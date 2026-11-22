import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { Buffer } from "node:buffer";
import process from "node:process";
import os from "node:os";
import { withTempHome } from "../helpers.mjs";
import { revokeReplacedKey, runBrowserFlow, runInteractiveSignIn, runSsoBrowserFlow } from "../../lib/auth/login/flows.mjs";
import { storeApiKey } from "../../lib/auth/login/output.mjs";
import { getSecret, resetSecretStoreForTests, setSecret } from "../../lib/keys/secret-store.mjs";
import { resolveFireworksApiKeyValue } from "../../lib/keys/api-key.mjs";
import { FIREWORKS_API_KEY_KEYCHAIN_REF, readGlobalConfig, writeGlobalConfig } from "../../lib/config/global-config.mjs";
import { connect } from "node:net";
import { after, before, describe, it } from "node:test";
import { grpcWebCall, pbDecode, pbField, pbString, pbStringAt } from "../../lib/auth/grpc-web.mjs";
import { defaultReturnTo, jwtClaims, signInViaDeviceFlow, signInViaLocalhostCallback, trustedVerificationUrl } from "../../lib/auth/browser-auth.mjs";
import { listAccountsForIdToken, mintApiKeyForAccount, mintApiKeyFromIdToken, mintedKeyName, mintedKeyStatePath, readMintedKeyState } from "../../lib/keys/mint-api-key.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EMAIL = "dev@example.com";

/** A structurally valid, unsigned JWT — the CLI only ever decodes the payload. */
function fakeJwt(claims) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}
const ID_TOKEN = fakeJwt({ email: EMAIL, exp: 9999999999 });

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

/** Frame a protobuf message (+ OK trailers) the way a gRPC-web server does. */
function grpcWebFrames(message, { status = 0, detail = "" } = {}) {
  const frame = (flag, payload) => {
    const head = Buffer.alloc(5);
    head[0] = flag;
    head.writeUInt32BE(payload.length, 1);
    return Buffer.concat([head, payload]);
  };
  const trailers = Buffer.from(`grpc-status: ${status}\r\n${detail ? `grpc-message: ${encodeURIComponent(detail)}\r\n` : ""}`);
  return message === null
    ? frame(0x80, trailers)
    : Buffer.concat([frame(0, message), frame(0x80, trailers)]);
}

describe("grpc-web codec", () => {
  it("round-trips strings and nested messages", () => {
    const message = Buffer.concat([
      pbString(1, "accounts/test"),
      pbField(2, pbString(2, "nexus-host")),
    ]);
    const fields = pbDecode(message);
    assert.equal(pbStringAt(fields, 1), "accounts/test");
    const nested = pbDecode(fields.get(2)[0]);
    assert.equal(pbStringAt(nested, 2), "nexus-host");
  });

  it("decodes varint fields and skips them cleanly", () => {
    // field 3, wire type 0 (varint 300) followed by a string field
    const message = Buffer.concat([Buffer.from([0x18, 0xac, 0x02]), pbString(1, "x")]);
    assert.equal(pbStringAt(pbDecode(message), 1), "x");
  });

  it("parses message + trailer frames and percent-decoded errors", async () => {
    const { server, url } = await startServer((req, res, body) => {
      // echo the request message back if authorized, else a trailer-only error
      const authed = req.headers.authorization === "bearer good-token";
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      if (!authed) {
        res.end(frameError());
        return;
      }
      res.end(grpcWebFrames(body.subarray(5)));
    });
    function frameError() {
      const trailers = Buffer.from("grpc-status: 16\r\ngrpc-message: bad%20token\r\n");
      const head = Buffer.alloc(5);
      head[0] = 0x80;
      head.writeUInt32BE(trailers.length, 1);
      return Buffer.concat([head, trailers]);
    }

    const ok = await grpcWebCall(url, "Echo", pbString(1, "hello"), "good-token");
    assert.equal(ok.status, 0);
    assert.equal(pbStringAt(pbDecode(ok.message), 1), "hello");

    const denied = await grpcWebCall(url, "Echo", pbString(1, "hello"), "bad");
    assert.equal(denied.status, 16);
    assert.equal(denied.detail, "bad token");
    assert.equal(denied.message, null);

    server.close();
  });
});

describe("device flow", () => {
  const noSleep = () => Promise.resolve();

  /** Device-auth mock whose poll responses follow a script. */
  function startDeviceService(pollScript, { verificationUri, userCode = "ABCD-1234" } = {}) {
    let polls = 0;
    return startServer((req, res) => {
      const url = new URL(req.url, "http://x");
      if (url.searchParams.get("grant_type")) {
        const step = pollScript[Math.min(polls, pollScript.length - 1)];
        polls += 1;
        res.writeHead(step.ok ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(step.body));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        device_code: "dev-code",
        user_code: userCode,
        verification_uri: verificationUri ?? `http://${req.headers.host}/device`,
        verification_uri_complete: verificationUri ?? `http://${req.headers.host}/device?code=ABCD-1234`,
        interval: 1,
        expires_in: 300,
      }));
    });
  }

  it("warns when the device service actually uses an insecure remote override", async (t) => {
    const lines = [];
    const urls = [];
    t.mock.method(console, "warn", (line) => lines.push(line));
    t.mock.method(globalThis, "fetch", async (url) => {
      urls.push(url);
      return new Response(null, { status: 401 });
    });
    const result = await signInViaDeviceFlow({ serviceUrl: "http://example.com", openBrowser: false });
    assert.equal(result.ok, false);
    assert.equal(new URL(urls[0]).origin, "http://example.com");
    assert.deepEqual(lines, ["Warning: NEXUS_DEVICE_AUTH_URL uses a non-HTTPS remote URL; traffic may be exposed."]);
  });

  it("polls through pending and slow_down to tokens", async () => {
    const { server, url } = await startDeviceService([
      { ok: false, body: { error: "authorization_pending" } },
      { ok: false, body: { error: "slow_down" } },
      { ok: true, body: { id_token: ID_TOKEN, refresh_token: "r", expires_in: 3600 } },
    ]);
    const lines = [];
    const result = await signInViaDeviceFlow({
      serviceUrl: url,
      openBrowser: false,
      onStatus: (line) => lines.push(line),
      sleep: noSleep,
    });
    assert.equal(result.ok, true);
    assert.equal(result.email, EMAIL);
    assert.ok(lines.some((l) => l.includes("ABCD-1234")), "shows the one-time code");
    server.close();
  });

  it("refuses a verification link off the service host and strips escapes from the code", async () => {
    for (const verificationUri of ["https://elsewhere.example/device", "file:///etc/passwd", "not a url"]) {
      const { server, url } = await startDeviceService([{ ok: false, body: { error: "denied" } }], { verificationUri });
      const opened = [];
      const result = await signInViaDeviceFlow({ serviceUrl: url, openBrowser: false, sleep: noSleep, onStatus: (l) => opened.push(l) });
      assert.equal(result.ok, false);
      assert.match(result.failure, /unexpected verification link/);
      assert.deepEqual(opened, []);
      server.close();
    }
    const { server, url } = await startDeviceService([{ ok: false, body: { error: "denied" } }], { userCode: "AB\u001b[2JCD" });
    const lines = [];
    await signInViaDeviceFlow({ serviceUrl: url, openBrowser: false, sleep: noSleep, onStatus: (l) => lines.push(l) });
    assert.ok(lines.some((l) => l.includes("ABCD")));
    assert.ok(lines.every((l) => !l.includes("\u001b")));
    server.close();
  });

  it("trustedVerificationUrl wants https on the service's host", () => {
    assert.equal(trustedVerificationUrl("https://device.example/x?c=1", "https://device.example"), "https://device.example/x?c=1");
    assert.equal(trustedVerificationUrl("http://device.example/x", "https://device.example"), "");
    assert.equal(trustedVerificationUrl("https://device.example.evil/x", "https://device.example"), "");
    assert.equal(trustedVerificationUrl("https://u:p@device.example/x", "https://device.example"), "");
    assert.equal(trustedVerificationUrl("https://device.example:8443/x", "https://device.example"), "");
  });

  it("trustedVerificationUrl accepts the default sign-in host when the service is reached under another name", () => {
    const viaOtherName = "https://device-auth.test.example";
    assert.equal(trustedVerificationUrl("https://device-auth.fireworks.ai/device?c=1", viaOtherName),
      "https://device-auth.fireworks.ai/device?c=1");
    assert.equal(trustedVerificationUrl("http://device-auth.fireworks.ai/device", viaOtherName), "");
    assert.equal(trustedVerificationUrl("https://device-auth.fireworks.ai:8443/device", viaOtherName), "");
  });

  it("treats denial as fatal (no paste fallback)", async () => {
    const { server, url } = await startDeviceService([{ ok: false, body: { error: "denied" } }]);
    const result = await signInViaDeviceFlow({ serviceUrl: url, openBrowser: false, sleep: noSleep });
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
    server.close();
  });

  it("stops on expired_token with a recovery line", async () => {
    const { server, url } = await startDeviceService([{ ok: false, body: { error: "expired_token" } }]);
    const result = await signInViaDeviceFlow({ serviceUrl: url, openBrowser: false, sleep: noSleep });
    assert.equal(result.ok, false);
    assert.equal(result.fatal, false);
    assert.match(result.failure, /expired/);
    server.close();
  });

  it("fails softly and silently when the service is unreachable, without starting", async () => {
    let started = 0;
    const lines = [];
    const result = await signInViaDeviceFlow({
      serviceUrl: "http://127.0.0.1:1",
      openBrowser: false,
      sleep: noSleep,
      onStart: () => { started += 1; },
      onStatus: (l) => lines.push(l),
    });
    assert.equal(result.ok, false);
    assert.equal(result.fatal, false);
    assert.equal(result.silent, true);
    assert.match(result.failure, /Couldn't reach/);
    assert.equal(started, 0);
    assert.deepEqual(lines, []);
  });

  it("calls onStart once the service answers with a code", async () => {
    const { server, url } = await startDeviceService([{ ok: false, body: { error: "denied" } }]);
    const order = [];
    await signInViaDeviceFlow({
      serviceUrl: url,
      openBrowser: false,
      sleep: noSleep,
      onStart: () => order.push("start"),
      onStatus: (l) => order.push(l),
    });
    assert.equal(order[0], "start");
    assert.ok(order.some((l) => l.includes("ABCD-1234")));
    server.close();
  });
});

