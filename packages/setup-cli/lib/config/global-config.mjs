import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  AZURE_API_KEY_ENV,
  AZURE_API_KEY_ENV_REF,
  isAzureApiKeyEnvRef,
  normalizeAzureBaseUrl,
} from "../fireworks/azure-core.mjs";
import { readJsonIfExists, writeJson } from "../io/json.mjs";
import { ensurePrivateParent } from "../io/private-files.mjs";
import { isFireworksShapedKey } from "../keys/key-type.mjs";
import { HARNESS, HARNESSES } from "../harness/id.mjs";
import { normalizeAutoSettings } from "./auto-providers.mjs";
import { supportedResidency } from "../fireworks/residency-regions.mjs";

export const GLOBAL_CONFIG_RELATIVE_PATH = ".nexus/config.json";
export const FIREWORKS_API_KEY_ENV_REF = "{env:FIREWORKS_API_KEY}";
export const ANTHROPIC_API_KEY_ENV_REF = "{env:ANTHROPIC_API_KEY}";
export const OPENAI_API_KEY_ENV_REF = "{env:OPENAI_API_KEY}";
// The keychain ref names the account the key is stored under — SECRET_ACCOUNT
// ("fireworks-api-key") in secret-store.mjs. It's a fixed sentinel, not parsed;
// getSecret() always reads that one account. The `keychain-ref-account-name`
// test guards this string against drift from SECRET_ACCOUNT.
export const FIREWORKS_API_KEY_KEYCHAIN_REF = "{keychain:fireworks-api-key}";

/**
 * Enabled Fireworks-routed harness entry (legacy entries omit `provider`).
 * @param {HarnessConfigMap} harnesses
 * @param {string} harnessId
 */
export function isEnabledFireworksHarness(harnesses, harnessId) {
  const entry = harnesses[harnessId];
  return entry?.enabled === true && entry?.provider !== "azure";
}

/** @typedef {{
 *   enabled: boolean,
 *   provider?: "fireworks"|"azure",
 *   profiles?: Record<string, unknown>,
 *   residency?: "US",
 * }} HarnessConfigEntry */
/** @typedef {Record<string, HarnessConfigEntry>} HarnessConfigMap */

export function globalConfigPath(home) {
  return path.join(home, GLOBAL_CONFIG_RELATIVE_PATH);
}

/**
 * Sync resolver for env ref only (legacy callers/tests).
 * Prefer resolveStoredApiKeyValue() for keychain-aware resolution.
 * @param {string} stored
 */
export function resolveStoredApiKey(stored) {
  if (!stored) {
    return "";
  }
  if (stored === FIREWORKS_API_KEY_ENV_REF) {
    // env is not a credential source; the ref is dead
    return "";
  }
  if (stored === FIREWORKS_API_KEY_KEYCHAIN_REF) {
    return "";
  }
  if (isFireworksShapedKey(stored)) {
    return stored.trim();
  }
  return stored.trim();
}

/**
 * @param {string} stored
 */
export function resolveStoredAnthropicApiKey(stored) {
  if (!stored) {
    return "";
  }
  if (stored === ANTHROPIC_API_KEY_ENV_REF) {
    return process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  }
  return stored.trim();
}

/**
 * @param {string} stored
 */
export function resolveStoredOpenaiApiKey(stored) {
  if (!stored) {
    return "";
  }
  if (stored === OPENAI_API_KEY_ENV_REF) {
    return process.env.OPENAI_API_KEY?.trim() ?? "";
  }
  return stored.trim();
}

/**
 * @param {HarnessConfigMap} harnesses
 * @returns {string[]}
 */
export function listRegisteredHarnesses(harnesses) {
  return Object.keys(harnesses);
}

/**
 * @param {HarnessConfigMap} harnesses
 * @returns {string[]}
 */
export function listEnabledHarnesses(harnesses) {
  return Object.entries(harnesses)
    .filter(([, entry]) => entry.enabled === true)
    .map(([id]) => id);
}

/**
 * @param {unknown} entry
 * @returns {HarnessConfigEntry}
 */
function normalizeHarnessEntry(entry) {
  if (entry && typeof entry === "object" && "enabled" in entry) {
    const provider = entry.provider === "azure" || entry.provider === "fireworks"
      ? entry.provider
      : undefined;
    const profiles = entry.profiles && typeof entry.profiles === "object"
      && !Array.isArray(entry.profiles)
      ? entry.profiles
      : undefined;
    // The account residency the harness's endpoint was last written for;
    // absent means the global endpoint.
    const residency = supportedResidency(entry.residency) || undefined;
    return {
      enabled: entry.enabled === true,
      ...(provider ? { provider } : {}),
      ...(profiles ? { profiles } : {}),
      ...(residency ? { residency } : {}),
    };
  }
  return { enabled: false };
}

