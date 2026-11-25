/**
 * The account's Ultra-fast boost, as the banner mod reads it from the
 * account's Ultra-fast status: whether a window is running now, and for a
 * window a reward started, the reward's optional reason text (e.g. "You sent
 * 5M tokens!"). Read-only: the mod never acknowledges rewards.
 *
 * Plain functions with no I/O of their own: the mod hands
 * {@link fetchBoostStatus} its `$.http.fetch`, and tests hand it a stub.
 *
 * The key is the one `nexus claude on` wrote into Claude Code's user
 * settings, and requests go only to the Fireworks gateway. For local testing,
 * `NEXUS_ULTRAFAST_MOCK_URL` points them at a loopback mock, and then a
 * placeholder key is sent, never the user's.
 */

export const FIREWORKS_GATEWAY_URL = "https://api.fireworks.ai";
/** The window source a reward starts; its `sourceId` is the reward's ID. */
export const POWERUP_SOURCE = "POWERUP";
/** Sent to a loopback mock instead of the user's key. */
export const MOCK_API_KEY = "nexus-ultrafast-mock";
/** How long one request may take before the check gives up on it. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** Largest response body parsed; anything bigger is treated as no answer. */
export const MAX_RESPONSE_CHARS = 256 * 1024;
const MAX_REASON_LENGTH = 200;
const FIREWORKS_KEY_HEADER = "x-fireworks-api-key";

/** @typedef {{ active: boolean, activationId: string, activatedAt: number | null, expiresAt: number | null, reason: string }} BoostStatus */

export const INACTIVE = Object.freeze({ active: false, activationId: "", activatedAt: null, expiresAt: null, reason: "" });

function parseTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Field names arrive in camelCase or snake_case; accept either. */
function field(object, camel, snake) {
  return object?.[camel] ?? object?.[snake];
}

function fireworksKeyOrEmpty(value) {
  return typeof value === "string" && value.trim().startsWith("fw_") ? value.trim() : "";
}

/**
 * The Fireworks key in a Claude Code settings `env`, where `nexus claude on`
 * puts it: an `X-Fireworks-Api-Key` line in `ANTHROPIC_CUSTOM_HEADERS`, or a
 * Fireworks key as the Anthropic key or token. "" when there is none.
 * @param {unknown} env
 */
export function fireworksKeyFromEnv(env) {
  if (!env || typeof env !== "object") return "";
  const direct = fireworksKeyOrEmpty(env.ANTHROPIC_API_KEY) || fireworksKeyOrEmpty(env.ANTHROPIC_AUTH_TOKEN);
  if (direct) return direct;
  const headers = typeof env.ANTHROPIC_CUSTOM_HEADERS === "string" ? env.ANTHROPIC_CUSTOM_HEADERS : "";
  for (const line of headers.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === FIREWORKS_KEY_HEADER) {
      return fireworksKeyOrEmpty(line.slice(colon + 1));
    }
  }
  return "";
}

/**
 * The loopback mock's origin when `value` names one (http or https on
 * localhost, 127.0.0.0/8 or ::1), else null.
 * @param {unknown} value
 */
export function mockOrigin(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
    return loopback ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Backend text goes to the user's terminal: keep one line of printable text,
 * with no escape or control characters (C0, C1, DEL, line/paragraph
 * separators, bidi overrides).
 */
export function sanitizeReason(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REASON_LENGTH);
}

/**
 * The running window in an Ultra-fast status response, on this machine's
 * clock: the server's window times shifted by how far its `readTime` is from
 * `now`. Null when Ultra-fast isn't offered or no window is running.
 * `serverStart` is the start on the server's clock, unshifted: the shift
 * changes a little with every read, so only this one is stable enough to
 * identify the window.
 * @returns {{ id: string, source: string, sourceId: string, start: number | null, serverStart: number | null, end: number | null } | null}
 */
