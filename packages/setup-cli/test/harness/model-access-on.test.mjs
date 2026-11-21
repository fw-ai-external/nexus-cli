// `on` with a configured model the account's catalog no longer lists, driven
// through the real engineOn with a fake harness profile: the yes path writes
// the replacement, and nothing is compared offline or against a stale or
// other account's catalog.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { engineOn } from "../../lib/harness/engine.mjs";
import { buildServerlessCatalogSnapshot } from "../../lib/fireworks/models.mjs";
import {
  cacheServerlessCatalogSnapshot,
  setServerlessCatalogSnapshot,
} from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { mockServerlessModel, withTempHome } from "../helpers.mjs";

const KEY = "fw_test_model_access_on_000000";
// The mock gateway serves a catalog (without blocked-model) to keys marked "cataloged".
const CATALOGED_KEY = "fw_test_cataloged_v2_access_on_0";
const ROWS = [
  mockServerlessModel({
    id: "accounts/fireworks/models/example-model",
    display_name: "Example Model",
    aliases: ["accounts/fireworks/routers/example-latest"],
  }),
];

/** A harness configured on `current` whose enable records the model `on` selects. */
function fakeProfile(current) {
  const calls = [];
  return {
    calls,
    profile: {
      id: "opencode",
      label: "OpenCode",
      resolveKey: async () => "",
      paths: () => ({}),
      keyEnvRef: "{env:FIREWORKS_API_KEY}",
      firerouter: null,
      restartHint: () => {},
      resolveOnKey: async () => ({ apiKeyRef: KEY, effectiveKey: KEY }),
      configuredModels: async () => [{ slot: "main", model: current }],
      enable: async ({ modelId }) => {
        calls.push(modelId);
        return { model: modelId || current, modelsAdded: [] };
      },
    },
  };
}

/** Run `fn` with stderr captured. */
async function withStderr(fn) {
  const lines = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return lines.join("");
}

/**
 * Run a test in its own temp HOME: the catalog cache is scoped by HOME, so
 * seeding, the `on` under test and the cleanup all stay under it.
 */
function inTempHome(prefix, fn) {
  return withTempHome(prefix, async (home) => {
    const prior = process.env.HOME;
    process.env.HOME = home;
    try {
      return await fn(home);
    } finally {
      cacheServerlessCatalogSnapshot(null);
      setServerlessCatalogSnapshot(null);
      process.env.HOME = prior;
    }
  });
}

describe("on: a configured model the catalog no longer lists", () => {
  it("re-on at a terminal switches a blocked model to a served one on yes", async () => {
    await inTempHome("model-access-on-yes-", async (home) => {
      cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(ROWS), { apiKey: KEY });
      const { profile, calls } = fakeProfile("blocked-model");
      const questions = [];
      await withStderr(() => engineOn(profile, {
        home, quiet: true, askModelSwitch: async (q) => { questions.push(q); return true; },
      }));
      // The catalog lists no auto row here, so the offer is a model it lists.
      assert.deepEqual(questions, ["Switch it to example-latest?"]);
      assert.deepEqual(calls, ["example-latest"]);
    });
  });

  it("offers auto when the account's catalog lists it", async () => {
    await inTempHome("model-access-on-auto-", async (home) => {
      cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot([
        ...ROWS,
        { kind: "router", usage_identifier: "accounts/fireworks/routers/auto" },
      ]), { apiKey: KEY });
      const { profile, calls } = fakeProfile("blocked-model");
      await withStderr(() => engineOn(profile, { home, quiet: true, askModelSwitch: async () => true }));
      assert.deepEqual(calls, ["auto"]);
    });
  });

  it("keeps the model on no", async () => {
    await inTempHome("model-access-on-no-", async (home) => {
      cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(ROWS), { apiKey: KEY });
      const { profile, calls } = fakeProfile("blocked-model");
      const stderr = await withStderr(() => engineOn(profile, { home, quiet: true, askModelSwitch: async () => false }));
      assert.deepEqual(calls, [""]);
      assert.match(stderr, /Kept as is\. To switch later, run: nexus opencode on --model example-latest/);
    });
  });

  it("an upgrade's quiet re-on still prints one line", async () => {
    await inTempHome("model-access-on-quiet-", async (home) => {
      cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(ROWS), { apiKey: KEY });
      const { profile, calls } = fakeProfile("blocked-model");
      const stderr = await withStderr(() => engineOn(profile, { home, quiet: true }));
      assert.deepEqual(calls, [""]);
      assert.equal(stderr.trim().split("\n").length, 1);
      assert.match(stderr, /^blocked-model isn't available to this account\. .*To switch, run: nexus opencode on --model example-latest/);
    });
  });

  it("offline re-on (nothing cached) compares nothing and asks nothing", async () => {
    await inTempHome("model-access-on-offline-", async (home) => {
      let asked = false;
      const { profile, calls } = fakeProfile("blocked-model");
      const stderr = await withStderr(() => engineOn(profile, {
        home, quiet: true, askModelSwitch: async () => { asked = true; return true; },
      }));
      assert.equal(asked, false);
      assert.deepEqual(calls, [""]);
      assert.doesNotMatch(stderr, /isn't available/);
    });
  });

  it("another account's cached catalog is not compared", async () => {
    await inTempHome("model-access-on-other-", async (home) => {
      // Fresh cache, but fetched with a different key: the load refetches,
      // the mock gateway serves this key nothing, and the copy isn't used.
      cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(ROWS), { apiKey: "fw_test_other_account_00000" });
      let asked = false;
      const { profile, calls } = fakeProfile("blocked-model");
      await withStderr(() => engineOn(profile, {
        home, quiet: true, askModelSwitch: async () => { asked = true; return true; },
      }));
      assert.equal(asked, false);
      assert.deepEqual(calls, [""]);
    });
  });

  it("nothing cached yet: compares nothing, even when the catalog could be fetched", async () => {
    await inTempHome("model-access-on-first-", async (home) => {
      // A first `on`: the mock gateway would serve this key a catalog without
      // blocked-model, but with no cached copy the check must not run (or wait).
      let asked = false;
      const { profile, calls } = fakeProfile("blocked-model");
      profile.resolveOnKey = async () => ({ apiKeyRef: CATALOGED_KEY, effectiveKey: CATALOGED_KEY });
      await withStderr(() => engineOn(profile, {
        home, quiet: true, askModelSwitch: async () => { asked = true; return true; },
      }));
      assert.equal(asked, false);
      assert.deepEqual(calls, [""]);
    });
  });

  it("an expired catalog that can't be refreshed is not compared", async () => {
    await inTempHome("model-access-on-stale-", async (home) => {
      cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(ROWS), { apiKey: KEY });
      const prior = process.env.NEXUS_CATALOG_TTL_MS;
      process.env.NEXUS_CATALOG_TTL_MS = "1";
      let asked = false;
      try {
        await new Promise((r) => setTimeout(r, 5));
        // The refetch fails (the mock gateway serves this key nothing), so the
        // load falls back to the expired copy: `stale`, never compared.
        const { profile, calls } = fakeProfile("blocked-model");
        await withStderr(() => engineOn(profile, {
          home, quiet: true, askModelSwitch: async () => { asked = true; return true; },
        }));
        assert.deepEqual(calls, [""]);
      } finally {
        if (prior === undefined) delete process.env.NEXUS_CATALOG_TTL_MS; else process.env.NEXUS_CATALOG_TTL_MS = prior;
      }
      assert.equal(asked, false);
    });
  });
});
