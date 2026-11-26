import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  codexConfigPath,
  codexDataDir,
  codexUltrafastCachePath,
  disableCodexFireworks,
  enableCodexFireworks,
} from "../../../lib/harnesses/codex/core.mjs";
import { codexPetDir } from "../../../lib/harnesses/codex/pet-patch.mjs";
import { patchFireconnectRoutingRaw, stripFireconnectRoutingRaw } from "../../../lib/harnesses/codex/toml-patch.mjs";
import { parseToml } from "../../../lib/harnesses/codex/toml.mjs";
import {
  CODEX_ULTRAFAST_MIN_VERSION,
  ULTRAFAST_ENV_VARS,
  ULTRAFAST_MARKER,
  canPatchCodexUltrafast,
  configuredCodexUltrafastServer,
  hasCodexUltrafast,
  patchCodexUltrafastRaw,
  stripCodexUltrafastRaw,
} from "../../../lib/harnesses/codex/ultrafast-patch.mjs";
import { applyCachedBoostToPet, codexUltrafastEnabled, codexUltrafastInstall, codexUltrafastServerPath, refreshCodexUltrafastPet } from "../../../lib/harnesses/codex/ultrafast.mjs";
import {
  CODEX_ULTRAFAST_MOVED_NOTE,
  CODEX_ULTRAFAST_NOTE,
  codexUltrafastReonReason,
} from "../../../lib/harnesses/codex/upgrade-reon.mjs";
import { withTempHomeEnv } from "../../helpers.mjs";

const OPTIONS = {
  nodePath: "/opt/node/bin/node",
  serverPath: "/opt/nexus/mods/codex-ultrafast/statusline-server.mjs",
  configPath: "/home/example/.codex/config.toml",
  petDir: "/home/example/.codex/pets/fireworks-nexus",
  cacheFile: "/home/example/.nexus/codex/ultrafast-status.0123456789abcdef.json",
};
const ROUTING = { providerId: "fireworks-ai", baseUrl: "https://api.fireworks.ai/inference/v1", modelId: "auto", pet: true };

