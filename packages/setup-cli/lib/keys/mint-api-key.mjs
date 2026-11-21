import os from "node:os";
import path from "node:path";
import process from "node:process";
import { rm } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { grpcWebCall, pbDecode, pbField, pbString, pbStringAt } from "../auth/grpc-web.mjs";
import { readJsonIfExists, writeJson } from "../io/json.mjs";

/**
 * This machine's fw_ key, made through the control plane's gRPC-web surface
 * at gateway.fireworks.ai (the same calls the web console makes). A Nexus
 * account's browser sign-in gets the key from the web app (planCliKeyAction
 * picks signin or refresh, settleCliKey says what became of the previous
 * key); a Fireworks Platform account's browser
 * sign-in and enterprise SSO sign-in make it with the account's id_token
 * (mintApiKeyForAccount). Either way the key is named
 * nexus-{client}-{hostname}.
 */
export const GATEWAY_GRPC_WEB_URL = process.env.NEXUS_GATEWAY_GRPC_WEB_URL?.trim()
  || "https://gateway.fireworks.ai/web/gateway.Gateway";

/**
 * Shown when the developer browser flow can't mint a key (SSO tenants land
 * here: their sign-in works but resolves to no account on the developer
 * pool). Points at the SSO path that DOES work for them.
 */
export const BROWSER_SSO_UNSUPPORTED_HINT =
  "(Teams that sign in with custom SSO: run nexus login --account <account-id>.)";

export const BROWSER_SIGNIN_NO_ACCOUNT_FAILURE =
  `Your sign-in worked, but no Fireworks account is associated with it. ${BROWSER_SSO_UNSUPPORTED_HINT}`;

/**
 * Label creation origin, not where a copied/shared key is subsequently used.
 * Desktop callers explicitly set NEXUS_CLIENT=desktop for their subprocess;
 * ordinary CLI calls (including unknown client values) default to cli.
 * At most 64 of [a-z0-9-], which the web app's sign-in requires.
 */
export function mintedKeyName(hostname = os.hostname(), client = process.env.NEXUS_CLIENT) {
  const origin = client === "desktop" ? "desktop" : "cli";
  const host = hostname.split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-") || "unknown-host";
  return `nexus-${origin}-${host}`.slice(0, 64);
}

/**
 * @typedef {Object} MintResult
 * @property {boolean} ok
 * @property {string} key        The fw_ key ("" on failure).
 * @property {string} keyId      Key id, for future revocation.
 * @property {string} userName   accounts/{account}/users/{user} the key belongs to.
 * @property {string} failure    One-line reason for the terminal ("" when ok).
 */

const failed = (failure) => ({ ok: false, key: "", keyId: "", userName: "", failure });

const GRPC_PERMISSION_DENIED = 7;
const SSO_REQUIRED_DETAIL = /\bsso\b|single sign-on|\bsaml\b|identity provider/i;

