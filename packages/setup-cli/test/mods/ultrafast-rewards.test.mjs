import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MAX_RESPONSE_CHARS,
  MOCK_API_KEY,
  fetchBoostStatus,
  fireworksKeyFromEnv,
  mockOrigin,
  runningWindow,
  sanitizeReason,
  windowRewardReason,
} from "../../mods/ultrafast-fireworks/hooks/rewards.mjs";

const NOW = Date.parse("2026-11-20T18:00:00Z");
const WINDOW = {
  windowId: "window-a1",
  source: "POWERUP",
  sourceId: "reward-a1",
  startTime: "2026-11-20T16:00:00Z",
  endTime: "2026-11-20T21:00:00Z",
};
const STATUS = {
  name: "accounts/example-account/nexusUltrafastStatus",
  featureAvailable: true,
  bankedDuration: "0s",
  readTime: "2026-11-20T18:00:00Z",
  activeWindow: WINDOW,
};
const REWARD = {
  name: "accounts/example-account/nexusUltrafastRewards/reward-a1",
  source: "TASK",
  powerup: "accounts/example-account/nexusUltrafastPowerups/auto-sessions-10",
  duration: "18000s",
  reason: "You sent 5M tokens!",
};

/** A stub of the mod's `$.http.fetch`, recording what was asked. */
function gateway({ status = STATUS, rewards = { nexusUltrafastRewards: [REWARD] }, statuses = {}, throwOn = "", bodies = {} } = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    requests.push({ url, path, authorization: init?.headers?.Authorization });
    if (throwOn && path.endsWith(throwOn)) throw new Error("offline");
    const reply = (code, body, headers = {}) => ({ status: code, ok: code >= 200 && code < 300, headers, text: body });
    if (path === "/verifyApiKey") {
      return reply(statuses.verify ?? 200, "", { "x-fireworks-account-id": "example-account" });
    }
    return path.endsWith("/nexusUltrafastStatus")
      ? reply(statuses.status ?? 200, bodies.status ?? JSON.stringify(status))
      : reply(statuses.rewards ?? 200, JSON.stringify(rewards));
  };
  return { fetch, requests };
}

