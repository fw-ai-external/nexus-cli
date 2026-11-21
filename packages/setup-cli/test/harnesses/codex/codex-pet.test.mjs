import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  codexBackupPath,
  codexConfigPath,
  codexDataDir,
  disableCodexFireworks,
  enableCodexFireworks,
} from "../../../lib/harnesses/codex/core.mjs";
import {
  CODEX_PET_SELECTOR,
  codexPetDir,
  patchCodexPetRaw,
  stripCodexPetRaw,
} from "../../../lib/harnesses/codex/pet-patch.mjs";
import { patchFireconnectRoutingRaw, stripFireconnectRoutingRaw } from "../../../lib/harnesses/codex/toml-patch.mjs";
import { parseToml } from "../../../lib/harnesses/codex/toml.mjs";
import { withTempHomeEnv } from "../../helpers.mjs";

const ROUTING = {
  providerId: "fireworks-ai",
  baseUrl: "https://api.fireworks.ai/inference/v1",
  modelId: "auto",
  pet: true,
};

describe("Codex terminal pet", () => {
  for (const [name, raw] of [
    ["fresh config", ""],
    ["root keys only", 'model = "gpt-5"\n'],
    ["existing [tui] table", "[tui]\nanimations = false\n\n[other]\na = 1\n"],
    ["dotted tui keys", "tui.animations = false\n"],
    ["tui sub-table only", "[tui.notifications]\nx = 1\n"],
  ]) {
    it(`selects the Fireworks pet for ${name} and strips back to the original`, () => {
      const patched = patchCodexPetRaw(raw);
      assert.equal(parseToml(patched).tables.tui.pet, CODEX_PET_SELECTOR);
      assert.equal(stripCodexPetRaw(patched), raw);
      const routed = patchFireconnectRoutingRaw(raw, ROUTING);
      assert.equal(parseToml(routed).tables.tui.pet, CODEX_PET_SELECTOR);
      assert.equal(patchFireconnectRoutingRaw(routed, ROUTING), routed, "re-on is idempotent");
      assert.doesNotMatch(stripFireconnectRoutingRaw(routed, { stripRootRouting: true }), /nexus: pet/);
    });
  }

  for (const [name, raw] of [
    ["the user's own pet", '[tui]\npet = "codex"\n'],
    ["a hidden pet", '[tui]\npet = "disabled"\n'],
    ["an inline tui table", "tui = { animations = false }\n"],
  ]) {
    it(`leaves ${name} alone`, () => {
      assert.equal(patchCodexPetRaw(raw), raw);
    });
  }

  it("keeps a [tui] header the user has since added keys under", () => {
    const patched = `${patchCodexPetRaw("")}animations = false\n`;
    const stripped = stripCodexPetRaw(patched);
    assert.deepEqual(parseToml(stripped).tables.tui, { animations: false });
    assert.doesNotMatch(stripped, /nexus: pet/);
  });

  it("is off when routing doesn't ask for it", () => {
    const { pet: _pet, ...routing } = ROUTING;
    assert.equal(parseToml(patchFireconnectRoutingRaw("", routing)).tables.tui, undefined);
  });

  it("installs the sprite sheet on `on` and removes it on `off`, restoring config byte for byte", async () => {
    await withTempHomeEnv("codex-pet", async (home) => {
      const configPath = codexConfigPath(home);
      const dataDir = codexDataDir(home);
      const original = 'model = "gpt-5"\n\n[tui]\nanimations = true\n';
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, original);

      await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto" });
      const petDir = codexPetDir(configPath);
      const manifest = JSON.parse(await readFile(path.join(petDir, "pet.json"), "utf8"));
      assert.equal(`custom:${manifest.id}`, CODEX_PET_SELECTOR);
      assert.ok(existsSync(path.join(petDir, manifest.spritesheetPath)));
      assert.equal(parseToml(await readFile(configPath, "utf8")).tables.tui.pet, CODEX_PET_SELECTOR);

      await disableCodexFireworks({ configPath, dataDir, wasEnabled: true });
      assert.equal(await readFile(configPath, "utf8"), original);
      assert.equal(existsSync(petDir), false);
    });
  });

  it("off removes the pet before it touches the config, so a failed off leaves no pet", async () => {
    await withTempHomeEnv("codex-pet-order", async (home) => {
      const configPath = codexConfigPath(home);
      const dataDir = codexDataDir(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, 'model = "gpt-5"\n');
      await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto" });
      const routed = await readFile(configPath, "utf8");

      // A backup recorded for another config makes the restore refuse.
      const backupPath = codexBackupPath(dataDir, configPath);
      const backup = JSON.parse(await readFile(backupPath, "utf8"));
      await writeFile(backupPath, JSON.stringify({ ...backup, configPath: path.join(home, "elsewhere.toml") }));

      await assert.rejects(disableCodexFireworks({ configPath, dataDir, wasEnabled: true }), /refusing to restore/);
      assert.equal(existsSync(codexPetDir(configPath)), false, "pet already removed");
      assert.equal(await readFile(configPath, "utf8"), routed, "config untouched, so off can run again");
    });
  });

  it("off without a backup (the strip path) also removes the pet", async () => {
    await withTempHomeEnv("codex-pet-strip", async (home) => {
      const configPath = codexConfigPath(home);
      const dataDir = codexDataDir(home);
      await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto" });
      await unlink(codexBackupPath(dataDir, configPath));

      assert.equal(await disableCodexFireworks({ configPath, dataDir, wasEnabled: true }), "stripped");
      assert.equal(existsSync(codexPetDir(configPath)), false);
      assert.doesNotMatch(await readFile(configPath, "utf8"), /nexus: pet/);
    });
  });

  it("leaves no pet folder when the user chose their own pet", async () => {
    await withTempHomeEnv("codex-pet-users", async (home) => {
      const configPath = codexConfigPath(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, '[tui]\npet = "codex"\n');
      await enableCodexFireworks({ configPath, dataDir: codexDataDir(home), apiKey: "fw_test", modelId: "auto" });
      assert.equal(parseToml(await readFile(configPath, "utf8")).tables.tui.pet, "codex");
      assert.equal(existsSync(codexPetDir(configPath)), false);
    });
  });

  it("doesn't select the pet when a folder of the user's sits at its path", async () => {
    await withTempHomeEnv("codex-pet-foreign", async (home) => {
      const configPath = codexConfigPath(home);
      const dataDir = codexDataDir(home);
      await mkdir(codexPetDir(configPath), { recursive: true });
      await writeFile(path.join(codexPetDir(configPath), "notes.txt"), "mine");
      await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto" });
      assert.equal(parseToml(await readFile(configPath, "utf8")).tables.tui, undefined);
      await disableCodexFireworks({ configPath, dataDir, wasEnabled: true });
      assert.equal(await readFile(path.join(codexPetDir(configPath), "notes.txt"), "utf8"), "mine");
    });
  });
});
