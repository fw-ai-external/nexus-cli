import { printModelAccessNote, printStructuredHarnessStatus } from "../../harness/status-display.mjs";
import { printHermesRestartHint } from "../../cli/messages.mjs";
import { defaultMainModel } from "../../fireworks/model-id.mjs";
import { loadRegisterableModels } from "../../fireworks/models.mjs";
import { byokEnvFromHeaders } from "../../firerouter/core.mjs";
import {
  HERMES_API_KEY_ENV,
  HERMES_FIREWORKS_BASE_URL,
  HERMES_FIREWORKS_PROVIDER_ID,
  disableHermesFireworks,
  enableHermesFireworks,
  hermesCurrentModelId,
  hermesGatewayRunning,
  hermesModelId,
  hermesProviderStatus,
  hermesRoutedByNexus,
  hermesStoredHeaders,
  readHermesConfigIfExists,
  readHermesEnvKey,
} from "./core.mjs";
import { harnessHasFullKey } from "../../keys/harness-api-key.mjs";
import { defineHarnessProfile, harnessModelAccess } from "../../harness/engine.mjs";
import { ensureHomeForHarness, hermesPathsFor } from "../../harness/context.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { harnessStatusKeySource } from "../../keys/api-key.mjs";
import { fireworksInferenceUrl, recordedHarnessResidency } from "../../fireworks/residency.mjs";

/** The `.env` key, when config.yaml selects a Fireworks provider. */
async function routedKey(configPath) {
  const { config } = await readHermesConfigIfExists(configPath);
  return hermesProviderStatus(config) === "fireworks" ? readHermesEnvKey(configPath) : "";
}

/** The Fireworks models Hermes selects while routed (see HarnessAdapter.configuredModels). */
async function hermesConfiguredModels(ctx) {
  const paths = hermesPathsFor(ctx);
  const { config } = await readHermesConfigIfExists(paths.configPath);
  if (!(await hermesRoutedByNexus(paths, config))) {
    return [];
  }
  const model = hermesCurrentModelId(config);
  // `nexus-auto` is matched as `auto` by the shared catalog check.
  return model ? [{ slot: "main", model }] : [];
}

export default defineHarnessProfile({
  id: HARNESS.HERMES,
  label: "Hermes Agent",
  configuredModels: hermesConfiguredModels,
  resolveKey: (ctx) => routedKey(hermesPathsFor(ctx).configPath),
  paths: (ctx) => hermesPathsFor(ctx),
  keyEnvRef: HERMES_API_KEY_ENV,
  // The `nexus` provider's `extra_headers` ride every main-model request:
  // telemetry, the `nexus auto` scope, and the provider keys Nexus Auto reads.
  firerouter: {
    byok: "value",
    autoCatalog: true,
  },
  telemetryHeaders: true,
  readByokEnv: async (_ctx, paths) => {
    try {
      const { config } = await readHermesConfigIfExists(paths.configPath);
      return byokEnvFromHeaders(hermesStoredHeaders(config));
    } catch {
      // An unparseable config.yaml has no keys to keep; `on` reports it.
      return {};
    }
  },
  getExistingHarnessKey: (_ctx, paths) => routedKey(paths.configPath),
  enable: async ({ paths, effectiveKey, modelId, byokHeaders = {}, telemetryHeaders = {} }) => {
    // The Fireworks picker shows only the account's catalog, as the other
    // picker harnesses list it (`-latest` aliases in place of the versions
    // they cover). A TTL-cached snapshot serves offline; a cold start with no
    // network fails the `on` rather than write a list that was never fetched.
    const { ids: catalogModelIds, available: catalogAvailable } = await loadRegisterableModels({
      apiKey: effectiveKey,
    });
    return enableHermesFireworks({
      configPath: paths.configPath,
      dataDir: paths.dataDir,
      effectiveApiKey: effectiveKey,
      modelId,
      headers: { ...telemetryHeaders, ...byokHeaders },
      catalogModelIds,
      catalogAvailable,
    });
  },
  restartHint: ({ paths }) => printHermesRestartHint({ gatewayRunning: hermesGatewayRunning(paths.configPath) }),
  disable: ({ paths, wasEnabled }) => disableHermesFireworks({
    configPath: paths.configPath,
    dataDir: paths.dataDir,
    wasEnabled,
  }),
  restartHintOff: (outcome, { paths }) => {
    if (outcome !== "unchanged") {
      printHermesRestartHint({ gatewayRunning: hermesGatewayRunning(paths.configPath) });
    }
  },
  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.HERMES);
    const paths = hermesPathsFor(ctx);
    const { config } = await readHermesConfigIfExists(paths.configPath);
    // A Fireworks setup made by hand isn't Nexus's: `off` and `uninstall` leave it.
    return (await hermesRoutedByNexus(paths, config)) ? "fireworks" : null;
  },

  async keyInUse(ctx) {
    ensureHomeForHarness(ctx, HARNESS.HERMES);
    return (await routedKey(hermesPathsFor(ctx).configPath)) || null;
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.HERMES);
    const paths = hermesPathsFor(ctx);
    const { configPath } = paths;
    const { config } = await readHermesConfigIfExists(configPath);
    const provider = (await hermesRoutedByNexus(paths, config)) ? "fireworks" : null;
    const routed = provider === "fireworks";
    const envKey = routed ? await readHermesEnvKey(configPath) : "";
    const apiKeyMode = !routed ? "missing" : envKey ? "literal" : "env-reference";
    // Presence only: reading the stored key here would cost a keychain
    // prompt on every status call.
    const hasAuthToken = await harnessHasFullKey(ctx, async () => envKey);
    const payload = {
      harness: HARNESS.HERMES,
      provider,
      baseUrl: fireworksInferenceUrl(HERMES_FIREWORKS_BASE_URL, recordedHarnessResidency("hermes", ctx.home)),
      modelProvider: HERMES_FIREWORKS_PROVIDER_ID,
      hasAuthToken,
      apiKeyMode,
      defaults: { main: hermesModelId(defaultMainModel()) },
      current: { main: routed ? hermesCurrentModelId(config) : null },
    };

    payload.modelAccess = await harnessModelAccess(HARNESS.HERMES, ctx);

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.HERMES, {
      provider: payload.provider,
      keyConfigured: payload.hasAuthToken,
      authMode: payload.apiKeyMode,
      model: payload.current.main,
      keySource: harnessStatusKeySource(HARNESS.HERMES, payload.provider),
    });
    printModelAccessNote(HARNESS.HERMES, payload.modelAccess);
  },
});
