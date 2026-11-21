import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { MAC_SECRET_UNREAD, MacKeychainAccessError, deleteMacSecret, readMacSecret, runSecurity, securityQuote, writeMacSecret } from "../../lib/keys/macos-security.mjs";
import { buildLaunchAgentPlist, stableNodeExec } from "../../lib/harnesses/claude-desktop/platform.mjs";

it("maps Homebrew Cellar nodes only when the opt binary exists", () => {
  for (const prefix of ["/opt/homebrew", "/usr/local"]) {
    const node = `${prefix}/Cellar/node@24/24.21.0/bin/node`;
    assert.equal(stableNodeExec(node, () => true), `${prefix}/opt/node@24/bin/node`);
    assert.equal(stableNodeExec(node, () => false), node);
  }
  assert.equal(stableNodeExec("/usr/bin/node", () => true), "/usr/bin/node");
  assert.equal(stableNodeExec("", () => true), "");
  assert.match(buildLaunchAgentPlist({ nodeExec: "/usr/bin/node", entry: "shim", home: "/home", logPath: "log", errorPath: "err" }), /<string>\/usr\/bin\/node<\/string>/u);
});

it("quotes literal interactive-parser arguments and rejects unsafe characters", () => {
  assert.equal(securityQuote("a b;$`&"), '"a b;$`&"');
  for (const value of ["a\nb", "a\rb", 'a"b', "a'b", "a\\b", "a\0b"]) {
    assert.throws(() => securityQuote(value), /cannot contain/u);
  }
});

it("writes the secret only to stdin, recreates the ACL and verifies readback", async () => {
  const calls = [];
  await writeMacSecret("service name", "account", "dummy-secret-xyz", {
    remove: async (...args) => calls.push(["delete", ...args]),
    run: async (args, options) => calls.push([args, options.input]),
    read: async () => "dummy-secret-xyz",
  });
  assert.deepEqual(calls, [
    ["delete", "service name", "account"],
    [["-i"], 'add-generic-password -U -s "service name" -a "account" -j "nexus-acl:security" -w "dummy-secret-xyz"\n'],
  ]);
});

it("does not delete on unsafe input and rejects failed verification", async () => {
  await assert.rejects(writeMacSecret("svc", "acct", "bad\nsecret", { remove: () => assert.fail("must not delete") }), /cannot contain/u);
  for (const options of [
    { run: async () => {}, read: async () => null },
    { run: async () => { throw Error("add failed"); } },
    { run: async () => {}, read: async () => { throw new MacKeychainAccessError(); } },
  ]) {
    await assert.rejects(writeMacSecret("svc", "acct", "secret", { remove: async () => {}, ...options }), /after deleting the old item.*nexus login/u);
  }
});

it("reads marked items through security with short timeouts, even on a TTY", async () => {
  const calls = [];
  const run = async (file, args, options) => {
    assert.equal(file, "/usr/bin/security");
    calls.push(args);
    assert.equal(options.timeout, 10000);
    return { stdout: args.includes("-w") ? "secret\n" : '    "icmt"<blob>="nexus-acl:security"\n' };
  };
  assert.equal(await readMacSecret("svc", "acct", { run, isTTY: true, migrate: false, nativeRead: () => assert.fail("must not use native") }), "secret");
  assert.deepEqual(calls, [
    ["find-generic-password", "-s", "svc", "-a", "acct"],
    ["find-generic-password", "-s", "svc", "-a", "acct", "-w"],
  ]);
});

it("returns null for metadata exit 44 without reading or migrating", async () => {
  assert.equal(await readMacSecret("svc", "acct", { run: async () => { throw { code: 44 }; }, nativeRead: () => assert.fail("must not migrate") }), null);
});

it("skips native reads of unmarked items when comparing before an overwrite", async () => {
  assert.equal(await readMacSecret("svc", "acct", {
    migrate: false, run: async (file, args) => {
      assert.ok(!args.includes("-w"));
      return { stdout: '"icmt"<blob>=<NULL>\n' };
    }, nativeRead: () => assert.fail("must not unlock the old item"), write: () => assert.fail("must not migrate"),
  }), MAC_SECRET_UNREAD);
});

