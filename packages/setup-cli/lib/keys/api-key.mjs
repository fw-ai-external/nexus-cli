import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  FIREWORKS_API_KEY_KEYCHAIN_REF,
  readGlobalConfig,
  writeGlobalConfig,
} from "../config/global-config.mjs";
import {
  deleteSecret,
  detectSecretBackend,
  getLastKeyStoreUndecryptableError,
  getLastSecretReadError,
  getSecret,
  hasSecret,
  setSecret,
} from "./secret-store.mjs";
import { MAC_SECRET_UNREAD, MacKeychainAccessError } from "./macos-security.mjs";
import { plaintextSecretStoreAvailable } from "./plaintext-secret-store.mjs";
import { isKeyStorageForcedNull } from "./storage-env.mjs";
import { cannotStoreKeyMessage, keyStorageSummaryLine } from "./storage-report.mjs";
import { syncBakedKeys } from "./sync.mjs";
import { FIREPASS_KEY_UNSUPPORTED_MESSAGE, isFirePassKey, isFireworksShapedKey } from "./key-type.mjs";
import { apiKeyFingerprint, clearMintedKeyState, readMintedKeyState, writeMintedKeyState } from "./mint-api-key.mjs";
import { expireCatalogCache } from "../fireworks/serverless-catalog-cache.mjs";
import { refreshServerlessCatalogCache } from "../fireworks/models.mjs";
import { readSecret } from "../ui/read-secret.mjs";
import { link } from "../ui/term.mjs";
import { printInfo, printNote } from "../cli/messages.mjs";
import { withSpinner } from "../ui/spinner.mjs";
import { verifyFireworksApiKey } from "./verify-api-key.mjs";
import {
  isEnvConfigRef,
  isKeychainConfigRef,
  isLegacyLiteralConfigRef,
  migrateLegacyGlobalApiKey,
} from "./config-ref.mjs";

export {
  isEnvConfigRef,
  isKeychainConfigRef,
  isLegacyLiteralConfigRef,
} from "./config-ref.mjs";

/** Where Nexus users create API keys, and the default when the account kind isn't known. */
export const NEXUS_KEYS_URL = "https://nexus.fireworks.ai/settings/api-keys";
/** The same page on the Fireworks Platform, for known Platform accounts. */
export const FIREWORKS_KEYS_URL = "https://app.fireworks.ai/settings/users/api-keys";

