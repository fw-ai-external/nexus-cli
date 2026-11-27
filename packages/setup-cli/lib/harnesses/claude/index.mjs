import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  printClaudeRestartHint,
  printClaudeModelActivationHint,
  printClaudeModelManagementHints,
  printHarnessOnSuccess,
  printHarnessRestored,
  printNote,
} from "../../cli/messages.mjs";
import {
  printModelAccessNote,
  printStructuredHarnessStatus,
} from "../../harness/status-display.mjs";
import {
  claudeFireconnectIntent,
  disableFireworksProvider,
  enableFireworksProvider,
  mappingFromSettings,
  hasLegacyAnthropicMainEnv,
  providerBackupPath,
  providerStatePath,
  providerStatusFromEnv,
  stripFireconnectManagedClaudeSettings,
  isNexusApiKeyHelper,
  stripManagedApiKeyHelper,
} from "./core.mjs";
import {
  FIREWORKS_BASE_URL,
} from "../../fireworks/model-id.mjs";
import { assertRequestedModelsServable } from "../../fireworks/model-servability.mjs";
import {
  MODEL_ACCESS_POLICY_HINT,
  blockedConfiguredModels,
  isModelInCatalog,
  offerModelAccessSwitch,
  pickReplacementModel,
} from "../../fireworks/model-access.mjs";
import {
  isAnthropicModelId,
  isClaudeModelAlias,
  isClaudeNativeModel,
  normalizeModelId,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import {
  isFireworksKey,
} from "../../keys/key-type.mjs";
import { withoutDesktopGuardHook } from "./desktop-guard.mjs";
import {
  originalSettingsDeniedServerTools,
  reconcileGatewayServerToolDenials,
  withoutGatewayServerToolsDenied,
} from "./server-tools-deny.mjs";
import {
  formatClaudeUsageReport,
  formatClaudeUsageReports,
  readClaudeUsage,
  readClaudeUsages,
} from "./usage/report.mjs";
import {
  canRunClaudeUsageInteractiveDisplay,
  hasClaudeUsageRows,
  playUsageIntroAnimation,
  runClaudeUsageInteractiveDisplay,
} from "./usage/display.mjs";
import { runClaudeUsageLive, shouldRunClaudeUsageLive } from "./usage/live.mjs";
import { promptClaudeUsageSession } from "./usage/session-picker.mjs";
import { accent } from "../../ui/style.mjs";
import { warn } from "../../ui/write.mjs";
import {
  attachPricing,
  CLAUDE_CODE_PRICING_DISCLAIMER,
} from "../../fireworks/pricing.mjs";
import {
  loadRegisterableModels,
  warmServerlessPricingCache,
} from "../../fireworks/models.mjs";
import {
  formatNonVisionModelsWarning,
  uniqueNonVisionModelShortIds,
} from "../../fireworks/vision.mjs";
import { defineHarnessProfile, harnessModelAccess, servedCatalogForOn } from "../../harness/engine.mjs";
import {
  claudePathsFor,
  ensureHomeForHarness,
  harnessPathOverrides,
  withoutPathOverrides,
} from "../../harness/context.mjs";
import {
  isHarnessEnabled,
  hasHarnessCustomPath,
  readGlobalConfig,
  recordHarnessCustomPath,
  setHarnessEnabled,
  setHarnessState,
} from "../../config/global-config.mjs";
import { formatAutoProviders } from "../../config/auto-providers.mjs";
import { HARNESS } from "../../harness/id.mjs";
import {
  fireworksKeyFromCustomHeaders,
  OPENAI_BYOK_HEADER,
} from "../../firerouter/core.mjs";
import { resolveAutoProviderKeyHeaders } from "../../firerouter/flag.mjs";
import {
  assertResolvedKeyNotRejected,
  harnessStatusKeySource,
  persistApiKeyFromFlag,
  resolveFireworksApiKeyValue,
} from "../../keys/api-key.mjs";
import { harnessFullKey, missingHarnessKeyError } from "../../keys/harness-api-key.mjs";
import { LIVE_KEY } from "../../keys/key-current.mjs";
import { detectSecretBackend } from "../../keys/secret-store.mjs";
import { assertBackendCanStore } from "../../keys/storage-report.mjs";
import { disableWebsearchMcp } from "../../system/websearch-mcp.mjs";
import { claudeJsonPath } from "../../system/websearch-state.mjs";
import {
  printClaudePickerSummary,
} from "./onboarding.mjs";
import {
  readClaudeActivationSnapshot,
  resolveClaudeActivationPlan,
} from "./activation.mjs";
import {
  CLAUDE_TIER_SLOTS,
  claudeBareFirerouterRequested,
  claudeExtraPickerModelFromCtx,
  claudeSlotOverridesFromCtx,
} from "./connect.mjs";
import {
  assertClaudeModelOverrides,
  claudeActiveMappingIsCurrent,
  defaultClaudeModelMapping,
  mappingUsesBareFirerouter,
  withSavedClaudeModelMapping,
} from "./model-profile.mjs";
import {
  isFireconnectModelPicker,
  validateClaudeModelPicker,
} from "./settings-model-picker.mjs";
import {
  claudeCodeModelPickerNote,
  claudeCodeShowsModelPicker,
  installedClaudeCodeVersion,
} from "./claude-code-version.mjs";
import { claudeModsEnabled } from "./mods.mjs";
import { clearUltrafastBadge } from "./ultrafast-badge.mjs";
import {
  CREDIT_STANDING_LOCK_TTL_MS,
  clearCreditStandingCache,
  creditKeyFingerprint,
  creditStandingJsonPayload,
  hasActiveCreditStandingRefreshLock,
  isCreditStandingCacheFresh,
  loadCreditStanding,
  readActiveCreditIndicator,
  readCreditStandingCache,
} from "../../fireworks/credit-standing.mjs";
import { activeAccountResidency, fireworksInferenceUrl, resolveHarnessResidency } from "../../fireworks/residency.mjs";

const CLAUDE_FIREROUTER = Object.freeze({
  byok: "none",
  autoCatalog: true,
  // Claude Code's own sign-in pays for Claude turns; Nexus only carries
  // an OpenAI key, in ANTHROPIC_CUSTOM_HEADERS.
  customHeaderOpenaiKey: true,
});

export const CLAUDE_ANTHROPIC_KEY_REMOVED_NOTE =
  "Nexus CLI no longer writes an Anthropic key into Claude Code's settings, so it removed the "
  + "one an earlier `nexus claude` saved. Claude Code's own sign-in pays for Claude turns: "
  + "run `claude login`, or export ANTHROPIC_API_KEY to pay with a key.";

export const CLAUDE_LEGACY_ANTHROPIC_MODEL_WARNING =
  "Legacy env.ANTHROPIC_MODEL is still set and overrides Claude Code's /model picker. "
  + "Run `nexus claude` to migrate.";

export function resolveClaudeAuthState(settings, state = {}) {
  const env = settings.env ?? {};
  const customHeaderToken = fireworksKeyFromCustomHeaders(
    env.ANTHROPIC_CUSTOM_HEADERS,
  );
  if (isFireworksKey(customHeaderToken)) {
    return {
      authMode: "customHeader",
      keyConfigured: true,
      token: customHeaderToken.trim(),
    };
  }

  const usesHelper = Boolean(settings.apiKeyHelper)
    || state.authMode === "apiKeyHelper";
  if (usesHelper) {
    return { authMode: "apiKeyHelper", keyConfigured: true, token: "" };
  }

  const token = [
    env.ANTHROPIC_API_KEY,
    env.ANTHROPIC_AUTH_TOKEN,
    state.fireworksApiKey,
  ].find(isFireworksKey)?.trim() ?? "";
  return {
    authMode: token ? "env" : "missing",
    keyConfigured: Boolean(token),
    token,
  };
}

/**
 * Fireworks key from active Claude Code settings when Fireconnect is on.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
/**
 * `ctx`'s `--settings-path` override, or none when it names the default
 * settings file anyway (so a plain `off` doesn't leave a record behind).
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
function claudeCustomPathOverrides(ctx) {
  const overrides = harnessPathOverrides(ctx, HARNESS.CLAUDE);
  const same = path.resolve(claudePathsFor(ctx).settingsPath)
    === path.resolve(claudePathsFor(withoutPathOverrides(ctx, HARNESS.CLAUDE)).settingsPath);
  return same ? {} : overrides;
}

/**
 * Whether the settings `ctx` points at are still routed through Fireworks by
 * Nexus. Unreadable, or not a regular file (a named pipe isn't read), counts
 * as routed, so the harness stays enabled: the safe side for key sync.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function claudeSettingsRouted(ctx) {
  try {
    const { settingsPath, dataDir } = claudePathsFor(ctx);
    for (const file of [settingsPath, providerBackupPath(dataDir), providerStatePath(dataDir)]) {
      const info = await stat(file).catch(() => null);
      if (info && !info.isFile()) return true;
    }
    const [settings, backup, state] = await Promise.all([
      readJsonIfExists(settingsPath),
      readJsonIfExists(providerBackupPath(dataDir)),
      readJsonIfExists(providerStatePath(dataDir)),
    ]);
    return Boolean(claudeFireconnectIntent(settings, { backup, state }));
  } catch {
    return true;
  }
}

async function claudeResolveUsageAuth(ctx) {
  const { settingsPath, dataDir } = claudePathsFor(ctx);
  const [settings, state] = await Promise.all([
    readJsonIfExists(settingsPath),
    readJsonIfExists(providerStatePath(dataDir)),
  ]);
  const auth = resolveClaudeAuthState(settings, state);
  return {
    token: auth.token,
    usesNexusHelper: auth.authMode === "apiKeyHelper" && isNexusApiKeyHelper(settings.apiKeyHelper, state),
  };
}

async function lstatToken(filePath) {
  if (!filePath) return "missing";
  try {
    const info = await lstat(filePath);
    if (!info.isFile()) return "nonfile";
    return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch {
    return "missing";
  }
}

async function readSmallRegularText(filePath, maxBytes = 64 * 1024) {
  if (!filePath) return "missing";
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.size > maxBytes) return "nonfile";
    return await readFile(filePath, "utf8");
  } catch {
    return "missing";
  }
}

function encryptedSecretsPathForHome(home, env = process.env) {
  if (!home) return "";
  if (process.platform === "win32") {
    const root = env?.LOCALAPPDATA || env?.ProgramData || home;
    return path.join(root, "Keyring", "secrets.json");
  }
  const envHome = env?.HOME?.trim() ?? "";
  const sameHome = Boolean(envHome) && path.resolve(home) === path.resolve(envHome);
  const dataHome = sameHome && env?.XDG_DATA_HOME ? env.XDG_DATA_HOME : path.join(home, ".local", "share");
  return path.join(dataHome, "keyring", "secrets.json");
}

/**
 * Lightweight filesystem-only snapshot of stored-key state (zero OS keychain
 * access, zero secret decryption) so the live meter detects out-of-process
 * `nexus login` / `nexus logout` without re-reading the OS keychain every 2s.
 */
async function readStoredCredentialSignature(home, env = process.env) {
  if (!home) return { hasKeyRef: false, version: "" };
  const [config, keyStorageRaw, legacyStorageRaw, mintedRaw, secretsStat, plaintextStat, memoryStat] = await Promise.all([
    readGlobalConfig(home).catch(() => ({ apiKey: "" })),
    readSmallRegularText(path.join(home, ".nexus", "key-storage.json")),
    readSmallRegularText(path.join(home, ".nexus", "secret-backend.json")),
    readSmallRegularText(path.join(home, ".nexus", "minted-key.json")),
    lstatToken(encryptedSecretsPathForHome(home, env)),
    lstatToken(path.join(home, ".nexus", ".api-key")),
    lstatToken(path.join(home, ".nexus", ".secret-memory")),
  ]);
  const keyRef = typeof config?.apiKey === "string" ? config.apiKey.trim() : "";
  const keyRefToken = keyRef ? creditKeyFingerprint(keyRef) : "";
  return {
    hasKeyRef: Boolean(keyRef),
    version: [keyRefToken, keyStorageRaw, legacyStorageRaw, mintedRaw, secretsStat, plaintextStat, memoryStat].join("\0"),
  };
}

/**
 * Create the live-meter credit-standing poller for `nexus claude usage`.
 *
 * Re-checks Claude settings and lightweight on-disk credential metadata on
 * every poll (without passing `fresh: true` on steady-state 2s ticks) so:
 * - OS keychains are read at most once per command instead of prompting every 2s;
 * - `nexus logout` or `nexus claude off` stops polling immediately (with zero
 *   keychain reads) and never recreates a signed-out account's credit cache;
 * - out-of-process `nexus login` rotation is detected via on-disk credential
 *   metadata (`config.json`, `key-storage.json`, `minted-key.json`, file store)
 *   and triggers a single fresh read;
 * - custom third-party helpers and unconfigured sessions never inherit another
 *   account's browser-minted credits;
 * - failed refreshes respect the 60-second cooldown lock (both on-disk and
 *   in-memory) instead of retrying on every two-second meter poll.
 *
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   nowFn?: () => number,
 *   resolveAuth?: typeof claudeResolveUsageAuth,
 *   resolveStoredKey?: typeof resolveFireworksApiKeyValue,
 *   loadStanding?: typeof loadCreditStanding,
 *   allowNetworkInTest?: boolean,
 *   initialCredentialSig?: string,
 *   trackCredentialChanges?: boolean,
 * }} [options]
 */
export function createClaudeLiveCreditReader(ctx, {
  env = process.env,
  nowFn = () => Date.now(),
  resolveAuth = claudeResolveUsageAuth,
  resolveStoredKey = resolveFireworksApiKeyValue,
  loadStanding = loadCreditStanding,
  allowNetworkInTest = false,
  initialCredentialSig = "",
  trackCredentialChanges = resolveStoredKey === resolveFireworksApiKeyValue,
} = {}) {
  let refreshing = false;
  let lastFailedAt = 0;
  let lastFailedFp = "";
  let hasLoadedStoredKey = false;
  let cachedStoredKey = "";
  let cachedCredSig = initialCredentialSig;
  return async () => {
    if (env?.NEXUS_CREDIT_STATUS === "0") return null;
    let activeKey = "";
    try {
      const { token, usesNexusHelper } = await resolveAuth(ctx);
      if (token) {
        activeKey = token;
      } else if (usesNexusHelper) {
        if (trackCredentialChanges) {
          const sig = await readStoredCredentialSignature(ctx.home, env);
          if (!sig.hasKeyRef) {
            hasLoadedStoredKey = true;
            cachedStoredKey = "";
            cachedCredSig = sig.version;
            activeKey = "";
          } else if (!hasLoadedStoredKey) {
            const changedSinceStartup = Boolean(cachedCredSig) && sig.version !== cachedCredSig;
            cachedStoredKey = await resolveStoredKey({ home: ctx.home, fresh: changedSinceStartup }).catch(() => "");
            // Re-snapshot after resolution so a one-time legacy literal migration
            // doesn't look like an external rotation on the next 2s tick.
            cachedCredSig = (await readStoredCredentialSignature(ctx.home, env)).version;
            hasLoadedStoredKey = true;
            activeKey = cachedStoredKey;
          } else if (sig.version !== cachedCredSig) {
            cachedStoredKey = await resolveStoredKey({ home: ctx.home, fresh: true }).catch(() => "");
            cachedCredSig = (await readStoredCredentialSignature(ctx.home, env)).version;
            activeKey = cachedStoredKey;
          } else {
            activeKey = cachedStoredKey;
          }
        } else {
          activeKey = await resolveStoredKey({ home: ctx.home }).catch(() => "");
        }
      }
    } catch {
      activeKey = "";
    }
    const expectedFingerprint = creditKeyFingerprint(activeKey);
    if (!expectedFingerprint) {
      lastFailedAt = 0;
      lastFailedFp = "";
      return null;
    }
    const now = nowFn();
    const cached = readCreditStandingCache(ctx.home, { keyFingerprint: expectedFingerprint });
    const inMemoryCooldown = lastFailedFp === expectedFingerprint
      && lastFailedAt > 0
      && now - lastFailedAt < CREDIT_STANDING_LOCK_TTL_MS;
    if (
      !refreshing
      && !inMemoryCooldown
      && (allowNetworkInTest || env?.NEXUS_TEST !== "1")
      && !isCreditStandingCacheFresh(cached, { expectedFingerprint, now })
      && !hasActiveCreditStandingRefreshLock(ctx.home, { keyFingerprint: expectedFingerprint, now })
    ) {
      refreshing = true;
      const attemptKey = activeKey;
      const attemptFp = expectedFingerprint;
      loadStanding({
        home: ctx.home,
        apiKey: attemptKey,
        now,
        env,
        allowNetworkInTest,
        respectCooldown: true,
      })
        .then(() => {
          const updated = readCreditStandingCache(ctx.home, { keyFingerprint: attemptFp });
          if (isCreditStandingCacheFresh(updated, { expectedFingerprint: attemptFp, now })) {
            lastFailedAt = 0;
            lastFailedFp = "";
          } else {
            lastFailedAt = now;
            lastFailedFp = attemptFp;
          }
        })
        .catch(() => {
          lastFailedAt = now;
          lastFailedFp = attemptFp;
        })
        .finally(() => { refreshing = false; });
    }
    return readActiveCreditIndicator(ctx.home, { expectedFingerprint, now, env });
  };
}

async function claudeResolveKey(ctx) {
  return (await claudeResolveUsageAuth(ctx)).token;
}

/**
 * Resolve before any Claude settings mutation. Claude `on` intentionally stops
 * with explicit login/custom-SSO guidance instead of starting sign-in itself.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function claudeApiKeyForOn(ctx, snapshot) {
  const token = await harnessFullKey(
    ctx,
    async () => resolveClaudeAuthState(snapshot.settings, snapshot.state).token,
  );
  if (!token) {
    throw missingHarnessKeyError();
  }
  // `--api-key` was already verified by runHarnessCommand.
  if (!ctx.apiKeyFromFlag) {
    await assertResolvedKeyNotRejected(token, { harnessId: HARNESS.CLAUDE });
  }
  return token;
}

function isNativeClaudeCredential(value) {
  const key = typeof value === "string" ? value.trim() : "";
  // Older releases also wrote Fire Pass (fpk_) keys; never keep one as Anthropic auth.
  return Boolean(key) && key !== "fireconnect" && !isFireworksKey(key) && !key.startsWith("fpk_");
}

function settingsFromSnapshot(backup) {
  if (backup.snapshot === undefined) {
    return null;
  }
  if (!backup.snapshot?.existed) {
    return {};
  }
  return JSON.parse(backup.snapshot.raw);
}

/**
 * Return the auth-bearing settings Claude had before Nexus. A current
 * v0.9 mapping uses its raw snapshot; a v0.8 values backup exposes the restored
 * auth fields directly. Backup-less v0.8 installs retain only credentials that
 * cannot be Nexus's own key/sentinel.
 */
export function claudeNativeAuthBaseline(settings, backup = {}, state = {}, intent = null) {
  const snapshot = settingsFromSnapshot(backup);
  if (snapshot !== null) {
    return snapshot;
  }
  if (backup.values !== undefined) {
    const baseline = { env: { ...(backup.values ?? {}) } };
    if (Object.hasOwn(backup.topLevel?.values ?? {}, "apiKeyHelper")) {
      baseline.apiKeyHelper = backup.topLevel.values.apiKeyHelper;
    }
    return baseline;
  }
  if (!intent) {
    return settings;
  }

  const baseline = stripFireconnectManagedClaudeSettings(settings, state);
  const currentEnv = settings.env ?? {};
  const env = { ...(baseline.env ?? {}) };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    if (isNativeClaudeCredential(currentEnv[key])) {
      env[key] = currentEnv[key];
    }
  }
  return { ...baseline, env };
}

