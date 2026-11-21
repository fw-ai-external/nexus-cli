import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { HARNESSES } from "../../lib/harness/id.mjs";
import { runCli, runCliJson, seedKeychainConfig, withTempHome, writeClaudeSettings } from "../helpers.mjs";
import { writeMintedKeyState } from "../../lib/keys/mint-api-key.mjs";

const VALID_KEY = "fw_status_test_key_0000000000000000";
const REJECTED_KEY = "fw_status_rejected_key_0000000000";
const EMAIL = "dev@example.com";
const ACCOUNT = "acct-test";

/** Mock of the gateway's GET /verifyApiKey: identity headers on 200, 401 otherwise. */
function startMockGateway() {
  const server = createServer((req, res) => {
    if (req.url !== "/verifyApiKey") {
      res.writeHead(404);
      res.end();
      return;
    }
    const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (key === VALID_KEY) {
      res.writeHead(200, {
        "x-fireworks-account-id": ACCOUNT,
        "x-fireworks-developer-email": EMAIL,
      });
    } else {
      res.writeHead(401);
    }
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe("fireconnect status", () => {
  let gateway;
  let gatewayEnv;

  before(async () => {
    gateway = await startMockGateway();
    gatewayEnv = { NEXUS_GATEWAY_URL: gateway.url };
  });

  after(() => {
    gateway.server.close();
  });

  it("reports not signed in with no key (exit 1) and still shows storage", async () => {
    await withTempHome("status-none-", async (home) => {
      const result = await runCli(["status"], { home, env: gatewayEnv });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /Not signed in/);
      assert.match(result.stdout, /nexus login/);
      // The storage report renders regardless of auth state.
      assert.match(result.stdout, /Config ref:/);
      assert.match(result.stdout, /Harnesses:/);
      assert.doesNotMatch(result.stdout, /FIREWORKS_API_KEY/);
    });
  });

  it("ignores a valid env key: status reports not signed in", async () => {
    await withTempHome("status-env-", async (home) => {
      const result = await runCli(["status"], {
        home,
        env: { ...gatewayEnv, FIREWORKS_API_KEY: VALID_KEY },
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /Not signed in/);
      // Explains why the exported key didn't count, without echoing it.
      assert.match(result.stdout, /FIREWORKS_API_KEY.*is set in your shell but Nexus ignores it/);
      assert.doesNotMatch(result.stdout, new RegExp(VALID_KEY));
    });
  });

  it("reports identity for a valid stored key (exit 0)", async () => {
    await withTempHome("status-stored-", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await seedKeychainConfig(home, VALID_KEY);
      const result = await runCli(["status"], { home, env: gatewayEnv });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Signed in as ${EMAIL}`));
      assert.match(result.stdout, /Active key: stored credential/);
      assert.match(result.stdout, /Key stored: yes/);
    });
  });

  it("uses the stored key and ignores the env key when both are present", async () => {
    await withTempHome("status-env-over-stored-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      const result = await runCli(["status"], {
        home,
        env: { ...gatewayEnv, FIREWORKS_API_KEY: REJECTED_KEY },
      });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      // The env var no longer wins: the stored key verifies, even with a bad
      // FIREWORKS_API_KEY sitting in the environment.
      assert.match(result.stdout, new RegExp(`Signed in as ${EMAIL}`));
      assert.match(result.stdout, /Active key: stored credential/);
      // With a key stored, the env var is noise: no field, no note.
      assert.doesNotMatch(result.stdout, /FIREWORKS_API_KEY/);
    });
  });

  it("flags a rejected stored key and points at login (exit 1)", async () => {
    await withTempHome("status-stored-rejected-", async (home) => {
      await seedKeychainConfig(home, REJECTED_KEY);
      const result = await runCli(["status"], { home, env: gatewayEnv });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /rejected/);
      assert.match(result.stdout, /nexus login/);
      assert.doesNotMatch(result.stdout, /--force/);
    });
  });

  it("ignores a rejected FIREWORKS_API_KEY and reports not signed in", async () => {
    await withTempHome("status-env-rejected-", async (home) => {
      const result = await runCli(["status"], {
        home,
        env: { ...gatewayEnv, FIREWORKS_API_KEY: REJECTED_KEY },
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /Not signed in/);
      assert.doesNotMatch(result.stdout, /--force/);
    });
  });

  it("stays exit 0 when a key is present but the gateway is unreachable", async () => {
    await withTempHome("status-unreachable-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      const result = await runCli(["status"], {
        home,
        env: { NEXUS_GATEWAY_URL: "http://127.0.0.1:1" },
      });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /couldn't be reached/i);
    });
  });

  it("--json emits an auth block plus the storage summary", async () => {
    await withTempHome("status-json-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      const result = await runCli(["status", "--json"], { home, env: gatewayEnv });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.auth.signedIn, true);
      assert.equal(summary.auth.email, EMAIL);
      assert.equal(summary.activeKeySource, "stored");
      assert.equal(summary.keychainPresent, true);
      assert.ok(Array.isArray(summary.perHarness));
    });
  });

  it("shows when a browser sign-in's key expires, and warns in its last day", async () => {
    await withTempHome("status-expiry-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      const day = 86_400_000;
      const record = (expiresAt, apiKey = VALID_KEY) => writeMintedKeyState(home, {
        keyId: "key-1", userName: "accounts/acct-test/users/dev", displayName: "nexus-cli-host", apiKey, expiresAt,
      });

      const far = new Date(Date.now() + 60 * day).toISOString();
      await record(far);
      let result = await runCli(["status"], { home, env: gatewayEnv });
      assert.match(result.stdout, new RegExp(`Key expires:\\s+${far.slice(0, 10)} \\(in (59|60) days\\)`));
      assert.doesNotMatch(result.stdout, /Run nexus login to replace it/);
      assert.equal((await runCliJson(["status", "--json"], { home, env: gatewayEnv })).json.keyExpiresAt, far);

      // A key with days left (a fresh 7-day key) gets no warning.
      const days = new Date(Date.now() + 3 * day).toISOString();
      await record(days);
      result = await runCli(["status"], { home, env: gatewayEnv });
      assert.match(result.stdout, new RegExp(`Key expires:\\s+${days.slice(0, 10)} \\(in (3|4) days\\)`));
      assert.doesNotMatch(result.stdout, /Run nexus login to replace it/);

      const soon = new Date(Date.now() + day / 2).toISOString();
      await record(soon);
      result = await runCli(["status"], { home, env: gatewayEnv });
      assert.match(result.stdout, new RegExp(`This machine's API key expires on ${soon.slice(0, 10)}\\. Run nexus login to replace it\\.`));

      // A record for some other key says nothing about this one.
      await record(soon, "fw_some_other_key_000000000000000");
      result = await runCli(["status"], { home, env: gatewayEnv });
      assert.doesNotMatch(result.stdout, /Key expires/);
      assert.equal((await runCliJson(["status", "--json"], { home, env: gatewayEnv })).json.keyExpiresAt, null);
    });
  });

  it("never shows a past expiry as still valid", async () => {
    await withTempHome("status-past-expiry-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      const past = new Date(Date.now() - 86_400_000).toISOString();
      await writeMintedKeyState(home, {
        keyId: "key-1", userName: "accounts/acct-test/users/dev", displayName: "nexus-cli-host", apiKey: VALID_KEY, expiresAt: past,
      });
      const result = await runCli(["status"], { home, env: gatewayEnv });
      assert.match(result.stdout, new RegExp(`Key expires:\\s+${past.slice(0, 10)} \\(expired\\)`));
      assert.doesNotMatch(result.stdout, /in 0 days/);
    });
  });

  it("names an expired key as expired and points at nexus login", async () => {
    await withTempHome("status-expired-", async (home) => {
      await seedKeychainConfig(home, REJECTED_KEY);
      const expired = new Date(Date.now() - 86_400_000).toISOString();
      await writeMintedKeyState(home, {
        keyId: "key-1", userName: "accounts/acct-test/users/dev", displayName: "nexus-cli-host", apiKey: REJECTED_KEY, expiresAt: expired,
      });
      const result = await runCli(["status"], { home, env: gatewayEnv });
      assert.equal(result.code, 1);
      assert.match(result.stdout, new RegExp(`This machine's API key expired on ${expired.slice(0, 10)}\\. Run nexus login to sign in again\\.`));
    });
  });

  it("help lists status and has a status topic", async () => {
    await withTempHome("status-help-", async (home) => {
      const help = await runCli(["help"], { home });
      assert.match(help.stdout, /status\s+Show sign-in state, environment, key storage, and each harness/);
      const topic = await runCli(["help", "status"], { home });
      assert.match(topic.stdout, /--json/);
    });
  });

  it("lists a harness as on from ground truth even when the global enabled flag is stale", async () => {
    // Simulate flag drift: Claude's real settings.json points at Fireworks,
    // but the global ~/.nexus/config.json harnesses.claude.enabled flag
    // was never flipped to true (the legacy condition this fix addresses).
    // `status` must read the real config and list Claude as on regardless.
    await withTempHome("status-groundtruth-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      await writeClaudeSettings(home, VALID_KEY, { fireworks: true });

      const result = await runCli(["status"], { home, env: gatewayEnv });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /Harnesses:/);
      // The summary lists each harness with a plain on/off state (no key-source
      // detail). Claude is on via ground truth despite the stale flag.
      assert.match(result.stdout, /^\s+claude\s+Claude Code\s+on\s+(installed|not detected)$/m);
      assert.doesNotMatch(result.stdout, /X-Fireworks-Api-Key header in settings\.json/);

      // The --json path reports the same ground-truth `enabled: true`.
      const json = await runCliJson(["status", "--json"], { home, env: gatewayEnv });
      const claude = json.json.perHarness.find((h) => h.id === "claude");
      assert.equal(claude?.enabled, true);
    });
  });

  it("--json prints every harness with a boolean `installed` even when signed out", async () => {
    // Callers read install state from this JSON regardless of the exit code.
    await withTempHome("status-json-signed-out-", async (home) => {
      const bin = path.join(home, "bin");
      await mkdir(bin);
      await mkdir(path.join(home, ".pi", "agent", "sessions"), { recursive: true });
      await writeFile(path.join(home, ".pi", "agent", "sessions", "s.jsonl"), "");
      const env = {
        ...gatewayEnv,
        PATH: bin,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
      };
      const result = await runCliJson(["status", "--json"], { home, env });
      assert.equal(result.code, 1, "signed out exits 1");
      assert.equal(result.json.auth.signedIn, false);
      assert.deepEqual(result.json.perHarness.map((h) => h.id).sort(), [...HARNESSES].sort());
      for (const h of result.json.perHarness) {
        assert.equal(typeof h.installed, "boolean", `${h.id}.installed`);
        assert.equal(typeof h.enabled, "boolean", `${h.id}.enabled`);
      }
      assert.equal(result.json.perHarness.find((h) => h.id === "pi").installed, true);
    });
  });

  it("--json still prints every harness's `installed` when the gateway is unreachable", async () => {
    await withTempHome("status-json-offline-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      const bin = path.join(home, "bin");
      await mkdir(bin);
      const env = {
        ...gatewayEnv,
        // Nothing listens on port 9 (discard), so the key check can't connect.
        NEXUS_GATEWAY_URL: "http://127.0.0.1:9",
        PATH: bin,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
      };
      const result = await runCliJson(["status", "--json"], { home, env });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.json.auth.signedIn, null);
      assert.equal(result.json.auth.reason, "unreachable");
      assert.deepEqual(result.json.perHarness.map((h) => h.id).sort(), [...HARNESSES].sort());
      for (const h of result.json.perHarness) {
        assert.equal(typeof h.installed, "boolean", `${h.id}.installed`);
      }
    });
  });

  it("shows whether each harness is installed, next to on/off", async () => {
    await withTempHome("status-installed-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      const bin = path.join(home, "bin");
      await mkdir(bin);
      // Session history only Pi writes; an empty ~/.dsh is a leftover, not an install.
      await mkdir(path.join(home, ".pi", "agent", "sessions"), { recursive: true });
      await writeFile(path.join(home, ".pi", "agent", "sessions", "s.jsonl"), "");
      await mkdir(path.join(home, ".dsh"));
      const env = {
        ...gatewayEnv,
        PATH: bin,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        DSH_HOME: "",
      };

      const result = await runCli(["status"], { home, env });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^\s+pi\s+Pi\s+off\s+installed$/m);
      assert.match(result.stdout, /^\s+deepseek\s+DeepSeek Harness \(dsh\)\s+off\s+not detected$/m);

      const json = await runCliJson(["status", "--json"], { home, env });
      const byId = new Map(json.json.perHarness.map((h) => [h.id, h]));
      assert.equal(byId.get("pi")?.installed, true);
      assert.equal(byId.get("deepseek")?.installed, false);
      for (const h of json.json.perHarness) {
        assert.equal(typeof h.installed, "boolean", h.id);
      }
    });
  });
});
