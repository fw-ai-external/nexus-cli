import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { CODEX_PROVIDER_TABLE as CORE_PROVIDER_TABLE } from "../../lib/harnesses/codex/core.mjs";
import { decodePng } from "../../scripts/png.mjs";
import { parseToml } from "../../lib/harnesses/codex/toml.mjs";
import { ULTRAFAST_TOOL_NAME } from "../../lib/harnesses/codex/ultrafast-patch.mjs";
import {
  CACHE_MAX_AGE_MS,
  CODEX_PROVIDER_TABLE,
  MAX_LINE_CHARS,
  STATUS_CACHE_FILE,
  TOOL,
  URI,
  createStatusServer,
  fireworksKeyFromCodexConfig,
  keyTag,
} from "../../mods/codex-ultrafast/server.mjs";
import {
  ENDED_NOTE_MS,
  LEVELS,
  LOW,
  NO_BOOST,
  PET_FRAME_COUNT,
  PLAIN_ANIMATIONS,
  TILE,
  boostFromJson,
  displayWidth,
  fillLevel,
  footerTree,
  levelFrames,
  petManifest,
  remaining,
  timeLeft,
  treeText,
  truncate,
} from "../../mods/codex-ultrafast/ultrafast.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PET_DIR_SRC = path.join(HERE, "..", "..", "lib", "ui", "brand", "codex-pet");
const NOW = Date.UTC(2026, 10, 24, 18, 0);
const HOUR = 3_600_000;
const boostWithShare = (share) => ({ active: true, activationId: "w1", activatedAt: NOW - (1 - share) * 5 * HOUR, expiresAt: NOW + share * 5 * HOUR, reason: "" });
const rows = (tree) => treeText(tree).replace(/ /g, " ").split("\n");

