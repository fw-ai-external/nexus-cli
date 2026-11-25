import { stat } from "node:fs/promises";
import path from "node:path";
import {
  printAzureConnected,
  printNote,
  printHarnessRestored,
  printHarnessUnchanged,
  printHarnessOnFootnotes,
  printHarnessOnSuccess,
} from "../cli/messages.mjs";
import { assertNotFirerouterModelId, canonicalRequestedModelId } from "../fireworks/model-id.mjs";
import { assertRequestedModelServable } from "../fireworks/model-servability.mjs";
import {
  blockedConfiguredModels,
  hasCachedCatalog,
  modelAccessReport,
  offerModelAccessSwitch,
  pickReplacementModel,
} from "../fireworks/model-access.mjs";
import { loadServerlessCatalog } from "../fireworks/models.mjs";
import { getServerlessCatalogSnapshot } from "../fireworks/serverless-catalog-cache.mjs";
import { resolveAzureBaseUrl, resolveAzureOnApiKey } from "../fireworks/azure-core.mjs";
import { assertResolvedKeyNotRejected } from "../keys/api-key.mjs";
import {
  resolveHarnessOnApiKey,
} from "../keys/harness-api-key.mjs";
import { resolveAutoProviderKeyHeaders } from "../firerouter/flag.mjs";
import {
  isHarnessEnabled,
  readGlobalConfig,
  hasHarnessCustomPath,
  readProviderSettings,
  recordHarnessCustomPath,
  setHarnessEnabled,
} from "../config/global-config.mjs";
import { autoHarnessSupported, nexusProvidersHeaders } from "../config/auto-providers.mjs";
import { reconcileShellEnvHook } from "../io/shell-env-hook.mjs";
import { resolveHarnessResidency } from "../fireworks/residency.mjs";
import { ensureHomeForHarness, harnessPathOverrides, withoutPathOverrides } from "./context.mjs";
import { defineHarness } from "./types.mjs";
import { buildFireconnectTelemetryHeaders } from "../telemetry/request-headers.mjs";

