import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { before, it } from "node:test";
import { removeUninstallPaths, windowsCleanupScript } from "../../lib/system/windows-uninstall.mjs";
import { POWERSHELL_TEST_ENV, warmPowerShell, withTempHome } from "../helpers.mjs";

before(async () => { await warmPowerShell(); });

function powershell(t, home) {
  const executable = process.env.NEXUS_TEST_PWSH || "pwsh";
  const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
    env: { ...process.env, ...POWERSHELL_TEST_ENV, HOME: home, USERPROFILE: home }, timeout: 10000, encoding: "utf8",
  });
  if (result.error?.code === "ENOENT") {
    t.skip("pwsh is not available");
    return null;
  }
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  t.diagnostic(`PowerShell ${result.stdout.trim()} executed`);
  return executable;
}

async function parentProcess(t, home) {
  const child = spawn(process.execPath, ["-e", 'process.on("message", () => process.exit(0)); process.send("ready"); setTimeout(() => process.exit(2), 20000);'], {
    env: { ...process.env, ...POWERSHELL_TEST_ENV, HOME: home, USERPROFILE: home }, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  t.after(() => child.kill());
  const exited = once(child, "exit");
  await once(child, "message");
  return { child, exit: async () => { child.send("exit"); assert.equal((await exited)[0], 0); } };
}

async function worker(t, executable, home, paths, pid, scheduledAt, cleanupDir = null) {
  const script = await windowsCleanupScript(paths, pid, scheduledAt, [path.join(home, ".nexus")], cleanupDir);
  if (cleanupDir) await writeFile(path.join(cleanupDir, "worker.ps1"), script);
  const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, ...POWERSHELL_TEST_ENV, HOME: home, USERPROFILE: home }, windowsHide: true, timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stdout = "";
  let stderr = "";
  const milestones = {};
  const waiting = new Promise((resolve) => { milestones.waiting = resolve; });
  const grace = new Promise((resolve) => { milestones.grace = resolve; });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes("Waiting for Nexus CLI to exit.")) milestones.waiting();
    if (stdout.includes("Nexus CLI exited; allowing the launcher to return.")) milestones.grace();
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = once(child, "close").then(([code, signal]) => {
    assert.equal(code, 0, `${signal ?? ""}\n${stdout}\n${stderr}`);
    return stdout;
  });
  done.catch(() => {});
  const waitFor = (milestone) => Promise.race([milestone, done.then(() => { throw new Error(`Worker exited before milestone: ${stdout}`); })]);
  return { done, waiting: () => waitFor(waiting), grace: () => waitFor(grace) };
}

async function seed(home) {
  const root = path.join(home, ".nexus");
  const cli = path.join(root, "cli");
  const launcher = path.join(home, ".local", "bin", "nexus.cmd");
  await mkdir(cli, { recursive: true });
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(path.join(cli, "old.node"), "old installation");
  await writeFile(launcher, "old launcher");
  return { root, cli, launcher, paths: [cli, root, launcher] };
}

it("PowerShell worker preserves a reinstall staged while the CLI PID is alive", async (t) => {
  await withTempHome("windows-worker-reinstall-", async (home) => {
    const executable = powershell(t, home);
    if (!executable) return;
    const { root, cli, launcher, paths } = await seed(home);
    const parent = await parentProcess(t, home);
    const cleanup = await worker(t, executable, home, paths, parent.child.pid, Date.now());
    await cleanup.waiting();
    assert.equal(parent.child.exitCode, null);
    assert.equal(existsSync(cli), true);
    const staged = path.join(root, "cli.download");
    await mkdir(staged);
    await writeFile(path.join(staged, "new.node"), "new installation");
    await writeFile(launcher, "new launcher");
    await parent.exit();
    assert.match(await cleanup.done, /Skipping cleanup because files changed/);
    assert.equal(await readFile(path.join(staged, "new.node"), "utf8"), "new installation");
    assert.equal(await readFile(launcher, "utf8"), "new launcher");
    assert.equal(existsSync(cli), true);
  });
});

