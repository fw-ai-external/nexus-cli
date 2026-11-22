import assert from "node:assert/strict";
import { it } from "node:test";
import { withTempHome } from "../helpers.mjs";
import { signInForKeyManagement } from "../../lib/auth/login/sign-in-token.mjs";
import { revokeMintedKey, readMintedKeyState, writeMintedKeyState } from "../../lib/keys/mint-api-key.mjs";
import { persistApiKeyToKeychain } from "../../lib/keys/api-key.mjs";
import { getSecret } from "../../lib/keys/secret-store.mjs";
import { runLogoutCommand } from "../../lib/cli/commands/login.mjs";

const idToken = "example-sign-in-token";
const minted = { keyId: "example-key", userName: "accounts/example-account/users/example-user", displayName: "example-key" };

it("revocation needs a sign-in token (never the key itself), and a token sends only bearer auth", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(options.headers);
    return new Response(null, { status: 503 });
  });
  assert.equal((await revokeMintedKey(minted)).ok, false);
  assert.equal((await revokeMintedKey({ ...minted, apiKey: "fw_example_test_0000000000000000" })).ok, false);
  assert.equal((await revokeMintedKey({ ...minted, idToken: " " })).ok, false);
  assert.equal(calls.length, 0);
  assert.equal((await revokeMintedKey({ ...minted, idToken })).ok, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, `bearer ${idToken}`);
  assert.equal(calls[0]["x-api-key"], undefined);
});

it("token-only shared sign-in falls back to the device flow without minting", async () => {
  const calls = [];
  const result = await signInForKeyManagement({ accountType: "nexus" }, {
    localhost: async (options) => { calls.push(options); return { ok: false }; },
    device: async () => ({ ok: true, idToken }),
  });
  assert.equal(result.idToken, idToken);
  assert.equal(calls[0].nexusSignInPage, true);
});

it("token-only SSO uses the resolved pool and never the shared device flow", async () => {
  let used = false;
  const result = await signInForKeyManagement({ ssoAccountId: "example-account" }, {
    resolveSso: async (account) => {
      assert.equal(account, "example-account");
      return { ok: true, cognitoDomain: "https://example-pool.auth.example.com", clientId: "example-client" };
    },
    localhost: async (options) => {
      assert.equal(options.clientId, "example-client");
      assert.equal(options.cognitoDomain, "https://example-pool.auth.example.com");
      return { ok: false, fatal: true };
    },
    device: async () => { used = true; },
  });
  assert.equal(result.ok, false);
  assert.equal(used, false);
});

it("token-only sign-in contains errors, empty responses and cancellation", async () => {
  for (const result of [null, { ok: false, fatal: true }]) {
    assert.equal((await signInForKeyManagement({}, {
      localhost: async () => result,
      device: async () => { throw new Error("unexpected fallback"); },
    })).ok, false);
  }
  assert.equal((await signInForKeyManagement({ ssoAccountId: "example-account" }, {
    resolveSso: async () => { throw new Error("offline"); },
  })).ok, false);
});

