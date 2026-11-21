import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_MODEL_MAP } from "../../../lib/harnesses/claude-desktop/lineup.mjs";
import { createModelAccessRefresher, createShimServer } from "../../../lib/harnesses/claude-desktop/shim.mjs";

const PROFILE_KEY = "fw_example_profile_key_000000000";
const POLICY_BODY = JSON.stringify({
  error: {
    object: "error",
    type: "invalid_request_error",
    message: "Your account's model-access policy does not allow serverless inference for model "
      + "accounts/fireworks/models/blocked-model",
  },
});

/**
 * A shim in front of an upstream that answers every turn with `status` and
 * `body`; resolves the URL to post to and a teardown.
 */
async function shimWithUpstream({ status, body, onModelAccessDenied, respond }) {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (respond) return respond(res);
      res.writeHead(status, { "content-type": "application/json", "x-request-id": "example-request" });
      res.end(body);
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const catalogDir = await mkdtemp(path.join(tmpdir(), "fc-shim-catalog-"));
  const server = createShimServer({
    modelMap: DEFAULT_MODEL_MAP,
    catalogDir,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    legacyGatewayKeyLoader: async () => PROFILE_KEY,
    onModelAccessDenied,
    log: () => {},
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    post: (headers = {}) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": PROFILE_KEY, ...headers },
      body: JSON.stringify({ model: "claude-sonnet-4-8", messages: [] }),
    }),
    async close() {
      await new Promise((r) => server.close(r));
      await new Promise((r) => upstream.close(r));
      await rm(catalogDir, { recursive: true, force: true });
    },
  };
}

test("shim passes a Model Access 403 through unchanged and asks for a catalog refresh", async () => {
  const denied = [];
  const shim = await shimWithUpstream({
    status: 403,
    body: POLICY_BODY,
    onModelAccessDenied: (args) => denied.push(args),
  });
  try {
    const res = await shim.post();
    assert.equal(res.status, 403);
    assert.equal(await res.text(), POLICY_BODY);
    assert.equal(res.headers.get("x-request-id"), "example-request");
    await new Promise((r) => setImmediate(r));
    // The refresh uses the key the turn was sent with, never a logged value.
    assert.deepEqual(denied, [{ apiKey: PROFILE_KEY }]);
  } finally {
    await shim.close();
  }
});

test("shim does not refresh the catalog for other 403s or for clients that aren't Desktop", async () => {
  const denied = [];
  const other = await shimWithUpstream({
    status: 403,
    body: '{"error":{"message":"forbidden"}}',
    onModelAccessDenied: (args) => denied.push(args),
  });
  try {
    const res = await other.post();
    assert.equal(res.status, 403);
    assert.equal(await res.text(), '{"error":{"message":"forbidden"}}');
  } finally {
    await other.close();
  }
  const policy = await shimWithUpstream({
    status: 403,
    body: POLICY_BODY,
    onModelAccessDenied: (args) => denied.push(args),
  });
  try {
    // A caller with some other key still gets the gateway's answer, but
    // can't make the shim spend a listing on it.
    const res = await policy.post({ "x-api-key": "fw_example_other_key_0000000000" });
    assert.equal(res.status, 403);
    assert.equal(await res.text(), POLICY_BODY);
  } finally {
    await policy.close();
  }
  assert.deepEqual(denied, []);
});

test("shim streams a 403 body byte for byte, invalid UTF-8 included", async () => {
  const denied = [];
  const bytes = Buffer.concat([Buffer.from(POLICY_BODY.slice(0, -2)), Buffer.from([0xff, 0xfe]), Buffer.from("}}")]);
  const shim = await shimWithUpstream({ status: 403, body: bytes, onModelAccessDenied: (args) => denied.push(args) });
  try {
    const res = await shim.post();
    assert.equal(res.status, 403);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
    await new Promise((r) => setImmediate(r));
    assert.equal(denied.length, 1);
  } finally {
    await shim.close();
  }
});

test("shim sends a 403's headers before its body ends", async () => {
  let finish;
  const shim = await shimWithUpstream({
    respond: (res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.write(POLICY_BODY.slice(0, 20));
      finish = () => res.end(POLICY_BODY.slice(20));
    },
  });
  try {
    // Headers arrive while the upstream body is still open.
    const res = await shim.post();
    assert.equal(res.status, 403);
    finish();
    assert.equal(await res.text(), POLICY_BODY);
  } finally {
    await shim.close();
  }
});

