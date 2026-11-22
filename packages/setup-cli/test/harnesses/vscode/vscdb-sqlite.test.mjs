import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { withTempHome } from "../../helpers.mjs";
import {
  applyItemTableWrites, deleteItemTableValue, ensureItemTable, readItemTableValue,
  secureItemTableFiles, writeItemTableValue,
} from "../../../lib/harnesses/vscode/vscdb-sqlite.mjs";

const posix = { skip: process.platform === "win32" };
const suffixes = ["", "-wal", "-shm", "-journal"];
const refusal = { message: "Cannot secure IDE database files. Check ownership, permissions, and symlinks." };

test("database permissions: existing database and all sidecars become private", posix, async () => {
  await withTempHome("vscdb-private-", async (home) => {
    const dbPath = path.join(home, "state.vscdb");
    for (const suffix of suffixes) {
      await writeFile(dbPath + suffix, "example");
      await chmod(dbPath + suffix, 0o644);
    }
    secureItemTableFiles(dbPath);
    for (const suffix of suffixes) {
      assert.equal((await lstat(dbPath + suffix)).mode & 0o777, 0o600);
      assert.equal(await readFile(dbPath + suffix, "utf8"), "example");
    }
  });
});

test("database permissions: missing files and empty mutations are harmless", async () => {
  await withTempHome("vscdb-missing-", async (home) => {
    const dbPath = path.join(home, "state.vscdb");
    secureItemTableFiles(dbPath);
    await applyItemTableWrites(dbPath, []);
    assert.equal(await readItemTableValue(dbPath, "example"), "");
    await deleteItemTableValue(dbPath, "example");
    await assert.rejects(lstat(dbPath), { code: "ENOENT" });
  });
});

test("database permissions: a different owner is refused without chmod", posix, async (t) => {
  await withTempHome("vscdb-owner-", async (home) => {
    const dbPath = path.join(home, "state.vscdb");
    await writeFile(dbPath, "example");
    await chmod(dbPath, 0o644);
    const uid = process.getuid();
    const mocked = t.mock.method(process, "getuid", () => uid + 1);
    try {
      assert.throws(() => secureItemTableFiles(dbPath), refusal);
    } finally {
      mocked.mock.restore();
    }
    assert.equal((await lstat(dbPath)).mode & 0o777, 0o644);
    assert.equal(await readFile(dbPath, "utf8"), "example");
  });
});

test("database permissions: Windows leaves modes unchanged", posix, async () => {
  await withTempHome("vscdb-windows-", async (home) => {
    const dbPath = path.join(home, "state.vscdb");
    await writeFile(dbPath, "example");
    await chmod(dbPath, 0o644);
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      secureItemTableFiles(dbPath);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    assert.equal((await lstat(dbPath)).mode & 0o777, 0o644);
  });
});

for (const suffix of suffixes) {
  test(`database permissions: refuses a non-file ${suffix || "database"}`, posix, async () => {
    await withTempHome("vscdb-directory-", async (home) => {
      const dbPath = path.join(home, "state.vscdb");
      await mkdir(dbPath + suffix, { mode: 0o700 });
      assert.throws(() => secureItemTableFiles(dbPath), refusal);
      assert.equal((await lstat(dbPath + suffix)).mode & 0o777, 0o700);
    });
  });

  for (const [name, operation] of [
    ["ensure", ensureItemTable],
    ["write", (db) => writeItemTableValue(db, "example", "replacement")],
    ["delete", (db) => deleteItemTableValue(db, "example")],
    ["transaction", (db) => applyItemTableWrites(db, [{ op: "set", key: "example", value: "replacement" }])],
  ]) {
    for (const dangling of [false, true]) {
      test(`database permissions: ${name} refuses a ${dangling ? "dangling" : "live"} ${suffix || "database"} symlink`, posix, async () => {
        await withTempHome("vscdb-link-", async (home) => {
          const dbPath = path.join(home, "state.vscdb");
          const outside = path.join(home, "outside.txt");
          await ensureItemTable(dbPath);
          await chmod(dbPath, 0o644);
          if (!dangling) {
            await writeFile(outside, "keep me");
            await chmod(outside, 0o644);
          }
          if (!suffix) await rm(dbPath);
          await symlink(outside, dbPath + suffix);
          await assert.rejects(operation(dbPath), refusal);
          assert.equal((await lstat(dbPath + suffix)).isSymbolicLink(), true);
          if (dangling) await assert.rejects(lstat(outside), { code: "ENOENT" });
          else {
            assert.equal(await readFile(outside, "utf8"), "keep me");
            assert.equal((await lstat(outside)).mode & 0o777, 0o644);
          }
        });
      });
    }
  }
}

test("database reads: follows a database symlink without changing permissions", posix, async () => {
  await withTempHome("vscdb-read-link-", async (home) => {
    const dbPath = path.join(home, "state.vscdb");
    const alias = path.join(home, "alias.vscdb");
    await ensureItemTable(dbPath);
    await writeItemTableValue(dbPath, "example", "original");
    await chmod(dbPath, 0o644);
    await symlink(dbPath, alias);
    assert.equal(await readItemTableValue(alias, "example"), "original");
    assert.equal((await lstat(dbPath)).mode & 0o777, 0o644);
    await rm(dbPath);
    assert.equal(await readItemTableValue(alias, "example"), "");
  });
});

test("database reads: does not require the file owner to match the current user", posix, async (t) => {
  await withTempHome("vscdb-read-owner-", async (home) => {
    const dbPath = path.join(home, "state.vscdb");
    await ensureItemTable(dbPath);
    await writeItemTableValue(dbPath, "example", "original");
    await chmod(dbPath, 0o644);
    const uid = process.getuid();
    const mocked = t.mock.method(process, "getuid", () => uid + 1);
    try {
      assert.equal(await readItemTableValue(dbPath, "example"), "original");
    } finally {
      mocked.mock.restore();
    }
    assert.equal((await lstat(dbPath)).mode & 0o777, 0o644);
  });
});
