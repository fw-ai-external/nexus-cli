import {
  printStructuredHarnessStatus,
  printModelAccessNote,
} from "../../harness/status-display.mjs";
import {
  PROVIDER_KEYS_DOCS_URL,
  printHarnessConnected,
  printNote,
} from "../../cli/messages.mjs";
import path from "node:path";
import {
  FIREROUTER_MODEL_ID,
  firerouterNamesAnthropicModel,
  isFirerouterModel,
  isRetiredModelId,
} from "../../fireworks/model-id.mjs";
import {
  CODEX_API_KEY_ENV_REF,
  CODEX_AZURE_PROVIDER_ID,
  CODEX_AZURE_PROVIDER_TABLE,
  CODEX_CHATGPT_FIREWORKS_KEY_HEADER,
  CODEX_DEFAULT_MODEL,
  CODEX_FIREWORKS_BASE_URL,
  CODEX_FIREWORKS_PROVIDER_ID,
  CODEX_PROVIDER_TABLE,
  codexAuthKeyMode,
  codexChatgptLoginFireworksKey,
  codexCurrentModelId,
  codexProviderStatus,
  codexStoredAuthRef,
  disableCodexFireworks,
  effectiveCodexApiKey,
  enableCodexFireworks,
  loadCodexCatalogBundle,
  printCodexRestartHint,
  readCodexTomlIfExists,
} from "./core.mjs";
import { DEFAULT_AZURE_MODEL } from "../../fireworks/azure-core.mjs";
import { isFireworksKey } from "../../keys/key-type.mjs";
import { finishEnvHarnessOn } from "../../harness/env-hook.mjs";
import { defineHarnessProfile, harnessModelAccess } from "../../harness/engine.mjs";
import { readProviderSettings } from "../../config/global-config.mjs";
import { ANTHROPIC_BYOK_HEADER, byokEnvFromHeaders } from "../../firerouter/core.mjs";
import { resolveAutoProviderKeyHeaders } from "../../firerouter/flag.mjs";
import {
  codexPathsFor,
  ensureHomeForHarness,
} from "../../harness/context.mjs";
import {
  codexModelExclusionReason,
  isCodexOpenaiModelSlug,
} from "./catalog.mjs";
import { ensureChatGptStopped, ensureCodexSessionsClosed, isCodexSessionRunning } from "./ide-running.mjs";
import { refreshCodexStockModels } from "./stock-models.mjs";
import { HARNESS } from "../../harness/id.mjs";
import { harnessStatusKeySource, resolveFireworksKeyWithSource } from "../../keys/api-key.mjs";
import { existsSync } from "node:fs";
import { fireworksInferenceUrl, recordedHarnessResidency } from "../../fireworks/residency.mjs";
import { warmServerlessPricingCache } from "../../fireworks/models.mjs";
import {
  canRunClaudeUsageInteractiveDisplay,
  hasClaudeUsageRows,
  playUsageIntroAnimation,
  runClaudeUsageInteractiveDisplay,
} from "../claude/usage/display.mjs";
import { formatClaudeUsageReport, formatClaudeUsageReports, parseLastN } from "../claude/usage/report.mjs";
import { findCodexRollouts, readCodexUsage, readCodexUsages } from "./usage/report.mjs";
import { promptCodexUsageSession, runCodexUsageLive } from "./usage/live.mjs";
import { shouldRunClaudeUsageLive } from "../claude/usage/live.mjs";
import { resolveServedModels, SERVED_LOOKUP_RATE_LIMITED } from "./usage/served-models.mjs";

/** `codex usage` on a TTY lists this many days of sessions by default. */
const CODEX_USAGE_DEFAULT_DAYS = 3;
/** The error the readers throw when there is no Codex session log to report. */
const NO_CODEX_LOGS_RE = /^No Codex session logs found/;
/** Cap on the sessions the default TTY view loads and prices. */
const CODEX_USAGE_SESSION_CAP = 25;
/**
 * Most sessions `--last-n` loads: each uncached one is a served-model lookup,
 * and the route rate-limits an account's lookups, so a larger cold run would
 * mostly come back n/a.
 */
const CODEX_USAGE_MAX_LAST_N = 30;

const CODEX_PROVIDER_KEYS_REMOVED_NOTE =
  "Codex now pays for GPT turns only with its own sign-in, so Nexus CLI removed the "
  + "provider-key headers from config.toml. To pay with an OpenAI key, sign Codex in with it: "
  + "`codex login --with-api-key`.";

