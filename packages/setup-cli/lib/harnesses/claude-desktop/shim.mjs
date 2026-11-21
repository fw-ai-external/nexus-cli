#!/usr/bin/env node
/**
 * Nexus Desktop profile-lane shim (long-running; launched by launchd).
 *
 * Claude Desktop's third-party ("gateway") provider requires Anthropic-shaped
 * model names and answers to a couple of endpoints Fireworks does not serve.
 * This loopback shim sits between Desktop and the Fireworks Anthropic endpoint:
 *
 * - rewrites `claude-*` model names to the configured Fireworks routes
 * - translates Anthropic-style `x-api-key` auth to `Authorization: Bearer`
 * - answers /v1/messages/count_tokens locally (Fireworks 404s it)
 * - mirrors Anthropic's signed model catalog byte-for-byte (the app verifies
 *   it against a built-in key; a local cache keeps it working offline)
 *
 * Robustness rules: every upstream call is raced with a timeout,
 * every failure degrades to a cached/local answer, and nothing throws past
 * the request boundary. Message content is never logged.
 */
import "../../system/legacy-env.mjs";
import http from "node:http";
import { Readable } from "node:stream";
import path from "node:path";
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../../io/atomic-write.mjs";
// Only the pure leaf: the shim must not pull the CLI's full module graph.
import { isCustomModelOffered, serverlessLineup, thirdPartyDir } from "./lineup.mjs";
import { autoCatalogEntry, autoCatalogEntryId, refreshServerlessCatalogCache } from "../../fireworks/models.mjs";
import { isModelAccessDenial } from "../../fireworks/model-access.mjs";
import {
  AUTO_PROVIDER_KEY_HEADERS,
  NEXUS_PROVIDERS_HEADER,
  formatAutoProviders,
  normalizeAutoProviders,
  autoProviderKeysInScope,
} from "../../config/auto-providers.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { SHIM_HEALTH_PATH, ensureShimSecret, readShimSecret, shimHealthDigest } from "./shim-auth.mjs";
import { timingSafeEqual } from "node:crypto";
import { loopbackHostHeaders } from "../../system/loopback.mjs";
import { buildFireconnectTelemetryHeaders } from "../../telemetry/request-headers.mjs";
import { CLAUDE_DESKTOP_TOKEN_PREFIX, desktopTokenPath, isDesktopToken, readDesktopToken } from "./desktop-token.mjs";
import { createStoredGatewayKeyLoader } from "./gateway-key.mjs";
import { activeAccountResidency, fireworksInferenceUrl } from "../../fireworks/residency.mjs";

const UPSTREAM = "https://api.fireworks.ai/inference";
const UPSTREAM_TIMEOUT_MS = 300_000; // long prefills (800k+ tokens) legitimately take minutes
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BUFFERED_BODY_BYTES = 64 * 1024 * 1024;
const MAX_TELEMETRY_LINE_CHARS = 1024 * 1024;
const EST_CHARS_PER_TOKEN = 4;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

/**
 * Fireworks compiles tool input schemas into a constrained-decoding grammar,
 * and length/item bounds expand into rules multiplicatively — one connector
 * with a maxLength of 204800 pushes a request past the rule limit (400
 * "tool schema is too complex"). Drop those bounds from the copy sent
 * upstream; the MCP server still validates arguments when the tool runs.
 * Trivial lower bounds (0 or 1) are cheap and kept.
 */
export function relaxSchemaBounds(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 64) return schema;
  if (Array.isArray(schema)) {
    for (const item of schema) relaxSchemaBounds(item, depth + 1);
    return schema;
  }
  delete schema.maxLength;
  delete schema.maxItems;
  if (typeof schema.minLength === "number" && schema.minLength > 1) delete schema.minLength;
  if (typeof schema.minItems === "number" && schema.minItems > 1) delete schema.minItems;
  for (const value of Object.values(schema)) {
    if (value && typeof value === "object") relaxSchemaBounds(value, depth + 1);
  }
  return schema;
}

/**
 * Normalize Anthropic-side thinking/effort values to what the Fireworks
 * routes accept. The picker labels come from the borrowed catalog ids
 * ("Extra" = xhigh, "Extended" = haiku's thinking mode), but the shared
 * reasoning ladders for these models are low/medium/high/max — so map the
 * two spellings the ladders don't advertise onto the nearest supported one
 * (xhigh -> max, extended -> high) instead of risking a 400.
 */
const EFFORT_REWRITE = { xhigh: "max", extended: "high" };

