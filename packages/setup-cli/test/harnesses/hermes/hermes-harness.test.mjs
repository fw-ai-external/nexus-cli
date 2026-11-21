import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readdir, readFile, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import {
  disableHermesFireworks,
  enableHermesFireworks,
  hermesBackupPath,
  hermesConfigPath,
  hermesDataDir,
  hermesEnvPath,
  hermesGatewayRunning,
  hermesModelId,
  hermesPluginSource,
  readHermesConfigIfExists,
  refreshHermesGatewayKey,
  removeHermesSavedProviderKeys,
} from "../../../lib/harnesses/hermes/core.mjs";
import hermesAdapter from "../../../lib/harnesses/hermes/index.mjs";
import { runFireconnect, withTempHome } from "../../helpers.mjs";

const KEY = "fw_test_key_12345";
const TELEMETRY = { "X-Title": "Hermes Agent", "HTTP-Referer": "nexus/v0.11.1" };
const ORIGINAL_CONFIG = [
  "# my hermes setup",
  "model:",
  "  provider: openrouter",
  "  default: anthropic/claude-sonnet-4",
  "  api_key: sk-or-original",
  "  extra_headers:",
  "    X-Team: blue",
  "terminal:",
  "  backend: local  # keep me",
  "",
].join("\n");
const ORIGINAL_ENV = "OPENROUTER_API_KEY=sk-or\n\nFIREWORKS_API_KEY=fw_original\n";

function pathsIn(home) {
  const configPath = hermesConfigPath(home);
  return { configPath, envPath: hermesEnvPath(configPath), dataDir: hermesDataDir(home) };
}

async function seed(home, { config = ORIGINAL_CONFIG, env = ORIGINAL_ENV } = {}) {
  const paths = pathsIn(home);
  await mkdir(path.dirname(paths.configPath), { recursive: true });
  if (config !== null) {
    await writeFile(paths.configPath, config);
    await chmod(paths.configPath, 0o644);
  }
  if (env !== null) {
    await writeFile(paths.envPath, env);
    await chmod(paths.envPath, 0o600);
  }
  return paths;
}

/** Where `on` writes the Nexus Auto provider plugin, beside config.yaml. */
function pluginPaths(configPath) {
  const dir = path.join(path.dirname(configPath), "plugins", "model-providers", "fireworks");
  return { dir, init: path.join(dir, "__init__.py"), manifest: path.join(dir, "plugin.yaml") };
}

const GATEWAY_HINT = /A Hermes gateway is running with the old setup/;

/** A live stand-in process for the gateway; never Hermes, never signalled beyond the final kill. */
async function withLiveProcess(fn) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await once(child, "spawn");
  try {
    return await fn(child.pid);
  } finally {
    child.kill();
  }
}

