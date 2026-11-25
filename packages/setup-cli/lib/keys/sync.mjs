import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { userSettingsPath } from "../harnesses/claude/core.mjs";
import { refreshFirerouterClaudeKey, removeClaudeSavedProviderKeys } from "../harnesses/claude/firerouter.mjs";
import { codexConfigPath, codexDataDir, refreshCodexGatewayKey, removeCodexSavedProviderKeys } from "../harnesses/codex/core.mjs";
import { refreshCodexUltrafastPet } from "../harnesses/codex/ultrafast.mjs";
import {
  deepseekEnvPath,
  deepseekPatchPaths,
  deepseekSettingsPath,
  refreshDeepseekGatewayKey,
  removeDeepseekSavedProviderKeys,
} from "../harnesses/deepseek/core.mjs";
import {
  hermesBackupPath,
  hermesConfigPath,
  hermesDataDir,
  hermesEnvPath,
  refreshHermesGatewayKey,
  removeHermesSavedProviderKeys,
} from "../harnesses/hermes/core.mjs";
import {
  opencodeConfigPath,
  opencodeDataDir,
  refreshOpencodeGatewayKey,
  removeOpencodeSavedProviderKeys,
} from "../harnesses/opencode/core.mjs";
import {
  piModelsPath,
  refreshPiGatewayKey,
  removePiSavedProviderKeys,
} from "../harnesses/pi/core.mjs";
import { claudeDesktopProfileUsesToken, refreshClaudeDesktopGatewayKey } from "../harnesses/claude-desktop/profile-lane.mjs";
import {
  chatLanguageModelsPath,
  isVscodeRunning,
  vscodeLocalStatePath,
  refreshVscodeGatewayKey,
  removeVscodeSavedProviderKeys,
} from "../harnesses/vscode/core.mjs";
import {
  refreshCopilotAppGatewayKey,
} from "../harnesses/copilot-app/sqlite.mjs";
import {
  copilotProvidersPath,
  refreshCopilotCliGatewayKey,
  removeCopilotCliSavedProviderKeys,
} from "../harnesses/copilot-cli/config.mjs";
import {
  FIREWORKS_API_KEY_KEYCHAIN_REF,
  readGlobalConfig,
  isEnabledFireworksHarness,
  recordHarnessCustomPath,
  writeGlobalConfig,
} from "../config/global-config.mjs";
import { HARNESS, HARNESS_COMMANDS } from "../harness/id.mjs";
import {
  claudePathsFor,
  codexPathsFor,
  copilotAppPathsFor,
  copilotCliPathsFor,
  deepseekPathsFor,
  hermesPathsFor,
  opencodePathsFor,
  pathOverrideFlags,
  piPathsFor,
  vscodePathsFor,
} from "../harness/context.mjs";
import { readJsonIfExists } from "../io/json.mjs";
import { reconcileShellEnvHook } from "../io/shell-env-hook.mjs";
import { resolveFireworksApiKeyValue, tryReadKeychainSecret } from "./api-key.mjs";
import { isEnvConfigRef, migrateLegacyGlobalApiKey } from "./config-ref.mjs";

/**
 * @param {import("../config/global-config.mjs").HarnessConfigMap} harnesses
 * @param {import("../harness/id.mjs").HarnessId} harnessId
 */
function shouldSyncFireworksHarness(harnesses, harnessId) {
  return isEnabledFireworksHarness(harnesses, harnessId);
}

/**
 * Re-point every **enabled** Fireworks-routed harness config that holds the key
 * as a baked plaintext literal (or legacy env-reference) so a `login`/rotation
 * takes effect without re-running `on`.
 *
 * Codex: only `[model_providers.fireworks-ai]` auth is updated when the active
 * route is the Fireworks gateway (`refreshCodexGatewayKey`).
 *
 * `<harness> on` is the write path when enabling: it resolves the key, writes
 * the literal into the harness config, then marks the harness enabled.
 *
 * Returns user-facing notes per harness updated (or whose update failed).
 * Never throws.
 * @param {string} home
 * @param {string} fireworksKey
 * @returns {Promise<string[]>}
 */
export async function syncBakedKeysAfterStore(home, fireworksKey) {
  return (await syncBakedKeys(home, fireworksKey)).notes;
}