// Both readers of config.toml and the model catalog load them once at boot: the
// ChatGPT app, and the app-server daemon every `codex` session shares. Writing
// while either is up changes nothing it serves, so wait for both to be closed.
async function ensureCodexStopped(ctx) {
  await ensureChatGptStopped({ force: ctx.force });
  await ensureCodexSessionsClosed({ force: ctx.force, home: ctx.home });
}

// Codex's own sign-in pays for GPT turns, so Nexus forwards no provider key.
const CODEX_FIREROUTER = Object.freeze({
  byok: "none",
  autoCatalog: true,
});

async function codexResolveKey(ctx) {
  const { configPath } = codexPathsFor(ctx);
  const { doc } = await readCodexTomlIfExists(configPath);
  if (codexProviderStatus(doc) !== "fireworks") {
    return "";
  }
  const key = effectiveCodexApiKey(codexStoredAuthRef(doc));
  return isFireworksKey(key) ? key.trim() : "";
}

/**
 * The key `codex usage` prices and looks up served models with: Codex's own
 * Fireworks key while it is routed, else the stored Nexus key (past sessions
 * stay priceable after `codex off`). Never throws.
 */
async function codexUsageKey(ctx) {
  // An explicit --api-key wins, as in every other command's key precedence;
  // it must not depend on reading Codex's config.
  if (isFireworksKey(ctx.apiKey)) return ctx.apiKey.trim();
  try {
    const routed = await codexResolveKey(ctx);
    if (routed) return routed;
  } catch {
    /* an unreadable Codex config falls through to the stored key */
  }
  try {
    const { key } = await resolveFireworksKeyWithSource({ apiKey: ctx.apiKey, home: ctx.home });
    return isFireworksKey(key) ? key.trim() : "";
  } catch {
    return "";
  }
}

async function codexResolveOnContext(ctx) {
  // Codex CLI 0.160+ dropped `wire_api = "chat"`, the only transport Foundry
  // offers. Reject --azure and a persisted `provider: azure` up front instead
  // of silently switching a former Foundry user to the gateway.
  const { provider } = await readProviderSettings(ctx.home);
  if (ctx.azure || provider === "azure") {
    throw new Error(
      "Codex no longer supports Azure/Foundry mode: Codex CLI 0.160+ removed `wire_api = \"chat\"`. " +
      "Run `nexus configure --provider fireworks` to use the Fireworks gateway.",
    );
  }
  // The GPT rows, and which GPT IDs `--model` accepts, follow stock Codex's own
  // list, so read it before anything checks the requested model.
  if (ctx.home?.trim()) {
    await refreshCodexStockModels({ codexHome: path.dirname(codexPathsFor(ctx).configPath), home: ctx.home });
  }
  // Any spelling of bare `firerouter` is stored as the bare route id.
  if (ctx.main?.trim()) {
    return isFirerouterModel(ctx.main) ? { ...ctx, main: FIREROUTER_MODEL_ID } : ctx;
  }
  const home = ctx.home?.trim() ?? "";
  if (!home) {
    return ctx;
  }
  // A first `on` lands on `auto`; a re-`on` keeps the current model, except
  // that a FireRouter selection carried over from an earlier `on` is dropped
  // to `auto` instead of being kept.
  const { configPath } = codexPathsFor(ctx);
  const { doc } = await readCodexTomlIfExists(configPath);
  const current = codexProviderStatus(doc) === "fireworks" ? codexCurrentModelId(doc) : "";
  if (current && !isRetiredModelId(current)) {
    return ctx;
  }
  return { ...ctx, main: CODEX_DEFAULT_MODEL };
}

/** Codex's sign-in GPT models: served, never in the catalog. */
function codexServedOutsideCatalog(modelId) {
  return isCodexOpenaiModelSlug(modelId);
}

/** The Fireworks models Codex selects while routed (see HarnessAdapter.configuredModels). */
async function codexConfiguredModels(ctx) {
  const { configPath } = codexPathsFor(ctx);
  const { doc } = await readCodexTomlIfExists(configPath);
  if (codexProviderStatus(doc) !== "fireworks") {
    return [];
  }
  const model = codexCurrentModelId(doc);
  return model ? [{ slot: "main", model }] : [];
}