/** An https URL from the environment, or null when unset or not https. */
function httpsUrlFromEnv(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The API-keys page for an account: known Platform accounts manage keys on
 * the Platform, everyone else (and an unknown account) on the Nexus site.
 * Platform accounts use the page of an https NEXUS_WEB_APP_URL when it is
 * set. Nexus and unknown accounts use an https NEXUS_KEYS_URL when it is set,
 * whatever the web app. Anything else keeps the production pages.
 * @param {"nexus"|"platform"|"unknown"|undefined} accountType
 * @param {NodeJS.ProcessEnv} [env]
 */
export function keysUrlFor(accountType, env = process.env) {
  if (accountType === "platform") {
    const webApp = httpsUrlFromEnv(env.NEXUS_WEB_APP_URL);
    return webApp ? `${webApp.origin}/settings/users/api-keys` : FIREWORKS_KEYS_URL;
  }
  return httpsUrlFromEnv(env.NEXUS_KEYS_URL)?.href ?? NEXUS_KEYS_URL;
}

/**
 * A note for a sign-in against a non-production web app (an https
 * `webAppUrl` other than production) when `keysUrl` (NEXUS_KEYS_URL) isn't
 * an https URL: Nexus key links would otherwise point at production without saying so.
 * "" when there is nothing to say.
 * @param {string | undefined} webAppUrl
 * @param {string | undefined} keysUrl
 */
export function keysUrlOverrideNote(webAppUrl, keysUrl) {
  const webApp = httpsUrlFromEnv(webAppUrl);
  if (!webApp || webApp.origin === new URL(FIREWORKS_KEYS_URL).origin || httpsUrlFromEnv(keysUrl)) {
    return "";
  }
  return "Note: NEXUS_WEB_APP_URL points at a non-production web app, but NEXUS_KEYS_URL isn't set to an https URL, "
    + "so Nexus API-key links point at production. Set NEXUS_KEYS_URL to that environment's API-keys page.";
}

/**
 * The API-keys page for the key stored on this machine. Reads the saved
 * account kind; never throws (Nexus on any error).
 * @param {string} home
 */
export async function keysUrlForHome(home) {
  try {
    return keysUrlFor((await readGlobalConfig(home)).accountType);
  } catch {
    return keysUrlFor("nexus");
  }
}

/**
 * One-line recovery copy for a failed key verification, shared by every
 * key-entry path so `login` and `<harness> on` phrase the same failure the same
 * way.
 * @param {import("./verify-api-key.mjs").VerifyResult} result
 * @param {{ interactive?: boolean, keysUrl?: string }} [options]
 */
export function verifyFailureLine(result, { interactive = false, keysUrl = NEXUS_KEYS_URL } = {}) {
  if (result.reason === "rejected") {
    return interactive
      ? `That key didn't work. Check it at ${link(keysUrl)} or paste another.`
      : `That key didn't work. Check it at ${keysUrl}`;
  }
  if (result.reason === "network") {
    return `Couldn't reach the Fireworks API (${result.detail}). Check your connection and try again.`;
  }
  return `The Fireworks API returned an unexpected response (${result.status}). Try again in a moment.`;
}

export function assertFireworksKeyShape(key) {
  const trimmed = key?.trim() ?? "";
  if (isFirePassKey(trimmed)) {
    throw new Error(FIREPASS_KEY_UNSUPPORTED_MESSAGE);
  }
  if (!isFireworksShapedKey(trimmed)) {
    throw new Error(
      `That doesn't look like a Fireworks key (expected it to start with fw_). Get one at ${NEXUS_KEYS_URL}`,
    );
  }
  return trimmed;
}

/**
 * Shape-check then strict-verify a Fireworks key before it is stored or baked
 * into a harness config, throwing a friendly one-line error on failure. Shared
 * by `login --api-key`/`--with-token` so non-interactive sign-ins validate
 * identically (a typo or dead key fails fast with a clear message instead of
 * a 401 surfacing later inside the tool). Returns the VerifyResult
 * on success so callers can print the resolved identity.
 * @param {string} key
 * @returns {Promise<import("./verify-api-key.mjs").VerifyResult>}
 */
export async function assertFireworksKeyUsable(key) {
  const trimmed = assertFireworksKeyShape(key);
  const result = await verifyFireworksApiKey(trimmed);
  if (!result.ok) {
    throw new Error(verifyFailureLine(result));
  }
  return result;
}

const ON_KEY_VERIFY_TIMEOUT_MS = 5000;

/**
 * Stop `<harness> on` before it bakes an env or saved key that the gateway
 * rejects (deleted, revoked or expired) into a harness config, where it would only
 * surface later as a 401 inside the tool. Only a definitive 401/403 stops the
 * command; offline or an unexpected status keeps `on` working without network.
 * @param {string} key
 * @param {{ harnessId?: string }} [options]
 */
export async function assertResolvedKeyNotRejected(key, { harnessId = "" } = {}) {
  const result = await verifyFireworksApiKey(key, { timeoutMs: ON_KEY_VERIFY_TIMEOUT_MS });
  if (result.reason !== "rejected") {
    return;
  }
  const rerun = harnessId ? `nexus ${harnessId} on` : "nexus login";
  throw new Error(
    "The Fireworks API rejected your saved Fireworks key (it may have been deleted, revoked or expired). "
      + `Run \`nexus login\` to sign in with a new key, then run: ${rerun}`,
  );
}

/**
 * Static description of where each harness reads its Fireworks key from at
 * runtime. Entries WITHOUT a `storage` field are keychain-backed (their
 * storage is filled in dynamically from the detected backend); entries WITH a
 * `storage` field use the IDE's own Electron safeStorage. FireRouter is just a
 * model on each harness's normal provider, so it reads the key from the same
 * place as any other model.
 */
const HARNESS_KEY_SOURCE = {
  claude: {
    readsFrom: "X-Fireworks-Api-Key header in settings.json",
  },
  "claude-desktop": {
    readsFrom: "the stored key, via the Nexus loopback shim",
  },
  codex: {
    readsFrom: "experimental_bearer_token in config.toml",
  },
  opencode: {
    readsFrom: "literal apiKey in opencode.json",
  },
  pi: {
    readsFrom: "literal key in auth.json",
  },
  deepseek: {
    readsFrom: "FIREWORKS_API_KEY in ~/.dsh/.credentials.yaml",
  },
  hermes: {
    readsFrom: "FIREWORKS_API_KEY in ~/.hermes/.env",
  },
  vscode: {
    readsFrom: "VS Code safeStorage (state.vscdb)",
    storage: "IDE Electron safeStorage (encrypted)",
  },
  cursor: {
    readsFrom: "Cursor SQLite / safeStorage",
    storage: "Cursor Electron safeStorage (secret://, encrypted; legacy plaintext fallback)",
  },
  "copilot-app": {
    readsFrom: "Authorization header on the BYOK provider row",
    storage: "Copilot data.db (owner-only)",
  },
  "copilot-cli": {
    readsFrom: "apiKey in the BYOK provider entry",
    storage: "~/.copilot/providers.json (owner-only)",
  },
};

/**
 * Short label for where a harness reads its Fireworks key at runtime.
 * @param {string} harnessId
 */
export function harnessKeySourceLabel(harnessId) {
  return HARNESS_KEY_SOURCE[harnessId]?.readsFrom ?? "";
}

/**
 * Key-source label for per-harness status when the harness is routed through
 * Fireworks (or, for IDE harnesses, any non-none provider).
 * @param {string} harnessId
 * @param {string} provider
 * @param {{ whenFireworks?: boolean, authMode?: string }} [options]
 */
export function harnessStatusKeySource(harnessId, provider, { whenFireworks = true, authMode } = {}) {
  const routed = whenFireworks
    ? provider === "fireworks"
    : provider !== "none";
  if (!routed) {
    return "";
  }
  if (harnessId === "claude" && authMode === "apiKeyHelper") {
    return "nexus key export hook";
  }
  return harnessKeySourceLabel(harnessId);
}

/**
 * @param {string} stored
 */
export function shouldInstallShellEnvHook(stored) {
  return isKeychainConfigRef(stored);
}

/**
 * Refetch the model catalog cache for `apiKey`'s account (bounded, never
 * throws). The cache lives under the process HOME, so a `home` that isn't
 * it (an in-process caller pointing elsewhere) is left alone.
 * @param {string} home
 * @param {string} apiKey
 */
export async function refreshCatalogCacheForHome(home, apiKey) {
  if (path.resolve(home) !== path.resolve(process.env.HOME ?? os.homedir())) {
    return false;
  }
  return await refreshServerlessCatalogCache(apiKey);
}

/**
 * @param {string} home
 * @param {string} apiKey
 * @param {{ backend?: import("./secret-store.mjs").SecretBackend, accountType?: "nexus"|"platform"|"unknown", onNote?: (line: string) => void }} [options]
 *   `onNote` receives baked-key sync notes (default: console.log) — callers
 *   that compose their own success block collect them instead.
 */
export async function persistApiKeyToKeychain(home, apiKey, options = {}) {
  // Refuse early with a friendly, actionable error when no backend can store a
  // key (e.g. HOME unset on headless Linux). `setSecret` readback-verifies the
  // write below; this guard just gives a clearer message before the attempt.
  const backend = options.backend ?? await detectSecretBackend(home);
  if (backend.backend === "unavailable" && (isKeyStorageForcedNull() || !plaintextSecretStoreAvailable(home))) {
    throw new Error(cannotStoreKeyMessage(backend.error));
  }
  const trimmed = apiKey?.trim() ?? "";
  // Idempotent: if the store already holds this key (e.g. login just stored
  // it), skip the write+readback to avoid a duplicate keychain round-trip.
  // An unmarked macOS item will be replaced, so do not unlock it to compare.
  const existing = await getSecret(home, { migrateMacItems: false });
  // A read error means a key may exist that rollback cannot put back, so it must not delete.
  const previousUnreadable = existing === MAC_SECRET_UNREAD || (!existing && getLastSecretReadError() !== null);
  const keyChanged = existing === MAC_SECRET_UNREAD
    ? (await readMintedKeyState(home).catch(() => null))?.keyFingerprint !== apiKeyFingerprint(trimmed)
    : !existing || existing.trim() !== trimmed;
  const secretReplaced = keyChanged || existing === MAC_SECRET_UNREAD;
  if (secretReplaced) {
    await setSecret(trimmed, home);
  }
  // Reference the stored key before the slow catalog refresh below.
  let config = null;
  try {
    config = await readGlobalConfig(home);
    await writeGlobalConfig(home, {
      apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF,
      // Keep the reference and its account metadata in the same config write.
      // Unknown replacements cannot inherit the previous credential's kind;
      // ordinary idempotent config repair preserves known metadata.
      ...(options.accountType !== undefined || keyChanged
        ? { accountType: options.accountType ?? "unknown" } : {}),
      harnesses: config.harnesses,
    });
    // The minted-key record describes the credential the browser flow stored.
    // Record a new mint right after the store, before the slow catalog refresh,
    // so an interrupted save still leaves `logout` able to revoke it. Once a
    // path stores a DIFFERENT key, `logout` must not offer to revoke the old one
    // on its behalf. Only clear on a real change — an idempotent re-store of the
    // same key (config repair, repeated `login --api-key`) must keep the record
    // so a still-held minted key stays revocable.
    if (options.mintedKey) {
      await writeMintedKeyState(home, { ...options.mintedKey, apiKey: trimmed });
    } else if (keyChanged || await mintedRecordIsForAnotherKey(home, trimmed)) {
      await clearMintedKeyState(home);
    }
  } catch (error) {
    // A key that isn't both referenced and recorded is undone locally, so the
    // previous key and its minted record keep working. Only the minted
    // caller revokes its new key; pasted keys belong to the user.
    if (secretReplaced) await restorePreviousKey(home, previousUnreadable ? MAC_SECRET_UNREAD : existing, config);
    throw error;
  }
  if (keyChanged) {
    // The model catalog belongs to the account the old key signed in to:
    // refetch it for the new one, so the next harness `on` lists its models.
    expireCatalogCache(home);
    await refreshCatalogCacheForHome(home, trimmed);
  }
  // Re-point router configs that bake the key as a literal — AFTER the store
  // succeeds, so no config ever points at a key that failed to persist. Runs
  // even when the stored key didn't change: the baked copies can be stale
  // independently of the keychain (that staleness is the 401 this exists to
  // fix), and the sync is a cheap no-op when everything already matches.
  const onNote = options.onNote ?? ((line) => console.log(line));
  const { notes, unconfirmed } = await syncBakedKeys(home, trimmed);
  for (const note of notes) {
    onNote(note);
  }
  options.onKeySync?.(unconfirmed);
}

// Best effort. An unread macOS item can't be put back, so it stays replaced.
async function restorePreviousKey(home, previous, config) {
  if (previous === MAC_SECRET_UNREAD) return;
  await (previous ? setSecret(previous, home) : deleteSecret(home)).catch(() => {});
  if (!config) return;
  await writeGlobalConfig(home, {
    apiKey: config.apiKey,
    accountType: config.accountType,
    harnesses: config.harnesses,
  }).catch(() => {});
}

/**
 * A rerun after a sign-in that stored its key but failed later finds that key
 * already stored, so "changed" alone would keep the replaced key's record.
 * Records without a fingerprint predate it and are left alone.
 * @param {string} home
 * @param {string} apiKey
 */
async function mintedRecordIsForAnotherKey(home, apiKey) {
  const record = await readMintedKeyState(home).catch(() => null);
  return Boolean(record?.keyFingerprint) && record.keyFingerprint !== apiKeyFingerprint(apiKey);
}

/**
 * @param {string} home
 * @param {string} apiKey
 * @param {{ backend?: import("./secret-store.mjs").SecretBackend }} [options]
 */
export async function persistApiKeyFromFlag(home, apiKey, options = {}) {
  if (!apiKey?.trim()) {
    return;
  }
  await persistApiKeyToKeychain(home, apiKey.trim(), options);
}

/**
 * Resolve stored config ref to a key value.
 * @param {string} stored
 */
export async function resolveStoredApiKeyValue(stored, home) {
  if (!stored) {
    return "";
  }
  // A stored {env:FIREWORKS_API_KEY} ref is dead — env is not a credential
  // source anymore; fall through to the keychain so a secret sitting beside
  // the legacy ref still resolves (upgrade reconciliation will rewrite the
  // ref on the next migration pass).
  if (isEnvConfigRef(stored)) {
    return tryReadKeychainSecret(home);
  }
  if (isKeychainConfigRef(stored)) {
    return tryReadKeychainSecret(home);
  }
  if (isLegacyLiteralConfigRef(stored) && isFireworksShapedKey(stored)) {
    return stored.trim();
  }
  return "";
}

/**
 * @typedef {"flag" | "stored" | "none"} FireworksKeySource
 * @typedef {{ key: string, source: FireworksKeySource }} FireworksKeyResolution
 */

/**
 * THE single precedence definition for the active Fireworks key, so every
 * caller resolves it the same way and can report which source won:
 *   1. an explicit `--api-key` flag,
 *   2. the stored credential (keychain / encrypted file / plaintext, via the
 *      `config.json` ref).
 * `FIREWORKS_API_KEY` is deliberately not a source — `nexus login` is the
 * only key entry, and env-injected keys are ignored.
 * `resolveFireworksApiKeyValue` returns just the value; callers that need to
 * tell the user which key is in effect use `.source` here.
 * @param {{ apiKey?: string, home?: string }} args
 * @returns {Promise<FireworksKeyResolution>}
 */
export async function resolveFireworksKeyWithSource({
  apiKey = "",
  home = process.env.HOME ?? "",
}) {
  const flagKey = apiKey?.trim() ?? "";
  let config = null;
  if (home) {
    const migration = await migrateLegacyGlobalApiKey(home);
    config = { apiKey: migration.apiKey };
  }

  if (flagKey) {
    return { key: flagKey, source: "flag" };
  }

  if (config) {
    const resolved = await resolveStoredApiKeyValue(config.apiKey, home);
    if (resolved) {
      return { key: resolved, source: "stored" };
    }
  }

  return { key: "", source: "none" };
}

/**
 * Whether `resolveFireworksKeyWithSource` would find a key, answered without
 * reading the stored one: the keychain is only asked whether the item exists
 * (see `hasSecret`), so status-style callers that report presence don't cost
 * the user a keychain prompt. Same precedence and config refs as the resolver;
 * it doesn't migrate a legacy literal (the next real resolve does).
 * @param {{ apiKey?: string, home?: string }} args
 * @returns {Promise<boolean>}
 */
export async function fireworksKeyPresent({
  apiKey = "",
  home = process.env.HOME ?? "",
}) {
  if (apiKey?.trim()) {
    return true;
  }
  if (!home) {
    return false;
  }
  const stored = (await readGlobalConfig(home)).apiKey;
  if (isKeychainConfigRef(stored)) {
    return hasSecret(home);
  }
  if (isEnvConfigRef(stored)) {
    // A dead env-ref resolves through the keychain (see
    // resolveStoredApiKeyValue); presence checks the same secret.
    return hasSecret(home);
  }
  return isLegacyLiteralConfigRef(stored) && isFireworksShapedKey(stored);
}

/**
 * @param {{ apiKey?: string, home?: string }} args
 */
export async function resolveFireworksApiKeyValue({
  apiKey = "",
  home = process.env.HOME ?? "",
}) {
  return (await resolveFireworksKeyWithSource({ apiKey, home })).key;
}

/**
 * Interactive last resort for `<harness> on`: when no Fireworks key resolves
 * anywhere, ask for one on the TTY instead of failing — the Fireworks
 * counterpart of firerouter-core's Anthropic-key prompt. Persists the entered
 * key to the keychain so the prompt only ever happens once. Returns "" (the
 * caller throws its usual error) on non-interactive stdin, a missing home, or
 * after too many blank/malformed attempts.
 *
 * @param {string} home
 * @param {{ input?: { isTTY?: boolean }, readSecretFn?: typeof readSecret, verifyApiKey?: typeof verifyFireworksApiKey }} [options] test seams
 */
export async function promptForFireworksApiKey(home, options = {}) {
  const input = options.input ?? process.stdin;
  if (!input.isTTY || !home) {
    return "";
  }
  const read = options.readSecretFn ?? readSecret;
  const verify = options.verifyApiKey ?? verifyFireworksApiKey;
  printInfo("No Fireworks API key is stored yet — enter one now to finish setup.");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const entered = await read("Fireworks API key (fw_...): ", { allowEmpty: true });
    if (!entered) {
      printNote("No key entered — try again, or press Ctrl+C to cancel.");
      continue;
    }
    if (isFirePassKey(entered)) {
      printNote(FIREPASS_KEY_UNSUPPORTED_MESSAGE);
      continue;
    }
    if (!isFireworksShapedKey(entered)) {
      printNote("That doesn't look like a Fireworks API key (should start with fw_). Try again.");
      continue;
    }
    const result = await withSpinner("Checking your key…", () => verify(entered));
    if (!result.ok) {
      printNote(verifyFailureLine(result, { interactive: true }));
      continue;
    }
    await persistApiKeyToKeychain(home, entered);
    const { message } = await keyStorageSummaryLine(home);
    console.log(message);
    return entered;
  }
  return "";
}

