/**
 * The Codex Ultra-fast status line server: a stdio MCP server Codex starts
 * (`nexus codex on` registers it in config.toml, see
 * lib/harnesses/codex/ultrafast-patch.mjs). It
 *
 * - advertises a `statusline` entrypoint, so Codex polls its `ui://` resource
 *   about once a second and paints the returned UI tree as the footer;
 * - checks the account's Ultra-fast boost with the Fireworks key `on` wrote
 *   into Codex's config (the same check as the Claude Code mod, see
 *   mods/ultrafast-fireworks/hooks/rewards.mjs);
 * - rewrites the Nexus pet's pet.json so the next pet load shows the boost.
 *
 * Codex turns the status line off for the session after one failed or slow
 * (>1 s) read, so a read only formats values already in memory: the boost
 * check, the pet write and the terminal width probe run on timers, each bounded
 * and none able to throw into a read.
 *
 * Everything with side effects is injected, so tests run it in-process.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import { fetchBoostStatus, mockOrigin, REQUEST_TIMEOUT_MS } from "../ultrafast-fireworks/hooks/rewards.mjs";
import { boostFromJson, footerTree, isRunning, NO_BOOST, petManifest } from "./ultrafast.mjs";

export const URI = "ui://fireworks-nexus/ultrafast";
export const TOOL = "ultrafast_status";
/** How often the boost is checked; against the loopback mock, much more often. */
export const CHECK_MS = 2 * 60_000;
export const MOCK_CHECK_MS = 5_000;
/** How often the pet manifest is reconsidered (the fill level moves with time). */
export const PET_MS = 30_000;
export const WIDTH_MS = 2_000;
/** How often the config file's modification time is checked for a new key (a login). */
export const KEY_WATCH_MS = 3_000;
/** A cached boost older than this is ignored at startup. */
export const CACHE_MAX_AGE_MS = 24 * 60 * 60_000;
export const STATUS_CACHE_FILE = "ultrafast-status.json";
/** Codex's status snapshot is a few KB; a line longer than this is dropped. */
export const MAX_LINE_CHARS = 16 << 20;
const MAX_CONFIG_BYTES = 1 << 20;
const MAX_CACHE_BYTES = 16 << 10;
/** The provider table `nexus codex on` writes (lib/harnesses/codex/core.mjs CODEX_PROVIDER_TABLE). */
export const CODEX_PROVIDER_TABLE = "model_providers.fireworks-ai";
const FIREWORKS_KEY_HEADER = "x-fireworks-api-key";

/**
 * A short, one-way tag for the key a status was checked with, so a cached
 * status is only reused for the same key (switching accounts must not inherit
 * the previous account's boost, or its "ended" note). Never the key itself.
 */
export function keyTag(key, mock = false) {
  if (mock) return "mock";
  if (!key) return "none";
  return createHash("sha256").update(`nexus-codex-ultrafast\n${key}`).digest("hex").slice(0, 16);
}

const fireworksKey = (value) => (typeof value === "string" && value.trim().startsWith("fw_") ? value.trim() : "");

/**
 * The Fireworks key in Codex's config text, as `nexus codex on` writes it: the
 * `x-fireworks-api-key` header on its provider table, or (older configs) the
 * provider's bearer token. "" when there is none. Never throws.
 * @param {string} raw
 * @param {(raw: string) => { tables: Record<string, any> }} parseToml
 */
export function fireworksKeyFromCodexConfig(raw, parseToml) {
  let table;
  try {
    table = parseToml(raw).tables[CODEX_PROVIDER_TABLE];
  } catch {
    return "";
  }
  if (!table || typeof table !== "object") return "";
  const headers = table.http_headers && typeof table.http_headers === "object" ? table.http_headers : {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === FIREWORKS_KEY_HEADER) return fireworksKey(value);
  }
  return fireworksKey(table.experimental_bearer_token);
}

/**
 * @typedef {{
 *   env: Record<string, string | undefined>,
 *   now: () => number,
 *   fetch: (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number, ok: boolean, headers: Record<string, string>, text: string }>,
 *   readText: (file: string, maxBytes: number) => Promise<string | null>,
 *   writeAtomic: (file: string, text: string) => Promise<void>,
 *   parseToml: (raw: string) => { tables: Record<string, any> },
 *   probeColumns: (cwd: string) => Promise<number>,
 *   send: (message: object) => void,
 *   home: string,
 *   mtime?: (file: string) => Promise<number>,
 *   setInterval: typeof setInterval,
 *   clearInterval: typeof clearInterval,
 *   log?: (line: string) => void,
 * }} Deps
 */

