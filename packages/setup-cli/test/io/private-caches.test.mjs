import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { cacheServerlessCatalogSnapshot, expireCatalogCache, scopedCacheFilePath, setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { setListPriceCacheRates } from "../../lib/pricing/list-price-cache.mjs";
import { refreshCodexStockModels, setCodexStockModelsForTests } from "../../lib/harnesses/codex/stock-models.mjs";
import { resolveServedModels } from "../../lib/harnesses/codex/usage/served-models.mjs";

/** Fills `codex-served-models.json` through its one writer, from a stubbed route. */
function persistServedModels() {
  const call = { key: "r1", responseId: "r1", signature: "1:0:1" };
  const row = { response_id: "r1", model_used: "example-model", billed_by: "fireworks", usage: { input: 1, cached: 0, output: 1 } };
  return resolveServedModels({
    sessions: [{ sessionId: "example-session", calls: [call] }],
    apiKey: ["fw", "example0000000000000000"].join("_"),
    home,
    env: { NEXUS_TEST: "1", NEXUS_SESSION_CALLS_BASE_URL: "http://127.0.0.1:9" },
    fetchImpl: async () => ({ ok: true, json: async () => ({ calls: [row], next_since: null }) }),
  });
}

let home;
let saved;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "private-caches-"));
  saved = Object.fromEntries(["HOME", "NEXUS_CACHE_DIR", "NEXUS_TEST", "NEXUS_TEST_CODEX_MODELS"].map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.NEXUS_CACHE_DIR = path.join(home, "cache");
  process.env.NEXUS_TEST = "1";
  process.env.NEXUS_TEST_CODEX_MODELS = JSON.stringify({ models: [{ slug: "gpt-example", display_name: "Example", visibility: "list" }] });
});
afterEach(async () => {
  setServerlessCatalogSnapshot(null);
  setListPriceCacheRates(null);
  setCodexStockModelsForTests(undefined);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

for (const [name, persist] of [
  ["catalog-cache.json", () => cacheServerlessCatalogSnapshot({ entries: [] })],
  ["list-price-cache.json", () => setListPriceCacheRates({}, { persist: true })],
  ["codex-stock-models.json", () => refreshCodexStockModels({ codexHome: path.join(home, ".codex") })],
  ["codex-served-models.json", persistServedModels],
]) {
  test(`${name} replaces a symlink leaf privately and leaves its target untouched`, { skip: process.platform === "win32" }, async () => {
    const file = scopedCacheFilePath(name);
    await mkdir(path.dirname(file), { recursive: true });
    const outside = path.join(home, "outside");
    await writeFile(outside, "unchanged");
    await symlink(outside, file);
    await persist();
    assert.equal((await lstat(file)).isSymbolicLink(), false);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.equal(await readFile(outside, "utf8"), "unchanged");
    if (name === "catalog-cache.json") {
      expireCatalogCache(home);
      assert.equal((await lstat(file)).mode & 0o777, 0o600);
      assert.equal(JSON.parse(await readFile(file, "utf8")).cachedAt, 0);
    }
  });

  test(`${name} quietly refuses an unsafe cache parent`, { skip: process.platform === "win32" }, async () => {
    const outside = path.join(home, "outside");
    await mkdir(outside);
    await mkdir(process.env.NEXUS_CACHE_DIR);
    await symlink(outside, path.dirname(scopedCacheFilePath(name)), "dir");
    await persist();
    assert.deepEqual(await readdir(outside), []);
  });

  test(`${name} allows a linked cache container without changing user directory modes`, { skip: process.platform === "win32" }, async () => {
    const outside = path.join(home, "outside");
    await mkdir(outside);
    await chmod(home, 0o770);
    await chmod(outside, 0o775);
    await symlink(outside, process.env.NEXUS_CACHE_DIR, "dir");
    await persist();
    const file = scopedCacheFilePath(name);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.equal((await lstat(path.dirname(file))).mode & 0o777, 0o700);
    assert.equal((await lstat(home)).mode & 0o777, 0o770);
    assert.equal((await lstat(outside)).mode & 0o777, 0o775);
  });
}
