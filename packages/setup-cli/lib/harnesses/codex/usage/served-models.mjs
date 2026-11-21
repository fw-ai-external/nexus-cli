/**
 * Which model actually served each Codex `auto` call.
 *
 * Codex logs only the requested model (`auto`) plus each call's `response_id`.
 * Fireworks reports the served model per call for the session, so
 * `codex usage` joins the two here. Everything is best effort: one short
 * deadline per session, no retries, and any failure leaves the call unresolved
 * (its cost stays `n/a`). Resolved calls are cached on disk, so a finished
 * session is looked up once and reads offline afterwards.
 */

import { readFile } from "node:fs/promises";
import { fireworksInferenceUrl, recordedHarnessResidency } from "../../../fireworks/residency.mjs";
import { catalogKeyFingerprint, ensureCacheParent, scopedCacheFilePath } from "../../../fireworks/serverless-catalog-cache.mjs";
import { writeFileAtomic } from "../../../io/atomic-write.mjs";
import { numberValue } from "../../claude/usage/report.mjs";
import { sanitize } from "../../../ui/sanitize.mjs";
import { warnInsecureUrlOverride } from "../../../system/url-override-warning.mjs";

/**
 * The prefix for the session-calls route; `/{session_id}/calls` follows.
 * Overridable (`NEXUS_SESSION_CALLS_BASE_URL`) for tests and staging.
 */
export const SESSION_CALLS_BASE_URL = "https://api.fireworks.ai/inference/v1/nexus/sessions";
/** Shared by every page of one session's lookup. */
export const SESSION_CALLS_TIMEOUT_MS = 1500;
const PAGE_LIMIT = 500;
const MAX_PAGES = 4;
/** Codex logs a call when it completes; the route records it when it starts. */
const SINCE_MARGIN_MS = 60_000;
const CACHE_FILE = "codex-served-models.json";
/** How long a "tracing is off" answer stands before the session is asked again. */
const TRACING_OFF_TTL_MS = 24 * 60 * 60 * 1000;
const TRACING_OFF = "tracing is off for this account";

/**
 * Milliseconds a 429 asks us to wait: Retry-After in seconds or as an HTTP
 * date, clamped to (0, RATE_LIMIT_MAX_MS]; the default when absent or unreadable.
 * @param {string | null | undefined} header
 * @param {number} nowMs
 */
export function retryAfterMs(header, nowMs = Date.now()) {
  const text = typeof header === "string" ? header.trim() : "";
  let ms = NaN;
  if (/^\d+$/.test(text)) ms = Number(text) * 1000;
  else if (text) ms = Date.parse(text) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return RATE_LIMIT_DEFAULT_MS;
  return Math.min(ms, RATE_LIMIT_MAX_MS);
}
/**
 * Sessions looked up at once. The route allows each account a burst of 10
 * lookups, so a cold multi-session run asks two at a time and stops at the
 * first 429 instead of firing a volley that mostly gets refused.
 */
const LOOKUP_CONCURRENCY = 2;
/** A 429 without a usable Retry-After waits this long before asking again. */
const RATE_LIMIT_DEFAULT_MS = 60_000;
/** Ceiling on a server-sent Retry-After, so one bad header can't stall lookups for long. */
const RATE_LIMIT_MAX_MS = 10 * 60_000;
/** The failure reason for a session not asked about because the route rate-limited this account. */
export const SERVED_LOOKUP_RATE_LIMITED = "rate limited; a later run fills these in";

/** Run `fn` over `items` with at most `limit` in flight. */
async function forEachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** v3: keys for calls without a response id carry their rollout's thread id. */
const CACHE_VERSION = 3;
const CACHE_MAX_SESSIONS = 500;

/**
 * Whether this process may call the route at all. `NEXUS_SERVED_MODEL_LOOKUP=0`
 * turns it off; under `NEXUS_TEST` it stays off unless a spec points it at a
 * local server, so tests never reach the network.
 */
export function servedModelLookupEnabled(env = process.env) {
  if (env.NEXUS_SERVED_MODEL_LOOKUP === "0") return false;
  if (env.NEXUS_TEST === "1" && !env.NEXUS_SESSION_CALLS_BASE_URL) return false;
  return true;
}

