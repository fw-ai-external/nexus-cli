import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { readGlobalConfig, writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { pathOverrideFlags } from "../../lib/harness/context.mjs";
import { codexConfigPath } from "../../lib/harnesses/codex/core.mjs";
import { deepseekHomePatchPath } from "../../lib/harnesses/deepseek/core.mjs";
import { piAuthPath, piSettingsPath } from "../../lib/harnesses/pi/core.mjs";
import { syncBakedKeys } from "../../lib/keys/sync.mjs";
import { runFireconnect, withTempHome } from "../helpers.mjs";

// Keep harness config reads inside each test's temporary home.
delete process.env.DSH_HOME;
delete process.env.HERMES_HOME;
delete process.env.COPILOT_HOME;
delete process.env.COPILOT_PROVIDERS_CONFIG;

const OLD_KEY = "fw_test_old_key_1111111111111111";
const NEW_KEY = "fw_test_new_key_2222222222222222";

/** Sign in with OLD_KEY and connect Codex at the default path and at `customPath`. */
async function connectCodexTwice(home, customPath, extra = []) {
  await mkdir(path.dirname(codexConfigPath(home)), { recursive: true });
  await mkdir(path.dirname(customPath), { recursive: true });
  const env = { HOME: home, FIREWORKS_API_KEY: "" };
  const login = await runFireconnect(["login", "--api-key", OLD_KEY], env);
  assert.equal(login.code, 0, login.stderr);
  for (const args of [["codex", "on"], ["codex", "on", "--config-path", customPath, ...extra]]) {
    const on = await runFireconnect(args, env);
    assert.equal(on.code, 0, on.stderr);
  }
  return env;
}

describe("key sync with a harness connected at a custom config path", () => {
  it("re-points the custom copy too, so a rotation can delete the old key", async () => {
    await withTempHome("sync-custom-both", async (home) => {
      const customPath = path.join(home, "work", "codex", "config.toml");
      await connectCodexTwice(home, customPath);
      const { harnesses } = await readGlobalConfig(home);
      assert.deepEqual(harnesses.codex.customPaths, [{ configPath: customPath }]);

      const { notes, unconfirmed } = await syncBakedKeys(home, NEW_KEY);
      assert.deepEqual(unconfirmed, []);
      for (const file of [codexConfigPath(home), customPath]) {
        const text = await readFile(file, "utf8");
        assert.match(text, new RegExp(NEW_KEY), file);
        assert.doesNotMatch(text, new RegExp(OLD_KEY), file);
      }
      assert.ok(notes.some((note) => note.includes(customPath)), notes.join("\n"));
    });
  });

  it("keeps the old key when a custom copy can't be re-pointed, naming the command", async () => {
    await withTempHome("sync-custom-unconfirmed", async (home) => {
      const customPath = path.join(home, "work", "codex", "config.toml");
      await connectCodexTwice(home, customPath);
      // The custom file no longer routes through Fireworks in a way Nexus can
      // rewrite (here: emptied), so its copy can't be confirmed.
      await writeFile(customPath, "");

      const { unconfirmed } = await syncBakedKeys(home, NEW_KEY);
      assert.deepEqual(unconfirmed, [{ label: "Codex", hint: `nexus codex on --config-path ${customPath}` }]);
    });
  });

  it("off at the custom path forgets it; off at the default still syncs the custom copy", async () => {
    await withTempHome("sync-custom-off", async (home) => {
      const customPath = path.join(home, "work", "codex", "config.toml");
      const env = await connectCodexTwice(home, customPath);

      const offDefault = await runFireconnect(["codex", "off"], env);
      assert.equal(offDefault.code, 0, offDefault.stderr);
      // `off` at the default clears the harness's enabled flag, but the custom
      // config still holds the key, so it is still synced.
      const afterDefaultOff = await syncBakedKeys(home, NEW_KEY);
      assert.deepEqual(afterDefaultOff.unconfirmed, []);
      assert.match(await readFile(customPath, "utf8"), new RegExp(NEW_KEY));

      const offCustom = await runFireconnect(["codex", "off", "--config-path", customPath], env);
      assert.equal(offCustom.code, 0, offCustom.stderr);
      assert.equal((await readGlobalConfig(home)).harnesses.codex.customPaths, undefined);
    });
  });

  it("finds a custom path connected before it was recorded, through its backup", async () => {
    await withTempHome("sync-custom-legacy", async (home) => {
      const customPath = path.join(home, "work", "codex", "config.toml");
      await connectCodexTwice(home, customPath);
      // An install from before `customPaths`: same files, no record.
      const config = await readGlobalConfig(home);
      const { customPaths: _dropped, ...codex } = config.harnesses.codex;
      await writeGlobalConfig(home, { harnesses: { ...config.harnesses, codex } });

      const { unconfirmed } = await syncBakedKeys(home, NEW_KEY);
      assert.deepEqual(unconfirmed, []);
      assert.match(await readFile(customPath, "utf8"), new RegExp(NEW_KEY));
    });
  });
  it("off at the custom path keeps the default copy in the sync", async () => {
    await withTempHome("sync-custom-off-custom", async (home) => {
      const customPath = path.join(home, "work", "codex", "config.toml");
      const env = await connectCodexTwice(home, customPath);
      const off = await runFireconnect(["codex", "off", "--config-path", customPath], env);
      assert.equal(off.code, 0, off.stderr);
      // The default config is still routed, so the harness stays enabled.
      assert.equal((await readGlobalConfig(home)).harnesses.codex.enabled, true);
      const { unconfirmed } = await syncBakedKeys(home, NEW_KEY);
      assert.deepEqual(unconfirmed, []);
      assert.match(await readFile(codexConfigPath(home), "utf8"), new RegExp(NEW_KEY));
    });
  });

  it("doesn't record or flag a --config-path that names the default file", async () => {
    await withTempHome("sync-custom-is-default", async (home) => {
      await connectCodexTwice(home, codexConfigPath(home));
      assert.equal((await readGlobalConfig(home)).harnesses.codex.customPaths, undefined);
      const { unconfirmed } = await syncBakedKeys(home, NEW_KEY);
      assert.deepEqual(unconfirmed, []);
    });
  });

  it("still syncs a Fireworks copy when the harness's default config is on Azure", async () => {
    await withTempHome("sync-custom-azure-default", async (home) => {
      const customPath = path.join(home, "work", "codex", "config.toml");
      await connectCodexTwice(home, customPath);
      const config = await readGlobalConfig(home);
      await writeGlobalConfig(home, { harnesses: { ...config.harnesses, codex: { ...config.harnesses.codex, provider: "azure" } } });
      const { unconfirmed } = await syncBakedKeys(home, NEW_KEY);
      assert.deepEqual(unconfirmed, []);
      assert.match(await readFile(customPath, "utf8"), new RegExp(NEW_KEY));
    });
  });

  it("reports a named pipe at a recorded path instead of blocking on it", { skip: process.platform === "win32" }, async () => {
    await withTempHome("sync-custom-fifo", async (home) => {
      const customPath = path.join(home, "work", "codex", "config.toml");
      await connectCodexTwice(home, customPath);
      await rm(customPath);
      assert.equal(spawnSync("mkfifo", [customPath]).status, 0);
      const { unconfirmed } = await syncBakedKeys(home, NEW_KEY);
      assert.deepEqual(unconfirmed, [{ label: "Codex", hint: `nexus codex on --config-path ${customPath}` }]);
    });
  });

  it("records --data-dir with the config it backs up", async () => {
    await withTempHome("sync-custom-data-dir", async (home) => {
      const customPath = path.join(home, "work", "codex", "config.toml");
      const dataDir = path.join(home, "work", "nexus-codex");
      await connectCodexTwice(home, customPath, ["--data-dir", dataDir]);
      assert.deepEqual((await readGlobalConfig(home)).harnesses.codex.customPaths, [{ configPath: customPath, dataDir }]);
    });
  });

  it("quotes a path in a re-run hint so nothing in it expands", () => {
    assert.equal(pathOverrideFlags({ configPath: "/work/config.toml" }), "--config-path /work/config.toml");
    assert.equal(pathOverrideFlags({ configPath: "/x/$(touch pwn)/c.toml" }), "--config-path '/x/$(touch pwn)/c.toml'");
    assert.equal(pathOverrideFlags({ configPath: "/it's/c" }), "--config-path '/it'\\''s/c'");
  });
  it("re-points a disabled harness's custom copy that shares the default file (Pi's auth.json)", async () => {
    await withTempHome("sync-custom-pi-shared", async (home) => {
      // Pi keeps one auth.json per directory, so a custom settings file next
      // to the default one shares it. Pi is off at the default path.
      const settingsPath = path.join(path.dirname(piSettingsPath(home, "")), "work.json");
      await mkdir(path.dirname(piAuthPath(home)), { recursive: true });
      await writeFile(piAuthPath(home), JSON.stringify({ fireworks: { type: "api_key", key: OLD_KEY, managedBy: "fireconnect" } }));
      await writeGlobalConfig(home, { harnesses: { pi: { enabled: false, customPaths: [{ settingsPath }] } } });
      const { unconfirmed } = await syncBakedKeys(home, NEW_KEY);
      assert.deepEqual(unconfirmed, []);
      assert.equal(JSON.parse(await readFile(piAuthPath(home), "utf8")).fireworks.key, NEW_KEY);
    });
  });

  it("counts two records of one file once", async () => {
    await withTempHome("sync-custom-same-file", async (home) => {
      const customPath = path.join(home, "work", "codex", "config.toml");
      await connectCodexTwice(home, customPath);
      const config = await readGlobalConfig(home);
      const customPaths = [{ configPath: customPath }, { configPath: customPath, dataDir: path.join(home, ".nexus", "codex") }];
      await writeGlobalConfig(home, { harnesses: { ...config.harnesses, codex: { ...config.harnesses.codex, customPaths } } });
      const { unconfirmed } = await syncBakedKeys(home, NEW_KEY);
      assert.deepEqual(unconfirmed, []);
    });
  });

  it("prints a path's control characters as ?, so a filename can't drive the terminal", async () => {
    await withTempHome("sync-custom-escape", async (home) => {
      const customPath = path.join(home, "work\u001b[2J", "config.toml");
      await connectCodexTwice(home, customPath);
      await writeFile(customPath, "");
      const { unconfirmed } = await syncBakedKeys(home, NEW_KEY);
      assert.equal(unconfirmed.length, 1);
      assert.doesNotMatch(unconfirmed[0].hint, /\u001b/);
      assert.match(unconfirmed[0].hint, /work\?\[2J/);
    });
  });
  it("leaves no record when on fails before routing the custom config", async () => {
    await withTempHome("sync-custom-failed-on", async (home) => {
      await mkdir(path.dirname(codexConfigPath(home)), { recursive: true });
      const env = { HOME: home, FIREWORKS_API_KEY: "" };
      assert.equal((await runFireconnect(["login", "--api-key", OLD_KEY], env)).code, 0);
      // The config's parent is a regular file, so nothing can be written there.
      await writeFile(path.join(home, "blocker"), "");
      const on = await runFireconnect(["codex", "on", "--config-path", path.join(home, "blocker", "config.toml")], env);
      assert.notEqual(on.code, 0);
      assert.equal((await readGlobalConfig(home)).harnesses.codex?.customPaths, undefined);
    });
  });
  it("refuses a custom DeepSeek config whose sibling .env is a named pipe", { skip: process.platform === "win32" }, async () => {
    await withTempHome("sync-custom-deepseek-fifo", async (home) => {
      const settingsPath = path.join(home, "work", "dsh", "settings.yaml");
      await mkdir(path.dirname(settingsPath), { recursive: true });
      const env = { HOME: home, FIREWORKS_API_KEY: "" };
      assert.equal((await runFireconnect(["login", "--api-key", OLD_KEY], env)).code, 0);
      const on = await runFireconnect(["deepseek", "on", "--config-path", settingsPath], env);
      assert.equal(on.code, 0, on.stderr);
      // A routed custom config whose refresh would read the sibling .env.
      const envPath = path.join(path.dirname(settingsPath), ".env");
      await rm(envPath, { force: true });
      assert.equal(spawnSync("mkfifo", [envPath]).status, 0);
      const { unconfirmed } = await syncBakedKeys(home, NEW_KEY);
      // (The default config also counts: DeepSeek is connected only here.)
      assert.ok(unconfirmed.some(({ hint }) => hint === `nexus deepseek on --config-path ${settingsPath}`), JSON.stringify(unconfirmed));
    });
  });
  for (const layer of ["home", "profile"]) {
    it(`refuses a custom DeepSeek ${layer} patch named pipe`, { skip: process.platform === "win32" }, async () => {
      await withTempHome(`sync-custom-deepseek-${layer}-patch-fifo`, async (home) => {
        const settingsPath = path.join(home, "work", "dsh", "settings.yaml");
        await mkdir(path.dirname(settingsPath), { recursive: true });
        const env = { HOME: home, FIREWORKS_API_KEY: "" };
        assert.equal((await runFireconnect(["login", "--api-key", OLD_KEY], env)).code, 0);
        const on = await runFireconnect(["deepseek", "on", "--config-path", settingsPath], env);
        assert.equal(on.code, 0, on.stderr);
        const homePatch = deepseekHomePatchPath(settingsPath);
        const route = await readFile(homePatch, "utf8");
        await rm(settingsPath);
        let patchPath = homePatch;
        if (layer === "profile") {
          const profileDir = path.join(path.dirname(settingsPath), "profiles", "headless");
          await mkdir(profileDir, { recursive: true });
          await writeFile(path.join(profileDir, "cordis.yml"), "[]\n");
          patchPath = path.join(profileDir, path.basename(homePatch));
          await rm(homePatch);
          await writeFile(patchPath, route);
        }
        const sync = () => spawnSync(process.execPath, ["--input-type=module", "-e", `
          import { syncBakedKeys } from ${JSON.stringify(new URL("../../lib/keys/sync.mjs", import.meta.url).href)};
          console.log(JSON.stringify(await syncBakedKeys(process.env.HOME, ${JSON.stringify(NEW_KEY)})));
        `], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 5000 });
        const regular = sync();
        assert.equal(regular.status, 0, regular.stderr || regular.error?.message);
        const hint = `nexus deepseek on --config-path ${settingsPath}`;
        assert.ok(!JSON.parse(regular.stdout).unconfirmed.some((entry) => entry.hint === hint));
        await rm(patchPath);
        assert.equal(spawnSync("mkfifo", [patchPath]).status, 0);
        const fifo = sync();
        assert.equal(fifo.status, 0, fifo.stderr || fifo.error?.message);
        assert.ok(JSON.parse(fifo.stdout).unconfirmed.some((entry) => entry.hint === hint));
      });
    });
  }
  it("forgets a recorded config whose files are gone, instead of keeping every rotation's old key", async () => {
    await withTempHome("sync-custom-gone", async (home) => {
      const customPath = path.join(home, "work", "codex", "config.toml");
      await connectCodexTwice(home, customPath);
      await rm(path.join(home, "work"), { recursive: true, force: true });

      const first = await syncBakedKeys(home, NEW_KEY);
      assert.deepEqual(first.unconfirmed, []);
      assert.ok(first.notes.includes(`Forgot Codex's config at ${customPath}: the file is gone.`), first.notes.join("\n"));
      assert.equal((await readGlobalConfig(home)).harnesses.codex.customPaths, undefined);
      // The next rotation is clean too, with nothing more to say about it.
      const second = await syncBakedKeys(home, `${NEW_KEY}x`);
      assert.deepEqual(second.unconfirmed, []);
      assert.ok(!second.notes.some((note) => note.startsWith("Forgot")), second.notes.join("\n"));
    });
  });
  it("keeps a recorded config it can't stat, instead of calling it gone", {
    // Root reads through chmod 000, and Windows has no POSIX modes.
    skip: process.platform === "win32" || process.getuid?.() === 0,
  }, async () => {
    await withTempHome("sync-custom-unreadable", async (home) => {
      const customPath = path.join(home, "work", "codex", "config.toml");
      await connectCodexTwice(home, customPath);
      const locked = path.join(home, "work");
      await chmod(locked, 0o000);
      try {
        const { unconfirmed, notes } = await syncBakedKeys(home, NEW_KEY);
        assert.ok(unconfirmed.some(({ hint }) => hint === `nexus codex on --config-path ${customPath}`), JSON.stringify(unconfirmed));
        assert.ok(!notes.some((note) => note.startsWith("Forgot")), notes.join("\n"));
      } finally {
        await chmod(locked, 0o755);
      }
      assert.deepEqual((await readGlobalConfig(home)).harnesses.codex.customPaths, [{ configPath: customPath }]);
    });
  });
});