test("Model Access refresher: one listing per burst, again after the interval", async () => {
  let clock = 0;
  const refreshed = [];
  let release;
  const refresher = createModelAccessRefresher({
    refresh: (apiKey) => { refreshed.push(apiKey); return new Promise((r) => { release = r; }); },
    minIntervalMs: 60_000,
    now: () => clock,
    log: () => {},
    env: {},
  });
  refresher({ apiKey: "fw_example" });
  refresher({ apiKey: "fw_example" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(refreshed, ["fw_example"]);
  release();
  await new Promise((r) => setImmediate(r));
  clock = 30_000;
  refresher({ apiKey: "fw_example" });
  await new Promise((r) => setImmediate(r));
  assert.equal(refreshed.length, 1);
  clock = 61_000;
  refresher({ apiKey: "fw_example" });
  await new Promise((r) => setImmediate(r));
  assert.equal(refreshed.length, 2);
  release();
  // No key: nothing to refresh with.
  clock = 200_000;
  refresher({});
  await new Promise((r) => setImmediate(r));
  assert.equal(refreshed.length, 2);
});

test("Model Access refresher never throws when the refresh fails", async () => {
  const refresher = createModelAccessRefresher({
    refresh: async () => { throw new Error("offline"); },
    log: () => {},
    env: {},
  });
  assert.doesNotThrow(() => refresher({ apiKey: "fw_example" }));
  await new Promise((r) => setImmediate(r));
});

test("Model Access refresher does nothing under the test runner or when switched off", async () => {
  for (const env of [{ NEXUS_TEST: "1" }, { NEXUS_CATALOG_REFRESH_ON_DENIAL: "0" }]) {
    const refreshed = [];
    const refresher = createModelAccessRefresher({ refresh: async (key) => refreshed.push(key), log: () => {}, env });
    refresher({ apiKey: "fw_example" });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(refreshed, [], JSON.stringify(env));
  }
});

test("a saved custom model is listed only while the catalog serves it", async () => {
  const { isCustomModelOffered } = await import("../../../lib/harnesses/claude-desktop/lineup.mjs");
  const custom = { shortId: "blocked-model", name: "claude-example-custom" };
  assert.equal(isCustomModelOffered(custom, [{ shortId: "example-model" }]), false);
  assert.equal(isCustomModelOffered(custom, [{ shortId: "blocked-model" }]), true);
  // No catalog to go by: keep listing it.
  assert.equal(isCustomModelOffered(custom, []), true);
});

/** A shim line-up loader over temp files: catalog cache, signed catalog, saved customs. */
async function lineupFixture() {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { createLineupLoader } = await import("../../../lib/harnesses/claude-desktop/shim.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "fc-shim-lineup-"));
  const modelsCachePath = path.join(root, "catalog-cache.json");
  const catalogDir = path.join(root, "claude-desktop", "catalog");
  const manualPath = path.join(root, "claude-desktop", "manual-models.json");
  await mkdir(catalogDir, { recursive: true });
  await writeFile(path.join(catalogDir, "catalog.json"), JSON.stringify({ surfaces: { chat: { model_selector_config: [{ models: [
    { id: "claude-opus-4-8" }, { id: "claude-sonnet-4-8" }, { id: "claude-opus-4-5" },
  ] }] } } }));
  const loader = createLineupLoader({ modelsCachePath, catalogDir, fallback: () => ({ modelMap: {}, models: [] }) });
  const custom = { shortId: "example-model", name: "claude-opus-4-5", label: "Example Model", tier: "opus" };
  return {
    loader,
    custom,
    writeCache: (entries) => writeFile(modelsCachePath, JSON.stringify({ cachedAt: Date.now(), snapshot: { entries } })),
    saveCustoms: async (list) => {
      await writeFile(manualPath, JSON.stringify(list));
      // A distinct mtime from the first read, as a later `on` would leave.
      const { utimes } = await import("node:fs/promises");
      const later = new Date(Date.now() + 5000);
      await utimes(manualPath, later, later);
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("a custom model saved after the line-up was cached shows up without a catalog change", async () => {
  const f = await lineupFixture();
  try {
    await f.writeCache([{ id: "accounts/fireworks/models/example-model", shortId: "example-model" }]);
    const before = await f.loader();
    assert.ok(!before.models.some((m) => m.name === f.custom.name));
    await f.saveCustoms([f.custom]);
    const after = await f.loader();
    assert.ok(after.models.some((m) => m.name === f.custom.name));
    assert.deepEqual(after.customs, [f.custom]);
  } finally {
    await f.cleanup();
  }
});

test("with no catalog cached, saved custom models stay listed", async () => {
  const f = await lineupFixture();
  try {
    await f.saveCustoms([f.custom]);
    // No catalog-cache.json: the loader only adds `auto`, which says nothing
    // about the saved models.
    const lineup = await f.loader();
    assert.ok(lineup.models.some((m) => m.name === f.custom.name));
  } finally {
    await f.cleanup();
  }
});
