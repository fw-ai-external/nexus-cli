/**
 * Once-per-model price healing for the Claude status line.
 *
 * A model added mid-session (e.g. via `/model` picking a freshly launched
 * serverless row) can appear in the transcript before any price cache knows
 * its rate, degrading the whole line to `cost n/a`. The helper therefore
 * heals before first paint: it claims each unpriced model once per session
 * (one exclusively created claim file per model), spawns a minimal
 * detached runner that warms the caches through the shared loaders, and polls
 * for the missing rates within a tight bound — so the line prints dollars
 * when the refresh is quick and never stalls when it is not.
 *
 * Two load-bearing constraints shape this module:
 * - The helper process must exit promptly in every case (Claude Code waits
 *   for the command to exit before painting), so the refresh runs detached
 *   and the parent only polls. Past the bound the runner keeps healing
 *   unfollowed and the next turn is priced.
 * - This module statically imports node builtins only. Key resolution and
 *   catalog fetching pull the harness dependency graph, so they resolve
 *   lazily via dynamic import inside {@link refreshPriceCaches} — which only
 *   ever executes in the runner or in specs, never on the per-turn path.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  claimCreditStandingRefresh,
  createRefreshLockToken,
  creditStandingLockScope,
  releaseCreditStandingRefreshLock,
} from "../../fireworks/credit-standing.mjs";
import { reloadServerlessCatalogSnapshot } from "../../fireworks/serverless-catalog-cache.mjs";
import { reloadListPriceRates } from "../../pricing/list-price-cache.mjs";
import { isHttpsOrLoopbackHttp, isLoopbackHostname } from "../../system/loopback.mjs";

const RUNNER_ENTRY = fileURLToPath(new URL("../../../bin/claude-price-refresh.mjs", import.meta.url));
const CREDIT_RUNNER_ENTRY = fileURLToPath(new URL("../../../bin/claude-credit-refresh.mjs", import.meta.url));
const MARKER_DIRNAME = "statusline-refresh";
// Project-supplied gateway/test overrides must never survive into detached
// status-line runners where credential-bearing refreshes execute.
const STRIPPED_DETACHED_ENV_NAMES = new Set([
  "NEXUS_GATEWAY_URL",
  "FIRECONNECT_GATEWAY_URL",
  "NEXUS_PRICE_REFRESH_IN_TEST",
  "FIRECONNECT_PRICE_REFRESH_IN_TEST",
  "NEXUS_CREDIT_REFRESH_IN_TEST",
  "FIRECONNECT_CREDIT_REFRESH_IN_TEST",
]);

function detachedRefreshEnv(env, home) {
  return Object.fromEntries(
    Object.entries({ ...env, HOME: home }).filter(
      ([name]) => !STRIPPED_DETACHED_ENV_NAMES.has(name.toUpperCase()),
    ),
  );
}

/**
 * Resolve the gateway URL for a detached status-line runner. Only explicit
 * test-mode opt-in (`NEXUS_TEST=1` plus `testOptInEnv=1`) may aim the runner
 * at a loopback HTTP mock; production background refreshes always pin to
 * `defaultGatewayUrl` so untrusted project settings cannot redirect API keys.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ testOptInEnv: string, defaultGatewayUrl: string }} options
 * @returns {string}
 */
export function resolveRunnerGatewayUrl(env, { testOptInEnv, defaultGatewayUrl }) {
  if (env?.NEXUS_TEST === "1" && env?.[testOptInEnv] === "1" && env?.NEXUS_GATEWAY_URL?.trim()) {
    try {
      const parsed = new URL(env.NEXUS_GATEWAY_URL.trim());
      if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
        return env.NEXUS_GATEWAY_URL.trim();
      }
    } catch {}
  }
  return defaultGatewayUrl;
}

function resolvePriceRefreshGatewayUrl(gatewayUrl, defaultGatewayUrl) {
  const candidate = (gatewayUrl?.trim() || defaultGatewayUrl).trim();
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    if (!isHttpsOrLoopbackHttp(parsed)) return "";
    return candidate.replace(/\/+$/, "");
  } catch {
    return "";
  }
}
// Stale markers are pruned opportunistically so ~/.nexus cannot fill
// with one file per session over time.
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Upper bound the pre-print poll waits: slow networks fall back to the cached
// line while the detached runner heals the next turn. Once per session.
export const STATUSLINE_HEAL_TIMEOUT_MS = 3000;
const STATUSLINE_HEAL_POLL_MS = 100;