export default defineHarnessProfile({
  id: HARNESS.CODEX,
  label: "Codex",
  configuredModels: codexConfiguredModels,
  resolveKey: codexResolveKey,
  resolveOnContext: codexResolveOnContext,
  paths: (ctx) => codexPathsFor(ctx),
  keyEnvRef: CODEX_API_KEY_ENV_REF,
  firerouter: CODEX_FIREROUTER,
  telemetryHeaders: true,
  getExistingHarnessKey: async (_ctx, paths) => {
    const { doc } = await readCodexTomlIfExists(paths.configPath);
    // Only reuse a stored key when the gateway provider is active — an Azure
    // bearer / {env:AZURE_API_KEY} ref must never be read as the Fireworks key
    // when switching from Foundry back to the gateway.
    return codexProviderStatus(doc) === "fireworks" ? codexStoredAuthRef(doc) : "";
  },
  servedOutsideCatalog: codexServedOutsideCatalog,
  enable: async ({
    ctx,
    paths,
    apiKeyRef,
    effectiveKey,
    modelId,
    telemetryHeaders,
  }) => {
    await ensureCodexStopped(ctx);
    const { doc } = await readCodexTomlIfExists(paths.configPath);
    const anthropicKey = (await resolveAutoProviderKeyHeaders({
      home: ctx.home,
      settingsEnv: byokEnvFromHeaders(doc.tables[CODEX_PROVIDER_TABLE]?.http_headers),
      openai: false,
    }))[ANTHROPIC_BYOK_HEADER] ?? "";
    const exclusionReason = codexModelExclusionReason(modelId);
    if (exclusionReason) {
      throw new Error(exclusionReason);
    }
    const { codexCatalog, snapshot, catalogAvailable } = await loadCodexCatalogBundle(effectiveKey, {
      modelId,
    });
    return enableCodexFireworks({
      configPath: paths.configPath,
      dataDir: paths.dataDir,
      apiKey: apiKeyRef,
      effectiveApiKey: effectiveKey,
      modelId,
      catalogPath: paths.catalogPath,
      catalog: codexCatalog,
      catalogSnapshot: snapshot,
      catalogAvailable,
      telemetryHeaders,
      anthropicKey,
    });
  },
  envHookOn: (ctx) => finishEnvHarnessOn(ctx.home, { harnessId: "codex" }),
  printConnected: ({ result }) => {
    printHarnessConnected("Codex", { model: result.model });
    printNote(
      "Codex keeps its own sign-in: sign in with ChatGPT and GPT turns use your plan. "
        + "Run `codex login` if Codex asks you to sign in.",
    );
    if (result.removedProviderKeys) {
      printNote(CODEX_PROVIDER_KEYS_REMOVED_NOTE);
    }
    if (isCodexOpenaiModelSlug(result.model)) {
      printNote(
        `Signing Codex in with only your Fireworks key? ${result.model} then needs an OpenAI `
          + `Provider Key on your Fireworks account: ${PROVIDER_KEYS_DOCS_URL}. Without one, use `
          + "`auto`, which falls back to open models.",
      );
    }
    if (firerouterNamesAnthropicModel(result.model)) {
      printNote(
        "Codex doesn't send an Anthropic key, so Claude turns on this route need an Anthropic "
          + `Provider Key on your Fireworks account: ${PROVIDER_KEYS_DOCS_URL}.`,
      );
    }
  },
  restartHint: () => printCodexRestartHint(),

  // Stop the app and Codex sessions before `off` rewrites config.toml/removes
  // the catalog — they cache the model list at boot. Mirrors Cursor/VS Code's
  // `prepareOff`.
  prepareOff: (ctx) => ensureCodexStopped(ctx),
  disable: async ({ paths, wasEnabled }) => disableCodexFireworks({
    configPath: paths.configPath,
    dataDir: paths.dataDir,
    catalogPath: paths.catalogPath,
    wasEnabled,
  }),
  restartHintOff: () => printCodexRestartHint({ resume: false, sessionsOpen: isCodexSessionRunning() }),
  async providerStatus(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const { configPath } = codexPathsFor(ctx);
    const { doc } = await readCodexTomlIfExists(configPath);
    return codexProviderStatus(doc);
  },

  async keyInUse(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const { doc } = await readCodexTomlIfExists(codexPathsFor(ctx).configPath);
    if (codexProviderStatus(doc) !== "fireworks") {
      return null;
    }
    const storedAuth = codexStoredAuthRef(doc);
    // An env reference sends whatever the shell exports, which Nexus no
    // longer ties to the stored key: can't tell.
    return storedAuth === CODEX_API_KEY_ENV_REF ? null : storedAuth || null;
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const { configPath, catalogPath } = codexPathsFor(ctx);
    const { doc } = await readCodexTomlIfExists(configPath);
    const provider = codexProviderStatus(doc);

    if (provider === "azure") {
      const azureTable = doc.tables[CODEX_AZURE_PROVIDER_TABLE] ?? {};
      const storedAuth = codexStoredAuthRef(doc);
      const payload = {
        harness: HARNESS.CODEX,
        provider,
        baseUrl: typeof azureTable.base_url === "string" ? azureTable.base_url : null,
        modelProvider: CODEX_AZURE_PROVIDER_ID,
        hasAuthToken: Boolean(effectiveCodexApiKey(storedAuth)),
        defaults: { main: DEFAULT_AZURE_MODEL },
        current: { main: codexCurrentModelId(doc) },
      };
      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printStructuredHarnessStatus(HARNESS.CODEX, {
        provider: payload.provider,
        keyConfigured: payload.hasAuthToken,
        authMode: codexAuthKeyMode(storedAuth),
        model: payload.current.main,
        endpoint: payload.baseUrl,
      });
      return;
    }

    const model = codexCurrentModelId(doc);
    const storedAuth = codexStoredAuthRef(doc);
    const chatgptLogin = provider === "fireworks"
      && Boolean(codexChatgptLoginFireworksKey(doc.tables[CODEX_PROVIDER_TABLE]));
    const payload = {
      harness: HARNESS.CODEX,
      provider,
      baseUrl: fireworksInferenceUrl(CODEX_FIREWORKS_BASE_URL, recordedHarnessResidency("codex", ctx.home)),
      modelProvider: CODEX_FIREWORKS_PROVIDER_ID,
      hasAuthToken: Boolean(effectiveCodexApiKey(storedAuth)),
      chatgptLogin,
      ...(chatgptLogin ? { fireworksKeyHeader: CODEX_CHATGPT_FIREWORKS_KEY_HEADER } : {}),
      defaults: { main: CODEX_DEFAULT_MODEL },
      current: { main: model },
      modelCatalog: {
        set: Boolean(doc.root.model_catalog_json),
        path: catalogPath,
        exists: existsSync(catalogPath),
      },
    };

    payload.modelAccess = await harnessModelAccess(HARNESS.CODEX, ctx);

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    printStructuredHarnessStatus(HARNESS.CODEX, {
      provider: payload.provider,
      keyConfigured: payload.hasAuthToken,
      authMode: codexAuthKeyMode(storedAuth),
      model: payload.current.main,
      keySource: chatgptLogin
        ? `Codex sign-in; Fireworks key in ${CODEX_CHATGPT_FIREWORKS_KEY_HEADER} header in config.toml`
        : harnessStatusKeySource(HARNESS.CODEX, provider),
    });
    printModelAccessNote(HARNESS.CODEX, payload.modelAccess);
  },

  async usage(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CODEX);
    const apiKey = await codexUsageKey(ctx);
    // Same best-effort warm as `claude usage`: live Fireworks prices when a
    // genuine fw_ key is configured, static spec prices otherwise.
    try {
      await warmServerlessPricingCache(apiKey);
    } catch {
      /* fall back to static spec pricing */
    }
    const codexHome = path.dirname(codexPathsFor(ctx).configPath);
    // `auto` calls are priced as the model that served them, looked up from
    // Fireworks (short timeout, cached, n/a on any failure).
    // Why lookups got nothing (HTTP 403, timeout, tracing off), for --verbose:
    // otherwise a key that is refused every run just shows n/a forever.
    /** @type {Map<string, number>} */
    const lookupFailures = new Map();
    const resolveServed = (lookups) => resolveServedModels({
      sessions: lookups,
      apiKey,
      home: ctx.home,
      onFailure: (reason) => lookupFailures.set(reason, (lookupFailures.get(reason) ?? 0) + 1),
    });
    const printLookupFailures = () => {
      for (const [reason, count] of lookupFailures) {
        // Rate limiting explains a run of n/a rows, so it shows without -v too.
        if (!ctx.verbose && reason !== SERVED_LOOKUP_RATE_LIMITED) continue;
        console.error(`served-model lookup failed for ${count} session${count === 1 ? "" : "s"} (${reason})`);
      }
    };
    // The session picker lists up to 100 sessions and redraws on every Esc, so
    // it prices from the on-disk cache only; the meter it opens looks models
    // up in the background for the one session it tracks.
    const resolveCached = (lookups) => resolveServedModels({
      sessions: lookups,
      apiKey,
      home: ctx.home,
      env: { ...process.env, NEXUS_SERVED_MODEL_LOOKUP: "0" },
    });

    // On a TTY with no snapshot flag: pick a session, then live-track it, as
    // `claude usage` does.
    if (shouldRunClaudeUsageLive(ctx)) {
      const withinDays = ctx.days || CODEX_USAGE_DEFAULT_DAYS;
      const session = ctx.session
        ? (await findCodexRollouts({ codexHome, home: ctx.home, session: ctx.session, lastN: 1 })).parents[0]?.filePath
        : await promptCodexUsageSession({ codexHome, home: ctx.home, withinDays, resolveServedForPicker: resolveCached });
      if (!session) return;
      await runCodexUsageLive({ home: ctx.home, codexHome, session, apiKey, withinDays, resolveServedForPicker: resolveCached });
      return;
    }

    const interactive = !ctx.json && !ctx.verbose && !ctx.plain
      && canRunClaudeUsageInteractiveDisplay();

    // A single session: --session, or the newest one off a TTY (as `claude
    // usage` reports the latest session when it cannot show the picker).
    if (ctx.session || (!ctx.lastN && !interactive)) {
      let report;
      try {
        report = await readCodexUsage({ codexHome, home: ctx.home, session: ctx.session ?? "", withinDays: ctx.days || undefined, resolveServed });
      } catch (error) {
        // No Codex logs yet (or none in --days) is an empty report, not a
        // failure; a --session that matches nothing still errors, logs or not.
        if (ctx.session || !(error instanceof Error && NO_CODEX_LOGS_RE.test(error.message))) throw error;
        console.log(ctx.json ? "null" : "No Codex session usage found.");
        return;
      }
      if (ctx.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      if (interactive && hasClaudeUsageRows(report)) {
        await playUsageIntroAnimation();
        if (await runClaudeUsageInteractiveDisplay(report)) {
          // A paused TTY stdin still holds a libuv ref; exit once the display
          // has restored the terminal (same as `claude usage`).
          process.exit(0);
        }
      }
      console.log(formatClaudeUsageReport(report, { verbose: ctx.verbose, plain: ctx.plain }));
      printLookupFailures();
      return;
    }

    // Several sessions: --last-n, or on a TTY every session from the last
    // --days (default 3), which the interactive display lets you drill into.
    let lastN = CODEX_USAGE_SESSION_CAP;
    if (ctx.lastN) {
      lastN = parseLastN(ctx.lastN);
      if (lastN > CODEX_USAGE_MAX_LAST_N) {
        console.error(`--last-n is capped at ${CODEX_USAGE_MAX_LAST_N} for codex usage; showing the newest ${CODEX_USAGE_MAX_LAST_N} sessions.`);
        lastN = CODEX_USAGE_MAX_LAST_N;
      }
    }
    let reportGroup;
    try {
      reportGroup = await readCodexUsages({
        codexHome,
        home: ctx.home,
        lastN,
        withinDays: ctx.days || (ctx.lastN ? undefined : CODEX_USAGE_DEFAULT_DAYS),
        resolveServed,
      });
    } catch (error) {
      if (ctx.session || !(error instanceof Error && NO_CODEX_LOGS_RE.test(error.message))) throw error;
      reportGroup = { sessions: [], grandRequests: 0, lastN: 0, sessionCount: 0 };
    }
    if (ctx.json) {
      console.log(JSON.stringify(reportGroup, null, 2));
      return;
    }
    if (reportGroup.sessions.length === 0) {
      console.log("No Codex session usage found.");
      return;
    }
    if (interactive && hasClaudeUsageRows(reportGroup)) {
      await playUsageIntroAnimation();
      if (await runClaudeUsageInteractiveDisplay(reportGroup)) {
        process.exit(0);
      }
    }
    console.log(formatClaudeUsageReports(reportGroup, { verbose: ctx.verbose, plain: ctx.plain }));
    printLookupFailures();
  },

});
