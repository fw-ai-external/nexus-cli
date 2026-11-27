import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, it } from "node:test";
import { Writable } from "node:stream";

import { writeGlobalConfig } from "../../../../lib/config/global-config.mjs";
import { createClaudeLiveCreditReader } from "../../../../lib/harnesses/claude/index.mjs";
import {
  liveMeterKeyHint,
  runClaudeUsageLive,
  shouldRunClaudeUsageLive,
  summarizePeerAgents,
} from "../../../../lib/harnesses/claude/usage/live.mjs";
import { runUsageMeter } from "../../../../lib/harnesses/claude/usage/meter.mjs";
import {
  CREDIT_STANDING_LOCK_TTL_MS,
  NEXUS_BILLING_URL,
  clearCreditStandingCache,
  creditKeyFingerprint,
  readCreditStandingCache,
  writeCreditStandingCache,
} from "../../../../lib/fireworks/credit-standing.mjs";
import { writeMintedKeyState } from "../../../../lib/keys/mint-api-key.mjs";
import {
  KEY_STORAGE_ENV,
  getSecret,
  resetSecretStoreForTests,
  setSecret,
} from "../../../../lib/keys/secret-store.mjs";
import { ANSI, DATA, METER } from "../../../../lib/ui/palette.mjs";
import { runFireconnect } from "../../../helpers.mjs";

const temps = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function jsonl(entries) {
  return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "fc-usage-live-"));
  temps.push(home);
  return home;
}

function collectStream() {
  let text = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  stream.isTTY = false;
  stream.columns = 100;
  stream.rows = 40;
  return {
    stream,
    get text() {
      return text;
    },
  };
}

describe("summarizePeerAgents", () => {
  it("propagates an unpriced peer cost instead of coercing it to zero", () => {
    const summary = summarizePeerAgents([
      {
        kind: "subagent",
        label: "Priced",
        report: { requests: 2, totals: { cost: 0.25 } },
      },
      {
        kind: "subagent",
        label: "Unpriced",
        report: { requests: 1, totals: { cost: null } },
      },
      {
        kind: "main",
        label: "Main",
        report: { requests: 3, totals: { cost: null } },
      },
    ]);

    assert.equal(summary.count, 2);
    assert.equal(summary.calls, 3);
    assert.equal(summary.cost, null);
    assert.equal(summary.main.cost, null);
  });
});

describe("shouldRunClaudeUsageLive", () => {
  it("watches on a TTY", () => {
    assert.equal(shouldRunClaudeUsageLive({}, { isTTY: true }), true);
  });

  it("prints a snapshot when stdout is not a TTY", () => {
    assert.equal(shouldRunClaudeUsageLive({}, { isTTY: false }), false);
  });

  it("prints a snapshot for --json, --last-n, and --verbose", () => {
    assert.equal(shouldRunClaudeUsageLive({ json: true }, { isTTY: true }), false);
    assert.equal(shouldRunClaudeUsageLive({ lastN: "2" }, { isTTY: true }), false);
    assert.equal(shouldRunClaudeUsageLive({ verbose: true }, { isTTY: true }), false);
  });

  it("prints a snapshot for --plain even on a TTY", () => {
    // --plain asks for scrapeable output, so it must not open the interactive
    // session picker before the meter's own plain handling kicks in.
    assert.equal(shouldRunClaudeUsageLive({ plain: true }, { isTTY: true }), false);
  });
});

describe("liveMeterKeyHint", () => {
  it("advertises the session-list key when a picker exists", () => {
    assert.equal(
      liveMeterKeyHint({ canPickSession: true }),
      "Tab agents · Esc sessions · q quit",
    );
  });

  it("omits the session-list key when the meter is locked to one session", () => {
    assert.equal(
      liveMeterKeyHint({ canPickSession: false }),
      "Tab agents · q quit",
    );
  });
});

describe("meter palette uses the color guide primary accent", () => {
  it("exposes the shared METER accent/gold/ghost codes", () => {
    assert.equal(METER.accent, ANSI.primary);
    assert.equal(METER.gold, DATA.cost);
    assert.equal(METER.ghost, "\u001b[38;5;245m");
    assert.equal(METER.modelPalette.length, 9);
    assert.equal(METER.modelPalette[0], "38;2;49;212;211", "badges use the data colors");
  });
});

