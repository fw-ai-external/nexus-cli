/**
 * Ultra-fast for OpenCode: the parts of the Nexus plugin (tui.tsx) that aren't
 * drawing. Plain functions, so tests import this file directly.
 *
 * At install, `nexus opencode on` copies this file into the plugin folder next
 * to the Claude Code mod's frames.mjs and rewards.mjs (the banner layout and
 * the boost check). tui.tsx hands those in, so this file imports nothing from
 * the folder and runs the same from lib/ and from the installed copy.
 *
 * The key is the one `nexus opencode on` wrote into opencode.json, the file
 * two folders up from the plugin, and requests go only to the Fireworks
 * gateway (or a loopback mock, with a placeholder key; see rewards.mjs).
 */

import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

/** The host rewards.mjs sends the key to; regional hosts are its subdomains. */
const FIREWORKS_GATEWAY_HOST = "api.fireworks.ai";
/** The provider `nexus opencode on` writes into opencode.json. */
export const FIREWORKS_PROVIDER_ID = "fireworks-ai";
/** Ask the account's Ultra-fast status at most this often; a window lasts hours. */
export const BOOST_CHECK_MS = 2 * 60_000;
/** Against a local mock, every few seconds, so trying the banner doesn't wait. */
export const MOCK_CHECK_MS = 5_000;
/** One request never waits longer than this; the next check tries again. */
export const FETCH_TIMEOUT_MS = 10_000;
/** Largest response body read; rewards.mjs treats a bigger one as no answer. */
const MAX_BODY_CHARS = 256 * 1024;
/**
 * Written into the plugin folder by `nexus opencode on`: the name of the
 * config file it routed, for an `on --config-path` with another name.
 */
export const CONFIG_HINT_FILE = "nexus-config.json";
/** Largest config file read; anything bigger counts as no key. */
export const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * A config file's text, read without blocking OpenCode's thread: only a
 * regular file (never a FIFO or device that could hang a read) no larger than
 * MAX_CONFIG_BYTES. The checks and the read use one open handle (opened
 * non-blocking, so a FIFO doesn't wait for a writer), and at most
 * MAX_CONFIG_BYTES + 1 bytes are read, so a file swapped in after the check
 * can't hang or flood it either. Rejects otherwise.
 * @param {string} file
 */
export async function readConfigFile(file) {
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw new Error("not a small regular file");
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_CONFIG_BYTES) throw new Error("config grew past the limit");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * The Fireworks key OpenCode uses from a parsed opencode.json: the native v2
 * `providers` entry when there is one (OpenCode prefers it over the v1
 * `provider` entry, wholly), else the v1 entry `nexus opencode on` writes.
 * Only a literal key counts; an `{env:…}` reference is not a key here, as it
 * isn't for the CLI. "" when there is none.
 * @param {unknown} config
 */
export function opencodeFireworksKey(config) {
  const native = /** @type {any} */ (config)?.providers?.[FIREWORKS_PROVIDER_ID];
  const settings = native && typeof native === "object"
    ? native.settings
    : /** @type {any} */ (config)?.provider?.[FIREWORKS_PROVIDER_ID]?.options;
  // The key is sent to the Fireworks gateway, so only a key the provider
  // itself sends there: none from a provider pointed at another endpoint.
  if (!sendsToFireworks(settings?.baseURL)) return "";
  const key = settings?.apiKey;
  return typeof key === "string" && key.trim().startsWith("fw_") ? key.trim() : "";
}

/** Whether a provider `baseURL` (unset means OpenCode's default) is the Fireworks gateway. */
export function sendsToFireworks(baseURL) {
  if (baseURL === undefined || baseURL === null || baseURL === "") return true;
  try {
    const url = new URL(String(baseURL));
    const host = url.hostname.toLowerCase();
    // api.fireworks.ai, or a data-residency host such as us.api.fireworks.ai.
    return url.protocol === "https:" && (host === FIREWORKS_GATEWAY_HOST || host.endsWith(`.${FIREWORKS_GATEWAY_HOST}`));
  } catch {
    return false;
  }
}

/**
 * The config file for a plugin installed at `<config dir>/plugins/<name>/`:
 * the one `nexus opencode on` named in CONFIG_HINT_FILE. Null without a
 * valid hint: guessing opencode.json could read another account's key.
 * @returns {Promise<string | null>}
 */
export async function opencodeConfigPathFor(pluginDir, read = readConfigFile) {
  try {
    const hinted = JSON.parse(String(await read(path.join(pluginDir, CONFIG_HINT_FILE))))?.configFile;
    if (typeof hinted === "string" && hinted && hinted === path.basename(hinted)) {
      return path.join(pluginDir, "..", "..", hinted);
    }
  } catch {}
  return null;
}

/**
 * The key from the opencode.json at `configPath`, read fresh on each check so
 * a key `nexus opencode on` rotates is picked up. "" on any failure.
 * Async, so a slow disk never stalls OpenCode's input or drawing.
 */
export async function readOpencodeFireworksKey(configPath, read = readConfigFile) {
  if (!configPath) return "";
  try {
    return opencodeFireworksKey(JSON.parse(String(await read(configPath))));
  } catch {
    return "";
  }
}

/**
 * A response body as text, or "" once it passes `max` characters: the read
 * stops there, so an oversized body is never held whole.
 * @param {Response} response
 */
async function boundedText(response, max) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => {});
    return "";
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
    if (text.length > max) {
      await reader.cancel().catch(() => {});
      return "";
    }
  }
}

