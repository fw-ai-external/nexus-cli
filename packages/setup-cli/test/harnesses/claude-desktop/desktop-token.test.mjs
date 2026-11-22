import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { promisify } from "node:util";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { createDesktopToken, ensureDesktopToken, desktopTokenPath, isDesktopToken, readDesktopToken } from "../../../lib/harnesses/claude-desktop/desktop-token.mjs";
import { createStoredGatewayKeyLoader, readServiceGatewayKey, selectDesktopCredential, shimKeyEnvironment } from "../../../lib/harnesses/claude-desktop/gateway-key.mjs";
import { createGatewayKeyLoader, createShimServer } from "../../../lib/harnesses/claude-desktop/shim.mjs";
import { claudeDesktopProfileUsesToken, disableProfileLane, enableProfileLane, readClaudeDesktopProfileKey, readProfileState, refreshClaudeDesktopGatewayKey } from "../../../lib/harnesses/claude-desktop/profile-lane.mjs";
import { thirdPartyDir } from "../../../lib/harnesses/claude-desktop/lineup.mjs";
import desktop from "../../../lib/harnesses/claude-desktop/index.mjs";
import { persistApiKeyToKeychain } from "../../../lib/keys/api-key.mjs";
import { getSecret } from "../../../lib/keys/secret-store.mjs";
import { cacheServerlessCatalogSnapshot, readCatalogCache } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import { seedKeychainConfig, seedServerlessCatalogCache, withoutEnvFireworksKey } from "../../helpers.mjs";

