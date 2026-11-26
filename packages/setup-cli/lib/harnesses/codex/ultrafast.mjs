/**
 * Whether and how `nexus codex on` installs the Ultra-fast footer
 * (ultrafast-patch.mjs): the shipped server script in mods/codex-ultrafast/,
 * run by the same Node that runs Nexus.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { mkdir, readFile, rm } from "node:fs/promises";

import { compareVersions } from "../../system/release-notes.mjs";
import { preferDataDirPath } from "../../system/data-dir.mjs";
import { installedCodexVersion } from "./stock-models.mjs";
import { codexPetDir, selectsCodexPet } from "./pet-patch.mjs";
import { CODEX_ULTRAFAST_MIN_VERSION, configuredCodexUltrafastCacheFile, hasCodexUltrafast } from "./ultrafast-patch.mjs";

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
 * The warning when the boost status can't be saved (or read) where the server
 * keeps it: `on` and login carry on, but an `off` then `on` can lose a running
 * boost. Names the folder and the error code, never the key.
 * @param {string} cacheFile
 * @param {unknown} error
 * @param {"save" | "read"} [action]
 */
export function codexUltrafastCacheWarning(cacheFile, error, action = "save") {
  const code = /** @type {{ code?: unknown }} */ (error)?.code;
  // The folder can come from Codex's config: no control characters reach the terminal.
  const printable = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
  const codeText = typeof code === "string" ? ` (${printable(code)})` : "";
  return `Warning: could not ${action} the Ultra-fast status in ${printable(path.dirname(cacheFile))}${codeText}. `
    + "Codex may show the plain pet during a boost after 'nexus codex off' and 'on'.";
}

const printWarning = (message) => console.log(message);

/**
 * A cache record checked with the key tagged `tag`, recent, with a boost in
 * the shape the server writes: rebuilt from those fields only, or null.
 */
function usableCache({ boostFromJson, CACHE_MAX_AGE_MS }, value, tag, now) {
  const status = boostFromJson(value?.status);
  const fetchedAt = Number(value?.fetchedAt);
  if (!status || !tag || value?.keyTag !== tag) return null;
  if (!(fetchedAt > 0) || now - fetchedAt > CACHE_MAX_AGE_MS || fetchedAt > now + 60_000) return null;
  const endedAt = Number(value?.endedAt);
  return { keyTag: tag, status, fetchedAt, endedAt: Number.isFinite(endedAt) && endedAt > 0 ? endedAt : null };
}

/**
 * `on` reinstalls the plain pet.json, and Codex reads the pet only when it
 * starts, so a Codex started right after `on` would show the plain logo for
 * that whole session even during a boost. When the status server's cache
 * (`cacheFile`, in Nexus's data folder so an `off` then `on` keeps it) holds a
 * recent running boost checked with this same key, write the boost pet now
 * instead.
 *
 * A server started from an older `on` keeps its cache in the pet folder, and
 * may still be running, so the pet folder's record counts only when it is
 * newer than whatever `cacheFile` holds (for any key: a later record for
 * another account means the old one is out of date). Then its checked fields
 * are copied to `cacheFile` (never the file's bytes), so an `off` before the
 * next save doesn't lose it.
 * Nothing under NEXUS_ULTRAFAST_STATUS=0, where the server ignores the cache
 * too. Local files only; never throws.
 * @param {string} petDir the Nexus pet folder
 * @param {string} apiKey the Fireworks key `on` writes into Codex's config
 * A copy that fails is reported with {@link codexUltrafastCacheWarning}.
 * @param {{ cacheFile: string, env?: NodeJS.ProcessEnv, now?: number, warn?: (message: string) => void }} [options]
 * @returns {Promise<boolean>} whether the boost pet was written
 */