describe("fetchBoostStatus", () => {
  test("reads the running window and its reward's reason", async () => {
    const { fetch, requests } = gateway();
    assert.deepEqual(await fetchBoostStatus({ fetch, key: "fw_test_key", now: NOW }), {
      active: true,
      activationId: "window-a1",
      activatedAt: Date.parse(WINDOW.startTime),
      expiresAt: Date.parse(WINDOW.endTime),
      reason: "You sent 5M tokens!",
    });
    assert.deepEqual(requests.map((r) => r.path), [
      "/verifyApiKey",
      "/v1/accounts/example-account/nexusUltrafastStatus",
      "/v1/accounts/example-account/nexusUltrafastRewards",
    ]);
    assert.ok(requests.every((r) => r.authorization === "Bearer fw_test_key"));
  });

  test("reads no window, or Ultra-fast not offered, as inactive without asking for rewards", async () => {
    for (const status of [{ ...STATUS, activeWindow: undefined }, { ...STATUS, featureAvailable: false }]) {
      const { fetch, requests } = gateway({ status });
      assert.equal((await fetchBoostStatus({ fetch, key: "fw_test_key", now: NOW })).active, false);
      assert.ok(!requests.some((r) => r.path.endsWith("/nexusUltrafastRewards")));
    }
  });

  test("asks for a reason only for a window a reward started", async () => {
    const { fetch, requests } = gateway({ status: { ...STATUS, activeWindow: { ...WINDOW, source: "DAILY_DROP", sourceId: "drop-1" } } });
    const status = await fetchBoostStatus({ fetch, key: "fw_test_key", now: NOW });
    assert.equal(status.active, true);
    assert.equal(status.reason, "");
    assert.ok(!requests.some((r) => r.path.endsWith("/nexusUltrafastRewards")));
  });

  test("shows the banner without a reason when the reward has none or the lookup fails", async () => {
    for (const setup of [{ statuses: { rewards: 500 } }, { throwOn: "/nexusUltrafastRewards" }, { rewards: { nexusUltrafastRewards: [{ ...REWARD, reason: "" }] } }]) {
      const { fetch } = gateway(setup);
      const status = await fetchBoostStatus({ fetch, key: "fw_test_key", now: NOW });
      assert.equal(status.active, true);
      assert.equal(status.reason, "");
    }
  });

  test("reads a definite refusal (e.g. FAILED_PRECONDITION for a non-Nexus account) as inactive", async () => {
    for (const code of [400, 403, 404]) {
      const { fetch } = gateway({ statuses: { status: code } });
      assert.equal((await fetchBoostStatus({ fetch, key: "fw_test_key", now: NOW })).active, false, String(code));
    }
  });

  test("answers null for UNAVAILABLE or no answer, so the last status stays", async () => {
    for (const setup of [{ statuses: { status: 503 } }, { statuses: { status: 429 } }, { statuses: { verify: 401 } }, { throwOn: "/nexusUltrafastStatus" }]) {
      const { fetch } = gateway(setup);
      assert.equal(await fetchBoostStatus({ fetch, key: "fw_test_key", now: NOW }), null, JSON.stringify(setup));
    }
    const { fetch, requests } = gateway();
    assert.equal(await fetchBoostStatus({ fetch, key: "", now: NOW }), null);
    assert.equal(requests.length, 0);
  });

  test("sends the key only to the Fireworks gateway", async () => {
    const { fetch, requests } = gateway();
    await fetchBoostStatus({ fetch, key: "fw_real_key", now: NOW });
    assert.ok(requests.length > 0);
    // The literal, not the shared constant: retargeting it must fail here.
    for (const request of requests) assert.equal(new URL(request.url).origin, "https://api.fireworks.ai");
  });

  test("keys a window without an id by its source, source id and start", async () => {
    const { windowId, ...anonymous } = WINDOW;
    assert.ok(windowId);
    const { fetch } = gateway({ status: { ...STATUS, activeWindow: anonymous } });
    const status = await fetchBoostStatus({ fetch, key: "fw_test_key", now: NOW });
    assert.equal(status.activationId, `POWERUP@reward-a1@${Date.parse(WINDOW.startTime)}`);
  });

  test("keeps the same id for a window without one across checks, so the banner plays once", async () => {
    const { windowId, ...anonymous } = WINDOW;
    assert.ok(windowId);
    const ids = [];
    // Each check reads a slightly different clock offset, as real polls do.
    for (const [readTime, now] of [["2026-11-20T18:00:00Z", NOW], ["2026-11-20T18:01:58.700Z", NOW + 120_000]]) {
      const { fetch } = gateway({ status: { ...STATUS, readTime, activeWindow: anonymous } });
      ids.push((await fetchBoostStatus({ fetch, key: "fw_test_key", now })).activationId);
    }
    assert.equal(ids[0], ids[1]);
  });

  test("records one line on how each check ended, never the key", async () => {
    const cases = [
      [{}, "fw_test_key", /^boost on until /],
      [{ status: { ...STATUS, activeWindow: undefined } }, "fw_test_key", /^no Ultra-fast window running$/],
      [{ statuses: { status: 404 } }, "fw_test_key", /^status answered 404: no boost$/],
      [{ statuses: { status: 503 } }, "fw_test_key", /^status answered 503: kept the last status$/],
      [{ statuses: { verify: 401 } }, "fw_test_key", /^key check answered 401$/],
      [{ throwOn: "/verifyApiKey" }, "fw_test_key", /^no answer \(network error\)$/],
      [{}, "", /^no Fireworks key in the user settings$/],
    ];
    for (const [setup, key, expected] of cases) {
      const outcome = {};
      await fetchBoostStatus({ fetch: gateway(setup).fetch, key, now: NOW, outcome });
      assert.match(outcome.text, expected, JSON.stringify(setup));
      assert.doesNotMatch(outcome.text, /fw_/);
    }
  });

  test("talks to a loopback mock with a placeholder key, never the user's", async () => {
    const mocked = gateway();
    await fetchBoostStatus({ fetch: mocked.fetch, key: "fw_real_key", mockUrl: "http://127.0.0.1:8799", now: NOW });
    assert.ok(mocked.requests.length > 0);
    for (const request of mocked.requests) {
      assert.equal(new URL(request.url).origin, "http://127.0.0.1:8799");
      assert.equal(request.authorization, `Bearer ${MOCK_API_KEY}`);
    }
    const remote = gateway();
    await fetchBoostStatus({ fetch: remote.fetch, key: "fw_real_key", mockUrl: "http://gateway.example:8799", now: NOW });
    for (const request of remote.requests) assert.equal(new URL(request.url).origin, "https://api.fireworks.ai");
  });

  test("asks for the account once per key, and again after the key changes or is refused", async () => {
    const cache = {};
    const first = gateway();
    await fetchBoostStatus({ fetch: first.fetch, key: "fw_test_key", now: NOW, cache });
    assert.equal(first.requests.filter((r) => r.path === "/verifyApiKey").length, 1);
    assert.equal(cache.accountId, "example-account");
    assert.ok(!JSON.stringify(cache).includes("fw_test_key"));

    const again = gateway();
    assert.equal((await fetchBoostStatus({ fetch: again.fetch, key: "fw_test_key", now: NOW, cache })).active, true);
    assert.ok(!again.requests.some((r) => r.path === "/verifyApiKey"));

    const otherKey = gateway();
    await fetchBoostStatus({ fetch: otherKey.fetch, key: "fw_other_key", now: NOW, cache });
    assert.equal(otherKey.requests.filter((r) => r.path === "/verifyApiKey").length, 1);

    const refused = gateway({ statuses: { status: 401 } });
    await fetchBoostStatus({ fetch: refused.fetch, key: "fw_other_key", now: NOW, cache });
    assert.equal(cache.accountId, undefined);
  });

  test("reports the status route's HTTP status, so the caller can back off after a 404", async () => {
    for (const code of [200, 404, 503]) {
      const outcome = {};
      await fetchBoostStatus({ fetch: gateway({ statuses: { status: code } }).fetch, key: "fw_test_key", now: NOW, outcome });
      assert.equal(outcome.status, code);
    }
    const outcome = {};
    await fetchBoostStatus({ fetch: gateway({ throwOn: "/nexusUltrafastStatus" }).fetch, key: "fw_test_key", now: NOW, outcome });
    assert.equal(outcome.status, undefined);
  });

  test("gives up on a request that never answers, so the next check can start", async () => {
    for (const hangOn of ["/verifyApiKey", "/nexusUltrafastStatus"]) {
      const asked = [];
      const fetch = (url, init) => {
        asked.push(new URL(url).pathname);
        return new URL(url).pathname.endsWith(hangOn) ? new Promise(() => {}) : gateway().fetch(url, init);
      };
      const outcome = {};
      const started = Date.now();
      assert.equal(await fetchBoostStatus({ fetch, key: "fw_test_key", now: NOW, outcome, timeoutMs: 20 }), null, hangOn);
      assert.ok(Date.now() - started < 2_000);
      assert.match(outcome.text, /^no answer within /);
      // The check finished, so a caller's one-at-a-time guard is released and
      // the next check sends a new request.
      const before = asked.length;
      await fetchBoostStatus({ fetch, key: "fw_test_key", now: NOW, timeoutMs: 20 });
      assert.ok(asked.length > before);
    }
  });

  test("still shows the banner when only the reason lookup hangs", async () => {
    const fetch = (url, init) => (new URL(url).pathname.endsWith("/nexusUltrafastRewards") ? new Promise(() => {}) : gateway().fetch(url, init));
    const status = await fetchBoostStatus({ fetch, key: "fw_test_key", now: NOW, timeoutMs: 20 });
    assert.equal(status.active, true);
    assert.equal(status.reason, "");
  });

  test("times requests with the caller's scheduler and cancels it once answered", async () => {
    const timers = [];
    const after = (ms, fn) => {
      const timer = { ms, fn, cancelled: false, cancel() { this.cancelled = true; } };
      timers.push(timer);
      return timer;
    };
    await fetchBoostStatus({ fetch: gateway().fetch, key: "fw_test_key", now: NOW, after, timeoutMs: 1234 });
    assert.equal(timers.length, 3);
    assert.ok(timers.every((t) => t.ms === 1234 && t.cancelled));
  });

  test("treats an oversized status response as no answer", async () => {
    const { fetch } = gateway({ bodies: { status: `{"pad":"${"x".repeat(MAX_RESPONSE_CHARS)}"}` } });
    assert.equal(await fetchBoostStatus({ fetch, key: "fw_test_key", now: NOW }), null);
  });
});

