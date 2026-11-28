/**
 * Nexus plan credit standing for the Claude Code status line and CLI usage views.
 *
 * Reads the seat's plan usage and account wallet state using the caller's API
 * key, caches the sanitized result on disk (mode 0600, no keys or PII), and
 * classifies whether the account is currently drawing down credits or has used
 * them up.
 *
 * Hot paths (the Claude Code status line) only read the local cache file and
 * never wait on the network. Background refreshes are TTL- and lock-gated.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import { claudeFireworksKeyFrom } from "../harnesses/claude/env-key.mjs";
import { writeFileAtomicSync } from "../io/atomic-write.mjs";
import { ensurePrivateParent } from "../io/private-files.mjs";
import { apiKeyFingerprint, readMintedKeyState } from "../keys/mint-api-key.mjs";
import { isHttpsOrLoopbackHttp } from "../system/loopback.mjs";
import { isDefiniteRefusal, readBoundedJson } from "./gateway-fetch.mjs";
import { scopedCacheFilePath } from "./serverless-catalog-cache.mjs";

export const CREDIT_STANDING_DEFAULT_GATEWAY_URL = "https://api.fireworks.ai";
const DEFAULT_GATEWAY_URL = CREDIT_STANDING_DEFAULT_GATEWAY_URL;

/** Public billing URL where users can review or add Nexus credits. */
export const NEXUS_BILLING_URL = "https://nexus.fireworks.ai/settings/billing";

/** Refresh cadence for an active Nexus Plan usage snapshot (60 seconds). */
export const CREDIT_STANDING_TTL_MS = 60_000;
/** Longer cadence when the gateway definitely reported no active plan or access. */
export const CREDIT_STANDING_NO_PLAN_TTL_MS = 5 * 60_000;
/** Maximum age a cached standing may be displayed before failing quietly to normal display. */
export const CREDIT_STANDING_MAX_AGE_MS = 5 * 60_000;
/** Cooldown / stale-lock window preventing concurrent or tight-loop background refreshes. */
export const CREDIT_STANDING_LOCK_TTL_MS = 60_000;
/** Upper bound on gateway reads during a refresh. */
export const CREDIT_STANDING_FETCH_TIMEOUT_MS = 5_000;
/** Upper bound on gateway reads in interactive CLI commands (`usage`, `status`). */
export const CREDIT_STANDING_CLI_TIMEOUT_MS = 3_000;
/** Maximum JSON response body buffered from gateway endpoints (256 KiB). */
export const MAX_CREDIT_RESPONSE_BYTES = 256 * 1024;

const FUTURE_CLOCK_SKEW_MS = 60_000;
const MAX_LOCAL_STATE_BYTES = 64 * 1024;
const CACHE_SUBDIR = "statusline-refresh";
const CACHE_FILENAME = "credit-standing-cache.json";
const LAST_ATTEMPT_FILENAME = "credit-standing.last.json";
const LOCK_FILENAME = "credit-standing-refresh.lock";
const STORED_KEY_FP_FILENAME = "stored-key-fingerprint";
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const FP_SCOPE_RE = /^[0-9a-f]{16}$/;
const SCOPED_CACHE_FILE_RE = /^credit-standing-[0-9a-f]{16}\.json$/;
const SCOPED_LAST_ATTEMPT_FILE_RE = /^credit-standing(?:-[0-9a-f]{16})?\.last\.json$/;
const SCOPED_LOCK_FILE_RE = /^credit-standing-refresh(?:-[0-9a-f]{16})?\.lock(?:\.[^/]+)?$/;

const DIAGNOSTIC_OUTCOMES = new Set(["error", "none", "unconfirmed"]);
const DIAGNOSTIC_STAGES = new Set(["verify", "users", "usage", "account"]);
const DIAGNOSTIC_STAGE_LABELS = Object.freeze({
  verify: "key verification",
  users: "user lookup",
  usage: "plan usage lookup",
  account: "account lookup",
});

const KNOWN_OVERAGE_STATUSES = new Set([
  "OVERAGE_STATUS_UNSPECIFIED",
  "OVERAGE_STATUS_ACTIVE",
  "OVERAGE_STATUS_DISABLED",
]);

/**
 * @typedef {"available" | "depleted" | "unavailable" | "unconfirmed"} CreditStanding
 * @typedef {"monthly" | "session"} PlanLimitKind
 * @typedef {{ standing: "available" | "depleted", limit: PlanLimitKind, label: "using credits" | "credits used up" }} ActiveCreditIndicator
 * @typedef {{
 *   at: number,
 *   outcome: "error" | "none" | "unconfirmed",
 *   stage: "verify" | "users" | "usage" | "account",
 *   status: number | null,
 * }} CreditStandingLastAttempt
 * @typedef {{
 *   monthlyUsedPercent: number | null,
 *   sessionUsedPercent: number | null,
 *   overageStatus: string | null,
 *   suspendState: string | null,
 *   ownsWallet: boolean | null,
 * }} CreditStandingSnapshot
 * @typedef {{
 *   fetchedAt: number,
 *   keyFingerprint: string,
 *   status: "ok" | "none",
 *   monthlyUsedPercent?: number | null,
 *   sessionUsedPercent?: number | null,
 *   overageStatus?: string | null,
 *   suspendState?: string | null,
 *   ownsWallet?: boolean | null,
 * }} CreditStandingCacheRecord
 */

/**
 * One-way fingerprint of an API key (full sha256 hex, shared with minted-key.json).
 * Never store or log the raw API key.
 */
export const creditKeyFingerprint = apiKeyFingerprint;

/**
 * Parse `accounts/{account}/users/{user}` into its path segments, or null.
 * Rejects malformed values so untrusted strings never shape request paths.
 * @param {unknown} userName
 * @returns {{ accountId: string, userId: string } | null}
 */
export function parseUserResourceName(userName) {
  if (typeof userName !== "string") return null;
  const match = /^accounts\/([^/\s]+)\/users\/([^/\s]+)$/.exec(userName.trim());
  if (!match) return null;
  return { accountId: match[1], userId: match[2] };
}

/**
 * Whether a plan limit's raw usage percentage has reached 100%.
 * 99.6% rounds to "100%" for display, but is not yet capped.
 * @param {unknown} usedPercent
 * @returns {boolean}
 */
export function isPlanLimitReached(usedPercent) {
  return typeof usedPercent === "number" && Number.isFinite(usedPercent) && usedPercent >= 100;
}