export function normalizeThinking(body) {
  const thinking = body?.thinking;
  if (!thinking || typeof thinking !== "object") return null;
  const before = thinking.effort ?? thinking.mode;
  if (thinking.effort && EFFORT_REWRITE[thinking.effort]) {
    thinking.effort = EFFORT_REWRITE[thinking.effort];
  }
  if (!thinking.effort && thinking.mode && EFFORT_REWRITE[thinking.mode]) {
    thinking.effort = EFFORT_REWRITE[thinking.mode];
    delete thinking.mode;
  }
  const after = thinking.effort ?? thinking.mode;
  return before !== after ? `${before} -> ${after}` : null;
}

/** Map a claude-* display name to the configured Fireworks route. */
export function mapModel(name, modelMap) {
  if (typeof name !== "string") return name;
  // Desktop's 1M-context variant marker is client-side; route the base model.
  name = name.replace(/\[1m\]$/i, "");
  const exact = modelMap?.models;
  if (exact && Object.hasOwn(exact, name)) return exact[name];
  const lower = name.toLowerCase();
  for (const [family, target] of Object.entries(modelMap?.families ?? {})) {
    if (lower.includes(family)) return target;
  }
  return name;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      req.off("data", onData);
      req.resume();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(Object.assign(new Error("Request body too large."), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks);
      chunks.length = 0;
      resolve(body);
    });
    req.once("error", fail);
    req.once("aborted", () => fail(new Error("Client disconnected.")));
  });
}

/**
 * Hop-by-hop headers (RFC 7230 plus proxy variants): Node's fetch THROWS on
 * some of them ("invalid keep-alive header" etc.), so a forwarded request
 * carrying one would 502. They never describe the payload; drop them.
 */
const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

function hopHeaders(connection) {
  return new Set([...HOP_HEADERS, ...String(connection ?? "").split(",").map((token) => token.trim().toLowerCase())]);
}

/**
 * Live lineup from the caches: the picker discovers models via /v1/models
 * (the profile carries no inferenceModels), and name mapping uses the same
 * pairing, so a refreshed serverless cache shows up on the next request —
 * no `nexus claude-desktop on` re-run, no Desktop restart beyond the
 * app's own /v1/models poll. Cold caches fall back to the curated 3-model
 * map written at `on` time (shim-state.json).
 */
export function createLineupLoader({ modelsCachePath, catalogDir, fallback }) {
  let memo = null;
  return async function currentLineup() {
    try {
      const manualModelsPath = path.join(path.dirname(modelsCachePath), "claude-desktop", "manual-models.json");
      // Keyed on every file the line-up is built from: a model saved with
      // `on --model` must show up without waiting for a catalog change.
      const [ms, cs, mm] = await Promise.all([
        stat(modelsCachePath).then((s) => s.mtimeMs).catch(() => 0),
        stat(path.join(catalogDir, "catalog.json")).then((s) => s.mtimeMs).catch(() => 0),
        stat(manualModelsPath).then((s) => s.mtimeMs).catch(() => 0),
      ]);
      const key = `${ms}:${cs}:${mm}`;
      if (memo?.key === key) return memo.value;
      const serverless = await readJson(modelsCachePath);
      const catalog = await readJson(path.join(catalogDir, "catalog.json"));
      const entries = Array.isArray(serverless?.entries) ? serverless.entries
        : Array.isArray(serverless?.snapshot?.entries) ? serverless.snapshot.entries : [];
      // What the catalog actually lists, before `auto` is added below: saved
      // customs are compared with this, so no catalog keeps them all listed.
      const servedEntries = [...entries];
      // The on-disk snapshot omits the auto mixes (loadServerlessCatalog
      // synthesizes them in-process); add them so the shim matches the CLI.
      if (!entries.some((e) => autoCatalogEntryId(e))) entries.push(autoCatalogEntry());
      const lineup = serverlessLineup(entries, catalog);
      // Custom models (on --model …) aren't in the lineup: merge their routes
      // into the live map so requests work between poller ticks too. The store
      // is durable (off-safe): manual-models.json.
      if (lineup) {
        const custom = await readJson(manualModelsPath) ?? [];
        // Listed only while the catalog serves them (see isCustomModelOffered).
        lineup.customs = custom.filter((m) => isCustomModelOffered(m, servedEntries));
        for (const m of custom) {
          if (lineup.customs.includes(m) && !lineup.models.some((e) => e.name === m.name)) {
            lineup.models.push({ name: m.name, labelOverride: m.label, anthropicFamilyTier: m.tier, isFamilyDefault: false });
          }
          lineup.modelMap.models[m.name] = m.shortId;
        }
      }
      memo = { key, value: lineup ?? fallback() };
      return memo.value;
    } catch {
      return fallback();
    }
  };
}

