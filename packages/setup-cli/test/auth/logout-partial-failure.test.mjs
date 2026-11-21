import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { withTempHome } from "../helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "../../bin/nexus.mjs");
const API_KEY_MODULE = path.join(__dirname, "../../lib/keys/api-key.mjs");

/** Real encrypted-file key storage under `home`, never the OS keychain. */
function fileStoreEnv(home, extra = {}) {
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    NEXUS_KEY_STORAGE: "file",
    KEYRING_FILE_MASTER_KEY: "a".repeat(64),
    NEXUS_TEST: "1",
    FIREWORKS_API_KEY: "",
    ...extra,
  };
  delete env.NEXUS_SECRET_STORE;
  return env;
}

/** Fireworks API mock that refuses every DeleteApiKey. */
function startRefusingGrpcGateway() {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const trailer = Buffer.from("grpc-status:7\r\ngrpc-message:permission denied\r\n");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(trailer.length);
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      res.end(Buffer.concat([Buffer.from([0, 0, 0, 0, 0]), Buffer.from([0x80]), len, trailer]));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/web/gateway.Gateway` });
    });
  });
}

function runLogout(env, args = ["logout", "--revoke"]) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("logout when removing the stored key fails", () => {
  it("still says the minted key wasn't revoked and where to revoke it", async () => {
    const grpc = await startRefusingGrpcGateway();
    try {
      await withTempHome("logout-delete-fails", async (home) => {
        const seed = spawnSync(process.execPath, ["--input-type=module", "-e",
          `const m = await import(${JSON.stringify(API_KEY_MODULE)}); await m.persistApiKeyToKeychain(process.env.HOME, "fw_logout_test_key_0000000000000");`,
        ], { env: fileStoreEnv(home), encoding: "utf8", timeout: 30_000 });
        assert.equal(seed.status, 0, seed.stderr);
        await writeFile(path.join(home, ".nexus", "minted-key.json"), JSON.stringify({
          keyId: "key-123",
          userName: "accounts/example-account/users/u-1",
          displayName: "nexus-testhost",
        }));
        // A directory where the plaintext fallback key goes makes deleteSecret throw.
        await mkdir(path.join(home, ".nexus", ".api-key", "x"), { recursive: true });

        const env = fileStoreEnv(home, { NEXUS_GATEWAY_GRPC_WEB_URL: grpc.url });
        const first = await runLogout(env, ["logout"]);
        const shown = first.stdout + first.stderr;
        assert.notEqual(first.code, 0, shown);
        assert.match(shown, /EISDIR|EPERM/);
        assert.match(shown, /nexus-testhost.*revoke it.*at/i);
        assert.match(shown, /api-keys/);
      });
    } finally {
      grpc.server.close();
    }
  });
});
