import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  KEY_STORE_UNDECRYPTABLE,
  KeyStoreUndecryptableError,
  builtinGetPassword,
  builtinSetPassword,
  secretsFilePath,
} from "../../lib/keys/builtin-file-secret-store.mjs";
import {
  KEY_STORAGE_ENV,
  getLastSecretReadError,
  getSecret,
  hasSecret,
  reprobeKeyStorage,
  resetSecretStoreForTests,
  setSecret,
} from "../../lib/keys/secret-store.mjs";
import { createSecretFallbackHandlers } from "../../lib/keys/secret-fallbacks.mjs";
import { readKeyStorageCache, writeKeyStorageCache } from "../../lib/keys/storage-cache.mjs";
import { plaintextSecretPath, writePlaintextSecret } from "../../lib/keys/plaintext-secret-store.mjs";
import { exportFireworksApiKey, keyStoreUnreadableError, resolveFireworksKeyWithSource } from "../../lib/keys/api-key.mjs";
import { resolveHarnessOnApiKey } from "../../lib/keys/harness-api-key.mjs";
import { FIREWORKS_API_KEY_KEYCHAIN_REF, writeGlobalConfig } from "../../lib/config/global-config.mjs";

const MASTER_A = "a".repeat(64);
const MASTER_B = "b".repeat(64);
const KEY_ONE = `fw_${"x".repeat(24)}`;
const KEY_TWO = `fw_${"y".repeat(24)}`;
const CLI = path.resolve("bin/nexus.mjs");
const SECRET_STORE = new URL("../../lib/keys/secret-store.mjs", import.meta.url).href;
const FAKE_KEYCHAIN = new URL("./fixtures/fake-cross-keychain.mjs", import.meta.url).href;
const USE_FAKE = `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(FAKE_KEYCHAIN)});`;
const ENV_KEYS = [
  "HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", KEY_STORAGE_ENV, "NEXUS_SECRET_STORE",
  "NEXUS_TEST", "KEYRING_FILE_MASTER_KEY", "TS_KEYRING_BACKEND",
];

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** A fresh CLI process in the same temp HOME, now with `masterKey`. */
function switchMasterKey(masterKey) {
  if (masterKey === undefined) delete process.env.KEYRING_FILE_MASTER_KEY;
  else process.env.KEYRING_FILE_MASTER_KEY = masterKey;
  resetSecretStoreForTests();
}