const key = "fw_example_stored_key";
async function fixture(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "desktop-token-"));
  const dataDir = path.join(home, ".nexus/claude-desktop");
  const priorEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  try {
    await mkdir(path.join(dataDir, "catalog"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(dataDir, "catalog/catalog.json"), "{}");
    await fn(home, dataDir);
  }
  finally {
    for (const [name, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
async function close(server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }

test("Desktop token creation has one concurrent winner, stays private and is separate from health identity", async () => {
  await fixture(async (_home, dataDir) => {
    const tokens = await Promise.all(Array.from({ length: 32 }, () => ensureDesktopToken(dataDir)));
    assert.equal(new Set(tokens).size, 1);
    assert.equal(isDesktopToken(tokens[0]), true);
    assert.equal(await readDesktopToken(dataDir), tokens[0]);
    if (process.platform !== "win32") {
      assert.equal((await lstat(dataDir)).mode & 0o777, 0o700);
      assert.equal((await lstat(desktopTokenPath(dataDir))).mode & 0o777, 0o600);
      await chmod(desktopTokenPath(dataDir), 0o644);
      assert.equal(await ensureDesktopToken(dataDir), tokens[0]);
      assert.equal((await lstat(desktopTokenPath(dataDir))).mode & 0o777, 0o600);
    }
    await writeFile(path.join(dataDir, "shim-secret"), "a".repeat(64));
    assert.notEqual(await readDesktopToken(dataDir), await readFile(path.join(dataDir, "shim-secret"), "utf8"));
  });
});

test("missing, corrupt and linked token files are not accepted", async () => {
  await fixture(async (home, dataDir) => {
    assert.equal(await readDesktopToken(dataDir), null);
    await mkdir(dataDir, { recursive: true });
    for (const value of ["", "invalid", `nexus-claude-desktop-${"A".repeat(64)}`, `nexus-claude-desktop-${"a".repeat(63)}`, `nexus-desktop-${"a".repeat(64)}`]) {
      await writeFile(desktopTokenPath(dataDir), value);
      assert.equal(await readDesktopToken(dataDir), null);
    }
    await assert.rejects(ensureDesktopToken(dataDir), /token file is invalid/);
    if (process.platform !== "win32") {
      await rm(desktopTokenPath(dataDir));
      const outside = path.join(home, "outside");
      await writeFile(outside, `nexus-claude-desktop-${"b".repeat(64)}`);
      await symlink(outside, desktopTokenPath(dataDir));
      assert.equal(await readDesktopToken(dataDir), null);
      await assert.rejects(ensureDesktopToken(dataDir));
      assert.equal(await readFile(outside, "utf8"), `nexus-claude-desktop-${"b".repeat(64)}`);
    }
  });
});

test("concurrent credential creation has one winner and keeps only a private key fingerprint", async () => {
  await fixture(async (home, dataDir) => {
    const select = () => selectDesktopCredential({ home, dataDir, key, readServiceKey: async () => key });
    const tokens = await Promise.all(Array.from({ length: 32 }, select));
    assert.equal(new Set(tokens).size, 1);
    assert.equal(await readDesktopToken(dataDir), tokens[0]);
    const fingerprint = path.join(dataDir, "claude-desktop-key-fingerprint");
    assert.match(await readFile(fingerprint, "utf8"), /^[0-9a-f]{64}\n$/);
    if (process.platform !== "win32") assert.equal((await lstat(fingerprint)).mode & 0o777, 0o600);
    const next = await select();
    assert.equal(next, tokens[0]);
    assert.equal(await readDesktopToken(dataDir), next);
    if (process.platform !== "win32") assert.equal((await lstat(desktopTokenPath(dataDir))).mode & 0o777, 0o600);
  });
});

test("repeat enable keeps the token; off revokes it and the next enable and key refresh issue fresh tokens", async () => {
  await fixture(async (home, dataDir) => {
    await seedKeychainConfig(home, key);
    let currentKey = key;
    const seen = [];
    const upstream = http.createServer((req, res) => { seen.push(req.headers.authorization); req.resume(); res.end("{}"); });
    await listen(upstream);
    const shim = createShimServer({
      upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, catalogDir: home, log: () => {},
      gatewayKeyLoader: createGatewayKeyLoader({ dataDir }), storedGatewayKeyLoader: async () => currentKey,
    });
    await listen(shim);
    const post = (token) => fetch(`http://127.0.0.1:${shim.address().port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": token }, body: "{}",
    });
    try {
      await withoutEnvFireworksKey(async () => {
        const enable = () => enableProfileLane(home, { allowSystemChanges: false, log: () => {}, readServiceKey: async () => currentKey });
        await enable();
        const first = await readDesktopToken(dataDir);
        const fingerprintPath = path.join(dataDir, "claude-desktop-key-fingerprint");
        const fingerprint = await readFile(fingerprintPath, "utf8");
        assert.equal((await post(first)).status, 200);
        await enable();
        const second = await readDesktopToken(dataDir);
        assert.equal(second, first);
        assert.equal(await readFile(fingerprintPath, "utf8"), fingerprint);
        assert.equal((await post(first)).status, 200);
        await disableProfileLane(home, { allowSystemChanges: false, log: () => {} });
        assert.equal(await readDesktopToken(dataDir), null);
        await assert.rejects(lstat(fingerprintPath), { code: "ENOENT" });
        const beforeRevoked = seen.length;
        const stale = await post(second);
        assert.equal(stale.status, 401);
        assert.match((await stale.json()).error.message, /Quit and reopen Claude Desktop/);
        assert.equal(seen.length, beforeRevoked);
        await enable();
        const third = await readDesktopToken(dataDir);
        assert.notEqual(third, second);
        assert.equal((await post(second)).status, 401);
        assert.equal((await post(third)).status, 200);
        const { setSecret } = await import("../../../lib/keys/secret-store.mjs");
        currentKey = "fw_example_rotated_key";
        await setSecret(currentKey, home);
        const refresh = () => refreshClaudeDesktopGatewayKey({ home, fireworksKey: currentKey, readServiceKey: async () => currentKey });
        assert.equal(await refresh(), true);
        const fourth = await readDesktopToken(dataDir);
        assert.notEqual(fourth, third);
        assert.equal((await post(third)).status, 401);
        assert.equal((await post(fourth)).status, 200);
        assert.equal(await refresh(), false);
        assert.equal(await readDesktopToken(dataDir), fourth);
        const refreshedKey = currentKey;
        currentKey = "fw_example_next_key";
        await setSecret(currentKey, home);
        await enable();
        const fifth = await readDesktopToken(dataDir);
        assert.notEqual(fifth, fourth);
        assert.equal((await post(fourth)).status, 401);
        assert.equal((await post(fifth)).status, 200);
        assert.deepEqual(seen, [`Bearer ${key}`, `Bearer ${key}`, `Bearer ${key}`, `Bearer ${refreshedKey}`, `Bearer ${currentKey}`]);
      });
    } finally { await close(shim); await close(upstream); }
  });
});

test("off without profile state revokes orphaned credentials and remains idempotent", async () => {
  await fixture(async (home, dataDir) => {
    await selectDesktopCredential({ home, dataDir, key, readServiceKey: async () => key });
    const fingerprintPath = path.join(dataDir, "claude-desktop-key-fingerprint");
    assert.equal(isDesktopToken(await readDesktopToken(dataDir)), true);
    assert.equal(await desktop.off({ home, quiet: true }), "none");
    await assert.rejects(lstat(desktopTokenPath(dataDir)), { code: "ENOENT" });
    await assert.rejects(lstat(fingerprintPath), { code: "ENOENT" });
    assert.equal(await desktop.off({ home, quiet: true }), "none");
  });
});

for (const catalogState of ["cold", "loaded", "other-key"]) {
  test(`explicit Desktop model rejection reports the cause with a ${catalogState} catalog`, async (t) => {
    await fixture(async (home, dataDir) => {
      await seedKeychainConfig(home, key);
      if (catalogState !== "cold") seedServerlessCatalogCache(home, []);
      if (catalogState === "other-key") {
        cacheServerlessCatalogSnapshot(readCatalogCache().snapshot, { apiKey: "fw_example_previous_key" });
      }
      const fetch = globalThis.fetch;
      t.mock.method(globalThis, "fetch", (url, options) => String(url).includes("/v1/serverless/models")
        ? Promise.resolve(new Response("Catalog unavailable", { status: 500 }))
        : fetch(url, options));
      await withoutEnvFireworksKey(async () => {
        await assert.rejects(enableProfileLane(home, {
          model: "example-model", allowSystemChanges: false, log: () => {}, readServiceKey: async () => key,
        }), catalogState === "loaded"
          ? /Model "example-model" isn't in this account's model list/
          : catalogState === "other-key"
            ? /Couldn't fetch the Fireworks model catalog\. Fireworks API 500.*Catalog unavailable.*cached copy was fetched with another key/
            : /Couldn't fetch the Fireworks model catalog and no cached copy exists yet\. Fireworks API 500.*Catalog unavailable/);
      });
      assert.equal(await readProfileState(home), null);
      assert.equal(await readDesktopToken(dataDir), null);
      await assert.rejects(lstat(path.join(dataDir, "manual-models.json")), { code: "ENOENT" });
    });
  });
}

test("an invalid repeat enable leaves the original profile and token authenticated", async () => {
  await fixture(async (home, dataDir) => {
    await seedKeychainConfig(home, key);
    const upstream = http.createServer((req, res) => { req.resume(); res.end("{}"); });
    await listen(upstream);
    const shim = createShimServer({
      upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, catalogDir: home, log: () => {},
      gatewayKeyLoader: createGatewayKeyLoader({ dataDir }), storedGatewayKeyLoader: async () => key,
    });
    await listen(shim);
    try {
      await withoutEnvFireworksKey(async () => {
        const options = { allowSystemChanges: false, log: () => {}, readServiceKey: async () => key };
        await enableProfileLane(home, options);
        const token = await readDesktopToken(dataDir);
        const { profileId } = await readProfileState(home);
        const file = path.join(thirdPartyDir(home), "configLibrary", `${profileId}.json`);
        const before = await readFile(file, "utf8");
        const fingerprint = await readFile(path.join(dataDir, "claude-desktop-key-fingerprint"), "utf8");
        const post = () => fetch(`http://127.0.0.1:${shim.address().port}/v1/messages`, {
          method: "POST", headers: { "content-type": "application/json", "x-api-key": token }, body: "{}",
        });
        assert.equal((await post()).status, 200);
        const changedKey = "fw_example_changed_key";
        const { setSecret } = await import("../../../lib/keys/secret-store.mjs");
        await setSecret(changedKey, home);
        seedServerlessCatalogCache(home, []);
        await assert.rejects(enableProfileLane(home, {
          ...options, model: "example-invalid-model", readServiceKey: async () => changedKey,
        }), /isn't in this account's model list/);
        assert.equal(await readFile(file, "utf8"), before);
        assert.equal(await readDesktopToken(dataDir), token);
        assert.equal(await readFile(path.join(dataDir, "claude-desktop-key-fingerprint"), "utf8"), fingerprint);
        assert.equal((await post()).status, 200);
      });
    } finally { await close(shim); await close(upstream); }
  });
});

