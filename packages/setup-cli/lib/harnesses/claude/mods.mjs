/**
 * Claude Code mods Nexus ships, loaded through `CLAUDE_CODE_PLUGIN_DIRS`.
 *
 * Claude Code reads that variable at startup as a list of plugin folders to
 * load, joined like PATH. `nexus claude on` adds the Ultra-fast banner mod's
 * folder to it in the settings `env` it already manages, and `off` removes
 * only that entry, dropping the key when nothing else is left. A user's own
 * entries are kept in place, and nothing is copied into Claude Code's plugin
 * cache, so an upgrade or reinstall of Nexus updates the mod by itself once
 * `on` re-points the path.
 *
 * Mods need Claude Code 2.1.287 or newer; older releases ignore the
 * variable, so `on` doesn't add it there and no banner plays.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { compareVersions } from "../../system/release-notes.mjs";
import { preferDataDirPath } from "../../system/data-dir.mjs";

export const CLAUDE_PLUGIN_DIRS_ENV = "CLAUDE_CODE_PLUGIN_DIRS";
/** First Claude Code release that loads mods (plugins with a hooks module). */
export const CLAUDE_CODE_MODS_MIN_VERSION = "2.1.287";

const ULTRAFAST_MOD_DIRNAME = "ultrafast-fireworks";
/** The `name` in the mod's `.claude-plugin/plugin.json`. */
export const ULTRAFAST_MOD_PLUGIN_NAME = "nexus-ultrafast";
/** Path suffix of the mod's folder in any Nexus install. */
const MOD_MARKER = `mods/${ULTRAFAST_MOD_DIRNAME}`;
// Folders a Nexus install keeps the mod under, for an entry whose folder is
// gone (an earlier install location): the package folder in a git checkout
// or an npm install, or Nexus's data directory.
const INSTALL_SIGNS = [/\/setup-cli\/mods\/[^/]+$/, /\/@nexus\/cli\/mods\/[^/]+$/, /\/\.nexus\//, /\/\.fireconnect\//];

/** The installed Ultra-fast banner mod's folder. */
export function ultrafastModDir() {
  return preferDataDirPath(fileURLToPath(new URL(`../../../mods/${ULTRAFAST_MOD_DIRNAME}`, import.meta.url)));
}

/**
 * Whether `on` should install mods: Claude Code is new enough (an unknown
 * version counts as no, since an old release would only carry a dead key),
 * and `NEXUS_CLAUDE_MODS=0` is not set.
 * @param {string} version
 * @param {NodeJS.ProcessEnv} [env]
 */
export function claudeModsEnabled(version, env = process.env) {
  if (env.NEXUS_CLAUDE_MODS === "0") return false;
  return Boolean(version) && compareVersions(version, CLAUDE_CODE_MODS_MIN_VERSION) >= 0;
}

function normalizeEntry(entry) {
  return String(entry ?? "").trim().replaceAll("\\", "/").replace(/\/+$/, "");
}

/**
 * The plugin name in an entry's `.claude-plugin/plugin.json`: a string, ""
 * when the file exists but names no plugin, or null when it can't be read.
 */
function pluginNameAt(entry) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(entry, ".claude-plugin", "plugin.json"), "utf8"));
    return typeof manifest?.name === "string" ? manifest.name : "";
  } catch {
    return null;
  }
}

/**
 * True when `entry` is a folder Nexus added, from this install or an earlier
 * one: it ends in the mod's folder name and either holds the Nexus mod, or is
 * gone and sits where a Nexus install keeps it. A user's own plugin folder
 * with the same name is never claimed.
 */
export function isNexusModEntry(entry) {
  const normalized = normalizeEntry(entry);
  if (!normalized.endsWith(`/${MOD_MARKER}`)) return false;
  const name = pluginNameAt(normalized);
  if (name !== null) return name === ULTRAFAST_MOD_PLUGIN_NAME;
  return INSTALL_SIGNS.some((sign) => sign.test(normalized));
}

function splitDirs(value, delimiter) {
  return typeof value === "string" ? value.split(delimiter) : [];
}

/**
 * Settings with the Nexus mod entry set (`enabled`) or removed, replacing a
 * stale Nexus path from an earlier install. Returns the same object when
 * nothing changes, so callers can skip the write.
 * @param {Record<string, unknown>} settings
 * @param {{ enabled: boolean, modDir?: string, delimiter?: string }} options
 */
export function withClaudeMods(settings, { enabled: wanted, modDir = ultrafastModDir(), delimiter = path.delimiter }) {
  // An install path holding the list separator would split into several
  // entries, so the mod is not installed from there (its entry is removed).
  const enabled = wanted && !modDir.includes(delimiter);
  const env = settings?.env && typeof settings.env === "object" ? settings.env : {};
  const current = env[CLAUDE_PLUGIN_DIRS_ENV];
  if (current !== undefined && typeof current !== "string") {
    // Not a path list we understand: leave it exactly as the user wrote it.
    return settings;
  }
  // A Nexus entry already in the list is re-pointed where it stands; a new one
  // goes last. Duplicates of it are dropped.
  const entries = [];
  let placed = false;
  for (const entry of splitDirs(current, delimiter)) {
    if (!isNexusModEntry(entry)) {
      entries.push(entry);
    } else if (enabled && !placed) {
      entries.push(modDir);
      placed = true;
    }
  }
  if (enabled && !placed) entries.push(modDir);
  const value = entries.join(delimiter);
  if (value === (current ?? "") && (current !== undefined || !enabled)) {
    return settings;
  }
  const nextEnv = { ...env };
  if (entries.some((entry) => entry.trim())) {
    nextEnv[CLAUDE_PLUGIN_DIRS_ENV] = value;
  } else {
    delete nextEnv[CLAUDE_PLUGIN_DIRS_ENV];
  }
  return { ...settings, env: nextEnv };
}

/**
 * Remove the Nexus mod entry, like the sibling strip helpers in core.mjs.
 * @param {Record<string, unknown>} settings
 * @returns {{ settings: Record<string, unknown>, changed: boolean }}
 */
export function stripClaudeMods(settings, options = {}) {
  const next = withClaudeMods(settings, { ...options, enabled: false });
  return { settings: next, changed: next !== settings };
}
