// Ultra-fast calls on a Pro plan are billed at the standard model's rates:
// /usage and the Claude Code status line cost read the plan tier saved with
// the catalog cache and price those calls the same way.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { fetchNexusPlan } from "../../lib/fireworks/account-plan.mjs";
import { standardPricingForUltrafast, ultrafastPricedAtStandard } from "../../lib/fireworks/pricing.mjs";
import {
  cacheServerlessCatalogSnapshot,
  cachedNexusPlan,
  forgetCachedPlanForOtherKey,
  readCatalogCache,
  setServerlessCatalogSnapshot,
} from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { computeClaudeUsageCost } from "../../lib/harnesses/claude/usage/pricing.mjs";

// Never read a cache from disk unless a case writes one under its own temp
// HOME and cache dir: mark this process's snapshot as resolved and empty.
setServerlessCatalogSnapshot(null);

const ULTRAFAST = "deepseek-v4p1-flash-1017-ultrafast";
const ULTRAFAST_ROUTER = `accounts/fireworks/routers/${ULTRAFAST}`;
const MILLION = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
// From the spec table: standard 0.30 in / 1.20 out, Ultra-fast 1.20 / 4.80.
const STANDARD_COST = 0.30 + 1.20;
const ULTRAFAST_COST = 1.20 + 4.80;

function emptySnapshot(planTier, planState = planTier ? "ACTIVE" : "") {
  return {
    entries: [],
    pricingById: new Map(),
    inputModalitiesById: new Map(),
    routerBaseModelById: new Map(),
    contextLengthById: new Map(),
    supportsToolsById: new Map(),
    planTier,
    planState,
  };
}

function withPlan(planTier, fn, planState) {
  setServerlessCatalogSnapshot(emptySnapshot(planTier, planState));
  try {
    return fn();
  } finally {
    setServerlessCatalogSnapshot(null);
  }
}

/** Sets one env var for `fn`, restoring it after `fn` (or its promise) settles. */
function withEnv(name, value, fn) {
  const previous = process.env[name];
  const restore = () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
  process.env[name] = value;
  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === "function") return result.finally(restore);
  restore();
  return result;
}

describe("Ultra-fast usage pricing by plan", () => {
  it("prices Ultra-fast calls on a Pro plan at the standard model's rates", () => {
    withPlan("PRO", () => {
      assert.equal(ultrafastPricedAtStandard(), true);
      for (const ref of [ULTRAFAST, ULTRAFAST_ROUTER]) {
        const row = computeClaudeUsageCost(ref, MILLION);
        assert.equal(row.cost, STANDARD_COST, ref);
        assert.equal(row.estimated, false);
      }
    });
  });

  it("keeps the Ultra-fast rate for other plans, no plan, and an unknown plan", () => {
    for (const tier of ["TEAMS", "ENTERPRISE", ""]) {
      withPlan(tier, () => {
        assert.equal(ultrafastPricedAtStandard(), false, tier);
        assert.equal(computeClaudeUsageCost(ULTRAFAST, MILLION).cost, ULTRAFAST_COST, tier);
      });
    }
    // A Pro plan that ended or isn't paid for yet.
    for (const state of ["ENDED", "PENDING_PAYMENT"]) {
      withPlan("PRO", () => {
        assert.equal(ultrafastPricedAtStandard(), false, state);
        assert.equal(computeClaudeUsageCost(ULTRAFAST, MILLION).cost, ULTRAFAST_COST, state);
      }, state);
    }
    // A Pro plan being canceled is still in force.
    withPlan("PRO", () => assert.equal(ultrafastPricedAtStandard(), true), "CANCELING");
    // No cached catalog at all.
    setServerlessCatalogSnapshot(null);
    assert.deepEqual(cachedNexusPlan(), { tier: "", state: "" });
    assert.equal(computeClaudeUsageCost(ULTRAFAST, MILLION).cost, ULTRAFAST_COST);
  });

  it("leaves standard models alone on a Pro plan", () => {
    withPlan("PRO", () => {
      assert.equal(computeClaudeUsageCost("deepseek-v4p1-flash-1017", MILLION).cost, STANDARD_COST);
    });
  });

  it("NEXUS_ULTRAFAST_STANDARD_PRICING=0 keeps the Ultra-fast rate", () => {
    withEnv("NEXUS_ULTRAFAST_STANDARD_PRICING", "0", () => withPlan("PRO", () => {
      assert.equal(ultrafastPricedAtStandard(), false);
      assert.equal(computeClaudeUsageCost(ULTRAFAST, MILLION).cost, ULTRAFAST_COST);
    }));
  });

  it("finds no standard price for a ref that isn't an Ultra-fast model", () => {
    assert.equal(standardPricingForUltrafast("some-unlisted-model-ultrafast"), null);
    assert.equal(standardPricingForUltrafast(ULTRAFAST)?.input, 0.30);
  });

  it("keeps the Ultra-fast rate, as a real price, when no standard price is known", () => {
    // An Ultra-fast model priced in the cache whose standard model isn't.
    const snapshot = emptySnapshot("PRO");
    snapshot.pricingById.set("accounts/fireworks/routers/new-model-ultrafast", {
      slug: "new-model-ultrafast", label: "New Model Ultra-fast", input: 6, cachedInput: 0.6, output: 24, tier: "ultrafast", source: "test",
    });
    setServerlessCatalogSnapshot(snapshot);
    try {
      // An "estimated" row reads as unpriced to the live meter and reports,
      // so the published Ultra-fast rate stands, unmarked.
      const row = computeClaudeUsageCost("accounts/fireworks/routers/new-model-ultrafast", MILLION);
      assert.equal(row.cost, 30);
      assert.equal(row.estimated, false);
    } finally {
      setServerlessCatalogSnapshot(null);
    }
  });
});