/**
 * Live `nexus auto` scope from the global config: the formatted providers
 * value to send for auto-routed turns, or "" when no scope is saved.
 * Memoized on the config file's mtime (like the lineup loader), so a
 * `nexus auto` change takes effect on the next request — no re-`on`, no
 * Desktop restart. A missing/unreadable config reads as no scope, and
 * forwarding never waits on or fails over it.
 * @param {{ configPath: string }} opts
 */
export function createAutoProvidersLoader({ configPath }) {
  let memo = null;
  return async function currentAutoProviders() {
    try {
      const mtime = await stat(configPath).then((s) => s.mtimeMs).catch(() => 0);
      if (memo?.mtime === mtime) return memo.value;
      const config = mtime ? await readJson(configPath) : null;
      const value = formatAutoProviders(normalizeAutoProviders(config?.auto?.providers));
      memo = { mtime, value };
      return value;
    } catch {
      return "";
    }
  };
}

/**
 * Live Anthropic and OpenAI keys saved with `nexus auto`, from the global
 * config: `{ anthropicKey, openaiKey }`, each "" when unset. Memoized on the
 * config file's mtime, so `nexus auto --anthropic-api-key` takes effect on
 * the next request, and none is sent while the `nexus auto` scope leaves
 * its provider out. Never reads the environment; a missing or unreadable
 * config reads as no keys.
 * @param {{ configPath: string }} opts
 */
export function createAutoKeysLoader({ configPath }) {
  let memo = null;
  return async function currentAutoKeys() {
    try {
      const mtime = await stat(configPath).then((s) => s.mtimeMs).catch(() => 0);
      if (memo?.mtime === mtime) return memo.value;
      const value = autoProviderKeysInScope(mtime ? await readJson(configPath) : null);
      memo = { mtime, value };
      return value;
    } catch {
      return { anthropicKey: "", openaiKey: "" };
    }
  };
}

/**
 * Live gateway key from the profile Desktop has applied (the key it sends
 * the shim): "" when there is none. The shim compares it with the key on
 * each request before attaching anything that belongs to the user. Reads
 * the library's appliedId, falling back to profile-state.json. Memoized on
 * the profile file's mtime; never throws.
 * @param {{ home: string, dataDir: string }} opts
 */
export function createLegacyGatewayKeyLoader({ home, dataDir }) {
  let memo = null;
  const lib = path.join(thirdPartyDir(home), "configLibrary");
  const validId = (id) => typeof id === "string" && /^[\w-]+$/.test(id);
  return async function currentGatewayKey() {
    try {
      const applied = (await readJson(path.join(lib, "_meta.json")))?.appliedId;
      const state = validId(applied) ? null : await readJson(path.join(dataDir, "profile-state.json"));
      const profileId = validId(applied) ? applied : state?.enabled ? state.profileId : null;
      if (!validId(profileId)) return "";
      const profilePath = path.join(lib, `${profileId}.json`);
      const mtime = await stat(profilePath).then((s) => s.mtimeMs).catch(() => 0);
      const key = `${profilePath}:${mtime}`;
      if (memo?.key === key) return memo.value;
      const profile = mtime ? await readJson(profilePath) : null;
      const value = typeof profile?.inferenceGatewayApiKey === "string" && !isDesktopToken(profile.inferenceGatewayApiKey)
        ? profile.inferenceGatewayApiKey : "";
      memo = { key, value };
      return value;
    } catch {
      return "";
    }
  };
}

export function createGatewayKeyLoader({ dataDir }) {
  let memo;
  return async () => {
    try {
      const info = await stat(desktopTokenPath(dataDir)).catch(() => null);
      const stamp = info ? `${info.mtimeMs}:${info.ctimeMs}:${info.ino}:${info.size}` : "";
      if (memo?.stamp === stamp) return memo.value;
      const value = await readDesktopToken(dataDir) ?? "";
      memo = { stamp, value };
      return value;
    } catch { return ""; }
  };
}

