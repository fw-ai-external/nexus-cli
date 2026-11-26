/**
 * Fireworks Ultra-fast in Codex's footer: a custom status line provider
 * (Codex's experimental `features.tui_extensions_statusline`) served by the
 * Node script in mods/codex-ultrafast/, which also picks the pet's animations.
 *
 * `on` adds three pieces, every line tagged `# nexus: ultrafast` so the strip
 * removes exactly them:
 *
 *   [features]                    tui_extensions_statusline = true
 *   [tui]                         status_line_provider = { server = "fireworks-nexus", tool = "ultrafast_status" }
 *   [mcp_servers.fireworks-nexus] the server: command, args, env, env_vars
 *
 * All or nothing, and the user's own choices win: when the config already sets
 * either key, has its own `mcp_servers.fireworks-nexus`, or defines `tui` or
 * `features` as an inline table Nexus can't extend safely, nothing is added.
 */

import { statements } from "./feature-patch.mjs";
import { parseToml, tomlString } from "./toml.mjs";

export const ULTRAFAST_MARKER = "# nexus: ultrafast";
export const ULTRAFAST_SERVER_NAME = "fireworks-nexus";
export const ULTRAFAST_TOOL_NAME = "ultrafast_status";
/** Codex release that has the custom status line provider (`tui_extensions_statusline`). */
export const CODEX_ULTRAFAST_MIN_VERSION = "0.171.0";

const MCP_TABLE = `mcp_servers.${ULTRAFAST_SERVER_NAME}`;
const MCP_HEADER = `[${MCP_TABLE}] ${ULTRAFAST_MARKER}`;
const FEATURE_VALUE = "true";
const PROVIDER_VALUE = `{ server = "${ULTRAFAST_SERVER_NAME}", tool = "${ULTRAFAST_TOOL_NAME}" }`;
/** Environment the server may read from Codex's own: switches and the loopback mock, never a key. */
export const ULTRAFAST_ENV_VARS = Object.freeze(["NEXUS_ULTRAFAST_STATUS", "NEXUS_ULTRAFAST_MOCK_URL", "NEXUS_CODEX_ULTRAFAST_WIDTH"]);


/** The keys the patch adds: [table, key, value]. */
const KEYS = Object.freeze([
  ["features", "tui_extensions_statusline", FEATURE_VALUE],
  ["tui", "status_line_provider", PROVIDER_VALUE],
]);

function parsed(raw) {
  try {
    return parseToml(raw);
  } catch {
    return null;
  }
}

/** The parsed text if it still parses, else the original. */
function checked(next, raw) {
  return parsed(next) ? next : raw;
}

const inlineTable = (name) => new RegExp(`^\\s*${name}\\s*=\\s*\\{`);

/**
 * Add `key = value # marker` to `[table]`: inside an existing `[table]`
 * section, as a dotted root key when the table exists only through dotted keys
 * or sub-tables, or as a new `[table] # marker` section at the end.
 * Returns null when the table is an inline table at the root.
 */
function addMarkedKey(raw, table, key, value) {
  const doc = parsed(raw);
  if (!doc) return null;
  const line = `${key} = ${value} ${ULTRAFAST_MARKER}`;
  const parts = statements(raw);
  let atRoot = true;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.header) {
      atRoot = false;
      if (Object.keys(part.doc.tables).length === 1 && Object.hasOwn(part.doc.tables, table)) {
        let end = i + 1;
        while (end < parts.length && !parts[end].header) end++;
        while (end - 1 > i && !parts[end - 1].raw.trim()) end--;
        const last = parts[end - 1];
        last.raw = `${last.raw.replace(/\n?$/, "\n")}${line}\n`;
        return parts.map((entry) => entry.raw).join("");
      }
    } else if (atRoot && inlineTable(table).test(part.raw)) {
      return null;
    }
  }
  if (doc.tables[table]) return `${table}.${line}\n${raw}`;
  return `${raw}${raw.endsWith("\n") || !raw ? "" : "\n"}\n[${table}] ${ULTRAFAST_MARKER}\n${line}\n`;
}

/**
 * Whether `on` may add the Ultra-fast pieces to `raw` (a config already
 * stripped of Nexus's own lines): it parses, and the user hasn't set either key,
 * named an MCP server `fireworks-nexus`, or made `tui`/`features` inline tables.
 */
export function canPatchCodexUltrafast(raw) {
  const doc = parsed(raw);
  if (!doc) return false;
  if (Object.hasOwn(doc.root, "tui") || Object.hasOwn(doc.root, "features") || Object.hasOwn(doc.root, "mcp_servers")) {
    // Root keys only appear here for non-table values; tables live in doc.tables.
    return false;
  }
  for (const [table, key] of KEYS) {
    if (doc.tables[table] && Object.hasOwn(doc.tables[table], key)) return false;
  }
  if (doc.tables[MCP_TABLE]) return false;
  for (const part of statements(raw)) {
    if (part.header) break;
    if (inlineTable("tui").test(part.raw) || inlineTable("features").test(part.raw) || inlineTable("mcp_servers").test(part.raw)) return false;
  }
  return true;
}

