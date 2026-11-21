// "Is Claude routed through Nexus?" is decided twice: in JS
// (inspectClaudeUpgradeState → claudeFireconnectIntent) for `nexus update`, and
// in the root install.sh (claude_is_fireconnect_enabled) before a reinstall.
// Both must agree on every config. This test generates many synthetic configs
// (seeded, so failures replay), runs both, and requires agreement on all of
// them and on the shortest witnesses in WITNESSES.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { inspectClaudeUpgradeState } from "../../lib/system/upgrade.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const INSTALL_PATH = path.join(REPO_ROOT, "install.sh");
const BASE_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
const CASES = 400;

const BASE_URLS = [
  undefined,
  "https://api.fireworks.ai/inference",
  "https://api.fireworks.ai/inference/v1",
  "https://FIREWORKS.AI",
  "https://example.com",
  "https://notfireworks.ai",
  "not a url",
  "",
];
const MODELS = [
  undefined,
  "accounts/fireworks/models/example-model",
  "example-model[1m]",
  "opus",
  "My Model",
];
const HEADERS = [
  undefined,
  "",
  "x-fireworks-api-key: fw_synthetic",
  "X-Fireworks-Api-Key: fpk_synthetic",
  "X-Title: Claude Code",
  "user-agent: nexus/1.2.3",
  "user-agent: nexus/dev-build",
  "x-firerouter-fireworks-key: fw_synthetic",
  "x-custom: 1",
  "x-custom: 1\n",
];
const HELPERS = [
  undefined,
  "/home/u/.local/bin/fireconnect key export",
  "/home/u/.local/bin/nexus key export",
  "nexus.cmd key export",
  "/usr/bin/pass show synthetic",
  "/opt/managed-helper",
];
const API_KEYS = [undefined, "fireconnect", "sk-synthetic"];
const GLOBALS = [undefined, true, false, "true"];
const BACKUPS = [undefined, {}, { snapshot: { existed: false, raw: "" } }, { values: {} }];
const STATES = [undefined, {}, { authMode: "apiKeyHelper" }, { managedApiKeyHelper: "/opt/managed-helper" }];

