import process from "node:process";
import { FIREWORKS_GATEWAY_URL } from "./models.mjs";
import { fireworksGatewayFetchSignal, isDefiniteRefusal, readBoundedJson } from "./gateway-fetch.mjs";
import { verifyFireworksApiKey } from "../keys/verify-api-key.mjs";

/**
 * The signed-in user's settings, read with their own API key.
 *
 * Every function returns a result object and never throws. Failure messages
 * are fixed strings: server error text can carry the account or user ID, so
 * it is never echoed.
 */

/**
 * @typedef {"network"|"unsupported"|"forbidden"|"other"} SettingsFailureCode
 * @typedef {{ ok: true, shareNexusAnalytics: boolean|null, nexusAnalyticsId: string|null, nexusAccountAnalyticsId: string|null } | { ok: false, code: SettingsFailureCode, message: string }} ShareNexusAnalyticsResult
 * @typedef {{ ok: true, userName: string } | { ok: false, code: SettingsFailureCode, message: string }} UserNameResult
 */

const MESSAGES = {
  network: "Couldn't reach Fireworks.",
  unsupported: "Fireworks doesn't support this setting yet.",
  forbidden: "Fireworks didn't allow reading this setting with your key.",
  other: "Fireworks returned an unexpected response.",
  noUser: "Couldn't find your Fireworks user for this key.",
};

const fail = (code, message = MESSAGES[code]) => ({ ok: false, code, message });

const USER_RESOURCE_NAME_RE = /^accounts\/[^/\s]+\/users\/[^/\s]+$/;

function gatewayBase(gatewayUrl = "") {
  return (gatewayUrl || process.env.NEXUS_GATEWAY_URL?.trim() || FIREWORKS_GATEWAY_URL).replace(/\/+$/, "");
}

/**
 * @param {string} url
 * @param {string} apiKey
 * @param {{ signal?: AbortSignal, fetchFn?: typeof fetch }} [options]
 * @returns {Promise<{ response: Response } | { response: null }>}
 */
async function gatewayFetch(url, apiKey, { signal, fetchFn = fetch } = {}) {
  try {
    const response = await fetchFn(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal ?? fireworksGatewayFetchSignal(),
    });
    return { response };
  } catch {
    return { response: null };
  }
}