/** The credential a request carries: x-api-key, else a Bearer token. */
function inboundKey(headers) {
  if (typeof headers["x-api-key"] === "string") return headers["x-api-key"];
  const auth = headers.authorization;
  return typeof auth === "string" && /^bearer /i.test(auth) ? auth.slice(7).trim() : "";
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

/** Loopback Host values for the port the request arrived on. */
function hostAllowed(host, port) {
  if (typeof host !== "string") return false;
  return loopbackHostHeaders(port).includes(host.toLowerCase());
}

function isJsonContentType(value) {
  return typeof value === "string" && value.split(";")[0].trim().toLowerCase() === "application/json";
}

/** Copy upstream response headers, dropping the hop-by-hop ones. */
function copyUpstreamHeaders(headers) {
  const out = {};
  const hop = hopHeaders(headers.get("connection"));
  for (const [k, v] of headers) {
    if (!hop.has(k) && k !== "content-encoding" && k !== "content-length") out[k] = v;
  }
  return out;
}

function reply(res, status, payload, headers = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": typeof payload === "string" ? "text/plain" : "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

// How much of a 403 body the shim keeps to recognize a Model Access refusal.
// The body itself always streams through whole.
const MAX_DENIAL_SNIFF_BYTES = 64 * 1024;

export function createShimServer({
  modelMap, catalogDir, upstreamOrigin = fireworksInferenceUrl(UPSTREAM, activeAccountResidency("claude-desktop")), log = console.log,
  // When provided, requests resolve the model map and discovery list from
  // this live loader (serverless cache + signed catalog) instead of the
  // static modelMap.
  lineupLoader = null,
  // When provided, resolves the current `nexus auto` providers value
  // ("" = no scope). Sent only for turns routed to an auto model.
  autoProvidersLoader = null,
  // When provided, resolves the keys saved with `nexus auto`. Sent only for
  // turns routed to an auto model.
  autoKeysLoader = null,
  // When provided, resolves the per-install secret the health path proves
  // knowledge of (see shim-auth.mjs). Unset or null: the path answers 503.
  secretLoader = null,
  // Resolves the key written into the applied profile. The keys saved with
  // `nexus auto` are attached only to requests that carry this key; without
  // a loader they are never attached.
  gatewayKeyLoader = null,
  legacyGatewayKeyLoader = null,
  storedGatewayKeyLoader = null,
  maxBufferedBodyBytes = MAX_BUFFERED_BODY_BYTES,
  maxTelemetryLineChars = MAX_TELEMETRY_LINE_CHARS,
  upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS,
  upstreamIdleTimeoutMs = UPSTREAM_TIMEOUT_MS,
  // Called (never awaited) with the gateway key when the gateway refuses a
  // turn under the account's Model Access policy, so the model catalog the
  // line-up comes from can be refreshed now rather than when its TTL ends.
  // Only the user's own client triggers it.
  onModelAccessDenied = null,
}) {
  let bufferedBodyBytes = 0;
  const currentModelMap = async () => (lineupLoader ? (await lineupLoader()).modelMap : modelMap) ?? modelMap;
  // The Nexus attribution every other harness puts on its gateway traffic.
  // Desktop's own `on` is bespoke, so the shim is where these are added.
  const telemetryHeaders = buildFireconnectTelemetryHeaders(HARNESS.CLAUDE_DESKTOP);
  return http.createServer(async (req, res) => {
    const controller = new AbortController();
    let timer;
    let nodeStream;
    let reservedBytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      req.off("aborted", disconnect);
      res.off("close", disconnect);
      res.off("finish", cleanup);
    };
    const disconnect = () => {
      controller.abort();
      nodeStream?.destroy();
      cleanup();
    };
    req.once("aborted", disconnect);
    res.once("close", disconnect);
    res.once("finish", cleanup);
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/") return reply(res, 200, "ok");
      if (req.method === "GET" && url.pathname === SHIM_HEALTH_PATH) {
        // Only for a caller that addressed us by a loopback name and isn't a
        // page: the answer is stable per nonce, so a DNS-rebinding page could
        // otherwise read it as a per-install identifier.
        if (!hostAllowed(req.headers.host, req.socket.localPort) || req.headers.origin !== undefined) {
          return reply(res, 403, "forbidden");
        }
        const secret = secretLoader ? await secretLoader().catch(() => null) : null;
        const nonce = url.searchParams.get("n") ?? "";
        if (!secret || !nonce) return reply(res, 503, "unavailable");
        return reply(res, 200, shimHealthDigest(secret, nonce));
      }

      const bodyBytes = Number(req.headers["content-length"] ?? MAX_BODY_BYTES);
      if (bodyBytes > MAX_BODY_BYTES) {
        req.resume();
        return reply(res, 413, { error: { message: "Request body too large." } }, { connection: "close" });
      }
      if (bufferedBodyBytes + bodyBytes > maxBufferedBodyBytes) {
        req.resume();
        return reply(res, 503, { error: { message: "Too many buffered requests. Try again shortly." } }, { connection: "close" });
      }
      reservedBytes = bodyBytes;
      bufferedBodyBytes += reservedBytes;
      const body = await readBody(req);

      // Health probe: count_tokens — estimate locally (~4 chars/token).
      if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        let parsed = {};
        try { parsed = JSON.parse(body.toString("utf8") || "{}"); } catch { /* estimate from raw */ }
        const text = parsed.messages ? JSON.stringify(parsed.messages) + (parsed.system ?? "") : body.toString("utf8");
        return reply(res, 200, { input_tokens: Math.max(1, Math.ceil(text.length / EST_CHARS_PER_TOKEN)) });
      }

      // Everything else: proxy upstream, rewriting the model field if present.
      let outBody = body;
      let toolSummary = "";
      let debugTools = null;
      let routedModel = null;
      if (body.length && (req.headers["content-type"] || "").includes("application/json")) {
        try {
          const parsed = JSON.parse(body.toString("utf8"));
          if (parsed.model) {
            const liveMap = await currentModelMap();
            const mapped = mapModel(parsed.model, liveMap);
            routedModel = mapped;
            if (mapped !== parsed.model) parsed.model = mapped;
          }
          const effortRewrite = normalizeThinking(parsed);
          if (effortRewrite) log(`[nexus-shim] effort rewritten: ${effortRewrite}`);
          if (Array.isArray(parsed.tools)) {
            for (const tool of parsed.tools) {
              if (tool?.input_schema) relaxSchemaBounds(tool.input_schema);
            }
            toolSummary = `tools=${parsed.tools.length} kinds=${[...new Set(parsed.tools.map((t) => t?.type ?? "custom"))].join(",")}`;
            if (process.env.NEXUS_SHIM_DEBUG === "1") debugTools = parsed.tools;
          }
          outBody = Buffer.from(JSON.stringify(parsed));
        } catch { /* pass through verbatim */ }
      }

      // Decided before the headers are rewritten: the user's own client
      // sends the profile's key, as JSON, to a loopback name (a web page
      // that rebinds its own hostname to 127.0.0.1 still sends that name).
      // Anything else is still forwarded, just without the saved keys.
      const callerKey = inboundKey(req.headers);
      const bearer = typeof req.headers.authorization === "string" && /^bearer /i.test(req.headers.authorization)
        ? req.headers.authorization.slice(7).trim() : "";
      const credentials = [req.headers["x-api-key"], bearer].filter((value) => typeof value === "string");
      const tokens = credentials.filter((value) => value.startsWith(CLAUDE_DESKTOP_TOKEN_PREFIX));
      const token = gatewayKeyLoader ? await gatewayKeyLoader().catch(() => "") : "";
      const tokenClient = isDesktopToken(token) && tokens.some((value) => sameSecret(value, token));
      let storedKey = "";
      if (tokens.length) {
        if (!tokenClient || tokens.some((value) => !sameSecret(value, token))) {
          return reply(res, 401, { error: { message: "Claude Desktop sent an outdated or invalid Nexus token. Quit and reopen Claude Desktop; if that doesn't help, run nexus claude-desktop on." } });
        }
        storedKey = storedGatewayKeyLoader ? await storedGatewayKeyLoader().catch(() => "") : "";
        if (!storedKey || storedKey.startsWith(CLAUDE_DESKTOP_TOKEN_PREFIX)) {
          return reply(res, 401, { error: { message: "No stored Fireworks key is available to the Desktop shim. Sign in again." } });
        }
      }
      const legacyKey = legacyGatewayKeyLoader ? await legacyGatewayKeyLoader().catch(() => "") : "";
      const ownClient = hostAllowed(req.headers.host, req.socket.localPort)
        && isJsonContentType(req.headers["content-type"])
        && (tokenClient || sameSecret(callerKey, legacyKey));

      const headers = {};
      const hop = hopHeaders(req.headers.connection);
      for (const [name, value] of Object.entries(req.headers)) {
        if (hop.has(name) || name === "host" || name === "content-length") continue;
        headers[name] = value;
      }
      headers["content-length"] = Buffer.byteLength(outBody);
      if (tokenClient) {
        delete headers["x-api-key"];
        headers.authorization = `Bearer ${storedKey}`;
      }
      // Desktop's 3p provider sends the key Anthropic-style; Fireworks wants Bearer.
      if (headers["x-api-key"] && !headers.authorization) {
        headers.authorization = `Bearer ${headers["x-api-key"]}`;
        delete headers["x-api-key"];
      }
      // Nexus attribution, owned by Nexus like the scope below: replace
      // any inbound copies (Node lowercases inbound header names).
      delete headers["x-title"];
      delete headers["http-referer"];
      Object.assign(headers, telemetryHeaders);
      // The `nexus auto` scope belongs to Nexus, not the client: drop any
      // inbound copy, then set the current one for auto-routed turns only.
      // The provider keys are Nexus's too, sent the same way.
      delete headers[NEXUS_PROVIDERS_HEADER];
      delete headers[AUTO_PROVIDER_KEY_HEADERS.anthropic];
      delete headers[AUTO_PROVIDER_KEY_HEADERS.openai];
      const autoTurn = typeof routedModel === "string"
        && (routedModel === "auto" || routedModel.startsWith("auto-"));
      if (autoProvidersLoader && autoTurn) {
        const providers = await autoProvidersLoader().catch(() => "");
        if (providers) headers[NEXUS_PROVIDERS_HEADER] = providers;
      }
      if (autoKeysLoader && autoTurn && !ownClient) {
        // Names the failed condition only; never a key or header value.
        const why = !gatewayKeyLoader && !legacyGatewayKeyLoader ? "no gateway key loader"
          : !hostAllowed(req.headers.host, req.socket.localPort) ? "Host is not a loopback name"
            : !isJsonContentType(req.headers["content-type"]) ? "content-type is not application/json"
              : "request key does not match the applied profile's key (restart Claude Desktop after a key change)";
        log(`[nexus-shim] saved provider keys not sent for this auto turn: ${why}`);
      }
      if (autoKeysLoader && autoTurn && ownClient) {
        const { anthropicKey, openaiKey } = await autoKeysLoader().catch(() => ({}));
        if (anthropicKey) headers[AUTO_PROVIDER_KEY_HEADERS.anthropic] = anthropicKey;
        if (openaiKey) headers[AUTO_PROVIDER_KEY_HEADERS.openai] = openaiKey;
        // Which providers got a key, never the key itself.
        const sent = [anthropicKey && "anthropic", openaiKey && "openai"].filter(Boolean);
        log(`[nexus-shim] auto turn: client verified; saved provider keys ${sent.length ? `sent (${sent.join(", ")})` : "none saved"}`);
      }
      for (const name of Object.keys(headers)) {
        if (hop.has(name.toLowerCase())) delete headers[name];
      }

      if (controller.signal.aborted || res.destroyed) return;
      timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
      timer.unref();
      let upstream;
      try {
        const forward = () => fetch(upstreamOrigin + url.pathname + url.search, {
          method: req.method,
          headers,
          body: ["GET", "HEAD"].includes(req.method) ? undefined : outBody,
          signal: controller.signal,
        });
        upstream = await forward();
        if (upstream.status === 401 && tokenClient) {
          storedGatewayKeyLoader.invalidate?.(storedKey);
          const refreshedKey = await storedGatewayKeyLoader().catch(() => "");
          if (!refreshedKey || refreshedKey.startsWith(CLAUDE_DESKTOP_TOKEN_PREFIX)) {
            await upstream.body?.cancel().catch(() => {});
            return reply(res, 401, { error: { message: "No stored Fireworks key is available to the Desktop shim. Sign in again." } });
          }
          if (refreshedKey !== storedKey) {
            await upstream.body?.cancel().catch(() => {});
            if (!hop.has("authorization")) headers.authorization = `Bearer ${refreshedKey}`;
            upstream = await forward();
          }
        }
      } catch (error) {
        if (res.destroyed) return;
        if (error.name === "AbortError") {
          log(`[nexus-shim] upstream timeout for ${req.method} ${url.pathname}`);
          return reply(res, 504, { error: { type: "timeout_error", message: "Upstream timed out." } });
        }
        // Surface the code: a TLS-inspecting proxy shows up as a cert error here.
        const cause = error.cause?.code ?? error.cause?.message ?? error.message;
        log(`[nexus-shim] upstream error for ${req.method} ${url.pathname}: ${cause}`);
        return reply(res, 502, { error: { type: "api_error", message: `Could not reach Fireworks: ${cause}` } });
      }
      clearTimeout(timer);
      log(`[nexus-shim] upstream ${upstream.status} for ${req.method} ${url.pathname}${toolSummary ? ` ${toolSummary}` : ""}`);
      if (upstream.status === 400 && debugTools) {
        // Diagnostics only (opt-in): tool names and sizes, never message content.
        const sizes = debugTools.map((t) => [t?.name ?? t?.type, JSON.stringify(t).length]).sort((a, b) => b[1] - a[1]).slice(0, 15);
        log(`[nexus-shim] 400 largest tools: ${sizes.map(([n, z]) => `${n}:${z}`).join(" ")}`);
      }

      res.writeHead(upstream.status, copyUpstreamHeaders(upstream.headers));
      if (upstream.body) {
        timer = setTimeout(() => controller.abort(), upstreamIdleTimeoutMs);
        timer.unref();
        // Status-only usage telemetry: a second data listener watches the SSE
        // stream for usage deltas and logs the true token count. Never logs
        // message content. (pipe keeps backpressure; both listeners see data.)
        nodeStream = Readable.fromWeb(upstream.body);
        nodeStream.once("end", () => clearTimeout(timer));
        {
          let pending = "";
          let parsing = true;
          nodeStream.on("data", (chunk) => {
            timer.refresh();
            if (!parsing) return;
            try {
              // Carry over only the last (possibly incomplete) line; complete
              // lines are scanned exactly once.
              const text = pending + chunk.toString("utf8");
              const lines = text.split("\n");
              pending = lines.pop();
              if (pending.length > maxTelemetryLineChars || lines.some((line) => line.length > maxTelemetryLineChars)) {
                pending = "";
                parsing = false;
                return;
              }
              for (const line of lines) {
                const m = /"type":"message_delta".*"usage":(\{[^}]*\})/.exec(line);
                if (m) {
                  try {
                    const u = JSON.parse(m[1]);
                    const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
                    if (total > 0) log(`[nexus-shim] usage ${total} in (${u.cache_read_input_tokens ?? 0} cached)`);
                  } catch {}
                }
              }
            } catch {
              pending = "";
              parsing = false;
            }
          });
          // A dropped upstream body must end the client response; a client
          // stop (user aborted) must end the upstream request — otherwise
          // generation keeps running (and billing) with no one attached.
          nodeStream.on("error", () => res.destroy());
        }
        if (upstream.status === 403) {
          // A Model Access refusal streams to Desktop untouched like any other
          // response; a capped copy is checked once it ends.
          const kept = [];
          let keptBytes = 0;
          nodeStream.on("data", (chunk) => {
            if (keptBytes >= MAX_DENIAL_SNIFF_BYTES) return;
            const slice = chunk.subarray(0, MAX_DENIAL_SNIFF_BYTES - keptBytes);
            kept.push(slice);
            keptBytes += slice.length;
          });
          nodeStream.once("end", () => {
            try {
              if (!isModelAccessDenial(403, Buffer.concat(kept).toString("utf8"))) return;
              log(`[nexus-shim] model-access policy refused ${routedModel ?? "the model"}`);
              if (onModelAccessDenied && ownClient) {
                const key = typeof headers.authorization === "string" ? headers.authorization.replace(/^bearer\s+/i, "") : "";
                onModelAccessDenied({ apiKey: key });
              }
            } catch { /* observer only */ }
          });
        }
        nodeStream.pipe(res);
      } else res.end();
    } catch (error) {
      if (res.destroyed) return;
      if (!res.headersSent) reply(res, error?.status === 413 ? 413 : 502, { error: { message: String(error?.message ?? error) } });
      else res.destroy();
    } finally {
      bufferedBodyBytes -= reservedBytes;
    }
  });
}

