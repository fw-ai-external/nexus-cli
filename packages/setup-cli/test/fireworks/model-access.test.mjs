import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  blockedConfiguredModels,
  formatBlockedModelsStatusNote,
  isModelAccessDenial,
  isModelInCatalog,
  modelAccessReport,
  modelNotAvailableMessage,
  formatModelAccessUncheckedNote,
  offerModelAccessSwitch,
  pickReplacementModel,
  staleCatalogDate,
} from "../../lib/fireworks/model-access.mjs";
import { probeModelServable } from "../../lib/fireworks/model-servability.mjs";
import { buildServerlessCatalogSnapshot } from "../../lib/fireworks/models.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cacheServerlessCatalogSnapshot,
  setServerlessCatalogSnapshot,
} from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { mockServerlessModel, mockServerlessModelRows } from "../helpers.mjs";

// The account's served catalog: example-model in both modes, other-model in
// standard only (its fast mode is blocked), plus the `-latest` aliases.
const ALLOWED_ROWS = [
  ...mockServerlessModelRows({
    id: "accounts/fireworks/models/example-model",
    display_name: "Example Model",
    aliases: ["accounts/fireworks/routers/example-latest"],
  }),
  mockServerlessModel({
    id: "accounts/fireworks/models/other-model",
    display_name: "Other Model",
  }),
];
const CATALOG = buildServerlessCatalogSnapshot(ALLOWED_ROWS).entries;

const POLICY_403 = JSON.stringify({
  error: {
    message: "Your account's model-access policy does not allow serverless inference for model "
      + "accounts/fireworks/models/blocked-model",
  },
});

afterEach(() => {
  // Memory and disk: specs run under the global NEXUS_CACHE_DIR isolation.
  cacheServerlessCatalogSnapshot(null);
  setServerlessCatalogSnapshot(null);
});

describe("isModelAccessDenial", () => {
  it("recognizes the gateway's Model Access refusal", () => {
    assert.equal(isModelAccessDenial(403, POLICY_403), true);
    assert.equal(isModelAccessDenial(403, "your account's model access policy does not allow it"), true);
  });

  it("ignores other 403s and other statuses", () => {
    assert.equal(isModelAccessDenial(403, '{"error":"forbidden"}'), false);
    // The gateway's other policy 403 is about an unresolvable model, not a refusal.
    assert.equal(isModelAccessDenial(403, "Could not resolve a model for this request, so your account's "
      + "model-access policy could not be evaluated"), false);
    assert.equal(isModelAccessDenial(401, POLICY_403), false);
    assert.equal(isModelAccessDenial(403, undefined), false);
  });
});

describe("isModelInCatalog", () => {
  it("matches short ids, resource names, and [1m] spellings", () => {
    assert.equal(isModelInCatalog("example-model", CATALOG), true);
    assert.equal(isModelInCatalog("accounts/fireworks/models/example-model", CATALOG), true);
    assert.equal(isModelInCatalog("example-latest[1m]", CATALOG), true);
    assert.equal(isModelInCatalog("example-model-fast", CATALOG), true);
  });

  it("does not admit another account's model on a public slug", () => {
    assert.equal(isModelInCatalog("accounts/example-account/models/example-model", CATALOG), false);
    assert.equal(isModelInCatalog("other-model-fast", CATALOG), false);
  });
});

describe("blockedConfiguredModels", () => {
  it("reports configured models the catalog doesn't list, with their slot", () => {
    const blocked = blockedConfiguredModels([
      { slot: "main", model: "accounts/fireworks/models/blocked-model" },
      { slot: "sonnet", model: "example-latest" },
      { slot: "haiku", model: "other-model-fast[1m]" },
    ], CATALOG);
    assert.deepEqual(blocked, [
      { slot: "main", model: "blocked-model" },
      { slot: "haiku", model: "other-model-fast" },
    ]);
  });

  it("never reports models served outside the catalog", () => {
    const blocked = blockedConfiguredModels([
      { slot: "main", model: "auto" },
      { slot: "opus", model: "claude-opus-4-8" },
      { slot: "sonnet", model: "accounts/example-account/deployments/test-deployment" },
      { slot: "haiku", model: "gpt-example" },
    ], CATALOG, { servedOutsideCatalog: (id) => id.startsWith("gpt-") });
    assert.deepEqual(blocked, []);
  });

  it("reports nothing without a catalog to compare with", () => {
    assert.deepEqual(blockedConfiguredModels([{ slot: "main", model: "blocked-model" }], []), []);
  });
});

describe("configured spellings", () => {
  it("match their catalog ids, whichever harness wrote them", () => {
    const catalog = [{ id: "auto", shortId: "auto" }, ...CATALOG];
    const blocked = blockedConfiguredModels([
      { slot: "main", model: "nexus/auto" },        // Cursor
      { slot: "main", model: "nexus-auto" },        // Hermes
      { slot: "main", model: "fireworks/example-latest" }, // Copilot CLI
      { slot: "main", model: "fireworks/blocked-model" },
    ], catalog);
    assert.deepEqual(blocked, [{ slot: "main", model: "blocked-model" }]);
  });
});

