/**
 * The models stock Codex lists in its picker, as Codex's own catalog rows.
 *
 * `codex debug models` prints the catalog Codex would load, in the same format
 * as `model_catalog_json`. Nexus's `model_catalog_json` replaces that
 * list and stops Codex refreshing it, so the command runs in a throwaway
 * CODEX_HOME whose `auth.json` is a symlink or hard link to the user's.
 * In-place token refreshes update the real file. If neither link is available,
 * the probe runs signed out; credentials are never copied. It runs the newer
 * of the `codex` command and the one inside the macOS ChatGPT app, since an
 * older Codex is sent a list without the newest models.
 * Signed in, Codex lists what the account can use; signed out, or with
 * keyring-stored auth (keyed by CODEX_HOME), it lists the models bundled with
 * that Codex release, and `--bundled` is the fallback when the refresh fails.
 * Visible rows are cached on disk so `--model` checks and catalog pruning
 * read them synchronously.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { writeFileAtomicSync } from "../../io/atomic-write.mjs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ensureCacheParent, scopedCacheFilePath } from "../../fireworks/serverless-catalog-cache.mjs";
import { findCommand, harnessCommandEnv, resolveHarnessCommandAsync } from "../../harness/detect.mjs";
import { compareVersions } from "../../system/release-notes.mjs";
import { safeCommand } from "../../system/win-command.mjs";

const RUN_TIMEOUT_MS = 10_000;

/** @typedef {{ slug: string, display_name?: string, input_modalities?: string[], [field: string]: unknown }} CodexCatalogRow */

/** @type {CodexCatalogRow[] | null | undefined} undefined until first read */
let snapshot;

function cachePath() {
  return scopedCacheFilePath("codex-stock-models.json");
}

/**
 * The rows Codex's picker shows, in catalog order. Hidden rows are Codex
 * internals, not picker entries.
 * @param {unknown} doc a `codex debug models` document (or its `models` array)
 * @returns {CodexCatalogRow[]}
 */
export function parseCodexCatalogModels(doc) {
  const rows = Array.isArray(doc) ? doc : doc?.models;
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.filter((row) => row && typeof row.slug === "string" && row.slug && row.visibility !== "hide");
}

function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A leftover temp dir holds only a link, never a credential copy.
  }
}

/**
 * The `codex` the macOS ChatGPT app ships inside its bundle, or "". The app
 * puts no `codex` on PATH, so without this a machine with only the app never
 * reads the account's own list, and the picker falls back to a fixed one
 * (no account-only models, no Codex effort tiers).
 * @param {string} home
 * @param {{ platform?: string, root?: string }} [options] `root` prefixes /Applications, as in detect.mjs
 */
export function chatgptAppCodexCommand(home, { platform = process.platform, root = "/" } = {}) {
  if (platform !== "darwin") return "";
  for (const apps of [path.join(root, "Applications"), path.join(home, "Applications")]) {
    const candidate = path.join(apps, "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex");
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Not installed here; try the next location.
    }
  }
  return "";
}

const VERSION_TIMEOUT_MS = 3_000;

/**
 * The `x.y.z` in `codex --version` output (`codex-cli 0.169.0-alpha.11.1`
 * reads as `0.169.0`), or "" when there is none. Compared with the shared
 * `compareVersions` (mirrored in the CLI's internal formal models), so
 * prerelease builds of one version tie.
 * @param {unknown} text
 */
export function codexVersionCore(text) {
  return /(\d+\.\d+\.\d+)/.exec(String(text ?? ""))?.[1] ?? "";
}

/** `bin --version`, or "" when it fails or takes too long. Never rejects. */
function readCodexVersion(bin) {
  return new Promise((resolve) => {
    try {
      execFile(bin, ["--version"], { env: harnessCommandEnv(bin), timeout: VERSION_TIMEOUT_MS }, (error, stdout) => {
        resolve(error ? "" : String(stdout));
      });
    } catch {
      resolve("");
    }
  });
}

/**
 * Which codex to read the model list with: the newer of the `codex` command
 * and the ChatGPT app's own. OpenAI leaves its newest models out of the list
 * it sends an older Codex, so the older binary would hide them. A tie, or a
 * version that can't be read, keeps the command.
 * @param {string} cli the resolved `codex` command, or ""
 * @param {string} app the ChatGPT app's codex, or ""
 * @param {{ version?: (bin: string) => Promise<string>, log?: (line: string) => void }} [options]
 *   `log` gets one line naming the choice and both versions, never a path
 *   (default: stderr with NEXUS_DEBUG=1)
 * @returns {Promise<string>} "" when neither exists
 */
export async function pickCodexProbeCommand(cli, app, { version = readCodexVersion, log = debug } = {}) {
  // The log only observes the pick; a logger that throws must not change it.
  const note = (line) => {
    try {
      log(line);
    } catch {
      // Ignored: diagnostics never break `codex on`.
    }
  };
  if (!cli || !app) {
    note(cli || app
      ? `codex model probe: ${cli ? "codex command" : "ChatGPT app codex"} (only one installed)`
      : "codex model probe: no codex found");
    return cli || app;
  }
  const [cliVersion, appVersion] = (await Promise.all([version(cli), version(app)])).map(codexVersionCore);
  // Only a readable, strictly newer app wins; if the command's version can't
  // be read, keep it (a failed probe still falls back to the app).
  const useApp = Boolean(cliVersion && appVersion) && compareVersions(appVersion, cliVersion) > 0;
  note(`codex model probe: ${useApp ? "ChatGPT app codex" : "codex command"} `
    + `(command ${cliVersion || "version unreadable"}, app ${appVersion || "version unreadable"})`);
  return useApp ? app : cli;
}