describe("Codex Ultra-fast pet", () => {
  it("gives each fill level its own three surface frames, inside the tile cells", () => {
    const seen = new Set();
    for (let level = 1; level <= LEVELS; level++) {
      const frames = levelFrames(level);
      assert.equal(new Set(frames).size, 3);
      for (const f of frames) {
        assert.ok(f >= TILE.levelBase && f < TILE.levelBase + 3 * LEVELS, `level ${level} frame ${f}`);
        assert.ok(!seen.has(f), `frame ${f} belongs to one level`);
        seen.add(f);
      }
    }
    const tileCells = [TILE.flash, ...TILE.rise, ...seen, ...TILE.low];
    assert.equal(new Set(tileCells).size, tileCells.length, "tile cells don't overlap");
    assert.ok(tileCells.every((c) => c > 0 && c < 56), "the tile never uses the logo cells (0, 56..59)");
  });

  it("rounds the share left up to a fill level", () => {
    assert.equal(fillLevel(1), 8);
    assert.equal(fillLevel(0.5), 4);
    assert.equal(fillLevel(0.126), 2);
    assert.equal(fillLevel(LOW), 1);
  });

  it("every manifest passes Codex's custom-pet loader rules and pins Codex's extra animations to the logo", () => {
    const states = [NO_BOOST, { ...NO_BOOST, active: true }, { active: true, activationId: "", activatedAt: null, expiresAt: null, reason: "" }];
    for (let i = 0; i <= 100; i++) states.push(boostWithShare(i / 100));
    for (const boost of states) {
      const pet = petManifest(boost, NOW);
      assert.equal(pet.id, "fireworks-nexus");
      assert.equal(pet.frame.width * pet.frame.columns, 1536);
      assert.equal(pet.frame.height * pet.frame.rows, 1872);
      for (const [name, anim] of Object.entries(pet.animations)) {
        assert.ok(anim.frames.length > 0, name);
        for (const f of anim.frames) assert.ok(Number.isInteger(f) && f >= 0 && f < PET_FRAME_COUNT, `${name}: ${f}`);
        if (anim.fps !== undefined) assert.ok(anim.fps > 0 && anim.fps <= 60);
        assert.ok(Object.hasOwn(pet.animations, anim.fallback ?? "idle"), `${name} fallback`);
      }
      for (const extra of ["running-right", "running-left", "waving", "jumping"]) assert.deepEqual(pet.animations[extra].frames, [0]);
    }
  });

  it("is today's logo pet without a boost, and the tile during one", () => {
    assert.deepEqual(petManifest(NO_BOOST, NOW).animations, PLAIN_ANIMATIONS);
    const full = petManifest(boostWithShare(1), NOW).animations;
    assert.deepEqual(full.level.frames, levelFrames(8));
    assert.equal(full.idle.loop, false);
    assert.equal(full.idle.fallback, "level");
    assert.deepEqual(full.idle.frames.slice(0, 2), [TILE.flash, TILE.flash]);
    assert.ok(petManifest(boostWithShare(0.02), NOW).animations.level.frames.every((f) => TILE.low.includes(f)));
    assert.deepEqual(petManifest({ active: true, activationId: "", activatedAt: null, expiresAt: null, reason: "" }, NOW).animations.level.frames, levelFrames(8));
  });

  it("the shipped pet.json is the plain manifest", () => {
    const shipped = JSON.parse(readFileSync(path.join(PET_DIR_SRC, "pet.json"), "utf8"));
    assert.deepEqual(shipped, JSON.parse(JSON.stringify(petManifest(NO_BOOST, NOW))));
  });

  it("the shipped sheet has the size Codex requires, the logo in cell 0 and the tile in its cells", () => {
    const png = readFileSync(path.join(PET_DIR_SRC, "spritesheet.png"));
    assert.equal(png.readUInt32BE(16), 1536);
    assert.equal(png.readUInt32BE(20), 1872);
    const pixels = decodePng(png).data;
    const opaque = (cell) => {
      const cx = (cell % 8) * 192, cy = Math.floor(cell / 8) * 208;
      let n = 0;
      for (let y = cy; y < cy + 208; y += 2) for (let x = cx; x < cx + 192; x += 2) if (pixels[(y * 1536 + x) * 4 + 3] > 0) n++;
      return n;
    };
    for (const cell of [0, 56, 57, 58, 59]) assert.ok(opaque(cell) > 50, `logo cell ${cell} is drawn`);
    // Codex's pet box is 5 rows tall and its lower 2 rows sit over the footer:
    // every frame keeps to the top 3/5 of its cell.
    const lowestOpaque = (cell) => {
      const cx = (cell % 8) * 192, cy = Math.floor(cell / 8) * 208;
      for (let y = 207; y >= 0; y--) for (let x = 0; x < 192; x++) if (pixels[((cy + y) * 1536 + cx + x) * 4 + 3] > 0) return y;
      return -1;
    };
    for (let cell = 0; cell < 72; cell++) assert.ok(lowestOpaque(cell) < 125, `cell ${cell} stays above the footer (lowest pixel ${lowestOpaque(cell)})`);
    // The idle logo (what shows most of the time) is centered on the cell's top
    // three of five rows, the ones over the prompt box. The working pops grow
    // upward from its base, so they share its bottom edge.
    const rowsOf = (cell) => {
      const cx = (cell % 8) * 192, cy = Math.floor(cell / 8) * 208;
      let top = -1, bottom = -1;
      for (let y = 0; y < 208; y++) for (let x = 0; x < 192; x++) {
        if (pixels[((cy + y) * 1536 + cx + x) * 4 + 3] > 0) { if (top < 0) top = y; bottom = y; break; }
      }
      return { top, bottom };
    };
    const idle = rowsOf(0);
    assert.ok(Math.abs((idle.top + idle.bottom + 1) / 2 - (3 * 208) / 5 / 2) <= 1, `idle logo centered (rows ${idle.top}..${idle.bottom})`);
    for (const cell of [56, 57, 58, 59]) assert.equal(rowsOf(cell).bottom, idle.bottom, `pop ${cell} shares the logo's base`);
    for (const cell of [TILE.flash, ...TILE.rise, ...levelFrames(1), ...levelFrames(8), ...TILE.low]) {
      assert.ok(opaque(cell) > 2000, `tile cell ${cell} is drawn`);
    }
  });
});