/**
 * {@link syncBakedKeysAfterStore}, plus the enabled harnesses not confirmed
 * to use `fireworksKey` now: ones whose update threw, ones with nothing to
 * re-point at their default config (set up with a custom config path, or
 * routed elsewhere), and ones only `<harness> on` writes (Cursor). A
 * rotation keeps the previous key while any is left, since they may still
 * send it.
 * @param {string} home
 * @param {string} fireworksKey
 * @returns {Promise<{ notes: string[], unconfirmed: { label: string, hint: string }[] }>}
 */
export async function syncBakedKeys(home, fireworksKey) {
  if (!home || !fireworksKey?.trim()) {
    return { notes: [], unconfirmed: [] };
  }
  const { harnesses = {} } = await readGlobalConfig(home);
  const notes = [];
  const unconfirmed = [];
  const targets = keySyncTargets(home, fireworksKey);
  /** Files this run already re-pointed (or tried to), so a second record of one isn't counted twice. */
  const handled = new Set();
  for (const { id, label, hint, file, refresh, readsStoredKey } of targets) {
    if (!shouldSyncFireworksHarness(harnesses, id)) {
      continue;
    }
    if (file) handled.add(path.resolve(file));
    try {
      if (await refresh()) {
        notes.push(`Updated ${label}'s Fireworks settings with this key — restart ${label} to pick it up.`);
      } else if (!await readsStoredKey?.().catch(() => false)) {
        unconfirmed.push({ label, hint });
      }
    } catch {
      notes.push(`Couldn't update ${label}'s Fireworks settings — re-run ${hint} to use this key there.`);
      unconfirmed.push({ label, hint });
    }
  }
  await syncCustomPathCopies(home, fireworksKey, harnesses, notes, unconfirmed, handled);
  const synced = new Set(targets.map(({ id }) => id));
  for (const id of Object.keys(harnesses)) {
    if (!synced.has(id) && shouldSyncFireworksHarness(harnesses, id)) {
      const label = HARNESS_COMMANDS.find((entry) => entry.command === id)?.name ?? id;
      unconfirmed.push({ label, hint: `nexus ${id} on` });
    }
  }
  return { notes, unconfirmed };
}

/**
 * The harnesses whose saved copy of the key a store re-points, and how. Paths
 * come from the same helpers `on` uses, so `overrides` (a harness's recorded
 * `--config-path` and friends) re-point exactly the file `on` wrote.
 * `file` and `also` list every file a target's refresh reads, so a custom
 * copy whose files aren't all regular files can be refused before a read
 * blocks on one.
 * @param {string} home
 * @param {string} fireworksKey
 * @param {Record<string, string>} [overrides]
 */
