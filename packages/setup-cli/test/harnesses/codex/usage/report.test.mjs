import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeClaudeUsageCost } from "../../../../lib/harnesses/claude/usage/pricing.mjs";
import {
  codexThreadIdFromPath,
  codexUsageToClaudeUsage,
  findCodexRollouts,
  parseCodexUsageLog,
  readCodexUsage,
  readCodexUsages,
} from "../../../../lib/harnesses/codex/usage/report.mjs";
import { runFireconnect } from "../../../helpers.mjs";

const MODEL = "accounts/fireworks/models/glm-5p2";
const PARENT = "a1000000-0000-7000-8000-00000000a001";
const CHILD = "b2000000-0000-7000-8000-00000000b002";
const OLDER = "c3000000-0000-7000-8000-00000000c003";

function jsonl(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function usage(input, cached, output) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
}

function meta(id, extra = {}) {
  return { type: "session_meta", payload: { id, session_id: id, model_provider: "fireworks-ai", ...extra } };
}

function turn(turnId, model = MODEL) {
  return [
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { type: "turn_context", payload: { turn_id: turnId, model } },
  ];
}

function call(turnId, responseId, input, cached, output) {
  return { type: "token_usage_record", payload: { turn_id: turnId, response_id: responseId, usage: usage(input, cached, output) } };
}