test("failed profile writes never publish a candidate token and failed credential publication restores the profile", async () => {
  await fixture(async (home, dataDir) => {
    const options = { home, dataDir, key, readServiceKey: async () => key };
    const original = await selectDesktopCredential(options);
    const fingerprintPath = path.join(dataDir, "claude-desktop-key-fingerprint");
    const fingerprint = await readFile(fingerprintPath, "utf8");
    await assert.rejects(selectDesktopCredential({ ...options, rotate: true, writeProfile: async (candidate) => {
      assert.notEqual(candidate, original);
      assert.equal(await readDesktopToken(dataDir), original);
      throw new Error("profile write failed");
    } }), /profile write failed/);
    assert.equal(await readDesktopToken(dataDir), original);
    assert.equal(await readFile(fingerprintPath, "utf8"), fingerprint);
    if (process.platform !== "win32") {
      const file = path.join(home, "profile.json");
      await writeFile(file, original, { mode: 0o600 });
      await assert.rejects(selectDesktopCredential({ ...options, rotate: true, writeProfile: async (candidate) => {
        await writeFile(file, candidate);
        await rm(fingerprintPath);
        await mkdir(fingerprintPath);
        return async () => {
          await writeFile(file, original);
          await rm(fingerprintPath, { recursive: true });
          await writeFile(fingerprintPath, fingerprint, { mode: 0o600 });
        };
      } }), /EISDIR|EEXIST|ENOTEMPTY/);
      assert.equal(await readFile(file, "utf8"), original);
      assert.equal(await readDesktopToken(dataDir), original);
      assert.equal(await readFile(fingerprintPath, "utf8"), fingerprint);
    }
  });
});

