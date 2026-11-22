import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ensurePrivateParent } from "../io/private-files.mjs";

/**
 * Minimal encrypted-file secret store compatible with cross-keychain's `file`
 * backend. Used only when the cross-keychain npm package cannot be loaded so
 * configure / harness on can still store keys (AES-256-GCM, same on-disk layout).
 */

/**
 * @returns {string}
 */
function resolvedHomeDir() {
  const home = process.env.HOME?.trim();
  return home || os.homedir();
}

/**
 * @returns {string}
 */
function configRoot() {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "keyring");
  }
  if (process.platform === "win32") {
    const root = process.env.LOCALAPPDATA || process.env.APPDATA || resolvedHomeDir();
    return path.join(root, "Keyring");
  }
  return path.join(resolvedHomeDir(), ".config", "keyring");
}

/**
 * @returns {string}
 */
export function fileDataRoot() {
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, "keyring");
  }
  if (process.platform === "win32") {
    const root = process.env.LOCALAPPDATA || process.env.ProgramData || resolvedHomeDir();
    return path.join(root, "Keyring");
  }
  const home = resolvedHomeDir();
  return home ? path.join(home, ".local", "share", "keyring") : "";
}

/**
 * @returns {string | null}
 */
export function secretsFilePath() {
  const root = fileDataRoot();
  return root ? path.join(root, "secrets.json") : null;
}

/**
 * @returns {string}
 */
export function keyFilePath() {
  return path.join(configRoot(), "file.key");
}

/** `code` of {@link KeyStoreUndecryptableError}, for callers that match on codes. */
export const KEY_STORE_UNDECRYPTABLE = "NEXUS_KEY_STORE_UNDECRYPTABLE";

/**
 * The encrypted key store exists but the current master key cannot decrypt it
 * (AES-GCM authentication failed): `KEYRING_FILE_MASTER_KEY` changed, was set
 * or unset, or the generated key file was replaced. Storage must stop here
 * rather than fall back to plaintext or overwrite a store that still holds
 * secrets under the previous key. Build it while HOME/XDG point at the store
 * in question (inside withHomeScopedEnv) so the paths in the message are right.
 */
