import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeClaudeUsageCost } from "../../../../lib/harnesses/claude/usage/pricing.mjs";
import {
  codexUsageToClaudeUsage,
  readCodexUsage,
} from "../../../../lib/harnesses/codex/usage/report.mjs";
import {
  fetchSessionCalls,
  matchServedCalls,
  resolveServedModels,
  retryAfterMs,
  SERVED_LOOKUP_RATE_LIMITED,
  SESSION_CALLS_BASE_URL,
  servedModelLookupEnabled,
  usageSignature,
} from "../../../../lib/harnesses/codex/usage/served-models.mjs";
import { scopedCacheFilePath } from "../../../../lib/fireworks/serverless-catalog-cache.mjs";
import { globalConfigPath } from "../../../../lib/config/global-config.mjs";
import { runFireconnect } from "../../../helpers.mjs";

const ROOT = "a1000000-0000-7000-8000-00000000a001";
const CHILD = "b2000000-0000-7000-8000-00000000b002";
const KEY = "fw_test0000000000000000000000";
const SERVED = "glm-5p3";

function jsonl(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function usage(input, cached, output) {
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output };
}

function remote({ responseId = null, model = SERVED, billedBy = "fireworks", input, cached, output, traceId }) {
  return {
    trace_id: traceId ?? `t-${input}-${cached}-${output}-${responseId ?? "x"}`,
    response_id: responseId,
    model_requested: "auto",
    model_used: model,
    billed_by: billedBy,
    usage: { input, cached, cache_write: 0, output, reasoning: null },
  };
}

/** A fetch stub answering from a list of pages, recording each URL. */
function pagedFetch(pages, { status = 200 } = {}) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(new URL(url));
    const body = pages[Math.min(urls.length - 1, pages.length - 1)];
    return { ok: status === 200, status, json: async () => body };
  };
  return { fetchImpl, urls };
}

async function withHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "nexus-served-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const ENABLED_ENV = { NEXUS_TEST: "1", NEXUS_SESSION_CALLS_BASE_URL: "http://127.0.0.1:9" };