/**
 * A HarnessProfile is the small, mostly-declarative description of a harness.
 * The engine owns the shared `on`/`off` command orchestration
 * so a new step in a flow is one edit here, not one per harness. Harness-specific
 * config-format work stays in the profile's hook functions.
 *
 * @typedef {Object} HarnessProfile
 * @property {import("./id.mjs").HarnessId} id
 * @property {string} label
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<string>} resolveKey
 *   Harness-local key (used by the registry's resolveKey and, typically, fullKey).
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<import("./types.mjs").HarnessContext>} [resolveOnContext]
 *   Resolve state-dependent defaults for `on`; the result is validated and dispatched.
 * @property {(ctx: import("./types.mjs").HarnessContext) => object} paths
 * @property {string} keyEnvRef
 * @property {{ byok?: "none"|"value", autoCatalog?: boolean, catalogByok?: boolean, customHeaderOpenaiKey?: boolean }|null} [firerouter]
 *   How the harness carries provider keys; null/omitted means it can't.
 * @property {boolean} [telemetryHeaders] Whether this harness can send static request headers.
 * @property {(ctx: import("./types.mjs").HarnessContext, paths: object) => Promise<Record<string,string>>} [readByokEnv]
 *   For `byok: "value"` harnesses: return a settingsEnv-shaped object (with
 *   ANTHROPIC_CUSTOM_HEADERS) built from BYOK keys already stored in the harness
 *   config, so a repeat `on` recovers them instead of dropping them.
 * @property {{
 *   read: (ctx: object, paths: object) => Promise<{ active: boolean, storedKey?: string, storedBaseUrl?: string, model?: string }>,
 *   enable: (args: { ctx: object, paths: object, apiKey: string, apiKeyFromFlag: boolean, baseUrl: string }) => Promise<{ model: string, baseUrl: string, apiKeyMode?: string }>,
 *   restart: (result: object) => void,
 * }} [azure] Complete Foundry capability; omitted means unsupported.
 * @property {(ctx: import("./types.mjs").HarnessContext, paths: object) => Promise<string>} [getExistingHarnessKey]
 * @property {(ctx: import("./types.mjs").HarnessContext, paths: object) => Promise<{ apiKeyRef?: string, effectiveKey: string, reusedExistingKey?: boolean }>} [resolveOnKey]
 *   Custom `on` key resolution (default: resolveHarnessOnApiKey with keyEnvRef + getExistingHarnessKey).
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<Array<{ slot: string, model: string }>>} [configuredModels]
 *   See HarnessAdapter.configuredModels.
 * @property {(modelId: string) => boolean} [servedOutsideCatalog]  `--model` ids this harness
 *   serves that the serverless catalog never lists (Codex's sign-in GPT models); they skip
 *   the catalog check.
 * @property {(args: { ctx: object, paths: object, apiKeyRef: string, effectiveKey: string, modelId: string, byokHeaders: Record<string,string>, telemetryHeaders: Record<string,string>, flags: object }) => Promise<{ model: string, modelsAdded?: string[] }>} enable
 * @property {(ctx: import("./types.mjs").HarnessContext, effectiveKey: string) => Promise<void>} [envHookOn]
 * @property {(args: { ctx: object, paths: object, result: object, reusedExistingKey: boolean }) => void} [printConnected]
 *   Full success-output override (default: connected + restartHint).
 * @property {(modelId: string) => string} [displayModelId]  How the model list after
 *   `printConnected` names a model (Codex prints its FireRouter route as `firerouter`).
 * @property {(args: { ctx: object, paths: object, result: object }) => void} [restartHint]
 *   Paths let a hint name what is still running the old setup (Hermes's gateway).
 * @property {(args: { ctx: object, paths: object, wasEnabled: boolean }) => Promise<"restored"|"stripped"|"unchanged">} [disable]
 * @property {(ctx: object) => Promise<void>} [prepareOff]  Stop the IDE before writing (Cursor/VS Code).
 * @property {boolean} [envHookOff]  Set false to skip the shell env-hook removal on `off` (Cursor/VS Code).
 * @property {(outcome: string, args: { ctx: object, paths: object }) => void} [restartHintOff]
 * Command overrides — when omitted, the engine's generic implementation is used
 * (except `status`, which is always harness-specific and required):
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<void>} status
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<void>} [on]
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<void>} [off]
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<void>} [usage]
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<string | object | null>} [keyInUse]
 *   See HarnessAdapter.keyInUse.
 * @property {(ctx: import("./types.mjs").HarnessContext) => Promise<boolean>} [ownsRouting]
 *   See HarnessAdapter.ownsRouting.
 */

/**
 * Generic `<harness> on`: resolve the key, decide the model (explicit
 * `--model` or the harness default), build BYOK headers, write the provider
 * enabled flag, reconcile the shell env hook when needed, and print the standard success
 * output. Azure mode delegates to the profile's own handler unchanged.
 * @param {HarnessProfile} profile
 * @param {import("./types.mjs").HarnessContext} ctx
 */