it("PowerShell worker waits for a real PID then deletes owned paths without following symlinks", async (t) => {
  await withTempHome("windows worker 用户 & 50% [x] '-", async (home) => {
    const executable = powershell(t, home);
    if (!executable) return;
    const { root, cli, launcher, paths } = await seed(home);
    const foreign = path.join(home, ".local", "bin", "example-tool.cmd");
    const target = path.join(home, "keep-dir");
    await mkdir(target);
    await writeFile(foreign, "foreign launcher");
    await writeFile(path.join(target, "keep.txt"), "symlink target");
    await symlink(target, path.join(cli, "shared-link"), process.platform === "win32" ? "junction" : "dir");
    await chmod(path.join(cli, "old.node"), 0o444);
    const staging = path.join(home, "worker-staging");
    await mkdir(staging);
    const parent = await parentProcess(t, home);
    const cleanup = await worker(t, executable, home, paths, parent.child.pid, Date.now(), staging);
    await cleanup.waiting();
    assert.equal(parent.child.exitCode, null);
    assert.equal(existsSync(root), true);
    assert.equal(existsSync(launcher), true);
    await writeFile(path.join(target, "new.txt"), "outside the installation");
    await parent.exit();
    assert.doesNotMatch(await cleanup.done, /Skipping cleanup/);
    assert.equal(existsSync(root), false);
    assert.equal(existsSync(launcher), false);
    assert.equal(existsSync(path.dirname(launcher)), true);
    assert.equal(existsSync(staging), false);
    assert.equal(await readFile(foreign, "utf8"), "foreign launcher");
    assert.equal(await readFile(path.join(target, "keep.txt"), "utf8"), "symlink target");
    assert.equal(await readFile(path.join(target, "new.txt"), "utf8"), "outside the installation");
    t.diagnostic("Real child PID exited; owned paths removed; shared bin, foreign launcher and symlink target preserved");
  });
});

it("PowerShell worker preserves a replacement installation made during the launcher grace period", async (t) => {
  await withTempHome("windows-worker-grace-", async (home) => {
    const executable = powershell(t, home);
    if (!executable) return;
    const { root, cli, launcher, paths } = await seed(home);
    const parent = await parentProcess(t, home);
    const cleanup = await worker(t, executable, home, paths, parent.child.pid, Date.now());
    await cleanup.waiting();
    await parent.exit();
    await cleanup.grace();
    await rm(root, { recursive: true });
    await mkdir(cli, { recursive: true });
    await writeFile(path.join(cli, "new.node"), "replacement installation");
    await writeFile(launcher, "replacement launcher");
    assert.match(await cleanup.done, /Skipping cleanup because files changed/);
    assert.equal(await readFile(path.join(cli, "new.node"), "utf8"), "replacement installation");
    assert.equal(await readFile(launcher, "utf8"), "replacement launcher");
  });
});

for (const change of ["created", "modified"]) {
  it(`PowerShell worker recursively preserves ${change} files even when directory mtimes are old`, async (t) => {
    await withTempHome("windows-worker-deep-change-", async (home) => {
      const executable = powershell(t, home);
      if (!executable) return;
      const { root, cli, launcher, paths } = await seed(home);
      const parent = await parentProcess(t, home);
      const cleanup = await worker(t, executable, home, paths, parent.child.pid, Date.now());
      await cleanup.waiting();
      const file = path.join(cli, change === "created" ? "new.node" : "old.node");
      await writeFile(file, "new installation");
      const old = new Date("2000-01-01T00:00:00Z");
      if (change === "created" && process.platform === "win32") await utimes(file, old, old);
      await utimes(cli, old, old);
      await utimes(root, old, old);
      await parent.exit();
      assert.match(await cleanup.done, /Skipping cleanup because files changed/);
      assert.equal(await readFile(file, "utf8"), "new installation");
      assert.equal(await readFile(launcher, "utf8"), "old launcher");
    });
  });
}

it("PowerShell worker preserves all paths when only the launcher was replaced", async (t) => {
  await withTempHome("windows-worker-new-launcher-", async (home) => {
    const executable = powershell(t, home);
    if (!executable) return;
    const { cli, launcher, paths } = await seed(home);
    const parent = await parentProcess(t, home);
    const cleanup = await worker(t, executable, home, paths, parent.child.pid, Date.now());
    await cleanup.waiting();
    await writeFile(launcher, "new launcher");
    await parent.exit();
    assert.match(await cleanup.done, /Skipping cleanup because files changed/);
    assert.equal(await readFile(launcher, "utf8"), "new launcher");
    assert.equal(existsSync(cli), true);
  });
});

