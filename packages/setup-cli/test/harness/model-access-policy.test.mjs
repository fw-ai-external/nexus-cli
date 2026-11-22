// A harness configured on a model the account's catalog stops listing (the
// organization's Model Access policy blocks it): `status` flags it, a plain
// re-`on` keeps it and says how to switch, and nothing is rewritten unasked.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";
import { itIfSqlite, runFireconnect } from "../helpers.mjs";

// The mock gateway serves a catalog to keys marked "cataloged": v1 lists
// deepseek-v4-flash and kimi-k3; v2 lists glm-5p2 and kimi-k3 only.
const KEY_V1 = "fw_test_cataloged_v1_access_00000";
const KEY_V2 = "fw_test_cataloged_v2_access_00000";

function opencodeConfigPath(home) {
  return path.join(home, ".config", "opencode", "opencode.json");
}

async function withOpencodeHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-model-access-"));
  await mkdir(path.dirname(opencodeConfigPath(home)), { recursive: true });
  await writeFile(opencodeConfigPath(home), `${JSON.stringify({ provider: {} }, null, 2)}\n`);
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Sign in with `key`, then run `args` in the same home. */
async function asAccount(home, key, args) {
  const env = { HOME: home, FIREWORKS_API_KEY: "" };
  const login = await runFireconnect(["login", "--api-key", key], env);
  assert.equal(login.code, 0, login.stderr);
  return runFireconnect(args, env);
}