describe("sign-in request deadlines", () => {
  async function withService(t, handle, check) {
    await withTempHome("auth-request-deadline-", async (home) => {
      const savedHome = process.env.HOME;
      process.env.HOME = home;
      const { server, url } = await startServer(handle);
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      try {
        await check(url);
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
      }
    });
  }

  function startBody(res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write("{");
  }

  function initializeDevice(req, res, expiresIn = 300) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      device_code: "example-device-code",
      user_code: "ABCD-1234",
      verification_uri: `http://${req.headers.host}/device`,
      interval: 1,
      expires_in: expiresIn,
    }));
  }

  for (const stallBody of [false, true]) {
    const stalled = stallBody ? "body" : "headers";

    it(`bounds a token exchange with stalled ${stalled}`, { timeout: 5000 }, async (t) => {
      await withService(t, (_req, res) => {
        if (stallBody) startBody(res);
      }, async (url) => {
        const result = await signInViaLocalhostCallback({
          cognitoDomain: url,
          requestTimeoutMs: 150,
          timeoutMs: 2000,
          openBrowser: true,
          open: async (authorizeUrl) => {
            const state = new URL(authorizeUrl).searchParams.get("state");
            await fetch(`http://localhost:18000/?code=example-code&state=${state}`);
            return true;
          },
        });
        assert.equal(result.ok, false);
        assert.equal(result.fatal, false);
        assert.match(result.failure, /Couldn't reach the sign-in service \(request timed out\)/);
      });
    });

    it(`bounds device initialization with stalled ${stalled}`, { timeout: 5000 }, async (t) => {
      await withService(t, (_req, res) => {
        if (stallBody) startBody(res);
      }, async (url) => {
        const result = await signInViaDeviceFlow({ serviceUrl: url, openBrowser: false, requestTimeoutMs: 150 });
        assert.equal(result.ok, false);
        assert.equal(result.fatal, false);
        assert.match(result.failure, /Couldn't reach the one-time code service \(request timed out\)/);
        assert.equal(result.silent, true);
      });
    });

    it(`retries a poll with stalled ${stalled} before succeeding`, { timeout: 5000 }, async (t) => {
      let polls = 0;
      await withService(t, (req, res) => {
        if (!new URL(req.url, "http://localhost").searchParams.has("grant_type")) {
          initializeDevice(req, res);
        } else if (++polls === 1) {
          if (stallBody) startBody(res);
        } else {
          res.end(JSON.stringify({ id_token: ID_TOKEN }));
        }
      }, async (url) => {
        const result = await signInViaDeviceFlow({
          serviceUrl: url, openBrowser: false, requestTimeoutMs: 150, sleep: () => Promise.resolve(),
        });
        assert.equal(result.ok, true);
        assert.equal(result.idToken, ID_TOKEN);
        assert.equal(polls, 2);
      });
    });

    it(`caps a poll with stalled ${stalled} at the overall expiration`, { timeout: 5000 }, async (t) => {
      let polls = 0;
      await withService(t, (req, res) => {
        if (!new URL(req.url, "http://localhost").searchParams.has("grant_type")) {
          initializeDevice(req, res, 0.2);
        } else {
          polls++;
          if (stallBody) startBody(res);
        }
      }, async (url) => {
        const started = Date.now();
        const result = await signInViaDeviceFlow({
          serviceUrl: url, openBrowser: false, requestTimeoutMs: 2000, sleep: () => Promise.resolve(),
        });
        assert.equal(result.ok, false);
        assert.equal(result.fatal, false);
        assert.match(result.failure, /expired/);
        assert.ok(Date.now() - started < 1500);
        assert.equal(polls, 1);
      });
    });

    it(`bounds a gRPC-web call with stalled ${stalled} even with a caller signal`, { timeout: 5000 }, async (t) => {
      await withService(t, (_req, res) => {
        if (stallBody) startBody(res);
      }, async (url) => {
        await assert.rejects(grpcWebCall(url, "Example", Buffer.alloc(0), "", {
          timeoutMs: 150, signal: new AbortController().signal,
        }), (error) => ["TimeoutError", "AbortError"].includes(error.name));
      });
    });
  }

  it("treats timeoutMs 0 as the default bound, not an immediate timeout", { timeout: 5000 }, async (t) => {
    // createApiKey and deleteApiKey pass 0; AbortSignal.timeout(0) would abort at once.
    await withService(t, (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/grpc-web+proto" });
        res.end(grpcWebFrames(pbString(1, "late")));
      }, 50);
    }, async (url) => {
      const reply = await grpcWebCall(url, "Example", Buffer.alloc(0), "", { timeoutMs: 0 });
      assert.equal(reply.status, 0);
      assert.equal(pbStringAt(pbDecode(reply.message), 1), "late");
    });
  });

  it("does not start a poll after expiration during the polling interval", { timeout: 5000 }, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
    const fetch = t.mock.method(globalThis, "fetch", async (input) => {
      assert.equal(new URL(String(input)).searchParams.has("grant_type"), false);
      return Response.json({
        device_code: "example-device-code", user_code: "ABCD-1234",
        verification_uri: "https://auth.example.com/device",
        interval: 1, expires_in: 0.05,
      });
    });
    for (const overshoot of [0, 1]) {
      const sleeps = [];
      const result = await signInViaDeviceFlow({
        serviceUrl: "https://auth.example.com",
        openBrowser: false,
        sleep: async (ms) => {
          sleeps.push(ms);
          t.mock.timers.tick(ms + overshoot);
        },
      });
      assert.equal(result.ok, false);
      assert.match(result.failure, /expired/);
      assert.deepEqual(sleeps, [50]);
    }
    assert.equal(fetch.mock.callCount(), 2);
  });
});

