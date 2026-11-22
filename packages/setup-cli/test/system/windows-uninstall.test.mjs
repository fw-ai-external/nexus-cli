import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { removeUninstallPaths, windowsCleanupScript } from "../../lib/system/windows-uninstall.mjs";
import { runUninstallCommand } from "../../lib/cli/commands/global.mjs";
import { withIsolatedProfileEnv, withTempHome } from "../helpers.mjs";

function fakeSpawn(mode = "spawn") {
  const calls = [];
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const child = new EventEmitter();
  child.unref = () => { child.unreferenced = true; };
  child.kill = () => { child.killed = true; };
  const spawnProcess = (...args) => {
    calls.push(args);
    started();
    if (mode === "throw") throw new Error("spawn denied");
    queueMicrotask(() => {
      if (mode === "error") child.emit("error", new Error("PowerShell not found"));
      else {
        child.emit("spawn");
        if (mode === "spawn") child.emit("close", 0, null);
        else if (mode === "nonzero") child.emit("close", 1, null);
        else if (mode === "signal") child.emit("close", null, "SIGTERM");
      }
    });
    return child;
  };
  return { calls, child, spawnProcess, ready };
}

async function decodeCall(call) {
  const launcher = Buffer.from(call[1].at(-1), "base64").toString("utf16le");
  const config = launcher.match(/FromBase64String\('([^']+)'\)/)[1];
  const launchConfig = JSON.parse(Buffer.from(config, "base64").toString("utf8"));
  const script = await readFile(launchConfig.script, "utf8");
  const encoded = script.match(/FromBase64String\('([^']+)'\)/)[1];
  return { launcher, launchConfig, script, payload: JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) };
}

async function seed(home) {
  const cli = path.join(home, ".nexus", "cli");
  const launcher = path.join(home, ".local", "bin", "nexus.cmd");
  const config = path.join(home, ".nexus", "config.json");
  await mkdir(cli, { recursive: true });
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(path.join(cli, "example.node"), "mock loaded DLL");
  await writeFile(config, "{}");
  await writeFile(launcher, 'node "%USERPROFILE%\\.nexus\\cli\\packages\\setup-cli\\bin\\nexus.mjs" %*\r\n');
  return { cli, launcher, config, paths: [cli, launcher, config, path.join(home, ".nexus")] };
}