/** One line on stderr with NEXUS_DEBUG=1, as elsewhere in Nexus; silent otherwise. Never throws. */
function debug(message) {
  try {
    if (process.env.NEXUS_DEBUG === "1") {
      process.stderr.write(`[nexus] ${message}\n`);
    }
  } catch {
    // Diagnostics must never break `codex on`.
  }
}

export function codexStockCommand(args, {
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  isFile,
  find = findCommand,
  exists = existsSync,
} = {}) {
  if (platform !== "win32") return ["codex", args];
  const native = safeCommand("codex", { platform, env, isFile });
  if (native) return [native, args];
  const searchEnv = {
    ...env,
    PATH: (env.PATH ?? env.Path ?? "").split(";").map((entry) => entry.trim().replace(/^"(.*)"$/, "$1")).join(";"),
  };
  const launcher = find("codex", { platform, env: searchEnv });
  if (!launcher || !path.win32.isAbsolute(launcher) || !/\.cmd$/i.test(launcher)) return null;
  const script = path.win32.join(path.win32.dirname(launcher), "node_modules", "@openai", "codex", "bin", "codex.js");
  return exists(script) ? [execPath, [script, ...args]] : null;
}

/**
 * @param {string[]} args
 * @param {string} codexHome
 * @param {string} bin
 * @returns {Promise<CodexCatalogRow[]>} empty when Codex is missing, fails, or times out
 */
function runDebugModels(args, codexHome, bin = "codex") {
  const env = harnessCommandEnv(bin, { ...process.env, CODEX_HOME: codexHome });
  const modelArgs = ["debug", "models", ...args];
  const command = process.platform === "win32"
    ? codexStockCommand(modelArgs, { env })
    : [bin, modelArgs];
  if (!command) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      command[0],
      command[1],
      {
        env,
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        cwd: codexHome,
      },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        try {
          resolve(parseCodexCatalogModels(JSON.parse(stdout)));
        } catch {
          resolve([]);
        }
      },
    );
  });
}

/**
 * Stock Codex's catalog for the user's sign-in, else the bundled one.
 * @param {string} codexHome the user's CODEX_HOME
 * @returns {Promise<CodexCatalogRow[]>}
 */
export async function readStockCatalog(codexHome, {
  symlink = symlinkSync,
  link = linkSync,
  run = runDebugModels,
  version = readCodexVersion,
  home = os.homedir(),
  resolverOptions,
} = {}) {
  let probeHome;
  try {
    const cli = await resolveHarnessCommandAsync("codex", home, resolverOptions);
    const app = chatgptAppCodexCommand(home, resolverOptions);
    const first = await pickCodexProbeCommand(cli, app, { version }) || "codex";
    // The other binary is a fallback: a failed probe of the newer one must not
    // leave the picker on the fixed list while a working codex is installed.
    const bins = [first, ...[cli, app].filter((bin) => bin && bin !== first)];
    probeHome = mkdtempSync(path.join(os.tmpdir(), "fireconnect-codex-models-"));
    const auth = path.join(codexHome, "auth.json");
    if (existsSync(auth)) {
      const probeAuth = path.join(probeHome, "auth.json");
      try {
        symlink(auth, probeAuth);
      } catch {
        try {
          link(auth, probeAuth);
        } catch {
          // Neither link is available: probe without the user's credentials.
        }
      }
    }
    // The account's own list from either binary beats a bundled one.
    for (const args of [[], ["--bundled"]]) {
      for (const bin of bins) {
        const rows = await run(args, probeHome, bin);
        if (rows.length) {
          return rows;
        }
      }
    }
    return [];
  } catch {
    return [];
  } finally {
    if (probeHome) {
      removeDir(probeHome);
    }
  }
}

/**
 * Stock Codex's visible catalog rows from the last successful read, or null.
 * Synchronous: reads the disk cache once per process.
 * @returns {CodexCatalogRow[] | null}
 */
export function cachedCodexStockModels() {
  if (snapshot === undefined) {
    try {
      const rows = parseCodexCatalogModels(JSON.parse(readFileSync(cachePath(), "utf8")));
      snapshot = rows.length ? rows : null;
    } catch {
      snapshot = null;
    }
  }
  return snapshot;
}

/**
 * Re-read stock Codex's catalog and cache it. Best-effort and bounded: a
 * missing Codex, a failed run, or a timeout keeps the previous rows. Never
 * runs Codex under NEXUS_TEST; specs describe the catalog in
 * NEXUS_TEST_CODEX_MODELS (a `codex debug models` document) instead.
 * @param {{ codexHome: string, home?: string, resolverOptions?: import("../../harness/detect.mjs").DetectOptions }} opts
 * @returns {Promise<boolean>} true when fresh rows were cached
 */
export async function refreshCodexStockModels({ codexHome, home = os.homedir(), resolverOptions }) {
  let rows = [];
  try {
    rows = process.env.NEXUS_TEST === "1"
      ? parseCodexCatalogModels(JSON.parse(process.env.NEXUS_TEST_CODEX_MODELS || "null"))
      : await readStockCatalog(codexHome, { home, resolverOptions });
  } catch {
    return false;
  }
  if (!rows.length) {
    return false;
  }
  try {
    const file = cachePath();
    ensureCacheParent(file);
    writeFileAtomicSync(file, `${JSON.stringify({ cachedAt: Date.now(), models: rows })}\n`, { mode: 0o600 });
  } catch {
    // The in-memory rows still serve this process.
  }
  snapshot = rows;
  return true;
}

/** Set (or with null, clear) the in-memory rows without touching disk. Tests only. */
export function setCodexStockModelsForTests(rows) {
  snapshot = rows;
}