export async function engineOn(profile, ctx) {
  ensureHomeForHarness(ctx, profile.id);

  // FireRouter routes are retired as a selection, on the Azure path too:
  // reject before any provider config is written.
  assertNotFirerouterModelId(ctx.main ?? "");

  if (profile.azure) {
    const { provider, azure: azureConfig } = await readProviderSettings(ctx.home);
    if (ctx.azure || provider === "azure") {
      await engineAzureOn(profile, ctx, azureConfig);
      return;
    }
  }

  const paths = profile.paths(ctx);
  const { apiKeyRef = "", effectiveKey, reusedExistingKey = false } = await resolveOnKey(profile, ctx, paths);
  // Inference URLs written below use the account's regional endpoint when it
  // has data residency; the gateway refuses the global one for it.
  const residencyState = await resolveHarnessResidency(effectiveKey, profile.id, ctx.home, {
    onNote: (line) => { if (!ctx.quiet) printNote(line); },
  });

  const modelId = canonicalRequestedModelId(ctx.main)
    || await offerAllowedModelForBlockedSelection(profile, ctx, effectiveKey);
  let byokHeaders = {};
  if (profile.firerouter?.byok === "value") {
    // Re-reading the harness's own headers keeps a provider key added by hand.
    const settingsEnv = profile.readByokEnv ? await profile.readByokEnv(ctx, paths) : {};
    byokHeaders = await resolveAutoProviderKeyHeaders({ home: ctx.home, settingsEnv });
  }

  if (!profile.servedOutsideCatalog?.(modelId)) {
    await assertRequestedModelServable(modelId, { apiKey: effectiveKey });
  }

  // The `auto` router's provider scope (`nexus auto`) is a static header
  // like telemetry: it rides whichever header channel the harness has
  // (BYOK headers for value harnesses, telemetry headers for the rest).
  // The gateway honors it only for `auto`, so it is safe on the provider
  // for in-session model switching. Unset = no header (default scope).
  const autoHeaders = nexusProvidersHeaders(
    (await readGlobalConfig(ctx.home)).auto.providers,
  );
  // A config at a custom path holds its own copy of the key: remember it
  // before writing it, so a key rotation re-points (or keeps the key for)
  // that copy too, even if this run dies mid-write.
  const overrides = customPathOverrides(profile, ctx);
  const recordedBefore = await hasHarnessCustomPath(ctx.home, profile.id, overrides);
  await recordHarnessCustomPath(ctx.home, profile.id, overrides, true);
  let result;
  try {
    result = await profile.enable({
      ctx,
      paths,
      apiKeyRef,
      effectiveKey,
      modelId,
      byokHeaders: { ...byokHeaders, ...autoHeaders },
      telemetryHeaders: profile.telemetryHeaders
        ? { ...buildFireconnectTelemetryHeaders(profile.id), ...autoHeaders }
        : {},
    });
  } catch (error) {
    // Nothing routed there after all: drop the new record, or every later
    // rotation would keep the old key for a config that never held it.
    if (!recordedBefore && !await isHarnessRouted(profile, ctx).catch(() => true)) {
      await recordHarnessCustomPath(ctx.home, profile.id, overrides, false).catch(() => {});
    }
    throw error;
  }

  await setHarnessEnabled(ctx.home, profile.id, true, "fireworks", residencyState);
  if (profile.envHookOn) {
    await profile.envHookOn(ctx, effectiveKey);
  }
  // An upgrade's re-`on` reports through its own note.
  if (ctx.quiet) {
    return;
  }

  if (!autoHarnessSupported(profile.id)
    && (await readGlobalConfig(ctx.home)).auto.providers) {
    printNote(
      `Your \`nexus auto\` provider scope doesn't apply in ${profile.label}: it can't carry the scope, `
      + "so auto there runs at the default scope. Saved Anthropic and OpenAI keys aren't sent from it either.",
    );
  }

  const modelsAdded = result.modelsAdded ?? [result.model];
  const restartHint = () => profile.restartHint({ ctx, paths, result });
  if (profile.printConnected) {
    await profile.printConnected({ ctx, paths, result, reusedExistingKey });
    const displayModelId = profile.displayModelId ?? ((model) => model);
    printHarnessOnFootnotes(modelsAdded.map(displayModelId), [], restartHint, {
      primaryModel: displayModelId(result.model),
    });
    return;
  }
  await printHarnessOnSuccess({
    label: profile.label,
    model: result.model,
    modelsAdded,
    restartHint,
  });
}

