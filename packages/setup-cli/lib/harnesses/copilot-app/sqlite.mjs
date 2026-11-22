import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSyncCommand } from "../../system/win-command.mjs";
import { loadNodeSqlite, sqlText } from "../../io/sqlite.mjs";
import { ensureIdeStopped, isIdeRunning, quitInstruction } from "../../io/ide-running.mjs";
import { activeAccountResidency, fireworksInferenceUrl } from "../../fireworks/residency.mjs";

/* -------------------------------------------------------------------------- */
/* GitHub Copilot desktop app SQLite access (`~/.copilot/data.db`).            */
/*                                                                            */
/* The Copilot app is a Tauri app with its own schema — not a VS Code          */
/* ItemTable. We only touch the BYOK tables:                                   */
/*                                                                            */
/*   model_providers (id, name, type, settings_json, account_id, ...)          */
/*   provider_models (id, provider_id, model_id, wire_model, display_name,     */
/*                    max_prompt_tokens, max_output_tokens,                    */
/*                    wire_api_override, supported_reasoning_efforts)          */
/*                                                                            */
/* Row ownership is natural: our provider rows carry a stable id prefix        */
/* (`fc-` + uuid) so `off` removes exactly our rows and never a user-created   */
/* provider. The built-in `github_copilot:*` row is never touched — BYOK       */
/* providers are additive, so native Copilot models keep working.              */
/*                                                                            */
/* The generic node:sqlite / sqlite3-CLI dual path mirrors                     */
/* ../vscode/vscdb-sqlite.mjs (zero-dependency, Node 18 compatible).           */
/* -------------------------------------------------------------------------- */

/** A finite number as a SQL literal, else NULL. */
function sqlNumberOrNull(value) {
  return Number.isFinite(value) ? String(Math.trunc(value)) : "NULL";
}

/** A non-empty string as a quoted SQL literal, else NULL. */
function sqlTextOrNull(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? sqlText(text) : "NULL";
}

function isMissingTableError(error) {
  return /no such table/i.test(error?.message ?? "");
}

/**
 * Execute a batch of SQL statements (no results) as one atomic unit.
 * node:sqlite: explicit BEGIN/COMMIT. sqlite3 CLI: whole stdin input is one
 * implicit transaction. Both fail the whole batch on any error.
 * @param {string} dbPath
 * @param {string[]} statements
 */
