import { userSettingsPath } from "../harnesses/claude/core.mjs";
import { refreshFirerouterClaudeKey, removeClaudeSavedProviderKeys } from "../harnesses/claude/firerouter.mjs";
import { codexConfigPath, refreshCodexGatewayKey, removeCodexSavedProviderKeys } from "../harnesses/codex/core.mjs";
import {
  deepseekCredentialsPath,
  deepseekSettingsPath,
  refreshDeepseekGatewayKey,
  removeDeepseekSavedProviderKeys,
} from "../harnesses/deepseek/core.mjs";
import {
  hermesConfigPath,
  hermesDataDir,
  refreshHermesGatewayKey,
  removeHermesSavedProviderKeys,
} from "../harnesses/hermes/core.mjs";
import {
  opencodeConfigPath,
  refreshOpencodeGatewayKey,
  removeOpencodeSavedProviderKeys,
} from "../harnesses/opencode/core.mjs";
import {
  piAuthPath,
  piModelsPath,
  refreshPiGatewayKey,
  removePiSavedProviderKeys,
} from "../harnesses/pi/core.mjs";
import { claudeDesktopProfileUsesToken, refreshClaudeDesktopGatewayKey } from "../harnesses/claude-desktop/profile-lane.mjs";
import {
  chatLanguageModelsPath,
  isVscodeRunning,
  refreshVscodeGatewayKey,
  removeVscodeSavedProviderKeys,
} from "../harnesses/vscode/core.mjs";
import {
  copilotDataDbPath,
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
  writeGlobalConfig,
} from "../config/global-config.mjs";
import { HARNESS, HARNESS_COMMANDS } from "../harness/id.mjs";
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
  for (const { id, label, hint, refresh, readsStoredKey } of targets) {
    if (!shouldSyncFireworksHarness(harnesses, id)) {
      continue;
    }
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
 * The harnesses whose saved copy of the key a store re-points, and how.
 * @param {string} home
 * @param {string} fireworksKey
 */
function keySyncTargets(home, fireworksKey) {
  const opencodeConfig = opencodeConfigPath(home, "");
  const codexConfig = codexConfigPath(home, "");
  const deepseekSettings = deepseekSettingsPath(home, "");
  const deepseekCredentials = deepseekCredentialsPath(home);
  return [
    {
      id: HARNESS.CLAUDE,
      label: "Claude Code",
      hint: "nexus claude",
      refresh: () => refreshFirerouterClaudeKey({ settingsPath: userSettingsPath(home), fireworksKey }),
    },
    {
      id: HARNESS.CODEX,
      label: "Codex",
      hint: "nexus codex on",
      refresh: () => refreshCodexGatewayKey({ configPath: codexConfig, fireworksKey }),
    },
    {
      id: HARNESS.PI,
      label: "Pi",
      hint: "nexus pi on",
      refresh: () => refreshPiGatewayKey({ authPath: piAuthPath(home), fireworksKey }),
    },
    {
      id: HARNESS.OPENCODE,
      label: "OpenCode",
      hint: "nexus opencode on",
      refresh: () => refreshOpencodeGatewayKey({ configPath: opencodeConfig, fireworksKey }),
    },
    {
      id: HARNESS.DEEPSEEK,
      label: "DeepSeek Harness",
      hint: "nexus deepseek on",
      refresh: () => refreshDeepseekGatewayKey({
        settingsPath: deepseekSettings,
        credentialsPath: deepseekCredentials,
        fireworksKey,
      }),
    },
    {
      id: HARNESS.HERMES,
      label: "Hermes Agent",
      hint: "nexus hermes on",
      refresh: () => refreshHermesGatewayKey({
        configPath: hermesConfigPath(home),
        dataDir: hermesDataDir(home),
        fireworksKey,
      }),
    },
    {
      id: HARNESS.COPILOT_APP,
      label: "Copilot app",
      hint: "nexus copilot-app on",
      refresh: () => refreshCopilotAppGatewayKey({ dbPath: copilotDataDbPath({ home }), fireworksKey }),
    },
    {
      id: HARNESS.COPILOT_CLI,
      label: "Copilot CLI",
      hint: "nexus copilot-cli on",
      refresh: () => refreshCopilotCliGatewayKey({ providersPath: copilotProvidersPath({ home }), fireworksKey }),
    },
    {
      id: HARNESS.VSCODE,
      label: "VS Code",
      hint: "nexus vscode on",
      refresh: () => refreshVscodeGatewayKey({ vscodePath: chatLanguageModelsPath({ home }), fireworksKey }),
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