test("service key reads use the service environment, not shell storage overrides or its key cache", async () => {
  await fixture(async (home) => {
    const env = shimKeyEnvironment(home, { env: { KEYRING_FILE_MASTER_KEY: "a".repeat(64), NEXUS_KEY_STORAGE: "null", NEXUS_SECRET_STORE: "memory", XDG_DATA_HOME: "/example/data" } });
    for (const name of ["KEYRING_FILE_MASTER_KEY", "NEXUS_KEY_STORAGE", "NEXUS_SECRET_STORE", "XDG_DATA_HOME"]) assert.equal(env[name], undefined);
    const module = new URL("../../../lib/keys/secret-store.mjs", import.meta.url).href;
    const script = `const {setSecret}=await import(${JSON.stringify(module)}); await setSecret(${JSON.stringify(key)},process.env.HOME);`;
    const run = promisify(execFile);
    const writer = { ...env, NEXUS_KEY_STORAGE: "file" };
    await run(process.execPath, ["--input-type=module", "-e", script], { env: writer, timeout: 15000 });
    assert.equal(await readServiceGatewayKey(home), key);
    await rm(path.join(home, ".local/share/keyring/secrets.json"));
    await run(process.execPath, ["--input-type=module", "-e", script], { env: { ...writer, KEYRING_FILE_MASTER_KEY: "a".repeat(64) }, timeout: 15000 });
    assert.equal(await readServiceGatewayKey(home), "");
    const notes = [];
    assert.equal(await selectDesktopCredential({ home, dataDir: path.join(home, ".nexus/claude-desktop"), key, warn: (note) => notes.push(note) }), key);
    assert.match(notes[0], /using the real key because the background shim can't unlock key storage/);
    assert.equal(await readServiceGatewayKey(home, { run: async () => { throw new Error("unavailable"); } }), "");
    assert.equal(await readServiceGatewayKey(home, {
      timeoutMs: 30,
      run: (_file, _args, options) => run(process.execPath, ["-e", "setInterval(()=>{},1000)"], options),
    }), "");
  });
});

test("stored key loader retains successful reads without expiry and retries empty results shortly", async () => {
  await fixture(async (home) => {
    let calls = 0, time = 0, value = key;
    const loader = createStoredGatewayKeyLoader({ home, now: () => time, readKey: async () => { calls++; return value; } });
    assert.deepEqual(await Promise.all([loader(), loader(), loader()]), [key, key, key]);
    assert.equal(calls, 1);
    value = "fw_example_rotated_key";
    assert.equal(await loader(), key);
    time = 24 * 3600_000;
    assert.equal(await loader(), key);
    assert.equal(calls, 1);
    loader.invalidate(key);
    assert.equal(await loader(), value);
    loader.invalidate("fw_example_older_key");
    assert.equal(await loader(), value);
    assert.equal(calls, 2);
    loader.invalidate(value);
    value = "";
    assert.equal(await loader(), "");
    value = key; time += 999;
    assert.equal(await loader(), "");
    time += 2;
    assert.equal(await loader(), key);
    const broken = createStoredGatewayKeyLoader({ home, readKey: async () => { throw new Error("locked"); } });
    assert.equal(await broken(), "");
  });
});

test("a real login store changes the config stamp and reloads the shim key", async () => {
  await fixture(async (home) => {
    await seedKeychainConfig(home, key);
    let calls = 0;
    const loader = createStoredGatewayKeyLoader({ home, readKey: async () => { calls++; return getSecret(home, { fresh: true }); } });
    assert.equal(await loader(), key);
    const configPath = path.join(home, ".nexus/config.json");
    const before = await lstat(configPath);
    const rotated = "fw_example_login_rotated_key";
    await persistApiKeyToKeychain(home, rotated, { onNote: () => {} });
    const after = await lstat(configPath);
    assert.notDeepEqual([after.ino, after.mtimeMs, after.ctimeMs], [before.ino, before.mtimeMs, before.ctimeMs]);
    assert.equal(await loader(), rotated);
    assert.equal(calls, 2);
  });
});

test("a config change supersedes an in-flight read without accepting its late key", async () => {
  await fixture(async (home) => {
    let finish, started;
    const ready = new Promise((resolve) => { started = resolve; });
    const oldRead = new Promise((resolve) => { finish = resolve; });
    let calls = 0;
    const loader = createStoredGatewayKeyLoader({ home, readKey: () => { if (++calls === 1) { started(); return oldRead; } return key; } });
    const first = loader();
    await ready;
    await writeFile(path.join(home, ".nexus/config.json"), "{}");
    assert.equal(await loader(), key);
    finish("fw_example_stale_key");
    assert.equal(await first, "");
    assert.equal(await loader(), key);
    assert.equal(calls, 2);
  });
});

test("only a token-authenticated upstream 401 refreshes a cached key and retries at most once", async () => {
  await fixture(async (home, dataDir) => {
    const token = await ensureDesktopToken(dataDir);
    let stored = key, accepted = key, calls = 0;
    const seen = [];
    const upstream = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      req.resume(); res.writeHead(req.headers.authorization === `Bearer ${accepted}` ? 200 : 401); res.end("{}");
    });
    await listen(upstream);
    const loader = createStoredGatewayKeyLoader({ home, now: () => 0, readKey: async () => { calls++; return stored; } });
    const shim = createShimServer({
      upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, catalogDir: home, log: () => {},
      gatewayKeyLoader: createGatewayKeyLoader({ dataDir }), storedGatewayKeyLoader: loader,
    });
    await listen(shim);
    const post = (credential = token) => fetch(`http://127.0.0.1:${shim.address().port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": credential }, body: "{}",
    });
    try {
      assert.equal((await post()).status, 200);
      assert.equal(calls, 1);
      stored = accepted = "fw_example_rotated_key";
      assert.equal((await post()).status, 200);
      assert.deepEqual(seen, [`Bearer ${key}`, `Bearer ${key}`, `Bearer ${stored}`]);
      assert.equal(calls, 2);
      assert.equal((await post()).status, 200);
      assert.equal(calls, 2);
      stored = "fw_example_rejected_key";
      accepted = "fw_example_unavailable_key";
      const before = seen.length;
      assert.equal((await post()).status, 401);
      assert.equal(seen.length, before + 2);
      assert.equal(calls, 3);
      assert.equal((await post("fw_example_legacy_key")).status, 401);
      assert.equal(calls, 3);
      stored = "";
      assert.equal((await post()).status, 401);
      assert.equal(calls, 4);
    } finally { await close(shim); await close(upstream); }
  });
});

test("unchanged-key upstream 401s recheck storage at most once per five minutes or config change", async () => {
  await fixture(async (home, dataDir) => {
    const token = await ensureDesktopToken(dataDir);
    let calls = 0, time = 0;
    const upstream = http.createServer((req, res) => { req.resume(); res.writeHead(401); res.end("{}"); });
    await listen(upstream);
    const loader = createStoredGatewayKeyLoader({ home, now: () => time, readKey: async () => { calls++; return key; } });
    const shim = createShimServer({
      upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, catalogDir: home, log: () => {},
      gatewayKeyLoader: createGatewayKeyLoader({ dataDir }), storedGatewayKeyLoader: loader,
    });
    await listen(shim);
    const post = () => fetch(`http://127.0.0.1:${shim.address().port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": token }, body: "{}",
    });
    try {
      assert.equal((await post()).status, 401);
      assert.equal(calls, 2);
      for (let i = 0; i < 20; i++) assert.equal((await post()).status, 401);
      assert.equal(calls, 2);
      time = 5 * 60_000 - 1;
      assert.equal((await post()).status, 401);
      assert.equal(calls, 2);
      time++;
      assert.equal((await post()).status, 401);
      assert.equal(calls, 3);
      await writeFile(path.join(home, ".nexus/config.json"), "{}");
      assert.equal((await post()).status, 401);
      assert.equal(calls, 5);
      assert.equal((await post()).status, 401);
      assert.equal(calls, 5);
    } finally { await close(shim); await close(upstream); }
  });
});

