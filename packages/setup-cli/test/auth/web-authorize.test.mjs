import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";

import {
  OOB_REDIRECT_URI,
  PASTED_CODE_REFUSED,
  WEB_CALLBACK_URI,
  computerName,
  confirmWebRefresh,
  exchangeRevokeCode,
  exchangeWebCode,
  probeWebAuthorizeVersion,
  revokeViaWebApp,
  signInViaWebApp,
  usePasteCode,
  webAuthMode,
  webAuthorizeVersion,
  webCallbackPort,
  webCallbackUri,
  defaultPortFallback,
  resetKeysUrlNoteForTests,
} from "../../lib/auth/web-authorize.mjs";
import { waitForCallback } from "../../lib/auth/browser-auth.mjs";
import { loopbackHostHeaders } from "../../lib/system/loopback.mjs";
import { pbDecode, pbStringAt } from "../../lib/auth/grpc-web.mjs";
import { BROWSER_SSO_UNSUPPORTED_HINT, apiKeyFingerprint, parseKeyExpireTime, planCliKeyAction, settleCliKey } from "../../lib/keys/mint-api-key.mjs";
import { withTempHome } from "../helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "../../bin/nexus.mjs");
/** The redirect policy shared with the web app and the control plane (identical copies). */
const REDIRECT_POLICY = JSON.parse(await readFile(path.join(__dirname, "../fixtures/nexus-cli-redirect-uris.json"), "utf8"));

const PARENT = "accounts/example-account/users/example-user";
/** The key the fake web app hands out on its nth redeem. */
const keyFor = (n) => ({ key: `fw_test_web_key_${String(n).padStart(4, "0")}`, keyId: `key-${n}` });

/** @param {(req, res, body: Buffer) => void} handle */
function startServer(handle) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => handle(req, res, Buffer.concat(chunks)));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** A loopback port nothing else is using, so parallel spec files never collide on 18000. */
/**
 * The browser the CLI opened: the URL is a one-time local page owned by the
 * first browser that loads it, which redirects to the web app's authorize
 * URL. Returns that URL (the opened one as is if it's already there).
 */
/** The local page's cookie per origin: what the browser that loaded it sends back with the callback. */
const cookieJar = new Map();

async function browse(opened) {
  if (!/\/s\/[^/]+$/.test(new URL(opened).pathname)) return opened;
  const response = await fetch(opened, { redirect: "manual" });
  assert.equal(response.status, 302, "the first browser to load the local page is sent on");
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  if (cookie) cookieJar.set(new URL(opened).origin, cookie);
  return response.headers.get("location");
}

/**
 * The browser following the web app's redirect back to the callback: it
 * sends the cookie the local page set (the callback only counts with it).
 */
function land(url, init = {}) {
  const cookie = cookieJar.get(new URL(url).origin);
  return fetch(url, { ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) } });
}

