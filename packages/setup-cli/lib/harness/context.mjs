import path from "node:path";
import {
  resolveDataDir,
  userSettingsPath,
} from "../harnesses/claude/core.mjs";
import {
  codexConfigPath,
  codexCatalogPath,
  codexDataDir,
} from "../harnesses/codex/core.mjs";
import {
  deepseekCredentialsPath,
  deepseekDataDir,
  deepseekSettingsPath,
} from "../harnesses/deepseek/core.mjs";
import { hermesConfigPath, hermesDataDir } from "../harnesses/hermes/core.mjs";
import {
  opencodeConfigPath,
  opencodeDataDir,
} from "../harnesses/opencode/core.mjs";
import {
  piAuthPath,
  piDataDir,
  piModelsPath,
  piSettingsPath,
} from "../harnesses/pi/core.mjs";
import { cursorStateDbPath, cursorDataDir } from "../harnesses/cursor/core.mjs";
import { chatLanguageModelsPath, vscodeDataDir, vscodeStateDbPath } from "../harnesses/vscode/core.mjs";
import { copilotDataDir } from "../harnesses/copilot-app/core.mjs";
import { copilotDataDbPath } from "../harnesses/copilot-app/sqlite.mjs";
import {
  copilotCliDataDir,
  copilotProvidersPath,
  copilotSettingsPath,
} from "../harnesses/copilot-cli/config.mjs";

/** @typedef {import("./types.mjs").HarnessContext} HarnessContext */

/**
 * @param {HarnessContext} ctx
 */