test("stored key loader uses the in-process secret store and invalidates on config changes", async () => {
  await fixture(async (home) => {
    await seedKeychainConfig(home, key);
    const loader = createStoredGatewayKeyLoader({ home });
    assert.equal(await loader(), key);
    const { setSecret } = await import("../../../lib/keys/secret-store.mjs");
    const rotated = "fw_example_rotated_key";
    await setSecret(rotated, home);
    assert.equal(await loader(), key);
    await writeFile(path.join(home, ".nexus/config.json"), JSON.stringify({ revision: "rotated" }));
    assert.equal(await loader(), rotated);
  });
});

test("timed-out reads release the memo and retry; a late value or rejection cannot replace a recovered key", async () => {
  await fixture(async (home) => {
    for (const outcome of ["resolve", "reject"]) {
      let finish, fail, calls = 0, time = 0;
      const stalled = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      const loader = createStoredGatewayKeyLoader({
        home, now: () => time, timeoutMs: 10,
        readKey: () => ++calls === 1 ? stalled : Promise.resolve(key),
      });
      assert.deepEqual(await Promise.all([loader(), loader()]), ["", ""]);
      assert.equal(calls, 1);
      time = 999;
      assert.equal(await loader(), "");
      assert.equal(calls, 1);
      time = 1001;
      assert.equal(await loader(), key);
      assert.equal(calls, 2);
      if (outcome === "resolve") finish("fw_example_stale_key"); else fail(new Error("late keyring failure"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await loader(), key);
      assert.equal(calls, 2);
    }
  });
});

test("stored key reads normalize empty and retired credentials and recover from synchronous errors", async () => {
  await fixture(async (home) => {
    for (const value of [null, undefined, "", "  ", "fpk_example", " fpk_example "]) {
      assert.equal(await createStoredGatewayKeyLoader({ home, readKey: () => value })(), "");
    }
    assert.equal(await createStoredGatewayKeyLoader({ home, readKey: () => ` ${key} ` })(), key);
    let calls = 0, time = 0;
    const loader = createStoredGatewayKeyLoader({ home, now: () => time, readKey: () => {
      if (++calls === 1) throw new Error("locked");
      return key;
    } });
    assert.equal(await loader(), "");
    time = 1001;
    assert.equal(await loader(), key);
  });
});

test("enable and refresh switch token and literal modes cleanly; status resolves the stored key and off restores bytes", async () => {
  await fixture(async (home, dataDir) => {
    await seedKeychainConfig(home, key);
    const lib = path.join(thirdPartyDir(home), "configLibrary");
    await mkdir(lib, { recursive: true });
    const original = '{"inferenceGatewayBaseUrl":"https://gateway.example.com"}\n';
    const meta = '{"appliedId":"original","entries":[{"id":"original"}]}\n';
    await writeFile(path.join(lib, "original.json"), original);
    await writeFile(path.join(lib, "_meta.json"), meta);
    await withoutEnvFireworksKey(async () => {
      await enableProfileLane(home, { allowSystemChanges: false, log: () => {}, readServiceKey: async () => key });
      const state = await readProfileState(home);
      const file = path.join(lib, `${state.profileId}.json`);
      const read = async () => JSON.parse(await readFile(file, "utf8"));
      const token = await readDesktopToken(dataDir);
      assert.equal((await read()).inferenceGatewayApiKey, token);
      assert.equal(isDesktopToken(token), true);
      assert.equal((await readFile(file, "utf8")).includes(key), false);
      assert.equal(await readClaudeDesktopProfileKey(home), key);
      // A token profile holds no key copy, so a rotation needn't wait for it.
      assert.equal(await claudeDesktopProfileUsesToken(home), true);
      await enableProfileLane(home, { allowSystemChanges: false, log: () => {}, readServiceKey: async () => key });
      assert.equal((await read()).inferenceGatewayApiKey, token);
      const notes = [];
      assert.equal(await refreshClaudeDesktopGatewayKey({ home, fireworksKey: key, readServiceKey: async () => "", warn: (note) => notes.push(note) }), true);
      assert.equal((await read()).inferenceGatewayApiKey, key);
      assert.equal(await claudeDesktopProfileUsesToken(home), false, "a literal profile holds a copy");
      assert.equal(notes.length, 1);
      assert.equal(await refreshClaudeDesktopGatewayKey({ home, fireworksKey: key, readServiceKey: async () => key }), true);
      assert.equal((await read()).inferenceGatewayApiKey, token);
      assert.equal(await refreshClaudeDesktopGatewayKey({ home, fireworksKey: key, readServiceKey: async () => key }), false);
      await disableProfileLane(home, { allowSystemChanges: false, log: () => {} });
      assert.equal(await claudeDesktopProfileUsesToken(home), false, "lane off");
      assert.equal(await readFile(path.join(lib, "original.json"), "utf8"), original);
      assert.equal(await readFile(path.join(lib, "_meta.json"), "utf8"), meta);
      await assert.rejects(lstat(desktopTokenPath(dataDir)), { code: "ENOENT" });
      await assert.rejects(lstat(path.join(dataDir, "claude-desktop-key-fingerprint")), { code: "ENOENT" });
    });
  });
});

test("a fake listener in place of the shim receives only the Desktop token", async () => {
  await fixture(async (home, dataDir) => {
    await seedKeychainConfig(home, key);
    const seen = [];
    const rogue = http.createServer((req, res) => { seen.push(req.headers["x-api-key"]); req.resume(); res.end("{}"); });
    await listen(rogue);
    try {
      await withoutEnvFireworksKey(() => enableProfileLane(home, { port: rogue.address().port, allowSystemChanges: false, log: () => {}, readServiceKey: async () => key }));
      const { profileId } = await readProfileState(home);
      const profile = JSON.parse(await readFile(path.join(thirdPartyDir(home), "configLibrary", `${profileId}.json`), "utf8"));
      await fetch(`${profile.inferenceGatewayBaseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": profile.inferenceGatewayApiKey }, body: "{}" });
      assert.deepEqual(seen, [await readDesktopToken(dataDir)]);
      assert.notEqual(seen[0], key);
    } finally { await close(rogue); }
  });
});

test("shim exchanges either token header for the stored key, retains provider attachment, and never forwards missing or corrupt tokens", async () => {
  await fixture(async (home, dataDir) => {
    const token = await ensureDesktopToken(dataDir);
    const seen = [];
    const upstream = http.createServer((req, res) => {
      seen.push({ authorization: req.headers.authorization, apiKey: req.headers["x-api-key"], provider: req.headers["x-anthropic-api-key"] });
      req.resume(); res.end("{}");
    });
    await listen(upstream);
    let available = key;
    const shim = createShimServer({
      upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, catalogDir: home, modelMap: { models: { example: "auto" } }, log: () => {},
      gatewayKeyLoader: createGatewayKeyLoader({ dataDir }), storedGatewayKeyLoader: async () => available,
      autoKeysLoader: async () => ({ anthropicKey: "sk-ant-example-key" }),
    });
    await listen(shim);
    const post = (headers) => fetch(`http://127.0.0.1:${shim.address().port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "example", messages: [] }),
    });
    try {
      assert.equal((await post({ "x-api-key": token })).status, 200);
      assert.equal((await post({ authorization: `Bearer ${token}` })).status, 200);
      assert.equal((await post({ "x-api-key": "fw_example_other_key", authorization: `Bearer ${token}` })).status, 200);
      for (const request of seen) assert.deepEqual(request, { authorization: `Bearer ${key}`, apiKey: undefined, provider: "sk-ant-example-key" });
      assert.equal((await post({ "x-api-key": "fw_example_legacy_key" })).status, 200);
      assert.deepEqual(seen.at(-1), { authorization: "Bearer fw_example_legacy_key", apiKey: undefined, provider: undefined });
      available = "";
      const unavailable = await post({ "x-api-key": token });
      assert.equal(unavailable.status, 401);
      assert.match((await unavailable.json()).error.message, /No stored Fireworks key/);
      await writeFile(desktopTokenPath(dataDir), "corrupt");
      assert.equal((await post({ authorization: `Bearer ${token}` })).status, 401);
      await rm(desktopTokenPath(dataDir));
      assert.equal((await post({ "x-api-key": token })).status, 401);
      assert.equal(seen.length, 4);
    } finally { await close(shim); await close(upstream); }
  });
});

// A crash between the profile write and the token
// file leaves a token the shim rejects; restarting the shim does not heal it,
// the next `on` or key refresh (key sync, upgrade migration) does.
test("a crash between credential writes is rejected until the next on or key refresh heals it", async () => {
  await fixture(async (home, dataDir) => {
    await seedKeychainConfig(home, key);
    const upstream = http.createServer((req, res) => { req.resume(); res.end("{}"); });
    await listen(upstream);
    const shims = [];
    try {
      await withoutEnvFireworksKey(async () => {
        const readServiceKey = async () => key;
        await enableProfileLane(home, { allowSystemChanges: false, log: () => {}, readServiceKey });
        const { profileId } = await readProfileState(home);
        const file = path.join(thirdPartyDir(home), "configLibrary", `${profileId}.json`);
        const profileToken = async () => JSON.parse(await readFile(file, "utf8")).inferenceGatewayApiKey;
        const setProfileToken = async (token) => writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), inferenceGatewayApiKey: token }));
        const fingerprintPath = path.join(dataDir, "claude-desktop-key-fingerprint");
        const post = async (token) => {
          const shim = createShimServer({
            upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, catalogDir: home, log: () => {},
            gatewayKeyLoader: createGatewayKeyLoader({ dataDir }), storedGatewayKeyLoader: async () => key,
          });
          shims.push(shim);
          await listen(shim);
          return (await fetch(`http://127.0.0.1:${shim.address().port}/v1/messages`, {
            method: "POST", headers: { "content-type": "application/json", "x-api-key": token }, body: "{}",
          })).status;
        };
        const refresh = () => refreshClaudeDesktopGatewayKey({ home, fireworksKey: key, readServiceKey });
        const crash = async (fingerprintWritten) => {
          const candidate = createDesktopToken();
          await setProfileToken(candidate);
          if (fingerprintWritten) await writeFile(fingerprintPath, `${createHmac("sha256", candidate).update(key).digest("hex")}\n`);
          assert.equal(await post(candidate), 401);
          assert.equal(await post(candidate), 401);
          return candidate;
        };
        for (const [fingerprintWritten, heal] of [[false, refresh], [true, refresh],
          [true, () => enableProfileLane(home, { allowSystemChanges: false, log: () => {}, readServiceKey })]]) {
          const before = await readDesktopToken(dataDir);
          const candidate = await crash(fingerprintWritten);
          await heal();
          const token = await profileToken();
          assert.equal(await readDesktopToken(dataDir), token);
          assert.equal(await post(token), 200);
          if (fingerprintWritten) assert.notEqual(token, before);
          else assert.equal(token, before);
          assert.notEqual(token, candidate);
        }
      });
    } finally { for (const shim of shims) await close(shim); await close(upstream); }
  });
});

