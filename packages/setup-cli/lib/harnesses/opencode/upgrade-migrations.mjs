import { existsSync } from "node:fs";
import path from "node:path";

import { isHarnessEnabled, readGlobalConfig } from "../../config/global-config.mjs";
import { dropRetiredModelId, fullFireworksResourceId, isRetiredModelId } from "../../fireworks/model-id.mjs";
import { refreshModelsDevFireworksRegistry } from "../../fireworks/models-dev-registry.mjs";
import { HARNESS } from "../../harness/id.mjs";
import {
  OPENCODE_FIREWORKS_PROVIDER_ID,
  OPENCODE_MANAGED_PROVIDER_IDS,
  opencodeConfigPath,
  opencodeProviderStatus,
  opencodeCurrentModelId,
  opencodeProviderModelKey,
  readRawIfExists,
  withAuthoredOpencodeReasoningEffort,
  withOpencodeReasoningEffort,
  withoutModelsDevDuplicates,
  writeOpencodeConfig,
} from "./core.mjs";
import { opencodePluginDir, refreshOpencodePluginIfStale } from "./nexus-plugin.mjs";
import { CONFIG_HINT_FILE, opencodeConfigPathFor, readConfigFile } from "./nexus-plugin/ultrafast.mjs";
import { mirrorOpencodeV2Providers } from "./providers-v2.mjs";

/**
 * The default opencode.json of an enabled harness, when Nexus routes it
 * through one of the given statuses.
 * @param {string} home
 * @param {ReadonlyArray<string>} statuses
 */
async function readRoutedOpencodeConfig(home, statuses) {
  if (!home || !await isHarnessEnabled(home, HARNESS.OPENCODE)) {
    return null;
  }
  const configPath = opencodeConfigPath(home);
  const snapshot = await readRawIfExists(configPath);
  if (!snapshot.existed || !snapshot.raw.trim()) {
    return null;
  }
  const config = JSON.parse(snapshot.raw);
  return statuses.includes(opencodeProviderStatus(config)) ? { configPath, config } : null;
}

/**
 * Releases through 0.9.9 wrote only `provider`, which OpenCode v2 discards
 * when the same file has a native `providers[id]`. Mirror the managed entries
 * into an existing `providers` map of a Nexus-routed config.
 * @param {string} home
 * @returns {Promise<boolean>} true when opencode.json was updated
 */
export async function migrateOpencodeV2ProvidersOnUpgrade(home) {
  const routed = await readRoutedOpencodeConfig(home, ["fireworks", "azure"]);
  if (!routed) {
    return false;
  }
  const mirrored = mirrorOpencodeV2Providers(routed.config, OPENCODE_MANAGED_PROVIDER_IDS);
  if (JSON.stringify(mirrored) === JSON.stringify(routed.config)) {
    return false;
  }
  await writeOpencodeConfig(routed.configPath, routed.config);
  return true;
}

/**
 * Move a Nexus-routed OpenCode install off FireRouter on upgrade: a
 * `model` selection naming a FireRouter route becomes the `auto` mix.
 * Provider model rows are left for the next `on`'s catalog refresh.
 * @param {string} home
 * @returns {Promise<boolean>} true when opencode.json was updated
 */
export async function migrateOpencodeFirerouterOnUpgrade(home) {
  const routed = await readRoutedOpencodeConfig(home, ["fireworks"]);
  if (!routed) {
    return false;
  }
  const { config, configPath } = routed;
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  // Re-`on` also recognizes the older `fireworks/` prefix, so a stored
  // selection may carry either spelling; both rewrite to the canonical one.
  const ref = typeof config.model === "string" && config.model.startsWith(prefix)
    ? config.model.slice(prefix.length)
    : typeof config.model === "string" && config.model.startsWith("fireworks/")
      ? config.model.slice("fireworks/".length)
      : "";
  const migrated = dropRetiredModelId(ref);
  const provider = config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID];
  const models = provider?.models && typeof provider.models === "object" && !Array.isArray(provider.models)
    ? provider.models
    : {};
  const keptModels = Object.fromEntries(
    Object.entries(models).filter(([id]) => !isRetiredModelId(id)),
  );
  const modelChanged = Boolean(ref) && migrated !== ref;
  const rowsChanged = Object.keys(keptModels).length !== Object.keys(models).length;
  if (!modelChanged && !rowsChanged) {
    return false;
  }
  // Provider-key headers stay: Nexus Auto reads them now.
  await writeOpencodeConfig(configPath, {
    ...config,
    ...(modelChanged ? { model: `${prefix}${migrated}` } : {}),
    provider: {
      ...config.provider,
      [OPENCODE_FIREWORKS_PROVIDER_ID]: {
        ...provider,
        models: keptModels,
      },
    },
  });
  return true;
}

/**
 * Earlier releases wrote Auto and catalog-missing model rows without
 * `reasoning: true`, so OpenCode 1.x sent no `reasoning_effort` for the
 * effort a user picked. Add the flag to Auto, to models the reasoning
 * table lists, and to the currently selected model (the row Nexus manages
 * for this config, listed or not); values the user set stay as written.
 * A config without an Auto row is left to the auto backfill.
 * @param {string} home
 * @returns {Promise<boolean>} true when opencode.json was updated
 */