/**
 * @param {unknown} raw
 * @returns {HarnessConfigMap}
 */
function normalizeHarnessMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  /** @type {HarnessConfigMap} */
  const map = {};
  for (const [harnessId, entry] of Object.entries(raw)) {
    // `copilot` was one harness that configured both Copilot products; it is
    // now two (copilot-app / copilot-cli). Re-home its entry on the app rather
    // than dropping it, so an existing user doesn't look "off" with no
    // explanation. The split CLI write stays as it was.
    const id = harnessId === "copilot" ? HARNESS.COPILOT_APP : harnessId;
    // Drop retired/unknown harness ids (e.g. the legacy `deepagents` entry
    // from the plugin era) so the config map stays in sync with the current
    // roster. Known ids are preserved verbatim through normalizeHarnessEntry.
    if (!HARNESSES.includes(id)) continue;
    map[id] = normalizeHarnessEntry(entry);
  }
  return map;
}

/**
 * @param {unknown} raw
 * @returns {{ baseUrl: string, apiKey: string }}
 */
function normalizeAzureSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { baseUrl: "", apiKey: "" };
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  return {
    baseUrl: typeof record.baseUrl === "string" ? normalizeAzureBaseUrl(record.baseUrl) : "",
    apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
  };
}

/**
 * @param {unknown} raw
 * @returns {"azure" | "fireworks"}
 */
function normalizeProvider(raw) {
  return raw === "azure" ? "azure" : "fireworks";
}

/** @typedef {"nexus" | "platform" | "unknown"} AccountType */

/** @returns {AccountType} */
function normalizeAccountType(value) {
  return value === "nexus" || value === "platform" ? value : "unknown";
}

/**
 * Configs written before `accountType` existed only mark Nexus accounts.
 * @returns {AccountType}
 */
function readAccountType(existing) {
  const explicit = normalizeAccountType(existing.accountType);
  if (explicit !== "unknown") return explicit;
  return existing.nexusAccount === true ? "nexus" : "unknown";
}

/**
 * @param {string} home
 */
export async function readGlobalConfig(home) {
  const existing = await readJsonIfExists(globalConfigPath(home));
  const accountType = readAccountType(existing);
  return {
    apiKey: typeof existing.apiKey === "string" ? existing.apiKey : "",
    anthropicApiKey: typeof existing.anthropicApiKey === "string" ? existing.anthropicApiKey : "",
    openaiApiKey: typeof existing.openaiApiKey === "string" ? existing.openaiApiKey : "",
    // Remembered enterprise SSO account (not a secret — just the org slug),
    // so `login` can reuse it instead of re-asking every time.
    ssoAccountId: typeof existing.ssoAccountId === "string" ? existing.ssoAccountId : "",
    // Which kind of account the stored key belongs to (not a secret):
    // "nexus", "platform", or "unknown". Picks which site the CLI's key
    // links open. `nexusAccount` is the older boolean form, still written.
    accountType,
    nexusAccount: accountType === "nexus",
    provider: normalizeProvider(existing.provider),
    azure: normalizeAzureSettings(existing.azure),
    auto: normalizeAutoSettings(existing.auto),
    harnesses: normalizeHarnessMap(existing.harnesses),
    _exists: Object.keys(existing).length > 0,
  };
}

/**
 * @param {string} home
 */
export async function readProviderSettings(home) {
  const config = await readGlobalConfig(home);
  return {
    provider: config.provider,
    azure: {
      baseUrl: config.azure.baseUrl,
      apiKey: config.azure.apiKey === AZURE_API_KEY_ENV_REF
        ? (process.env[AZURE_API_KEY_ENV] ? AZURE_API_KEY_ENV_REF : "")
        : config.azure.apiKey,
    },
  };
}

/**
 * Synchronous provider read for sites that can't await (the parser is sync).
 * Mirrors the `provider` field of readProviderSettings.
 * @param {string} home
 * @returns {"azure" | "fireworks"}
 */
export function readConfiguredProviderSync(home) {
  try {
    const raw = JSON.parse(readFileSync(globalConfigPath(home), "utf8"));
    return normalizeProvider(raw?.provider);
  } catch {
    return "fireworks";
  }
}