export async function execCopilotSql(dbPath, statements) {
  if (statements.length === 0) {
    return;
  }
  await requireCopilotDatabase(dbPath);
  const databaseUri = `${pathToFileURL(path.resolve(dbPath)).href}?mode=rw`;
  const DatabaseSync = await loadNodeSqlite();
  if (DatabaseSync) {
    let db;
    try {
      db = new DatabaseSync(databaseUri);
      db.exec("BEGIN");
      try {
        for (const statement of statements) {
          db.exec(statement);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    } finally {
      db?.close();
    }
    return;
  }
  // sqlite3 auto-commits each statement by default, so an explicit
  // BEGIN/COMMIT is what makes the batch atomic — a mid-batch failure rolls
  // the whole set back, matching the node:sqlite path above.
  const result = spawnSyncCommand("sqlite3", ["-bail", databaseUri], {
    input: `BEGIN;\n${statements.join("\n")}\nCOMMIT;`,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`sqlite3 failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`sqlite3 exited ${result.status}: ${(result.stderr || "").trim()}`);
  }
}

/**
 * Run a single SELECT and return rows as arrays of strings (null → "").
 * Raw stdout mode on the CLI path keeps values verbatim.
 * @param {string} dbPath
 * @param {string} sql
 * @returns {Promise<string[][]>}
 */
export async function queryCopilotSql(dbPath, sql) {
  if (!dbPath || !existsSync(dbPath)) {
    return [];
  }
  const DatabaseSync = await loadNodeSqlite();
  if (DatabaseSync) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare(sql).all();
      return rows.map((row) => Object.values(row).map((v) => (v == null ? "" : String(v))));
    } catch (error) {
      if (isMissingTableError(error)) {
        return [];
      }
      throw error;
    } finally {
      db?.close();
    }
  }
  const result = spawnSyncCommand("sqlite3", ["-readonly", dbPath, sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (isMissingTableError({ message: result.stderr })) {
      return [];
    }
    throw new Error(`sqlite3 exited ${result.status}: ${(result.stderr || "").trim()}`);
  }
  const text = (result.stdout || "").replace(/\n$/, "");
  if (!text) {
    return [];
  }
  return text.split("\n").map((line) => line.split("|"));
}

/**
 * Resolve the path to the Copilot desktop app's data.db.
 *
 * The app overrides Tauri's per-platform app-data default and keeps all of its
 * state in one `~/.copilot` tree — the same config dir the Copilot CLI uses
 * (`config.json`, `settings.json`, `logs/`, `session-store.db`). That layout is
 * platform-independent, so there is no `%APPDATA%` branch here: an earlier
 * version guessed one by analogy with other harnesses and would have pointed
 * Windows at a database the app never opens. `COPILOT_HOME` relocates the whole
 * tree and is honored first.
 *
 * @param {{ home?: string, dbPath?: string }} opts
 * @returns {string}
 */
export function copilotDataDbPath({ home = "", dbPath = "" } = {}) {
  if (dbPath) {
    return path.resolve(dbPath);
  }
  const configDir = process.env.COPILOT_HOME?.trim();
  if (configDir) {
    return path.join(path.resolve(configDir), "data.db");
  }
  const baseHome = home || process.env.HOME || process.env.USERPROFILE || "";
  return path.join(baseHome, ".copilot", "data.db");
}

/** Stable prefix for fireconnect-owned model_providers rows. */
export const COPILOT_PROVIDER_ID_PREFIX = "fc-";

/** Provider name shown in Copilot's model picker. */
export const COPILOT_PROVIDER_NAME = "Fireworks";

/** The nexus BYOK provider type (OpenAI-compatible custom endpoint). */
export const COPILOT_PROVIDER_TYPE = "openai";

/** Fireworks OpenAI-compatible inference base URL. */
import { COPILOT_FIREWORKS_BASE_URL } from "../copilot-shared.mjs";
export { COPILOT_FIREWORKS_BASE_URL };

/**
 * Generate a fireconnect-owned provider id.
 * @returns {string}
 */
export function newCopilotProviderId() {
  return `${COPILOT_PROVIDER_ID_PREFIX}${randomUUID()}`;
}

/**
 * Find the fireconnect-owned BYOK provider row, if any.
 * @param {string} dbPath
 * @returns {Promise<{ id: string, name: string, type: string, settings_json: string } | null>}
 */
export async function findFireconnectProvider(dbPath) {
  const rows = await queryCopilotSql(
    dbPath,
    `SELECT id, name, type, settings_json FROM model_providers WHERE id LIKE '${COPILOT_PROVIDER_ID_PREFIX}%';`,
  );
  if (rows.length === 0) {
    return null;
  }
  const [id, name, type, settings_json] = rows[0];
  return { id, name, type, settings_json };
}

/**
 * List every model_providers row (for status display).
 * @param {string} dbPath
 * @returns {Promise<Array<{ id: string, name: string, type: string, settings_json: string }>>}
 */
export async function listCopilotProviders(dbPath) {
  const rows = await queryCopilotSql(dbPath, "SELECT id, name, type, settings_json FROM model_providers;");
  return rows.map(([id, name, type, settings_json]) => ({ id, name, type, settings_json }));
}

/**
 * List the provider_models registered to a provider.
 * @param {string} dbPath
 * @param {string} providerId
 * @returns {Promise<Array<{ model_id: string, display_name: string, wire_model: string }>>}
 */
export async function listCopilotProviderModels(dbPath, providerId) {
  const rows = await queryCopilotSql(
    dbPath,
    `SELECT model_id, display_name, wire_model FROM provider_models WHERE provider_id = ${sqlText(providerId)};`,
  );
  return rows.map(([model_id, display_name, wire_model]) => ({
    model_id,
    display_name,
    wire_model,
  }));
}

/**
 * INSERT for one provider_models row. Shared by the full-catalog upsert and
 * single-row upgrade inserts so the column list can't drift between them.
 */
function providerModelInsertStatement(providerId, model) {
  return `INSERT INTO provider_models (id, provider_id, model_id, wire_model, display_name, max_prompt_tokens, max_output_tokens, wire_api_override, supported_reasoning_efforts) VALUES (${sqlText(newProviderModelId())}, ${sqlText(providerId)}, ${sqlText(model.id)}, ${sqlText(model.wireModel || model.id)}, ${sqlText(model.displayName)}, ${sqlNumberOrNull(model.maxPromptTokens)}, ${sqlNumberOrNull(model.maxOutputTokens)}, NULL, ${sqlTextOrNull(model.supportedReasoningEfforts)});`;
}

/**
 * Insert-or-replace the BYOK provider row and its registered models in one
 * atomic DB transaction.
 *
 * @param {string} dbPath
 * @param {{ providerId: string, apiKey: string, models: Array<{ id: string, displayName: string, wireModel?: string, maxPromptTokens?: number|null, maxOutputTokens?: number|null }> }} opts
 */
export async function upsertFireconnectProvider(dbPath, {
  providerId,
  apiKey,
  models,
  extraHeaders = {},
}) {
  // The key rides as an Authorization header on the provider row rather than
  // in the OS keychain (`authKind: "apiKey"`).
  //
  // The app spawns a fresh CLI subprocess per session and hands it the key via
  // COPILOT_PROVIDER_API_KEY, re-reading the keychain item on every spawn. An
  // item Nexus creates via `security` is not on the app's keychain
  // partition list, and adding it there needs the user's login password — which
  // a non-interactive `nexus copilot on` cannot supply. The result was a
  // per-session macOS auth prompt and an HTTP 401 whenever it was dismissed.
  //
  // `authKind: "none"` keeps the app out of the keychain entirely and the
  // header authenticates every session. The tradeoff is that the key is stored
  // in data.db (owner-only, 0600 — the same file the app already keeps its own
  // state in) instead of the encrypted keychain.
  const settings = JSON.stringify({
    authKind: "none",
    baseUrl: fireworksInferenceUrl(COPILOT_FIREWORKS_BASE_URL, activeAccountResidency("copilot-app")),
    // Attribution headers ride alongside the credential in the same map.
    headersJson: JSON.stringify({ Authorization: `Bearer ${apiKey}`, ...extraHeaders }),
    wireApi: "completions",
  });
  const statements = [
    `INSERT OR REPLACE INTO model_providers (id, name, type, settings_json, account_id) VALUES (${sqlText(providerId)}, '${COPILOT_PROVIDER_NAME}', '${COPILOT_PROVIDER_TYPE}', ${sqlText(settings)}, NULL);`,
    `DELETE FROM provider_models WHERE provider_id = ${sqlText(providerId)};`,
    // max_prompt_tokens / max_output_tokens drive the app's context-window
    // readout and supported_reasoning_efforts (a JSON array of effort names)
    // drives its reasoning-effort control; NULL in either makes the picker
    // report `hasContextWindowMetadata: false` / `missing-effort-metadata`
    // and hide the corresponding UI.
    ...models.map((model) => providerModelInsertStatement(providerId, model)),
  ];
  await execCopilotSql(dbPath, statements);
  // The row holds the API key in a header, so the DB must be owner-only.
  restrictDbPermissions(dbPath);
}

/**
 * Insert a single model row under an existing BYOK provider without touching
 * the provider row or its other models. Used by upgrade migrations that
 * backfill one catalog entry (no backup/snapshot involved).
 *
 * @param {string} dbPath
 * @param {{ providerId: string, model: { id: string, displayName: string, wireModel?: string, maxPromptTokens?: number|null, maxOutputTokens?: number|null, supportedReasoningEfforts?: string } }} opts
 */
export async function insertCopilotProviderModel(dbPath, { providerId, model }) {
  // provider_models is UNIQUE(provider_id, model_id); upgrade migrations run
  // on every `upgrade`, so re-inserting a backfilled row must be a no-op
  // rather than a constraint-violation error.
  await execCopilotSql(dbPath, [
    providerModelInsertStatement(providerId, model).replace(/^INSERT /, "INSERT OR IGNORE "),
  ]);
}

/**
 * Delete specific model rows from a provider (upgrade migrations pruning
 * retired rows). No-op for an empty id list.
 * @param {string} dbPath
 * @param {string} providerId
 * @param {string[]} modelIds
 */
export async function deleteCopilotProviderModels(dbPath, providerId, modelIds) {
  const ids = [...new Set(modelIds.filter(Boolean))];
  if (!ids.length) {
    return;
  }
  const list = ids.map((id) => `${sqlText(id)}`).join(", ");
  await execCopilotSql(dbPath, [
    `DELETE FROM provider_models WHERE provider_id = ${sqlText(providerId)} AND model_id IN (${list});`,
  ]);
}

/**
 * Make the DB and its sidecar WAL/SHM files owner-only. Best-effort: chmod is
 * a no-op on Windows, and a DB owned by another user is the app's to manage.
 * @param {string} dbPath
 */
function restrictDbPermissions(dbPath) {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (existsSync(file)) {
        chmodSync(file, 0o600);
      }
    } catch {
      // Permission denied / unsupported platform — leave as-is.
    }
  }
}

/**
 * Remove the nexus provider row + its registered models.
 * @param {string} dbPath
 * @param {string} providerId
 */
export async function removeFireconnectProvider(dbPath, providerId) {
  if (!dbPath || !existsSync(dbPath)) {
    return;
  }
  await execCopilotSql(dbPath, [
    `DELETE FROM provider_models WHERE provider_id = ${sqlText(providerId)};`,
    `DELETE FROM model_providers WHERE id = ${sqlText(providerId)};`,
  ]);
}

/**
 * Require the app-owned database and tables without initializing them.
 * @param {string} dbPath
 */
export async function requireCopilotDatabase(dbPath, { recoverStub = false, force = false } = {}) {
  if (recoverStub) {
    await recoverCopilotStubDatabase(dbPath, { force });
  }
  const rows = await queryCopilotSql(dbPath,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('accounts', 'model_providers', 'provider_models');");
  if (rows.length !== 3) {
    throw new Error("Could not find the Copilot app's initialized database. Open GitHub Copilot once (it creates this database on first launch) and retry `nexus copilot-app on`.");
  }
}

const STUB_COLUMNS = {
  accounts: ["id"],
  model_providers: ["id", "name", "created_at", "updated_at", "type", "settings_json", "account_id"],
  provider_models: ["id", "provider_id", "model_id", "wire_model", "display_name", "max_prompt_tokens", "max_output_tokens", "wire_api_override", "created_at", "updated_at", "supported_reasoning_efforts"],
};

async function isCopilotStubDatabase(dbPath) {
  const dir = mkdtempSync(path.join(path.dirname(dbPath), ".nexus-stub-inspect-"));
  const snapshot = path.join(dir, "data.db");
  const signatures = new Map();
  const signature = (file) => {
    if (!existsSync(file)) return "";
    const stat = lstatSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error("Copilot database recovery requires regular files.");
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  };
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${dbPath}${suffix}`;
      signatures.set(source, signature(source));
      if (signatures.get(source)) {
        copyFileSync(source, `${snapshot}${suffix}`);
        chmodSync(`${snapshot}${suffix}`, 0o600);
      }
    }
    // Even a read-only SQLite connection can rewrite shared-memory sidecars.
    const matches = await hasCopilotStubSchema(snapshot);
    if ([...signatures].some(([file, before]) => signature(file) !== before)) {
      throw new Error("The Copilot database changed during inspection. Quit GitHub Copilot and retry.");
    }
    return matches;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function hasCopilotStubSchema(dbPath) {
  const objects = await queryCopilotSql(dbPath, "SELECT type, name FROM sqlite_master ORDER BY name;");
  const tables = objects.filter(([type]) => type === "table").map(([, name]) => name);
  if (JSON.stringify(tables) !== JSON.stringify(Object.keys(STUB_COLUMNS).sort())) {
    return false;
  }
  if (objects.some(([type, name]) => type !== "table" && !(type === "index" && (name === "idx_provider_models_provider" || /^sqlite_autoindex_(accounts|model_providers|provider_models)_\d+$/.test(name))))) {
    return false;
  }
  for (const [table, expected] of Object.entries(STUB_COLUMNS)) {
    const columns = await queryCopilotSql(dbPath, `PRAGMA table_info(${table});`);
    if (JSON.stringify(columns.map((column) => column[1])) !== JSON.stringify(expected)) {
      return false;
    }
  }
  if ((await queryCopilotSql(dbPath, "SELECT 1 FROM accounts LIMIT 1;")).length > 0) {
    return false;
  }
  return (await queryCopilotSql(dbPath, "SELECT 1 FROM model_providers WHERE id NOT GLOB 'fc-*' UNION ALL SELECT 1 FROM provider_models WHERE provider_id NOT GLOB 'fc-*' LIMIT 1;")).length === 0;
}

/** Preserve a never-initialized Nexus database so the app can create its own. */
export async function recoverCopilotStubDatabase(dbPath, { force = false, move = renameSync } = {}) {
  if (!dbPath || !existsSync(dbPath) || !lstatSync(dbPath).isFile()) {
    return "";
  }
  if (["-wal", "-shm"].some((suffix) => existsSync(`${dbPath}${suffix}`) && !lstatSync(`${dbPath}${suffix}`).isFile())) {
    return "";
  }
  if (!await isCopilotStubDatabase(dbPath)) {
    return "";
  }
  await ensureCopilotStopped({ force });
  if (!await isCopilotStubDatabase(dbPath)) {
    return "";
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${dbPath}.nexus-stub-${stamp}-${randomUUID()}`;
  const moved = [];
  try {
    for (const suffix of ["-wal", "-shm", ""]) {
      const source = `${dbPath}${suffix}`;
      if (suffix === "" || existsSync(source)) {
        move(source, `${backup}${suffix}`);
        moved.push(suffix);
      }
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const suffix of moved.reverse()) {
      try {
        move(`${backup}${suffix}`, `${dbPath}${suffix}`);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], `Could not restore the Copilot database from ${backup}.`);
    }
    throw error;
  }
  return backup;
}

function newProviderModelId() {
  // The app only requires uniqueness; a plain uuid matches its own shape.
  return randomUUID();
}

/**
 * Rebake the Fireworks API key in the provider row's Authorization header
 * after a login/upgrade rotates it. The app harness bakes a literal key, so
 * `syncBakedKeysAfterStore` must update it the same way as the file configs.
 * @param {{ dbPath: string, fireworksKey: string }} opts
 * @returns {Promise<boolean>} true when a row was updated
 */
export async function refreshCopilotAppGatewayKey({ dbPath, fireworksKey }) {
  const provider = await findFireconnectProvider(dbPath);
  if (!provider) {
    return false;
  }
  let settings;
  try {
    settings = JSON.parse(provider.settings_json || "{}");
  } catch {
    return false;
  }
  let headers;
  try {
    headers = JSON.parse(settings.headersJson || "{}");
  } catch {
    return false;
  }
  if (!/^Bearer\s+/i.test(headers.Authorization ?? "")) {
    return false;
  }
  const key = headers.Authorization.replace(/^Bearer\s+/i, "");
  if (key === fireworksKey) {
    return false;
  }
  headers.Authorization = `Bearer ${fireworksKey}`;
  settings.headersJson = JSON.stringify(headers);
  await execCopilotSql(dbPath, [
    `UPDATE model_providers SET settings_json = ${sqlText(JSON.stringify(settings))} WHERE id = ${sqlText(provider.id)};`,
  ]);
  return true;
}

/**
 * Apply `rewrite` to the provider row's settings JSON in place, so upgrades can
 * update baked headers without a re-`on`.
 * @param {string} dbPath
 * @param {(settingsJson: string) => string} rewrite
 * @returns {Promise<boolean>} true when the row changed
 */
export async function rewriteCopilotAppProviderSettings(dbPath, rewrite) {
  const provider = await findFireconnectProvider(dbPath);
  if (!provider) {
    return false;
  }
  const next = rewrite(provider.settings_json);
  if (next === provider.settings_json) {
    return false;
  }
  await execCopilotSql(dbPath, [
    `UPDATE model_providers SET settings_json = ${sqlText(next)} WHERE id = ${sqlText(provider.id)};`,
  ]);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Running-app guard — same rationale as Cursor/VS Code: writes while the app  */
/* is open can be clobbered by its WAL/in-memory state.                        */
/* -------------------------------------------------------------------------- */

/**
 * The guard exists for the **desktop app** only: it holds data.db open and can
 * clobber our write from its WAL/in-memory state. The Copilot **CLI** shares
 * the ~/.copilot directory but never touches data.db, and this harness
 * configures it through providers.json — so a running CLI session must not be
 * mistaken for the app. Each pattern is therefore specific to the app's own
 * binary rather than the word "copilot", which is the CLI's binary name.
 */
export const COPILOT_PROCESS_SPEC = {
  // Bundle is "GitHub Copilot.app", executable "github".
  darwinPattern: "Copilot.app/Contents/MacOS/github",
  // The official .deb installs the app as `/usr/bin/github` and its desktop
  // entry runs `github %u`, so the process is just `github`; match that as the
  // command itself, never as a path argument. The other alternatives cover a
  // `github-copilot*` binary or a `GitHub Copilot/` install dir. A bare
  // `[/]copilot` would also match the CLI (`/usr/local/bin/copilot`), blocking
  // on/off for a quit never required; verified against real pgrep that this
  // does not.
  linuxPattern: "^([^ ]*/)?github( |$)|[/](github-copilot|GitHub Copilot)",
  // tasklist reports image names only (no paths), so this must enumerate the
  // desktop executables: `github.exe` (1.4.0), a `github-copilot*`/`GitHub Copilot*` app
  // and `copilotd.exe`, the daemon the app's own PowerShell strings reference.
  // The CLI installs as `copilot.exe`, which none of these match — `copilotd`
  // differs from `copilot` before the word boundary the caller anchors with.
  // Matching is case-insensitive (isIdeRunning compiles with "im").
  windowsImage: "(github|github[- ]copilot[^ ]*|copilotd)\\.exe",
};

const COPILOT_RUNNING_MESSAGE =
  `GitHub Copilot is running. ${quitInstruction("GitHub Copilot")} so the write isn't overwritten by the app's in-memory state, then rerun. Or pass --force to write anyway (not recommended).`;

export function isCopilotRunning() {
  return isIdeRunning(COPILOT_PROCESS_SPEC);
}

/**
 * Wait for the Copilot app to be quit before writing (interactive TTY wait,
 * --force escape — identical semantics to ensureCursorStopped).
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureCopilotStopped({ force = false } = {}) {
  return ensureIdeStopped(COPILOT_PROCESS_SPEC, COPILOT_RUNNING_MESSAGE, { force, label: "GitHub Copilot" });
}