/**
 * The Anthropic credentials Claude Code had before Nexus. Nexus
 * never adds one: Claude Code's own sign-in pays for Claude turns.
 */
function resolveClaudeNativeAuth({ baseline, state }) {
  const baselineEnv = baseline.env ?? {};
  const anthropicApiKey = isNativeClaudeCredential(baselineEnv.ANTHROPIC_API_KEY)
    ? baselineEnv.ANTHROPIC_API_KEY.trim()
    : "";
  const anthropicAuthToken = isNativeClaudeCredential(baselineEnv.ANTHROPIC_AUTH_TOKEN)
    ? baselineEnv.ANTHROPIC_AUTH_TOKEN.trim()
    : "";
  const helperResult = stripManagedApiKeyHelper(baseline, state).settings;
  const nativeApiKeyHelper = Object.hasOwn(helperResult, "apiKeyHelper")
    ? helperResult.apiKeyHelper
    : null;
  return { anthropicApiKey, anthropicAuthToken, nativeApiKeyHelper };
}

/**
 * Pre-approve a stray ANTHROPIC_API_KEY in ~/.claude.json so Claude Code doesn't
 * show its one-time "Detected a custom API key in your environment" prompt.
 * Nexus authenticates via the X-Fireworks-Api-Key header (that key still
 * wins), but a user who exports ANTHROPIC_API_KEY would otherwise get prompted on
 * first launch. Claude Code identifies an approved key by `key.trim().slice(-20)`
 * stored in customApiKeyResponses.approved. No-op when no key is in the env.
 * @param {string} home
 * @returns {Promise<boolean>}
 */