describe("Codex Ultra-fast config patch", () => {
  const shapes = {
    empty: "",
    "plain config": 'model = "gpt-5"\n',
    "a [tui] table": '[tui]\nanimations = true\n',
    "a [features] table": "[features]\nweb_search = true\n",
    "dotted tui keys": 'tui.animations = false\nmodel = "gpt-5"\n',
    "other MCP servers": '[mcp_servers.docs]\ncommand = "docs-mcp"\nargs = ["--stdio"]\n',
    "comments and blank lines": "# my settings\n\n[tui]\n# keep this\nanimations = true\n\n",
  };
  for (const [name, raw] of Object.entries(shapes)) {
    it(`adds the three pieces to ${name}, and the strip returns the original`, () => {
      const patched = patchCodexUltrafastRaw(raw, OPTIONS);
      const doc = parseToml(patched);
      assert.equal(doc.tables.features.tui_extensions_statusline, true);
      assert.deepEqual({ ...doc.tables.tui.status_line_provider }, { server: "fireworks-nexus", tool: "ultrafast_status" });
      const server = doc.tables["mcp_servers.fireworks-nexus"];
      assert.equal(server.command, OPTIONS.nodePath);
      assert.deepEqual(server.args, [OPTIONS.serverPath]);
      assert.deepEqual({ ...server.env }, { NEXUS_CODEX_CONFIG: OPTIONS.configPath, NEXUS_CODEX_PET_DIR: OPTIONS.petDir, NEXUS_CODEX_STATUS_CACHE: OPTIONS.cacheFile });
      assert.deepEqual(server.env_vars, [...ULTRAFAST_ENV_VARS]);
      assert.ok(!ULTRAFAST_ENV_VARS.some((name) => /KEY|TOKEN/.test(name)), "no key passes through the environment");
      assert.ok(hasCodexUltrafast(patched));
      assert.equal(configuredCodexUltrafastServer(patched), OPTIONS.serverPath);
      const stripped = stripCodexUltrafastRaw(patched);
      assert.equal(stripped, raw);
      assert.ok(!stripped.includes(ULTRAFAST_MARKER));
    });
  }

  it("leaves the pet folder out of env when Nexus's pet isn't selected", () => {
    const doc = parseToml(patchCodexUltrafastRaw("", { ...OPTIONS, petDir: "" }));
    assert.deepEqual({ ...doc.tables["mcp_servers.fireworks-nexus"].env }, { NEXUS_CODEX_CONFIG: OPTIONS.configPath, NEXUS_CODEX_STATUS_CACHE: OPTIONS.cacheFile });
  });

  const userChoices = {
    "their own status line provider": '[tui]\nstatus_line_provider = { server = "mine", tool = "line" }\n',
    "the status line feature turned off": "[features]\ntui_extensions_statusline = false\n",
    "their own fireworks-nexus MCP server": '[mcp_servers.fireworks-nexus]\ncommand = "mine"\n',
    "an inline tui table": "tui = { animations = true }\n",
    "an inline features table": "features = { web_search = true }\n",
    "an inline mcp_servers table": 'mcp_servers = { other = { command = "x" } }\n',
    "invalid TOML": "[tui\n",
  };
  for (const [name, raw] of Object.entries(userChoices)) {
    it(`leaves a config with ${name} alone`, () => {
      assert.equal(canPatchCodexUltrafast(raw), false);
      assert.equal(patchCodexUltrafastRaw(raw, OPTIONS), raw);
    });
  }

  it("keeps a [tui] header the user has since put keys under", () => {
    const patched = `${patchCodexUltrafastRaw("", OPTIONS)}`.replace(
      `status_line_provider = { server = "fireworks-nexus", tool = "ultrafast_status" } ${ULTRAFAST_MARKER}\n`,
      `status_line_provider = { server = "fireworks-nexus", tool = "ultrafast_status" } ${ULTRAFAST_MARKER}\nanimations = false\n`,
    );
    const stripped = stripCodexUltrafastRaw(patched);
    assert.deepEqual({ ...parseToml(stripped).tables.tui }, { animations: false });
    assert.ok(!stripped.includes(ULTRAFAST_MARKER));
  });

  it("is part of the routing patch: re-on is idempotent and the routing strip removes it", () => {
    const raw = '# mine\n[tui]\nanimations = true\n\n[mcp_servers.docs]\ncommand = "docs"\n';
    const routing = { ...ROUTING, ultrafast: OPTIONS };
    const on = patchFireconnectRoutingRaw(raw, routing);
    assert.ok(hasCodexUltrafast(on));
    assert.equal(patchFireconnectRoutingRaw(on, routing), on);
    const off = stripFireconnectRoutingRaw(on, { stripRootRouting: true });
    assert.ok(!off.includes(ULTRAFAST_MARKER));
    assert.ok(!off.includes("nexus: pet"));
    assert.equal(off.trim(), raw.trim());
  });

  it("is absent when routing doesn't ask for it", () => {
    assert.equal(hasCodexUltrafast(patchFireconnectRoutingRaw("", ROUTING)), false);
  });
});

describe("Codex Ultra-fast install gate", () => {
  it("needs a known Codex at or above the minimum version, and no opt-out", () => {
    assert.equal(CODEX_ULTRAFAST_MIN_VERSION, "0.171.0");
    assert.equal(codexUltrafastEnabled("0.171.0", {}), true);
    assert.equal(codexUltrafastEnabled("0.172.3", {}), true);
    assert.equal(codexUltrafastEnabled("0.170.9", {}), false);
    assert.equal(codexUltrafastEnabled("", {}), false);
    assert.equal(codexUltrafastEnabled("0.172.0", { NEXUS_CODEX_ULTRAFAST: "0" }), false);
  });

  it("points Codex at this install's server, run by this Node", async () => {
    const install = await codexUltrafastInstall({ env: {}, version: async () => "0.171.0", execPath: "/opt/node/bin/node" });
    assert.deepEqual(install, { nodePath: "/opt/node/bin/node", serverPath: codexUltrafastServerPath() });
    assert.match(install.serverPath, /mods\/codex-ultrafast\/statusline-server\.mjs$/);
    assert.equal(await codexUltrafastInstall({ env: {}, version: async () => "0.170.0" }), null);
    assert.equal(await codexUltrafastInstall({ env: {}, version: async () => { throw new Error("no codex"); } }), null);
    assert.equal(await codexUltrafastInstall({ env: { NEXUS_CODEX_ULTRAFAST: "0" }, version: async () => "0.172.0" }), null);
  });
});

