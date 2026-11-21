import process from "node:process";
import { isRemoteContext } from "./remote-context.mjs";
import { readKeyStorageOverride } from "../keys/storage-env.mjs";

/**
 * Central policy for secret storage in remote / SSH / WSL sessions.
 * Keys, harness, and environment detection should all consult this module
 * instead of re-deriving overlapping predicates.
 */

/**
 * On Linux SSH/WSL, prefer encrypted-file storage over libsecret. Secret
 * Service is often detected (secret-tool installed) but unusable without an
 * unlocked session keyring. A desktop session uses the file too once it holds
 * a key (`fileKeyPresent`), so the desktop and SSH sessions on one machine
 * read and write the same copy.
 *
 * @param {{ fileKeyPresent?: boolean }} [opts]
 * @returns {boolean}
 */
export function shouldPreferFileBackendOnLinux({ fileKeyPresent = false } = {}) {
  if (process.platform !== "linux") {
    return false;
  }
  if (readKeyStorageOverride()) {
    return false;
  }
  return isRemoteContext() || fileKeyPresent;
}

/**
 * Human-readable detail for `detectSecretStorage()` when file backend is chosen
 * due to remote context.
 *
 * @returns {string | undefined}
 */
export function remoteSecretStorageDetail() {
  if (!shouldPreferFileBackendOnLinux()) {
    return undefined;
  }
  return "SSH/remote session — using encrypted-file storage instead of the OS keychain";
}