describe("codex served-model lookup", () => {
  it("defaults to the gateway route", () => {
    assert.equal(SESSION_CALLS_BASE_URL, "https://api.fireworks.ai/inference/v1/nexus/sessions");
  });

  it("stays off under tests, with the kill switch, or without a route override", () => {
    assert.equal(servedModelLookupEnabled({ NEXUS_TEST: "1" }), false);
    assert.equal(servedModelLookupEnabled(ENABLED_ENV), true);
    assert.equal(servedModelLookupEnabled({ ...ENABLED_ENV, NEXUS_SERVED_MODEL_LOOKUP: "0" }), false);
    assert.equal(servedModelLookupEnabled({}), true);
  });

  it("matches by response id first, then by token counts against id-less rows only", () => {
    const local = [
      { key: "resp_a", responseId: "resp_a", signature: usageSignature(100, 50, 5) },
      // Same tokens as a row that belongs to a different response: must not pair.
      { key: "resp_b", responseId: "resp_b", signature: usageSignature(200, 0, 7) },
      // Older Codex: no response id, pairs on tokens.
      { key: "old#0", responseId: "", signature: usageSignature(300, 100, 9) },
    ];
    const rows = [
      remote({ responseId: "resp_z", input: 200, cached: 0, output: 7, model: "kimi-k3" }),
      remote({ responseId: "resp_a", input: 100, cached: 50, output: 5, model: "glm-5p2", billedBy: "provider" }),
      remote({ input: 300, cached: 100, output: 9 }),
    ];
    const matched = matchServedCalls(local, rows);
    assert.deepEqual(matched.get("resp_a"), { model: "glm-5p2", billedBy: "provider" });
    assert.equal(matched.has("resp_b"), false);
    assert.deepEqual(matched.get("old#0"), { model: SERVED, billedBy: "fireworks" });
  });

  it("pairs repeated token counts in order and skips rows with no served model", () => {
    const sig = usageSignature(10, 0, 1);
    const matched = matchServedCalls(
      [{ key: "a", signature: sig }, { key: "b", signature: sig }, { key: "c", signature: sig }],
      [
        remote({ input: 10, cached: 0, output: 1, model: "kimi-k3", traceId: "1" }),
        remote({ input: 10, cached: 0, output: 1, model: "glm-5p3", traceId: "2" }),
        remote({ input: 10, cached: 0, output: 1, model: "", traceId: "3" }),
      ],
    );
    assert.equal(matched.get("a").model, "kimi-k3");
    assert.equal(matched.get("b").model, "glm-5p3");
    assert.equal(matched.has("c"), false);
  });

  it("pages with the since/after cursor", async () => {
    const first = remote({ responseId: "r1", input: 1, cached: 0, output: 1, traceId: "1" });
    const second = remote({ responseId: "r2", input: 2, cached: 0, output: 1, traceId: "2" });
    const { fetchImpl, urls } = pagedFetch([
      { tracing_enabled: true, calls: [first], next_since: "2026-11-01T14:19:00Z", next_after: "1" },
      { tracing_enabled: true, calls: [second], next_since: null, next_after: null },
    ]);
    const { calls, truncated } = await fetchSessionCalls({ sessionId: ROOT, since: "2026-11-01T14:17:00Z", apiKey: KEY, baseUrl: "http://x", fetchImpl });
    assert.deepEqual(calls.map((c) => c.trace_id), ["1", "2"]);
    assert.equal(truncated, false);
    assert.equal(urls[0].href.split("?")[0], `http://x/${ROOT}/calls`);
    assert.equal(urls[0].searchParams.get("since"), "2026-11-01T14:17:00Z");
    assert.equal(urls[0].searchParams.get("after"), null);
    assert.equal(urls[1].searchParams.get("since"), "2026-11-01T14:19:00Z");
    assert.equal(urls[1].searchParams.get("after"), "1");
  });

  it("rejects a cursor that does not move", async () => {
    const stuck = { calls: [], next_since: "a", next_after: "x" };
    assert.deepEqual(await fetchSessionCalls({ sessionId: ROOT, apiKey: KEY, baseUrl: "http://x", fetchImpl: pagedFetch([stuck, stuck]).fetchImpl }), { failed: "unexpected response" });
  });

  it("says why on any failure and returns an empty list when tracing is off", async () => {
    assert.deepEqual(await fetchSessionCalls({ sessionId: ROOT, apiKey: KEY, baseUrl: "http://x", fetchImpl: pagedFetch([{}], { status: 403 }).fetchImpl }), { failed: "HTTP 403" });
    assert.deepEqual(await fetchSessionCalls({ sessionId: ROOT, apiKey: KEY, baseUrl: "http://x", fetchImpl: async () => { throw new Error("offline"); } }), { failed: "network error" });
    assert.deepEqual(await fetchSessionCalls({ sessionId: ROOT, apiKey: KEY, baseUrl: "http://x", fetchImpl: pagedFetch([{ calls: "nope" }]).fetchImpl }), { failed: "unexpected response" });
    const notJson = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } });
    assert.deepEqual(await fetchSessionCalls({ sessionId: ROOT, apiKey: KEY, baseUrl: "http://x", fetchImpl: notJson }), { failed: "unexpected response" });
    // Endless paging stops at the page cap and hands back a list marked truncated.
    const endless = pagedFetch([{ calls: [], next_since: "a" }, { calls: [], next_since: "b" }, { calls: [], next_since: "c" }, { calls: [], next_since: "d" }, { calls: [], next_since: "e" }]);
    const partial = await fetchSessionCalls({ sessionId: ROOT, apiKey: KEY, baseUrl: "http://x", fetchImpl: endless.fetchImpl });
    assert.equal(partial.truncated, true);
    assert.deepEqual(await fetchSessionCalls({ sessionId: ROOT, apiKey: KEY, baseUrl: "http://x", fetchImpl: pagedFetch([{ tracing_enabled: false, calls: [] }]).fetchImpl }), { calls: [], truncated: false, tracingOff: true });
  });

  it("gives up at the deadline instead of hanging", async () => {
    const hang = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    // AbortSignal.timeout's timer doesn't hold the event loop open, and this
    // fake fetch has no socket that would; without a live handle the runner
    // can drain the loop before the deadline fires.
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      const started = Date.now();
      assert.deepEqual(await fetchSessionCalls({ sessionId: ROOT, apiKey: KEY, baseUrl: "http://x", timeoutMs: 50, fetchImpl: hang }), { failed: "timeout" });
      assert.ok(Date.now() - started < 1000);
    } finally {
      clearInterval(keepAlive);
    }
  });

  it("caches resolved calls so a later run needs no network", async () => {
    await withHome(async (home) => {
      const env = ENABLED_ENV;
      const sessions = [{ sessionId: ROOT, startedAt: "2026-11-01T14:18:00Z", calls: [{ key: "r1", responseId: "r1", signature: usageSignature(1, 0, 1) }] }];
      const { fetchImpl, urls } = pagedFetch([{ calls: [remote({ responseId: "r1", input: 1, cached: 0, output: 1 })], next_since: null }]);
      const first = await resolveServedModels({ sessions, apiKey: KEY, home, env, fetchImpl });
      assert.equal(first.get("r1").model, SERVED);
      assert.equal(urls.length, 1);
      // `since` backs off from the session start: the server records a call when it starts.
      assert.equal(urls[0].searchParams.get("since"), "2026-11-01T14:17:00.000Z");
      assert.ok(JSON.parse(await readFile(scopedCacheFilePath("codex-served-models.json", home), "utf8")).sessions[ROOT]);

      const offline = await resolveServedModels({ sessions, apiKey: KEY, home, env, fetchImpl: async () => { throw new Error("must not fetch"); } });
      assert.equal(offline.get("r1").model, SERVED);
    });
  });

  it("keeps a cached call's row spoken for, so a later id-less call with the same counts gets its own", async () => {
    await withHome(async (home) => {
      const sig = usageSignature(10, 0, 1);
      const first = { key: "2026-11-01T14:18:10Z#0:10:0:1", responseId: "", signature: sig };
      const second = { key: "2026-11-01T14:18:20Z#1:10:0:1", responseId: "", signature: sig };
      const rows = [remote({ input: 10, cached: 0, output: 1, model: "glm-5p2", traceId: "1" }), remote({ input: 10, cached: 0, output: 1, model: "kimi-k3", traceId: "2" })];
      // Run 1 sees only the first call (the second hadn't happened yet).
      const run1 = pagedFetch([{ calls: rows.slice(0, 1), next_since: null }]);
      await resolveServedModels({ sessions: [{ sessionId: ROOT, calls: [first] }], apiKey: KEY, home, env: ENABLED_ENV, fetchImpl: run1.fetchImpl });
      // Run 2: the first is cached, the second is new; the first row must not be reused for it.
      const run2 = pagedFetch([{ calls: rows, next_since: null }]);
      const resolved = await resolveServedModels({ sessions: [{ sessionId: ROOT, calls: [first, second] }], apiKey: KEY, home, env: ENABLED_ENV, fetchImpl: run2.fetchImpl });
      assert.equal(resolved.get(first.key).model, "glm-5p2");
      assert.equal(resolved.get(second.key).model, "kimi-k3");
    });
  });

  it("serves cached served models only to the account that resolved them", async () => {
    await withHome(async (home) => {
      const sessions = [{ sessionId: ROOT, calls: [{ key: "r1", responseId: "r1", signature: usageSignature(1, 0, 1) }] }];
      const { fetchImpl } = pagedFetch([{ calls: [remote({ responseId: "r1", input: 1, cached: 0, output: 1 })], next_since: null }]);
      await resolveServedModels({ sessions, apiKey: KEY, home, env: ENABLED_ENV, fetchImpl });
      const otherKey = ["fw", `other${"1".repeat(21)}`].join("_");
      const offline = { NEXUS_SERVED_MODEL_LOOKUP: "0" };
      assert.equal((await resolveServedModels({ sessions, apiKey: otherKey, home, env: offline })).size, 0);
      assert.equal((await resolveServedModels({ sessions, apiKey: KEY, home, env: offline })).get("r1").model, SERVED);
    });
  });

  it("warns once when the endpoint override sends the key to a plain-HTTP remote host", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    await withHome(async (home) => {
      const sessions = [{ sessionId: ROOT, calls: [{ key: "r1", responseId: "r1", signature: "1:0:1" }] }];
      const env = { NEXUS_TEST: "1", NEXUS_SESSION_CALLS_BASE_URL: "http://example.invalid/sessions" };
      const failing = async () => { throw new Error("offline"); };
      await resolveServedModels({ sessions, apiKey: KEY, home, env, fetchImpl: failing });
      await resolveServedModels({ sessions, apiKey: KEY, home, env, fetchImpl: failing });
    });
    const warnings = warn.mock.calls.map((call) => String(call.arguments[0]));
    assert.deepEqual(warnings.filter((w) => /NEXUS_SESSION_CALLS_BASE_URL/.test(w)).length, 1);
  });

  it("pages from just before the earliest unresolved call, not the session start", async () => {
    await withHome(async (home) => {
      const done = { key: "r1", responseId: "r1", signature: usageSignature(1, 0, 1), at: "2026-11-01T10:00:00Z" };
      const later = { key: "r2", responseId: "r2", signature: usageSignature(2, 0, 1), at: "2026-11-01T12:00:00Z" };
      const sessions = (calls) => [{ sessionId: ROOT, startedAt: "2026-11-01T09:00:00Z", calls }];
      const first = pagedFetch([{ calls: [remote({ responseId: "r1", input: 1, cached: 0, output: 1 })], next_since: null }]);
      await resolveServedModels({ sessions: sessions([done]), apiKey: KEY, home, env: ENABLED_ENV, fetchImpl: first.fetchImpl });
      assert.equal(first.urls[0].searchParams.get("since"), "2026-11-01T09:59:00.000Z");
      const second = pagedFetch([{ calls: [remote({ responseId: "r2", input: 2, cached: 0, output: 1 })], next_since: null }]);
      const resolved = await resolveServedModels({ sessions: sessions([done, later]), apiKey: KEY, home, env: ENABLED_ENV, fetchImpl: second.fetchImpl });
      // r1 is cached, so the lookup starts a minute before r2.
      assert.equal(second.urls[0].searchParams.get("since"), "2026-11-01T11:59:00.000Z");
      assert.equal(resolved.get("r2").model, SERVED);
    });
  });

  it("takes only exact response-id matches from a truncated list", async () => {
    await withHome(async (home) => {
      const withId = { key: "r1", responseId: "r1", signature: usageSignature(1, 0, 1) };
      const idless = { key: "old#0", responseId: "", signature: usageSignature(3, 0, 1) };
      const rows = [remote({ responseId: "r1", input: 1, cached: 0, output: 1 }), remote({ input: 3, cached: 0, output: 1, traceId: "x" })];
      const pages = Array.from({ length: 5 }, (_, i) => ({ calls: i === 0 ? rows : [], next_since: `p${i}` }));
      const { fetchImpl } = pagedFetch(pages);
      const resolved = await resolveServedModels({ sessions: [{ sessionId: ROOT, calls: [withId, idless] }], apiKey: KEY, home, env: ENABLED_ENV, fetchImpl });
      assert.equal(resolved.get("r1").model, SERVED);
      assert.equal(resolved.has("old#0"), false);
    });
  });

  it("pairs a response id once even when two calls logged it, and skips rows with no served model", () => {
    const sig = usageSignature(5, 0, 1);
    const forked = matchServedCalls(
      [{ key: "a", responseId: "r1", signature: sig }, { key: "b", responseId: "r1", signature: sig }],
      [remote({ responseId: "r1", input: 5, cached: 0, output: 1, model: "m0" })],
    );
    assert.deepEqual([...forked.keys()], ["a"]);
    const skipped = matchServedCalls(
      [{ key: "a", responseId: "", signature: sig }],
      [remote({ input: 5, cached: 0, output: 1, model: "", traceId: "0" }), remote({ input: 5, cached: 0, output: 1, model: "m1", traceId: "1" })],
    );
    assert.equal(skipped.get("a").model, "m1");
  });

  it("pairs each server row with at most one local call, whatever the inputs", () => {
    // A small deterministic generator: many random sessions mixing calls with
    // and without response ids, shared and distinct token counts, and rows the
    // server has or hasn't got.
    // Take the high bits: an LCG's low bits cycle (its lowest just alternates).
    let seed = 7;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return Math.floor(seed / 2 ** 15) % n; };
    for (let trial = 0; trial < 500; trial += 1) {
      const sigs = ["1:0:1", "2:0:1", "3:1:2"];
      const local = Array.from({ length: rand(8) }, (_, i) => {
        const withId = rand(2) === 0;
        return { key: `k${i}`, responseId: withId ? `r${rand(6)}` : "", signature: sigs[rand(3)] };
      });
      const remoteRows = Array.from({ length: rand(8) }, (_, i) => {
        const [input, cached, output] = sigs[rand(3)].split(":").map(Number);
        return remote({ responseId: rand(2) === 0 ? `r${rand(6)}` : null, input, cached, output, model: `m${i}`, traceId: String(i) });
      });
      const matched = matchServedCalls(local, remoteRows);
      // Each row's model is unique (m<index>), so a model used twice means a row paired twice.
      const models = [...matched.values()].map((served) => served.model);
      assert.equal(new Set(models).size, models.length, `trial ${trial}: a server row was paired twice`);
      for (const [key, served] of matched) {
        const call = local.find((c) => c.key === key);
        const row = remoteRows[Number(served.model.slice(1))];
        // A pairing is either the same response id, or same counts where the row's id can't contradict the call's.
        const sameId = call.responseId && row.response_id === call.responseId;
        const sameCounts = usageSignature(row.usage.input, row.usage.cached, row.usage.output) === call.signature
          && (!call.responseId || !row.response_id);
        assert.ok(sameId || sameCounts, `trial ${trial}: ${key} paired with an unrelated row`);
      }
    }
  });

  it("does not fetch without a genuine fw_ key or when disabled", async () => {
    await withHome(async (home) => {
      const sessions = [{ sessionId: ROOT, calls: [{ key: "r1", responseId: "r1", signature: "1:0:1" }] }];
      const fetchImpl = async () => { throw new Error("must not fetch"); };
      assert.equal((await resolveServedModels({ sessions, apiKey: "fpk_x", home, env: ENABLED_ENV, fetchImpl })).size, 0);
      assert.equal((await resolveServedModels({ sessions, apiKey: KEY, home, env: { NEXUS_TEST: "1" }, fetchImpl })).size, 0);
    });
  });

  it("prices auto calls as the served model, covering subagents with the root session", async () => {
    await withHome(async (home) => {
      const codexHome = path.join(home, ".codex");
      const dir = path.join(codexHome, "sessions", "2026", "11", "01");
      await mkdir(dir, { recursive: true });
      const turn = (turnId) => [
        { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
        { type: "turn_context", payload: { turn_id: turnId, model: "auto" } },
      ];
      await writeFile(path.join(dir, `rollout-2026-11-01T10-00-00-${ROOT}.jsonl`), jsonl([
        { type: "session_meta", payload: { id: ROOT, session_id: ROOT, timestamp: "2026-11-01T14:18:00Z" } },
        ...turn("t1"),
        { type: "token_usage_record", timestamp: "2026-11-01T14:18:20Z", payload: { turn_id: "t1", response_id: "resp_main", usage: usage(13_228, 3_712, 66) } },
      ]));
      await writeFile(path.join(dir, `rollout-2026-11-01T10-01-00-${CHILD}.jsonl`), jsonl([
        { type: "session_meta", payload: { id: CHILD, session_id: ROOT, parent_thread_id: ROOT, agent_nickname: "Scout" } },
        ...turn("c1"),
        { type: "token_usage_record", timestamp: "2026-11-01T14:19:54Z", payload: { turn_id: "c1", response_id: "resp_sub", usage: usage(12_868, 7_296, 115) } },
      ]));

      const lookups = [];
      const resolveServed = async (requested) => {
        lookups.push(...requested);
        return matchServedCalls(requested[0].calls, [
          remote({ responseId: "resp_main", input: 13_228, cached: 3_712, output: 66, model: "glm-5p2", billedBy: "provider" }),
          remote({ responseId: "resp_sub", input: 12_868, cached: 7_296, output: 115 }),
        ]);
      };
      const report = await readCodexUsage({ codexHome, home, resolveServed });

      assert.deepEqual(lookups.map((l) => [l.sessionId, l.calls.length]), [[ROOT, 2]]);
      const [main] = report.rows;
      assert.equal(main.model, "glm-5p2");
      assert.equal(main.requestedModel, "auto");
      assert.equal(main.billedBy, "provider");
      assert.equal(main.cost, computeClaudeUsageCost("glm-5p2", codexUsageToClaudeUsage(usage(13_228, 3_712, 66))).cost);
      assert.equal(report.subagents[0].rows[0].model, SERVED);
      assert.equal(report.unpriced, 0);

      // A failing lookup leaves the rows as they were: requested model, n/a.
      const fallback = await readCodexUsage({ codexHome, home, resolveServed: async () => { throw new Error("boom"); } });
      assert.equal(fallback.rows[0].model, "auto");
      assert.equal(fallback.rows[0].cost, null);
    });
  });

  it("resolves served models end to end through the CLI against a mock route", async () => {
    await withHome(async (home) => {
      const codexHome = path.join(home, ".codex");
      const dir = path.join(codexHome, "sessions", "2026", "11", "01");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `rollout-2026-11-01T10-00-00-${ROOT}.jsonl`), jsonl([
        { type: "session_meta", payload: { id: ROOT, session_id: ROOT, timestamp: "2026-11-01T14:18:00Z" } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
        { type: "turn_context", payload: { turn_id: "t1", model: "auto" } },
        { type: "token_usage_record", timestamp: "2026-11-01T14:18:20Z", payload: { turn_id: "t1", response_id: "resp_main", usage: usage(1_000, 400, 50) } },
      ]));

      const seen = [];
      const server = http.createServer((req, res) => {
        seen.push({ url: req.url, auth: req.headers.authorization });
        if (req.url.startsWith(`/inference/v1/nexus/sessions/${ROOT}/calls`)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ tracing_enabled: true, calls: [remote({ responseId: "resp_main", input: 1_000, cached: 400, output: 50 })], next_since: null }));
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        // Env keys are never a source; --api-key is how a key reaches `usage` here.
        const result = await runFireconnect(["codex", "usage", "--json", "--api-key", KEY], {
          HOME: home,
          NEXUS_GATEWAY_URL: base,
          NEXUS_SESSION_CALLS_BASE_URL: `${base}/inference/v1/nexus/sessions`,
        });
        assert.equal(result.code, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(report.rows[0].model, SERVED);
        assert.equal(report.rows[0].requestedModel, "auto");
        assert.ok(report.rows[0].cost > 0);
        const lookup = seen.find((s) => s.url.startsWith("/inference/v1/nexus/sessions/"));
        assert.equal(lookup.auth, `Bearer ${KEY}`);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  it("says why a lookup failed under -v, and only there", async () => {
    await withHome(async (home) => {
      const codexHome = path.join(home, ".codex");
      const dir = path.join(codexHome, "sessions", "2026", "11", "01");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `rollout-2026-11-01T10-00-00-${ROOT}.jsonl`), jsonl([
        { type: "session_meta", payload: { id: ROOT, session_id: ROOT, timestamp: "2026-11-01T14:18:00Z" } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
        { type: "turn_context", payload: { turn_id: "t1", model: "auto" } },
        { type: "token_usage_record", timestamp: "2026-11-01T14:18:20Z", payload: { turn_id: "t1", response_id: "resp_main", usage: usage(1_000, 400, 50) } },
      ]));
      const server = http.createServer((req, res) => {
        res.writeHead(req.url.startsWith("/inference/v1/nexus/sessions/") ? 403 : 404).end();
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        const env = { HOME: home, NEXUS_GATEWAY_URL: base, NEXUS_SESSION_CALLS_BASE_URL: `${base}/inference/v1/nexus/sessions` };
        const verbose = await runFireconnect(["codex", "usage", "--plain", "-v", "--api-key", KEY], env);
        assert.equal(verbose.code, 0, verbose.stderr);
        assert.match(verbose.stderr, /served-model lookup failed for 1 session \(HTTP 403\)/);
        const quiet = await runFireconnect(["codex", "usage", "--plain", "--api-key", KEY], env);
        assert.equal(quiet.code, 0, quiet.stderr);
        assert.doesNotMatch(quiet.stderr, /served-model lookup failed/);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  it("looks up on the account's regional host, as Codex inference does", async () => {
    await withHome(async (home) => {
      await mkdir(path.dirname(globalConfigPath(home)), { recursive: true });
      await writeFile(globalConfigPath(home), JSON.stringify({ harnesses: { codex: { residency: "US" } } }));
      const call = { key: "resp_1", responseId: "resp_1", signature: usageSignature(3, 0, 1) };
      const { fetchImpl, urls } = pagedFetch([{ calls: [remote({ responseId: "resp_1", input: 3, cached: 0, output: 1 })], next_since: null }]);
      // No route override: the default URL, moved to the residency's host.
      const resolved = await resolveServedModels({ sessions: [{ sessionId: ROOT, calls: [call] }], apiKey: KEY, home, env: {}, fetchImpl });
      assert.equal(urls[0].origin, "https://us.api.fireworks.ai");
      assert.equal(urls[0].pathname, `/inference/v1/nexus/sessions/${ROOT}/calls`);
      assert.equal(resolved.get("resp_1").model, SERVED);
    });
  });

  it("reports each failed session's reason and survives a throwing observer", async () => {
    await withHome(async (home) => {
      const call = { key: "resp_1", responseId: "resp_1", signature: usageSignature(3, 0, 1) };
      const reasons = [];
      const refused = pagedFetch([{}], { status: 403 }).fetchImpl;
      await resolveServedModels({ sessions: [{ sessionId: ROOT, calls: [call] }], apiKey: KEY, home, env: ENABLED_ENV, fetchImpl: refused, onFailure: (r) => reasons.push(r) });
      assert.deepEqual(reasons, ["HTTP 403"]);
      const off = pagedFetch([{ tracing_enabled: false, calls: [] }]).fetchImpl;
      const boom = () => { throw new Error("observer"); };
      await resolveServedModels({ sessions: [{ sessionId: CHILD, calls: [call] }], apiKey: KEY, home, env: ENABLED_ENV, fetchImpl: off, onFailure: boom });
      // The tracing-off answer is cached; the next run still says why it skipped.
      await resolveServedModels({ sessions: [{ sessionId: CHILD, calls: [call] }], apiKey: KEY, home, env: ENABLED_ENV, fetchImpl: off, onFailure: (r) => reasons.push(r) });
      assert.deepEqual(reasons, ["HTTP 403", "tracing is off for this account"]);
    });
  });

  it("uses an explicit --api-key over the key Codex is routed with", async () => {
    await withHome(async (home) => {
      const codexHome = path.join(home, ".codex");
      const dir = path.join(codexHome, "sessions", "2026", "11", "01");
      await mkdir(dir, { recursive: true });
      const routedKey = ["fw", `routed${"2".repeat(20)}`].join("_");
      await writeFile(path.join(codexHome, "config.toml"), [
        'model_provider = "fireworks-ai"',
        'model = "auto"',
        "",
        "[model_providers.fireworks-ai]",
        'name = "Fireworks"',
        'base_url = "https://api.fireworks.ai/inference/v1"',
        'wire_api = "responses"',
        `experimental_bearer_token = "${routedKey}"`,
        "",
      ].join("\n"));
      await writeFile(path.join(dir, `rollout-2026-11-01T10-00-00-${ROOT}.jsonl`), jsonl([
        { type: "session_meta", payload: { id: ROOT, session_id: ROOT, timestamp: "2026-11-01T14:18:00Z" } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
        { type: "turn_context", payload: { turn_id: "t1", model: "auto" } },
        { type: "token_usage_record", timestamp: "2026-11-01T14:18:20Z", payload: { turn_id: "t1", response_id: "resp_main", usage: usage(1_000, 400, 50) } },
      ]));
      const auths = [];
      const server = http.createServer((req, res) => {
        auths.push(req.headers.authorization);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tracing_enabled: true, calls: [], next_since: null }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        const env = { HOME: home, NEXUS_GATEWAY_URL: base, NEXUS_SESSION_CALLS_BASE_URL: `${base}/inference/v1/nexus/sessions` };
        await runFireconnect(["codex", "usage", "--json"], env);
        assert.equal(auths.at(-1), `Bearer ${routedKey}`, "the routed key is used by default");
        await runFireconnect(["codex", "usage", "--json", "--api-key", KEY], env);
        assert.equal(auths.at(-1), `Bearer ${KEY}`, "an explicit --api-key wins");
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  it("compares a log timestamp with an offset as an instant when windowing the lookup", async () => {
    await withHome(async (home) => {
      // 15:18:10+01:00 is 14:18:10Z: inside a window that starts at 14:17:10Z.
      const offsetCall = { key: "old#0", responseId: "", signature: usageSignature(3, 0, 1), at: "2026-11-01T15:18:10+01:00" };
      const { fetchImpl, urls } = pagedFetch([{ calls: [remote({ input: 3, cached: 0, output: 1, traceId: "1" })], next_since: null }]);
      const resolved = await resolveServedModels({ sessions: [{ sessionId: ROOT, calls: [offsetCall] }], apiKey: KEY, home, env: ENABLED_ENV, fetchImpl });
      assert.equal(urls[0].searchParams.get("since"), "2026-11-01T14:17:10.000Z");
      assert.equal(resolved.get("old#0").model, SERVED);
    });
  });

  it("resolves at most two sessions at a time, and all of them", async () => {
    await withHome(async (home) => {
      const sessions = Array.from({ length: 9 }, (_, i) => ({
        sessionId: `s${i}`,
        calls: [{ key: `r${i}`, responseId: `r${i}`, signature: usageSignature(1, 0, 1) }],
      }));
      let inFlight = 0;
      let peak = 0;
      const fetchImpl = async (url) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        const id = new URL(url).pathname.split("/").at(-2).slice(1);
        return { ok: true, json: async () => ({ calls: [remote({ responseId: `r${id}`, input: 1, cached: 0, output: 1 })], next_since: null }) };
      };
      const resolved = await resolveServedModels({ sessions, apiKey: KEY, home, env: ENABLED_ENV, fetchImpl });
      assert.equal(peak, 2);
      assert.equal(resolved.size, 9);
    });
  });

  it("stops at the first 429 and waits out its Retry-After across runs", async () => {
    await withHome(async (home) => {
      const sessions = Array.from({ length: 9 }, (_, i) => ({
        sessionId: `s${i}`,
        calls: [{ key: `r${i}`, responseId: `r${i}`, signature: usageSignature(1, 0, 1) }],
      }));
      let clock = Date.parse("2026-11-19T12:00:00Z");
      const now = () => clock;
      let requests = 0;
      let refuse = true;
      const fetchImpl = async (url) => {
        requests += 1;
        const id = new URL(url).pathname.split("/").at(-2).slice(1);
        if (refuse && requests >= 3) {
          return { ok: false, status: 429, headers: new Headers({ "retry-after": "30" }), json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({ calls: [remote({ responseId: `r${id}`, input: 1, cached: 0, output: 1 })], next_since: null }) };
      };
      const reasons = [];
      const onFailure = (r) => reasons.push(r);
      const first = await resolveServedModels({ sessions, apiKey: KEY, home, env: ENABLED_ENV, fetchImpl, now, onFailure });
      // Two in flight when the 429 lands, so at most one more request goes out.
      assert.ok(requests <= 4, `stopped asking after the 429 (${requests} requests)`);
      assert.equal(first.size + reasons.length, 9);
      assert.ok(reasons.every((r) => r === SERVED_LOOKUP_RATE_LIMITED));

      // A later run inside the window asks nothing and says why.
      const before = requests;
      reasons.length = 0;
      clock += 20_000;
      const second = await resolveServedModels({ sessions, apiKey: KEY, home, env: ENABLED_ENV, fetchImpl, now, onFailure });
      assert.equal(requests, before);
      assert.equal(second.size, first.size, "cached answers still come back");
      assert.ok(reasons.length > 0 && reasons.every((r) => r === SERVED_LOOKUP_RATE_LIMITED));

      // Once it passes, the rest fill in.
      refuse = false;
      clock += 11_000;
      const third = await resolveServedModels({ sessions, apiKey: KEY, home, env: ENABLED_ENV, fetchImpl, now });
      assert.equal(third.size, 9);
    });
  });

  it("reads Retry-After as seconds or a date, within bounds", () => {
    const at = Date.parse("2026-11-19T12:00:00Z");
    assert.equal(retryAfterMs("30", at), 30_000);
    assert.equal(retryAfterMs("Thu, 19 Nov 2026 12:01:00 GMT", at), 60_000);
    assert.equal(retryAfterMs(null, at), 60_000);
    assert.equal(retryAfterMs("soon", at), 60_000);
    assert.equal(retryAfterMs("0", at), 60_000);
    assert.equal(retryAfterMs("86400", at), 600_000);
  });

  it("caps --last-n at 30 and says so", async () => {
    await withHome(async (home) => {
      const dir = path.join(home, ".codex", "sessions", "2026", "11", "01");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `rollout-2026-11-01T10-00-00-${ROOT}.jsonl`), jsonl([
        { type: "session_meta", payload: { id: ROOT, session_id: ROOT, timestamp: "2026-11-01T14:18:00Z" } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
        { type: "turn_context", payload: { turn_id: "t1", model: "kimi-k3" } },
        { type: "token_usage_record", timestamp: "2026-11-01T14:18:20Z", payload: { turn_id: "t1", response_id: "resp_main", usage: usage(10, 0, 1) } },
      ]));
      const env = { HOME: home, NEXUS_SERVED_MODEL_LOOKUP: "0" };
      const capped = await runFireconnect(["codex", "usage", "--json", "--last-n", "100", "--api-key", KEY], env);
      assert.equal(capped.code, 0, capped.stderr);
      assert.match(capped.stderr, /--last-n is capped at 30/);
      assert.equal(JSON.parse(capped.stdout).sessions.length, 1);
      const within = await runFireconnect(["codex", "usage", "--json", "--last-n", "30", "--api-key", KEY], env);
      assert.doesNotMatch(within.stderr, /capped/);
      const invalid = await runFireconnect(["codex", "usage", "--json", "--last-n", "zero", "--api-key", KEY], env);
      assert.notEqual(invalid.code, 0);
      assert.match(invalid.stderr, /--last-n must be a positive integer/);
    });
  });

  it("makes no request when NEXUS_SERVED_MODEL_LOOKUP=0", async () => {
    await withHome(async (home) => {
      const sessions = [{ sessionId: ROOT, calls: [{ key: "r1", responseId: "r1", signature: usageSignature(1, 0, 1) }] }];
      const fetchImpl = async () => { throw new Error("must not fetch"); };
      const resolved = await resolveServedModels({ sessions, apiKey: KEY, home, env: { ...ENABLED_ENV, NEXUS_SERVED_MODEL_LOOKUP: "0" }, fetchImpl });
      assert.equal(resolved.size, 0);
    });
  });

  it("keeps sessions another run cached while this one was looking up", async () => {
    await withHome(async (home) => {
      const one = (id) => [{ sessionId: id, calls: [{ key: `${id}-r`, responseId: `${id}-r`, signature: usageSignature(1, 0, 1) }] }];
      const answer = (id) => ({ ok: true, json: async () => ({ calls: [remote({ responseId: `${id}-r`, input: 1, cached: 0, output: 1 })], next_since: null }) });
      // B reads the (empty) cache, then A finishes and writes while B is still fetching.
      let releaseB;
      const bWaits = new Promise((resolve) => { releaseB = resolve; });
      const runB = resolveServedModels({ sessions: one("B"), apiKey: KEY, home, env: ENABLED_ENV, fetchImpl: async () => { await bWaits; return answer("B"); } });
      await resolveServedModels({ sessions: one("A"), apiKey: KEY, home, env: ENABLED_ENV, fetchImpl: async () => answer("A") });
      releaseB();
      await runB;
      const offline = { NEXUS_SERVED_MODEL_LOOKUP: "0" };
      const cached = await resolveServedModels({ sessions: [...one("A"), ...one("B")], apiKey: KEY, home, env: offline });
      assert.deepEqual([...cached.keys()].sort(), ["A-r", "B-r"]);
    });
  });

  it("asks once, not on every run, about a session whose account records no calls", async () => {
    await withHome(async (home) => {
      const sessions = [{ sessionId: ROOT, calls: [{ key: "r1", responseId: "r1", signature: usageSignature(1, 0, 1) }] }];
      const { fetchImpl, urls } = pagedFetch([{ tracing_enabled: false, calls: [] }]);
      assert.equal((await resolveServedModels({ sessions, apiKey: KEY, home, env: ENABLED_ENV, fetchImpl })).size, 0);
      assert.equal((await resolveServedModels({ sessions, apiKey: KEY, home, env: ENABLED_ENV, fetchImpl })).size, 0);
      assert.equal(urls.length, 1);
    });
  });
});