for (const isTTY of [true, false, undefined]) {
  it(`reads unmarked items natively then migrates, with isTTY=${isTTY}`, async () => {
    const calls = [];
    const value = await readMacSecret("svc", "acct", {
      isTTY,
      run: async (file, args) => {
        assert.ok(!args.includes("-w"));
        calls.push(["metadata"]);
        return { stdout: '    "icmt"<blob>=<NULL>\n' };
      },
      nativeRead: async (...args) => { calls.push(["native", ...args]); return "secret"; },
      write: async (...args) => calls.push(["write", ...args]),
    });
    assert.equal(value, isTTY ? "secret" : MAC_SECRET_UNREAD);
    assert.deepEqual(calls, isTTY
      ? [["metadata"], ["native", "svc", "acct", { timeoutMs: 120000 }], ["write", "svc", "acct", "secret"]]
      : [["metadata"]]);
  });
}

it("surfaces access errors for denied, empty or failed native migration", async () => {
  for (const nativeRead of [null, async () => null, async () => { throw Error("denied"); }]) {
    await assert.rejects(readMacSecret("svc", "acct", { isTTY: true, run: async () => ({ stdout: "" }), nativeRead, write: () => assert.fail("must not write") }), MacKeychainAccessError);
  }
  for (const code of [128, 51, 36, "ETIMEDOUT"]) {
    await assert.rejects(readMacSecret("svc", "acct", {
      run: async () => { throw { code }; }, nativeRead: () => assert.fail("must not read native after metadata failure"),
    }), MacKeychainAccessError);
    await assert.rejects(readMacSecret("svc", "acct", {
      run: async (file, args) => {
        if (args.includes("-w")) throw { code };
        return { stdout: '"icmt"<blob>="nexus-acl:security"\n' };
      }, nativeRead: () => assert.fail("must not read native for marked item"),
    }), MacKeychainAccessError);
  }
  await assert.rejects(deleteMacSecret("svc", "acct", { run: async () => { throw { code: 36 }; } }), MacKeychainAccessError);
  await deleteMacSecret("svc", "acct", { run: async () => { throw { code: 44 }; } });
});

it("lets an interactive finalizer migrate before a noninteractive service probe", async () => {
  let marked = false;
  let nativeReads = 0;
  const options = {
    run: async (file, args) => ({ stdout: args.includes("-w") ? "secret\n" : marked ? '"icmt"<blob>="nexus-acl:security"\n' : "" }),
    nativeRead: async () => { nativeReads++; return "secret"; },
    write: async () => { marked = true; },
  };
  assert.equal(await readMacSecret("svc", "acct", { ...options, isTTY: false }), MAC_SECRET_UNREAD);
  assert.equal(await readMacSecret("svc", "acct", { ...options, isTTY: true }), "secret");
  assert.equal(await readMacSecret("svc", "acct", { ...options, isTTY: false }), "secret");
  assert.equal(nativeReads, 1);
});

it("restores the native item and returns its value if migration fails", async () => {
  const calls = [];
  assert.equal(await readMacSecret("svc", "acct", {
    isTTY: true, run: async () => ({ stdout: "" }), nativeRead: async () => "secret",
    write: async (...args) => { calls.push(["write", ...args]); throw Error("add or readback failed"); },
    restore: async (...args) => calls.push(["restore", ...args]),
  }), "secret");
  assert.deepEqual(calls, [["write", "svc", "acct", "secret"], ["restore", "svc", "acct", "secret"]]);
});

it("preserves the explicit login recovery error if migration and restoration fail", async () => {
  await assert.rejects(readMacSecret("svc", "acct", {
    isTTY: true, run: async () => ({ stdout: "" }), nativeRead: async () => "secret",
    write: async () => { throw Error("Re-run `nexus login` to restore the key."); },
    restore: async () => { throw Error("restore failed"); },
  }), /nexus login/u);
});

it("kills a hung interactive security subprocess on timeout", async () => {
  let killed = false;
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => { assert.equal(signal, "SIGKILL"); killed = true; };
  await assert.rejects(runSecurity(["-i"], { input: "command\n", timeoutMs: 5, spawnFn: (file, args) => {
    assert.equal(file, "/usr/bin/security");
    assert.deepEqual(args, ["-i"]);
    return child;
  } }), MacKeychainAccessError);
  assert.equal(killed, true);
});