export async function approveStrayAnthropicApiKey(home) {
  const key = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (!home || !key) {
    return false;
  }
  const identifier = key.slice(-20);
  const filePath = claudeJsonPath(home);
  const current = await readJsonIfExists(filePath);
  const responses = (current.customApiKeyResponses && typeof current.customApiKeyResponses === "object")
    ? current.customApiKeyResponses
    : {};
  const approved = Array.isArray(responses.approved) ? responses.approved : [];
  if (approved.includes(identifier)) {
    return false;
  }
  await writeJson(filePath, {
    ...current,
    customApiKeyResponses: {
      ...responses,
      approved: [...approved, identifier],
      rejected: Array.isArray(responses.rejected) ? responses.rejected : [],
    },
  });
  return true;
}

/** Strip a legacy SessionStart desktop-guard hook left by older FireConnect installs. */
async function removeDesktopGuardHook(settingsPath) {
  const settings = await readJsonIfExists(settingsPath);
  const next = withoutDesktopGuardHook(settings);
  if (next !== settings) {
    await writeJson(settingsPath, next);
  }
}

// Remove legacy FireConnect-added server-tool denials while preserving rules
// that were present in the user's original settings.
async function reconcileServerToolDenials(settingsPath, preserveDeniedTools) {
  const settings = await readJsonIfExists(settingsPath);
  const next = reconcileGatewayServerToolDenials(settings, { preserveDeniedTools });
  if (next !== settings) {
    await writeJson(settingsPath, next);
  }
}