// credentialUpdates serializes calls in one process only. Two processes (two
// `on`s, or `on` and a key sync) can each publish a different token; the next
// run sees the fingerprint mismatch and heals (DesktopCredentialTwoProcsRace).
test("two processes selecting a credential at once can leave a rejected token until the next run heals it", async () => {
  await fixture(async (home, dataDir) => {
    const other = await import("../../../lib/harnesses/claude-desktop/gateway-key.mjs?process=other");
    const readServiceKey = async () => key;
    let profile = null;
    const writeProfile = async (token) => { profile = token; };
    await selectDesktopCredential({ home, dataDir, key, readServiceKey, writeProfile: async (token) => {
      await other.selectDesktopCredential({ home, dataDir, key, readServiceKey, writeProfile });
      profile = token;
    } });
    assert.notEqual(await readDesktopToken(dataDir), profile);
    await other.selectDesktopCredential({ home, dataDir, key, readServiceKey, writeProfile });
    assert.equal(await readDesktopToken(dataDir), profile);
    await selectDesktopCredential({ home, dataDir, key, readServiceKey, writeProfile });
    assert.equal(await readDesktopToken(dataDir), profile);
  });
});

// ensureDesktopToken creates the file and then writes it; dying in between, or a
// failed write, leaves it empty (DesktopCredentialEmptyFile).
test("an empty token file left by an interrupted first create is replaced on the next on", async () => {
  await fixture(async (home, dataDir) => {
    await seedKeychainConfig(home, key);
    const upstream = http.createServer((req, res) => { req.resume(); res.end("{}"); });
    await listen(upstream);
    const shim = createShimServer({
      upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, catalogDir: home, log: () => {},
      gatewayKeyLoader: createGatewayKeyLoader({ dataDir }), storedGatewayKeyLoader: async () => key,
    });
    await listen(shim);
    try {
      await withoutEnvFireworksKey(async () => {
        const readServiceKey = async () => key;
        const post = async (token) => (await fetch(`http://127.0.0.1:${shim.address().port}/v1/messages`, {
          method: "POST", headers: { "content-type": "application/json", "x-api-key": token }, body: "{}",
        })).status;
        for (const empty of ["", " \n"]) {
          await mkdir(dataDir, { recursive: true });
          await writeFile(desktopTokenPath(dataDir), empty, { mode: 0o600 });
          await enableProfileLane(home, { allowSystemChanges: false, log: () => {}, readServiceKey });
          const { profileId } = await readProfileState(home);
          const token = JSON.parse(await readFile(path.join(thirdPartyDir(home), "configLibrary", `${profileId}.json`), "utf8")).inferenceGatewayApiKey;
          assert.ok(isDesktopToken(token));
          assert.equal(await readDesktopToken(dataDir), token);
          if (process.platform !== "win32") assert.equal((await lstat(desktopTokenPath(dataDir))).mode & 0o777, 0o600);
          assert.equal(await post(token), 200);
          await disableProfileLane(home, { allowSystemChanges: false, log: () => {} });
          await assert.rejects(lstat(desktopTokenPath(dataDir)), { code: "ENOENT" });
        }
      });
    } finally { await close(shim); await close(upstream); }
  });
});

