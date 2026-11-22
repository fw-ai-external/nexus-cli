import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createShimServer } from "../../../lib/harnesses/claude-desktop/shim.mjs";

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