function legacyBackupIncludesPermissions(backup) {
  return Object.hasOwn(backup.topLevel?.values ?? {}, "permissions")
    || (backup.topLevel?.missing ?? []).includes("permissions");
}

async function prepareClaudeV09Baseline({ settingsPath, dataDir, intent }) {
  if (!intent?.needsUpgrade) {
    return;
  }

  const backupPath = providerBackupPath(dataDir);
  const backup = await readJsonIfExists(backupPath);
  const state = await readJsonIfExists(providerStatePath(dataDir));
  const hasLegacyBackup = backup.values !== undefined;
  if (hasLegacyBackup) {
    await disableFireworksProvider({ settingsPath, dataDir, wasEnabled: true });
  } else {
    const settings = await readJsonIfExists(settingsPath);
    await writeJson(
      settingsPath,
      stripFireconnectManagedClaudeSettings(settings, state),
      { mode: 0o600 },
    );
  }

  let baseline = await readJsonIfExists(settingsPath);
  baseline = withoutDesktopGuardHook(baseline);
  if (!hasLegacyBackup || !legacyBackupIncludesPermissions(backup)) {
    baseline = withoutGatewayServerToolsDenied(baseline);
  }
  await writeJson(settingsPath, baseline, { mode: 0o600 });
}

/**
 * The Fireworks models Claude Code's settings select while routed: the
 * /model default (`main`), each pinned tier slot, and the /model picker rows
 * Nexus registered (`picker`). Native slots and Anthropic ids are not
 * Fireworks selections and are left out.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function claudeConfiguredModels(ctx) {
  const { settingsPath } = claudePathsFor(ctx);
  const settings = await readJsonIfExists(settingsPath);
  const env = settings.env ?? {};
  if (providerStatusFromEnv(env) !== "fireworks") {
    return [];
  }
  const mapping = mappingFromSettings(settings);
  const slots = ["main", ...CLAUDE_TIER_SLOTS]
    .filter((slot) => typeof mapping[slot] === "string" && !isClaudeNativeModel(mapping[slot]))
    .map((slot) => ({ slot, model: mapping[slot] }));
  return [...slots, ...claudeRegisteredPickerModels(settings).map((model) => ({ slot: "picker", model }))];
}

/**
 * The /model picker rows Nexus registered: Fireworks rows only, never Claude's own.
 * @param {Record<string, any>} settings
 */