describe("modelAccessReport", () => {
  it("says nothing was checked when nothing is configured", () => {
    cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(ALLOWED_ROWS));
    assert.equal(modelAccessReport([]).reason, "nothing-configured");
  });

  it("marks a catalog past its refresh interval as stale", (t) => {
    cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(ALLOWED_ROWS));
    const configured = [{ slot: "main", model: "blocked-model" }];
    assert.equal(modelAccessReport(configured).stale, false);
    const prior = process.env.NEXUS_CATALOG_TTL_MS;
    process.env.NEXUS_CATALOG_TTL_MS = "1";
    // Move the clock past the TTL: on a fast runner the cache write and this
    // read can land in the same millisecond, leaving the catalog 0ms old.
    const later = Date.now() + 1000;
    t.mock.method(Date, "now", () => later);
    try {
      const old = modelAccessReport(configured);
      assert.equal(old.stale, true);
      assert.match(formatBlockedModelsStatusNote("opencode", old.blocked, { asOf: staleCatalogDate(old) }),
        /\(per the model catalog from \d{4}-\d{2}-\d{2}; run `nexus model list --refresh` to recheck\)/);
    } finally {
      if (prior === undefined) delete process.env.NEXUS_CATALOG_TTL_MS; else process.env.NEXUS_CATALOG_TTL_MS = prior;
    }
  });

  it("an unchecked report gets a line of its own, so it doesn't read as all clear", () => {
    assert.match(formatModelAccessUncheckedNote({ checked: false, reason: "no-catalog" }), /not checked/);
    assert.match(formatModelAccessUncheckedNote({ checked: false, reason: "other-account" }), /another key/);
    assert.equal(formatModelAccessUncheckedNote({ checked: false, reason: "nothing-configured" }), "");
    assert.equal(formatModelAccessUncheckedNote({ checked: true, blocked: [] }), "");
  });

  it("is unchecked when nothing is cached (no network, no throw)", () => {
    cacheServerlessCatalogSnapshot(null);
    assert.deepEqual(modelAccessReport([{ slot: "main", model: "blocked-model" }]), {
      checked: false,
      reason: "no-catalog",
      catalogUpdatedAt: null,
      blocked: [],
    });
  });

  it("can't tell when the cache was fetched with another account's key", () => {
    cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(ALLOWED_ROWS), { apiKey: "fw_example_account_a" });
    const configured = [{ slot: "main", model: "blocked-model" }];
    assert.deepEqual(modelAccessReport(configured, { apiKey: "fw_example_account_b" }), {
      checked: false,
      reason: "other-account",
      catalogUpdatedAt: null,
      blocked: [],
    });
    const same = modelAccessReport(configured, { apiKey: "fw_example_account_a" });
    assert.equal(same.checked, true);
    assert.deepEqual(same.blocked, [{ slot: "main", model: "blocked-model" }]);
  });

  it("reads the catalog cached under the harness's home, not the shell's", async () => {
    const otherHome = await mkdtemp(path.join(os.tmpdir(), "fc-model-access-home-"));
    const prior = process.env.HOME;
    try {
      // The shell home has a catalog; the other home has none.
      cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(ALLOWED_ROWS));
      const configured = [{ slot: "main", model: "blocked-model" }];
      assert.equal(modelAccessReport(configured).checked, true);
      assert.equal(modelAccessReport(configured, { home: otherHome }).reason, "no-catalog");
      // Once the other home has its own catalog, that one is used.
      process.env.HOME = otherHome;
      cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot([
        mockServerlessModel({ id: "accounts/fireworks/models/blocked-model", display_name: "Now Allowed" }),
      ]));
      process.env.HOME = prior;
      assert.deepEqual(modelAccessReport(configured, { home: otherHome }).blocked, []);
    } finally {
      process.env.HOME = prior;
      await rm(otherHome, { recursive: true, force: true });
    }
  });

  it("compares with the cached catalog and says when it was fetched", () => {
    cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot(ALLOWED_ROWS));
    const report = modelAccessReport([
      { slot: "main", model: "blocked-model" },
      { slot: "picker", model: "example-model" },
    ]);
    assert.equal(report.checked, true);
    assert.match(report.catalogUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(report.blocked, [{ slot: "main", model: "blocked-model" }]);
  });
});

