/**
 * Whether and how `nexus codex on` installs the Ultra-fast footer
 * (ultrafast-patch.mjs): the shipped server script in mods/codex-ultrafast/,
 * run by the same Node that runs Nexus.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { readFile } from "node:fs/promises";

import { compareVersions } from "../../system/release-notes.mjs";
import { preferDataDirPath } from "../../system/data-dir.mjs";
import { installedCodexVersion } from "./stock-models.mjs";
import { codexPetDir, selectsCodexPet } from "./pet-patch.mjs";
import { CODEX_ULTRAFAST_MIN_VERSION, hasCodexUltrafast } from "./ultrafast-patch.mjs";

export const CODEX_ULTRAFAST_DIRNAME = "codex-ultrafast";

/**
 * The shipped mod modules the pet helpers share with the status server.
 * Loaded on first use, not at startup: every command imports this file (through
 * the key sync), and a command must still run when the mods folder is missing.
 */
async function loadMods() {
  const [rewards, files, http, server, ultrafast] = await Promise.all([
    import("../../../mods/ultrafast-fireworks/hooks/rewards.mjs"),
    import("../../../mods/codex-ultrafast/files.mjs"),
    import("../../../mods/codex-ultrafast/http.mjs"),
    import("../../../mods/codex-ultrafast/server.mjs"),
    import("../../../mods/codex-ultrafast/ultrafast.mjs"),
  ]);
  return { ...rewards, ...files, ...http, ...server, ...ultrafast };
}

/** The installed status server script, in the package's mods folder. */
export function codexUltrafastServerPath() {
  return preferDataDirPath(fileURLToPath(new URL(`../../../mods/${CODEX_ULTRAFAST_DIRNAME}/statusline-server.mjs`, import.meta.url)));
}

/**
 * Whether this Codex gets the footer: `NEXUS_CODEX_ULTRAFAST=0` is not set,
 * and the installed Codex is known to be new enough (an unknown version counts
 * as no: an older Codex would warn about the experimental feature key).
 * @param {string} version
 * @param {NodeJS.ProcessEnv} [env]
 */
export function codexUltrafastEnabled(version, env = process.env) {
  if (env.NEXUS_CODEX_ULTRAFAST === "0") return false;
  return Boolean(version) && compareVersions(version, CODEX_ULTRAFAST_MIN_VERSION) >= 0;
}

/**
 * The `ultrafast` routing option for `on`, or null when this Codex doesn't get
 * the footer. Reads the installed Codex version (a short `codex --version`).
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, version?: (options: object) => Promise<string>, execPath?: string }} [options]
 * @returns {Promise<{ nodePath: string, serverPath: string } | null>}
 */
export async function codexUltrafastInstall({ env = process.env, home, version = installedCodexVersion, execPath = process.execPath } = {}) {
  if (env.NEXUS_CODEX_ULTRAFAST === "0") return null;
  let installed = "";
  try {
    installed = await version({ env, home });
  } catch {
    installed = "";
  }
  if (!codexUltrafastEnabled(installed, env)) return null;
  return { nodePath: execPath, serverPath: codexUltrafastServerPath() };
}

/**
 * `on` reinstalls the plain pet.json, and Codex reads the pet only when it
 * starts, so a Codex started right after `on` would show the plain logo for
 * that whole session even during a boost. When the status server's cache in
 * the pet folder holds a recent running boost checked with this same key,
 * write the boost pet now instead. Local files only; never throws.
 * @param {string} petDir the Nexus pet folder
 * @param {string} apiKey the Fireworks key `on` writes into Codex's config
 * @returns {Promise<boolean>} whether the boost pet was written
 */
export async function applyCachedBoostToPet(petDir, apiKey, { now = Date.now() } = {}) {
  try {
    const { readText, writeAtomic, CACHE_MAX_AGE_MS, STATUS_CACHE_FILE, keyTag, boostFromJson, isRunning, petManifest } = await loadMods();
    const text = await readText(path.join(petDir, STATUS_CACHE_FILE), 16 << 10);
    if (text == null) return false;
    const value = JSON.parse(text);
    const boost = boostFromJson(value?.status);
    const fetchedAt = Number(value?.fetchedAt);
    if (!boost || !apiKey || value?.keyTag !== keyTag(apiKey)) return false;
    if (!(fetchedAt > 0) || now - fetchedAt > CACHE_MAX_AGE_MS || fetchedAt > now + 60_000) return false;
    if (!isRunning(boost, now)) return false;
    await writeAtomic(path.join(petDir, "pet.json"), `${JSON.stringify(petManifest(boost, now), null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** How long `nexus login` waits for the new account's boost before moving on. */
export const LOGIN_BOOST_TIMEOUT_MS = 3_000;

/**
 * After `nexus login` puts a new key into Codex's config: set the pet for the
 * new account now, so the next Codex shows it (Codex reads the pet only when it
 * starts, and a running status server would only notice at its next check).
 * One boost check with the new key, at most LOGIN_BOOST_TIMEOUT_MS; an answer
 * is cached for the status server and picks the pet, and no answer resets a
 * pet left from another key to the plain one. Only when the config has Nexus's
 * footer and pet. Never throws.
 * @param {{ configPath: string, apiKey: string, env?: NodeJS.ProcessEnv, fetch?: (url: string, init: object, options: { timeoutMs: number }) => Promise<Response>, now?: () => number, timeoutMs?: number }} options
 * @returns {Promise<"boost" | "plain" | "kept" | "skipped">}
 */
export async function refreshCodexUltrafastPet({ configPath, apiKey, env = process.env, fetch, now = Date.now, timeoutMs = LOGIN_BOOST_TIMEOUT_MS }) {
  try {
    const raw = await readFile(configPath, "utf8").catch(() => "");
    if (!apiKey || !hasCodexUltrafast(raw) || !selectsCodexPet(raw)) return "skipped";
    const { fetchBoostStatus, mockOrigin, readText, writeAtomic, httpFetch, STATUS_CACHE_FILE, keyTag, boostFromJson, isRunning, petManifest } = await loadMods();
    fetch ??= httpFetch;
    const petDir = codexPetDir(configPath);
    const cacheFile = path.join(petDir, STATUS_CACHE_FILE);
    const mockUrl = mockOrigin(env.NEXUS_ULTRAFAST_MOCK_URL) ? env.NEXUS_ULTRAFAST_MOCK_URL : undefined;
    const tag = keyTag(mockUrl ? "" : apiKey, Boolean(mockUrl));
    const writePet = (boost) => writeAtomic(path.join(petDir, "pet.json"), `${JSON.stringify(petManifest(boost, now()), null, 2)}\n`);
    let status = null;
    if (env.NEXUS_TEST !== "1" && env.NEXUS_ULTRAFAST_STATUS !== "0") {
      status = await fetchBoostStatus({ fetch: (url, init) => fetch(url, init, { timeoutMs }), key: apiKey, mockUrl, now: now(), timeoutMs });
    }
    if (status) {
      const boost = boostFromJson(status);
      if (boost) {
        await writeAtomic(cacheFile, `${JSON.stringify({ keyTag: tag, status: boost, fetchedAt: now(), endedAt: null })}\n`);
        await writePet(boost);
        return isRunning(boost, now()) ? "boost" : "plain";
      }
    }
    // No answer: keep a pet checked with this same key; reset one from another key.
    let cachedTag = "";
    try {
      cachedTag = JSON.parse((await readText(cacheFile, 16 << 10)) ?? "null")?.keyTag ?? "";
    } catch {}
    if (cachedTag === tag) return "kept";
    await writePet(null);
    return "plain";
  } catch {
    return "skipped";
  }
}
