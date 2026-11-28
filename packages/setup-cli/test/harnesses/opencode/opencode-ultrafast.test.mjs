// The Ultra-fast banner and badge in the OpenCode plugin: ultrafast.mjs's
// rules, and what `nexus opencode on` puts in the plugin folder. The drawing
// itself (tui.tsx) runs only inside OpenCode.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { formatTimeLeft as claudeFormatTimeLeft, ultrafastBadgeParts } from "../../../lib/harnesses/claude/ultrafast-badge.mjs";
import {
  OPENCODE_API_KEY_ENV_REF,
  OPENCODE_FIREWORKS_PROVIDER_ID,
  effectiveOpencodeApiKey,
  enableOpencodeFireworks,
  opencodeConfigPath,
  opencodeDataDir,
} from "../../../lib/harnesses/opencode/core.mjs";
import { PLUGIN_FILES, isOpencodePluginStale, opencodePluginDir, refreshOpencodePluginIfStale, removeOpencodePlugin } from "../../../lib/harnesses/opencode/nexus-plugin.mjs";
import {
  BOOST_CHECK_MS,
  CONFIG_HINT_FILE,
  FIREWORKS_PROVIDER_ID,
  MAX_CONFIG_BYTES,
  MOCK_CHECK_MS,
  badgeParts,
  bannerRowsFor,
  boostChecksDisabled,
  boundedFetch,
  checkBoost,
  createBoostChecker,
  formatTimeLeft,
  opencodeConfigPathFor,
  opencodeFireworksKey,
  readConfigFile,
  readOpencodeFireworksKey,
  sendsToFireworks,
} from "../../../lib/harnesses/opencode/nexus-plugin/ultrafast.mjs";
import { MAX_ROWS } from "../../../mods/ultrafast-fireworks/hooks/frames.mjs";
import { fetchBoostStatus, mockOrigin } from "../../../mods/ultrafast-fireworks/hooks/rewards.mjs";
import { RESIDENCY_INFERENCE_ORIGINS } from "../../../lib/fireworks/residency-regions.mjs";
import { recordHarnessCustomPath, setHarnessEnabled } from "../../../lib/config/global-config.mjs";
import { installOwnedDir, removeOwnedDir } from "../../../lib/harness/owned-asset-dir.mjs";
import { migrateOpencodePluginOnUpgrade } from "../../../lib/harnesses/opencode/upgrade-migrations.mjs";
import { runHarnessForwardMigrations } from "../../../lib/system/forward-migrations.mjs";
import { withTempHomeEnv } from "../../helpers.mjs";

const KEY = "fw_example_test_key";
const ON = { apiKey: KEY, modelId: "auto", catalogModelIds: ["auto"] };
const MOD_HOOKS = new URL("../../../mods/ultrafast-fireworks/hooks/", import.meta.url);
const PLUGIN_SOURCE = new URL("../../../lib/harnesses/opencode/nexus-plugin/", import.meta.url);

// `on` fetches the live catalog unless NEXUS_TEST=1; global-setup only
// defaults it, so pin it here: these specs never touch the network.
let savedNexusTest;
before(() => {
  savedNexusTest = process.env.NEXUS_TEST;
  process.env.NEXUS_TEST = "1";
});
after(() => {
  if (savedNexusTest === undefined) delete process.env.NEXUS_TEST;
  else process.env.NEXUS_TEST = savedNexusTest;
});