function sessionCallsBaseUrl(env = process.env) {
  const override = env.NEXUS_SESSION_CALLS_BASE_URL;
  // The key goes to this URL, so a plain-HTTP remote override gets the same
  // warning as every other endpoint override.
  if (override) warnInsecureUrlOverride(override, "NEXUS_SESSION_CALLS_BASE_URL");
  return (override || SESSION_CALLS_BASE_URL).replace(/\/+$/, "");
}


/** The token tuple both sides report: total prompt (cached included), cached, output. */
export function usageSignature(input, cached, output) {
  return `${numberValue(input)}:${numberValue(cached)}:${numberValue(output)}`;
}

/**
 * Every recorded call in one session, oldest first, or `null` when the lookup
 * failed, with why in `failed` ("HTTP 403", "timeout", ...). `truncated` marks a
 * list cut at the page cap (only exact response-id matches are safe from it);
 * `tracingOff` means the account records no calls.
 *
 * @returns {Promise<{ calls: object[], truncated: boolean, tracingOff: boolean } | { failed: string, retryAfterMs?: number }>}
 *
 * @param {{ sessionId: string, since?: string, apiKey: string, baseUrl?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} args
 */
export async function fetchSessionCalls({
  sessionId,
  since = "",
  apiKey,
  baseUrl = sessionCallsBaseUrl(),
  timeoutMs = SESSION_CALLS_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const calls = [];
    // Pages are ordered by (started_at, trace_id); `next_since` + `next_after`
    // name the last call, and the next page starts strictly after it.
    let cursor = { since, after: "" };
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(`${baseUrl}/${encodeURIComponent(sessionId)}/calls`);
      url.searchParams.set("limit", String(PAGE_LIMIT));
      if (cursor.since) url.searchParams.set("since", cursor.since);
      if (cursor.after) url.searchParams.set("after", cursor.after);
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal,
      });
      if (res.status === 429) {
        return { failed: `HTTP ${res.status}`, retryAfterMs: retryAfterMs(res.headers?.get?.("retry-after")) };
      }
      if (!res.ok) return { failed: `HTTP ${res.status}` };
      const body = await res.json().catch(() => null);
      if (body?.tracing_enabled === false) return { calls: [], truncated: false, tracingOff: true };
      if (!Array.isArray(body?.calls)) return { failed: "unexpected response" };
      calls.push(...body.calls);
      if (!body.next_since) return { calls, truncated: false, tracingOff: false };
      const next = { since: body.next_since, after: body.next_after || "" };
      // A cursor that doesn't move would loop until the page cap; treat it as a bad answer.
      if (next.since === cursor.since && next.after === cursor.after) return { failed: "unexpected response" };
      cursor = next;
    }
    // More rows than we read: hand back what we have, marked truncated. The
    // caller trusts only exact response-id matches from a partial list.
    return { calls, truncated: true, tracingOff: false };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { failed: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network error" };
  }
}

function servedFrom(call) {
  // Printed in every view, so stripped of terminal control sequences like log ids.
  const model = typeof call?.model_used === "string" ? sanitize(call.model_used).replace(/\s+/g, "") : "";
  if (!model) return null;
  const billedBy = call.billed_by === "fireworks" || call.billed_by === "provider" ? call.billed_by : null;
  return { model, billedBy };
}

/** A row's response id, or "" when it has none. */
function rowResponseId(row) {
  return typeof row?.response_id === "string" ? row.response_id : "";
}

function rowSignature(row) {
  const usage = row?.usage ?? {};
  return usageSignature(usage.input, usage.cached, usage.output);
}

/**
 * Pair local calls with the route's rows. Each call, in log order, takes the
 * first unused row that names a served model and matches it: first by
 * response id; then, in a second pass for calls still unpaired, by identical
 * token counts where neither side's response id contradicts the other's.
 *
 * No row is paired with two calls, and every pairing is one of those two kinds
 * of match. Mirrored in the CLI's internal formal models, which check it on a
 * finite set of cases: change both together.
 *
 * Call keys must be unique (the result is keyed by them). The parser makes
 * them so: a response id, deduplicated across the session, or the rollout's
 * thread id with the call's timestamp and position.
 *
 * @param {{ key: string, responseId?: string, signature: string }[]} localCalls in log order
 * @param {object[]} remoteCalls rows from the route, oldest first
 * @returns {Map<string, { model: string, billedBy: string | null }>}
 */
