import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function treeSignature(root, creationTimes) {
  const rows = [];
  const ticks = (ns) => (ns / 100n + 621355968000000000n).toString();
  async function visit(file) {
    const info = await lstat(file, { bigint: true });
    const kind = info.isSymbolicLink() ? "l" : info.isDirectory() ? "d" : "f";
    const relative = Buffer.from(path.relative(root, file).split(path.sep).join("/"), "utf8").toString("base64");
    // Directory mtimes change during our own deletions.
    rows.push([relative, kind, kind === "f" ? info.size.toString() : "0", kind === "d" ? "0" : ticks(info.mtimeNs), creationTimes ? ticks(info.birthtimeNs) : "0"].join("|"));
    if (kind === "d") {
      for (const name of await readdir(file)) await visit(path.join(file, name));
    }
  }
  try {
    await visit(root);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return createHash("sha256").update(rows.sort().join("\n"), "utf8").digest("hex");
}

export async function windowsCleanupScript(paths, pid, scheduledAt = Date.now(), guardPaths = [], cleanupDir = null) {
  const roots = [...new Set(paths)].filter((file) => !paths.some((parent) => file !== parent && file.startsWith(`${parent}${path.sep}`)));
  const creationTimes = process.platform === "win32";
  const snapshots = [];
  for (const file of new Set([...roots, ...guardPaths])) {
    snapshots.push({ path: file, signature: await treeSignature(file, creationTimes) });
  }
  const payload = Buffer.from(JSON.stringify({
    paths: roots, pid, scheduledAt, creationTimes, snapshots, cleanupDir,
  }), "utf8").toString("base64");
  return `$ErrorActionPreference = 'Stop'
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
try {
$removed = [Collections.Generic.List[object]]::new()
function Get-NexusEntry($item) {
  $kind = if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { 'l' } elseif ($item.Attributes -band [IO.FileAttributes]::Directory) { 'd' } else { 'f' }
  return @{
    path = $item.FullName; kind = $kind
    size = if ($kind -eq 'f') { $item.Length.ToString() } else { '0' }
    modified = if ($kind -eq 'd') { '0' } else { $item.LastWriteTimeUtc.Ticks.ToString() }
    created = if ($config.creationTimes) { $item.CreationTimeUtc.Ticks.ToString() } else { '0' }
  }
}
function Add-NexusRow([string]$root, $entry, $rows) {
  $relative = $entry.path.Substring($root.Length).TrimStart([char[]]@(47,92)).Replace([char]92,[char]47)
  $name = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($relative))
  $rows.Add([string]::Join('|', @($name, $entry.kind, $entry.size, $entry.modified, $entry.created)))
}
function Add-NexusTree([string]$root, $item, $rows) {
  Add-NexusRow $root (Get-NexusEntry $item) $rows
  if (($item.Attributes -band [IO.FileAttributes]::Directory) -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    foreach ($entry in $item.EnumerateFileSystemInfos()) { Add-NexusTree $root $entry $rows }
  }
}
function Get-NexusSignature([string]$literalPath) {
  $root = [IO.Path]::GetFullPath($literalPath).TrimEnd([char[]]@(47,92))
  $rows = [Collections.Generic.List[string]]::new()
  if (Test-Path -LiteralPath $literalPath) { Add-NexusTree $root (Get-Item -LiteralPath $literalPath -Force) $rows }
  $comparison = if ($config.creationTimes) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
  $prefix = $root + [IO.Path]::DirectorySeparatorChar
  foreach ($entry in $removed) {
    if ($entry.path.Equals($root, $comparison) -or $entry.path.StartsWith($prefix, $comparison)) { Add-NexusRow $root $entry $rows }
  }
  if ($rows.Count -eq 0) { return $null }
  $ordered = $rows.ToArray()
  [Array]::Sort($ordered, [StringComparer]::Ordinal)
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]::Join([string][char]10, $ordered)))).Replace('-', '').ToLowerInvariant()
  } finally {
    $hash.Dispose()
  }
}
try {
  $parent = [Diagnostics.Process]::GetProcessById([int]$config.pid)
  Write-Output 'Waiting for Nexus CLI to exit.'
  if (-not $parent.WaitForExit(120000)) { exit 2 }
} catch [ArgumentException] {}
Write-Output 'Nexus CLI exited; allowing the launcher to return.'
Start-Sleep -Milliseconds 1500
function Remove-NexusPath([string]$literalPath) {
  $item = Get-Item -LiteralPath $literalPath -Force
  $record = Get-NexusEntry $item
  if (($item.Attributes -band [IO.FileAttributes]::Directory) -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    foreach ($entry in $item.EnumerateFileSystemInfos()) { Remove-NexusPath $entry.FullName }
  } elseif (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    $item.Attributes = $item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
  }
  $item.Delete()
  $removed.Add($record)
}
foreach ($literalPath in $config.paths) {
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      foreach ($snapshot in $config.snapshots) {
        if ((Get-NexusSignature $snapshot.path) -cne $snapshot.signature) {
          Write-Output 'Skipping cleanup because files changed after uninstall was scheduled.'
          exit 0
        }
      }
      if (Test-Path -LiteralPath $literalPath) { Remove-NexusPath $literalPath }
      break
    } catch {
      if ($attempt -eq 19) { exit 3 }
      Start-Sleep -Milliseconds 250
    }
  }
}
exit 0
} finally {
  if ($config.cleanupDir) { Remove-Item -LiteralPath $config.cleanupDir -Recurse -Force -ErrorAction SilentlyContinue }
}`;
}

async function scheduleCleanup(paths, { spawnProcess, env, pid, home }) {
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  const executable = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const staging = await mkdtemp(path.join(process.env.NEXUS_TEST === "1" ? home : os.tmpdir(), "nexus-uninstall-"));
  try {
    const script = path.join(staging, "worker.ps1");
    await writeFile(script, await windowsCleanupScript(paths, pid, Date.now(), [path.join(home, ".nexus")], staging), { mode: 0o600 });
    const payload = Buffer.from(JSON.stringify({ executable, script }), "utf8").toString("base64");
    const launcher = `$ErrorActionPreference = 'Stop'
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
try {
  $worker = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([IO.File]::ReadAllText($config.script, [Text.Encoding]::UTF8)))
  Start-Process -FilePath $config.executable -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand',$worker -ErrorAction Stop | Out-Null
  exit 0
} catch { exit 1 }`;
    const encoded = Buffer.from(launcher, "utf16le").toString("base64");
    await new Promise((resolve, reject) => {
      const child = spawnProcess(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        detached: false, windowsHide: true, stdio: "ignore", cwd: root,
      });
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        reject(new Error("Timed out starting Windows uninstall cleanup."));
      }, 5000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Windows uninstall cleanup launcher failed (${signal || `exit ${code}`}).`));
      });
    });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Only known Windows process-owned paths are deferred; other errors stay fatal. */
export async function removeUninstallPaths(home, paths, {
  platform = process.platform, spawnProcess = spawn, env = process.env,
  pid = process.pid, remove = rm, exists = existsSync,
} = {}) {
  const deferred = [];
  const failures = [];
  const processOwned = new Set([
    path.join(home, ".nexus", "cli"), path.join(home, ".nexus"),
    path.join(home, ".local", "bin", "nexus.cmd"), path.join(home, ".local", "bin", "fireconnect.cmd"),
  ]);
  const deferWindows = platform === "win32" && (process.env.NEXUS_TEST !== "1" || spawnProcess !== spawn);
  for (const file of paths) {
    if (deferWindows && processOwned.has(file)) {
      if (exists(file)) deferred.push(file);
      continue;
    }
    try {
      await remove(file, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "ENOENT") failures.push({ path: file, message: error.message });
    }
  }
  if (deferred.length > 0) {
    try {
      const ordered = deferred.filter((file) => !file.endsWith(".cmd")).concat(deferred.filter((file) => file.endsWith(".cmd")));
      await scheduleCleanup(ordered, { spawnProcess, env, pid, home });
    } catch (error) {
      failures.push(...deferred.map((file) => ({ path: file, message: `Could not schedule removal after exit: ${error.message}` })));
      return { failures, deferred: [] };
    }
  }
  return { failures, deferred };
}