/**
 * Refresh the serverless catalog cache after a Model Access refusal, at most
 * once per `minIntervalMs` and one at a time: a burst of refused turns costs
 * one listing. Does nothing under `NEXUS_TEST=1` or with
 * `NEXUS_CATALOG_REFRESH_ON_DENIAL=0`. The refresh is bounded and never throws; its result lands in
 * the cache file the line-up loader watches.
 * @param {{ refresh?: (apiKey: string) => Promise<unknown>, minIntervalMs?: number, now?: () => number, log?: (line: string) => void, env?: Record<string, string | undefined> }} [options]
 * @returns {(args: { apiKey: string }) => void}
 */
export function createModelAccessRefresher({
  refresh = refreshServerlessCatalogCache,
  minIntervalMs = 60_000,
  now = Date.now,
  log = console.log,
  env = process.env,
} = {}) {
  let lastStartedAt = -Infinity;
  let inFlight = false;
  return function onModelAccessDenied({ apiKey } = {}) {
    // Side effect gates: never under the test runner, and off with
    // NEXUS_CATALOG_REFRESH_ON_DENIAL=0.
    if (env.NEXUS_TEST === "1" || env.NEXUS_CATALOG_REFRESH_ON_DENIAL === "0") return;
    if (!apiKey || inFlight || now() - lastStartedAt < minIntervalMs) return;
    lastStartedAt = now();
    inFlight = true;
    Promise.resolve()
      .then(() => refresh(apiKey))
      .then((refreshed) => {
        if (refreshed !== false) log("[nexus-shim] model catalog refreshed after a model-access refusal");
      })
      .catch(() => {})
      .finally(() => { inFlight = false; });
  };
}

