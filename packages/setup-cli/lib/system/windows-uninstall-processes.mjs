import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { windowsSystem32 } from "./win-command.mjs";

const execFileAsync = promisify(execFile);
function processQuery(root, pid, ppid) {
  const config = Buffer.from(JSON.stringify({ root, pid, ppid, commandPattern: commandPathPattern(root) }), "utf8").toString("base64");
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${config}')) | ConvertFrom-Json
$root = $config.root.TrimEnd('\\') + '\\'
$commandPath = [regex]::new($config.commandPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
$processes = @(Get-CimInstance Win32_Process -OperationTimeoutSec 3 -ErrorAction Stop |
  Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine)
$desktop = @{}
foreach ($record in $processes) {
  if ($record.Name -ieq 'nexus-desktop.exe') { $desktop[[int]$record.ProcessId] = $true }
}
$candidates = @{}
foreach ($record in $processes) {
  if ($record.ProcessId -eq $config.pid) { continue }
  $executable = ([string]$record.ExecutablePath).Replace('/', '\\')
  $command = ([string]$record.CommandLine).Replace('/', '\\')
  $managedExecutable = $executable -ieq $config.root -or $executable.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
  $managedCommand = $commandPath.IsMatch($command)
  $suspect = $desktop.ContainsKey([int]$record.ProcessId) -or $desktop.ContainsKey([int]$record.ParentProcessId) -or
    $managedExecutable -or ($record.ProcessId -ne $config.ppid -and $managedCommand)
  if ($suspect -or $record.Name -imatch '^node(?:\\.exe)?$' -or $managedCommand) {
    $candidates[[int]$record.ProcessId] = [bool]$suspect
  }
}
$native = @{}
if ($candidates.Count -gt 0) {
  try {
    Get-Process -Id @($candidates.Keys) -ErrorAction SilentlyContinue | ForEach-Object { $native[$_.Id] = $_ }
  } catch {}
}
$rows = @($processes | ForEach-Object {
  $record = $_
  $modules = @()
  $failed = $false
  if ($candidates.ContainsKey([int]$record.ProcessId)) {
    try {
      $live = $native[[int]$record.ProcessId]
      if ($null -eq $live) { throw 'Candidate process unavailable' }
      $loaded = $live.Modules
      if ($null -eq $loaded) { throw 'Candidate modules unavailable' }
      $modules = @($loaded |
        Where-Object { $_.FileName -and $_.FileName.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } |
        ForEach-Object { $_.FileName })
    } catch {
      $failed = $candidates[[int]$record.ProcessId]
    }
  }
  [PSCustomObject]@{
    ProcessId = $record.ProcessId; ParentProcessId = $record.ParentProcessId; Name = $record.Name
    ExecutablePath = $record.ExecutablePath; CommandLine = $record.CommandLine
    ModulePaths = $modules; ModuleInspectionFailed = $failed
  }
})
ConvertTo-Json -InputObject $rows -Depth 4 -Compress
`;
}

function normalized(value) {
  return value.replaceAll("/", "\\").toLowerCase();
}

function commandPathPattern(root) {
  const escaped = normalized(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:^|[\\s"'=])${escaped}(?=\\\\|[\\s"']|$)`;
}

function processName(value) {
  return value.replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 160);
}

function validProcess(row) {
  return row && Number.isSafeInteger(row.ProcessId) && row.ProcessId >= 0
    && Number.isSafeInteger(row.ParentProcessId) && row.ParentProcessId >= 0
    && typeof row.Name === "string" && row.Name.length > 0
    && (row.ExecutablePath === null || typeof row.ExecutablePath === "string")
    && (row.CommandLine === null || typeof row.CommandLine === "string")
    && Array.isArray(row.ModulePaths) && row.ModulePaths.every((file) => typeof file === "string")
    && typeof row.ModuleInspectionFailed === "boolean";
}

function managedCliReference(row, root, commandPath, ppid) {
  const executable = normalized(row.ExecutablePath ?? "");
  return executable === root || executable.startsWith(root + "\\")
    || (row.ProcessId !== ppid && commandPath.test(normalized(row.CommandLine ?? "")));
}

function desktopProcess(row, byPid) {
  return /^nexus-desktop(?:\.exe)?$/i.test(row.Name)
    || /^nexus-desktop(?:\.exe)?$/i.test(byPid.get(row.ParentProcessId)?.Name ?? "");
}

export function findManagedCliProcesses(home, rows, { pid = process.pid, ppid = process.ppid } = {}) {
  const root = normalized(path.win32.normalize(path.join(home, ".nexus", "cli")));
  const commandPath = new RegExp(commandPathPattern(root), "i");
  const byPid = new Map(rows.map((row) => [row.ProcessId, row]));
  return rows.filter((row) => {
    if (row.ProcessId === pid) return false;
    return managedCliReference(row, root, commandPath, ppid)
      || row.ModulePaths.some((file) => normalized(file).startsWith(root + "\\"));
  }).map((row) => ({
    pid: row.ProcessId,
    name: processName(row.Name),
    parentPid: row.ParentProcessId,
    desktop: desktopProcess(row, byPid),
  }));
}

export async function assertWindowsUninstallSafe(home, {
  platform = process.platform,
  pid = process.pid,
  ppid = process.ppid,
  env = process.env,
  run = execFileAsync,
} = {}) {
  if (platform !== "win32") return;
  let rows;
  try {
    const powershell = path.win32.join(windowsSystem32({ env }), "WindowsPowerShell", "v1.0", "powershell.exe");
    const root = path.win32.normalize(path.join(home, ".nexus", "cli"));
    const { stdout } = await run(powershell, [
      "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(processQuery(root, pid, ppid), "utf16le").toString("base64"),
    ], { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, cwd: path.win32.dirname(windowsSystem32({ env })) });
    rows = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    if (!Array.isArray(rows) || !rows.every(validProcess)) throw new Error("Invalid process listing");
  } catch {
    throw new Error("Cannot safely uninstall Nexus CLI: Windows process inspection failed or timed out. Quit Nexus Desktop and any other Nexus CLI processes, then rerun `nexus uninstall`. Uninstall stopped before file cleanup.");
  }

  const blockers = findManagedCliProcesses(home, rows, { pid, ppid });
  const root = normalized(path.win32.normalize(path.join(home, ".nexus", "cli")));
  const commandPath = new RegExp(commandPathPattern(root), "i");
  const byPid = new Map(rows.map((row) => [row.ProcessId, row]));
  if (blockers.length === 0 && rows.some((row) => row.ProcessId !== pid && row.ModuleInspectionFailed
    && (desktopProcess(row, byPid) || managedCliReference(row, root, commandPath, ppid)))) {
    throw new Error("Cannot safely uninstall Nexus CLI: Windows could not inspect a candidate process's loaded modules. Quit Nexus Desktop and other Nexus CLI processes, then rerun `nexus uninstall`.");
  }
  if (blockers.length === 0) return;
  const details = blockers.map((row) => `  ${row.name} (PID ${row.pid}${row.desktop ? "; Nexus Desktop" : ""})`).join("\n");
  const action = blockers.some((row) => row.desktop)
    ? "Quit Nexus Desktop and any other listed processes"
    : "Stop the listed processes";
  throw new Error(`Cannot uninstall Nexus CLI while other processes are using ~/.nexus/cli:\n${details}\n${action}, then rerun \`nexus uninstall\`.`);
}