export function matchServedCalls(localCalls, remoteCalls) {
  const matched = new Map();
  const used = new Set();
  const take = (local, fits) => {
    for (let index = 0; index < remoteCalls.length; index += 1) {
      if (used.has(index) || !fits(remoteCalls[index])) continue;
      const served = servedFrom(remoteCalls[index]);
      if (!served) continue;
      used.add(index);
      matched.set(local.key, served);
      return;
    }
  };
  for (const local of localCalls) {
    if (local.responseId) take(local, (row) => rowResponseId(row) === local.responseId);
  }
  for (const local of localCalls) {
    if (matched.has(local.key)) continue;
    take(local, (row) => rowSignature(row) === local.signature && (!local.responseId || !rowResponseId(row)));
  }
  return matched;
}

async function readCache(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed?.version === CACHE_VERSION && parsed.sessions && typeof parsed.sessions === "object") {
      return parsed;
    }
  } catch {
    /* missing or corrupt: start over */
  }
  return { version: CACHE_VERSION, sessions: {} };
}

/** `rateLimited` from a cache: owner -> until (ms), unexpired entries only. */
function liveRateLimits(cache, nowMs) {
  const out = {};
  const raw = cache?.rateLimited;
  if (!raw || typeof raw !== "object") return out;
  for (const [owner, until] of Object.entries(raw)) {
    if (Number.isFinite(until) && until > nowMs) out[owner] = until;
  }
  return out;
}

/**
 * Write the sessions this run learned, merged into what's on disk now: another
 * `codex usage` may have written its own sessions since this one read the
 * file, and a whole-file write would drop them.
 *
 * @param {string} file
 * @param {{ sessions: Record<string, { at?: number, owner?: string, calls: object }> }} cache
 * @param {Set<string>} touched session ids this run changed
 * @param {number} [nowMs]
 */
async function writeCache(file, cache, touched, nowMs = Date.now()) {
  const disk = await readCache(file);
  const sessions = { ...disk.sessions };
  for (const id of touched) {
    const ours = cache.sessions[id];
    const theirs = disk.sessions[id];
    sessions[id] = theirs?.owner === ours.owner
      ? { ...ours, at: Math.max(ours.at ?? 0, theirs.at ?? 0), calls: { ...theirs.calls, ...ours.calls } }
      : ours;
  }
  const entries = Object.entries(sessions)
    .sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, CACHE_MAX_SESSIONS);
  // Rate limits from both sides, the later deadline winning; expired ones drop.
  const rateLimited = liveRateLimits(disk, nowMs);
  for (const [owner, until] of Object.entries(liveRateLimits(cache, nowMs))) {
    rateLimited[owner] = Math.max(rateLimited[owner] ?? 0, until);
  }
  const body = JSON.stringify({
    version: CACHE_VERSION,
    sessions: Object.fromEntries(entries),
    ...(Object.keys(rateLimited).length > 0 ? { rateLimited } : {}),
  });
  // Same private-parent check and no-follow temp write as every other cache.
  ensureCacheParent(file);
  await writeFileAtomic(file, body, { mode: 0o600 });
}

function backOff(iso) {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? new Date(ms - SINCE_MARGIN_MS).toISOString() : "";
}

/**
 * Where a lookup starts paging: just before the earliest call that still
 * needs a model, so a long session's lookup moves forward as calls resolve
 * instead of re-reading from the session's start. An undated call (old logs)
 * falls back to the session's start.
 *
 * @param {{ at?: string }[]} missing
 * @param {string} [startedAt]
 */
function lookupSince(missing, startedAt) {
  if (missing.length === 0 || missing.some((call) => !call.at)) return backOff(startedAt);
  // Compare instants, not text: a log timestamp may carry an offset.
  const times = missing.map((call) => Date.parse(call.at));
  if (times.some((ms) => !Number.isFinite(ms))) return backOff(startedAt);
  return backOff(new Date(Math.min(...times)).toISOString()) || backOff(startedAt);
}

/**
 * Served models for the calls that need one, keyed by the call's `key`.
 *
 * @param {{
 *   sessions: { sessionId: string, startedAt?: string, calls: { key: string, responseId?: string, signature: string }[] }[],
 *   apiKey: string,
 *   home: string,
 *   env?: NodeJS.ProcessEnv,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   onFailure?: (reason: string) => void,
 * }} args `onFailure` hears, once per session, why its lookup got nothing
 *   (`--verbose` prints it; the lookup stays best effort either way).
 */