function keySyncTargets(home, fireworksKey, overrides = {}) {
  const ctx = { home, ...overrides };
  return [
    {
      id: HARNESS.CLAUDE,
      label: "Claude Code",
      hint: "nexus claude",
      file: claudePathsFor(ctx).settingsPath,
      refresh: () => refreshFirerouterClaudeKey({ settingsPath: claudePathsFor(ctx).settingsPath, fireworksKey }),
    },
    {
      id: HARNESS.CODEX,
      label: "Codex",
      hint: "nexus codex on",
      file: codexPathsFor(ctx).configPath,
      refresh: async () => {
        const { configPath } = codexPathsFor(ctx);
        const changed = await refreshCodexGatewayKey({ configPath, fireworksKey });
        // The pet and footer cache follow the account the key belongs to.
        if (changed) await refreshCodexUltrafastPet({ configPath, apiKey: fireworksKey });
        return changed;
      },
    },
    {
      id: HARNESS.PI,
      label: "Pi",
      hint: "nexus pi on",
      file: piPathsFor(ctx).authPath,
      refresh: () => refreshPiGatewayKey({ authPath: piPathsFor(ctx).authPath, fireworksKey }),
    },
    {
      id: HARNESS.OPENCODE,
      label: "OpenCode",
      hint: "nexus opencode on",
      file: opencodePathsFor(ctx).configPath,
      refresh: () => refreshOpencodeGatewayKey({ configPath: opencodePathsFor(ctx).configPath, fireworksKey }),
    },
    {
      id: HARNESS.DEEPSEEK,
      label: "DeepSeek Harness",
      hint: "nexus deepseek on",
      file: deepseekPathsFor(ctx).settingsPath,
      also: async () => [
        deepseekPathsFor(ctx).credentialsPath,
        deepseekEnvPath(deepseekPathsFor(ctx).credentialsPath),
        ...await deepseekPatchPaths(deepseekPathsFor(ctx).settingsPath),
      ],
      refresh: () => {
        const { settingsPath, credentialsPath } = deepseekPathsFor(ctx);
        return refreshDeepseekGatewayKey({ settingsPath, credentialsPath, fireworksKey });
      },
    },
    {
      id: HARNESS.HERMES,
      label: "Hermes Agent",
      hint: "nexus hermes on",
      file: hermesPathsFor(ctx).configPath,
      also: [
        hermesEnvPath(hermesPathsFor(ctx).configPath),
        hermesBackupPath(hermesPathsFor(ctx).dataDir, hermesPathsFor(ctx).configPath),
      ],
      // The backup there records a checksum the refresh keeps in step.
      refresh: () => refreshHermesGatewayKey({
        configPath: hermesPathsFor(ctx).configPath,
        dataDir: hermesPathsFor(ctx).dataDir,
        fireworksKey,
      }),
    },
    {
      id: HARNESS.COPILOT_APP,
      label: "Copilot app",
      hint: "nexus copilot-app on",
      file: copilotAppPathsFor(ctx).dbPath,
      refresh: () => refreshCopilotAppGatewayKey({ dbPath: copilotAppPathsFor(ctx).dbPath, fireworksKey }),
    },
    {
      id: HARNESS.COPILOT_CLI,
      label: "Copilot CLI",
      hint: "nexus copilot-cli on",
      file: copilotCliPathsFor(ctx).providersPath,
      refresh: () => refreshCopilotCliGatewayKey({ providersPath: copilotCliPathsFor(ctx).providersPath, fireworksKey }),
    },
    {
      id: HARNESS.VSCODE,
      label: "VS Code",
      hint: "nexus vscode on",
      file: vscodePathsFor(ctx).vscodePath,
      also: [vscodePathsFor(ctx).stateDbPath, vscodeLocalStatePath({ vscodePath: vscodePathsFor(ctx).vscodePath })],
      refresh: () => refreshVscodeGatewayKey({ vscodePath: vscodePathsFor(ctx).vscodePath, fireworksKey }),
    },
    {
      id: HARNESS.CLAUDE_DESKTOP,
      label: "Claude Desktop",
      hint: "nexus claude-desktop on",
      refresh: () => refreshClaudeDesktopGatewayKey({ home, fireworksKey }),
      // A token profile holds no key: the local proxy reads the stored one.
      readsStoredKey: () => claudeDesktopProfileUsesToken(home),
    },
  ];
}

/**
 * Harnesses whose per-config backup records the file it snapshotted. A
 * backup exists while Nexus is connected at that file, so it also finds a
 * custom path connected before `customPaths` was recorded.
 */
const BACKED_UP_CONFIGS = {
  [HARNESS.CODEX]: { dataDir: codexDataDir, configPath: codexConfigPath },
  [HARNESS.OPENCODE]: { dataDir: (home) => opencodeDataDir(home, ""), configPath: opencodeConfigPath },
  [HARNESS.HERMES]: { dataDir: hermesDataDir, configPath: hermesConfigPath },
};

async function isRegularFile(file) {
  return (await stat(file).catch(() => null))?.isFile() === true;
}

async function anyExists(files) {
  for (const file of files) {
    // lstat: a dangling symlink still counts as something there. Only "no
    // such file" means gone: any other error (EACCES on an unreadable
    // folder, say) may hide a file that still holds the old key.
    const missing = await lstat(file).then(() => false, (error) => ["ENOENT", "ENOTDIR"].includes(error?.code));
    if (!missing) return true;
  }
  return false;
}

function sameOverrides(a, b) {
  const key = (overrides) => JSON.stringify(Object.entries(overrides).sort());
  return key(a) === key(b);
}

async function anyNonRegularFile(files) {
  for (const file of files) {
    if (!file) continue;
    const info = await stat(file).catch(() => null);
    if (info && !info.isFile()) return true;
  }
  return false;
}