function assertUndecryptable(error, home) {
  assert.ok(error instanceof KeyStoreUndecryptableError, `expected KeyStoreUndecryptableError, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, KEY_STORE_UNDECRYPTABLE);
  assert.match(error.message, /can't be decrypted with the current master key/);
  assert.match(error.message, /KEYRING_FILE_MASTER_KEY/);
  assert.ok(error.message.includes(path.join(home, "data", "keyring", "secrets.json")), error.message);
  assert.doesNotMatch(error.message, /fw_/);
  return true;
}

describe("encrypted key store that the current master key cannot decrypt", () => {
  let home;
  let saved;
  let storeFile;

  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    home = await mkdtemp(path.join(os.tmpdir(), "nexus-key-mismatch-"));
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
    process.env[KEY_STORAGE_ENV] = "file";
    delete process.env.NEXUS_SECRET_STORE;
    delete process.env.NEXUS_TEST;
    switchMasterKey(MASTER_A);
    storeFile = path.join(home, "data", "keyring", "secrets.json");
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSecretStoreForTests();
    await rm(home, { recursive: true, force: true });
  });

  it("setSecret refuses instead of falling back to plaintext and leaves the store untouched", async () => {
    await setSecret(KEY_ONE, home);
    assert.equal(await readKeyStorageCache(home), "file");
    const before = await readFile(storeFile);

    switchMasterKey(MASTER_B);
    await assert.rejects(() => setSecret(KEY_TWO, home), (error) => assertUndecryptable(error, home));

    assert.equal(await exists(plaintextSecretPath(home)), false);
    assert.notEqual(await readKeyStorageCache(home), "plaintext");
    assert.deepEqual(await readFile(storeFile), before);

    switchMasterKey(MASTER_A);
    assert.equal(await getSecret(home), KEY_ONE);
  });

  it("getSecret stays non-throwing and records the undecryptable store as the read error", async () => {
    await setSecret(KEY_ONE, home);
    switchMasterKey(MASTER_B);
    assert.equal(await getSecret(home), null);
    assertUndecryptable(getLastSecretReadError(), home);
  });

  it("refuses when the generated key file was replaced (no KEYRING_FILE_MASTER_KEY)", async () => {
    switchMasterKey(undefined);
    await setSecret(KEY_ONE, home);
    const keyFile = path.join(home, "cfg", "keyring", "file.key");
    await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
    const before = await readFile(storeFile);

    resetSecretStoreForTests();
    await assert.rejects(() => setSecret(KEY_TWO, home), (error) => {
      assertUndecryptable(error, home);
      assert.ok(error.message.includes(keyFile), error.message);
      return true;
    });
    assert.equal(await exists(plaintextSecretPath(home)), false);
    assert.deepEqual(await readFile(storeFile), before);
  });

  it("the built-in encrypted-file store raises the same error and does not rewrite the file", async () => {
    await builtinSetPassword("FireworksAI", "fireworks-api-key", KEY_ONE);
    assert.equal(secretsFilePath(), storeFile);
    const before = await readFile(storeFile);
    switchMasterKey(MASTER_B);
    await assert.rejects(() => builtinGetPassword("FireworksAI", "fireworks-api-key"), (error) => assertUndecryptable(error, home));
    await assert.rejects(() => builtinSetPassword("FireworksAI", "fireworks-api-key", KEY_TWO), (error) => assertUndecryptable(error, home));
    assert.deepEqual(await readFile(storeFile), before);
  });

  it("the fallback ladder rethrows the error without trying plaintext", async () => {
    const calls = [];
    const { storeSecretWithFallbacks } = createSecretFallbackHandlers({
      resolveHome: (h) => h,
      withHomeScopedEnv: async (_home, fn) => fn(),
      persistKeyStorageCache: async (_home, storage) => { calls.push(`cache:${storage}`); },
      clearKeyStorageCache: async () => {},
      deleteSecretFromSecureBackend: async () => { calls.push("delete-secure"); },
      primeSecureReadCache: () => {},
      clearLastReadError: () => {},
      secretService: "FireworksAI",
      secretAccount: "fireworks-api-key",
    });
    const refusal = new KeyStoreUndecryptableError();
    await assert.rejects(
      () => storeSecretWithFallbacks(KEY_TWO, home, async () => { throw refusal; }),
      (error) => error === refusal,
    );
    assert.deepEqual(calls, []);
    assert.equal(await exists(plaintextSecretPath(home)), false);
  });

  it("still falls back to plaintext when no encrypted store can be used at all", async () => {
    const blocked = path.join(home, "blocked-xdg");
    await writeFile(blocked, "not-a-directory");
    process.env.XDG_DATA_HOME = blocked;
    resetSecretStoreForTests();
    await setSecret(KEY_ONE, home);
    assert.equal(await readKeyStorageCache(home), "plaintext");
    assert.equal(await getSecret(home), KEY_ONE);
  });

  it("reprobe neither writes plaintext nor touches the store when the store is undecryptable", async () => {
    await setSecret(KEY_ONE, home);
    const before = await readFile(storeFile);
    switchMasterKey(MASTER_B);

    const result = await reprobeKeyStorage(home);
    assert.equal(result.migrated, false);
    assert.equal(await exists(plaintextSecretPath(home)), false);
    assert.notEqual(await readKeyStorageCache(home), "plaintext");
    assert.deepEqual(await readFile(storeFile), before);
  });

  it("reprobe keeps an existing plaintext key in place and reports the store error", async () => {
    await setSecret(KEY_ONE, home);
    const before = await readFile(storeFile);
    // A key left in plaintext by an earlier fallback.
    await writePlaintextSecret(home, KEY_TWO);
    await writeKeyStorageCache(home, "plaintext", "earlier fallback");
    switchMasterKey(MASTER_B);

    const result = await reprobeKeyStorage(home);
    assert.equal(result.migrated, false);
    assertUndecryptable(result.keyStoreError, home);
    assert.deepEqual(await readFile(storeFile), before);
    resetSecretStoreForTests();
    assert.equal(await getSecret(home), KEY_TWO);
  });

  it("a later successful read for another purpose does not hide the undecryptable store", async () => {
    await setSecret(KEY_ONE, home);
    switchMasterKey(MASTER_B);
    assert.equal(await hasSecret(home), false);
    assertUndecryptable(keyStoreUnreadableError(), home);
    // A plaintext copy written by an earlier release still resolves...
    await writePlaintextSecret(home, KEY_TWO);
    resetSecretStoreForTests();
    assert.equal(await getSecret(home), KEY_TWO);
    // ...and that success resets the generic read error, but not the record
    // that the encrypted store can't be decrypted.
    assert.equal(getLastSecretReadError(), null);
    assertUndecryptable(keyStoreUnreadableError(), home);
    // Only decrypting the store again clears it.
    switchMasterKey(MASTER_A);
    assert.equal(await getSecret(home), KEY_ONE);
    assert.equal(keyStoreUnreadableError(), null);
  });

  it("key export surfaces the actionable error instead of 'No Fireworks API key found'", async () => {
    await setSecret(KEY_ONE, home);
    await writeGlobalConfig(home, { apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF });
    switchMasterKey(MASTER_B);
    await assert.rejects(() => exportFireworksApiKey(home), (error) => assertUndecryptable(error, home));
    // Plain resolution (status, status line) stays non-throwing.
    resetSecretStoreForTests();
    assert.deepEqual(await resolveFireworksKeyWithSource({ home }), { key: "", source: "none" });
  });

  it("harness `on` explains the undecryptable store instead of prompting for a key", async () => {
    await setSecret(KEY_ONE, home);
    await writeGlobalConfig(home, { apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF });
    switchMasterKey(MASTER_B);
    let prompted = false;
    await assert.rejects(
      () => resolveHarnessOnApiKey({
        home,
        harnessEnvRef: "{env:FIREWORKS_API_KEY}",
        promptForKey: async () => { prompted = true; return ""; },
      }),
      (error) => assertUndecryptable(error, home),
    );
    assert.equal(prompted, false);
  });
});

/** Run the real CLI as a separate process in the temp HOME. */
function runCli(home, args, env, input = "") {
  const childEnv = { ...process.env, HOME: home, ...env };
  for (const key of ["NEXUS_SECRET_STORE", "FIREWORKS_API_KEY", "TS_KEYRING_BACKEND"]) {
    delete childEnv[key];
  }
  const res = spawnSync(process.execPath, [CLI, ...args], { env: childEnv, encoding: "utf8", input, timeout: 30_000 });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("nexus login with an undecryptable encrypted key store", () => {
  it("exits non-zero with the recovery steps and writes no plaintext key", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nexus-key-mismatch-cli-"));
    try {
      const base = {
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CONFIG_HOME: path.join(home, "cfg"),
        [KEY_STORAGE_ENV]: "file",
      };
      const first = runCli(home, ["login", "--with-token"], { ...base, KEYRING_FILE_MASTER_KEY: MASTER_A }, `${KEY_ONE}\n`);
      assert.equal(first.code, 0, first.stderr);
      const storeFile = path.join(home, "data", "keyring", "secrets.json");
      const before = await readFile(storeFile);

      const second = runCli(home, ["login", "--with-token", "--force"], { ...base, KEYRING_FILE_MASTER_KEY: MASTER_B }, `${KEY_TWO}\n`);
      assert.equal(second.code, 1);
      const output = `${second.stdout}\n${second.stderr}`;
      assert.match(output, /can't be decrypted with the current master key/);
      assert.ok(output.includes(storeFile), output);
      assert.doesNotMatch(output, /plaintext file at/);
      assert.equal(await exists(plaintextSecretPath(home)), false);
      assert.deepEqual(await readFile(storeFile), before);

      const exported = runCli(home, ["key", "export", "--stored-only"], { ...base, KEYRING_FILE_MASTER_KEY: MASTER_B });
      assert.equal(exported.code, 1);
      assert.equal(exported.stdout, "");
      assert.match(exported.stderr, /can't be decrypted with the current master key/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("commands that read the stored key under the wrong master key", () => {
  /** @type {string} */
  let home;
  /** @type {Record<string, string>} */
  let base;
  /** @type {string} */
  let storeFile;
  /** @type {Buffer} */
  let before;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "nexus-key-mismatch-on-"));
    base = {
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CONFIG_HOME: path.join(home, "cfg"),
      [KEY_STORAGE_ENV]: "file",
    };
    const login = runCli(home, ["login", "--with-token"], { ...base, KEYRING_FILE_MASTER_KEY: MASTER_A }, `${KEY_ONE}\n`);
    assert.equal(login.code, 0, login.stderr);
    storeFile = path.join(home, "data", "keyring", "secrets.json");
    before = await readFile(storeFile);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function assertNothingLeaked(result) {
    assert.equal(result.code, 1);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /can't be decrypted with the current master key/);
    assert.match(output, /KEYRING_FILE_MASTER_KEY/);
    assert.doesNotMatch(output, /No Fireworks (API key|credential) found/);
    assert.doesNotMatch(output, /fw_/);
    assert.equal(await exists(plaintextSecretPath(home)), false);
    assert.deepEqual(await readFile(storeFile), before);
  }

  for (const [harness, untouched] of [
    ["claude", [".claude/settings.json", ".claude.json"]],
    ["vscode", [".config/Code/User/globalStorage/state.vscdb", ".config/Code/User/settings.json"]],
    ["claude-desktop", [".config/Claude/claude_desktop_config.json", ".nexus/claude-desktop"]],
  ]) {
    it(`${harness} on explains the undecryptable store and writes nothing`, async () => {
      const result = runCli(home, [harness, "on", "--skip-install-check"], { ...base, KEYRING_FILE_MASTER_KEY: MASTER_B });
      await assertNothingLeaked(result);
      for (const rel of untouched) {
        assert.equal(await exists(path.join(home, rel)), false, `${rel} was written`);
      }
    });
  }

  it("status explains the undecryptable store", async () => {
    const result = runCli(home, ["status"], { ...base, KEYRING_FILE_MASTER_KEY: MASTER_B });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /can't be decrypted with the current master key/);
    assert.doesNotMatch(output, /fw_/);
    assert.equal(await exists(plaintextSecretPath(home)), false);
  });

  it("logout refuses and leaves the encrypted store and config in place", async () => {
    const configFile = path.join(home, ".nexus", "config.json");
    const configBefore = await readFile(configFile, "utf8");
    const result = runCli(home, ["logout"], { ...base, KEYRING_FILE_MASTER_KEY: MASTER_B });
    await assertNothingLeaked(result);
    assert.match(result.stderr, /Not logged out/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Signed out|Logged out/);
    assert.equal(await readFile(configFile, "utf8"), configBefore);

    const restored = runCli(home, ["logout"], { ...base, KEYRING_FILE_MASTER_KEY: MASTER_A });
    assert.equal(restored.code, 0, restored.stderr);
    const exported = runCli(home, ["key", "export", "--stored-only"], { ...base, KEYRING_FILE_MASTER_KEY: MASTER_A });
    assert.equal(exported.code, 1);
    assert.match(exported.stderr, /No Fireworks API key found/);
  });
});

describe("an OS keychain that refuses the key, with an undecryptable encrypted-file fallback", () => {
  /** Run `code` as its own process against the fake keychain. */
  function runFake(home, keychain, masterKey, code) {
    const env = { ...process.env, HOME: home, FAKE_KEYCHAIN: keychain, KEYRING_FILE_MASTER_KEY: masterKey };
    for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", KEY_STORAGE_ENV, "NEXUS_SECRET_STORE", "NEXUS_TEST", "SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT", "TS_KEYRING_BACKEND"]) {
      delete env[key];
    }
    const result = spawnSync(process.execPath, [
      "--import", USE_FAKE, "--input-type=module", "-e",
      `const s = await import(${JSON.stringify(SECRET_STORE)}); const home = process.env.HOME; ${code}`,
    ], { env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }

  it("reprobe keeps the storage choice on the file store it cannot decrypt, even when the keychain is back", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nexus-key-mismatch-fake-"));
    try {
      runFake(home, "broken", MASTER_A, `await s.setSecret(${JSON.stringify(KEY_ONE)}, home);`);
      const probe = runFake(home, "working", MASTER_B, `
        const r = await s.reprobeKeyStorage(home);
        const cache = await import(${JSON.stringify(new URL("../../lib/keys/storage-cache.mjs", import.meta.url).href)});
        console.log(JSON.stringify({ migrated: r.migrated, code: r.keyStoreError?.code ?? null, storage: await cache.readKeyStorageCache(home) }));`);
      assert.deepEqual(JSON.parse(probe), { migrated: false, code: KEY_STORE_UNDECRYPTABLE, storage: "file" });
      const restored = runFake(home, "working", MASTER_A, `console.log(await s.getSecret(home));`);
      assert.equal(restored, KEY_ONE);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses instead of writing the key in plaintext", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nexus-key-mismatch-fake-"));
    try {
      runFake(home, "broken", MASTER_A, `await s.setSecret(${JSON.stringify(KEY_ONE)}, home);`);
      const storeFile = path.join(home, ".local", "share", "keyring", "secrets.json");
      const before = await readFile(storeFile);
      const outcome = runFake(home, "broken", MASTER_B, `
        try { await s.setSecret(${JSON.stringify(KEY_TWO)}, home); console.log("stored"); }
        catch (error) { console.log(error.code); }`);
      assert.equal(outcome, KEY_STORE_UNDECRYPTABLE);
      assert.equal(await exists(plaintextSecretPath(home)), false);
      assert.deepEqual(await readFile(storeFile), before);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