describe("Windows uninstall cleanup", () => {
  it("defers only process-owned paths, preserving the shared bin and PATH", async () => {
    await withTempHome("windows uninstall 用户 $ & % [x] '", async (home) => {
      const { cli, launcher, config, paths } = await seed(home);
      const sibling = path.join(home, ".local", "bin", "example-tool.cmd");
      await writeFile(sibling, "foreign launcher");
      const beforePath = process.env.PATH;
      const fake = fakeSpawn();
      const result = await removeUninstallPaths(home, paths, {
        platform: "win32", spawnProcess: fake.spawnProcess, env: { SystemRoot: "C:\\Windows" }, pid: 1234,
      });
      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.deferred, [cli, launcher, path.join(home, ".nexus")]);
      assert.equal(existsSync(config), false);
      assert.equal(existsSync(cli), true);
      assert.equal(existsSync(launcher), true);
      assert.equal(await readFile(sibling, "utf8"), "foreign launcher");
      assert.equal(process.env.PATH, beforePath);
      assert.equal(fake.calls.length, 1);
      const [executable, args, options] = fake.calls[0];
      assert.equal(executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      assert.deepEqual(args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
      assert.deepEqual(options, { detached: false, windowsHide: true, stdio: "ignore", cwd: "C:\\Windows" });
      assert.equal(fake.child.unreferenced, undefined);
      const { script, payload, launcher: launcherScript, launchConfig } = await decodeCall(fake.calls[0]);
      assert.equal(launchConfig.executable, executable);
      assert.match(launcherScript, /Start-Process -FilePath \$config.executable -WindowStyle Hidden/);
      assert.match(launcherScript, /-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand',\$worker/);
      assert.match(launcherScript, /ReadAllText\(\$config.script/);
      assert.ok(args.at(-1).length < 8000, "the launcher must fit the Windows command-line limit");
      assert.deepEqual(payload, {
        pid: 1234, paths: [path.join(home, ".nexus"), launcher],
        scheduledAt: payload.scheduledAt, creationTimes: process.platform === "win32", snapshots: payload.snapshots,
        cleanupDir: path.dirname(launchConfig.script),
      });
      assert.deepEqual(payload.snapshots.map((entry) => entry.path), [path.join(home, ".nexus"), launcher]);
      for (const entry of payload.snapshots) assert.match(entry.signature, /^[a-f0-9]{64}$/);
      assert.equal(Number.isFinite(payload.scheduledAt), true);
      assert.equal(script.includes(home), false, "paths are data, never PowerShell source");
      assert.match(script, /WaitForExit\(120000\)/);
      assert.match(script, /Start-Sleep -Milliseconds 1500/);
      assert.match(script, /\$attempt -lt 20/);
      assert.match(script, /ReparsePoint/);
      assert.doesNotMatch(script, /SetEnvironmentVariable|HKCU|Invoke-Expression/);
    });
  });

  for (const platform of ["linux", "darwin"]) {
    it(`keeps ${platform} removal synchronous`, async () => {
      await withTempHome("uninstall-posix-", async (home) => {
        const { paths } = await seed(home);
        const fake = fakeSpawn();
        assert.deepEqual(await removeUninstallPaths(home, paths, { platform, spawnProcess: fake.spawnProcess }), { failures: [], deferred: [] });
        assert.equal(existsSync(path.join(home, ".nexus")), false);
        assert.equal(fake.calls.length, 0);
      });
    });
  }

  it("does not start a helper when no process-owned files exist", async () => {
    await withTempHome("uninstall-empty-", async (home) => {
      const fake = fakeSpawn();
      assert.deepEqual(await removeUninstallPaths(home, [path.join(home, ".nexus")], {
        platform: "win32", spawnProcess: fake.spawnProcess,
      }), { failures: [], deferred: [] });
      assert.equal(fake.calls.length, 0);
    });
  });

  for (const mode of ["throw", "error", "nonzero", "signal"]) {
    it(`reports cleanup startup ${mode} without removing the launcher`, async () => {
      await withTempHome("uninstall-spawn-error-", async (home) => {
        const { paths, launcher } = await seed(home);
        const fake = fakeSpawn(mode);
        const result = await removeUninstallPaths(home, paths, { platform: "win32", spawnProcess: fake.spawnProcess });
        assert.deepEqual(result.deferred, []);
        assert.equal(result.failures.length, 3);
        assert.match(result.failures[0].message, /Could not schedule removal after exit/);
        assert.equal(existsSync(launcher), true);
      });
    });
  }

  it("bounds the wait for a launcher that starts but never exits", async (t) => {
    await withTempHome("uninstall-start-timeout-", async (home) => {
      const fake = fakeSpawn("hang");
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const pending = removeUninstallPaths(home, [path.join(home, ".nexus")], {
        platform: "win32", spawnProcess: fake.spawnProcess, exists: () => true,
      });
      await fake.ready;
      t.mock.timers.tick(5000);
      const result = await pending;
      assert.equal(fake.child.killed, true);
      assert.match(result.failures[0].message, /Timed out starting/);
    });
  });

  it("does not report scheduling success until the launcher exits successfully", async () => {
    await withTempHome("uninstall-launcher-exit-", async (home) => {
      const fake = fakeSpawn("hang");
      let settled = false;
      const pending = removeUninstallPaths(home, [path.join(home, ".nexus")], {
        platform: "win32", spawnProcess: fake.spawnProcess, exists: () => true,
      }).then((result) => { settled = true; return result; });
      await fake.ready;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "the spawn event is not a successful launch result");
      fake.child.emit("close", 0, null);
      assert.deepEqual(await pending, { failures: [], deferred: [path.join(home, ".nexus")] });
    });
  });

  for (const failRemoval of [false, true]) {
    it(`uninstall reports ${failRemoval ? "a real unrelated removal error" : "successful scheduling without exit errors"}`, async (t) => {
      await withTempHome("uninstall-summary-", async (home) => {
        const { launcher } = await seed(home);
        const priorExitCode = process.exitCode;
        const output = [];
        t.mock.method(console, "log", (...args) => output.push(args.join(" ")));
        t.mock.method(console, "error", (...args) => output.push(args.join(" ")));
        const fake = fakeSpawn();
        try {
          process.exitCode = undefined;
          await withIsolatedProfileEnv(home, () => runUninstallCommand({ home, force: true }, {
            cleanupPaths: (base, paths) => removeUninstallPaths(base, paths, {
              platform: "win32", spawnProcess: fake.spawnProcess,
              remove: async (file, options) => {
                if (failRemoval && file === path.join(home, ".nexus", "config.json")) throw new Error("unrelated removal denied");
                return rm(file, options);
              },
            }),
          }));
          assert.equal(process.exitCode ?? 0, failRemoval ? 1 : 0);
          assert.match(output.join("\n"), /scheduled for removal after this process exits/);
          if (failRemoval) assert.match(output.join("\n"), /unrelated removal denied/);
          else assert.doesNotMatch(output.join("\n"), /removal errors/);
          assert.equal(existsSync(launcher), true);
        } finally {
          process.exitCode = priorExitCode;
        }
      });
    });
  }

  it("encodes arbitrary path characters as JSON data", async () => {
    await withTempHome("uninstall encoded 用户 & 50% ", async (home) => {
      const paths = [path.join(home, ".nexus"), path.join(home, "[x]';exit 9;#")];
      const script = await windowsCleanupScript(paths, 4321, 1000);
      assert.equal(script.includes(paths[1]), false);
      const encoded = script.match(/FromBase64String\('([^']+)'\)/)[1];
      assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")), {
        paths, pid: 4321, scheduledAt: 1000, creationTimes: process.platform === "win32",
        snapshots: paths.map((file) => ({ path: file, signature: null })),
        cleanupDir: null,
      });
    });
  });
});
