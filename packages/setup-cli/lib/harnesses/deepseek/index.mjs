import {
  printStructuredHarnessStatus,
  printModelAccessNote,
} from "../../harness/status-display.mjs";
import {
  printDeepseekRestartHint,
} from "../../cli/messages.mjs";
import { defaultMainModel } from "../../fireworks/model-id.mjs";
import { loadRegisterableModels } from "../../fireworks/models.mjs";
import { byokEnvFromHeaders } from "../../firerouter/core.mjs";
import {
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_FIREWORKS_BASE_URL,
  DEEPSEEK_FIREWORKS_PROVIDER_ID,
  deepseekEffectiveFireworksState,
  deepseekStoredProviderHeaders,
  disableDeepseekFireworks,
  enableDeepseekFireworks,
  readDeepseekCredentialsIfExists,
  readDeepseekSettingsIfExists,
  resolveDeepseekApiKey,
} from "./core.mjs";
import { harnessHasFullKey } from "../../keys/harness-api-key.mjs";
import { finishEnvHarnessOn } from "../../harness/env-hook.mjs";
import { defineHarnessProfile, harnessModelAccess } from "../../harness/engine.mjs";
import {
  deepseekPathsFor,
  ensureHomeForHarness,
} from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";
import { fireworksInferenceUrl, recordedHarnessResidency } from "../../fireworks/residency.mjs";

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function deepseekResolveKey(ctx) {
  const { settingsPath, credentialsPath } = deepseekPathsFor(ctx);
  const { settings } = await readDeepseekSettingsIfExists(settingsPath);
  const effective = await deepseekEffectiveFireworksState(settingsPath, settings);
  if (effective.provider !== "fireworks") {
    return "";
  }
  const { credentials } = await readDeepseekCredentialsIfExists(credentialsPath);
  return resolveDeepseekApiKey({
    mode: deepseekAuthModeFor(effective.provider, credentials),
    credentials,
  });
}

/** Auth mode from the effective provider (settings or profile patch). */
function deepseekAuthModeFor(provider, credentials) {
  if (provider !== "fireworks") {
    return "missing";
  }
  const stored = credentials[DEEPSEEK_API_KEY_ENV];
  return typeof stored === "string" && stored.trim() ? "literal" : "env-reference";
}

/** The Fireworks models DeepSeek Harness selects while routed (see HarnessAdapter.configuredModels). */
async function deepseekConfiguredModels(ctx) {
  const { settingsPath } = deepseekPathsFor(ctx);
  const { settings } = await readDeepseekSettingsIfExists(settingsPath);
  const effective = await deepseekEffectiveFireworksState(settingsPath, settings);
  return effective.provider === "fireworks" && effective.model
    ? [{ slot: "main", model: effective.model }]
    : [];
}

