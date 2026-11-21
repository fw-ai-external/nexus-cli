import assert from "node:assert/strict";
import { linkSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, it } from "node:test";

import {
  buildCodexOpenaiCatalogEntry,
  isCodexOpenaiModelSlug,
  missingCodexSignInRows,
  withCodexConstantFields,
  withCodexSignInRows,
} from "../../../lib/harnesses/codex/catalog.mjs";
import {
  cachedCodexStockModels,
  chatgptAppCodexCommand,
  codexVersionCore,
  pickCodexProbeCommand,
  codexStockCommand,
  parseCodexCatalogModels,
  readStockCatalog,
  refreshCodexStockModels,
  setCodexStockModelsForTests,
} from "../../../lib/harnesses/codex/stock-models.mjs";
import { scopedCacheFilePath } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import { withTempHome } from "../../helpers.mjs";

// A synthetic `codex debug models` document, in the shape stock Codex prints.
const nativeRow = (slug, priority, extra = {}) => ({
  slug,
  display_name: slug.toUpperCase(),
  description: `${slug} from stock Codex.`,
  visibility: "list",
  priority,
  default_reasoning_level: "low",
  supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
  context_window: 200_000,
  max_context_window: 800_000,
  input_modalities: ["text", "image"],
  base_instructions: `You are ${slug}.`,
  supports_search_tool: true,
  prefer_websockets: true,
  ...extra,
});
const DEBUG_MODELS = {
  models: [
    nativeRow("gpt-9-astra", 2),
    nativeRow("gpt-9-sol", 1),
    nativeRow("example-internal", 3, { visibility: "hide" }),
    nativeRow("o-example", 4),
  ],
};

// Resolve codex only under a temp root, so specs never find or run a host codex.
const noHostCodex = (home) => ({
  home,
  resolverOptions: { root: home, platform: "darwin", env: { PATH: "", NEXUS_DETECT_LOGIN_SHELL: "0" } },
});

afterEach(() => {
  setCodexStockModelsForTests(undefined);
});

