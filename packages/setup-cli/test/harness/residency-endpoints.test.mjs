import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { readGlobalConfig, writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { scopedCacheFilePath } from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { readClaudeSettings, readOpencodeConfig, runCli, runCliJson } from "../helpers.mjs";

const KEY = "fw_test_key_12345";
const US_V1 = "https://us.api.fireworks.ai/inference/v1";

async function withHome(prefix, fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** `nexus login` then `nexus <harness> on`, with the account's residency stubbed. */
async function loginAndOn(home, harness, residency) {
  const login = await runCli(["login", "--api-key", KEY], { home });
  assert.equal(login.code, 0, login.stderr);
  const on = await runCli([harness, "on"], { home, env: { NEXUS_TEST_RESIDENCY: residency } });
  assert.equal(on.code, 0, on.stderr);
  return on;
}

async function readPiModels(home) {
  return JSON.parse(await readFile(path.join(home, ".pi/agent/models.json"), "utf8"));
}

describe("harness endpoints follow the account's data residency", () => {
  it("opencode on writes the US endpoint for a US-residency account", async () => {
    await withHome("nexus-residency-opencode-", async (home) => {
      await loginAndOn(home, "opencode", "US");

      const config = await readOpencodeConfig(home);
      assert.equal(config.provider["fireworks-ai"].options.baseURL, US_V1);
      assert.equal((await readGlobalConfig(home)).harnesses.opencode.residency, "US");
    });
  });

  it("opencode on drops the regional endpoint once the account has no residency", async () => {
    await withHome("nexus-residency-opencode-clear-", async (home) => {
      await loginAndOn(home, "opencode", "US");
      const on = await runCli(["opencode", "on"], { home, env: { NEXUS_TEST_RESIDENCY: "" } });
      assert.equal(on.code, 0, on.stderr);

      const config = await readOpencodeConfig(home);
      assert.equal(config.provider["fireworks-ai"].options.baseURL, undefined);
      assert.equal((await readGlobalConfig(home)).harnesses.opencode.residency, undefined);
    });
  });

  it("opencode on writes no base URL without residency", async () => {
    await withHome("nexus-residency-opencode-global-", async (home) => {
      await loginAndOn(home, "opencode", "");

      const config = await readOpencodeConfig(home);
      assert.equal(config.provider["fireworks-ai"].options.baseURL, undefined);
    });
  });

  it("pi on writes the US endpoint for a US-residency account", async () => {
    await withHome("nexus-residency-pi-", async (home) => {
      await loginAndOn(home, "pi", "US");

      assert.equal((await readPiModels(home)).providers.fireworks.baseUrl, US_V1);
    });
  });

  it("pi on writes no base URL without residency", async () => {
    await withHome("nexus-residency-pi-global-", async (home) => {
      await loginAndOn(home, "pi", "");

      assert.equal((await readPiModels(home)).providers.fireworks.baseUrl, undefined);
    });
  });

  it("codex on writes the US endpoint, and status still sees Codex as routed through Fireworks", async () => {
    await withHome("nexus-residency-codex-", async (home) => {
      await loginAndOn(home, "codex", "US");

      const config = await readFile(path.join(home, ".codex/config.toml"), "utf8");
      assert.match(config, /base_url = "https:\/\/us\.api\.fireworks\.ai\/inference\/v1"/);
      assert.doesNotMatch(config, /base_url = "https:\/\/api\.fireworks\.ai/);
      const status = await runCliJson(["codex", "status", "--json"], { home, env: { NEXUS_TEST_RESIDENCY: "US" } });
      assert.equal(status.code, 0, status.stderr);
      assert.equal(status.json.provider, "fireworks");
      assert.equal(status.json.baseUrl, US_V1);
    });
  });

  it("claude on writes the US endpoint for a US-residency account", async () => {
    await withHome("nexus-residency-claude-", async (home) => {
      await loginAndOn(home, "claude", "US");

      assert.equal((await readClaudeSettings(home)).env.ANTHROPIC_BASE_URL, "https://us.api.fireworks.ai/inference");
      assert.equal((await readGlobalConfig(home)).harnesses.claude.residency, "US");
      const status = await runCliJson(["status", "--json"], { home, env: { NEXUS_TEST_RESIDENCY: "US" } });
      const claude = status.json.perHarness.find((h) => h.id === "claude");
      assert.equal(claude.enabled, true);
      assert.equal(claude.residencyCurrent, true);
    });
  });

  it("an unreadable residency keeps a harness on the endpoint it was set up for", async () => {
    await withHome("nexus-residency-unknown-on-", async (home) => {
      await loginAndOn(home, "opencode", "US");
      await rm(scopedCacheFilePath("residency-cache.json", home), { force: true });
      const on = await runCli(["opencode", "on"], { home, env: { NEXUS_TEST_RESIDENCY: "UNAVAILABLE" } });
      assert.equal(on.code, 0, on.stderr);

      assert.equal((await readOpencodeConfig(home)).provider["fireworks-ai"].options.baseURL, US_V1);
      assert.equal((await readGlobalConfig(home)).harnesses.opencode.residency, "US");
    });
  });

  it("status gives no residency advice when the residency can't be read", async () => {
    await withHome("nexus-residency-unknown-status-", async (home) => {
      await loginAndOn(home, "opencode", "US");
      // The residency cache is gone and the policy can't be read.
      await rm(scopedCacheFilePath("residency-cache.json", home), { force: true });
      const env = { NEXUS_TEST_RESIDENCY: "UNAVAILABLE" };

      const json = await runCliJson(["status", "--json"], { home, env });
      assert.equal(json.json.residency, null);
      assert.equal(json.json.perHarness.find((h) => h.id === "opencode").residencyCurrent, null);
      const text = await runCli(["status"], { home, env });
      assert.doesNotMatch(text.stdout, /Data residency|isn't set up for your account's data residency/);
    });
  });

  it("codex status reports the endpoint that was written, not the account's current residency", async () => {
    await withHome("nexus-residency-codex-written-", async (home) => {
      await loginAndOn(home, "codex", "US");

      // The account dropped residency, but Codex hasn't been turned on again.
      const status = await runCliJson(["codex", "status", "--json"], { home, env: { NEXUS_TEST_RESIDENCY: "" } });
      assert.equal(status.json.baseUrl, US_V1);
    });
  });

  it("on warns about a residency Nexus can't set up, and status doesn't call it current", async () => {
    await withHome("nexus-residency-europe-", async (home) => {
      const on = await loginAndOn(home, "opencode", "EUROPE");
      assert.match(on.stdout + on.stderr, /Your account has EUROPE data residency, which Nexus can't set up yet\./);
      assert.equal((await readOpencodeConfig(home)).provider["fireworks-ai"].options.baseURL, undefined);

      const json = await runCliJson(["status", "--json"], { home, env: { NEXUS_TEST_RESIDENCY: "EUROPE" } });
      assert.equal(json.json.residency, null);
      assert.equal(json.json.unsupportedResidency, "EUROPE");
      assert.equal(json.json.perHarness.find((h) => h.id === "opencode").residencyCurrent, null);
      const text = await runCli(["status"], { home, env: { NEXUS_TEST_RESIDENCY: "EUROPE" } });
      assert.match(text.stdout, /Your account has EUROPE data residency, which Nexus can't set up yet\./);
    });
  });

  it("on says so when it can't read the residency and nothing is recorded", async () => {
    await withHome("nexus-residency-unknown-note-", async (home) => {
      const on = await loginAndOn(home, "opencode", "UNAVAILABLE");
      assert.match(on.stdout + on.stderr, /Couldn't read your account's data residency; using api\.fireworks\.ai\./);
    });
  });

  it("status flags a harness set up before the account had residency", async () => {
    await withHome("nexus-residency-status-", async (home) => {
      await loginAndOn(home, "opencode", "");
      // The account turned on US residency after OpenCode was connected.
      const env = { NEXUS_TEST_RESIDENCY: "US" };

      const json = await runCliJson(["status", "--json"], { home, env });
      assert.deepEqual(json.json.residency, { value: "US", inferenceHost: "us.api.fireworks.ai" });
      assert.equal(json.json.perHarness.find((h) => h.id === "opencode").residencyCurrent, false);

      const text = await runCli(["status"], { home, env });
      assert.match(text.stdout, /Data residency: US \(inference on us\.api\.fireworks\.ai\)/);
      assert.match(text.stdout, /OpenCode isn't set up for your account's data residency.*Run: nexus opencode on \(it will use us\.api\.fireworks\.ai\)/s);
    });
  });

  it("status doesn't flag a harness already set up for the account's residency", async () => {
    await withHome("nexus-residency-status-current-", async (home) => {
      await loginAndOn(home, "opencode", "US");

      const json = await runCliJson(["status", "--json"], { home, env: { NEXUS_TEST_RESIDENCY: "US" } });
      assert.equal(json.json.perHarness.find((h) => h.id === "opencode").residencyCurrent, true);
    });
  });

  it("status doesn't flag a harness routed through Azure", async () => {
    await withHome("nexus-residency-status-azure-", async (home) => {
      await loginAndOn(home, "opencode", "");
      const config = await readGlobalConfig(home);
      await writeGlobalConfig(home, {
        harnesses: { ...config.harnesses, opencode: { ...config.harnesses.opencode, provider: "azure" } },
      });

      const json = await runCliJson(["status", "--json"], { home, env: { NEXUS_TEST_RESIDENCY: "US" } });
      assert.notEqual(json.json.perHarness.find((h) => h.id === "opencode")?.residencyCurrent, false);
    });
  });
});