export class KeyStoreUndecryptableError extends Error {
  /**
   * @param {{ storePath?: string | null, keyFile?: string, masterKeyFromEnv?: boolean, cause?: unknown }} [details]
   */
  constructor({
    storePath = secretsFilePath(),
    keyFile = keyFilePath(),
    masterKeyFromEnv = Boolean(process.env.KEYRING_FILE_MASTER_KEY?.trim()),
    cause,
  } = {}) {
    const store = storePath ?? "~/.local/share/keyring/secrets.json";
    const current = masterKeyFromEnv ? "from KEYRING_FILE_MASTER_KEY" : `from the key file ${keyFile}`;
    super(
      `The encrypted key store at ${store} can't be decrypted with the current master key (${current}). `
        + "It was encrypted under a different one: KEYRING_FILE_MASTER_KEY changed, was set or unset, "
        + `or the key file ${keyFile} was replaced. Nexus did not modify the store or fall back to a plaintext copy.\n\n`
        + "To keep the stored key: restore the previous KEYRING_FILE_MASTER_KEY or key file, then re-run.\n"
        + `To discard it: delete ${store} (this removes every secret in it), then run \`nexus login\`.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "KeyStoreUndecryptableError";
    this.code = KEY_STORE_UNDECRYPTABLE;
    this.storePath = store;
    this.keyFile = keyFile;
  }
}

/**
 * @param {unknown} error
 * @returns {error is KeyStoreUndecryptableError}
 */
export function isKeyStoreUndecryptableError(error) {
  return /** @type {{ code?: unknown } | null} */ (error)?.code === KEY_STORE_UNDECRYPTABLE;
}

/**
 * Node's AES-GCM authentication failure, as thrown by `decipher.final()` here
 * and in cross-keychain's file backend when the key does not match the data.
 * @param {unknown} error
 */
function isDecryptAuthFailure(error) {
  const message = /** @type {{ message?: unknown } | null} */ (error)?.message;
  return typeof message === "string" && /unable to authenticate data/i.test(message);
}

/**
 * Map a file-store decrypt failure to {@link KeyStoreUndecryptableError};
 * any other error is returned unchanged.
 * @param {unknown} error
 * @returns {unknown}
 */
export function asKeyStoreUndecryptableError(error) {
  if (isKeyStoreUndecryptableError(error) || !isDecryptAuthFailure(error)) {
    return error;
  }
  return new KeyStoreUndecryptableError({ cause: error });
}

function environmentKey() {
  const value = process.env.KEYRING_FILE_MASTER_KEY;
  if (!value?.trim()) return null;
  if (value.length !== 64 || !/^[a-fA-F0-9]+$/.test(value)) {
    throw new Error("KEYRING_FILE_MASTER_KEY must be 64 hex characters (32 bytes)");
  }
  return Buffer.from(value, "hex");
}

async function openPrivate(file, flags, directory = false) {
  let handle;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
    handle = await open(file, flags | noFollow, 0o600);
    if (process.platform !== "win32") {
      const info = await handle.stat();
      if (info.uid !== process.getuid() || !(directory ? info.isDirectory() : info.isFile())) {
        throw new Error("Unsafe file store entry");
      }
      await handle.chmod(directory ? 0o700 : 0o600);
    }
    return handle;
  } catch (error) {
    await handle?.close();
    if (error.code === "ENOENT" || error.code === "EEXIST") throw error;
    throw new Error("Cannot secure file key store. Check ownership, permissions, and symlinks.");
  }
}

async function secureDirectory(dir, create = false) {
  try {
    ensurePrivateParent(path.join(dir, ".entry"), { create });
  } catch (error) {
    if (error.code === "ENOENT") throw error;
    throw new Error("Cannot secure file key store. Check ownership, permissions, and symlinks.");
  }
  if (process.platform === "win32") {
    if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
    return;
  }
  let handle;
  try {
    handle = await openPrivate(dir, constants.O_RDONLY, true);
  } catch (error) {
    if (!create || error.code !== "ENOENT") throw error;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    handle = await openPrivate(dir, constants.O_RDONLY, true);
  }
  await handle.close();
}

async function readPrivate(file) {
  await secureDirectory(path.dirname(file));
  const handle = await openPrivate(file, constants.O_RDONLY);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function createPrivate(file, data) {
  await secureDirectory(path.dirname(file), true);
  const handle = await openPrivate(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/**
 * @returns {Promise<Buffer>}
 */
async function getKeyMaterial() {
  const envKey = environmentKey();
  if (envKey) return envKey;

  const keyFile = keyFilePath();
  let key;
  try {
    key = await readPrivate(keyFile);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
      throw error;
    }
    try {
      await createPrivate(keyFile, randomBytes(32));
    } catch (createError) {
      if (createError.code !== "EEXIST") throw createError;
    }
    key = await readPrivate(keyFile);
  }
  if (key.length !== 32) {
    throw new Error("Key file must contain exactly 32 bytes");
  }
  return key;
}

/**
 * @param {Record<string, Record<string, string>>} store
 * @returns {Promise<Buffer>}
 */
async function encryptStore(store) {
  const plaintext = JSON.stringify(store);
  const key = await getKeyMaterial();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const version = Buffer.from([1]);
  return Buffer.concat([version, iv, authTag, encrypted]);
}

/**
 * @param {Buffer} data
 * @returns {Promise<Record<string, Record<string, string>>>}
 */
async function decryptStore(data) {
  const version = data[0];
  if (version !== 1) {
    throw new Error(`Unsupported store format version: ${version}`);
  }
  const iv = data.subarray(1, 13);
  const authTag = data.subarray(13, 29);
  const encrypted = data.subarray(29);
  const key = await getKeyMaterial();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  let decrypted;
  try {
    decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (error) {
    throw asKeyStoreUndecryptableError(error);
  }
  return JSON.parse(decrypted.toString("utf8"));
}

/**
 * @param {string} file
 * @param {Buffer} buf
 */
async function atomicWrite(file, buf) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
  let created = false;
  try {
    await createPrivate(tmp, buf);
    created = true;
    const target = await openPrivate(file, constants.O_RDONLY);
    await target.close();
    await rename(tmp, file);
  } finally {
    if (created) await unlink(tmp).catch(() => {});
  }
}

/**
 * @returns {Promise<Record<string, Record<string, string>>>}
 */
async function readStore(initialize = false) {
  environmentKey();
  const file = secretsFilePath();
  if (!file) {
    throw new Error("HOME is not set and XDG_DATA_HOME is unset");
  }
  try {
    const data = await readPrivate(file);
    return decryptStore(data);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      if (!initialize) return {};
      const encrypted = await encryptStore({});
      try {
        await createPrivate(file, encrypted);
      } catch (createError) {
        if (createError.code !== "EEXIST") throw createError;
      }
      return readStore();
    }
    throw error;
  }
}

/**
 * @param {Record<string, Record<string, string>>} store
 */
async function writeStore(store) {
  const file = secretsFilePath();
  if (!file) {
    throw new Error("HOME is not set and XDG_DATA_HOME is unset");
  }
  const encrypted = await encryptStore(store);
  await atomicWrite(file, encrypted);
}

/**
 * @returns {boolean}
 */
export function builtinFileStoreAvailable() {
  return Boolean(secretsFilePath());
}

/**
 * @param {string} service
 * @param {string} account
 * @returns {Promise<string | null>}
 */
export async function builtinGetPassword(service, account) {
  const store = await readStore();
  return store[service]?.[account] ?? null;
}

let storeUpdates = Promise.resolve();

function serializeUpdate(update) {
  const pending = storeUpdates.then(update);
  storeUpdates = pending.catch(() => {});
  return pending;
}

/**
 * @param {string} service
 * @param {string} account
 * @param {string} password
 */
export async function builtinSetPassword(service, account, password) {
  return serializeUpdate(async () => {
    const store = await readStore(true);
    const serviceEntry = store[service] ?? {};
    serviceEntry[account] = password;
    store[service] = serviceEntry;
    await writeStore(store);
  });
}

/**
 * Write and readback-verify a secret in the builtin encrypted-file store.
 *
 * @param {string} service
 * @param {string} account
 * @param {string} password
 */
export async function storeBuiltinFileSecretVerified(service, account, password) {
  const trimmed = password?.trim() ?? "";
  await builtinSetPassword(service, account, trimmed);
  const readback = await builtinGetPassword(service, account);
  if (!readback || readback.trim() !== trimmed) {
    const where = secretsFilePath() ?? "the encrypted file store";
    throw new Error(`Storage verification failed: the key could not be read back from ${where}.`);
  }
}

/**
 * @param {string} service
 * @param {string} account
 */
export async function builtinDeletePassword(service, account) {
  return serializeUpdate(async () => {
    const store = await readStore();
    const serviceEntry = store[service];
    if (!serviceEntry || !(account in serviceEntry)) {
      return;
    }
    delete serviceEntry[account];
    if (Object.keys(serviceEntry).length === 0) {
      delete store[service];
    } else {
      store[service] = serviceEntry;
    }
    await writeStore(store);
  });
}

/**
 * @param {string} service
 * @param {string} account
 * @returns {Promise<boolean>}
 */
export async function builtinHasPassword(service, account) {
  const value = await builtinGetPassword(service, account);
  return Boolean(value?.trim());
}