describe("stock Codex catalog", () => {
  it("runs native Windows Codex without a shell", () => {
    const executable = String.raw`C:\tools\codex.exe`;
    const args = ["debug", "models"];
    assert.deepEqual(codexStockCommand(args, {
      platform: "win32",
      env: { PATH: String.raw`C:\tools` },
      isFile: (file) => file === executable,
      find: () => { throw new Error("native executable should win"); },
    }), [executable, args]);
  });

  it("runs an npm Windows shim's JavaScript entry with Node", () => {
    const prefix = String.raw`C:\example home\npm`;
    const script = path.win32.join(prefix, "node_modules", "@openai", "codex", "bin", "codex.js");
    const node = String.raw`C:\tools\node.exe`;
    const args = ["debug", "models", "--bundled"];
    const options = {
      platform: "win32",
      env: { PATH: prefix },
      execPath: node,
      isFile: () => false,
      find: () => path.win32.join(prefix, "codex.cmd"),
      exists: (file) => file === script,
    };
    assert.deepEqual(codexStockCommand(args, options), [node, [script, ...args]]);
    assert.equal(codexStockCommand(args, { ...options, exists: () => false }), null);
    assert.equal(codexStockCommand(args, { ...options, find: () => "" }), null);
    assert.equal(codexStockCommand(args, { ...options, find: () => "codex.cmd" }), null);
    assert.deepEqual(codexStockCommand(args, { platform: "linux" }), ["codex", args]);
  });

  it("resolves an npm shim from a quoted Windows PATH entry", () => {
    const prefix = String.raw`C:\Users\x\AppData\Roaming\npm`;
    const script = path.win32.join(prefix, "node_modules", "@openai", "codex", "bin", "codex.js");
    const node = String.raw`C:\tools\node.exe`;
    const args = ["debug", "models"];
    for (const key of ["PATH", "Path"]) {
      const env = { [key]: `C:\\other;"${prefix}"` };
      assert.deepEqual(codexStockCommand(args, {
        platform: "win32",
        env,
        execPath: node,
        isFile: () => false,
        find: (_name, { env: searchEnv }) => searchEnv.PATH.split(";").includes(prefix)
          ? path.win32.join(prefix, "codex.cmd") : "",
        exists: (file) => file === script,
      }), [node, [script, ...args]]);
      assert.deepEqual(env, { [key]: `C:\\other;"${prefix}"` });
    }
  });

  for (const outcome of ["success", "empty", "error"]) {
    it(`hard-links auth after symlink EPERM and cleans up on ${outcome}`, async () => {
      await withTempHome("codex-probe-link-", async (home) => {
        const codexHome = path.join(home, ".codex");
        await mkdir(codexHome);
        const auth = JSON.stringify({ example: "synthetic credential fixture" });
        await writeFile(path.join(codexHome, "auth.json"), auth);
        const updatedAuth = JSON.stringify({ example: "synthetic refreshed fixture" });
        let probe;
        let links = 0;
        let observedAuth;
        let sameInode;
        const calls = [];
        const rows = await readStockCatalog(codexHome, {
          ...noHostCodex(home),
          version: async () => "",
          symlink: () => { throw Object.assign(new Error("symlink unavailable"), { code: "EPERM" }); },
          link: (source, destination) => { links++; linkSync(source, destination); },
          run: async (args, probeHome) => {
            probe = probeHome;
            calls.push(args);
            const probeAuth = path.join(probeHome, "auth.json");
            observedAuth = await readFile(probeAuth, "utf8");
            const original = await stat(path.join(codexHome, "auth.json"));
            const linked = await stat(probeAuth);
            sameInode = original.ino === linked.ino && original.dev === linked.dev;
            await writeFile(probeAuth, updatedAuth);
            if (outcome === "error") throw new Error("probe failed");
            return outcome === "success" ? [{ slug: "example-model" }] : [];
          },
        });
        assert.deepEqual(rows, outcome === "success" ? [{ slug: "example-model" }] : []);
        assert.deepEqual(calls, outcome === "empty" ? [[], ["--bundled"]] : [[]]);
        assert.ok(probe);
        assert.equal(links, 1);
        assert.equal(observedAuth, outcome === "empty" ? updatedAuth : auth);
        assert.equal(sameInode, true);
        await assert.rejects(stat(probe), { code: "ENOENT" });
        assert.equal(await readFile(path.join(codexHome, "auth.json"), "utf8"), updatedAuth);
      });
    });
  }

  it("probes without auth when both links fail, never copying credentials", async () => {
    await withTempHome("codex-probe-no-link-", async (home) => {
      const auth = JSON.stringify({ example: "synthetic credential fixture" });
      await writeFile(path.join(home, "auth.json"), auth);
      let probe;
      let links = 0;
      const entries = [];
      const rows = await readStockCatalog(home, {
        ...noHostCodex(home),
        version: async () => "",
        symlink: () => { throw Object.assign(new Error("symlink unavailable"), { code: "EPERM" }); },
        link: () => { links++; throw Object.assign(new Error("different volume"), { code: "EXDEV" }); },
        run: async (_args, probeHome) => {
          probe = probeHome;
          entries.push(await readdir(probeHome));
          return [{ slug: "example-bundled-model" }];
        },
      });
      assert.deepEqual(rows, [{ slug: "example-bundled-model" }]);
      assert.equal(links, 1);
      assert.deepEqual(entries, [[]]);
      assert.ok(probe);
      await assert.rejects(stat(probe), { code: "ENOENT" });
      assert.equal(await readFile(path.join(home, "auth.json"), "utf8"), auth);
    });
  });

  it("keeps visible rows and drops hidden ones", () => {
    assert.deepEqual(parseCodexCatalogModels(DEBUG_MODELS).map((row) => row.slug), ["gpt-9-astra", "gpt-9-sol", "o-example"]);
    assert.deepEqual(parseCodexCatalogModels(null), []);
    assert.deepEqual(parseCodexCatalogModels({ models: [{ visibility: "list" }, "junk"] }), []);
  });

  it("caches the rows for later processes, and keeps them when a refresh finds nothing", async () => {
    await withTempHome("codex-stock-cache-", async (home) => {
      const saved = { HOME: process.env.HOME, list: process.env.NEXUS_TEST_CODEX_MODELS };
      process.env.HOME = home;
      try {
        process.env.NEXUS_TEST_CODEX_MODELS = JSON.stringify(DEBUG_MODELS);
        assert.equal(await refreshCodexStockModels({ codexHome: path.join(home, ".codex") }), true);
        const onDisk = JSON.parse(await readFile(scopedCacheFilePath("codex-stock-models.json"), "utf8"));
        assert.deepEqual(onDisk.models.map((row) => row.slug), ["gpt-9-astra", "gpt-9-sol", "o-example"]);

        setCodexStockModelsForTests(undefined);
        assert.deepEqual(cachedCodexStockModels().map((row) => row.slug), ["gpt-9-astra", "gpt-9-sol", "o-example"]);

        for (const doc of ['{"models":[]}', "not json"]) {
          process.env.NEXUS_TEST_CODEX_MODELS = doc;
          assert.equal(await refreshCodexStockModels({ codexHome: path.join(home, ".codex") }), false);
          assert.equal(cachedCodexStockModels().length, 3);
        }
      } finally {
        process.env.HOME = saved.HOME;
        if (saved.list === undefined) {
          delete process.env.NEXUS_TEST_CODEX_MODELS;
        } else {
          process.env.NEXUS_TEST_CODEX_MODELS = saved.list;
        }
      }
    });
  });

  it("lists stock Codex's GPT rows in its priority order, as Codex's own rows", () => {
    setCodexStockModelsForTests(parseCodexCatalogModels(DEBUG_MODELS));
    const rows = withCodexSignInRows([]);
    assert.deepEqual(rows.map((row) => row.slug), ["gpt-9-sol", "gpt-9-astra"]);
    assert.ok(isCodexOpenaiModelSlug("gpt-9-astra"));
    assert.ok(!isCodexOpenaiModelSlug("o-example"), "only gpt-* models reach FireRouter");

    const stock = parseCodexCatalogModels(DEBUG_MODELS).find((row) => row.slug === "gpt-9-sol");
    const sol = buildCodexOpenaiCatalogEntry("gpt-9-sol", { "gpt-9-sol": { label: "Ignored", contextWindow: 1 } });
    assert.deepEqual(
      sol,
      { ...stock, prefer_websockets: false, auto_review_model_override: "gpt-9-sol" },
      "stock Codex's row as is, plus only what the Fireworks route needs",
    );
    assert.ok(!rows.some((row) => row.slug.startsWith("firerouter")), "no FireRouter row in the sign-in block");

    assert.deepEqual(missingCodexSignInRows(rows), []);
    assert.deepEqual(missingCodexSignInRows(rows.filter((row) => row.slug !== "gpt-9-astra")), ["gpt-9-astra"]);
  });

  it("re-stamps the transport fields and stock Codex's tool search onto stock Codex's rows", () => {
    const stock = parseCodexCatalogModels({
      models: [nativeRow("gpt-9-sol", 1), nativeRow("gpt-9-mini", 2, { supports_search_tool: false })],
    });
    const [native, mini, fireworks] = withCodexConstantFields([
      { ...nativeRow("gpt-9-sol", 1), supports_search_tool: false },
      { ...nativeRow("gpt-9-mini", 2), supports_search_tool: true },
      { slug: "example-model", base_instructions: "", priority: 5 },
    ], stock);
    assert.equal(native.base_instructions, "You are gpt-9-sol.");
    assert.equal(native.priority, 1);
    assert.equal(native.prefer_websockets, false);
    assert.equal(native.supports_search_tool, true, "an earlier release's off is replaced by stock Codex's on");
    assert.equal(mini.supports_search_tool, false, "stock Codex's own off is kept");
    assert.equal(fireworks.priority, 5, "a re-stamp never reorders the picker");

    const [cold] = withCodexConstantFields([{ ...nativeRow("gpt-9-sol", 1), supports_search_tool: false }], null);
    assert.equal(cold.supports_search_tool, true, "without stock rows, GPT rows follow stock Codex's default");
  });

  it("falls back to models.dev's newest model per family without stock rows", () => {
    setCodexStockModelsForTests(null);
    const rows = withCodexSignInRows([]);
    const slugs = rows.map((row) => row.slug);
    assert.ok(slugs.includes("gpt-6-astra"), slugs.join(", "));
    assert.ok(!slugs.includes("gpt-9-sol"));
    for (const row of rows) {
      assert.deepEqual(
        row.supported_reasoning_levels.map((level) => level.effort),
        ["low", "medium", "high", "xhigh"],
        `${row.slug} keeps Codex's Extra high tier without a stock row`,
      );
    }
  });

  it("reads x.y.z out of codex --version output", () => {
    assert.equal(codexVersionCore("codex-cli 0.169.0-alpha.11.1\n"), "0.169.0");
    assert.equal(codexVersionCore("codex-cli 0.163.0"), "0.163.0");
    assert.equal(codexVersionCore("codex: not a version"), "");
    assert.equal(codexVersionCore(undefined), "");
  });

  it("probes with the newer codex, keeping the command on a tie or an unreadable version", async () => {
    const pick = (cli, app, versions) => pickCodexProbeCommand(cli, app, {
      version: async (bin) => versions[bin] ?? "",
    });
    assert.equal(await pick("/cli", "/app", { "/cli": "codex-cli 0.163.0", "/app": "codex-cli 0.169.0-alpha.11.1" }), "/app");
    assert.equal(await pick("/cli", "/app", { "/cli": "codex-cli 0.170.0", "/app": "codex-cli 0.169.0-alpha.11.1" }), "/cli");
    assert.equal(await pick("/cli", "/app", { "/cli": "codex-cli 0.169.0", "/app": "codex-cli 0.169.0-alpha.11.1" }), "/cli", "prereleases of one version tie");
    assert.equal(await pick("/cli", "/app", { "/cli": "codex-cli 0.169.0", "/app": "codex-cli 0.169.0" }), "/cli");
    assert.equal(await pick("/cli", "/app", { "/cli": "codex-cli 0.169.0" }), "/cli", "app version unreadable");
    assert.equal(await pick("/cli", "/app", { "/app": "codex-cli 0.150.0" }), "/cli", "command version unreadable");
    assert.equal(await pick("/cli", "/app", { "/app": "codex-cli 0.170.0" }), "/cli", "unreadable command is kept even against a newer app");
    assert.equal(await pick("/cli", "/app", {}), "/cli", "neither readable");
    let asked = 0;
    const counted = { version: async () => { asked += 1; return ""; } };
    assert.equal(await pickCodexProbeCommand("/cli", "", counted), "/cli");
    assert.equal(await pickCodexProbeCommand("", "/app", counted), "/app");
    assert.equal(await pickCodexProbeCommand("", "", counted), "");
    assert.equal(asked, 0, "one candidate needs no version check");
  });

  it("logs which codex the probe picked and both versions, never a path", async () => {
    const cli = "/Users/example-user/.local/bin/codex";
    const app = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
    const run = async (versions, candidates = [cli, app]) => {
      const lines = [];
      await pickCodexProbeCommand(...candidates, { version: async (bin) => versions[bin] ?? "", log: (line) => lines.push(line) });
      return lines;
    };
    assert.deepEqual(
      await run({ [cli]: "codex-cli 0.163.0", [app]: "codex-cli 0.169.0-alpha.11.1" }),
      ["codex model probe: ChatGPT app codex (command 0.163.0, app 0.169.0)"],
    );
    assert.deepEqual(await run({}), ["codex model probe: codex command (command version unreadable, app version unreadable)"]);
    assert.deepEqual(await run({}, [cli, ""]), ["codex model probe: codex command (only one installed)"]);
    assert.deepEqual(await run({}, ["", ""]), ["codex model probe: no codex found"]);
    for (const line of [...await run({ [cli]: "codex-cli 0.170.0" }), ...await run({}, ["", app])]) {
      assert.ok(!line.includes("/"), `no path in: ${line}`);
    }
  });

  it("never lets a throwing logger change the pick", async () => {
    const log = () => { throw new Error("logger unavailable"); };
    assert.equal(await pickCodexProbeCommand("/cli", "", { log }), "/cli");
    assert.equal(await pickCodexProbeCommand("/cli", "/app", {
      log,
      version: async (bin) => (bin === "/app" ? "codex-cli 0.169.0" : "codex-cli 0.163.0"),
    }), "/app");
  });

  it("falls back to the other codex when the newer one lists nothing, signed-in lists first", { skip: process.platform === "win32" }, async () => {
    await withTempHome("codex-probe-fallback-", async (home) => {
      const cli = path.join(home, ".npm-global", "bin", "codex");
      const app = path.join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex");
      for (const bin of [cli, app]) {
        await mkdir(path.dirname(bin), { recursive: true });
        await writeFile(bin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      }
      const label = (bin) => (bin === cli ? "cli" : bin === app ? "app" : bin);
      const run = async (rowsFor) => {
        const calls = [];
        const rows = await readStockCatalog(path.join(home, ".codex"), {
          ...noHostCodex(home),
          version: async (bin) => (bin === app ? "codex-cli 0.169.0" : "codex-cli 0.163.0"),
          run: async (args, _probeHome, bin) => {
            calls.push(`${label(bin)} ${args.join(" ") || "signed-in"}`);
            return rowsFor(label(bin), args);
          },
        });
        return { slugs: rows.map((row) => row.slug), calls };
      };
      assert.deepEqual(await run((bin, args) => (bin === "cli" && !args.length ? [{ slug: "gpt-example-cli" }] : [])), {
        slugs: ["gpt-example-cli"],
        calls: ["app signed-in", "cli signed-in"],
      });
      assert.deepEqual(await run((bin, args) => (bin === "app" && args.length ? [{ slug: "gpt-example-bundled" }] : [])), {
        slugs: ["gpt-example-bundled"],
        calls: ["app signed-in", "cli signed-in", "app --bundled"],
      });
      assert.deepEqual(await run(() => []), {
        slugs: [],
        calls: ["app signed-in", "cli signed-in", "app --bundled", "cli --bundled"],
      });
    });
  });

  it("finds the codex inside the macOS ChatGPT app, machine-wide or per-user", { skip: process.platform === "win32" }, async () => {
    await withTempHome("codex-chatgpt-app-", async (home) => {
      const root = path.join(home, "root");
      const bundled = (dir) => path.join(dir, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex");
      assert.equal(chatgptAppCodexCommand(home, { platform: "darwin", root }), "");

      await mkdir(path.dirname(bundled(home)), { recursive: true });
      await writeFile(bundled(home), "#!/bin/sh\n", { mode: 0o644 });
      assert.equal(chatgptAppCodexCommand(home, { platform: "darwin", root }), "", "not executable");
      await chmod(bundled(home), 0o755);
      assert.equal(chatgptAppCodexCommand(home, { platform: "darwin", root }), bundled(home));

      await mkdir(path.dirname(bundled(root)), { recursive: true });
      await writeFile(bundled(root), "#!/bin/sh\n", { mode: 0o755 });
      assert.equal(chatgptAppCodexCommand(home, { platform: "darwin", root }), bundled(root), "/Applications first");
      assert.equal(chatgptAppCodexCommand(home, { platform: "linux", root }), "", "macOS only");
    });
  });
});