describe("Codex Ultra-fast boost", () => {
  it("reads a boost from untrusted JSON, or nothing", () => {
    assert.deepEqual(boostFromJson({ active: true, activationId: "x", activatedAt: 1, expiresAt: 2, reason: "r" }), { active: true, activationId: "x", activatedAt: 1, expiresAt: 2, reason: "r" });
    assert.deepEqual(boostFromJson({ active: true, activatedAt: null, expiresAt: null }), { active: true, activationId: "", activatedAt: null, expiresAt: null, reason: "" });
    for (const bad of [null, [], 42, {}, { active: "yes" }, { active: true, activatedAt: "1" }, { active: true, activatedAt: 5, expiresAt: 1 }, { active: true, expiresAt: Infinity }]) {
      assert.equal(boostFromJson(bad), null, JSON.stringify(bad));
    }
  });

  it("measures the share left; an open window reads as full", () => {
    assert.equal(remaining(NO_BOOST, NOW), 0);
    assert.equal(remaining(boostWithShare(0.5), NOW), 0.5);
    assert.equal(remaining({ active: true, activationId: "", activatedAt: null, expiresAt: null, reason: "" }, NOW), 1);
    assert.equal(remaining({ ...boostWithShare(1), expiresAt: NOW - 1 }, NOW), 0);
    assert.equal(timeLeft(5 * HOUR), "5h 00m");
    assert.equal(timeLeft(47 * 60_000), "47m");
    assert.equal(timeLeft(0), "<1m");
  });
});

describe("Codex Ultra-fast footer", () => {
  it("counts wide characters as 2 columns and combining marks as 0", () => {
    assert.equal(displayWidth("abc"), 3);
    assert.equal(displayWidth("日本語"), 6);
    assert.equal(displayWidth("🚀"), 2);
    assert.equal(displayWidth("é"), 1);
    assert.equal(displayWidth(truncate("日本語のフォルダ", 7)), 7);
  });

  it("every row fits the terminal, whatever the width, model, folder and badge", () => {
    const models = ["example-model", "an-exceptionally-long-model-display-name-that-goes-on-and-on"];
    const folders = ["/home/x/acme-api", "/home/x/プロジェクト/とても長いフォルダ名/作業", "/home/x/🚀🚀🚀/rockets/🚀🚀"];
    const ended = NOW - 60_000;
    const cases = [[boostWithShare(0.6), null], [{ ...boostWithShare(0), expiresAt: ended }, ended], [NO_BOOST, null]];
    for (const columns of [12, 20, 30, 40, 60, 90, 120]) {
      for (const display_name of models) for (const cwd of folders) for (const [boost, endedAt] of cases) {
        const state = { thread: { model: { display_name, reasoning_level: "high" }, workspace: { cwd } } };
        const { tree } = footerTree({ state, boost, endedAt, now: NOW, columns, sawBoost: true, home: "/home/x", timeZone: "America/Los_Angeles" });
        for (const row of rows(tree)) assert.ok(displayWidth(row) <= columns - 3, `${columns} cols: "${row}"`);
      }
    }
  });

  it("puts the badge at the right edge and the time under it", () => {
    const state = { thread: { model: { display_name: "accounts/fireworks/models/example-model", reasoning_level: "high" }, workspace: { cwd: "/home/x/acme-api" } } };
    const [top, bottom] = rows(footerTree({ state, boost: boostWithShare(1), now: NOW, columns: 90, home: "/home/x" }).tree);
    assert.match(top, /^example-model high · ~\/acme-api +ϟ Ultra-fast on$/);
    assert.equal(displayWidth(top), 87);
    assert.match(bottom, /^ +5h 00m left$/);
    assert.equal(displayWidth(bottom), 87);
  });

  it("after a boost: a red ended note with the local time, then nothing; the second row stays", () => {
    const state = { thread: { model: { display_name: "example-model" } } };
    const endedAt = NOW - 60_000;
    const boost = { ...boostWithShare(0), expiresAt: endedAt };
    const soon = footerTree({ state, boost, endedAt, now: NOW, columns: 90, sawBoost: true, timeZone: "America/Los_Angeles" });
    assert.match(treeText(soon.tree), /ϟ Ultra-fast ended at 9:59 PT/);
    assert.ok(JSON.stringify(soon.tree).includes("#ff5f5f"));
    assert.equal(rows(soon.tree).length, 2);
    const later = footerTree({ state, boost, endedAt, now: endedAt + ENDED_NOTE_MS + 1, columns: 90, sawBoost: true });
    assert.doesNotMatch(treeText(later.tree), /Ultra-fast/);
    assert.equal(rows(later.tree).length, 2);
  });

  it("is always two rows, so the pet's box stays put", () => {
    const state = { thread: { model: { display_name: "example-model" } } };
    for (const boost of [NO_BOOST, boostWithShare(0.5)]) {
      assert.equal(rows(footerTree({ state, boost, now: NOW, columns: 80 }).tree).length, 2);
    }
  });

  it("an open-ended boost shows the badge without a time", () => {
    const state = { thread: { model: { display_name: "example-model" } } };
    const open = { active: true, activationId: "", activatedAt: null, expiresAt: null, reason: "" };
    const lines = rows(footerTree({ state, boost: open, now: NOW, columns: 60 }).tree);
    assert.match(lines[0], /ϟ Ultra-fast on$/);
    assert.equal(lines[1].trim(), "");
  });

  it("strips control characters from snapshot text before it reaches the terminal", () => {
    const state = { thread: { model: { display_name: "evil\u001b[31mmodel\nx" }, workspace: { cwd: "/w\u0007" } } };
    const lines = treeText(footerTree({ state, boost: NO_BOOST, now: NOW, columns: 80 }).tree).split("\n");
    assert.equal(lines.length, 2, "two rows, always (the row break is the footer's own)");
    for (const line of lines) assert.doesNotMatch(line, /[\u0000-\u001f]/);
  });
});