/** Runs `fn` under a temp HOME and cache dir, cleaning up once it (or its promise) settles. */
function withTempHome(fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), "nexus-plan-tier-"));
  const previous = { HOME: process.env.HOME, NEXUS_CACHE_DIR: process.env.NEXUS_CACHE_DIR };
  process.env.HOME = home;
  process.env.NEXUS_CACHE_DIR = path.join(home, "cache");
  const cleanup = () => {
    setServerlessCatalogSnapshot(null);
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  };
  let result;
  try {
    result = fn(home);
  } catch (error) {
    cleanup();
    throw error;
  }
  if (result && typeof result.then === "function") return result.finally(cleanup);
  cleanup();
  return result;
}

describe("the plan saved with the catalog cache", () => {
  it("survives a save and a fresh read, and older caches read as unknown", () => {
    withTempHome(() => {
      cacheServerlessCatalogSnapshot(emptySnapshot("PRO", "CANCELING"));
      assert.equal(readCatalogCache()?.snapshot?.planTier, "PRO");
      assert.equal(readCatalogCache()?.snapshot?.planState, "CANCELING");
      cacheServerlessCatalogSnapshot(emptySnapshot(""));
      assert.equal(readCatalogCache()?.snapshot?.planTier, "");
    });
  });

  it("forgets the plan when another key takes over, keeping the rest of the cache", () => {
    withTempHome(() => {
      cacheServerlessCatalogSnapshot(emptySnapshot("PRO"), { apiKey: "fw_first_key" });
      const before = readCatalogCache();
      // Same key: nothing changes.
      forgetCachedPlanForOtherKey("fw_first_key");
      assert.equal(readCatalogCache()?.snapshot?.planTier, "PRO");
      // Another key: the plan goes, in memory and on disk; the age stays.
      forgetCachedPlanForOtherKey("fw_second_key");
      const after = readCatalogCache();
      assert.equal(after?.snapshot?.planTier, "");
      assert.equal(after?.cachedAt, before?.cachedAt);
      assert.equal(after?.keyFingerprint, before?.keyFingerprint);
      assert.deepEqual(cachedNexusPlan(), { tier: "", state: "" });
    });
  });

  it("reads the plan from NEXUS_TEST_PLAN_TIER in specs, never the network", async () => {
    await withEnv("NEXUS_TEST", "1", async () => {
      await withEnv("NEXUS_TEST_PLAN_TIER", "PRO", async () => assert.deepEqual(await fetchNexusPlan("fw_test_key"), { catalogTier: "PRO", tier: "PRO", state: "ACTIVE" }));
      await withEnv("NEXUS_TEST_PLAN_TIER", "UNAVAILABLE", async () => assert.equal(await fetchNexusPlan("fw_test_key"), null));
      await withEnv("NEXUS_TEST_PLAN_TIER", "", async () => assert.deepEqual(await fetchNexusPlan("fw_test_key"), { catalogTier: "", tier: "", state: "" }));
    });
  });
});
