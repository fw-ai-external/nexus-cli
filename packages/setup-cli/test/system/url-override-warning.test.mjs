import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { warnInsecureUrlOverride } from "../../lib/system/url-override-warning.mjs";
import { verifyFireworksApiKey } from "../../lib/keys/verify-api-key.mjs";
import { downloadCliTarball } from "../../lib/system/tarball-update.mjs";
import { withTempHome } from "../helpers.mjs";
import { parseCli } from "../../lib/cli/parse-args.mjs";
import { getOAuthArgumentsForAccount } from "../../lib/auth/sso-account.mjs";
import { listAccountsForIdToken } from "../../lib/keys/mint-api-key.mjs";

const cli = fileURLToPath(new URL("../../bin/nexus.mjs", import.meta.url));

test("URL overrides warn without revealing URL credentials, paths or queries", (t) => {
  const lines = [];
  t.mock.method(console, "warn", (line) => lines.push(line));
  warnInsecureUrlOverride("http://example-user:example-password@example.com/private?token=example-token", "Example URL override");
  warnInsecureUrlOverride("http://example.com", "Example URL override");
  assert.deepEqual(lines, ["Warning: Example URL override uses a non-HTTPS remote URL; traffic may be exposed."]);
});

test("HTTPS, loopback HTTP, empty and malformed overrides stay silent", (t) => {
  const lines = [];
  t.mock.method(console, "warn", (line) => lines.push(line));
  for (const value of ["https://example.com", "http://localhost:1234", "http://127.0.0.1", "http://[::1]:1234", "", "not a URL"]) {
    warnInsecureUrlOverride(value, "Silent URL override");
  }
  assert.deepEqual(lines, []);
});

test("warnings never throw even when the observer fails", (t) => {
  t.mock.method(console, "warn", () => { throw new Error("output unavailable"); });
  assert.doesNotThrow(() => warnInsecureUrlOverride("http://example.com", "Unavailable warning output"));
});

test("credential verification and downloads warn but retain the override destination", async (t) => {
  const lines = [];
  const urls = [];
  t.mock.method(console, "warn", (line) => lines.push(line));
  t.mock.method(globalThis, "fetch", async (url) => { urls.push(url); return new Response(null, { status: 401 }); });
  const verified = await verifyFireworksApiKey("example-key", { gatewayUrl: "http://example.com" });
  assert.equal(verified.reason, "rejected");
  await withTempHome("url-warning-download-", async (home) => {
    await assert.rejects(downloadCliTarball(`${home}/staging`, { url: "http://example.com/archive" }), /HTTP 401/);
  });
  assert.deepEqual(urls, ["http://example.com/verifyApiKey", "http://example.com/archive"]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Gateway URL override/);
  assert.match(lines[1], /NEXUS_TARBALL_URL/);
});

test("SSO and key minting warn only for the gRPC-web destination they use", async (t) => {
  const lines = [];
  const urls = [];
  t.mock.method(console, "warn", (line) => lines.push(line));
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    return new Response(null, { status: 401 });
  });
  for (const baseUrl of ["https://example.com", "http://127.0.0.1:1234"]) {
    await getOAuthArgumentsForAccount("example-account", { baseUrl });
    await listAccountsForIdToken("example-token", { baseUrl });
  }
  assert.deepEqual(lines, []);
  const baseUrl = "http://example.com";
  const args = await getOAuthArgumentsForAccount("example-account", { baseUrl });
  const accounts = await listAccountsForIdToken("example-token", { baseUrl });
  assert.equal(args.ok, false);
  assert.equal(accounts.ok, false);
  assert.deepEqual(urls.slice(-2), [`${baseUrl}/GetOAuthArguments`, `${baseUrl}/ListAccounts`]);
  assert.deepEqual(lines, ["Warning: NEXUS_GATEWAY_GRPC_WEB_URL uses a non-HTTPS remote URL; traffic may be exposed."]);
});

test("unused overrides never warn on CLI, machine-readable, or observer paths", async () => {
  await withTempHome("url-warning-observers-", async (home) => {
    const env = {
      ...process.env, HOME: home, USERPROFILE: home,
      NEXUS_CACHE_DIR: `${home}/cache`, NEXUS_NO_UPDATE_CHECK: "1",
      NEXUS_GATEWAY_URL: "http://example.com",
      NEXUS_TARBALL_URL: "http://example.com",
      NEXUS_GATEWAY_GRPC_WEB_URL: "http://example.com",
      NEXUS_COGNITO_DOMAIN: "http://example.com",
      NEXUS_DEVICE_AUTH_URL: "http://example.com",
      OPENAI_BASE_URL: "http://example.com",
    };
    for (const args of [["help"], ["--version"], ["--version", "--json"]]) {
      const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /non-HTTPS remote URL/);
      if (args.includes("--json")) assert.equal(typeof JSON.parse(result.stdout).version, "string");
    }
    const statusline = fileURLToPath(new URL("../../bin/claude-statusline.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [statusline], { env, input: "{}", encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");

    const refreshUrl = new URL("../../lib/harnesses/claude/statusline-refresh.mjs", import.meta.url).href;
    const checkerUrl = new URL("../../lib/system/update-checker.mjs", import.meta.url).href;
    const shimUrl = new URL("../../lib/harnesses/claude-desktop/shim.mjs", import.meta.url).href;
    const observers = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { get } from "node:http";
      const seen = [];
      globalThis.fetch = async (url) => {
        seen.push(String(url));
        return String(url).endsWith("/verifyApiKey")
          ? new Response(null, { status: 401 })
          : new Response(JSON.stringify({ data: [] }));
      };
      const { refreshPriceCaches } = await import(${JSON.stringify(refreshUrl)});
      await refreshPriceCaches({ home: process.env.HOME, env: {
        ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_example_header_key",
      } });
      assert.ok(seen.some((url) => url.endsWith("/verifyApiKey")));
      await import(${JSON.stringify(checkerUrl)});
      const { createShimServer } = await import(${JSON.stringify(shimUrl)});
      const server = createShimServer({ modelMap: {}, catalogDir: process.env.HOME, log: () => {} });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        await new Promise((resolve, reject) => {
          get({ hostname: "127.0.0.1", port: server.address().port, path: "/example", agent: false }, (res) => {
            assert.equal(res.statusCode, 200);
            res.resume();
            res.on("end", resolve);
          }).on("error", reject);
        });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    `], {
      env: { ...env, NEXUS_TEST: "0", NEXUS_PLAN_CATALOG_FILTER: "1" },
      encoding: "utf8", timeout: 10000,
    });
    assert.equal(observers.status, 0, observers.stderr);
    assert.equal(observers.stderr, "");
  });
});

test("the explicit base URL flag warns without changing the configured URL", (t) => {
  const lines = [];
  t.mock.method(console, "warn", (line) => lines.push(line));
  const parsed = parseCli(["configure", "--provider", "azure", "--base-url", "http://example.com"]);
  assert.equal(parsed.ctx.baseUrl, "http://example.com");
  assert.match(lines[0], /--base-url uses a non-HTTPS remote URL/);
});
