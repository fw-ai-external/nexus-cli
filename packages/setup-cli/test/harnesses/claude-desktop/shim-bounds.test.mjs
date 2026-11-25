import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createAutoSettingsLoader, createShimServer } from "../../../lib/harnesses/claude-desktop/shim.mjs";
import { AUTO_PROVIDER_KEY_HEADERS } from "../../../lib/config/auto-providers.mjs";
import { createDesktopToken, desktopTokenFingerprint } from "../../../lib/harnesses/claude-desktop/desktop-token.mjs";

async function fixture(t, handle, options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "shim-bounds-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const upstream = http.createServer(handle);
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const shim = createShimServer({
    modelMap: {}, catalogDir: home,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    log: () => {}, ...options,
  });
  await new Promise((resolve) => shim.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    shim.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise((resolve) => shim.close(resolve)), new Promise((resolve) => upstream.close(resolve))]);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await rm(home, { recursive: true, force: true });
  });
  return { port: shim.address().port, upstream, shim };
}

// Retries `check` briefly: for a release that happens after the client's side has closed.
async function eventually(check, { tries = 40, delayMs = 25 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  assert.fail("condition never held");
}

function request(port, { body = "{}", headers = {}, method = "POST", path = "/v1/messages", chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers };
    if (chunked) {
      delete requestHeaders["content-length"];
      requestHeaders["transfer-encoding"] = "chunked";
    }
    const req = http.request({
      host: "127.0.0.1", port, path, method,
      headers: requestHeaders,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("shim strips Connection-nominated headers in both directions", { timeout: 5000 }, async (t) => {
  let seen;
  const { port } = await fixture(t, (req, res) => {
    seen = req.headers;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { connection: "X-Response, keep-alive", "x-response": "example-hop", "x-end-to-end": "kept" });
      res.end("ok");
    });
  });
  const result = await request(port, { headers: {
    connection: "keep-alive, X-Foo, x-BAR, x-title", "x-foo": "example-hop", "x-bar": "example-hop", "x-end-to-end": "kept",
  } });
  assert.equal(result.status, 200);
  assert.equal(seen["x-foo"], undefined);
  assert.equal(seen["x-bar"], undefined);
  assert.equal(seen["x-title"], undefined);
  assert.equal(seen["x-end-to-end"], "kept");
  assert.equal(result.headers["x-response"], undefined);
  assert.equal(result.headers["x-end-to-end"], "kept");
  assert.equal(result.body.toString(), "ok");
});

for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]]) {
  test(`shim forwards decompressed ${encoding} bytes with matching framing`, { timeout: 5000 }, async (t) => {
    const body = Buffer.from("example response\n".repeat(2000));
    const compressed = compress(body);
    const { port } = await fixture(t, (req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-encoding": encoding, "content-length": compressed.length });
        res.end(compressed);
      });
    });
    const result = await request(port);
    assert.deepEqual(result.body, body);
    assert.equal(result.headers["content-encoding"], undefined);
    assert.equal(result.headers["content-length"], undefined);
  });
}

test("shim handles an empty upstream response", { timeout: 5000 }, async (t) => {
  const { port } = await fixture(t, (req, res) => { req.resume(); req.on("end", () => { res.writeHead(204); res.end(); }); });
  const result = await request(port, { body: "" });
  assert.equal(result.status, 204);
  assert.equal(result.body.length, 0);
});

for (const overflow of [false, true]) {
  test(`shim ${overflow ? "stops telemetry after line overflow" : "parses fragmented telemetry"} without altering bytes`, { timeout: 5000 }, async (t) => {
    const logs = [];
    let sendRest;
    const prefix = overflow ? "x".repeat(2048) : 'data: {"type":"message_delta",';
    const suffix = overflow ? '\ndata: {"type":"message_delta","usage":{"input_tokens":42}}\n' : '"usage":{"input_tokens":42}}\n';
    const { port } = await fixture(t, (req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(prefix);
        sendRest = () => res.end(suffix);
      });
    }, { maxTelemetryLineChars: 1024, log: (line) => logs.push(line) });
    const body = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/v1/messages", method: "POST" }, (res) => {
        let received = "";
        res.on("data", (chunk) => {
          received += chunk;
          if (received.length === prefix.length) sendRest();
        });
        res.on("end", () => resolve(received));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(body, prefix + suffix);
    assert.equal(logs.filter((line) => /usage 42 in/.test(line)).length, overflow ? 0 : 1);
  });
}