/**
 * A plain re-`on` (no `--model`) keeps the harness's current model. When the
 * account's served catalog no longer lists that model (its organization's
 * Model Access policy blocks it, say), tell the user and, at a terminal, ask
 * whether to switch to an allowed one. Returns the model to select instead,
 * or "" to keep the current one. Settings are never switched without a yes.
 *
 * Picker lists aren't asked about: `on` already reconciles them with the
 * served catalog. With no cached catalog yet, offline, or with only a stale
 * or other account's catalog, nothing is compared. Never throws.
 * @param {HarnessProfile} profile
 * @param {import("./types.mjs").HarnessContext} ctx
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
export async function offerAllowedModelForBlockedSelection(profile, ctx, apiKey) {
  if (typeof profile.configuredModels !== "function") {
    return "";
  }
  try {
    const configured = (await profile.configuredModels(ctx)).filter((entry) => entry.slot !== "picker");
    if (!configured.length) {
      return "";
    }
    const { catalog, entries } = await servedCatalogForOn(apiKey);
    const blocked = blockedConfiguredModels(configured, catalog, {
      servedOutsideCatalog: profile.servedOutsideCatalog,
    });
    if (!blocked.length) {
      return "";
    }
    const replacement = pickReplacementModel(entries, { exclude: blocked.map(({ model }) => model) });
    const agreed = await offerModelAccessSwitch({ ctx, harnessCommand: profile.id, blocked, replacement });
    return agreed ? replacement : "";
  } catch {
    return "";
  }
}

/**
 * This account's served catalog for `on`'s Model Access checks: `catalog`
 * (with the `auto` row every served catalog gains) for membership, and
 * `entries`, the rows the API returned, to pick a replacement from. Empty
 * when it can't be had: nothing cached yet (a first `on`, or offline, where
 * the check must add no wait), a failed or stale load, or another account's
 * copy. Bounded by the cached-catalog budget; never throws. The one rule for
 * every harness's `on`.
 * @param {string} apiKey
 * @returns {Promise<{ catalog: Array<object>, entries: Array<object> }>}
 */
export async function servedCatalogForOn(apiKey) {
  const none = { catalog: [], entries: [] };
  if (!apiKey || !hasCachedCatalog()) {
    return none;
  }
  try {
    const { catalog, source } = await loadServerlessCatalog({ apiKey, bounded: true });
    if (source === "stale") {
      return none;
    }
    return { catalog, entries: getServerlessCatalogSnapshot()?.entries ?? [] };
  } catch {
    return none;
  }
}

/**
 * The model-access part of a harness's status: its configured models compared
 * with the catalog cached under the harness's home, but only when that cache
 * belongs to the key the harness sends (otherwise `checked: false`). The key
 * comes from `keyInUse` (never prompts); a harness that fetches the key from
 * Nexus per request, or reads it from the environment, sends
 * `FIREWORKS_API_KEY` when it is set, else `activeKey` when the caller already
 * holds it. Cache only, never throws (see `modelAccessReport`).
 * @param {string | { configuredModels?: HarnessProfile["configuredModels"], servedOutsideCatalog?: (modelId: string) => boolean, keyInUse?: (ctx: object) => Promise<unknown> }} target
 *   a harness id or adapter
 * @param {import("./types.mjs").HarnessContext} ctx
 * @param {{ activeKey?: string }} [options]
 * @returns {Promise<import("../fireworks/model-access.mjs").ModelAccessReport>}
 */
export async function harnessModelAccess(target, ctx, { activeKey = "" } = {}) {
  let adapter = target;
  let configured = [];
  let apiKey = "";
  try {
    if (typeof target === "string") {
      adapter = (await import("./registry.mjs")).getHarness(target);
    }
    configured = typeof adapter?.configuredModels === "function" ? await adapter.configuredModels(ctx) : [];
    // `modelAccessKeyInUse` replaces `keyInUse` where reading the key could
    // touch a secret store (status must stay prompt-free).
    const readKey = adapter?.modelAccessKeyInUse ?? adapter?.keyInUse;
    const inUse = typeof readKey === "function" ? await readKey.call(adapter, ctx) : null;
    // A string is the literal key; LIVE_KEY or null means the key is fetched
    // or read from the environment at request time.
    apiKey = typeof inUse === "string" && inUse !== ""
      ? inUse
      : process.env.FIREWORKS_API_KEY?.trim() || activeKey || "";
  } catch {
    // Unreadable config: report what could be read.
  }
  return modelAccessReport(configured, {
    servedOutsideCatalog: adapter?.servedOutsideCatalog,
    home: ctx?.home,
    apiKey,
  });
}