async function writeGatewayRecord(configPath, record) {
  await writeFile(path.join(path.dirname(configPath), "gateway.pid"),
    typeof record === "string" ? record : JSON.stringify(record));
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("Hermes Agent core", () => {
  it("on selects Fireworks with Nexus Auto, writes the plugin, keeps comments and user keys; off restores all", async () => {
    await withTempHome("hermes-roundtrip-", async (home) => {
      const paths = await seed(home);
      const result = await enableHermesFireworks({
        ...paths,
        effectiveApiKey: KEY,
        headers: { ...TELEMETRY, "x-anthropic-api-key": "sk-ant-test" },
      });
      assert.equal(result.model, "nexus-auto");
      assert.equal(result.modelSpec, "fireworks:nexus-auto");

      const raw = await readFile(paths.configPath, "utf8");
      assert.match(raw, /# my hermes setup/);
      assert.match(raw, /backend: local +# keep me/);
      const config = parse(raw);
      assert.equal(config.model.provider, "fireworks");
      assert.equal(config.model.default, "nexus-auto");
      assert.equal(config.model.base_url, undefined);
      assert.equal(config.model.api_key, undefined);
      assert.deepEqual(config.model.extra_headers, { "X-Team": "blue" });
      assert.deepEqual(config.providers, {
        fireworks: {
          base_url: "https://api.fireworks.ai/inference/v1",
          key_env: "FIREWORKS_API_KEY",
          extra_headers: { ...TELEMETRY, "x-anthropic-api-key": "sk-ant-test" },
          models: { "nexus-auto": {} },
        },
      });
      assert.deepEqual(config.model_aliases, { "Nexus Auto": { model: "nexus-auto", provider: "fireworks" } });

      const plugin = pluginPaths(paths.configPath);
      assert.match(await readFile(plugin.init, "utf8"), /NEXUS_AUTO_ID = "nexus-auto"/);
      assert.match(await readFile(plugin.manifest, "utf8"), /^kind: model-provider$/m);
      assert.equal((await stat(plugin.init)).mode & 0o777, 0o600);

      const env = await readFile(paths.envPath, "utf8");
      assert.match(env, /^OPENROUTER_API_KEY=sk-or$/m);
      assert.match(env, new RegExp(`^FIREWORKS_API_KEY=${KEY}$`, "m"));
      const backupPath = hermesBackupPath(paths.dataDir, paths.configPath);
      assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
      assert.equal((await stat(paths.envPath)).mode & 0o777, 0o600);

      // Hermes's import leaves a bytecode cache beside the plugin.
      await mkdir(path.join(plugin.dir, "__pycache__"));
      await writeFile(path.join(plugin.dir, "__pycache__", "__init__.cpython-312.pyc"), "");

      assert.equal(await disableHermesFireworks(paths), "restored");
      assert.equal(await readFile(paths.configPath, "utf8"), ORIGINAL_CONFIG);
      assert.equal(await readFile(paths.envPath, "utf8"), ORIGINAL_ENV);
      assert.equal((await stat(paths.configPath)).mode & 0o777, 0o644);
      assert.equal(await exists(plugin.dir), false);
      assert.equal(await exists(path.join(path.dirname(paths.configPath), "plugins")), false);
      assert.equal(await exists(backupPath), false);
    });
  });

  it("maps auto to nexus-auto and leaves other models alone", () => {
    assert.equal(hermesModelId("auto"), "nexus-auto");
    assert.equal(hermesModelId("AUTO"), "nexus-auto");
    assert.equal(hermesModelId("auto-instant"), "nexus-auto");
    assert.equal(hermesModelId("nexus-auto"), "nexus-auto");
    assert.equal(hermesModelId("glm-latest"), "glm-latest");
    assert.equal(hermesModelId("accounts/fireworks/models/example-model"), "example-model");
  });

  it("off without an original keeps the model section and its comments, taking back only Nexus's selection", async () => {
    await withTempHome("hermes-no-original-", async (home) => {
      // Already routed by Nexus when `on` runs (its backup was lost), so there
      // is no un-routed original to snapshot.
      const routed = [
        "model:",
        "  # Default model to use",
        "  default: nexus-auto",
        "  # Inference provider selection",
        "  provider: fireworks",
        "  context_length: 200000",
        "providers:",
        "  fireworks:",
        "    base_url: https://api.fireworks.ai/inference/v1",
        "    extra_headers:",
        "      HTTP-Referer: nexus/v0.0.0",
        "",
      ].join("\n");
      const paths = await seed(home, { config: routed });
      await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: TELEMETRY });
      await writeFile(paths.configPath, `${await readFile(paths.configPath, "utf8")}display:\n  skin: mono\n`);

      assert.equal(await disableHermesFireworks(paths), "stripped");
      const raw = await readFile(paths.configPath, "utf8");
      assert.match(raw, /# Default model to use/);
      assert.match(raw, /# Inference provider selection/);
      const config = parse(raw);
      // Hermes's documented default provider; `default` (Nexus's pick) is gone.
      assert.deepEqual(config.model, { provider: "auto", context_length: 200000 });
      assert.equal(config.providers, undefined);
      assert.equal(config.model_aliases, undefined);
      assert.equal(config.display.skin, "mono");
      assert.equal(await exists(pluginPaths(paths.configPath).dir), false);
    });
  });

  it("off puts back a Fireworks provider plugin the user already had", async () => {
    await withTempHome("hermes-user-plugin-", async (home) => {
      const paths = await seed(home);
      const plugin = pluginPaths(paths.configPath);
      await mkdir(plugin.dir, { recursive: true });
      await writeFile(plugin.init, "# the user's own plugin\n");
      await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: TELEMETRY });
      assert.match(await readFile(plugin.init, "utf8"), /nexus-auto/);
      assert.equal(await disableHermesFireworks(paths), "restored");
      assert.equal(await readFile(plugin.init, "utf8"), "# the user's own plugin\n");
      assert.equal(await exists(plugin.manifest), false);
    });
  });

  it("off leaves a Fireworks setup the user made by hand, even when Nexus thinks it enabled Hermes", async () => {
    await withTempHome("hermes-hand-fireworks-", async (home) => {
      const config = "model:\n  provider: fireworks\n  default: accounts/fireworks/models/glm-5p2\n";
      const env = "FIREWORKS_API_KEY=fw_users_own_key\n";
      const paths = await seed(home, { config, env });
      assert.equal(await disableHermesFireworks({ ...paths, wasEnabled: true }), "unchanged");
      assert.equal(await readFile(paths.configPath, "utf8"), config);
      assert.equal(await readFile(paths.envPath, "utf8"), env);
    });
  });

  it("on refuses to write the backup through a symlinked data directory", async () => {
    await withTempHome("hermes-symlinked-data-", async (home) => {
      const paths = await seed(home);
      const target = path.join(home, "elsewhere");
      await mkdir(target, { mode: 0o755 });
      await mkdir(path.dirname(paths.dataDir), { recursive: true });
      await symlink(target, paths.dataDir);
      await assert.rejects(
        enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: TELEMETRY }),
        /Cannot secure private files/,
      );
      assert.equal(await readFile(paths.configPath, "utf8"), ORIGINAL_CONFIG);
    });
  });

  it("a route Nexus set up still counts as routed after its headers are edited", async () => {
    await withTempHome("hermes-edited-referer-", async (home) => {
      const paths = await seed(home);
      const ctx = { home, settingsPath: "", configPath: "", dataDir: "" };
      await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: TELEMETRY });
      const raw = await readFile(paths.configPath, "utf8");
      await writeFile(paths.configPath, raw.replace("nexus/v0.11.1", "my-own-referer"));
      assert.equal(await hermesAdapter.providerStatus(ctx), "fireworks");
      assert.equal(await refreshHermesGatewayKey({ ...paths, fireworksKey: "fw_rotated_key_67890" }), true);
      await disableHermesFireworks(paths);
      assert.equal(await hermesAdapter.providerStatus(ctx), null);
    });
  });

  it("a damaged backup doesn't break status", async () => {
    await withTempHome("hermes-bad-backup-", async (home) => {
      const paths = await seed(home, { config: "model:\n  provider: fireworks\n  default: nexus-auto\n" });
      const backupPath = hermesBackupPath(paths.dataDir, paths.configPath);
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, "{not json");
      const ctx = { home, settingsPath: "", configPath: "", dataDir: "" };
      assert.equal(await hermesAdapter.providerStatus(ctx), null);
    });
  });

  it("a Fireworks setup made by hand doesn't count as routed", async () => {
    await withTempHome("hermes-hand-status-", async (home) => {
      await seed(home, { config: "model:\n  provider: fireworks\n  default: accounts/fireworks/models/glm-5p2\n" });
      const ctx = { home, settingsPath: "", configPath: "", dataDir: "" };
      assert.equal(await hermesAdapter.providerStatus(ctx), null);
    });
  });

  it("off keeps files added to the plugin directory while connected", async () => {
    await withTempHome("hermes-plugin-extra-", async (home) => {
      const paths = await seed(home);
      const plugin = pluginPaths(paths.configPath);
      await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: TELEMETRY });
      const extra = path.join(plugin.dir, "notes.txt");
      await writeFile(extra, "mine\n");
      assert.equal(await disableHermesFireworks(paths), "restored");
      assert.equal(await readFile(extra, "utf8"), "mine\n");
      assert.equal(await exists(plugin.init), false);
      assert.equal(await exists(plugin.manifest), false);
    });
  });

  it("a repeat on keeps the first snapshot and the selected model", async () => {
    await withTempHome("hermes-repeat-", async (home) => {
      const paths = await seed(home);
      await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, modelId: "glm-latest", headers: TELEMETRY });
      const second = await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: TELEMETRY });
      assert.equal(second.model, "glm-latest");
      const { config } = await readHermesConfigIfExists(paths.configPath);
      assert.deepEqual(Object.keys(config.providers.fireworks.models), ["nexus-auto", "glm-latest"]);
      assert.equal(await disableHermesFireworks(paths), "restored");
      assert.equal(await readFile(paths.configPath, "utf8"), ORIGINAL_CONFIG);
      assert.equal(await readFile(paths.envPath, "utf8"), ORIGINAL_ENV);
    });
  });

  it("on lists the account's catalog in place of other Fireworks rows, and a re-on prunes delisted ones", async () => {
    await withTempHome("hermes-catalog-", async (home) => {
      const paths = await seed(home, {
        config: `${ORIGINAL_CONFIG}providers:\n  fireworks:\n    models:\n      example-model:\n        context_length: 8192\n      old-model: {}\n`,
      });
      const first = await enableHermesFireworks({
        ...paths,
        effectiveApiKey: KEY,
        headers: TELEMETRY,
        catalogModelIds: ["auto", "accounts/fireworks/routers/example-latest", "accounts/fireworks/models/example-model"],
      });
      let { config } = await readHermesConfigIfExists(paths.configPath);
      assert.deepEqual(Object.keys(config.providers.fireworks.models), ["example-model", "nexus-auto", "example-latest"]);
      // A row the catalog still serves keeps its metadata.
      assert.deepEqual(config.providers.fireworks.models["example-model"], { context_length: 8192 });
      assert.deepEqual(first.modelsAdded, ["example-model", "nexus-auto", "example-latest"]);

      await enableHermesFireworks({
        ...paths,
        effectiveApiKey: KEY,
        modelId: "other-latest",
        headers: TELEMETRY,
        catalogModelIds: ["auto", "accounts/fireworks/routers/other-latest"],
      });
      ({ config } = await readHermesConfigIfExists(paths.configPath));
      assert.deepEqual(Object.keys(config.providers.fireworks.models), ["nexus-auto", "other-latest"]);

      // Offline (no fresh catalog), the list stays as it is.
      await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: TELEMETRY });
      ({ config } = await readHermesConfigIfExists(paths.configPath));
      assert.deepEqual(Object.keys(config.providers.fireworks.models), ["nexus-auto", "other-latest"]);
    });
  });

  it("a repeat on drops provider-key headers that are no longer saved", async () => {
    await withTempHome("hermes-drop-byok-", async (home) => {
      const paths = await seed(home);
      await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: { ...TELEMETRY, "x-openai-api-key": "sk-oa" } });
      await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: TELEMETRY });
      const { config } = await readHermesConfigIfExists(paths.configPath);
      assert.equal(config.providers.fireworks.extra_headers["x-openai-api-key"], undefined);
      assert.equal(config.model.extra_headers["X-Team"], "blue");
    });
  });

  it("off on files Nexus created removes them", async () => {
    await withTempHome("hermes-fresh-", async (home) => {
      const paths = pathsIn(home);
      await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: TELEMETRY });
      assert.equal((await stat(paths.configPath)).mode & 0o777, 0o600);
      assert.equal(await disableHermesFireworks(paths), "restored");
      assert.equal(await exists(paths.configPath), false);
      assert.equal(await exists(paths.envPath), false);
    });
  });

  it("on and a stripping off leave flow lists Nexus didn't touch unpadded", async () => {
    await withTempHome("hermes-flow-", async (home) => {
      const flowLines = ["  cli: [hermes-cli]", "  chat: [hermes-cli, hermes-web]", "tags: [a, b]"];
      const paths = await seed(home, { config: `${ORIGINAL_CONFIG}toolsets:\n${flowLines[0]}\n${flowLines[1]}\n${flowLines[2]}\n` });
      await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: TELEMETRY });
      const routed = await readFile(paths.configPath, "utf8");
      for (const line of flowLines) {
        assert.ok(routed.includes(`${line}\n`), `on rewrote ${JSON.stringify(line)}`);
      }

      // A Hermes edit since `on` sends `off` down the strip path, which re-serializes too.
      await writeFile(paths.configPath, `${routed}display:\n  skin: mono\n`);
      assert.equal(await disableHermesFireworks(paths), "stripped");
      const stripped = await readFile(paths.configPath, "utf8");
      for (const line of flowLines) {
        assert.ok(stripped.includes(`${line}\n`), `off rewrote ${JSON.stringify(line)}`);
      }
      assert.doesNotMatch(stripped, /\[ /);
    });
  });

  it("off keeps edits Hermes made while connected and takes back only Nexus's settings", async () => {
    await withTempHome("hermes-rewritten-", async (home) => {
      const paths = await seed(home);
      await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: TELEMETRY });
      const edited = `${await readFile(paths.configPath, "utf8")}display:\n  skin: mono\n`;
      await writeFile(paths.configPath, edited);
      await writeFile(paths.envPath, `${await readFile(paths.envPath, "utf8")}EXA_API_KEY=exa\n`);

      assert.equal(await disableHermesFireworks(paths), "stripped");
      const config = parse(await readFile(paths.configPath, "utf8"));
      assert.deepEqual(config.model, parse(ORIGINAL_CONFIG).model);
      assert.equal(config.providers, undefined);
      assert.equal(config.model_aliases, undefined);
      assert.equal(config.display.skin, "mono");
      const env = await readFile(paths.envPath, "utf8");
      assert.match(env, /^FIREWORKS_API_KEY=fw_original$/m);
      assert.match(env, /^EXA_API_KEY=exa$/m);
      assert.doesNotMatch(env, new RegExp(KEY));
    });
  });

  it("off leaves a provider the user switched to and removes the Fireworks entry Nexus added", async () => {
    await withTempHome("hermes-switched-", async (home) => {
      const paths = await seed(home);
      await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: { ...TELEMETRY, "x-anthropic-api-key": "sk-ant" } });
      // The `model:` section's provider line (the alias has its own, deeper-indented one).
      const raw = (await readFile(paths.configPath, "utf8")).replace(/^  provider: fireworks$/m, "  provider: nous");
      await writeFile(paths.configPath, raw);
      await disableHermesFireworks(paths);
      const config = parse(await readFile(paths.configPath, "utf8"));
      assert.equal(config.model.provider, "nous");
      assert.deepEqual(config.model.extra_headers, { "X-Team": "blue" });
      assert.equal(config.providers, undefined);
      assert.equal(config.model_aliases, undefined);
    });
  });

  it("off puts back a user's own providers and aliases after Hermes edits", async () => {
    await withTempHome("hermes-user-providers-", async (home) => {
      const original = [
        "model:",
        "  provider: openrouter",
        "  default: anthropic/claude-sonnet-4",
        "providers:",
        "  local:",
        "    base_url: http://localhost:8080/v1",
        "  fireworks:",
        "    models:",
        "      example-model: {}",
        "    extra_headers:",
        "      X-Team: blue",
        "model_aliases:",
        "  fast:",
        "    model: glm-latest",
        "    provider: local",
        "",
      ].join("\n");
      const paths = await seed(home, { config: original });
      await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: TELEMETRY });
      const enabled = parse(await readFile(paths.configPath, "utf8"));
      assert.equal(enabled.providers.local.base_url, "http://localhost:8080/v1");
      // `on` extends the user's own Fireworks entry instead of replacing it.
      assert.deepEqual(Object.keys(enabled.providers.fireworks.models), ["example-model", "nexus-auto"]);
      assert.deepEqual(enabled.providers.fireworks.extra_headers, { "X-Team": "blue", ...TELEMETRY });
      assert.equal(enabled.model_aliases.fast.model, "glm-latest");
      await writeFile(paths.configPath, `${await readFile(paths.configPath, "utf8")}display:\n  skin: mono\n`);

      assert.equal(await disableHermesFireworks(paths), "stripped");
      const config = parse(await readFile(paths.configPath, "utf8"));
      assert.deepEqual(config.model, parse(original).model);
      assert.deepEqual(config.providers, parse(original).providers);
      assert.deepEqual(config.model_aliases, parse(original).model_aliases);
      assert.equal(config.display.skin, "mono");
    });
  });

  it("off restores a config deleted while connected", async () => {
    await withTempHome("hermes-deleted-", async (home) => {
      const paths = await seed(home);
      await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: TELEMETRY });
      await unlink(paths.configPath);
      await disableHermesFireworks(paths);
      assert.equal(await readFile(paths.configPath, "utf8"), ORIGINAL_CONFIG);
    });
  });

  it("on refuses a config.yaml that doesn't parse, and writes nothing", async () => {
    await withTempHome("hermes-corrupt-", async (home) => {
      const paths = await seed(home, { config: "model: [unclosed\n" });
      await assert.rejects(
        enableHermesFireworks({ ...paths, effectiveApiKey: KEY }),
        /Couldn't parse Hermes config\.yaml/,
      );
      assert.equal(await readFile(paths.configPath, "utf8"), "model: [unclosed\n");
      assert.equal(await readFile(paths.envPath, "utf8"), ORIGINAL_ENV);
      assert.equal(await exists(hermesBackupPath(paths.dataDir, paths.configPath)), false);
    });
  });

  it("handles a BOM, a bare model string, and an empty file", async () => {
    for (const config of ["\uFEFFmodel: anthropic/claude-sonnet-4\n", "", "# only a comment\n"]) {
      await withTempHome("hermes-shapes-", async (home) => {
        const paths = await seed(home, { config, env: null });
        await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: TELEMETRY });
        const { config: patched } = await readHermesConfigIfExists(paths.configPath);
        assert.equal(patched.model.provider, "fireworks");
        assert.equal(patched.model.default, "nexus-auto");
        await disableHermesFireworks(paths);
        assert.equal(await readFile(paths.configPath, "utf8"), config);
        assert.equal(await exists(paths.envPath), false);
      });
    }
  });

  it("honors HERMES_HOME", async () => {
    await withTempHome("hermes-home-env-", async (home) => {
      const prev = process.env.HERMES_HOME;
      process.env.HERMES_HOME = path.join(home, "alt-hermes");
      try {
        assert.equal(hermesConfigPath(home), path.join(home, "alt-hermes", "config.yaml"));
      } finally {
        if (prev === undefined) {
          delete process.env.HERMES_HOME;
        } else {
          process.env.HERMES_HOME = prev;
        }
      }
    });
  });

  it("key rotation and provider-key removal keep off byte-for-byte", async () => {
    await withTempHome("hermes-sync-", async (home) => {
      const paths = await seed(home);
      await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: { ...TELEMETRY, "x-openai-api-key": "sk-oa" } });
      assert.equal(await refreshHermesGatewayKey({ ...paths, fireworksKey: "fw_rotated_key_67890" }), true);
      assert.match(await readFile(paths.envPath, "utf8"), /^FIREWORKS_API_KEY=fw_rotated_key_67890$/m);
      assert.equal(await refreshHermesGatewayKey({ ...paths, fireworksKey: "fw_rotated_key_67890" }), false);
      assert.equal(await removeHermesSavedProviderKeys({ ...paths, headerNames: ["x-openai-api-key"] }), true);
      const { config } = await readHermesConfigIfExists(paths.configPath);
      assert.equal(config.providers.fireworks.extra_headers["x-openai-api-key"], undefined);
      assert.equal(config.providers.fireworks.extra_headers["X-Title"], "Hermes Agent");

      assert.equal(await disableHermesFireworks(paths), "restored");
      assert.equal(await readFile(paths.configPath, "utf8"), ORIGINAL_CONFIG);
      assert.equal(await readFile(paths.envPath, "utf8"), ORIGINAL_ENV);
    });
  });

  it("key rotation leaves a Hermes not routed through Nexus alone", async () => {
    await withTempHome("hermes-sync-skip-", async (home) => {
      const paths = await seed(home);
      assert.equal(await refreshHermesGatewayKey({ ...paths, fireworksKey: "fw_rotated_key_67890" }), false);
      assert.equal(await readFile(paths.envPath, "utf8"), ORIGINAL_ENV);
    });
  });
});