export function claudePathsFor(ctx) {
  return {
    settingsPath: userSettingsPath(ctx.home, ctx.settingsPath),
    dataDir: resolveDataDir({ home: ctx.home, dataDir: ctx.dataDir }),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function opencodePathsFor(ctx) {
  return {
    configPath: opencodeConfigPath(ctx.home, ctx.configPath),
    dataDir: opencodeDataDir(ctx.home, ctx.dataDir),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function codexPathsFor(ctx) {
  return {
    configPath: codexConfigPath(ctx.home, ctx.configPath),
    dataDir: codexDataDir(ctx.home, ctx.dataDir),
    catalogPath: codexCatalogPath(ctx.home, ctx.catalogPath),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function piPathsFor(ctx) {
  const settingsPath = piSettingsPath(ctx.home, ctx.settingsPath || ctx.configPath);
  return {
    settingsPath,
    authPath: piAuthPath(ctx.home, "", settingsPath),
    modelsPath: piModelsPath(ctx.home, settingsPath),
    dataDir: piDataDir(ctx.home, ctx.dataDir),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function cursorPathsFor(ctx) {
  return {
    dbPath: cursorStateDbPath({ home: ctx.home, dbPath: ctx.dbPath }),
    dataDir: cursorDataDir(ctx.home, ctx.dataDir),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function vscodePathsFor(ctx) {
  return {
    vscodePath: chatLanguageModelsPath({ home: ctx.home, vscodePath: ctx.vscodePath }),
    stateDbPath: vscodeStateDbPath({ home: ctx.home, vscodePath: ctx.vscodePath }),
    dataDir: vscodeDataDir(ctx.home, ctx.dataDir),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function copilotAppPathsFor(ctx) {
  return {
    dbPath: copilotDataDbPath({ home: ctx.home, dbPath: ctx.dbPath }),
    dataDir: copilotDataDir(ctx.home, ctx.dataDir),
  };
}

/**
 * The CLI harness's paths live in its own data dir so its backup can never
 * collide with the desktop harness's.
 * @param {HarnessContext} ctx
 */
export function copilotCliPathsFor(ctx) {
  return {
    providersPath: copilotProvidersPath({ home: ctx.home, providersPath: ctx.providersPath }),
    settingsPath: copilotSettingsPath({ home: ctx.home }),
    dataDir: copilotCliDataDir(ctx.home, ctx.dataDir),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function deepseekPathsFor(ctx) {
  const settingsPath = deepseekSettingsPath(ctx.home, ctx.configPath);
  return {
    settingsPath,
    credentialsPath: deepseekCredentialsPath(ctx.home, { settingsPath }),
    dataDir: deepseekDataDir(ctx.home, ctx.dataDir),
  };
}

/**
 * @param {HarnessContext} ctx
 */
export function hermesPathsFor(ctx) {
  return {
    configPath: hermesConfigPath(ctx.home, ctx.configPath),
    dataDir: hermesDataDir(ctx.home, ctx.dataDir),
  };
}

/** Per-harness path-override fields + the flag to suggest in the error message. */
const HOME_VALIDATION = {
  claude: { fields: ["settingsPath"], flag: "--settings-path" },
  "claude-desktop": { fields: [], flag: "--home" },
  opencode: { fields: ["configPath"], flag: "--config-path" },
  codex: { fields: ["configPath"], flag: "--config-path" },
  pi: { fields: ["settingsPath", "configPath"], flag: "--settings-path" },
  cursor: { fields: ["dbPath"], flag: "--db-path" },
  "copilot-app": { fields: ["dbPath"], flag: "--db-path" },
  "copilot-cli": { fields: ["providersPath"], flag: "--providers-path" },
  vscode: { fields: ["vscodePath"], flag: "--vscode-path" },
  copilot: { fields: ["dbPath"], flag: "--db-path" },
  deepseek: { fields: ["configPath"], flag: "--config-path" },
  hermes: { fields: ["configPath"], flag: "--config-path" },
};

/** The flag that sets each path-override field, for "re-run" hints. */
const PATH_OVERRIDE_FLAGS = {
  configPath: "--config-path",
  settingsPath: "--settings-path",
  dbPath: "--db-path",
  providersPath: "--providers-path",
  vscodePath: "--vscode-path",
  dataDir: "--data-dir",
};

/**
 * The file-path overrides `ctx` sets for `harnessId` (`--config-path` and
 * friends), as absolute paths; empty when the harness uses its defaults.
 * @param {Partial<HarnessContext>} ctx
 * @param {string} harnessId
 * @returns {Record<string, string>}
 */
export function harnessPathOverrides(ctx, harnessId) {
  const fields = HOME_VALIDATION[harnessId]?.fields ?? [];
  const set = (field) => typeof ctx[field] === "string" && ctx[field];
  const overrides = fields.filter(set);
  // `--data-dir` goes with the file it backs up (a key refresh may update
  // the backup there), but alone it doesn't make a separate config.
  if (overrides.length && set("dataDir")) overrides.push("dataDir");
  return Object.fromEntries(overrides.map((field) => [field, path.resolve(ctx[field])]));
}

/**
 * `ctx` with every path override for `harnessId` cleared: its default config.
 * @template {Partial<HarnessContext>} T
 * @param {T} ctx
 * @param {string} harnessId
 * @returns {T}
 */
export function withoutPathOverrides(ctx, harnessId) {
  const fields = [...(HOME_VALIDATION[harnessId]?.fields ?? []), "dataDir"];
  return { ...ctx, ...Object.fromEntries(fields.map((field) => [field, ""])) };
}

/** Shell-quote a path for a copy-paste hint: single quotes, so nothing in it expands. */
function shellQuote(value) {
  return /^[\w@%+=:,./~-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The flags that reproduce `overrides`, e.g. `--config-path /work/config.toml`.
 * @param {Record<string, string>} overrides
 */
export function pathOverrideFlags(overrides) {
  return Object.entries(overrides)
    .filter(([field]) => PATH_OVERRIDE_FLAGS[field])
    .map(([field, value]) => `${PATH_OVERRIDE_FLAGS[field]} ${shellQuote(value)}`)
    .join(" ");
}

/**
 * @param {HarnessContext} ctx
 * @param {"claude" | "opencode" | "codex" | "pi" | "cursor" | "vscode" | "copilot" | "deepseek" | "hermes"} harnessId
 */
export function ensureHomeForHarness(ctx, harnessId) {
  const req = HOME_VALIDATION[harnessId] ?? HOME_VALIDATION.claude;
  const hasOverride = req.fields.some((field) => ctx[field]);
  if (!hasOverride && !ctx.home) {
    throw new Error(`HOME is not set; pass --home or ${req.flag}`);
  }
}
