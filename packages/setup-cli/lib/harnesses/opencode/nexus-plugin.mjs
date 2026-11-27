/**
 * The Fireworks Nexus plugin for OpenCode 2.x (nexus-plugin/tui.tsx): the
 * sidebar card, and the Ultra-fast banner and footer badge. The banner's
 * frames and the boost check are the Claude Code mod's own files
 * (mods/ultrafast-fireworks/hooks/), copied in beside ultrafast.mjs, so the
 * two harnesses draw and decide the same way.
 *
 * OpenCode auto-discovers plugin folders in `<config dir>/plugins/<name>/`, so
 * installing is a file copy: opencode.json is untouched and `off` keeps its
 * byte-for-byte restore. `off` deletes the folder. OpenCode 1.x doesn't read
 * this folder, so the copy is inert there.
 */

import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installOwnedDir, isNexusOwnedDir, removeOwnedDir } from "../../harness/owned-asset-dir.mjs";
import { CONFIG_HINT_FILE } from "./nexus-plugin/ultrafast.mjs";

export const OPENCODE_PLUGIN_DIRNAME = "fireworks-nexus";
const PLUGIN_ASSET_DIR = fileURLToPath(new URL("./nexus-plugin/", import.meta.url));
const MOD_HOOKS_DIR = fileURLToPath(new URL("../../../mods/ultrafast-fireworks/hooks/", import.meta.url));
/**
 * What the folder holds: tui.tsx imports the other three. The entry point
 * goes last, so an install that stops partway never leaves a new tui.tsx
 * beside modules it didn't install.
 */
export const PLUGIN_FILES = [
  "ultrafast.mjs",
  [path.join(MOD_HOOKS_DIR, "frames.mjs"), "frames.mjs"],
  [path.join(MOD_HOOKS_DIR, "rewards.mjs"), "rewards.mjs"],
  "tui.tsx",
];

/** `~/.config/opencode/plugins/fireworks-nexus` for the opencode.json at `configPath`. */
export function opencodePluginDir(configPath) {
  return path.join(path.dirname(configPath), "plugins", OPENCODE_PLUGIN_DIRNAME);
}

/**
 * Copy the plugin next to the config. Best effort: a failed copy means no
 * card, never a failed `on`. Returns whether the plugin is in place.
 * @param {string} configPath
 */
export async function installOpencodePlugin(configPath) {
  // The modules, then the hint naming the config file that holds the key
  // (ultrafast.mjs reads nothing without it), then the entry point: an
  // install that stops partway never leaves a new tui.tsx without them.
  const hint = { name: CONFIG_HINT_FILE, contents: `${JSON.stringify({ configFile: path.basename(configPath) })}\n` };
  const files = [...PLUGIN_FILES.slice(0, -1), hint, PLUGIN_FILES.at(-1)];
  return installOwnedDir(opencodePluginDir(configPath), PLUGIN_ASSET_DIR, files, { recognize: isNexusPluginDir });
}

/** A plugin folder an earlier build installed before the ownership marker. */
function isNexusPluginDir(dir) {
  const entry = readSmallRegularFile(path.join(dir, "tui.tsx"));
  return Boolean(entry?.toString("utf8").includes('id: "fireworks.nexus"'));
}

/** Larger than any plugin file Nexus ships. */
const MAX_ASSET_BYTES = 256 * 1024;

/**
 * `file`'s bytes when it is a regular file of at most MAX_ASSET_BYTES, else
 * null. Opened once, non-blocking and without following a symlink, and
 * checked on that handle, so a FIFO, device, link or huge file in the
 * folder (which other tools can write) can't hang or flood `on`, `off` or
 * an upgrade.
 * @param {string} file
 * @returns {Buffer | null}
 */
function readSmallRegularFile(file) {
  let fd = -1;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_ASSET_BYTES) return null;
    const buffer = Buffer.alloc(MAX_ASSET_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    return length > MAX_ASSET_BYTES ? null : buffer.subarray(0, length);
  } catch {
    return null;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/**
 * Remove the plugin folder, only if Nexus created it (lib/harness/owned-asset-dir.mjs).
 * A failed delete throws, so `off` stops with the config still routed and can
 * be run again.
 * @param {string} configPath
 */
export async function removeOpencodePlugin(configPath) {
  return removeOwnedDir(opencodePluginDir(configPath), { recognize: isNexusPluginDir });
}

/** Whether `file` itself (not a link's target) is a regular file. */
function isRegularFile(file) {
  return readSmallRegularFile(file) !== null;
}

/**
 * Whether `installed` is a regular file with `shipped`'s exact bytes. Anything
 * else (missing, a symlink, a FIFO, another size) is different, read
 * through readSmallRegularFile, so a FIFO can't hang an upgrade.
 */
function sameRegularFile(installed, shipped) {
  try {
    const have = readSmallRegularFile(installed);
    return Boolean(have?.equals(readFileSync(shipped)));
  } catch {
    return false;
  }
}

/**
 * Whether the plugin folder for `configPath` is one Nexus installed whose
 * files differ from this release's (or are missing).
 * @param {string} configPath
 */
export function isOpencodePluginStale(configPath) {
  const dir = opencodePluginDir(configPath);
  try {
    if (!existsSync(dir) || !isNexusOwnedDir(dir, isNexusPluginDir)) return false;
    return PLUGIN_FILES.some((file) => {
      const [source, name] = Array.isArray(file) ? file : [file, file];
      return !sameRegularFile(path.join(dir, name), path.resolve(PLUGIN_ASSET_DIR, source));
    }) || !isRegularFile(path.join(dir, CONFIG_HINT_FILE));
  } catch {
    return false;
  }
}

/**
 * On upgrade: bring an installed plugin folder up to this release's files,
 * so a routed OpenCode gets new plugin features (the Ultra-fast banner)
 * without another `nexus opencode on`. Returns whether it refreshed.
 * @param {string} configPath
 */
export async function refreshOpencodePluginIfStale(configPath) {
  if (!isOpencodePluginStale(configPath)) return false;
  if (!(await installOpencodePlugin(configPath))) throw new Error("could not refresh the OpenCode plugin folder");
  return true;
}
