/**
 * The Fireworks Nexus sidebar card for OpenCode 2.x (nexus-plugin/tui.tsx).
 * One file: the logo is Braille cell art, the same mark the CLI prints.
 *
 * OpenCode auto-discovers plugin folders in `<config dir>/plugins/<name>/`, so
 * installing is a file copy: opencode.json is untouched and `off` keeps its
 * byte-for-byte restore. `off` deletes the folder. OpenCode 1.x doesn't read
 * this folder, so the copy is inert there.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installOwnedDir, removeOwnedDir } from "../../harness/owned-asset-dir.mjs";

export const OPENCODE_PLUGIN_DIRNAME = "fireworks-nexus";
const PLUGIN_ASSET_DIR = fileURLToPath(new URL("./nexus-plugin/", import.meta.url));
const PLUGIN_FILES = ["tui.tsx"];

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
  return installOwnedDir(opencodePluginDir(configPath), PLUGIN_ASSET_DIR, PLUGIN_FILES, { recognize: isNexusPluginDir });
}

/** A plugin folder an earlier build installed before the ownership marker. */
function isNexusPluginDir(dir) {
  return readFileSync(path.join(dir, "tui.tsx"), "utf8").includes('id: "fireworks.nexus"');
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