describe("Codex Ultra-fast through on and off", () => {
  it("on writes the footer pieces next to the pet; off restores the config byte for byte", async () => {
    await withTempHomeEnv("codex-ultrafast", async (home) => {
      const configPath = codexConfigPath(home);
      const dataDir = codexDataDir(home);
      const original = 'model = "gpt-5"\n\n[tui]\nanimations = true\n';
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, original);

      const ultrafast = { nodePath: "/opt/node/bin/node", serverPath: codexUltrafastServerPath() };
      await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto", ultrafast });
      const doc = parseToml(await readFile(configPath, "utf8"));
      assert.equal(doc.tables.features.tui_extensions_statusline, true);
      assert.deepEqual({ ...doc.tables["mcp_servers.fireworks-nexus"].env }, {
        NEXUS_CODEX_CONFIG: configPath,
        NEXUS_CODEX_PET_DIR: codexPetDir(configPath),
        NEXUS_CODEX_STATUS_CACHE: codexUltrafastCachePath(dataDir, configPath),
      });
      assert.ok(!codexUltrafastCachePath(dataDir, configPath).startsWith(codexPetDir(configPath)), "the cache is not in the folder off deletes");

      await disableCodexFireworks({ configPath, dataDir, wasEnabled: true });
      assert.equal(await readFile(configPath, "utf8"), original);
    });
  });

  it("re-on during a boost writes the boost pet from a cache checked with the same key", async () => {
    const { keyTag } = await import("../../../mods/codex-ultrafast/server.mjs");
    const ultrafast = { nodePath: "/opt/node/bin/node", serverPath: codexUltrafastServerPath() };
    const now = Date.now();
    const running = { active: true, activationId: "w1", activatedAt: now - 3_600_000, expiresAt: now + 3_600_000, reason: "" };
    const cases = [
      ["the same key, a running boost", { keyTag: keyTag("fw_test"), status: running, fetchedAt: now - 60_000 }, true],
      ["another key", { keyTag: keyTag("fw_other"), status: running, fetchedAt: now - 60_000 }, false],
      ["an expired boost", { keyTag: keyTag("fw_test"), status: { ...running, expiresAt: now - 1000 }, fetchedAt: now - 60_000 }, false],
      ["a stale cache", { keyTag: keyTag("fw_test"), status: running, fetchedAt: now - 2 * 24 * 3_600_000 }, false],
    ];
    for (const [name, cache, boosted] of cases) {
      await withTempHomeEnv("codex-ultrafast-pet", async (home) => {
        const configPath = codexConfigPath(home);
        const dataDir = codexDataDir(home);
        await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto", ultrafast });
        const petDir = codexPetDir(configPath);
        await writeFile(codexUltrafastCachePath(dataDir, configPath), JSON.stringify(cache));
        await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto", ultrafast });
        const pet = JSON.parse(await readFile(path.join(petDir, "pet.json"), "utf8"));
        assert.equal(Boolean(pet.animations.level), boosted, name);
      });
    }
  });

  it("off then on during a boost still shows the boost pet (off deletes the pet folder, not the cache)", async () => {
    const { keyTag } = await import("../../../mods/codex-ultrafast/server.mjs");
    const ultrafast = { nodePath: "/opt/node/bin/node", serverPath: codexUltrafastServerPath() };
    const now = Date.now();
    const running = { active: true, activationId: "w1", activatedAt: now - 3_600_000, expiresAt: now + 3_600_000, reason: "" };
    await withTempHomeEnv("codex-ultrafast-off-on", async (home) => {
      const configPath = codexConfigPath(home);
      const dataDir = codexDataDir(home);
      const petDir = codexPetDir(configPath);
      await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto", ultrafast });
      await writeFile(codexUltrafastCachePath(dataDir, configPath), JSON.stringify({ keyTag: keyTag("fw_test"), status: running, fetchedAt: now - 60_000 }));
      await disableCodexFireworks({ configPath, dataDir, wasEnabled: true });
      assert.equal(existsSync(petDir), false, "off removes the pet folder");
      assert.ok(existsSync(codexUltrafastCachePath(dataDir, configPath)), "the cache survives off");
      await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto", ultrafast });
      const pet = JSON.parse(await readFile(path.join(petDir, "pet.json"), "utf8"));
      assert.ok(pet.animations.level, "the boost pet is in place before Codex starts");
    });
  });

  it("the first on after an upgrade uses a cache an older server left in the pet folder; not under NEXUS_ULTRAFAST_STATUS=0", async () => {
    const { keyTag } = await import("../../../mods/codex-ultrafast/server.mjs");
    const ultrafast = { nodePath: "/opt/node/bin/node", serverPath: codexUltrafastServerPath() };
    const now = Date.now();
    const running = { active: true, activationId: "w1", activatedAt: now - 3_600_000, expiresAt: now + 3_600_000, reason: "" };
    const cache = JSON.stringify({ keyTag: keyTag("fw_test"), status: running, fetchedAt: now - 60_000 });
    for (const [status, boosted] of [[undefined, true], ["0", false]]) {
      await withTempHomeEnv("codex-ultrafast-legacy-cache", async (home) => {
        const configPath = codexConfigPath(home);
        const dataDir = codexDataDir(home);
        await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto", ultrafast });
        const petDir = codexPetDir(configPath);
        await writeFile(path.join(petDir, "ultrafast-status.json"), cache);
        const saved = process.env.NEXUS_ULTRAFAST_STATUS;
        if (status === undefined) delete process.env.NEXUS_ULTRAFAST_STATUS;
        else process.env.NEXUS_ULTRAFAST_STATUS = status;
        try {
          await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto", ultrafast });
        } finally {
          if (saved === undefined) delete process.env.NEXUS_ULTRAFAST_STATUS;
          else process.env.NEXUS_ULTRAFAST_STATUS = saved;
        }
        const pet = JSON.parse(await readFile(path.join(petDir, "pet.json"), "utf8"));
        assert.equal(Boolean(pet.animations.level), boosted, `NEXUS_ULTRAFAST_STATUS=${status}`);
        if (boosted) {
          const copied = JSON.parse(await readFile(codexUltrafastCachePath(dataDir, configPath), "utf8"));
          assert.deepEqual({ ...copied, endedAt: undefined }, { ...JSON.parse(cache), endedAt: undefined }, "copied out of the pet folder");
          await disableCodexFireworks({ configPath, dataDir, wasEnabled: true });
          await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto", ultrafast });
          assert.ok(JSON.parse(await readFile(path.join(petDir, "pet.json"), "utf8")).animations.level, "an off right after still keeps it");
        }
      });
    }
  });

  it("re-on picks the newer of the two caches, and reads the pet folder's when the new path is unusable", async () => {
    const { keyTag } = await import("../../../mods/codex-ultrafast/server.mjs");
    const ultrafast = { nodePath: "/opt/node/bin/node", serverPath: codexUltrafastServerPath() };
    const now = Date.now();
    const running = { active: true, activationId: "w2", activatedAt: now - 3_600_000, expiresAt: now + 3_600_000, reason: "" };
    const ended = { ...running, activationId: "w1", expiresAt: now - 60_000 };
    const record = (status, fetchedAt) => JSON.stringify({ keyTag: keyTag("fw_test"), status, fetchedAt });
    for (const [name, prepare] of [
      ["an older server saved a newer boost in the pet folder", async (cacheFile) => writeFile(cacheFile, record(ended, now - 600_000))],
      ["a folder where the new cache goes", async (cacheFile) => mkdir(cacheFile, { recursive: true })],
    ]) {
      await withTempHomeEnv("codex-ultrafast-two-caches", async (home) => {
        const configPath = codexConfigPath(home);
        const dataDir = codexDataDir(home);
        await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto", ultrafast });
        const petDir = codexPetDir(configPath);
        await prepare(codexUltrafastCachePath(dataDir, configPath));
        await writeFile(path.join(petDir, "ultrafast-status.json"), record(running, now - 60_000));
        await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto", ultrafast });
        assert.ok(JSON.parse(await readFile(path.join(petDir, "pet.json"), "utf8")).animations.level, name);
      });
    }
  });

  it("warns, without the key, when the pet-folder cache can't be copied forward", async () => {
    const { keyTag } = await import("../../../mods/codex-ultrafast/server.mjs");
    const ultrafast = { nodePath: "/opt/node/bin/node", serverPath: codexUltrafastServerPath() };
    const now = Date.now();
    const running = { active: true, activationId: "w1", activatedAt: now - 3_600_000, expiresAt: now + 3_600_000, reason: "" };
    await withTempHomeEnv("codex-ultrafast-copy-warning", async (home) => {
      const configPath = codexConfigPath(home);
      const dataDir = codexDataDir(home);
      await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto", ultrafast });
      const petDir = codexPetDir(configPath);
      const cacheFile = codexUltrafastCachePath(dataDir, configPath);
      await mkdir(cacheFile, { recursive: true }); // a folder where the file goes: the copy fails
      await writeFile(path.join(petDir, "ultrafast-status.json"), JSON.stringify({ keyTag: keyTag("fw_test"), status: running, fetchedAt: now - 60_000 }));
      const warnings = [];
      assert.equal(await applyCachedBoostToPet(petDir, "fw_test", { cacheFile, env: {}, now, warn: (m) => warnings.push(m) }), true, "this on still shows the boost");
      assert.equal(warnings.length, 1, "one warning for one broken cache");
      assert.match(warnings[0], /could not (read|save) the Ultra-fast status/);
      assert.ok(warnings[0].includes(path.dirname(cacheFile)));
      assert.ok(!warnings[0].includes("fw_test"), "never the key");
    });
  });

  it("a pet-folder record older than another account's newer record doesn't come back", async () => {
    const { keyTag } = await import("../../../mods/codex-ultrafast/server.mjs");
    const now = Date.now();
    const running = { active: true, activationId: "w1", activatedAt: now - 3_600_000, expiresAt: now + 3_600_000, reason: "" };
    await withTempHomeEnv("codex-ultrafast-stale-legacy", async (home) => {
      const petDir = path.join(home, "pet");
      const cacheFile = codexUltrafastCachePath(path.join(home, "data"), path.join(home, "config.toml"));
      await mkdir(petDir, { recursive: true });
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(path.join(petDir, "ultrafast-status.json"), JSON.stringify({ keyTag: keyTag("fw_a"), status: running, fetchedAt: now - 600_000 }));
      await writeFile(cacheFile, JSON.stringify({ keyTag: keyTag("fw_b"), status: { ...running, active: false }, fetchedAt: now - 60_000 }));
      assert.equal(await applyCachedBoostToPet(petDir, "fw_a", { cacheFile, env: {}, now }), false);
    });
  });

  it("the warning shows no control characters from the folder name", async () => {
    const { codexUltrafastCacheWarning } = await import("../../../lib/harnesses/codex/ultrafast.mjs");
    const text = codexUltrafastCacheWarning("/tmp/x\u001b[2J\u0007y/ultrafast-status.0123456789abcdef.json", { code: "EACCES\u001b" });
    assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f]/);
    assert.match(text, /\/tmp\/x\?\[2J\?y/);
  });

  it("warns when the cache can't be read, and stays quiet when there's none", async () => {
    await withTempHomeEnv("codex-ultrafast-read-warning", async (home) => {
      const petDir = path.join(home, "pet");
      const cacheFile = codexUltrafastCachePath(path.join(home, "data"), path.join(home, "config.toml"));
      await mkdir(petDir, { recursive: true });
      const warnings = [];
      const warn = (m) => warnings.push(m);
      assert.equal(await applyCachedBoostToPet(petDir, "fw_test", { cacheFile, env: {}, warn }), false);
      assert.deepEqual(warnings, [], "no cache yet: nothing to report");
      await mkdir(cacheFile, { recursive: true }); // a folder where the file goes
      assert.equal(await applyCachedBoostToPet(petDir, "fw_test", { cacheFile, env: {}, warn }), false);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /could not read the Ultra-fast status/);
      assert.ok(!warnings[0].includes("fw_test"));
    });
  });

  it("never copies a pet-folder cache that doesn't check out", async () => {
    const ultrafast = { nodePath: "/opt/node/bin/node", serverPath: codexUltrafastServerPath() };
    await withTempHomeEnv("codex-ultrafast-bad-legacy", async (home) => {
      const configPath = codexConfigPath(home);
      const dataDir = codexDataDir(home);
      await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto", ultrafast });
      await writeFile(path.join(codexPetDir(configPath), "ultrafast-status.json"), 'model = "example"\n');
      await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto", ultrafast });
      assert.equal(existsSync(codexUltrafastCachePath(dataDir, configPath)), false);
    });
  });

  it("leaves the plain pet when the config kept the user's own footer", async () => {
    const { keyTag } = await import("../../../mods/codex-ultrafast/server.mjs");
    const ultrafast = { nodePath: "/opt/node/bin/node", serverPath: codexUltrafastServerPath() };
    const now = Date.now();
    const running = { active: true, activationId: "w1", activatedAt: now - 3_600_000, expiresAt: now + 3_600_000, reason: "" };
    await withTempHomeEnv("codex-ultrafast-own-footer", async (home) => {
      const configPath = codexConfigPath(home);
      const dataDir = codexDataDir(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, '[tui]\nstatus_line_provider = { server = "mine", tool = "line" }\n');
      await mkdir(dataDir, { recursive: true });
      await writeFile(codexUltrafastCachePath(dataDir, configPath), JSON.stringify({ keyTag: keyTag("fw_test"), status: running, fetchedAt: now - 60_000 }));
      await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto", ultrafast });
      assert.equal(hasCodexUltrafast(await readFile(configPath, "utf8")), false);
      assert.equal(JSON.parse(await readFile(path.join(codexPetDir(configPath), "pet.json"), "utf8")).animations.level, undefined);
    });
  });

  it("names an absolute cache path the server accepts, and creates its folder", async () => {
    const { isStatusCacheFile } = await import("../../../mods/codex-ultrafast/ultrafast.mjs");
    const relative = codexUltrafastCachePath("relative-data", "/home/example/.codex/config.toml");
    assert.ok(path.isAbsolute(relative), "a relative --data-dir doesn't follow Codex's working folder");
    assert.ok(isStatusCacheFile(relative));
    await withTempHomeEnv("codex-ultrafast-cache-dir", async (home) => {
      const configPath = codexConfigPath(home);
      const dataDir = path.join(home, "fresh-data");
      const ultrafast = { nodePath: "/opt/node/bin/node", serverPath: codexUltrafastServerPath() };
      await enableCodexFireworks({ configPath, dataDir, apiKey: "fw_test", modelId: "auto", ultrafast });
      assert.ok(existsSync(path.dirname(codexUltrafastCachePath(dataDir, configPath))));
    });
  });

  it("off without a backup strips the footer with the rest of Nexus's lines", async () => {
    await withTempHomeEnv("codex-ultrafast-strip", async (home) => {
      const configPath = codexConfigPath(home);
      const dataDir = codexDataDir(home);
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, patchFireconnectRoutingRaw('[tui]\nanimations = true\n', { ...ROUTING, ultrafast: OPTIONS }));
      await disableCodexFireworks({ configPath, dataDir, wasEnabled: true });
      const raw = await readFile(configPath, "utf8");
      assert.ok(!raw.includes(ULTRAFAST_MARKER));
      assert.equal(parseToml(raw).tables["mcp_servers.fireworks-nexus"], undefined);
    });
  });

  it("without the option (old Codex or opted out) on adds nothing", async () => {
    await withTempHomeEnv("codex-ultrafast-off", async (home) => {
      const configPath = codexConfigPath(home);
      await enableCodexFireworks({ configPath, dataDir: codexDataDir(home), apiKey: "fw_test", modelId: "auto" });
      assert.equal(hasCodexUltrafast(await readFile(configPath, "utf8")), false);
    });
  });
});