async function readJson(response, maxBytes = 0) {
  if (maxBytes > 0) {
    return readBoundedJson(response, maxBytes);
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * A 400 that says the server doesn't know the field (or the settings
 * resource) yet.
 * @param {unknown} body
 */
function isUnknownFieldError(body) {
  const message = typeof body?.message === "string" ? body.message : "";
  return /share_?nexus_?analytics|unknown field|invalid field|no such field|not (?:a )?(?:valid|known) field/i
    .test(message);
}

/**
 * @param {Response} response
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<{ ok: false, code: SettingsFailureCode, message: string }>}
 */
async function httpFailure(response, { maxBytes = 0 } = {}) {
  if (response.status === 401 || response.status === 403) {
    return fail("forbidden");
  }
  if (response.status === 400 && isUnknownFieldError(await readJson(response, maxBytes))) {
    return fail("unsupported");
  }
  return fail("other");
}

/**
 * The `accounts/{a}/users/{u}` the key belongs to, found from the key's
 * account and developer email (GET /verifyApiKey), then ListUsers filtered
 * by that email. Account members may list users with their own API key
 * (firectl resolves API-key users the same way).
 * @param {string} apiKey
 * @param {{
 *   gatewayUrl?: string,
 *   deadline?: number,
 *   quiet?: boolean,
 *   fetchFn?: typeof fetch,
 *   maxBytes?: number,
 *   includeDiagnostic?: boolean,
 * }} [options]
 * @returns {Promise<UserNameResult & { stage?: "verify" | "users", status?: number | null, definite?: boolean }>}
 */
export async function lookupUserNameForKey(
  apiKey,
  {
    gatewayUrl = "",
    deadline = 0,
    quiet = false,
    fetchFn = fetch,
    maxBytes = 0,
    includeDiagnostic = false,
  } = {},
) {
  const withDiag = (failure, diag) => (includeDiagnostic ? { ...failure, ...diag } : failure);

  const verifyTimeoutMs = deadline > 0 ? deadline - Date.now() : 0;
  if (deadline > 0 && verifyTimeoutMs <= 0) {
    return withDiag(fail("network"), { stage: "verify", status: null, definite: false });
  }
  const verified = await verifyFireworksApiKey(apiKey, {
    gatewayUrl,
    timeoutMs: verifyTimeoutMs,
    quiet,
    fetchFn,
  });
  if (!verified.ok) {
    const status = verified.status > 0 ? verified.status : null;
    const definite = verified.reason !== "network" && isDefiniteRefusal(verified.status);
    const failure = verified.reason === "network"
      ? fail("network")
      : verified.reason === "rejected"
        ? fail("forbidden")
        : fail("other");
    return withDiag(failure, { stage: "verify", status, definite });
  }
  const accountId = verified.accountId.trim().replace(/^accounts\//, "");
  const email = verified.email.trim();
  if (!accountId || !email) {
    // Service-account keys carry no developer email, so there is no person
    // whose preference this would be.
    return withDiag(fail("other", MESSAGES.noUser), {
      stage: "verify",
      status: verified.status > 0 ? verified.status : 200,
      definite: true,
    });
  }

  const usersTimeoutMs = deadline > 0 ? deadline - Date.now() : 0;
  if (deadline > 0 && usersTimeoutMs <= 0) {
    return withDiag(fail("network"), { stage: "users", status: null, definite: false });
  }
  const parent = `accounts/${encodeURIComponent(accountId)}`;
  const query = new URLSearchParams({ filter: `email="${email}"`, pageSize: "2" });
  const { response } = await gatewayFetch(`${gatewayBase(gatewayUrl)}/v1/${parent}/users?${query}`, apiKey, {
    signal: deadline > 0 ? AbortSignal.timeout(usersTimeoutMs) : undefined,
    fetchFn,
  });
  if (!response) {
    return withDiag(fail("network"), { stage: "users", status: null, definite: false });
  }
  if (!response.ok) {
    const failure = await httpFailure(response, { maxBytes });
    return withDiag(failure, {
      stage: "users",
      status: response.status,
      definite: isDefiniteRefusal(response.status),
    });
  }

  const body = await readJson(response, maxBytes);
  if (!body || typeof body !== "object" || Array.isArray(body) || (body.users !== undefined && !Array.isArray(body.users))) {
    return withDiag(fail("other"), { stage: "users", status: response.status, definite: false });
  }
  const users = Array.isArray(body.users) ? body.users : [];
  const names = users
    .map((user) => (typeof user?.name === "string" ? user.name.trim() : ""))
    .filter((name) => USER_RESOURCE_NAME_RE.test(name));
  return names.length === 1
    ? { ok: true, userName: names[0] }
    : withDiag(fail("other", MESSAGES.noUser), { stage: "users", status: response.status, definite: true });
}

/**
 * @param {unknown} body
 * @returns {boolean|null}
 */
function shareNexusAnalyticsFrom(body) {
  return typeof body?.shareNexusAnalytics === "boolean" ? body.shareNexusAnalytics : null;
}

/**
 * An opaque ID of at most 128 characters: letters, digits, `_` and `-` only
 * (no `@`, `/` or spaces), so an email or resource path is never passed on.
 * @param {unknown} value
 * @returns {string|null}
 */
function analyticsIdFrom(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

/**
 * Read the preference; null when the user has never answered.
 * @param {string} apiKey
 * @param {string} userName  accounts/{a}/users/{u}
 * @param {{ gatewayUrl?: string }} [options]
 * @returns {Promise<ShareNexusAnalyticsResult>}
 */
export async function getShareNexusAnalytics(apiKey, userName, { gatewayUrl = "" } = {}) {
  const { response } = await gatewayFetch(`${gatewayBase(gatewayUrl)}/v1/${userName}/settings`, apiKey);
  if (!response) return fail("network");
  if (!response.ok) return httpFailure(response);
  const body = await readJson(response);
  if (!body || typeof body !== "object") return fail("other");
  return {
    ok: true,
    shareNexusAnalytics: shareNexusAnalyticsFrom(body),
    nexusAnalyticsId: analyticsIdFrom(body.nexusAnalyticsId),
    nexusAccountAnalyticsId: analyticsIdFrom(body.nexusAccountAnalyticsId),
  };
}