describe("localhost callback flow", () => {
  let cognito;
  const tokenClients = [];

  before(async () => {
    cognito = await startServer((req, res, body) => {
      if (req.url !== "/oauth2/token") {
        res.writeHead(404);
        res.end();
        return;
      }
      const params = new URLSearchParams(body.toString());
      tokenClients.push(params.get("client_id"));
      const ok = params.get("grant_type") === "authorization_code"
        && params.get("code") === "good-code"
        && Boolean(params.get("code_verifier"));
      res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(ok
        ? JSON.stringify({ id_token: ID_TOKEN, access_token: "a", refresh_token: "r", expires_in: 3600 })
        : JSON.stringify({ error: "invalid_grant" }));
    });
  });

  after(() => {
    cognito.server.close();
  });

  /** Start the Nexus flow (our pages) and wait for the listener. */
  async function startNexusFlow() {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      nexusSignInPage: true,
      openBrowser: false,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { lines, pending };
  }

  /**
   * Pull the authorize URL (and its state) from what the flow prints via
   * onStatus: the authorize URL itself, or, with nexusSignInPage, our sign-in
   * page, whose first (Google) button carries it.
   */
  async function stateFrom(lines) {
    const page = /https?:\S+/.exec(lines.join("\n"))?.[0];
    let href = page;
    let cookie = "";
    if (page.startsWith("http://127.0.0.1:18000/s/")) {
      const response = await fetch(page);
      // The page belongs to the first browser that opens it: later loads
      // must carry its cookie, like a reload in that browser would.
      cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
      const html = await response.text();
      href = /<a class="btn" href="([^"]+)"/.exec(html)?.[1].replace(/&amp;/g, "&");
    }
    const url = new URL(href);
    return { page, url, state: url.searchParams.get("state"), cookie };
  }

  it("warns for an insecure remote sign-in domain only when sign-in uses it", async (t) => {
    const lines = [];
    t.mock.method(console, "warn", (line) => lines.push(line));
    const result = await signInViaLocalhostCallback({
      cognitoDomain: "http://example.com",
      openBrowser: true,
      open: async (url) => {
        assert.equal(new URL(url).origin, "http://example.com");
        const state = new URL(url).searchParams.get("state");
        await fetch(`http://localhost:18000/?error=access_denied&state=${state}`);
        return true;
      },
      timeoutMs: 5000,
    });
    assert.equal(result.fatal, true);
    assert.deepEqual(lines, ["Warning: NEXUS_COGNITO_DOMAIN uses a non-HTTPS remote URL; traffic may be exposed."]);
  });

  it("ignores stray requests, honors state, and exchanges the code (PKCE)", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: false,
      returnTo: "terminal",
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50)); // listener up
    const { state } = await stateFrom(lines);
    assert.ok(state, "authorize URL with state was printed");

    // wrong path, wrong state, and forged errors (any local page can fire
    // these cross-origin) are all ignored, not fatal
    await fetch("http://localhost:18000/favicon.ico");
    await fetch(`http://localhost:18000/?code=evil&state=wrong`);
    await fetch("http://localhost:18000/?error=access_denied");
    await fetch(`http://localhost:18000/?error=server_error&state=wrong`);
    const landing = await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    assert.match(await landing.text(), /return to your terminal/i);

    const result = await pending;
    assert.equal(result.ok, true, result.failure);
    assert.equal(result.email, EMAIL);
  });

  it("serves its own sign-in page: social buttons skip Cognito's UI, email uses it", async () => {
    const { lines, pending } = await startNexusFlow();
    const { page, url, state, cookie } = await stateFrom(lines);
    // Our page, not Cognito's: on the IP literal (a squatter on [::1] can't
    // answer it) at a secret path.
    assert.match(page, /^http:\/\/127\.0\.0\.1:18000\/s\/[\w-]{43}$/);
    assert.equal(`${url.origin}${url.pathname}`, `${cognito.url}/oauth2/authorize`);
    assert.equal(url.searchParams.get("identity_provider"), "Google");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:18000");
    const response = await fetch(page, { headers: { cookie } });
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy"), /form-action 'none'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const html = await response.text();
    const providers = [...html.matchAll(/identity_provider=(\w+)/g)].map((m) => m[1]);
    assert.deepEqual(providers, ["Google", "GitHub", "LinkedIn"]);
    // Email goes to Cognito's hosted UI (no identity_provider): passwords are
    // never typed on our page.
    const emailLink = html.split("<a ").find((tag) => tag.includes("Continue with email"));
    const email = /href="([^"]+)"/.exec(emailLink ?? "")?.[1]?.replaceAll("&amp;", "&");
    assert.equal(email, url.href.replace(/&identity_provider=Google$/, ""));
    assert.doesNotMatch(html, /<form|type="password"/);
    assert.equal((await fetch(`${page}/email`)).status, 404);

    // Another local process that doesn't know the path gets no state: not
    // at the root, not at a guessed path.
    for (const other of ["http://localhost:18000/", "http://127.0.0.1:18000/s/guess", "http://127.0.0.1:18000/s/"]) {
      assert.doesNotMatch(await (await fetch(other)).text(), new RegExp(state), other);
    }

    // A DNS-rebinding page reaches the listener under its own Host (or a
    // look-alike one): no page, no state.
    for (const host of ["attacker.example:18000", "localhost:18000.attacker.example"]) {
      const rebound = await new Promise((resolve, reject) => {
        request({ host: "127.0.0.1", port: 18000, path: new URL(page).pathname, headers: { Host: host } }, (res) => {
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => resolve({ status: res.statusCode, body }));
        }).on("error", reject).end();
      });
      assert.equal(rebound.status, 400, host);
      assert.doesNotMatch(rebound.body, new RegExp(state));
    }

    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });

  /** A raw GET to the listener, for paths and headers fetch would normalize. */
  function rawGet(path, headers = {}) {
    return new Promise((resolve, reject) => {
      request({ host: "127.0.0.1", port: 18000, path, headers: { Host: "127.0.0.1:18000", ...headers } }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }).on("error", reject).end();
    });
  }

  it("answers an unparsable request path with 400 and keeps waiting", async () => {
    const { lines, pending } = await startNexusFlow();
    for (const path of ["//", "//:", "http://[", "/%"]) {
      const { status } = await rawGet(path);
      assert.ok(status === 400 || status === 404, `${path} -> ${status}`);
    }
    const { state } = await stateFrom(lines);
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });

  it("the owning browser can reload the sign-in page and complete sign-in", async () => {
    const { lines, pending } = await startNexusFlow();
    const { page, state, cookie } = await stateFrom(lines);
    const reloaded = await rawGet(new URL(page).pathname, { cookie });
    assert.equal(reloaded.status, 200);
    assert.match(reloaded.body, /Continue with Google/);
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });

  for (const headers of [{}, { cookie: "nexus_signin=forged" }]) {
    it(`a claimed sign-in page stops sign-in on a ${headers.cookie ? "wrong-cookie" : "cookieless"} request`, async () => {
      const { lines, pending } = await startNexusFlow();
      const { page, state, cookie } = await stateFrom(lines);
      assert.match(cookie, /^nexus_signin=[\w-]{43}$/);
      // Reload or Back in the same browser still works.
      const again = await rawGet(new URL(page).pathname, { cookie });
      assert.equal(again.status, 200);
      const other = await rawGet(new URL(page).pathname, headers);
      assert.equal(other.status, 409);
      assert.match(other.body, /this sign-in was stopped/);
      assert.doesNotMatch(other.body, new RegExp(state));
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.fatal, true);
      assert.match(result.failure, /second browser/);
    });
  }

  it("hands the opener the authorize URL, so an app never has to load (and claim) the page", async () => {
    const calls = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      nexusSignInPage: true,
      open: async (url, info) => { calls.push({ url, info }); return true; },
      timeoutMs: 5000,
    });
    for (let tries = 0; !calls.length && tries < 100; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(calls.length, 1);
    const { url, info } = calls[0];
    assert.match(url, /^http:\/\/127\.0\.0\.1:18000\/s\//);
    const authorize = new URL(info.authorizeUrl);
    assert.equal(`${authorize.origin}${authorize.pathname}`, `${cognito.url}/oauth2/authorize`);
    const state = authorize.searchParams.get("state");
    // The page is still unclaimed: the user's browser is its first load.
    const first = await fetch(url);
    assert.equal(first.status, 200);
    assert.match(await first.text(), /Continue with Google/);
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });

  it("keeps other clients (SSO pools) on Cognito's own sign-in", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      clientId: "sso-client",
      openBrowser: false,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { page, url, state } = await stateFrom(lines);
    assert.equal(page, url.href, "the printed URL is Cognito's authorize URL");
    assert.equal(url.searchParams.get("client_id"), "sso-client");
    assert.equal(url.searchParams.get("identity_provider"), null);
    assert.doesNotMatch(await (await fetch("http://localhost:18000/")).text(), /Continue with Google/);

    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });

  /** The Nexus flow with "Sign in with SSO": only "acme" has custom SSO. */
  async function startSsoFlow(lookups = []) {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      nexusSignInPage: true,
      openBrowser: false,
      onStatus: (line) => lines.push(line),
      ssoSignIn: async (accountId, { signal }) => {
        assert.ok(signal instanceof AbortSignal, "the lookup can be cancelled");
        lookups.push(accountId);
        return accountId === "acme"
          ? { ok: true, cognitoDomain: cognito.url, clientId: "acme-client" }
          : { ok: false, failure: `Couldn't find SSO sign-in configuration for account "${accountId}".` };
      },
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { lines, pending };
  }

  it("signs in through custom SSO from the sign-in page, with that account's pool", async () => {
    const lookups = [];
    const { lines, pending } = await startSsoFlow(lookups);
    const { page, url, state, cookie } = await stateFrom(lines);
    const ssoPath = `${new URL(page).pathname}/sso`;
    const html = await (await rawGet(new URL(page).pathname, { cookie })).body;
    assert.match(html, new RegExp(`href="${ssoPath}"[^>]*>.*Sign in with SSO`, "s"));

    // Only the browser that owns the page gets the form.
    for (const headers of [{}, { cookie: "nexus_signin=forged" }]) {
      const denied = await rawGet(`${ssoPath}?account=acme`, headers);
      assert.equal(denied.status, 403);
    }
    assert.deepEqual(lookups, []);

    const form = await fetch(`http://127.0.0.1:18000${ssoPath}`, { headers: { cookie } });
    assert.match(form.headers.get("content-security-policy"), /form-action 'self'/);
    const formHtml = await form.text();
    assert.match(formHtml, new RegExp(`<form class="sso" method="get" action="${ssoPath}">`));
    assert.match(formHtml, /name="account"/);
    assert.doesNotMatch(formHtml, new RegExp(state));

    // Malformed IDs never reach the lookup; unknown ones show its reason, escaped.
    const bad = await rawGet(`${ssoPath}?account=%3Cscript%3E`, { cookie });
    assert.match(bad.body, /letters, numbers, and hyphens/);
    assert.match(bad.body, /value="&lt;script&gt;"/);
    const unknown = await rawGet(`${ssoPath}?account=nope`, { cookie });
    assert.match(unknown.body, /Couldn&#39;t find SSO sign-in configuration for account &quot;nope&quot;/);
    assert.deepEqual(lookups, ["nope"]);

    const found = await fetch(`http://127.0.0.1:18000${ssoPath}?account=%20acme%20`, { headers: { cookie }, redirect: "manual" });
    // Not a redirect: one after a form submit is held to form-action 'self'.
    assert.equal(found.status, 200);
    const refresh = found.headers.get("refresh");
    assert.match(refresh, /^0; url=/);
    const tenant = new URL(refresh.slice("0; url=".length));
    assert.ok((await found.text()).includes(`href="${tenant.href.replaceAll("&", "&amp;")}"`));
    assert.equal(`${tenant.origin}${tenant.pathname}`, `${cognito.url}/oauth2/authorize`);
    assert.equal(tenant.searchParams.get("client_id"), "acme-client");
    assert.equal(tenant.searchParams.get("redirect_uri"), "http://localhost:18000");
    assert.equal(tenant.searchParams.get("code_challenge"), url.searchParams.get("code_challenge"));
    const ssoState = tenant.searchParams.get("state");
    assert.ok(ssoState && ssoState !== state);

    tokenClients.length = 0;
    await fetch(`http://localhost:18000/?code=good-code&state=${ssoState}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
    assert.equal(result.ssoAccountId, "acme");
    assert.deepEqual(tokenClients, ["acme-client"]);
  });

  it("a looked-up SSO account doesn't take over a regular sign-in", async () => {
    const { lines, pending } = await startSsoFlow();
    const { page, state, cookie } = await stateFrom(lines);
    await fetch(`http://127.0.0.1:18000${new URL(page).pathname}/sso?account=acme`, { headers: { cookie }, redirect: "manual" });
    tokenClients.length = 0;
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
    assert.equal(result.ssoAccountId, "");
    assert.notDeepEqual(tokenClients, ["acme-client"]);
  });

  it("offers no SSO without a lookup, or on the hosted sign-in", async () => {
    const { lines, pending } = await startNexusFlow();
    const { page, state, cookie } = await stateFrom(lines);
    assert.doesNotMatch((await rawGet(new URL(page).pathname, { cookie })).body, /Sign in with SSO/);
    assert.equal((await rawGet(`${new URL(page).pathname}/sso?account=acme`, { cookie })).status, 404);
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    assert.equal((await pending).ok, true);
  });

  it("drops a browser's unused preconnection when sign-in finishes", async () => {
    const { lines, pending } = await startNexusFlow();
    const { state } = await stateFrom(lines);
    // Chrome opens a spare connection and never sends on it; left alone it
    // holds server.close() (and `nexus login`) for Node's 60s headers timeout.
    const spare = connect(18000, "127.0.0.1");
    await new Promise((resolve) => spare.once("connect", resolve));
    const dropped = new Promise((resolve) => spare.once("close", resolve));
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    assert.equal((await pending).ok, true);
    await Promise.race([
      dropped,
      new Promise((_, reject) => setTimeout(() => reject(new Error("spare connection still open")), 1000)),
    ]);
  });

  /** Whether this machine can bind the IPv6 loopback (some CI containers can't). */
  async function ipv6LoopbackAvailable() {
    return new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(0, "::1", () => probe.close(() => resolve(true)));
    });
  }

  it("refuses to start when another process holds [::1]:18000", async (t) => {
    if (!await ipv6LoopbackAvailable()) {
      t.skip("no IPv6 loopback here");
      return;
    }
    // localhost may resolve to ::1, so a squatter there would receive the
    // Cognito callback (and its state). Sign-in must fail up front instead.
    const squatter = createServer((req, res) => res.end("lookalike"));
    await new Promise((resolve) => squatter.listen(18000, "::1", resolve));
    try {
      const result = await signInViaLocalhostCallback({
        cognitoDomain: cognito.url,
        nexusSignInPage: true,
        openBrowser: false,
        onStatus: () => {},
        timeoutMs: 5000,
      });
      assert.equal(result.ok, false);
      assert.match(result.failure, /Port 18000 is in use/);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it("answers the localhost callback on [::1] too", async (t) => {
    if (!await ipv6LoopbackAvailable()) {
      t.skip("no IPv6 loopback here");
      return;
    }
    const { lines, pending } = await startNexusFlow();
    const { state } = await stateFrom(lines);
    const landing = await fetch(`http://[::1]:18000/?code=good-code&state=${state}`);
    const text = await landing.text();
    // Shown before the token exchange: "finishing", never "signed in".
    assert.match(text, /Almost done/);
    assert.doesNotMatch(text, /signed in\b/i);
    assert.equal((await pending).ok, true);
  });

  it("ignores callbacks addressed to another Host, even with the right state", async () => {
    const { lines, pending } = await startNexusFlow();
    const { state } = await stateFrom(lines);
    // A DNS-rebinding page reaches loopback under its own Host: it gets a
    // 400 and can neither finish nor cancel the sign-in.
    for (const query of [`code=evil&state=${state}`, `error=access_denied&state=${state}`]) {
      const status = await new Promise((resolve, reject) => {
        request({ host: "127.0.0.1", port: 18000, path: `/?${query}`, headers: { Host: "attacker.example:18000" } }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        }).on("error", reject).end();
      });
      assert.equal(status, 400, query);
    }
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });

  it("closes a half-sent request soon after sign-in finishes", async () => {
    const { lines, pending } = await startNexusFlow();
    const { state } = await stateFrom(lines);
    // A request that never finishes its headers isn't "unused", so it used to
    // keep `nexus login` from exiting until Node's request timeout.
    const partial = connect(18000, "127.0.0.1");
    await new Promise((resolve) => partial.once("connect", resolve));
    partial.write("GET / HTTP/1.1\r\nHost: 127.0.0.1:18000\r\n");
    const dropped = new Promise((resolve) => partial.once("close", resolve));
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    assert.equal((await pending).ok, true);
    await Promise.race([
      dropped,
      new Promise((_, reject) => setTimeout(() => reject(new Error("half-sent request still open")), 3000)),
    ]);
  });

  it("sends the user back to the terminal or the Nexus app", async () => {
    // `nexus login` always has a terminal; Nexus desktop's helper has pipes.
    assert.equal(defaultReturnTo({ stdin: { isTTY: true }, stdout: { isTTY: true } }), "terminal");
    assert.equal(defaultReturnTo({ stdin: { isTTY: false }, stdout: { isTTY: true } }), "terminal");
    assert.equal(defaultReturnTo({ stdin: {}, stdout: {} }), "app");

    // The app's result page (passed explicitly: the default depends on
    // whether this test runs from a terminal, covered just above).
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: false,
      returnTo: "app",
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { state } = await stateFrom(lines);
    const landing = await (await fetch(`http://localhost:18000/?code=good-code&state=${state}`)).text();
    assert.match(landing, /Return to the Nexus app\./);
    assert.doesNotMatch(landing, /terminal/i);
    assert.equal((await pending).ok, true);
  });

  it("treats access_denied with the matching state as fatal", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: false,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { state } = await stateFrom(lines);
    await fetch(`http://localhost:18000/?error=access_denied&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
  });

  it("times out with a one-line failure instead of hanging", async () => {
    const result = await signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: false,
      onStatus: () => {},
      timeoutMs: 100,
    });
    assert.equal(result.ok, false);
    assert.match(result.failure, /didn't finish in time/);
  });

  it("surfaces a rejected code exchange as a soft failure", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: false,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { state } = await stateFrom(lines);
    await fetch(`http://localhost:18000/?code=stale-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.fatal, false);
    assert.match(result.failure, /invalid_grant/);
  });

  it("prints the sign-in URL alongside the opened-browser line", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: true, // pin: the runner itself may be an SSH session
      open: async () => true,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(lines.join("\n"), /Your browser is opening/);
    assert.match(lines.join("\n"), /If it didn't open/);
    const { state } = await stateFrom(lines);
    assert.ok(state, "the authorize URL was printed as a fallback");
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });

  it("skips the opener entirely in a remote (SSH) session and prints the URL", async () => {
    process.env.SSH_TTY = "/dev/pts/7";
    try {
      const lines = [];
      let openerCalled = false;
      const pending = signInViaLocalhostCallback({
        cognitoDomain: cognito.url,
        open: async () => { openerCalled = true; return true; },
        onStatus: (line) => lines.push(line),
        timeoutMs: 5000,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(openerCalled, false, "no opener attempt on SSH");
      assert.match(lines.join("\n"), /Open this link in a browser to sign in/);
      const { state } = await stateFrom(lines);
      await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
      const result = await pending;
      assert.equal(result.ok, true, result.failure);
    } finally {
      delete process.env.SSH_TTY;
    }
  });

  it("prints the URL and keeps listening when no browser can be opened", async () => {
    const lines = [];
    const pending = signInViaLocalhostCallback({
      cognitoDomain: cognito.url,
      openBrowser: true, // pin: the runner itself may be an SSH session
      open: async () => false,
      onStatus: (line) => lines.push(line),
      timeoutMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(lines.join("\n"), /Couldn't open a browser\. To sign in/);
    assert.match(lines.join("\n"), /No browser here\? Over SSH, run nexus login there/);
    assert.doesNotMatch(lines.join("\n"), /--paste\b/, "no API-key fallback");
    // The wait is NOT abandoned: the printed URL still completes sign-in
    // (WSL's Windows browser, an SSH port-forward).
    const { state } = await stateFrom(lines);
    assert.ok(state, "the authorize URL was printed");
    await fetch(`http://localhost:18000/?code=good-code&state=${state}`);
    const result = await pending;
    assert.equal(result.ok, true, result.failure);
  });
});

describe("mint-api-key", () => {
  /** gRPC-web gateway mock: ListAccounts → ListUsers → CreateApiKey. */
  function startGateway({ minted = "fw_minted_key_0000000000000000000", authorized = true, accounts = ["accounts/test"], users = ["dev"], nexusAccounts = [], onKeyName = () => {} } = {}) {
    return startServer((req, res, body) => {
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      if (!authorized || req.headers.authorization !== `bearer ${ID_TOKEN}`) {
        res.end(grpcWebFrames(null, { status: 16 }));
        return;
      }
      const message = body.subarray(5);
      if (req.url.endsWith("/ListAccounts")) {
        // Account field 28 as a varint 1 marks a Nexus account.
        const productivityOnly = Buffer.from([0xe0, 0x01, 0x01]);
        res.end(grpcWebFrames(Buffer.concat(accounts.map((a) => pbField(1, Buffer.concat([
          pbString(1, a),
          ...(nexusAccounts.includes(a) ? [productivityOnly] : []),
        ]))))));
      } else if (req.url.endsWith("/ListUsers")) {
        const fields = pbDecode(message);
        const parent = pbStringAt(fields, 1);
        assert.match(parent, /^accounts\//);
        // An email filter narrows to one user; without it (no email claim in
        // the id_token) every configured user comes back, like the real API.
        let matched = users;
        if (pbStringAt(fields, 4)) {
          assert.match(pbStringAt(fields, 4), /email="dev@example\.com"/);
          matched = users.slice(0, 1);
        }
        res.end(grpcWebFrames(Buffer.concat(matched.map((u) => pbField(1, pbString(1, `${parent}/users/${u}`))))));
      } else if (req.url.endsWith("/CreateApiKey")) {
        const fields = pbDecode(message);
        const parent = pbStringAt(fields, 1);
        assert.match(parent, /^accounts\/.+\/users\/dev$/);
        const apiKey = pbDecode(fields.get(2)[0]);
        assert.match(pbStringAt(apiKey, 2), /^nexus-/);
        onKeyName(pbStringAt(apiKey, 2));
        res.end(grpcWebFrames(Buffer.concat([
          pbString(1, "key_test123"),
          pbString(2, pbStringAt(apiKey, 2)),
          pbString(3, minted),
        ])));
      } else {
        res.end(grpcWebFrames(null, { status: 12 }));
      }
    });
  }

  it("walks account → user → key and returns the plaintext once", async () => {
    const { server, url } = await startGateway();
    const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url });
    assert.equal(result.ok, true, result.failure);
    assert.equal(result.key, "fw_minted_key_0000000000000000000");
    assert.equal(result.keyId, "key_test123");
    assert.equal(result.userName, "accounts/test/users/dev");
    server.close();
  });

  it("accepts any printable minted key without quotes or backslashes", async () => {
    const { server, url } = await startGateway({ minted: "fw_Ab9.~+=/:-_0000000000" });
    try {
      const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url });
      assert.equal(result.ok, true, result.failure);
      assert.equal(result.key, "fw_Ab9.~+=/:-_0000000000");
    } finally {
      server.close();
    }
  });

  it("refuses a minted key outside the fw_ charset", async () => {
    const { server, url } = await startGateway({ minted: "fw_abc\"\n[mcp_servers.x]" });
    try {
      const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url });
      assert.equal(result.ok, false);
      assert.equal(result.key, "");
      assert.match(result.failure, /malformed API key/);
    } finally {
      server.close();
    }
  });

  for (const minted of ["fw_{file:~/.ssh/id_rsa}", "fw_{env:HOME}", "fw_abc$HOME"]) {
    it(`refuses a minted key a harness config would expand: ${minted}`, async () => {
      const { server, url } = await startGateway({ minted });
      try {
        const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url });
        assert.equal(result.ok, false);
        assert.equal(result.key, "");
        assert.match(result.failure, /malformed API key/);
      } finally {
        server.close();
      }
    });
  }

  it("listAccountsForIdToken returns every account so the caller can pick", async () => {
    const { server, url } = await startGateway({ accounts: ["accounts/acme", "accounts/personal"] });
    try {
      const listed = await listAccountsForIdToken(ID_TOKEN, { baseUrl: url });
      assert.equal(listed.ok, true, listed.failure);
      assert.deepEqual(listed.accountNames, ["accounts/acme", "accounts/personal"]);
      assert.deepEqual(listed.nexusAccountNames, []);
    } finally {
      server.close();
    }
  });

  it("listAccountsForIdToken gives up on a stalled response when its signal aborts", async () => {
    // Headers arrive, the body never does: without the signal this would hang.
    const { server, url } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      res.write(Buffer.alloc(0));
    });
    try {
      const started = Date.now();
      const listed = await listAccountsForIdToken(ID_TOKEN, { baseUrl: url, signal: AbortSignal.timeout(100) });
      assert.equal(listed.ok, false);
      assert.deepEqual(listed.nexusAccountNames, []);
      assert.match(listed.failure, /Couldn't reach the Fireworks API/);
      assert.ok(Date.now() - started < 2_000, "returns at the deadline");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("listAccountsForIdToken says which accounts are Nexus accounts", async () => {
    const { server, url } = await startGateway({ accounts: ["accounts/acme", "accounts/personal"], nexusAccounts: ["accounts/acme"] });
    try {
      const listed = await listAccountsForIdToken(ID_TOKEN, { baseUrl: url });
      assert.equal(listed.ok, true, listed.failure);
      assert.deepEqual(listed.accountNames, ["accounts/acme", "accounts/personal"]);
      assert.deepEqual(listed.nexusAccountNames, ["accounts/acme"]);
    } finally {
      server.close();
    }
  });

  it("mintApiKeyForAccount mints under the chosen account; the wrapper takes the first", async () => {
    const { server, url } = await startGateway({ accounts: ["accounts/acme", "accounts/personal"] });
    try {
      const picked = await mintApiKeyForAccount(ID_TOKEN, "accounts/personal", { email: EMAIL, baseUrl: url });
      assert.equal(picked.ok, true, picked.failure);
      assert.equal(picked.userName, "accounts/personal/users/dev");

      // The non-interactive wrapper still defaults to the first account.
      const first = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url });
      assert.equal(first.ok, true, first.failure);
      assert.equal(first.userName, "accounts/acme/users/dev");
    } finally {
      server.close();
    }
  });

  it("refuses to guess among users when the sign-in has no email claim", async () => {
    const { server, url } = await startGateway({ users: ["alice", "bob"] });
    try {
      const result = await mintApiKeyForAccount(ID_TOKEN, "accounts/test", { baseUrl: url });
      assert.equal(result.ok, false);
      assert.match(result.failure, /didn't say which/);
      assert.doesNotMatch(result.failure, /--paste\b/);
    } finally {
      server.close();
    }
  });

  it("mints without an email claim when the account has exactly one user", async () => {
    const { server, url } = await startGateway();
    try {
      const result = await mintApiKeyForAccount(ID_TOKEN, "accounts/test", { baseUrl: url });
      assert.equal(result.ok, true, result.failure);
      assert.equal(result.userName, "accounts/test/users/dev");
    } finally {
      server.close();
    }
  });

  it("says the caller isn't a member on a bare ListUsers denial, and keeps a denial's reason", async () => {
    let detail = "";
    const { server, url } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      res.end(grpcWebFrames(null, { status: 7, detail }));
    });
    try {
      const bare = await mintApiKeyForAccount(ID_TOKEN, "accounts/example-account", { email: EMAIL, baseUrl: url });
      assert.equal(bare.ok, false);
      assert.match(bare.failure, /not a member of "example-account"/);

      detail = "SSO authentication is required";
      const explained = await mintApiKeyForAccount(ID_TOKEN, "accounts/example-account", { email: EMAIL, baseUrl: url });
      assert.equal(explained.ok, false);
      assert.match(explained.failure, /SSO authentication is required/);
      assert.doesNotMatch(explained.failure, /not a member/);
    } finally {
      server.close();
    }
  });

  it("points an SSO-required denial at the SSO sign-in, unless the sign-in already came through SSO", async () => {
    let detail = "SSO authentication is required";
    const { server, url } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      res.end(grpcWebFrames(null, { status: 7, detail }));
    });
    try {
      const browser = await mintApiKeyForAccount(ID_TOKEN, "accounts/example-account", { email: EMAIL, baseUrl: url });
      assert.equal(browser.ok, false);
      assert.match(browser.failure, /SSO authentication is required/);
      assert.match(browser.failure, /nexus login --account <account-id>/);

      const sso = await mintApiKeyForAccount(ID_TOKEN, "accounts/example-account", {
        email: EMAIL,
        baseUrl: url,
        ssoSignIn: true,
      });
      assert.equal(sso.ok, false);
      assert.match(sso.failure, /SSO authentication is required/);
      assert.doesNotMatch(sso.failure, /--account/);

      detail = "role editor is required to list users";
      const role = await mintApiKeyForAccount(ID_TOKEN, "accounts/example-account", { email: EMAIL, baseUrl: url });
      assert.equal(role.ok, false);
      assert.match(role.failure, /role editor is required/);
      assert.doesNotMatch(role.failure, /--account/);
    } finally {
      server.close();
    }
  });

  it("points an SSO-required CreateApiKey denial at the SSO sign-in too", async () => {
    let ssoSignIn = false;
    const { server, url } = await startServer((req, res, body) => {
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto" });
      if (req.url.endsWith("/ListUsers")) {
        const parent = pbStringAt(pbDecode(body.subarray(5)), 1);
        res.end(grpcWebFrames(pbField(1, pbString(1, `${parent}/users/dev`))));
        return;
      }
      res.end(grpcWebFrames(null, { status: 7, detail: "account requires single sign-on" }));
    });
    try {
      const browser = await mintApiKeyForAccount(ID_TOKEN, "accounts/example-account", { email: EMAIL, baseUrl: url });
      assert.equal(browser.ok, false);
      assert.match(browser.failure, /creating an API key \(account requires single sign-on\)/);
      assert.match(browser.failure, /nexus login --account <account-id>/);

      ssoSignIn = true;
      const sso = await mintApiKeyForAccount(ID_TOKEN, "accounts/example-account", { email: EMAIL, baseUrl: url, ssoSignIn });
      assert.equal(sso.ok, false);
      assert.match(sso.failure, /account requires single sign-on/);
      assert.doesNotMatch(sso.failure, /--account/);
    } finally {
      server.close();
    }
  });

  it("maps an unauthenticated token to a try-again line, with no API-key fallback", async () => {
    const { server, url } = await startGateway({ authorized: false });
    const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url });
    assert.equal(result.ok, false);
    assert.match(result.failure, /wasn't accepted.*Try again/);
    assert.doesNotMatch(result.failure, /--paste\b/);
    server.close();
  });

  it("fails softly when the Fireworks API is unreachable", async () => {
    const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: "http://127.0.0.1:1" });
    assert.equal(result.ok, false);
    assert.match(result.failure, /Couldn't reach/);
  });

  it("names keys with an explicit origin and sanitized hostname", () => {
    assert.equal(mintedKeyName("Example-Workstation.local", "cli"), "nexus-cli-example-workstation");
    assert.equal(mintedKeyName("host_with.dots", "desktop"), "nexus-desktop-host-with");
    assert.equal(mintedKeyName("", "cli"), "nexus-cli-unknown-host");
    assert.equal(mintedKeyName("", "desktop"), "nexus-desktop-unknown-host");
    assert.equal(mintedKeyName("host", "unrecognized"), "nexus-cli-host");
    assert.equal(mintedKeyName("host", ""), "nexus-cli-host");
  });

  it("reads the explicit desktop signal at call time, defaulting to CLI", () => {
    const previous = process.env.NEXUS_CLIENT;
    try {
      delete process.env.NEXUS_CLIENT;
      assert.equal(mintedKeyName("host"), "nexus-cli-host");
      process.env.NEXUS_CLIENT = "desktop";
      assert.equal(mintedKeyName("host"), "nexus-desktop-host");
      process.env.NEXUS_CLIENT = "other";
      assert.equal(mintedKeyName("host"), "nexus-cli-host");
    } finally {
      if (previous === undefined) delete process.env.NEXUS_CLIENT;
      else process.env.NEXUS_CLIENT = previous;
    }
  });

  for (const client of ["cli", "desktop"]) {
    it(`sends the ${client} display name in the key creation request`, async () => {
      const names = [];
      const { server, url } = await startGateway({ onKeyName: (name) => names.push(name) });
      try {
        const keyName = mintedKeyName("Test-Machine.local", client);
        const result = await mintApiKeyFromIdToken(ID_TOKEN, { email: EMAIL, baseUrl: url, keyName });
        assert.equal(result.ok, true, result.failure);
        assert.deepEqual(names, [`nexus-${client}-test-machine`]);
      } finally {
        server.close();
      }
    });
  }

  for (const client of ["cli", "desktop"]) {
    it(`keeps the ${client} created name consistent with state and login output`, async (t) => {
      await withTempHome("key-origin-", async (home) => {
        const envKeys = ["HOME", "NEXUS_CLIENT", "FIREWORKS_API_KEY", "SSH_CONNECTION", "NEXUS_SECRET_STORE", "NEXUS_TEST"];
        const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
        Object.assign(process.env, { HOME: home, NEXUS_CLIENT: client, FIREWORKS_API_KEY: "", SSH_CONNECTION: "test", NEXUS_SECRET_STORE: "memory", NEXUS_TEST: "1" });
        resetSecretStoreForTests();
        const hostnameMock = t.mock.method(os, "hostname", () => "example-host");
        const realFetch = globalThis.fetch;
        const lines = [];
        let createdName;
        let callback;
        const identityResponse = () => new Response(null, { headers: { "x-fireworks-developer-email": EMAIL } });
        // Local-only replies for token exchange, account/user lookup, creation,
        // and both identity checks. Unexpected requests fail closed.
        const replies = [
          () => Response.json({ id_token: ID_TOKEN }),
          () => new Response(grpcWebFrames(pbField(1, pbString(1, "accounts/test")))),
          () => new Response(grpcWebFrames(pbField(1, pbString(1, "accounts/test/users/dev")))),
          (_url, options) => {
            const request = pbDecode(options.body.subarray(5));
            createdName = pbStringAt(pbDecode(request.get(2)[0]), 2);
            // A changed environment after creation must not change local metadata/output.
            process.env.NEXUS_CLIENT = client === "desktop" ? "cli" : "desktop";
            return new Response(grpcWebFrames(Buffer.concat([
              pbString(1, "key-origin-test"), pbString(2, createdName),
              pbString(3, "fw_origin_test_0000000000000000000"),
            ])));
          },
          identityResponse,
          identityResponse,
        ];
        const fetchMock = t.mock.method(globalThis, "fetch", async (...args) => {
          const reply = replies.shift();
          assert.ok(reply, "unexpected auth request");
          return reply(...args);
        });
        const logMock = t.mock.method(console, "log", (...args) => {
          const line = args.join(" ");
          lines.push(line);
          // A Platform sign-in prints the hosted authorize URL (remote session).
          const match = line.match(/https:\/\/\S+\/oauth2\/authorize\?\S+/);
          if (match && !callback) {
            const state = new URL(match[0]).searchParams.get("state");
            callback = realFetch(`http://127.0.0.1:18000/?code=test&state=${state}`);
            callback.catch(() => {});
          }
        });
        try {
          // A former SSO account must not be offered after a shared-page sign-in.
          await writeGlobalConfig(home, { ssoAccountId: "former-company" });
          assert.equal(await runInteractiveSignIn(home, { accountType: "platform", nextHint: false }), true);
          await callback;
          assert.equal((await readGlobalConfig(home)).ssoAccountId, "");
          assert.equal(replies.length, 0);
          assert.equal(createdName, mintedKeyName(os.hostname(), client));
          const state = await readMintedKeyState(home);
          assert.equal(state.displayName, createdName);
          const createdLine = lines.find((line) => line.includes(`Created API key ${createdName}`));
          assert.ok(createdLine);
          t.diagnostic(createdLine.trim());
        } finally {
          hostnameMock.mock.restore();
          fetchMock.mock.restore();
          logMock.mock.restore();
          resetSecretStoreForTests();
          for (const key of envKeys) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
          }
        }
      });
    });
  }

  it("signs a Platform account in through the hosted sign-in, not the Nexus page", async (t) => {
    await withTempHome("platform-signin-", async (home) => {
      const envKeys = ["HOME", "FIREWORKS_API_KEY", "SSH_CONNECTION", "NEXUS_SECRET_STORE", "NEXUS_TEST"];
      const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
      Object.assign(process.env, { HOME: home, FIREWORKS_API_KEY: "", SSH_CONNECTION: "test", NEXUS_SECRET_STORE: "memory", NEXUS_TEST: "1" });
      resetSecretStoreForTests();
      const realFetch = globalThis.fetch;
      const fetched = [];
      const lines = [];
      let callback;
      const identityResponse = () => new Response(null, { headers: { "x-fireworks-developer-email": EMAIL } });
      const replies = [
        () => Response.json({ id_token: ID_TOKEN }),
        () => new Response(grpcWebFrames(pbField(1, pbString(1, "accounts/test")))),
        () => new Response(grpcWebFrames(pbField(1, pbString(1, "accounts/test/users/dev")))),
        () => new Response(grpcWebFrames(Buffer.concat([
          pbString(1, "platform-test"), pbString(2, "nexus-cli-test"),
          pbString(3, "fw_platform_test_0000000000000000000"),
        ]))),
        identityResponse,
        identityResponse,
      ];
      const fetchMock = t.mock.method(globalThis, "fetch", async (...args) => {
        fetched.push(String(args[0]));
        const reply = replies.shift();
        assert.ok(reply, "unexpected auth request");
        return reply(...args);
      });
      const logMock = t.mock.method(console, "log", (...args) => {
        const line = args.join(" ");
        lines.push(line);
        const match = line.match(/https:\/\/\S+\/oauth2\/authorize\?\S+/);
        if (match && !callback) {
          const state = new URL(match[0]).searchParams.get("state");
          callback = realFetch(`http://127.0.0.1:18000/?code=test&state=${state}`);
          callback.catch(() => {});
        }
      });
      try {
        assert.equal(await runInteractiveSignIn(home, { method: "browser", accountType: "platform", nextHint: false }), true);
        await callback;
        assert.equal(replies.length, 0);
        // The new key is checked once; a sign-in that reported success isn't re-verified.
        assert.equal(fetched.filter((url) => url.endsWith("/verifyApiKey")).length, 1);
        assert.ok(!lines.some((line) => /127\.0\.0\.1:18000\/s\//.test(line)), "no Nexus sign-in page");
        assert.equal((await readGlobalConfig(home)).accountType, "platform");
      } finally {
        fetchMock.mock.restore();
        logMock.mock.restore();
        resetSecretStoreForTests();
        for (const key of envKeys) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
      }
    });
  });

  it("stops a Platform sign-in whose only account is a Nexus one, instead of minting there", async (t) => {
    await withTempHome("platform-mismatch-", async (home) => {
      const envKeys = ["HOME", "FIREWORKS_API_KEY", "SSH_CONNECTION", "NEXUS_SECRET_STORE", "NEXUS_TEST"];
      const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
      Object.assign(process.env, { HOME: home, FIREWORKS_API_KEY: "", SSH_CONNECTION: "test", NEXUS_SECRET_STORE: "memory", NEXUS_TEST: "1" });
      resetSecretStoreForTests();
      const realFetch = globalThis.fetch;
      const lines = [];
      let callback;
      const nexusMarker = Buffer.from([0xe0, 0x01, 0x01]);
      const replies = [
        () => Response.json({ id_token: ID_TOKEN }),
        () => new Response(grpcWebFrames(pbField(1, Buffer.concat([pbString(1, "accounts/test"), nexusMarker])))),
      ];
      const fetchMock = t.mock.method(globalThis, "fetch", async (...args) => {
        const reply = replies.shift();
        assert.ok(reply, "unexpected request after the account check");
        return reply(...args);
      });
      const logMock = t.mock.method(console, "log", (...args) => {
        const line = args.join(" ");
        lines.push(line);
        const match = line.match(/https:\/\/\S+\/oauth2\/authorize\?\S+/);
        if (match && !callback) {
          const state = new URL(match[0]).searchParams.get("state");
          callback = realFetch(`http://127.0.0.1:18000/?code=test&state=${state}`);
          callback.catch(() => {});
        }
      });
      try {
        assert.equal(await runBrowserFlow(home, { accountType: "platform", nextHint: false }), false);
        await callback;
        assert.equal(replies.length, 0);
        assert.ok(lines.some((line) => /No Fireworks Platform account is linked to this sign-in/.test(line)), lines.join("\n"));
        assert.ok(lines.some((line) => /pick 1 for your Nexus account/.test(line)));
        assert.ok(!lines.some((line) => /Saving your key/.test(line)), "no key minted in the Nexus account");
        assert.notEqual((await readGlobalConfig(home)).accountType, "nexus");
      } finally {
        fetchMock.mock.restore();
        logMock.mock.restore();
        resetSecretStoreForTests();
        for (const key of envKeys) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
      }
    });
  });

  it("jwtClaims decodes without verifying and tolerates garbage", () => {
    assert.equal(jwtClaims(ID_TOKEN).email, EMAIL);
    assert.deepEqual(jwtClaims("not-a-jwt"), {});
  });
});

