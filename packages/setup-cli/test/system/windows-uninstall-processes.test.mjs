import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { before, describe, it } from "node:test";
import { assertWindowsUninstallSafe, findManagedCliProcesses } from "../../lib/system/windows-uninstall-processes.mjs";
import { runUninstallCommand } from "../../lib/cli/commands/global.mjs";
import { POWERSHELL_TEST_ENV, warmPowerShell, withTempHome } from "../helpers.mjs";

before(async () => { await warmPowerShell(); });

const home = "C:\\Users\\example 用户 & ' [x]";
const cli = path.win32.join(home, ".nexus", "cli");
const own = { pid: 100, ppid: 101 };
const processRow = (pid, values = {}) => ({
  ProcessId: pid, ParentProcessId: 101, Name: "node.exe",
  ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
  CommandLine: `node "${cli}\\packages\\setup-cli\\bin\\nexus.mjs" status --json`,
  ModulePaths: [], ModuleInspectionFailed: false,
  ...values,
});
const listing = (rows) => async () => ({ stdout: JSON.stringify(rows) });
const options = (rows) => ({ platform: "win32", ...own, run: listing(rows) });

function powershellListing(t, tempHome, rows, expectedCandidates, expectedModules = expectedCandidates) {
  const query = { executed: false };
  query.run = async (_executable, args, settings) => {
    const fixture = Buffer.from(JSON.stringify(rows), "utf8").toString("base64");
    const preamble = `
      $fixture = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${fixture}')) | ConvertFrom-Json
      $global:queryAudit = @{ calls = 0; ids = [Collections.Generic.List[int]]::new(); modules = [Collections.Generic.List[int]]::new() }
      function Get-CimInstance {
        [CmdletBinding()] param([string]$ClassName, [int]$OperationTimeoutSec)
        $fixture
      }
      function Get-Process {
        [CmdletBinding()] param([int[]]$Id)
        $global:queryAudit.calls++
        $global:queryAudit.ids.AddRange($Id)
        if ($fixture.TestLookupError -contains $true) { throw 'example lookup failure' }
        foreach ($processId in $Id) {
          $record = $fixture | Where-Object { $_.ProcessId -eq $processId }
          if ($record.TestMissing) { continue }
          $entry = [PSCustomObject]@{ Id = $processId; Record = $record }
          $entry | Add-Member -MemberType ScriptProperty -Name Modules -Value {
            $global:queryAudit.modules.Add([int]$this.Id)
            if ($this.Record.ModuleInspectionFailed) { throw 'example module access denied' }
            return ,@($this.Record.ModulePaths | ForEach-Object { [PSCustomObject]@{ FileName = $_ } })
          } -PassThru
        }
      }
    `;
    const script = preamble + Buffer.from(args.at(-1), "base64").toString("utf16le")
      + "\n[Console]::Error.WriteLine('QUERY_AUDIT=' + ($global:queryAudit | ConvertTo-Json -Compress))";
    const start = performance.now();
    const result = spawnSync(process.env.NEXUS_TEST_PWSH || "pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      encoding: "utf8", timeout: settings.timeout, env: { ...process.env, ...POWERSHELL_TEST_ENV, HOME: tempHome, USERPROFILE: tempHome },
    });
    if (result.error?.code === "ENOENT") {
      t.skip("pwsh is not available");
      return { stdout: "[]" };
    }
    query.executed = true;
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const audit = JSON.parse(result.stderr.match(/QUERY_AUDIT=([^\r\n]+)/)?.[1] ?? "null");
    assert.ok(audit, result.stderr);
    assert.equal(audit.calls, expectedCandidates.length ? 1 : 0);
    assert.deepEqual(audit.ids.sort((a, b) => a - b), expectedCandidates);
    assert.deepEqual(audit.modules.sort((a, b) => a - b), expectedModules);
    t.diagnostic(`PowerShell query: ${Math.round(performance.now() - start)} ms including startup; ${rows.length} CIM records, ${expectedCandidates.length} candidates`);
    return { stdout: result.stdout };
  };
  return query;
}