describe("Codex Ultra-fast key", () => {
  it("reads the key `codex on` wrote: the header, or an older bearer token", () => {
    assert.equal(CODEX_PROVIDER_TABLE, CORE_PROVIDER_TABLE);
    const header = `[${CODEX_PROVIDER_TABLE}]\nhttp_headers = { "X-Fireworks-Api-Key" = "fw_test_key" }\n`;
    assert.equal(fireworksKeyFromCodexConfig(header, parseToml), "fw_test_key");
    assert.equal(fireworksKeyFromCodexConfig(`[${CODEX_PROVIDER_TABLE}]\nexperimental_bearer_token = "fw_bearer"\n`, parseToml), "fw_bearer");
    assert.equal(fireworksKeyFromCodexConfig(`[${CODEX_PROVIDER_TABLE}]\nexperimental_bearer_token = "sk-not-fireworks"\n`, parseToml), "");
    assert.equal(fireworksKeyFromCodexConfig('[model_providers.other]\nexperimental_bearer_token = "fw_other"\n', parseToml), "");
    assert.equal(fireworksKeyFromCodexConfig("[broken\n", parseToml), "");
  });
});

// --- the server, in-process ------------------------------------------------------------------

function harness({ env = {}, files = {}, statusBody = null, statusCode = 404, now = NOW, columns = 0 } = {}) {
  const sent = [];
  const written = {};
  const requests = [];
  let clock = now;
  const deps = {
    env: { NEXUS_CODEX_CONFIG: "/h/.codex/config.toml", NEXUS_CODEX_PET_DIR: "/h/.codex/pets/fireworks-nexus", ...env },
    now: () => clock,
    fetch: async (url, init) => {
      requests.push({ url, auth: init.headers.Authorization });
      if (url.endsWith("/verifyApiKey")) return { status: 200, ok: true, headers: { "x-fireworks-account-id": "example-account" }, text: "{}" };
      // The account status route (no query string; the rewards list has one).
      if (url.includes("/v1/accounts/") && !url.includes("?") && statusBody) return { status: 200, ok: true, headers: {}, text: JSON.stringify(statusBody(clock)) };
      return { status: statusCode, ok: false, headers: {}, text: "" };
    },
    readText: async (file) => (Object.hasOwn(files, file) ? files[file] : null),
    writeAtomic: async (file, text) => {
      written[file] = text;
      files[file] = text;
    },
    parseToml,
    probeColumns: async () => columns,
    send: (message) => sent.push(message),
    home: "/h",
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  };
  const server = createStatusServer(deps);
  const read = (id = 1, snapshot = { thread: { model: { display_name: "example-model" }, workspace: { cwd: "/h/acme-api" } } }) => {
    server.handle({ jsonrpc: "2.0", id, method: "resources/read", params: { uri: URI, _meta: { "com.openai/codex-statusline-state": snapshot } } });
    return treeText(JSON.parse(sent.at(-1).result.contents[0].text)).replace(/ /g, " ");
  };
  return { server, deps, sent, written, requests, read, files, tick: (ms) => { clock += ms; } };
}
const CONFIG = `[${CODEX_PROVIDER_TABLE}]\nhttp_headers = { "x-fireworks-api-key" = "fw_test_key" }\n`;
const runningStatus = (end) => (clock) => ({ featureAvailable: true, readTime: new Date(clock).toISOString(), activeWindow: { windowId: "w1", startTime: new Date(clock - HOUR).toISOString(), endTime: new Date(end).toISOString() } });