/**
 * rewards.mjs's fetch shape over a standard `fetch`: every request bounded by
 * `timeoutMs`, redirects refused (the key and a mock's requests stay at the
 * origin rewards.mjs chose), header names lowercased, the body read as text
 * (an oversized one comes back empty). Rejects on network errors and
 * redirects; rewards.mjs catches them.
 * @param {typeof fetch} fetchImpl
 */
export function boundedFetch(fetchImpl, timeoutMs = FETCH_TIMEOUT_MS) {
  return async (url, init = {}) => {
    const response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    const headers = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const text = await boundedText(response, MAX_BODY_CHARS);
    return { status: response.status, ok: response.ok, headers, text };
  };
}

/** Whether boost checks are off: the kill switch, or a test run. */
export function boostChecksDisabled(env) {
  return env?.NEXUS_ULTRAFAST_STATUS === "0" || env?.NEXUS_TEST === "1";
}

/**
 * Paces the boost check: one request chain at a time, at most once per
 * BOOST_CHECK_MS (MOCK_CHECK_MS against a mock). `check` asks the server and
 * resolves the status or null; `onStatus` gets each answer. `tick` never
 * throws and never waits for the network: call it from a timer.
 * @param {{
 *   check: (opts: { now: number, mockUrl: string | undefined }) => Promise<object | null>,
 *   onStatus: (status: object, now: number) => void,
 *   env: Record<string, string | undefined>,
 *   now?: () => number,
 *   isMock: (mockUrl: string | undefined) => boolean,
 * }} options
 */
export function createBoostChecker({ check, onStatus, env, now = Date.now, isMock }) {
  let checking = false;
  let lastCheck = Number.NEGATIVE_INFINITY;
  return {
    tick() {
      try {
        if (checking || boostChecksDisabled(env)) return;
        const mockUrl = env?.NEXUS_ULTRAFAST_MOCK_URL;
        const at = now();
        if (at - lastCheck < (isMock(mockUrl) ? MOCK_CHECK_MS : BOOST_CHECK_MS)) return;
        lastCheck = at;
        checking = true;
        Promise.resolve()
          .then(() => check({ now: at, mockUrl }))
          .then((status) => {
            if (status) onStatus(status, at);
          })
          .catch(() => {})
          .finally(() => {
            checking = false;
          });
      } catch {
        checking = false;
      }
    },
  };
}

/** "45m", "5h 00m": the same as the Claude Code status line's badge. */
export function formatTimeLeft(ms) {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The footer badge's parts while a boost runs: the share of the window left
 * ("100%", or "" when its start is unknown) and the time left. Null when no
 * boost is on.
 * @param {{ active?: boolean, activatedAt?: number | null, expiresAt?: number | null } | null} status
 * @param {number} now
 */
export function badgeParts(status, now) {
  if (!status || status.active !== true) return null;
  const { activatedAt, expiresAt } = status;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
  const total = typeof activatedAt === "number" && Number.isFinite(activatedAt) ? expiresAt - activatedAt : 0;
  const share = total > 0 ? `${Math.min(100, Math.max(0, Math.round(((expiresAt - now) / total) * 100)))}%` : "";
  return { share, left: formatTimeLeft(expiresAt - now) };
}

/**
 * OpenCode's own screen needs about this many rows (session tabs, the prompt
 * box, its footer and a margin); the banner borrows the rest for 5 seconds.
 */
const OPENCODE_CHROME_ROWS = 16;

/**
 * Banner rows for a terminal `height` rows tall: the full nine from 25 rows
 * up, fewer (frames.mjs shrinks to the title and subtitle) on a shorter one.
 */
export function bannerRowsFor(height, maxRows = 9) {
  const room = Math.floor(Number(height) || 0) - OPENCODE_CHROME_ROWS;
  return Math.max(2, Math.min(maxRows, room));
}

/**
 * One boost check, as the plugin runs it: the key read fresh from the config
 * (so a key `on` rotates or removes is picked up), then rewards.mjs's
 * check. No key and no mock answers "no boost", so a badge for a key that's
 * gone clears. Resolves null when the server didn't answer.
 * @param {{
 *   fetchBoostStatus: (opts: object) => Promise<object | null>,
 *   mockOrigin: (url: unknown) => string | null,
 *   fetch: Function,
 *   pluginDir: string,
 *   mockUrl: unknown,
 *   read?: (file: string) => Promise<string> | string,
 *   clock?: () => number,
 *   cache?: object,
 * }} options `cache` is rewards.mjs's account cache, kept across checks so
 *   the key's account is looked up once per key. `pluginDir` is the installed plugin's folder; the config it
 *   names is found and read on each check, off OpenCode's thread.
 */
export async function checkBoost({ fetchBoostStatus, mockOrigin, fetch, pluginDir, mockUrl, read = readConfigFile, clock = Date.now, cache }) {
  const key = await readOpencodeFireworksKey(await opencodeConfigPathFor(pluginDir, read), read);
  if (!key && !mockOrigin(mockUrl)) return { active: false };
  // The clock rewards.mjs lines the server's up with, read just before the
  // requests: the config read's time never shortens a boost. What's left is
  // the requests' own time (a key check, then the status), under a second
  // normally; its times are not moved, so an ended boost is never extended.
  return fetchBoostStatus({ fetch, key, mockUrl, now: clock(), cache });
}
