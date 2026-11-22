import { readFileSync } from "node:fs";
import os from "node:os";
import process from "node:process";
import { globalConfigPath } from "../config/global-config.mjs";
import { writeFileAtomicSync } from "../io/atomic-write.mjs";
import { verifyFireworksApiKey } from "../keys/verify-api-key.mjs";
import { FIREWORKS_GATEWAY_URL } from "./models.mjs";
import { RESIDENCY_INFERENCE_ORIGINS, supportedResidency } from "./residency-regions.mjs";
import { catalogKeyFingerprint, ensureCacheParent, scopedCacheFilePath } from "./serverless-catalog-cache.mjs";

// An account with US data residency must send inference to us.api.fireworks.ai
// (https://docs.fireworks.ai/accounts/data-residency); api.fireworks.ai answers
// it with 403 "region not allowed". Catalog and account reads are unaffected,
// so only inference URLs change.
const GLOBAL_ORIGIN = "https://api.fireworks.ai";
const REGIONAL_ORIGINS = Object.values(RESIDENCY_INFERENCE_ORIGINS);
// Get Policy Settings values that mean "no restriction".
const UNRESTRICTED_RESIDENCIES = new Set(["", "GLOBAL", "MULTI_REGION_UNSPECIFIED"]);

// Residency changes rarely; `on` refetches it every time, so this only bounds
// how long a cached answer counts as fresh.
const RESIDENCY_TTL_MS = 24 * 60 * 60 * 1000;
// `on` must not hang on this lookup; a slow gateway leaves the cached answer.
const RESIDENCY_FETCH_TIMEOUT_MS = 5_000;

/** @typedef {"US" | ""} Residency  "" means the account has none. */

/** @type {Residency | undefined} */
let activeResidency;
// A residency the last lookup read that Nexus has no endpoint for (e.g.
// "EUROPE"); such a lookup answers unknown instead of "none".
let unsupportedResidency = "";

function cacheFile() {
  return scopedCacheFilePath("residency-cache.json");
}

const normalizeResidency = supportedResidency;

/**
 * A policy's residency value as Nexus handles it: "" (unrestricted), "US", or
 * null with `unsupportedResidency` set for a region Nexus can't set up yet.
 * @param {unknown} value
 * @returns {Residency | null}
 */
function classifyPolicyResidency(value) {
  const key = String(value ?? "").trim().toUpperCase();
  if (UNRESTRICTED_RESIDENCIES.has(key)) return "";
  const supported = supportedResidency(key);
  if (supported) return supported;
  unsupportedResidency = key;
  return null;
}

