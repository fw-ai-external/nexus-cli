import assert from "node:assert/strict";
import { constants } from "node:fs";
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { writeFileAtomic, writeFileAtomicSync } from "../../lib/io/atomic-write.mjs";
import { copyPrivateTree, ensurePrivateParent, restoreTreeModes } from "../../lib/io/private-files.mjs";

let home;
let previous;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "private-files-"));
  previous = process.env.HOME;
  process.env.HOME = home;
});
afterEach(async () => {
  process.env.HOME = previous;
  await rm(home, { recursive: true, force: true });
});

const posix = { skip: process.platform === "win32" };

test("async temps are exclusively opened with private mode before writing", posix, async (t) => {
  const original = fs.open;
  let checked = false;
  const mocked = t.mock.method(fs, "open", async (file, flags, mode) => {
    const handle = await original(file, flags, mode);
    assert.ok(flags & constants.O_EXCL);
    assert.ok(flags & constants.O_NOFOLLOW);
    assert.equal(mode, 0o600);
    assert.equal((await handle.stat()).mode & 0o777, 0o600);
    assert.equal((await handle.stat()).size, 0);
    checked = true;
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await writeFileAtomic(path.join(home, "backup.json"), "example", { mode: 0o600 });
    assert.equal(checked, true);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const write of [writeFileAtomic, writeFileAtomicSync]) {
  test(`${write.name} replaces a symlink leaf privately`, posix, async () => {
    const outside = path.join(home, "outside");
    await writeFile(outside, "unchanged");
    const dir = path.join(home, "private", "nested");
    const target = path.join(dir, "cache.json");
    ensurePrivateParent(target, { root: path.join(home, "private") });
    await write(target, "", { mode: 0o600 });
    for (const parent of [path.dirname(dir), dir]) assert.equal((await lstat(parent)).mode & 0o777, 0o700);
    await rm(target);
    await symlink(outside, target);
    await write(target, "replacement", { mode: 0o600 });
    assert.equal((await lstat(target)).isSymbolicLink(), false);
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
    assert.equal(await readFile(outside, "utf8"), "unchanged");
    assert.deepEqual(await readdir(dir), ["cache.json"]);
  });

  test(`${write.name} allows trusted symlinked parents without chmodding them`, posix, async () => {
    const outside = path.join(home, "outside");
    await mkdir(path.join(outside, "nested"), { recursive: true });
    await symlink(outside, path.join(home, "private"), "dir");
    const target = path.join(home, "private", "nested", "secret");
    await chmod(home, 0o770);
    await chmod(outside, 0o775);
    await write(target, "example", { mode: 0o600 });
    assert.equal(await readFile(path.join(outside, "nested", "secret"), "utf8"), "example");
    assert.equal((await lstat(home)).mode & 0o777, 0o770);
    assert.equal((await lstat(outside)).mode & 0o777, 0o775);
  });
}

test("private validation starts at the Nexus directory, below trusted symlinked ancestors", posix, async () => {
  const outside = path.join(home, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(home, "config"), "dir");
  await chmod(home, 0o770);
  await chmod(outside, 0o775);
  const root = path.join(home, "config", "nexus");
  const file = path.join(root, "nested", "backup.json");
  ensurePrivateParent(file, { root });
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  assert.equal((await lstat(home)).mode & 0o777, 0o770);
  assert.equal((await lstat(outside)).mode & 0o777, 0o775);
  await rm(root, { recursive: true });
  await symlink(outside, root, "dir");
  assert.throws(() => ensurePrivateParent(file, { root }), /Cannot secure/);
  assert.throws(() => ensurePrivateParent(path.join(home, "elsewhere", "file"), { root }), /Invalid private directory boundary/);
});

test("owned writable parents are tightened, foreign parents are not chmodded", posix, async () => {
  const directory = path.join(home, "private");
  await mkdir(directory);
  await chmod(directory, 0o777);
  ensurePrivateParent(path.join(directory, "secret"));
  assert.equal((await lstat(directory)).mode & 0o022, 0);
  await chmod(directory, 0o777);
  assert.throws(() => ensurePrivateParent(path.join(directory, "secret"), { root: directory, uid: process.getuid() + 1 }), /Cannot secure/);
  assert.equal((await lstat(directory)).mode & 0o777, 0o777);
});

test("existing private directory read and execute bits are cleared without changing ancestors", posix, async () => {
  const directory = path.join(home, "private");
  await mkdir(directory);
  await chmod(home, 0o775);
  for (const mode of [0o755, 0o711, 0o750, 0o777, 0o700]) {
    await chmod(directory, mode);
    ensurePrivateParent(path.join(directory, "secret"));
    assert.equal((await lstat(directory)).mode & 0o7777, 0o700);
    assert.equal((await lstat(home)).mode & 0o777, 0o775);
  }
});

test("Windows parent checks leave POSIX ownership and modes alone", async () => {
  const directory = path.join(home, "private");
  await mkdir(directory);
  await chmod(directory, 0o777);
  ensurePrivateParent(path.join(directory, "secret"), { platform: "win32", uid: -1 });
  if (process.platform !== "win32") assert.equal((await lstat(directory)).mode & 0o777, 0o777);
});

test("private tree backups preserve content including empty files and never overwrite", posix, async () => {
  const source = path.join(home, "source");
  await mkdir(path.join(source, "nested"), { recursive: true });
  await chmod(home, 0o770);
  await chmod(source, 0o775);
  await writeFile(path.join(source, "nested", "profile.json"), "example");
  await writeFile(path.join(source, "empty"), "");
  const destination = path.join(home, "backups", "snapshot");
  await copyPrivateTree(source, destination);
  assert.equal((await lstat(home)).mode & 0o777, 0o770);
  assert.equal((await lstat(source)).mode & 0o777, 0o775);
  for (const parent of [path.dirname(destination), destination, path.join(destination, "nested")]) {
    assert.equal((await lstat(parent)).mode & 0o777, 0o700);
  }
  assert.equal((await lstat(path.join(destination, "nested", "profile.json"))).mode & 0o777, 0o600);
  assert.equal(await readFile(path.join(destination, "nested", "profile.json"), "utf8"), "example");
  assert.equal(await readFile(path.join(destination, "empty"), "utf8"), "");
  await assert.rejects(copyPrivateTree(source, destination), { code: "EEXIST" });
  await symlink(path.join(source, "empty"), path.join(source, "link"));
  const linkedBackup = path.join(home, "linked-backup");
  await copyPrivateTree(source, linkedBackup);
  assert.equal((await lstat(path.join(linkedBackup, "link"))).isSymbolicLink(), true);
  assert.equal(await readFile(path.join(linkedBackup, "link"), "utf8"), "");
});

test("a linked source root can be followed but private destination links are never followed", posix, async () => {
  const source = path.join(home, "source");
  await mkdir(source);
  await writeFile(path.join(source, "profile.json"), "example");
  const linked = path.join(home, "linked");
  await symlink(source, linked, "dir");
  await assert.rejects(copyPrivateTree(linked, path.join(home, "rejected")), /symbolic root/);
  const backup = path.join(home, "backup");
  await copyPrivateTree(linked, backup, { sourceSymlink: "follow" });
  assert.equal((await lstat(backup)).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(backup, "profile.json"), "utf8"), "example");
  const destination = path.join(home, "destination");
  await symlink(source, destination, "dir");
  await assert.rejects(copyPrivateTree(linked, destination, { sourceSymlink: "follow" }), { code: "EEXIST" });
  assert.equal(await readFile(path.join(source, "profile.json"), "utf8"), "example");
});

test("restored modes use tree entries, never metadata paths or symlink targets", posix, async () => {
  const source = path.join(home, "source");
  await mkdir(source);
  await chmod(source, 0o751);
  await writeFile(path.join(source, "empty"), "");
  await chmod(path.join(source, "empty"), 0o640);
  const outside = path.join(home, "outside");
  await writeFile(outside, "unchanged");
  await chmod(outside, 0o644);
  await symlink(outside, path.join(source, "link"));
  const destination = path.join(home, "backup");
  const modes = await copyPrivateTree(source, destination);
  assert.equal((await lstat(destination)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(destination, "empty"))).mode & 0o777, 0o600);
  await restoreTreeModes(destination, [...modes, ["../outside", 0o777], ["link", 0o777], ["empty", -1]]);
  assert.equal((await lstat(destination)).mode & 0o777, 0o751);
  assert.equal((await lstat(path.join(destination, "empty"))).mode & 0o777, 0o640);
  assert.equal((await lstat(outside)).mode & 0o777, 0o644);
  assert.equal(await readFile(outside, "utf8"), "unchanged");
});