it("PowerShell worker protects a newly created data root when only a launcher was scheduled", async (t) => {
  await withTempHome("windows-worker-new-root-", async (home) => {
    const executable = powershell(t, home);
    if (!executable) return;
    const { root, cli, launcher } = await seed(home);
    await rm(root, { recursive: true });
    const parent = await parentProcess(t, home);
    const cleanup = await worker(t, executable, home, [launcher], parent.child.pid, Date.now());
    await cleanup.waiting();
    await mkdir(cli, { recursive: true });
    await writeFile(path.join(cli, "new.node"), "new installation");
    await parent.exit();
    assert.match(await cleanup.done, /Skipping cleanup because files changed/);
    assert.equal(await readFile(path.join(cli, "new.node"), "utf8"), "new installation");
    assert.equal(await readFile(launcher, "utf8"), "old launcher");
  });
});

it("a real PowerShell launcher failure is reported without claiming deferred removal", async (t) => {
  await withTempHome("windows-worker-launcher-failure-", async (home) => {
    const executable = powershell(t, home);
    if (!executable) return;
    const { root, launcher } = await seed(home);
    const result = await removeUninstallPaths(home, [root, launcher], {
      platform: "win32", env: { SystemRoot: path.join(home, "missing-system-root") },
      spawnProcess: (_file, args, options) => spawn(executable, args, {
        ...options, cwd: home, env: { ...process.env, ...POWERSHELL_TEST_ENV, HOME: home, USERPROFILE: home },
      }),
    });
    assert.deepEqual(result.deferred, []);
    assert.equal(result.failures.length, 2);
    assert.match(result.failures[0].message, /launcher failed \(exit 1\)/);
    assert.equal(existsSync(root), true);
    assert.equal(existsSync(launcher), true);
    t.diagnostic("Real PowerShell launcher exited 1; paths reported as removal failures, not scheduled");
  });
});

it("PowerShell worker removes unchanged future-dated files from the schedule-time snapshot", async (t) => {
  await withTempHome("windows-worker-future-", async (home) => {
    const executable = powershell(t, home);
    if (!executable) return;
    const { root, cli, launcher, paths } = await seed(home);
    const future = new Date("2099-01-01T00:00:00Z");
    await utimes(path.join(cli, "old.node"), future, future);
    await utimes(launcher, future, future);
    const parent = await parentProcess(t, home);
    const cleanup = await worker(t, executable, home, paths, parent.child.pid, Date.now());
    await cleanup.waiting();
    await parent.exit();
    assert.doesNotMatch(await cleanup.done, /Skipping cleanup/);
    assert.equal(existsSync(root), false);
    assert.equal(existsSync(launcher), false);
    t.diagnostic("Unchanged future-dated CLI file and launcher removed after parent exit");
  });
});

it("PowerShell worker detects a same-size backdated modification despite another future-dated file", async (t) => {
  await withTempHome("windows-worker-future-change-", async (home) => {
    const executable = powershell(t, home);
    if (!executable) return;
    const { cli, launcher, paths } = await seed(home);
    const futureFile = path.join(cli, "future.node");
    const future = new Date("2099-01-01T00:00:00Z");
    await writeFile(futureFile, "future-dated fixture");
    await utimes(futureFile, future, future);
    const parent = await parentProcess(t, home);
    const cleanup = await worker(t, executable, home, paths, parent.child.pid, Date.now());
    await cleanup.waiting();
    const file = path.join(cli, "old.node");
    await writeFile(file, "new installation");
    const old = new Date("2000-01-01T00:00:00Z");
    await utimes(file, old, old);
    await parent.exit();
    assert.match(await cleanup.done, /Skipping cleanup because files changed/);
    assert.equal(await readFile(file, "utf8"), "new installation");
    assert.equal(existsSync(launcher), true);
  });
});
