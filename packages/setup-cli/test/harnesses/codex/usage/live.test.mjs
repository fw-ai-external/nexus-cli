import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runUsageMeter } from "../../../../lib/harnesses/claude/usage/meter.mjs";
import {
  createCodexMeterTranslator,
  listRecentCodexUsageSessions,
  runCodexUsageLive,
} from "../../../../lib/harnesses/codex/usage/live.mjs";

const ROOT = "d4000000-0000-7000-8000-00000000d004";
const CHILD = "e5000000-0000-7000-8000-00000000e005";
const EMPTY = "f6000000-0000-7000-8000-00000000f006";
/** Synthetic: only its `fw_` prefix matters to the lookup's key check. */
const KEY = ["fw", `test${"0".repeat(22)}`].join("_");
const SERVED = "glm-5p3";
/** How the meter labels SERVED. */
const SERVED_LABEL = /GLM ?5\.3/;

function jsonl(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function usage(input, cached, output) {
  return { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output };
}

function rollout(turnId, prompt, calls, { model = "auto", meta = {} } = {}) {
  return [
    { type: "session_meta", timestamp: "2026-11-01T14:18:00Z", payload: { timestamp: "2026-11-01T14:18:00Z", ...meta } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
    { type: "turn_context", payload: { turn_id: turnId, model } },
    ...(prompt ? [{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } }] : []),
    ...calls.map(([responseId, input, cached, output], i) => ({
      type: "token_usage_record",
      timestamp: `2026-11-01T14:18:${String(10 + i).padStart(2, "0")}Z`,
      payload: { turn_id: turnId, response_id: responseId, usage: usage(input, cached, output) },
    })),
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(1, 1, 1), total_token_usage: usage(9, 9, 9) } } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
  ];
}

/** A non-TTY stream the meter writes its plain output to. */
function sink() {
  const stream = { isTTY: false, columns: 140, text: "", write(chunk) { stream.text += String(chunk); return true; } };
  return stream;
}

const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