/**
 * Load the plugin `on` writes against a stand-in `providers` package, the
 * way Hermes's registry does, and report what it registered.
 */
function runPluginAgainstStub(pluginInit, stubDir, { readOnlyFallbacks = false } = {}) {
  const script = `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(stubDir)})
import providers
spec = importlib.util.spec_from_file_location("_hermes_user_provider_fireworks", ${JSON.stringify(pluginInit)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
p = providers.get_provider_profile("fireworks")
print(json.dumps({
    "nexus": getattr(p, "_nexus_auto", False),
    "nexusTop": p.build_api_kwargs_extras(reasoning_config=None, model="nexus-auto")[1],
    "otherTop": p.build_api_kwargs_extras(reasoning_config=None, model="glm-latest")[1],
    "live": p.fetch_models(api_key="k"),
    "fallbacks": list(p.fallback_models),
    "headers": dict(getattr(p, "default_headers", {}) or {}),
}))
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, STUB_READ_ONLY_FALLBACKS: readOnlyFallbacks ? "1" : "" },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const PROVIDERS_STUB = `
import os

_REGISTRY = {}


class ProviderProfile:
    def __init__(self, name, fallback_models=()):
        self.name = name
        self.default_headers = {"X-Base": "1"}
        self._fallbacks = tuple(fallback_models)
        if not os.environ.get("STUB_READ_ONLY_FALLBACKS"):
            self.fallback_models = self._fallbacks

    def build_api_kwargs_extras(self, *, reasoning_config=None, **context):
        return {}, {"top": 1}

    def fetch_models(self, *, api_key=None, base_url=None, timeout=8.0):
        return ["auto", "firerouter/auto", "accounts/fireworks/models/glm-5p2"]


if os.environ.get("STUB_READ_ONLY_FALLBACKS"):
    ProviderProfile.fallback_models = property(lambda self: self._fallbacks)


def register_provider(profile):
    _REGISTRY[profile.name] = profile


def get_provider_profile(name):
    return _REGISTRY.get(name)


register_provider(ProviderProfile("fireworks", ("accounts/fireworks/models/kimi-k2p6",)))
`;

const HAS_PYTHON = spawnSync("python3", ["--version"]).status === 0;

describe("Hermes Nexus Auto plugin", { skip: !HAS_PYTHON && "python3 not installed" }, () => {
  async function pluginWithStub(home, { catalogModelIds = ["auto"] } = {}) {
    const paths = await seed(home);
    await enableHermesFireworks({ ...paths, effectiveApiKey: KEY, headers: TELEMETRY, catalogModelIds });
    const stubDir = path.join(home, "stub");
    await mkdir(path.join(stubDir, "providers"), { recursive: true });
    await writeFile(path.join(stubDir, "providers", "__init__.py"), PROVIDERS_STUB);
    await mkdir(path.join(stubDir, "hermes_cli"), { recursive: true });
    await writeFile(path.join(stubDir, "hermes_cli", "__init__.py"), "");
    await writeFile(path.join(stubDir, "hermes_cli", "config.py"),
      "def load_config():\n    return {'providers': {'fireworks': {'extra_headers': {'HTTP-Referer': 'nexus/v0.11.1'}}}}\n");
    return { init: pluginPaths(paths.configPath).init, stubDir };
  }

  it("sends nexus-auto as auto, and an auto-only catalog pins the picker to Nexus Auto", async () => {
    await withTempHome("hermes-plugin-py-", async (home) => {
      const { init, stubDir } = await pluginWithStub(home);
      const report = runPluginAgainstStub(init, stubDir);
      assert.equal(report.nexus, true);
      assert.deepEqual(report.nexusTop, { top: 1, model: "auto" });
      assert.deepEqual(report.otherTop, { top: 1 });
      // Neither the live rows nor Hermes's own fallbacks: the catalog is `auto` alone.
      assert.deepEqual(report.live, ["nexus-auto"]);
      assert.deepEqual(report.fallbacks, ["nexus-auto"]);
      // Auxiliary clients send the profile's default headers, so Nexus's ride there too.
      assert.deepEqual(report.headers, { "X-Base": "1", "HTTP-Referer": "nexus/v0.11.1" });
    });
  });

  it("serves the Nexus model list as the whole picker when on wrote one", async () => {
    await withTempHome("hermes-plugin-py-pinned-", async (home) => {
      const { init, stubDir } = await pluginWithStub(home, {
        catalogModelIds: ["accounts/fireworks/routers/example-latest", "auto", "accounts/fireworks/models/example-model"],
      });
      const report = runPluginAgainstStub(init, stubDir);
      // Neither the live rows nor Hermes's own fallbacks: only Nexus's list.
      assert.deepEqual(report.live, ["nexus-auto", "example-latest", "example-model"]);
      assert.deepEqual(report.fallbacks, ["nexus-auto", "example-latest", "example-model"]);
      assert.deepEqual(report.nexusTop, { top: 1, model: "auto" });
    });
  });

  it("a re-on with a same-length list never leaves the old list in cached bytecode", async () => {
    await withTempHome("hermes-plugin-pyc-", async (home) => {
      const paths = await seed(home);
      const { dir, init } = pluginPaths(paths.configPath);
      const importList = () => {
        const result = spawnSync("python3", ["-c", [
          "import json, sys",
          "sys.dont_write_bytecode = False",
          `sys.path.insert(0, ${JSON.stringify(path.dirname(dir))})`,
          "sys.modules['providers'] = type(sys)('providers')",
          "sys.modules['providers'].get_provider_profile = lambda name: None",
          "import fireworks",
          "print(json.dumps(fireworks.NEXUS_MODELS))",
        ].join("\n")], {
          encoding: "utf8",
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: "", PYTHONPYCACHEPREFIX: "" },
        });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
      };
      const on = (id) => enableHermesFireworks({
        ...paths, effectiveApiKey: KEY, headers: TELEMETRY, catalogModelIds: ["auto", id],
      });
      await on("example-model-a");
      const { mtime } = await stat(init);
      assert.deepEqual(importList(), ["nexus-auto", "example-model-a"]);
      assert.ok((await readdir(path.join(dir, "__pycache__"))).some((name) => name.startsWith("__init__.")),
        "the import cached bytecode");
      await on("example-model-b");
      // Same size and same whole-second mtime: Python would trust the old bytecode.
      await utimes(init, mtime, mtime);
      assert.deepEqual(importList(), ["nexus-auto", "example-model-b"]);
    });
  });

  it("writes model ids into the plugin source exactly, whatever characters they hold", () => {
    const ids = ["nexus-auto", 'quote"d', "back\\slash", "uni\u00e9", "line\nbreak"];
    const source = hermesPluginSource(ids);
    const line = source.split("\n").find((row) => row.startsWith("NEXUS_MODELS = "));
    const result = spawnSync("python3", ["-c", `import json\n${line}\nprint(json.dumps(NEXUS_MODELS))`], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ids);
  });

  it("still routes nexus-auto when the listing change can't be applied", async () => {
    await withTempHome("hermes-plugin-py-fallback-", async (home) => {
      const { init, stubDir } = await pluginWithStub(home);
      const report = runPluginAgainstStub(init, stubDir, { readOnlyFallbacks: true });
      assert.equal(report.nexus, true);
      assert.deepEqual(report.nexusTop, { top: 1, model: "auto" });
      assert.deepEqual(report.fallbacks, ["accounts/fireworks/models/kimi-k2p6"]);
    });
  });
});

describe("Hermes gateway detection", () => {
  it("is false with no gateway.pid", async () => {
    await withTempHome("hermes-gw-none-", async (home) => {
      const paths = await seed(home);
      assert.equal(hermesGatewayRunning(paths.configPath), false);
    });
  });

  it("is true for a live pid in a hermes-gateway record", async () => {
    await withTempHome("hermes-gw-live-", async (home) => {
      const paths = await seed(home);
      await withLiveProcess(async (pid) => {
        await writeGatewayRecord(paths.configPath, { pid, kind: "hermes-gateway" });
        assert.equal(hermesGatewayRunning(paths.configPath), true);
      });
    });
  });

  it("is false for an exited pid, a foreign kind, garbage, or our own pid", async () => {
    await withTempHome("hermes-gw-stale-", async (home) => {
      const paths = await seed(home);
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await once(child, "exit");
      for (const record of [
        { pid: child.pid, kind: "hermes-gateway" },
        { pid: process.ppid, kind: "something-else" },
        { pid: process.pid, kind: "hermes-gateway" },
        { pid: -1, kind: "hermes-gateway" },
        "not json",
        "12345",
      ]) {
        await writeGatewayRecord(paths.configPath, record);
        assert.equal(hermesGatewayRunning(paths.configPath), false, JSON.stringify(record));
      }
    });
  });
});

describe("nexus hermes CLI", () => {
  it("on and off name a running Hermes gateway in the restart hint", async () => {
    await withTempHome("hermes-cli-gw-", async (home) => {
      const paths = await seed(home);
      const env = { HOME: home, FIREWORKS_API_KEY: "", HERMES_HOME: "" };
      const login = await runFireconnect(["login", "--api-key", KEY], env);
      assert.equal(login.code, 0, login.stderr);
      await withLiveProcess(async (pid) => {
        await writeGatewayRecord(paths.configPath, { pid, kind: "hermes-gateway" });
        const on = await runFireconnect(["hermes", "on", "--skip-install-check"], env);
        assert.equal(on.code, 0, on.stderr);
        assert.match(on.stdout, GATEWAY_HINT);
        assert.match(on.stdout, /hermes gateway stop/);
        assert.doesNotMatch(on.stdout, /Restart Hermes Agent to use the new setup/);
        const off = await runFireconnect(["hermes", "off"], env);
        assert.equal(off.code, 0, off.stderr);
        assert.match(off.stdout, GATEWAY_HINT);
      });
    });
  });

  it("status doesn't report a hand-made Fireworks setup as connected", async () => {
    await withTempHome("hermes-cli-hand-", async (home) => {
      await seed(home, { config: "model:\n  provider: fireworks\n  default: glm-latest\n", env: "FIREWORKS_API_KEY=fw_users_own_key\n" });
      const status = await runFireconnect(["hermes", "status", "--json"], { HOME: home, FIREWORKS_API_KEY: "", HERMES_HOME: "" });
      assert.equal(status.code, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).provider, null);
    });
  });

  it("on, status --json, and off round-trip through the CLI", async () => {
    await withTempHome("hermes-cli-", async (home) => {
      const paths = await seed(home);
      const env = { HOME: home, FIREWORKS_API_KEY: "", HERMES_HOME: "" };
      const login = await runFireconnect(["login", "--api-key", KEY], env);
      assert.equal(login.code, 0, login.stderr);
      const on = await runFireconnect(["hermes", "on", "--skip-install-check"], env);
      assert.equal(on.code, 0, on.stderr);
      assert.match(on.stdout, /Restart Hermes Agent to use the new setup/);
      assert.doesNotMatch(on.stdout, GATEWAY_HINT);

      const { config } = await readHermesConfigIfExists(paths.configPath);
      assert.equal(config.model.provider, "fireworks");
      assert.equal(config.model.default, "nexus-auto");
      assert.equal(config.providers.fireworks.extra_headers["X-Title"], "Hermes Agent");
      assert.match(config.providers.fireworks.extra_headers["HTTP-Referer"], /^nexus\//);

      const status = await runFireconnect(["hermes", "status", "--json"], env);
      assert.equal(status.code, 0, status.stderr);
      const payload = JSON.parse(status.stdout);
      assert.equal(payload.harness, "hermes");
      assert.equal(payload.provider, "fireworks");
      assert.equal(payload.current.main, "nexus-auto");
      assert.equal(payload.apiKeyMode, "literal");

      const off = await runFireconnect(["hermes", "off"], env);
      assert.equal(off.code, 0, off.stderr);
      assert.equal(await readFile(paths.configPath, "utf8"), ORIGINAL_CONFIG);
      assert.equal(await readFile(paths.envPath, "utf8"), ORIGINAL_ENV);
    });
  });
});