describe("minted key bookkeeping when saving the key fails", () => {
  const MINTED = "fw_bookkeeping_test_00000000000000";

  /**
   * Browser sign-in against local-only replies. `route` sees every request the
   * replies below don't cover (catalog refresh, key deletion) and may answer it.
   * `before` seeds stored state, `onMint` runs as the key is created, and
   * `inspect` reads stored state back before the env resets.
   */
  async function signInWithReplies(t, home, { env = {}, route = () => null, before, inspect, onMint, verify, browserOnly = false } = {}) {
    const envKeys = ["HOME", "FIREWORKS_API_KEY", "SSH_CONNECTION", "NEXUS_SECRET_STORE", "NEXUS_KEY_STORAGE", "NEXUS_TEST"];
    const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, { HOME: home, FIREWORKS_API_KEY: "", SSH_CONNECTION: "test", NEXUS_SECRET_STORE: "memory", NEXUS_TEST: "1" }, env);
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
    resetSecretStoreForTests();
    const realFetch = globalThis.fetch;
    const urls = [];
    let callback;
    const identityResponse = () => new Response(null, { headers: { "x-fireworks-developer-email": EMAIL } });
    const fetchMock = t.mock.method(globalThis, "fetch", async (url, options) => {
      const href = String(url);
      urls.push(href);
      if (href.endsWith("/oauth2/token")) return Response.json({ id_token: ID_TOKEN });
      if (href.endsWith("/ListAccounts")) {
        return new Response(grpcWebFrames(pbField(1, pbString(1, "accounts/test"))));
      }
      if (href.endsWith("/ListUsers")) return new Response(grpcWebFrames(pbField(1, pbString(1, "accounts/test/users/dev"))));
      if (href.endsWith("/CreateApiKey")) {
        await onMint?.();
        return new Response(grpcWebFrames(Buffer.concat([pbString(1, "bookkeeping-key"), pbString(2, "nexus-cli-test"), pbString(3, MINTED)])));
      }
      if (href.includes("/verifyApiKey")) return verify?.() ?? identityResponse();
      const routed = await route(href, options);
      if (routed) return routed;
      throw new Error(`unexpected request: ${href}`);
    });
    // A Platform sign-in prints the hosted authorize URL (remote session).
    const logMock = t.mock.method(console, "log", (...args) => {
      const match = args.join(" ").match(/https?:\/\/[^\s]+\/oauth2\/authorize\?[^\s]+/);
      if (match && !callback) {
        callback = (async () => {
          const state = new URL(match[0]).searchParams.get("state");
          return realFetch(`http://127.0.0.1:18000/?code=test&state=${state}`);
        })();
        callback.catch(() => {});
      }
    });
    try {
      await before?.();
      let error = null;
      // A sign-in that fails after the key exists (it couldn't be stored)
      // reports it and sets the exit code rather than throwing.
      const exitCodeBefore = process.exitCode;
      process.exitCode = undefined;
      try {
        // A failed browser flow reports it (exit code 1); there is no key-paste fallback.
        if (browserOnly) await runBrowserFlow(home, { accountType: "platform", nextHint: false });
        else await runInteractiveSignIn(home, { accountType: "platform", nextHint: false });
        if (process.exitCode === 1) error = new Error("sign-in reported a failure");
      } catch (caught) {
        error = caught;
      } finally {
        process.exitCode = exitCodeBefore;
      }
      await callback;
      return { error, urls, inspected: await inspect?.() };
    } finally {
      fetchMock.mock.restore();
      logMock.mock.restore();
      resetSecretStoreForTests();
      for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }

  it("records the minted key before the catalog refresh, so an interrupted save stays revocable", async (t) => {
    await withTempHome("minted-order-", async (home) => {
      let recordDuringRefresh;
      const { error } = await signInWithReplies(t, home, {
        route: async (href) => {
          if (!href.includes("/v1/serverless/models")) return null;
          recordDuringRefresh ??= await readMintedKeyState(home);
          return new Response(null, { status: 503 });
        },
      });
      assert.equal(error, null);
      assert.equal(recordDuringRefresh?.keyId, "bookkeeping-key");
      assert.equal((await readMintedKeyState(home))?.keyId, "bookkeeping-key");
    });
  });

  it("revokes the minted key when no key storage can hold it", async (t) => {
    await withTempHome("minted-unstored-", async (home) => {
      const deleted = [];
      const { error } = await signInWithReplies(t, home, {
        env: { NEXUS_SECRET_STORE: undefined, NEXUS_KEY_STORAGE: "null" },
        route: (href, options) => {
          if (!href.endsWith("/DeleteApiKey")) return null;
          deleted.push({ keyId: pbStringAt(pbDecode(options.body.subarray(5)), 2), authorization: options.headers.authorization });
          return new Response(grpcWebFrames(Buffer.alloc(0)));
        },
      });
      assert.ok(error, "the failed save still fails the sign-in");
      assert.deepEqual(deleted, [{ keyId: "bookkeeping-key", authorization: `bearer ${ID_TOKEN}` }]);
      assert.equal(await readMintedKeyState(home), null);
    });
  });

  const PREVIOUS = "fw_previous_test_0000000000000000";
  const revokeRoute = (deleted) => (href, options) => {
    if (!href.endsWith("/DeleteApiKey")) return null;
    assert.equal(options.headers["x-api-key"], undefined);
    deleted.push(options.headers.authorization);
    return new Response(grpcWebFrames(Buffer.alloc(0)));
  };

  it("puts the previous key back and revokes the new one when recording the mint fails", async (t) => {
    await withTempHome("minted-rollback-", async (home) => {
      const deleted = [];
      const { error, inspected } = await signInWithReplies(t, home, {
        route: revokeRoute(deleted),
        before: async () => {
          await setSecret(PREVIOUS, home);
          await writeGlobalConfig(home, { apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF });
          // A directory where the record belongs makes writing it fail after the key is saved.
          await mkdir(mintedKeyStatePath(home), { recursive: true });
        },
        inspect: () => resolveFireworksApiKeyValue({ home }),
      });
      assert.ok(error, "the failed record still fails the sign-in");
      assert.equal(inspected, PREVIOUS, "the previous key is back in use");
      assert.deepEqual(deleted, [`bearer ${ID_TOKEN}`]);
    });
  });

  it("puts the previous key back when the config turns unreadable mid sign-in", async (t) => {
    await withTempHome("minted-rollback-config-", async (home) => {
      const deleted = [];
      const { error, inspected } = await signInWithReplies(t, home, {
        route: revokeRoute(deleted),
        before: async () => {
          await setSecret(PREVIOUS, home);
          await writeGlobalConfig(home, { apiKey: FIREWORKS_API_KEY_KEYCHAIN_REF });
        },
        onMint: () => writeFile(path.join(home, ".nexus", "config.json"), "{"),
        inspect: () => getSecret(home),
      });
      assert.ok(error);
      assert.equal(inspected, PREVIOUS, "the previous key is still the stored one");
      assert.deepEqual(deleted, [`bearer ${ID_TOKEN}`]);
    });
  });

  // Records who authorized each delete; `refuseToken` makes token-authorized deletes fail.
  const revokeByAuthRoute = (deleted, { refuseToken = false } = {}) => (href, options) => {
    if (!href.endsWith("/DeleteApiKey")) return null;
    const bearer = options.headers.authorization;
    deleted.push(bearer ? "token" : options.headers["x-api-key"]);
    return new Response(grpcWebFrames(null, bearer && refuseToken ? { status: 7 } : {}));
  };

  it("revokes the minted key with the sign-in token when the API rejects the key", async (t) => {
    await withTempHome("minted-rejected-", async (home) => {
      const deleted = [];
      const { error, inspected } = await signInWithReplies(t, home, {
        route: revokeByAuthRoute(deleted),
        verify: () => new Response(null, { status: 401 }),
        browserOnly: true,
        inspect: () => resolveFireworksApiKeyValue({ home }),
      });
      assert.equal(error, null);
      assert.equal(inspected ?? "", "", "the rejected key is never stored");
      assert.deepEqual(deleted, ["token"], "one delete, authorized by the sign-in token");
      assert.equal(await readMintedKeyState(home), null);
    });
  });

  it("does not fall back to an API key when the sign-in token cannot delete a rejected key", async (t) => {
    await withTempHome("minted-rejected-fallback-", async (home) => {
      const deleted = [];
      const { error } = await signInWithReplies(t, home, {
        route: revokeByAuthRoute(deleted, { refuseToken: true }),
        verify: () => new Response(null, { status: 401 }),
        browserOnly: true,
      });
      assert.equal(error, null);
      assert.deepEqual(deleted, ["token"]);
    });
  });

  it("removes the new key and revokes it when a first sign-in can't record it", async (t) => {
    await withTempHome("minted-rollback-first-", async (home) => {
      await mkdir(mintedKeyStatePath(home), { recursive: true });
      const deleted = [];
      const { error, inspected } = await signInWithReplies(t, home, {
        route: revokeRoute(deleted),
        inspect: () => resolveFireworksApiKeyValue({ home }),
      });
      assert.ok(error);
      assert.equal(inspected ?? "", "", "no key is left that nothing can revoke");
      assert.equal((await readGlobalConfig(home)).apiKey, "");
      assert.deepEqual(deleted, [`bearer ${ID_TOKEN}`]);
    });
  });
});