async function withCodexHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "nexus-codex-live-"));
  const codexHome = path.join(home, ".codex");
  const dir = path.join(codexHome, "sessions", "2026", "11", "01");
  await mkdir(dir, { recursive: true });
  try {
    return await fn({ home, codexHome, dir });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeRollout(dir, threadId, entries) {
  const filePath = path.join(dir, `rollout-2026-11-01T14-18-00-${threadId}.jsonl`);
  await writeFile(filePath, jsonl(entries));
  return filePath;
}

describe("codex live usage meter", () => {
  it("translates rollout lines into the turns and calls the meter tallies", () => {
    const served = new Map([["resp_b", { model: SERVED, billedBy: "fireworks" }]]);
    const translate = createCodexMeterTranslator(served);
    const out = rollout("t1", "fix the failing test", [["resp_a", 100, 40, 5], ["resp_b", 200, 0, 7]]).flatMap(translate);

    assert.deepEqual(out.map((rec) => rec.type), ["user", "assistant", "assistant", "assistant"]);
    assert.equal(out[0].message.content, "fix the failing test");
    // OpenAI-style input includes the cached share; the meter wants disjoint buckets.
    assert.deepEqual(out[1].message, {
      id: "resp_a",
      model: "auto",
      usage: { input_tokens: 60, cache_read_input_tokens: 40, cache_creation_input_tokens: 0, output_tokens: 5 },
    });
    assert.equal(out[2].message.model, SERVED);
    // The token_count echo is not a second call; task_complete settles the turn.
    assert.deepEqual(out[3].message, { stop_reason: "end_turn" });
  });

  it("keeps a prompt logged just before its turn started on that turn's row", () => {
    const records = [
      { type: "event_msg", payload: { type: "user_message", message: "fix tests" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      { type: "turn_context", payload: { turn_id: "t1", model: SERVED } },
      { type: "token_usage_record", timestamp: "2026-11-01T14:18:10Z", payload: { turn_id: "t1", response_id: "r1", usage: usage(10, 0, 1) } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } },
      // The next turn starts normally, then its prompt is logged.
      { type: "event_msg", payload: { type: "task_started", turn_id: "t2" } },
      { type: "event_msg", payload: { type: "user_message", message: "now the docs" } },
      { type: "token_usage_record", timestamp: "2026-11-01T14:18:20Z", payload: { turn_id: "t2", response_id: "r2", usage: usage(10, 0, 1) } },
    ];
    const out = records.flatMap(createCodexMeterTranslator());
    const prompts = out.filter((rec) => rec.type === "user").map((rec) => rec.message.content);
    assert.deepEqual(prompts, ["fix tests", "now the docs"]);
    assert.equal(out.filter((rec) => rec.message?.usage).length, 2);
  });

  it("gives the served-model lookup each call's time, so the settle delay applies", async () => {
    await withCodexHome(async ({ codexHome, dir }) => {
      const log = await writeRollout(dir, ROOT, rollout("t1", "hello", [["resp_a", 10, 0, 1]], { meta: { id: ROOT, session_id: ROOT } }));
      const { readCodexSessionTree, codexServedLookup } = await import("../../../../lib/harnesses/codex/usage/report.mjs");
      const lookup = codexServedLookup(await readCodexSessionTree({ codexHome, sessionPath: log }));
      assert.deepEqual(lookup.calls.map((call) => call.at), ["2026-11-01T14:18:10Z"]);
    });
  });

  it("parses a growing rollout incrementally, across a split character and a rewrite", async () => {
    await withCodexHome(async ({ dir }) => {
      const { parseCodexCallsIncremental } = await import("../../../../lib/harnesses/codex/usage/report.mjs");
      const { appendFile } = await import("node:fs/promises");
      const file = path.join(dir, `rollout-2026-11-01T14-18-00-${ROOT}.jsonl`);
      const lines = rollout("t1", "café ☕ time", [["r1", 10, 0, 1], ["r2", 20, 0, 2]]).map((e) => `${JSON.stringify(e)}\n`);
      const bytes = Buffer.from(lines.join(""));
      // Cut inside the multi-byte "☕" so the first read ends mid-character.
      const cut = bytes.indexOf(Buffer.from("☕")) + 1;
      await writeFile(file, bytes.subarray(0, cut));
      const state = {};
      assert.equal((await parseCodexCallsIncremental(file, state)).calls.length, 0);
      await appendFile(file, bytes.subarray(cut));
      const full = await parseCodexCallsIncremental(file, state);
      assert.deepEqual(full.calls.map((c) => c.key), ["r1", "r2"]);
      assert.equal(full.firstPrompt, "café ☕ time");
      // Nothing new: same result, no re-parse.
      assert.equal((await parseCodexCallsIncremental(file, state)).calls.length, 2);
      // A rewrite (shorter file) starts over.
      await writeFile(file, jsonl(rollout("t9", "again", [["r9", 1, 0, 1]])));
      assert.deepEqual((await parseCodexCallsIncremental(file, state)).calls.map((c) => c.key), ["r9"]);
    });
  });

  it("keeps Codex's injected AGENTS.md message out of the meter's rows", () => {
    const records = [
      { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>x</INSTRUCTIONS>" }] } },
      // Some Codex builds leave out the directory.
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>y</INSTRUCTIONS>" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "real prompt" }] } },
      { type: "token_usage_record", timestamp: "2026-11-01T14:18:10Z", payload: { turn_id: "t1", response_id: "r1", usage: usage(10, 0, 1) } },
    ];
    const prompts = records.flatMap(createCodexMeterTranslator()).filter((rec) => rec.type === "user").map((rec) => rec.message.content);
    assert.deepEqual(prompts, ["real prompt"]);
  });

  it("skips calls a forked subagent inherited from its parent", () => {
    const records = rollout("c1", "", [["r_parent", 100, 0, 10], ["r_own", 50, 0, 5]]);
    const out = records.flatMap(createCodexMeterTranslator(new Map(), { isInherited: (id) => id === "r_parent" }));
    assert.deepEqual(out.filter((rec) => rec.message?.usage).map((rec) => rec.message.id), ["r_own"]);
  });

  it("starts over when a rollout is rewritten with a longer body", async () => {
    await withCodexHome(async ({ dir }) => {
      const { parseCodexCallsIncremental } = await import("../../../../lib/harnesses/codex/usage/report.mjs");
      const file = path.join(dir, `rollout-2026-11-01T14-18-00-${ROOT}.jsonl`);
      await writeFile(file, jsonl(rollout("t1", "first", [["r1", 10, 0, 1]], { meta: { id: "a" } })));
      const state = {};
      await parseCodexCallsIncremental(file, state);
      await writeFile(file, jsonl(rollout("t9", "second", [["r8", 1, 0, 1], ["r9", 2, 0, 1]], { meta: { id: "b" } })));
      assert.deepEqual((await parseCodexCallsIncremental(file, state)).calls.map((c) => c.key), ["r8", "r9"]);
    });
  });

  it("parses an appended call once when two refreshes read the same rollout at once", async () => {
    await withCodexHome(async ({ dir }) => {
      const { parseCodexCallsIncremental } = await import("../../../../lib/harnesses/codex/usage/report.mjs");
      const { appendFile } = await import("node:fs/promises");
      const file = path.join(dir, `rollout-2026-11-01T14-18-00-${ROOT}.jsonl`);
      await writeFile(file, jsonl(rollout("t1", "hi", [])));
      const state = {};
      const before = (await parseCodexCallsIncremental(file, state)).calls.length;
      // Many appended calls and many overlapping reads, so unserialized reads
      // would start from the same offset.
      const added = Array.from({ length: 200 }, (_, i) => ({
        type: "event_msg",
        timestamp: "2026-11-01T14:18:30Z",
        payload: { type: "token_count", info: { last_token_usage: usage(5, 0, 1), total_token_usage: usage(100 + i, 9, 10) } },
      }));
      await appendFile(file, jsonl(added));
      const results = await Promise.all(Array.from({ length: 20 }, () => parseCodexCallsIncremental(file, state)));
      for (const result of results) assert.equal(result.calls.length, before + added.length);
    });
  });

  it("joins a subagent to its parent once its half-written first line is complete", async () => {
    await withCodexHome(async ({ codexHome, dir }) => {
      const { readCodexSessionTree } = await import("../../../../lib/harnesses/codex/usage/report.mjs");
      const parent = await writeRollout(dir, ROOT, rollout("t1", "hi", [["r1", 10, 0, 1]], { meta: { id: ROOT, session_id: ROOT } }));
      const childPath = path.join(dir, `rollout-2026-11-01T14-18-05-${CHILD}.jsonl`);
      const childLines = jsonl(rollout("c1", "", [["rc1", 5, 0, 1]], { meta: { id: CHILD, session_id: ROOT, parent_thread_id: ROOT } }));
      await writeFile(childPath, childLines.slice(0, 20)); // session_meta cut off mid-line
      const cache = new Map();
      const parseState = new Map();
      assert.equal((await readCodexSessionTree({ codexHome, sessionPath: parent, cache, parseState })).subagents.length, 0);
      await writeFile(childPath, childLines);
      assert.equal((await readCodexSessionTree({ codexHome, sessionPath: parent, cache, parseState })).subagents.length, 1);
    });
  });

  it("warns instead of showing an empty session when the translator fails", async (t) => {
    const warned = [];
    t.mock.method(process.stderr, "write", (chunk) => { warned.push(String(chunk)); return true; });
    await withCodexHome(async ({ dir }) => {
      const log = await writeRollout(dir, ROOT, rollout("t1", "hi", [["r1", 10, 0, 1]]));
      const stream = sink();
      await runUsageMeter({ filePath: log, plain: true, follow: false, stream, translate: () => { throw new Error("broken translator"); } });
      // Raw Codex records never reach the meter as if they were Claude's.
      assert.doesNotMatch(strip(stream.text), /✓/);
    });
    assert.ok(warned.some((line) => /couldn't read this session's log: broken translator/.test(line)));
  });

  it("detects a rewrite even when the first read saw only a few bytes", async () => {
    await withCodexHome(async ({ dir }) => {
      const { parseCodexCallsIncremental } = await import("../../../../lib/harnesses/codex/usage/report.mjs");
      const { appendFile } = await import("node:fs/promises");
      const file = path.join(dir, `rollout-2026-11-01T14-18-00-${ROOT}.jsonl`);
      const original = jsonl(rollout("t1", "first", [["r1", 10, 0, 1]], { meta: { id: "aaaa" } }));
      await writeFile(file, original.slice(0, 12)); // read the moment it's created
      const state = {};
      await parseCodexCallsIncremental(file, state);
      await appendFile(file, original.slice(12));
      await parseCodexCallsIncremental(file, state);
      // Same first 12 bytes, different (longer) body after them.
      await writeFile(file, original.slice(0, 12) + original.slice(12).replace("aaaa", "bbbb").replace('"r1"', '"r9"').replace("first", "first prompt, rewritten"));
      assert.deepEqual((await parseCodexCallsIncremental(file, state)).calls.map((c) => c.key), ["r9"]);
    });
  });

  it("meters a response id repeated within one rollout once, not zero times", async () => {
    await withCodexHome(async ({ codexHome, dir }) => {
      const { readCodexSessionTree } = await import("../../../../lib/harnesses/codex/usage/report.mjs");
      const records = rollout("t1", "hi", [["r1", 10, 0, 1]], { meta: { id: ROOT, session_id: ROOT } });
      records.splice(-2, 0, { type: "token_usage_record", timestamp: "2026-11-01T14:18:11Z", payload: { turn_id: "t1", response_id: "r1", usage: usage(10, 0, 1) } });
      const log = await writeRollout(dir, ROOT, records);
      const tree = await readCodexSessionTree({ codexHome, sessionPath: log });
      const inherited = new Set(tree.main.parsed.inherited);
      assert.equal(inherited.has("r1"), false, "a repeat in the same rollout isn't inherited");
      const stream = sink();
      await runUsageMeter({
        filePath: log,
        plain: true,
        follow: false,
        stream,
        translate: () => createCodexMeterTranslator(new Map(), { isInherited: (id) => inherited.has(id) }),
      });
      // The snapshot counts one call; the meter must too.
      assert.equal(tree.main.parsed.calls.length, 1);
      assert.match(strip(stream.text), /✓\s+1 /);
    });
  });

  it("names a translator failure in the live frame, not only after quitting", async (t) => {
    t.mock.method(process.stderr, "write", () => true);
    await withCodexHome(async ({ dir }) => {
      const log = await writeRollout(dir, ROOT, rollout("t1", "hi", [["r1", 10, 0, 1]]));
      const { Dashboard } = await import("../../../../lib/harnesses/claude/usage/meter.mjs");
      let db;
      await runUsageMeter({
        filePath: log,
        plain: true,
        follow: false,
        stream: sink(),
        translate: () => { throw new Error("broken"); },
        onReady: (dashboard) => { db = dashboard; },
      });
      assert.ok(db instanceof Dashboard);
      assert.equal(db.failure?.message, "broken");
    });
  });

  it("opens a turn for calls whose rollout has no typed prompt", () => {
    const out = rollout("t1", "", [["resp_a", 10, 0, 1]]).flatMap(createCodexMeterTranslator());
    assert.equal(out[0].type, "user");
    assert.equal(out[0].message.content, "(no typed prompt)");
  });

  it("meters a Codex rollout through the shared meter", async () => {
    await withCodexHome(async ({ dir }) => {
      const log = await writeRollout(dir, ROOT, rollout("t1", "fix the failing test", [["resp_a", 1_000, 400, 50]], { model: SERVED }));
      const stream = sink();
      await runUsageMeter({ filePath: log, plain: true, follow: false, stream, translate: () => createCodexMeterTranslator(), sessionLabel: ROOT.slice(0, 8) });
      const text = strip(stream.text);
      assert.match(text, /fix the failing test/);
      assert.match(text, SERVED_LABEL);
      assert.match(text, /TOTAL[^\n]*\$\d/);
    });
  });

  it("replays the log when a served model resolves, so auto is priced as that model", async () => {
    await withCodexHome(async ({ dir }) => {
      const log = await writeRollout(dir, ROOT, rollout("t1", "hello", [["resp_a", 1_000, 400, 50]]));
      const served = new Map();
      const stream = sink();
      const controller = new AbortController();
      let polls = 0;
      let lookups = 0;
      await runUsageMeter({
        filePath: log,
        plain: true,
        stream,
        signal: controller.signal,
        servedMs: 0,
        translate: () => createCodexMeterTranslator(served),
        refreshServed: async () => {
          lookups += 1;
          if (served.size) return false;
          served.set("resp_a", { model: SERVED, billedBy: "fireworks" });
          return true;
        },
        sleep: async () => {
          await new Promise((resolve) => setImmediate(resolve));
          polls += 1;
          if (polls >= 4) controller.abort();
        },
      });
      // Plain mode prints the footer once, at the end, from the replayed tally.
      const footer = strip(stream.text).split("\n").filter((line) => /auto|GLM|TOTAL/.test(line) && !/^\s+✓/.test(line)).join("\n");
      assert.ok(lookups >= 1);
      assert.match(footer, SERVED_LABEL);
      // Plain output can't redraw, so the turns are reprinted with their new prices.
      const afterUpdate = strip(stream.text).split("(prices updated)")[1] ?? "";
      assert.match(afterUpdate, /✓[^\n]*GLM/);
      assert.doesNotMatch(footer, /\bauto\b/);
      assert.match(footer, /TOTAL[^\n]*\$\d/);
    });
  });

  it("lists sessions that have not made a call yet", async () => {
    await withCodexHome(async ({ home, codexHome, dir }) => {
      await writeRollout(dir, ROOT, rollout("t1", "work", [["resp_a", 10, 0, 1]], { meta: { id: ROOT, session_id: ROOT } }));
      await writeRollout(dir, EMPTY, [{ type: "session_meta", payload: { id: EMPTY, session_id: EMPTY } }]);
      const sessions = await listRecentCodexUsageSessions({ codexHome, home, withinDays: 36500 });
      assert.deepEqual(sessions.map((s) => s.sessionId).sort(), [ROOT, EMPTY].sort());
    });
  });

  it("live-tracks a session, prices auto from the route in the background, and counts subagents", async () => {
    await withCodexHome(async ({ home, codexHome, dir }) => {
      const parent = await writeRollout(dir, ROOT, rollout("t1", "hello", [["resp_main", 1_000, 400, 50]], { meta: { id: ROOT, session_id: ROOT } }));
      await writeRollout(dir, CHILD, rollout("c1", "", [["resp_sub", 500, 0, 20]], {
        meta: { id: CHILD, session_id: ROOT, parent_thread_id: ROOT, agent_nickname: "Scout" },
      }));

      const seen = [];
      const server = http.createServer((req, res) => {
        seen.push(req.url);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          tracing_enabled: true,
          calls: [
            { trace_id: "1", response_id: "resp_main", model_requested: "auto", model_used: SERVED, billed_by: "fireworks", usage: { input: 1_000, cached: 400, output: 50 } },
            { trace_id: "2", response_id: "resp_sub", model_requested: "auto", model_used: SERVED, billed_by: "fireworks", usage: { input: 500, cached: 0, output: 20 } },
          ],
          next_since: null,
        }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}/inference/v1/nexus/sessions`;
      const stream = sink();
      const controller = new AbortController();
      let polls = 0;
      try {
        await runCodexUsageLive({
          home,
          codexHome,
          session: parent,
          apiKey: KEY,
          plain: true,
          env: { ...process.env, NEXUS_TEST: "1", NEXUS_SESSION_CALLS_BASE_URL: base },
          input: { isTTY: false },
          stream,
          signal: controller.signal,
          sleep: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            polls += 1;
            if (polls >= 25) controller.abort();
          },
        });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
      const text = strip(stream.text);
      assert.ok(seen.some((url) => url.startsWith(`/inference/v1/nexus/sessions/${ROOT}/calls`)), "looked up the root session");
      assert.match(text, /Codex · Live Cost Meter/);
      assert.match(text, SERVED_LABEL);
      // The subagent's spend is priced from the same lookup once it lands.
      assert.match(text, /1 subagent · 1 call\s+\$\d/);
      assert.match(text, /SESSION COST\s+\$\d/);
    });
  });
});
