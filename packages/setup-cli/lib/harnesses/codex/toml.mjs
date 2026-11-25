import { parse } from "smol-toml";

function isRecord(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && !(value instanceof Date);
}

function collectTables(value, path, tables) {
  if (!isRecord(value)) {
    return;
  }
  const table = {};
  for (const [key, entry] of Object.entries(value)) {
    table[key] = entry;
    if (isRecord(entry)) {
      collectTables(entry, [...path, key], tables);
    }
  }
  if (path.length > 0) {
    tables[path.join(".")] = table;
  }
}

/**
 * A TOML parse error without the parser's code frame: the offending line
 * can hold an API key.
 */
export class TomlSyntaxError extends Error {
  constructor(error) {
    const reason = String(error?.message ?? error).split("\n")[0].replace(/^Invalid TOML document:\s*/, "");
    const where = Number.isInteger(error?.line) ? ` (line ${error.line}, column ${error.column})` : "";
    super(`${reason}${where}`);
    this.name = "TomlSyntaxError";
    this.reason = reason;
  }
}

/**
 * Parse TOML with the complete TOML grammar, then expose the flat `{root,
 * tables}` view expected by existing harness adapters.
 * @throws {TomlSyntaxError}
 */
export function parseToml(text) {
  if (!text.trim()) {
    return { root: {}, tables: {} };
  }
  let parsed;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new TomlSyntaxError(error);
  }
  const root = {};
  const tables = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isRecord(value)) {
      collectTables(value, [key], tables);
    } else {
      root[key] = value;
    }
  }
  return { root, tables };
}

const TOML_ESCAPES = { "\\": "\\\\", "\"": "\\\"", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };

/**
 * A TOML basic string. Every value Nexus writes goes through here: quotes,
 * backslashes and all control characters are escaped, so a value can only
 * ever set its own key.
 */
export function tomlString(value) {
  return `"${String(value).replace(/[\\"\u0000-\u001f\u007f]/g, (c) =>
    TOML_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}