test("a failed Desktop on puts back the residency the running shim was started with", async () => {
  const { recordedHarnessResidency, forgetAccountResidency } = await import("../../../lib/fireworks/residency.mjs");
  const priorResidency = process.env.NEXUS_TEST_RESIDENCY;
  await fixture(async (home) => {
    await seedKeychainConfig(home, key);
    seedServerlessCatalogCache(home, []);
    const options = { allowSystemChanges: false, log: () => {}, readServiceKey: async () => key };
    try {
      await withoutEnvFireworksKey(async () => {
        process.env.NEXUS_TEST_RESIDENCY = "";
        await enableProfileLane(home, options);
        assert.equal(recordedHarnessResidency("claude-desktop", home), "");

        // The account turned on US residency, but this `on` fails before the shim restarts.
        process.env.NEXUS_TEST_RESIDENCY = "US";
        await assert.rejects(
          enableProfileLane(home, { ...options, model: "example-invalid-model" }),
          /Model "example-invalid-model" isn't in this account's model list/,
        );
        assert.equal(recordedHarnessResidency("claude-desktop", home), "");

        await enableProfileLane(home, options);
        assert.equal(recordedHarnessResidency("claude-desktop", home), "US");
      });
    } finally {
      if (priorResidency === undefined) delete process.env.NEXUS_TEST_RESIDENCY;
      else process.env.NEXUS_TEST_RESIDENCY = priorResidency;
      forgetAccountResidency();
    }
  });
});