// A minted key is stored and written into harness configs and headers: one
// with whitespace, quotes, backslashes or control characters is refused
// rather than carried into those files. So is one with braces or `$`:
// OpenCode expands `{env:VAR}` and `{file:path}` in its config, which would
// send that variable or file as the key. Every other printable key passes.
const MINTED_KEY_RE = /^fw_[\x21-\x7e]+$/;
const MINTED_KEY_UNSAFE = /["'\\`{}$]/;

/** @param {unknown} key */
export function isSafeMintedKey(key) {
  return typeof key === "string" && MINTED_KEY_RE.test(key) && !MINTED_KEY_UNSAFE.test(key);
}

/**
 * List the Fireworks accounts an id_token principal can mint keys under. The
 * Fireworks API resolves the principal to its accounts server-side; when more
 * than one comes back the caller must pick which one the key belongs to,
 * since minting under the wrong account silently puts the key where the user
 * didn't mean to (and the CLI would still report success for their identity).
 * `nexusAccountNames` lists the ones that are Nexus accounts (Account
 * field 28), which manage keys on the Nexus site.
 * @param {string} idToken
 * @param {{ baseUrl?: string, signal?: AbortSignal }} [options]  `signal` aborts the call.
 * @returns {Promise<{ ok: boolean, accountNames: string[], nexusAccountNames: string[], failure: string }>}
 */
export async function listAccountsForIdToken(idToken, { baseUrl = GATEWAY_GRPC_WEB_URL, signal } = {}) {
  let accounts;
  try {
    accounts = await grpcWebCall(baseUrl, "ListAccounts", Buffer.alloc(0), idToken, { signal });
  } catch (error) {
    return { ok: false, accountNames: [], nexusAccountNames: [], failure: `Couldn't reach the Fireworks API (${error?.message ?? "network error"}).` };
  }
  if (accounts.status !== 0 || !accounts.message) {
    return { ok: false, accountNames: [], nexusAccountNames: [], failure: rpcFailureLine("looking up your account", accounts) };
  }
  return {
    ok: true,
    accountNames: allResourceNames(accounts.message),
    nexusAccountNames: nexusResourceNames(accounts.message),
    failure: "",
  };
}

/**
 * Mint a named fw_ key under a specific account: ListUsers (find the caller's
 * user resource by email), then CreateApiKey (the plaintext key is returned
 * exactly once). Used by enterprise SSO sign-in, where the account is known.
 * @param {string} idToken
 * @param {string} accountName  e.g. "accounts/acme"
 * @param {{ email?: string, baseUrl?: string, keyName?: string, ssoSignIn?: boolean }} [options]
 *   `ssoSignIn` marks a sign-in through the account's own identity provider,
 *   so a refusal doesn't point back at the SSO path it already took.
 * @returns {Promise<MintResult>}
 */
export async function mintApiKeyForAccount(idToken, accountName, {
  email = "",
  baseUrl = GATEWAY_GRPC_WEB_URL,
  keyName = mintedKeyName(),
  ssoSignIn = false,
} = {}) {
  const usersRequest = Buffer.concat([
    pbString(1, accountName),
    ...(email ? [pbString(4, `email="${email}"`)] : []),
  ]);
  let users;
  try {
    users = await grpcWebCall(baseUrl, "ListUsers", usersRequest, idToken);
  } catch (error) {
    return failed(`Couldn't reach the Fireworks API (${error?.message ?? "network error"}).`);
  }
  // A bare denial is the gateway's non-member answer; denials with a message
  // (SSO enforcement, role limits) fall through so the reason is shown.
  if (users.status === GRPC_PERMISSION_DENIED && !users.detail) {
    return failed(`You signed in, but you're not a member of "${accountName.replace(/^accounts\//, "")}" yet — ask your account admin to add you.`);
  }
  if (users.status !== 0 || !users.message) {
    return failed(rpcFailureLine("looking up your user", users, { ssoSignIn }));
  }
  const userNames = allResourceNames(users.message);
  if (userNames.length === 0) {
    return failed(`Couldn't find your user in ${accountName}.`);
  }
  if (!email && userNames.length > 1) {
    // Without an email claim (some SSO/federated sign-ins omit it) the
    // ListUsers filter is skipped and every user in the account comes back.
    // Picking the first would mint a key under whoever the server lists
    // first — possibly not the caller — so refuse instead.
    return failed(
      `Your sign-in didn't say which of ${accountName}'s users you are, so no key was created. Ask your account admin to check your user on that account.`,
    );
  }
  return createApiKey(idToken, userNames[0], { baseUrl, keyName, ssoSignIn });
}

/**
 * Exchange a Cognito id_token for an fw_ API key under the principal's first
 * account — the non-interactive path (tests, and any caller that doesn't
 * supply a picker). Interactive browser sign-in uses
 * listAccountsForIdToken + mintApiKeyForAccount so it can prompt when the
 * principal belongs to more than one account.
 * @param {string} idToken
 * @param {{ email?: string, baseUrl?: string, keyName?: string }} [options]
 * @returns {Promise<MintResult>}
 */
export async function mintApiKeyFromIdToken(idToken, options = {}) {
  const listed = await listAccountsForIdToken(idToken, { baseUrl: options.baseUrl ?? GATEWAY_GRPC_WEB_URL });
  if (!listed.ok) {
    return failed(listed.failure);
  }
  const accountName = listed.accountNames[0] ?? "";
  if (!accountName) {
    return failed(BROWSER_SIGNIN_NO_ACCOUNT_FAILURE);
  }
  return mintApiKeyForAccount(idToken, accountName, options);
}

/**
 * CreateApiKey on a user resource; the plaintext key is returned exactly once.
 * `auth` is any gateway credential grpcWebCall accepts: a Cognito id_token
 * (enterprise SSO) or `{ apiKey }`.
 * @param {string | { apiKey: string }} auth
 * @param {string} userName  accounts/{account}/users/{user}
 * @param {{ baseUrl?: string, keyName?: string, timeoutMs?: number, ssoSignIn?: boolean }} [options]
 * @returns {Promise<MintResult>}
 */
export async function createApiKey(auth, userName, {
  baseUrl = GATEWAY_GRPC_WEB_URL,
  keyName = mintedKeyName(),
  timeoutMs = 0,
  ssoSignIn = false,
} = {}) {
  // CreateApiKeyRequest{ parent = user, api_key.display_name = keyName }
  const createRequest = Buffer.concat([
    pbString(1, userName),
    pbField(2, pbString(2, keyName)),
  ]);
  let created;
  try {
    created = await grpcWebCall(baseUrl, "CreateApiKey", createRequest, auth, { timeoutMs });
  } catch (error) {
    return failed(unreachableLine(error));
  }
  if (created.status !== 0 || !created.message) {
    return failed(rpcFailureLine("creating an API key", created, { ssoSignIn }));
  }
  const fields = pbDecode(created.message);
  const key = pbStringAt(fields, 3); // ApiKey.key — plaintext, only on create
  if (!key) {
    return failed("Fireworks created a key but didn't return its value.");
  }
  if (!isSafeMintedKey(key)) {
    return failed("The control plane returned a malformed API key; nothing was stored.");
  }
  return { ok: true, key, keyId: pbStringAt(fields, 1), userName, failure: "" };
}

/**
 * DeleteApiKey with a Cognito id_token. Never with an API key: a key may not
 * delete a key. Never throws.
 * @param {string} auth
 * @param {{ keyId: string, userName: string, baseUrl?: string, timeoutMs?: number }} args
 * @returns {Promise<{ ok: boolean, failure: string }>}
 */
export async function deleteApiKey(auth, { keyId, userName, baseUrl = GATEWAY_GRPC_WEB_URL, timeoutMs = 0 }) {
  if (typeof auth !== "string" || !auth.trim()) {
    return { ok: false, failure: "a sign-in is needed to delete a key" };
  }
  // DeleteApiKeyRequest{ parent = user resource, key_id }
  const request = Buffer.concat([pbString(1, userName), pbString(2, keyId)]);
  let result;
  try {
    result = await grpcWebCall(baseUrl, "DeleteApiKey", request, auth, { timeoutMs });
  } catch (error) {
    // Same wording as createApiKey's unreachableLine, as a clause: callers
    // put it inside their own sentence.
    return {
      ok: false,
      failure: error?.name === "TimeoutError"
        ? "timed out reaching the Fireworks control plane"
        : `couldn't reach the Fireworks control plane (${error?.message ?? "network error"})`,
    };
  }
  if (result.status !== 0) {
    return { ok: false, failure: result.detail ? `the control plane refused: ${result.detail}` : `the control plane refused (status ${result.status})` };
  }
  return { ok: true, failure: "" };
}

/**
 * What a browser sign-in on a Nexus account does with the key this machine
 * already has, decided before the browser opens (the web app's approval
 * names the action):
 *   keep     the stored key is the one browser sign-in made here (its
 *            fingerprint matches the record), it still works (or can't be
 *            checked) and isn't expiring, and the user didn't ask to replace
 *            it: no browser, nothing made or deleted.
 *   refresh  that key still works (or can't be checked) and is being
 *            replaced (`rotate`, or it expires within KEY_EXPIRY_WARNING_MS):
 *            the web app makes the new key on the same account and deletes
 *            the old one, after the user approves.
 *   signin   anything else: no such key, a record without a fingerprint (it
 *            can't be tied to the stored key), a key already past its expiry,
 *            or one the Fireworks API rejects (it may already be gone). A new
 *            key; nothing is deleted, so no refresh names a dead key id.
 * The key is checked before anything else, so a refresh only ever names a
 * live key. `checked` is that check when the caller already ran it on this
 * same key, so it isn't repeated; `check` comes back for the same reason.
 * Nothing here deletes a key, and no API key ever deletes one.
 * @param {{
 *   previous: { keyId: string, userName: string, displayName: string, keyFingerprint?: string, expiresAt?: string } | null,
 *   storedKey: string,
 *   verify: (key: string) => Promise<{ ok: boolean, reason: string }>,
 *   checked?: { ok: boolean, reason: string } | null,
 *   rotate?: boolean,
 *   now?: number,
 * }} options
 * @returns {Promise<{ action: "keep" | "refresh" | "signin", rejected: boolean, expiring: boolean, check?: { ok: boolean, reason: string } }>}
 */
export async function planCliKeyAction({ previous, storedKey, verify, checked = null, rotate = false, now = Date.now() }) {
  const ours = Boolean(previous?.keyFingerprint && storedKey
    && previous.keyFingerprint === apiKeyFingerprint(storedKey));
  if (!ours) {
    return { action: "signin", rejected: false, expiring: false };
  }
  const expiresMs = previous.expiresAt ? Date.parse(previous.expiresAt) : NaN;
  if (Number.isFinite(expiresMs) && expiresMs <= now) {
    // Already expired: there's no live key for a refresh to delete.
    return { action: "signin", rejected: true, expiring: false };
  }
  const check = checked ?? await verify(storedKey);
  if (!check.ok && check.reason === "rejected") {
    return { action: "signin", rejected: true, expiring: false, check };
  }
  const expiring = keyExpiresSoon(previous.expiresAt, now);
  if (rotate || expiring) {
    return { action: "refresh", rejected: false, expiring, check };
  }
  return { action: "keep", rejected: false, expiring: false, check };
}

/**
 * The key this machine keeps after a web-app sign-in, which always made a new
 * key (`fresh`), and what to say about the previous one. `plan` is what
 * planCliKeyAction decided; `refreshed` is false when a refresh had to run as
 * a plain sign-in (a web app older than version 3), so the previous key is
 * still active. Never deletes anything.
 * @param {{ key: string, keyId: string, parent: string, expiresAt?: string, previousKeyRevoked?: boolean }} fresh
 * @param {{
 *   previous: { keyId: string, userName: string, displayName: string, expiresAt?: string } | null,
 *   plan: { action: "keep" | "refresh" | "signin", rejected: boolean, expiring: boolean },
 *   storedKey?: string,
 *   refreshed?: boolean,
 *   keysUrl?: string,
 *   otherSignIn?: boolean,
 * }} options
 * `otherSignIn`: the previous key came from a Fireworks Platform or
 * company-SSO sign-in, which the web app can't delete, so it stays active.
 * @returns {{ key: string, keyId: string, expiresAt?: string, reused: false, notes: string[], previousKey?: "deleted" | "kept" | "unknown" }}
 *   `previousKey`: what happened to this machine's previous key, when it is
 *   already known here (a refresh with a confirm step decides it later).
 */
export function settleCliKey(fresh, { previous, plan, storedKey = "", refreshed = true, keysUrl = "", otherSignIn = false }) {
  const label = previous ? previous.displayName || previous.keyId : "";
  const where = keysUrl ? ` — revoke it at ${keysUrl}` : "";
  const notes = [];
  const kept = { key: fresh.key, keyId: fresh.keyId, ...(fresh.expiresAt ? { expiresAt: fresh.expiresAt } : {}), reused: /** @type {false} */ (false), notes };
  if (!previous) {
    return kept;
  }
  if (plan.action === "refresh") {
    // Only a refresh that ran replaced anything (an older web app can't).
    if (plan.expiring && refreshed) {
      notes.push(`Replaced this machine's previous key (${label}), which expires ${formatExpiry(previous.expiresAt)}.`);
    }
    if (!refreshed) {
      notes.push(`This machine's previous key (${label}) is still active (the web app couldn't replace it)${where}`);
      return { ...kept, previousKey: "kept" };
    }
    if (fresh.previousKeyRevoked === false) {
      notes.push(`Couldn't delete this machine's previous key (${label})${where}`);
      return { ...kept, previousKey: "kept" };
    }
    if (fresh.confirmDeadline) {
      return kept;
    }
    if (fresh.previousKeyRevoked !== true) {
      // A refresh without a confirm step whose reply doesn't say the old key
      // was deleted: never report it as replaced.
      notes.push(`Couldn't confirm that this machine's previous key (${label}) was deleted, so it may still be active${where}`);
      return { ...kept, previousKey: "unknown" };
    }
    return { ...kept, previousKey: "deleted" };
  }
  const samePrincipal = previous.userName === fresh.parent;
  if (otherSignIn) {
    notes.push(`This machine's previous key (${label}) came from a Fireworks Platform or company SSO sign-in, `
      + `which this sign-in can't delete, so it is still active${where}`);
  } else if (plan.rejected && samePrincipal) {
    notes.push(`Replaced this machine's previous key (${label}), which no longer worked.`);
    return kept;
  } else if (plan.rejected) {
    notes.push(`The key this machine created under another account (${label}) no longer worked; it was replaced.`);
    return kept;
  } else if (samePrincipal && !storedKey) {
    notes.push(`This machine's previous key (${label}) wasn't stored here any more, so it wasn't deleted${where}`);
  } else if (samePrincipal) {
    notes.push(`This machine's previous key (${label}) is still active${where}`);
  } else {
    notes.push(`The key this machine created under another account (${label}) is still active${where}`);
  }
  return { ...kept, previousKey: "kept" };
}

/**
 * Keys the web app makes expire (7 days); `nexus status` warns this long
 * before, and a browser sign-in in that window replaces the key.
 */
export const KEY_EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * The token response's optional `expire_time` (RFC 3339) as an ISO string,
 * or "" when absent or malformed (a web app that predates key expiry).
 * @param {unknown} value
 */
export function parseKeyExpireTime(value) {
  if (typeof value !== "string" || !RFC3339.test(value)) return "";
  const ms = Date.parse(value.toUpperCase());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

/**
 * True when `expiresAt` (ISO) is known and within KEY_EXPIRY_WARNING_MS of
 * `now`, or already past.
 * @param {string | undefined} expiresAt
 */
export function keyExpiresSoon(expiresAt, now = Date.now()) {
  const ms = expiresAt ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(ms) && ms - now <= KEY_EXPIRY_WARNING_MS;
}

/** "on 2026-02-01" (UTC date): enough for a key that lasts days. */
export function formatExpiry(expiresAt) {
  return `on ${String(expiresAt).slice(0, 10)}`;
}

/**
 * Where the CLI remembers the key it minted, so `logout` can revoke it
 * server-side — "reversible" should undo the remote side effect too, not
 * just the local copy. Holds ids and a one-way fingerprint, never the key.
 * @param {string} home
 */
export function mintedKeyStatePath(home) {
  return path.join(home, ".nexus", "minted-key.json");
}

/**
 * @param {string} home
 * @param {{ keyId: string, userName: string, displayName: string, apiKey?: string, expiresAt?: string }} state
 *   `expiresAt` (ISO) when the web app said when the key expires.
 */
export async function writeMintedKeyState(home, { keyId, userName, displayName, apiKey = "", expiresAt = "" }) {
  const expiresAtIso = parseKeyExpireTime(expiresAt);
  await writeJson(mintedKeyStatePath(home), {
    keyId,
    userName,
    displayName,
    createdAt: new Date().toISOString(),
    ...(expiresAtIso ? { expiresAt: expiresAtIso } : {}),
    ...(apiKey ? { keyFingerprint: apiKeyFingerprint(apiKey) } : {}),
  });
}

/**
 * @param {string} home
 * @returns {Promise<{ keyId: string, userName: string, displayName: string, keyFingerprint?: string, expiresAt?: string } | null>}
 */
export async function readMintedKeyState(home) {
  const state = await readJsonIfExists(mintedKeyStatePath(home));
  const expiresAt = parseKeyExpireTime(state.expiresAt);
  return typeof state.keyId === "string" && state.keyId && typeof state.userName === "string" && state.userName
    ? { keyId: state.keyId, userName: state.userName, displayName: typeof state.displayName === "string" ? state.displayName : "",
      ...(typeof state.keyFingerprint === "string" ? { keyFingerprint: state.keyFingerprint } : {}),
      ...(expiresAt ? { expiresAt } : {}) }
    : null;
}

/**
 * The account id in a key's user resource (accounts/{account}/users/{user}),
 * or "" when it isn't one.
 * @param {string | undefined} userName
 */
export function accountIdOfUserName(userName) {
  return /^accounts\/([^/]+)\//.exec(userName ?? "")?.[1] ?? "";
}

export function apiKeyFingerprint(apiKey) {
  return createHash("sha256").update(apiKey.trim()).digest("hex");
}

/** @param {string} home */
export async function clearMintedKeyState(home) {
  await rm(mintedKeyStatePath(home), { force: true });
}

/**
 * Delete an API key this CLI minted with a Cognito sign-in token
 * (`idToken`): Fireworks Platform and enterprise SSO sign-ins. A key never
 * deletes itself, so there is no API-key form; a Nexus account's key is
 * revoked through the web app (revokeViaWebApp). Never throws.
 * @param {{ keyId: string, userName: string, idToken: string, baseUrl?: string }} args
 * @returns {Promise<{ ok: boolean, failure: string }>}
 */
export async function revokeMintedKey({ keyId, userName, idToken, baseUrl = GATEWAY_GRPC_WEB_URL }) {
  const token = typeof idToken === "string" ? idToken.trim() : "";
  if (!token) return { ok: false, failure: "a sign-in is needed to revoke this key" };
  return deleteApiKey(token, { keyId, userName, baseUrl });
}

/**
 * Both List*Response messages put the resources in field 1 and each
 * resource's name in field 1 — decode two levels and return every resource
 * name. ListAccounts callers choose among them; ListUsers callers expect one
 * (the email filter) and treat more than one without an email as ambiguous.
 * @param {Buffer} message
 */
function allResourceNames(message) {
  const out = [];
  for (const entry of pbDecode(message).get(1) ?? []) {
    if (Buffer.isBuffer(entry)) {
      const name = pbStringAt(pbDecode(entry), 1);
      if (name) {
        out.push(name);
      }
    }
  }
  return out;
}

/** @param {unknown} error */
function unreachableLine(error) {
  return error?.name === "TimeoutError"
    ? "Timed out reaching the Fireworks control plane."
    : `Couldn't reach the Fireworks control plane (${error?.message ?? "network error"}).`;
}

const ACCOUNT_NEXUS_FIELD = 28;

/** Names of the listed accounts marked as Nexus accounts. */
function nexusResourceNames(message) {
  const out = [];
  for (const entry of pbDecode(message).get(1) ?? []) {
    if (!Buffer.isBuffer(entry)) continue;
    const fields = pbDecode(entry);
    const name = pbStringAt(fields, 1);
    if (name && fields.get(ACCOUNT_NEXUS_FIELD)?.[0] === 1) out.push(name);
  }
  return out;
}

/**
 * @param {string} doing
 * @param {import("../auth/grpc-web.mjs").GrpcWebResult} result
 */
function rpcFailureLine(doing, result, { ssoSignIn = false } = {}) {
  if (result.status === 16) {
    if (ssoSignIn) {
      return `Your sign-in wasn't accepted while ${doing}. Try again.`;
    }
    return `Your browser sign-in wasn't accepted while ${doing}. Try again. `
      + BROWSER_SSO_UNSUPPORTED_HINT;
  }
  // A denial that names SSO is an account that requires its own sign-in:
  // keep the server's reason and point at the SSO sign-in.
  if (result.status === GRPC_PERMISSION_DENIED && !ssoSignIn && SSO_REQUIRED_DETAIL.test(result.detail ?? "")) {
    return `Your sign-in was refused while ${doing} (${result.detail}). ${BROWSER_SSO_UNSUPPORTED_HINT}`;
  }
  return `Something went wrong ${doing}${result.detail ? ` (${result.detail})` : ` (status ${result.status})`}.`;
}