/**
 * The MCP server table: Codex starts `nodePath serverPath` with only the
 * environment it passes every MCP server (HOME, PATH, TZ, ...), plus `env`
 * (where to find the config, the pet folder and the status cache) and
 * `env_vars` (the switches).
 * The Fireworks key is not in it: the server reads the key `on` wrote into the
 * Codex config, as `codex` itself does.
 */
function mcpTable({ nodePath, serverPath, configPath, petDir, cacheFile }) {
  const env = [
    `NEXUS_CODEX_CONFIG = ${tomlString(configPath)}`,
    ...(petDir ? [`NEXUS_CODEX_PET_DIR = ${tomlString(petDir)}`] : []),
    ...(cacheFile ? [`NEXUS_CODEX_STATUS_CACHE = ${tomlString(cacheFile)}`] : []),
  ];
  return [
    MCP_HEADER,
    `command = ${tomlString(nodePath)}`,
    `args = [${tomlString(serverPath)}]`,
    `env = { ${env.join(", ")} }`,
    `env_vars = [${ULTRAFAST_ENV_VARS.map(tomlString).join(", ")}]`,
  ].join("\n");
}

/**
 * Add the Ultra-fast footer to `raw`, or return `raw` unchanged when the user's
 * config rules it out (see {@link canPatchCodexUltrafast}).
 * @param {string} raw
 * @param {{ nodePath: string, serverPath: string, configPath: string, petDir?: string, cacheFile?: string }} options
 *   `petDir` is the Nexus pet folder when the config selects Nexus's pet, so the
 *   server can pick its animations; without it only the footer changes.
 *   `cacheFile` is where the server keeps the last boost status (Nexus's data
 *   folder, so it outlives the pet folder across `off` and `on`).
 */
export function patchCodexUltrafastRaw(raw, options) {
  if (!canPatchCodexUltrafast(raw)) return raw;
  let next = raw;
  for (const [table, key, value] of KEYS) {
    const added = addMarkedKey(next, table, key, value);
    if (added == null) return raw;
    next = added;
  }
  next = `${next}${next.endsWith("\n") || !next ? "" : "\n"}\n${mcpTable(options)}\n`;
  const doc = parsed(next);
  if (!doc || doc.tables.features?.tui_extensions_statusline !== true || !doc.tables.tui?.status_line_provider || !doc.tables[MCP_TABLE]) {
    return raw;
  }
  return next;
}

/** Whether the config text carries Nexus's Ultra-fast footer. */
export function hasCodexUltrafast(raw) {
  return raw.includes(MCP_HEADER);
}

/** The server script path in the config's Nexus MCP table, or "". */
/**
 * The status cache path the config's MCP table gives the server
 * (`NEXUS_CODEX_STATUS_CACHE`), or "" for a footer an older `on` wrote.
 * @param {string} raw
 */
export function configuredCodexUltrafastCacheFile(raw) {
  if (!hasCodexUltrafast(raw)) return "";
  const value = parsed(raw)?.tables[MCP_TABLE]?.env?.NEXUS_CODEX_STATUS_CACHE;
  return typeof value === "string" ? value : "";
}

export function configuredCodexUltrafastServer(raw) {
  if (!hasCodexUltrafast(raw)) return "";
  const args = parsed(raw)?.tables[MCP_TABLE]?.args;
  return Array.isArray(args) && typeof args[0] === "string" ? args[0] : "";
}

/**
 * Remove exactly what {@link patchCodexUltrafastRaw} added: the marked keys,
 * the marked MCP table (with every line under it), and a marked `[features]`
 * or `[tui]` header the user hasn't since put keys under. A header the user
 * kept loses only its marker.
 * @param {string} raw
 */
export function stripCodexUltrafastRaw(raw) {
  if (!raw.includes(ULTRAFAST_MARKER)) return raw;
  const parts = statements(raw);
  // The MCP table: its marked header and everything up to the next header.
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].raw.trim() !== MCP_HEADER) continue;
    let end = i + 1;
    while (end < parts.length && !parts[end].header) end++;
    for (let j = i; j < end; j++) parts[j].raw = "";
    const previous = parts[i - 1];
    if (previous && !previous.raw.trim()) previous.raw = "";
  }
  // The marked keys, in their section or dotted at the root.
  for (const part of parts) {
    const trimmed = part.raw.trim();
    for (const [table, key, value] of KEYS) {
      const line = `${key} = ${value} ${ULTRAFAST_MARKER}`;
      if (trimmed === line || trimmed === `${table}.${line}`) part.raw = "";
    }
  }
  // Marked headers: drop when nothing but comments remain under them.
  for (const [table] of KEYS) {
    const header = `[${table}] ${ULTRAFAST_MARKER}`;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].raw.trim() !== header) continue;
      let end = i + 1;
      while (end < parts.length && !parts[end].header) end++;
      const body = parts.slice(i + 1, end);
      if (body.every((part) => part.raw.split("\n").every((l) => !l.trim() || l.trimStart().startsWith("#")))) {
        parts[i].raw = "";
        const previous = parts[i - 1];
        if (previous && !previous.raw.trim()) previous.raw = "";
      } else {
        parts[i].raw = parts[i].raw.replace(/[ \t]*# nexus: ultrafast[ \t]*(\r?\n?)$/, "$1");
      }
    }
  }
  return checked(parts.map((part) => part.raw).join(""), raw);
}
