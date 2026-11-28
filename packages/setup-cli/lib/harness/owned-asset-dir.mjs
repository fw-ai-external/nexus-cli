/**
 * A folder Nexus installs beside a harness's config (the Codex pet, the
 * OpenCode sidebar plugin), marked so Nexus only ever replaces or deletes a
 * folder it created. A folder at the same path that Nexus can't identify as
 * its own belongs to the user and is left alone.
 */

import { randomBytes } from "node:crypto";
import { constants as fsConstants, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
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
 * Whether `dir` holds nothing but a staged ownership marker: what a first
 * install leaves when it stops while writing the marker, its first write.
 * Each file must carry the marker's Nexus-specific temp name and be a regular
 * file whose bytes are the marker text (or the start of it, if the write
 * stopped partway). Such a folder is Nexus's to take over or remove; one with
 * anything else in it stays the user's.
 */
function holdsOnlyStagedMarker(dir) {
  try {
    const names = readdirSync(dir);
    return names.length > 0 && names.every((name) => {
      if (!STAGED_MARKER.test(name)) return false;
      const file = path.join(dir, name);
      const info = lstatSync(file);
      return info.isFile() && info.size <= MARKER_TEXT.length && MARKER_TEXT.startsWith(readFileSync(file, "utf8"));
    });
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
  return !existsSync(dir) || isNexusOwnedDir(dir, recognize) || isEmptyDir(dir) || holdsOnlyStagedMarker(dir);
}

/** One line on stderr with NEXUS_DEBUG=1; silent otherwise. */
function debug(message, error) {
  if (process.env.NEXUS_DEBUG === "1") {
    process.stderr.write(`[nexus] ${message}: ${error?.message ?? error}\n`);
  }
}

/**
 * Create or refresh `dir` with `files`, in order: a name copied from
 * `sourceDir`, a `[source, name]` pair for a file kept elsewhere (a path
 * relative to `sourceDir`, or absolute), or `{ name, contents }` for a file
 * written from text. Each lands atomically (see replaceAtomically), and temp
 * files an earlier, interrupted install left are removed first. The marker is
 * written right after the folder, so an install that stops partway is still
 * recognized (and removed) as Nexus's; an empty folder left by a stop before
 * the marker is safe to take over. Refuses a non-empty folder Nexus can't
 * identify. Best effort: returns false on any failure, never throws.
 * @param {string} dir
 * @param {string} sourceDir
 * @param {(string | [string, string] | { name: string, contents: string })[]} files
 * @param {{ recognize?: (dir: string) => boolean }} [options]
 */
export async function installOwnedDir(dir, sourceDir, files, { recognize } = {}) {
  try {
    if (!canInstallOwnedDir(dir, recognize)) {
      debug(`left ${dir} alone`, "it exists and was not installed by Nexus");
      return false;
    }
    await mkdir(dir, { recursive: true });
    await replaceOwnedFile(path.join(dir, OWNED_MARKER), MARKER_TEXT);
    await removeStaleTemps(dir);
    for (const file of files) {
      if (file && typeof file === "object" && !Array.isArray(file)) {
        await replaceOwnedFile(path.join(dir, file.name), file.contents);
        continue;
      }
      const [source, name] = Array.isArray(file) ? file : [file, file];
      await replaceWithCopy(path.resolve(sourceDir, source), path.join(dir, name));
    }
    return true;
  } catch (error) {
    debug(`could not install ${dir}`, error);
    return false;
  }
}

/**
 * Put new content at `dest` without ever writing through what is there: the
 * content goes to a fresh, exclusively created file beside it, which is then
 * renamed over `dest` (replacing a file, or a symlink itself, never its
 * target). If writing fails, `dest` is left as it was and the temp file is
 * removed.
 * @param {string} dest
 * @param {(temp: string) => Promise<void>} write creates `temp` exclusively
 */
async function replaceAtomically(dest, write) {
  const temp = path.join(path.dirname(dest), `.${path.basename(dest)}.nexus-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await write(temp);
    await rename(temp, dest);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Temp files replaceAtomically names: `.<name>.nexus-<pid>-<hex>.tmp`. */
const TEMP_FILE = /^\..+\.nexus-\d+-[0-9a-f]{12}\.tmp$/;
/** A staged ownership marker: the temp name of `.nexus-owned`. */
const STAGED_MARKER = /^\.\.nexus-owned\.nexus-\d+-[0-9a-f]{12}\.tmp$/;

/** Remove temp files a stopped install left in `dir`. */
async function removeStaleTemps(dir) {
  for (const name of readdirSync(dir)) {
    if (TEMP_FILE.test(name)) await rm(path.join(dir, name), { force: true });
  }
}

/** Copy `source` to `dest`; see {@link replaceAtomically}. */
async function replaceWithCopy(source, dest) {
  await replaceAtomically(dest, (temp) => copyFile(source, temp, fsConstants.COPYFILE_EXCL));
}

/**
 * Write `text` to `dest` in a folder Nexus owns, the same way as
 * {@link installOwnedDir} copies: never through a symlink at `dest`, and a
 * failed write leaves what was there.
 * @param {string} dest
 * @param {string} text
 */
export async function replaceOwnedFile(dest, text) {
  await replaceAtomically(dest, (temp) => writeFile(temp, text, { flag: "wx" }));
}

/**
 * Delete `dir` only when Nexus created it. Throws when the delete itself
 * fails, so `off` stops before it restores the config and can be run again;
 * returns false when there is nothing of Nexus's to delete.
 * @param {string} dir
 * @param {{ recognize?: (dir: string) => boolean }} [options]
 */
export async function removeOwnedDir(dir, { recognize } = {}) {
  if (!existsSync(dir) || !(isNexusOwnedDir(dir, recognize) || holdsOnlyStagedMarker(dir))) {
    return false;
  }
  await rm(dir, { recursive: true, force: true });
  return true;
}