describe("copy", () => {
  it("--model errors name the account and the Model Access policy", () => {
    const message = modelNotAvailableMessage("accounts/fireworks/models/blocked-model");
    assert.match(message, /^Model "blocked-model" isn't in this account's model list\./);
    assert.match(message, /Check the spelling; if it's right, your organization's Model Access policy may block it\./);
    assert.match(message, /nexus model list --refresh/);
    assert.doesNotMatch(message, /serverless model/);
  });

  it("status notes say requests will fail and how to switch", () => {
    const note = formatBlockedModelsStatusNote("opencode", [{ slot: "main", model: "blocked-model" }]);
    assert.match(note, /^blocked-model isn't available to this account\./);
    assert.match(note, /Requests to it will fail\. Run `nexus opencode on` to switch to an allowed model\./);
    const many = formatBlockedModelsStatusNote("claude", [
      { slot: "sonnet", model: "blocked-model" },
      { slot: "haiku", model: "other-model-fast" },
    ]);
    assert.match(many, /^blocked-model \(sonnet\), other-model-fast \(haiku\) aren't available/);
  });
});

describe("pickReplacementModel", () => {
  it("offers auto only when the catalog's own rows list it", () => {
    const withAuto = [{ id: "auto", shortId: "auto" }, ...CATALOG];
    assert.equal(pickReplacementModel(withAuto), "auto");
    // No auto row (a residency the gateway blocks it for, say): a served model.
    assert.equal(pickReplacementModel(CATALOG), "example-latest");
  });

  it("prefers a plain -latest alias, then a model, and never a blocked one", () => {
    assert.equal(pickReplacementModel(CATALOG, { exclude: ["example-latest"] }), "example-model");
    const fastOnly = [{ id: "accounts/fireworks/routers/example-fast-latest", shortId: "example-fast-latest" },
      { id: "accounts/fireworks/models/example-model", shortId: "example-model" }];
    assert.equal(pickReplacementModel(fastOnly), "example-model");
  });

  it("offers nothing when the catalog has nothing to offer", () => {
    assert.equal(pickReplacementModel([]), "");
    assert.equal(pickReplacementModel([{ id: "accounts/fireworks/models/blocked-model", shortId: "blocked-model" }], {
      exclude: ["blocked-model"],
    }), "");
  });
});

describe("offerModelAccessSwitch", () => {
  const blocked = [{ slot: "main", model: "blocked-model" }];

  it("without a terminal, switches nothing and says how to switch", async () => {
    const notes = [];
    const switched = await offerModelAccessSwitch({
      harnessCommand: "opencode",
      blocked,
      replacement: "example-latest",
      note: (line) => notes.push(line),
    });
    assert.equal(switched, false);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /left your settings as they are/);
    assert.match(notes[0], /nexus opencode on --model example-latest/);
  });

  it("with nothing to switch to, says so and asks nothing", async () => {
    const notes = [];
    let asked = false;
    const switched = await offerModelAccessSwitch({
      harnessCommand: "opencode",
      blocked,
      replacement: "",
      note: (line) => notes.push(line),
      ask: async () => { asked = true; return true; },
    });
    assert.equal(switched, false);
    assert.equal(asked, false);
    assert.match(notes[0], /lists no model to switch to/);
  });

  it("an upgrade's quiet re-on still gets one short line", async () => {
    const notes = [];
    const switched = await offerModelAccessSwitch({
      ctx: { quiet: true }, harnessCommand: "opencode", blocked, replacement: "auto", note: (line) => notes.push(line),
    });
    assert.equal(switched, false);
    assert.deepEqual(notes, [
      "blocked-model isn't available to this account. Your organization's Model Access policy may block it. "
        + "To switch, run: nexus opencode on --model auto",
    ]);
  });

  it("switches only on a yes", async () => {
    const questions = [];
    const yes = await offerModelAccessSwitch({
      harnessCommand: "opencode",
      blocked,
      replacement: "auto",
      note: () => {},
      ask: async (question) => { questions.push(question); return true; },
    });
    assert.equal(yes, true);
    assert.deepEqual(questions, ["Switch it to auto?"]);

    const notes = [];
    for (const answer of [false, null]) {
      const switched = await offerModelAccessSwitch({
        harnessCommand: "opencode",
        blocked,
        replacement: "auto",
        note: (line) => notes.push(line),
        ask: async () => answer,
      });
      assert.equal(switched, false);
    }
    assert.ok(notes.some((line) => /Kept as is/.test(line)));
  });

  it("never throws, even when the prompt does", async () => {
    const switched = await offerModelAccessSwitch({
      harnessCommand: "opencode",
      blocked,
      replacement: "auto",
      note: () => {},
      ask: async () => { throw new Error("stdin closed"); },
    });
    assert.equal(switched, false);
  });

  it("does nothing when nothing is blocked", async () => {
    const notes = [];
    assert.equal(await offerModelAccessSwitch({
      harnessCommand: "opencode", blocked: [], replacement: "auto", note: (l) => notes.push(l),
    }), false);
    assert.deepEqual(notes, []);
  });
});

describe("probeModelServable and Model Access refusals", () => {
  async function probeWith(status, body) {
    const prior = process.env.NEXUS_TEST;
    delete process.env.NEXUS_TEST;
    try {
      return await probeModelServable("blocked-model", "fw_example", {
        fetchImpl: async () => new Response(body, { status }),
      });
    } finally {
      process.env.NEXUS_TEST = prior;
    }
  }

  it("a policy 403 means this account can't use the model", async () => {
    assert.equal(await probeWith(403, POLICY_403), false);
  });

  it("any other 403 is no verdict on the model", async () => {
    assert.equal(await probeWith(403, '{"error":"forbidden"}'), true);
    assert.equal(await probeWith(404, "Model not found"), false);
    assert.equal(await probeWith(200, "{}"), true);
  });
});