// Shortest witnesses of disagreements the two sides once had, with the verdict
// both must now give. Add a row (and fix one side) when a new one turns up.
const WITNESSES = [
  {
    id: "nexus-helper",
    verdict: "enabled",
    why: "A `nexus key export` apiKeyHelper is Nexus's own, like the `fireconnect` one.",
    config: { baseUrl: "https://api.fireworks.ai/inference/v1", helper: "/home/u/.local/bin/nexus key export" },
  },
  {
    id: "fpk-header",
    verdict: "enabled",
    why: "A retired Fire Pass (fpk_) X-Fireworks-Api-Key plus a mapping was written by Nexus.",
    config: { baseUrl: "https://api.fireworks.ai/inference/v1", headers: "X-Fireworks-Api-Key: fpk_synthetic", model: "example-model[1m]" },
  },
  {
    id: "firerouter-key-header",
    verdict: "enabled",
    why: "FireConnect before 0.9 wrote x-firerouter-fireworks-key in router mode.",
    config: { baseUrl: "https://api.fireworks.ai/inference/v1", headers: "x-firerouter-fireworks-key: fw_synthetic" },
  },
  {
    id: "user-agent-shape",
    verdict: "disabled",
    why: "Only `nexus/<x.y.z>` or `nexus/unknown` is the user-agent Nexus wrote.",
    config: { baseUrl: "https://api.fireworks.ai/inference/v1", headers: "user-agent: nexus/dev-build" },
  },
  {
    id: "blank-header-line",
    verdict: "disabled",
    why: "A blank line in ANTHROPIC_CUSTOM_HEADERS is not telemetry.",
    config: { baseUrl: "https://api.fireworks.ai/inference/v1", headers: "x-custom: 1\n" },
  },
  {
    id: "exact-base-url-mapping",
    verdict: "enabled",
    why: "On Nexus's exact base URL unset slots map to Claude's native model, so a fw_ header is managed.",
    config: { baseUrl: "https://api.fireworks.ai/inference", headers: "x-fireworks-api-key: fw_synthetic" },
  },
  {
    id: "top-level-model-mapping",
    verdict: "enabled",
    why: "`on` writes the main slot to the top-level `model` field.",
    config: { baseUrl: "https://api.fireworks.ai/inference/v1", headers: "x-fireworks-api-key: fw_synthetic", topModel: "example-model[1m]" },
  },
  {
    id: "top-level-alias",
    verdict: "disabled",
    why: "A bare `/model` picker alias in `model` pins nothing.",
    config: { baseUrl: "https://api.fireworks.ai/inference/v1", headers: "x-fireworks-api-key: fw_synthetic", topModel: "opus" },
  },
  {
    id: "model-shape",
    verdict: "enabled",
    why: "Any non-empty model env slot is a mapping, whatever its shape.",
    config: { baseUrl: "https://api.fireworks.ai/inference/v1", headers: "x-fireworks-api-key: fw_synthetic", model: "My Model" },
  },
];

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(count, seed = 671) {
  const rand = mulberry32(seed);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const configs = [];
  for (let i = 0; i < count; i += 1) {
    configs.push({
      globalEnabled: pick(GLOBALS),
      // Bias toward a Fireworks host so ownership evidence is exercised.
      baseUrl: rand() < 0.7 ? pick(BASE_URLS.slice(1, 4)) : pick(BASE_URLS),
      topModel: rand() < 0.2 ? pick(MODELS) : undefined,
      model: rand() < 0.5 ? pick(MODELS) : undefined,
      headers: pick(HEADERS),
      helper: rand() < 0.4 ? pick(HELPERS) : undefined,
      apiKey: rand() < 0.3 ? pick(API_KEYS) : undefined,
      backup: rand() < 0.3 ? pick(BACKUPS) : undefined,
      state: rand() < 0.4 ? pick(STATES) : undefined,
    });
  }
  return configs;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function materialize(home, c) {
  if (c.globalEnabled !== undefined) {
    await writeJson(path.join(home, ".nexus/config.json"), {
      harnesses: { claude: { enabled: c.globalEnabled } },
    });
  }
  const env = {};
  if (c.baseUrl !== undefined) env.ANTHROPIC_BASE_URL = c.baseUrl;
  if (c.model !== undefined) env.ANTHROPIC_DEFAULT_SONNET_MODEL = c.model;
  if (c.headers !== undefined) env.ANTHROPIC_CUSTOM_HEADERS = c.headers;
  if (c.apiKey !== undefined) env.ANTHROPIC_API_KEY = c.apiKey;
  const settings = { env };
  if (c.topModel !== undefined) settings.model = c.topModel;
  if (c.helper !== undefined) settings.apiKeyHelper = c.helper;
  await writeJson(path.join(home, ".claude/settings.json"), settings);
  if (c.backup !== undefined) await writeJson(path.join(home, ".nexus/claude/provider-backup.json"), c.backup);
  if (c.state !== undefined) await writeJson(path.join(home, ".nexus/claude/provider-state.json"), c.state);
}

async function shellRunner(root) {
  const source = await readFile(INSTALL_PATH, "utf8");
  const fn = source.match(/^claude_is_fireconnect_enabled\(\) \{\n[\s\S]*?\nNODE\n\}\n/m)?.[0];
  assert.ok(fn, "expected claude_is_fireconnect_enabled in install.sh");
  const runner = path.join(root, "claude-enabled-runner.sh");
  await writeFile(runner, `#!/usr/bin/env bash
${fn}
for home in "$@"; do
  HOME="$home" claude_is_fireconnect_enabled 2>/dev/null
  printf '%s\\n' "$?"
done
`);
  return runner;
}

function shellVerdicts(runner, homes) {
  const result = spawnSync("bash", [runner, ...homes], {
    encoding: "utf8",
    env: { PATH: BASE_PATH, HOME: homes[0] ?? "/nonexistent" },
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split("\n").map((code) => (
    code === "0" ? "enabled" : code === "1" ? "disabled" : `error(${code})`
  ));
}

async function jsVerdict(home) {
  try {
    return (await inspectClaudeUpgradeState(home)).enabled ? "enabled" : "disabled";
  } catch {
    return "error(2)";
  }
}

async function compare(configs) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-claude-parity-"));
  try {
    const runner = await shellRunner(root);
    const homes = [];
    for (const [index, config] of configs.entries()) {
      const home = path.join(root, `home-${index}`);
      await mkdir(home, { recursive: true });
      await materialize(home, config);
      homes.push(home);
    }
    const shell = shellVerdicts(runner, homes);
    const js = await Promise.all(homes.map(jsVerdict));
    return configs.map((config, index) => ({ config, js: js[index], shell: shell[index] }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Claude-enabled parity: install.sh vs JS", () => {
  it("gives the recorded verdict on every witness, on both sides", async () => {
    const results = await compare(WITNESSES.map((row) => row.config));
    for (const [index, { js, shell }] of results.entries()) {
      const row = WITNESSES[index];
      assert.deepEqual({ js, shell }, { js: row.verdict, shell: row.verdict }, `${row.id}: ${row.why}`);
    }
  });

  it(`agrees on ${CASES} generated configs`, async () => {
    const results = await compare(generate(CASES));
    const disagreements = results.filter(({ js, shell }) => js !== shell);
    assert.deepEqual(disagreements, [], "install.sh/JS disagreement");
    assert.ok(results.some(({ js }) => js === "enabled"), "generator never produced an enabled config");
    assert.ok(results.some(({ js }) => js === "disabled"), "generator never produced a disabled config");
  });
});