export default defineHarnessProfile({
  id: HARNESS.DEEPSEEK,
  label: "DeepSeek Harness",
  configuredModels: deepseekConfiguredModels,
  resolveKey: deepseekResolveKey,
  paths: (ctx) => deepseekPathsFor(ctx),
  keyEnvRef: DEEPSEEK_API_KEY_ENV,
  // The dsh provider profile carries per-request headers: telemetry, the
  // `nexus auto` scope, and the provider keys Nexus Auto reads.
  firerouter: {
    byok: "value",
    autoCatalog: true,
  },
  telemetryHeaders: true,
  readByokEnv: async (_ctx, paths) => {
    try {
      const { settings } = await readDeepseekSettingsIfExists(paths.settingsPath);
      return byokEnvFromHeaders(deepseekStoredProviderHeaders(settings));
    } catch {
      // An unparseable settings.yaml has no keys to keep; `on` reports it.
      return {};
    }
  },
  getExistingHarnessKey: async (_ctx, paths) => {
    const { settings } = await readDeepseekSettingsIfExists(paths.settingsPath);
    const effective = await deepseekEffectiveFireworksState(paths.settingsPath, settings);
    if (effective.provider !== "fireworks") {
      return "";
    }
    const { credentials } = await readDeepseekCredentialsIfExists(paths.credentialsPath);
    return credentials[DEEPSEEK_API_KEY_ENV] ?? "";
  },
  enable: async ({ paths, effectiveKey, modelId, byokHeaders = {}, telemetryHeaders = {} }) => {
    // Register the account's catalog, like the other picker harnesses. A
    // TTL-cached snapshot serves offline; a cold start with no network fails
    // the `on` rather than register a list that was never fetched.
    const { ids: catalogModelIds, available: catalogAvailable } = await loadRegisterableModels({
      apiKey: effectiveKey,
    });
    return enableDeepseekFireworks({
      settingsPath: paths.settingsPath,
      credentialsPath: paths.credentialsPath,
      dataDir: paths.dataDir,
      effectiveApiKey: effectiveKey,
      modelId,
      headers: { ...telemetryHeaders, ...byokHeaders },
      catalogModelIds,
      catalogAvailable,
    });
  },
  envHookOn: (ctx, effectiveKey) => finishEnvHarnessOn(ctx.home, {
    harnessId: "deepseek",
    expectedKey: effectiveKey,
  }),
  restartHint: () => printDeepseekRestartHint(),
  disable: ({ paths, wasEnabled }) => disableDeepseekFireworks({
    settingsPath: paths.settingsPath,
    credentialsPath: paths.credentialsPath,
    dataDir: paths.dataDir,
    wasEnabled,
  }),
  restartHintOff: (outcome) => {
    if (outcome !== "unchanged") {
      printDeepseekRestartHint();
    }
  },
  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.DEEPSEEK);
    const { settingsPath } = deepseekPathsFor(ctx);
    const { settings } = await readDeepseekSettingsIfExists(settingsPath);
    return (await deepseekEffectiveFireworksState(settingsPath, settings)).provider;
  },

  async keyInUse(ctx) {
    ensureHomeForHarness(ctx, HARNESS.DEEPSEEK);
    const { settingsPath, credentialsPath } = deepseekPathsFor(ctx);
    const [{ settings }, { credentials }] = await Promise.all([
      readDeepseekSettingsIfExists(settingsPath),
      readDeepseekCredentialsIfExists(credentialsPath),
    ]);
    const { provider } = await deepseekEffectiveFireworksState(settingsPath, settings);
    if (provider !== "fireworks") {
      return null;
    }
    // Only a literal in the credentials file says which key it sends; an env
    // reference sends whatever the shell exports.
    const mode = deepseekAuthModeFor(provider, credentials);
    return mode === "literal" ? resolveDeepseekApiKey({ mode, credentials }) || null : null;
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.DEEPSEEK);
    const { settingsPath, credentialsPath } = deepseekPathsFor(ctx);
    const [{ settings }, { credentials }] = await Promise.all([
      readDeepseekSettingsIfExists(settingsPath),
      readDeepseekCredentialsIfExists(credentialsPath),
    ]);

    const effective = await deepseekEffectiveFireworksState(settingsPath, settings);
    const provider = effective.provider;
    const apiKeyMode = deepseekAuthModeFor(provider, credentials);
    const model = effective.model;
    // Presence only: reading the stored key here would cost a keychain
    // prompt on every status call.
    const hasAuthToken = await harnessHasFullKey(ctx, async () => (
      provider === "fireworks"
        ? resolveDeepseekApiKey({ mode: apiKeyMode, credentials })
        : ""
    ));
    const payload = {
      harness: HARNESS.DEEPSEEK,
      provider,
      baseUrl: fireworksInferenceUrl(DEEPSEEK_FIREWORKS_BASE_URL, recordedHarnessResidency("deepseek", ctx.home)),
      modelProvider: DEEPSEEK_FIREWORKS_PROVIDER_ID,
      hasAuthToken,
      apiKeyMode,
      defaults: { main: defaultMainModel() },
      current: { main: model },
    };

    payload.modelAccess = await harnessModelAccess(HARNESS.DEEPSEEK, ctx);

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.DEEPSEEK, {
      provider: payload.provider,
      keyConfigured: payload.hasAuthToken,
      authMode: payload.apiKeyMode,
      model: payload.current.main,
      keySource: harnessStatusKeySource(HARNESS.DEEPSEEK, payload.provider),
    });
    printModelAccessNote(HARNESS.DEEPSEEK, payload.modelAccess);
  },
});
