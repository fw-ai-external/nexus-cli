import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";

const SECRET_STORE = new URL("../../lib/keys/secret-store.mjs", import.meta.url).href;
const NEXUS_BIN = new URL("../../bin/nexus.mjs", import.meta.url).pathname;
const FAKE_KEYCHAIN = new URL("./fixtures/fake-cross-keychain.mjs", import.meta.url).href;
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const NO_NATIVE = `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(new URL("./fixtures/no-native-keyring.mjs", import.meta.url).href)});`;
const FAIL_FILE_WRITES = `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(new URL("./fixtures/fail-file-writes.mjs", import.meta.url).href)});`;
const USE_FAKE = `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(FAKE_KEYCHAIN)});`;

/**
 * One command on a Linux machine with a keychain (the fake). `ssh` runs it
 * as an SSH session on the same machine. `code` starting with "nexus " runs
 * the CLI; anything else runs against the secret store.
 */
function run(home, keychain, code, { ssh = false, real = false, failFileWrites = false, extraEnv = {} } = {}) {
  const env = { ...process.env, HOME: home, FAKE_KEYCHAIN: keychain };
  for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "NEXUS_KEY_STORAGE", "NEXUS_SECRET_STORE", "NEXUS_TEST", "SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT", "KEYRING_FILE_MASTER_KEY", "TS_KEYRING_BACKEND"]) {
    delete env[key];
  }
  // Stripping NEXUS_TEST would otherwise let each CLI run start the detached
  // update checker, which fetches from GitHub and writes under .nexus after
  // the run ends: keep the specs offline and their cleanup race-free.
  env.NEXUS_NO_UPDATE_CHECK = "1";
  if (ssh) env.SSH_CONNECTION = "192.0.2.1 50000 192.0.2.2 22";
  // `real`: the real cross-keychain, with the fixture secret-tool as the keychain.
  if (real) env.PATH = `${FIXTURES}${path.delimiter}${env.PATH}`;
  Object.assign(env, extraEnv);
  const args = code.startsWith("nexus ")
    ? [NEXUS_BIN, ...code.slice("nexus ".length).split(" ")]
    : ["--input-type=module", "-e", `const s = await import(${JSON.stringify(SECRET_STORE)}); const home = process.env.HOME; ${code}`];
  return spawnSync(process.execPath, ["--import", real ? NO_NATIVE : USE_FAKE, ...(failFileWrites ? ["--import", FAIL_FILE_WRITES] : []), ...args], { env, encoding: "utf8", timeout: 30_000, input: "" });
}

function ok(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const save = (home, key, opts) => ok(run(home, "working", `await s.setSecret(${JSON.stringify(key)}, home);`, opts));
const readKey = (home, opts) => ok(run(home, "working", "console.log(String(await s.getSecret(home)));", opts));
const keychainCopy = (home) => {
  try {
    return JSON.parse(readFileSync(path.join(home, "fake-keychain.json"), "utf8"))["FireworksAI/fireworks-api-key"] ?? null;
  } catch {
    return null;
  }
};

const fileStoreDir = (home) => {
  const found = readdirSync(home, { recursive: true }).find((p) => String(p).endsWith("secrets.json"));
  assert.ok(found, "encrypted file store not found");
  return path.dirname(path.join(home, String(found)));
};

async function withHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "nexus-stale-key-"));
  try {
    await fn(home);
  } finally {
    // A second guard behind NEXUS_NO_UPDATE_CHECK: if anything still writes
    // under .nexus as the test ends, a file may vanish mid-sweep and the
    // delete may meet a directory that just gained an entry (ENOTEMPTY), so
    // skip vanished files and retry the delete.
    for (const p of readdirSync(home, { recursive: true })) {
      try {
        chmodSync(path.join(home, String(p)), 0o700);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// The secret store picks its backend from the platform, so this Linux story
// only runs on Linux (CI); elsewhere it would exercise another backend.
describe("keys saved at a Linux desktop and over SSH", { skip: process.platform !== "linux" && "Linux secret store only" }, () => {
  it("a desktop sign-in after an SSH one writes the same encrypted file", () => withHome((home) => {
    save(home, "fw_one", { ssh: true });
    save(home, "fw_two");
    assert.equal(readKey(home, { ssh: true }), "fw_two");
    assert.equal(readKey(home), "fw_two");
  }));

  it("moving the desktop to the file deletes its keychain copy", () => withHome((home) => {
    save(home, "fw_one");
    assert.notEqual(keychainCopy(home), null);
    save(home, "fw_two", { ssh: true });
    save(home, "fw_three");
    assert.equal(keychainCopy(home), null);
    assert.equal(readKey(home), "fw_three");
  }));

  it("a bad file master key with no file keeps the desktop on its keychain", () => withHome((home) => {
    const opts = { extraEnv: { KEYRING_FILE_MASTER_KEY: "not-hex" } };
    save(home, "fw_one", opts);
    assert.equal(keychainCopy(home), "fw_one");
    assert.equal(readKey(home, opts), "fw_one");
  }));

  it("logout over SSH fails when a desktop keychain copy may be left", () => withHome((home) => {
    save(home, "fw_one");
    save(home, "fw_two", { ssh: true });
    const result = run(home, "working", "nexus logout", { ssh: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /couldn't be removed from here/);
  }));

  it("logout with the keychain locked fails instead of reporting success", () => withHome((home) => {
    save(home, "fw_one");
    const result = run(home, "broken", "nexus logout");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /couldn't be removed from here/);
  }));

  it("the move to the file deletes the real keychain item, not the file", () => withHome((home) => {
    const opts = { real: true };
    save(home, "fw_one", opts);
    assert.ok(existsSync(path.join(home, "fake-secret-tool")) && readdirSync(path.join(home, "fake-secret-tool")).length === 1);
    save(home, "fw_two", { ...opts, ssh: true });
    save(home, "fw_three", opts);
    assert.equal(readdirSync(path.join(home, "fake-secret-tool")).length, 0);
    assert.equal(readKey(home, opts), "fw_three");
  }));

  it("a desktop read never falls back to the keychain when the file can't be read", () => withHome((home) => {
    save(home, "fw_one");
    save(home, "fw_two", { ssh: true });
    const dir = fileStoreDir(home);
    chmodSync(dir, 0o000);
    rmSync(path.join(home, ".nexus", "key-storage.json"), { force: true });
    try {
      const result = run(home, "working", "console.log(String(await s.getSecret(home)));");
      assert.doesNotMatch(result.stdout, /fw_one/);
    } finally {
      chmodSync(dir, 0o700);
    }
  }));

  it("logout fails when the encrypted file can't be updated", () => withHome((home) => {
    const extraEnv = { NEXUS_KEY_STORAGE: "file", KEYRING_FILE_MASTER_KEY: "c".repeat(64) };
    save(home, "fw_one", { extraEnv });
    const result = run(home, "working", "nexus logout", { extraEnv, failFileWrites: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /couldn't be removed from here/);
  }));

  it("logout at the desktop removes every copy", () => withHome((home) => {
    save(home, "fw_one");
    save(home, "fw_two", { ssh: true });
    ok(run(home, "working", "nexus logout"));
    assert.equal(keychainCopy(home), null);
    assert.equal(readKey(home), "null");
    assert.equal(readKey(home, { ssh: true }), "null");
  }));
});