it("keeps getSecret's return shape and reports its access error through Fireworks key resolution", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nexus-mac-denied-"));
  const loader = new URL("./fixtures/fake-cross-keychain.mjs", import.meta.url).href;
  const api = new URL("../../lib/keys/api-key.mjs", import.meta.url).href;
  const store = new URL("../../lib/keys/secret-store.mjs", import.meta.url).href;
  try {
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,import{register}from'node:module';register(${JSON.stringify(loader)});`, "--input-type=module", "-e", `
      const { getSecret, getLastSecretReadError } = await import(${JSON.stringify(store)});
      const { resolveStoredApiKeyValue } = await import(${JSON.stringify(api)});
      if (await getSecret(process.env.HOME) !== null) throw Error('Expected null');
      console.log(getLastSecretReadError().message);
      await resolveStoredApiKeyValue('{keychain:fireworks-api-key}', process.env.HOME);
    `], { encoding: "utf8", env: {
      ...process.env, HOME: home, NEXUS_TEST: "0", NEXUS_SECRET_STORE: "", NEXUS_KEY_STORAGE: "keychain",
      FAKE_KEYCHAIN: "denied", FAKE_KEYCHAIN_BACKEND: "native-macos",
    } });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /macOS Keychain access was denied or timed out/u);
    assert.match(result.stderr, /macOS Keychain access was denied or timed out/u);
    assert.doesNotMatch(result.stderr, /No Fireworks/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("login --with-token replaces an unmarked macOS item without a native read", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nexus-login-overwrite-"));
  const loader = new URL("./fixtures/fake-cross-keychain.mjs", import.meta.url).href;
  const cli = new URL("../../bin/nexus.mjs", import.meta.url).pathname;
  const log = path.join(home, "calls.log");
  try {
    await writeFile(path.join(home, "fake-keychain.json"), JSON.stringify({ "FireworksAI/fireworks-api-key": "old-dummy-key" }));
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,import{register}from'node:module';register(${JSON.stringify(loader)});`, cli, "login", "--with-token"], {
      input: "fw_replacement_test_key_000000000000\n", encoding: "utf8", timeout: 30000,
      env: { ...process.env, HOME: home, NEXUS_TEST: "0", NEXUS_NO_UPDATE_CHECK: "1", NEXUS_SECRET_STORE: "", NEXUS_KEY_STORAGE: "keychain",
        FAKE_KEYCHAIN: "working", FAKE_KEYCHAIN_BACKEND: "native-macos", FAKE_KEYCHAIN_UNMARKED: "1", FAKE_KEYCHAIN_LOG: log },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(log, "utf8")).trim(), "skipNativeRead");
    const store = JSON.parse(await readFile(path.join(home, "fake-keychain.json"), "utf8"));
    assert.equal(store["FireworksAI/fireworks-api-key"], "fw_replacement_test_key_000000000000");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("unknown unmarked keys preserve matching minted records but clear different, legacy or malformed records", async () => {
  const loader = new URL("./fixtures/fake-cross-keychain.mjs", import.meta.url).href;
  const api = new URL("../../lib/keys/api-key.mjs", import.meta.url).href;
  const mint = new URL("../../lib/keys/mint-api-key.mjs", import.meta.url).href;
  const key = "fw_minted_dummy_key_000000000000";
  for (const mintedKey of [key, "fw_other_dummy_key_00000000000", undefined, null]) {
    const home = await mkdtemp(path.join(os.tmpdir(), "nexus-unmarked-mint-"));
    try {
      const result = spawnSync(process.execPath, ["--import", `data:text/javascript,import{register}from'node:module';register(${JSON.stringify(loader)});`, "--input-type=module", "-e", `
        const { persistApiKeyToKeychain } = await import(${JSON.stringify(api)});
        const { writeMintedKeyState, readMintedKeyState } = await import(${JSON.stringify(mint)});
        await writeMintedKeyState(process.env.HOME, { keyId: 'minted-id', userName: 'accounts/test/users/test', displayName: 'test', apiKey: ${JSON.stringify(mintedKey)} });
        if (${JSON.stringify(mintedKey)} === null) {
          const { writeFile } = await import('node:fs/promises');
          const { mintedKeyStatePath } = await import(${JSON.stringify(mint)});
          await writeFile(mintedKeyStatePath(process.env.HOME), '{malformed');
        }
        await persistApiKeyToKeychain(process.env.HOME, ${JSON.stringify(key)});
        console.log(JSON.stringify({ retained: (await readMintedKeyState(process.env.HOME))?.keyId === 'minted-id' }));
      `], { encoding: "utf8", timeout: 30000, env: {
        ...process.env, HOME: home, NEXUS_TEST: "0", NEXUS_SECRET_STORE: "", NEXUS_KEY_STORAGE: "keychain",
        FAKE_KEYCHAIN: "working", FAKE_KEYCHAIN_BACKEND: "native-macos", FAKE_KEYCHAIN_UNMARKED: "1",
      } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).retained, mintedKey === key);
      const store = JSON.parse(await readFile(path.join(home, "fake-keychain.json"), "utf8"));
      assert.equal(store["FireworksAI/fireworks-api-key"], key);
      if (mintedKey === key) {
        assert.ok(!(await readFile(path.join(home, ".nexus", "minted-key.json"), "utf8")).includes(key));
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

it("an unread keychain item cannot fall through to a matching stale plaintext copy", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nexus-unread-plaintext-"));
  const loader = new URL("./fixtures/fake-cross-keychain.mjs", import.meta.url).href;
  const api = new URL("../../lib/keys/api-key.mjs", import.meta.url).href;
  const store = new URL("../../lib/keys/secret-store.mjs", import.meta.url).href;
  const mac = new URL("../../lib/keys/macos-security.mjs", import.meta.url).href;
  const plaintext = new URL("../../lib/keys/plaintext-secret-store.mjs", import.meta.url).href;
  const key = "fw_stale_plaintext_dummy_000000000000";
  try {
    await writeFile(path.join(home, "fake-keychain.json"), JSON.stringify({ "FireworksAI/fireworks-api-key": "different-old-dummy" }));
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,import{register}from'node:module';register(${JSON.stringify(loader)});`, "--input-type=module", "-e", `
      const { getSecret } = await import(${JSON.stringify(store)});
      const { MAC_SECRET_UNREAD } = await import(${JSON.stringify(mac)});
      const { writePlaintextSecret, readPlaintextSecret } = await import(${JSON.stringify(plaintext)});
      const { persistApiKeyToKeychain } = await import(${JSON.stringify(api)});
      await writePlaintextSecret(process.env.HOME, ${JSON.stringify(key)});
      if (await getSecret(process.env.HOME) !== null) throw Error('Background unread item was not deferred');
      process.env.FAKE_KEYCHAIN_UNMARKED = '0';
      if (await getSecret(process.env.HOME) !== 'different-old-dummy') throw Error('Deferred item was cached as missing');
      process.env.FAKE_KEYCHAIN_UNMARKED = '1';
      if (await getSecret(process.env.HOME, { fresh: true }) !== null) throw Error('Background unread item was hidden by plaintext');
      if (await getSecret(process.env.HOME, { migrateMacItems: false }) !== MAC_SECRET_UNREAD) throw Error('Unread item was hidden by plaintext');
      await persistApiKeyToKeychain(process.env.HOME, ${JSON.stringify(key)});
      console.log(JSON.stringify({ plaintextDeleted: await readPlaintextSecret(process.env.HOME) === null }));
    `], { encoding: "utf8", timeout: 30000, env: {
      ...process.env, HOME: home, NEXUS_TEST: "0", NEXUS_SECRET_STORE: "", NEXUS_KEY_STORAGE: "keychain",
      FAKE_KEYCHAIN: "working", FAKE_KEYCHAIN_BACKEND: "native-macos", FAKE_KEYCHAIN_UNMARKED: "1",
    } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).plaintextDeleted, true);
    const saved = JSON.parse(await readFile(path.join(home, "fake-keychain.json"), "utf8"));
    assert.equal(saved["FireworksAI/fireworks-api-key"], key);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