export async function applyCachedBoostToPet(petDir, apiKey, { cacheFile, env = process.env, now = Date.now(), warn = printWarning } = {}) {
  try {
    if (!cacheFile || !apiKey || env.NEXUS_ULTRAFAST_STATUS === "0") return false;
    const mods = await loadMods();
    const { readText, writeAtomic, STATUS_CACHE_FILE, keyTag, isRunning, petManifest } = mods;
    const tag = keyTag(apiKey);
    // Each location on its own: one that can't be read doesn't hide the other.
    // A missing file is just null; the new cache failing to read (a folder in
    // its place, no permission) is reported, since the server can't use it
    // either. The pet folder's old cache is optional and stays quiet.
    let reported = false;
    const read = async (file, report) => {
      let text;
      try {
        text = await readText(file, 16 << 10);
      } catch (error) {
        if (report) {
          reported = true;
          try {
            warn(codexUltrafastCacheWarning(file, error, "read"));
          } catch {}
        }
        return null;
      }
      try {
        return JSON.parse(text ?? "null");
      } catch {
        return null;
      }
    };
    const currentValue = await read(cacheFile, true);
    const currentAt = Number(currentValue?.fetchedAt);
    const current = usableCache(mods, currentValue, tag, now);
    const legacy = usableCache(mods, await read(path.join(petDir, STATUS_CACHE_FILE), false), tag, now);
    const best = legacy && !(currentAt >= legacy.fetchedAt) ? legacy : current;
    if (!best) return false;
    if (best === legacy) {
      try {
        await mkdir(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
        await writeAtomic(cacheFile, `${JSON.stringify(best)}\n`);
      } catch (error) {
        // One warning per cache: a read that already failed said it.
        if (!reported) {
          try {
            warn(codexUltrafastCacheWarning(cacheFile, error));
          } catch {}
        }
      }
    }
    if (!isRunning(best.status, now)) return false;
    await writeAtomic(path.join(petDir, "pet.json"), `${JSON.stringify(petManifest(best.status, now), null, 2)}\n`);
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
 * The cache is the one the server uses: the path the config names, or the pet
 * folder for a footer an older `on` wrote.
 * A cache that can't be written is reported with {@link codexUltrafastCacheWarning}.
 * @param {{ configPath: string, apiKey: string, env?: NodeJS.ProcessEnv, fetch?: (url: string, init: object, options: { timeoutMs: number }) => Promise<Response>, now?: () => number, timeoutMs?: number, warn?: (message: string) => void }} options
 * @returns {Promise<"boost" | "plain" | "kept" | "skipped">}
 */
export async function refreshCodexUltrafastPet({ configPath, apiKey, env = process.env, fetch, now = Date.now, timeoutMs = LOGIN_BOOST_TIMEOUT_MS, warn = printWarning }) {
  try {
    const raw = await readFile(configPath, "utf8").catch(() => "");
    if (!apiKey || !hasCodexUltrafast(raw) || !selectsCodexPet(raw)) return "skipped";
    const { fetchBoostStatus, mockOrigin, readText, writeAtomic, httpFetch, STATUS_CACHE_FILE, isStatusCacheFile, keyTag, boostFromJson, isRunning, petManifest } = await loadMods();
    fetch ??= httpFetch;
    const petDir = codexPetDir(configPath);
    const named = configuredCodexUltrafastCacheFile(raw);
    const cacheFile = isStatusCacheFile(named) ? named : path.join(petDir, STATUS_CACHE_FILE);
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
        // The pet and the cache each on their own: one failing doesn't stop
        // the other. A cache that can't be written must not leave the previous
        // account's record either, whose tag would make a later login keep
        // this pet: remove it.
        const petWritten = await writePet(boost).then(() => true, () => false);
        try {
          await mkdir(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
          await writeAtomic(cacheFile, `${JSON.stringify({ keyTag: tag, status: boost, fetchedAt: now(), endedAt: null })}\n`);
        } catch (error) {
          const removed = await rm(cacheFile, { force: true }).then(() => true, () => false);
          try {
            warn(codexUltrafastCacheWarning(cacheFile, error));
          } catch {}
          // Another account's record that's still there would make a later
          // login keep this account's pet: show the plain one instead.
          const left = removed ? "" : await readText(cacheFile, 16 << 10).then((text) => JSON.parse(text ?? "null")?.keyTag ?? "", () => "");
          if (left && left !== tag) {
            await writePet(null).catch(() => {});
            return "plain";
          }
        }
        if (!petWritten) return "skipped";
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