/**
 * Generic `<harness> on --azure`: the shared Foundry (Azure) orchestration —
 * resolve the key + endpoint (precedence: flag > configured > stored > env),
 * write the provider through the profile's cohesive Azure capability, flip the
 * enabled flag, and print the standard Azure success output.
 * @param {HarnessProfile} profile
 * @param {import("./types.mjs").HarnessContext} ctx
 * @param {{ baseUrl?: string, apiKey?: string }} azureConfig
 */
export async function engineAzureOn(profile, ctx, azureConfig) {
  const paths = profile.paths(ctx);
  const { active = false, storedKey = "", storedBaseUrl = "" } = await profile.azure.read(ctx, paths);

  const { apiKey, apiKeyFromFlag } = await resolveAzureOnApiKey({
    apiKey: ctx.apiKey,
    apiKeyFromFlag: ctx.apiKeyFromFlag,
    configuredApiKey: azureConfig.apiKey,
    getExistingKey: async () => (active ? storedKey : ""),
  });
  const baseUrl = resolveAzureBaseUrl(ctx, azureConfig, active ? storedBaseUrl : "");

  const result = await profile.azure.enable({ ctx, paths, apiKey, apiKeyFromFlag, baseUrl });

  await setHarnessEnabled(ctx.home, profile.id, true, "azure");
  // That config no longer holds the Fireworks key.
  await recordHarnessCustomPath(ctx.home, profile.id, harnessPathOverrides(ctx, profile.id), false);
  await reconcileShellEnvHook(ctx.home);

  printAzureConnected({
    id: profile.label,
    result,
  });
  profile.azure.restart(result);
}

/**
 * `on` key resolution: the profile's own resolver when provided (Cursor/VS Code
 * read a SQLite secret), else the standard keychain/env-ref flow.
 * @param {HarnessProfile} profile
 * @param {import("./types.mjs").HarnessContext} ctx
 * @param {object} paths
 */
async function resolveOnKey(profile, ctx, paths) {
  let resolved;
  let keyVerified = false;
  if (profile.resolveOnKey) {
    resolved = await profile.resolveOnKey(ctx, paths);
  } else {
    const { apiKey, effectiveKey, reusedExistingKey, source } = await resolveHarnessOnApiKey({
      apiKey: ctx.apiKey,
      home: ctx.home,
      harnessId: profile.id,
      harnessEnvRef: profile.keyEnvRef,
      getExistingHarnessKey: profile.getExistingHarnessKey
        ? () => profile.getExistingHarnessKey(ctx, paths)
        : undefined,
    });
    resolved = { apiKeyRef: apiKey, effectiveKey, reusedExistingKey };
    keyVerified = source === "harness-local-literal";
  }
  // `--api-key` was already verified by runHarnessCommand; a harness-local
  // literal was verified inside resolveHarnessOnApiKey before its migration.
  if (!ctx.apiKeyFromFlag && !keyVerified) {
    await assertResolvedKeyNotRejected(resolved.effectiveKey, { harnessId: profile.id });
  }
  return resolved;
}

/**
 * Is this harness currently routed through Fireworks/Azure?
 *
 * The harness's own config is the source of truth: `providerStatus` reads it
 * directly, so it reflects reality even when Nexus's `enabled` flag has
 * drifted (older CLI versions, adapters that didn't maintain it, a lost or
 * reinstalled `~/.nexus`). The flag is only a fallback for when that
 * config cannot be read at all.
 *
 * This is the single definition of "on" — `off` uses it to choose
 * restore-vs-strip, and `uninstall` uses it to decide which harnesses to
 * restore at all, so the two can never disagree about a harness's state.
 *
 * Named for the real condition rather than the flag: `isHarnessEnabled` reads
 * the flag, this reads the config, and the gap between them is the whole point.
 *
 * A harness whose own provider looks the same as Nexus's (OpenCode's built-in
 * Fireworks provider) also defines `ownsRouting`: routing counts only when
 * Nexus wrote it, so `off` and `uninstall` never remove the user's own setup.
 *
 * @param {{ id: string, providerStatus?: (ctx: object) => Promise<string>, ownsRouting?: (ctx: object) => Promise<boolean> }} target
 *   a harness profile or adapter; both expose `id` and optional `providerStatus` / `ownsRouting`.
 * @param {import("./types.mjs").HarnessContext} ctx
 * @returns {Promise<boolean>}
 */
