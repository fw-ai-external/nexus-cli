import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { runCli, seedKeychainConfig, withTempHome } from "../helpers.mjs";
import { readGlobalConfig, writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { writeMintedKeyState } from "../../lib/keys/mint-api-key.mjs";
import { pbDecode, pbStringAt } from "../../lib/auth/grpc-web.mjs";
import { accountsForKind, runInteractiveSignIn, signedInIdentityLine } from "../../lib/auth/login/flows.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "../../bin/nexus.mjs");

const VALID_KEY = "fw_login_test_key_000000000000000";
const REJECTED_KEY = "fw_login_rejected_key_00000000000";
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

/**
 * Mock of the Fireworks gRPC-web API, for logout's DeleteApiKey.
 * Captures auth header + decoded request fields; answers with the given
 * grpc-status in the trailers frame.
 */
function startMockGrpcGateway({ status = 0, detail = "" } = {}) {
  /** @type {{ method: string, apiKey: string, parent: string, keyId: string }[]} */
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const request = pbDecode(body.subarray(5)); // skip the 5-byte frame header
      calls.push({
        method: req.url?.split("/").at(-1) ?? "",
        apiKey: String(req.headers["x-api-key"] ?? ""),
        parent: pbStringAt(request, 1),
        keyId: pbStringAt(request, 2),
      });
      const trailer = Buffer.from(`grpc-status:${status}\r\ngrpc-message:${detail}\r\n`);
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      res.end(Buffer.concat([
        Buffer.from([0x00, 0, 0, 0, 0]), // empty message frame (Empty)
        Buffer.from([0x80]),
        (() => { const len = Buffer.alloc(4); len.writeUInt32BE(trailer.length); return len; })(),
        trailer,
      ]));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/web/gateway.Gateway` });
    });
  });
}

const MINTED_STATE = {
  keyId: "key-123",
  userName: "accounts/acct-test/users/u-1",
  displayName: "fireconnect-testhost",
};

async function seedMintedState(home) {
  await mkdir(path.join(home, ".nexus"), { recursive: true });
  await writeFile(path.join(home, ".nexus", "minted-key.json"), JSON.stringify(MINTED_STATE));
}

/** Like helpers.runCli but with a writable stdin (for --with-token). */
function runCliWithStdin(args, { home, env = {}, input = "" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        ...env,
        HOME: home,
        NEXUS_SECRET_STORE: "memory",
        NEXUS_TEST: "1",
        FIREWORKS_API_KEY: env.FIREWORKS_API_KEY ?? "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));

    child.stdin.end(input);
  });
}

describe("fireconnect login / logout", () => {
  let gateway;
  let gatewayEnv;

  before(async () => {
    gateway = await startMockGateway();
    gatewayEnv = { NEXUS_GATEWAY_URL: gateway.url };
  });

  after(() => {
    gateway.server.close();
  });

  it("login --with-token validates, stores, and confirms identity", async () => {
    await withTempHome("login-with-token-", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      const result = await runCliWithStdin(["login", "--with-token"], {
        home,
        env: gatewayEnv,
        input: `${VALID_KEY}\n`,
      });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Signed in as ${EMAIL}`));

      const exported = await runCli(["key", "export"], { home });
      assert.equal(exported.code, 0);
      assert.equal(exported.stdout.trim(), VALID_KEY);
    });
  });

  it("login --with-token rejects a wrong-shaped key without storing it", async () => {
    await withTempHome("login-token-shape-", async (home) => {
      const result = await runCliWithStdin(["login", "--with-token"], {
        home,
        env: gatewayEnv,
        input: "sk-not-a-fireworks-key\n",
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /doesn't look like a Fireworks key/);
      assert.match(result.stderr, /nexus\.fireworks\.ai\/settings\/api-keys/);
      assert.doesNotMatch(result.stderr, /Error:/);

      const exported = await runCli(["key", "export"], { home });
      assert.notEqual(exported.code, 0);
    });
  });

  it("login --with-token surfaces an API-rejected key without storing it", async () => {
    await withTempHome("login-token-rejected-", async (home) => {
      const result = await runCliWithStdin(["login", "--with-token"], {
        home,
        env: gatewayEnv,
        input: `${REJECTED_KEY}\n`,
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /That key didn't work/);
      assert.doesNotMatch(result.stderr, /Error:/);

      const exported = await runCli(["key", "export"], { home });
      assert.notEqual(exported.code, 0);
    });
  });

  it("login --api-key signs in non-interactively", async () => {
    await withTempHome("login-flag-key-", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      const result = await runCli(["login", "--api-key", VALID_KEY], { home, env: gatewayEnv });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Signed in as ${EMAIL}`));

      const exported = await runCli(["key", "export"], { home });
      assert.equal(exported.stdout.trim(), VALID_KEY);
    });
  });

  it("login stores the flag key while FIREWORKS_API_KEY is set (env ignored)", async () => {
    await withTempHome("login-env-conflict-", async (home) => {
      const result = await runCli(["login", "--api-key", VALID_KEY], {
        home,
        env: { ...gatewayEnv, FIREWORKS_API_KEY: VALID_KEY },
      });
      assert.equal(result.code, 0, result.stderr);
    });
  });

  it("interactive sign-in ignores an environment credential", async () => {
    await withTempHome("login-interactive-env-conflict-", async (home) => {
      // env is not a credential source: bare `login` sees no credential, so
      // non-interactive runs point at --with-token instead of "already
      // signed in".
      const result = await runCli(["login"], {
        home,
        env: { ...gatewayEnv, FIREWORKS_API_KEY: VALID_KEY },
      });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /--with-token/);
      assert.doesNotMatch(result.stderr, /Already signed in/);
      await assert.rejects(access(path.join(home, ".nexus", ".secret-memory")));
    });
  });



  it("login re-points the key baked into Claude's Fireworks settings", async () => {
    await withTempHome("login-router-refresh-", async (home) => {
      // A router-mode settings file from before this sign-in: stale key,
      // plus lines that must survive.
      const settingsPath = path.join(home, ".claude", "settings.json");
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
          ANTHROPIC_MODEL: "accounts/fireworks/routers/firerouter[1m]",
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_stale_key_000000000000000000\nx-routing-preference: 3",
          ANTHROPIC_AUTH_TOKEN: "sk-ant-keep",
        },
      }));

      await writeGlobalConfig(home, {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });

      const result = await runCli(["login", "--api-key", VALID_KEY], { home, env: gatewayEnv });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Fireworks settings/);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(
        settings.env.ANTHROPIC_CUSTOM_HEADERS,
        `X-Fireworks-Api-Key: ${VALID_KEY}\nx-routing-preference: 3`,
      );
      assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "sk-ant-keep");
    });
  });

  async function seedStaleClaudeSettings(home) {
    const settingsPath = path.join(home, ".claude", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
        ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_stale_key_000000000000000000",
      },
    }));
    await writeGlobalConfig(home, {
      harnesses: { claude: { enabled: true, provider: "fireworks" } },
    });
    return settingsPath;
  }

  it("login ignores FIREWORKS_API_KEY: no sign-in, no baked-key update", async () => {
    await withTempHome("login-env-rotate-", async (home) => {
      const settingsPath = await seedStaleClaudeSettings(home);

      const result = await runCli(["login"], {
        home,
        env: { ...gatewayEnv, FIREWORKS_API_KEY: VALID_KEY },
      });
      assert.notEqual(result.code, 0);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(
        settings.env.ANTHROPIC_CUSTOM_HEADERS,
        "X-Fireworks-Api-Key: fw_stale_key_000000000000000000",
      );
      await assert.rejects(access(path.join(home, ".nexus", ".secret-memory")));
    });
  });

  it("login with a rotated stored key re-points Claude's baked key", async () => {
    await withTempHome("login-stored-rotate-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      const settingsPath = await seedStaleClaudeSettings(home);

      const result = await runCli(["login"], { home, env: gatewayEnv });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Updated Claude Code's Fireworks settings/);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, `X-Fireworks-Api-Key: ${VALID_KEY}`);
    });
  });

  it("login leaves baked keys alone when the active key can't be verified", async () => {
    await withTempHome("login-unverified-no-sync-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      const settingsPath = await seedStaleClaudeSettings(home);

      const result = await runCli(["login"], {
        home,
        env: { NEXUS_GATEWAY_URL: "http://127.0.0.1:1" },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /couldn't verify/);

      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.equal(
        settings.env.ANTHROPIC_CUSTOM_HEADERS,
        "X-Fireworks-Api-Key: fw_stale_key_000000000000000000",
      );
    });
  });

  it("login when already signed in reports identity and rotation hints", async () => {
    await withTempHome("login-already-", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await seedKeychainConfig(home, VALID_KEY);

      const result = await runCli(["login"], { home, env: gatewayEnv });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Already signed in as ${EMAIL}`));
      assert.match(result.stdout, /--api-key/);
      assert.doesNotMatch(result.stdout, /key expires/);
    });
  });

  it("login when already signed in shows when a browser sign-in key expires", async () => {
    await withTempHome("login-already-expiry-", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await seedKeychainConfig(home, VALID_KEY);
      const record = (expiresAt, apiKey = VALID_KEY) => writeMintedKeyState(home, {
        keyId: "key-1", userName: "accounts/acct-test/users/dev", displayName: "nexus-test", apiKey, expiresAt,
      });

      const later = new Date(Date.now() + 5 * 86_400_000).toISOString();
      await record(later);
      let result = await runCli(["login"], { home, env: gatewayEnv });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Already signed in as ${EMAIL} \\(key expires on ${later.slice(0, 10)}\\)\\.`));
      assert.doesNotMatch(result.stdout, /sign in again to replace it/);

      // In the last day the date moves to the warning instead.
      const soon = new Date(Date.now() + 3_600_000).toISOString();
      await record(soon);
      result = await runCli(["login"], { home, env: gatewayEnv });
      assert.match(result.stdout, new RegExp(`Already signed in as ${EMAIL}\\.`));
      assert.match(result.stdout, new RegExp(`This machine's API key expires on ${soon.slice(0, 10)}: sign in again to replace it\\.`));

      // A record for another key says nothing about this one.
      await record(later, "fw_some_other_key_000000000000000");
      result = await runCli(["login"], { home, env: gatewayEnv });
      assert.doesNotMatch(result.stdout, /key expires/);
    });
  });

  it("login --account is an explicit re-auth: it runs even when already signed in", async () => {
    await withTempHome("login-account-signedin-", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await seedKeychainConfig(home, VALID_KEY);
      const grpc = await startMockGrpcGateway({ status: 7 });
      try {
        const result = await runCli(["login", "--account", "bogus"], {
          home,
          env: { ...gatewayEnv, NEXUS_GATEWAY_GRPC_WEB_URL: grpc.url },
        });
        // It attempted the SSO flow (and failed on the bogus account) rather
        // than short-circuiting on the stored key.
        assert.doesNotMatch(result.stdout, /Already signed in/);
        assert.match(result.stderr, /Couldn't find SSO sign-in configuration/);
      } finally {
        grpc.server.close();
      }
    });
  });

  it("login without a TTY points at --with-token instead of hanging", async () => {
    await withTempHome("login-no-tty-", async (home) => {
      const result = await runCli(["login"], { home, env: gatewayEnv });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /--with-token/);
      assert.doesNotMatch(result.stderr, /Error:/);
    });
  });

  it("logout clears stored credentials and confirms", async () => {
    await withTempHome("logout-", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await seedKeychainConfig(home, VALID_KEY);

      const result = await runCli(["logout"], { home });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Logged out/);

      const exported = await runCli(["key", "export"], { home });
      assert.notEqual(exported.code, 0);

      const check = await runCli(["status"], { home, env: gatewayEnv });
      assert.equal(check.code, 1);
    });
  });

  it("logout of a key this machine has no record of creating says it stays active on Fireworks, at a terminal and in --json", async () => {
    const line = /This API key was only removed from this machine \(this machine has no record of creating it\), so it stays active on Fireworks\. Revoke it at https:\/\/\S+api-keys if you no longer need it\./;
    await withTempHome("logout-local-only-", async (home) => {
      const stored = await runCliWithStdin(["login", "--with-token"], { home, env: gatewayEnv, input: VALID_KEY });
      assert.equal(stored.code, 0, stored.stderr);
      const result = await runCli(["logout"], { home });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      // Said before the removal, so it doesn't claim the key was removed yet.
      assert.match(result.stdout, /This machine has no record of creating this API key, so logging out only removes it from this machine and it stays active on Fireworks\. Revoke it at https:\/\/\S+api-keys if you no longer need it\./);
      assert.doesNotMatch(result.stdout, /was only removed/);
      assert.match(result.stdout, /Logged out/);
    });
    await withTempHome("logout-local-only-json-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      const result = await runCli(["logout", "--json"], { home });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.deepEqual({ ...parsed, warnings: parsed.warnings.length }, { type: "result", ok: true, keyDeleted: false, warnings: 1 });
      assert.match(parsed.warnings[0], line);
      assert.doesNotMatch(parsed.warnings[0], /\u001b/, "a plain URL, no terminal escapes");
      // Nothing stored any more: nothing to warn about.
      assert.deepEqual(JSON.parse((await runCli(["logout", "--json"], { home })).stdout).warnings, []);
    });
  });

  it("logout says connected harnesses keep their copy of the key", async () => {
    await withTempHome("logout-baked-", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await seedKeychainConfig(home, VALID_KEY);
      const { writeGlobalConfig } = await import("../../lib/config/global-config.mjs");
      await writeGlobalConfig(home, { harnesses: { opencode: { enabled: true }, pi: { enabled: true, provider: "azure" } } });

      const result = await runCli(["logout"], { home });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /OpenCode still has a copy of the key in its settings/);
      assert.match(result.stdout, /nexus opencode off/);
      assert.doesNotMatch(result.stdout, /nexus pi off/);
    });
  });

  it("logout clears provider keys even without a stored Fireworks key", async () => {
    await withTempHome("logout-provider-only-", async (home) => {
      await writeGlobalConfig(home, {
        anthropicApiKey: "sk-ant-example-logout-0000",
        openaiApiKey: "sk-example-logout-0000",
      });
      const result = await runCli(["logout"], { home });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Logged out/);
      const config = await readGlobalConfig(home);
      assert.equal(config.anthropicApiKey, "");
      assert.equal(config.openaiApiKey, "");
    });
  });

  it("logout also clears saved Anthropic and OpenAI provider keys", async () => {
    await withTempHome("logout-provider-keys-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      await writeGlobalConfig(home, {
        anthropicApiKey: "sk-ant-example-logout-0000",
        openaiApiKey: "sk-example-logout-0000",
      });

      const result = await runCli(["logout"], { home });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Logged out/);

      const config = await readGlobalConfig(home);
      assert.equal(config.anthropicApiKey, "");
      assert.equal(config.openaiApiKey, "");
    });
  });

  it("configure --unset openai-api-key clears only the saved OpenAI key and leaves harness files it has no key in alone", async () => {
    await withTempHome("logout-openai-", async (home) => {
      await seedKeychainConfig(home, VALID_KEY);
      await writeGlobalConfig(home, {
        openaiApiKey: "sk-example-0000",
        harnesses: { opencode: { enabled: true, provider: "fireworks" }, cursor: { enabled: true, provider: "fireworks" } },
      });

      const result = await runCli(["configure", "--unset", "openai-api-key"], { home, env: { OPENAI_API_KEY: "" } });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Removed the saved OpenAI key/);
      assert.doesNotMatch(result.stdout, /Removed the saved OpenAI key from|Couldn't update/);
      assert.equal((await readGlobalConfig(home)).openaiApiKey, "");

      const fireworks = await runCli(["key", "export"], { home });
      assert.equal(fireworks.code, 0, fireworks.stderr);
      assert.equal(fireworks.stdout, VALID_KEY);
    });
  });

  it("configure --unset openai-api-key still finishes when a harness's settings can't be read, and says how to fix it", async () => {
    await withTempHome("logout-openai-bad-json-", async (home) => {
      await writeGlobalConfig(home, {
        openaiApiKey: "sk-example-0000",
        harnesses: { opencode: { enabled: true, provider: "fireworks" } },
      });
      const configPath = path.join(home, ".config/opencode/opencode.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, "{ not json");

      const result = await runCli(["configure", "--unset", "openai-api-key"], { home, env: { OPENAI_API_KEY: "" } });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Removed the saved OpenAI key\./);
      assert.match(result.stdout, /Couldn't update OpenCode's settings\. Run nexus opencode off/);
      assert.equal(await readFile(configPath, "utf8"), "{ not json");
    });
  });

  it("configure --unset anthropic-api-key leaves an env-reference setting alone", async () => {
    await withTempHome("logout-anthropic-ref-", async (home) => {
      await writeGlobalConfig(home, { anthropicApiKey: "{env:ANTHROPIC_API_KEY}" });
      const result = await runCli(["configure", "--unset", "anthropic-api-key"], { home, env: { ANTHROPIC_API_KEY: "" } });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /No saved Anthropic key to remove/);
      assert.equal((await readGlobalConfig(home)).anthropicApiKey, "{env:ANTHROPIC_API_KEY}");
    });
  });

  it("logout --revoke without a TTY never deletes the key with itself: a Platform key needs a terminal sign-in, so everything is kept", async () => {
    const grpc = await startMockGrpcGateway();
    try {
      await withTempHome("logout-revoke-", async (home) => {
        // Store first, then record the mint — the browser flow's order
        // (storing a key clears any previous machine's minted-key record).
        await seedKeychainConfig(home, VALID_KEY);
        await seedMintedState(home);

        const result = await runCli(["logout", "--revoke"], {
          home,
          env: { NEXUS_GATEWAY_GRPC_WEB_URL: grpc.url, FIREWORKS_API_KEY: REJECTED_KEY },
        });
        assert.notEqual(result.code, 0);
        assert.doesNotMatch(result.stdout, /Logged out/);
        assert.match(result.stderr, /browser sign-in needs a terminal.*Your stored key and revoke record were kept.*revoke it at .*api-keys/i);
        assert.equal(grpc.calls.length, 0, "no API key ever deletes a key");
        await assert.doesNotReject(access(path.join(home, ".nexus", "minted-key.json")));

        const check = await runCli(["status"], { home, env: gatewayEnv });
        assert.equal(check.code, 0); // local credentials remain for retry
      });
    } finally {
      grpc.server.close();
    }
  });

  it("logout --json without a terminal can't sign in for a Platform key: logged out, keyDeleted false, a warning, one result line", async () => {
    const grpc = await startMockGrpcGateway();
    try {
      await withTempHome("logout-json-", async (home) => {
        await seedKeychainConfig(home, VALID_KEY);
        await seedMintedState(home);
        const result = await runCli(["logout", "--json"], { home, env: { NEXUS_GATEWAY_GRPC_WEB_URL: grpc.url } });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        const line = JSON.parse(result.stdout);
        assert.deepEqual({ ...line, warnings: line.warnings.length }, { type: "result", ok: true, keyDeleted: false, warnings: 1 });
        // Says the key stays active, and why: not a generic "couldn't delete".
        assert.match(line.warnings[0], /stays active until you revoke it \(revoking a Fireworks Platform or company SSO key needs a browser sign-in from a terminal: run nexus logout --revoke in a terminal\) at \S+api-keys/);
        assert.match(result.stderr, /Logged out/);
        assert.equal(grpc.calls.length, 0, "no API key ever deletes a key");
        await assert.rejects(access(path.join(home, ".nexus", "minted-key.json")));

        const again = await runCli(["logout", "--json"], { home });
        assert.equal(again.code, 0);
        assert.deepEqual(JSON.parse(again.stdout), { type: "result", ok: true, keyDeleted: false, warnings: [] });
      });
    } finally {
      grpc.server.close();
    }
  });

  it("a Platform key's revoke uses the sign-in token at a terminal, never the key; a Nexus key's goes to the web app", async () => {
    const { revokeThisMachinesKey } = await import("../../lib/cli/commands/login.mjs");
    const minted = { keyId: MINTED_STATE.keyId, userName: MINTED_STATE.userName };
    const deletes = [];
    const platform = await revokeThisMachinesKey({ minted, config: { accountType: "platform", ssoAccountId: "" }, ctx: {}, tty: true }, {
      signIn: async () => ({ ok: true, idToken: "example-sign-in-token" }),
      revoke: async (args) => { deletes.push(args); return { ok: true, failure: "" }; },
      webRevoke: async () => assert.fail("a Platform key isn't revoked through the web app"),
    });
    assert.equal(platform.ok, true);
    assert.deepEqual(deletes, [{ idToken: "example-sign-in-token", keyId: "key-123", userName: MINTED_STATE.userName }]);

    const web = [];
    const nexus = await revokeThisMachinesKey({ minted, config: { accountType: "nexus" }, ctx: { pasteCode: "" }, tty: false }, {
      version: async () => 3,
      signIn: async () => assert.fail("no Cognito sign-in for a Nexus key"),
      webRevoke: async (args) => { web.push(args); return { ok: true, failure: "", error: "", fatal: false }; },
    });
    assert.equal(nexus.ok, true);
    assert.deepEqual(web.map(({ keyId, accountHint, interactive }) => ({ keyId, accountHint, interactive })), [{ keyId: "key-123", accountHint: "acct-test", interactive: false }]);

    const old = await revokeThisMachinesKey({ minted, config: { accountType: "nexus" }, ctx: {}, tty: true }, {
      version: async () => 2, webRevoke: async () => assert.fail("version 2 has no revoke"),
    });
    assert.deepEqual(old, { ok: false, failure: "the web app can't revoke keys for Nexus yet (run nexus update later)" });
  });

  it("logout without a TTY or --revoke leaves the minted key alone and says so", async () => {
    const grpc = await startMockGrpcGateway();
    try {
      await withTempHome("logout-keep-", async (home) => {
        await seedKeychainConfig(home, VALID_KEY);
        await seedMintedState(home);

        const result = await runCli(["logout"], {
          home,
          env: { NEXUS_GATEWAY_GRPC_WEB_URL: grpc.url },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /Logged out/);
        assert.match(result.stdout, /Left .*fireconnect-testhost.* active/);
        assert.match(result.stdout, /api-keys/);
        assert.equal(grpc.calls.length, 0, "must not revoke without consent");
      });
    } finally {
      grpc.server.close();
    }
  });

  it("storing a different key invalidates the minted-key record", async () => {
    const grpc = await startMockGrpcGateway();
    try {
      await withTempHome("logout-stale-mint-", async (home) => {
        // Browser sign-in minted a key on this machine…
        await seedMintedState(home);
        // …then the user stored a different key (paste / --api-key / key set).
        await seedKeychainConfig(home, VALID_KEY);

        // logout must not describe or try to revoke the old minted key on
        // behalf of a credential it no longer holds.
        const result = await runCli(["logout", "--revoke"], {
          home,
          env: { NEXUS_GATEWAY_GRPC_WEB_URL: grpc.url },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /Logged out/);
        assert.doesNotMatch(result.stdout, /fireconnect-testhost/);
        assert.equal(grpc.calls.length, 0, "no revocation for a key another credential minted");
        await assert.rejects(access(path.join(home, ".nexus", "minted-key.json")));
      });
    } finally {
      grpc.server.close();
    }
  });

  it("re-storing the same minted key keeps the revoke record", async () => {
    const grpc = await startMockGrpcGateway();
    try {
      await withTempHome("logout-same-key-mint-", async (home) => {
        // Browser sign-in minted VALID_KEY and recorded the mint.
        await seedKeychainConfig(home, VALID_KEY);
        await seedMintedState(home);

        // An idempotent re-store of the SAME key (config repair, a repeated
        // sign-in) must NOT wipe minted-key.json — the key is still the one
        // this machine minted and should stay revocable.
        await seedKeychainConfig(home, VALID_KEY);
        await assert.doesNotReject(access(path.join(home, ".nexus", "minted-key.json")));

        const result = await runCli(["logout"], {
          home,
          env: { NEXUS_GATEWAY_GRPC_WEB_URL: grpc.url },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /Left .*fireconnect-testhost.* active/, "the record survived, so logout still knows the key");
        assert.equal(grpc.calls.length, 0);
      });
    } finally {
      grpc.server.close();
    }
  });

  it("logout points a Nexus account at the Nexus keys page, then forgets the account kind", async () => {
    const grpc = await startMockGrpcGateway();
    try {
      await withTempHome("logout-nexus-", async (home) => {
        await seedKeychainConfig(home, VALID_KEY);
        await seedMintedState(home);
        const configPath = path.join(home, ".nexus", "config.json");
        const config = JSON.parse(await readFile(configPath, "utf8"));
        await writeFile(configPath, JSON.stringify({ ...config, nexusAccount: true }));

        const result = await runCli(["logout"], {
          home,
          env: { NEXUS_GATEWAY_GRPC_WEB_URL: grpc.url },
        });
        assert.equal(result.code, 0, `stderr: ${result.stderr}`);
        assert.match(result.stdout, /nexus\.fireworks\.ai\/settings\/api-keys/);
        assert.doesNotMatch(result.stdout, /app\.fireworks\.ai/);
        assert.equal(JSON.parse(await readFile(configPath, "utf8")).nexusAccount, false);
      });
    } finally {
      grpc.server.close();
    }
  });

  it("logout with nothing stored says so and exits 0", async () => {
    await withTempHome("logout-none-", async (home) => {
      const result = await runCli(["logout"], { home });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Not signed in/);
    });
  });

  it("logout with no stored key notes an enabled Fireworks harness keeps its copy", async () => {
    await withTempHome("logout-none-baked-", async (home) => {
      const { writeGlobalConfig } = await import("../../lib/config/global-config.mjs");
      await writeGlobalConfig(home, {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });

      const result = await runCli(["logout"], { home });
      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Claude Code still has a copy of the key in/);
      assert.match(result.stdout, /nexus claude off/);
    });
  });

  it("logout notes a lingering FIREWORKS_API_KEY env var", async () => {
    await withTempHome("logout-env-note-", async (home) => {
      const result = await runCli(["logout"], { home, env: { FIREWORKS_API_KEY: VALID_KEY } });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /FIREWORKS_API_KEY is still set/);
    });
  });

  function parseMethod(stdout) {
    const marker = stdout.lastIndexOf("RESULT:");
    assert.notEqual(marker, -1, stdout);
    return JSON.parse(stdout.slice(marker + "RESULT:".length));
  }

  describe("remembered SSO account", () => {
    function runSignIn(home, input, env = {}) {
      const flowsPath = path.join(__dirname, "../../lib/auth/login/flows.mjs");
      const script = `
        import { runInteractiveSignIn } from ${JSON.stringify(flowsPath)};
        const ok = await runInteractiveSignIn(${JSON.stringify(home)});
        process.stdout.write("RESULT:" + JSON.stringify(ok));
      `;
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, HOME: home, NEXUS_TEST: "1", ...env },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(input);
      });
    }

    it("asks the account kind right away when no SSO account is remembered", async () => {
      await withTempHome("sso-remembered-none-", async (home) => {
        const result = await runSignIn(home, "q\n");
        assert.doesNotMatch(result.stdout, /company SSO\. Use it again\?/);
        assert.match(result.stdout, /Which account do you use\?/);
        assert.equal(parseMethod(result.stdout), false);
      });
    });

    it("offers the remembered SSO account first and falls back to the account kind on n", async () => {
      await withTempHome("sso-remembered-decline-", async (home) => {
        await writeGlobalConfig(home, { ssoAccountId: "example-account" });
        const result = await runSignIn(home, "n\nq\n");
        const sso = result.stdout.indexOf("example-account's company SSO. Use it again?");
        const kind = result.stdout.indexOf("Which account do you use?");
        assert.notEqual(sso, -1, result.stdout);
        assert.notEqual(kind, -1, result.stdout);
        assert.ok(sso < kind, "SSO offer comes before the account kind prompt");
        assert.equal(parseMethod(result.stdout), false);
      });
    });

    it("cancels when input closes at the SSO offer instead of asking the account kind", async () => {
      await withTempHome("sso-remembered-eof-", async (home) => {
        await writeGlobalConfig(home, { ssoAccountId: "example-account" });
        const result = await runSignIn(home, "");
        assert.match(result.stdout, /example-account's company SSO\. Use it again\?/);
        assert.doesNotMatch(result.stdout, /Which account do you use\?/);
        assert.match(result.stderr, /Sign-in cancelled/);
        assert.equal(parseMethod(result.stdout), false);
      });
    });

    it("goes straight to the remembered account's SSO sign-in on Enter", async () => {
      await withTempHome("sso-remembered-accept-", async (home) => {
        await writeGlobalConfig(home, { ssoAccountId: "example-account" });
        const result = await runSignIn(home, "\n", { NEXUS_GATEWAY_GRPC_WEB_URL: "http://127.0.0.1:9" });
        assert.match(result.stdout, /example-account's company SSO\. Use it again\?/);
        assert.doesNotMatch(result.stdout, /Which account do you use\?/);
        assert.match(result.stdout + result.stderr, /Fireworks API|Couldn't/i);
        assert.equal(parseMethod(result.stdout), false);
      });
    });
  });

  describe("promptAccountKind", () => {
    function runKindPrompt(input) {
      const promptsPath = path.join(__dirname, "../../lib/auth/login/prompts.mjs");
      const script = `
        import { promptAccountKind } from ${JSON.stringify(promptsPath)};
        const kind = await promptAccountKind();
        process.stdout.write("RESULT:" + JSON.stringify(kind));
      `;
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(input);
      });
    }

    it("offers Nexus and Platform accounts, defaulting to Nexus on Enter", async () => {
      const result = await runKindPrompt("\n");
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Nexus account: Pro, Team, or Enterprise plan at nexus\.fireworks\.ai/);
      assert.match(result.stdout, /Fireworks Platform account: app\.fireworks\.ai/);
      assert.doesNotMatch(result.stdout, /pay-as-you-go|subscription/);
      assert.match(result.stdout, /nexus logout/);
      assert.match(result.stdout, /Company SSO\? Press q, then run nexus login --account <account-id>\./);
      assert.equal(parseMethod(result.stdout), "nexus");
    });

    it("returns platform for choice 2", async () => {
      const result = await runKindPrompt("2\n");
      assert.equal(parseMethod(result.stdout), "platform");
    });

    it("re-asks on invalid input; q and EOF cancel", async () => {
      const reasked = await runKindPrompt("3\nq\n");
      assert.match(reasked.stdout, /Please enter 1 or 2/);
      assert.equal(parseMethod(reasked.stdout), null);
      assert.equal(parseMethod((await runKindPrompt("")).stdout), null);
    });
  });

  describe("accountsForKind", () => {
    const listed = {
      accountNames: ["accounts/example-nexus", "accounts/example-platform", "accounts/example-other"],
      nexusAccountNames: ["accounts/example-nexus"],
    };

    it("narrows the sign-in's accounts to the kind picked", () => {
      assert.deepEqual(accountsForKind(listed, "nexus"), { accountNames: ["accounts/example-nexus"], failure: "" });
      assert.deepEqual(accountsForKind(listed, "platform"), {
        accountNames: ["accounts/example-platform", "accounts/example-other"],
        failure: "",
      });
    });

    it("keeps every account without a kind", () => {
      assert.deepEqual(accountsForKind(listed, undefined), { accountNames: listed.accountNames, failure: "" });
    });

    it("stops, and says where to go, when no account is of the kind picked", () => {
      const platformOnly = { accountNames: ["accounts/example-platform"], nexusAccountNames: [] };
      const nexus = accountsForKind(platformOnly, "nexus");
      assert.deepEqual(nexus.accountNames, []);
      assert.match(nexus.failure, /No Nexus account is linked to this sign-in/);
      assert.match(nexus.failure, /nexus\.fireworks\.ai\/signup/);
      assert.match(nexus.failure, /pick 2/);

      const nexusOnly = { accountNames: ["accounts/example-nexus"], nexusAccountNames: ["accounts/example-nexus"] };
      const platform = accountsForKind(nexusOnly, "platform");
      assert.deepEqual(platform.accountNames, []);
      assert.match(platform.failure, /No Fireworks Platform account is linked/);
      assert.match(platform.failure, /pick 1/);
    });

    it("has no failure when the sign-in has no accounts at all", () => {
      assert.deepEqual(accountsForKind({ accountNames: [], nexusAccountNames: [] }, "nexus"), { accountNames: [], failure: "" });
    });
  });

  describe("promptAccountChoice", () => {
    // When browser sign-in resolves to several accounts, the user must pick
    // which one the key belongs to — same TTY-only subprocess pattern as
    // promptAccountKind.
    function runAccountPrompt(accountNames, input) {
      const loginPath = path.join(__dirname, "../../lib/cli/commands/login.mjs");
      const script = `
        import { promptAccountChoice } from ${JSON.stringify(loginPath)};
        const idx = await promptAccountChoice(${JSON.stringify(accountNames)});
        process.stdout.write("RESULT:" + JSON.stringify(idx));
      `;
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(input);
      });
    }

    const accounts = ["accounts/acme", "accounts/personal"];

    it("lists the accounts and defaults to the first on Enter", async () => {
      const result = await runAccountPrompt(accounts, "\n");
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /more than one Fireworks account/);
      assert.match(result.stdout, /acme/);
      assert.match(result.stdout, /personal/);
      assert.equal(parseMethod(result.stdout), 0);
    });

    it("returns the chosen index for a number", async () => {
      const result = await runAccountPrompt(accounts, "2\n");
      assert.equal(result.code, 0, result.stderr);
      assert.equal(parseMethod(result.stdout), 1);
    });

    it("re-asks on invalid input, and q cancels", async () => {
      const result = await runAccountPrompt(accounts, "banana\nq\n");
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Enter 1 to 2, or q to cancel/);
      assert.equal(parseMethod(result.stdout), null);
    });
  });

  describe("promptYesNo", () => {
    function runYesNo(input, runYesNoOptions = "{}") {
      const loginPath = path.join(__dirname, "../../lib/cli/commands/login.mjs");
      const script = `
        import { promptYesNo } from ${JSON.stringify(loginPath)};
        const answer = await promptYesNo("Proceed?", ${runYesNoOptions});
        process.stdout.write("RESULT:" + JSON.stringify(answer));
      `;
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout }));
        child.stdin.end(input);
      });
    }

    it("Enter means yes", async () => {
      const result = await runYesNo("\n");
      assert.equal(parseMethod(result.stdout), true);
    });

    it("n means no; invalid input re-asks; EOF is null so callers can tell it from n", async () => {
      assert.equal(parseMethod((await runYesNo("n\n")).stdout), false);
      const reasked = await runYesNo("maybe\nyes\n");
      assert.match(reasked.stdout, /Enter y or n/);
      assert.equal(parseMethod(reasked.stdout), true);
      assert.equal(parseMethod((await runYesNo("")).stdout), null);
    });

    it("defaultYes:false flips the prompt and the Enter default (rotation prompt)", async () => {
      const entered = await runYesNo("\n", '{ "defaultYes": false }');
      assert.match(entered.stdout, /\[y\/N\]/);
      assert.equal(parseMethod(entered.stdout), false);
      assert.equal(parseMethod((await runYesNo("y\n", '{ "defaultYes": false }')).stdout), true);
    });
  });

  it("login refuses --paste, and --with-token / --api-key at a terminal (headless only)", async () => {
    const { loginFlagConflict } = await import("../../lib/cli/commands/login.mjs");
    assert.match(loginFlagConflict({ paste: true }, { tty: true }), /--paste/);
    assert.match(loginFlagConflict({ withToken: true }, { tty: true }), /at a terminal, sign in through your browser/);
    // Without a terminal (this test's child processes) --with-token still signs in: see above.
    await withTempHome("login-paste-refused-", async (home) => {
      const result = await runCli(["login", "--paste"], { home, env: gatewayEnv });
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /--paste: pasting an API key at a terminal isn't supported/);
    });
  });

  it("help lists login and logout", async () => {
    await withTempHome("login-help-", async (home) => {
      const help = await runCli(["help"], { home });
      assert.match(help.stdout, /login\s+Sign in to Fireworks/);
      assert.match(help.stdout, /logout\s+Clear stored credentials/);

      const topic = await runCli(["help", "login"], { home });
      assert.match(topic.stdout, /--with-token/);
      assert.match(topic.stdout, /--account/);
      assert.match(topic.stdout, /--force/);
      assert.doesNotMatch(topic.stdout, /--paste(?![-\w])/, "pasting a key at a terminal is gone");
      assert.match(topic.stdout, /Without a terminal only/);

      const logoutTopic = await runCli(["help", "logout"], { home });
      assert.match(logoutTopic.stdout, /--revoke\s+Revoke this machine's key without prompting/);
      assert.match(logoutTopic.stdout, /--json/);
    });
  });
});

