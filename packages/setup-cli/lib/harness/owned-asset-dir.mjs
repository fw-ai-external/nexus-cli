/**
 * A folder Nexus installs beside a harness's config (the Codex pet, the
 * OpenCode sidebar plugin), marked so Nexus only ever replaces or deletes a
 * folder it created. A folder at the same path that Nexus can't identify as
 * its own belongs to the user and is left alone.
 */

import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const OWNED_MARKER = ".nexus-owned";
const MARKER_TEXT = "Installed by Nexus. `nexus <harness> off` removes this folder.\n";

/**
 * True when `dir` is Nexus's: it carries the marker, or `recognize` positively
 * identifies Nexus's own files in it (a folder an earlier build installed
 * before the marker existed).
 * @param {string} dir
 * @param {(dir: string) => boolean} [recognize]
 */
export function isNexusOwnedDir(dir, recognize) {
  if (existsSync(path.join(dir, OWNED_MARKER))) {
    return true;
  }
  try {
    return Boolean(recognize?.(dir));
  } catch {
    return false;
  }
}

/** @param {string} dir */
function isEmptyDir(dir) {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/**
 * Whether {@link installOwnedDir} would write here: nothing there yet, an empty
 * folder, or one that is already Nexus's.
 * @param {string} dir
 * @param {(dir: string) => boolean} [recognize]
 */
export function canInstallOwnedDir(dir, recognize) {
  return !existsSync(dir) || isNexusOwnedDir(dir, recognize) || isEmptyDir(dir);
}

/** One line on stderr with NEXUS_DEBUG=1; silent otherwise. */
function debug(message, error) {
  if (process.env.NEXUS_DEBUG === "1") {
    process.stderr.write(`[nexus] ${message}: ${error?.message ?? error}\n`);
  }
}

/**
 * Create or refresh `dir` with `files` copied from `sourceDir`. The marker is
 * written right after the folder, so an install that stops partway is still
 * recognized (and removed) as Nexus's; an empty folder left by a stop before
 * the marker is safe to take over. Refuses a non-empty folder Nexus can't
 * identify. Best effort: returns false on any failure, never throws.
 * @param {string} dir
 * @param {string} sourceDir
 * @param {string[]} files
 * @param {{ recognize?: (dir: string) => boolean }} [options]
 */
export async function installOwnedDir(dir, sourceDir, files, { recognize } = {}) {
  try {
    if (!canInstallOwnedDir(dir, recognize)) {
      debug(`left ${dir} alone`, "it exists and was not installed by Nexus");
      return false;
    }
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, OWNED_MARKER), MARKER_TEXT);
    for (const file of files) {
      await copyFile(path.join(sourceDir, file), path.join(dir, file));
    }
    return true;
  } catch (error) {
    debug(`could not install ${dir}`, error);
    return false;
  }
}

/**
 * Delete `dir` only when Nexus created it. Throws when the delete itself
 * fails, so `off` stops before it restores the config and can be run again;
 * returns false when there is nothing of Nexus's to delete.
 * @param {string} dir
 * @param {{ recognize?: (dir: string) => boolean }} [options]
 */
export async function removeOwnedDir(dir, { recognize } = {}) {
  if (!existsSync(dir) || !isNexusOwnedDir(dir, recognize)) {
    return false;
  }
  await rm(dir, { recursive: true, force: true });
  return true;
}