/** @param {Deps} deps */
export function createStatusServer(deps) {
  const { env } = deps;
  const log = (line) => {
    try {
      deps.log?.(line);
    } catch {}
  };
  const test = env.NEXUS_TEST === "1";
  const statusOn = env.NEXUS_ULTRAFAST_STATUS !== "0" && !test;
  const widthOn = env.NEXUS_CODEX_ULTRAFAST_WIDTH !== "0" && !test;
  const configFile = env.NEXUS_CODEX_CONFIG ?? "";
  const petDir = test ? "" : env.NEXUS_CODEX_PET_DIR ?? "";
  const cacheFile = petDir ? path.join(petDir, STATUS_CACHE_FILE) : "";
  const mockUrl = mockOrigin(env.NEXUS_ULTRAFAST_MOCK_URL) ? env.NEXUS_ULTRAFAST_MOCK_URL : undefined;

  const state = {
    boost: NO_BOOST,
    endedAt: null,
    fetchedAt: 0,
    sawBoost: false,
    columns: 0,
    cwd: "",
    checking: false,
    petText: "",
    petWriting: false,
    lastOutcome: "",
    lastAnswered: true,
    keyTag: "",
  };
  const cache = {};
  const timers = [];

  /** Track the end of a running boost: when it expires or the server says it stopped. */
  function setBoost(next, at) {
    if (isRunning(state.boost, at) && !isRunning(next, at)) {
      state.endedAt = state.boost.expiresAt != null && state.boost.expiresAt <= at ? state.boost.expiresAt : at;
    }
    if (isRunning(next, at)) state.endedAt = null;
    state.boost = next;
  }
  /** A running boost that ran out between checks ends at its expiry. */
  function settle(at) {
    if (state.boost.active && !isRunning(state.boost, at) && state.endedAt == null && state.boost.expiresAt != null) {
      state.endedAt = state.boost.expiresAt;
    }
  }

  async function loadCache() {
    if (!cacheFile) return;
    try {
      const text = await deps.readText(cacheFile, MAX_CACHE_BYTES);
      if (text == null) return;
      const value = JSON.parse(text);
      const boost = boostFromJson(value?.status);
      const fetchedAt = Number(value?.fetchedAt);
      // Only a status checked with the key Codex has now.
      const tag = keyTag(mockUrl ? "" : await readKey(), Boolean(mockUrl));
      if (value?.keyTag !== tag) {
        log("status cache is for another key; starting fresh");
        return;
      }
      state.keyTag = tag;
      const at = deps.now();
      if (!boost || !(fetchedAt > 0) || at - fetchedAt > CACHE_MAX_AGE_MS || fetchedAt > at + 60_000) return;
      state.boost = boost;
      state.fetchedAt = fetchedAt;
      const endedAt = Number(value?.endedAt);
      state.endedAt = Number.isFinite(endedAt) && endedAt > 0 ? endedAt : null;
      settle(at);
    } catch (error) {
      log(`status cache unreadable: ${error?.code ?? error?.name ?? "error"}`);
    }
  }

  async function saveCache() {
    if (!cacheFile) return;
    try {
      await deps.writeAtomic(cacheFile, `${JSON.stringify({ keyTag: state.keyTag, status: state.boost, fetchedAt: state.fetchedAt, endedAt: state.endedAt })}\n`);
    } catch (error) {
      log(`status cache not written: ${error?.code ?? "error"}`);
    }
  }

  async function readKey() {
    if (!configFile) return "";
    try {
      const raw = await deps.readText(configFile, MAX_CONFIG_BYTES);
      return raw == null ? "" : fireworksKeyFromCodexConfig(raw, deps.parseToml);
    } catch {
      return "";
    }
  }

  /** One boost check; at most one at a time. Never throws. */
  async function check() {
    if (!statusOn || state.checking) return;
    state.checking = true;
    try {
      const key = mockUrl ? "" : await readKey();
      // A different key (a re-login, another account): what was shown belonged
      // to the old one, so start over instead of reporting it as ended.
      const tag = keyTag(key, Boolean(mockUrl));
      const switched = Boolean(state.keyTag) && tag !== state.keyTag;
      if (switched) {
        state.boost = NO_BOOST;
        state.endedAt = null;
        state.fetchedAt = 0;
      }
      state.keyTag = tag;
      const outcome = {};
      const status = await fetchBoostStatus({ fetch: deps.fetch, key, mockUrl, now: deps.now(), outcome, cache, timeoutMs: REQUEST_TIMEOUT_MS });
      const text = outcome.text ?? "";
      // The outcome text says how the check ended ("status answered 503: kept
      // the last status", "no Fireworks key ..."); it never holds the key.
      // Logged when it changes, so a broken check is visible without a line
      // every two minutes.
      if (text !== state.lastOutcome) log(`boost check: ${text || "no answer"}`);
      state.lastOutcome = text;
      state.lastAnswered = Boolean(status);
      // A new key with no answer yet: the old account's pet must not stay.
      if (!status && switched) await writePet();
      // null: no answer this time; keep what was last shown.
      if (status) {
        const at = deps.now();
        setBoost(boostFromJson(status) ?? NO_BOOST, at);
        state.fetchedAt = at;
        await saveCache();
        await writePet();
      }
    } catch (error) {
      log(`boost check failed: ${error?.name ?? "error"}`);
    } finally {
      state.checking = false;
    }
  }

  /** Rewrite pet.json when the manifest for now differs from the last one written. Never throws. */
  async function writePet() {
    if (!petDir || state.petWriting) return;
    state.petWriting = true;
    try {
      settle(deps.now());
      const text = `${JSON.stringify(petManifest(state.boost, deps.now()), null, 2)}\n`;
      if (text !== state.petText) {
        await deps.writeAtomic(path.join(petDir, "pet.json"), text);
        state.petText = text;
      }
    } catch (error) {
      log(`pet write failed: ${error?.code ?? "error"}`);
    } finally {
      state.petWriting = false;
    }
  }

  /**
   * A login rewrites the key in Codex's config: notice within KEY_WATCH_MS
   * (a modification-time check, no read unless it changed) and check the new
   * account at once instead of at the next two-minute check.
   */
  let configMtime = null;
  async function watchKey() {
    if (!configFile || !deps.mtime) return;
    try {
      const mtime = await deps.mtime(configFile);
      if (configMtime === null || mtime === configMtime) {
        configMtime = mtime;
        return;
      }
      configMtime = mtime;
      const tag = keyTag(mockUrl ? "" : await readKey(), Boolean(mockUrl));
      if (tag !== state.keyTag) await check();
    } catch {}
  }

  async function probe() {
    if (!widthOn) return;
    try {
      const columns = await deps.probeColumns(state.cwd);
      if (columns > 0) state.columns = columns;
    } catch {}
  }

  /** The footer for a Codex status snapshot. Synchronous, from memory only. */
  function footer(snapshot) {
    const at = deps.now();
    settle(at);
    state.cwd = String(snapshot?.thread?.workspace?.cwd ?? "");
    const out = footerTree({ state: snapshot, boost: state.boost, endedAt: state.endedAt, now: at, columns: state.columns, sawBoost: state.sawBoost, home: deps.home });
    state.sawBoost = out.sawBoost;
    return out.tree;
  }

  function handle(message) {
    const { id, method, params } = message ?? {};
    if (method === "initialize") {
      return deps.send({ jsonrpc: "2.0", id, result: {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "fireworks-nexus", version: "1.0.0" },
      } });
    }
    if (method === "tools/list") {
      return deps.send({ jsonrpc: "2.0", id, result: { tools: [{
        name: TOOL,
        title: "Fireworks Ultra-fast",
        description: "Shows whether Fireworks Ultra-fast is on in the Codex status line.",
        inputSchema: { type: "object", properties: {} },
        _meta: { "openai/ui": { entrypoints: [{ type: "statusline", resourceUri: URI }] } },
      }] } });
    }
    if (method === "tools/call") {
      const text = isRunning(state.boost, deps.now())
        ? "Fireworks Ultra-fast is on."
        : statusOn && !state.lastAnswered
          ? `Fireworks Ultra-fast status is unavailable (${state.lastOutcome || "no answer"}).`
          : "Fireworks Ultra-fast is off.";
      return deps.send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    }
    if (method === "resources/list") {
      return deps.send({ jsonrpc: "2.0", id, result: { resources: [{ uri: URI, name: "ultrafast", mimeType: "application/json" }] } });
    }
    if (method === "resources/read") {
      let text = "null";
      try {
        text = JSON.stringify(footer(params?._meta?.["com.openai/codex-statusline-state"]));
      } catch (error) {
        log(`footer failed: ${error?.name ?? "error"}`);
      }
      return deps.send({ jsonrpc: "2.0", id, result: { contents: [{ uri: URI, mimeType: "application/json", text }] } });
    }
    if (method === "ping") return deps.send({ jsonrpc: "2.0", id, result: {} });
    if (id !== undefined && id !== null) deps.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }

  // --- newline-delimited JSON-RPC over stdio, bounded ------------------------------------
  let buf = "";
  let dropping = false;
  function receive(chunk) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (dropping) {
        dropping = false;
        continue;
      }
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        handle(message);
      } catch (error) {
        log(`handler failed: ${error?.name ?? "error"}`);
      }
    }
    if (buf.length > MAX_LINE_CHARS) {
      log("dropped an oversized message");
      buf = "";
      dropping = true;
    }
  }

  async function start() {
    // With the check off, a cached boost from an earlier session isn't shown either.
    if (statusOn) await loadCache();
    await writePet();
    const every = (fn, ms) => {
      const id = deps.setInterval(() => { fn(); }, ms);
      id?.unref?.();
      timers.push(id);
    };
    if (statusOn) {
      check();
      every(check, mockUrl ? MOCK_CHECK_MS : CHECK_MS);
    }
    if (petDir) every(writePet, PET_MS);
    if (statusOn && configFile && deps.mtime) {
      watchKey();
      every(watchKey, KEY_WATCH_MS);
    }
    if (widthOn) {
      probe();
      every(probe, WIDTH_MS);
    }
  }

  function stop() {
    for (const id of timers.splice(0)) deps.clearInterval(id);
  }

  return { receive, handle, start, stop, check, writePet, probe, watchKey, footer, state, loadCache };
}