export async function resolveServedModels({
  sessions, apiKey, home, env = process.env, fetchImpl = fetch, now = Date.now, onFailure = () => {},
}) {
  const report = (reason) => {
    try {
      onFailure(reason);
    } catch {
      /* an observer never breaks the lookup */
    }
  };
  /** @type {Map<string, { model: string, billedBy: string | null }>} */
  const resolved = new Map();
  const file = scopedCacheFilePath(CACHE_FILE, home);
  const cache = await readCache(file);
  const touched = new Set();

  const hasKey = typeof apiKey === "string" && apiKey.startsWith("fw_");
  const online = servedModelLookupEnabled(env) && hasKey;
  // Served models are per account: a session cached under another key's
  // account is neither served nor extended.
  const owner = hasKey ? catalogKeyFingerprint(apiKey) : "";
  // A 429 (this run's or a recent run's) stops further asking until its
  // Retry-After passes; those sessions stay n/a and a later run fills them in.
  let limitedUntil = liveRateLimits(cache, now())[owner] ?? 0;
  let limitChanged = false;
  // A few sessions at a time: a cold `--last-n 25` shouldn't send 25 keyed
  // request chains at once.
  await forEachLimited(sessions, LOOKUP_CONCURRENCY, async ({ sessionId, startedAt, calls }) => {
    if (!sessionId || calls.length === 0 || !owner) return;
    const stored = cache.sessions[sessionId];
    const ours = stored?.owner === owner;
    const cached = ours ? stored.calls ?? {} : {};
    const missing = [];
    for (const call of calls) {
      const hit = cached[call.key];
      if (hit?.model) resolved.set(call.key, hit);
      else missing.push(call);
    }
    if (missing.length === 0 || !online) return;
    // This account recorded no calls for the session: don't ask again for a day.
    if (ours && stored.tracingOffAt && now() - stored.tracingOffAt < TRACING_OFF_TTL_MS) {
      report(TRACING_OFF);
      return;
    }
    if (now() < limitedUntil) {
      report(SERVED_LOOKUP_RATE_LIMITED);
      return;
    }

    const since = lookupSince(missing, startedAt);
    const remote = await fetchSessionCalls({
      sessionId,
      since,
      apiKey,
      // Same regional host as the account's Codex inference: a US-residency
      // account gets 403 from the global one.
      baseUrl: fireworksInferenceUrl(sessionCallsBaseUrl(env), recordedHarnessResidency("codex", home)),
      fetchImpl,
    });
    if ("failed" in remote) {
      if (remote.retryAfterMs !== undefined) {
        limitedUntil = Math.max(limitedUntil, now() + remote.retryAfterMs);
        cache.rateLimited = { ...liveRateLimits(cache, now()), [owner]: limitedUntil };
        limitChanged = true;
        report(SERVED_LOOKUP_RATE_LIMITED);
        return;
      }
      report(remote.failed);
      return;
    }
    if (remote.tracingOff) {
      report(TRACING_OFF);
      cache.sessions[sessionId] = { at: now(), owner, calls: { ...cached }, tracingOffAt: now() };
      touched.add(sessionId);
      return;
    }
    // Match every call in the window the rows cover, cached ones included, so a
    // cached call's row is spoken for and can't be paired again with a later
    // id-less call that has the same token counts. Only the missing ones are new.
    const sinceMs = Date.parse(since);
    let window = Number.isFinite(sinceMs)
      ? calls.filter((call) => !(Date.parse(call.at) < sinceMs)) // undated or unparsable: keep
      : calls;
    let rows = remote.calls;
    if (remote.truncated) {
      // Pairing by token counts goes by order, which a partial list can't
      // support; exact response ids are still safe.
      window = window.filter((call) => call.responseId);
      rows = rows.filter((row) => typeof row?.response_id === "string" && row.response_id);
    }
    const matched = matchServedCalls(window, rows);
    const entry = { at: now(), owner, calls: { ...cached } };
    let learned = false;
    for (const call of missing) {
      const served = matched.get(call.key);
      if (!served) continue;
      resolved.set(call.key, served);
      entry.calls[call.key] = served;
      learned = true;
    }
    if (!learned) return;
    cache.sessions[sessionId] = entry;
    touched.add(sessionId);
  });

  if (touched.size > 0 || limitChanged) {
    try {
      await writeCache(file, cache, touched, now());
    } catch {
      /* a read-only home still gets this run's answers */
    }
  }
  return resolved;
}
