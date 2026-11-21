import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runUpdateCheck } from "../../lib/system/update-check-runner.mjs";
import { readUpdateCache, updateLockPath, writeUpdateCache } from "../../lib/system/update-cache.mjs";

async function temp(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "nexus-update-runner-"));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test("update runner does nothing without a home", async () => {
  await runUpdateCheck({ home: "", fetchVersion: () => assert.fail("must not fetch without a home") });
});

test("update runner writes a successful check and releases its lock", async () => {
  await temp(async (home) => {
    await writeUpdateCache(home, { checkedAt: 0, pending: true, fetchFailed: true });
    await writeFile(updateLockPath(home), "");
    await runUpdateCheck({ home, now: () => 1234, fetchVersion: async (options) => {
      assert.deepEqual(options, { timeoutMs: 5000 });
      return "1.2.3";
    } });
    assert.deepEqual(readUpdateCache(home), { checkedAt: 1234, pending: true, fetchFailed: false, latestVersion: "1.2.3" });
    assert.equal(fs.existsSync(updateLockPath(home)), false);
  });
});

for (const empty of [false, true]) {
  test(`update runner records ${empty ? "a missing version" : "an offline failure"} without forgetting a known version`, async () => {
    await temp(async (home) => {
      await writeUpdateCache(home, { checkedAt: 0, latestVersion: "1.2.3" });
      await writeFile(updateLockPath(home), "");
      await runUpdateCheck({ home, now: () => 5678, fetchVersion: async () => {
        if (empty) return "";
        throw new Error("Offline fixture");
      } });
      assert.deepEqual(readUpdateCache(home), { checkedAt: 5678, latestVersion: "1.2.3", fetchFailed: true });
      assert.equal(fs.existsSync(updateLockPath(home)), false);
    });
  });
}

test("update runner swallows an unwritable cache and still releases its lock", async () => {
  await temp(async (home) => {
    await mkdir(path.dirname(updateLockPath(home)), { recursive: true });
    await writeFile(updateLockPath(home), "");
    await mkdir(path.join(home, ".nexus/update-check.json"));
    await runUpdateCheck({ home, now: () => 1234, fetchVersion: async () => "1.2.3" });
    assert.equal(fs.existsSync(updateLockPath(home)), false);
  });
});