describe("Windows uninstall process preflight", () => {
  it("detects a managed CLI child and identifies its Desktop parent", async () => {
    const rows = [processRow(200, { ParentProcessId: 300 }), processRow(300, {
      Name: "nexus-desktop.exe", ExecutablePath: "C:\\Apps\\nexus-desktop.exe", CommandLine: null,
    })];
    assert.deepEqual(findManagedCliProcesses(home, rows, own), [
      { pid: 200, name: "node.exe", parentPid: 300, desktop: true },
    ]);
    await assert.rejects(assertWindowsUninstallSafe(home, options(rows)), (error) => {
      assert.match(error.message, /node\.exe \(PID 200; Nexus Desktop\)/);
      assert.match(error.message, /Quit Nexus Desktop.*rerun `nexus uninstall`/);
      assert.doesNotMatch(error.message, /status --json|Program Files/);
      return true;
    });
  });

  it("matches managed executables even without a command line and never prints arguments", async () => {
    const rows = [processRow(201, { CommandLine: null, ExecutablePath: `${cli}\\node.exe` }),
      processRow(202, { CommandLine: `node "${cli}\\bin\\nexus.mjs" --example-option=not-for-display` })];
    await assert.rejects(assertWindowsUninstallSafe(home, options(rows)), (error) => {
      assert.match(error.message, /PID 201/);
      assert.match(error.message, /PID 202/);
      assert.match(error.message, /Stop the listed processes, then rerun/);
      assert.doesNotMatch(error.message, /Nexus Desktop|not-for-display/);
      return true;
    });
  });

  it("detects a persistent Desktop helper whose only managed-CLI reference is its loaded DLL", async () => {
    const rows = [processRow(200, { ParentProcessId: 300,
      CommandLine: 'node "C:\\Apps\\Nexus\\resources\\node\\signin-helper.mjs"',
      ModulePaths: [`${cli}\\packages\\setup-cli\\node_modules\\example\\keyring.node`],
    }), processRow(300, { Name: "nexus-desktop.exe", ExecutablePath: "C:\\Apps\\nexus-desktop.exe", CommandLine: null })];
    await assert.rejects(assertWindowsUninstallSafe(home, options(rows)), /node\.exe \(PID 200; Nexus Desktop\)/);
    assert.deepEqual(findManagedCliProcesses(home, rows, own).map((row) => row.pid), [200]);
    rows[0].ModulePaths = [`${cli}.previous\\keyring.node`];
    await assertWindowsUninstallSafe(home, options(rows));
  });

  it("fails closed for Desktop children whose modules cannot be inspected, but excludes our own PID", async () => {
    const row = processRow(200, { ParentProcessId: 300, CommandLine: 'node "C:\\Apps\\signin-helper.mjs"', ModuleInspectionFailed: true });
    const desktop = processRow(300, { Name: "nexus-desktop.exe", ExecutablePath: null, CommandLine: null });
    await assert.rejects(assertWindowsUninstallSafe(home, options([row, desktop])), /could not inspect.*loaded modules/);
    await assertWindowsUninstallSafe(home, options([{ ...row, ProcessId: own.pid }, desktop]));
  });

  it("ignores inaccessible plain Node candidates, but still detects their known managed modules", async () => {
    const row = processRow(200, { CommandLine: null, ModuleInspectionFailed: true });
    await assertWindowsUninstallSafe(home, options([row]));
    await assert.rejects(assertWindowsUninstallSafe(home, options([{ ...row, ModulePaths: [`${cli}\\example.node`] }])), /PID 200/);
    await assertWindowsUninstallSafe(home, options([{ ...row, ProcessId: own.ppid, Name: "cmd.exe", CommandLine: `cmd /c "${cli}\\nexus.cmd"` }]));
  });

  it("ignores only the parent's command line, not its managed executable or modules", async () => {
    const parent = processRow(own.ppid, { Name: "cmd.exe" });
    await assertWindowsUninstallSafe(home, options([parent]));
    for (const values of [{ ExecutablePath: `${cli}\\example.exe` }, { ModulePaths: [`${cli}\\example.node`] }]) {
      const rows = [{ ...parent, ...values }];
      assert.deepEqual(findManagedCliProcesses(home, rows, own).map((row) => row.pid), [own.ppid]);
      await assert.rejects(assertWindowsUninstallSafe(home, options(rows)), /cmd\.exe \(PID 101\)/);
    }
  });

  it("runs the actual PowerShell query against a mocked process and module listing", async (t) => {
    await withTempHome("uninstall-query-", async (tempHome) => {
      const rows = [processRow(200, { ParentProcessId: 300,
        CommandLine: 'node "C:\\Apps\\Nexus\\node\\signin-helper.mjs"',
        ModulePaths: [`${cli}\\packages\\setup-cli\\node_modules\\example\\keyring.node`],
      }), processRow(300, { Name: "nexus-desktop.exe", CommandLine: null, ExecutablePath: "C:\\Apps\\nexus-desktop.exe" })];
      const query = powershellListing(t, tempHome, rows, [200, 300]);
      const error = await assertWindowsUninstallSafe(home, { ...options(rows), run: query.run }).then(() => null, (error) => error);
      if (query.executed) {
        assert.ok(error instanceof Error, "the loaded module must block uninstall");
        assert.match(error.message, /node\.exe \(PID 200; Nexus Desktop\)/);
        rows[0].ModulePaths = [];
        await assertWindowsUninstallSafe(home, { ...options(rows), run: query.run });
        t.diagnostic("Actual PowerShell query found a Desktop helper through its managed CLI module, not argv");
      }
    });
  });

  it("batches only CIM-selected candidates and never reads unrelated or own modules", async (t) => {
    await withTempHome("uninstall-candidates-", async (tempHome) => {
      const unrelated = (pid, values = {}) => processRow(pid, { Name: "example.exe", CommandLine: null, ExecutablePath: null, ModuleInspectionFailed: true, ...values });
      const rows = Array.from({ length: 200 }, (_, i) => unrelated(1000 + i));
      rows.push(processRow(own.pid, { ModuleInspectionFailed: true }), processRow(own.ppid, { Name: "cmd.exe" }),
        unrelated(201, { Name: "node", ModuleInspectionFailed: false }),
        unrelated(202, { Name: "NODE.EXE", ModuleInspectionFailed: false }),
        unrelated(203, { Name: "nexus-desktop.exe", ModuleInspectionFailed: false }),
        unrelated(204, { ParentProcessId: 203, ModuleInspectionFailed: false }),
        unrelated(205, { ExecutablePath: `${cli.toUpperCase().replaceAll("\\", "/")}/example.exe`, ModuleInspectionFailed: false }),
        unrelated(206, { CommandLine: `example --require="${cli}\\example.mjs"`, ModuleInspectionFailed: false }),
        unrelated(207, { ExecutablePath: `${cli}.previous\\example.exe`, CommandLine: `example "${cli}-other\\example.mjs"` }));
      const query = powershellListing(t, tempHome, rows, [101, 201, 202, 203, 204, 205, 206]);
      const error = await assertWindowsUninstallSafe(home, { ...options(rows), run: query.run }).then(() => null, (error) => error);
      if (query.executed) {
        assert.match(error?.message ?? "", /PID 205/);
        assert.match(error.message, /PID 206/);
        assert.doesNotMatch(error.message, /could not inspect/);
      }
    });
  });

  it("does not call Get-Process at all when CIM has no candidates", async (t) => {
    await withTempHome("uninstall-no-candidates-", async (tempHome) => {
      const rows = [processRow(200, { Name: "example.exe", ExecutablePath: null, CommandLine: null, ModuleInspectionFailed: true })];
      const query = powershellListing(t, tempHome, rows, []);
      await assertWindowsUninstallSafe(home, { ...options(rows), run: query.run });
    });
  });

  for (const failure of ["modules", "missing", "lookup"]) {
    it(`fails closed on candidate ${failure} errors in the actual query`, async (t) => {
      await withTempHome("uninstall-candidate-error-", async (tempHome) => {
        const rows = [processRow(200, { Name: "nexus-desktop.exe", CommandLine: null, ModuleInspectionFailed: failure === "modules",
          TestMissing: failure === "missing", TestLookupError: failure === "lookup" })];
        const query = powershellListing(t, tempHome, rows, [200], failure === "modules" ? [200] : []);
        const error = await assertWindowsUninstallSafe(home, { ...options(rows), run: query.run }).then(() => null, (error) => error);
        if (query.executed) assert.match(error?.message ?? "", /could not inspect a candidate process's loaded modules/);
      });
    });
  }

  it("allows an inaccessible plain Node process in the actual PowerShell query", async (t) => {
    await withTempHome("uninstall-other-node-", async (tempHome) => {
      const rows = [processRow(200, { CommandLine: null, ModuleInspectionFailed: true })];
      const query = powershellListing(t, tempHome, rows, [200]);
      await assertWindowsUninstallSafe(home, { ...options(rows), run: query.run });
    });
  });

  it("still inspects the parent's modules while ignoring its command line in the actual query", async (t) => {
    await withTempHome("uninstall-parent-modules-", async (tempHome) => {
      const rows = [processRow(own.ppid, { Name: "cmd.exe", ModulePaths: [`${cli}\\example.node`] })];
      const query = powershellListing(t, tempHome, rows, [own.ppid]);
      const error = await assertWindowsUninstallSafe(home, { ...options(rows), run: query.run }).then(() => null, (error) => error);
      if (query.executed) assert.match(error?.message ?? "", /cmd\.exe \(PID 101\)/);
      rows[0].ModulePaths = [];
      await assertWindowsUninstallSafe(home, { ...options(rows), run: query.run });
    });
  });

  it("accepts case and separator differences and quoted or equals-delimited arguments", () => {
    const root = cli.toUpperCase().replaceAll("\\", "/");
    const rows = [processRow(201, { CommandLine: `node --require="${root}/example.mjs"` }),
      processRow(202, { ExecutablePath: `${root}/node.exe`, CommandLine: null })];
    assert.deepEqual(findManagedCliProcesses(home, rows, own).map((row) => row.pid), [201, 202]);
  });

  it("supports UNC homes", () => {
    const unc = "\\\\example-server\\example-share\\example 用户";
    const rows = [processRow(201, { CommandLine: `node "${unc}\\.nexus\\cli\\bin\\nexus.mjs"` })];
    assert.equal(findManagedCliProcesses(unc, rows, own).length, 1);
  });

  it("excludes ourselves, our parent, unrelated paths, and sibling directory prefixes", async () => {
    const rows = [processRow(100), processRow(101),
      processRow(201, { CommandLine: `node "${cli}.previous\\bin\\nexus.mjs"` }),
      processRow(202, { CommandLine: `node "${cli}-other\\bin\\nexus.mjs"` }),
      processRow(203, { CommandLine: 'node "C:\\other\\nexus.mjs"' }),
      processRow(204, { CommandLine: null, ExecutablePath: null }),
      processRow(205, { ExecutablePath: `${cli}.download\\node.exe`, CommandLine: null })];
    assert.deepEqual(findManagedCliProcesses(home, rows, own), []);
    await assertWindowsUninstallSafe(home, options(rows));
    await assertWindowsUninstallSafe(home, options([]));
  });

  it("does not inspect processes on other platforms", async () => {
    for (const platform of ["linux", "darwin"]) {
      await assertWindowsUninstallSafe(home, { platform, run: () => assert.fail("must not query") });
    }
  });

  it("uses a fixed, hidden, bounded system PowerShell query, not a shell or interpolated paths", async () => {
    await assertWindowsUninstallSafe(home, { platform: "win32", env: { SystemRoot: "C:\\Windows" },
      run: async (executable, args, settings) => {
        assert.equal(executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
        const script = Buffer.from(args[3], "base64").toString("utf16le");
        assert.match(script, /Get-CimInstance Win32_Process -OperationTimeoutSec 3 -ErrorAction Stop/);
        assert.match(script, /OutputEncoding.*UTF8Encoding/);
        assert.match(script, /Get-Process -Id @\(\$candidates.Keys\)/);
        assert.match(script, /StartsWith\(\$root, \[StringComparison\]::OrdinalIgnoreCase\)/);
        assert.equal(script.includes(home), false);
        assert.equal(settings.timeout, 15000);
        assert.equal(settings.windowsHide, true);
        assert.equal(settings.encoding, "utf8");
        assert.equal(settings.maxBuffer, 4 * 1024 * 1024);
        assert.equal(settings.cwd, "C:\\Windows");
        assert.equal(settings.shell, undefined);
        return { stdout: "\uFEFF[]" };
      },
    });
  });

  for (const failure of ["spawn", "timeout", "buffer", "invalid JSON", "empty", "invalid rows", "object"]) {
    it(`fails closed on ${failure} without exposing raw query output`, async () => {
      const run = async () => {
        if (["spawn", "timeout", "buffer"].includes(failure)) throw new Error("private-query-details");
        return { stdout: failure === "empty" ? "" : failure === "invalid rows" ? '[{"Name":"private-query-details"}]'
          : failure === "object" ? "{}" : "private-query-details" };
      };
      await assert.rejects(assertWindowsUninstallSafe(home, { ...options([]), run }), (error) => {
        assert.match(error.message, /process inspection failed or timed out/);
        assert.match(error.message, /Quit Nexus Desktop/);
        assert.doesNotMatch(error.message, /private-query-details/);
        return true;
      });
    });
  }

  for (const force of [false, true]) {
    it(`refuses uninstall before changes even with force=${force}`, async (t) => {
      await withTempHome("uninstall-running-", async (tempHome) => {
        const files = [".nexus/cli/example.node", ".nexus/config.json", ".local/bin/nexus.cmd", ".claude/settings.json", ".nexus/claude/settings.backup.json"];
        for (const file of files) {
          await mkdir(path.dirname(path.join(tempHome, file)), { recursive: true });
          await writeFile(path.join(tempHome, file), "example original contents");
        }
        const beforeHome = process.env.HOME;
        const output = [];
        t.mock.method(console, "log", (...args) => output.push(args.join(" ")));
        t.mock.method(console, "error", (...args) => output.push(args.join(" ")));
        try {
          process.env.HOME = tempHome;
          const rows = [processRow(200, { CommandLine: `node "${path.join(tempHome, ".nexus", "cli", "nexus.mjs")}"` })];
          await assert.rejects(runUninstallCommand({ home: tempHome, force }, {
            checkProcesses: (base) => assertWindowsUninstallSafe(base, options(rows)),
            cleanupPaths: () => assert.fail("must not schedule cleanup"),
          }), /Stop the listed processes/);
          for (const file of files) assert.equal(await readFile(path.join(tempHome, file), "utf8"), "example original contents");
          assert.doesNotMatch(output.join("\n"), /uninstalled|after.*exit|Restoring/);
        } finally {
          if (beforeHome === undefined) delete process.env.HOME;
          else process.env.HOME = beforeHome;
        }
      });
    });
  }

  it("the real CLI entrypoint exits 1 without printing success or deleting files", async () => {
    await withTempHome("uninstall-process-cli-", async (tempHome) => {
      const config = path.join(tempHome, ".nexus", "config.json");
      const dll = path.join(tempHome, ".nexus", "cli", "example.node");
      await mkdir(path.dirname(dll), { recursive: true });
      await writeFile(config, "{}");
      await writeFile(dll, "example loaded module");
      const rows = [processRow(200, { ParentProcessId: 300,
        CommandLine: 'node "C:\\Apps\\Nexus\\node\\signin-helper.mjs"', ModulePaths: [dll],
      }), processRow(300, { Name: "nexus-desktop.exe", ExecutablePath: "C:\\Apps\\nexus-desktop.exe", CommandLine: null })];
      const entry = new URL("../../bin/nexus.mjs", import.meta.url).href;
      const script = `
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        import { promisify } from 'node:util';
        cp.execFile = Object.assign(() => { throw new Error('unexpected callback query'); }, {
          [promisify.custom]: async () => ({ stdout: ${JSON.stringify(JSON.stringify(rows))} })
        });
        syncBuiltinESMExports();
        Object.defineProperty(process, 'platform', { value: 'win32' });
        process.argv = [process.execPath, ${JSON.stringify(entry)}, 'uninstall', '--force'];
        await import(${JSON.stringify(entry)});
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, NO_COLOR: "1", NEXUS_TEST: "1", NEXUS_KEY_STORAGE: "file" },
        encoding: "utf8", timeout: 10000,
      });
      assert.equal(result.status, 1, result.stderr || result.error?.message);
      assert.match(result.stderr, /Quit Nexus Desktop.*rerun `nexus uninstall`/);
      assert.doesNotMatch(result.stdout + result.stderr, /has been uninstalled|scheduled for removal/);
      assert.equal(await readFile(config, "utf8"), "{}");
      assert.equal(await readFile(dll, "utf8"), "example loaded module");
    });
  });

  it("rechecks before cleanup to catch a process started during restoration", async () => {
    await withTempHome("uninstall-new-process-", async (tempHome) => {
      const config = path.join(tempHome, ".nexus", "config.json");
      await mkdir(path.dirname(config), { recursive: true });
      await writeFile(config, "{}");
      const isolatedEnv = {
        HOME: tempHome,
        USERPROFILE: tempHome,
        XDG_CONFIG_HOME: path.join(tempHome, ".config"),
        APPDATA: path.join(tempHome, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(tempHome, "AppData", "Local"),
      };
      const beforeEnv = Object.fromEntries(Object.keys(isolatedEnv).map((name) => [name, process.env[name]]));
      let checks = 0;
      try {
        Object.assign(process.env, isolatedEnv);
        await assert.rejects(runUninstallCommand({ home: tempHome, force: true }, {
          checkProcesses: async () => {
            if (++checks === 2) throw new Error("new blocking process");
          },
          cleanupPaths: () => assert.fail("must not schedule cleanup"),
        }), /new blocking process/);
        assert.equal(checks, 2);
        assert.equal(existsSync(config), true);
        assert.equal(await readFile(config, "utf8"), "{}");
      } finally {
        for (const [name, value] of Object.entries(beforeEnv)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    });
  });
});