describe("runClaudeUsageLive meter UI", () => {
  it("renders per-turn meter rows as the session grows", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const sessionId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const logPath = path.join(projectDir, `${sessionId}.jsonl`);
    await writeFile(logPath, jsonl([
      { type: "user", message: { content: "first turn" } },
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
        },
      },
    ]));

    const out = collectStream();
    const controller = new AbortController();
    let polls = 0;
    const sleep = async () => {
      polls += 1;
      if (polls === 1) {
        await appendFile(logPath, jsonl([
          { type: "user", message: { content: "second turn" } },
          {
            type: "assistant",
            message: {
              id: "msg_2",
              model: "accounts/fireworks/models/kimi-k3",
              usage: { input_tokens: 500_000, output_tokens: 100_000 },
            },
          },
        ]));
      }
      if (polls >= 4) controller.abort();
    };

    await runClaudeUsageLive({
      home,
      session: sessionId,
      plain: true,
      stream: out.stream,
      signal: controller.signal,
      sleep,
      pollMs: 0,
    });

    assert.match(out.text, /Live Cost Meter|✦/);
    assert.match(out.text, /TOTAL/);
    assert.match(out.text, /first turn/);
    assert.match(out.text, /GLM/);
    assert.match(out.text, /Kimi/);
    assert.match(out.text, /\$4\.4000|\$1\.4000/);
  });

  it("refreshes live credit standing across polls and emits inline warnings in NO_COLOR mode", async () => {
    const home = await tempHome();
    const logPath = path.join(home, "session.jsonl");
    await writeFile(logPath, jsonl([
      { type: "user", message: { content: "turn one" } },
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    ]));

    const active = { standing: "available", limit: "session", label: "using credits" };
    const depleted = { standing: "depleted", limit: "monthly", label: "credits used up" };
    let current = active;
    let polls = 0;
    const seenBeforeExit = [];
    const out = collectStream();
    out.stream.isTTY = true;
    const controller = new AbortController();
    const prevNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const db = await runUsageMeter({
        filePath: logPath,
        plain: false,
        fromStart: true,
        follow: true,
        pollMs: 0,
        peersMs: 0,
        stream: out.stream,
        signal: controller.signal,
        creditIndicator: active,
        readCreditIndicator: () => current,
        sleep: async () => {
          polls += 1;
          // Wait a microtask for refreshPeers promise resolution before asserting inline output.
          await new Promise((r) => setImmediate(r));
          seenBeforeExit.push(out.text);
          if (polls === 1) current = depleted;
          if (polls === 3) current = null;
          if (polls >= 5) controller.abort();
        },
      });
      // Immediately visible inline after banner in NO_COLOR mode before exit.
      assert.match(seenBeforeExit[0], /using credits \(5h plan limit reached\)/);
      // Mid-session transition to depleted renders inline with billing URL before exit.
      assert.match(seenBeforeExit[2], /⚠ credits used up/);
      assert.ok(seenBeforeExit[2].includes(NEXUS_BILLING_URL), seenBeforeExit[2]);
      // Subsequent top-up clears db.creditIndicator cleanly.
      assert.equal(db.creditIndicator, null);
    } finally {
      if (prevNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevNoColor;
    }
  });

  it("preserves prior creditIndicator and rendered notice when a readCreditIndicator poll rejects", async () => {
    const home = await tempHome();
    const logPath = path.join(home, "session.jsonl");
    await writeFile(logPath, jsonl([
      { type: "user", message: { content: "turn one" } },
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    ]));

    const depleted = { standing: "depleted", limit: "monthly", label: "credits used up" };
    let pollCalls = 0;
    let sleeps = 0;
    const out = collectStream();
    out.stream.isTTY = true;
    const controller = new AbortController();
    const prevNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const db = await runUsageMeter({
        filePath: logPath,
        plain: false,
        fromStart: true,
        follow: true,
        pollMs: 0,
        peersMs: 0,
        stream: out.stream,
        signal: controller.signal,
        creditIndicator: depleted,
        readCreditIndicator: async () => {
          pollCalls += 1;
          if (pollCalls === 1) return depleted;
          throw new Error("transient poll failure");
        },
        sleep: async () => {
          sleeps += 1;
          await new Promise((r) => setImmediate(r));
          if (sleeps >= 3) controller.abort();
        },
      });
      assert.ok(pollCalls >= 2, `expected rejecting poll after initial reading, got ${pollCalls}`);
      assert.deepEqual(db.creditIndicator, depleted);
      assert.match(out.text, /⚠ credits used up/);
      assert.ok(out.text.includes(NEXUS_BILLING_URL), out.text);
    } finally {
      if (prevNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevNoColor;
    }
  });

  it("createClaudeLiveCreditReader stops polling after logout, ignores custom helpers, and enforces 60s failure cooldown", async () => {
    const home = await tempHome();
    const key = "fw_live_meter_credit_key_00000000";
    const fp = creditKeyFingerprint(key);
    let now = Date.now();
    await writeMintedKeyState(home, {
      keyId: "key-1",
      userName: "accounts/example-account/users/example-user",
      displayName: "nexus-cli-test",
      apiKey: key,
    });
    writeCreditStandingCache(home, {
      fetchedAt: now,
      keyFingerprint: fp,
      status: "ok",
      monthlyUsedPercent: 100,
      sessionUsedPercent: 20,
      overageStatus: "OVERAGE_STATUS_ACTIVE",
      suspendState: "CREDIT_DEPLETED",
      ownsWallet: true,
    });

    // 1. Custom third-party helper or unconfigured session must NEVER show browser-minted credits or poll.
    let loadCalls = 0;
    const customReader = createClaudeLiveCreditReader(
      { home },
      {
        env: {},
        nowFn: () => now,
        resolveAuth: async () => ({ token: "", usesNexusHelper: false }),
        resolveStoredKey: async () => key,
        loadStanding: async () => { loadCalls += 1; return null; },
        allowNetworkInTest: true,
      },
    );
    assert.equal(await customReader(), null);
    assert.equal(loadCalls, 0);

    // 2. Nexus apiKeyHelper mode: active while signed in, then stops immediately after logout
    //    without recreating the deleted credit cache.
    let storedKey = key;
    let logoutLoadCalls = 0;
    const helperReader = createClaudeLiveCreditReader(
      { home },
      {
        env: {},
        nowFn: () => now,
        resolveAuth: async () => ({ token: "", usesNexusHelper: true }),
        resolveStoredKey: async () => storedKey,
        loadStanding: async () => {
          logoutLoadCalls += 1;
          writeCreditStandingCache(home, {
            fetchedAt: now,
            keyFingerprint: fp,
            status: "ok",
            monthlyUsedPercent: 100,
            sessionUsedPercent: 20,
            overageStatus: "OVERAGE_STATUS_ACTIVE",
            suspendState: "CREDIT_DEPLETED",
            ownsWallet: true,
          });
          return { standing: "depleted", limit: "monthly", label: "credits used up" };
        },
        allowNetworkInTest: true,
      },
    );
    assert.deepEqual(await helperReader(), { standing: "depleted", limit: "monthly", label: "credits used up" });
    assert.equal(logoutLoadCalls, 0);

    // Simulate `nexus logout`: stored key deleted and credit cache cleared.
    storedKey = "";
    clearCreditStandingCache(home);
    assert.equal(await helperReader(), null);
    await new Promise((r) => setImmediate(r));
    assert.equal(logoutLoadCalls, 0);
    assert.equal(readCreditStandingCache(home, { keyFingerprint: fp }), null);

    // 3. Repeated polls after a failed refresh respect the 60s cooldown instead of retrying every 2s.
    let retryCalls = 0;
    const cooldownReader = createClaudeLiveCreditReader(
      { home },
      {
        env: {},
        nowFn: () => now,
        resolveAuth: async () => ({ token: key, usesNexusHelper: false }),
        loadStanding: async () => {
          retryCalls += 1;
          return null;
        },
        allowNetworkInTest: true,
      },
    );
    // Poll 1: missing cache -> triggers 1 refresh attempt (which fails).
    assert.equal(await cooldownReader(), null);
    await new Promise((r) => setImmediate(r));
    assert.equal(retryCalls, 1);

    // Polls at +2s and +30s: still inside 60s cooldown -> no additional gateway attempts.
    now += 2_000;
    assert.equal(await cooldownReader(), null);
    await new Promise((r) => setImmediate(r));
    now += 28_000;
    assert.equal(await cooldownReader(), null);
    await new Promise((r) => setImmediate(r));
    assert.equal(retryCalls, 1);

    // Poll after 60s cooldown expires -> retries once.
    now += CREDIT_STANDING_LOCK_TTL_MS;
    assert.equal(await cooldownReader(), null);
    await new Promise((r) => setImmediate(r));
    assert.equal(retryCalls, 2);
  });

  it("never blocks first frame or periodic peer/agent updates when readCreditIndicator stalls", async () => {
    const home = await tempHome();
    const logPath = path.join(home, "session.jsonl");
    await writeFile(logPath, jsonl([
      { type: "user", message: { content: "turn one" } },
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    ]));

    let peerReads = 0;
    let sleeps = 0;
    const out = collectStream();
    const controller = new AbortController();
    const db = await runUsageMeter({
      filePath: logPath,
      plain: true,
      fromStart: true,
      follow: true,
      pollMs: 0,
      peersMs: 0,
      creditTimeoutMs: 5_000,
      stream: out.stream,
      signal: controller.signal,
      readPeers: async () => {
        peerReads += 1;
        return { count: 1, calls: peerReads, cost: 0.25 * peerReads };
      },
      // Permanently hung credit reader must NEVER block first frame, peer updates, or exit.
      readCreditIndicator: () => new Promise(() => {}),
      sleep: async () => {
        sleeps += 1;
        await new Promise((r) => setImmediate(r));
        if (sleeps >= 3) controller.abort();
      },
    });

    assert.ok(peerReads >= 3, `expected periodic peer updates while credit read hung, got ${peerReads}`);
    assert.equal(db.peers?.calls, peerReads);
    assert.match(out.text, /turn one/);
  });

  it("createClaudeLiveCreditReader sees out-of-process secure-store key rotation without stale memoization", async () => {
    const home = await tempHome();
    const keyA = "fw_live_rotation_account_a_00000";
    const keyB = "fw_live_rotation_account_b_00000";
    const fpA = creditKeyFingerprint(keyA);
    const fpB = creditKeyFingerprint(keyB);
    const masterKey = "b".repeat(64);
    const savedEnv = {
      [KEY_STORAGE_ENV]: process.env[KEY_STORAGE_ENV],
      KEYRING_FILE_MASTER_KEY: process.env.KEYRING_FILE_MASTER_KEY,
      NEXUS_SECRET_STORE: process.env.NEXUS_SECRET_STORE,
    };
    process.env[KEY_STORAGE_ENV] = "file";
    process.env.KEYRING_FILE_MASTER_KEY = masterKey;
    delete process.env.NEXUS_SECRET_STORE;
    resetSecretStoreForTests();

    try {
      await setSecret(keyA, home);
      await writeGlobalConfig(home, { apiKey: "{keychain:fireworks-api-key}" });

      const now = Date.now();
      const polledKeys = [];
      const reader = createClaudeLiveCreditReader(
        { home },
        {
          env: {},
          nowFn: () => now,
          resolveAuth: async () => ({ token: "", usesNexusHelper: true }),
          loadStanding: async ({ apiKey }) => {
            polledKeys.push(apiKey);
            writeCreditStandingCache(home, {
              fetchedAt: now,
              keyFingerprint: creditKeyFingerprint(apiKey),
              status: "ok",
              monthlyUsedPercent: 100,
              sessionUsedPercent: 0,
              overageStatus: "OVERAGE_STATUS_ACTIVE",
              suspendState: apiKey === keyB ? "UNSUSPENDED" : "CREDIT_DEPLETED",
              ownsWallet: true,
            });
            return null;
          },
          allowNetworkInTest: true,
        },
      );

      // Poll 1 reads key A from the encrypted file store (populating secureReadCache).
      await reader();
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(polledKeys, [keyA]);
      assert.deepEqual(await reader(), { standing: "depleted", limit: "monthly", label: "credits used up" });

      // Simulate a separate `nexus login --api-key <keyB>` process rotating the stored key
      // while this live-meter process is still running (secureReadCache still holds keyA!).
      const childEnv = {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
        [KEY_STORAGE_ENV]: "file",
        KEYRING_FILE_MASTER_KEY: masterKey,
        NEXUS_NO_UPDATE_CHECK: "1",
      };
      delete childEnv.NEXUS_SECRET_STORE;
      delete childEnv.FIREWORKS_API_KEY;
      const login = spawnSync(process.execPath, [path.resolve("bin/nexus.mjs"), "login", "--api-key", keyB], {
        env: childEnv,
        encoding: "utf8",
      });
      assert.equal(login.status, 0, login.stderr);

      // Confirm in-process default getSecret() was indeed memoized on keyA,
      // proving fresh reads are load-bearing here.
      assert.equal(await getSecret(home), keyA);

      // Next live poll MUST see keyB (never repopulating keyA's cleared cache).
      await reader();
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(polledKeys, [keyA, keyB]);
      assert.equal(readCreditStandingCache(home, { keyFingerprint: fpA }), null);
      assert.deepEqual(await reader(), { standing: "available", limit: "monthly", label: "using credits" });
      assert.ok(readCreditStandingCache(home, { keyFingerprint: fpB }));
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetSecretStoreForTests();
    }
  });

  it("createClaudeLiveCreditReader reads stored key at most once across steady-state polls and drops on logout without touching keychain", async () => {
    const home = await tempHome();
    const keyA = "fw_live_keychain_once_a_0000000";
    const keyB = "fw_live_keychain_once_b_0000000";
    const fpA = creditKeyFingerprint(keyA);
    const fpB = creditKeyFingerprint(keyB);
    const now = Date.now();

    await writeGlobalConfig(home, { apiKey: "{keychain:fireworks-api-key}" });
    await writeFile(
      path.join(home, ".nexus", "key-storage.json"),
      `${JSON.stringify({ storage: "keychain", updatedAt: "2027-01-01T00:00:00.000Z" })}\n`,
    );
    writeCreditStandingCache(home, {
      fetchedAt: now,
      keyFingerprint: fpA,
      status: "ok",
      monthlyUsedPercent: 100,
      sessionUsedPercent: 0,
      overageStatus: "OVERAGE_STATUS_ACTIVE",
      suspendState: "CREDIT_DEPLETED",
      ownsWallet: true,
    });

    let currentSecret = keyA;
    const storeReads = [];
    const reader = createClaudeLiveCreditReader(
      { home },
      {
        env: {},
        nowFn: () => now,
        resolveAuth: async () => ({ token: "", usesNexusHelper: true }),
        resolveStoredKey: async (opts) => {
          storeReads.push({ fresh: Boolean(opts?.fresh) });
          return currentSecret;
        },
        trackCredentialChanges: true,
        loadStanding: async () => null,
        allowNetworkInTest: true,
      },
    );

    // Steady-state polls: first poll reads once (NO fresh: true), subsequent 2s ticks do ZERO secret-store reads.
    assert.deepEqual(await reader(), { standing: "depleted", limit: "monthly", label: "credits used up" });
    assert.deepEqual(await reader(), { standing: "depleted", limit: "monthly", label: "credits used up" });
    assert.deepEqual(await reader(), { standing: "depleted", limit: "monthly", label: "credits used up" });
    assert.deepEqual(storeReads, [{ fresh: false }]);

    // Out-of-process rotation updates key-storage.json -> triggers exactly ONE fresh read.
    currentSecret = keyB;
    writeCreditStandingCache(home, {
      fetchedAt: now,
      keyFingerprint: fpB,
      status: "ok",
      monthlyUsedPercent: 100,
      sessionUsedPercent: 0,
      overageStatus: "OVERAGE_STATUS_ACTIVE",
      suspendState: "UNSUSPENDED",
      ownsWallet: true,
    });
    await writeFile(
      path.join(home, ".nexus", "key-storage.json"),
      `${JSON.stringify({ storage: "keychain", updatedAt: "2027-01-01T00:01:00.000Z" })}\n`,
    );
    assert.deepEqual(await reader(), { standing: "available", limit: "monthly", label: "using credits" });
    assert.deepEqual(await reader(), { standing: "available", limit: "monthly", label: "using credits" });
    assert.deepEqual(storeReads, [{ fresh: false }, { fresh: true }]);

    // Out-of-process `nexus logout` clears config.apiKey -> stops immediately with ZERO secret-store reads.
    await writeGlobalConfig(home, { apiKey: "" });
    assert.equal(await reader(), null);
    assert.equal(await reader(), null);
    assert.deepEqual(storeReads, [{ fresh: false }, { fresh: true }]);
  });

  it("drops pre-picker creditIndicator on session switch so stale depletion or prior-account credits never reprint in NO_COLOR mode", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    const sessionA = path.join(projectDir, "11111111-1111-4111-8111-111111111111.jsonl");
    const sessionB = path.join(projectDir, "22222222-2222-4222-8222-222222222222.jsonl");
    const sampleLog = jsonl([
      { type: "user", message: { content: "hello" } },
      {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "accounts/fireworks/models/glm-5p2",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    ]);
    await writeFile(sessionA, sampleLog);
    await writeFile(sessionB, sampleLog);

    const depleted = { standing: "depleted", limit: "monthly", label: "credits used up" };
    let liveCredit = depleted;
    const out = collectStream();
    out.stream.isTTY = true;
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      setRawMode() {},
      resume() {},
      pause() {},
      isPaused() { return false; },
    });
    const controller = new AbortController();
    let sleepCount = 0;
    let outputBeforeSwitch = 0;

    const prevNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      await runClaudeUsageLive({
        home,
        session: "11111111",
        plain: false,
        pollMs: 0,
        stream: out.stream,
        input,
        signal: controller.signal,
        creditIndicator: depleted,
        readCreditIndicator: async () => liveCredit,
        promptSession: async () => {
          // Account topped up / changed while the session picker was open.
          liveCredit = null;
          outputBeforeSwitch = out.text.length;
          return sessionB;
        },
        sleep: async () => {
          sleepCount += 1;
          await new Promise((r) => setImmediate(r));
          if (sleepCount === 1) {
            // Press Esc to open the session picker.
            input.emit("data", Buffer.from("\x1b"));
            await new Promise((r) => setImmediate(r));
          } else if (sleepCount >= 3) {
            controller.abort();
          }
        },
      });

      const beforeSwitch = out.text.slice(0, outputBeforeSwitch);
      const afterSwitch = out.text.slice(outputBeforeSwitch);
      assert.match(beforeSwitch, /⚠ credits used up/);
      assert.doesNotMatch(
        afterSwitch,
        /credits used up|using credits/i,
        `stale credit standing must not reprint after picker/session switch:\n${afterSwitch}`,
      );
    } finally {
      if (prevNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevNoColor;
    }
  });

  it("fails fast on an unknown session id", async () => {
    const home = await tempHome();
    const projectDir = path.join(home, ".claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb.jsonl"),
      "\n",
    );
    await assert.rejects(
      () => runClaudeUsageLive({
        home,
        session: "does-not-exist",
        plain: true,
        stream: collectStream().stream,
        signal: AbortSignal.abort(),
        sleep: async () => {},
      }),
      /No Claude Code session log matching/,
    );
  });
});

describe("fireconnect claude usage help", () => {
  it("documents live watch without --live/--once flags", async () => {
    const result = await runFireconnect(["claude", "help"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /live cost meter|Live per-turn cost meter|Pick session|live Main|Main meter|← agents|subagent/i);
    assert.doesNotMatch(result.stdout, /tmux/i, "the retired `claude live` split is not advertised");
    assert.doesNotMatch(result.stdout, /--live/);
    assert.doesNotMatch(result.stdout, /--once/);
  });
});