// Platform/SSO rotation (`nexus login --force`). Lives here, not in its own
// file, because the Platform callback binds 127.0.0.1:18000 like the flows above.
const ROTATION_OLD_KEY = "fw_rotation_old_00000000000000000000";
const ROTATION_NEW_KEY = "fw_rotation_new_00000000000000000000";
const ROTATION_OLD_RECORD = { keyId: "old-key-id", userName: "accounts/test/users/dev", displayName: "nexus-cli-old-host" };


/**
 * A Fireworks Platform `nexus login` that replaces this machine's key, against
 * local replies only. `before` seeds the machine's previous credential;
 * `verifyNew` answers the new key's check; `deleteStatus` answers DeleteApiKey;
 * `seed(home)` adjusts that machine's state before the sign-in; `sso` signs in
 * through that account's company SSO instead of the Platform hosted sign-in;
 * `remembered` is the SSO account a previous sign-in left, offered (and
 * accepted) first.
 */
async function rotateMachineKey(t, { rotate: rotating = true, before = "minted", verifyNew = 200, deleteStatus = 0, seed = async () => {}, sso = "", remembered = "" } = {}) {
  return withTempHome("login-rotation-", async (home) => {
    const envKeys = ["HOME", "FIREWORKS_API_KEY", "SSH_CONNECTION", "NEXUS_SECRET_STORE", "NEXUS_TEST"];
    const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, { HOME: home, FIREWORKS_API_KEY: "", SSH_CONNECTION: "test", NEXUS_SECRET_STORE: "memory", NEXUS_TEST: "1" });
    resetSecretStoreForTests();
    const realFetch = globalThis.fetch;
    const deletes = [];
    const verified = [];
    const lines = [];
    let callback;
    const fetchMock = t.mock.method(globalThis, "fetch", async (input, options = {}) => {
      const url = String(input);
      if (url.includes("/oauth2/token")) return Response.json({ id_token: ID_TOKEN });
      if (url.endsWith("/GetOAuthArguments")) {
        return new Response(grpcWebFrames(Buffer.concat([
          pbString(1, "https://example-pool.auth.example.com"), pbString(2, "example-client"), pbString(3, "example-pool.auth.example.com"),
        ])));
      }
      if (url.endsWith("/CreateUser")) return new Response(grpcWebFrames(Buffer.alloc(0)));
      if (url.endsWith("/ListAccounts")) return new Response(grpcWebFrames(pbField(1, pbString(1, "accounts/test"))));
      if (url.endsWith("/ListUsers")) return new Response(grpcWebFrames(pbField(1, pbString(1, "accounts/test/users/dev"))));
      if (url.endsWith("/CreateApiKey")) {
        return new Response(grpcWebFrames(Buffer.concat([
          pbString(1, "new-key-id"), pbString(2, "nexus-cli-new-host"), pbString(3, ROTATION_NEW_KEY),
        ])));
      }
      if (url.endsWith("/DeleteApiKey")) {
        const request = pbDecode(options.body.subarray(5));
        deletes.push({ userName: pbStringAt(request, 1), keyId: pbStringAt(request, 2), auth: options.headers?.authorization ?? options.headers?.Authorization });
        return new Response(grpcWebFrames(null, { status: deleteStatus, detail: deleteStatus ? "denied" : "" }));
      }
      if (url.endsWith("/verifyApiKey")) {
        const key = String(options.headers?.Authorization ?? options.headers?.authorization ?? "").replace(/^Bearer /, "");
        verified.push(key);
        const status = key === ROTATION_NEW_KEY ? verifyNew : 200;
        return new Response(null, { status, headers: status === 200 ? { "x-fireworks-developer-email": EMAIL } : {} });
      }
      return new Response(null, { headers: { "x-fireworks-developer-email": EMAIL } });
    });
    const logMock = t.mock.method(console, "log", (...args) => {
      const line = args.join(" ");
      lines.push(line);
      const match = line.match(/https:\/\/\S+\/oauth2\/authorize\?\S+/);
      if (match && !callback) {
        const state = new URL(match[0]).searchParams.get("state");
        callback = realFetch(`http://127.0.0.1:18000/?code=test&state=${state}`);
        callback.catch(() => {});
      }
    });
    try {
      if (before === "minted") {
        await storeApiKey(home, ROTATION_OLD_KEY, "platform", { mintedKey: ROTATION_OLD_RECORD });
      } else if (before === "foreign") {
        // A record left by another key: the stored key wasn't made here.
        await storeApiKey(home, ROTATION_OLD_KEY, "platform", { mintedKey: ROTATION_OLD_RECORD });
        await setSecret("fw_rotation_pasted_000000000000000000", home);
      }
      await seed(home);
      let signedIn;
      if (remembered) {
        await writeGlobalConfig(home, { ssoAccountId: remembered });
        const asked = [];
        signedIn = await runInteractiveSignIn(home, {
          nextHint: false,
          rotate: rotating,
          confirm: async (question) => { asked.push(question); return true; },
        });
        assert.match(asked.join("\n"), new RegExp(`${remembered}.*company SSO\\. Use it again\\?`));
      } else {
        signedIn = sso
          ? await runSsoBrowserFlow(home, sso, { nextHint: false, rotate: rotating })
          : await runInteractiveSignIn(home, { accountType: "platform", nextHint: false, rotate: rotating });
      }
      await callback;
      return {
        signedIn,
        deletes,
        verified,
        lines,
        storedKey: await resolveFireworksApiKeyValue({ apiKey: "", home }),
        record: await readMintedKeyState(home),
      };
    } finally {
      fetchMock.mock.restore();
      logMock.mock.restore();
      resetSecretStoreForTests();
      for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
}

describe("login --force on a Platform or SSO sign-in", () => {
  it("deletes this machine's previous key with the sign-in token once the new key works", async (t) => {
    const result = await rotateMachineKey(t);
    assert.equal(result.signedIn, true);
    assert.equal(result.storedKey, ROTATION_NEW_KEY);
    assert.equal(result.record.keyId, "new-key-id");
    assert.deepEqual(result.deletes.map(({ userName, keyId }) => ({ userName, keyId })), [
      { userName: ROTATION_OLD_RECORD.userName, keyId: ROTATION_OLD_RECORD.keyId },
    ]);
    // The sign-in token deletes it, never an API key.
    assert.equal(String(result.deletes[0].auth).toLowerCase(), `bearer ${ID_TOKEN}`.toLowerCase());
    assert.ok(result.verified.includes(ROTATION_NEW_KEY), "new key checked before the delete");
    assert.ok(result.lines.some((line) => line.includes("Deleted this machine's previous key (nexus-cli-old-host).")));
  });

  it("keeps the previous key when the user didn't ask to replace it", async (t) => {
    const result = await rotateMachineKey(t, { rotate: false });
    assert.equal(result.signedIn, true);
    assert.deepEqual(result.deletes, []);
  });

  it("never deletes a key this CLI didn't create", async (t) => {
    const result = await rotateMachineKey(t, { before: "foreign" });
    assert.equal(result.signedIn, true);
    assert.deepEqual(result.deletes, []);
    assert.ok(!result.lines.some((line) => line.includes("previous key")));
  });

  it("keeps the previous key when the new key couldn't be checked", async (t) => {
    const result = await rotateMachineKey(t, { verifyNew: 503 });
    assert.equal(result.storedKey, ROTATION_NEW_KEY);
    assert.deepEqual(result.deletes, []);
    assert.ok(result.lines.some((line) => line.includes("Kept this machine's previous key (nexus-cli-old-host)")));
  });

  it("finishes the sign-in and points at the keys page when the delete is refused", async (t) => {
    const result = await rotateMachineKey(t, { deleteStatus: 7 });
    assert.equal(result.signedIn, true);
    assert.equal(result.storedKey, ROTATION_NEW_KEY);
    assert.equal(result.deletes.length, 1);
    assert.ok(result.lines.some((line) => /Couldn't delete this machine's previous key \(nexus-cli-old-host\): the control plane refused: denied\. Delete it at /.test(line)));
  });

  it("keeps a key the Nexus web app made, which only the web app deletes", async (t) => {
    const result = await rotateMachineKey(t, { seed: (home) => writeGlobalConfig(home, { accountType: "nexus", ssoAccountId: "" }) });
    assert.equal(result.storedKey, ROTATION_NEW_KEY);
    assert.deepEqual(result.deletes, []);
    assert.ok(result.lines.some((line) => line.includes("Kept this machine's previous key (nexus-cli-old-host) because the Nexus web app made it")));
  });

  it("keeps the previous key while a connected tool still uses it", async (t) => {
    const result = await rotateMachineKey(t, {
      seed: async (home) => {
        // Codex is on, but its config defines Nexus's provider twice, so the
        // new key can't be written there and Codex keeps sending the old one.
        await writeGlobalConfig(home, { harnesses: { codex: { enabled: true, provider: "fireworks" } } });
        await mkdir(path.join(home, ".codex"), { recursive: true });
        await writeFile(path.join(home, ".codex", "config.toml"),
          'model_provider = "fireworks-ai"\n\n[model_providers.fireworks-ai]\nname = "a"\nname = "b"\n');
      },
    });
    assert.equal(result.storedKey, ROTATION_NEW_KEY);
    assert.deepEqual(result.deletes, []);
    assert.ok(result.lines.some((line) => line.includes("Couldn't update Codex's Fireworks settings")));
    assert.ok(result.lines.some((line) => line.includes("because Codex may still use it") && line.includes("after running nexus codex on")));
  });

  it("keeps the previous key while a harness that keeps its own copy (Cursor) is connected", async (t) => {
    const result = await rotateMachineKey(t, {
      seed: (home) => writeGlobalConfig(home, { harnesses: { cursor: { enabled: true, provider: "fireworks" } } }),
    });
    assert.equal(result.storedKey, ROTATION_NEW_KEY);
    assert.deepEqual(result.deletes, []);
    assert.ok(result.lines.some((line) => line.includes("because Cursor IDE may still use it") && line.includes("nexus cursor on")));
  });

  it("keeps the previous key for a harness set up outside its default config (a custom --config-path)", async (t) => {
    // OpenCode is on, but nothing at its default config holds a key to re-point.
    const result = await rotateMachineKey(t, {
      seed: (home) => writeGlobalConfig(home, { harnesses: { opencode: { enabled: true, provider: "fireworks" } } }),
    });
    assert.equal(result.storedKey, ROTATION_NEW_KEY);
    assert.deepEqual(result.deletes, []);
    assert.ok(result.lines.some((line) => line.includes("because OpenCode may still use it")));
  });

  it("rotates through a company-SSO sign-in with that sign-in's token", async (t) => {
    const result = await rotateMachineKey(t, { sso: "example-account" });
    assert.equal(result.storedKey, ROTATION_NEW_KEY);
    assert.deepEqual(result.deletes.map(({ keyId }) => keyId), [ROTATION_OLD_RECORD.keyId]);
    assert.equal(String(result.deletes[0].auth).toLowerCase(), `bearer ${ID_TOKEN}`.toLowerCase());
  });

  it("rotates through the remembered company-SSO account offered first", async (t) => {
    const result = await rotateMachineKey(t, { remembered: "example-account" });
    assert.equal(result.storedKey, ROTATION_NEW_KEY);
    assert.deepEqual(result.deletes.map(({ keyId }) => keyId), [ROTATION_OLD_RECORD.keyId]);
  });

  it("leaves the previous key alone on a company-SSO sign-in that isn't a rotation", async (t) => {
    const result = await rotateMachineKey(t, { sso: "example-account", rotate: false });
    assert.equal(result.storedKey, ROTATION_NEW_KEY);
    assert.deepEqual(result.deletes, []);
  });

  it("says so when it can't tell whether the previous key was made here", async (t) => {
    const result = await rotateMachineKey(t, {
      seed: async (home) => {
        // A record from before fingerprints were kept.
        const { keyFingerprint: _dropped, ...legacy } = JSON.parse(await readFile(mintedKeyStatePath(home), "utf8"));
        await writeFile(mintedKeyStatePath(home), JSON.stringify(legacy));
      },
    });
    assert.deepEqual(result.deletes, []);
    assert.ok(result.lines.some((line) => line.includes("Couldn't tell whether this machine's previous key was made here")));
  });

  it("keeps the previous key when the harness sync didn't report (fails closed)", async () => {
    const previous = { kind: "ours", ...ROTATION_OLD_RECORD, webApp: false, keysUrl: "https://keys.example.test" };
    const calls = [];
    const revoke = async (args) => { calls.push(args); return { ok: true, failure: "" }; };
    const missing = await revokeReplacedKey(previous, { idToken: ID_TOKEN, newKeyWorks: true, stillUsing: null }, { revoke });
    assert.equal(missing.outcome, "kept");
    assert.match(missing.line, /couldn't confirm that your connected harnesses use the new key/);
    assert.deepEqual(calls, []);
    const confirmed = await revokeReplacedKey(previous, { idToken: ID_TOKEN, newKeyWorks: true, stillUsing: [] }, { revoke });
    assert.equal(confirmed.outcome, "deleted");
    assert.deepEqual(calls, [{ idToken: ID_TOKEN, keyId: ROTATION_OLD_RECORD.keyId, userName: ROTATION_OLD_RECORD.userName }]);
  });
});