/**
 * @param {string} home
 * @param {{
 *   apiKey?: string,
 *   anthropicApiKey?: string,
 *   openaiApiKey?: string,
 *   ssoAccountId?: string,
 *   accountType?: AccountType,
 *   nexusAccount?: boolean,
 *   provider?: "azure" | "fireworks",
 *   azure?: { baseUrl?: string, apiKey?: string },
 *   auto?: { providers?: string[] | null },
 *   harnesses?: HarnessConfigMap,
 * }} config
 */
export async function writeGlobalConfig(home, config) {
  const filePath = globalConfigPath(home);
  const existing = await readJsonIfExists(filePath);
  const existingAzure = normalizeAzureSettings(existing.azure);
  const apiKey = config.apiKey !== undefined ? config.apiKey : (existing.apiKey ?? "");
  const anthropicApiKey = config.anthropicApiKey !== undefined
    ? config.anthropicApiKey
    : (existing.anthropicApiKey ?? "");
  const openaiApiKey = config.openaiApiKey !== undefined
    ? config.openaiApiKey
    : (existing.openaiApiKey ?? "");
  const ssoAccountId = config.ssoAccountId !== undefined
    ? config.ssoAccountId
    : (typeof existing.ssoAccountId === "string" ? existing.ssoAccountId : "");
  const accountType = config.accountType !== undefined
    ? normalizeAccountType(config.accountType)
    : config.nexusAccount !== undefined
      ? (config.nexusAccount === true ? "nexus" : "unknown")
      : readAccountType(existing);
  const provider = config.provider !== undefined
    ? normalizeProvider(config.provider)
    : normalizeProvider(existing.provider);
  const azure = config.azure !== undefined
    ? {
      baseUrl: config.azure.baseUrl !== undefined
        ? normalizeAzureBaseUrl(config.azure.baseUrl)
        : existingAzure.baseUrl,
      apiKey: config.azure.apiKey !== undefined ? config.azure.apiKey : existingAzure.apiKey,
    }
    : existingAzure;
  const harnesses = config.harnesses !== undefined
    ? config.harnesses
    : normalizeHarnessMap(existing.harnesses);
  const auto = config.auto !== undefined
    ? normalizeAutoSettings(config.auto)
    : normalizeAutoSettings(existing.auto);
  const payload = {
    apiKey,
    anthropicApiKey,
    openaiApiKey,
    ssoAccountId,
    nexusAccount: accountType === "nexus",
    ...(accountType === "unknown" ? {} : { accountType }),
    provider,
    azure,
    auto,
    harnesses,
  };
  const hasLiteralKey = (payload.apiKey && payload.apiKey !== FIREWORKS_API_KEY_ENV_REF && payload.apiKey !== FIREWORKS_API_KEY_KEYCHAIN_REF)
    || (payload.anthropicApiKey && payload.anthropicApiKey !== ANTHROPIC_API_KEY_ENV_REF)
    || (payload.openaiApiKey && payload.openaiApiKey !== OPENAI_API_KEY_ENV_REF)
    || (payload.azure.apiKey && !isAzureApiKeyEnvRef(payload.azure.apiKey));
  ensurePrivateParent(filePath);
  await writeJson(filePath, payload, { mode: hasLiteralKey ? 0o600 : undefined });
  return payload;
}

/**
 * @param {string} home
 * @param {string} harnessId
 * @param {boolean} enabled
 * @param {"fireworks"|"azure"|""} [provider]
 */
export async function setHarnessEnabled(home, harnessId, enabled, provider = "", { residency } = {}) {
  const patch = {
    enabled,
    ...(provider === "fireworks" || provider === "azure" ? { provider } : {}),
    // Only `on` passes it; "" clears a residency the harness was written for.
    ...(residency !== undefined ? { residency } : {}),
  };
  await setHarnessState(home, harnessId, patch);
}

/**
 * @param {string} home
 * @param {string} harnessId
 * @param {Partial<HarnessConfigEntry>} patch
 */
export async function setHarnessState(home, harnessId, patch) {
  const config = await readGlobalConfig(home);
  const existing = config.harnesses[harnessId] ?? { enabled: false };
  const harnesses = {
    ...config.harnesses,
    [harnessId]: normalizeHarnessEntry({
      ...existing,
      ...patch,
    }),
  };
  await writeGlobalConfig(home, { harnesses });
}

/**
 * @param {string} home
 * @param {string} harnessId
 */
export async function isHarnessEnabled(home, harnessId) {
  const config = await readGlobalConfig(home);
  return config.harnesses[harnessId]?.enabled === true;
}

/**
 * @param {string} home
 */
export async function discoverHarnessesForUninstall(home) {
  const config = await readGlobalConfig(home);
  return listRegisteredHarnesses(config.harnesses);
}