async function main() {
  const home = argValue("--home") ?? process.env.HOME ?? "";
  const dataDir = path.join(home, ".nexus", "claude-desktop");
  const state = (await readJson(path.join(dataDir, "shim-state.json"))) ?? {};
  const port = Number(state.port) > 0 ? Number(state.port) : 8799;
  const catalogDir = path.join(dataDir, "catalog");
  // Created here too, so a shim restarted by an upgrade can prove itself
  // before the next `on`. Read per probe: `on` may create it after start.
  await ensureShimSecret(dataDir).catch(() => {});
  const lineupLoader = createLineupLoader({
    modelsCachePath: path.join(home, ".nexus", "catalog-cache.json"),
    catalogDir,
    fallback: () => ({ modelMap: state.modelMap ?? {}, models: [] }),
  });
  const server = createShimServer({
    modelMap: state.modelMap,
    catalogDir,
    lineupLoader,
    autoProvidersLoader: createAutoProvidersLoader({
      configPath: path.join(home, ".nexus", "config.json"),
    }),
    autoKeysLoader: createAutoKeysLoader({
      configPath: path.join(home, ".nexus", "config.json"),
    }),
    secretLoader: () => readShimSecret(dataDir),
    gatewayKeyLoader: createGatewayKeyLoader({ home, dataDir }),
    legacyGatewayKeyLoader: createLegacyGatewayKeyLoader({ home, dataDir }),
    storedGatewayKeyLoader: createStoredGatewayKeyLoader({ home }),
    onModelAccessDenied: createModelAccessRefresher(),
    // The harness matrix's CI loopback; never honored outside tests, so a
    // stray variable can't send a real key elsewhere.
    ...(process.env.NEXUS_TEST === "1" && process.env.NEXUS_SHIM_UPSTREAM
      ? { upstreamOrigin: process.env.NEXUS_SHIM_UPSTREAM } : {}),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  }).catch((error) => {
    // Claude Desktop still sends the Fireworks key to this port, so whoever
    // holds it instead gets that key: say so plainly in the log.
    if (error?.code === "EADDRINUSE") {
      console.error(`[nexus-shim] EADDRINUSE: another program holds 127.0.0.1:${port}. `
        + "Claude Desktop sends your Fireworks key to this port; quit Claude Desktop until the shim is back "
        + "(`nexus claude-desktop status`).");
    }
    throw error;
  });
  console.log(`[nexus-shim] listening on 127.0.0.1:${port}`);

  // Keep the applied profile's model list in sync with the live lineup: the
  // profile is static (Desktop reads it at launch), so when the serverless
  // cache changes the shim rewrites inferenceModels — preserving connectors —
  // and the next app launch shows the new model without re-running `on`.
  let lastModelNames = "";
  setInterval(async () => {
    try {
      const lineup = await lineupLoader();
      if (!lineup?.models?.length) return;
      // Custom models (on --model …) aren't in the lineup: keep them, and
      // route their ids in the live map. The store is durable (off-safe).
      // The loader already listed the ones the catalog serves.
      const custom = lineup.customs ?? await readJson(path.join(dataDir, "manual-models.json")) ?? [];
      for (const m of custom) {
        if (!lineup.models.some((e) => e.name === m.name)) {
          lineup.models.push({ name: m.name, labelOverride: m.label, anthropicFamilyTier: m.tier, isFamilyDefault: false });
        }
        lineup.modelMap.models[m.name] = m.shortId;
      }
      const names = lineup.models.map((m) => m.name).join(",");
      if (names === lastModelNames) return;
      lastModelNames = names;
      const stateFile = path.join(dataDir, "profile-state.json");
      const profileState = await readJson(stateFile);
      if (!profileState?.enabled || !profileState.profileId) return;
      const profilePath = path.join(thirdPartyDir(home), "configLibrary", `${profileState.profileId}.json`);
      const profile = await readJson(profilePath);
      if (!profile) return;
      const current = (Array.isArray(profile.inferenceModels) ? profile.inferenceModels : []).map((m) => m.name).join(",");
      if (current === names) return;
      profile.inferenceModels = lineup.models.map(({ route: _route, ...entry }) => entry);
      await writeFileAtomic(profilePath, JSON.stringify(profile, null, 2), { mode: 0o600 });
      console.log(`[nexus-shim] model list refreshed in the profile (${lineup.models.length} entries; restart Desktop to see them)`);
    } catch (error) {
      console.log(`[nexus-shim] model-list refresh skipped: ${error?.message ?? error}`);
    }
  }, 30_000).unref();
}

/**
 * True when `argv1` launches the module at `moduleUrl`. Node resolves
 * symlinks in `import.meta.url` but not in argv, and the service file can
 * name the shim through a link (`~/.nexus` → `~/.fireconnect` during a
 * deferred move) or a path with spaces: a raw string compare there makes
 * the shim exit 0 without listening, silently, under KeepAlive.
 * @param {string} moduleUrl
 * @param {string | undefined} argv1
 */
export function isEntrypoint(moduleUrl, argv1) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) main().catch((error) => { console.error(error); process.exit(1); });
