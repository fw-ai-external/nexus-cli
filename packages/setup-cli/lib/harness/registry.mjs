import claude from "../harnesses/claude/index.mjs";
import claudeDesktop from "../harnesses/claude-desktop/index.mjs";
import codex from "../harnesses/codex/index.mjs";
import copilotApp from "../harnesses/copilot-app/index.mjs";
import copilotCli from "../harnesses/copilot-cli/index.mjs";
import cursor from "../harnesses/cursor/index.mjs";
import deepseek from "../harnesses/deepseek/index.mjs";
import hermes from "../harnesses/hermes/index.mjs";
import opencode from "../harnesses/opencode/index.mjs";
import pi from "../harnesses/pi/index.mjs";
import vscode, { vscodeNeedsRestore } from "../harnesses/vscode/index.mjs";
import { isHarnessRouted } from "./engine.mjs";
import { HARNESSES } from "./id.mjs";

/** @typedef {import("./types.mjs").HarnessAdapter} HarnessAdapter */

const REGISTRY = new Map(
  [claude, claudeDesktop, opencode, codex, pi, cursor, vscode, copilotApp, copilotCli, deepseek, hermes].map((adapter) => [adapter.id, adapter]),
);

/**
 * @param {string} id
 * @returns {HarnessAdapter}
 */
export function getHarness(id) {
  const adapter = REGISTRY.get(id);
  if (!adapter) {
    throw new Error(`Unknown harness: ${id}. Choose one of: ${HARNESSES.join(", ")}`);
  }
  return adapter;
}

/**
 * @returns {HarnessAdapter[]}
 */
export function listHarnesses() {
  return [...REGISTRY.values()];
}

/**
 * Ids of the harnesses whose own config routes through Fireworks, in registry
 * order. Local reads only; path overrides are cleared so every harness resolves
 * its default location under `home`.
 *
 * Reads each harness's config (`isHarnessRouted`) rather than Nexus's
 * `enabled` flag, which can drift.
 * @param {import("./types.mjs").HarnessContext} ctx
 * @param {string} home
 * @returns {Promise<string[]>}
 */
export async function listRoutedHarnessIds(ctx, home) {
  return listMatchingHarnessIds(ctx, home, isHarnessRouted);
}

export async function listHarnessIdsToRestore(ctx, home) {
  if ((ctx.platform ?? process.platform) !== "win32") {
    return listRoutedHarnessIds(ctx, home);
  }
  return listMatchingHarnessIds(ctx, home, (adapter, harnessCtx) =>
    adapter === vscode ? vscodeNeedsRestore(harnessCtx) : isHarnessRouted(adapter, harnessCtx));
}

async function listMatchingHarnessIds(ctx, home, matches) {
  const ids = [];
  for (const adapter of listHarnesses()) {
    if (await matches(adapter, { ...ctx, home, settingsPath: "", configPath: "", dataDir: "" })) {
      ids.push(adapter.id);
    }
  }
  return ids;
}