test("shim reserves aggregate body memory until upstream accepts the request", { timeout: 5000 }, async (t) => {
  let release;
  let arrivals = 0;
  const accepted = Promise.withResolvers();
  const { port } = await fixture(t, (req, res) => {
    arrivals++;
    req.resume();
    req.on("end", () => {
      if (arrivals === 1) { release = () => res.end("first"); accepted.resolve(); }
      else res.end("next");
    });
  }, { maxBufferedBodyBytes: 4 });
  const first = request(port, { body: "1234" });
  await accepted.promise;
  const rejected = await request(port, { body: "1" });
  assert.equal(rejected.status, 503);
  assert.match(rejected.body.toString(), /Too many buffered requests/);
  assert.equal(arrivals, 1);
  release();
  assert.equal((await first).body.toString(), "first");
  assert.equal((await request(port, { body: "1234" })).body.toString(), "next");
});

test("shim releases body reservations after a client abort during upload", { timeout: 5000 }, async (t) => {
  const { port, shim } = await fixture(t, (req, res) => { req.resume(); req.on("end", () => res.end("ok")); }, { maxBufferedBodyBytes: 4 });
  const receiving = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  shim.on("request", (req) => {
    req.once("data", () => receiving.resolve());
    req.once("aborted", () => aborted.resolve());
  });
  const upload = http.request({ host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-length": 4 } });
  upload.on("error", () => {});
  upload.flushHeaders();
  upload.write("1");
  await receiving.promise;
  assert.equal((await request(port, { body: "1234" })).status, 503);
  upload.destroy();
  await aborted.promise;
  assert.equal((await request(port, { body: "1234" })).status, 200);
});

test("shim refuses oversized bodies with 413 and keeps serving", { timeout: 5000 }, async (t) => {
  const { port } = await fixture(t, (req, res) => { req.resume(); req.on("end", () => res.end("ok")); });
  const result = await request(port, { body: "", headers: { "content-length": 8 * 1024 * 1024 + 1 } });
  assert.equal(result.status, 413);
  assert.match(result.body.toString(), /Request body too large/);
  assert.equal((await request(port)).status, 200);
});

test("shim bounds chunked uploads without a declared length", { timeout: 5000 }, async (t) => {
  const { port } = await fixture(t, (req, res) => { req.resume(); req.on("end", () => res.end("ok")); });
  const result = await request(port, { body: Buffer.alloc(8 * 1024 * 1024 + 1, 120), chunked: true });
  assert.equal(result.status, 413);
  assert.equal((await request(port, { chunked: true })).status, 200);
});

for (const streaming of [false, true]) {
  test(`shim cancels disconnected clients ${streaming ? "during streaming" : "before upstream headers"}`, { timeout: 5000 }, async (t) => {
    const started = Promise.withResolvers();
    const closed = Promise.withResolvers();
    const { port } = await fixture(t, (req, res) => {
      req.resume();
      res.on("close", () => closed.resolve());
      req.on("end", () => {
        if (streaming) { res.writeHead(200); res.write("prefix"); }
        started.resolve();
      });
    });
    const client = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages" });
    client.on("error", () => {});
    client.on("response", (res) => { res.on("error", () => {}); res.resume(); });
    client.end("{}");
    await started.promise;
    client.destroy();
    await closed.promise;
    assert.equal((await request(port, { method: "GET", path: "/", body: "" })).status, 200);
  });
}

test("shim lets an active stream outlive the header deadline even after telemetry stops", { timeout: 5000 }, async (t) => {
  const parts = Array.from({ length: 8 }, (_, i) => `part-${i}`);
  const { port } = await fixture(t, (req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200);
      res.flushHeaders();
      let index = 0;
      const interval = setInterval(() => {
        res.write(parts[index++]);
        if (index === parts.length) {
          clearInterval(interval);
          res.end();
        }
      }, 100);
      res.once("close", () => clearInterval(interval));
    });
  }, { upstreamTimeoutMs: 300, upstreamIdleTimeoutMs: 600, maxTelemetryLineChars: 16 });
  const started = Date.now();
  const result = await request(port);
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), parts.join(""));
  assert.ok(Date.now() - started > 300);
});