/**
 * Last-resort keychain read: the stored Fireworks key (trimmed) or "". Shared
 * by `exportFireworksApiKey`, `resolveHarnessOnApiKey`'s fallback, and stored
 * key resolution so the keychain-read logic lives in one place. A leftover
 * Fire Pass key reads as missing, so callers fall through to `login`.
 * @param {string} home
 * @returns {Promise<string>}
 */
export async function tryReadKeychainSecret(home) {
  const secret = (await getSecret(home))?.trim() ?? "";
  const error = getLastSecretReadError();
  if (!secret && error instanceof MacKeychainAccessError) throw error;
  return isFirePassKey(secret) ? "" : secret;
}

/**
 * For `nexus key export` and Claude apiKeyHelper.
 * @param {string} [home]
 * @param {{ storedOnly?: boolean }} [opts]
 */
export async function exportFireworksApiKey(home = process.env.HOME ?? "", { storedOnly = false } = {}) {
  const fromKeychain = await tryReadKeychainSecret(home);
  if (fromKeychain) {
    return fromKeychain;
  }

  if (home) {
    const config = await readGlobalConfig(home);
    if (isLegacyLiteralConfigRef(config.apiKey) && isFireworksShapedKey(config.apiKey)) {
      return config.apiKey.trim();
    }
  }

  throw keyStoreUnreadableError() ?? new Error("No Fireworks API key found. Run `nexus login` to sign in.");
}