/** A path as printed in a note: control characters (terminal escapes) shown as "?". */
function printable(text) {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

/**
 * The non-default configs a harness's backups say Nexus is connected at.
 * Never throws.
 * @param {string} home
 * @param {string} harnessId
 * @returns {Promise<Record<string, string>[]>}
 */
async function backedUpCustomConfigs(home, harnessId) {
  const layout = BACKED_UP_CONFIGS[harnessId];
  if (!layout) return [];
  const dir = layout.dataDir(home);
  const defaultConfig = path.resolve(layout.configPath(home, ""));
  const names = await readdir(dir).catch(() => []);
  const found = [];
  for (const name of names) {
    if (!/^config-backup\.[0-9a-f]{16}\.json$/.test(name)) continue;
    // Only a regular file: reading a named pipe would block sign-in.
    if (!await isRegularFile(path.join(dir, name))) continue;
    const backup = await readJsonIfExists(path.join(dir, name)).catch(() => ({}));
    const configPath = backup?.configPath;
    if (typeof configPath === "string" && path.isAbsolute(configPath) && path.resolve(configPath) !== defaultConfig) {
      found.push({ configPath: path.resolve(configPath) });
    }
  }
  return found;
}

/**
 * Re-point each non-default config a harness is connected at: the paths `on`
 * recorded plus any its backups name. A copy that can't be confirmed to hold
 * `fireworksKey` afterwards is reported in `unconfirmed`, so a rotation keeps
 * the previous key. Never throws.
 * @param {string} home
 * @param {string} fireworksKey
 * @param {import("../config/global-config.mjs").HarnessConfigMap} harnesses
 * @param {string[]} notes
 * @param {{ label: string, hint: string }[]} unconfirmed
 * @param {Set<string>} handled files already re-pointed this run
 */
async function syncCustomPathCopies(home, fireworksKey, harnesses, notes, unconfirmed, handled) {
  const ids = new Set([...Object.keys(harnesses), ...Object.keys(BACKED_UP_CONFIGS)]);
  for (const id of ids) {
    // Not skipped when the harness's default config is on Azure: a recorded
    // copy elsewhere can still hold the Fireworks key.
    const seen = new Set();
    const copies = [...(harnesses[id]?.customPaths ?? []), ...await backedUpCustomConfigs(home, id)]
      .filter((overrides) => {
        const key = JSON.stringify(Object.entries(overrides).sort());
        return !seen.has(key) && seen.add(key);
      });
    for (const overrides of copies) {
      const target = keySyncTargets(home, fireworksKey, overrides).find((candidate) => candidate.id === id);
      const label = target?.label ?? HARNESS_COMMANDS.find((entry) => entry.command === id)?.name ?? id;
      const hint = printable(`${target?.hint ?? `nexus ${id} on`} ${pathOverrideFlags(overrides)}`);
      const file = printable(Object.values(overrides)[0]);
      if (!target) {
        unconfirmed.push({ label, hint });
        continue;
      }
      // This run already re-pointed that file: the default pass did (a
      // `--config-path` can name the default file, and Pi shares one auth
      // file per directory), or another record names it.
      const key = target.file ? path.resolve(target.file) : "";
      if (key && handled.has(key)) continue;
      if (key) handled.add(key);
      const also = typeof target.also === "function" ? await target.also() : target.also;
      const files = [target.file, ...(also ?? [])].filter(Boolean);
      // None of its files exist (the project was deleted, say): no copy of
      // the key is left there. Drop the record, rather than keep every
      // rotation's old key for it, and say so.
      if (files.length > 0 && !await anyExists(files)) {
        const recorded = (harnesses[id]?.customPaths ?? []).some((item) => sameOverrides(item, overrides));
        if (recorded) {
          await recordHarnessCustomPath(home, id, overrides, false).catch(() => {});
          notes.push(`Forgot ${label}'s config at ${file}: the file is gone.`);
        }
        continue;
      }
      // Only regular files (or none, which the refresh reports): a named pipe
      // at a recorded path, or next to it, would block sign-in on its read.
      if (await anyNonRegularFile(files)) {
        unconfirmed.push({ label, hint });
        continue;
      }
      try {
        if (await target.refresh()) {
          notes.push(`Updated ${label}'s Fireworks settings in ${file} with this key — restart ${label} to pick it up.`);
        } else {
          unconfirmed.push({ label, hint });
        }
      } catch {
        notes.push(`Couldn't update ${label}'s Fireworks settings in ${file} — re-run ${hint} to use this key there.`);
        unconfirmed.push({ label, hint });
      }
    }
  }
}

/**
 * Remove saved provider keys (`x-anthropic-api-key`, `x-openai-api-key`) from
 * every enabled Fireworks harness that bakes them into its own config, so a
 * repeat `on` can't read them back. Never throws.
 *
 * `skipRunningIdes` leaves an IDE that is open alone (it rewrites its config
 * from memory and would drop the edit), reporting it in `skipped` only when
 * it still holds one of `headerNames`.
 * @param {string} home
 * @param {string[]} headerNames
 * @param {{ skipRunningIdes?: boolean, vscodeRunning?: () => boolean }} [options]
 * @returns {Promise<{ updated: string[], failed: { label: string, id: string }[], skipped: { label: string, id: string }[] }>}
 */
export async function removeSavedProviderKeysFromHarnesses(home, headerNames, {
  skipRunningIdes = false,
  vscodeRunning = isVscodeRunning,
  includeDisabled = false,
} = {}) {
  const { harnesses } = await readGlobalConfig(home);
  const targets = [
    {
      id: HARNESS.CLAUDE,
      label: "Claude Code",
      remove: () => removeClaudeSavedProviderKeys({ settingsPath: userSettingsPath(home), headerNames }),
    },
    {
      id: HARNESS.CODEX,
      label: "Codex",
      remove: () => removeCodexSavedProviderKeys({ configPath: codexConfigPath(home), headerNames }),
    },
    {
      id: HARNESS.OPENCODE,
      label: "OpenCode",
      remove: () => removeOpencodeSavedProviderKeys({ configPath: opencodeConfigPath(home, ""), headerNames }),
    },
    {
      id: HARNESS.PI,
      label: "Pi",
      remove: () => removePiSavedProviderKeys({ modelsPath: piModelsPath(home), headerNames }),
    },
    {
      id: HARNESS.VSCODE,
      label: "VS Code",
      remove: () => removeVscodeSavedProviderKeys({ filePath: chatLanguageModelsPath({ home }), headerNames }),
      pending: () => removeVscodeSavedProviderKeys({ filePath: chatLanguageModelsPath({ home }), headerNames, dryRun: true }),
      running: vscodeRunning,
    },
    {
      id: HARNESS.COPILOT_CLI,
      label: "Copilot CLI",
      remove: () => removeCopilotCliSavedProviderKeys({ providersPath: copilotProvidersPath({ home }), headerNames }),
    },
    {
      id: HARNESS.DEEPSEEK,
      label: "DeepSeek Harness",
      remove: () => removeDeepseekSavedProviderKeys({ settingsPath: deepseekSettingsPath(home), headerNames }),
    },
    {
      id: HARNESS.HERMES,
      label: "Hermes Agent",
      remove: () => removeHermesSavedProviderKeys({
        configPath: hermesConfigPath(home),
        dataDir: hermesDataDir(home),
        headerNames,
      }),
    },
  ];
  const updated = [];
  const failed = [];
  const skipped = [];
  for (const { id, label, remove, pending, running } of targets) {
    // Unset scrubs any harness Nexus knows about, enabled or not: a baked
    // key copy in a disabled harness's file is still a live credential on
    // disk. Never-installed harnesses (no entry) stay untouched.
    const known = includeDisabled && harnesses && Object.hasOwn(harnesses, id);
    if (!shouldSyncFireworksHarness(harnesses, id) && !known) {
      continue;
    }
    try {
      if (skipRunningIdes && running?.()) {
        if (await pending()) {
          skipped.push({ id, label });
        }
        continue;
      }
      if (await remove()) {
        updated.push(label);
      }
    } catch {
      failed.push({ id, label });
    }
  }
  return { updated, failed, skipped };
}

/**
 * Post-upgrade key reconciliation: rebake every enabled Fireworks harness
 * config to plaintext literals (including legacy env-reference auth), repair
 * a stale global `{env:FIREWORKS_API_KEY}` ref when keychain holds the secret,
 * and reconcile the shell hook (dropping the legacy Codex provider-key exports).
 *
 * Key-independent harness migrations live in `system/forward-migrations.mjs`.
 * Never throws.
 * @param {string} home
 * @returns {Promise<string[]>}
 */
export async function reconcileHarnessConfigOnUpgrade(home) {
  if (!home) {
    return [];
  }
  const notes = [];
  try {
    await migrateLegacyGlobalApiKey(home);
  } catch {
    // Best-effort: upgrade finalize must not abort after the git reset.
  }
  try {
    const fromKeychain = await tryReadKeychainSecret(home);
    if (fromKeychain) {
      const config = await readGlobalConfig(home);
      if (isEnvConfigRef(config.apiKey)) {
        await writeGlobalConfig(home, { apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF });
      }
    }
  } catch {
    // Best-effort config repair — rebake may still use the keychain secret directly.
  }
  let key = "";
  try {
    key = (await tryReadKeychainSecret(home))?.trim()
      || (await resolveFireworksApiKeyValue({ home }));
  } catch {
    return notes;
  }
  if (key) {
    notes.push(...await syncBakedKeysAfterStore(home, key));
  }
  try {
    await reconcileShellEnvHook(home);
  } catch {
    // Best-effort shell reconcile — never fail upgrade over ~/.bashrc I/O.
  }
  return notes;
}
