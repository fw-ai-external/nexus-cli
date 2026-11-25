import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  CLAUDE_CODE_MODS_MIN_VERSION,
  CLAUDE_PLUGIN_DIRS_ENV,
  claudeModsEnabled,
  isNexusModEntry,
  stripClaudeMods,
  ultrafastModDir,
  withClaudeMods,
} from "../../../lib/harnesses/claude/mods.mjs";
import { mockServerlessModel, runFireconnect, seedServerlessCatalogCache, withTempHome } from "../../helpers.mjs";

const MOD = "/opt/nexus/packages/setup-cli/mods/ultrafast-fireworks";
const STALE = "/old/install/packages/setup-cli/mods/ultrafast-fireworks";
const opts = { modDir: MOD, delimiter: ":" };

describe("Claude Code mods in settings env", () => {
  it("installs only on Claude Code releases that load mods", () => {
    assert.equal(claudeModsEnabled(CLAUDE_CODE_MODS_MIN_VERSION, {}), true);
    assert.equal(claudeModsEnabled("2.1.330", {}), true);
    assert.equal(claudeModsEnabled("2.1.286", {}), false);
    // Unknown: an old release would only carry a dead key.
    assert.equal(claudeModsEnabled("", {}), false);
    assert.equal(claudeModsEnabled("2.1.330", { NEXUS_CLAUDE_MODS: "0" }), false);
  });

  it("recognizes a Nexus entry from any install location", () => {
    assert.equal(isNexusModEntry(MOD), true);
    assert.equal(isNexusModEntry(`${STALE}/`), true);
    assert.equal(isNexusModEntry("C:\\nexus\\packages\\setup-cli\\mods\\ultrafast-fireworks"), true);
    assert.equal(isNexusModEntry("/opt/my-mods/ultrafast-fireworks"), false);
    assert.equal(isNexusModEntry("/opt/mods/ultrafast-fireworks-fork"), false);
  });

  it("never claims a user's own plugin folder with the same name", async () => {
    await withTempHome("mods-own-folder", async (home) => {
      const mine = path.join(home, "plugins", "mods", "ultrafast-fireworks");
      await mkdir(path.join(mine, ".claude-plugin"), { recursive: true });
      await writeFile(path.join(mine, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "my-fireworks" }));
      assert.equal(isNexusModEntry(mine), false);
      // Gone, and not where a Nexus install keeps it: not claimed either.
      assert.equal(isNexusModEntry(path.join(home, "gone", "mods", "ultrafast-fireworks")), false);
      const settings = { env: { [CLAUDE_PLUGIN_DIRS_ENV]: mine } };
      assert.equal(withClaudeMods(settings, { ...opts, delimiter: path.delimiter, enabled: true }).env[CLAUDE_PLUGIN_DIRS_ENV],
        [mine, MOD].join(path.delimiter));
      assert.equal(stripClaudeMods(settings).changed, false);
    });
  });

  it("doesn't install from a path that holds the list separator", () => {
    const settings = { env: { [CLAUDE_PLUGIN_DIRS_ENV]: `/mine:${STALE}` } };
    const next = withClaudeMods(settings, { modDir: "/odd:path/mods/ultrafast-fireworks", delimiter: ":", enabled: true });
    assert.equal(next.env[CLAUDE_PLUGIN_DIRS_ENV], "/mine");
  });

  it("adds the mod, keeping a user's own entries first", () => {
    assert.deepEqual(withClaudeMods({ env: {} }, { ...opts, enabled: true }).env, { [CLAUDE_PLUGIN_DIRS_ENV]: MOD });
    assert.deepEqual(
      withClaudeMods({ env: { [CLAUDE_PLUGIN_DIRS_ENV]: "/mine" } }, { ...opts, enabled: true }).env,
      { [CLAUDE_PLUGIN_DIRS_ENV]: `/mine:${MOD}` },
    );
    // No env block at all.
    assert.deepEqual(withClaudeMods({}, { ...opts, enabled: true }).env, { [CLAUDE_PLUGIN_DIRS_ENV]: MOD });
  });

  it("re-points a stale Nexus path where it stands and drops duplicates", () => {
    const settings = { env: { [CLAUDE_PLUGIN_DIRS_ENV]: `${STALE}:/mine:${MOD}` } };
    assert.equal(withClaudeMods(settings, { ...opts, enabled: true }).env[CLAUDE_PLUGIN_DIRS_ENV], `${MOD}:/mine`);
  });

  it("returns the same object when nothing changes", () => {
    const installed = { env: { [CLAUDE_PLUGIN_DIRS_ENV]: `/mine:${MOD}` } };
    assert.equal(withClaudeMods(installed, { ...opts, enabled: true }), installed);
    const none = { env: { OTHER: "1" } };
    assert.equal(withClaudeMods(none, { ...opts, enabled: false }), none);
    assert.equal(stripClaudeMods(none, opts).changed, false);
  });

  it("removes only the Nexus entry, and the key when nothing else is left", () => {
    const shared = stripClaudeMods({ env: { [CLAUDE_PLUGIN_DIRS_ENV]: `/mine:${MOD}`, OTHER: "1" } }, opts);
    assert.equal(shared.changed, true);
    assert.deepEqual(shared.settings.env, { [CLAUDE_PLUGIN_DIRS_ENV]: "/mine", OTHER: "1" });
    const alone = stripClaudeMods({ env: { [CLAUDE_PLUGIN_DIRS_ENV]: MOD, OTHER: "1" } }, opts);
    assert.deepEqual(alone.settings.env, { OTHER: "1" });
  });

  it("leaves a value it doesn't understand alone", () => {
    const odd = { env: { [CLAUDE_PLUGIN_DIRS_ENV]: ["/mine"] } };
    assert.equal(withClaudeMods(odd, { ...opts, enabled: true }), odd);
  });

  it("uses the platform's list separator", () => {
    const win = withClaudeMods({ env: { [CLAUDE_PLUGIN_DIRS_ENV]: "C:\\mine" } }, {
      enabled: true,
      modDir: "C:\\nexus\\mods\\ultrafast-fireworks",
      delimiter: ";",
    });
    assert.equal(win.env[CLAUDE_PLUGIN_DIRS_ENV], "C:\\mine;C:\\nexus\\mods\\ultrafast-fireworks");
  });

  it("points at the mod this install ships", () => {
    assert.ok(existsSync(path.join(ultrafastModDir(), ".claude-plugin", "plugin.json")));
    assert.ok(existsSync(path.join(ultrafastModDir(), "hooks", "hooks.json")));
    assert.equal(isNexusModEntry(ultrafastModDir()), true);
  });
});