/**
 * Which plan limit is currently reached (`"monthly"` takes precedence over
 * `"session"`), or `null` when both windows are under cap.
 * @param {{ monthlyUsedPercent?: number | null, sessionUsedPercent?: number | null } | null | undefined} snapshot
 * @returns {PlanLimitKind | null}
 */
export function reachedPlanLimit(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  if (isPlanLimitReached(snapshot.monthlyUsedPercent)) return "monthly";
  if (isPlanLimitReached(snapshot.sessionUsedPercent)) return "session";
  return null;
}

/**
 * Resolve credit standing from plan overage status, account suspend state, and
 * wallet ownership:
 * - ACTIVE + own wallet + UNSUSPENDED -> "available"
 * - ACTIVE + own wallet + CREDIT_DEPLETED -> "depleted"
 * - ACTIVE + org wallet or non-credit suspension -> "unavailable"
 * - ACTIVE + unknown wallet or suspend state -> "unconfirmed"
 * - DISABLED -> "unavailable"
 * - UNSPECIFIED / unreadable -> "unconfirmed"
 *
 * @param {{
 *   overageStatus?: string | null,
 *   suspendState?: string | null,
 *   ownsWallet?: boolean | null,
 * }} input
 * @returns {CreditStanding}
 */
export function resolveCreditStanding({
  overageStatus = null,
  suspendState = null,
  ownsWallet = null,
} = {}) {
  if (overageStatus === "OVERAGE_STATUS_ACTIVE") {
    if (ownsWallet === false) return "unavailable";
    if (ownsWallet === null || suspendState === null) return "unconfirmed";
    if (suspendState === "CREDIT_DEPLETED") return "depleted";
    if (suspendState !== "UNSUSPENDED") return "unavailable";
    return "available";
  }
  if (overageStatus === "OVERAGE_STATUS_DISABLED") {
    return "unavailable";
  }
  return "unconfirmed";
}

/**
 * Compact indicator to display when the user has reached a plan cap and is
 * drawing down (or has exhausted) own-wallet Nexus credits. Returns `null` when
 * under cap, unavailable, org-billed, suspended for non-credit reasons, or
 * unconfirmed so callers stay quiet and never show misleading standing.
 *
 * @param {CreditStandingSnapshot | null | undefined} snapshot
 * @returns {ActiveCreditIndicator | null}
 */
export function resolveActiveCreditIndicator(snapshot) {
  const limit = reachedPlanLimit(snapshot);
  if (!limit) return null;
  const standing = resolveCreditStanding(snapshot);
  if (standing === "available") {
    return { standing: "available", limit, label: "using credits" };
  }
  if (standing === "depleted") {
    return { standing: "depleted", limit, label: "credits used up" };
  }
  return null;
}

/**
 * Plain-text notice lines for CLI usage views (`nexus claude usage`).
 * Empty when no credit indicator is active.
 * @param {ActiveCreditIndicator | null | undefined} indicator
 * @returns {string[]}
 */
export function formatCreditStandingUsageLines(indicator) {
  if (!indicator) return [];
  const limitLabel = indicator.limit === "monthly" ? "Monthly plan limit reached" : "5-hour plan limit reached";
  if (indicator.standing === "depleted") {
    return [`Nexus plan: ${limitLabel} — credits used up. Add credits at ${NEXUS_BILLING_URL}`];
  }
  return [`Nexus plan: ${limitLabel} — using credits.`];
}

/**
 * Structured JSON payload for CLI `--json` views when an indicator is active,
 * or `null` when nothing should be added.
 * @param {ActiveCreditIndicator | null | undefined} indicator
 */
export function creditStandingJsonPayload(indicator) {
  if (!indicator) return null;
  return {
    status: indicator.standing,
    limit: indicator.limit,
    label: indicator.label,
    ...(indicator.standing === "depleted" ? { billingUrl: NEXUS_BILLING_URL } : {}),
  };
}

/**
 * Short 16-hex filename scope derived from a full SHA-256 key fingerprint (or
 * an already-sliced 16-hex scope), or "" when absent/invalid.
 * @param {string} [keyFingerprint]
 * @returns {string}
 */
export function creditStandingLockScope(keyFingerprint = "") {
  const trimmed = typeof keyFingerprint === "string" ? keyFingerprint.trim().toLowerCase() : "";
  if (SHA256_HEX_RE.test(trimmed)) return trimmed.slice(0, 16);
  if (FP_SCOPE_RE.test(trimmed)) return trimmed;
  return "";
}

/**
 * Per-key cache file inside `statusline-refresh/` so concurrent sessions under
 * one home using different Fireworks keys never evict each other's badge.
 * @param {string} [home]
 * @param {string} [keyFingerprint]
 */
export function creditStandingCachePath(home, keyFingerprint = "") {
  const scope = creditStandingLockScope(keyFingerprint);
  const name = scope ? `credit-standing-${scope}.json` : CACHE_FILENAME;
  return scopedCacheFilePath(path.join(CACHE_SUBDIR, name), home);
}

/**
 * Per-key sanitized last-attempt diagnostic file inside `statusline-refresh/`.
 * Records non-PII failure/unconfirmed metadata so `nexus status --verbose` can
 * explain why no credit indicator appeared while keeping the status line quiet.
 * @param {string} [home]
 * @param {string} [keyFingerprint]
 */
export function creditStandingLastAttemptPath(home, keyFingerprint = "") {
  const scope = creditStandingLockScope(keyFingerprint);
  const name = scope ? `credit-standing-${scope}.last.json` : LAST_ATTEMPT_FILENAME;
  return scopedCacheFilePath(path.join(CACHE_SUBDIR, name), home);
}

/**
 * Per-key refresh lock inside `statusline-refresh/`. Falls back to the
 * unscoped bootstrap lock when the key fingerprint is not yet known (first
 * refresh in pasted-key apiKeyHelper mode).
 * @param {string} [home]
 * @param {string} [keyFingerprint]
 */
export function creditStandingLockPath(home, keyFingerprint = "") {
  const scope = creditStandingLockScope(keyFingerprint);
  const name = scope ? `credit-standing-refresh-${scope}.lock` : LOCK_FILENAME;
  return scopedCacheFilePath(path.join(CACHE_SUBDIR, name), home);
}

/** @param {string} [home] */
export function creditStandingStoredKeyFingerprintPath(home) {
  return scopedCacheFilePath(path.join(CACHE_SUBDIR, STORED_KEY_FP_FILENAME), home);
}

