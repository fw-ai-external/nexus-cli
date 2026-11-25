// The banner mod can't import from lib/ (it runs in Claude Code's sandbox from
// its own folder), so it keeps copies of a few CLI rules. These tests pin each
// copy to the CLI's own, the way the frames test pins the logo, so changing one
// side without the other fails here instead of silently stopping the banner or
// the badge.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { FIREWORKS_GATEWAY_URL as CLI_GATEWAY_URL } from "../../lib/fireworks/models.mjs";
import { isAutoModelId } from "../../lib/fireworks/model-id.mjs";
import { AUTO_INSTANT_MODEL_ID, AUTO_MODEL_ID, KNOWN_AUTO_MODEL_IDS, NEXUS_AUTO_MODEL_ID, NON_GATEWAY_AUTO_IDS } from "../../lib/fireworks/model-specs.mjs";
import { claudeFireworksKeyFrom } from "../../lib/harnesses/claude/core.mjs";
import {
  ULTRAFAST_BOOST_FILE,
  ULTRAFAST_BOOST_MAX_AGE_MS,
  formatTimeLeft,
} from "../../lib/harnesses/claude/ultrafast-badge.mjs";
import { NEXUS_OWNED_FILENAMES } from "../../lib/system/data-dir.mjs";
import { FLAG_MAX_AGE_MS, boostsModel, formatRemaining } from "../../mods/ultrafast-fireworks/hooks/frames.mjs";
import { FIREWORKS_GATEWAY_URL, fireworksKeyFromEnv } from "../../mods/ultrafast-fireworks/hooks/rewards.mjs";

const REGISTER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../mods/ultrafast-fireworks/hooks/register.tsx");

describe("the banner mod's copies of CLI rules", () => {
  it("treats a boost record as stale at the same age as the status line", () => {
    assert.equal(FLAG_MAX_AGE_MS, ULTRAFAST_BOOST_MAX_AGE_MS);
  });

  it("writes the boost record where the status line reads it, a name the data dir owns", () => {
    const literal = /const BOOST_FILE = '([^']+)'/.exec(readFileSync(REGISTER, "utf8"))?.[1];
    assert.equal(literal, ULTRAFAST_BOOST_FILE.split(path.sep).join("/"));
    assert.ok(NEXUS_OWNED_FILENAMES.includes(path.basename(ULTRAFAST_BOOST_FILE)));
  });

  it("finds the Fireworks key in Claude Code's settings env exactly as `nexus claude on` writes it", () => {
    const shapes = [
      { ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_header" },
      { ANTHROPIC_CUSTOM_HEADERS: "X-Other: 1\nX-Fireworks-Api-Key: fw_second_line" },
      { ANTHROPIC_API_KEY: "fw_direct" },
      { ANTHROPIC_AUTH_TOKEN: "fw_token" },
      { ANTHROPIC_API_KEY: "sk-ant-not-fireworks" },
      { ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: not-a-key" },
      {},
    ];
    for (const env of shapes) {
      assert.equal(fireworksKeyFromEnv(env), claudeFireworksKeyFrom({ env }), JSON.stringify(env));
    }
  });

  it("plays only on the models the CLI counts as Nexus Auto", () => {
    const models = [
      "auto", "auto[1m]", "AUTO[1M]", " auto ", "auto-example", "auto-smart", "nexus/auto",
      "example/auto", "autopilot", "example-model", "claude-opus-5-5",
      "opus", "", null, undefined, 42,
    ];
    // Every Auto id and exclusion the CLI defines, read from its own sets so
    // a variant or exclusion added there is compared here too, each in the
    // spellings Claude Code and people use.
    const cliIds = [AUTO_MODEL_ID, AUTO_INSTANT_MODEL_ID, NEXUS_AUTO_MODEL_ID, ...KNOWN_AUTO_MODEL_IDS, ...NON_GATEWAY_AUTO_IDS];
    for (const id of cliIds) {
      for (const spelling of [id, `${id}[1m]`, `${id}[1M]`, ` ${id} `, id.toUpperCase(), `${id}[1m][1m]`, `${id} [1m]`]) models.push(spelling);
    }
    for (const model of models) assert.equal(boostsModel(model), isAutoModelId(model), String(model));
    // The CLI's exclusions are never a boost, in any spelling.
    for (const id of NON_GATEWAY_AUTO_IDS) assert.equal(boostsModel(`${id}[1m]`), false, id);
  });

  it("sends the key only to the Fireworks gateway the CLI uses", () => {
    assert.equal(FIREWORKS_GATEWAY_URL, "https://api.fireworks.ai");
    assert.equal(FIREWORKS_GATEWAY_URL, CLI_GATEWAY_URL);
  });

  it("only uses Text wrap modes every mods-capable Claude Code accepts", () => {
    // 2.1.314 refuses the whole tree for any other value (`clip` included), so the
    // banner silently never shows; this is the set its error message lists.
    const accepted = new Set(["wrap", "end", "middle", "truncate-end", "truncate", "truncate-middle"]);
    // Every wrap prop must be a string literal, in any JSX spelling, so this can check it.
    const props = [...readFileSync(REGISTER, "utf8").matchAll(/\bwrap\s*=\s*([^\s>]+)/g)].map((m) => m[1]);
    assert.ok(props.length > 0);
    for (const prop of props) {
      const mode = /^\{?\s*["']([^"']+)["']\s*\}?$/.exec(prop)?.[1];
      assert.ok(mode !== undefined, `wrap=${prop} is not a string literal`);
      assert.ok(accepted.has(mode), `wrap="${mode}"`);
    }
  });

  it("says the same time left on the banner as on the status line badge", () => {
    for (const minutes of [1, 45, 59, 60, 61, 119, 120, 253, 300, 301]) {
      const ms = minutes * 60_000 - 1_000;
      assert.equal(formatRemaining(ms), formatTimeLeft(ms).replace(/ 00m$/, ""), `${minutes}m`);
    }
  });
});