describe("Codex Ultra-fast after an upgrade", () => {
  const withVersion = async (version, fn) => {
    const saved = process.env.NEXUS_TEST_CODEX_VERSION;
    process.env.NEXUS_TEST_CODEX_VERSION = version;
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env.NEXUS_TEST_CODEX_VERSION;
      else process.env.NEXUS_TEST_CODEX_VERSION = saved;
    }
  };

  it("re-points a footer whose server moved, and leaves a current one alone", async () => {
    // The installed path itself, checked independently of the code that compares it.
    assert.match(codexUltrafastServerPath(), /[/\\]mods[/\\]codex-ultrafast[/\\]statusline-server\.mjs$/);
    assert.ok(existsSync(codexUltrafastServerPath()), "the server script ships where Codex is pointed");
    await withVersion("0.171.0", async () => {
      const moved = patchCodexUltrafastRaw("", { ...OPTIONS, serverPath: "/old/install/mods/codex-ultrafast/statusline-server.mjs" });
      assert.equal(await codexUltrafastReonReason(moved, "/home/example"), CODEX_ULTRAFAST_MOVED_NOTE);
      const current = patchCodexUltrafastRaw("", { ...OPTIONS, serverPath: codexUltrafastServerPath() });
      assert.equal(await codexUltrafastReonReason(current, "/home/example"), "");
      const uncached = patchCodexUltrafastRaw("", { ...OPTIONS, serverPath: codexUltrafastServerPath(), cacheFile: "" });
      assert.equal(await codexUltrafastReonReason(uncached, "/home/example"), CODEX_ULTRAFAST_MOVED_NOTE, "an older on's footer moves its cache out of the pet folder");
    });
  });

  it("adds the footer for a supported Codex unless the config rules it out", async () => {
    await withVersion("0.171.0", async () => {
      assert.equal(await codexUltrafastReonReason('model = "auto"\n', "/home/example"), CODEX_ULTRAFAST_NOTE);
      assert.equal(await codexUltrafastReonReason('[tui]\nstatus_line_provider = { server = "mine", tool = "x" }\n', "/home/example"), "");
    });
    await withVersion("0.170.0", async () => {
      assert.equal(await codexUltrafastReonReason('model = "auto"\n', "/home/example"), "");
    });
  });
});