function claudeRegisteredPickerModels(settings) {
  // Claude Code strips the managed marker when it persists a /model pick,
  // so a Fireworks-routed picker is Nexus territory with or without it.
  const pickerIsNexusTerritory = isFireconnectModelPicker(settings.modelPicker)
    || providerStatusFromEnv(settings.env ?? {}) === "fireworks";
  if (!pickerIsNexusTerritory) {
    return [];
  }
  return (settings.modelPicker?.options ?? [])
    .map((option) => option?.model)
    .filter((id) => typeof id === "string" && id.trim())
    .filter((id) => {
      const normalized = shortFireworksModelRef(normalizeModelId(id));
      return !isAnthropicModelId(normalized) && !isClaudeModelAlias(normalized);
    });
}

/**
 * On a re-`on`, tier slots pinned (by an earlier `on` or the saved profile)
 * to a model the account's served catalog no longer lists: say so and, at a
 * terminal, ask whether to switch them to an allowed model. Slots set by
 * this run's flags were already checked. Returns the mapping to write, with
 * the switched slots replaced only on a yes. Never throws.
 * @param {{ ctx: object, mapping: Record<string, string>, slotOverrides: Record<string, string>, catalog: Array<object>, entries: Array<object> }} args
 */
async function offerAllowedClaudeSlots({ ctx, mapping, slotOverrides, catalog, entries }) {
  const configured = CLAUDE_TIER_SLOTS
    .filter((slot) => !slotOverrides[slot] && mapping[slot] && !isClaudeNativeModel(mapping[slot]))
    .map((slot) => ({ slot, model: mapping[slot] }));
  const blocked = blockedConfiguredModels(configured, catalog);
  if (!blocked.length) {
    return mapping;
  }
  // The rows the API returned, not `catalog` (which always gains `auto`).
  const replacement = pickReplacementModel(entries, {
    exclude: blocked.map(({ model }) => model),
  });
  const flags = blocked.map(({ slot }) => `--${slot} ${replacement}`).join(" ");
  const agreed = await offerModelAccessSwitch({
    ctx,
    harnessCommand: HARNESS.CLAUDE,
    blocked,
    replacement,
    switchCommand: `nexus claude on ${flags}`,
  });
  if (!agreed) {
    return mapping;
  }
  const next = { ...mapping };
  for (const { slot } of blocked) {
    next[slot] = replacement;
  }
  return next;
}

/**
 * `on` keeps a saved /model default only when the picker serves it, so a
 * default the account can no longer use moves to the one `on` writes. Say so
 * when that happened because the served catalog doesn't list it.
 * @param {Record<string, any>} before settings before `on`
 * @param {Record<string, any> | undefined} after settings `on` wrote
 * @param {Array<object>} catalog
 * @returns {string}
 */
function blockedDefaultReplacedNote(before, after, catalog) {
  const previous = typeof before?.model === "string" ? before.model.trim() : "";
  const next = typeof after?.model === "string" ? after.model : "";
  if (!previous || !next || shortFireworksModelRef(previous) === shortFireworksModelRef(next)) {
    return "";
  }
  const [blocked] = blockedConfiguredModels([{ slot: "main", model: previous }], catalog);
  if (!blocked) {
    return "";
  }
  return `Your /model default ${blocked.model} isn't available to this account. ${MODEL_ACCESS_POLICY_HINT} `
    + `Claude Code now starts on ${shortFireworksModelRef(next)}; pick another model with /model.`;
}