for (const outcome of ["success", "failure", "cancelled", "throws", "non-tty"]) {
  it(`logout --revoke preserves retry state unless deletion succeeds: ${outcome}`, async (t) => {
    await withTempHome("logout-token-", async (home) => {
      await persistApiKeyToKeychain(home, "fw_example_test_0000000000000000");
      await writeMintedKeyState(home, minted);
      const lines = [];
      const headers = [];
      t.mock.method(console, "log", (line) => lines.push(String(line)));
      t.mock.method(globalThis, "fetch", async (url, options) => {
        headers.push(options.headers);
        return new Response(Buffer.from([128, 0, 0, 0, 15, ...Buffer.from("grpc-status:0\r\n")]));
      });
      let signedIn = false;
      const asked = [];
      const logout = runLogoutCommand({ home, revoke: true }, {
        tty: outcome !== "non-tty",
        confirm: async (question) => { asked.push(question); return false; },
        signIn: async () => {
          signedIn = true;
          if (outcome === "throws") throw new Error("offline");
          return outcome === "success" ? { ok: true, idToken } : { ok: false, fatal: outcome === "cancelled" };
        },
      });
      if (outcome === "success") await logout;
      else await assert.rejects(logout, /Couldn't revoke.*revoke record were kept/);
      assert.equal(signedIn, outcome !== "non-tty");
      // Declining "Log out anyway?" keeps everything; only a failed revoke at a terminal asks.
      assert.equal(asked.length, ["failure", "cancelled", "throws"].includes(outcome) ? 1 : 0);
      assert.equal(headers.length, outcome === "success" ? 1 : 0);
      if (headers.length) {
        assert.equal(headers[0].authorization, `bearer ${idToken}`);
        assert.equal(headers[0]["x-api-key"], undefined);
      }
      assert.equal(lines.join("\n").includes("Logged out"), outcome === "success");
      assert.deepEqual(await readMintedKeyState(home), outcome === "success" ? null : minted);
      assert.equal(await getSecret(home), outcome === "success" ? null : "fw_example_test_0000000000000000");
    });
  });
}

it("logout --revoke keeps the local retry state when the server refuses deletion", async (t) => {
  await withTempHome("logout-revoke-denied-", async (home) => {
    const key = "fw_example_test_0000000000000000";
    await persistApiKeyToKeychain(home, key);
    await writeMintedKeyState(home, minted);
    t.mock.method(console, "log", () => {});
    t.mock.method(globalThis, "fetch", async () =>
      new Response(Buffer.from([128, 0, 0, 0, 15, ...Buffer.from("grpc-status:7\r\n")])));

    await assert.rejects(
      runLogoutCommand({ home, revoke: true }, { tty: true, signIn: async () => ({ ok: true, idToken }), confirm: async () => false }),
      /Fireworks did not confirm deletion.*revoke record were kept/,
    );
    assert.deepEqual(await readMintedKeyState(home), minted);
    assert.equal(await getSecret(home), key);
  });
});

for (const outcome of ["sign-in fails", "server refuses"]) {
  it(`logout --revoke at a terminal can log out anyway, leaving the key active, when ${outcome}`, async (t) => {
    await withTempHome("logout-anyway-", async (home) => {
      await persistApiKeyToKeychain(home, "fw_example_test_0000000000000000");
      await writeMintedKeyState(home, minted);
      const lines = [];
      const asked = [];
      t.mock.method(console, "log", (line) => lines.push(String(line)));
      t.mock.method(globalThis, "fetch", async () =>
        new Response(Buffer.from([128, 0, 0, 0, 15, ...Buffer.from("grpc-status:7\r\n")])));

      await runLogoutCommand({ home, revoke: true }, {
        tty: true,
        signIn: async () => (outcome === "server refuses" ? { ok: true, idToken } : { ok: false }),
        confirm: async (question, options) => { asked.push({ question, options }); return true; },
      });

      assert.equal(asked.length, 1);
      assert.match(asked[0].question, /Log out anyway\? .* stays active/);
      assert.equal(asked[0].options?.defaultYes, false, "leaving a live key behind is opt-in");
      const shown = lines.join("\n");
      assert.match(shown, /Couldn't revoke/);
      assert.match(shown, /Left .* active/);
      assert.match(shown, /Logged out/);
      assert.doesNotMatch(shown, /Revoked .* server-side/);
      assert.equal(await readMintedKeyState(home), null);
      assert.equal(await getSecret(home), null);
    });
  });
}

it("logout without --revoke at a terminal asks with the injected prompt and never signs in on no", async (t) => {
  await withTempHome("logout-decline-", async (home) => {
    await persistApiKeyToKeychain(home, "fw_example_test_0000000000000000");
    await writeMintedKeyState(home, minted);
    t.mock.method(console, "log", () => {});
    let signedIn = false;
    await runLogoutCommand({ home }, { tty: true, signIn: async () => { signedIn = true; }, confirm: async () => false });
    assert.equal(signedIn, false);
    assert.equal(await getSecret(home), null);
  });
});

it("a Nexus account's key is revoked through the web app (no terminal needed), never with the key or a Cognito sign-in", async (t) => {
  for (const ok of [true, false]) {
    await withTempHome("logout-web-revoke-", async (home) => {
      await persistApiKeyToKeychain(home, "fw_example_test_0000000000000000", { accountType: "nexus" });
      await writeMintedKeyState(home, minted);
      const { writeGlobalConfig } = await import("../../lib/config/global-config.mjs");
      await writeGlobalConfig(home, { accountType: "nexus" });
      t.mock.method(console, "log", () => {});
      let fetched = false;
      t.mock.method(globalThis, "fetch", async () => { fetched = true; return new Response(null, { status: 503 }); });
      const asked = [];
      const prevAuth = process.env.NEXUS_WEB_AUTH;
      process.env.NEXUS_WEB_AUTH = "on";
      try {
        const logout = runLogoutCommand({ home, revoke: true }, {
          tty: false,
          confirm: async (question) => { asked.push(question); return false; },
          signIn: async () => assert.fail("no Cognito sign-in for a Nexus key"),
          webRevoke: async (args) => {
            assert.equal(args.keyId, "example-key");
            assert.equal(args.accountHint, "example-account");
            assert.equal(args.interactive, false);
            return ok ? { ok: true, failure: "", error: "", fatal: false } : { ok: false, failure: "Sign-in was cancelled in the browser.", error: "access_denied", fatal: true };
          },
        });
        if (ok) await logout;
        else await assert.rejects(logout, /Couldn't revoke example-key: Sign-in was cancelled in the browser\. Your stored key and revoke record were kept/);
      } finally {
        if (prevAuth === undefined) delete process.env.NEXUS_WEB_AUTH; else process.env.NEXUS_WEB_AUTH = prevAuth;
      }
      assert.equal(fetched, false, "no gateway call: the web app deletes the key");
      assert.equal(asked.length, 0);
      assert.deepEqual(await readMintedKeyState(home), ok ? null : minted);
      assert.equal(await getSecret(home), ok ? null : "fw_example_test_0000000000000000");
    });
  }
});