/** Let a checker's request chain settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("OpenCode Ultra-fast: install", () => {
  it("`on` puts the banner's files beside the card, the mod's two unchanged", async () => {
    await withTempHomeEnv("opencode-ultrafast-install", async (home) => {
      const configPath = opencodeConfigPath(home);
      await enableOpencodeFireworks({ configPath, dataDir: opencodeDataDir(home), ...ON });
      const dir = opencodePluginDir(configPath);
      for (const name of ["frames.mjs", "rewards.mjs"]) {
        assert.equal(await readFile(path.join(dir, name), "utf8"), await readFile(new URL(name, MOD_HOOKS), "utf8"), name);
      }
      assert.equal(
        await readFile(path.join(dir, "ultrafast.mjs"), "utf8"),
        await readFile(new URL("ultrafast.mjs", PLUGIN_SOURCE), "utf8"),
      );
    });
  });

  it("a refresh replaces a symlink in the folder instead of writing through it", async () => {
    await withTempHomeEnv("opencode-ultrafast-symlink", async (home) => {
      const configPath = opencodeConfigPath(home);
      await enableOpencodeFireworks({ configPath, dataDir: opencodeDataDir(home), ...ON });
      const dir = opencodePluginDir(configPath);
      const victim = path.join(home, "victim.txt");
      await writeFile(victim, "untouched\n");
      for (const name of [CONFIG_HINT_FILE, "frames.mjs"]) {
        const link = path.join(dir, name);
        await rm(link, { force: true });
        await symlink(victim, link);
      }
      await enableOpencodeFireworks({ configPath, dataDir: opencodeDataDir(home), ...ON });
      assert.equal(await readFile(victim, "utf8"), "untouched\n");
      for (const name of [CONFIG_HINT_FILE, "frames.mjs"]) {
        await assert.rejects(readlink(path.join(dir, name)), `${name} is a plain file again`);
      }
      assert.equal(await readFile(path.join(dir, "frames.mjs"), "utf8"), await readFile(new URL("frames.mjs", MOD_HOOKS), "utf8"));
    });
  });

  it("keeps the installed file when a refresh can't copy its replacement", async () => {
    await withTempHomeEnv("opencode-ultrafast-failed-refresh", async (home) => {
      const dir = path.join(home, "owned");
      const source = path.join(home, "source");
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "a.mjs"), "first\n");
      assert.equal(await installOwnedDir(dir, source, ["a.mjs"]), true);
      await rm(path.join(source, "a.mjs"));
      assert.equal(await installOwnedDir(dir, source, ["a.mjs"]), false);
      assert.equal(await readFile(path.join(dir, "a.mjs"), "utf8"), "first\n");
      assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), [], "no temp file left behind");
    });
  });

  it("clears temp files an interrupted install left", async () => {
    await withTempHomeEnv("opencode-ultrafast-stale-temp", async (home) => {
      const configPath = opencodeConfigPath(home);
      await enableOpencodeFireworks({ configPath, dataDir: opencodeDataDir(home), ...ON });
      const dir = opencodePluginDir(configPath);
      const stale = path.join(dir, ".tui.tsx.nexus-4242-0123456789ab.tmp");
      await writeFile(stale, "half-written");
      await enableOpencodeFireworks({ configPath, dataDir: opencodeDataDir(home), ...ON });
      assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
    });
  });

  it("an upgrade refreshes an installed plugin whose files are out of date", async () => {
    await withTempHomeEnv("opencode-ultrafast-upgrade", async (home) => {
      const configPath = opencodeConfigPath(home);
      await enableOpencodeFireworks({ configPath, dataDir: opencodeDataDir(home), ...ON });
      const dir = opencodePluginDir(configPath);
      assert.equal(isOpencodePluginStale(configPath), false);
      assert.equal(await refreshOpencodePluginIfStale(configPath), false, "nothing to do when current");
      // A folder from a release before Ultra-fast: the card only, no hint.
      for (const name of ["ultrafast.mjs", "frames.mjs", "rewards.mjs", CONFIG_HINT_FILE]) await rm(path.join(dir, name));
      await writeFile(path.join(dir, "tui.tsx"), 'export default { id: "fireworks.nexus", setup() {} }\n');
      assert.equal(isOpencodePluginStale(configPath), true);
      assert.equal(await refreshOpencodePluginIfStale(configPath), true);
      assert.equal(isOpencodePluginStale(configPath), false);
      assert.equal(await readOpencodeFireworksKey(await opencodeConfigPathFor(dir)), KEY);
    });
  });

  it("an upgrade refreshes a recorded --config-path config's folder for that config", async () => {
    await withTempHomeEnv("opencode-ultrafast-upgrade-custom", async (home) => {
      const configPath = path.join(home, "work", "opencode", "custom-opencode.json");
      await enableOpencodeFireworks({ configPath, dataDir: opencodeDataDir(home), ...ON });
      await recordHarnessCustomPath(home, "opencode", { configPath }, true);
      const dir = opencodePluginDir(configPath);
      await writeFile(path.join(dir, "tui.tsx"), 'export default { id: "fireworks.nexus", setup() {} }\n');
      assert.equal(await migrateOpencodePluginOnUpgrade(home), true);
      assert.equal(isOpencodePluginStale(configPath), false);
      assert.equal(await opencodeConfigPathFor(dir), configPath, "the hint still names the custom file");
    });
  });

  it("an upgrade keeps the config a shared folder's hint names", async () => {
    await withTempHomeEnv("opencode-ultrafast-upgrade-hint", async (home) => {
      const defaultPath = opencodeConfigPath(home);
      const customPath = path.join(path.dirname(defaultPath), "work.json");
      await enableOpencodeFireworks({ configPath: defaultPath, dataDir: opencodeDataDir(home), ...ON });
      await enableOpencodeFireworks({ configPath: customPath, dataDir: path.join(home, "work-data"), ...ON });
      await setHarnessEnabled(home, "opencode", true);
      const dir = opencodePluginDir(defaultPath);
      await writeFile(path.join(dir, "tui.tsx"), 'export default { id: "fireworks.nexus", setup() {} }\n');
      assert.equal(await migrateOpencodePluginOnUpgrade(home), true);
      assert.equal(await opencodeConfigPathFor(dir), customPath);
    });
  });

  it("an upgrade never opens a FIFO planted in the plugin folder", { skip: process.platform === "win32" }, async () => {
    await withTempHomeEnv("opencode-ultrafast-upgrade-fifo", async (home) => {
      const configPath = opencodeConfigPath(home);
      await enableOpencodeFireworks({ configPath, dataDir: opencodeDataDir(home), ...ON });
      const entry = path.join(opencodePluginDir(configPath), "tui.tsx");
      await rm(entry);
      execFileSync("mkfifo", [entry]);
      assert.equal(isOpencodePluginStale(configPath), true, "returns without waiting for a writer");
      assert.equal(await refreshOpencodePluginIfStale(configPath), true);
      assert.ok((await lstat(entry)).isFile(), "replaced by the shipped file");
    });
  });

  it("takes over, or removes, a folder a first install left before its marker", async () => {
    await withTempHomeEnv("opencode-ultrafast-first-install", async (home) => {
      const source = path.join(home, "source");
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "a.mjs"), "a\n");
      for (const action of ["install", "remove"]) {
        const dir = path.join(home, `owned-${action}`);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "..nexus-owned.nexus-4242-0123456789ab.tmp"), "Installed by Nexus.");
        if (action === "install") {
          assert.equal(await installOwnedDir(dir, source, ["a.mjs"]), true);
          assert.deepEqual((await readdir(dir)).sort(), [".nexus-owned", "a.mjs"]);
        } else {
          assert.equal(await removeOwnedDir(dir), true);
          assert.equal(existsSync(dir), false);
        }
      }
      const foreign = path.join(home, "foreign");
      await mkdir(foreign, { recursive: true });
      await writeFile(path.join(foreign, "notes.txt"), "mine");
      assert.equal(await installOwnedDir(foreign, source, ["a.mjs"]), false, "a folder with anything else stays the user's");
      // Files that only look like temp files, or a staged marker with other
      // bytes, don't make a folder Nexus's.
      for (const [name, text] of [
        [".notes.txt.4242.0123456789ab.tmp", "Installed by Nexus."],
        [".a.mjs.nexus-4242-0123456789ab.tmp", "Installed by Nexus."],
        ["..nexus-owned.nexus-4242-0123456789ab.tmp", "someone else's file"],
      ]) {
        const lookalike = path.join(home, `lookalike-${name}`);
        await mkdir(lookalike, { recursive: true });
        await writeFile(path.join(lookalike, name), text);
        assert.equal(await installOwnedDir(lookalike, source, ["a.mjs"]), false, name);
        assert.equal(await removeOwnedDir(lookalike), false, name);
        assert.ok(existsSync(path.join(lookalike, name)), `${name} left alone`);
      }
    });
  });

  it("`nexus update` refreshes a routed install's old plugin and says so", async () => {
    await withTempHomeEnv("opencode-ultrafast-forward", async (home) => {
      const configPath = opencodeConfigPath(home);
      await enableOpencodeFireworks({ configPath, dataDir: opencodeDataDir(home), ...ON });
      await setHarnessEnabled(home, "opencode", true, "fireworks");
      await writeFile(path.join(opencodePluginDir(configPath), "tui.tsx"), 'export default { id: "fireworks.nexus", setup() {} }\n');
      const notes = await runHarnessForwardMigrations(home);
      assert.ok(notes.some((note) => note.startsWith("Updated the Nexus plugin in OpenCode")), notes.join("\n"));
      assert.equal(isOpencodePluginStale(configPath), false);
    });
  });

  it("counts an unreadable or non-file asset as stale, and a refresh that can't fix it fails loudly", async () => {
    await withTempHomeEnv("opencode-ultrafast-refresh-fails", async (home) => {
      const configPath = opencodeConfigPath(home);
      await enableOpencodeFireworks({ configPath, dataDir: opencodeDataDir(home), ...ON });
      await setHarnessEnabled(home, "opencode", true, "fireworks");
      const frames = path.join(opencodePluginDir(configPath), "frames.mjs");
      await rm(frames);
      await mkdir(path.join(frames, "inside"), { recursive: true }); // a non-empty folder can't be renamed over
      assert.equal(isOpencodePluginStale(configPath), true);
      await assert.rejects(refreshOpencodePluginIfStale(configPath));
      const notes = await runHarnessForwardMigrations(home);
      assert.ok(notes.includes("Couldn't update the Nexus plugin in OpenCode. Re-run nexus opencode on."), notes.join("\n"));
    });
  });

  it("an upgrade reports an unreadable hint instead of guessing its config", { skip: process.platform === "win32" }, async () => {
    await withTempHomeEnv("opencode-ultrafast-upgrade-bad-hint", async (home) => {
      const configPath = opencodeConfigPath(home);
      await enableOpencodeFireworks({ configPath, dataDir: opencodeDataDir(home), ...ON });
      await setHarnessEnabled(home, "opencode", true, "fireworks");
      const dir = opencodePluginDir(configPath);
      await writeFile(path.join(dir, "tui.tsx"), 'export default { id: "fireworks.nexus", setup() {} }\n');
      await rm(path.join(dir, CONFIG_HINT_FILE));
      execFileSync("mkfifo", [path.join(dir, CONFIG_HINT_FILE)]);
      await assert.rejects(migrateOpencodePluginOnUpgrade(home), /can't read .*nexus-config\.json/);
      const notes = await runHarnessForwardMigrations(home);
      assert.ok(notes.includes("Couldn't update the Nexus plugin in OpenCode. Re-run nexus opencode on."), notes.join("\n"));
      // `on` itself recovers: the hint is replaced by a regular file again.
      await enableOpencodeFireworks({ configPath, dataDir: opencodeDataDir(home), ...ON });
      assert.ok((await lstat(path.join(dir, CONFIG_HINT_FILE))).isFile());
      assert.equal(await migrateOpencodePluginOnUpgrade(home), false, "current again");
    });
  });

  it("an upgrade never hangs on a recorded config that became a FIFO or a device", { skip: process.platform === "win32" }, async () => {
    await withTempHomeEnv("opencode-ultrafast-upgrade-special-config", async (home) => {
      for (const [name, make] of [
        ["fifo.json", (file) => execFileSync("mkfifo", [file])],
        ["zero.json", (file) => symlink("/dev/zero", file)],
      ]) {
        const configPath = path.join(home, `project-${name}`, name); // one plugin folder each
        await enableOpencodeFireworks({ configPath, dataDir: path.join(home, `data-${name}`), ...ON });
        await recordHarnessCustomPath(home, "opencode", { configPath }, true);
        await rm(configPath);
        await make(configPath);
      }
      const started = performance.now();
      await assert.rejects(migrateOpencodePluginOnUpgrade(home), (error) => /fifo\.json/.test(error.message) && /zero\.json/.test(error.message));
      assert.ok(performance.now() - started < 5_000, "returns without waiting on the FIFO or reading the device");
      const notes = await runHarnessForwardMigrations(home);
      assert.ok(notes.includes("Couldn't update the Nexus plugin in OpenCode. Re-run nexus opencode on."), notes.join("\n"));
    });
  });

  it("never opens a FIFO, device link or huge file when recognizing a marker-less plugin folder", { skip: process.platform === "win32" }, async () => {
    await withTempHomeEnv("opencode-ultrafast-legacy-fifo", async (home) => {
      for (const [label, make] of [
        ["fifo", (file) => execFileSync("mkfifo", [file])],
        ["device link", (file) => symlink("/dev/zero", file)],
        ["huge file", (file) => writeFile(file, `export default { id: "fireworks.nexus" }\n${" ".repeat(1024 * 1024)}`)],
      ]) {
        const configPath = path.join(home, label.replace(" ", "-"), "opencode.json");
        await enableOpencodeFireworks({ configPath, dataDir: path.join(home, `data-${label}`), ...ON });
        await recordHarnessCustomPath(home, "opencode", { configPath }, true);
        const dir = opencodePluginDir(configPath);
        await rm(path.join(dir, ".nexus-owned"));
        await rm(path.join(dir, "tui.tsx"));
        await make(path.join(dir, "tui.tsx"));
        const started = performance.now();
        assert.equal(isOpencodePluginStale(configPath), false, `${label}: not recognized as Nexus's`);
        await migrateOpencodePluginOnUpgrade(home).catch(() => {});
        assert.equal(await removeOpencodePlugin(configPath), false, `${label}: off leaves it`);
        assert.ok(performance.now() - started < 5_000, `${label}: returned without reading it`);
        assert.ok(existsSync(dir), `${label}: folder left alone`);
      }
    });
  });

  it("an upgrade leaves OpenCode alone when Nexus doesn't route it", async () => {
    await withTempHomeEnv("opencode-ultrafast-upgrade-off", async (home) => {
      assert.equal(await migrateOpencodePluginOnUpgrade(home), false);
      assert.equal(isOpencodePluginStale(opencodeConfigPath(home)), false, "no folder, nothing stale");
    });
  });

  it("installs the entry point last", () => {
    const names = PLUGIN_FILES.map((file) => (Array.isArray(file) ? file[1] : file));
    assert.equal(names.at(-1), "tui.tsx");
  });

  it("installs every module tui.tsx imports from its folder", async () => {
    const source = await readFile(new URL("tui.tsx", PLUGIN_SOURCE), "utf8");
    const local = [...source.matchAll(/import\(\s*"\.\/([^"]+)"\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(local.sort(), ["frames.mjs", "rewards.mjs", "ultrafast.mjs"]);
    const installed = PLUGIN_FILES.map((file) => (Array.isArray(file) ? file[1] : file));
    for (const name of local) assert.ok(installed.includes(name), name);
    assert.doesNotMatch(source, /^\s*import\b[^\n]*from\s*["']\.\//m, "folder modules load dynamically, so a broken one can't take the card down");
    assert.doesNotMatch(source.replace(/import\(\s*"\.\/[^"]+"\s*\)/g, ""), /["']\.\/[^"']+\.m?[jt]sx?["']/, "no other reference to a folder module");
    assert.match(source, /function DemoCommand\(\) \{\s*try \{\s*context\?\.keymap\?\.layer\?\.\(\(\) => \(\{[^]*?mode: "global"/,
      "the slash command's layer is made in a rendered component and reachable from the prompt");
  });

  it("reads back the key `on` wrote, from the folder the plugin is installed in", async () => {
    await withTempHomeEnv("opencode-ultrafast-key", async (home) => {
      const configPath = opencodeConfigPath(home);
      await enableOpencodeFireworks({ configPath, dataDir: opencodeDataDir(home), ...ON });
      const fromPlugin = await opencodeConfigPathFor(opencodePluginDir(configPath));
      assert.equal(fromPlugin, configPath);
      assert.equal(await readOpencodeFireworksKey(fromPlugin), KEY);
    });
  });
});

describe("OpenCode Ultra-fast: a custom config file", () => {
  it("reads the key from the file `on --config-path` routed, not a sibling opencode.json", async () => {
    await withTempHomeEnv("opencode-ultrafast-custom", async (home) => {
      const configPath = path.join(home, ".config", "opencode", "custom-opencode.json");
      await enableOpencodeFireworks({ configPath, dataDir: opencodeDataDir(home), ...ON });
      const fromPlugin = await opencodeConfigPathFor(opencodePluginDir(configPath));
      assert.equal(fromPlugin, configPath);
      assert.equal(await readOpencodeFireworksKey(fromPlugin), KEY);
    });
  });

  it("reads no key without a valid hint, rather than guess a sibling opencode.json", async () => {
    const dir = path.join("/example", "opencode", "plugins", "fireworks-nexus");
    for (const hint of ['{"configFile":"../../etc/passwd"}', '{"configFile":"/tmp/x.json"}', '{"configFile":""}', "{}", "not json"]) {
      assert.equal(await opencodeConfigPathFor(dir, () => hint), null, hint);
    }
    assert.equal(await opencodeConfigPathFor(dir, async () => {
      throw new Error("ENOENT");
    }), null);
    assert.equal(await readOpencodeFireworksKey(null), "");
    assert.equal(await opencodeConfigPathFor(dir, () => '{"configFile":"work.json"}'), path.join("/example", "opencode", "work.json"));
  });
});

describe("OpenCode Ultra-fast: the key", () => {
  it("withholds the key from a provider pointed anywhere but the Fireworks gateway", () => {
    const withBase = (baseURL) => ({ provider: { [FIREWORKS_PROVIDER_ID]: { options: { apiKey: KEY, baseURL } } } });
    for (const base of [undefined, "", "https://api.fireworks.ai/inference/v1", "https://us.api.fireworks.ai/inference/v1"]) {
      assert.equal(opencodeFireworksKey(withBase(base)), KEY, String(base));
    }
    for (const base of ["https://gateway.example.com/v1", "http://api.fireworks.ai/inference/v1", "https://api.fireworks.ai.example.com", "not a url"]) {
      assert.equal(opencodeFireworksKey(withBase(base)), "", base);
    }
    const native = { providers: { [FIREWORKS_PROVIDER_ID]: { settings: { apiKey: KEY, baseURL: "https://gateway.example.com" } } } };
    assert.equal(opencodeFireworksKey(native), "");
  });

  it("counts every data-residency host Nexus writes as the Fireworks gateway", () => {
    for (const origin of Object.values(RESIDENCY_INFERENCE_ORIGINS)) {
      assert.equal(sendsToFireworks(`${origin}/inference/v1`), true, origin);
    }
  });

  it("prefers the native v2 entry OpenCode uses, with no fallback to the v1 entry", () => {
    const v1 = { [FIREWORKS_PROVIDER_ID]: { options: { apiKey: "fw_example_v1_key" } } };
    assert.equal(opencodeFireworksKey({ provider: v1, providers: { [FIREWORKS_PROVIDER_ID]: { settings: { apiKey: KEY } } } }), KEY);
    assert.equal(opencodeFireworksKey({ provider: v1, providers: { [FIREWORKS_PROVIDER_ID]: { settings: { apiKey: OPENCODE_API_KEY_ENV_REF } } } }), "");
    assert.equal(opencodeFireworksKey({ provider: v1, providers: { [FIREWORKS_PROVIDER_ID]: {} } }), "");
    assert.equal(opencodeFireworksKey({ provider: v1, providers: { other: {} } }), "fw_example_v1_key");
  });

  it("uses the provider `on` writes", () => {
    assert.equal(FIREWORKS_PROVIDER_ID, OPENCODE_FIREWORKS_PROVIDER_ID);
  });

  it("takes a literal Fireworks key only, as the CLI does", () => {
    const config = (apiKey) => ({ provider: { [FIREWORKS_PROVIDER_ID]: { options: { apiKey } } } });
    for (const apiKey of [KEY, ` ${KEY} `, OPENCODE_API_KEY_ENV_REF, "sk-example-not-fireworks", "", undefined, 42]) {
      const expected = typeof apiKey === "string" && effectiveOpencodeApiKey(apiKey).trim().startsWith("fw_") ? apiKey.trim() : "";
      assert.equal(opencodeFireworksKey(config(apiKey)), expected, String(apiKey));
    }
    for (const broken of [null, undefined, "{}", [], { provider: null }, { provider: { other: { options: { apiKey: KEY } } } }]) {
      assert.equal(opencodeFireworksKey(broken), "");
    }
  });

  it("answers no key for a missing or unreadable config, never throws", async () => {
    assert.equal(await readOpencodeFireworksKey("/nonexistent/opencode.json"), "");
    assert.equal(await readOpencodeFireworksKey("x", () => "{ not json"), "");
    assert.equal(await readOpencodeFireworksKey("x", async () => {
      throw new Error("EACCES");
    }), "");
  });

  it("reads only a small regular file, so a FIFO or a huge file can't hang or flood OpenCode", async () => {
    await withTempHomeEnv("opencode-ultrafast-read", async (home) => {
      // No mkfifo on Windows, which has no FIFOs in the file system either.
      if (process.platform !== "win32") {
        const fifo = path.join(home, "fifo.json");
        execFileSync("mkfifo", [fifo]);
        await assert.rejects(readConfigFile(fifo));
        assert.equal(await readOpencodeFireworksKey(fifo), "");
      }
      const huge = path.join(home, "huge.json");
      await writeFile(huge, " ".repeat(MAX_CONFIG_BYTES + 1));
      await assert.rejects(readConfigFile(huge));
      await assert.rejects(readConfigFile(home), "a folder");
    });
  });
});

describe("OpenCode Ultra-fast: requests", () => {
  it("adapts fetch for rewards.mjs: status, lowercased headers, body text", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, init });
      return new Response('{"ok":true}', { status: 200, headers: { "X-Fireworks-Account-Id": "example-account" } });
    };
    const response = await boundedFetch(fetchImpl)("https://example.com/x", { headers: { Authorization: "Bearer example" } });
    assert.deepEqual(
      { status: response.status, ok: response.ok, account: response.headers["x-fireworks-account-id"], text: response.text },
      { status: 200, ok: true, account: "example-account", text: '{"ok":true}' },
    );
    assert.ok(seen[0].init.signal instanceof AbortSignal, "every request is bounded");
    assert.equal(seen[0].init.redirect, "error", "a redirect can't carry a request to another origin");
    assert.equal(seen[0].init.headers.Authorization, "Bearer example");
  });

  it("gives up on a server that doesn't answer", async () => {
    const hang = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
    // AbortSignal.timeout's timer doesn't hold the event loop open (OpenCode's
    // TUI does); without this one the runner can exit before the abort fires.
    const keepAlive = setTimeout(() => {}, 5_000);
    try {
      const started = performance.now();
      await assert.rejects(boundedFetch(hang, 20)("https://example.com/slow"));
      assert.ok(performance.now() - started < 1_000, "the timeout given is the one used");
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it("stops reading an undeclared body once it passes the limit", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    const endless = new ReadableStream({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const response = await boundedFetch(async () => new Response(endless))("https://example.com/endless");
    assert.equal(response.text, "");
    assert.ok(pulled < 10, `read ${pulled} chunks`);
  });

  it("drops a body declared larger than rewards.mjs reads", async () => {
    const big = async () => new Response("x", { headers: { "content-length": String(10 * 1024 * 1024) } });
    assert.equal((await boundedFetch(big)("https://example.com/big")).text, "");
  });
});

describe("OpenCode Ultra-fast: pacing the boost check", () => {
  function checker({ env = {}, answers = [], mock = false } = {}) {
    let clock = 1_000_000;
    const calls = [];
    const statuses = [];
    const check = createBoostChecker({
      env,
      now: () => clock,
      isMock: () => mock,
      check: async (opts) => {
        calls.push(opts);
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return answer ?? null;
      },
      onStatus: (status, at) => statuses.push({ status, at }),
    });
    return { check, calls, statuses, advance: (ms) => (clock += ms) };
  }

  it("checks once, then not again until the interval passes", async () => {
    const t = checker({ answers: [{ active: true }, { active: false }] });
    t.check.tick();
    await settle();
    t.check.tick();
    t.advance(BOOST_CHECK_MS - 1);
    t.check.tick();
    await settle();
    assert.equal(t.calls.length, 1);
    t.advance(1);
    t.check.tick();
    await settle();
    assert.equal(t.calls.length, 2);
    assert.deepEqual(t.statuses.map((s) => s.status.active), [true, false]);
  });

  it("checks every few seconds against a mock", async () => {
    const t = checker({ mock: true });
    t.check.tick();
    await settle();
    t.advance(MOCK_CHECK_MS);
    t.check.tick();
    await settle();
    assert.equal(t.calls.length, 2);
  });

  it("runs one check at a time", async () => {
    let release;
    const calls = [];
    const check = createBoostChecker({
      env: {},
      now: (() => {
        let at = 0;
        return () => (at += BOOST_CHECK_MS);
      })(),
      isMock: () => false,
      check: () => {
        calls.push(1);
        return new Promise((resolve) => (release = resolve));
      },
      onStatus: () => {},
    });
    check.tick();
    await settle();
    check.tick();
    await settle();
    assert.equal(calls.length, 1, "the first chain is still waiting");
    release(null);
    await settle();
    check.tick();
    await settle();
    assert.equal(calls.length, 2);
  });

  it("keeps going after a failed check, and passes no answer on", async () => {
    const t = checker({ answers: [new Error("offline"), null, { active: true }] });
    for (let i = 0; i < 3; i += 1) {
      assert.doesNotThrow(() => t.check.tick());
      await settle();
      t.advance(BOOST_CHECK_MS);
    }
    assert.equal(t.calls.length, 3);
    assert.equal(t.statuses.length, 1);
  });

  it("never checks with the kill switch or in tests", async () => {
    for (const env of [{ NEXUS_ULTRAFAST_STATUS: "0" }, { NEXUS_TEST: "1" }]) {
      assert.equal(boostChecksDisabled(env), true);
      const t = checker({ env });
      t.check.tick();
      await settle();
      assert.equal(t.calls.length, 0, JSON.stringify(env));
    }
    assert.equal(boostChecksDisabled({}), false);
  });

  it("passes the mock URL through, for rewards.mjs to vet", async () => {
    const t = checker({ env: { NEXUS_ULTRAFAST_MOCK_URL: "http://127.0.0.1:8799" } });
    t.check.tick();
    await settle();
    assert.equal(t.calls[0].mockUrl, "http://127.0.0.1:8799");
  });
});

describe("OpenCode Ultra-fast: one check", () => {
  // The hint names opencode.json; the config holds `apiKey`.
  const configWith = (apiKey) => (file) => (path.basename(file) === CONFIG_HINT_FILE
    ? '{"configFile":"opencode.json"}'
    : JSON.stringify({ provider: { [FIREWORKS_PROVIDER_ID]: { options: { apiKey } } } }));

  it("answers no boost without a key, so a badge for a removed key clears, and asks nobody", async () => {
    let asked = 0;
    const status = await checkBoost({
      fetchBoostStatus: async () => {
        asked += 1;
        return { active: true };
      },
      mockOrigin,
      fetch: async () => assert.fail("no request without a key"),
      pluginDir: "/example/opencode/plugins/fireworks-nexus",
      mockUrl: undefined,
      read: configWith(OPENCODE_API_KEY_ENV_REF),
    });
    assert.deepEqual(status, { active: false });
    assert.equal(asked, 0);
  });

  it("asks a loopback mock even without a key, so the banner can be tried on any setup", async () => {
    const asked = [];
    const status = await checkBoost({
      fetchBoostStatus: async (opts) => {
        asked.push(opts);
        return { active: true };
      },
      mockOrigin,
      fetch: async () => assert.fail("the stub answers"),
      pluginDir: "/example/opencode/plugins/fireworks-nexus",
      mockUrl: "http://127.0.0.1:8799",
      read: configWith(OPENCODE_API_KEY_ENV_REF),
    });
    assert.deepEqual(status, { active: true });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].key, "", "no key is sent; rewards.mjs uses its placeholder for the mock");
    assert.equal(asked[0].mockUrl, "http://127.0.0.1:8799");
  });

  it("reads the clock for rewards.mjs after the config, just before the requests", async () => {
    let clock = 1_000;
    let seenNow = 0;
    await checkBoost({
      fetchBoostStatus: async ({ now }) => {
        seenNow = now;
        return null;
      },
      mockOrigin,
      fetch: async () => assert.fail("the stub answers"),
      pluginDir: "/example/opencode/plugins/fireworks-nexus",
      mockUrl: undefined,
      read: async (file) => {
        clock += 3_000; // a slow disk
        return configWith(KEY)(file);
      },
      clock: () => clock,
    });
    assert.equal(seenNow, 7_000, "after both reads, not before them");
  });

  it("starts cold and offline with nothing to show, and keeps checking", async () => {
    const offline = async () => {
      throw new TypeError("fetch failed");
    };
    const statuses = [];
    let clock = 0;
    const checker = createBoostChecker({
      env: {},
      now: () => clock,
      isMock: (url) => Boolean(mockOrigin(url)),
      check: ({ now, mockUrl }) => checkBoost({
        fetchBoostStatus, mockOrigin, fetch: offline, pluginDir: "/example/opencode/plugins/fireworks-nexus", mockUrl, read: configWith(KEY),
      }),
      onStatus: (status) => statuses.push(status),
    });
    for (let i = 0; i < 3; i += 1) {
      assert.doesNotThrow(() => checker.tick());
      await settle();
      await settle();
      clock += BOOST_CHECK_MS;
    }
    assert.deepEqual(statuses, [], "no answer: no banner, no badge");
  });
});

describe("OpenCode Ultra-fast: footer badge", () => {
  it("shows what the Claude Code status line shows for the same boost", () => {
    const now = 10_000_000_000;
    const hour = 3_600_000;
    const cases = [
      { active: true, activatedAt: now, expiresAt: now + 5 * hour },
      { active: true, activatedAt: now - 4 * hour, expiresAt: now + hour },
      { active: true, activatedAt: null, expiresAt: now + 30 * 60_000 },
      { active: true, activatedAt: now - hour, expiresAt: now },
      { active: false, activatedAt: now, expiresAt: now + hour },
      { active: true, activatedAt: now, expiresAt: null },
    ];
    for (const status of cases) {
      assert.deepEqual(badgeParts(status, now), ultrafastBadgeParts({ ...status, updatedAt: now }, now, {}), JSON.stringify(status));
    }
    assert.equal(badgeParts(null, now), null);
  });

  it("formats the time left as the status line does", () => {
    for (const minutes of [0, 1, 45, 59, 60, 61, 300, 301]) {
      assert.equal(formatTimeLeft(minutes * 60_000), claudeFormatTimeLeft(minutes * 60_000), `${minutes}m`);
    }
  });
});

describe("OpenCode Ultra-fast: banner size", () => {
  it("plays all nine rows on a roomy terminal and shrinks on a short one", () => {
    assert.equal(bannerRowsFor(36, MAX_ROWS), MAX_ROWS);
    assert.equal(bannerRowsFor(30, MAX_ROWS), MAX_ROWS, "a side panel about 30 rows tall gets the full banner");
    assert.equal(bannerRowsFor(25, MAX_ROWS), MAX_ROWS);
    assert.equal(bannerRowsFor(20, MAX_ROWS), 4);
    for (const height of [0, 10, undefined, Number.NaN]) assert.equal(bannerRowsFor(height, MAX_ROWS), 2, String(height));
  });
});