export async function isHarnessRouted(target, ctx) {
  if (typeof target.providerStatus === "function") {
    try {
      const provider = await target.providerStatus(ctx);
      if (provider !== "fireworks" && provider !== "azure") {
        return false;
      }
      return typeof target.ownsRouting === "function" ? await target.ownsRouting(ctx) : true;
    } catch {
      // Config unreadable (e.g. IDE DB locked): fall back to the flag below.
    }
  }
  return isHarnessEnabled(ctx.home, target.id);
}

/**
 * The path overrides `ctx` sets for `profile`, or none when they name its
 * default files anyway (`--config-path ~/.codex/config.toml`), so a plain
 * `off` doesn't leave a record behind.
 * @param {HarnessProfile} profile
 * @param {import("./types.mjs").HarnessContext} ctx
 */
function customPathOverrides(profile, ctx) {
  const overrides = harnessPathOverrides(ctx, profile.id);
  if (Object.keys(overrides).length === 0) return overrides;
  const files = (c) => JSON.stringify(Object.entries(profile.paths(c))
    .filter(([key, value]) => key !== "dataDir" && typeof value === "string")
    .map(([key, value]) => [key, path.resolve(value)]));
  return files(ctx) === files(withoutPathOverrides(ctx, profile.id)) ? {} : overrides;
}

/** Whether any file in `paths` exists but is neither a file nor a directory (a named pipe). */
async function hasSpecialFile(paths) {
  for (const [key, file] of Object.entries(paths)) {
    if (key === "dataDir" || typeof file !== "string" || !file) continue;
    const info = await stat(file).catch(() => null);
    if (info && !info.isFile() && !info.isDirectory()) return true;
  }
  return false;
}

/**
 * Generic `<harness> off`: back out the provider config via the profile's
 * `disable` hook (which returns an outcome), flip the enabled flag, remove the
 * shell env hook (unless the harness opts out), and print restored/unchanged.
 * `prepareOff` (stop the IDE) and `restartHintOff` are optional.
 *
 * Pass `ctx.quiet` to suppress the restored/unchanged + restart-hint narration
 * (see below); the outcome is returned either way so a caller that silences the
 * narration can still report what happened.
 * @param {HarnessProfile} profile
 * @param {import("./types.mjs").HarnessContext} ctx
 * @returns {Promise<"restored" | "stripped" | "none">}
 */
export async function engineOff(profile, ctx) {
  ensureHomeForHarness(ctx, profile.id);
  const paths = profile.paths(ctx);
  // `wasEnabled` drives restore-vs-strip in `profile.disable`.
  const wasEnabled = await isHarnessRouted(profile, ctx);
  if (profile.prepareOff) {
    await profile.prepareOff(ctx);
  }
  const outcome = await profile.disable({ ctx, paths, wasEnabled });
  const overrides = customPathOverrides(profile, ctx);
  await recordHarnessCustomPath(ctx.home, profile.id, overrides, false);
  // `off` at a custom path leaves the default config alone: while that one
  // is still routed, the harness stays enabled so a key rotation still
  // re-points it. A default file that isn't a regular file (a named pipe)
  // isn't read; the harness stays enabled, the safe side for key sync.
  const defaultCtx = withoutPathOverrides(ctx, profile.id);
  const custom = Object.keys(overrides).length > 0;
  const defaultUnreadable = custom && await hasSpecialFile(profile.paths(defaultCtx));
  const defaultStillRouted = custom && (defaultUnreadable || await isHarnessRouted(profile, defaultCtx));
  // A Fireworks default stays marked Fireworks (an Azure custom path turned
  // off mustn't leave it marked Azure, which key sync skips). Azure is never
  // set here: Pi, for one, keeps the Fireworks key next to Azure settings.
  const defaultOnFireworks = defaultStillRouted && !defaultUnreadable && typeof profile.providerStatus === "function"
    && await Promise.resolve().then(() => profile.providerStatus(defaultCtx)).catch(() => "") === "fireworks";
  await setHarnessEnabled(ctx.home, profile.id, defaultStillRouted, defaultOnFireworks ? "fireworks" : "");
  if (profile.envHookOff !== false) {
    await reconcileShellEnvHook(ctx.home);
  }
  // `ctx.quiet` suppresses the per-harness narration. Used by `uninstall`,
  // which restores every harness in one run and prints its own checklist plus a
  // single restart reminder — the per-harness lines would both duplicate that
  // and interleave with it.
  if (!ctx.quiet) {
    if (outcome === "restored" || outcome === "stripped") {
      printHarnessRestored(profile.id);
    } else {
      printHarnessUnchanged(profile.id);
    }
    if (profile.restartHintOff) {
      profile.restartHintOff(outcome, { ctx, paths });
    }
  }
  return outcome;
}