describe("Codex Ultra-fast server", () => {
  it("advertises one statusline entrypoint", () => {
    const { server, sent } = harness({ env: { NEXUS_TEST: "1" } });
    server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const [tool] = sent[0].result.tools;
    assert.equal(tool.name, TOOL);
    assert.equal(tool.name, ULTRAFAST_TOOL_NAME);
    assert.deepEqual(tool._meta["openai/ui"].entrypoints, [{ type: "statusline", resourceUri: URI }]);
  });

  it("checks the boost with the config's key, shows it, writes the pet and the cache", async () => {
    const h = harness({ files: { "/h/.codex/config.toml": CONFIG }, statusBody: runningStatus(NOW + 4 * HOUR), columns: 80 });
    await h.server.probe();
    await h.server.check();
    assert.ok(h.requests.every((r) => r.auth === "Bearer fw_test_key"));
    assert.ok(h.requests.some((r) => r.url.startsWith("https://api.fireworks.ai/v1/accounts/example-account/")));
    const footer = h.read();
    assert.match(footer, /ϟ Ultra-fast on/);
    assert.match(footer, /4h 00m left/);
    const pet = JSON.parse(h.written["/h/.codex/pets/fireworks-nexus/pet.json"]);
    assert.deepEqual(pet.animations.level.frames, levelFrames(fillLevel(0.8)));
    const cache = JSON.parse(h.written[`/h/.codex/pets/fireworks-nexus/${STATUS_CACHE_FILE}`]);
    assert.equal(cache.status.active, true);
    assert.ok(!JSON.stringify(h.written).includes("fw_test_key"), "the key is never written anywhere");
  });

  it("a read never touches the network, the disk or the probe, and answers synchronously", () => {
    let calls = 0;
    const count = () => { calls++; return new Promise(() => {}); };
    const sent = [];
    const server = createStatusServer({
      env: { NEXUS_CODEX_CONFIG: "/h/c.toml", NEXUS_CODEX_PET_DIR: "/h/pet" },
      now: () => NOW, fetch: count, readText: count, writeAtomic: count, parseToml, probeColumns: count,
      send: (m) => sent.push(m), home: "/h", setInterval: () => ({}), clearInterval: () => {},
    });
    server.handle({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: URI, _meta: { "com.openai/codex-statusline-state": { thread: {} } } } });
    assert.equal(calls, 0);
    assert.equal(sent.length, 1, "the reply is sent before handle returns");
  });

  it("an ended boost shows the red note, and the next check can clear it", async () => {
    const h = harness({ files: { "/h/.codex/config.toml": CONFIG }, statusBody: runningStatus(NOW + 60_000), columns: 90 });
    await h.server.check();
    assert.match(h.read(), /Ultra-fast on/);
    h.tick(2 * 60_000);
    assert.match(h.read(), /ϟ Ultra-fast ended at/);
    h.tick(ENDED_NOTE_MS);
    assert.doesNotMatch(h.read(), /Ultra-fast/);
  });

  it("starts from a fresh cache, and ignores a stale or corrupt one", async () => {
    const cacheFile = `/h/.codex/pets/fireworks-nexus/${STATUS_CACHE_FILE}`;
    const fresh = { keyTag: keyTag("fw_test_key"), status: boostWithShare(0.5), fetchedAt: NOW - 60_000, endedAt: null };
    const a = harness({ files: { [cacheFile]: JSON.stringify(fresh), "/h/.codex/config.toml": CONFIG } });
    await a.server.loadCache();
    assert.match(a.read(), /Ultra-fast on/);
    for (const content of [JSON.stringify({ ...fresh, fetchedAt: NOW - CACHE_MAX_AGE_MS - 1 }), "{not json", "null", JSON.stringify({ ...fresh, status: { active: "yes" } })]) {
      const b = harness({ files: { [cacheFile]: content, "/h/.codex/config.toml": CONFIG } });
      await b.server.loadCache();
      assert.doesNotMatch(b.read(), /Ultra-fast/, content);
    }
  });

  it("a cached boost from another key (another account) is ignored: no badge, no ended note", async () => {
    const cacheFile = `/h/.codex/pets/fireworks-nexus/${STATUS_CACHE_FILE}`;
    const other = JSON.stringify({ keyTag: keyTag("fw_other_account_key"), status: boostWithShare(0.5), fetchedAt: NOW - 60_000, endedAt: null });
    const h = harness({ files: { [cacheFile]: other, "/h/.codex/config.toml": CONFIG }, statusCode: 404, columns: 90 });
    await h.server.loadCache();
    assert.doesNotMatch(h.read(), /Ultra-fast/);
    await h.server.check();
    assert.doesNotMatch(h.read(), /Ultra-fast/, "this account never had a boost: nothing ended");
    const saved = h.written[cacheFile];
    assert.equal(JSON.parse(saved).keyTag, keyTag("fw_test_key"));
    assert.ok(!saved.includes("fw_test_key"), "the cache holds a tag, never the key");
  });

  it("a key change mid-session starts over instead of reporting the old account's boost as ended", async () => {
    const files = { "/h/.codex/config.toml": CONFIG };
    const h = harness({ files, statusBody: runningStatus(NOW + HOUR), columns: 90 });
    await h.server.check();
    assert.match(h.read(), /Ultra-fast on/);
    // A re-login writes another account's key, whose status route says "no boost".
    files["/h/.codex/config.toml"] = CONFIG.replace("fw_test_key", "fw_other_account_key");
    h.deps.fetch = async (url) => (url.endsWith("/verifyApiKey")
      ? { status: 200, ok: true, headers: { "x-fireworks-account-id": "other-account" }, text: "{}" }
      : { status: 404, ok: false, headers: {}, text: "" });
    await h.server.check();
    assert.doesNotMatch(h.read(), /Ultra-fast/);
  });

  it("the same key keeps reporting a boost the server ended as ended", async () => {
    const files = { "/h/.codex/config.toml": CONFIG };
    const h = harness({ files, statusBody: runningStatus(NOW + HOUR), columns: 90 });
    await h.server.check();
    h.deps.fetch = async (url) => (url.endsWith("/verifyApiKey")
      ? { status: 200, ok: true, headers: { "x-fireworks-account-id": "example-account" }, text: "{}" }
      : { status: 404, ok: false, headers: {}, text: "" });
    await h.server.check();
    assert.match(h.read(), /ϟ Ultra-fast ended at/);
  });

  it("no answer keeps what was shown; a definite no clears it", async () => {
    for (const [code, kept] of [[503, true], [429, true], [404, false]]) {
      const h = harness({ files: { "/h/.codex/config.toml": CONFIG }, statusCode: code, columns: 80 });
      h.server.state.boost = boostWithShare(0.5);
      await h.server.check();
      assert.equal(/Ultra-fast on/.test(h.read()), kept, `status ${code}`);
    }
  });

  it("a check with no answer is logged once, without the key, and the tool says unavailable", async () => {
    const lines = [];
    const h = harness({ files: { "/h/.codex/config.toml": CONFIG }, statusCode: 503 });
    h.server.state.boost = NO_BOOST;
    const deps = { log: (line) => lines.push(line) };
    const server = createStatusServer({ ...h.deps, ...deps });
    await server.check();
    await server.check();
    assert.equal(lines.length, 1, "logged when the outcome changes, not on every check");
    assert.match(lines[0], /boost check: status answered 503/);
    assert.ok(!lines.join("").includes("fw_test_key"));
    server.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: TOOL } });
    assert.match(h.sent.at(-1).result.content[0].text, /unavailable/);
  });

  it("NEXUS_ULTRAFAST_STATUS=0 ignores a cached boost: no badge, plain pet", async () => {
    const cacheFile = `/h/.codex/pets/fireworks-nexus/${STATUS_CACHE_FILE}`;
    const cached = JSON.stringify({ keyTag: keyTag("fw_test_key"), status: boostWithShare(0.5), fetchedAt: NOW - 60_000, endedAt: null });
    const h = harness({ env: { NEXUS_ULTRAFAST_STATUS: "0" }, files: { [cacheFile]: cached, "/h/.codex/config.toml": CONFIG } });
    await h.server.start();
    h.server.stop();
    assert.doesNotMatch(h.read(), /Ultra-fast/);
    assert.deepEqual(JSON.parse(h.written["/h/.codex/pets/fireworks-nexus/pet.json"]).animations, JSON.parse(JSON.stringify(PLAIN_ANIMATIONS)));
  });

  it("without a key, nothing is sent and nothing changes", async () => {
    const h = harness({ files: { "/h/.codex/config.toml": '[tui]\nanimations = true\n' }, statusBody: runningStatus(NOW + HOUR) });
    await h.server.check();
    assert.equal(h.requests.length, 0);
    assert.doesNotMatch(h.read(), /Ultra-fast/);
  });

  it("NEXUS_TEST=1 and NEXUS_ULTRAFAST_STATUS=0 make no request and write nothing", async () => {
    for (const env of [{ NEXUS_TEST: "1" }, { NEXUS_ULTRAFAST_STATUS: "0", NEXUS_CODEX_PET_DIR: "" }]) {
      const h = harness({ env, files: { "/h/.codex/config.toml": CONFIG }, statusBody: runningStatus(NOW + HOUR) });
      await h.server.start();
      await h.server.check();
      h.server.stop();
      assert.equal(h.requests.length, 0, JSON.stringify(env));
      assert.deepEqual(Object.keys(h.written), [], JSON.stringify(env));
    }
  });

  it("the loopback mock gets a placeholder key, never the user's", async () => {
    const h = harness({ env: { NEXUS_ULTRAFAST_MOCK_URL: "http://127.0.0.1:8799" }, files: { "/h/.codex/config.toml": CONFIG }, statusBody: runningStatus(NOW + HOUR) });
    await h.server.check();
    assert.ok(h.requests.length > 0);
    assert.ok(h.requests.every((r) => r.url.startsWith("http://127.0.0.1:8799/") && !r.auth.includes("fw_test_key")));
    const remote = harness({ env: { NEXUS_ULTRAFAST_MOCK_URL: "https://example.com" }, files: { "/h/.codex/config.toml": CONFIG }, statusBody: runningStatus(NOW + HOUR) });
    await remote.server.check();
    assert.ok(remote.requests.every((r) => r.url.startsWith("https://api.fireworks.ai/")), "a non-loopback mock URL is ignored");
  });

  it("drops an oversized unterminated message and keeps answering; a large snapshot is still answered", () => {
    const h = harness({ env: { NEXUS_TEST: "1" } });
    h.server.receive("x".repeat(MAX_LINE_CHARS + 10));
    h.server.receive("tail of the huge line\n");
    const big = { thread: { model: { display_name: "example-model" } }, pad: "x".repeat(2 << 20) };
    h.server.receive(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "resources/read", params: { uri: URI, _meta: { "com.openai/codex-statusline-state": big } } })}\n`);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].id, 9);
    h.server.receive("{not json}\n");
    assert.equal(h.sent.length, 1, "bad JSON is ignored");
  });
});

describe("Codex Ultra-fast server files", () => {
  it("writes all at once and never through a symlink planted at the temp path", async () => {
    const { mkdtemp, readFile: read, rm, symlink, writeFile: write, readdir } = await import("node:fs/promises");
    const os = await import("node:os");
    const { writeAtomic } = await import("../../mods/codex-ultrafast/files.mjs");
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-ultrafast-files-"));
    try {
      const target = path.join(dir, "elsewhere.txt");
      await write(target, "untouched");
      const file = path.join(dir, "pet.json");
      await symlink(target, path.join(dir, `.pet.json.${process.pid}.tmp`));
      await writeAtomic(file, "new pet");
      assert.equal(await read(file, "utf8"), "new pet");
      assert.equal(await read(target, "utf8"), "untouched");
      assert.deepEqual((await readdir(dir)).sort(), ["elsewhere.txt", "pet.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads only small regular files", async () => {
    const { mkdtemp, rm, writeFile: write, symlink } = await import("node:fs/promises");
    const os = await import("node:os");
    const { readText } = await import("../../mods/codex-ultrafast/files.mjs");
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-ultrafast-files-"));
    try {
      assert.equal(await readText(path.join(dir, "missing"), 100), null);
      await write(path.join(dir, "small"), "ok");
      assert.equal(await readText(path.join(dir, "small"), 100), "ok");
      await write(path.join(dir, "big"), "x".repeat(200));
      await assert.rejects(readText(path.join(dir, "big"), 100), { code: "EFBIG" });
      await symlink(dir, path.join(dir, "folder-link"));
      await assert.rejects(readText(path.join(dir, "folder-link"), 100), { code: "ENOTFILE" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Codex Ultra-fast server after a login", () => {
  it("notices a new key in Codex's config within one watch and checks the new account at once", async () => {
    const files = { "/h/.codex/config.toml": CONFIG };
    let mtime = 1;
    const h = harness({ files, statusCode: 404, columns: 90 });
    h.deps.mtime = async () => mtime;
    await h.server.check();
    assert.doesNotMatch(h.read(), /Ultra-fast/);
    await h.server.watchKey(); // first look: remembers the file's time
    // `nexus login` writes the boosted account's key.
    files["/h/.codex/config.toml"] = CONFIG.replace("fw_test_key", "fw_boosted_key");
    mtime = 2;
    h.deps.fetch = async (url) => (url.endsWith("/verifyApiKey")
      ? { status: 200, ok: true, headers: { "x-fireworks-account-id": "boosted-account" }, text: "{}" }
      : { status: 200, ok: true, headers: {}, text: JSON.stringify(runningStatus(NOW + 4 * HOUR)(NOW)) });
    await h.server.watchKey();
    assert.match(h.read(), /Ultra-fast on/);
    assert.ok(JSON.parse(h.written["/h/.codex/pets/fireworks-nexus/pet.json"]).animations.level, "boost pet written");
  });

  it("a new key whose check gets no answer resets the pet instead of keeping the old account's", async () => {
    const files = { "/h/.codex/config.toml": CONFIG };
    const h = harness({ files, statusBody: runningStatus(NOW + HOUR), columns: 90 });
    await h.server.check();
    assert.ok(JSON.parse(h.written["/h/.codex/pets/fireworks-nexus/pet.json"]).animations.level);
    files["/h/.codex/config.toml"] = CONFIG.replace("fw_test_key", "fw_other_key");
    h.deps.fetch = async () => ({ status: 503, ok: false, headers: {}, text: "" });
    await h.server.check();
    assert.equal(JSON.parse(h.written["/h/.codex/pets/fireworks-nexus/pet.json"]).animations.level, undefined);
  });
});