describe("Codex Ultra-fast after a login", () => {
  const now = Date.now();
  const window = (end) => ({ featureAvailable: true, readTime: new Date(now).toISOString(), activeWindow: { windowId: "w9", startTime: new Date(now - 3_600_000).toISOString(), endTime: new Date(end).toISOString() } });
  const fakeFetch = (statusBody) => async (url) => {
    if (url.endsWith("/verifyApiKey")) return { status: 200, ok: true, headers: { "x-fireworks-account-id": "example-account" }, text: "{}" };
    if (statusBody === "down") throw new Error("offline");
    return { status: 200, ok: true, headers: {}, text: JSON.stringify(statusBody) };
  };
  const setup = async (home) => {
    const configPath = codexConfigPath(home);
    const ultrafast = { nodePath: "/opt/node/bin/node", serverPath: codexUltrafastServerPath() };
    await enableCodexFireworks({ configPath, dataDir: codexDataDir(home), apiKey: "fw_old", modelId: "auto", ultrafast });
    return { configPath, petDir: codexPetDir(configPath), cacheFile: codexUltrafastCachePath(codexDataDir(home), configPath) };
  };
  const pet = async (petDir) => JSON.parse(await readFile(path.join(petDir, "pet.json"), "utf8"));

  it("a boosted account's key sets the boost pet and caches the status for the server", async () => {
    await withTempHomeEnv("codex-ultrafast-login", async (home) => {
      const { configPath, petDir, cacheFile } = await setup(home);
      const result = await refreshCodexUltrafastPet({ configPath, apiKey: "fw_new", env: {}, fetch: fakeFetch(window(now + 3_600_000)), now: () => now });
      assert.equal(result, "boost");
      assert.ok((await pet(petDir)).animations.level, "the boost pet");
      const cache = JSON.parse(await readFile(cacheFile, "utf8"));
      const { keyTag } = await import("../../../mods/codex-ultrafast/server.mjs");
      assert.equal(cache.keyTag, keyTag("fw_new"));
      assert.ok(!JSON.stringify(cache).includes("fw_new"));
    });
  });

  it("no answer resets a pet left from another key, and keeps one checked with this key", async () => {
    await withTempHomeEnv("codex-ultrafast-login-down", async (home) => {
      const { configPath, petDir } = await setup(home);
      await refreshCodexUltrafastPet({ configPath, apiKey: "fw_old", env: {}, fetch: fakeFetch(window(now + 3_600_000)), now: () => now });
      assert.ok((await pet(petDir)).animations.level);
      assert.equal(await refreshCodexUltrafastPet({ configPath, apiKey: "fw_old", env: {}, fetch: fakeFetch("down"), now: () => now }), "kept");
      assert.ok((await pet(petDir)).animations.level, "same key: kept");
      assert.equal(await refreshCodexUltrafastPet({ configPath, apiKey: "fw_other", env: {}, fetch: fakeFetch("down"), now: () => now }), "plain");
      assert.equal((await pet(petDir)).animations.level, undefined, "another key: plain");
    });
  });

  it("writes the cache the config names, or the pet folder for a footer an older on wrote", async () => {
    await withTempHomeEnv("codex-ultrafast-login-legacy", async (home) => {
      const { configPath, petDir, cacheFile } = await setup(home);
      const raw = await readFile(configPath, "utf8");
      await writeFile(configPath, raw.replace(/, NEXUS_CODEX_STATUS_CACHE = "[^"]*"/, ""));
      assert.equal(await refreshCodexUltrafastPet({ configPath, apiKey: "fw_new", env: {}, fetch: fakeFetch(window(now + 3_600_000)), now: () => now }), "boost");
      assert.ok(existsSync(path.join(petDir, "ultrafast-status.json")), "where that server reads it");
      assert.equal(existsSync(cacheFile), false);
    });
  });

  it("sets the pet even when the cache can't be written", async () => {
    await withTempHomeEnv("codex-ultrafast-login-unwritable", async (home) => {
      const { configPath, petDir, cacheFile } = await setup(home);
      await mkdir(cacheFile, { recursive: true }); // a folder where the file goes: the write fails
      const warnings = [];
      assert.equal(await refreshCodexUltrafastPet({ configPath, apiKey: "fw_new", env: {}, fetch: fakeFetch(window(now + 3_600_000)), now: () => now, warn: (m) => warnings.push(m) }), "boost");
      assert.ok((await pet(petDir)).animations.level);
      assert.equal(warnings.length, 1, "the failed save is reported");
      assert.ok(!warnings[0].includes("fw_new"));
    });
  });

  it("saves the status even when the pet can't be written", async () => {
    await withTempHomeEnv("codex-ultrafast-login-pet-fails", async (home) => {
      const { configPath, petDir, cacheFile } = await setup(home);
      await rm(path.join(petDir, "pet.json"));
      await mkdir(path.join(petDir, "pet.json")); // a folder where pet.json goes: the pet write fails
      await refreshCodexUltrafastPet({ configPath, apiKey: "fw_new", env: {}, fetch: fakeFetch(window(now + 3_600_000)), now: () => now });
      const { keyTag } = await import("../../../mods/codex-ultrafast/server.mjs");
      assert.equal(JSON.parse(await readFile(cacheFile, "utf8")).keyTag, keyTag("fw_new"));
    });
  });

  it("shows the plain pet when the old account's cache can be neither replaced nor removed", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
    await withTempHomeEnv("codex-ultrafast-login-readonly-cache", async (home) => {
      const { configPath, petDir, cacheFile } = await setup(home);
      await refreshCodexUltrafastPet({ configPath, apiKey: "fw_old", env: {}, fetch: fakeFetch(window(now + 3_600_000)), now: () => now });
      const { chmod } = await import("node:fs/promises");
      await chmod(path.dirname(cacheFile), 0o500);
      try {
        const warnings = [];
        assert.equal(await refreshCodexUltrafastPet({ configPath, apiKey: "fw_new", env: {}, fetch: fakeFetch(window(now + 3_600_000)), now: () => now, warn: (m) => warnings.push(m) }), "plain");
        assert.equal(warnings.length, 1);
        assert.equal((await pet(petDir)).animations.level, undefined, "not the new account's tile beside the old record");
      } finally {
        await chmod(path.dirname(cacheFile), 0o700);
      }
    });
  });

  it("removes an old account's cache it couldn't replace, so a later login doesn't keep this pet", async () => {
    await withTempHomeEnv("codex-ultrafast-login-stale-cache", async (home) => {
      const { configPath, petDir, cacheFile } = await setup(home);
      await refreshCodexUltrafastPet({ configPath, apiKey: "fw_old", env: {}, fetch: fakeFetch(window(now + 3_600_000)), now: () => now });
      assert.ok(existsSync(cacheFile));
      // The temp file the all-at-once write uses is a folder: the replace fails.
      // This pins writeAtomic's temp name (mods/codex-ultrafast/files.mjs):
      // change both together. It's the one way to fail the replace while the
      // remove still works; the read-only-folder test covers both failing.
      await mkdir(path.join(path.dirname(cacheFile), `.${path.basename(cacheFile)}.${process.pid}.tmp`), { recursive: true });
      await refreshCodexUltrafastPet({ configPath, apiKey: "fw_new", env: {}, fetch: fakeFetch(window(now + 3_600_000)), now: () => now, warn: () => {} });
      assert.equal(existsSync(cacheFile), false, "the old account's cache is gone");
      assert.equal(await refreshCodexUltrafastPet({ configPath, apiKey: "fw_old", env: {}, fetch: fakeFetch("down"), now: () => now }), "plain");
      assert.equal((await pet(petDir)).animations.level, undefined);
    });
  });

  it("does nothing without Nexus's footer, and makes no request under NEXUS_TEST=1", async () => {
    await withTempHomeEnv("codex-ultrafast-login-skip", async (home) => {
      const configPath = codexConfigPath(home);
      await enableCodexFireworks({ configPath, dataDir: codexDataDir(home), apiKey: "fw_old", modelId: "auto" });
      assert.equal(await refreshCodexUltrafastPet({ configPath, apiKey: "fw_new", env: {}, fetch: fakeFetch(window(now + 1)) }), "skipped");
      const { petDir } = await setup(home);
      let requests = 0;
      const counted = async (...args) => { requests++; return fakeFetch(window(now + 3_600_000))(...args); };
      await refreshCodexUltrafastPet({ configPath, apiKey: "fw_new", env: { NEXUS_TEST: "1" }, fetch: counted });
      assert.equal(requests, 0);
      assert.equal((await pet(petDir)).animations.level, undefined);
    });
  });
});