function assertProfileCapabilities(profile) {
  const capability = profile.firerouter;
  if (capability != null) {
    const validByok = typeof capability === "object"
      && (
        capability.byok === "none"
        || capability.byok === "value"
      );
    if (!validByok || typeof capability.autoCatalog !== "boolean") {
      throw new Error(
        `Harness profile ${profile.id} must define firerouter as `
          + "{ byok: \"none\"|\"value\", autoCatalog: boolean, catalogByok?: boolean } or null.",
      );
    }
    if (
      Object.hasOwn(capability, "catalogByok")
      && typeof capability.catalogByok !== "boolean"
    ) {
      throw new Error(
        `Harness profile ${profile.id} firerouter.catalogByok must be a boolean when set.`,
      );
    }
  }
  if (
    profile.azure != null
    && (
      typeof profile.azure !== "object"
      || typeof profile.azure.read !== "function"
      || typeof profile.azure.enable !== "function"
      || typeof profile.azure.restart !== "function"
    )
  ) {
    throw new Error(
      `Harness profile ${profile.id} must define azure as { read, enable, restart } or omit it.`,
    );
  }
}

/**
 * Build a HarnessAdapter from a HarnessProfile.
 * @param {HarnessProfile} profile
 * @returns {import("./types.mjs").HarnessAdapter}
 */
export function defineHarnessProfile(profile) {
  assertProfileCapabilities(profile);
  return defineHarness({
    id: profile.id,
    label: profile.label,
    resolveKey: profile.resolveKey,
    firerouter: profile.firerouter ?? null,
    azure: profile.azure ?? null,
    // Engine supplies the default flow; a profile may override when needed.
    on: profile.on ?? ((ctx) => engineOn(profile, ctx)),
    off: profile.off ?? ((ctx) => engineOff(profile, ctx)),
    status: profile.status,
    ...(profile.providerStatus ? { providerStatus: profile.providerStatus } : {}),
    ...(profile.ownsRouting ? { ownsRouting: profile.ownsRouting } : {}),
    ...(profile.keyInUse ? { keyInUse: profile.keyInUse } : {}),
    ...(profile.configuredModels ? { configuredModels: profile.configuredModels } : {}),
    ...(profile.servedOutsideCatalog ? { servedOutsideCatalog: profile.servedOutsideCatalog } : {}),
    ...(profile.usage ? { usage: profile.usage } : {}),
    ...(profile.live ? { live: profile.live } : {}),
    ...(profile.resolveOnContext ? { resolveOnContext: profile.resolveOnContext } : {}),
    // The provider-key headers this harness's config carries now, in
    // `settingsEnv` shape (see byokEnvFromHeaders).
    ...(profile.readByokEnv ? { readByokEnv: (ctx) => profile.readByokEnv(ctx, profile.paths(ctx)) } : {}),
  });
}