function readCache() {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The residency last stored for apiKey's account, or null when none is cached
 * (or it is older than the TTL and `allowStale` is false).
 * @param {string} apiKey
 * @param {{ allowStale?: boolean }} [options]
 * @returns {Residency | null}
 */
export function cachedAccountResidency(apiKey, { allowStale = false } = {}) {
  if (!apiKey) return null;
  const entry = readCache()[catalogKeyFingerprint(apiKey)];
  if (!entry || typeof entry !== "object") return null;
  if (!allowStale && !(Date.now() - Number(entry.fetchedAt) < RESIDENCY_TTL_MS)) return null;
  return normalizeResidency(entry.residency);
}

function storeAccountResidency(apiKey, residency) {
  try {
    const file = cacheFile();
    ensureCacheParent(file);
    const cache = readCache();
    cache[catalogKeyFingerprint(apiKey)] = { residency, fetchedAt: Date.now() };
    writeFileAtomicSync(file, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A cache that can't be written only costs a refetch.
  }
}

/**
 * The data residency of apiKey's account, read from its policy settings.
 * Answers null when it could not be read (offline, timeout, a key that can't
 * read the policy) or names a region Nexus has no endpoint for (see
 * accountUnsupportedResidency), so callers can keep a cached answer. Pass
 * `accountId` when the key was already verified, to skip a second check.
 * Never throws.
 * `NEXUS_RESIDENCY_LOOKUP=0` turns the lookup off (always null).
 * `NEXUS_TEST_RESIDENCY` answers for specs, which stay offline
 * ("UNAVAILABLE" for a failed lookup).
 * @param {string} apiKey
 * @param {{ timeoutMs?: number, accountId?: string }} [options]
 * @returns {Promise<Residency | null>}
 */
export async function fetchAccountResidency(apiKey, { timeoutMs = RESIDENCY_FETCH_TIMEOUT_MS, accountId: knownAccountId = "" } = {}) {
  unsupportedResidency = "";
  if (process.env.NEXUS_RESIDENCY_LOOKUP === "0") return null;
  if (process.env.NEXUS_TEST === "1") {
    const value = process.env.NEXUS_TEST_RESIDENCY ?? "";
    return value === "UNAVAILABLE" ? null : classifyPolicyResidency(value);
  }
  if (!apiKey) return null;
  try {
    const gatewayUrl = process.env.NEXUS_GATEWAY_URL?.trim() || FIREWORKS_GATEWAY_URL;
    const deadline = Date.now() + timeoutMs;
    let accountId = String(knownAccountId ?? "").trim().replace(/^accounts\//, "");
    if (!accountId) {
      const verified = await verifyFireworksApiKey(apiKey, { gatewayUrl, timeoutMs, quiet: true });
      accountId = String(verified?.accountId ?? "").trim().replace(/^accounts\//, "");
      if (!verified?.ok || !accountId) return null;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const response = await fetch(`${gatewayUrl}/v1/accounts/${encodeURIComponent(accountId)}/policySettings`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(remaining),
    });
    // An account that never saved a policy has no row: no residency.
    if (response.status === 404) return "";
    if (!response.ok) return null;
    const policy = await response.json();
    return classifyPolicyResidency(policy?.residency);
  } catch {
    return null;
  }
}

/**
 * Look up apiKey's account residency, store it, and make it the one inference
 * URLs use in this process. A failed lookup uses the last stored answer for
 * this key. With neither, answers null (unknown) and leaves the process on
 * each harness's recorded residency (see activeAccountResidency), so an
 * unreadable policy never moves a harness off the endpoint it was set up for.
 * Never throws.
 * @param {string} apiKey
 * @param {{ accountId?: string }} [options] see fetchAccountResidency
 * @returns {Promise<Residency | null>}
 */
export async function refreshAccountResidency(apiKey, { accountId } = {}) {
  unsupportedResidency = "";
  // Turned off: unknown, so nothing (not even a cached answer) moves a harness.
  if (process.env.NEXUS_RESIDENCY_LOOKUP === "0") return null;
  const fetched = await fetchAccountResidency(apiKey, { accountId });
  // A region Nexus can't set up is unknown, and a cached answer must not
  // stand in for it.
  if (unsupportedResidency) return null;
  if (fetched !== null) {
    storeAccountResidency(apiKey, fetched);
    activeResidency = fetched;
    return fetched;
  }
  const cached = cachedAccountResidency(apiKey, { allowStale: true });
  if (cached !== null) activeResidency = cached;
  return cached;
}

/**
 * The residency the last lookup read that Nexus has no endpoint for (e.g.
 * "EUROPE"), or "".
 */
export function accountUnsupportedResidency() {
  return unsupportedResidency;
}

/** The one-line warning for an account whose residency Nexus can't set up. */
export function unsupportedResidencyNote(residency) {
  return `Your account has ${residency} data residency, which Nexus can't set up yet. `
    + "Requests may be refused with \"region not allowed\".";
}

/**
 * For a harness's `on`: look up the account's residency for apiKey and make it
 * the one inference URLs use; when it can't be read, keep the residency the
 * harness was set up for. Returns the harness-state patch to save after the
 * config is written (empty when unknown, so the recorded value stays).
 * `onNote` gets one line when the user should know why the endpoint is what
 * it is: a region Nexus can't set up, or an unreadable residency that leaves
 * the global endpoint.
 * @param {string} apiKey
 * @param {string} harnessId
 * @param {string} [home]
 * @param {{ onNote?: (line: string) => void }} [options]
 * @returns {Promise<{ residency?: Residency }>}
 */
export async function resolveHarnessResidency(apiKey, harnessId, home, { onNote = () => {} } = {}) {
  const residency = await refreshAccountResidency(apiKey);
  if (residency !== null) return { residency };
  const recorded = recordedHarnessResidency(harnessId, home);
  useAccountResidency(recorded);
  try {
    if (unsupportedResidency) onNote(unsupportedResidencyNote(unsupportedResidency));
    else if (!recorded) onNote("Couldn't read your account's data residency; using api.fireworks.ai.");
  } catch {
    // A note that can't be shown never stops `on`.
  }
  return {};
}

/** Forget the residency set for this process, so the recorded fallback applies. */
export function forgetAccountResidency() {
  activeResidency = undefined;
}

/**
 * Make `residency` the one inference URLs use in this process. For callers
 * that already know it (the Desktop shim, specs).
 * @param {Residency | string} residency
 */
export function useAccountResidency(residency) {
  activeResidency = normalizeResidency(residency);
}

/**
 * The residency a harness's endpoint was last written for, as `on` records it
 * on the harness entry in ~/.nexus/config.json ("" when none or unreadable).
 * @param {string} harnessId
 * @param {string} [home]
 * @returns {Residency}
 */
export function recordedHarnessResidency(harnessId, home = process.env.HOME ?? os.homedir()) {
  try {
    const config = JSON.parse(readFileSync(globalConfigPath(home), "utf8"));
    return normalizeResidency(config?.harnesses?.[harnessId]?.residency);
  } catch {
    return "";
  }
}

/**
 * The residency a harness's inference URLs use in this process: the one
 * looked up for the key in use (`on`, status), or else the one this harness
 * was last written for, so paths that rewrite a config without a lookup
 * (catalog refresh, upgrade migrations, the Desktop shim) keep its endpoint.
 * Every writer passes its own harness id, so writes and status read the same
 * record.
 * @param {string} harnessId
 * @returns {Residency}
 */
export function activeAccountResidency(harnessId) {
  if (activeResidency !== undefined) return activeResidency;
  return harnessId ? recordedHarnessResidency(harnessId) : "";
}

/**
 * url on the residency's inference endpoint: a global Fireworks URL moves to
 * the regional host, anything else (a custom or Azure URL) is left alone.
 * @param {string} url
 * @param {Residency | string} [residency]
 */
export function fireworksInferenceUrl(url, residency) {
  const origin = RESIDENCY_INFERENCE_ORIGINS[normalizeResidency(residency ?? activeResidency ?? "")];
  if (!origin || typeof url !== "string") return url;
  if (url === GLOBAL_ORIGIN || url.startsWith(`${GLOBAL_ORIGIN}/`)) {
    return origin + url.slice(GLOBAL_ORIGIN.length);
  }
  return url;
}

/**
 * Whether value is the Fireworks inference URL `url`, on the global or any
 * regional endpoint. Detection must accept every region, so a config written
 * for one residency is still recognized after the account's residency changes.
 * @param {unknown} value
 * @param {string} url  The global form, e.g. FIREWORKS_BASE_URL.
 */
export function isFireworksInferenceUrl(value, url) {
  if (typeof value !== "string" || typeof url !== "string") return false;
  if (value === url) return true;
  if (!url.startsWith(GLOBAL_ORIGIN)) return false;
  const rest = url.slice(GLOBAL_ORIGIN.length);
  return REGIONAL_ORIGINS.some((origin) => value === origin + rest);
}

/**
 * The regional inference host for residency, or "" when it uses the global
 * endpoint. For status lines.
 * @param {Residency | string} residency
 */
export function residencyInferenceHost(residency) {
  const origin = RESIDENCY_INFERENCE_ORIGINS[normalizeResidency(residency)];
  return origin ? new URL(origin).host : "";
}
