import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { readGlobalConfig, writeGlobalConfig } from "../../lib/config/global-config.mjs";
import {
  FIREWORKS_KEYS_URL,
  NEXUS_KEYS_URL,
  keysUrlFor,
  keysUrlOverrideNote,
  keysUrlForHome,
  verifyFailureLine,
} from "../../lib/keys/api-key.mjs";

async function withTempHome(fn) {
  const home = await mkdtemp(path.join(tmpdir(), "nexus-keys-url-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("API-keys link by account kind", () => {
  it("sends known Platform accounts to the Platform and everyone else to the Nexus site", () => {
    assert.equal(NEXUS_KEYS_URL, "https://nexus.fireworks.ai/settings/api-keys");
    assert.equal(keysUrlFor("nexus"), NEXUS_KEYS_URL);
    assert.equal(keysUrlFor("platform"), FIREWORKS_KEYS_URL);
    assert.equal(keysUrlFor("unknown"), NEXUS_KEYS_URL);
    assert.equal(keysUrlFor(undefined), NEXUS_KEYS_URL);
  });

  it("notes a non-production web app without NEXUS_KEYS_URL, and nothing otherwise", () => {
    assert.match(keysUrlOverrideNote("https://console.example.test", undefined), /Set NEXUS_KEYS_URL to that environment's API-keys page/);
    assert.match(keysUrlOverrideNote("https://console.example.test/", "not a url"), /NEXUS_KEYS_URL isn't set to an https URL/);
    assert.match(keysUrlOverrideNote("https://console.example.test", "http://keys.example.test"), /NEXUS_KEYS_URL isn't set to an https URL/);
    assert.equal(keysUrlOverrideNote("https://console.example.test", "https://keys.example.test/settings/api-keys"), "");
    for (const prod of ["https://app.fireworks.ai", "https://app.fireworks.ai/"]) assert.equal(keysUrlOverrideNote(prod, undefined), "", prod);
    for (const other of ["http://localhost:3001", "not a url", "", undefined]) assert.equal(keysUrlOverrideNote(other, undefined), "", String(other));
  });

  it("follows a non-production web app and NEXUS_KEYS_URL, production for anything else", () => {
    const env = { NEXUS_WEB_APP_URL: "https://console.example.test", NEXUS_KEYS_URL: "https://keys.example.test/settings/api-keys" };
    assert.equal(keysUrlFor("nexus", env), "https://keys.example.test/settings/api-keys");
    assert.equal(keysUrlFor("unknown", env), "https://keys.example.test/settings/api-keys");
    assert.equal(keysUrlFor("platform", env), "https://console.example.test/settings/users/api-keys");
    assert.equal(keysUrlFor("nexus", { NEXUS_WEB_APP_URL: "https://console.example.test" }), NEXUS_KEYS_URL);
    assert.equal(keysUrlFor("nexus", { NEXUS_WEB_APP_URL: "https://app.fireworks.ai/" }), NEXUS_KEYS_URL);
    assert.equal(keysUrlFor("platform", { NEXUS_WEB_APP_URL: "https://app.fireworks.ai" }), FIREWORKS_KEYS_URL);
    for (const other of ["http://localhost:3001", "not a url", ""]) {
      assert.equal(keysUrlFor("nexus", { NEXUS_WEB_APP_URL: other, NEXUS_KEYS_URL: other }), NEXUS_KEYS_URL, other);
      assert.equal(keysUrlFor("platform", { NEXUS_WEB_APP_URL: other }), FIREWORKS_KEYS_URL, other);
    }
  });

  it("follows the account kind saved in config, Nexus when unknown or unreadable", async () => {
    await withTempHome(async (home) => {
      assert.equal(await keysUrlForHome(home), NEXUS_KEYS_URL);
      const configPath = path.join(home, ".nexus", "config.json");
      const saved = async () => JSON.parse(await readFile(configPath, "utf8"));
      await writeGlobalConfig(home, { ssoAccountId: "example-account" });
      assert.equal((await readGlobalConfig(home)).accountType, "unknown");
      assert.equal(await keysUrlForHome(home), NEXUS_KEYS_URL);
      await writeGlobalConfig(home, { accountType: "nexus" });
      assert.equal((await readGlobalConfig(home)).nexusAccount, true);
      assert.equal(await keysUrlForHome(home), NEXUS_KEYS_URL);
      await writeGlobalConfig(home, { accountType: "platform" });
      assert.equal(await keysUrlForHome(home), FIREWORKS_KEYS_URL);
      // Other writes keep it, and the older boolean stays in step.
      await writeGlobalConfig(home, { ssoAccountId: "example-account" });
      assert.equal(await keysUrlForHome(home), FIREWORKS_KEYS_URL);
      assert.equal((await saved()).nexusAccount, false);
      await writeGlobalConfig(home, { accountType: "unknown" });
      assert.equal("accountType" in await saved(), false);
      assert.equal((await saved()).nexusAccount, false);
      assert.equal(await keysUrlForHome(home), NEXUS_KEYS_URL);
      // A config from before accountType: true is Nexus, false is unknown.
      await writeFile(configPath, JSON.stringify({ nexusAccount: true }));
      assert.equal((await readGlobalConfig(home)).accountType, "nexus");
      await writeFile(configPath, JSON.stringify({ nexusAccount: false }));
      assert.equal(await keysUrlForHome(home), NEXUS_KEYS_URL);
      // Callers still passing the older boolean update the account kind.
      await writeGlobalConfig(home, { accountType: "platform" });
      await writeGlobalConfig(home, { nexusAccount: true });
      assert.equal((await readGlobalConfig(home)).accountType, "nexus");
      await writeGlobalConfig(home, { nexusAccount: false });
      assert.equal((await readGlobalConfig(home)).accountType, "unknown");
      await writeFile(configPath, JSON.stringify({ accountType: "other" }));
      assert.equal(await keysUrlForHome(home), NEXUS_KEYS_URL);
      await writeFile(configPath, "{not json");
      assert.equal(await keysUrlForHome(home), NEXUS_KEYS_URL);
    });
  });

  it("puts the chosen link in the rejected-key line", () => {
    const rejected = { ok: false, reason: "rejected" };
    assert.match(verifyFailureLine(rejected), /nexus\.fireworks\.ai\/settings\/api-keys/);
    assert.match(verifyFailureLine(rejected, { keysUrl: FIREWORKS_KEYS_URL }), /app\.fireworks\.ai\/settings\/users\/api-keys/);
  });
});