describe("`nexus claude on/off` and the banner mod", () => {
  const ENV = { FIREWORKS_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", NEXUS_CLAUDE_MODS: "" };

  async function connect(home, version) {
    seedServerlessCatalogCache(home, [mockServerlessModel({
      name: "accounts/fireworks/models/glm-5p3",
      aliases: ["accounts/fireworks/routers/glm-latest"],
    })]);
    const env = { ...ENV, HOME: home, NEXUS_TEST_CLAUDE_VERSION: version };
    const login = await runFireconnect(["login", "--api-key", "fw_test_key_12345"], env);
    assert.equal(login.code, 0, login.stderr);
    const on = await runFireconnect(["claude", "on"], env);
    assert.equal(on.code, 0, on.stderr);
    return env;
  }

  it("adds the mod beside a user's own plugin dir, and off restores the file byte for byte", async () => {
    await withTempHome("claude-mods-on-off", async (home) => {
      const settingsPath = path.join(home, ".claude", "settings.json");
      await mkdir(path.dirname(settingsPath), { recursive: true });
      const original = `{\n  "env": { "${CLAUDE_PLUGIN_DIRS_ENV}": "/opt/my-plugins" },\n  "theme": "dark"\n}\n`;
      await writeFile(settingsPath, original);

      const env = await connect(home, "2.1.330 (Claude Code)");
      const on = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(on.env[CLAUDE_PLUGIN_DIRS_ENV], ["/opt/my-plugins", ultrafastModDir()].join(path.delimiter));

      const off = await runFireconnect(["claude", "off"], env);
      assert.equal(off.code, 0, off.stderr);
      assert.equal(await readFile(settingsPath, "utf8"), original);
    });
  });

  it("skips the mod on a Claude Code release that can't load it", async () => {
    await withTempHome("claude-mods-old", async (home) => {
      await connect(home, "2.1.250 (Claude Code)");
      const settings = JSON.parse(await readFile(path.join(home, ".claude", "settings.json"), "utf8"));
      assert.equal(settings.env[CLAUDE_PLUGIN_DIRS_ENV], undefined);
      assert.ok(settings.statusLine, "the status line still plays the banner there");
    });
  });
});