/** Session id from a transcript path: basename without `.jsonl`, else "". */
export function sessionIdFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) {
    return "";
  }
  const base = path.basename(transcriptPath.trim());
  return base.toLowerCase().endsWith(".jsonl") && base.length > 6
    ? base.slice(0, -".jsonl".length)
    : "";
}

/** True when any model in the parsed usage has no rate (renders `n/a`). */
export function hasUnpricedModels(usage) {
  return Array.isArray(usage?.models)
    && usage.models.some((model) => model == null || model.cost == null);
}

function markerDir(home) {
  return path.join(home, ".nexus", MARKER_DIRNAME);
}

function markerFor(home, sessionId) {
  return path.join(markerDir(home), `${sessionId}.refreshed`);
}

function claimFileFor(home, sessionId, modelKey) {
  const digest = createHash("sha256").update(modelKey).digest("hex").slice(0, 16);
  return path.join(markerDir(home), `${sessionId}.${digest}.claim`);
}

// Claim files this process created, so a failed spawn releases only its own.
const heldClaims = new Map();

function heldClaimsKey(home, sessionId) {
  return `${home}\0${sessionId}`;
}

function removeQuietly(file) {
  try {
    rmSync(file, { force: true });
  } catch {}
}

function pruneMarkers(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > MARKER_TTL_MS) {
        rmSync(file, { force: true });
      }
    } catch {
      // Best-effort: a leftover marker only costs a stat per turn.
    }
  }
}

function unpricedModelKeys(usage) {
  return [...new Set(
    usage.models
      .filter((model) => model == null || model.cost == null)
      .map((model) => String(model?.id ?? model?.label ?? "")),
  )];
}

/**
 * Models this session attempted before per-model claim files existed, from
 * the older JSON marker. Markers that predate per-model tracking hold a bare
 * timestamp and read as "none attempted", which grants those sessions one
 * more refresh.
 */
