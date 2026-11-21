import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../io/atomic-write.mjs";
import { ensurePrivateParent } from "../io/private-files.mjs";

const PLAINTEXT_RELATIVE_PATH = ".nexus/.api-key";

/**
 * @param {string} home
 * @returns {string | null}
 */
export function plaintextSecretPath(home) {
  const resolved = home?.trim() ?? "";
  return resolved ? path.join(resolved, PLAINTEXT_RELATIVE_PATH) : null;
}

/**
 * @param {string} home
 * @returns {boolean}
 */
export function plaintextSecretStoreAvailable(home) {
  return Boolean(plaintextSecretPath(home));
}

async function openPlaintextSecret(filePath, home) {
  ensurePrivateParent(filePath, { create: false });
  if (process.platform !== "win32") {
    const directory = await open(path.dirname(filePath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.chmod(0o700); } finally { await directory.close(); }
  }
  const handle = await open(filePath, constants.O_RDONLY
    | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    if (process.platform !== "win32") {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid()) throw new Error("Unsafe plaintext credential file");
      await handle.chmod(0o600);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * @param {string} home
 * @returns {Promise<string | null>}
 */
export async function readPlaintextSecret(home) {
  const filePath = plaintextSecretPath(home);
  if (!filePath) {
    return null;
  }
  try {
    const handle = await openPlaintextSecret(filePath, home);
    try { return (await handle.readFile("utf8")).trim() || null; } finally { await handle.close(); }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * @param {string} home
 * @param {string} value
 */
export async function writePlaintextSecret(home, value) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new Error("API key is required");
  }
  const filePath = plaintextSecretPath(home);
  if (!filePath) {
    throw new Error("HOME is not set; cannot use the plaintext secret fallback");
  }
  try {
    if (!(await lstat(filePath)).isSymbolicLink()) {
      const handle = await openPlaintextSecret(filePath, home);
      await handle.close();
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  ensurePrivateParent(filePath);
  await writeFileAtomic(filePath, `${trimmed}\n`, { mode: 0o600 });
}

/**
 * @param {string} home
 */
export async function deletePlaintextSecret(home) {
  const filePath = plaintextSecretPath(home);
  if (!filePath) {
    return;
  }
  try {
    ensurePrivateParent(filePath, { create: false });
    await unlink(filePath);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * @param {string} home
 * @returns {Promise<boolean>}
 */
export async function hasPlaintextSecret(home) {
  const value = await readPlaintextSecret(home);
  return Boolean(value?.trim());
}