/**
 * The stored key is unreachable because the encrypted key store can't be
 * decrypted with the current master key: that error (with its recovery
 * steps), or null. Reads themselves stay non-throwing; commands that need
 * the key call this after resolving nothing, to explain the miss instead of
 * reporting that no key exists. The record survives unrelated successful
 * reads in the same command (plaintext, cache, macOS probe) and is cleared
 * only by decrypting or writing the encrypted store, so a command can't be
 * misled either way: see `getLastKeyStoreUndecryptableError`.
 * @returns {import("./secret-store.mjs").KeyStoreUndecryptableError | null}
 */
export function keyStoreUnreadableError() {
  return getLastKeyStoreUndecryptableError();
}

/**
 * Stop a sign-in before it creates a key that could not be stored: refuses
 * with {@link keyStoreUnreadableError} when the encrypted key store can't be
 * decrypted. Any other probe failure is left for the store step to report.
 * @param {string} home
 */
export async function assertKeyStoreReadable(home) {
  try {
    await hasSecret(home);
  } catch {
    return;
  }
  const unreadable = keyStoreUnreadableError();
  if (unreadable) throw unreadable;
}

/**
 * @param {string} home
 */
export async function keyStatusSummary(home) {
  const config = await readGlobalConfig(home);
  const keychainPresent = await hasSecret(home);
  const backend = await detectSecretBackend(home);

  /** @type {Array<{ id: string, enabled: boolean, readsFrom: string, storage: string }>} */
  const perHarness = [];
  for (const [id, src] of Object.entries(HARNESS_KEY_SOURCE)) {
    const enabled = config.harnesses[id]?.enabled === true;
    // Keychain-backed harnesses are the ones without a static `storage`.
    const storage = src.storage
      ? src.storage
      : keychainPresent
        ? backend.label
        : "(no key stored)";
    perHarness.push({
      id,
      enabled,
      readsFrom: src.readsFrom,
      storage,
    });
  }

  // Don't surface a legacy literal key in `nexus status` output — mask it. Only
  // refs ({env:…}, {keychain:…}) and "(unset)" are reported verbatim; the kind
  // is derivable from configRef by the caller.
  const rawRef = config.apiKey || "";
  const configRef = isKeychainConfigRef(rawRef) || isEnvConfigRef(rawRef)
    ? rawRef
    : rawRef
      ? "(legacy literal — run `nexus login` to move it into secure storage)"
      : "(unset)";

  return {
    configRef,
    keychainPresent,
    envPresent: Boolean(process.env.FIREWORKS_API_KEY?.trim()),
    backend: backend.backend,
    backendLabel: backend.label,
    location: backend.location ?? null,
    backendError: backend.error ?? null,
    perHarness,
  };
}
