import { mkdtemp, readFile, writeFile, mkdir, access, lstat, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { userSettingsPath } from "../../lib/harnesses/claude/core.mjs";
import { thirdPartyDir } from "../../lib/harnesses/claude-desktop/profile-lane.mjs";
import { opencodeBackupPath, opencodeConfigPath, opencodeDataDir } from "../../lib/harnesses/opencode/core.mjs";
import { piAuthPath, piModelsPath, piSettingsPath } from "../../lib/harnesses/pi/core.mjs";
import { codexBackupPath, codexConfigPath, codexDataDir, CODEX_CATALOG_TOML_REF } from "../../lib/harnesses/codex/core.mjs";
import { patchCodexCatalogRefRaw } from "../../lib/harnesses/codex/toml-patch.mjs";
import { globalConfigPath, writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { writeJson } from "../../lib/io/json.mjs";
import { isolatedProfileEnv, runCli, runFireconnect, supportsVscodeSqlite, withIsolatedProfileEnv, withTempHome } from "../helpers.mjs";
import { fileURLToPath } from "node:url";
import * as registry from "../../lib/harness/registry.mjs";
import { HARNESS } from "../../lib/harness/id.mjs";
import { runUninstallCommand } from "../../lib/cli/commands/global.mjs";
import { vscodeDataDir, vscodeStateDbPath, writeVscodeBackup } from "../../lib/harnesses/vscode/core.mjs";
import { detectVscodeInstall } from "../../lib/harnesses/vscode/install.mjs";
import { ensureItemTable, readItemTableValue, writeItemTableValue } from "../../lib/harnesses/vscode/vscdb-sqlite.mjs";
import { appUserDataDir } from "../../lib/io/user-data-dir.mjs";

const hasVscodeSqlite = await supportsVscodeSqlite();

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("uninstall", () => {
  it("does not discover VS Code profiles under the parent process's app data roots", async () => {
    await withTempHome("uninstall-parent-profile-", async (parentHome) => {
      const env = isolatedProfileEnv(parentHome);
      const profilePath = path.join(appUserDataDir(parentHome, "Code - Insiders", { env }), "User", "chatLanguageModels.json");
      await mkdir(path.dirname(profilePath), { recursive: true });
      await writeFile(profilePath, "not valid JSON");

      await withTempHome("uninstall-isolated-profile-", async (home) => {
        const result = await withIsolatedProfileEnv(parentHome, () => runFireconnect(["uninstall", "--force"], { HOME: home }));
        assert.equal(result.code, 0, result.stderr);
        assert.equal(await readFile(profilePath, "utf8"), "not valid JSON");
      });
    });
  });

  for (const platform of ["win32", "linux", "darwin"]) {
    const restoresStandardProfiles = platform === "win32";
    const scope = restoresStandardProfiles ? "the explicit and standard" : "only the explicit";
    it(`${platform}: uninstall --vscode-path restores ${scope} VS Code profiles and clears the install directory`, { skip: !hasVscodeSqlite }, async () => {
      await withTempHome("uninstall-vscode-explicit-profile-", async (home) => {
        const env = isolatedProfileEnv(home);
        const vscodePath = path.join(home, "custom", "User", "chatLanguageModels.json");
        const standardPaths = ["Code", "Code - Insiders"].map((folder) =>
          path.join(appUserDataDir(home, folder, { env }), "User", "chatLanguageModels.json"));
        const original = '[{"name":"User provider"}]\n';
        const routed = '[{"apiKey":"${input:chat.lm.secret.fw-abcdef}"}]';
        const secretId = "chat.lm.secret.fw-abcdef";
        const secretKey = `secret://${secretId}`;
        const profilePaths = [vscodePath, ...standardPaths];
        for (const profilePath of profilePaths) {
          await mkdir(path.dirname(profilePath), { recursive: true });
          await writeFile(profilePath, routed);
          const dbPath = vscodeStateDbPath({ vscodePath: profilePath });
          await ensureItemTable(dbPath);
          await writeItemTableValue(dbPath, secretKey, "test-value");
          await writeVscodeBackup(vscodeDataDir(home), profilePath, {
            fileExisted: true, fileRaw: original, secretIds: [secretId],
          });
        }
        await writeFile(path.join(home, ".nexus", "update-check.json"), "{}");

        await withIsolatedProfileEnv(home, () => runUninstallCommand(
          { home, platform, vscodePath, force: true }, { checkProcesses: async () => {} },
        ));
        for (const profilePath of profilePaths) {
          const shouldRestore = restoresStandardProfiles || profilePath === vscodePath;
          assert.equal(await readFile(profilePath, "utf8"), shouldRestore ? original : routed, profilePath);
          assert.equal(await readItemTableValue(vscodeStateDbPath({ vscodePath: profilePath }), secretKey), shouldRestore ? "" : "test-value", profilePath);
        }
        await assert.rejects(lstat(path.join(home, ".nexus")), { code: "ENOENT" });
      });
    });
  }

  for (const state of ["backup and marker", "backup only", "marker only"]) {
    it(`win32: restores the non-default VS Code profile with ${state} before removing Nexus state`, { skip: !hasVscodeSqlite }, async () => {
      await withTempHome("uninstall-vscode-profiles-", async (home) => {
        const env = isolatedProfileEnv(home);
        const selected = detectVscodeInstall(undefined, { env, home })?.folder || "Code";
        const other = selected === "Code" ? "Code - Insiders" : "Code";
        const modelsPath = (folder) => path.join(appUserDataDir(home, folder, { env }), "User", "chatLanguageModels.json");
        const selectedPath = modelsPath(selected);
        const otherPath = modelsPath(other);
        const dbPath = vscodeStateDbPath({ vscodePath: otherPath });
        const original = '[{"name":"User provider"}]\n';
        const selectedOriginal = '[{"name":"Default profile provider"}]\n';
        const secretId = "chat.lm.secret.fw-abcdef";
        const secretKey = `secret://${secretId}`;
        await mkdir(path.dirname(selectedPath), { recursive: true });
        await mkdir(path.dirname(otherPath), { recursive: true });
        await writeFile(selectedPath, selectedOriginal);
        const entries = JSON.parse(original);
        if (state !== "backup only") entries.push({ apiKey: "${input:chat.lm.secret.fw-abcdef}" });
        await writeFile(otherPath, JSON.stringify(entries));
        const dataDir = vscodeDataDir(home);
        if (state !== "marker only") {
          await writeVscodeBackup(dataDir, otherPath, { fileExisted: true, fileRaw: original, secretIds: [secretId] });
        }
        await ensureItemTable(dbPath);
        await writeItemTableValue(dbPath, secretKey, "test-value");

        await withIsolatedProfileEnv(home, async () => {
          for (const platform of ["linux", "darwin"]) {
            const ids = await registry.listHarnessIdsToRestore({ platform }, home);
            assert.ok(!ids.includes(HARNESS.VSCODE), platform);
          }
          await runUninstallCommand({ home, platform: "win32", force: true }, { checkProcesses: async () => {} });
        });
        const restored = await readFile(otherPath, "utf8");
        if (state !== "marker only") assert.equal(restored, original);
        assert.deepEqual(JSON.parse(restored), JSON.parse(original));
        assert.equal(await readItemTableValue(dbPath, secretKey), "");
        assert.equal(await readFile(selectedPath, "utf8"), selectedOriginal);
        assert.equal(await pathExists(dataDir), false);
      });
    });
  }

  it("restores claude, opencode, and codex then removes state", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-"));
    const settingsDir = path.join(home, ".claude");
    const opencodeDir = path.join(home, ".config/opencode");
    const codexDir = path.join(home, ".codex");
    await mkdir(settingsDir, { recursive: true });
    await mkdir(opencodeDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });

    const settingsPath = userSettingsPath(home);
    await writeFile(
      settingsPath,
      JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-original" } }),
    );

    const configPath = opencodeConfigPath(home);
    const opencodeOriginal = JSON.stringify({ model: "openai/gpt-4" }, null, 2) + "\n";
    await writeFile(configPath, opencodeOriginal);

    const codexPath = codexConfigPath(home);
    const codexOriginal = [
      'model_provider = "openai"',
      'model = "gpt-4.1"',
    ].join("\n") + "\n";
    await writeFile(codexPath, codexOriginal);

    await (await runFireconnect(["login", "--api-key", "fw_test_key_12345"], { HOME: home }), await runFireconnect(["claude", "on"], { HOME: home }));
    await (await runFireconnect(["login", "--api-key", "fw_test_key_12345"], { HOME: home }), await runFireconnect(["opencode", "on"], { HOME: home }));
    await (await runFireconnect(["login", "--api-key", "fw_test_key_12345"], { HOME: home, FIREWORKS_API_KEY: "" }), await runFireconnect(["codex", "on"], { HOME: home, FIREWORKS_API_KEY: "" }));

    // Regression (gh fw-ai-external/nexus-cli#12): a leftover ~/.nexus file
    // (e.g. the update-check cache) must not survive uninstall.
    await writeFile(path.join(home, ".nexus/update-check.json"), '{"lastCheck":1}');

    const uninstallResult = await runFireconnect(["uninstall"], { HOME: home });
    assert.equal(uninstallResult.code, 0);

    const restoredClaude = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restoredClaude.env.ANTHROPIC_API_KEY, "sk-ant-original");

    const restoredOpencode = await readFile(configPath, "utf8");
    assert.equal(restoredOpencode, opencodeOriginal);

    const restoredCodex = await readFile(codexPath, "utf8");
    assert.equal(restoredCodex, codexOriginal);

    assert.equal(await pathExists(globalConfigPath(home)), false);
    assert.equal(await pathExists(path.join(home, ".nexus/claude")), false);
    assert.equal(await pathExists(path.join(home, ".nexus/opencode")), false);
    assert.equal(await pathExists(path.join(home, ".nexus/codex")), false);
    assert.equal(await pathExists(path.join(home, ".codex/fireworks-model-catalog.json")), false);
    // gh #12: nothing left in ~/.nexus, and the dir itself is gone.
    assert.equal(await pathExists(path.join(home, ".nexus/update-check.json")), false);
    assert.equal(await pathExists(path.join(home, ".nexus")), false);
  });

  it("win32: restores other harnesses before aborting uninstall for a malformed VS Code profile", { skip: process.platform !== "win32" }, async () => {
    await withTempHome("uninstall-malformed-vscode-", async (home) => {
      const env = isolatedProfileEnv(home);
      const selected = detectVscodeInstall(undefined, { env, home })?.folder || "Code";
      const other = selected === "Code" ? "Code - Insiders" : "Code";
      const modelsPath = path.join(appUserDataDir(home, other, { env }), "User", "chatLanguageModels.json");
      await mkdir(path.dirname(modelsPath), { recursive: true });
      await writeFile(modelsPath, "not valid JSON");

      const settingsPath = userSettingsPath(home);
      const original = JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-original" } });
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, original);
      const login = await runFireconnect(["login", "--api-key", "fw_test_key_12345"], { HOME: home });
      assert.equal(login.code, 0, login.stderr);
      const on = await runFireconnect(["claude", "on"], { HOME: home });
      assert.equal(on.code, 0, on.stderr);
      assert.notEqual(await readFile(settingsPath, "utf8"), original);
      const cachePath = path.join(home, ".nexus", "update-check.json");
      await writeFile(cachePath, "{}");

      const result = await runCli(["uninstall", "--force"], { home, env });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /Stopped before removing Nexus CLI\./);
      assert.match(result.stdout, /VS Code could not be restored:[\s\S]*chatLanguageModels\.json is not valid JSON/);
      assert.equal(await readFile(settingsPath, "utf8"), original);
      assert.equal(await readFile(modelsPath, "utf8"), "not valid JSON");
      assert.equal(await readFile(cachePath, "utf8"), "{}");
    });
  });

  it("restores codex from a legacy fireworks-azure routing on uninstall", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-legacy-azure-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });

    // The state an Azure-enabled install is left in after the Azure removal:
    // config.toml still routes through fireworks-azure (which Codex CLI 0.160+
    // refuses to load), and the pre-Nexus snapshot is the only way back.
    const configPath = codexConfigPath(home);
    const codexOriginal = 'model = "gpt-4.1"\n';
    const legacyAzureRouting = [
      'model_provider = "fireworks-azure"',
      'model = "FW-GLM-5.2"',
      "",
      "[model_providers.fireworks-azure]",
      'name = "Fireworks Azure"',
      'base_url = "https://example-resource.services.ai.azure.com/openai/v1"',
      'wire_api = "chat"',
      'env_key = "AZURE_API_KEY"',
      "requires_openai_auth = false",
    ].join("\n") + "\n";
    await writeFile(configPath, legacyAzureRouting);

    const backupPath = codexBackupPath(codexDataDir(home), configPath);
    await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJson(backupPath, {
      configPath: path.resolve(configPath),
      snapshot: { existed: true, raw: codexOriginal },
    });

    const uninstallResult = await runFireconnect(["uninstall"], { HOME: home });
    assert.equal(uninstallResult.code, 0, uninstallResult.stderr);

    assert.equal(await readFile(configPath, "utf8"), codexOriginal);
    assert.equal(await pathExists(path.join(home, ".nexus/codex")), false);
  });

  it("keeps codex catalog when uninstall cannot disable codex", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-codex-off-fail-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });

    await (await runFireconnect(["login", "--api-key", "fw_test_key_12345"], { HOME: home, FIREWORKS_API_KEY: "" }), await runFireconnect(["codex", "on"], { HOME: home, FIREWORKS_API_KEY: "" }));

    const configPath = codexConfigPath(home);
    const catalogPath = path.join(home, ".codex/fireworks-model-catalog.json");
    await writeFile(
      configPath,
      patchCodexCatalogRefRaw(await readFile(configPath, "utf8"), CODEX_CATALOG_TOML_REF),
      "utf8",
    );
    await writeFile(catalogPath, '{"models":[]}', "utf8");

    const backupPath = codexBackupPath(codexDataDir(home), configPath);
    await writeJson(backupPath, {
      configPath: "/different/config.toml",
      snapshot: { existed: true, raw: 'model = "gpt-4.1"\n' },
    });

    const uninstallResult = await runFireconnect(["uninstall"], { HOME: home });
    assert.notEqual(uninstallResult.code, 0);
    assert.match(uninstallResult.stderr, /failed to restore codex/i);
    assert.equal(await pathExists(catalogPath), true);
    assert.match(await readFile(configPath, "utf8"), /model_catalog_json/);
  });

  it("keeps codex catalog on uninstall when restored config still references it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-keep-catalog-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });

    await (await runFireconnect(["login", "--api-key", "fw_test_key_12345"], { HOME: home, FIREWORKS_API_KEY: "" }), await runFireconnect(["codex", "on"], { HOME: home, FIREWORKS_API_KEY: "" }));

    const configPath = codexConfigPath(home);
    const catalogPath = path.join(home, ".codex/fireworks-model-catalog.json");
    await writeFile(
      configPath,
      patchCodexCatalogRefRaw(await readFile(configPath, "utf8"), CODEX_CATALOG_TOML_REF),
      "utf8",
    );
    await writeFile(catalogPath, '{"models":[]}', "utf8");

    const original = [
      'model_provider = "openai"',
      `model_catalog_json = "${CODEX_CATALOG_TOML_REF}"`,
      'model = "gpt-4.1"',
      "",
    ].join("\n");
    await writeJson(codexBackupPath(codexDataDir(home), configPath), {
      configPath: path.resolve(configPath),
      snapshot: { existed: true, raw: original },
    });

    const offResult = await runFireconnect(["codex", "off"], { HOME: home });
    assert.equal(offResult.code, 0);
    assert.equal(await pathExists(catalogPath), true);

    const uninstallResult = await runFireconnect(["uninstall"], { HOME: home });
    assert.equal(uninstallResult.code, 0);
    assert.equal(await pathExists(catalogPath), true);
    assert.match(await readFile(configPath, "utf8"), /model_catalog_json/);
  });

  it("does not mutate settings when harness was configured but not enabled", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-config-only-"));
    const settingsDir = path.join(home, ".claude");
    await mkdir(settingsDir, { recursive: true });

    const settingsPath = userSettingsPath(home);
    const originalSettings = JSON.stringify({
      env: { ANTHROPIC_API_KEY: "sk-ant-original" },
    });
    await writeFile(settingsPath, originalSettings);

    // Harness registered (present in config) but never enabled.
    await writeGlobalConfig(home, { harnesses: { claude: { enabled: false } } });

    const uninstallResult = await runFireconnect(["uninstall"], { HOME: home });
    assert.equal(uninstallResult.code, 0);

    const after = await readFile(settingsPath, "utf8");
    assert.equal(after, originalSettings);
  });

  it("still counts OpenCode as routed when its Nexus backup is unreadable", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-opencode-bad-backup-"));
    const configPath = opencodeConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      model: "fireworks-ai/accounts/fireworks/models/example-model",
      provider: { "fireworks-ai": { options: { apiKey: "{env:FIREWORKS_API_KEY}" } } },
    }, null, 2)}\n`);
    const backupPath = opencodeBackupPath(opencodeDataDir(home), configPath);
    await mkdir(path.dirname(backupPath), { recursive: true });
    await writeFile(backupPath, "{ not json");

    assert.equal((await registry.listRoutedHarnessIds({}, home)).includes(HARNESS.OPENCODE), true);
  });

  it("leaves the user's own OpenCode Fireworks provider alone when Nexus never turned it on", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-own-opencode-"));
    const configPath = opencodeConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    const original = `${JSON.stringify({
      model: "fireworks-ai/accounts/fireworks/models/example-model",
      provider: { "fireworks-ai": { options: { apiKey: "{env:FIREWORKS_API_KEY}" } } },
    }, null, 2)}\n`;
    await writeFile(configPath, original);
    await mkdir(path.join(home, ".nexus"), { recursive: true });

    assert.equal((await registry.listRoutedHarnessIds({}, home)).includes(HARNESS.OPENCODE), false);
    const uninstallResult = await runFireconnect(["uninstall", "--force"], { HOME: home });
    assert.equal(uninstallResult.code, 0, uninstallResult.stderr);
    assert.equal(await readFile(configPath, "utf8"), original);
  });

});

describe("uninstall after a Claude Desktop on that failed midway", { skip: process.platform === "win32" }, () => {
  it("uninstall --force restores Desktop's profile library byte for byte", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-desktop-"));
    const lib = path.join(thirdPartyDir(home), "configLibrary");
    const deviceConfig = path.join(thirdPartyDir(home), "claude_desktop_config.json");
    const original = JSON.stringify({ inferenceGatewayBaseUrl: "https://gateway.example.com" });
    const meta = JSON.stringify({ appliedId: "original", entries: [{ id: "original", name: "Original" }] });
    await mkdir(lib, { recursive: true });
    await writeFile(path.join(lib, "original.json"), original);
    await writeFile(path.join(lib, "_meta.json"), meta);
    // A directory where the device config belongs makes `on` fail after
    // Desktop already points at the Fireworks profile.
    await mkdir(deviceConfig);
    // Pin the child's config root so a runner's XDG_CONFIG_HOME can't move Desktop's data dir.
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };

    await runFireconnect(["login", "--api-key", "fw_test_cataloged_key_12345"], env);
    const failed = await runFireconnect(["claude-desktop", "on"], env);
    assert.notEqual(failed.code, 0, "on fails at the device-config step");
    assert.notEqual(await readFile(path.join(lib, "_meta.json"), "utf8"), meta, "Desktop was left on the Fireworks profile");
    await rm(deviceConfig, { recursive: true });

    const uninstall = await runFireconnect(["uninstall", "--force"], env);
    assert.equal(uninstall.code, 0, uninstall.stderr);
    assert.equal(await readFile(path.join(lib, "_meta.json"), "utf8"), meta, "uninstall restored the profile library");
    assert.equal(await readFile(path.join(lib, "original.json"), "utf8"), original);
    assert.equal(await pathExists(path.join(home, ".nexus")), false);
  });
});

describe("uninstall (interactive path)", () => {
  // Drive runUninstallCommand in-process with a faked TTY so the interactive
  // (per-harness, non-forced) branch runs. Stub the harness registry so we
  // control each `off` outcome and can assert per-harness data-dir deletion
  // ordering: a dir is removed only after its `off` succeeds; a failed harness
  // keeps its dir so `off` stays recoverable.

  function withFakedTTY(fn) {
    const realStdin = process.stdin;
    const realIsTTY = realStdin.isTTY;
    Object.defineProperty(realStdin, "isTTY", { value: true, configurable: true });
    return Promise.resolve(fn()).finally(() => {
      Object.defineProperty(realStdin, "isTTY", { value: realIsTTY, configurable: true });
    });
  }

  const withHome = withIsolatedProfileEnv;

  /**
   * Present a harness as routed (or not) and optionally stub its `off`.
   *
   * "On" is resolved from the harness's own config via `providerStatus`, not
   * from Nexus's `enabled` flag, so a test that wants a harness treated
   * as on has to say so here — writing `enabled: true` into the global config
   * is not enough and would silently test nothing.
   *
   * @returns {() => void} restores the adapter
   */
  function stubHarness(id, { routed = true, off } = {}) {
    const adapter = registry.getHarness(id);
    const orig = { off: adapter.off, providerStatus: adapter.providerStatus, ownsRouting: adapter.ownsRouting };
    adapter.providerStatus = async () => (routed ? "fireworks" : "none");
    adapter.ownsRouting = async () => routed;
    if (off) {
      adapter.off = off;
    }
    return () => {
      adapter.off = orig.off;
      adapter.providerStatus = orig.providerStatus;
      adapter.ownsRouting = orig.ownsRouting;
    };
  }

  it("deletes each harness data dir only after its off succeeds", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-interactive-"));
    // Two registered harnesses with on-disk data dirs.
    await writeGlobalConfig(home, { harnesses: { claude: { enabled: true }, opencode: { enabled: true } } });
    await mkdir(path.join(home, ".nexus/claude"), { recursive: true });
    await mkdir(path.join(home, ".nexus/opencode"), { recursive: true });
    await writeFile(path.join(home, ".nexus/claude/marker"), "1");
    await writeFile(path.join(home, ".nexus/opencode/marker"), "1");

    let claudeOffCalls = 0;
    let opencodeOffCalls = 0;
    const restore = [
      stubHarness(HARNESS.CLAUDE, { off: async () => { claudeOffCalls += 1; } }),
      stubHarness(HARNESS.OPENCODE, {
        off: async () => { opencodeOffCalls += 1; throw new Error("boom"); },
      }),
    ];

    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      restore.forEach((fn) => fn());
    }

    assert.equal(claudeOffCalls, 1, "claude off ran once");
    assert.equal(opencodeOffCalls, 1, "opencode off ran once");
    // Succeeded harness: its data dir was removed right after off succeeded.
    assert.equal(await pathExists(path.join(home, ".nexus/claude/marker")), false,
      "claude data dir removed after successful off");
    // Failed harness: its backup survives. Uninstall stops before the global
    // cleanup precisely so this stays usable for a retry.
    assert.equal(await pathExists(path.join(home, ".nexus/opencode/marker")), true,
      "failed harness keeps its backup");
    assert.notEqual(process.exitCode, 0, "non-zero exit on off failure");
    process.exitCode = origExitCode;
  });

  it("interactive path does not force (lets the IDE guard run)", async () => {
    // The interactive branch passes ctx.force (false) to off, not hardcoded
    // true. Assert by capturing the force flag the adapter's off receives.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-interactive-force-"));
    await writeGlobalConfig(home, { harnesses: { claude: { enabled: true } } });
    await mkdir(path.join(home, ".nexus/claude"), { recursive: true });

    let capturedForce;
    const restore = stubHarness(HARNESS.CLAUDE, {
      off: async (ctx) => { capturedForce = ctx.force; },
    });
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      restore();
    }
    assert.equal(capturedForce, false, "interactive path must not force");
    process.exitCode = origExitCode;
  });

  it("omits harnesses that are not on from the checklist entirely", async () => {
    // A harness that is not routed has nothing to restore. It must not be
    // listed, and its `off` must not run — every harness in the config used to
    // be listed, so ones that were off rendered as "wasn't connected".
    // Note the config claims opencode is enabled: its real config says
    // otherwise, and the harness's own config wins.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-onlyon-"));
    await writeGlobalConfig(home, {
      harnesses: { claude: { enabled: true }, opencode: { enabled: true } },
    });
    await mkdir(path.join(home, ".nexus/cli"), { recursive: true });

    const ran = [];
    const restore = [
      stubHarness(HARNESS.CLAUDE, {
        routed: true,
        off: async () => { ran.push("claude"); return "restored"; },
      }),
      stubHarness(HARNESS.OPENCODE, {
        routed: false,
        off: async () => { ran.push("opencode"); return "restored"; },
      }),
    ];

    let out = "";
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { out += String(chunk); return true; };
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      process.stdout.write = realWrite;
      restore.forEach((fn) => fn());
      process.exitCode = origExitCode;
    }

    assert.deepEqual(ran, ["claude"], "only the routed harness runs off");
    assert.match(out, /Claude Code/);
    assert.doesNotMatch(out, /OpenCode/, "an unrouted harness must not be listed");
    assert.doesNotMatch(out, /wasn't connected/, "no not-connected noise");
  });

  it("restores a harness that is routed but missing from config", async () => {
    // Regression: discovery used to read only config.harnesses, so a lost or
    // reinstalled ~/.nexus meant no `off` ran at all — uninstall deleted
    // the backup while leaving the harness pointed at Fireworks with its
    // built-in models hidden, which is unrecoverable. providerStatus reads the
    // harness's real config, so it catches what the config map misses.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-orphan-"));
    // No config.json at all — just an installed CLI.
    await mkdir(path.join(home, ".nexus/cli"), { recursive: true });

    let offRan = false;
    const restore = stubHarness(HARNESS.CURSOR, {
      routed: true,
      off: async () => { offRan = true; return "stripped"; },
    });
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      restore();
      process.exitCode = origExitCode;
    }
    assert.equal(offRan, true, "a routed harness must be restored even without a config entry");
  });

  it("does not restore harnesses that are not routed", async () => {
    // The discovery probe must not drag in every harness — only routed ones.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-notrouted-"));
    await mkdir(path.join(home, ".nexus/cli"), { recursive: true });

    let offRan = false;
    const restore = stubHarness(HARNESS.CURSOR, {
      routed: false,
      off: async () => { offRan = true; },
    });
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      restore();
      process.exitCode = origExitCode;
    }
    assert.equal(offRan, false, "an unrouted harness must be left alone");
  });

  it("aborts before cleanup when a restore fails, keeping FireConnect usable", async () => {
    // Regression: a failed `off` leaves that harness routed through Fireworks,
    // and its backup is the only way back. Uninstall must not remove the
    // backup, the config, or the CLI needed to retry. The likely trigger is
    // the user declining to quit Cursor — deleting their backup in response
    // would be indefensible.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-abort-"));
    await writeGlobalConfig(home, { harnesses: { cursor: { enabled: true } } });
    await mkdir(path.join(home, ".nexus/cursor"), { recursive: true });
    await writeFile(path.join(home, ".nexus/cursor/cursor-backup.json"), '{"snapshot":{}}');
    await mkdir(path.join(home, ".nexus/cli"), { recursive: true });
    await mkdir(path.join(home, ".local/bin"), { recursive: true });
    await writeFile(path.join(home, ".local/bin/nexus"), "exec node /cli/packages/setup-cli/bin/nexus.mjs \"$@\"\n");

    const restore = stubHarness(HARNESS.CURSOR, {
      off: async () => { throw new Error("Cursor is running."); },
    });
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      restore();
    }

    assert.notEqual(process.exitCode, 0, "exits non-zero");
    process.exitCode = origExitCode;
    assert.equal(await pathExists(path.join(home, ".nexus/cursor/cursor-backup.json")), true,
      "backup preserved for retry");
    assert.equal(await pathExists(path.join(home, ".nexus/cli")), true,
      "CLI preserved so the retry is runnable");
    assert.equal(await pathExists(path.join(home, ".local/bin/nexus")), true,
      "launcher preserved so the retry is runnable");
    assert.equal(await pathExists(globalConfigPath(home)), true, "config preserved");
  });

  it("passes quiet to off so harness narration does not fight the checklist", async () => {
    // Regression: engineOff (and claude's own off) print restored/restart lines
    // to stdout during the off call. Uninstall prints its own checklist and a
    // single restart reminder, so it must silence them.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-quiet-"));
    await writeGlobalConfig(home, { harnesses: { claude: { enabled: true } } });
    await mkdir(path.join(home, ".nexus/claude"), { recursive: true });

    let capturedQuiet;
    const restore = stubHarness(HARNESS.CLAUDE, {
      off: async (ctx) => { capturedQuiet = ctx.quiet; return "restored"; },
    });
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      restore();
      process.exitCode = origExitCode;
    }
    assert.equal(capturedQuiet, true, "interactive uninstall must pass quiet");
  });

  it("reports the real off outcome in the checklist", async () => {
    // A harness that was never connected must not be reported as "restored".
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-outcome-"));
    await writeGlobalConfig(home, { harnesses: { claude: { enabled: true } } });
    await mkdir(path.join(home, ".nexus/claude"), { recursive: true });

    // Routed, so it is listed — but `off` finds nothing to undo (state drift).
    const restore = stubHarness(HARNESS.CLAUDE, { off: async () => "none" });
    let out = "";
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { out += String(chunk); return true; };
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      process.stdout.write = realWrite;
      restore();
      process.exitCode = origExitCode;
    }
    assert.match(out, /wasn't connected/, "outcome 'none' must not claim a restore");
    assert.doesNotMatch(out, /Your original settings are back/,
      "nothing was restored, so the farewell must not claim otherwise");
  });

  it("still removes files when no harnesses are registered (installed CLI only)", async () => {
    // Regression: an install with no `fci <harness> on` yet has an empty
    // harnesses map but Nexus files on disk. Uninstall must remove the
    // files, not bail out with "Nexus is not installed."
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-no-harnesses-"));
    // No global config / no harnesses — but the CLI launcher + ~/.nexus exist.
    await mkdir(path.join(home, ".nexus/cli"), { recursive: true });
    await writeFile(path.join(home, ".nexus/cli/marker"), "1");
    await mkdir(path.join(home, ".local/bin"), { recursive: true });
    await writeFile(path.join(home, ".local/bin/nexus"), "exec node /cli/packages/setup-cli/bin/nexus.mjs \"$@\"\n");

    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      process.exitCode = origExitCode;
    }
    assert.equal(await pathExists(path.join(home, ".nexus")), false,
      "~/.nexus removed even with no harnesses");
    assert.equal(await pathExists(path.join(home, ".local/bin/nexus")), false,
      "launcher removed even with no harnesses");
  });

  it("says 'not installed' only when there are no harnesses and no files", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-truly-absent-"));
    // Nothing on disk, no config.
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    let stdout = "";
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
    try {
      await withHome(home, () => withFakedTTY(() => runUninstallCommand({ force: false })));
    } finally {
      process.stdout.write = realWrite;
      process.exitCode = origExitCode;
    }
    assert.match(stdout, /Nexus CLI is not installed\./);
  });

  it("non-interactive --force stops before cleanup when a restore fails", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-force-fail-"));
    await writeGlobalConfig(home, { harnesses: { opencode: { enabled: true } } });
    await mkdir(path.join(home, ".nexus/opencode"), { recursive: true });
    await writeFile(path.join(home, ".nexus/opencode/marker"), "1");
    await mkdir(path.join(home, ".nexus/cli"), { recursive: true });
    const restore = stubHarness(HARNESS.OPENCODE, { off: async () => { throw new Error("boom"); } });
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withHome(home, () => runUninstallCommand({ force: true }));
      assert.equal(process.exitCode, 1);
    } finally {
      restore();
      process.exitCode = origExitCode;
    }
    assert.equal(await pathExists(path.join(home, ".nexus/opencode/marker")), true, "backup kept for a retry");
    assert.equal(await pathExists(path.join(home, ".nexus/cli")), true, "CLI kept for a retry");
  });

  it("non-interactive --force path still forces every off", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-force-flag-"));
    await writeGlobalConfig(home, { harnesses: { claude: { enabled: true } } });
    await mkdir(path.join(home, ".nexus/claude"), { recursive: true });

    let capturedForce;
    const restore = stubHarness(HARNESS.CLAUDE, {
      off: async (ctx) => { capturedForce = ctx.force; },
    });
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      // --force → ctx.force true → non-interactive branch forces.
      await withHome(home, () => runUninstallCommand({ force: true }));
    } finally {
      restore();
    }
    assert.equal(capturedForce, true, "--force forces every off");
    process.exitCode = origExitCode;
  });

});

describe("uninstall launchers", () => {
  it("removes the launchers it installed under either name but not another tool's", async () => {
    for (const [content, kept] of [
      ["exec node /cli/packages/setup-cli/bin/nexus.mjs \"$@\"\n", false],
      ["#!/bin/sh\nexec other-tool \"$@\"\n", true],
    ]) {
      const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-nexus-"));
      const bin = path.join(home, ".local/bin");
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, "fireconnect"), "exec node /cli/packages/setup-cli/bin/fireconnect.mjs \"$@\"\n");
      await writeFile(path.join(bin, "nexus"), content);

      const result = await runFireconnect(["uninstall"], { HOME: home });
      assert.equal(result.code, 0);
      assert.equal(await pathExists(path.join(bin, "fireconnect")), false);
      assert.equal(await pathExists(path.join(bin, "nexus")), kept);
    }
  });
});

describe("uninstall data directories", () => {
  it("removes ~/.nexus and an unfinished move's ~/.fireconnect", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-deferred-"));
    await mkdir(path.join(home, ".fireconnect"), { recursive: true });
    await writeFile(path.join(home, ".fireconnect/update-check.json"), "{}");
    await symlink(".fireconnect", path.join(home, ".nexus"), "dir");

    const result = await runFireconnect(["uninstall"], { HOME: home });
    assert.equal(result.code, 0);
    await assert.rejects(lstat(path.join(home, ".nexus")), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(home, ".fireconnect")), { code: "ENOENT" });
  });
});

describe("legacy data directory next to an existing ~/.nexus", () => {
  it("merges the old backups in, so off and uninstall work", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-merge-"));
    await mkdir(path.join(home, ".fireconnect/claude"), { recursive: true });
    await writeFile(path.join(home, ".fireconnect/claude/settings.backup.json"), "{}");
    await mkdir(path.join(home, ".nexus"), { recursive: true });

    for (const args of [["claude", "off"], ["uninstall"]]) {
      const result = await runFireconnect(args, { HOME: home });
      assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
    }
    assert.equal(await pathExists(path.join(home, ".nexus")), false);
    assert.equal(await pathExists(path.join(home, ".fireconnect")), false);
  });
  it("keeps an unrecorded ~/.nexus-pre with nested personal files and prints no note", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-nexus-pre-personal-"));
    await mkdir(path.join(home, ".nexus-pre/cli"), { recursive: true });
    await writeFile(path.join(home, ".nexus-pre/cli/personal-notes.txt"), "personal notes");
    await mkdir(path.join(home, ".nexus"), { recursive: true });

    const result = await runFireconnect(["uninstall"], { HOME: home });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await pathExists(path.join(home, ".nexus-pre")), true);
    assert.equal(await readFile(path.join(home, ".nexus-pre/cli/personal-notes.txt"), "utf8"), "personal notes");
    assert.doesNotMatch(result.stdout, /Left ~\/\.nexus-pre:/);
  });

  it("leaves stored keys and other files in an unrecorded aside and names the keys", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-nexus-pre-strong-"));
    await mkdir(path.join(home, ".nexus-pre"), { recursive: true });
    await writeFile(path.join(home, ".nexus-pre/key-storage.json"), "{}");
    await writeFile(path.join(home, ".nexus-pre/.api-key"), "synthetic-api-key");
    await writeFile(path.join(home, ".nexus-pre/.secret-memory-abc"), "synthetic-memory-key");
    await writeFile(path.join(home, ".nexus-pre/minted-key.json"), JSON.stringify({ keyId: "key-123" }));
    await writeFile(path.join(home, ".nexus-pre/notes.txt"), "personal notes");
    await mkdir(path.join(home, ".nexus"), { recursive: true });

    const result = await runFireconnect(["uninstall"], { HOME: home });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await pathExists(path.join(home, ".nexus-pre")), true);
    assert.equal(await readFile(path.join(home, ".nexus-pre/key-storage.json"), "utf8"), "{}");
    assert.equal(await readFile(path.join(home, ".nexus-pre/.api-key"), "utf8"), "synthetic-api-key");
    assert.equal(await readFile(path.join(home, ".nexus-pre/.secret-memory-abc"), "utf8"), "synthetic-memory-key");
    assert.equal(await readFile(path.join(home, ".nexus-pre/notes.txt"), "utf8"), "personal notes");
    assert.equal(
      await readFile(path.join(home, ".nexus-pre/minted-key.json"), "utf8"),
      JSON.stringify({ keyId: "key-123" }),
    );
    assert.match(result.stdout, /Left ~\/\.nexus-pre: it looks like a backup from an older Nexus version and still holds stored keys \(\.api-key, \.secret-memory-abc\)\. Delete it yourself if you don't need it\./);
  });

  it("leaves another tool's key-storage.json and .api-key in an unrecorded aside", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-foreign-nexus-pre-"));
    const aside = path.join(home, ".nexus-pre");
    await mkdir(aside, { recursive: true });
    await writeFile(path.join(aside, "key-storage.json"), '{"owner":"other-tool"}');
    await writeFile(path.join(aside, ".api-key"), "synthetic-other-tool-key");
    await mkdir(path.join(home, ".nexus"), { recursive: true });

    const result = await runFireconnect(["uninstall"], { HOME: home });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(path.join(aside, "key-storage.json"), "utf8"), '{"owner":"other-tool"}');
    assert.equal(await readFile(path.join(aside, ".api-key"), "utf8"), "synthetic-other-tool-key");
    assert.match(result.stdout, /still holds stored keys \(\.api-key\)\./);
  });

  it("prints the backup note when an unrecorded aside has no detected key files", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-nexus-pre-no-keys-"));
    await mkdir(path.join(home, ".nexus-pre"), { recursive: true });
    await writeFile(path.join(home, ".nexus-pre/key-storage.json"), "{}");
    await mkdir(path.join(home, ".nexus"), { recursive: true });

    const result = await runFireconnect(["uninstall"], { HOME: home });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(path.join(home, ".nexus-pre/key-storage.json"), "utf8"), "{}");
    assert.match(result.stdout, /Left ~\/\.nexus-pre: it looks like a backup from an older Nexus version\. Delete it yourself if you don't need it\./);
  });

  it("does not follow a key-file symlink in an unrecorded aside", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-nexus-pre-symlink-"));
    const aside = path.join(home, ".nexus-pre");
    const outsideKey = path.join(home, "outside-api-key.txt");
    await mkdir(aside, { recursive: true });
    await writeFile(path.join(aside, "key-storage.json"), "{}");
    await writeFile(path.join(aside, ".secret-memory-abc"), "synthetic-memory-key");
    await writeFile(outsideKey, "synthetic-external-api-key");
    await symlink(outsideKey, path.join(aside, ".api-key"));
    await mkdir(path.join(aside, "cli"), { recursive: true });
    await writeFile(path.join(aside, "notes.txt"), "personal notes");
    await mkdir(path.join(home, ".nexus"), { recursive: true });

    const result = await runFireconnect(["uninstall"], { HOME: home });

    assert.equal(result.code, 0, result.stderr);
    assert.equal((await lstat(path.join(aside, ".api-key"))).isSymbolicLink(), true);
    assert.equal(await readFile(outsideKey, "utf8"), "synthetic-external-api-key");
    assert.equal(await readFile(path.join(aside, ".secret-memory-abc"), "utf8"), "synthetic-memory-key");
    assert.equal(await readFile(path.join(aside, "key-storage.json"), "utf8"), "{}");
    assert.equal(await readFile(path.join(aside, "notes.txt"), "utf8"), "personal notes");
    assert.match(result.stdout, /still holds stored keys \(\.secret-memory-abc\)\./);
  });

  it("keeps an unrecorded ~/.nexus-pre with only .api-key and prints no note", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-nexus-pre-api-key-only-"));
    await mkdir(path.join(home, ".nexus-pre"), { recursive: true });
    await writeFile(path.join(home, ".nexus-pre/.api-key"), "synthetic-api-key");
    await mkdir(path.join(home, ".nexus"), { recursive: true });

    const result = await runFireconnect(["uninstall"], { HOME: home });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(path.join(home, ".nexus-pre/.api-key"), "utf8"), "synthetic-api-key");
    assert.doesNotMatch(result.stdout, /Left ~\/\.nexus-pre:|Removed stored keys from ~\/\.nexus-pre/);
  });

  it("removes a recorded ~/.nexus-pre aside", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-nexus-pre-recorded-"));
    await mkdir(path.join(home, ".nexus-pre"), { recursive: true });
    await writeFile(path.join(home, ".nexus-pre/legacy-copy.txt"), "recorded aside");
    await mkdir(path.join(home, ".nexus"), { recursive: true });
    await writeFile(path.join(home, ".nexus/set-aside.json"), '[".nexus-pre"]\n');

    const result = await runFireconnect(["uninstall"], { HOME: home });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await pathExists(path.join(home, ".nexus-pre")), false);
    assert.doesNotMatch(result.stdout, /Left ~\/\.nexus-pre:/);
  });

  it("finishes when the recorded ~/.nexus-pre is missing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-nexus-pre-missing-"));
    await mkdir(path.join(home, ".nexus"), { recursive: true });
    await writeFile(path.join(home, ".nexus/set-aside.json"), '[".nexus-pre", ".nexus-pre-1"]\n');

    const result = await runFireconnect(["uninstall"], { HOME: home });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await pathExists(path.join(home, ".nexus")), false);
    assert.equal(await pathExists(path.join(home, ".nexus-pre")), false);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Left ~\/\.nexus-pre:|Couldn't remove|could not remove/i);
  });

  it("removes a kept ~/.nexus-pre, and only the link when it points into dotfiles", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-nexus-pre-"));
    await mkdir(path.join(home, "dotfiles/fireconnect"), { recursive: true });
    await writeFile(path.join(home, "dotfiles/fireconnect/config.json"), "{}");
    await symlink(path.join(home, "dotfiles/fireconnect"), path.join(home, ".fireconnect"), "dir");
    await mkdir(path.join(home, ".nexus"), { recursive: true });

    const result = await runFireconnect(["uninstall"], { HOME: home });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await pathExists(path.join(home, ".nexus-pre")), false);
    assert.equal(await pathExists(path.join(home, ".fireconnect")), false);
    assert.equal(await readFile(path.join(home, "dotfiles/fireconnect/config.json"), "utf8"), "{}");
  });
});

describe("uninstall after an interrupted on", () => {
  it("restores Pi when `pi on` died between its settings and auth writes", async () => {
    // connectPi rewrites settings.json before it writes anything that marks Pi
    // as Nexus-routed. If `on` dies in between, uninstall must still find Pi
    // and restore settings.json before it deletes the snapshot in ~/.nexus.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-pi-crash-"));
    const settingsPath = piSettingsPath(home);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const original = '{\n  "defaultProvider": "anthropic",\n  "defaultModel": "claude-sonnet-4-5"\n}\n';
    await writeFile(settingsPath, original);
    assert.equal((await runFireconnect(["login", "--api-key", "fw_test_key_12345"], { HOME: home })).code, 0);

    const preload = fileURLToPath(new URL("../fixtures/crash-before-write.mjs", import.meta.url));
    const on = await runFireconnect(["pi", "on"], {
      HOME: home,
      NODE_OPTIONS: `--import ${preload}`,
      NEXUS_TEST_CRASH_BEFORE_WRITE: piAuthPath(home),
    });
    assert.notEqual(on.code, 0, "pi on must die before writing auth.json");
    assert.notEqual(await readFile(settingsPath, "utf8"), original, "settings.json was rewritten before the crash");

    assert.equal((await runFireconnect(["uninstall", "--force"], { HOME: home })).code, 0);
    assert.equal(await readFile(settingsPath, "utf8"), original);
  });

  it("restores Pi's models.json when `pi off` died before restoring it", async () => {
    // disablePiFireworks restores one file at a time. If `off` dies part way,
    // Pi must still look routed so uninstall restores the rest before it
    // deletes their snapshots in ~/.nexus.
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-uninstall-pi-off-crash-"));
    const settingsPath = piSettingsPath(home);
    const modelsPath = piModelsPath(home);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const settings = '{\n  "defaultProvider": "anthropic",\n  "defaultModel": "claude-sonnet-4-5"\n}\n';
    const models = '{\n  "providers": {\n    "local": { "baseUrl": "http://127.0.0.1:11434/v1" }\n  }\n}\n';
    await writeFile(settingsPath, settings);
    await writeFile(modelsPath, models);
    assert.equal((await runFireconnect(["login", "--api-key", "fw_test_key_12345"], { HOME: home })).code, 0);
    assert.equal((await runFireconnect(["pi", "on"], { HOME: home })).code, 0);
    assert.notEqual(await readFile(modelsPath, "utf8"), models, "pi on adds its provider to models.json");

    const preload = fileURLToPath(new URL("../fixtures/crash-before-write.mjs", import.meta.url));
    const off = await runFireconnect(["pi", "off"], {
      HOME: home,
      NODE_OPTIONS: `--import ${preload}`,
      NEXUS_TEST_CRASH_BEFORE_WRITE: modelsPath,
    });
    assert.notEqual(off.code, 0, "pi off must die before restoring models.json");

    assert.equal((await runFireconnect(["uninstall", "--force"], { HOME: home })).code, 0);
    assert.equal(await readFile(modelsPath, "utf8"), models);
    assert.equal(await readFile(settingsPath, "utf8"), settings);
  });

  it("keeps Pi's own fireworks entries when `on` runs again after an `off` that died before settings.json", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-pi-off-crash-reon-"));
    const settingsPath = piSettingsPath(home);
    const authPath = piAuthPath(home);
    const modelsPath = piModelsPath(home);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const settings = '{\n  "defaultProvider": "anthropic",\n  "defaultModel": "claude-sonnet-4-5"\n}\n';
    const auth = '{\n  "fireworks": { "type": "api_key", "key": "fw_users_own_key" }\n}\n';
    const models = '{\n  "providers": {\n    "fireworks": { "baseUrl": "https://example.test/v1" }\n  }\n}\n';
    await writeFile(settingsPath, settings);
    await writeFile(authPath, auth, { mode: 0o600 });
    await writeFile(modelsPath, models);
    assert.equal((await runFireconnect(["login", "--api-key", "fw_test_key_12345"], { HOME: home })).code, 0);
    assert.equal((await runFireconnect(["pi", "on"], { HOME: home })).code, 0);

    const preload = fileURLToPath(new URL("../fixtures/crash-before-write.mjs", import.meta.url));
    const off = await runFireconnect(["pi", "off"], {
      HOME: home,
      NODE_OPTIONS: `--import ${preload}`,
      NEXUS_TEST_CRASH_BEFORE_WRITE: settingsPath,
    });
    assert.notEqual(off.code, 0, "pi off must die before restoring settings.json");

    assert.equal((await runFireconnect(["pi", "on"], { HOME: home })).code, 0);
    assert.equal((await runFireconnect(["pi", "off"], { HOME: home })).code, 0);
    assert.equal(await readFile(modelsPath, "utf8"), models);
    assert.equal(await readFile(authPath, "utf8"), auth);
    assert.equal(await readFile(settingsPath, "utf8"), settings);
  });
});