describe("signedInIdentityLine", () => {
  it("names the returned email and account before a key is created", () => {
    assert.equal(
      signedInIdentityLine("user@example.com", "accounts/example-account"),
      "Signed in as user@example.com. Creating an API key in account example-account.",
    );
    assert.match(signedInIdentityLine("", "accounts/example-account"), /no email/);
    assert.doesNotMatch(signedInIdentityLine("a\u001b[2Jb@example.com", "accounts/x"), /\u001b/);
  });
});


describe("desktop plaintext-token account metadata", () => {
  let gateway;
  before(async () => { gateway = await startMockGateway(); });
  after(() => gateway.server.close());

  it("applies Nexus, explicit Platform, unknown and omitted metadata on repeated saves", async () => {
    await withTempHome("login-account-kind-", async (home) => {
      await writeGlobalConfig(home, { ssoAccountId: "keep-me" });
      for (const kind of ["nexus", "platform", "nexus", "unknown", "nexus", null]) {
        const result = await runCliWithStdin(["login", "--with-token", ...(kind ? ["--account-type", kind] : [])], {
          home, env: { NEXUS_GATEWAY_URL: gateway.url }, input: `${VALID_KEY}\n`,
        });
        assert.equal(result.code, 0, result.stderr);
        const config = await readGlobalConfig(home);
        assert.equal(config.nexusAccount, kind === "nexus");
        assert.equal(config.accountType, kind ?? "unknown");
        assert.equal(config.ssoAccountId, "keep-me");
        assert.ok(!(result.stdout + result.stderr).includes(VALID_KEY));
      }
    });
  });

  it("does not reclassify the previous credential after verification rejects a replacement", async () => {
    await withTempHome("login-account-kind-rejected-", async (home) => {
      await writeGlobalConfig(home, { accountType: "nexus" });
      const result = await runCliWithStdin(["login", "--with-token", "--account-type", "platform"], {
        home, env: { NEXUS_GATEWAY_URL: gateway.url }, input: REJECTED_KEY,
      });
      assert.notEqual(result.code, 0);
      assert.equal((await readGlobalConfig(home)).nexusAccount, true);
    });
  });

  it("logout clears stale account metadata even without a stored credential", async () => {
    await withTempHome("logout-stale-kind-", async (home) => {
      await writeGlobalConfig(home, { accountType: "nexus" });
      const result = await runCli(["logout"], { home });
      assert.equal(result.code, 0, result.stderr);
      assert.equal((await readGlobalConfig(home)).nexusAccount, false);
      assert.equal((await readGlobalConfig(home)).accountType, "unknown");
    });
  });
});