async function freePort() {
  const { server } = await startServer(() => {});
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const s256 = (verifier) => createHash("sha256").update(verifier).digest("base64url");

/** Frame a protobuf message (+ trailers) the way a gRPC-web server does. */
function grpcWebFrames(message, { status = 0, detail = "" } = {}) {
  const frame = (flag, payload) => {
    const head = Buffer.alloc(5);
    head[0] = flag;
    head.writeUInt32BE(payload.length, 1);
    return Buffer.concat([head, payload]);
  };
  const trailers = Buffer.from(`grpc-status: ${status}\r\n${detail ? `grpc-message: ${encodeURIComponent(detail)}\r\n` : ""}`);
  return message === null ? frame(0x80, trailers) : Buffer.concat([frame(0, message), frame(0x80, trailers)]);
}

/**
 * Stand-ins for the web app (authorize + token routes) and the control
 * plane's gRPC-web surface. The web app remembers the PKCE challenge, redirect
 * and action each issued code is bound to, checks the verifier, hands out a
 * new key per signin/refresh redeem and deletes the target key for
 * refresh/revoke. The gateway refuses every call: nothing in a web sign-in
 * may reach it (no key ever deletes a key).
 */
describe("web-app sign-in (redeem → key)", () => {
  let web;
  let gateway;
  let issued;
  let tokenCalls;
  let tokenReply;
  let probeBody;
  let redeemed;
  /** keyId → key, for every key the fake web app handed out. */
  let keys;
  let grpcCalls;
  let grpcStatus;
  /** Order of side effects across both servers. */
  let events;
  /** The token response's expire_time (omitted when undefined, like an older web app). */
  let expireTime;
  /** Key ids the web app deleted for refresh/revoke redeems. */
  let webDeleted;
  /** The refresh waits for the CLI's confirm (newer backend) instead of deleting on redeem. */
  let confirmMode;
  /** code → the refresh waiting for its confirm. */
  let pendingRefresh;
  let confirmCalls;
  let confirmReply;
  /** Runs while the CLI stores a key (it refetches the model catalog then). */
  let duringStore;
  /** The key check rejects keys the web app no longer has (deleted ones). */
  let verifyChecksKeys;
  /** The confirm commits (deletes the old key), then its answer is lost. */
  let dropConfirmAnswer;
  /** Make the web app's delete of the target key fail. */
  let deleteFails;

  before(async () => {
    web = await startServer((req, res, raw) => {
      const url = new URL(req.url, "http://web.test");
      // Stands in for the gateway's key check too (NEXUS_GATEWAY_URL), so the
      // login spec never reaches the real API.
      if (url.pathname.startsWith("/v1/serverless/models") && duringStore) {
        // The catalog refetch happens inside the CLI's key store.
        Promise.resolve(duringStore()).finally(() => json(res, 404, {}));
        return;
      }
      if (url.pathname === "/verifyApiKey") {
        const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (verifyChecksKeys && ![...keys.values()].includes(bearer)) {
          json(res, 401, { error: "invalid API key" });
          return;
        }
        // The same identity as test/mock-gateway.mjs.
        res.writeHead(200, {
          "Content-Type": "application/json",
          Connection: "close",
          "x-fireworks-developer-email": "test@example.com",
          "x-fireworks-account-id": "acct-test",
        });
        res.end("{}");
        return;
      }
      if (url.pathname !== "/api/v2/nexus/cli/token") {
        json(res, 404, {});
        return;
      }
      if (req.method === "GET") {
        json(res, 200, probeBody);
        return;
      }
      const params = JSON.parse(raw.toString("utf8"));
      if (params.grant_type === "confirm_refresh") {
        // The refresh confirm: same route, the redeem's code and verifier.
        confirmCalls.push(params);
        events.push("confirm");
        if (confirmReply) {
          json(res, confirmReply.status, confirmReply.body);
          return;
        }
        const pending = pendingRefresh.get(params.code);
        if (!pending || pending.challenge !== s256(params.code_verifier) || pending.redirectUri !== params.redirect_uri || pending.newKeyId !== params.key_id) {
          json(res, 400, { error: "invalid_grant", error_description: "refresh not confirmed" });
          return;
        }
        pendingRefresh.delete(params.code);
        if (!deleteFails) {
          webDeleted.push(pending.target);
          keys.delete(pending.target);
          events.push(`deleted ${pending.target}`);
        }
        if (dropConfirmAnswer) {
          // Committed on the server, but the answer never reaches the CLI.
          req.socket.destroy();
          return;
        }
        json(res, 200, { previous_key_revoked: !deleteFails });
        return;
      }
      tokenCalls.push(params);
      events.push("token");
      if (tokenReply) {
        json(res, tokenReply.status, tokenReply.body);
        return;
      }
      const grant = issued.get(params.code);
      if (!grant || grant.challenge !== s256(params.code_verifier) || grant.redirectUri !== params.redirect_uri) {
        json(res, 400, { error: "invalid_grant", error_description: "bad code" });
        return;
      }
      issued.delete(params.code);
      if (grant.action === "revoke") {
        if (deleteFails) {
          json(res, 503, { error: "temporarily_unavailable" });
          return;
        }
        webDeleted.push(grant.keyId);
        events.push(`deleted ${grant.keyId}`);
        json(res, 200, { revoked: true });
        return;
      }
      redeemed += 1;
      const { key, keyId } = keyFor(redeemed);
      keys.set(keyId, key);
      const refresh = grant.action === "refresh";
      if (refresh && confirmMode) {
        // Nothing is deleted until the CLI confirms it stored the new key.
        pendingRefresh.set(params.code, { target: grant.keyId, newKeyId: keyId, challenge: grant.challenge, redirectUri: grant.redirectUri });
        json(res, 200, {
          api_key: key, key_id: keyId, display_name: params.display_name, parent: PARENT,
          ...(expireTime === undefined ? {} : { expire_time: expireTime }),
          confirm_deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
          previous_key_revoked: false,
        });
        return;
      }
      if (refresh && !deleteFails) {
        webDeleted.push(grant.keyId);
        events.push(`deleted ${grant.keyId}`);
      }
      json(res, 200, {
        api_key: key, key_id: keyId, display_name: params.display_name, parent: PARENT,
        ...(expireTime === undefined ? {} : { expire_time: expireTime }),
        ...(refresh ? { previous_key_revoked: !deleteFails } : {}),
      });
    });
    gateway = await startServer((req, res, raw) => {
      const method = req.url.split("/").at(-1);
      const request = pbDecode(raw.subarray(5));
      const call = {
        method,
        authorization: String(req.headers.authorization ?? ""),
        apiKey: String(req.headers["x-api-key"] ?? ""),
        parent: pbStringAt(request, 1),
        keyId: pbStringAt(request, 2),
      };
      grpcCalls.push(call);
      events.push(`${method} ${call.keyId}`);
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      res.end(grpcWebFrames(null, { status: grpcStatus[method] ?? 7, detail: "denied by test" }));
    });
    gateway.url = `${gateway.url}/web/gateway.Gateway`;
  });

  after(() => {
    web.server.closeAllConnections();
    web.server.close();
    gateway.server.close();
  });

  beforeEach(() => {
    issued = new Map();
    tokenCalls = [];
    tokenReply = null;
    probeBody = { version: 2 };
    redeemed = 0;
    keys = new Map();
    grpcCalls = [];
    grpcStatus = {};
    events = [];
    expireTime = undefined;
    webDeleted = [];
    deleteFails = false;
    confirmMode = false;
    pendingRefresh = new Map();
    confirmCalls = [];
    confirmReply = null;
    duringStore = null;
    verifyChecksKeys = false;
    dropConfirmAnswer = false;
  });

  /** What the authorize page does on Approve: issue a code bound to the challenge, redirect and action. */
  function approve(authorizeUrl, code = "one-time-code") {
    const url = new URL(authorizeUrl);
    issued.set(code, {
      challenge: url.searchParams.get("code_challenge"),
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
      action: url.searchParams.get("action") ?? "signin",
      keyId: url.searchParams.get("key_id") ?? "",
    });
    return { code, state: url.searchParams.get("state"), redirectUri: url.searchParams.get("redirect_uri") };
  }

  it("a second browser loading the local page stops the sign-in, whichever loads it first (no local login CSRF)", async () => {
    // Another user on the machine can read the opened URL from the process
    // list. If they approve with their own account, their code must never be
    // redeemed here: their load and this user's browser contest the page.
    for (const attackerFirst of [false, true]) {
      tokenCalls = [];
      const port = await freePort();
      const result = await signInViaWebApp({
        baseUrl: web.url,
        port,
        host: "h",
        // A regression fails fast instead of waiting out the callback timeout.
        timeoutMs: 2000,
        open: async (page) => {
          const intruder = () => fetch(page, { redirect: "manual" });
          if (attackerFirst) {
            const theirs = await intruder();
            assert.equal(theirs.status, 302, "the first load is sent on");
            const theirCookie = (theirs.headers.get("set-cookie") ?? "").split(";")[0];
            const { code, state, redirectUri } = approve(theirs.headers.get("location"), "attacker-code");
            // This user's browser opens the page: contested, the sign-in stops.
            const mine = await fetch(page, { redirect: "manual" });
            assert.equal(mine.status, 409);
            setImmediate(() => fetch(`${redirectUri}?code=${code}&state=${state}`, { headers: { cookie: theirCookie } }).catch(() => {}));
          } else {
            await browse(page);
            const theirs = await intruder();
            assert.equal(theirs.status, 409, "a load without this browser's cookie is refused");
          }
          return true;
        },
      });
      assert.equal(result.ok, false, `attackerFirst=${attackerFirst}`);
      assert.equal(result.fatal, true);
      assert.equal(result.error, "contested", "its own code, not a user's Cancel");
      assert.equal(tokenCalls.length, 0, "no code is redeemed");
    }
  });

  it("the redirecting local page is single-use: a second load stops the sign-in even with the owner's cookie", async () => {
    // A localhost cookie isn't scoped by port, so another local service could
    // replay it: owning the cookie mustn't let anyone load the page again.
    const port = await freePort();
    const result = await signInViaWebApp({
      baseUrl: web.url,
      port,
      host: "h",
      timeoutMs: 2000,
      open: async (page) => {
        const first = await fetch(page, { redirect: "manual" });
        assert.equal(first.status, 302);
        const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
        assert.ok(cookie, "the owner cookie is set");
        const replay = await fetch(page, { redirect: "manual", headers: { cookie } });
        assert.equal(replay.status, 409, "the same cookie can't load it again");
        return true;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
    assert.equal(result.error, "contested");
    assert.equal(tokenCalls.length, 0);
  });

  it("never stores a code whose page is contested while its redeem is in flight", async () => {
    // The attacker claims the page and approves; this user's browser loads
    // the page while that code is being redeemed.
    let release;
    const slow = await startServer((req, res) => {
      if (req.method === "GET") return json(res, 200, { version: 3 });
      new Promise((resolve) => { release = resolve; })
        .then(() => json(res, 200, { api_key: keyFor(5).key, key_id: "attacker-key", display_name: "nexus-cli-h", parent: PARENT }));
    });
    try {
      const port = await freePort();
      const stored = [];
      let mine;
      const result = await signInViaWebApp({
        baseUrl: slow.url,
        port,
        host: "h",
        timeoutMs: 2000,
        finish: async (redeemed) => { stored.push(redeemed.keyId); return { ok: true }; },
        open: async (page) => {
          const theirs = await fetch(page, { redirect: "manual" });
          const theirCookie = (theirs.headers.get("set-cookie") ?? "").split(";")[0];
          const { code, state, redirectUri } = approve(theirs.headers.get("location"), "attacker-code");
          setImmediate(async () => {
            // The attacker's own browser claimed the page, so its callback carries its cookie.
            const callback = fetch(`${redirectUri}?code=${code}&state=${state}`, { redirect: "manual", headers: { cookie: theirCookie } }).catch(() => null);
            while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
            mine = await fetch(page, { redirect: "manual" });
            release();
            await callback;
          });
          return true;
        },
      });
      // Let the in-flight answer finish before checking what it did.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(mine.status, 409);
      assert.equal(result.ok, false);
      assert.equal(result.fatal, true);
      assert.deepEqual(stored, [], "the contested code's key is never stored");
    } finally {
      slow.server.close();
    }
  });

  it("refuses a callback without the local page's cookie and keeps waiting for this browser's (no local login CSRF)", async () => {
    const port = await freePort();
    const refused = [];
    const result = await signInViaWebApp({
      baseUrl: web.url,
      port,
      host: "h",
      timeoutMs: 5000,
      open: async (page) => {
        const authorizeUrl = await browse(page);
        // Someone who learned the authorize URL approves with their own account
        // and sends the callback from another browser: no cookie, or a forged one.
        const theirs = approve(authorizeUrl, "attacker-code");
        const mine = approve(authorizeUrl, "my-code");
        setImmediate(async () => {
          for (const headers of [{}, { cookie: "nexus_signin=forged" }]) {
            refused.push((await fetch(`${theirs.redirectUri}?code=${theirs.code}&state=${theirs.state}`, { redirect: "manual", headers })).status);
            refused.push((await fetch(`${theirs.redirectUri}?error=access_denied&state=${theirs.state}`, { redirect: "manual", headers })).status);
          }
          await land(`${mine.redirectUri}?code=${mine.code}&state=${mine.state}`, { redirect: "manual" });
        });
        return true;
      },
    });
    assert.deepEqual(refused, [403, 403, 403, 403], "refused, and the sign-in kept waiting");
    assert.equal(result.ok, true, result.failure);
    assert.deepEqual(tokenCalls.map((call) => call.code), ["my-code"], "the other browser's code is never redeemed");
  });

  it("redeems the code with the key's name and gets this machine's key back", async () => {
    const port = await freePort();
    let opened = "";
    const result = await signInViaWebApp({
      baseUrl: web.url,
      port,
      host: "testhost",
      keyName: "nexus-testhost",
      open: async (page) => {
        const url = await browse(page);
        opened = url;
        const { code, state, redirectUri } = approve(await browse(url));
        setImmediate(() => land(`${redirectUri}?code=${code}&state=${state}`));
        return true;
      },
    });

    assert.equal(result.ok, true, result.failure);
    assert.equal(result.key, keyFor(1).key);
    assert.equal(result.keyId, "key-1");
    assert.equal(result.userName, PARENT);
    assert.equal(result.accountId, "example-account");
    assert.equal(result.reused, false);

    const url = new URL(opened);
    assert.equal(`${url.origin}${url.pathname}`, `${web.url}/nexus/cli/authorize`);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), `http://localhost:${port}/callback`);
    assert.equal(url.searchParams.get("client"), "nexus-cli");
    assert.equal(url.searchParams.get("host"), "testhost");

    assert.deepEqual(events, ["token"], "no control-plane calls: the key comes from the redeem");
    assert.equal(tokenCalls[0].grant_type, "authorization_code");
    assert.equal(tokenCalls[0].display_name, "nexus-testhost");
  });

  it("keeps the new key if the settle step throws", async () => {
    const port = await freePort();
    const result = await signInViaWebApp({
      baseUrl: web.url,
      port,
      settle: async () => { throw new Error("boom"); },
      open: async (url) => {
        const { code, state, redirectUri } = approve(await browse(url));
        setImmediate(() => land(`${redirectUri}?code=${code}&state=${state}`));
        return true;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.keyId, "key-1");
  });

  it("refuses a malformed token response", async () => {
    for (const body of [
      { api_key: "not-a-fireworks-key", key_id: "k", parent: PARENT },
      { api_key: "fw_{env:HOME}", key_id: "k", parent: PARENT },
      { api_key: "fw_has space", key_id: "k", parent: PARENT },
      { api_key: keyFor(9).key, key_id: "", parent: PARENT },
      { api_key: keyFor(9).key, key_id: "k", parent: "not-a-user" },
      { access_token: "old-shape", refresh_token: "old-shape", parent: PARENT },
    ]) {
      tokenReply = { status: 200, body };
      const result = await exchangeWebCode({ baseUrl: web.url, code: "c", verifier: "v", redirectUri: "", keyName: "k" });
      assert.equal(result.ok, false, JSON.stringify(body));
      assert.match(result.failure, /unexpected response/);
    }
  });

  it("never deletes the key a malformed reply carries; says which key to revoke", async () => {
    for (const body of [
      { api_key: keyFor(9).key, key_id: "k9", parent: "accounts/a/users/odd/x" },
      { api_key: keyFor(9).key, key_id: "", parent: PARENT },
    ]) {
      grpcCalls = [];
      tokenReply = { status: 200, body };
      const result = await exchangeWebCode({ baseUrl: web.url, code: "c", verifier: "v", redirectUri: "", keyName: "nexus-cli-h" });
      assert.equal(result.ok, false);
      assert.equal(grpcCalls.length, 0, "no API key deletes a key");
      assert.match(result.failure, /Revoke the API key nexus-cli-h at .*nexus\.fireworks\.ai/);
      assert.equal(result.failure.includes(keyFor(9).key), false, "the key itself is never printed");
    }
  });

  it("stops for good when the user cancels on the authorize page", async () => {
    const port = await freePort();
    const result = await signInViaWebApp({
      baseUrl: web.url,
      port,
      open: async (url) => {
        const { state, redirectUri } = approve(await browse(url));
        setImmediate(() => land(`${redirectUri}?error=access_denied&state=${state}`));
        return true;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
    assert.equal(result.error, "access_denied");
    assert.equal(tokenCalls.length, 0);
  });

  it("ignores a callback with the wrong state and keeps waiting for the real one", async () => {
    const port = await freePort();
    const result = await signInViaWebApp({
      baseUrl: web.url,
      port,
      open: async (url) => {
        const { code, state, redirectUri } = approve(await browse(url));
        setImmediate(async () => {
          await land(`${redirectUri}?code=forged&state=not-the-state`);
          await land(`${redirectUri}?error=access_denied&state=not-the-state`);
          await land(`${redirectUri}?code=${code}&state=${state}`);
        });
        return true;
      },
    });
    assert.equal(result.ok, true, result.failure);
    assert.deepEqual(tokenCalls.map((call) => call.code), ["one-time-code"]);
  });

  describe("browser answer after the key is settled", () => {
    async function runBrowser(answerFor, extra = {}) {
      const port = await freePort();
      let seen;
      const result = await signInViaWebApp({
        baseUrl: web.url,
        port,
        host: "test host",
        open: async (url) => {
          const query = answerFor(await browse(url));
          seen = new Promise((resolve) => setImmediate(resolve))
            .then(() => land(`http://localhost:${port}/callback?${query}`, { redirect: "manual" }))
            .then((response) => ({ status: response.status, location: response.headers.get("location"), events: [...events] }));
          return true;
        },
        ...extra,
      });
      return { result, seen: await seen };
    }
    const grant = (url) => {
      const { code, state } = approve(url);
      return `code=${code}&state=${state}`;
    };
    const successUrl = (query) => `${web.url}/nexus/cli/success?${query}`;

    it("redirects to the success page only once the key is settled", async () => {
      let settled = false;
      const { result, seen } = await runBrowser(grant, {
        settle: async (fresh) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          settled = true;
          return { key: fresh.key, keyId: fresh.keyId };
        },
      });
      assert.equal(result.ok, true, result.failure);
      assert.equal(settled, true);
      assert.equal(seen.status, 302);
      assert.equal(seen.location, successUrl("host=test+host"));
      assert.doesNotMatch(seen.location, /one-time-code|fw_|verifier|key/);
    });

    it("tells the success page which action was approved (refresh, revoke), never the key id", async () => {
      // Sign-in omits the action.
      const signin = await runBrowser(grant);
      assert.equal(signin.seen.location, successUrl("host=test+host"));

      const refreshed = await runBrowser(grant, { action: "refresh", keyId: "key-7", accountHint: "example-account" });
      assert.equal(refreshed.result.ok, true, refreshed.result.failure);
      assert.equal(refreshed.seen.location, successUrl("host=test+host&action=refresh"));
      const refusedRefresh = await runBrowser((url) => `error=access_denied&state=${new URL(url).searchParams.get("state")}`, { action: "refresh", keyId: "key-7" });
      assert.equal(refusedRefresh.seen.location, successUrl("error=access_denied&host=test+host&action=refresh"));

      for (const [answerFor, query] of [
        [grant, "host=test+host&action=revoke"],
        [(url) => `error=access_denied&state=${new URL(url).searchParams.get("state")}`, "error=access_denied&host=test+host&action=revoke"],
      ]) {
        const port = await freePort();
        let seen;
        await revokeViaWebApp({
          keyId: "key-9",
          baseUrl: web.url,
          port,
          host: "test host",
          open: async (url) => {
            const answer = answerFor(await browse(url));
            seen = new Promise((resolve) => setImmediate(resolve))
              .then(() => land(`http://localhost:${port}/callback?${answer}`, { redirect: "manual" }))
              .then((response) => response.headers.get("location"));
            return true;
          },
        });
        const location = await seen;
        assert.equal(location, successUrl(query));
        assert.doesNotMatch(location, /key-9|one-time-code|fw_|verifier/);
      }
    });

    it("stores the key before answering the browser, and says signed in only if that worked", async () => {
      let stored = false;
      const ok = await runBrowser(grant, {
        finish: async (redeemed) => {
          assert.equal(redeemed.ok, true);
          await new Promise((resolve) => setTimeout(resolve, 50));
          stored = true;
          return { ok: true };
        },
      });
      assert.equal(ok.result.ok, true, ok.result.failure);
      assert.equal(stored, true);
      assert.equal(ok.seen.location, successUrl("host=test+host"));

      for (const finish of [async () => ({ ok: false }), async () => { throw new Error("no key store"); }]) {
        const { result, seen } = await runBrowser(grant, { finish });
        // The key was redeemed; the caller reports the storage failure.
        assert.equal(result.ok, true);
        assert.equal(seen.status, 302);
        assert.equal(seen.location, successUrl("error=server_error&host=test+host"));
      }
    });

    it("keeps the terminal waiting for a store that outlives the browser's deadline", async () => {
      // A refresh's rollback runs inside finish: it must not be cut off when
      // the browser is answered.
      let finished = false;
      const { result, seen } = await runBrowser(grant, {
        finish: async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          finished = true;
          return { ok: false };
        },
        completeTimeoutMs: 100,
      });
      assert.equal(seen.location, successUrl("error=server_error&host=test+host"));
      assert.equal(finished, true, "the terminal returned only after storing finished");
      assert.equal(result.ok, true, "the redeemed result, for the caller to report the store outcome");
      assert.equal("late" in result, false);
    });

    it("answers the browser and the terminal by a deadline even if storing never finishes", async () => {
      const { result, seen } = await runBrowser(grant, { finish: () => new Promise(() => {}), completeTimeoutMs: 100 });
      assert.equal(seen.location, successUrl("error=server_error&host=test+host"));
      assert.equal(result.ok, false);
      assert.equal(result.fatal, true, "no key paste on top of a store that may still finish");
      assert.match(result.failure, /took too long/);
    });

    it("sends each token-endpoint error to the success page as ?error=", async () => {
      const cases = [
        [{ status: 400, body: { error: "invalid_grant" } }, "invalid_grant"],
        [{ status: 403, body: { error: "no_account" } }, "no_account"],
        [{ status: 403, body: { error: "account_suspended" } }, "account_suspended"],
        [{ status: 429, body: {} }, "slow_down"],
        [{ status: 503, body: { error: "temporarily_unavailable" } }, "temporarily_unavailable"],
        [{ status: 503, body: {} }, "temporarily_unavailable"],
        [{ status: 500, body: { error: "something_new" } }, "server_error"],
        [{ status: 400, body: { error: "unsupported_grant_type" } }, "server_error"],
        [{ status: 403, body: { error: "key_limit_reached" } }, "key_limit_reached"],
        [{ status: 200, body: { api_key: "not-a-fireworks-key" } }, "server_error"],
      ];
      for (const [reply, error] of cases) {
        tokenReply = reply;
        const { result, seen } = await runBrowser(grant);
        assert.equal(result.ok, false);
        assert.equal(seen.status, 302);
        assert.equal(seen.location, successUrl(`error=${error}&host=test+host`), JSON.stringify(reply));
      }
      assert.equal(grpcCalls.length, 0);
    });

    it("sends Cancel to the success page as access_denied, without a token call", async () => {
      const { result, seen } = await runBrowser((url) => `error=access_denied&state=${new URL(url).searchParams.get("state")}`);
      assert.equal(result.fatal, true);
      assert.equal(seen.location, successUrl("error=access_denied&host=test+host"));
      assert.equal(tokenCalls.length, 0);
    });

    it("answers the browser with server_error when the exchange hangs", async () => {
      const hanging = await startServer(() => {}); // the token endpoint never answers
      try {
        const port = await freePort();
        let seen;
        const started = Date.now();
        const result = await signInViaWebApp({
          baseUrl: hanging.url,
          port,
          host: "h",
          exchangeTimeoutMs: 100,
          open: async (page) => {
            const state = new URL(await browse(page)).searchParams.get("state");
            seen = new Promise((resolve) => setImmediate(resolve))
              .then(() => land(`http://localhost:${port}/callback?code=c&state=${state}`, { redirect: "manual" }))
              .then((response) => ({ status: response.status, location: response.headers.get("location") }));
            return true;
          },
        });
        seen = await seen;
        assert.equal(result.ok, false);
        assert.match(result.failure, /Timed out/);
        assert.equal(seen.status, 302);
        assert.equal(seen.location, `${hanging.url}/nexus/cli/success?error=server_error&host=h`);
        assert.ok(Date.now() - started < 2000);
      } finally {
        hanging.server.closeAllConnections();
        hanging.server.close();
      }
    });

    it("without the hook, the shared listener still serves the SSO flow's local page", async () => {
      const port = await freePort();
      let browser;
      const result = await waitForCallback("http://unused.test", "s1", async () => {
        browser = fetch(`http://localhost:${port}/?code=c&state=s1`, { redirect: "manual" })
          .then(async (response) => ({ status: response.status, html: await response.text() }));
      }, { port, timeoutMs: 5000 });
      const page = await browser;
      assert.deepEqual(result, { code: "c", state: "s1", failure: "", fatal: false });
      assert.equal(page.status, 200);
      assert.match(page.html, /Almost done/);
      assert.match(page.html, /Return to your terminal\./);
    });
  });

  it("in a remote session prints the URL and the port-forward hint, never opens a browser, and still uses the loopback callback", async () => {
    const port = await freePort();
    const lines = [];
    const result = await signInViaWebApp({
      baseUrl: web.url,
      port,
      openBrowser: false,
      open: async () => assert.fail("no browser is opened over SSH"),
      onStatus: (line) => {
        lines.push(line);
        const printed = /(http:\/\/localhost:\d+\/s\/[\w-]+)/.exec(line)?.[1];
        if (printed) {
          browse(printed).then((url) => {
            const { code, state, redirectUri } = approve(url);
            assert.equal(redirectUri, `http://localhost:${port}/callback`, "paste-the-code only when asked for");
            setImmediate(() => land(`${redirectUri}?code=${code}&state=${state}`));
          });
        }
      },
    });
    assert.equal(result.ok, true, result.failure);
    const text = lines.join("\n");
    assert.ok(text.includes(`ssh -L ${port}:localhost:${port} <this machine>`), text);
    assert.ok(text.includes(`LocalForward ${port} localhost:${port}`), "the ~/.ssh/config form too");
    // Paste-the-code is only offered as an opt-in, with the phishing warning.
    assert.match(text, /Can't forward the port\? Run with --paste-code .*Never paste a code someone sent you\./);
    assert.doesNotMatch(text, /--paste(?![-\w])|--with-token|API key instead/, "no API-key sign-in fallback");
    assert.doesNotMatch(text, /Paste the code/);
    assert.equal(tokenCalls[0].redirect_uri, `http://localhost:${port}/callback`);
  });

  it("a code replayed or bound to another verifier is refused", async () => {
    issued.set("stolen", { challenge: s256("attacker-verifier"), redirectUri: "" });
    const result = await exchangeWebCode({ baseUrl: web.url, code: "stolen", verifier: "my-verifier", redirectUri: "", keyName: "k" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_grant");
    assert.match(result.failure, /expired or was already used/);
  });

  it("maps the web app's error codes to terminal lines", async () => {
    const cases = [
      [{ status: 400, body: { error: "invalid_grant" } }, /expired or was already used.*nexus login --account <account-id>/],
      [{ status: 400, body: { error: "invalid_request" } }, /didn't accept this version.*nexus update/],
      [{ status: 400, body: { error: "unsupported_grant_type" } }, /unsupported_grant_type/],
      [{ status: 403, body: { error: "no_account" } }, /no Fireworks account/],
      [{ status: 403, body: { error: "key_limit_reached" } }, /^Your Fireworks account has reached its API key limit\. Delete an API key at https:\/\/nexus\.fireworks\.ai\/settings\/api-keys, then sign in again\.$/],
      [{ status: 403, body: { error: "account_suspended" } }, new RegExp(`^Your Fireworks account is suspended\\. Add credits at ${web.url}/account/billing, then run nexus login again\\.$`)],
      [{ status: 429, body: {} }, /Too many sign-in attempts/],
      [{ status: 503, body: { error: "temporarily_unavailable" } }, /isn't available right now/],
      [{ status: 500, body: {} }, /HTTP 500/],
    ];
    for (const [reply, pattern] of cases) {
      tokenReply = reply;
      const result = await exchangeWebCode({ baseUrl: web.url, code: "c", verifier: "v", redirectUri: "", keyName: "k" });
      assert.equal(result.ok, false);
      assert.match(result.failure, pattern);
    }
  });

  it("bounds the code exchange with a timeout", async () => {
    const { server, url } = await startServer(() => {}); // never answers
    try {
      const started = Date.now();
      const result = await exchangeWebCode({ baseUrl: url, code: "c", verifier: "v", redirectUri: "", keyName: "k", timeoutMs: 100 });
      assert.equal(result.ok, false);
      assert.match(result.failure, /Timed out/);
      assert.ok(Date.now() - started < 2000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  describe("planCliKeyAction and settleCliKey (signing in again on the same machine)", () => {
    const old = keyFor(100);
    const previous = { keyId: old.keyId, userName: PARENT, displayName: "nexus-testhost", keyFingerprint: apiKeyFingerprint(old.key) };
    const fresh = (extra = {}) => ({ ...keyFor(1), parent: PARENT, ...extra });
    const plan = (options) => planCliKeyAction({ previous, storedKey: old.key, ...options });
    const ok = async () => ({ ok: true, reason: "" });

    it("keeps the stored key when it still works or can't be checked: no browser, nothing deleted", async () => {
      const verified = [];
      const okCheck = { ok: true, reason: "" };
      assert.deepEqual(await plan({ verify: async (key) => { verified.push(key); return okCheck; } }),
        { action: "keep", rejected: false, expiring: false, check: okCheck });
      assert.deepEqual(verified, [old.key]);
      assert.equal((await plan({ verify: async () => ({ ok: false, reason: "network" }) })).action, "keep");
    });

    it("reuses a check the caller already ran instead of asking the API again", async () => {
      const checked = { ok: true, reason: "" };
      assert.deepEqual(await plan({ checked, verify: async () => assert.fail("already checked") }),
        { action: "keep", rejected: false, expiring: false, check: checked });
      assert.equal((await plan({ checked: { ok: false, reason: "rejected" }, verify: async () => assert.fail("already checked") })).action, "signin");
    });

    it("rotate and a live key in its last day refresh (the web app deletes the old key), after the key is checked", async () => {
      const now = Date.parse("2027-01-01T00:00:00Z");
      const okCheck = { ok: true, reason: "" };
      assert.deepEqual(await plan({ rotate: true, verify: ok }),
        { action: "refresh", rejected: false, expiring: false, check: okCheck });
      assert.deepEqual(await plan({ now, previous: { ...previous, expiresAt: "2027-01-01T12:00:00.000Z" }, verify: ok }),
        { action: "refresh", rejected: false, expiring: true, check: okCheck });
      // A fresh 7-day key, or one with a few days left, is kept.
      assert.equal((await plan({ now, previous: { ...previous, expiresAt: "2027-01-08T00:00:00.000Z" }, verify: ok })).action, "keep");
      assert.equal((await plan({ now, previous: { ...previous, expiresAt: "2027-01-03T00:00:00.000Z" }, verify: ok })).action, "keep");
      assert.equal((await plan({ now, previous: { ...previous, expiresAt: "2027-03-01T00:00:00.000Z" }, verify: ok })).action, "keep");
    });

    it("never refreshes a dead key: one past its expiry or rejected gets a plain sign-in, even with rotate", async () => {
      const now = Date.parse("2027-01-01T00:00:00Z");
      // Expired 2 days ago: there's nothing left to delete.
      assert.deepEqual(await plan({ now, rotate: true, previous: { ...previous, expiresAt: "2026-12-30T00:00:00.000Z" }, verify: async () => assert.fail("no check needed") }),
        { action: "signin", rejected: true, expiring: false });
      const rejected = { ok: false, reason: "rejected" };
      assert.deepEqual(await plan({ now, rotate: true, previous: { ...previous, expiresAt: "2027-01-05T00:00:00.000Z" }, verify: async () => rejected }),
        { action: "signin", rejected: true, expiring: false, check: rejected });
    });

    it("a rejected key, a key not stored here, a key that isn't the record's, or no record: a plain sign-in", async () => {
      const rejected = { ok: false, reason: "rejected" };
      assert.deepEqual(await plan({ verify: async () => rejected }),
        { action: "signin", rejected: true, expiring: false, check: rejected });
      assert.equal((await plan({ storedKey: "", verify: ok })).action, "signin");
      assert.equal((await plan({ storedKey: keyFor(7).key, rotate: true, verify: ok })).action, "signin");
      assert.equal((await plan({ previous: null, rotate: true, verify: ok })).action, "signin");
      // A record without a fingerprint can't be tied to the stored key: never kept or refreshed.
      assert.equal((await plan({ previous: { ...previous, keyFingerprint: undefined }, rotate: true, verify: ok })).action, "signin");
      assert.equal((await plan({ previous: { ...previous, keyFingerprint: undefined }, verify: ok })).action, "signin");
    });

    it("settling keeps the new key and only ever says what became of the previous one", () => {
      const keysUrl = "https://keys.example.test";
      const settle = (planned, extra = {}, f = fresh()) => settleCliKey(f, { previous, plan: planned, storedKey: old.key, keysUrl, ...extra });
      const refresh = { action: "refresh", rejected: false, expiring: false };
      assert.deepEqual(settle(refresh, {}, fresh({ previousKeyRevoked: true })), { key: keyFor(1).key, keyId: "key-1", reused: false, notes: [], previousKey: "deleted" });
      // What became of the previous key, for `login --browser --json`.
      assert.equal(settle(refresh, {}, fresh({ previousKeyRevoked: false })).previousKey, "kept");
      assert.equal(settle(refresh).previousKey, "unknown");
      assert.equal(settle(refresh, {}, fresh({ confirmDeadline: "2030-01-01T00:00:00.000Z" })).previousKey, undefined, "decided by the confirm");
      assert.equal(settle(refresh, { refreshed: false }).previousKey, "kept");
      assert.equal(settle({ action: "signin", rejected: false, expiring: false }).previousKey, "kept");
      assert.equal(settle({ action: "signin", rejected: true, expiring: false }).previousKey, undefined, "already gone");
      assert.deepEqual(settle(refresh, {}, fresh({ previousKeyRevoked: false })).notes,
        ["Couldn't delete this machine's previous key (nexus-testhost) — revoke it at https://keys.example.test"]);
      // A reply that says nothing about the old key isn't a deletion.
      assert.deepEqual(settle(refresh).notes,
        ["Couldn't confirm that this machine's previous key (nexus-testhost) was deleted, so it may still be active — revoke it at https://keys.example.test"]);
      // A confirm-mode refresh learns that from its confirm instead: no note here.
      assert.deepEqual(settle(refresh, {}, fresh({ confirmDeadline: "2030-01-01T00:00:00.000Z" })).notes, []);
      assert.deepEqual(settle(refresh, { refreshed: false }).notes,
        ["This machine's previous key (nexus-testhost) is still active (the web app couldn't replace it) — revoke it at https://keys.example.test"]);
      const expiring = settle({ ...refresh, expiring: true }, { previous: { ...previous, expiresAt: "2027-01-05T00:00:00.000Z" } }, fresh({ previousKeyRevoked: true, expiresAt: "2027-04-01T00:00:00.000Z" }));
      assert.equal(expiring.expiresAt, "2027-04-01T00:00:00.000Z");
      assert.deepEqual(expiring.notes, ["Replaced this machine's previous key (nexus-testhost), which expires on 2027-01-05."]);
      // An expiring key the web app couldn't refresh (older web app): never "Replaced".
      assert.deepEqual(settle({ ...refresh, expiring: true }, { refreshed: false, previous: { ...previous, expiresAt: "2027-01-05T00:00:00.000Z" } }).notes,
        ["This machine's previous key (nexus-testhost) is still active (the web app couldn't replace it) — revoke it at https://keys.example.test"]);

      const signin = { action: "signin", rejected: false, expiring: false };
      assert.deepEqual(settle({ ...signin, rejected: true }).notes, ["Replaced this machine's previous key (nexus-testhost), which no longer worked."]);
      assert.match(settle(signin, { storedKey: "" }).notes[0], /previous key \(nexus-testhost\) wasn't stored here any more, so it wasn't deleted — revoke it at/);
      assert.match(settle(signin, { previous: { ...previous, userName: "accounts/other-account/users/example-user" } }).notes[0], /under another account .* is still active/);
      assert.deepEqual(settle(signin, { previous: null }), { key: keyFor(1).key, keyId: "key-1", reused: false, notes: [] });
      assert.deepEqual(settle(signin, { otherSignIn: true }).notes,
        ["This machine's previous key (nexus-testhost) came from a Fireworks Platform or company SSO sign-in, which this sign-in can't delete, so it is still active — revoke it at https://keys.example.test"]);
      assert.equal(grpcCalls.length, 0, "settling never calls the control plane");
    });
  });

  /**
   * Run the real CLI as over SSH (so it never launches a browser) with its
   * callback listener on a free port, and approve whatever authorize URL it
   * prints by sending the browser's redirect to that listener.
   */
  async function runLogin(home, args, { approveAs = "e2e-code", env = {}, onOutput, onUrl = () => {}, onPage = () => {} } = {}) {
    const port = await freePort();
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        HOME: home,
        FIREWORKS_API_KEY: "",
        NEXUS_SECRET_STORE: "memory",
        NEXUS_WEB_AUTH: "on",
        NEXUS_WEB_APP_URL: web.url,
        NEXUS_WEB_CALLBACK_PORT: String(port),
        NEXUS_GATEWAY_GRPC_WEB_URL: gateway.url,
        // The key check too, even without the suite's global preload.
        NEXUS_GATEWAY_URL: web.url,
        SSH_CONNECTION: "203.0.113.1 50000 203.0.113.2 22",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let approved = false;
    const maybeApprove = () => {
      if (onOutput) {
        onOutput(child, stdout, stderr);
        return;
      }
      // The CLI prints its one-time local page; loading it (as the browser
      // would) leads on to the web app's authorize URL.
      const printed = /(http:\/\/localhost:\d+\/s\/[\w-]+)/.exec(stdout + stderr)?.[1];
      if (printed && !approved) {
        approved = true;
        onPage(printed);
        browse(printed).then((url) => {
          onUrl(url);
          const { code, state, redirectUri } = approve(url, approveAs);
          assert.equal(redirectUri, `http://localhost:${port}/callback`);
          setImmediate(() => land(`${redirectUri}?code=${code}&state=${state}`, { redirect: "manual" }).catch(() => {}));
        }).catch(() => {});
      }
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; maybeApprove(); });
    child.stderr.on("data", (chunk) => { stderr += chunk; maybeApprove(); });
    return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
  }

  /** stdout of a --json run as NDJSON objects; asserts every line is JSON with a type. */
  function ndjson(stdout) {
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    for (const line of lines) {
      assert.equal(typeof line.type, "string", JSON.stringify(line));
    }
    assert.equal(lines.at(-1).type, "result", "the last line is always the result");
    return lines;
  }

  it("login --browser --json and logout --json end in a result line when HOME is missing", async () => {
    await withTempHome("web-login-no-home", async (home) => {
      for (const args of [["login", "--browser", "--json"], ["logout", "--json"]]) {
        const { code, stdout } = await runLogin(home, args, { env: { HOME: "" } });
        const lines = ndjson(stdout);
        assert.deepEqual(lines.at(-1), {
          type: "result",
          ok: false,
          error: { code: "usage", message: "HOME is not set; pass --home or set HOME" },
        }, args.join(" "));
        assert.equal(code, 2, args.join(" "));
      }
    });
  });

  it("nexus login --browser --json: NDJSON events then the result; people's output on stderr; the key never printed", async () => {
    await withTempHome("web-login-json", async (home) => {
      const { code, stdout, stderr } = await runLogin(home, ["login", "--browser", "--json"]);
      assert.equal(code, 0, stderr);
      const lines = ndjson(stdout);
      assert.deepEqual(lines.map((line) => line.type), ["authorize_url", "waiting", "exchanging", "result"]);
      // The one-time local page that leads on to the web app's authorize URL.
      assert.match(lines[0].url, /^http:\/\/localhost:\d+\/s\/[\w-]+$/);
      assert.ok(!Number.isNaN(Date.parse(lines[0].expiresAt)));
      const { keyName, ...rest } = lines.at(-1);
      assert.match(keyName ?? rest.key.name, /^nexus-/);
      assert.deepEqual({ ...rest, key: { ...rest.key, name: "<name>" } }, {
        type: "result",
        ok: true,
        email: "test@example.com",
        name: "",
        accountId: "acct-test",
        userName: PARENT,
        key: { id: "key-1", name: "<name>", created: true },
        reused: false,
      });
      assert.match(stderr, /Created API key/);
      assert.deepEqual(events, ["token"]);
      assert.equal(tokenCalls[0].display_name, rest.key.name, "the key is named like today's minted keys");

      const minted = JSON.parse(await readFile(path.join(home, ".nexus", "minted-key.json"), "utf8"));
      assert.equal(minted.keyId, "key-1");
      assert.equal(minted.userName, PARENT);
      assert.equal(JSON.stringify(minted).includes(keyFor(1).key), false, "the record holds ids only");
      assert.equal(`${stdout}\n${stderr}`.includes(keyFor(1).key), false, "the key is never printed");

      // Same machine, same account, key still works: kept, without a browser
      // or any key made or deleted.
      events = [];
      grpcCalls = [];
      const again = await runLogin(home, ["login", "--browser", "--json"], { approveAs: "e2e-code-2" });
      assert.equal(again.code, 0, again.stderr);
      const secondLines = ndjson(again.stdout);
      assert.deepEqual(secondLines.map((line) => line.type), ["result"], "no authorize_url: the browser isn't needed");
      const second = secondLines.at(-1);
      assert.equal(second.ok, true);
      assert.equal(second.reused, true);
      assert.deepEqual(second.key, { id: "key-1", name: rest.key.name, created: false });
      assert.equal(second.previousKey, undefined, "nothing was replaced");
      assert.deepEqual(events, []);
      assert.match(again.stderr, /Kept this machine's API key/);

      // --force: a refresh on the key's account; the web app makes the new
      // key and deletes the old one. Nothing reaches the control plane.
      events = [];
      let refreshUrl;
      const forced = await runLogin(home, ["login", "--browser", "--json", "--force"], {
        approveAs: "e2e-code-3", onUrl: (url) => { refreshUrl = new URL(url); },
      });
      assert.equal(forced.code, 0, forced.stderr);
      assert.deepEqual(ndjson(forced.stdout).at(-1).key, { id: "key-2", name: rest.key.name, created: true });
      assert.equal(ndjson(forced.stdout).at(-1).previousKey, "deleted");
      assert.equal(refreshUrl.searchParams.get("action"), "refresh");
      assert.equal(refreshUrl.searchParams.get("key_id"), "key-1");
      assert.equal(refreshUrl.searchParams.get("account_hint"), "example-account");
      assert.deepEqual(events, ["token", "deleted key-1"]);
      assert.equal(grpcCalls.length, 0);
      assert.doesNotMatch(forced.stderr, /Couldn't delete/);
      const rotated = JSON.parse(await readFile(path.join(home, ".nexus", "minted-key.json"), "utf8"));
      assert.equal(rotated.keyId, "key-2");

      // The web app couldn't delete the old key: the new one is kept, and the
      // terminal says where to revoke the old one.
      deleteFails = true;
      const kept = await runLogin(home, ["login", "--browser", "--json", "--force"], { approveAs: "e2e-code-4" });
      assert.equal(kept.code, 0, kept.stderr);
      assert.deepEqual(ndjson(kept.stdout).at(-1).key, { id: "key-3", name: rest.key.name, created: true });
      assert.equal(ndjson(kept.stdout).at(-1).previousKey, "kept");
      assert.match(kept.stderr, /Couldn't delete this machine's previous key \(nexus-[^)]+\) — revoke it at https:\/\/nexus\.fireworks\.ai\/settings\/api-keys/);
      assert.equal(grpcCalls.length, 0);
    });
  });

  it("a second browser loading the page while the key is being stored undoes the store: the previous key and record are back", async () => {
    await withTempHome("web-login-contest-store", async (home) => {
      const first = await runLogin(home, ["login", "--browser", "--json"]);
      assert.equal(first.code, 0, first.stderr);
      const record = async () => JSON.parse(await readFile(path.join(home, ".nexus", "minted-key.json"), "utf8"));
      const before = await record();
      let page = "";
      let contest;
      // While the CLI is storing the new key, another browser loads the page.
      duringStore = () => {
        contest ??= fetch(page, { redirect: "manual" }).then((response) => response.status);
        return contest;
      };
      const { code, stdout, stderr } = await runLogin(home, ["login", "--browser", "--json", "--select-account", "example-account-2"], {
        approveAs: "contested-code", onPage: (url) => { page = url; },
      });
      assert.equal(code, 1, "a failure, not a user's Cancel (130)");
      assert.equal(await contest, 409, "the page was contested during the store");
      assert.ok(tokenCalls.some((call) => call.code === "contested-code"), "the code was redeemed before the contest");
      const result = ndjson(stdout).at(-1);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "contested");
      assert.match(result.error.message, /opened in a second browser/);
      assert.doesNotMatch(result.error.message, /finish in the browser it opens/);
      assert.doesNotMatch(stderr, /Created API key/, "no success block");
      const after = await record();
      assert.equal(after.keyId, before.keyId, "the previous record is back");
      assert.equal(after.keyFingerprint, before.keyFingerprint, "and the previous key itself");
    });
  });

  it("a refresh whose confirm answer is lost keeps the new key when the old one is already gone, else rolls back", async () => {
    confirmMode = true;
    await withTempHome("web-login-confirm-lost", async (home) => {
      assert.equal((await runLogin(home, ["login", "--browser", "--json"])).code, 0);
      const record = async () => JSON.parse(await readFile(path.join(home, ".nexus", "minted-key.json"), "utf8"));
      verifyChecksKeys = true;

      // The server confirmed (deleting the old key), but the answer was lost:
      // the old key no longer works, so the replacement went through.
      dropConfirmAnswer = true;
      const lost = await runLogin(home, ["login", "--browser", "--json", "--force"], { approveAs: "lost-confirm" });
      assert.equal(lost.code, 0, lost.stderr);
      assert.equal(ndjson(lost.stdout).at(-1).key.id, "key-2");
      assert.deepEqual(webDeleted, ["key-1"]);
      assert.match(lost.stderr, /answer was lost, but the previous key no longer works/);
      assert.equal((await record()).keyId, "key-2", "the new key and record are kept");

      // A 5xx with the old key still working: the confirm never landed, so the
      // server deletes the new key; this machine goes back to the old one.
      dropConfirmAnswer = false;
      confirmReply = { status: 503, body: { error: "temporarily_unavailable" } };
      const before = await record();
      const unconfirmed = await runLogin(home, ["login", "--browser", "--json", "--force"], { approveAs: "unknown-confirm" });
      assert.equal(unconfirmed.code, 1, unconfirmed.stderr);
      assert.equal(ndjson(unconfirmed.stdout).at(-1).error.code, "refresh_unconfirmed");
      assert.equal((await record()).keyId, before.keyId);
    });
  });

  it("a cancelled login --browser --json writes nothing after its result, even if the approval lands during the exit", async () => {
    await withTempHome("web-login-cancel-late", async (home) => {
      let signalled = false;
      const { code, stdout } = await runLogin(home, ["login", "--browser", "--json"], {
        onOutput: (child, out, err) => {
          const page = /(http:\/\/localhost:\d+\/s\/[\w-]+)/.exec(err)?.[1];
          if (!signalled && page) {
            signalled = true;
            child.kill("SIGTERM");
            // The approval arrives while the CLI is exiting.
            browse(page).then((url) => {
              const { code: approved, state, redirectUri } = approve(url, "late-approval");
              return land(`${redirectUri}?code=${approved}&state=${state}`, { redirect: "manual" });
            }).catch(() => {});
          }
        },
      });
      assert.equal(code, 130);
      const lines = ndjson(stdout);
      assert.equal(lines.filter((line) => line.type === "result").length, 1);
      assert.deepEqual(lines.at(-1), { type: "result", ok: false, error: { code: "cancelled", message: "Sign-in was cancelled." } });
    });
  });

  it("a refresh that needs confirming: stores the new key, then confirms; a refused confirm puts the old key back", async () => {
    confirmMode = true;
    await withTempHome("web-login-confirm", async (home) => {
      const first = await runLogin(home, ["login", "--browser", "--json"]);
      assert.equal(first.code, 0, first.stderr);
      const record = async () => JSON.parse(await readFile(path.join(home, ".nexus", "minted-key.json"), "utf8"));
      const original = await record();
      assert.equal(original.keyId, "key-1");

      // Confirmed: the server deletes the old key only after the new one is stored.
      events = [];
      const confirmed = await runLogin(home, ["login", "--browser", "--json", "--force"], { approveAs: "e2e-confirm-1" });
      assert.equal(confirmed.code, 0, confirmed.stderr);
      assert.deepEqual(ndjson(confirmed.stdout).at(-1).key.id, "key-2");
      assert.deepEqual(events, ["token", "confirm", "deleted key-1"]);
      assert.deepEqual(confirmCalls.at(-1), {
        grant_type: "confirm_refresh", code: "e2e-confirm-1", code_verifier: confirmCalls.at(-1).code_verifier, redirect_uri: tokenCalls.at(-1).redirect_uri, key_id: "key-2",
      });
      assert.equal(s256(confirmCalls.at(-1).code_verifier), s256(tokenCalls.at(-1).code_verifier), "the redeem's verifier");
      assert.match(confirmed.stderr, /Deleted this machine's previous key/);
      assert.equal((await record()).keyId, "key-2");
      assert.equal(grpcCalls.length, 0, "no API key deletes a key");

      // Confirmed, but the server couldn't delete the old key: both exist, and the user is told.
      deleteFails = true;
      const bothKept = await runLogin(home, ["login", "--browser", "--json", "--force"], { approveAs: "e2e-confirm-2" });
      assert.equal(bothKept.code, 0, bothKept.stderr);
      assert.match(bothKept.stderr, /Couldn't delete this machine's previous key \(nexus-[^)]+\)\. Delete it at https:\/\/nexus\.fireworks\.ai\/settings\/api-keys/);
      assert.equal((await record()).keyId, "key-3");
      deleteFails = false;

      // Refused (too late, another key, or a lost response): the server keeps
      // the old key and deletes the new one, so this machine goes back to the old key.
      const before = await record();
      confirmReply = { status: 400, body: { error: "invalid_grant", error_description: "refresh not confirmed" } };
      const refused = await runLogin(home, ["login", "--browser", "--json", "--force"], { approveAs: "e2e-confirm-3" });
      assert.equal(refused.code, 1, refused.stderr);
      const result = ndjson(refused.stdout).at(-1);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "refresh_unconfirmed");
      assert.match(result.error.message, /Kept the previous key .*which still works.*nexus login --force/);
      const after = await record();
      assert.equal(after.keyId, before.keyId, "the old key's record is back");
      assert.equal(after.keyFingerprint, before.keyFingerprint, "and the old key itself");
      assert.equal(`${refused.stdout}\n${refused.stderr}`.includes("e2e-confirm-3"), false, "the code is never printed");

      // The new key can't be stored here: never confirmed, so the server deletes
      // it and keeps the old one, which this machine still points at. A
      // read-only folder only fails writes for a non-root user.
      if (process.getuid?.() === 0) return;
      confirmReply = null;
      events = [];
      // Reads still work; every write under ~/.nexus fails.
      const nexusDir = path.join(home, ".nexus");
      await chmod(nexusDir, 0o555);
      let unstored;
      try {
        unstored = await runLogin(home, ["login", "--browser", "--json", "--force"], { approveAs: "e2e-confirm-4" });
      } finally {
        await chmod(nexusDir, 0o755);
      }
      assert.equal(unstored.code, 1, unstored.stderr);
      const unstoredResult = ndjson(unstored.stdout).at(-1);
      assert.equal(unstoredResult.error.code, "refresh_unconfirmed");
      assert.match(unstoredResult.error.message, /couldn't store the new key/);
      assert.equal(events.includes("confirm"), false, "a key that wasn't stored is never confirmed");
      assert.equal((await record()).keyId, after.keyId, "this machine still points at the old key");
    });
  });

  it("confirmWebRefresh never sends a confirm past its deadline, and maps refusals and odd replies", async () => {
    const base = { baseUrl: web.url, code: "c", verifier: "v", redirectUri: "", keyId: "key-1" };
    const late = await confirmWebRefresh({ ...base, deadline: new Date(Date.now() - 1000).toISOString() });
    assert.deepEqual(late, { ok: false, targetRevoked: false, failure: "the confirmation window passed", error: "confirm_expired" });
    assert.equal(confirmCalls.length, 0);
    const deadline = new Date(Date.now() + 60_000).toISOString();
    confirmReply = { status: 400, body: { error: "invalid_grant" } };
    assert.equal((await confirmWebRefresh({ ...base, deadline })).error, "invalid_grant");
    assert.equal(confirmCalls.at(-1).grant_type, "confirm_refresh");
    confirmReply = { status: 200, body: {} };
    assert.equal((await confirmWebRefresh({ ...base, deadline })).error, "server_error");
    confirmReply = { status: 200, body: { previous_key_revoked: true } };
    assert.deepEqual(await confirmWebRefresh({ ...base, deadline }), { ok: true, targetRevoked: true, failure: "", error: "" });
    const offline = await confirmWebRefresh({ ...base, baseUrl: `http://127.0.0.1:${await freePort()}`, deadline });
    assert.equal(offline.error, "network");
  });

  it("login --browser --json reports when the key expires, and records it with the key's ids", async () => {
    await withTempHome("web-login-expiry", async (home) => {
      // Relative to now, so the key is never inside the renewal window when the
      // test runs. Sent with a +01:00 offset and a fractional second, as an
      // RFC 3339 producer may.
      const expires = new Date(Math.floor(Date.now() / 1000) * 1000 + 60 * 86_400_000 + 500);
      const expiresIso = expires.toISOString();
      expireTime = `${new Date(expires.getTime() + 3_600_000).toISOString().slice(0, 19)}.5+01:00`;
      const { code, stdout, stderr } = await runLogin(home, ["login", "--browser", "--json"]);
      assert.equal(code, 0, stderr);
      const result = ndjson(stdout).at(-1);
      assert.equal(result.key.expiresAt, expiresIso);
      const minted = JSON.parse(await readFile(path.join(home, ".nexus", "minted-key.json"), "utf8"));
      assert.equal(minted.expiresAt, expiresIso);
      assert.equal(JSON.stringify(minted).includes(keyFor(1).key), false, "still ids only");

      // Signing in again keeps the key, and its expiry with it.
      expireTime = new Date(expires.getTime() + 60 * 86_400_000).toISOString();
      const again = await runLogin(home, ["login", "--browser", "--json"], { approveAs: "e2e-code-2" });
      const kept = ndjson(again.stdout).at(-1);
      assert.equal(kept.reused, true, again.stderr);
      assert.equal(kept.key.expiresAt, expiresIso);
    });
    for (const malformed of ["next tuesday", "2027-02-11", 1_800_000_000, "2027-02-11T09:00:00"]) {
      expireTime = malformed;
      await withTempHome("web-login-expiry-malformed", async (home) => {
        const { stdout, stderr } = await runLogin(home, ["login", "--browser", "--json"]);
        const result = ndjson(stdout).at(-1);
        assert.equal(result.ok, true, stderr);
        assert.equal("expiresAt" in result.key, false, String(malformed));
      });
    }
  });

  it("nexus login --browser --json maps failures to the desktop's error codes and exits 1", async () => {
    const cases = [
      [() => { tokenReply = { status: 400, body: { error: "invalid_grant" } }; }, "invalid_grant", /expired or was already used/],
      [() => { tokenReply = { status: 403, body: { error: "account_suspended" } }; }, "account_suspended", /suspended/],
      [() => { tokenReply = { status: 503, body: { error: "temporarily_unavailable" } }; }, "unavailable", /isn't available/],
      [() => { tokenReply = { status: 429, body: { error: "slow_down" } }; }, "unavailable", /Too many/],
      [() => { tokenReply = { status: 403, body: { error: "key_limit_reached" } }; }, "key_limit_reached", /API key limit\. Delete an API key/],
      [() => { tokenReply = { status: 200, body: { api_key: "nope" } }; }, "internal", /unexpected response/],
    ];
    for (const [arrange, expected, message] of cases) {
      tokenReply = null;
      arrange();
      await withTempHome("web-login-json-fail", async (home) => {
        const { code, stdout } = await runLogin(home, ["login", "--browser", "--json"]);
        assert.equal(code, 1, expected);
        const { type, ok, error } = ndjson(stdout).at(-1);
        assert.deepEqual({ type, ok, code: error.code }, { type: "result", ok: false, code: expected });
        assert.match(error.message, message);
      });
    }
  });

  it("nexus login --browser --json reports a key that can't be stored as keychain", async () => {
    await withTempHome("web-login-json-keychain", async (home) => {
      const { code, stdout, stderr } = await runLogin(home, ["login", "--browser", "--json"], {
        env: { NEXUS_SECRET_STORE: "", NEXUS_KEY_STORAGE: "null" },
      });
      assert.equal(code, 1, stderr);
      const { error } = ndjson(stdout).at(-1);
      assert.equal(error.code, "keychain");
      assert.match(error.message, /^Couldn't store the API key on this machine/);
    });
  });

  it("nexus login --browser --json names a damaged sign-in record, not the keychain", async () => {
    await withTempHome("web-login-json-bad-record", async (home) => {
      await mkdir(path.join(home, ".nexus"), { recursive: true });
      await writeFile(path.join(home, ".nexus", "minted-key.json"), "{not json");
      const { code, stdout, stderr } = await runLogin(home, ["login", "--browser", "--json"]);
      assert.equal(code, 1, stderr);
      const { error } = ndjson(stdout).at(-1);
      assert.equal(error.code, "internal");
      assert.match(error.message, /sign-in record \(~\/\.nexus\/minted-key\.json\) can't be read/);
      assert.doesNotMatch(error.message, /keychain/i);
    });
  });

  it("nexus login --browser --json exits 130 with a cancelled result on SIGTERM", async () => {
    await withTempHome("web-login-json-sigterm", async (home) => {
      let signalled = false;
      const started = Date.now();
      const { code, stdout } = await runLogin(home, ["login", "--browser", "--json"], {
        onOutput: (child, out) => {
          if (!signalled && out.includes("authorize_url")) {
            signalled = true;
            child.kill("SIGTERM");
          }
        },
      });
      assert.equal(code, 130);
      const result = ndjson(stdout).at(-1);
      assert.deepEqual(result, { type: "result", ok: false, error: { code: "cancelled", message: "Sign-in was cancelled." } });
      assert.ok(Date.now() - started < 5000);
      assert.equal(tokenCalls.length, 0);
    });
  });

  it("nexus login --json without --browser is a usage error (exit 2)", async () => {
    await withTempHome("web-login-json-usage", async (home) => {
      const { code, stdout } = await runLogin(home, ["login", "--json"]);
      assert.equal(code, 2);
      assert.equal(ndjson(stdout).at(-1).error.code, "usage");
    });
  });

  it("nexus login --browser --json fails as unavailable when the web app doesn't speak version 2; no other browser flow runs", async () => {
    for (const [body, env] of [[{ version: 1 }, { NEXUS_WEB_AUTH: "auto", NEXUS_TEST: "" }], [{ version: 2 }, { NEXUS_WEB_AUTH: "off" }]]) {
      probeBody = body;
      await withTempHome("web-login-json-unavailable", async (home) => {
        const { code, stdout, stderr } = await runLogin(home, ["login", "--browser", "--json"], { env });
        assert.equal(code, 1, stderr);
        const { error } = ndjson(stdout).at(-1);
        assert.equal(error.code, "unavailable");
        assert.match(error.message, /Browser sign-in isn't available right now\. Try again in a moment\./);
        assert.equal(ndjson(stdout).length, 1, "no authorize_url: nothing was opened");
        assert.equal(tokenCalls.length, 0);
        assert.doesNotMatch(stderr, /amazoncognito|device-auth|one-time code/i);
      });
    }
  });

  it("--no-open emits the URL and waits without opening a browser; --signup and --select-account reach the page", async () => {
    const port = await freePort();
    const seen = [];
    let pending = Promise.resolve();
    const result = await signInViaWebApp({
      baseUrl: web.url,
      port,
      noOpen: true,
      signup: true,
      selectAccount: "example-account",
      open: async () => assert.fail("--no-open must not open a browser"),
      onEvent: (event) => {
        seen.push(event);
        if (event.type === "authorize_url") {
          pending = browse(event.url).then((authorize) => {
            const url = new URL(authorize);
            assert.equal(url.searchParams.get("screen_hint"), "signup");
            assert.equal(url.searchParams.get("account_hint"), "example-account");
            assert.equal(url.searchParams.has("account"), false, "account= would switch the web session's active account");
            const { code, state, redirectUri } = approve(authorize);
            setImmediate(() => land(`${redirectUri}?code=${code}&state=${state}`));
          });
        }
      },
    });
    await pending;
    assert.equal(result.ok, true, result.failure);
    assert.deepEqual(seen.map((event) => event.type), ["authorize_url", "waiting", "exchanging"]);
  });

  describe("no browser and no terminal", () => {
    it("sign-in and revoke fail at once instead of waiting out the callback timeout", async () => {
      const started = Date.now();
      const lines = [];
      const signIn = await signInViaWebApp({
        baseUrl: web.url, port: await freePort(), interactive: false, open: async () => false, onStatus: (line) => lines.push(line),
      });
      assert.equal(signIn.ok, false);
      assert.equal(signIn.error, "no_browser");
      assert.match(signIn.failure, /^Couldn't open a browser here, and there's no terminal to show the sign-in URL in\./);
      const refresh = await signInViaWebApp({
        baseUrl: web.url, port: await freePort(), interactive: false, open: async () => false, action: "refresh", keyId: "key-9",
      });
      assert.equal(refresh.error, "no_browser");
      const revoke = await revokeViaWebApp({ keyId: "key-9", baseUrl: web.url, port: await freePort(), interactive: false, open: async () => false });
      assert.deepEqual(revoke, {
        ok: false, fatal: false, error: "no_browser",
        failure: "couldn't open a browser here to approve it, and there's no terminal to show the URL in",
      });
      assert.ok(Date.now() - started < 5000, "the default 5-minute wait never ran");
      assert.equal(tokenCalls.length, 0);
      assert.doesNotMatch(lines.join("\n"), /open this URL/, "nobody is there to read it");
    });

    it("still waits when the browser opened (the desktop app) or a terminal shows the URL", async () => {
      // No terminal, but the browser opened: wait for the approval.
      const desktop = await revokeViaWebApp({
        keyId: "key-9", baseUrl: web.url, port: await freePort(), interactive: false,
        open: async (url) => {
          const { code, state, redirectUri } = approve(await browse(url));
          setTimeout(() => land(`${redirectUri}?code=${code}&state=${state}`, { redirect: "manual" }).catch(() => {}), 50);
          return true;
        },
      });
      assert.equal(desktop.ok, true, desktop.failure);
      // A terminal and no browser: the URL is shown, and the wait runs to its timeout.
      const lines = [];
      const atTerminal = await signInViaWebApp({
        baseUrl: web.url, port: await freePort(), interactive: true, open: async () => false, timeoutMs: 100,
        onStatus: (line) => lines.push(line),
      });
      assert.equal(atTerminal.error, "timeout");
      assert.match(lines.join("\n"), /Couldn't open a browser here\. To sign in, open this URL/);
      // --no-open leaves opening to the caller: it waits too.
      const noOpen = await signInViaWebApp({ baseUrl: web.url, port: await freePort(), interactive: false, noOpen: true, timeoutMs: 100 });
      assert.equal(noOpen.error, "timeout");
    });
  });

  it("falls back to a free port when the callback port is taken and the browser is on this machine", async () => {
    const taken = await startServer(() => {});
    const takenPort = Number(new URL(taken.url).port);
    try {
      const lines = [];
      let page = "";
      const result = await signInViaWebApp({
        baseUrl: web.url,
        port: takenPort,
        portFallback: true,
        openBrowser: true,
        onStatus: (line) => lines.push(line),
        open: async (url) => {
          page = url;
          const authorizeUrl = await browse(url);
          const { code, state, redirectUri } = approve(authorizeUrl);
          setImmediate(() => land(`${redirectUri}?code=${code}&state=${state}`));
          return true;
        },
      });
      assert.equal(result.ok, true, result.failure);
      const port = Number(new URL(page).port);
      assert.notEqual(port, takenPort);
      assert.ok(port >= 49152 && port <= 65535, String(port));
      assert.equal(tokenCalls[0].redirect_uri, `http://localhost:${port}/callback`, "the redeem names the fallback port");
      assert.ok(lines.some((line) => line.includes(`Port ${takenPort} is in use, so this sign-in uses port ${port} instead.`)), lines.join("\n"));
    } finally {
      taken.server.close();
    }
  });

  it("over SSH (or without fallback) a taken port stays an error: the forward names 18000", async () => {
    const taken = await startServer(() => {});
    try {
      const port = Number(new URL(taken.url).port);
      const remote = await signInViaWebApp({ baseUrl: web.url, port, portFallback: true, openBrowser: false, open: async () => assert.fail("no browser over SSH") });
      assert.equal(remote.error, "port_in_use");
      const pinned = await signInViaWebApp({ baseUrl: web.url, port, openBrowser: true, open: async () => assert.fail("nothing to open") });
      assert.equal(pinned.error, "port_in_use", "a pinned (non-default) port never falls back");
      assert.equal(tokenCalls.length, 0);
    } finally {
      taken.server.close();
    }
  });

  it("names a taken callback port and a callback timeout", async () => {
    const taken = await startServer(() => {});
    try {
      const busy = await signInViaWebApp({ baseUrl: web.url, port: Number(new URL(taken.url).port), noOpen: true });
      assert.equal(busy.error, "port_in_use");
    } finally {
      taken.server.close();
    }
    const late = await signInViaWebApp({ baseUrl: web.url, port: await freePort(), noOpen: true, timeoutMs: 50 });
    assert.equal(late.error, "timeout");
  });

  describe("paste-the-code (oob redirect)", () => {
    it("prints the URL, reads the pasted code and redeems it with the oob redirect; no listener", async () => {
      const lines = [];
      let asked = "";
      let url;
      const result = await signInViaWebApp({
        baseUrl: web.url,
        port: await freePort(),
        host: "remote box",
        pasteCode: true,
        interactive: true,
        open: async () => assert.fail("paste-the-code never opens a browser here"),
        onStatus: (line) => lines.push(line),
        onEvent: (event) => { if (event.type === "authorize_url") url = event.url; },
        readCode: async (question) => {
          asked = question;
          const { code, redirectUri } = approve(url, "pasted-code");
          assert.equal(redirectUri, OOB_REDIRECT_URI);
          return ` ${code} `;
        },
      });
      assert.equal(result.ok, true, result.failure);
      assert.equal(result.keyId, "key-1");
      assert.match(asked, /Paste the code shown in your browser:/);
      assert.equal(tokenCalls[0].redirect_uri, OOB_REDIRECT_URI);
      assert.equal(tokenCalls[0].code, "pasted-code");
      const text = lines.join("\n");
      assert.match(text, /\/nexus\/cli\/authorize\?/);
      assert.match(text, /Only paste a code from a browser you are using right now\. Never paste a code someone sent you\./);
      assert.match(text, /ssh -L \d+:localhost:\d+ <this machine> and run again without --paste-code/);
    });

    it("refuses without a terminal to paste into, and an empty paste changes nothing", async () => {
      const noTty = await signInViaWebApp({ baseUrl: web.url, pasteCode: true, interactive: false, readCode: async () => assert.fail("no prompt") });
      assert.equal(noTty.ok, false);
      assert.equal(noTty.error, "paste_needs_tty");
      assert.match(noTty.failure, /needs an interactive terminal/);
      const empty = await signInViaWebApp({ baseUrl: web.url, pasteCode: true, interactive: true, readCode: async () => "" });
      assert.equal(empty.ok, false);
      assert.equal(empty.fatal, true);
      assert.equal(tokenCalls.length, 0);
    });

    /** A code approved from some other terminal's URL: bound to a verifier this one never had. */
    const someoneElsesCode = (code = "someone-elses-code") => {
      issued.set(code, { challenge: s256("another-terminals-verifier"), redirectUri: OOB_REDIRECT_URI, action: "signin", keyId: "" });
      return code;
    };

    it("a code that isn't this terminal's: says so, prints a fresh URL and asks again; never falls back to key paste", async () => {
      const lines = [];
      const urls = [];
      const questions = [];
      const result = await signInViaWebApp({
        baseUrl: web.url,
        pasteCode: true,
        interactive: true,
        open: async () => assert.fail("paste-the-code never opens a browser here"),
        onStatus: (line) => lines.push(line),
        onEvent: (event) => { if (event.type === "authorize_url") urls.push(event.url); },
        readCode: async (question) => {
          questions.push(question);
          return questions.length === 1 ? someoneElsesCode() : approve(urls.at(-1), "my-code").code;
        },
      });
      assert.equal(result.ok, true, result.failure);
      assert.equal(result.keyId, "key-1");
      assert.equal(urls.length, 2, "a fresh approval URL for the retry");
      const challenge = (url) => new URL(url).searchParams.get("code_challenge");
      assert.notEqual(challenge(urls[0]), challenge(urls[1]), "the retry has its own verifier");
      assert.equal(new URL(urls[1]).searchParams.get("redirect_uri"), OOB_REDIRECT_URI);
      assert.deepEqual(questions, ["  Paste the code shown in your browser: ", "  Paste the new code (or press Enter to stop): "]);
      const text = lines.join("\n");
      assert.ok(text.includes(urls[1]), "the new URL is printed");
      assert.ok(text.indexOf(urls[1]) < text.indexOf(PASTED_CODE_REFUSED), "the URL is above the line that points at it");
      assert.ok(text.includes("That code wasn't issued for this terminal, or it expired. Approve again from the URL above and paste the new code."), text);
      assert.doesNotMatch(text, /expired or was already used/, "not the loopback's line");
      assert.deepEqual(tokenCalls.map((call) => call.code), ["someone-elses-code", "my-code"]);
    });

    it("a refused code then Enter stops for good; three refused codes stop as invalid_grant", async () => {
      let asked = 0;
      const stopped = await signInViaWebApp({
        baseUrl: web.url, pasteCode: true, interactive: true,
        readCode: async () => (++asked === 1 ? someoneElsesCode() : ""),
      });
      assert.equal(stopped.ok, false);
      assert.equal(stopped.fatal, true, "fatal: login doesn't move on to the API-key paste");
      assert.equal(stopped.error, "access_denied");

      tokenCalls = [];
      let n = 0;
      const exhausted = await signInViaWebApp({
        baseUrl: web.url, pasteCode: true, interactive: true,
        readCode: async () => someoneElsesCode(`bad-${++n}`),
      });
      assert.equal(exhausted.ok, false);
      assert.equal(exhausted.fatal, true);
      assert.equal(exhausted.error, "invalid_grant");
      assert.equal(exhausted.failure, `${PASTED_CODE_REFUSED} ${BROWSER_SSO_UNSUPPORTED_HINT}`, "an SSO refusal keeps its hint");
      assert.equal(tokenCalls.length, 3, "bounded");
    });

    it("a revoke's refused code gets the same retry", async () => {
      const urls = [];
      let asked = 0;
      const result = await revokeViaWebApp({
        keyId: "key-9", accountHint: "example-account", baseUrl: web.url, pasteCode: true, interactive: true,
        onEvent: (event) => { if (event.type === "authorize_url") urls.push(event.url); },
        readCode: async () => (++asked === 1 ? someoneElsesCode() : approve(urls.at(-1), "revoke-code").code),
      });
      assert.equal(result.ok, true, result.failure);
      assert.equal(new URL(urls[1]).searchParams.get("action"), "revoke");
      assert.equal(new URL(urls[1]).searchParams.get("key_id"), "key-9");
      assert.deepEqual(webDeleted, ["key-9"]);
    });

    it("is used only when asked for with --paste-code, never automatically over SSH, never with an older web app", () => {
      assert.equal(usePasteCode({ flag: "on" }), true);
      assert.equal(usePasteCode({}), false, "SSH included: the default is the loopback through a forwarded port");
      assert.equal(usePasteCode({ flag: "" }), false);
      assert.equal(usePasteCode({ flag: "on", version: 2 }), false, "no oob redirect before version 3");
    });
  });

  describe("revoke through the web app", () => {
    const loopbackApprove = (answer = "approve") => async (page) => {
      const url = await browse(page);
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("action"), "revoke");
      assert.equal(parsed.searchParams.get("key_id"), "key-9");
      assert.equal(parsed.searchParams.get("account_hint"), "example-account");
      assert.equal(parsed.searchParams.has("screen_hint"), false);
      const { code, state, redirectUri } = approve(url);
      const query = answer === "approve" ? `code=${code}&state=${state}` : `error=access_denied&state=${state}`;
      setImmediate(() => land(`${redirectUri}?${query}`, { redirect: "manual" }).catch(() => {}));
      return true;
    };

    it("deletes the key on approval, over the loopback; nothing authenticates with an API key", async () => {
      const result = await revokeViaWebApp({ keyId: "key-9", accountHint: "example-account", baseUrl: web.url, port: await freePort(), open: loopbackApprove() });
      assert.deepEqual(result, { ok: true, failure: "", error: "", fatal: false });
      assert.deepEqual(webDeleted, ["key-9"]);
      assert.equal(tokenCalls[0].display_name, undefined, "a revoke names no new key");
      assert.equal(grpcCalls.length, 0);
    });

    it("over paste-the-code too", async () => {
      let url;
      const result = await revokeViaWebApp({
        keyId: "key-9", accountHint: "example-account", baseUrl: web.url, pasteCode: true, interactive: true,
        onEvent: (event) => { if (event.type === "authorize_url") url = event.url; },
        readCode: async () => approve(url, "revoke-code").code,
      });
      assert.equal(result.ok, true, result.failure);
      assert.equal(tokenCalls[0].redirect_uri, OOB_REDIRECT_URI);
      assert.deepEqual(webDeleted, ["key-9"]);
    });

    it("a cancel, a failed delete or a malformed answer is not a revoke", async () => {
      const cancelled = await revokeViaWebApp({ keyId: "key-9", accountHint: "example-account", baseUrl: web.url, port: await freePort(), open: loopbackApprove("cancel") });
      assert.equal(cancelled.ok, false);
      assert.equal(cancelled.fatal, true);
      deleteFails = true;
      const failedDelete = await revokeViaWebApp({ keyId: "key-9", accountHint: "example-account", baseUrl: web.url, port: await freePort(), open: loopbackApprove() });
      assert.equal(failedDelete.ok, false);
      assert.equal(failedDelete.error, "temporarily_unavailable");
      assert.deepEqual(webDeleted, []);
      for (const body of [{}, { revoked: "true" }, { revoked: false }, { api_key: keyFor(3).key }]) {
        tokenReply = { status: 200, body };
        assert.equal((await exchangeRevokeCode({ baseUrl: web.url, code: "c", verifier: "v", redirectUri: OOB_REDIRECT_URI })).ok, false, JSON.stringify(body));
      }
      tokenReply = { status: 400, body: { error: "invalid_grant" } };
      assert.match((await exchangeRevokeCode({ baseUrl: web.url, code: "c", verifier: "v", redirectUri: "" })).failure, /approval code expired/);
    });
  });

  it("nexus logout --revoke --json (the desktop app): revokes through the web app with no terminal, one result line", async () => {
    await withTempHome("web-logout-json", async (home) => {
      const signedIn = await runLogin(home, ["login", "--browser", "--json"]);
      assert.equal(signedIn.code, 0, signedIn.stderr);
      events = [];
      let revokeUrl;
      const { code, stdout, stderr } = await runLogin(home, ["logout", "--revoke", "--json"], {
        approveAs: "revoke-code", onUrl: (url) => { revokeUrl = new URL(url); },
      });
      assert.equal(code, 0, stderr);
      // The revoke's URL comes as an event too, so the app can show or open it.
      const lines = ndjson(stdout);
      assert.deepEqual(lines.map((line) => line.type), ["authorize_url", "waiting", "exchanging", "result"]);
      assert.match(lines[0].url, /^http:\/\/localhost:\d+\/s\/[\w-]+$/, "the one-time local page");
      assert.equal(revokeUrl.searchParams.get("action"), "revoke");
      assert.ok(!Number.isNaN(Date.parse(lines[0].expiresAt)));
      assert.deepEqual(lines.at(-1), { type: "result", ok: true, keyDeleted: true, warnings: [] });
      assert.equal(revokeUrl.searchParams.get("action"), "revoke");
      assert.equal(revokeUrl.searchParams.get("key_id"), "key-1");
      assert.equal(revokeUrl.searchParams.get("account_hint"), "example-account");
      assert.deepEqual(events, ["token", "deleted key-1"]);
      assert.equal(grpcCalls.length, 0);
      assert.match(stderr, /Revoked .* server-side/);
      await assert.rejects(readFile(path.join(home, ".nexus", "minted-key.json")));
    });
  });

  it("nexus logout --json --no-open leaves opening the revoke URL to the app and waits for the approval", async () => {
    await withTempHome("web-logout-json-no-open", async (home) => {
      assert.equal((await runLogin(home, ["login", "--browser", "--json"])).code, 0);
      const { code, stdout, stderr } = await runLogin(home, ["logout", "--json", "--no-open"], { approveAs: "revoke-no-open" });
      assert.equal(code, 0, stderr);
      assert.deepEqual(ndjson(stdout).map((line) => line.type), ["authorize_url", "waiting", "exchanging", "result"]);
      assert.equal(ndjson(stdout).at(-1).keyDeleted, true);
      assert.match(stderr, /Waiting for the approval at/);
      assert.doesNotMatch(stderr, /Over SSH/, "--no-open: the app opens it, so no port-forward hint");
    });
  });

  it("nexus logout --json answers a SIGTERM while it waits on the browser: exit 130, a cancelled result, still signed in", async () => {
    await withTempHome("web-logout-json-sigterm", async (home) => {
      assert.equal((await runLogin(home, ["login", "--browser", "--json"])).code, 0);
      tokenCalls = [];
      let signalled = false;
      const started = Date.now();
      const { code, stdout } = await runLogin(home, ["logout", "--json"], {
        // The URL is on stderr for people (and an authorize_url line on stdout).
        onOutput: (child, out, err) => {
          if (!signalled && /localhost:\d+\/s\//.test(err)) {
            signalled = true;
            child.kill("SIGTERM");
          }
        },
      });
      assert.equal(code, 130);
      assert.deepEqual(ndjson(stdout).at(-1), { type: "result", ok: false, error: { code: "cancelled",
        message: "Log out was cancelled: you're still signed in on this machine. Run nexus logout again." } });
      assert.ok(Date.now() - started < 5000);
      assert.equal(tokenCalls.length, 0, "nothing was redeemed");
      assert.equal(JSON.parse(await readFile(path.join(home, ".nexus", "minted-key.json"), "utf8")).keyId, "key-1", "the record is kept");
    });
  });

  it("nexus logout --json when the web app can't delete the key: logged out, keyDeleted false, a warning", async () => {
    await withTempHome("web-logout-json-fail", async (home) => {
      assert.equal((await runLogin(home, ["login", "--browser", "--json"])).code, 0);
      deleteFails = true;
      const { code, stdout, stderr } = await runLogin(home, ["logout", "--json"], { approveAs: "revoke-code" });
      assert.equal(code, 0, stderr);
      const result = ndjson(stdout).at(-1);
      assert.equal(result.keyDeleted, false);
      assert.match(result.warnings[0], /^Couldn't delete this machine's API key on Fireworks \(.*\)\. Delete it at https:\/\/nexus\.fireworks\.ai\/settings\/api-keys/);
      assert.equal(grpcCalls.length, 0);
      await assert.rejects(readFile(path.join(home, ".nexus", "minted-key.json")));
    });
  });

  /**
   * PATH for a run off SSH: an empty folder (no browser opener, like a CI
   * box), or one whose opener "opens" (exits 0, like the desktop app's).
   */
  async function browserPath(home, { opens }) {
    const dir = path.join(home, opens ? "bin-opens" : "bin-empty");
    await mkdir(dir, { recursive: true });
    if (opens) {
      for (const name of ["xdg-open", "open"]) {
        await writeFile(path.join(dir, name), "#!/bin/sh\nexit 0\n");
        await chmod(path.join(dir, name), 0o755);
      }
    }
    return { PATH: dir, SSH_CONNECTION: "", SSH_CLIENT: "", SSH_TTY: "" };
  }

  it("nexus logout --json with no browser and no terminal logs out at once and says until when the key stays active", { skip: process.platform === "win32" }, async () => {
    await withTempHome("web-logout-no-browser", async (home) => {
      expireTime = "2099-01-02T03:04:05Z";
      assert.equal((await runLogin(home, ["login", "--browser", "--json"])).code, 0);
      const env = await browserPath(home, { opens: false });
      const started = Date.now();
      // Nothing approves: a run that waited would hit the test timeout.
      const { code, stdout, stderr } = await runLogin(home, ["logout", "--json"], { env, onOutput: () => {} });
      assert.ok(Date.now() - started < 15_000, "no wait for an approval nobody can give");
      assert.equal(code, 0, stderr);
      const lines = ndjson(stdout);
      // Nobody could be asked: the URL was announced, nothing was waited on.
      assert.deepEqual(lines.map((line) => line.type), ["authorize_url", "waiting", "result"]);
      const result = lines.at(-1);
      assert.equal(result.ok, true);
      assert.equal(result.keyDeleted, false);
      assert.equal(result.warnings.length, 1, result.warnings.join("\n"));
      assert.match(result.warnings[0], /^nexus-\S+ stays active until 2099-01-02; revoke it at https:\/\/nexus\.fireworks\.ai\/settings\/api-keys$/);
      assert.equal(tokenCalls.length, 1, "only the sign-in's redeem");
      await assert.rejects(readFile(path.join(home, ".nexus", "minted-key.json")), "logged out: the record is gone");

      // login --browser --force --json in the same spot fails at once too.
      assert.equal((await runLogin(home, ["login", "--browser", "--json"], { approveAs: "e2e-code-2" })).code, 0);
      const forced = await runLogin(home, ["login", "--browser", "--force", "--json"], { env, onOutput: () => {} });
      assert.equal(forced.code, 1, forced.stderr);
      const { error } = ndjson(forced.stdout).at(-1);
      assert.equal(error.code, "no_browser");
      assert.match(error.message, /no terminal to show the sign-in URL in/);
      assert.equal(JSON.parse(await readFile(path.join(home, ".nexus", "minted-key.json"), "utf8")).keyId, "key-2", "the key is kept");
      assert.ok(Date.now() - started < 30_000);
    });
  });

  it("nexus logout --revoke --json with no terminal still waits for the approval when the browser opens (the desktop app)", { skip: process.platform === "win32" }, async () => {
    await withTempHome("web-logout-desktop-opens", async (home) => {
      assert.equal((await runLogin(home, ["login", "--browser", "--json"])).code, 0);
      const env = await browserPath(home, { opens: true });
      // The browser "opened"; the user approves the URL it was given.
      const { code, stdout, stderr } = await runLogin(home, ["logout", "--revoke", "--json"], { env, approveAs: "desktop-revoke-code" });
      assert.equal(code, 0, stderr);
      // Only NDJSON on stdout, even when the approval lands before the browser
      // opener returns (its late "Opened your browser" line is dropped).
      const lines = ndjson(stdout);
      assert.deepEqual(lines.map((line) => line.type), ["authorize_url", "waiting", "exchanging", "result"]);
      assert.deepEqual(lines.at(-1), { type: "result", ok: true, keyDeleted: true, warnings: [] });
      assert.deepEqual(webDeleted, ["key-1"]);
    });
  });

  it("nexus logout --revoke without a terminal keeps everything when the web app predates key actions", async () => {
    await withTempHome("web-logout-v2", async (home) => {
      assert.equal((await runLogin(home, ["login", "--browser", "--json"])).code, 0);
      probeBody = { version: 2 };
      const { code, stderr } = await runLogin(home, ["logout", "--revoke"], { env: { NEXUS_WEB_AUTH: "auto", NEXUS_TEST: "" } });
      assert.notEqual(code, 0);
      assert.match(stderr, /can't revoke keys for Nexus yet.*Your stored key and revoke record were kept/);
      assert.equal(tokenCalls.length, 1, "only the sign-in's redeem");
      await assert.doesNotReject(readFile(path.join(home, ".nexus", "minted-key.json")));
    });
  });

  describe("discovery probe", () => {
    it("answers the version when the web app speaks one this CLI does (2 or 3), else 0", async () => {
            assert.equal(await probeWebAuthorizeVersion({ baseUrl: web.url }), 2);
      probeBody = { version: 3 };
            assert.equal(await probeWebAuthorizeVersion({ baseUrl: web.url }), 3);
      for (const body of [{ version: 1 }, {}, { version: "2" }, { version: 2.5 }, { version: 4 }]) {
        probeBody = body;
        assert.equal(await probeWebAuthorizeVersion({ baseUrl: web.url }), 0, JSON.stringify(body));
      }
      const old = await startServer((req, res) => json(res, 404, {}));
      try {
        assert.equal(await probeWebAuthorizeVersion({ baseUrl: old.url }), 0);
      } finally {
        old.server.close();
      }
    });

    it("is 0 when offline or hanging, within its timeout", async () => {
      assert.equal(await probeWebAuthorizeVersion({ baseUrl: `http://127.0.0.1:${await freePort()}` }), 0);
      const { server, url } = await startServer(() => {});
      try {
        const started = Date.now();
        assert.equal(await probeWebAuthorizeVersion({ baseUrl: url, timeoutMs: 100 }), 0);
        assert.ok(Date.now() - started < 2000);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });

    it("auto mode uses the web flow only when the web app speaks version 2", async () => {
      probeBody = { version: 1 };
      assert.equal(await webAuthorizeVersion({ env: {}, probe: () => probeWebAuthorizeVersion({ baseUrl: web.url }) }), 0);
      probeBody = { version: 2 };
      assert.equal(await webAuthorizeVersion({ env: {}, probe: () => probeWebAuthorizeVersion({ baseUrl: web.url }) }), 2);
    });
  });
});

describe("key expiry in the token response", () => {
  it("takes RFC 3339 times and ignores anything else", () => {
    assert.equal(parseKeyExpireTime("2027-02-11T09:00:00Z"), "2027-02-11T09:00:00.000Z");
    assert.equal(parseKeyExpireTime("2027-02-11t09:00:00.123456789z"), "2027-02-11T09:00:00.123Z");
    assert.equal(parseKeyExpireTime("2027-02-11T09:00:00-08:00"), "2027-02-11T17:00:00.000Z");
    for (const value of [undefined, null, "", 1_800_000_000, "2027-02-11", "2027-02-11T09:00:00", "2027-13-11T09:00:00Z", "soon", " 2027-02-11T09:00:00Z"]) {
      assert.equal(parseKeyExpireTime(value), "", String(value));
    }
  });
});

describe("redirect URI policy (shared with the web app and the control plane)", () => {
  const { allowed, rejected, exact, loopback } = REDIRECT_POLICY;
  /** The fixture's rule (version 2), exactly as its description states it. */
  const policyAllows = (uri) => {
    if (exact.includes(uri)) return true;
    for (const host of loopback.hosts) {
      const prefix = `${loopback.scheme}://${host}:`;
      if (!uri.startsWith(prefix) || !uri.endsWith(loopback.path)) continue;
      const port = uri.slice(prefix.length, uri.length - loopback.path.length);
      if (/^[1-9]\d*$/.test(port) && Number(port) >= loopback.minPort && Number(port) <= loopback.maxPort) return true;
    }
    return false;
  };

  it("is version 2, and the rule accepts every allowed example and rejects every rejected one", () => {
    assert.equal(REDIRECT_POLICY.version, 2);
    for (const uri of allowed) assert.equal(policyAllows(uri), true, uri);
    for (const uri of rejected) assert.equal(policyAllows(uri), false, JSON.stringify(uri));
  });

  it("every redirect the CLI can send is allowed: 18000 and the whole fallback range", () => {
    for (const port of [18000, 49152, 54321, 65535]) {
      assert.ok(policyAllows(webCallbackUri(port)), webCallbackUri(port));
    }
  });

  it("the redirect the CLI sends by default is exactly an allowed one", () => {
    assert.equal(webCallbackPort({}), 18000);
    assert.equal(webCallbackUri(webCallbackPort({})), WEB_CALLBACK_URI);
    assert.ok(allowed.includes(WEB_CALLBACK_URI), WEB_CALLBACK_URI);
    assert.equal(rejected.includes(WEB_CALLBACK_URI), false);
  });

  it("ignores a test port override that isn't a valid TCP port", () => {
    for (const bad of ["-1", "0", "1.5", "65536", "abc", " "]) {
      assert.equal(webCallbackPort({ NEXUS_WEB_CALLBACK_PORT: bad }), 18000, bad);
    }
  });

  it("a port override pins the port (no fallback); any port from 1024 is inside the policy", () => {
    assert.equal(webCallbackPort({ NEXUS_WEB_CALLBACK_PORT: "18001" }), 18001);
    assert.ok(policyAllows(webCallbackUri(18001)));
    assert.equal(policyAllows(webCallbackUri(1023)), false);
    assert.equal(defaultPortFallback(18000, {}), true);
    assert.equal(defaultPortFallback(18000, { NEXUS_WEB_CALLBACK_PORT: "18000" }), false, "pinned");
    assert.equal(defaultPortFallback(18001, {}), false);
  });

  it("paste-the-code sends exactly the allowed oob string; its near-misses are rejected", () => {
    assert.equal(OOB_REDIRECT_URI, "urn:ietf:wg:oauth:2.0:oob");
    assert.ok(allowed.includes(OOB_REDIRECT_URI));
    for (const nearMiss of ["urn:ietf:wg:oauth:2.0:oob:auto", "URN:IETF:WG:OAUTH:2.0:OOB", "urn:ietf:wg:oauth:2.0:oob "]) {
      assert.ok(rejected.includes(nearMiss), nearMiss);
    }
    assert.deepEqual(allowed.filter((uri) => !uri.startsWith("http://")), [OOB_REDIRECT_URI], "the only non-loopback redirect");
  });

  it("the callback listener answers every allowed loopback redirect's Host; the only other one is [::1], which the web app never redirects to", () => {
    // Whatever port the listener is on (18000 or a fallback), it answers
    // that port's allowed redirect hosts.
    for (const uri of allowed.filter((entry) => entry.startsWith("http://"))) {
      const { host, port, pathname } = new URL(uri);
      assert.ok(loopbackHostHeaders(Number(port)).includes(host), uri);
      assert.equal(pathname, "/callback");
    }
    const hosts = loopbackHostHeaders(18000);
    const extra = hosts.filter((host) => !allowed.some((uri) => uri.startsWith("http://") && new URL(uri).host === host));
    assert.deepEqual(extra, ["[::1]:18000"]);
    assert.ok(rejected.includes("http://[::1]:18000/callback"));
  });

  it("authorize and redeem carry the same redirect_uri", async () => {
    const tokenBodies = [];
    const { server, url } = await new Promise((resolve) => {
      const srv = createServer((req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          tokenBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          json(res, 400, { error: "invalid_grant" });
        });
      });
      srv.listen(0, "127.0.0.1", () => resolve({ server: srv, url: `http://127.0.0.1:${srv.address().port}` }));
    });
    try {
      const port = await freePort();
      let sent = "";
      await signInViaWebApp({
        baseUrl: url,
        port,
        open: async (page) => {
          const authorizeUrl = await browse(page);
          sent = new URL(authorizeUrl).searchParams.get("redirect_uri");
          setImmediate(() => land(`${sent}?code=c&state=${new URL(authorizeUrl).searchParams.get("state")}`, { redirect: "manual" }).catch(() => {}));
          return true;
        },
      });
      assert.equal(sent, webCallbackUri(port));
      assert.equal(tokenBodies[0].redirect_uri, sent);
    } finally {
      server.close();
    }
  });
});

describe("NEXUS_WEB_AUTH gate", () => {
  it("parses on/off/auto", () => {
    assert.equal(webAuthMode({}), "auto");
    assert.equal(webAuthMode({ NEXUS_WEB_AUTH: "on" }), "on");
    assert.equal(webAuthMode({ NEXUS_WEB_AUTH: "1" }), "on");
    assert.equal(webAuthMode({ NEXUS_WEB_AUTH: "OFF" }), "off");
    assert.equal(webAuthMode({ NEXUS_WEB_AUTH: "0" }), "off");
    assert.equal(webAuthMode({ NEXUS_WEB_AUTH: "maybe" }), "auto");
  });
});

describe("webAuthorizeVersion", () => {
  it("on assumes the current version, off is 0, auto probes except under NEXUS_TEST", async () => {
    let probes = 0;
    const probe = async () => { probes += 1; return 2; };
    assert.equal(await webAuthorizeVersion({ env: { NEXUS_WEB_AUTH: "on" }, probe }), 3);
    assert.equal(await webAuthorizeVersion({ env: { NEXUS_WEB_AUTH: "off" }, probe }), 0);
    assert.equal(await webAuthorizeVersion({ env: { NEXUS_TEST: "1" }, probe }), 0);
    assert.equal(probes, 0);
    assert.equal(await webAuthorizeVersion({ env: {}, probe }), 2);
    assert.equal(probes, 1);
  });
});

describe("NEXUS_WEB_APP_URL override", () => {
  it("warns before sending a sign-in to a non-HTTPS remote web app", async (t) => {
    const lines = [];
    t.mock.method(console, "warn", (line) => lines.push(line));
    const port = await freePort();
    const result = await signInViaWebApp({
      baseUrl: "http://example.invalid", port, host: "test host", interactive: false, open: async () => false,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(lines, ["Warning: NEXUS_WEB_APP_URL uses a non-HTTPS remote URL; traffic may be exposed."]);
  });

  it("notes once that key links stay on production when NEXUS_KEYS_URL isn't set", async (t) => {
    const lines = [];
    t.mock.method(console, "warn", (line) => lines.push(line));
    // The note prints once per process: start clean whatever ran before.
    resetKeysUrlNoteForTests();
    const saved = process.env.NEXUS_KEYS_URL;
    delete process.env.NEXUS_KEYS_URL;
    try {
      for (let i = 0; i < 2; i += 1) {
        const port = await freePort();
        const result = await signInViaWebApp({
          baseUrl: "https://console.example.invalid", port, host: "test host", interactive: false, open: async () => false,
        });
        assert.equal(result.ok, false);
      }
    } finally {
      if (saved === undefined) delete process.env.NEXUS_KEYS_URL; else process.env.NEXUS_KEYS_URL = saved;
    }
    assert.deepEqual(lines, ["Note: NEXUS_WEB_APP_URL points at a non-production web app, but NEXUS_KEYS_URL isn't set to an https URL, so Nexus API-key links point at production. Set NEXUS_KEYS_URL to that environment's API-keys page."]);
  });
});

describe("computerName", () => {
  const shortHost = os.hostname().split(".")[0];

  it("uses the macOS Computer Name", async () => {
    const calls = [];
    const name = await computerName({ platform: "darwin", run: (cmd, args) => { calls.push([cmd, ...args]); return "Sam's MacBook Pro\n"; } });
    assert.equal(name, "Sam's MacBook Pro");
    assert.deepEqual(calls, [["scutil", "--get", "ComputerName"]]);
  });

  it("falls back to the short hostname when scutil fails or prints nothing", async () => {
    assert.equal(await computerName({ platform: "darwin", run: () => { throw new Error("scutil missing"); } }), shortHost);
    assert.equal(await computerName({ platform: "darwin", run: async () => { throw new Error("scutil timed out"); } }), shortHost);
    assert.equal(await computerName({ platform: "darwin", run: () => "  \n" }), shortHost);
  });

  it("uses the short hostname off macOS without running anything", async () => {
    for (const platform of ["linux", "win32"]) {
      assert.equal(await computerName({ platform, run: () => assert.fail("ran a command") }), shortHost);
    }
  });
});
