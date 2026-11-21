import assert from "node:assert/strict";
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { readPlaintextSecret, writePlaintextSecret, plaintextSecretPath } from "../../lib/keys/plaintext-secret-store.mjs";
import { getSecret, resetSecretStoreForTests, setSecret, withHomeScopedEnv } from "../../lib/keys/secret-store.mjs";
import { secretsFilePath } from "../../lib/keys/builtin-file-secret-store.mjs";
import { createSecretFallbackHandlers } from "../../lib/keys/secret-fallbacks.mjs";
import { writeKeyStorageCache } from "../../lib/keys/storage-cache.mjs";

let home;
let saved;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "key-files-"));
  saved = Object.fromEntries(["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "NEXUS_KEY_STORAGE", "NEXUS_SECRET_STORE", "KEYRING_FILE_MASTER_KEY"].map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = path.join(home, "data");
  process.env.XDG_CONFIG_HOME = path.join(home, "config");
  process.env.NEXUS_KEY_STORAGE = "file";
  process.env.KEYRING_FILE_MASTER_KEY = "a".repeat(64);
  delete process.env.NEXUS_SECRET_STORE;
  resetSecretStoreForTests();
});
afterEach(async () => {
  resetSecretStoreForTests();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

const posix = { skip: process.platform === "win32" };

test("plaintext fallback rechecks and tightens files and directories on every reuse", posix, async () => {
  await writePlaintextSecret(home, "example-key");
  const file = plaintextSecretPath(home);
  for (let i = 0; i < 2; i += 1) {
    await chmod(file, 0o644);
    await chmod(path.dirname(file), 0o777);
    assert.equal(await readPlaintextSecret(home), "example-key");
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.equal((await lstat(path.dirname(file))).mode & 0o777, 0o700);
  }
  await writePlaintextSecret(home, "replacement");
  assert.equal(await readPlaintextSecret(home), "replacement");
  await assert.rejects(writePlaintextSecret(home, " "), /API key is required/);
});

test("plaintext fallback refuses linked files without changing the target, and observers do not throw", posix, async () => {
  const outside = path.join(home, "outside");
  await writeFile(outside, "example-key", { mode: 0o644 });
  await mkdir(path.dirname(plaintextSecretPath(home)), { recursive: true });
  await symlink(outside, plaintextSecretPath(home));
  await assert.rejects(readPlaintextSecret(home));
  assert.equal(await getSecret(home), null);
  await writePlaintextSecret(home, "replacement");
  assert.equal(await readPlaintextSecret(home), "replacement");
  assert.equal((await lstat(outside)).mode & 0o777, 0o644);
  assert.equal(await readFile(outside, "utf8"), "example-key");
});

test("an encrypted fallback allows linked XDG ancestors but refuses a linked keyring directory", posix, async () => {
  await setSecret("example-key", home);
  assert.equal(await getSecret(home), "example-key");
  const outside = path.join(home, "outside-data");
  await fs.rename(process.env.XDG_DATA_HOME, outside);
  await symlink(outside, process.env.XDG_DATA_HOME, "dir");
  resetSecretStoreForTests();
  assert.equal(await getSecret(home), "example-key");
  const keyring = path.dirname(secretsFilePath());
  const outsideKeyring = path.join(home, "outside-keyring");
  await fs.rename(keyring, outsideKeyring);
  await symlink(outsideKeyring, keyring, "dir");
  resetSecretStoreForTests();
  assert.equal(await getSecret(home), null);
});

test("nested HOME scopes complete, serialize siblings, and restore after errors", { timeout: 3000 }, async () => {
  const original = [process.env.HOME, process.env.XDG_DATA_HOME, process.env.XDG_CONFIG_HOME];
  const homes = ["outer", "inner", "sibling", "queued"].map((name) => path.join(home, name));
  await Promise.all(homes.map((value) => mkdir(value)));
  const visited = [];
  const outer = withHomeScopedEnv(homes[0], async () => {
    assert.equal(process.env.HOME, homes[0]);
    assert.equal(await withHomeScopedEnv(homes[0], async () => {}), undefined);
    await assert.rejects(withHomeScopedEnv(homes[1], async () => {
      assert.equal(process.env.HOME, homes[1]);
      await setSecret("nested-example", homes[1]);
      assert.equal(await getSecret(homes[1]), "nested-example");
      throw new Error("nested failure");
    }), /nested failure/);
    assert.equal(process.env.HOME, homes[0]);
    await Promise.all(homes.slice(1, 3).map((value) => withHomeScopedEnv(value, async () => {
      assert.equal(process.env.HOME, value);
      await new Promise(setImmediate);
      assert.equal(process.env.HOME, value);
      visited.push(value);
    })));
    assert.equal(process.env.HOME, homes[0]);
    assert.deepEqual(visited, homes.slice(1, 3));
    visited.push(homes[0]);
  });
  const queued = withHomeScopedEnv(homes[3], async () => {
    assert.equal(process.env.HOME, homes[3]);
    assert.deepEqual(visited, [homes[1], homes[2], homes[0]]);
  });
  await Promise.all([outer, queued]);
  assert.deepEqual([process.env.HOME, process.env.XDG_DATA_HOME, process.env.XDG_CONFIG_HOME], original);
  await assert.rejects(withHomeScopedEnv(homes[0], async () => { throw new Error("outer failure"); }), /outer failure/);
  assert.equal(await withHomeScopedEnv(homes[1], async () => "recovered"), "recovered");
  assert.deepEqual([process.env.HOME, process.env.XDG_DATA_HOME, process.env.XDG_CONFIG_HOME], original);
});

test("HOME-scoped file operations over different homes do not mix keys or environment", async () => {
  const homes = [path.join(home, "first"), path.join(home, "second")];
  await Promise.all(homes.map((value) => mkdir(value)));
  const expectedEnv = [process.env.HOME, process.env.XDG_DATA_HOME, process.env.XDG_CONFIG_HOME];
  await Promise.all(homes.map((value, index) => setSecret(`example-key-${index}`, value)));
  assert.deepEqual([process.env.HOME, process.env.XDG_DATA_HOME, process.env.XDG_CONFIG_HOME], expectedEnv);
  resetSecretStoreForTests();
  assert.deepEqual(await Promise.all(homes.map((value) => getSecret(value))), ["example-key-0", "example-key-1"]);
  assert.deepEqual([process.env.HOME, process.env.XDG_DATA_HOME, process.env.XDG_CONFIG_HOME], expectedEnv);
});

test("stale plaintext cleanup failures warn without undoing a successful fallback", async (t) => {
  await writePlaintextSecret(home, "old-example");
  const original = fs.unlink;
  const mocked = t.mock.method(fs, "unlink", async (file) => {
    if (file === plaintextSecretPath(home)) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return original(file);
  });
  const warnings = [];
  t.mock.method(console, "warn", (message) => warnings.push(message));
  syncBuiltinESMExports();
  try {
    const handlers = createSecretFallbackHandlers({
      resolveHome: () => home,
      withHomeScopedEnv: async (_home, fn) => fn(),
      persistKeyStorageCache: async () => {}, clearKeyStorageCache: async () => {},
      primeSecureReadCache: () => {}, clearLastReadError: () => {},
      secretService: "example", secretAccount: "example",
    });
    assert.equal(await handlers.storeSecretInFileFallback("new-example", home, new Error("unavailable"), "example", { quiet: true }), true);
    assert.match(warnings.join("\n"), /stale credential copy could not be removed/);
    assert.equal(await readPlaintextSecret(home), "old-example");
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("storage cache atomically replaces a linked leaf with a private file", posix, async () => {
  const outside = path.join(home, "outside");
  await writeFile(outside, "unchanged");
  await mkdir(path.join(home, ".nexus"));
  const cache = path.join(home, ".nexus", "key-storage.json");
  await symlink(outside, cache);
  await writeKeyStorageCache(home, "file");
  assert.equal((await lstat(cache)).isSymbolicLink(), false);
  assert.equal((await lstat(cache)).mode & 0o777, 0o600);
  assert.equal(await readFile(outside, "utf8"), "unchanged");
});