for (const streaming of [false, true]) {
  test(`shim times out stalled upstream ${streaming ? "bodies after the idle deadline" : "headers"}`, { timeout: 2000 }, async (t) => {
    const closed = Promise.withResolvers();
    let arrivals = 0;
    const { port } = await fixture(t, (req, res) => {
      req.resume();
      res.on("close", () => closed.resolve());
      req.on("end", () => {
        if (++arrivals > 1) res.end("recovered");
        else if (streaming) { res.writeHead(200); res.write("prefix"); }
      });
    }, { upstreamTimeoutMs: streaming ? 3000 : 150, upstreamIdleTimeoutMs: 150, maxBufferedBodyBytes: 2 });
    if (streaming) await assert.rejects(request(port), /aborted|reset|premature/i);
    else {
      const result = await request(port);
      assert.equal(result.status, 504);
      assert.match(result.body.toString(), /Upstream timed out/);
    }
    await closed.promise;
    assert.equal((await request(port)).body.toString(), "recovered");
  });
}

test("requests without the profile's key cannot fill the buffer the profile's own requests need", { timeout: 5000 }, async (t) => {
  const legacyKey = "fw_example_profile_key";
  const { port, shim } = await fixture(t, (req, res) => { req.resume(); req.on("end", () => res.end("ok")); }, {
    maxBufferedBodyBytes: 8, maxUnverifiedBufferedBodyBytes: 4, legacyGatewayKeyLoader: async () => legacyKey,
  });
  const receiving = Promise.withResolvers();
  shim.on("request", (req) => req.once("data", () => receiving.resolve()));
  const stalled = http.request({ host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-length": 4, "x-api-key": "fw_example_other_key" } });
  stalled.on("error", () => {});
  stalled.flushHeaders();
  stalled.write("1");
  await receiving.promise;
  // A second unverified upload is refused instead of taking the rest.
  assert.equal((await request(port, { body: "1234", headers: { "x-api-key": "fw_example_other_key" } })).status, 503);
  assert.equal((await request(port, { body: "1234" })).status, 503);
  const own = await request(port, { body: "1234", headers: { "x-api-key": legacyKey } });
  assert.equal(own.status, 200);
  stalled.destroy();
  // The aborted upload gives its unverified share back.
  await eventually(async () => (await request(port, { body: "1234", headers: { "x-api-key": "fw_example_other_key" } })).status === 200);
});


test("a stalled upload times out and releases its reservation", { timeout: 5000 }, async (t) => {
  const { port, shim } = await fixture(t, (req, res) => { req.resume(); req.on("end", () => res.end("ok")); }, {
    maxBufferedBodyBytes: 4, maxUnverifiedBufferedBodyBytes: 4, bodyTimeoutMs: 200,
  });
  const receiving = Promise.withResolvers();
  shim.on("request", (req) => req.once("data", () => receiving.resolve()));
  const stalledResponse = Promise.withResolvers();
  const stalled = http.request({ host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-length": 4 } },
    (res) => { res.resume(); stalledResponse.resolve(res.statusCode); });
  stalled.on("error", () => {});
  stalled.flushHeaders();
  stalled.write("1");
  await receiving.promise;
  assert.equal((await request(port, { body: "1234" })).status, 503);
  assert.equal(await stalledResponse.promise, 408);
  assert.equal((await request(port, { body: "1234" })).status, 200);
  stalled.destroy();
});

// A started upload; the caller finishes (`req.end(...)`) or destroys `req`.
function partialUpload(port, headers, first = "1") {
  const response = Promise.withResolvers();
  const req = http.request({ host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", ...headers } },
    (res) => { const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => response.resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })); });
  req.on("error", () => {});
  req.flushHeaders();
  req.write(first);
  return { req, response: response.promise };
}

function desktopAuth(token, key) {
  let currentToken = token;
  const checked = Promise.withResolvers();
  return {
    setToken: (value) => { currentToken = value; },
    checked: checked.promise,
    options: {
      gatewayKeyLoader: async () => currentToken,
      storedGatewayKeyLoader: async () => key,
      tokenFingerprintLoader: async () => { checked.resolve(); return desktopTokenFingerprint(currentToken, key); },
    },
  };
}

test("a token rotated while its body uploads is refused after the upload", { timeout: 5000 }, async (t) => {
  const token = createDesktopToken();
  const auth = desktopAuth(token, "fw_example_stored_key");
  let forwarded = 0;
  const { port, shim } = await fixture(t, (req, res) => { forwarded++; req.resume(); req.on("end", () => res.end("ok")); }, auth.options);
  const receiving = Promise.withResolvers();
  shim.on("request", (req) => req.once("data", () => receiving.resolve()));
  const upload = partialUpload(port, { "content-length": 2, "x-api-key": token }, "{");
  await receiving.promise;
  auth.setToken(createDesktopToken());
  upload.req.end("}");
  const result = await upload.response;
  assert.equal(result.status, 401);
  assert.match(result.body, /outdated or invalid Nexus token/);
  assert.equal(forwarded, 0);
});

test("a refreshed key after an upstream 401 is not used with a token bound to the old key", { timeout: 5000 }, async (t) => {
  const token = createDesktopToken();
  let stored = "fw_example_stored_key";
  const loader = async () => stored;
  loader.invalidate = () => { stored = "fw_example_other_account_key"; };
  const seen = [];
  const { port } = await fixture(t, (req, res) => { seen.push(req.headers.authorization); req.resume(); req.on("end", () => { res.writeHead(401); res.end("{}"); }); }, {
    gatewayKeyLoader: async () => token,
    storedGatewayKeyLoader: loader,
    tokenFingerprintLoader: async () => desktopTokenFingerprint(token, "fw_example_stored_key"),
  });
  const result = await request(port, { headers: { "x-api-key": token } });
  assert.equal(result.status, 401);
  assert.match(result.body.toString(), /issued for a different Fireworks key/);
  assert.deepEqual(seen, ["Bearer fw_example_stored_key"]);
});

test("count_tokens with an outdated token is still answered locally", { timeout: 5000 }, async (t) => {
  const auth = desktopAuth(createDesktopToken(), "fw_example_stored_key");
  const { port } = await fixture(t, (req, res) => { req.resume(); res.end("{}"); }, auth.options);
  const result = await request(port, { path: "/v1/messages/count_tokens", body: '{"messages":[]}', headers: { "x-api-key": createDesktopToken() } });
  assert.equal(result.status, 200);
  assert.ok(JSON.parse(result.body.toString()).input_tokens >= 1);
});

test("a token rotated while the model is looked up is refused, not forwarded with the old key", { timeout: 5000 }, async (t) => {
  const token = createDesktopToken();
  const auth = desktopAuth(token, "fw_example_stored_key");
  let forwarded = 0;
  const { port } = await fixture(t, (req, res) => { forwarded++; req.resume(); req.on("end", () => res.end("ok")); }, {
    ...auth.options,
    lineupLoader: async () => { auth.setToken(createDesktopToken()); return { modelMap: { models: {} }, models: [] }; },
  });
  const result = await request(port, { body: '{"model":"claude-example"}', headers: { "x-api-key": token } });
  assert.equal(result.status, 401);
  assert.match(result.body.toString(), /outdated or invalid Nexus token/);
  assert.equal(forwarded, 0);
});

test("a stalled credential read neither delays admission nor holds the request", { timeout: 5000 }, async (t) => {
  const never = () => new Promise(() => {});
  const { port } = await fixture(t, (req, res) => { req.resume(); req.on("end", () => res.end("ok")); }, {
    maxBufferedBodyBytes: 4, bodyTimeoutMs: 200, credentialTimeoutMs: 100,
    gatewayKeyLoader: never, legacyGatewayKeyLoader: never,
  });
  // The upload deadline runs while every credential read hangs.
  const stalled = partialUpload(port, { "content-length": 4 });
  assert.equal((await stalled.response).status, 408);
  stalled.req.destroy();
  // A complete request is checked against no credential and forwarded as before.
  const started = Date.now();
  assert.equal((await request(port, { body: "1234" })).status, 200);
  assert.ok(Date.now() - started < 1000);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("a token from before an account switch does not get the protected share of the buffer", { timeout: 5000 }, async (t) => {
  const token = createDesktopToken();
  const { port, shim } = await fixture(t, (req, res) => { req.resume(); req.on("end", () => res.end("ok")); }, {
    maxBufferedBodyBytes: 8, maxUnverifiedBufferedBodyBytes: 4,
    gatewayKeyLoader: async () => token,
    storedGatewayKeyLoader: async () => "fw_example_other_account_key",
    tokenFingerprintLoader: async () => desktopTokenFingerprint(token, "fw_example_stored_key"),
  });
  await settle();
  const receiving = Promise.withResolvers();
  shim.on("request", (req) => req.once("data", () => receiving.resolve()));
  const stalled = partialUpload(port, { "content-length": 4, "x-api-key": token });
  await receiving.promise;
  // The old token's upload counted against the unverified share, which is now full.
  assert.equal((await request(port, { body: "1234" })).status, 503);
  stalled.req.destroy();
});

test("a Desktop token newer than the last snapshot is rechecked before a refusal", { timeout: 5000 }, async (t) => {
  const auth = desktopAuth(createDesktopToken(), "fw_example_stored_key");
  const { port, shim } = await fixture(t, (req, res) => { req.resume(); req.on("end", () => res.end("ok")); }, {
    ...auth.options, maxBufferedBodyBytes: 16, maxUnverifiedBufferedBodyBytes: 4,
  });
  await settle();
  const receiving = Promise.withResolvers();
  shim.on("request", (req) => req.once("data", () => receiving.resolve()));
  const stalled = partialUpload(port, { "content-length": 4 });
  await receiving.promise;
  const rotated = createDesktopToken();
  auth.setToken(rotated);
  const result = await request(port, { body: "1234", headers: { "x-api-key": rotated } });
  assert.equal(result.status, 200);
  stalled.req.destroy();
});

test("a stalled nexus auto read refuses an auto turn instead of dropping its scope", { timeout: 5000 }, async (t) => {
  let forwarded = 0;
  const { port } = await fixture(t, (req, res) => { forwarded++; req.resume(); req.on("end", () => res.end("ok")); }, {
    modelMap: { models: { "claude-example": "auto" } }, credentialTimeoutMs: 100,
    autoSettingsLoader: () => new Promise(() => {}),
  });
  const started = Date.now();
  const result = await request(port, { body: '{"model":"claude-example"}' });
  assert.equal(result.status, 503);
  assert.match(result.body.toString(), /nexus auto settings/);
  assert.equal(forwarded, 0);
  assert.ok(Date.now() - started < 1000);
});

test("an auto turn sends the scope and keys from one read", { timeout: 5000 }, async (t) => {
  let seen;
  let reads = 0;
  const { port } = await fixture(t, (req, res) => { seen = req.headers; req.resume(); req.on("end", () => res.end("ok")); }, {
    modelMap: { models: { "claude-example": "auto" } },
    legacyGatewayKeyLoader: async () => "fw_example_profile_key",
    autoSettingsLoader: async () => {
      reads++;
      return { providers: "", anthropicKey: "sk-ant-example-key", openaiKey: "sk-example-key" };
    },
  });
  const result = await request(port, { body: '{"model":"claude-example"}', headers: { "x-api-key": "fw_example_profile_key" } });
  assert.equal(result.status, 200);
  assert.equal(reads, 1);
  assert.equal(seen["x-nexus-providers"], undefined);
  assert.equal(seen[AUTO_PROVIDER_KEY_HEADERS.anthropic], "sk-ant-example-key");
  assert.equal(seen[AUTO_PROVIDER_KEY_HEADERS.openai], "sk-example-key");
});

test("createAutoSettingsLoader reads the scope and the keys it allows from one config read", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auto-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");
  const loader = createAutoSettingsLoader({ configPath });
  assert.deepEqual(await loader(), { providers: "", anthropicKey: "", openaiKey: "" });
  // No scope: every saved key is allowed.
  await writeFile(configPath, JSON.stringify({ anthropicApiKey: "sk-ant-example-key", openaiApiKey: "sk-example-key" }));
  assert.deepEqual(await loader(), { providers: "", anthropicKey: "sk-ant-example-key", openaiKey: "sk-example-key" });
  // A Fireworks-only scope withholds both, from the same read.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(configPath, JSON.stringify({
    auto: { providers: ["fireworks"] }, anthropicApiKey: "sk-ant-example-key", openaiApiKey: "sk-example-key",
  }));
  assert.deepEqual(await loader(), { providers: "fireworks", anthropicKey: "", openaiKey: "" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(configPath, "{ not json");
  await assert.rejects(loader());
});

test("a snapshot read that times out is logged and the turn gets a retryable 503", { timeout: 5000 }, async (t) => {
  const token = createDesktopToken();
  const logs = [];
  const { port } = await fixture(t, (req, res) => { req.resume(); req.on("end", () => res.end("ok")); }, {
    credentialTimeoutMs: 100, log: (line) => logs.push(line),
    gatewayKeyLoader: async () => token,
    storedGatewayKeyLoader: () => new Promise(() => {}),
    tokenFingerprintLoader: async () => desktopTokenFingerprint(token, "fw_example_stored_key"),
  });
  const result = await request(port, { headers: { "x-api-key": token } });
  assert.equal(result.status, 503);
  assert.match(result.body.toString(), /in time/);
  assert.ok(logs.some((line) => /credential snapshot read timed out/.test(line)));
});

test("a token rotated while the nexus auto settings are read is refused", { timeout: 5000 }, async (t) => {
  const token = createDesktopToken();
  const auth = desktopAuth(token, "fw_example_stored_key");
  let forwarded = 0;
  const { port } = await fixture(t, (req, res) => { forwarded++; req.resume(); req.on("end", () => res.end("ok")); }, {
    ...auth.options,
    modelMap: { models: { "claude-example": "auto" } },
    autoSettingsLoader: async () => { auth.setToken(createDesktopToken()); return { providers: "", anthropicKey: "", openaiKey: "" }; },
  });
  const result = await request(port, { body: '{"model":"claude-example"}', headers: { "x-api-key": token } });
  assert.equal(result.status, 401);
  assert.equal(forwarded, 0);
});

test("an account switch after a valid snapshot takes the old token's protected share away", { timeout: 5000 }, async (t) => {
  const token = createDesktopToken();
  let stored = "fw_example_stored_key";
  const { port, shim } = await fixture(t, (req, res) => { req.resume(); req.on("end", () => res.end("ok")); }, {
    maxBufferedBodyBytes: 8, maxUnverifiedBufferedBodyBytes: 4,
    gatewayKeyLoader: async () => token,
    storedGatewayKeyLoader: async () => stored,
    tokenFingerprintLoader: async () => desktopTokenFingerprint(token, "fw_example_stored_key"),
  });
  assert.equal((await request(port, { body: "1234", headers: { "x-api-key": token } })).status, 200);
  stored = "fw_example_other_account_key";
  const receiving = Promise.withResolvers();
  shim.on("request", (req) => req.once("data", () => receiving.resolve()));
  const stalled = partialUpload(port, { "content-length": 4, "x-api-key": token });
  await receiving.promise;
  assert.equal((await request(port, { body: "1234" })).status, 503);
  stalled.req.destroy();
});

test("a profile key newer than the last snapshot is rechecked before a refusal", { timeout: 5000 }, async (t) => {
  let legacy = "fw_example_profile_key";
  const { port, shim } = await fixture(t, (req, res) => { req.resume(); req.on("end", () => res.end("ok")); }, {
    maxBufferedBodyBytes: 16, maxUnverifiedBufferedBodyBytes: 4,
    legacyGatewayKeyLoader: async () => legacy,
  });
  await settle();
  const receiving = Promise.withResolvers();
  shim.on("request", (req) => req.once("data", () => receiving.resolve()));
  const stalled = partialUpload(port, { "content-length": 4 });
  await receiving.promise;
  legacy = "fw_example_refreshed_profile_key";
  assert.equal((await request(port, { body: "1234", headers: { "x-api-key": legacy } })).status, 200);
  stalled.req.destroy();
});

test("a credential read that times out asks to retry instead of reporting a missing binding", { timeout: 5000 }, async (t) => {
  const token = createDesktopToken();
  let forwarded = 0;
  const { port } = await fixture(t, (req, res) => { forwarded++; req.resume(); req.on("end", () => res.end("ok")); }, {
    credentialTimeoutMs: 100,
    gatewayKeyLoader: async () => token,
    storedGatewayKeyLoader: async () => "fw_example_stored_key",
    tokenFingerprintLoader: () => new Promise(() => {}),
  });
  const result = await request(port, { headers: { "x-api-key": token } });
  assert.equal(result.status, 503);
  assert.match(result.body.toString(), /Couldn't read Claude Desktop's Nexus credentials in time/);
  assert.equal(forwarded, 0);
});

test("a profile key read that times out asks to retry instead of forwarding unverified", { timeout: 5000 }, async (t) => {
  let forwarded = 0;
  const { port } = await fixture(t, (req, res) => { forwarded++; req.resume(); req.on("end", () => res.end("ok")); }, {
    credentialTimeoutMs: 100,
    legacyGatewayKeyLoader: () => new Promise(() => {}),
  });
  const result = await request(port, { headers: { "x-api-key": "fw_example_profile_key" } });
  assert.equal(result.status, 503);
  assert.match(result.body.toString(), /in time/);
  assert.equal(forwarded, 0);
  // A request with no credential doesn't depend on that read.
  assert.equal((await request(port)).status, 200);
});
