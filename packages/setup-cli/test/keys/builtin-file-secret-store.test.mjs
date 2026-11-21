import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  builtinGetPassword,
  builtinDeletePassword,
  builtinHasPassword,
  builtinSetPassword,
  fileDataRoot,
  secretsFilePath,
} from "../../lib/keys/builtin-file-secret-store.mjs";

const SERVICE = "FireworksAI";
const ACCOUNT = "fireworks-api-key";

describe("builtin-file-secret-store", () => {
  let home;
  let savedHome;
  let savedEnv;

  beforeEach(async () => {
    savedHome = process.env.HOME;
    savedEnv = Object.fromEntries(["XDG_DATA_HOME", "XDG_CONFIG_HOME", "KEYRING_FILE_MASTER_KEY"].map((key) => [key, process.env[key]]));
    home = await mkdtemp(path.join(os.tmpdir(), "fc-builtin-file-"));
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
    delete process.env.KEYRING_FILE_MASTER_KEY;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });

  it("stores secrets as encrypted bytes, not plaintext JSON", async () => {
    await builtinSetPassword(SERVICE, ACCOUNT, "fw_test_secret_value");
    const file = secretsFilePath();
    assert.ok(file);
    const raw = await readFile(file);
    assert.ok(raw.length > 32);
    assert.doesNotMatch(raw.toString("utf8"), /fw_test_secret_value/);
    assert.equal(await builtinGetPassword(SERVICE, ACCOUNT), "fw_test_secret_value");
    assert.equal(await builtinHasPassword(SERVICE, ACCOUNT), true);
  });

  it("uses HOME for data and config when XDG paths are unset", async () => {
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
    const altHome = await mkdtemp(path.join(os.tmpdir(), "fc-builtin-alt-home-"));
    try {
      process.env.HOME = altHome;
      await builtinSetPassword(SERVICE, ACCOUNT, "fw_home_aligned_key");
      assert.equal(fileDataRoot(), path.join(altHome, ".local", "share", "keyring"));
      assert.equal(await builtinGetPassword(SERVICE, ACCOUNT), "fw_home_aligned_key");
      const secrets = secretsFilePath();
      assert.ok(secrets?.startsWith(altHome));
    } finally {
      await rm(altHome, { recursive: true, force: true });
      process.env.HOME = home;
      process.env.XDG_DATA_HOME = path.join(home, "data");
      process.env.XDG_CONFIG_HOME = path.join(home, "cfg");
    }
  });

  for (const value of ["a".repeat(63), "a".repeat(65), "g".repeat(64), `${"a".repeat(62)}gg`, `${"a".repeat(63)}\n`, `${"a".repeat(64)}\n`]) {
    it(`rejects a malformed environment master key (${JSON.stringify(value.length)} characters)`, async () => {
      process.env.KEYRING_FILE_MASTER_KEY = value;
      for (const operation of [
        () => builtinSetPassword(SERVICE, ACCOUNT, "example-secret"),
        () => builtinGetPassword(SERVICE, ACCOUNT),
        () => builtinDeletePassword(SERVICE, ACCOUNT),
      ]) {
        await assert.rejects(operation(), {
          message: "KEYRING_FILE_MASTER_KEY must be 64 hex characters (32 bytes)",
        });
      }
      assert.deepEqual(await readdir(home), []);
    });
  }

  for (const value of ["", " \t\n "]) {
    it(`uses the key file when the environment master key is ${value ? "whitespace-only" : "empty"}`, async () => {
      process.env.KEYRING_FILE_MASTER_KEY = value;
      await builtinSetPassword(SERVICE, ACCOUNT, "original-secret");
      const keyFile = path.join(home, "cfg", "keyring", "file.key");
      const key = await readFile(keyFile);
      assert.equal(key.length, 32);
      delete process.env.KEYRING_FILE_MASTER_KEY;
      assert.equal(await builtinGetPassword(SERVICE, ACCOUNT), "original-secret");
      process.env.KEYRING_FILE_MASTER_KEY = value;
      await builtinSetPassword(SERVICE, ACCOUNT, "updated-secret");
      assert.equal(await builtinGetPassword(SERVICE, ACCOUNT), "updated-secret");
      assert.deepEqual(await readFile(keyFile), key);
      await builtinDeletePassword(SERVICE, ACCOUNT);
      assert.equal(await builtinGetPassword(SERVICE, ACCOUNT), null);
    });
  }

  it("accepts upper- and lowercase hexadecimal environment keys without creating a key file", async () => {
    process.env.KEYRING_FILE_MASTER_KEY = "aB".repeat(32);
    await builtinSetPassword(SERVICE, ACCOUNT, "example-secret");
    process.env.KEYRING_FILE_MASTER_KEY = "ab".repeat(32);
    assert.equal(await builtinGetPassword(SERVICE, ACCOUNT), "example-secret");
    await assert.rejects(readFile(path.join(home, "cfg", "keyring", "file.key")), { code: "ENOENT" });
  });

  it("keeps existing key bytes and encrypted stores readable across updates", async () => {
    await builtinSetPassword(SERVICE, ACCOUNT, "original");
    const keyFile = path.join(home, "cfg", "keyring", "file.key");
    const key = await readFile(keyFile);
    assert.equal(key.length, 32);
    await builtinSetPassword("example-service", "another-account", "another-secret");
    assert.deepEqual(await readFile(keyFile), key);
    assert.equal(await builtinGetPassword(SERVICE, ACCOUNT), "original");
    await builtinDeletePassword("example-service", "another-account");
    assert.equal(await builtinGetPassword("example-service", "another-account"), null);
    assert.equal(await builtinGetPassword(SERVICE, ACCOUNT), "original");
  });

  it("reads the existing version-one AES-GCM layout without rewriting key material", async () => {
    const key = Buffer.alloc(32, 5);
    const iv = Buffer.alloc(12, 3);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ [SERVICE]: { [ACCOUNT]: "existing-secret" } })), cipher.final()]);
    const file = secretsFilePath();
    const keyFile = path.join(home, "cfg", "keyring", "file.key");
    await mkdir(path.dirname(file), { recursive: true });
    await mkdir(path.dirname(keyFile), { recursive: true });
    await writeFile(keyFile, key);
    await writeFile(file, Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]));
    assert.equal(await builtinGetPassword(SERVICE, ACCOUNT), "existing-secret");
    await builtinSetPassword(SERVICE, "new-account", "new-secret");
    assert.equal(await builtinGetPassword(SERVICE, ACCOUNT), "existing-secret");
    assert.deepEqual(await readFile(keyFile), key);
  });

  it("does not create a store for absent reads and deletes", async () => {
    assert.equal(await builtinGetPassword(SERVICE, ACCOUNT), null);
    await builtinDeletePassword(SERVICE, ACCOUNT);
    assert.deepEqual(await readdir(home), []);
  });

  it("preserves concurrent sets and deletes across accounts and services", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => builtinSetPassword(`service-${i % 2}`, `account-${i}`, `secret-${i}`)));
    await Promise.all(Array.from({ length: 12 }, (_, i) => i % 2
      ? builtinSetPassword(`service-${i % 2}`, `new-account-${i}`, `new-secret-${i}`)
      : builtinDeletePassword(`service-${i % 2}`, `account-${i}`)));
    for (let i = 0; i < 12; i++) {
      assert.equal(await builtinGetPassword(`service-${i % 2}`, `account-${i}`), i % 2 ? `secret-${i}` : null);
      if (i % 2) assert.equal(await builtinGetPassword(`service-${i % 2}`, `new-account-${i}`), `new-secret-${i}`);
    }
  });

  it("allows later updates after a rejected update", async () => {
    process.env.KEYRING_FILE_MASTER_KEY = "invalid";
    await assert.rejects(builtinSetPassword(SERVICE, ACCOUNT, "rejected"), /64 hex characters/);
    delete process.env.KEYRING_FILE_MASTER_KEY;
    await builtinSetPassword(SERVICE, ACCOUNT, "accepted");
    assert.equal(await builtinGetPassword(SERVICE, ACCOUNT), "accepted");
  });

  for (const entry of ["key", "store"]) {
    it(`reads the ${entry} created by another initializer on EEXIST`, async (t) => {
      const keyFile = path.join(home, "cfg", "keyring", "file.key");
      let winner;
      if (entry === "store") {
        await builtinSetPassword(SERVICE, "winner-account", "winner-secret");
        winner = await readFile(secretsFilePath());
        await rm(secretsFilePath());
      } else {
        winner = Buffer.alloc(32, 7);
      }
      const file = entry === "key" ? keyFile : secretsFilePath();
      const originalOpen = fs.open;
      let claimed = false;
      const mock = t.mock.method(fs, "open", async (target, flags, mode) => {
        if (target === file && (flags & constants.O_EXCL) && !claimed) {
          claimed = true;
          await writeFile(target, winner, { flag: "wx", mode: 0o600 });
        }
        return originalOpen(target, flags, mode);
      });
      syncBuiltinESMExports();
      t.after(() => {
        mock.mock.restore();
        syncBuiltinESMExports();
      });
      await builtinSetPassword(SERVICE, ACCOUNT, "new-secret");
      assert.equal(claimed, true);
      assert.equal(await builtinGetPassword(SERVICE, ACCOUNT), "new-secret");
      if (entry === "key") assert.deepEqual(await readFile(keyFile), winner);
      else assert.equal(await builtinGetPassword(SERVICE, "winner-account"), "winner-secret");
    });
  }

  const posix = { skip: process.platform === "win32" };

  it("creates private files and tightens existing file and directory modes", posix, async () => {
    await builtinSetPassword(SERVICE, ACCOUNT, "example-secret");
    const files = [path.join(home, "cfg", "keyring", "file.key"), secretsFilePath()];
    for (const file of files) {
      assert.equal((await lstat(file)).mode & 0o777, 0o600);
      await chmod(file, 0o644);
      await chmod(path.dirname(file), 0o777);
    }
    assert.equal(await builtinGetPassword(SERVICE, ACCOUNT), "example-secret");
    for (const file of files) {
      assert.equal((await lstat(file)).mode & 0o777, 0o600);
      assert.equal((await lstat(path.dirname(file))).mode & 0o777, 0o700);
    }
  });

  for (const entry of ["key", "store", "key directory", "store directory"]) {
    for (const dangling of [false, true]) {
      it(`refuses a ${dangling ? "dangling" : "live"} symlink at the ${entry}`, posix, async () => {
        await builtinSetPassword(SERVICE, ACCOUNT, "example-secret");
        let file = entry.startsWith("key") ? path.join(home, "cfg", "keyring", "file.key") : secretsFilePath();
        const directory = entry.endsWith("directory");
        if (directory) file = path.dirname(file);
        const target = path.join(home, "outside");
        await rename(file, target);
        if (dangling) await rm(target, { recursive: true });
        else await chmod(target, directory ? 0o755 : 0o644);
        await symlink(target, file);
        for (const operation of [
          () => builtinGetPassword(SERVICE, ACCOUNT),
          () => builtinSetPassword(SERVICE, ACCOUNT, "changed"),
          () => builtinDeletePassword(SERVICE, ACCOUNT),
        ]) {
          await assert.rejects(operation(), /Cannot secure file key store/);
        }
        if (dangling) await assert.rejects(lstat(target), { code: "ENOENT" });
        else assert.equal((await lstat(target)).mode & 0o777, directory ? 0o755 : 0o644);
      });
    }

    it(`refuses a foreign-owned ${entry} without changing its mode`, posix, async (t) => {
      await builtinSetPassword(SERVICE, ACCOUNT, "example-secret");
      let file = entry.startsWith("key") ? path.join(home, "cfg", "keyring", "file.key") : secretsFilePath();
      const directory = entry.endsWith("directory");
      if (directory) file = path.dirname(file);
      await chmod(file, directory ? 0o755 : 0o644);
      const uid = process.getuid();
      const refusedCall = (entry.startsWith("key") ? 2 : 0) + (directory ? 1 : 2);
      let calls = 0;
      const mock = t.mock.method(process, "getuid", () => ++calls === refusedCall ? uid + 1 : uid);
      try {
        await assert.rejects(builtinGetPassword(SERVICE, ACCOUNT), /Cannot secure file key store/);
      } finally {
        mock.mock.restore();
      }
      assert.equal((await lstat(file)).mode & 0o777, directory ? 0o755 : 0o644);
    });
  }
});