describe("Model Access: configured models the catalog no longer lists", () => {
  it("re-on keeps the blocked model and says how to switch; status flags it", async () => {
    await withOpencodeHome(async (home) => {
      const first = await asAccount(home, KEY_V1, ["opencode", "on", "--model", "deepseek-v4-flash"]);
      assert.equal(first.code, 0, first.stderr);
      assert.equal(JSON.parse(await readFile(opencodeConfigPath(home), "utf8")).model, "fireworks-ai/accounts/fireworks/models/deepseek-v4-flash");

      // The account's catalog no longer lists the model.
      const reOn = await asAccount(home, KEY_V2, ["opencode", "on"]);
      assert.equal(reOn.code, 0, reOn.stderr);
      assert.match(reOn.stderr, /deepseek-v4-flash isn't available to this account\./);
      assert.match(reOn.stderr, /Model Access policy may block it/);
      // The catalog lists no `auto` row, so the offer is a model it does list.
      assert.match(reOn.stderr, /nexus opencode on --model glm-latest/);
      // Without a terminal nothing is switched.
      assert.equal(JSON.parse(await readFile(opencodeConfigPath(home), "utf8")).model, "fireworks-ai/accounts/fireworks/models/deepseek-v4-flash");

      const status = await runFireconnect(["opencode", "status", "--json"], { HOME: home });
      assert.equal(status.code, 0, status.stderr);
      const payload = JSON.parse(status.stdout);
      assert.equal(payload.modelAccess.checked, true);
      assert.deepEqual(payload.modelAccess.blocked, [{ slot: "main", model: "deepseek-v4-flash" }]);

      const human = await runFireconnect(["opencode", "status"], { HOME: home });
      assert.match(human.stdout, /deepseek-v4-flash isn't available to this account\. .*Run `nexus opencode on` to switch/);

      const global = await runFireconnect(["status", "--json"], { HOME: home, FIREWORKS_API_KEY: "" });
      const opencode = JSON.parse(global.stdout).perHarness.find((h) => h.id === "opencode");
      assert.deepEqual(opencode.modelAccess.blocked, [{ slot: "main", model: "deepseek-v4-flash" }]);

      // `--model` names an allowed one: the switch happens, and status clears.
      const switched = await asAccount(home, KEY_V2, ["opencode", "on", "--model", "glm-latest"]);
      assert.equal(switched.code, 0, switched.stderr);
      const after = JSON.parse((await runFireconnect(["opencode", "status", "--json"], { HOME: home })).stdout);
      assert.deepEqual(after.modelAccess.blocked, []);
    });
  });

  it("--model for a model the catalog doesn't list names the account and the policy", async () => {
    await withOpencodeHome(async (home) => {
      const on = await asAccount(home, KEY_V2, ["opencode", "on", "--model", "deepseek-v4-flash"]);
      assert.notEqual(on.code, 0);
      assert.match(on.stderr, /Model "deepseek-v4-flash" isn't in this account's model list\./);
      assert.match(on.stderr, /Check the spelling; if it's right, your organization's Model Access policy may block it/);
    });
  });

  it("an allowed configured model raises nothing", async () => {
    await withOpencodeHome(async (home) => {
      const on = await asAccount(home, KEY_V2, ["opencode", "on", "--model", "kimi-latest"]);
      assert.equal(on.code, 0, on.stderr);
      const reOn = await asAccount(home, KEY_V2, ["opencode", "on"]);
      assert.equal(reOn.code, 0, reOn.stderr);
      assert.doesNotMatch(reOn.stderr, /isn't available/);
      const payload = JSON.parse((await runFireconnect(["opencode", "status", "--json"], { HOME: home })).stdout);
      assert.deepEqual(payload.modelAccess.blocked, []);
    });
  });

  it("claude: a pinned tier slot the catalog stops listing is kept, flagged, and the switch is spelled out", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-model-access-claude-"));
    try {
      const settingsPath = path.join(home, ".claude", "settings.json");
      const first = await asAccount(home, KEY_V1, ["claude", "on", "--sonnet", "deepseek-v4-flash"]);
      assert.equal(first.code, 0, first.stderr);
      const sonnetEnv = () => readFile(settingsPath, "utf8")
        .then((raw) => JSON.parse(raw).env.ANTHROPIC_DEFAULT_SONNET_MODEL);
      assert.match(await sonnetEnv(), /deepseek-v4-flash/);

      const reOn = await asAccount(home, KEY_V2, ["claude", "on"]);
      assert.equal(reOn.code, 0, reOn.stderr);
      assert.match(reOn.stderr, /deepseek-v4-flash \(sonnet\) isn't available to this account\./);
      assert.match(reOn.stderr, /nexus claude on --sonnet glm-latest/);
      assert.match(await sonnetEnv(), /deepseek-v4-flash/);

      const status = JSON.parse((await runFireconnect(["claude", "status", "--json"], { HOME: home })).stdout);
      assert.equal(status.modelAccess.checked, true);
      assert.deepEqual(
        status.modelAccess.blocked.filter((entry) => entry.slot !== "picker"),
        [{ slot: "sonnet", model: "deepseek-v4-flash" }],
      );

      const switched = await asAccount(home, KEY_V2, ["claude", "on", "--sonnet", "glm-latest"]);
      assert.equal(switched.code, 0, switched.stderr);
      const after = JSON.parse((await runFireconnect(["claude", "status", "--json"], { HOME: home })).stdout);
      assert.deepEqual(after.modelAccess.blocked, []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("copilot-cli: its provider-qualified selection (fireworks/<id>) is matched by its catalog id", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-model-access-copilot-"));
    try {
      const on = await asAccount(home, KEY_V2, ["copilot-cli", "on", "--model", "kimi-latest"]);
      assert.equal(on.code, 0, on.stderr);
      assert.doesNotMatch(on.stderr, /isn't available/);
      const status = JSON.parse((await runFireconnect(["copilot-cli", "status", "--json"], { HOME: home })).stdout);
      assert.equal(status.selectedModel, "fireworks/kimi-latest");
      assert.equal(status.modelAccess.checked, true);
      assert.deepEqual(status.modelAccess.blocked, []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  itIfSqlite("cursor: its `nexus/auto` default is the catalog's auto, not a blocked model", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fc-model-access-cursor-"));
    try {
      const dbPath = path.join(home, "state.vscdb");
      const blob = {
        openAIBaseUrl: null,
        useOpenAIKey: false,
        aiSettings: {
          userAddedModels: [],
          modelOverrideEnabled: [],
          modelConfig: { composer: { modelName: "default", maxMode: true, selectedModels: [{ modelId: "default", parameters: [] }] } },
        },
      };
      const key = "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
      const sql = "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);"
        + `INSERT OR REPLACE INTO ItemTable(key,value) VALUES('${key}','${JSON.stringify(blob).replace(/'/g, "''")}');`;
      assert.equal(spawnSync("sqlite3", [dbPath, sql]).status, 0);

      const on = await asAccount(home, KEY_V2, ["cursor", "on", "--db-path", dbPath, "--force"]);
      assert.equal(on.code, 0, on.stderr);
      const status = JSON.parse((await runFireconnect(["cursor", "status", "--db-path", dbPath, "--json"], { HOME: home })).stdout);
      assert.equal(status.current.main, "nexus/auto");
      assert.equal(status.modelAccess.checked, true);
      assert.deepEqual(status.modelAccess.blocked, []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("status can't tell when the harness's key isn't the one the catalog was fetched with", async () => {
    await withOpencodeHome(async (home) => {
      const first = await asAccount(home, KEY_V1, ["opencode", "on", "--model", "deepseek-v4-flash"]);
      assert.equal(first.code, 0, first.stderr);
      // OpenCode now holds another account's key; only account A's catalog is cached.
      const config = JSON.parse(await readFile(opencodeConfigPath(home), "utf8"));
      config.provider["fireworks-ai"].options.apiKey = KEY_V2;
      await writeFile(opencodeConfigPath(home), JSON.stringify(config, null, 2));
      const status = JSON.parse((await runFireconnect(["opencode", "status", "--json"], { HOME: home })).stdout);
      assert.equal(status.modelAccess.checked, false);
      assert.equal(status.modelAccess.reason, "other-account");
      assert.deepEqual(status.modelAccess.blocked, []);
    });
  });
});