export function runningWindow(response, now) {
  if (!response || typeof response !== "object") return null;
  if (field(response, "featureAvailable", "feature_available") !== true) return null;
  const window = field(response, "activeWindow", "active_window");
  if (!window || typeof window !== "object") return null;
  const readTime = parseTime(field(response, "readTime", "read_time"));
  const skew = readTime == null ? 0 : now - readTime;
  const shift = (time) => (time == null ? null : time + skew);
  const serverStart = parseTime(field(window, "startTime", "start_time"));
  const start = shift(serverStart);
  const end = shift(parseTime(field(window, "endTime", "end_time")));
  if (end != null && end <= now) return null;
  return {
    id: String(field(window, "windowId", "window_id") ?? ""),
    source: String(window.source ?? ""),
    sourceId: String(field(window, "sourceId", "source_id") ?? ""),
    start,
    serverStart,
    end,
  };
}

/**
 * The reason text of the reward that started a POWERUP window, from a
 * rewards-list response; "" when the window has another source, the reward
 * isn't listed, or the server gave no reason (it is optional).
 */
export function windowRewardReason(response, window) {
  if (window?.source !== POWERUP_SOURCE || !window.sourceId) return "";
  const rewards = field(response, "nexusUltrafastRewards", "nexus_ultrafast_rewards");
  if (!Array.isArray(rewards)) return "";
  const reward = rewards.find((r) => typeof r?.name === "string" && r.name.endsWith(`/${window.sourceId}`));
  return sanitizeReason(reward?.reason);
}

/** A 4xx other than 429: the gateway answered, and asking again won't change it. */
function isDefiniteRefusal(status) {
  return status >= 400 && status < 500 && status !== 429;
}

/**
 * A short fingerprint of where a key is sent and the key, so a cached account
 * ID is reused only for the same key. FNV-1a: it only has to notice a change,
 * and the cache never leaves memory.
 */