function readAttemptedModels(marker) {
  let raw;
  try {
    raw = readFileSync(marker, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.models) ? parsed.models.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Claim a healing attempt for this session's unpriced models. Each model gets
 * one attempt per session, so an unpriceable model cannot use up the attempt a
 * later `/model` switch needs. Synchronous and side-effect free beyond the
 * session's claim files, so the render path can call it unconditionally.
 *
 * @param {{ home?: string, transcriptPath?: string, usage?: object | null }} [options]
 * @returns {boolean} True when the caller should kick off a refresh.
 */
export function claimSessionPriceHealing({ home = "", transcriptPath = "", usage = null } = {}) {
  try {
    if (process.env.NEXUS_TEST === "1" || process.env.NEXUS_STATUSLINE_REFRESH === "0") {
      return false;
    }
    if (!hasUnpricedModels(usage)) {
      return false;
    }
    const sessionId = sessionIdFromTranscript(transcriptPath);
    if (!home || !sessionId) {
      return false;
    }
    const dir = markerDir(home);
    mkdirSync(dir, { recursive: true });
    const attempted = readAttemptedModels(markerFor(home, sessionId)) ?? [];
    const claimed = [];
    try {
      for (const key of unpricedModelKeys(usage)) {
        if (attempted.includes(key)) {
          continue;
        }
        // Exclusive create: of two concurrent turns, only one gets the model.
        const file = claimFileFor(home, sessionId, key);
        try {
          writeFileSync(file, String(Date.now()), { flag: "wx" });
          claimed.push(file);
        } catch (error) {
          if (error?.code !== "EEXIST") {
            throw error;
          }
        }
      }
    } catch (error) {
      claimed.forEach(removeQuietly);
      throw error;
    }
    if (claimed.length === 0) {
      return false;
    }
    const key = heldClaimsKey(home, sessionId);
    heldClaims.set(key, [...(heldClaims.get(key) ?? []), ...claimed]);
    pruneMarkers(dir);
    return true;
  } catch {
    return false;
  }
}

/** Hand the session's not-yet-spawned claims to the refresh about to start. */
function takeClaims(home, sessionId) {
  const key = heldClaimsKey(home, sessionId);
  const claims = heldClaims.get(key) ?? [];
  heldClaims.delete(key);
  return claims;
}

/** Give back one refresh's claims (and any older JSON marker) for the session. */
function releaseClaims(home, sessionId, claims) {
  claims.forEach(removeQuietly);
  removeQuietly(markerFor(home, sessionId));
}

/**
 * Refresh both price caches through the shared loaders (serverless catalog
 * and models.dev list prices, concurrently). Never throws and never touches
 * harness configs. Heavy modules resolve lazily so the per-turn helper's
 * static graph stays at node builtins — this only executes in the detached
 * runner or in specs.
 *
 * Security invariant: credential-bearing catalog/plan refreshes pin to the
 * official Fireworks gateway (`FIREWORKS_GATEWAY_URL`) by default and ignore
 * untrusted `NEXUS_GATEWAY_URL` / `FIRECONNECT_GATEWAY_URL` environment
 * overrides; callers may inject an explicit HTTPS or loopback `gatewayUrl`
 * (e.g. in tests).
 */
export async function refreshPriceCaches({ home = "", env = process.env, gatewayUrl = "" } = {}) {
  try {
    const [
      { FIREWORKS_GATEWAY_URL, loadServerlessCatalog },
      { resolveFireworksApiKey },
      { claudeFireworksKeyFrom },
      { refreshListPriceCache },
    ] = await Promise.all([
      import("../../fireworks/models.mjs"),
      import("../../keys/harness-api-key.mjs"),
      import("./env-key.mjs"),
      import("../../pricing/list-price-cache.mjs"),
    ]);
    const pinnedGatewayUrl = resolvePriceRefreshGatewayUrl(gatewayUrl, FIREWORKS_GATEWAY_URL);
    await Promise.all([
      (async () => {
        // Claude Code hands the status line its settings env, which carries
        // the key `nexus claude on` baked into the gateway header — a
        // fallback for when the stored key can't be read here.
        const apiKey = await resolveFireworksApiKey({
          home,
          resolveKey: () => claudeFireworksKeyFrom({ env }),
        });
        if (apiKey && pinnedGatewayUrl) {
          await loadServerlessCatalog({
            apiKey,
            refresh: true,
            gatewayUrl: pinnedGatewayUrl,
          });
        }
      })(),
      refreshListPriceCache({ force: true }),
    ]);
  } catch {
    // Best-effort: keyless, offline, or broken-dependency machines keep
    // serving from cache.
  }
}

/**
 * Spawn the detached refresh runner. Returns the child (or null when spawning
 * is impossible), unref'd so the helper exits on its own schedule. Call only
 * after {@link claimSessionPriceHealing} returns true: a spawn that dies
 * asynchronously releases this turn's claims, so the next turn retries instead of
 * burning the session's single attempt on a stillborn refresh. Filters
 * untrusted gateway URL overrides from the child environment.
 *
 * @param {{ home?: string, sessionId?: string, env?: NodeJS.ProcessEnv, spawnFn?: typeof spawn }} [options]
 */
export function spawnPriceRefresh({
  home = "",
  sessionId = "",
  env = process.env,
  spawnFn = spawn,
} = {}) {
  if (!home || !sessionId) {
    return null;
  }
  const claims = takeClaims(home, sessionId);
  // Defense in depth: never spawn a real detached runner under NEXUS_TEST=1
  // unless an injected mock `spawnFn` or explicit test opt-in is in use.
  if (process.env.NEXUS_TEST === "1" && spawnFn === spawn && env?.NEXUS_PRICE_REFRESH_IN_TEST !== "1") {
    releaseClaims(home, sessionId, claims);
    return null;
  }
  const childEnv = detachedRefreshEnv(env, home);
  let child = null;
  try {
    child = spawnFn(process.execPath, [RUNNER_ENTRY], {
      detached: true,
      stdio: "ignore",
      // Windows gives a detached child its own console; without this the
      // first heal in a session flashes a window over Claude Code.
      windowsHide: true,
      env: childEnv,
    });
  } catch {
    child = null;
  }
  if (!child) {
    releaseClaims(home, sessionId, claims);
    return null;
  }
  child.unref?.();
  child.on?.("error", () => {
    releaseClaims(home, sessionId, claims);
  });
  return child;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-read both price caches from disk. Pricing lookups memoize the snapshot
 * in memory, so without this a polling process re-prices from stale rows
 * forever even after the background runner warms the files. Total.
 */
function reloadPriceCachesFromDisk() {
  reloadServerlessCatalogSnapshot();
  reloadListPriceRates();
}

/**
 * Re-read usage until every model is priced, the runner exits, or the bound
 * elapses — whichever comes first. Each tick reloads the caches from disk
 * first, so rows the detached runner wrote become visible. Pure polling over
 * injected functions, so the render never waits on the network itself.
 *
 * @param {{ readUsage?: () => Promise<object | null>, reloadCaches?: () => void, child?: { exitCode?: number | null } | null, timeoutMs?: number, intervalMs?: number }} [options]
 */
export async function waitForPricedUsage({
  readUsage = async () => null,
  reloadCaches = reloadPriceCachesFromDisk,
  child = null,
  timeoutMs = STATUSLINE_HEAL_TIMEOUT_MS,
  intervalMs = STATUSLINE_HEAL_POLL_MS,
} = {}) {
  const started = Date.now();
  let usage = null;
  let exited = false;
  for (;;) {
    reloadCaches();
    try {
      usage = await readUsage();
    } catch {
      // Keep the last usage: a failed re-read must never blank the line.
    }
    // Null is "no reading", never "priced": only a real usage object with
    // rates on every model satisfies the poll.
    if (usage != null && !hasUnpricedModels(usage)) {
      return usage;
    }
    // The runner writes caches synchronously before it exits, so the first
    // tick that observes the exit gets one grace re-read: without it the poll
    // can return a stale snapshot written milliseconds earlier.
    if (child == null || child.exitCode !== null) {
      if (!exited) {
        exited = true;
        continue;
      }
      return usage;
    }
    if (Date.now() - started >= timeoutMs) {
      return usage;
    }
    await sleep(intervalMs);
  }
}

/**
 * Spawn the detached credit-standing refresh runner. Unref'd so the status
 * line exits immediately without waiting on the network. Filters untrusted
 * gateway URL overrides from the child environment and releases the refresh
 * lock (only when its ownership token still matches) if spawning fails.
 *
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, spawnFn?: typeof spawn, lockToken?: string, keyFingerprint?: string }} [options]
 */
export function spawnCreditStandingRefresh({
  home = "",
  env = process.env,
  spawnFn = spawn,
  lockToken = "",
  keyFingerprint = "",
} = {}) {
  if (!home) {
    return null;
  }
  const lockScope = creditStandingLockScope(keyFingerprint);
  // Defense in depth: never spawn a real detached runner under NEXUS_TEST=1
  // unless an injected mock `spawnFn` or explicit test opt-in is in use.
  if (process.env.NEXUS_TEST === "1" && spawnFn === spawn && env?.NEXUS_CREDIT_REFRESH_IN_TEST !== "1") {
    releaseCreditStandingRefreshLock(home, { lockToken, keyFingerprint: lockScope });
    return null;
  }
  const childEnv = detachedRefreshEnv(env, home);
  const args = [CREDIT_RUNNER_ENTRY];
  if (lockToken) {
    args.push("--lock-token", lockToken);
    if (lockScope) {
      args.push("--lock-scope", lockScope);
    } else {
      args.push("--lock-unscoped");
    }
  }
  let child = null;
  try {
    child = spawnFn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: childEnv,
    });
  } catch {
    child = null;
  }
  if (!child) {
    releaseCreditStandingRefreshLock(home, { lockToken, keyFingerprint: lockScope });
    return null;
  }
  child.unref?.();
  child.on?.("error", () => {
    releaseCreditStandingRefreshLock(home, { lockToken, keyFingerprint: lockScope });
  });
  return child;
}

/**
 * Claim and spawn a non-blocking credit-standing refresh when the disk cache
 * is missing or past its TTL. Never throws and never waits on the child.
 *
 * @param {{
 *   home?: string,
 *   expectedFingerprint?: string,
 *   now?: number,
 *   env?: NodeJS.ProcessEnv,
 *   spawnFn?: typeof spawn,
 * }} [options]
 */
export function maybeSpawnCreditStandingRefresh({
  home = "",
  expectedFingerprint = "",
  now = Date.now(),
  env = process.env,
  spawnFn = spawn,
} = {}) {
  try {
    const lockToken = createRefreshLockToken();
    if (!claimCreditStandingRefresh({ home, expectedFingerprint, now, env, lockToken })) {
      return null;
    }
    return spawnCreditStandingRefresh({ home, env, spawnFn, lockToken, keyFingerprint: expectedFingerprint });
  } catch {
    return null;
  }
}
