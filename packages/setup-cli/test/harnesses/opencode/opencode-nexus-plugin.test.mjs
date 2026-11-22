import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  disableOpencodeFireworks,
  enableOpencodeAzure,
  enableOpencodeFireworks,
  opencodeBackupPath,
  opencodeConfigPath,
  opencodeDataDir,
} from "../../../lib/harnesses/opencode/core.mjs";
import { opencodePluginDir } from "../../../lib/harnesses/opencode/nexus-plugin.mjs";
import { withTempHomeEnv } from "../../helpers.mjs";

const ON = { apiKey: "fw_example_test_key", modelId: "auto", catalogModelIds: ["auto"] };

describe("OpenCode Fireworks sidebar card", () => {
  it("installs the plugin folder on `on`, removes it on `off`, and leaves opencode.json's restore byte-identical", async () => {
    await withTempHomeEnv("opencode-plugin", async (home) => {
      const configPath = opencodeConfigPath(home);
      const dataDir = opencodeDataDir(home);
      const original = `${JSON.stringify({ $schema: "https://opencode.ai/config.json", theme: "system" }, null, 2)}\n`;
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, original);

      await enableOpencodeFireworks({ configPath, dataDir, ...ON });
      const dir = opencodePluginDir(configPath);
      assert.equal(dir, path.join(home, ".config", "opencode", "plugins", "fireworks-nexus"));
      assert.match(await readFile(path.join(dir, "tui.tsx"), "utf8"), /prepend: "sidebar\.content"/);
      assert.doesNotMatch(await readFile(configPath, "utf8"), /fireworks-nexus/, "plugin is auto-discovered, not listed in config");

      await disableOpencodeFireworks({ configPath, dataDir, wasEnabled: true });
      assert.equal(await readFile(configPath, "utf8"), original);
      assert.equal(existsSync(dir), false);
    });
  });

  it("off removes the card before it touches the config, so a failed off leaves no card", async () => {
    await withTempHomeEnv("opencode-plugin-order", async (home) => {
      const configPath = opencodeConfigPath(home);
      const dataDir = opencodeDataDir(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, `${JSON.stringify({ theme: "system" }, null, 2)}\n`);
      await enableOpencodeFireworks({ configPath, dataDir, ...ON });
      const routed = await readFile(configPath, "utf8");

      // An unreadable backup makes the restore throw.
      await writeFile(opencodeBackupPath(dataDir, configPath), "{ not json");

      await assert.rejects(disableOpencodeFireworks({ configPath, dataDir, wasEnabled: true }));
      assert.equal(existsSync(opencodePluginDir(configPath)), false, "card already removed");
      assert.equal(await readFile(configPath, "utf8"), routed, "config untouched, so off can run again");
    });
  });

  it("switching to Azure removes the Fireworks card", async () => {
    await withTempHomeEnv("opencode-plugin-azure", async (home) => {
      const configPath = opencodeConfigPath(home);
      const dataDir = opencodeDataDir(home);
      await enableOpencodeFireworks({ configPath, dataDir, ...ON });
      assert.ok(existsSync(opencodePluginDir(configPath)));

      await enableOpencodeAzure({
        configPath,
        dataDir,
        apiKey: "example-azure-key",
        apiKeyFromFlag: true,
        baseUrl: "https://example-resource.services.ai.azure.com",
      });
      assert.equal(existsSync(opencodePluginDir(configPath)), false);
    });
  });

  it("ships a plugin that can't take OpenCode down", async () => {
    const source = await readFile(new URL("../../../lib/harnesses/opencode/nexus-plugin/tui.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(source, /from "@opencode\/plugin/, "no import that a 2.x release could move");
    assert.match(source, /export default \{\s*id: "fireworks\.nexus"/);
    assert.match(source, /setup\(context[^)]*\) \{\s*try \{/, "setup is guarded");
    assert.match(source, /<ErrorBoundary fallback=/, "render errors are contained");
  });
});
