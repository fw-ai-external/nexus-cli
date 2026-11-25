/**
 * File access for the Codex Ultra-fast server: small, bounded reads and
 * all-at-once writes. Separate from statusline-server.mjs (which starts the
 * server when loaded) so tests can import it.
 */

import { constants } from "node:fs";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** A small regular file's text, null when it doesn't exist; throws when it can't be used. */
export async function readText(file, maxBytes) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error("not a regular file"), { code: "ENOTFILE" });
    if (stat.size > maxBytes) throw Object.assign(new Error("too large"), { code: "EFBIG" });
    const buf = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buf, 0, stat.size, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Write a file all at once: a private temp file beside it, then a rename. The
 * temp file is created exclusively (`wx`), so a file or symlink already at that
 * path is never written through; a stale one left by a crashed run is removed
 * and the write tried once more.
 */
export async function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) throw error;
      await unlink(tmp); // removes a symlink itself, never its target
    }
  }
  try {
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}