function fingerprint(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}:${hash.toString(16)}`;
}

class Timeout extends Error {}

/**
 * `fetch` with a deadline: a request that hasn't answered within `ms` rejects
 * with {@link Timeout}, and its late answer settles unobserved. `after` is the
 * caller's scheduler (the mod passes `$.clock.after`), defaulting to
 * `setTimeout`.
 */
function withDeadline(fetch, ms, after) {
  const schedule = after ?? ((wait, fn) => {
    const id = setTimeout(fn, wait);
    return { cancel: () => clearTimeout(id) };
  });
  return (url, init) =>
    new Promise((resolve, reject) => {
      const timer = schedule(ms, () => reject(new Timeout()));
      Promise.resolve()
        .then(() => fetch(url, init))
        .then(
          (value) => {
            timer?.cancel?.();
            resolve(value);
          },
          (error) => {
            timer?.cancel?.();
            reject(error);
          },
        );
    });
}

/**
 * Identifies the key (and the loopback mock, when one is set) a status was
 * fetched with, so a cached status is only reused for that same key. "" when
 * there is neither: nothing cached may be reused then.
 * @param {string} key
 * @param {unknown} mockUrl
 */
export function keyFingerprint(key, mockUrl) {
  const mock = mockOrigin(mockUrl) ?? "";
  if (!key && !mock) return "";
  return fingerprint(`${mock}\n${key}`);
}

function parseBody(response) {
  const text = typeof response?.text === "string" ? response.text : "";
  if (!response?.ok || text.length > MAX_RESPONSE_CHARS) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Fetch the account's boost. Never throws.
 *
 * Answers the status, {@link INACTIVE} for a definite "no" (Ultra-fast not
 * offered, no window running, or a 4xx such as FAILED_PRECONDITION for an
 * account that isn't a Nexus account), or null when there was no answer
 * (network, 429, 5xx such as UNAVAILABLE, a key that didn't verify), so the
 * caller keeps what it last showed and tries again later.
 * @param {{
 *   fetch: (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number, ok: boolean, headers: Record<string, string>, text: string }>,
 *   key: string,
 *   mockUrl?: unknown,
 *   now: number,
 *   outcome?: { text?: string, status?: number },
 *   cache?: { fingerprint?: string, accountId?: string },
 *   timeoutMs?: number,
 *   after?: (ms: number, fn: () => void) => { cancel(): void },
 * }} options Each request gets `timeoutMs` (default
 *   {@link REQUEST_TIMEOUT_MS}) to answer, timed with `after`; a request that
 *   doesn't answer counts as no answer, so the check always finishes. `outcome.text` is set to one line saying how the check ended,
 *   e.g. "no key in user settings" or "status answered 404", for
 *   `/ultrafast-demo stats`; it never holds the key. `outcome.status` is the
 *   status route's HTTP status, when it answered. `cache` keeps the account
 *   ID between checks (the caller holds it in memory only), so a check with
 *   the same key skips `/verifyApiKey`; a 401 or 403 from the status route
 *   drops it.
 * @returns {Promise<BoostStatus | null>}
 */
export async function fetchBoostStatus({ fetch: rawFetch, key, mockUrl, now, outcome = {}, cache = {}, timeoutMs = REQUEST_TIMEOUT_MS, after }) {
  const done = (text, result) => {
    outcome.text = text;
    return result;
  };
  const fetch = withDeadline(rawFetch, timeoutMs, after);
  try {
    const mock = mockOrigin(mockUrl);
    const base = mock ?? FIREWORKS_GATEWAY_URL;
    const bearer = mock ? MOCK_API_KEY : key;
    if (!bearer) return done("no Fireworks key in the user settings", null);
    const headers = { Authorization: `Bearer ${bearer}` };
    // A key's account never changes, so ask for it once per key.
    const print = fingerprint(`${base}\n${bearer}`);
    let accountId = cache.fingerprint === print ? cache.accountId ?? "" : "";
    if (!accountId) {
      const verified = await fetch(`${base}/verifyApiKey`, { headers });
      accountId = String(verified?.headers?.["x-fireworks-account-id"] ?? "").trim().replace(/^accounts\//, "");
      if (!verified?.ok || !accountId) return done(`key check answered ${verified?.status ?? "nothing"}`, null);
      cache.fingerprint = print;
      cache.accountId = accountId;
    }
    const account = `${base}/v1/accounts/${encodeURIComponent(accountId)}`;
    const status = await fetch(`${account}/nexusUltrafastStatus`, { headers });
    if (typeof status?.status === "number") outcome.status = status.status;
    if (status?.status === 401 || status?.status === 403) {
      cache.fingerprint = undefined;
      cache.accountId = undefined;
    }
    if (isDefiniteRefusal(status?.status)) return done(`status answered ${status.status}: no boost`, { ...INACTIVE });
    const body = parseBody(status);
    if (!body) return done(`status answered ${status?.status ?? "nothing"}: kept the last status`, null);
    const window = runningWindow(body, now);
    if (!window) return done("no Ultra-fast window running", { ...INACTIVE });
    // The reason is decoration: without it the banner still shows.
    let reason = "";
    if (window.source === POWERUP_SOURCE && window.sourceId) {
      try {
        reason = windowRewardReason(parseBody(await fetch(`${account}/nexusUltrafastRewards?pageSize=50`, { headers })), window);
      } catch {}
    }
    outcome.text = `boost on until ${new Date(window.end ?? now).toISOString()}`;
    return {
      active: true,
      // Keyed on the server's start, not the shifted one, so a window without
      // an ID keeps one ID across checks and the banner plays once.
      activationId: (window.id || [window.source, window.sourceId, window.serverStart ?? ""].filter((part) => part !== "").join("@")).slice(0, 256),
      activatedAt: window.start,
      expiresAt: window.end,
      reason,
    };
  } catch (error) {
    if (error instanceof Timeout) return done(`no answer within ${Math.round(timeoutMs / 1000)}s`, null);
    return done("no answer (network error)", null);
  }
}