/**
 * Read a private local state file only when `lstatSync` confirms it is a
 * regular file within `maxBytes`. Prevents named pipes (FIFOs) or symlinks
 * from blocking the synchronous status-line hot path.
 */
function readRegularFileSync(filePath, maxBytes = MAX_LOCAL_STATE_BYTES) {
  try {
    const info = lstatSync(filePath);
    if (!info.isFile() || info.size > maxBytes) return null;
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read the one-way sha256 fingerprint last confirmed for the machine's stored
 * key (written by the detached worker when resolving key-helper mode). Never
 * reads the secret store and never throws.
 * @param {string} [home]
 * @returns {string}
 */
export function readStoredKeyFingerprint(home) {
  if (!home) return "";
  const raw = readRegularFileSync(creditStandingStoredKeyFingerprintPath(home), 256);
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return SHA256_HEX_RE.test(trimmed) ? trimmed : "";
}

/**
 * Persist the one-way sha256 fingerprint confirmed for the stored key
 * (mode 0600, no secrets). Never throws.
 * @param {string} home
 * @param {string} fingerprint
 * @returns {boolean}
 */
export function writeStoredKeyFingerprint(home, fingerprint) {
  if (!home || typeof fingerprint !== "string" || !SHA256_HEX_RE.test(fingerprint)) {
    return false;
  }
  try {
    const file = creditStandingStoredKeyFingerprintPath(home);
    ensurePrivateParent(file);
    writeFileAtomicSync(file, `${fingerprint}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function finiteNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parse a plan usage response JSON object.
 * @param {unknown} body
 * @returns {{ monthlyUsedPercent: number | null, sessionUsedPercent: number | null, overageStatus: string | null } | null}
 */
export function parsePlanUsageBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = /** @type {Record<string, any>} */ (body);
  const overageStatus = typeof raw.overageStatus === "string" && KNOWN_OVERAGE_STATUSES.has(raw.overageStatus)
    ? raw.overageStatus
    : null;
  return {
    monthlyUsedPercent: finiteNumberOrNull(raw.monthly?.usedPercent),
    sessionUsedPercent: finiteNumberOrNull(raw.rollingWindow?.usedPercent),
    overageStatus,
  };
}

/**
 * Parse an account standing response JSON object.
 * When `organization` is absent or empty, own-wallet ownership is implied
 * (the server also disables overage on organization-billed wallets); any
 * non-empty `organization` marks the account org-billed.
 * @param {unknown} body
 * @returns {{ suspendState: string | null, ownsWallet: boolean | null } | null}
 */
export function parseAccountBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = /** @type {Record<string, any>} */ (body);
  const suspendState = typeof raw.suspendState === "string" && raw.suspendState.trim() !== ""
    ? raw.suspendState.trim()
    : null;
  let ownsWallet = null;
  if (typeof raw.organization === "string") {
    ownsWallet = raw.organization.trim() === "";
  } else if (raw.organization === undefined) {
    ownsWallet = true;
  }
  return { suspendState, ownsWallet };
}

/**
 * Read the sanitized credit standing cache from disk, or null if absent or
 * unreadable. Never blocks on non-regular files and never throws.
 * @param {string} [home]
 * @param {{ keyFingerprint?: string }} [options]
 * @returns {CreditStandingCacheRecord | null}
 */
export function readCreditStandingCache(home, { keyFingerprint = "" } = {}) {
  if (!home) return null;
  const raw = readRegularFileSync(creditStandingCachePath(home, keyFingerprint));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (typeof parsed.fetchedAt !== "number" || !Number.isFinite(parsed.fetchedAt)) return null;
    if (parsed.status !== "ok" && parsed.status !== "none") return null;
    const recordFingerprint = typeof parsed.keyFingerprint === "string" ? parsed.keyFingerprint : "";
    if (parsed.status === "none") {
      return { fetchedAt: parsed.fetchedAt, keyFingerprint: recordFingerprint, status: "none" };
    }
    return {
      fetchedAt: parsed.fetchedAt,
      keyFingerprint: recordFingerprint,
      status: "ok",
      monthlyUsedPercent: finiteNumberOrNull(parsed.monthlyUsedPercent),
      sessionUsedPercent: finiteNumberOrNull(parsed.sessionUsedPercent),
      overageStatus: typeof parsed.overageStatus === "string" && KNOWN_OVERAGE_STATUSES.has(parsed.overageStatus)
        ? parsed.overageStatus
        : null,
      suspendState: typeof parsed.suspendState === "string" && parsed.suspendState.trim() !== ""
        ? parsed.suspendState.trim()
        : null,
      ownsWallet: typeof parsed.ownsWallet === "boolean" ? parsed.ownsWallet : null,
    };
  } catch {
    return null;
  }
}

/**
 * Persist a sanitized credit standing cache entry atomically with 0600
 * permissions under a 0700 parent directory. Never writes API keys or PII, and
 * never throws.
 * @param {string} home
 * @param {CreditStandingCacheRecord} record
 * @returns {boolean}
 */
export function writeCreditStandingCache(home, record) {
  if (!home || !record || typeof record !== "object") return false;
  try {
    const recordFp = typeof record.keyFingerprint === "string" ? record.keyFingerprint : "";
    const file = creditStandingCachePath(home, recordFp);
    ensurePrivateParent(file);
    const payload = record.status === "ok"
      ? {
        fetchedAt: Number.isFinite(record.fetchedAt) ? record.fetchedAt : Date.now(),
        keyFingerprint: recordFp,
        status: "ok",
        monthlyUsedPercent: finiteNumberOrNull(record.monthlyUsedPercent),
        sessionUsedPercent: finiteNumberOrNull(record.sessionUsedPercent),
        overageStatus: typeof record.overageStatus === "string" && KNOWN_OVERAGE_STATUSES.has(record.overageStatus)
          ? record.overageStatus
          : null,
        suspendState: typeof record.suspendState === "string" && record.suspendState.trim() !== ""
          ? record.suspendState.trim()
          : null,
        ownsWallet: typeof record.ownsWallet === "boolean" ? record.ownsWallet : null,
      }
      : {
        fetchedAt: Number.isFinite(record.fetchedAt) ? record.fetchedAt : Date.now(),
        keyFingerprint: recordFp,
        status: "none",
      };
    writeFileAtomicSync(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function sanitizeHttpStatus(status) {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

/**
 * Read the sanitized last-attempt diagnostic for `keyFingerprint`, or null if
 * absent or unreadable. Guarded with `readRegularFileSync` so FIFOs/symlinks
 * never block, and strips any unexpected fields. Never throws.
 * @param {string} [home]
 * @param {{ keyFingerprint?: string }} [options]
 * @returns {CreditStandingLastAttempt | null}
 */
export function readCreditStandingLastAttempt(home, { keyFingerprint = "" } = {}) {
  if (!home) return null;
  const raw = readRegularFileSync(creditStandingLastAttemptPath(home, keyFingerprint));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) return null;
    if (!DIAGNOSTIC_OUTCOMES.has(parsed.outcome)) return null;
    if (!DIAGNOSTIC_STAGES.has(parsed.stage)) return null;
    const status = parsed.status === null ? null : sanitizeHttpStatus(parsed.status);
    if (parsed.status !== null && status === null) return null;
    return {
      at: parsed.at,
      outcome: parsed.outcome,
      stage: parsed.stage,
      status,
    };
  } catch {
    return null;
  }
}

/**
 * Persist a sanitized last-attempt diagnostic atomically with 0600 permissions.
 * Contains ONLY `{ at, outcome, stage, status }` — zero API keys, emails,
 * account IDs, or user IDs. Never throws.
 * @param {string} home
 * @param {{ at?: number, outcome: string, stage: string, status?: number | null }} record
 * @param {{ keyFingerprint?: string }} [options]
 * @returns {boolean}
 */
export function writeCreditStandingLastAttempt(home, record, { keyFingerprint = "" } = {}) {
  if (!home || !record || typeof record !== "object") return false;
  if (!DIAGNOSTIC_OUTCOMES.has(record.outcome) || !DIAGNOSTIC_STAGES.has(record.stage)) return false;
  try {
    const file = creditStandingLastAttemptPath(home, keyFingerprint);
    ensurePrivateParent(file);
    const payload = {
      at: Number.isFinite(record.at) ? record.at : Date.now(),
      outcome: record.outcome,
      stage: record.stage,
      status: sanitizeHttpStatus(record.status),
    };
    writeFileAtomicSync(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete the per-key last-attempt diagnostic once a confirmed snapshot succeeds.
 * Never throws.
 * @param {string} home
 * @param {{ keyFingerprint?: string }} [options]
 */
export function clearCreditStandingLastAttempt(home, { keyFingerprint = "" } = {}) {
  if (!home) return;
  try {
    rmSync(creditStandingLastAttemptPath(home, keyFingerprint), { force: true });
  } catch {}
}

function formatDiagnosticAge(at, now) {
  const deltaMs = now - at;
  if (!Number.isFinite(deltaMs) || deltaMs < -FUTURE_CLOCK_SKEW_MS) return "";
  if (deltaMs < 60_000) return "just now";
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m ago`;
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)}h ago`;
  return `${Math.floor(deltaMs / 86_400_000)}d ago`;
}

/**
 * Format a sanitized last-attempt diagnostic for `nexus status --verbose`.
 * Example: `unknown (account lookup returned 403, 2m ago)`.
 * @param {CreditStandingLastAttempt | null | undefined} record
 * @param {number} [now]
 * @returns {string}
 */
export function formatCreditStandingLastAttempt(record, now = Date.now()) {
  if (!record || !DIAGNOSTIC_STAGES.has(record.stage) || !DIAGNOSTIC_OUTCOMES.has(record.outcome)) {
    return "";
  }
  const stageLabel = DIAGNOSTIC_STAGE_LABELS[record.stage];
  let detail;
  if (typeof record.status === "number") {
    if (record.status >= 200 && record.status < 300) {
      const qualifier = record.outcome === "unconfirmed"
        ? "unconfirmed"
        : record.outcome === "none"
          ? "no matching record"
          : "unreadable response";
      detail = `${stageLabel} returned ${record.status} (${qualifier})`;
    } else {
      detail = `${stageLabel} returned ${record.status}`;
    }
  } else {
    detail = `${stageLabel} failed`;
  }
  const age = formatDiagnosticAge(record.at, now);
  return age ? `unknown (${detail}, ${age})` : `unknown (${detail})`;
}

/**
 * Remove all cached credit standing entries, last-attempt diagnostics, refresh
 * locks, and stored-key fingerprint files for `home` (e.g. on `nexus claude on`/
 * `off`, `nexus logout`, or key change). Never throws.
 * @param {string} home
 */
export function clearCreditStandingCache(home) {
  if (!home) return;
  for (const file of [
    creditStandingCachePath(home),
    creditStandingLastAttemptPath(home),
    creditStandingLockPath(home),
    creditStandingStoredKeyFingerprintPath(home),
  ]) {
    try {
      rmSync(file, { force: true });
    } catch {}
  }
  const dir = path.dirname(creditStandingCachePath(home));
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (
      SCOPED_CACHE_FILE_RE.test(name)
      || SCOPED_LAST_ATTEMPT_FILE_RE.test(name)
      || SCOPED_LOCK_FILE_RE.test(name)
    ) {
      try {
        rmSync(path.join(dir, name), { force: true });
      } catch {}
    }
  }
}

function effectiveCacheTtlMs(cache, { ttlMs = CREDIT_STANDING_TTL_MS, noPlanTtlMs = CREDIT_STANDING_NO_PLAN_TTL_MS } = {}) {
  return cache?.status === "none" ? noPlanTtlMs : ttlMs;
}

/**
 * Whether `cache` is fresh enough to skip a background refresh for the active key.
 * Fail-closed: returns `false` when `expectedFingerprint` is empty.
 * @param {CreditStandingCacheRecord | null} cache
 * @param {{ expectedFingerprint?: string, now?: number, ttlMs?: number, noPlanTtlMs?: number }} [options]
 */
export function isCreditStandingCacheFresh(cache, {
  expectedFingerprint = "",
  now = Date.now(),
  ttlMs = CREDIT_STANDING_TTL_MS,
  noPlanTtlMs = CREDIT_STANDING_NO_PLAN_TTL_MS,
} = {}) {
  if (!cache || !expectedFingerprint) return false;
  if (cache.keyFingerprint !== expectedFingerprint) return false;
  if (cache.fetchedAt > now + FUTURE_CLOCK_SKEW_MS) return false;
  return now - cache.fetchedAt < effectiveCacheTtlMs(cache, { ttlMs, noPlanTtlMs });
}

/**
 * Hot-path read of the active credit indicator from disk cache only (0ms
 * network). Returns `null` when disabled, missing, stale beyond `maxAgeMs`,
 * missing or mismatched key fingerprint, under cap, unavailable, or
 * unconfirmed. Never throws.
 *
 * @param {string} home
 * @param {{
 *   expectedFingerprint?: string,
 *   now?: number,
 *   env?: NodeJS.ProcessEnv,
 *   maxAgeMs?: number,
 * }} [options]
 * @returns {ActiveCreditIndicator | null}
 */
export function readActiveCreditIndicator(home, {
  expectedFingerprint = "",
  now = Date.now(),
  env = process.env,
  maxAgeMs = CREDIT_STANDING_MAX_AGE_MS,
} = {}) {
  try {
    if (env?.NEXUS_CREDIT_STATUS === "0") return null;
    if (!home || !expectedFingerprint) return null;
    const cache = readCreditStandingCache(home, { keyFingerprint: expectedFingerprint });
    if (!cache) return null;
    if (cache.keyFingerprint !== expectedFingerprint) return null;
    if (cache.fetchedAt > now + FUTURE_CLOCK_SKEW_MS) return null;
    if (now - cache.fetchedAt > maxAgeMs) return null;
    if (cache.status !== "ok") return null;
    return resolveActiveCreditIndicator(cache);
  } catch {
    return null;
  }
}

/** Generate a unique ownership token for a single credit-standing refresh lock. */
export function createRefreshLockToken() {
  return `${process.pid}-${randomBytes(12).toString("hex")}`;
}

/**
 * Read the current refresh lock's ownership token, or "" when absent/unreadable.
 * Uses regular-file checks so a FIFO/symlink never blocks or misleads.
 * @param {string} [home]
 * @param {{ keyFingerprint?: string }} [options]
 * @returns {string}
 */
export function readCreditStandingLockToken(home, { keyFingerprint = "" } = {}) {
  if (!home) return "";
  const raw = readRegularFileSync(creditStandingLockPath(home, keyFingerprint), 256);
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * True only when the lock file on disk still carries `lockToken`.
 * @param {string} home
 * @param {string} lockToken
 * @param {{ keyFingerprint?: string }} [options]
 */
export function ownsCreditStandingRefreshLock(home, lockToken, { keyFingerprint = "" } = {}) {
  return Boolean(home && lockToken && readCreditStandingLockToken(home, { keyFingerprint }) === lockToken);
}

/**
 * Whether a non-stale refresh cooldown lock is currently held on disk.
 * Used by periodic live-meter polling so fast gateway failures respect the
 * 60-second cooldown instead of retrying every poll tick. Never throws.
 * @param {string} [home]
 * @param {{ keyFingerprint?: string, now?: number, lockTtlMs?: number }} [options]
 * @returns {boolean}
 */
export function hasActiveCreditStandingRefreshLock(home, {
  keyFingerprint = "",
  now = Date.now(),
  lockTtlMs = CREDIT_STANDING_LOCK_TTL_MS,
} = {}) {
  if (!home) return false;
  try {
    const info = lstatSync(creditStandingLockPath(home, keyFingerprint));
    if (!info.isFile()) return false;
    if (info.mtimeMs > now + FUTURE_CLOCK_SKEW_MS) return false;
    return now - info.mtimeMs < lockTtlMs;
  } catch {
    return false;
  }
}

function createLockFile(lockPath, lockToken) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  try {
    const fd = openSync(lockPath, flags, 0o600);
    try {
      if (lockToken) {
        writeSync(fd, `${lockToken}\n`, 0, "utf8");
      }
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Atomically replace/claim the refresh lock for an interactive foreground CLI
 * refresh so any in-flight detached worker sees lost ownership and will not
 * overwrite the CLI's fresher snapshot or unlink its lock. Never throws.
 * @param {string} home
 * @param {string} lockToken
 * @param {{ keyFingerprint?: string }} [options]
 * @returns {boolean}
 */
function acquireForegroundCreditStandingLock(home, lockToken, { keyFingerprint = "" } = {}) {
  if (!home || !lockToken) return false;
  try {
    const lockPath = creditStandingLockPath(home, keyFingerprint);
    ensurePrivateParent(lockPath);
    writeFileAtomicSync(lockPath, `${lockToken}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the refresh lock file. When `lockToken` is given, only removes the
 * lock if its ownership token still matches, so an older runner can never
 * delete a newer runner's lock. Never throws.
 * @param {string} home
 * @param {{ lockToken?: string, keyFingerprint?: string }} [options]
 * @returns {boolean}
 */
export function releaseCreditStandingRefreshLock(home, { lockToken = "", keyFingerprint = "" } = {}) {
  if (!home) return false;
  try {
    if (lockToken && !ownsCreditStandingRefreshLock(home, lockToken, { keyFingerprint })) {
      return false;
    }
    rmSync(creditStandingLockPath(home, keyFingerprint), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether the status line should spawn a detached credit-standing
 * refresh, and atomically claim the lock when so. Synchronous and safe to call
 * on every render: fresh caches return `false` without touching the lock, and
 * test/kill-switch gates return `false` before touching disk.
 *
 * @param {{
 *   home?: string,
 *   expectedFingerprint?: string,
 *   now?: number,
 *   env?: NodeJS.ProcessEnv,
 *   ttlMs?: number,
 *   noPlanTtlMs?: number,
 *   lockTtlMs?: number,
 *   lockToken?: string,
 * }} [options]
 * @returns {boolean}
 */
export function claimCreditStandingRefresh({
  home = "",
  expectedFingerprint = "",
  now = Date.now(),
  env = process.env,
  ttlMs = CREDIT_STANDING_TTL_MS,
  noPlanTtlMs = CREDIT_STANDING_NO_PLAN_TTL_MS,
  lockTtlMs = CREDIT_STANDING_LOCK_TTL_MS,
  lockToken = createRefreshLockToken(),
} = {}) {
  try {
    if (
      env?.NEXUS_TEST === "1"
      || env?.NEXUS_STATUSLINE_REFRESH === "0"
      || env?.NEXUS_CREDIT_STATUS === "0"
    ) {
      return false;
    }
    if (!home) return false;
    const cache = readCreditStandingCache(home, { keyFingerprint: expectedFingerprint });
    if (isCreditStandingCacheFresh(cache, { expectedFingerprint, now, ttlMs, noPlanTtlMs })) {
      return false;
    }
    const lockPath = creditStandingLockPath(home, expectedFingerprint);
    ensurePrivateParent(lockPath);
    if (createLockFile(lockPath, lockToken)) return true;

    let info;
    try {
      info = lstatSync(lockPath);
    } catch {
      return createLockFile(lockPath, lockToken);
    }
    if (!info.isFile()) return false;
    if (now - info.mtimeMs < lockTtlMs) return false;

    // Atomically claim a stale lock: move it aside and confirm it was still stale.
    const aside = `${lockPath}.${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      renameSync(lockPath, aside);
    } catch {
      return false;
    }
    try {
      const asideInfo = lstatSync(aside);
      if (!asideInfo.isFile() || now - asideInfo.mtimeMs < lockTtlMs) {
        try {
          linkSync(aside, lockPath);
        } finally {
          unlinkSync(aside);
        }
        return false;
      }
      unlinkSync(aside);
    } catch {
      try { unlinkSync(aside); } catch {}
      return false;
    }
    return createLockFile(lockPath, lockToken);
  } catch {
    return false;
  }
}

/**
 * Resolve the gateway base URL, enforcing HTTPS for any non-loopback host so
 * API keys are never sent in plaintext over remote HTTP. Returns "" when
 * invalid or disallowed.
 */
function gatewayBase(gatewayUrl = "", env = process.env) {
  const candidate = (gatewayUrl || env?.NEXUS_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL).trim();
  if (!candidate) return "";
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return "";
  }
  if (!isHttpsOrLoopbackHttp(parsed)) {
    return "";
  }
  return candidate.replace(/\/+$/, "");
}

async function boundedGet(url, apiKey, deadline, fetchFn) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  try {
    return await fetchFn(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(remaining),
    });
  } catch {
    return null;
  }
}

/**
 * Internal snapshot fetcher returning both the public outcome and any
 * sanitized diagnostic metadata for `credit-standing-<fp16>.last.json`.
 */
async function fetchCreditStandingSnapshotDetailed({
  apiKey,
  userName,
  gatewayUrl = "",
  timeoutMs = CREDIT_STANDING_FETCH_TIMEOUT_MS,
  env = process.env,
  fetchFn = fetch,
}) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  const parsedUser = parseUserResourceName(userName);
  if (!key || !parsedUser) {
    return { outcome: "none", diagnostic: { outcome: "none", stage: "users", status: null } };
  }

  const base = gatewayBase(gatewayUrl, env);
  if (!base) {
    return { outcome: "error", diagnostic: { outcome: "error", stage: "usage", status: null } };
  }
  const encodedAccount = encodeURIComponent(parsedUser.accountId);
  const encodedUser = encodeURIComponent(parsedUser.userId);
  const usageUrl = `${base}/v1/accounts/${encodedAccount}/users/${encodedUser}/nexusPlanUsage`;
  const accountUrl = `${base}/v1/accounts/${encodedAccount}`;
  const deadline = Date.now() + Math.max(1, timeoutMs);

  const [usageRes, accountRes] = await Promise.all([
    boundedGet(usageUrl, key, deadline, fetchFn),
    boundedGet(accountUrl, key, deadline, fetchFn),
  ]);

  if (!usageRes) {
    return { outcome: "error", diagnostic: { outcome: "error", stage: "usage", status: null } };
  }
  if (!usageRes.ok) {
    const outcome = isDefiniteRefusal(usageRes.status) ? "none" : "error";
    return {
      outcome,
      diagnostic: { outcome, stage: "usage", status: sanitizeHttpStatus(usageRes.status) },
    };
  }
  const parsedUsage = parsePlanUsageBody(await readBoundedJson(usageRes, MAX_CREDIT_RESPONSE_BYTES));
  if (!parsedUsage) {
    return {
      outcome: "error",
      diagnostic: { outcome: "error", stage: "usage", status: sanitizeHttpStatus(usageRes.status) },
    };
  }

  if (!accountRes) {
    return { outcome: "error", diagnostic: { outcome: "error", stage: "account", status: null } };
  }
  if (!accountRes.ok) {
    if (isDefiniteRefusal(accountRes.status)) {
      const snapshot = {
        ...parsedUsage,
        suspendState: null,
        ownsWallet: null,
      };
      const standing = resolveCreditStanding(snapshot);
      return {
        outcome: "ok",
        snapshot,
        diagnostic: standing === "unconfirmed"
          ? { outcome: "unconfirmed", stage: "account", status: sanitizeHttpStatus(accountRes.status) }
          : null,
      };
    }
    return {
      outcome: "error",
      diagnostic: { outcome: "error", stage: "account", status: sanitizeHttpStatus(accountRes.status) },
    };
  }
  const parsedAccount = parseAccountBody(await readBoundedJson(accountRes, MAX_CREDIT_RESPONSE_BYTES));
  if (!parsedAccount) {
    return {
      outcome: "error",
      diagnostic: { outcome: "error", stage: "account", status: sanitizeHttpStatus(accountRes.status) },
    };
  }

  const snapshot = {
    ...parsedUsage,
    ...parsedAccount,
  };
  const standing = resolveCreditStanding(snapshot);
  let diagnostic = null;
  if (standing === "unconfirmed") {
    diagnostic = snapshot.overageStatus === "OVERAGE_STATUS_ACTIVE"
      ? { outcome: "unconfirmed", stage: "account", status: sanitizeHttpStatus(accountRes.status) }
      : { outcome: "unconfirmed", stage: "usage", status: sanitizeHttpStatus(usageRes.status) };
  }
  return {
    outcome: "ok",
    snapshot,
    diagnostic,
  };
}

/**
 * Poll the plan usage and account standing endpoints concurrently with a
 * bounded timeout. Never throws.
 *
 * @param {{
 *   apiKey: string,
 *   userName: string,
 *   gatewayUrl?: string,
 *   timeoutMs?: number,
 *   env?: NodeJS.ProcessEnv,
 *   fetchFn?: typeof fetch,
 * }} options
 * @returns {Promise<
 *   | { outcome: "ok", snapshot: CreditStandingSnapshot }
 *   | { outcome: "none" }
 *   | { outcome: "error" }
 * >}
 */
export async function fetchCreditStandingSnapshot(options) {
  const detailed = await fetchCreditStandingSnapshotDetailed(options);
  return detailed.outcome === "ok"
    ? { outcome: "ok", snapshot: detailed.snapshot }
    : { outcome: detailed.outcome };
}

/**
 * Resolve `accounts/{account}/users/{user}` for `apiKey` within `deadline`:
 * checks the local sign-in record first (zero network), and delegates fallback
 * verification + user lookup to the shared `lookupUserNameForKey` helper.
 * Never throws.
 */
async function resolveUserNameBounded({ apiKey, home, userName = "", gatewayUrl = "", deadline, env = process.env, fetchFn = fetch }) {
  if (parseUserResourceName(userName)) return userName.trim();

  const fingerprint = creditKeyFingerprint(apiKey);
  if (home) {
    try {
      const minted = await readMintedKeyState(home);
      if (
        minted?.userName
        && parseUserResourceName(minted.userName)
        && Boolean(fingerprint)
        && minted.keyFingerprint === fingerprint
      ) {
        return minted.userName.trim();
      }
    } catch {
      // Fall through to gateway lookup.
    }
  }

  const base = gatewayBase(gatewayUrl, env);
  if (!base) {
    return { outcome: "error", diagnostic: { outcome: "error", stage: "verify", status: null } };
  }
  const { lookupUserNameForKey } = await import("./user-settings.mjs");
  const lookup = await lookupUserNameForKey(apiKey, {
    gatewayUrl: base,
    deadline,
    quiet: true,
    fetchFn,
    maxBytes: MAX_CREDIT_RESPONSE_BYTES,
    includeDiagnostic: true,
  });
  if (lookup.ok && parseUserResourceName(lookup.userName)) {
    return lookup.userName.trim();
  }
  const outcome = lookup.definite ? "none" : "error";
  const stage = DIAGNOSTIC_STAGES.has(lookup.stage) ? lookup.stage : "verify";
  return {
    outcome,
    diagnostic: {
      outcome,
      stage,
      status: sanitizeHttpStatus(lookup.status),
    },
  };
}

/**
 * Read a stored Fireworks API key for detached background refreshes ONLY when
 * storage is non-interactive (legacy literal ref, encrypted file, plaintext, or
 * in-memory test store). Native OS keychains (macOS Keychain, Windows
 * Credential Manager, Linux Secret Service) are never read from a background
 * worker so turn refreshes never prompt or stall past the 60s lock TTL.
 */
async function resolveNonInteractiveStoredKey(home, { detectBackendFn } = {}) {
  if (!home) return "";
  try {
    const [{ readGlobalConfig }, { isFireworksShapedKey, isFirePassKey }, { isLegacyLiteralConfigRef }] = await Promise.all([
      import("../config/global-config.mjs"),
      import("../keys/key-type.mjs"),
      import("../keys/config-ref.mjs"),
    ]);
    const config = await readGlobalConfig(home);
    if (!config.apiKey) return "";
    if (isLegacyLiteralConfigRef(config.apiKey) && isFireworksShapedKey(config.apiKey)) {
      return config.apiKey.trim();
    }
    const detect = detectBackendFn ?? (await import("../keys/secret-store.mjs")).detectSecretBackend;
    const detected = await detect(home);
    if (detected?.backend === "plaintext") {
      const { readPlaintextSecret } = await import("../keys/plaintext-secret-store.mjs");
      const plaintext = (await readPlaintextSecret(home).catch(() => ""))?.trim() ?? "";
      return plaintext && !isFirePassKey(plaintext) ? plaintext : "";
    }
    if (detected?.backend === "file" || detected?.backend === "memory") {
      const { resolveFireworksApiKeyValue } = await import("../keys/api-key.mjs");
      return (await resolveFireworksApiKeyValue({ home }).catch(() => ""))?.trim() ?? "";
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Persist a refreshed record (and update or clear the sanitized last-attempt
 * diagnostic) only while this caller still owns its lock (when lock-coordinated),
 * keeping the lock as a cooldown if the cache write fails.
 * @returns {{ lostOwnership: boolean }}
 */
function commitCreditStandingCache({
  home,
  record,
  diagnostic = null,
  now = Date.now(),
  lockToken = "",
  lockKeyFingerprint,
  writeCacheFn = writeCreditStandingCache,
  storedFingerprint = "",
}) {
  if (!home) return { lostOwnership: false };
  const lockScope = lockKeyFingerprint !== undefined ? lockKeyFingerprint : record.keyFingerprint;
  if (lockToken && !ownsCreditStandingRefreshLock(home, lockToken, { keyFingerprint: lockScope })) {
    return { lostOwnership: true };
  }
  const wrote = writeCacheFn(home, record);
  if (diagnostic) {
    writeCreditStandingLastAttempt(home, { ...diagnostic, at: now }, { keyFingerprint: record.keyFingerprint });
  } else if (wrote) {
    clearCreditStandingLastAttempt(home, { keyFingerprint: record.keyFingerprint });
  }
  if (!wrote) {
    // Keep the refresh lock on disk until its TTL so an unwritable cache
    // directory does not trigger a tight refresh loop on every render.
    return { lostOwnership: false };
  }
  if (storedFingerprint) {
    writeStoredKeyFingerprint(home, storedFingerprint);
  }
  if (lockToken) {
    releaseCreditStandingRefreshLock(home, { lockToken, keyFingerprint: lockScope });
  }
  return { lostOwnership: false };
}

/**
 * Refresh the on-disk credit standing cache for `home`. Used by the detached
 * status-line refresher and by `loadCreditStanding`.
 *
 * Cache monotonicity: transient errors leave any existing cache untouched (and
 * keep the refresh lock as a retry cooldown); definite refusals (`400`/`401`/
 * `403`/`404`) write a `"none"` record so non-plan accounts don't re-poll every
 * turn. Failure/none/unconfirmed outcomes record a sanitized 0600 diagnostic in
 * `credit-standing-<fp16>.last.json`; confirmed snapshots clear it. Never throws.
 *
 * @param {{
 *   home?: string,
 *   apiKey?: string,
 *   userName?: string,
 *   gatewayUrl?: string,
 *   timeoutMs?: number,
 *   now?: number,
 *   env?: NodeJS.ProcessEnv,
 *   fetchFn?: typeof fetch,
 *   lockToken?: string,
 *   lockKeyFingerprint?: string,
 *   writeCacheFn?: typeof writeCreditStandingCache,
 *   detectBackendFn?: (home?: string) => Promise<{ backend: string }>,
 * }} [options]
 * @returns {Promise<CreditStandingCacheRecord | null>}
 */
export async function refreshCreditStandingCache({
  home = "",
  apiKey = "",
  userName = "",
  gatewayUrl = "",
  timeoutMs = CREDIT_STANDING_FETCH_TIMEOUT_MS,
  now = Date.now(),
  env = process.env,
  fetchFn = fetch,
  lockToken = "",
  lockKeyFingerprint,
  writeCacheFn = writeCreditStandingCache,
  detectBackendFn,
} = {}) {
  try {
    if (env?.NEXUS_CREDIT_STATUS === "0") return null;

    let resolvedKey = typeof apiKey === "string" ? apiKey.trim() : "";
    let keyFromStoredStore = false;
    if (!resolvedKey) {
      // Prefer the key Claude Code already carries in its gateway header; fall
      // back only to non-interactive stored backends so detached refreshes
      // never prompt an OS keychain on a background turn.
      resolvedKey = claudeFireworksKeyFrom({ env });
      if (!resolvedKey && home) {
        resolvedKey = await resolveNonInteractiveStoredKey(home, { detectBackendFn });
        keyFromStoredStore = Boolean(resolvedKey);
      }
    }
    if (!resolvedKey) return null;

    const fingerprint = creditKeyFingerprint(resolvedKey);
    const storedFingerprint = keyFromStoredStore ? fingerprint : "";
    const lockScope = lockKeyFingerprint !== undefined ? lockKeyFingerprint : fingerprint;
    const recordErrorDiagnostic = (diagnostic) => {
      if (!home || !diagnostic) return;
      if (lockToken && !ownsCreditStandingRefreshLock(home, lockToken, { keyFingerprint: lockScope })) {
        return;
      }
      writeCreditStandingLastAttempt(home, { ...diagnostic, at: now }, { keyFingerprint: fingerprint });
    };

    const deadline = Date.now() + Math.max(1, timeoutMs);
    const resolvedUser = await resolveUserNameBounded({
      apiKey: resolvedKey,
      home,
      userName,
      gatewayUrl,
      deadline,
      env,
      fetchFn,
    });

    if (typeof resolvedUser !== "string") {
      if (resolvedUser.outcome === "none" && home) {
        const record = { fetchedAt: now, keyFingerprint: fingerprint, status: /** @type {const} */ ("none") };
        const { lostOwnership } = commitCreditStandingCache({
          home,
          record,
          diagnostic: resolvedUser.diagnostic,
          now,
          lockToken,
          lockKeyFingerprint,
          writeCacheFn,
          storedFingerprint,
        });
        return lostOwnership ? null : record;
      }
      recordErrorDiagnostic(resolvedUser.diagnostic);
      return null;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      recordErrorDiagnostic({ outcome: "error", stage: "usage", status: null });
      return null;
    }
    const result = await fetchCreditStandingSnapshotDetailed({
      apiKey: resolvedKey,
      userName: resolvedUser,
      gatewayUrl,
      timeoutMs: remaining,
      env,
      fetchFn,
    });

    if (result.outcome === "error") {
      recordErrorDiagnostic(result.diagnostic);
      return null;
    }
    /** @type {CreditStandingCacheRecord} */
    const record = result.outcome === "ok"
      ? { fetchedAt: now, keyFingerprint: fingerprint, status: "ok", ...result.snapshot }
      : { fetchedAt: now, keyFingerprint: fingerprint, status: "none" };
    if (home) {
      const { lostOwnership } = commitCreditStandingCache({
        home,
        record,
        diagnostic: result.diagnostic ?? null,
        now,
        lockToken,
        lockKeyFingerprint,
        writeCacheFn,
        storedFingerprint,
      });
      if (lostOwnership) return null;
    }
    return record;
  } catch {
    return null;
  }
}

/**
 * Shared loader for explicit CLI commands (`nexus claude usage`, `nexus status`).
 * Uses a fresh on-disk cache immediately; otherwise refreshes with a short
 * bounded timeout (skipped under `NEXUS_TEST=1` unless `allowNetworkInTest` is
 * passed) and falls back to any still-valid cache entry.
 *
 * Security & attribution invariants:
 * - Fail-closed without an explicit `apiKey`: never falls back to another
 *   account's browser `minted-key.json` fingerprint.
 * - Foreground gateway pinning: ignores untrusted `NEXUS_GATEWAY_URL` /
 *   `FIRECONNECT_GATEWAY_URL` env overrides and pins to
 *   `CREDIT_STANDING_DEFAULT_GATEWAY_URL` unless an explicit `gatewayUrl`
 *   option is injected (e.g. in tests).
 * - Never throws.
 *
 * @param {{
 *   home?: string,
 *   apiKey?: string,
 *   userName?: string,
 *   gatewayUrl?: string,
 *   timeoutMs?: number,
 *   now?: number,
 *   env?: NodeJS.ProcessEnv,
 *   fetchFn?: typeof fetch,
 *   allowNetworkInTest?: boolean,
 *   respectCooldown?: boolean,
 * }} [options]
 * @returns {Promise<ActiveCreditIndicator | null>}
 */
export async function loadCreditStanding({
  home = "",
  apiKey = "",
  userName = "",
  gatewayUrl = "",
  timeoutMs = CREDIT_STANDING_CLI_TIMEOUT_MS,
  now = Date.now(),
  env = process.env,
  fetchFn = fetch,
  allowNetworkInTest = false,
  respectCooldown = false,
} = {}) {
  try {
    if (env?.NEXUS_CREDIT_STATUS === "0") return null;

    const expectedFingerprint = creditKeyFingerprint(apiKey);
    if (!expectedFingerprint) return null;

    const cached = home ? readCreditStandingCache(home, { keyFingerprint: expectedFingerprint }) : null;
    if (isCreditStandingCacheFresh(cached, { expectedFingerprint, now })) {
      return cached.status === "ok" ? resolveActiveCreditIndicator(cached) : null;
    }

    const cooldownActive = respectCooldown
      && home
      && hasActiveCreditStandingRefreshLock(home, { keyFingerprint: expectedFingerprint, now });
    const canFetch = Boolean(apiKey) && !cooldownActive && (allowNetworkInTest || env?.NEXUS_TEST !== "1");
    if (canFetch) {
      const lockToken = home ? createRefreshLockToken() : "";
      const locked = home
        ? acquireForegroundCreditStandingLock(home, lockToken, { keyFingerprint: expectedFingerprint })
        : false;
      const refreshed = await refreshCreditStandingCache({
        home,
        apiKey,
        userName,
        gatewayUrl: gatewayUrl || CREDIT_STANDING_DEFAULT_GATEWAY_URL,
        timeoutMs,
        now,
        env,
        fetchFn,
        lockToken: locked ? lockToken : "",
        lockKeyFingerprint: expectedFingerprint,
      });
      if (refreshed) {
        return refreshed.status === "ok" ? resolveActiveCreditIndicator(refreshed) : null;
      }
    }

    return home ? readActiveCreditIndicator(home, { expectedFingerprint, now, env }) : null;
  } catch {
    return null;
  }
}
