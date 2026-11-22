import { randomBytes } from "node:crypto";
import { constants, closeSync, fchmodSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

async function existingFileMode(filePath) {
  try {
    return (await stat(filePath)).mode & 0o777;
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Write a file atomically: write to a temp file in the same directory, then
 * rename over the target. On POSIX the rename is atomic, so readers (e.g.
 * Claude Code loading settings.json) never observe a truncated file even if
 * this process is killed mid-write. When `mode` is omitted, an existing
 * target's permissions are preserved rather than replaced by the process
 * umask's default.
 *
 * @param {string} filePath
 * @param {string} data
 * @param {{ mode?: number }} [options]
 */
export async function writeFileAtomic(filePath, data, { mode } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const targetMode = mode ?? await existingFileMode(filePath) ?? (0o666 & ~process.umask());
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle;
  let created = false;
  try {
    handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
    created = true;
    await handle.writeFile(data);
    if (targetMode !== undefined) await handle.chmod(targetMode);
    await handle.close();
    handle = null;
    await rename(tempPath, filePath);
  } catch (error) {
    await handle?.close();
    if (created) await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function existingFileModeSync(filePath) {
  try {
    return statSync(filePath).mode & 0o777;
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Write a file atomically from a synchronous caller.
 * @param {string} filePath
 * @param {string} data
 * @param {{ mode?: number }} [options]
 */
export function writeFileAtomicSync(filePath, data, { mode } = {}) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const targetMode = mode ?? existingFileModeSync(filePath) ?? (0o666 & ~process.umask());
  const tempPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let fd;
  let created = false;
  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
    created = true;
    writeFileSync(fd, data);
    if (targetMode !== undefined) fchmodSync(fd, targetMode);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (fd !== undefined) closeSync(fd);
      if (created) unlinkSync(tempPath);
    } catch {
      // The temp file may not have been created.
    }
    throw error;
  }
}