async function withCodexHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "nexus-codex-usage-"));
  try {
    return await fn(home, path.join(home, ".codex"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeRollout(codexHome, day, threadId, entries, mtimeMs) {
  const dir = path.join(codexHome, "sessions", "2026", "11", day);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-2026-11-${day}T10-00-00-${threadId}.jsonl`);
  await writeFile(filePath, jsonl(entries));
  if (mtimeMs) {
    await utimes(filePath, mtimeMs / 1000, mtimeMs / 1000);
  }
  return filePath;
}

async function seedSessions(codexHome) {
  const now = Date.now();
  const parentPath = await writeRollout(codexHome, "01", PARENT, [
    meta(PARENT),
    ...turn("t1"),
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the failing test" }] } },
    call("t1", "r1", 1000, 600, 50),
    call("t1", "r2", 2000, 1500, 80),
  ], now - 1000);
  await writeRollout(codexHome, "01", CHILD, [
    meta(CHILD, {
      parent_thread_id: PARENT,
      agent_nickname: "Scout",
      source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } },
      thread_source: "subagent",
    }),
    ...turn("c1"),
    call("c1", "rc1", 500, 0, 20),
  ], now - 500);
  await writeRollout(codexHome, "01", OLDER, [
    meta(OLDER),
    ...turn("o1"),
    call("o1", "ro1", 100, 0, 10),
  ], now - 10 * 86_400_000);
  await writeFile(path.join(codexHome, "session_index.jsonl"), jsonl([
    { id: PARENT, thread_name: "First name" },
    { id: PARENT, thread_name: "Fix failing test" },
  ]));
  return parentPath;
}

describe("codex usage", () => {
  it("splits OpenAI-style input into disjoint uncached and cached buckets", () => {
    assert.deepEqual(codexUsageToClaudeUsage(usage(33_372, 33_024, 501)), {
      input_tokens: 348,
      cache_read_input_tokens: 33_024,
      cache_creation_input_tokens: 0,
      output_tokens: 501,
    });
    // A malformed record never yields negative tokens.
    assert.equal(codexUsageToClaudeUsage({ input_tokens: 1, cached_input_tokens: 5 }).input_tokens, 0);
  });

  it("prices one row per token_usage_record with the model of its turn", () => {
    const rows = parseCodexUsageLog(jsonl([
      meta(PARENT),
      ...turn("t1", MODEL),
      call("t1", "r1", 1000, 600, 50),
      // token_count duplicates the record above; it must not double-count.
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(1000, 600, 50), total_token_usage: usage(1000, 600, 50) } } },
      ...turn("t2", "kimi-k3"),
      call("t2", "r2", 2000, 0, 10),
      "not json",
    ]).replace('"not json"', "{torn"));

    assert.equal(rows.length, 2);
    assert.equal(rows.currentTurn, 2);
    assert.deepEqual(rows.map((row) => [row.model, row.turn, row.input, row.cacheRead, row.output]), [
      [MODEL, 1, 400, 600, 50],
      ["kimi-k3", 2, 2000, 0, 10],
    ]);
    assert.equal(rows[0].cost, computeClaudeUsageCost(MODEL, codexUsageToClaudeUsage(usage(1000, 600, 50))).cost);
  });

  it("falls back to token_count on older rollouts, skipping repeated totals", () => {
    const tokenCount = (last, total) => ({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } } });
    const rows = parseCodexUsageLog(jsonl([
      meta(PARENT),
      ...turn("t1"),
      tokenCount(usage(100, 0, 10), usage(100, 0, 10)),
      tokenCount(usage(100, 0, 10), usage(100, 0, 10)),
      tokenCount(usage(200, 100, 5), usage(300, 100, 15)),
      { type: "event_msg", payload: { type: "token_count", info: null } },
    ]));
    assert.deepEqual(rows.map((row) => [row.input, row.cacheRead, row.output]), [[100, 0, 10], [100, 100, 5]]);
  });

  it("groups subagent rollouts under their parent and names the session", async () => {
    await withCodexHome(async (home, codexHome) => {
      await seedSessions(codexHome);
      const report = await readCodexUsage({ codexHome, home });
      assert.equal(report.sessionId, PARENT);
      assert.equal(report.sessionName, "Fix failing test");
      assert.equal(report.requests, 2);
      assert.deepEqual(report.subagents.map((subagent) => [subagent.id, subagent.requests]), [["Scout-0000b002", 1]]);
      assert.equal(report.grandRequests, 3);
      assert.equal(report.grandTotals.input, 400 + 500 + 500);
      assert.equal(report.grandTotals.cacheRead, 600 + 1500);
    });
  });

  it("falls back to the first typed prompt when the thread has no name", async () => {
    await withCodexHome(async (home, codexHome) => {
      await seedSessions(codexHome);
      await rm(path.join(codexHome, "session_index.jsonl"));
      const report = await readCodexUsage({ codexHome, home, session: PARENT.slice(0, 8) });
      assert.equal(report.sessionName, "fix the failing test");
    });
  });

  it("selects sessions by thread id prefix, explicit path, --last-n, and --days", async () => {
    await withCodexHome(async (home, codexHome) => {
      const parentPath = await seedSessions(codexHome);
      assert.equal(codexThreadIdFromPath(parentPath), PARENT);

      const byPrefix = await findCodexRollouts({ codexHome, home, session: OLDER.slice(0, 13) });
      assert.equal(byPrefix.parents[0].threadId, OLDER);

      const explicit = await readCodexUsage({ codexHome, home, session: parentPath });
      assert.equal(explicit.path, parentPath);

      const lastTwo = await readCodexUsages({ codexHome, home, lastN: 2 });
      assert.deepEqual(lastTwo.sessions.map((s) => s.sessionId), [PARENT, OLDER]);
      assert.equal(lastTwo.grandRequests, 4);

      const recent = await readCodexUsages({ codexHome, home, lastN: 25, withinDays: 3 });
      assert.deepEqual(recent.sessions.map((s) => s.sessionId), [PARENT]);

      await assert.rejects(findCodexRollouts({ codexHome, home, session: "zzzz" }), /No Codex session log matching 'zzzz'/);
    });
  });

  it("strips terminal control sequences from subagent labels", async () => {
    await withCodexHome(async (home, codexHome) => {
      await writeRollout(codexHome, "01", PARENT, [meta(PARENT), ...turn("t1"), call("t1", "r1", 100, 0, 10)]);
      await writeRollout(codexHome, "01", CHILD, [
        meta(CHILD, { parent_thread_id: PARENT, agent_nickname: "Sc\u001b]52;c;ZXZpbA==\u0007out\u001b[31m\nx" }),
        ...turn("c1"),
        call("c1", "rc1", 500, 0, 20),
      ]);
      const report = await readCodexUsage({ codexHome, home, session: PARENT.slice(0, 8) });
      const [label] = report.subagents.map((subagent) => subagent.id);
      assert.doesNotMatch(label, /[\u0000-\u001f\u007f]/);
      assert.match(label, /^Scout x-0000b002$/);
    });
  });

  it("skips Codex's injected AGENTS.md message when naming a session", async () => {
    await withCodexHome(async (home, codexHome) => {
      await writeRollout(codexHome, "01", PARENT, [
        meta(PARENT),
        ...turn("t1"),
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nbe nice\n</INSTRUCTIONS>" }] } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the flaky test" }] } },
        call("t1", "r1", 100, 0, 10),
      ]);
      assert.equal((await readCodexUsage({ codexHome, home })).sessionName, "fix the flaky test");
    });
  });

  it("counts a call once when a forked subagent repeats the parent's response ids", async () => {
    await withCodexHome(async (home, codexHome) => {
      await writeRollout(codexHome, "01", PARENT, [meta(PARENT), ...turn("t1"), call("t1", "r1", 100, 0, 10), call("t1", "r2", 200, 0, 20)]);
      await writeRollout(codexHome, "01", CHILD, [
        meta(CHILD, { parent_thread_id: PARENT, agent_nickname: "Scout" }),
        ...turn("c1"),
        // Copied from the parent by the fork, then its own call.
        call("c1", "r1", 100, 0, 10),
        call("c1", "r2", 200, 0, 20),
        call("c1", "rc1", 500, 0, 20),
      ]);
      const report = await readCodexUsage({ codexHome, home, session: PARENT.slice(0, 8) });
      assert.equal(report.requests, 2);
      assert.deepEqual(report.subagents.map((s) => s.requests), [1]);
      assert.equal(report.grandRequests, 3);
    });
  });

  it("strips terminal control sequences from model ids in the log and from the lookup", async () => {
    await withCodexHome(async (home, codexHome) => {
      await writeRollout(codexHome, "01", PARENT, [meta(PARENT), ...turn("t1", "glm\u001b]52;c;ZXZpbA==\u0007-5p2\u001b[2J"), call("t1", "r1", 100, 0, 10)]);
      const report = await readCodexUsage({ codexHome, home });
      assert.deepEqual(report.rows.map((row) => row.model), ["glm-5p2"]);
      const { matchServedCalls } = await import("../../../../lib/harnesses/codex/usage/served-models.mjs");
      const served = matchServedCalls(
        [{ key: "r1", responseId: "r1", signature: "1:0:1" }],
        [{ response_id: "r1", model_used: "kimi\u001b[31m-k3\n", usage: { input: 1, cached: 0, output: 1 } }],
      );
      assert.equal(served.get("r1").model, "kimi-k3");
    });
  });

  it("errors on an explicit --session even when there are no Codex logs at all", async () => {
    await withCodexHome(async (home) => {
      const result = await runFireconnect(["codex", "usage", "--session", "missing", "--json"], { HOME: home });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr + result.stdout, /No Codex session log/);
    });
  });

  it("orders a session's lookup calls by instant across time-zone offsets", async () => {
    await withCodexHome(async (home, codexHome) => {
      const { readCodexSessionTree, codexServedLookup } = await import("../../../../lib/harnesses/codex/usage/report.mjs");
      const at = (iso, turnId, id) => ({ type: "token_usage_record", timestamp: iso, payload: { turn_id: turnId, response_id: id, usage: usage(10, 0, 1) } });
      const parentPath = await writeRollout(codexHome, "01", PARENT, [meta(PARENT), ...turn("t1", "auto"), at("2026-11-01T14:00:00Z", "t1", "r_parent")]);
      await writeRollout(codexHome, "01", CHILD, [meta(CHILD, { parent_thread_id: PARENT }), ...turn("c1", "auto"), at("2026-11-01T15:30:00+02:00", "c1", "r_child")]);
      const lookup = codexServedLookup(await readCodexSessionTree({ codexHome, sessionPath: parentPath }));
      // 15:30+02:00 is 13:30Z, before the parent's 14:00Z.
      assert.deepEqual(lookup.calls.map((c) => c.key), ["r_child", "r_parent"]);
    });
  });

  it("puts undated calls after the dated ones in a session's lookup, without unsorting the rest", async () => {
    await withCodexHome(async (home, codexHome) => {
      const { readCodexSessionTree, codexServedLookup } = await import("../../../../lib/harnesses/codex/usage/report.mjs");
      const at = (iso, turnId, id) => ({ type: "token_usage_record", timestamp: iso, payload: { turn_id: turnId, response_id: id, usage: usage(10, 0, 1) } });
      const parentPath = await writeRollout(codexHome, "01", PARENT, [meta(PARENT), ...turn("t1", "auto"), at("2026-11-01T14:00:00Z", "t1", "r_late"), at(undefined, "t1", "r_undated")]);
      await writeRollout(codexHome, "01", CHILD, [meta(CHILD, { parent_thread_id: PARENT }), ...turn("c1", "auto"), at("2026-11-01T13:00:00Z", "c1", "r_early")]);
      const lookup = codexServedLookup(await readCodexSessionTree({ codexHome, sessionPath: parentPath }));
      assert.deepEqual(lookup.calls.map((c) => c.key), ["r_early", "r_late", "r_undated"]);
    });
  });

  it("converts a nonzero cache write into its own bucket", () => {
    assert.deepEqual(codexUsageToClaudeUsage({ input_tokens: 1_000, cached_input_tokens: 600, cache_write_input_tokens: 100, output_tokens: 20 }), {
      input_tokens: 300,
      cache_read_input_tokens: 600,
      cache_creation_input_tokens: 100,
      output_tokens: 20,
    });
  });

  it("keeps calls without a response id apart across sessions", async () => {
    await withCodexHome(async (home, codexHome) => {
      // Same timestamp, position and counts in two sessions: only the thread id tells them apart.
      const idless = () => [{ type: "event_msg", timestamp: "2026-11-01T14:18:10Z", payload: { type: "token_count", info: { last_token_usage: usage(10, 0, 1), total_token_usage: usage(10, 0, 1) } } }];
      await writeRollout(codexHome, "01", PARENT, [meta(PARENT), ...turn("t1", "auto"), ...idless()]);
      await writeRollout(codexHome, "01", OLDER, [meta(OLDER), ...turn("o1", "auto"), ...idless()]);
      const resolveServed = async (lookups) => new Map(lookups.flatMap((lookup) => lookup.calls.map((call) => [
        call.key,
        { model: lookup.sessionId === PARENT ? "glm-5p2" : "kimi-k3", billedBy: "fireworks" },
      ])));
      const group = await readCodexUsages({ codexHome, home, lastN: 2, resolveServed });
      const models = Object.fromEntries(group.sessions.map((s) => [s.sessionId, s.rows.map((row) => row.model)]));
      assert.deepEqual(models, { [PARENT]: ["glm-5p2"], [OLDER]: ["kimi-k3"] });
    });
  });

  it("still counts legacy token_count calls in a turn after a modern one", () => {
    const rows = parseCodexUsageLog(jsonl([
      meta(PARENT),
      ...turn("t1", MODEL),
      call("t1", "r1", 100, 0, 10),
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(100, 0, 10), total_token_usage: usage(100, 0, 10) } } },
      // Resumed on an older build: this turn has only token_count.
      ...turn("t2", MODEL),
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(50, 0, 5), total_token_usage: usage(150, 0, 15) } } },
    ]));
    assert.deepEqual(rows.map((row) => [row.turn, row.input, row.output]), [[1, 100, 10], [2, 50, 5]]);
  });

  it("keeps a typed prompt that starts with a plain tag, and skips injected ones", async () => {
    await withCodexHome(async (home, codexHome) => {
      const userMsg = (text) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
      await writeRollout(codexHome, "01", PARENT, [
        meta(PARENT),
        ...turn("t1"),
        userMsg("<external_codex_apps_open_page>x</external_codex_apps_open_page>"),
        userMsg("# Files mentioned by the user:\n\n## a.txt"),
        userMsg("<config>debug=true</config> why does this fail"),
        call("t1", "r1", 100, 0, 10),
      ]);
      assert.equal((await readCodexUsage({ codexHome, home })).sessionName, "<config>debug=true</config> why does this fail");
    });
  });

  it("strips terminal control sequences from session names", async () => {
    await withCodexHome(async (home, codexHome) => {
      await seedSessions(codexHome);
      await writeFile(path.join(codexHome, "session_index.jsonl"), jsonl([{ id: PARENT, thread_name: "Fix\u001b]52;c;ZXZpbA==\u0007 the\u001b[2J\ntest" }]));
      assert.equal((await readCodexUsage({ codexHome, home, session: PARENT.slice(0, 8) })).sessionName, "Fix the test");
      await rm(path.join(codexHome, "session_index.jsonl"));
      await writeRollout(codexHome, "01", OLDER, [
        meta(OLDER),
        ...turn("o1"),
        { type: "event_msg", payload: { type: "user_message", message: "do\u001b[31m it\u0007" } },
        call("o1", "ro1", 100, 0, 10),
      ]);
      assert.equal((await readCodexUsage({ codexHome, home, session: OLDER.slice(0, 8) })).sessionName, "do it");
    });
  });

  it("never takes a session id from the log unless it is id-shaped", async () => {
    await withCodexHome(async (home, codexHome) => {
      await writeRollout(codexHome, "01", PARENT, [
        { type: "session_meta", payload: { id: "evil\u001b]52;c;ZXZpbA==\u0007\nid", session_id: "x\u001b[31m" } },
        ...turn("t1"),
        call("t1", "r1", 100, 0, 10),
      ]);
      const report = await readCodexUsage({ codexHome, home });
      // Falls back to the id in the rollout's filename.
      assert.equal(report.sessionId, PARENT);
    });
  });

  it("includes subagents when the session is named by its rollout path", async () => {
    await withCodexHome(async (home, codexHome) => {
      const parentPath = await seedSessions(codexHome);
      const report = await readCodexUsage({ codexHome, home, session: parentPath });
      assert.deepEqual(report.subagents.map((subagent) => subagent.id), ["Scout-0000b002"]);
      assert.equal(report.grandRequests, 3);
    });
  });

  it("keeps an older subagent in a recent session's totals under --days", async () => {
    await withCodexHome(async (home, codexHome) => {
      const now = Date.now();
      await writeRollout(codexHome, "01", PARENT, [meta(PARENT), ...turn("t1"), call("t1", "r1", 100, 0, 10)], now - 1000);
      await writeRollout(codexHome, "01", CHILD, [
        meta(CHILD, { parent_thread_id: PARENT, agent_nickname: "Scout" }),
        ...turn("c1"),
        call("c1", "rc1", 500, 0, 20),
      ], now - 5 * 86_400_000);
      const group = await readCodexUsages({ codexHome, home, lastN: 25, withinDays: 3 });
      assert.deepEqual(group.sessions.map((s) => s.sessionId), [PARENT]);
      assert.equal(group.sessions[0].grandRequests, 2);
    });
  });

  it("applies --days to the single-session report and treats no logs as an empty report", async () => {
    await withCodexHome(async (home, codexHome) => {
      const empty = await runFireconnect(["codex", "usage", "--last-n", "1", "--plain"], { HOME: home });
      assert.equal(empty.code, 0, empty.stderr);
      assert.match(empty.stdout, /No Codex session usage found\./);

      await writeRollout(codexHome, "01", OLDER, [meta(OLDER), ...turn("o1"), call("o1", "ro1", 100, 0, 10)], Date.now() - 10 * 86_400_000);
      const json = await runFireconnect(["codex", "usage", "--days", "3", "--json"], { HOME: home });
      assert.equal(json.code, 0, json.stderr);
      assert.equal(JSON.parse(json.stdout), null);
      const all = await runFireconnect(["codex", "usage", "--days", "30", "--json"], { HOME: home });
      assert.equal(JSON.parse(all.stdout).sessionId, OLDER);
    });
  });

  it("explains unpriced auto calls with the lookup, not a catalog refresh", async () => {
    await withCodexHome(async (home, codexHome) => {
      await writeRollout(codexHome, "01", PARENT, [meta(PARENT), ...turn("t1", "auto"), call("t1", "r1", 100, 0, 10)]);
      const plain = await runFireconnect(["codex", "usage", "--plain"], { HOME: home });
      assert.equal(plain.code, 0, plain.stderr);
      assert.match(plain.stdout, /Codex logs only the requested model/);
    });
  });

  it("errors cleanly when there are no rollouts", async () => {
    await withCodexHome(async (home, codexHome) => {
      await assert.rejects(readCodexUsage({ codexHome, home }), /No Codex session logs found under/);
    });
  });

  it("prints JSON and plain reports from the CLI", async () => {
    await withCodexHome(async (home, codexHome) => {
      await seedSessions(codexHome);
      const json = await runFireconnect(["codex", "usage", "--json"], { HOME: home });
      assert.equal(json.code, 0, json.stderr);
      const report = JSON.parse(json.stdout);
      assert.equal(report.sessionId, PARENT);
      assert.equal(report.grandRequests, 3);

      const plain = await runFireconnect(["codex", "usage", "--last-n", "2", "--plain"], { HOME: home });
      assert.equal(plain.code, 0, plain.stderr);
      assert.match(plain.stdout, new RegExp(`start session ${PARENT} \\(Fix failing test\\)`));
      assert.match(plain.stdout, /Scout-0000b002/);
      assert.match(plain.stdout, /Session totals for last 2 sessions:/);
    });
  });
});