describe("the key and the mock", () => {
  test("finds the key where `nexus claude on` writes it", () => {
    assert.equal(fireworksKeyFromEnv({ ANTHROPIC_CUSTOM_HEADERS: "X-Other: 1\nX-Fireworks-Api-Key: fw_abc" }), "fw_abc");
    assert.equal(fireworksKeyFromEnv({ ANTHROPIC_CUSTOM_HEADERS: "x-fireworks-api-key:fw_lower" }), "fw_lower");
    assert.equal(fireworksKeyFromEnv({ ANTHROPIC_API_KEY: "fw_direct" }), "fw_direct");
    assert.equal(fireworksKeyFromEnv({ ANTHROPIC_API_KEY: "sk-ant-not-fireworks" }), "");
    assert.equal(fireworksKeyFromEnv({ ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: not-a-key" }), "");
    assert.equal(fireworksKeyFromEnv(undefined), "");
  });

  test("accepts only a loopback mock", () => {
    assert.equal(mockOrigin("http://127.0.0.1:8799/x"), "http://127.0.0.1:8799");
    assert.equal(mockOrigin("http://localhost:1"), "http://localhost:1");
    assert.equal(mockOrigin("http://[::1]:9"), "http://[::1]:9");
    assert.equal(mockOrigin("https://gateway.example"), null);
    assert.equal(mockOrigin("http://10.0.0.1"), null);
    assert.equal(mockOrigin("file:///tmp/x"), null);
    assert.equal(mockOrigin(undefined), null);
  });
});

describe("reading the status", () => {
  test("puts the window on this machine's clock, using the server's readTime", () => {
    // The server's clock reads 2 minutes behind ours.
    const window = runningWindow({ ...STATUS, readTime: "2026-11-20T17:58:00Z" }, NOW);
    assert.equal(window.end, Date.parse(WINDOW.endTime) + 2 * 60_000);
    assert.equal(window.start, Date.parse(WINDOW.startTime) + 2 * 60_000);
    assert.equal(runningWindow({ ...STATUS, readTime: undefined }, NOW).end, Date.parse(WINDOW.endTime));
  });

  test("ignores a window that already ended, and reads snake_case fields too", () => {
    assert.equal(runningWindow({ ...STATUS, activeWindow: { ...WINDOW, endTime: "2026-11-20T17:00:00Z" } }, NOW), null);
    const snake = {
      feature_available: true,
      read_time: STATUS.readTime,
      active_window: { window_id: "w", source: "POWERUP", source_id: "r", start_time: WINDOW.startTime, end_time: WINDOW.endTime },
    };
    assert.equal(runningWindow(snake, NOW).id, "w");
    assert.equal(runningWindow(null, NOW), null);
  });

  test("finds the starting reward's reason by its ID", () => {
    const window = runningWindow(STATUS, NOW);
    assert.equal(windowRewardReason({ nexusUltrafastRewards: [REWARD] }, window), "You sent 5M tokens!");
    assert.equal(windowRewardReason({ nexusUltrafastRewards: [{ ...REWARD, name: "accounts/example-account/nexusUltrafastRewards/other" }] }, window), "");
    assert.equal(windowRewardReason({ nexusUltrafastRewards: [REWARD] }, { ...window, source: "SCHEDULED_DROP" }), "");
  });

  test("backend text cannot inject escapes or break the line", () => {
    assert.equal(sanitizeReason("Hi\u001b[31m there\nnow\u202e!"), "Hi [31m there now !");
    assert.equal(sanitizeReason(42), "");
    assert.equal(sanitizeReason("x".repeat(500)).length, 200);
  });
});
