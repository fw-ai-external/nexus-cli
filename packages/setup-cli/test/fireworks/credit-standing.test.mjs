import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import {
  CREDIT_STANDING_DEFAULT_GATEWAY_URL,
  CREDIT_STANDING_LOCK_TTL_MS,
  CREDIT_STANDING_MAX_AGE_MS,
  CREDIT_STANDING_NO_PLAN_TTL_MS,
  CREDIT_STANDING_TTL_MS,
  MAX_CREDIT_RESPONSE_BYTES,
  NEXUS_BILLING_URL,
  claimCreditStandingRefresh,
  clearCreditStandingCache,
  clearCreditStandingLastAttempt,
  createRefreshLockToken,
  creditKeyFingerprint,
  creditStandingCachePath,
  creditStandingJsonPayload,
  creditStandingLastAttemptPath,
  creditStandingLockPath,
  fetchCreditStandingSnapshot,
  formatCreditStandingLastAttempt,
  formatCreditStandingUsageLines,
  hasActiveCreditStandingRefreshLock,
  isCreditStandingCacheFresh,
  isPlanLimitReached,
  loadCreditStanding,
  ownsCreditStandingRefreshLock,
  parseAccountBody,
  parsePlanUsageBody,
  parseUserResourceName,
  reachedPlanLimit,
  readActiveCreditIndicator,
  readCreditStandingCache,
  readCreditStandingLastAttempt,
  readCreditStandingLockToken,
  refreshCreditStandingCache,
  releaseCreditStandingRefreshLock,
  resolveActiveCreditIndicator,
  resolveCreditStanding,
  writeCreditStandingCache,
  writeCreditStandingLastAttempt,
} from "../../lib/fireworks/credit-standing.mjs";
import { writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { claudeFireworksKeyFrom } from "../../lib/harnesses/claude/env-key.mjs";
import {
  maybeSpawnCreditStandingRefresh,
  spawnCreditStandingRefresh,
} from "../../lib/harnesses/claude/statusline-refresh.mjs";
import { mintedKeyStatePath, writeMintedKeyState } from "../../lib/keys/mint-api-key.mjs";
import { withTempHome } from "../helpers.mjs";

const EXAMPLE_KEY = "fw_example_credit_key_000000000000";
const EXAMPLE_USER = "accounts/example-account/users/example-user";
const NOW = Date.parse("2027-01-15T12:00:00Z");

async function startMockGateway(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("credit standing classification", () => {
  it("detects reached limits on raw percent >= 100 without rounding 99.6 up", () => {
    assert.equal(isPlanLimitReached(0), false);
    assert.equal(isPlanLimitReached(99.6), false);
    assert.equal(isPlanLimitReached(99.99), false);
    assert.equal(isPlanLimitReached(null), false);
    assert.equal(isPlanLimitReached(undefined), false);
    assert.equal(isPlanLimitReached(Number.NaN), false);
    assert.equal(isPlanLimitReached(100), true);
    assert.equal(isPlanLimitReached(104.2), true);

    assert.equal(reachedPlanLimit({ monthlyUsedPercent: 80, sessionUsedPercent: 99.6 }), null);
    assert.equal(reachedPlanLimit({ monthlyUsedPercent: 80, sessionUsedPercent: 100 }), "session");
    assert.equal(reachedPlanLimit({ monthlyUsedPercent: 100, sessionUsedPercent: 40 }), "monthly");
    assert.equal(reachedPlanLimit({ monthlyUsedPercent: 101, sessionUsedPercent: 102 }), "monthly");
    assert.equal(reachedPlanLimit(null), null);
  });

  it("resolves credit standing for every overage/suspend/wallet combination", () => {
    // Active + own wallet
    assert.equal(
      resolveCreditStanding({
        overageStatus: "OVERAGE_STATUS_ACTIVE",
        suspendState: "UNSUSPENDED",
        ownsWallet: true,
      }),
      "available",
    );
    assert.equal(
      resolveCreditStanding({
        overageStatus: "OVERAGE_STATUS_ACTIVE",
        suspendState: "CREDIT_DEPLETED",
        ownsWallet: true,
      }),
      "depleted",
    );

    // Non-credit suspensions stay unavailable
    for (const suspendState of [
      "FAILED_PAYMENTS",
      "MONTHLY_SPEND_LIMIT_EXCEEDED",
      "BLOCKED_BY_ABUSE_RULE",
      "OTHER_SUSPENSION",
    ]) {
      assert.equal(
        resolveCreditStanding({
          overageStatus: "OVERAGE_STATUS_ACTIVE",
          suspendState,
          ownsWallet: true,
        }),
        "unavailable",
        suspendState,
      );
    }

    // Org-billed wallet -> unavailable even if ACTIVE
    assert.equal(
      resolveCreditStanding({
        overageStatus: "OVERAGE_STATUS_ACTIVE",
        suspendState: "UNSUSPENDED",
        ownsWallet: false,
      }),
      "unavailable",
    );

    // Unreadable / partial account state -> unconfirmed
    assert.equal(
      resolveCreditStanding({
        overageStatus: "OVERAGE_STATUS_ACTIVE",
        suspendState: null,
        ownsWallet: true,
      }),
      "unconfirmed",
    );
    assert.equal(
      resolveCreditStanding({
        overageStatus: "OVERAGE_STATUS_ACTIVE",
        suspendState: "UNSUSPENDED",
        ownsWallet: null,
      }),
      "unconfirmed",
    );

    // Disabled / unspecified / missing overage status
    assert.equal(
      resolveCreditStanding({
        overageStatus: "OVERAGE_STATUS_DISABLED",
        suspendState: "UNSUSPENDED",
        ownsWallet: true,
      }),
      "unavailable",
    );
    assert.equal(
      resolveCreditStanding({
        overageStatus: "OVERAGE_STATUS_UNSPECIFIED",
        suspendState: "UNSUSPENDED",
        ownsWallet: true,
      }),
      "unconfirmed",
    );
    assert.equal(resolveCreditStanding({}), "unconfirmed");
  });

  it("returns compact indicators only when capped with confirmed own-wallet credit standing", () => {
    // Under cap -> silent
    assert.equal(
      resolveActiveCreditIndicator({
        monthlyUsedPercent: 50,
        sessionUsedPercent: 99.6,
        overageStatus: "OVERAGE_STATUS_ACTIVE",
        suspendState: "UNSUSPENDED",
        ownsWallet: true,
      }),
      null,
    );

    // 5h cap + ACTIVE + UNSUSPENDED -> using credits
    assert.deepEqual(
      resolveActiveCreditIndicator({
        monthlyUsedPercent: 45,
        sessionUsedPercent: 100,
        overageStatus: "OVERAGE_STATUS_ACTIVE",
        suspendState: "UNSUSPENDED",
        ownsWallet: true,
      }),
      { standing: "available", limit: "session", label: "using credits" },
    );

    // Monthly cap + ACTIVE + CREDIT_DEPLETED -> credits used up
    assert.deepEqual(
      resolveActiveCreditIndicator({
        monthlyUsedPercent: 101.5,
        sessionUsedPercent: 20,
        overageStatus: "OVERAGE_STATUS_ACTIVE",
        suspendState: "CREDIT_DEPLETED",
        ownsWallet: true,
      }),
      { standing: "depleted", limit: "monthly", label: "credits used up" },
    );

    // Non-credit suspension / org wallet / DISABLED / unconfirmed -> silent
    for (const snapshot of [
      { monthlyUsedPercent: 100, sessionUsedPercent: 0, overageStatus: "OVERAGE_STATUS_ACTIVE", suspendState: "FAILED_PAYMENTS", ownsWallet: true },
      { monthlyUsedPercent: 100, sessionUsedPercent: 0, overageStatus: "OVERAGE_STATUS_ACTIVE", suspendState: "UNSUSPENDED", ownsWallet: false },
      { monthlyUsedPercent: 100, sessionUsedPercent: 0, overageStatus: "OVERAGE_STATUS_DISABLED", suspendState: "UNSUSPENDED", ownsWallet: true },
      { monthlyUsedPercent: 100, sessionUsedPercent: 0, overageStatus: "OVERAGE_STATUS_UNSPECIFIED", suspendState: "UNSUSPENDED", ownsWallet: true },
      { monthlyUsedPercent: 100, sessionUsedPercent: 0, overageStatus: "OVERAGE_STATUS_ACTIVE", suspendState: null, ownsWallet: true },
    ]) {
      assert.equal(resolveActiveCreditIndicator(snapshot), null);
    }
  });

  it("formats CLI usage copy and JSON payload with billing URL on depletion", () => {
    assert.deepEqual(formatCreditStandingUsageLines(null), []);
    assert.equal(creditStandingJsonPayload(null), null);

    const active = { standing: "available", limit: "session", label: "using credits" };
    assert.deepEqual(formatCreditStandingUsageLines(active), [
      "Nexus plan: 5-hour plan limit reached — using credits.",
    ]);
    assert.deepEqual(creditStandingJsonPayload(active), {
      status: "available",
      limit: "session",
      label: "using credits",
    });

    const depleted = { standing: "depleted", limit: "monthly", label: "credits used up" };
    assert.deepEqual(formatCreditStandingUsageLines(depleted), [
      `Nexus plan: Monthly plan limit reached — credits used up. Add credits at ${NEXUS_BILLING_URL}`,
    ]);
    assert.deepEqual(creditStandingJsonPayload(depleted), {
      status: "depleted",
      limit: "monthly",
      label: "credits used up",
      billingUrl: NEXUS_BILLING_URL,
    });
  });

  it("parses user resource names, plan usage responses, and account responses safely", () => {
    assert.deepEqual(parseUserResourceName(EXAMPLE_USER), {
      accountId: "example-account",
      userId: "example-user",
    });
    assert.equal(parseUserResourceName("user@example.com"), null);
    assert.equal(parseUserResourceName("accounts/a/users/b/extra"), null);
    assert.equal(parseUserResourceName(""), null);

    assert.deepEqual(
      parsePlanUsageBody({
        monthly: { usedPercent: 100 },
        rollingWindow: null,
        overageStatus: "OVERAGE_STATUS_ACTIVE",
      }),
      { monthlyUsedPercent: 100, sessionUsedPercent: null, overageStatus: "OVERAGE_STATUS_ACTIVE" },
    );
    assert.equal(parsePlanUsageBody(null), null);
    assert.equal(parsePlanUsageBody([]), null);

    assert.deepEqual(parseAccountBody({ suspendState: "UNSUSPENDED", organization: "" }), {
      suspendState: "UNSUSPENDED",
      ownsWallet: true,
    });
    // REST responses may omit `organization`; own-wallet ownership is implied.
    assert.deepEqual(parseAccountBody({ suspendState: "CREDIT_DEPLETED" }), {
      suspendState: "CREDIT_DEPLETED",
      ownsWallet: true,
    });
    assert.deepEqual(
      parseAccountBody({ suspendState: "UNSUSPENDED", organization: "organizations/example-org" }),
      { suspendState: "UNSUSPENDED", ownsWallet: false },
    );
    assert.deepEqual(parseAccountBody({}), { suspendState: null, ownsWallet: true });
    assert.equal(parseAccountBody("invalid"), null);
  });
});

describe("credit standing cache, locking, and refresh", () => {
  it("writes 0600 cache with zero secrets or PII and enforces fingerprint and age bounds", async () => {
    await withTempHome("credit-cache-io", async (home) => {
      const fp = creditKeyFingerprint(EXAMPLE_KEY);
      assert.equal(readCreditStandingCache(home), null);
      assert.equal(readActiveCreditIndicator(home, { now: NOW }), null);

      const ok = writeCreditStandingCache(home, {
        fetchedAt: NOW,
        keyFingerprint: fp,
        status: "ok",
        monthlyUsedPercent: 30,
        sessionUsedPercent: 100,
        overageStatus: "OVERAGE_STATUS_ACTIVE",
        suspendState: "UNSUSPENDED",
        ownsWallet: true,
      });
      assert.equal(ok, true);

      const file = creditStandingCachePath(home, fp);
      if (process.platform !== "win32") {
        assert.equal(statSync(file).mode & 0o777, 0o600);
      }
      const raw = readFileSync(file, "utf8");
      assert.doesNotMatch(raw, new RegExp(EXAMPLE_KEY));
      assert.doesNotMatch(raw, /example-account|example-user|@/);

      assert.deepEqual(
        readActiveCreditIndicator(home, { expectedFingerprint: fp, now: NOW + 10_000 }),
        { standing: "available", limit: "session", label: "using credits" },
      );
      // Missing expectedFingerprint fails closed (never accepts previous account cache).
      assert.equal(readActiveCreditIndicator(home, { now: NOW + 10_000 }), null);
      assert.equal(
        isCreditStandingCacheFresh(readCreditStandingCache(home, { keyFingerprint: fp }), { expectedFingerprint: "", now: NOW + 10_000 }),
        false,
      );
      // Mismatched key fingerprint invalidates cached display.
      assert.equal(
        readActiveCreditIndicator(home, { expectedFingerprint: creditKeyFingerprint("fw_other_key_000"), now: NOW + 10_000 }),
        null,
      );
      // Past max display age (5m) -> silent fallback.
      assert.equal(
        readActiveCreditIndicator(home, { expectedFingerprint: fp, now: NOW + CREDIT_STANDING_MAX_AGE_MS + 1 }),
        null,
      );
      // Far-future timestamp (clock skew) -> ignored.
      assert.equal(
        readActiveCreditIndicator(home, { expectedFingerprint: fp, now: NOW - 120_000 }),
        null,
      );
      // Kill switch -> silent.
      assert.equal(
        readActiveCreditIndicator(home, { expectedFingerprint: fp, now: NOW, env: { NEXUS_CREDIT_STATUS: "0" } }),
        null,
      );

      // Corrupt JSON -> safe null.
      writeFileSync(file, "{bad json");
      assert.equal(readCreditStandingCache(home, { keyFingerprint: fp }), null);
      assert.equal(readActiveCreditIndicator(home, { expectedFingerprint: fp, now: NOW }), null);

      clearCreditStandingCache(home);
      assert.equal(existsSync(file), false);
    });
  });

  it("gates detached refresh by TTL, lock cooldown, stale lock takeover, and kill switches", async () => {
    await withTempHome("credit-lock-gating", async (home) => {
      const fp = creditKeyFingerprint(EXAMPLE_KEY);
      const liveEnv = {};
      // Lock mtime uses OS wall-clock time, so anchor this test to real Date.now().
      const now = Date.now();

      // Kill switches never touch disk.
      assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fp, now, env: { NEXUS_TEST: "1" } }), false);
      assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fp, now, env: { NEXUS_STATUSLINE_REFRESH: "0" } }), false);
      assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fp, now, env: { NEXUS_CREDIT_STATUS: "0" } }), false);
      assert.equal(existsSync(creditStandingLockPath(home, fp)), false);

      // Cold cache: first caller wins the lock, second concurrent caller does not.
      assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fp, now, env: liveEnv }), true);
      assert.equal(existsSync(creditStandingLockPath(home, fp)), true);
      assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fp, now: now + 1_000, env: liveEnv }), false);

      // Once lock ages past lockTtlMs, a stale lock is taken over cleanly.
      const staleTime = new Date(now - CREDIT_STANDING_LOCK_TTL_MS - 5_000);
      utimesSync(creditStandingLockPath(home, fp), staleTime, staleTime);
      assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fp, now, env: liveEnv }), true);

      // Fresh cache skips claiming altogether.
      releaseCreditStandingRefreshLock(home, { keyFingerprint: fp });
      writeCreditStandingCache(home, {
        fetchedAt: now,
        keyFingerprint: fp,
        status: "ok",
        monthlyUsedPercent: 50,
        sessionUsedPercent: 10,
        overageStatus: "OVERAGE_STATUS_ACTIVE",
        suspendState: "UNSUSPENDED",
        ownsWallet: true,
      });
      assert.equal(isCreditStandingCacheFresh(readCreditStandingCache(home, { keyFingerprint: fp }), { expectedFingerprint: fp, now: now + 30_000 }), true);
      assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fp, now: now + 30_000, env: liveEnv }), false);
      assert.equal(existsSync(creditStandingLockPath(home, fp)), false);

      // After 60s TTL elapses, refresh is claimed again.
      assert.equal(
        claimCreditStandingRefresh({ home, expectedFingerprint: fp, now: now + CREDIT_STANDING_TTL_MS, env: liveEnv }),
        true,
      );

      // "none" records use the longer 5m backoff.
      releaseCreditStandingRefreshLock(home, { keyFingerprint: fp });
      writeCreditStandingCache(home, { fetchedAt: now, keyFingerprint: fp, status: "none" });
      assert.equal(
        claimCreditStandingRefresh({ home, expectedFingerprint: fp, now: now + CREDIT_STANDING_TTL_MS + 1_000, env: liveEnv }),
        false,
      );
      assert.equal(
        claimCreditStandingRefresh({ home, expectedFingerprint: fp, now: now + CREDIT_STANDING_NO_PLAN_TTL_MS, env: liveEnv }),
        true,
      );
    });
  });

  it("spawns detached bin/claude-credit-refresh.mjs and releases the lock on spawn errors", async () => {
    await withTempHome("credit-spawn", async (home) => {
      const fp = creditKeyFingerprint(EXAMPLE_KEY);
      const spawns = [];
      const listeners = {};
      const child = {
        unrefCalled: false,
        unref() { this.unrefCalled = true; },
        on(event, fn) { listeners[event] = fn; return this; },
      };

      const got = maybeSpawnCreditStandingRefresh({
        home,
        expectedFingerprint: fp,
        now: NOW,
        env: {
          NEXUS_GATEWAY_URL: "https://evil.example.com",
          FIRECONNECT_GATEWAY_URL: "https://legacy-evil.example.com",
          ANTHROPIC_CUSTOM_HEADERS: `X-Fireworks-Api-Key: ${EXAMPLE_KEY}`,
        },
        spawnFn: (...args) => {
          spawns.push(args);
          return child;
        },
      });
      assert.equal(got, child);
      assert.equal(spawns.length, 1);
      const [cmd, argv, opts] = spawns[0];
      assert.equal(cmd, process.execPath);
      assert.ok(argv[0].endsWith("bin/claude-credit-refresh.mjs"), argv[0]);
      assert.equal(argv[1], "--lock-token");
      assert.equal(argv[2], readCreditStandingLockToken(home, { keyFingerprint: fp }));
      assert.equal(argv[3], "--lock-scope");
      assert.equal(argv[4], fp.slice(0, 16));
      assert.equal(opts.detached, true);
      assert.equal(opts.stdio, "ignore");
      assert.equal(opts.windowsHide, true);
      assert.equal(opts.env.HOME, home);
      assert.equal(opts.env.NEXUS_GATEWAY_URL, undefined);
      assert.equal(opts.env.FIRECONNECT_GATEWAY_URL, undefined);
      assert.equal(child.unrefCalled, true);
      assert.equal(existsSync(creditStandingLockPath(home, fp)), true);

      // Async spawn error releases the lock so a later turn can retry.
      listeners.error(new Error("ENOENT"));
      assert.equal(existsSync(creditStandingLockPath(home, fp)), false);

      // Synchronous throw also releases the unscoped bootstrap lock.
      const throwToken = createRefreshLockToken();
      assert.equal(
        claimCreditStandingRefresh({ home, now: NOW, env: {}, lockToken: throwToken }),
        true,
      );
      assert.equal(
        spawnCreditStandingRefresh({
          home,
          env: {},
          lockToken: throwToken,
          spawnFn: () => { throw new Error("EAGAIN"); },
        }),
        null,
      );
      assert.equal(existsSync(creditStandingLockPath(home)), false);
    });
  });

  it("polls plan usage and account standing endpoints concurrently and refreshes cache cleanly", async () => {
    const requests = [];
    let usageStatus = 200;
    let usageBody = {
      name: `${EXAMPLE_USER}/nexusPlanUsage`,
      monthly: { usedPercent: 100 },
      rollingWindow: { usedPercent: 45 },
      overageStatus: "OVERAGE_STATUS_ACTIVE",
    };
    let accountStatus = 200;
    let accountBody = {
      name: "accounts/example-account",
      suspendState: "UNSUSPENDED",
    };
    // Shared barrier proving both GETs arrive concurrently before either responds.
    let requireOverlap = true;
    let observedOverlap = false;
    const held = [];
    const flushHeld = () => {
      while (held.length) held.shift()();
    };
    const replyOrHold = (send) => {
      if (!requireOverlap) {
        send();
        return;
      }
      held.push(send);
      if (held.length >= 2) {
        observedOverlap = true;
        flushHeld();
      } else {
        // Safety release so a sequential regression fails the assertion instead of hanging.
        setTimeout(flushHeld, 250).unref?.();
      }
    };

    const gateway = await startMockGateway((req, res) => {
      requests.push({ url: req.url, auth: req.headers.authorization });
      if (req.url === `/v1/${EXAMPLE_USER}/nexusPlanUsage`) {
        replyOrHold(() => {
          res.writeHead(usageStatus, { "content-type": "application/json" });
          res.end(JSON.stringify(usageBody));
        });
        return;
      }
      if (req.url === "/v1/accounts/example-account") {
        replyOrHold(() => {
          res.writeHead(accountStatus, { "content-type": "application/json" });
          res.end(JSON.stringify(accountBody));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      await withTempHome("credit-http-refresh", async (home) => {
        await writeMintedKeyState(home, {
          keyId: "key-1",
          userName: EXAMPLE_USER,
          displayName: "nexus-cli-test",
          apiKey: EXAMPLE_KEY,
        });

        const direct = await fetchCreditStandingSnapshot({
          apiKey: EXAMPLE_KEY,
          userName: EXAMPLE_USER,
          gatewayUrl: gateway.url,
          timeoutMs: 2_000,
        });
        assert.equal(observedOverlap, true, "usage and account GETs must overlap in flight");
        requireOverlap = false;
        assert.deepEqual(direct, {
          outcome: "ok",
          snapshot: {
            monthlyUsedPercent: 100,
            sessionUsedPercent: 45,
            overageStatus: "OVERAGE_STATUS_ACTIVE",
            suspendState: "UNSUSPENDED",
            ownsWallet: true,
          },
        });
        assert.equal(requests.length, 2);
        assert.ok(requests.every((r) => r.auth === `Bearer ${EXAMPLE_KEY}`));

        // Full refresh uses minted-key.json userName directly (no /verifyApiKey) and populates cache.
        requests.length = 0;
        const record = await refreshCreditStandingCache({
          home,
          apiKey: EXAMPLE_KEY,
          gatewayUrl: gateway.url,
          now: NOW,
        });
        assert.equal(record?.status, "ok");
        assert.deepEqual(
          readActiveCreditIndicator(home, { expectedFingerprint: creditKeyFingerprint(EXAMPLE_KEY), now: NOW }),
          { standing: "available", limit: "monthly", label: "using credits" },
        );
        assert.equal(requests.some((r) => r.url === "/verifyApiKey"), false);

        // Transient 500 preserves prior good cache monotonically.
        usageStatus = 500;
        const failed = await refreshCreditStandingCache({
          home,
          apiKey: EXAMPLE_KEY,
          gatewayUrl: gateway.url,
          now: NOW + 70_000,
        });
        assert.equal(failed, null);
        assert.deepEqual(
          readActiveCreditIndicator(home, { expectedFingerprint: creditKeyFingerprint(EXAMPLE_KEY), now: NOW + 70_000 }),
          { standing: "available", limit: "monthly", label: "using credits" },
        );

        // Definite 400 (no active Nexus Plan) writes "none" and clears prior indicator.
        usageStatus = 400;
        usageBody = { message: "no active plan" };
        const noPlan = await refreshCreditStandingCache({
          home,
          apiKey: EXAMPLE_KEY,
          gatewayUrl: gateway.url,
          now: NOW + 80_000,
        });
        assert.equal(noPlan?.status, "none");
        assert.equal(
          readActiveCreditIndicator(home, { expectedFingerprint: creditKeyFingerprint(EXAMPLE_KEY), now: NOW + 80_000 }),
          null,
        );

        // Credit depleted state updates cache to depleted.
        usageStatus = 200;
        usageBody = {
          name: `${EXAMPLE_USER}/nexusPlanUsage`,
          monthly: { usedPercent: 50 },
          rollingWindow: { usedPercent: 100 },
          overageStatus: "OVERAGE_STATUS_ACTIVE",
        };
        accountStatus = 200;
        accountBody = { name: "accounts/example-account", suspendState: "CREDIT_DEPLETED", organization: "" };
        await refreshCreditStandingCache({
          home,
          apiKey: EXAMPLE_KEY,
          gatewayUrl: gateway.url,
          now: NOW + 90_000,
        });
        assert.deepEqual(
          readActiveCreditIndicator(home, { expectedFingerprint: creditKeyFingerprint(EXAMPLE_KEY), now: NOW + 90_000 }),
          { standing: "depleted", limit: "session", label: "credits used up" },
        );

        // 403 on account standing endpoint leaves standing unconfirmed (never shows false credit label).
        accountStatus = 403;
        await refreshCreditStandingCache({
          home,
          apiKey: EXAMPLE_KEY,
          gatewayUrl: gateway.url,
          now: NOW + 100_000,
        });
        assert.equal(
          readActiveCreditIndicator(home, { expectedFingerprint: creditKeyFingerprint(EXAMPLE_KEY), now: NOW + 100_000 }),
          null,
        );
      });
    } finally {
      await gateway.close();
    }
  });

  it("falls back to key verification and user lookup when no minted-key.json record exists", async () => {
    const seen = [];
    const gateway = await startMockGateway((req, res) => {
      seen.push(req.url);
      if (req.url === "/verifyApiKey") {
        res.writeHead(200, {
          "x-fireworks-account-id": "example-account",
          "x-fireworks-developer-email": "user@example.com",
        });
        res.end();
        return;
      }
      if (req.url?.startsWith("/v1/accounts/example-account/users?")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ users: [{ name: EXAMPLE_USER }] }));
        return;
      }
      if (req.url === `/v1/${EXAMPLE_USER}/nexusPlanUsage`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          monthly: { usedPercent: 25 },
          rollingWindow: { usedPercent: 100 },
          overageStatus: "OVERAGE_STATUS_ACTIVE",
        }));
        return;
      }
      if (req.url === "/v1/accounts/example-account") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          name: "accounts/example-account",
          suspendState: "UNSUSPENDED",
          organization: "",
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      await withTempHome("credit-fallback-user", async (home) => {
        const record = await refreshCreditStandingCache({
          home,
          apiKey: EXAMPLE_KEY,
          gatewayUrl: gateway.url,
          now: NOW,
        });
        assert.equal(record?.status, "ok");
        assert.equal(seen[0], "/verifyApiKey");
        assert.ok(seen.some((u) => u.startsWith("/v1/accounts/example-account/users?")));
        assert.deepEqual(
          readActiveCreditIndicator(home, { expectedFingerprint: creditKeyFingerprint(EXAMPLE_KEY), now: NOW }),
          { standing: "available", limit: "session", label: "using credits" },
        );
      });
    } finally {
      await gateway.close();
    }
  });

  it("executes bin/claude-credit-refresh.mjs silently and populates the cache via gateway header key", async () => {
    const gateway = await startMockGateway((req, res) => {
      if (req.url === `/v1/${EXAMPLE_USER}/nexusPlanUsage`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          monthly: { usedPercent: 100 },
          rollingWindow: { usedPercent: 80 },
          overageStatus: "OVERAGE_STATUS_ACTIVE",
        }));
        return;
      }
      if (req.url === "/v1/accounts/example-account") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          name: "accounts/example-account",
          suspendState: "CREDIT_DEPLETED",
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const runnerScript = fileURLToPath(new URL("../../bin/claude-credit-refresh.mjs", import.meta.url));
    try {
      await withTempHome("credit-runner-bin", async (home) => {
        await writeMintedKeyState(home, {
          keyId: "key-1",
          userName: EXAMPLE_USER,
          displayName: "nexus-cli-test",
          apiKey: EXAMPLE_KEY,
        });

        // Under NEXUS_TEST=1 without explicit runner opt-in, runner exits early with zero gateway calls.
        let testModeRequests = 0;
        const quietGateway = await startMockGateway((_req, res) => {
          testModeRequests += 1;
          res.writeHead(200);
          res.end("{}");
        });
        try {
          const testModeOut = await execFileAsync(process.execPath, [runnerScript], {
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: home,
              ANTHROPIC_API_KEY: "",
              ANTHROPIC_AUTH_TOKEN: "",
              NEXUS_TEST: "1",
              NEXUS_CREDIT_REFRESH_IN_TEST: "",
              NEXUS_CREDIT_STATUS: "1",
              NEXUS_GATEWAY_URL: quietGateway.url,
              FIRECONNECT_GATEWAY_URL: "",
              ANTHROPIC_CUSTOM_HEADERS: `X-Fireworks-Api-Key: ${EXAMPLE_KEY}`,
            },
          });
          assert.equal(testModeOut.stdout, "");
          assert.equal(testModeOut.stderr, "");
          assert.equal(testModeRequests, 0);
        } finally {
          await quietGateway.close();
        }

        const fp = creditKeyFingerprint(EXAMPLE_KEY);
        const scopedToken = createRefreshLockToken();
        assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fp, env: {}, lockToken: scopedToken }), true);
        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [runnerScript, "--lock-token", scopedToken, "--lock-scope", fp.slice(0, 16)],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: home,
              ANTHROPIC_API_KEY: "",
              ANTHROPIC_AUTH_TOKEN: "",
              NEXUS_CREDIT_STATUS: "1",
              NEXUS_CREDIT_REFRESH_IN_TEST: "1",
              NEXUS_GATEWAY_URL: gateway.url,
              FIRECONNECT_GATEWAY_URL: "",
              ANTHROPIC_CUSTOM_HEADERS: `X-Fireworks-Api-Key: ${EXAMPLE_KEY}`,
            },
          },
        );
        assert.equal(stdout, "");
        assert.equal(stderr, "");
        assert.equal(existsSync(creditStandingLockPath(home, fp)), false);
        assert.deepEqual(
          readActiveCreditIndicator(home, { expectedFingerprint: fp }),
          { standing: "depleted", limit: "monthly", label: "credits used up" },
        );

        // Bootstrap unscoped lock (first refresh before stored-key-fingerprint exists)
        // must also verify ownership, write the scoped cache, and release the unscoped lock.
        clearCreditStandingCache(home);
        const unscopedToken = createRefreshLockToken();
        assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: "", env: {}, lockToken: unscopedToken }), true);
        assert.equal(existsSync(creditStandingLockPath(home)), true);
        await execFileAsync(
          process.execPath,
          [runnerScript, "--lock-token", unscopedToken, "--lock-unscoped"],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: home,
              ANTHROPIC_API_KEY: "",
              ANTHROPIC_AUTH_TOKEN: "",
              NEXUS_CREDIT_STATUS: "1",
              NEXUS_CREDIT_REFRESH_IN_TEST: "1",
              NEXUS_GATEWAY_URL: gateway.url,
              FIRECONNECT_GATEWAY_URL: "",
              ANTHROPIC_CUSTOM_HEADERS: `X-Fireworks-Api-Key: ${EXAMPLE_KEY}`,
            },
          },
        );
        assert.equal(existsSync(creditStandingLockPath(home)), false);
        assert.deepEqual(
          readActiveCreditIndicator(home, { expectedFingerprint: fp }),
          { standing: "depleted", limit: "monthly", label: "credits used up" },
        );
      });
    } finally {
      await gateway.close();
    }
  });

  it("loadCreditStanding serves fresh cache offline, fails closed without active key, and degrades gracefully on unreachable network", async () => {
    await withTempHome("credit-loader-offline", async (home) => {
      const fp = creditKeyFingerprint(EXAMPLE_KEY);
      // Cold cache + failing fetch -> null, never throws.
      const cold = await loadCreditStanding({
        home,
        apiKey: EXAMPLE_KEY,
        userName: EXAMPLE_USER,
        allowNetworkInTest: true,
        timeoutMs: 200,
        fetchFn: async () => { throw new Error("ENETUNREACH"); },
      });
      assert.equal(cold, null);

      // Seeded fresh cache -> returned without calling fetchFn.
      let fetched = 0;
      writeCreditStandingCache(home, {
        fetchedAt: NOW,
        keyFingerprint: fp,
        status: "ok",
        monthlyUsedPercent: 100,
        sessionUsedPercent: 20,
        overageStatus: "OVERAGE_STATUS_ACTIVE",
        suspendState: "UNSUSPENDED",
        ownsWallet: true,
      });
      // Signed-out / no active key -> fails closed even when a browser mint record exists on disk.
      await writeMintedKeyState(home, {
        keyId: "key-1",
        userName: EXAMPLE_USER,
        displayName: "nexus-cli-test",
        apiKey: EXAMPLE_KEY,
      });
      assert.equal(await loadCreditStanding({ home, apiKey: "", now: NOW + 10_000 }), null);

      // Foreground loadCreditStanding ignores untrusted NEXUS_GATEWAY_URL / FIRECONNECT_GATEWAY_URL
      // env overrides and pins requests to the production Fireworks gateway.
      const seenUrls = [];
      const pinned = await loadCreditStanding({
        home,
        apiKey: EXAMPLE_KEY,
        userName: EXAMPLE_USER,
        now: NOW + 90_000,
        env: {
          NEXUS_GATEWAY_URL: "https://evil.example.com",
          FIRECONNECT_GATEWAY_URL: "https://legacy-evil.example.com",
        },
        allowNetworkInTest: true,
        fetchFn: async (url) => {
          seenUrls.push(String(url));
          if (String(url).includes("/nexusPlanUsage")) {
            return new Response(JSON.stringify({
              monthly: { usedPercent: 100 },
              rollingWindow: { usedPercent: 20 },
              overageStatus: "OVERAGE_STATUS_ACTIVE",
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ suspendState: "UNSUSPENDED" }), { status: 200 });
        },
      });
      assert.deepEqual(pinned, { standing: "available", limit: "monthly", label: "using credits" });
      assert.ok(seenUrls.length >= 2);
      assert.ok(seenUrls.every((u) => u.startsWith(`${CREDIT_STANDING_DEFAULT_GATEWAY_URL}/`)), seenUrls.join(", "));

      // Reset cache timestamp so the cached + stale fallback checks below remain deterministic.
      writeCreditStandingCache(home, {
        fetchedAt: NOW,
        keyFingerprint: fp,
        status: "ok",
        monthlyUsedPercent: 100,
        sessionUsedPercent: 20,
        overageStatus: "OVERAGE_STATUS_ACTIVE",
        suspendState: "UNSUSPENDED",
        ownsWallet: true,
      });

      const cached = await loadCreditStanding({
        home,
        apiKey: EXAMPLE_KEY,
        userName: EXAMPLE_USER,
        now: NOW + 10_000,
        allowNetworkInTest: true,
        fetchFn: async () => {
          fetched += 1;
          throw new Error("should not be called");
        },
      });
      assert.deepEqual(cached, { standing: "available", limit: "monthly", label: "using credits" });
      assert.equal(fetched, 0);

      // Stale (90s) cache + offline network -> falls back to still-valid (<5m) cache.
      const fallback = await loadCreditStanding({
        home,
        apiKey: EXAMPLE_KEY,
        userName: EXAMPLE_USER,
        now: NOW + 90_000,
        allowNetworkInTest: true,
        timeoutMs: 200,
        fetchFn: async () => {
          fetched += 1;
          throw new Error("ECONNREFUSED");
        },
      });
      assert.equal(fetched > 0, true);
      assert.deepEqual(fallback, { standing: "available", limit: "monthly", label: "using credits" });
    });
  });

  it("refuses plaintext remote HTTP gateway overrides and oversized gateway responses", async () => {
    let fetchCalls = 0;
    const remoteHttp = await fetchCreditStandingSnapshot({
      apiKey: EXAMPLE_KEY,
      userName: EXAMPLE_USER,
      gatewayUrl: "http://example.com",
      fetchFn: async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      },
    });
    assert.deepEqual(remoteHttp, { outcome: "error" });
    assert.equal(fetchCalls, 0);

    const envRemoteHttp = await fetchCreditStandingSnapshot({
      apiKey: EXAMPLE_KEY,
      userName: EXAMPLE_USER,
      env: { NEXUS_GATEWAY_URL: "http://example.com" },
      fetchFn: async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      },
    });
    assert.deepEqual(envRemoteHttp, { outcome: "error" });
    assert.equal(fetchCalls, 0);

    // Oversized responses (both chunked and declared content-length) return error and preserve prior cache.
    const bigPadding = "x".repeat(MAX_CREDIT_RESPONSE_BYTES + 4096);
    const bigPayload = `{"monthly":{"usedPercent":100},"overageStatus":"OVERAGE_STATUS_ACTIVE","pad":"${bigPadding}"}`;
    let oversizedMode = "chunked";
    const oversizedGateway = await startMockGateway((req, res) => {
      if (req.url === `/v1/${EXAMPLE_USER}/nexusPlanUsage`) {
        if (oversizedMode === "content-length") {
          res.writeHead(200, {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(bigPayload, "utf8")),
          });
          res.end(bigPayload);
          return;
        }
        // Chunked response without content-length header exceeding MAX_CREDIT_RESPONSE_BYTES.
        res.writeHead(200, { "content-type": "application/json" });
        res.write(`{"monthly":{"usedPercent":100},"overageStatus":"OVERAGE_STATUS_ACTIVE","pad":"`);
        res.write(bigPadding);
        res.end(`"}`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ suspendState: "UNSUSPENDED" }));
    });
    try {
      await withTempHome("credit-oversized", async (home) => {
        const fp = creditKeyFingerprint(EXAMPLE_KEY);
        writeCreditStandingCache(home, {
          fetchedAt: NOW,
          keyFingerprint: fp,
          status: "ok",
          monthlyUsedPercent: 100,
          sessionUsedPercent: 0,
          overageStatus: "OVERAGE_STATUS_ACTIVE",
          suspendState: "UNSUSPENDED",
          ownsWallet: true,
        });
        for (const mode of ["chunked", "content-length"]) {
          oversizedMode = mode;
          const res = await refreshCreditStandingCache({
            home,
            apiKey: EXAMPLE_KEY,
            userName: EXAMPLE_USER,
            gatewayUrl: oversizedGateway.url,
            now: NOW + 70_000,
          });
          assert.equal(res, null, `expected null for oversized mode=${mode}`);
          assert.deepEqual(
            readActiveCreditIndicator(home, { expectedFingerprint: fp, now: NOW + 70_000 }),
            { standing: "available", limit: "monthly", label: "using credits" },
            `expected prior cache preserved for oversized mode=${mode}`,
          );
        }
      });
    } finally {
      await oversizedGateway.close();
    }
  });

  it("treats HTTP 408, HTTP 429, and malformed user lookup responses as transient errors preserving cache", async () => {
    let mode = "408-usage";
    const gateway = await startMockGateway((req, res) => {
      if (req.url === "/verifyApiKey") {
        if (mode === "408-verify" || mode === "429-verify") {
          res.writeHead(mode === "429-verify" ? 429 : 408);
          res.end();
          return;
        }
        res.writeHead(200, {
          "x-fireworks-account-id": "example-account",
          "x-fireworks-developer-email": "user@example.com",
        });
        res.end();
        return;
      }
      if (req.url?.startsWith("/v1/accounts/example-account/users?")) {
        if (mode === "bad-users-json") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{truncated");
          return;
        }
        if (mode === "empty-users") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ users: [] }));
          return;
        }
      }
      if (req.url === `/v1/${EXAMPLE_USER}/nexusPlanUsage`) {
        res.writeHead(mode === "429-usage" ? 429 : 408);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ suspendState: "UNSUSPENDED" }));
    });
    try {
      await withTempHome("credit-transient-408-429", async (home) => {
        const fp = creditKeyFingerprint(EXAMPLE_KEY);
        writeCreditStandingCache(home, {
          fetchedAt: NOW,
          keyFingerprint: fp,
          status: "ok",
          monthlyUsedPercent: 100,
          sessionUsedPercent: 0,
          overageStatus: "OVERAGE_STATUS_ACTIVE",
          suspendState: "UNSUSPENDED",
          ownsWallet: true,
        });

        // 408 and 429 on plan usage endpoint preserve cache without writing "none".
        for (const usageMode of ["408-usage", "429-usage"]) {
          mode = usageMode;
          assert.equal(
            await refreshCreditStandingCache({ home, apiKey: EXAMPLE_KEY, userName: EXAMPLE_USER, gatewayUrl: gateway.url, now: NOW + 70_000 }),
            null,
          );
          assert.deepEqual(
            readActiveCreditIndicator(home, { expectedFingerprint: fp, now: NOW + 70_000 }),
            { standing: "available", limit: "monthly", label: "using credits" },
            `prior cache must remain intact on ${usageMode}`,
          );
        }

        // 408 and 429 on key verification preserve cache without writing "none".
        for (const verifyMode of ["408-verify", "429-verify"]) {
          mode = verifyMode;
          assert.equal(
            await refreshCreditStandingCache({ home, apiKey: EXAMPLE_KEY, gatewayUrl: gateway.url, now: NOW + 75_000 }),
            null,
          );
          assert.deepEqual(
            readActiveCreditIndicator(home, { expectedFingerprint: fp, now: NOW + 75_000 }),
            { standing: "available", limit: "monthly", label: "using credits" },
            `prior cache must remain intact on ${verifyMode}`,
          );
        }

        // Unreadable user lookup JSON preserves cache instead of writing "none".
        mode = "bad-users-json";
        assert.equal(
          await refreshCreditStandingCache({ home, apiKey: EXAMPLE_KEY, gatewayUrl: gateway.url, now: NOW + 80_000 }),
          null,
        );
        assert.deepEqual(
          readActiveCreditIndicator(home, { expectedFingerprint: fp, now: NOW + 80_000 }),
          { standing: "available", limit: "monthly", label: "using credits" },
        );

        // Valid empty user list writes "none".
        mode = "empty-users";
        const empty = await refreshCreditStandingCache({ home, apiKey: EXAMPLE_KEY, gatewayUrl: gateway.url, now: NOW + 85_000 });
        assert.equal(empty?.status, "none");
        assert.equal(readActiveCreditIndicator(home, { expectedFingerprint: fp, now: NOW + 85_000 }), null);
      });
    } finally {
      await gateway.close();
    }
  });

  it("enforces lock ownership across stale takeovers, claude off cleanup, foreground refreshes, and failed cache writes", async () => {
    await withTempHome("credit-lock-ownership", async (home) => {
      const fp = creditKeyFingerprint(EXAMPLE_KEY);
      const now = Date.now();

      // 1. Stale takeover: A's delayed error event must NOT delete B's fresh lock.
      const listenersA = {};
      const childA = { unref() {}, on(ev, fn) { listenersA[ev] = fn; return this; } };
      maybeSpawnCreditStandingRefresh({
        home,
        expectedFingerprint: fp,
        now,
        env: {},
        spawnFn: () => childA,
      });
      const tokenA = readCreditStandingLockToken(home, { keyFingerprint: fp });
      assert.ok(tokenA);
      const stale = new Date(now - CREDIT_STANDING_LOCK_TTL_MS - 5_000);
      utimesSync(creditStandingLockPath(home, fp), stale, stale);

      const childB = { unref() {}, on() { return this; } };
      maybeSpawnCreditStandingRefresh({
        home,
        expectedFingerprint: fp,
        now,
        env: {},
        spawnFn: () => childB,
      });
      const tokenB = readCreditStandingLockToken(home, { keyFingerprint: fp });
      assert.ok(tokenB && tokenB !== tokenA);

      listenersA.error(new Error("late failure"));
      assert.equal(ownsCreditStandingRefreshLock(home, tokenB, { keyFingerprint: fp }), true);

      // 2. Late refresh after clearCreditStandingCache (claude off) must NOT recreate cache.
      clearCreditStandingCache(home);
      const lateOk = await refreshCreditStandingCache({
        home,
        apiKey: EXAMPLE_KEY,
        userName: EXAMPLE_USER,
        lockToken: tokenB,
        now,
        fetchFn: async (url) => {
          if (String(url).includes("/nexusPlanUsage")) {
            return new Response(JSON.stringify({ monthly: { usedPercent: 100 }, overageStatus: "OVERAGE_STATUS_ACTIVE" }), { status: 200 });
          }
          return new Response(JSON.stringify({ suspendState: "UNSUSPENDED" }), { status: 200 });
        },
      });
      assert.equal(lateOk, null);
      assert.equal(readCreditStandingCache(home, { keyFingerprint: fp }), null);

      // Same for the "none" branch.
      const lateNone = await refreshCreditStandingCache({
        home,
        apiKey: EXAMPLE_KEY,
        userName: EXAMPLE_USER,
        lockToken: tokenB,
        now,
        fetchFn: async () => new Response("{}", { status: 400 }),
      });
      assert.equal(lateNone, null);
      assert.equal(readCreditStandingCache(home, { keyFingerprint: fp }), null);

      // 3. Foreground loadCreditStanding takes ownership so a slower detached worker cannot overwrite it.
      const workerToken = createRefreshLockToken();
      assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fp, now, env: {}, lockToken: workerToken }), true);
      let releaseWorker;
      const workerStarted = new Promise((r) => { releaseWorker = r; });
      let resolveWorkerFetch;
      const workerFetchPromise = new Promise((r) => { resolveWorkerFetch = r; });
      const workerPromise = refreshCreditStandingCache({
        home,
        apiKey: EXAMPLE_KEY,
        userName: EXAMPLE_USER,
        lockToken: workerToken,
        now: now - 1_000,
        fetchFn: async (url) => {
          releaseWorker();
          await workerFetchPromise;
          if (String(url).includes("/nexusPlanUsage")) {
            return new Response(JSON.stringify({ monthly: { usedPercent: 100 }, overageStatus: "OVERAGE_STATUS_ACTIVE" }), { status: 200 });
          }
          return new Response(JSON.stringify({ suspendState: "UNSUSPENDED" }), { status: 200 });
        },
      });
      await workerStarted;

      const fgIndicator = await loadCreditStanding({
        home,
        apiKey: EXAMPLE_KEY,
        userName: EXAMPLE_USER,
        now,
        allowNetworkInTest: true,
        fetchFn: async (url) => {
          if (String(url).includes("/nexusPlanUsage")) {
            return new Response(JSON.stringify({ monthly: { usedPercent: 100 }, overageStatus: "OVERAGE_STATUS_ACTIVE" }), { status: 200 });
          }
          return new Response(JSON.stringify({ suspendState: "CREDIT_DEPLETED" }), { status: 200 });
        },
      });
      assert.deepEqual(fgIndicator, { standing: "depleted", limit: "monthly", label: "credits used up" });

      resolveWorkerFetch();
      const workerResult = await workerPromise;
      assert.equal(workerResult, null);
      assert.deepEqual(
        readActiveCreditIndicator(home, { expectedFingerprint: fp, now }),
        { standing: "depleted", limit: "monthly", label: "credits used up" },
      );

      // 4. Failed cache write retains the lock cooldown so immediate re-claim returns false.
      clearCreditStandingCache(home);
      const failToken = createRefreshLockToken();
      assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fp, now, env: {}, lockToken: failToken }), true);
      await refreshCreditStandingCache({
        home,
        apiKey: EXAMPLE_KEY,
        userName: EXAMPLE_USER,
        lockToken: failToken,
        now,
        writeCacheFn: () => false,
        fetchFn: async (url) => {
          if (String(url).includes("/nexusPlanUsage")) {
            return new Response(JSON.stringify({ monthly: { usedPercent: 100 }, overageStatus: "OVERAGE_STATUS_ACTIVE" }), { status: 200 });
          }
          return new Response(JSON.stringify({ suspendState: "UNSUSPENDED" }), { status: 200 });
        },
      });
      assert.equal(ownsCreditStandingRefreshLock(home, failToken, { keyFingerprint: fp }), true);
      assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fp, now: now + 1_000, env: {} }), false);
    });
  });

  it("ignores named pipes at the cache or lock path without blocking", async () => {
    if (process.platform === "win32") return;
    await withTempHome("credit-fifo-safe", async (home) => {
      const fp = creditKeyFingerprint(EXAMPLE_KEY);
      const cacheFile = creditStandingCachePath(home, fp);
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      const mk = spawnSync("mkfifo", [cacheFile]);
      if (mk.status !== 0) return;
      assert.equal(readCreditStandingCache(home, { keyFingerprint: fp }), null);
      assert.equal(readActiveCreditIndicator(home, { expectedFingerprint: fp }), null);

      const lockFile = creditStandingLockPath(home, fp);
      const mkLock = spawnSync("mkfifo", [lockFile]);
      if (mkLock.status !== 0) return;
      assert.equal(readCreditStandingLockToken(home, { keyFingerprint: fp }), "");
      assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fp, env: {} }), false);
    });
  });

  it("ignores legacy fingerprintless minted-key.json and resolves the active key via /verifyApiKey", async () => {
    const newKey = "fw_example_new_account_key_00000";
    const seen = [];
    const gateway = await startMockGateway((req, res) => {
      seen.push(req.url);
      if (req.url === "/verifyApiKey") {
        res.writeHead(200, {
          "x-fireworks-account-id": "new-account",
          "x-fireworks-developer-email": "new@example.com",
        });
        res.end();
        return;
      }
      if (req.url?.startsWith("/v1/accounts/new-account/users?")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ users: [{ name: "accounts/new-account/users/new-user" }] }));
        return;
      }
      if (req.url === "/v1/accounts/new-account/users/new-user/nexusPlanUsage") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          monthly: { usedPercent: 100 },
          rollingWindow: { usedPercent: 10 },
          overageStatus: "OVERAGE_STATUS_ACTIVE",
        }));
        return;
      }
      if (req.url === "/v1/accounts/new-account") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "accounts/new-account", suspendState: "CREDIT_DEPLETED" }));
        return;
      }
      res.writeHead(403);
      res.end();
    });

    try {
      await withTempHome("credit-legacy-minted", async (home) => {
        // Legacy minted-key.json written before keyFingerprint existed, pointing to an old account.
        const mintedPath = mintedKeyStatePath(home);
        mkdirSync(path.dirname(mintedPath), { recursive: true });
        writeFileSync(mintedPath, JSON.stringify({
          keyId: "old-key",
          userName: "accounts/old-account/users/old-user",
          displayName: "old-cli-key",
        }));

        const record = await refreshCreditStandingCache({
          home,
          apiKey: newKey,
          gatewayUrl: gateway.url,
          now: NOW,
        });
        assert.equal(record?.status, "ok");
        assert.equal(seen.includes("/verifyApiKey"), true, "must verify active key instead of trusting fingerprintless record");
        assert.equal(seen.some((u) => u.includes("old-account")), false, "must never query the old account");
        assert.deepEqual(
          readActiveCreditIndicator(home, { expectedFingerprint: creditKeyFingerprint(newKey), now: NOW }),
          { standing: "depleted", limit: "monthly", label: "credits used up" },
        );
      });
    } finally {
      await gateway.close();
    }
  });

  it("respects the 60s refresh lock cooldown when loadCreditStanding sets respectCooldown", async () => {
    await withTempHome("credit-respect-cooldown", async (home) => {
      const start = Date.now();
      let fetchCalls = 0;
      const failFetch = async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 500 });
      };

      // First attempt hits gateway, fails, and leaves the refresh cooldown lock on disk.
      assert.equal(
        await loadCreditStanding({
          home,
          apiKey: EXAMPLE_KEY,
          userName: EXAMPLE_USER,
          now: start,
          allowNetworkInTest: true,
          respectCooldown: true,
          fetchFn: failFetch,
        }),
        null,
      );
      assert.equal(fetchCalls, 2);
      assert.equal(hasActiveCreditStandingRefreshLock(home, { keyFingerprint: creditKeyFingerprint(EXAMPLE_KEY), now: start + 2_000 }), true);

      // Subsequent poll within 60s sees active lock and skips the gateway.
      assert.equal(
        await loadCreditStanding({
          home,
          apiKey: EXAMPLE_KEY,
          userName: EXAMPLE_USER,
          now: start + 2_000,
          allowNetworkInTest: true,
          respectCooldown: true,
          fetchFn: failFetch,
        }),
        null,
      );
      assert.equal(fetchCalls, 2);

      // Once 60s cooldown elapses, the next poll retries.
      assert.equal(
        await loadCreditStanding({
          home,
          apiKey: EXAMPLE_KEY,
          userName: EXAMPLE_USER,
          now: start + CREDIT_STANDING_LOCK_TTL_MS + 1_000,
          allowNetworkInTest: true,
          respectCooldown: true,
          fetchFn: failFetch,
        }),
        null,
      );
      assert.equal(fetchCalls, 4);
    });
  });

  it("shares Claude gateway-key header-first precedence via claudeFireworksKeyFrom", () => {
    // X-Fireworks-Api-Key custom header wins over stale ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN.
    assert.equal(
      claudeFireworksKeyFrom({
        env: {
          ANTHROPIC_API_KEY: "fw_direct_key_1",
          ANTHROPIC_AUTH_TOKEN: "fw_auth_key_2",
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_header_key_3",
        },
      }),
      "fw_header_key_3",
    );
    assert.equal(
      claudeFireworksKeyFrom({
        env: {
          ANTHROPIC_API_KEY: "fw_direct_key_1",
          ANTHROPIC_AUTH_TOKEN: "fw_auth_key_2",
        },
      }),
      "fw_direct_key_1",
    );
    assert.equal(
      claudeFireworksKeyFrom({
        env: {
          ANTHROPIC_API_KEY: "sk-ant-not-fireworks",
          ANTHROPIC_AUTH_TOKEN: "fw_auth_key_2",
          ANTHROPIC_CUSTOM_HEADERS: "x-other: foo",
        },
      }),
      "fw_auth_key_2",
    );
    assert.equal(
      claudeFireworksKeyFrom({
        env: {
          ANTHROPIC_CUSTOM_HEADERS: "x-other: foo\nx-fireworks-api-key: fw_header_key_3",
        },
      }),
      "fw_header_key_3",
    );
  });

  it("isolates credit caches and refresh locks per key fingerprint across alternating sessions", async () => {
    await withTempHome("credit-alternating-keys", async (home) => {
      const keyA = "fw_session_alpha_key_00000000000";
      const keyB = "fw_session_beta_key_000000000000";
      const fpA = creditKeyFingerprint(keyA);
      const fpB = creditKeyFingerprint(keyB);
      const now = Date.now();
      let fetchesA = 0;
      let fetchesB = 0;

      const makeFetch = (which) => async (url) => {
        if (which === "A") fetchesA += 1;
        else fetchesB += 1;
        if (String(url).includes("/nexusPlanUsage")) {
          return new Response(JSON.stringify({
            monthly: { usedPercent: 100 },
            rollingWindow: { usedPercent: 0 },
            overageStatus: "OVERAGE_STATUS_ACTIVE",
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          suspendState: which === "A" ? "UNSUSPENDED" : "CREDIT_DEPLETED",
        }), { status: 200 });
      };

      // Session A claims and refreshes its own scoped cache + lock.
      const tokA = createRefreshLockToken();
      assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fpA, now, env: {}, lockToken: tokA }), true);
      // Session B can claim concurrently without colliding with A's lock.
      const tokB = createRefreshLockToken();
      assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fpB, now, env: {}, lockToken: tokB }), true);

      await refreshCreditStandingCache({
        home,
        apiKey: keyA,
        userName: EXAMPLE_USER,
        lockToken: tokA,
        now,
        fetchFn: makeFetch("A"),
      });
      await refreshCreditStandingCache({
        home,
        apiKey: keyB,
        userName: EXAMPLE_USER,
        lockToken: tokB,
        now,
        fetchFn: makeFetch("B"),
      });

      // Alternating turns between A and B both stay cached & fresh without evicting or re-fetching.
      assert.deepEqual(
        readActiveCreditIndicator(home, { expectedFingerprint: fpA, now: now + 5_000 }),
        { standing: "available", limit: "monthly", label: "using credits" },
      );
      assert.deepEqual(
        readActiveCreditIndicator(home, { expectedFingerprint: fpB, now: now + 6_000 }),
        { standing: "depleted", limit: "monthly", label: "credits used up" },
      );
      assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fpA, now: now + 7_000, env: {} }), false);
      assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fpB, now: now + 8_000, env: {} }), false);
      assert.equal(fetchesA, 2);
      assert.equal(fetchesB, 2);

      // clearCreditStandingCache removes all scoped cache files cleanly.
      clearCreditStandingCache(home);
      assert.equal(readCreditStandingCache(home, { keyFingerprint: fpA }), null);
      assert.equal(readCreditStandingCache(home, { keyFingerprint: fpB }), null);
      assert.equal(existsSync(creditStandingCachePath(home, fpA)), false);
      assert.equal(existsSync(creditStandingCachePath(home, fpB)), false);
    });
  });

  it("writes sanitized 0600 last-attempt diagnostics on 403/500/shape-drift and clears them on recovery or logout", async () => {
    let usageStatus = 200;
    let usageBody = {
      name: `${EXAMPLE_USER}/nexusPlanUsage`,
      monthly: { usedPercent: 100 },
      rollingWindow: { usedPercent: 40 },
      overageStatus: "OVERAGE_STATUS_ACTIVE",
    };
    let accountStatus = 403;
    let accountBody = { message: `permission denied for ${EXAMPLE_USER} user@example.com` };
    const gateway = await startMockGateway((req, res) => {
      if (req.url === `/v1/${EXAMPLE_USER}/nexusPlanUsage`) {
        res.writeHead(usageStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(usageBody));
        return;
      }
      if (req.url === "/v1/accounts/example-account") {
        res.writeHead(accountStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(accountBody));
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "internal error" }));
    });
    const runnerScript = fileURLToPath(new URL("../../bin/claude-credit-refresh.mjs", import.meta.url));
    try {
      await withTempHome("credit-last-attempt", async (home) => {
        const fp = creditKeyFingerprint(EXAMPLE_KEY);
        const diagFile = creditStandingLastAttemptPath(home, fp);
        await writeMintedKeyState(home, {
          keyId: "key-1",
          userName: EXAMPLE_USER,
          displayName: "nexus-cli-test",
          apiKey: EXAMPLE_KEY,
        });

        // 1. Account endpoint returns 403 -> cache records unconfirmed snapshot AND .last.json records 403 with 0600 perms and zero PII.
        const record403 = await refreshCreditStandingCache({
          home,
          apiKey: EXAMPLE_KEY,
          gatewayUrl: gateway.url,
          now: NOW,
        });
        assert.equal(record403?.status, "ok");
        assert.equal(readActiveCreditIndicator(home, { expectedFingerprint: fp, now: NOW }), null);
        assert.equal(existsSync(diagFile), true);
        if (process.platform !== "win32") {
          assert.equal(statSync(diagFile).mode & 0o777, 0o600);
        }
        const raw403 = readFileSync(diagFile, "utf8");
        assert.doesNotMatch(raw403, new RegExp(EXAMPLE_KEY));
        assert.doesNotMatch(raw403, /example-account|example-user|@/);
        const parsed403 = readCreditStandingLastAttempt(home, { keyFingerprint: fp });
        assert.deepEqual(parsed403, {
          at: NOW,
          outcome: "unconfirmed",
          stage: "account",
          status: 403,
        });
        assert.equal(
          formatCreditStandingLastAttempt(parsed403, NOW + 120_000),
          "unknown (account lookup returned 403, 2m ago)",
        );

        // 2. Plan usage shape change (200 with missing overageStatus) -> records unconfirmed at usage stage.
        accountStatus = 200;
        accountBody = { suspendState: "CREDIT_DEPLETED", organization: "" };
        usageBody = { unexpectedShape: true };
        await refreshCreditStandingCache({
          home,
          apiKey: EXAMPLE_KEY,
          gatewayUrl: gateway.url,
          now: NOW + 10_000,
        });
        const parsedShape = readCreditStandingLastAttempt(home, { keyFingerprint: fp });
        assert.deepEqual(parsedShape, {
          at: NOW + 10_000,
          outcome: "unconfirmed",
          stage: "usage",
          status: 200,
        });
        assert.equal(
          formatCreditStandingLastAttempt(parsedShape, NOW + 10_000),
          "unknown (plan usage lookup returned 200 (unconfirmed), just now)",
        );

        // 3. Real detached runner hitting 500 on every call records error diagnostic with 0600 perms and zero PII.
        usageStatus = 500;
        accountStatus = 500;
        const runnerOut = await execFileAsync(process.execPath, [runnerScript], {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            NEXUS_TEST: "1",
            NEXUS_CREDIT_REFRESH_IN_TEST: "1",
            NEXUS_CREDIT_STATUS: "1",
            NEXUS_GATEWAY_URL: gateway.url,
            FIRECONNECT_GATEWAY_URL: "",
            ANTHROPIC_CUSTOM_HEADERS: `X-Fireworks-Api-Key: ${EXAMPLE_KEY}`,
          },
        });
        assert.equal(runnerOut.stdout, "");
        assert.equal(runnerOut.stderr, "");
        if (process.platform !== "win32") {
          assert.equal(statSync(diagFile).mode & 0o777, 0o600);
        }
        const raw500 = readFileSync(diagFile, "utf8");
        assert.doesNotMatch(raw500, new RegExp(EXAMPLE_KEY));
        assert.doesNotMatch(raw500, /example-account|example-user|@/);
        const parsed500 = readCreditStandingLastAttempt(home, { keyFingerprint: fp });
        assert.equal(parsed500?.outcome, "error");
        assert.equal(parsed500?.stage, "usage");
        assert.equal(parsed500?.status, 500);
        assert.equal(typeof parsed500?.at, "number");

        // 4. Subsequent confirmed snapshot clears .last.json.
        usageStatus = 200;
        usageBody = {
          monthly: { usedPercent: 100 },
          rollingWindow: { usedPercent: 20 },
          overageStatus: "OVERAGE_STATUS_ACTIVE",
        };
        accountStatus = 200;
        accountBody = { suspendState: "CREDIT_DEPLETED", organization: "" };
        await refreshCreditStandingCache({
          home,
          apiKey: EXAMPLE_KEY,
          gatewayUrl: gateway.url,
          now: NOW + 20_000,
        });
        assert.equal(existsSync(diagFile), false);
        assert.equal(readCreditStandingLastAttempt(home, { keyFingerprint: fp }), null);

        // 5. Late detached worker that lost lock ownership after clearCreditStandingCache must NOT write .last.json.
        const staleToken = createRefreshLockToken();
        assert.equal(claimCreditStandingRefresh({ home, expectedFingerprint: fp, now: NOW + 90_000, env: {}, lockToken: staleToken }), true);
        clearCreditStandingCache(home);
        await refreshCreditStandingCache({
          home,
          apiKey: EXAMPLE_KEY,
          userName: EXAMPLE_USER,
          lockToken: staleToken,
          now: NOW + 90_000,
          fetchFn: async () => new Response("{}", { status: 500 }),
        });
        assert.equal(existsSync(diagFile), false);

        // 6. clearCreditStandingCache removes both scoped and unscoped .last.json files.
        writeCreditStandingLastAttempt(home, { at: NOW, outcome: "error", stage: "verify", status: 500 }, { keyFingerprint: fp });
        writeCreditStandingLastAttempt(home, { at: NOW, outcome: "error", stage: "verify", status: 500 });
        assert.equal(existsSync(diagFile), true);
        assert.equal(existsSync(creditStandingLastAttemptPath(home)), true);
        clearCreditStandingCache(home);
        assert.equal(existsSync(diagFile), false);
        assert.equal(existsSync(creditStandingLastAttemptPath(home)), false);

        // 7. FIFO at .last.json path never blocks readCreditStandingLastAttempt.
        if (process.platform !== "win32") {
          mkdirSync(path.dirname(diagFile), { recursive: true });
          const mk = spawnSync("mkfifo", [diagFile]);
          if (mk.status === 0) {
            assert.equal(readCreditStandingLastAttempt(home, { keyFingerprint: fp }), null);
            clearCreditStandingLastAttempt(home, { keyFingerprint: fp });
          }
        }
      });
    } finally {
      await gateway.close();
    }
  });

  it("never touches native OS keychain backends from detached background refreshes", async () => {
    await withTempHome("credit-no-keychain-bg", async (home) => {
      await writeGlobalConfig(home, { apiKey: "{keychain:fireworks-api-key}" });
      let fetchCalled = 0;
      let detectCalled = 0;
      const res = await refreshCreditStandingCache({
        home,
        env: {},
        detectBackendFn: async () => {
          detectCalled += 1;
          return { backend: "keychain" };
        },
        fetchFn: async () => {
          fetchCalled += 1;
          return new Response("{}", { status: 200 });
        },
      });
      assert.equal(res, null);
      assert.equal(detectCalled, 1);
      assert.equal(fetchCalled, 0);
    });
  });

  it("bin/claude-credit-refresh.mjs refuses NEXUS_GATEWAY_URL outside NEXUS_TEST=1 even if NEXUS_CREDIT_REFRESH_IN_TEST=1", async () => {
    const runnerHref = new URL("../../bin/claude-credit-refresh.mjs", import.meta.url).href;
    await withTempHome("credit-runner-pin", async (home) => {
      await writeMintedKeyState(home, {
        keyId: "key-1",
        userName: EXAMPLE_USER,
        displayName: "nexus-cli-test",
        apiKey: EXAMPLE_KEY,
      });
      const probe = await execFileAsync(process.execPath, ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        const seen = [];
        globalThis.fetch = async (url) => {
          seen.push(String(url));
          return new Response(JSON.stringify({}), { status: 500 });
        };
        await import(${JSON.stringify(runnerHref)});
        assert.ok(seen.length >= 2, JSON.stringify(seen));
        assert.ok(
          seen.every((u) => u.startsWith(${JSON.stringify(`${CREDIT_STANDING_DEFAULT_GATEWAY_URL}/`)})),
          JSON.stringify(seen),
        );
      `], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          NEXUS_TEST: "0",
          NEXUS_CREDIT_REFRESH_IN_TEST: "1",
          NEXUS_CREDIT_STATUS: "1",
          NEXUS_GATEWAY_URL: "http://127.0.0.1:19999",
          FIRECONNECT_GATEWAY_URL: "https://evil.example.com",
          ANTHROPIC_CUSTOM_HEADERS: `X-Fireworks-Api-Key: ${EXAMPLE_KEY}`,
        },
      });
      assert.equal(probe.stdout, "");
      assert.equal(probe.stderr, "");
    });
  });
});