export async function migrateOpencodeReasoningEffortOnUpgrade(home) {
  const routed = await readRoutedOpencodeConfig(home, ["fireworks"]);
  const provider = routed?.config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID];
  const models = provider?.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    return false;
  }
  const next = Object.fromEntries(Object.entries(models)
    .map(([id, entry]) => [id, withOpencodeReasoningEffort(id, entry, provider.npm)]));
  const selected = routed ? opencodeCurrentModelId(routed.config) : null;
  const selectedKey = selected ? opencodeProviderModelKey(selected) : "";
  if (selectedKey && next[selectedKey]) {
    next[selectedKey] = withAuthoredOpencodeReasoningEffort(selectedKey, next[selectedKey], provider.npm);
  }
  if (Object.entries(models).every(([id, entry]) => next[id] === entry)) {
    return false;
  }
  const { config, configPath } = routed;
  await writeOpencodeConfig(configPath, {
    ...config,
    provider: { ...config.provider, [OPENCODE_FIREWORKS_PROVIDER_ID]: { ...provider, models: next } },
  });
  return true;
}

/**
 * Releases through 0.9.9 overrode router aliases under short keys that
 * models.dev now also lists, so OpenCode's `/models` showed them twice. Drop
 * those rows and point a default at a dropped key to its models.dev id. Without
 * the models.dev registry (offline), nothing changes.
 * @param {string} home
 * @returns {Promise<boolean>} true when opencode.json was updated
 */
export async function migrateOpencodePickerDuplicatesOnUpgrade(home) {
  const routed = await readRoutedOpencodeConfig(home, ["fireworks"]);
  const provider = routed?.config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID];
  const current = provider?.models;
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    return false;
  }
  if (!Object.keys(current).some((id) => fullFireworksResourceId(id) !== id)) {
    return false;
  }
  await refreshModelsDevFireworksRegistry();
  const models = withoutModelsDevDuplicates(current);
  if (Object.keys(models).length === Object.keys(current).length) {
    return false;
  }
  const { config, configPath } = routed;
  const prefix = `${OPENCODE_FIREWORKS_PROVIDER_ID}/`;
  // Re-`on` also recognizes the older `fireworks/` prefix, so a stored
  // selection may carry either spelling; both rewrite to the canonical one.
  const ref = typeof config.model === "string" && config.model.startsWith(prefix)
    ? config.model.slice(prefix.length)
    : typeof config.model === "string" && config.model.startsWith("fireworks/")
      ? config.model.slice("fireworks/".length)
      : "";
  const model = Object.hasOwn(current, ref) && !Object.hasOwn(models, ref)
    ? `${prefix}${fullFireworksResourceId(ref)}`
    : config.model;
  await writeOpencodeConfig(configPath, {
    ...config,
    model,
    provider: { ...config.provider, [OPENCODE_FIREWORKS_PROVIDER_ID]: { ...provider, models } },
  });
  return true;
}

/**
 * Refresh the Nexus plugin folders of Fireworks-routed OpenCode configs when
 * this release ships different plugin files (e.g. the Ultra-fast banner), so
 * an upgrade alone brings them in. Covers the default config and every
 * `on --config-path` config Nexus recorded; each folder is refreshed for the
 * config its hint names, so it keeps its key source.
 * @param {string} home
 * @returns {Promise<boolean>} true when a plugin folder was updated
 */
export async function migrateOpencodePluginOnUpgrade(home) {
  if (!home) {
    return false;
  }
  const recorded = ((await readGlobalConfig(home)).harnesses[HARNESS.OPENCODE]?.customPaths ?? [])
    .map((overrides) => overrides?.configPath)
    .filter((value) => typeof value === "string" && value);
  const candidates = [
    ...(await isHarnessEnabled(home, HARNESS.OPENCODE) ? [opencodeConfigPath(home)] : []),
    ...recorded,
  ];
  let refreshed = false;
  const unreadable = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const dir = opencodePluginDir(candidate);
    if (seen.has(dir)) continue;
    seen.add(dir);
    const hinted = await opencodeConfigPathFor(dir);
    // No hint is an install from before hints: refresh it for its own config.
    // A hint that's there but unreadable (not a small regular file, or bad
    // JSON) can't say which config it served, so say so instead of guessing.
    if (!hinted && existsSync(path.join(dir, CONFIG_HINT_FILE))) {
      unreadable.push(path.join(dir, CONFIG_HINT_FILE));
      continue;
    }
    const configPath = hinted ?? candidate;
    // The same bounded, non-blocking reader the plugin uses: a recorded
    // config (possibly in a project folder) that became a FIFO, a device or
    // a huge file can't hang or flood the upgrade. Gone: nothing to refresh.
    // Not a small regular file: reported, as for a hint.
    if (!existsSync(configPath)) continue;
    let raw = "";
    try {
      raw = await readConfigFile(configPath);
    } catch {
      unreadable.push(configPath);
      continue;
    }
    if (!raw.trim()) continue;
    let status = "";
    try {
      status = opencodeProviderStatus(JSON.parse(raw));
    } catch {
      continue; // bad JSON is the user's to fix; the others still refresh
    }
    if (status !== "fireworks") continue;
    if (await refreshOpencodePluginIfStale(configPath)) refreshed = true;
  }
  // After the others refreshed: the upgrade's failure note asks for `on`.
  if (unreadable.length) throw new Error(`can't read ${unreadable.join(", ")}`);
  return refreshed;
}