export default defineHarnessProfile({
  id: HARNESS.CLAUDE,
  label: "Claude Code",
  resolveKey: claudeResolveKey,
  configuredModels: claudeConfiguredModels,
  firerouter: CLAUDE_FIREROUTER,
  // Claude's `on` is bespoke (slot mapping and raw-snapshot backup).
  async on(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const onboardingMode = ctx.onboardingMode ?? "auto";
    if (onboardingMode === "prompt") {
      throw new Error(
        "--interactive is not supported. Use `--model <id>` to choose a Fireworks model "
          + "and add it to Claude Code's /model picker.",
      );
    }
    assertClaudeModelOverrides(ctx);
    const snapshot = await readClaudeActivationSnapshot(ctx);
    const { settingsPath, dataDir } = snapshot;
    const preserveDeniedServerTools = originalSettingsDeniedServerTools(
      snapshot.settings,
      snapshot.backup,
    );
    const fireworksKey = await claudeApiKeyForOn(ctx, snapshot);
    // Claude Code's base URL follows the account's data residency.
    const residencyState = await resolveHarnessResidency(fireworksKey, HARNESS.CLAUDE, ctx.home, {
      onNote: (line) => { if (!ctx.quiet) printNote(line); },
    });
    const activeToken = resolveClaudeAuthState(snapshot.settings, snapshot.state).token;
    validateClaudeModelPicker(snapshot.settings);
    // Normalize first so friendly aliases like `native` are seen as the native
    // sentinel (claude-default) before the servability check, not as a bare,
    // unrecognized model id.
    const extraPickerModel = claudeExtraPickerModelFromCtx(ctx);
    const slotOverrides = claudeSlotOverridesFromCtx(ctx);
    await assertRequestedModelsServable(
      [extraPickerModel, ...Object.values(slotOverrides)]
        .filter((modelId) => modelId && !isClaudeNativeModel(modelId)),
      { apiKey: fireworksKey },
    );
    const nativeBaseline = claudeNativeAuthBaseline(
      snapshot.settings,
      snapshot.backup,
      snapshot.state,
      snapshot.intent,
    );
    const nativeAuth = resolveClaudeNativeAuth({
      baseline: nativeBaseline,
      state: snapshot.state,
    });
    const currentAnthropicKey = snapshot.settings.env?.ANTHROPIC_API_KEY?.trim() ?? "";
    const removedAnthropicKey = isNativeClaudeCredential(currentAnthropicKey)
      && currentAnthropicKey !== nativeAuth.anthropicApiKey;
    // Claude Code keeps its own OAuth/subscription login and attaches Anthropic
    // auth at request time. Nexus does not probe for that login.
    const activeMappingIsCurrent = Boolean(snapshot.intent) && claudeActiveMappingIsCurrent({
      legacyFirePass: snapshot.legacyFirePass,
      tokenIsFireworks: isFireworksKey(activeToken),
      recordedKeyType: snapshot.state.keyType,
      profiles: snapshot.profiles,
      activeMapping: snapshot.intent.mapping,
    });
    const { catalog: servedCatalog, entries: servedEntries } = await servedCatalogForOn(fireworksKey);
    const plan = resolveClaudeActivationPlan({
      ctx,
      snapshot,
      activeMappingIsCurrent,
      // Without this account's catalog the migration runs as before.
      isServed: (modelId) => !servedCatalog.length || isModelInCatalog(modelId, servedCatalog),
    });
    const mapping = await offerAllowedClaudeSlots({
      ctx,
      mapping: plan.mapping,
      slotOverrides,
      catalog: servedCatalog,
      entries: servedEntries,
    });
    const { ids, served: catalogServed } = await loadRegisterableModels({ apiKey: fireworksKey });
    const registerablePickerIds = ids
      .map((id) => shortFireworksModelRef(id))
      .filter(Boolean);
    if (extraPickerModel) {
      const shortId = shortFireworksModelRef(extraPickerModel);
      if (shortId && !registerablePickerIds.includes(shortId)) {
        registerablePickerIds.unshift(shortId);
      }
    }
    const bareFirerouter = claudeBareFirerouterRequested(extraPickerModel)
      || mappingUsesBareFirerouter(mapping);
    // Preserve native Anthropic credentials already in Claude settings (subscription
    // or BYOK the user configured in Claude Code). FireRouter does not require
    // Nexus to inject x-anthropic-api-key — Claude Code attaches auth.
    const anthropicKeyForSettings = nativeAuth.anthropicApiKey;
    // Claude Code's own login covers Claude turns. An OpenAI key saved with
    // `nexus auto` rides along as x-openai-api-key for GPT turns (`/model`
    // always lists `auto`); a key already in settings is kept. Never read
    // from the environment.
    const openaiKeyForSettings = (await resolveAutoProviderKeyHeaders({
      home: ctx.home,
      settingsEnv: { ANTHROPIC_CUSTOM_HEADERS: snapshot.settings.env?.ANTHROPIC_CUSTOM_HEADERS ?? "" },
      anthropic: false,
    }))[OPENAI_BYOK_HEADER] ?? "";

    // Migrate a harness-local key (baked into settings by an older `on`) into the
    // shared store so `key export` and other harnesses can reuse it — but only
    // when env/stored are both empty, so a newer key from `login`/env is
    // never clobbered (matches resolveHarnessOnApiKey's precedence).
    const migrated = isFireworksKey(fireworksKey)
      && !(await resolveFireworksApiKeyValue({ home: ctx.home }));
    if (migrated) {
      const backend = await detectSecretBackend(ctx.home);
      await assertBackendCanStore(backend, ctx.home);
      await persistApiKeyFromFlag(ctx.home, fireworksKey, { backend });
    }
    await prepareClaudeV09Baseline({
      settingsPath,
      dataDir,
      intent: snapshot.intent,
    });
    const nexusProviders = formatAutoProviders(
      (await readGlobalConfig(ctx.home)).auto.providers,
    );
    // Probed before the write so `on` installs the Ultra-fast banner mod only
    // on Claude Code releases that load mods.
    const claudeCodeVersion = installedClaudeCodeVersion({ home: ctx.home });
    const claudeMods = claudeModsEnabled(claudeCodeVersion);
    // Recorded before the write; see engineOn.
    const overrides = claudeCustomPathOverrides(ctx);
    const recordedBefore = await hasHarnessCustomPath(ctx.home, HARNESS.CLAUDE, overrides);
    await recordHarnessCustomPath(ctx.home, HARNESS.CLAUDE, overrides, true);
    const { settings: enabledSettings } = await enableFireworksProvider({
      settingsPath,
      dataDir,
      effectiveApiKey: fireworksKey,
      baseUrl: fireworksInferenceUrl(ctx.baseUrl || FIREWORKS_BASE_URL, activeAccountResidency("claude")),
      mapping,
      anthropicKey: anthropicKeyForSettings,
      anthropicAuthToken: nativeAuth.anthropicAuthToken,
      openaiKey: openaiKeyForSettings,
      nexusProviders,
      nativeApiKeyHelper: nativeAuth.nativeApiKeyHelper,
      useApiKeySentinel: false,
      registerablePickerIds,
      selectedPickerModel: extraPickerModel ?? "",
      firerouterHeaders: bareFirerouter,
      catalogServed,
      claudeMods,
    }).catch(async (error) => {
      // Nothing routed there after all: drop the new record; see engineOn.
      if (!recordedBefore && !await claudeSettingsRouted(ctx)) {
        await recordHarnessCustomPath(ctx.home, HARNESS.CLAUDE, overrides, false).catch(() => {});
      }
      throw error;
    });
    // The key Claude Code uses may have changed: drop cached per-account
    // badges so another account's boost or credit standing never shows.
    await clearUltrafastBadge(ctx.home);
    clearCreditStandingCache(ctx.home);
    await setHarnessState(ctx.home, HARNESS.CLAUDE, {
      enabled: true,
      provider: "fireworks",
      profiles: withSavedClaudeModelMapping(snapshot.profiles, mapping),
      ...residencyState,
    });
    // Drop a legacy SessionStart desktop-guard hook if present (retired; CLI-only).
    await removeDesktopGuardHook(settingsPath);
    /** @type {Array<() => void>} */
    const footnotes = [];
    const visionWarning = formatNonVisionModelsWarning(
      uniqueNonVisionModelShortIds(
        [extraPickerModel, ...Object.values(slotOverrides)]
          .filter((modelId) => modelId && !isClaudeNativeModel(modelId)),
      ),
    );
    if (visionWarning) {
      footnotes.push(() => printNote(visionWarning));
    }
    if (removedAnthropicKey) {
      footnotes.push(() => printNote(CLAUDE_ANTHROPIC_KEY_REMOVED_NOTE));
    }
    const replacedDefault = blockedDefaultReplacedNote(snapshot.settings, enabledSettings, servedCatalog);
    if (replacedDefault) {
      footnotes.push(() => printNote(replacedDefault));
    }
    const pickerVersionNote = claudeCodeModelPickerNote(claudeCodeVersion);
    if (pickerVersionNote) {
      footnotes.push(() => printNote(pickerVersionNote));
    }
    await reconcileServerToolDenials(settingsPath, preserveDeniedServerTools);
    await approveStrayAnthropicApiKey(ctx.home);
    await disableWebsearchMcp(ctx.home);
    await printHarnessOnSuccess({
      label: "Claude Code",
      // The pinned default (the `auto` mix unless the user saved a servable
      // /model pick) leads the success line, like every other harness.
      model: typeof enabledSettings?.model === "string" ? enabledSettings.model : "",
      // Show what landed in /model, like every other harness's `on` output.
      modelsAdded: registerablePickerIds,
      footnotes,
      restartHint: printClaudeModelActivationHint,
      afterConnected: async () => {
        printClaudePickerSummary({
          extraPickerModel,
          mapping,
          catalogShown: claudeCodeShowsModelPicker(claudeCodeVersion),
        });
      },
    });
    printClaudeModelManagementHints();
  },

  async off(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath, dataDir } = claudePathsFor(ctx);
    const [wasEnabled, settings, backup, state] = await Promise.all([
      isHarnessEnabled(ctx.home, HARNESS.CLAUDE),
      readJsonIfExists(settingsPath),
      readJsonIfExists(providerBackupPath(dataDir)),
      readJsonIfExists(providerStatePath(dataDir)),
    ]);
    const intent = claudeFireconnectIntent(settings, { backup, state });
    // A v0.8 install may have managed settings but no enabled flag or raw
    // snapshot. Reuse the on-migration fallback so upgrade-triggered off still
    // restores its values backup or strips only Nexus-owned settings.
    await prepareClaudeV09Baseline({ settingsPath, dataDir, intent });
    const connected = wasEnabled || Boolean(intent);
    await disableFireworksProvider({
      settingsPath,
      dataDir,
      wasEnabled: connected,
    });
    await clearUltrafastBadge(ctx.home);
    clearCreditStandingCache(ctx.home);
    const overrides = claudeCustomPathOverrides(ctx);
    await recordHarnessCustomPath(ctx.home, HARNESS.CLAUDE, overrides, false);
    // `off` at a custom path leaves the default settings alone; see engineOff.
    await setHarnessEnabled(ctx.home, HARNESS.CLAUDE,
      Object.keys(overrides).length > 0 && await claudeSettingsRouted(withoutPathOverrides(ctx, HARNESS.CLAUDE)));
    await disableWebsearchMcp(ctx.home);
    await removeDesktopGuardHook(settingsPath);
    // `ctx.quiet` (uninstall) silences the per-harness narration so the
    // uninstall checklist is the only output; see `engineOff`, which gates the
    // same lines for every other harness. Non-quiet output is unchanged.
    if (!ctx.quiet) {
      printHarnessRestored("Claude Code");
      printClaudeRestartHint();
    }
    return connected ? "restored" : "none";
  },

  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath } = claudePathsFor(ctx);
    const settings = await readJsonIfExists(settingsPath);
    return providerStatusFromEnv(settings.env ?? {});
  },

  async keyInUse(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath, dataDir } = claudePathsFor(ctx);
    const settings = await readJsonIfExists(settingsPath);
    if (providerStatusFromEnv(settings.env ?? {}) !== "fireworks") {
      return null;
    }
    const state = await readJsonIfExists(providerStatePath(dataDir));
    const auth = resolveClaudeAuthState(settings, state);
    if (auth.authMode === "apiKeyHelper") {
      // Nexus's helper runs `nexus key export` per request: always the stored
      // key. A user's own helper may send anything.
      return isNexusApiKeyHelper(settings.apiKeyHelper, state) ? LIVE_KEY : null;
    }
    return auth.token || null;
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath, dataDir } = claudePathsFor(ctx);
    const settings = await readJsonIfExists(settingsPath);
    const state = await readJsonIfExists(providerStatePath(dataDir));
    const env = settings.env ?? {};
    const auth = resolveClaudeAuthState(settings, state);
    const token = auth.token;
    if (token) {
      // Only `--json`'s pricing reads the catalog, so a TTL-fresh cache is
      // enough; refetching made every status wait on the listing.
      await warmServerlessPricingCache(token, { reuseFreshCache: true });
    }
    const currentMapping = mappingFromSettings(settings);
    // Claude's own rows are not Nexus registrations and are not reported.
    const registeredModels = claudeRegisteredPickerModels(settings);
    const payload = {
      harness: HARNESS.CLAUDE,
      provider: providerStatusFromEnv(env),
      baseUrl: env.ANTHROPIC_BASE_URL ?? null,
      hasAuthToken: auth.keyConfigured,
      authMode: auth.authMode,
      defaults: defaultClaudeModelMapping(),
      current: currentMapping,
      pricing: Object.fromEntries(
        Object.entries(currentMapping)
          .filter(([, modelId]) => modelId)
          .map(([slot, modelId]) => [slot, attachPricing(modelId)]),
      ),
      pricingNote: CLAUDE_CODE_PRICING_DISCLAIMER,
      registeredModels,
      modelAccess: await harnessModelAccess(HARNESS.CLAUDE, ctx),
    };
    payload.keyType = "fireworks";

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    const routed = payload.provider === "fireworks";
    const mainModel = payload.current.main || payload.defaults.main || null;
    // Native main is never pinned: Claude Code's own default row is in charge,
    // and through the Fireworks gateway that resolves the bare `auto` alias —
    // so an unpinned main reads `auto`, like the other harnesses' Model line.
    const statusModel = routed && isClaudeNativeModel(mainModel) ? "auto" : mainModel;
    printStructuredHarnessStatus(HARNESS.CLAUDE, {
      provider: payload.provider,
      keyConfigured: payload.hasAuthToken,
      authMode: auth.authMode,
      endpoint: routed ? null : payload.baseUrl,
      model: statusModel,
      registeredModels,
      keySource: harnessStatusKeySource(HARNESS.CLAUDE, payload.provider, {
        authMode: auth.authMode,
      }),
    });
    printModelAccessNote(HARNESS.CLAUDE, payload.modelAccess);
    if (routed && hasLegacyAnthropicMainEnv(settings)) {
      printNote(CLAUDE_LEGACY_ANTHROPIC_MODEL_WARNING);
    }
  },

  async usage(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    // Meter with live Fireworks prices, not just the static spec table. The
    // serverless catalog is per-process (no disk cache) and only `status` warmed
    // it before — so every `claude usage` / live-meter process priced from the
    // static fallback. Warm it here (self-gates on a genuine fw_ key) before any
    // cost is computed. Fully best-effort: resolving the key can throw on a
    // malformed/unreadable settings file, and usage must still work off the
    // session logs, so the whole warm is wrapped, not just the fetch.
    let claudeKey = "";
    let usesNexusHelper = false;
    try {
      const resolved = await claudeResolveUsageAuth(ctx);
      claudeKey = resolved.token;
      usesNexusHelper = resolved.usesNexusHelper;
    } catch {
      claudeKey = "";
      usesNexusHelper = false;
    }
    const creditDisabled = process.env.NEXUS_CREDIT_STATUS === "0";
    let initialCredentialSig = "";
    const [, creditIndicator] = await Promise.all([
      // Preserve pre-PR pricing warm scope: only use Claude's explicitly
      // configured key (never the machine's stored secret, since catalog
      // requests honor NEXUS_GATEWAY_URL).
      warmServerlessPricingCache(claudeKey).catch(() => {
        /* fall back to static spec pricing */
      }),
      creditDisabled
        ? Promise.resolve(null)
        : (async () => {
          // Only read credit standing for an explicit Claude Fireworks key or
          // Nexus's own apiKeyHelper; loadCreditStanding pins to the trusted
          // Fireworks gateway and ignores NEXUS_GATEWAY_URL.
          let creditKey = claudeKey;
          if (!creditKey && usesNexusHelper) {
            creditKey = await resolveFireworksApiKeyValue({ home: ctx.home }).catch(() => "");
            initialCredentialSig = (await readStoredCredentialSignature(ctx.home)).version;
          }
          if (!creditKey) return null;
          return loadCreditStanding({ home: ctx.home, apiKey: creditKey });
        })().catch(() => null),
    ]);
    const creditStanding = creditStandingJsonPayload(creditIndicator);
    if (shouldRunClaudeUsageLive(ctx)) {
      const withinDays = ctx.days || undefined;
      let session = ctx.session ?? "";
      const pickedAtStartup = !session;
      if (!session) {
        // Needs stdin TTY for the multi-session menu; otherwise picks newest.
        session = await promptClaudeUsageSession({ home: ctx.home, withinDays });
        if (!session) {
          return;
        }
      }
      const readCreditIndicator = createClaudeLiveCreditReader(ctx, { initialCredentialSig });
      await runClaudeUsageLive({
        home: ctx.home,
        session,
        verbose: ctx.verbose,
        plain: ctx.plain,
        // If the startup picker ran, drop the pre-picker snapshot so the live
        // meter reads current standing instead of printing stale credits if
        // the account changed while the picker was open.
        creditIndicator: pickedAtStartup ? null : creditIndicator,
        readCreditIndicator,
        // The session list is always reachable, including from an explicit
        // --session. It was withheld there on the theory that you can only go
        // "back" somewhere you have been, but the list is a destination in its
        // own right: --session names a starting point, not a cage, and the only
        // way out used to be quitting and rerunning.
        promptSession: (opts) => promptClaudeUsageSession({ ...opts, withinDays }),
      });
      return;
    }
    if (ctx.lastN) {
      const reportGroup = await readClaudeUsages({ home: ctx.home, session: ctx.session ?? "", lastN: ctx.lastN });
      if (ctx.json) {
        console.log(JSON.stringify(creditStanding ? { ...reportGroup, creditStanding } : reportGroup, null, 2));
        return;
      }
      if (!ctx.verbose && !ctx.plain && hasClaudeUsageRows(reportGroup)) {
        await playUsageIntroAnimation();
        if (canRunClaudeUsageInteractiveDisplay() && await runClaudeUsageInteractiveDisplay(reportGroup, { creditIndicator })) {
          // q/Esc/Ctrl-C resolve the display and restore the cursor, but a
          // paused TTY stdin still holds a libuv ref, so returning up the stack
          // hangs the process. Exit explicitly now that the terminal is restored
          // (same fix as the live meter's quit path in usage/live.mjs).
          process.exit(0);
        }
      }
      console.log(formatClaudeUsageReports(reportGroup, { verbose: ctx.verbose, plain: ctx.plain, creditIndicator }));
      return;
    }

    const report = await readClaudeUsage({ home: ctx.home, session: ctx.session ?? "" });
    if (ctx.json) {
      console.log(JSON.stringify(creditStanding ? { ...report, creditStanding } : report, null, 2));
      return;
    }
    if (!ctx.verbose && !ctx.plain && hasClaudeUsageRows(report)) {
      await playUsageIntroAnimation();
      if (canRunClaudeUsageInteractiveDisplay() && await runClaudeUsageInteractiveDisplay(report, { creditIndicator })) {
        // q/Esc/Ctrl-C resolve the display and restore the cursor, but a paused
        // TTY stdin still holds a libuv ref, so returning up the stack hangs the
        // process. Exit explicitly now that the terminal is restored (same fix
        // as the live meter's quit path in usage/live.mjs).
        process.exit(0);
      }
    }
    console.log(formatClaudeUsageReport(report, { verbose: ctx.verbose, plain: ctx.plain, creditIndicator }));
  },

  /** Retired tmux split, kept so old muscle memory gets a pointer instead of "unknown command". */
  live() {
    warn("`nexus claude live` was removed: Claude Code's status line shows the routed model and spend on every turn.");
    process.stderr.write(`  Run ${accent("claude")} as usual, or ${accent("nexus claude usage")} for the full cost breakdown.\n`);
  },

});
