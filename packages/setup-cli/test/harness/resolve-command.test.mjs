import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import { harnessCommandEnv, resetHarnessCommandPathForTests, resolveHarnessCommand, resolveHarnessCommandAsync } from "../../lib/harness/detect.mjs";
import { withTempHome } from "../helpers.mjs";
import { stableNodeExec } from "../../lib/system/node-exec.mjs";

it("resolves fallback commands, prefers PATH, and tolerates missing commands", async () => {
  await withTempHome("resolve-command-", async (home) => {
    const fallback = path.join(home, ".npm-global", "bin");
    const primary = path.join(home, "bin");
    await mkdir(fallback, { recursive: true });
    await mkdir(primary);
    for (const dir of [fallback, primary]) {
      await writeFile(path.join(dir, "example-harness"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    const options = { env: { PATH: primary, NEXUS_TEST: "1" }, platform: "linux", root: home };
    assert.equal(resolveHarnessCommand("example-harness", home, options), path.join(primary, "example-harness"));
    options.env.PATH = "";
    assert.equal(resolveHarnessCommand("example-harness", home, options), path.join(fallback, "example-harness"));
    assert.equal(await resolveHarnessCommandAsync("example-harness", home, options), path.join(fallback, "example-harness"));
    assert.equal(await resolveHarnessCommandAsync("example-absent", home, options), "");
    assert.equal(resolveHarnessCommand("example-absent", home, options), "");
    assert.equal(resolveHarnessCommand(null, home, options), "");
  });
});

it("skips Windows shell shims and keeps searching for native executables", async () => {
  await withTempHome("resolve-windows-", async (home) => {
    const fallback = path.join(home, "AppData", "Roaming", "npm");
    await mkdir(fallback, { recursive: true });
    await writeFile(path.join(home, "example-harness.CMD"), "");
    const options = { env: { PATH: home, PATHEXT: ".CMD;.BAT;.EXE" }, platform: "win32" };
    assert.equal(resolveHarnessCommand("example-harness", home, options), "");
    await writeFile(path.join(fallback, "example-harness.EXE"), "");
    assert.equal(resolveHarnessCommand("example-harness", home, options), path.join(fallback, "example-harness.EXE"));
  });
});

it("uses the login-shell PATH only after local lookup fails", { skip: process.platform === "win32" }, async () => {
  await withTempHome("resolve-login-", async (home) => {
    const dir = path.join(home, "custom-bin");
    await mkdir(dir);
    const bin = path.join(dir, "example-harness");
    await writeFile(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const shell = path.join(home, "login-shell");
    await writeFile(shell, `#!/bin/sh\nPATH=${JSON.stringify(dir + ":/usr/bin:/bin")}\nexport PATH\n/bin/sh -c "$3"\n`, { mode: 0o755 });
    const options = { env: { PATH: "", NEXUS_TEST: "1" }, platform: "linux", root: home, shell };
    assert.equal(await resolveHarnessCommandAsync("example-harness", home, options), bin);
    assert.equal(await resolveHarnessCommandAsync("example-harness", home, { ...options, shell: path.join(home, "missing-shell") }), "");
  });
});

it("refreshes stock Codex rows using the fallback binary", { skip: process.platform === "win32" }, async () => {
  await withTempHome("resolve-stock-", async (home) => {
    const bin = path.join(home, ".npm-global", "bin", "codex");
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(bin, '#!/bin/sh\nprintf \'%s\\n\' \'{"models":[{"slug":"gpt-example-new"}]}\'\n');
    await chmod(bin, 0o755);
    const moduleUrl = new URL("../../lib/harnesses/codex/stock-models.mjs", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { refreshCodexStockModels, cachedCodexStockModels } from ${JSON.stringify(moduleUrl)};
      assert.equal(await refreshCodexStockModels({ codexHome: ${JSON.stringify(path.join(home, "external", "config"))}, home: ${JSON.stringify(home)}, resolverOptions: { root: ${JSON.stringify(home)} } }), true);
      assert.equal(cachedCodexStockModels()[0].slug, 'gpt-example-new');
    `], { env: { ...process.env, HOME: home, PATH: "", NEXUS_TEST: "", NEXUS_DETECT_LOGIN_SHELL: "0", NEXUS_CACHE_DIR: path.join(home, "cache") }, encoding: "utf8", timeout: 15_000 });
    assert.equal(child.status, 0, child.stderr);
  });
});

// The probe reads the list with the newer of the `codex` command and the
// ChatGPT app's codex; a tie keeps the command.
const STOCK_PROBE_CASES = [
  { name: "refreshes stock Codex rows with the ChatGPT app's own codex when no command exists", app: "0.169.0", cli: null, wins: "app" },
  { name: "reads the list with the ChatGPT app's codex when it is newer than the command", app: "0.169.0-alpha.11.1", cli: "0.163.0", wins: "app" },
  { name: "reads the list with the codex command when it is newer than the app's", app: "0.169.0-alpha.11.1", cli: "0.170.0", wins: "cli" },
  { name: "keeps the codex command when both report the same version", app: "0.169.0", cli: "0.169.0", wins: "cli" },
  { name: "keeps the codex command when its version is unreadable", app: "0.150.0", cli: "dev", wins: "cli" },
];

for (const { name, app, cli, wins } of STOCK_PROBE_CASES) {
  it(name, { skip: process.platform === "win32" }, async () => {
    await withTempHome("resolve-stock-app-", async (home) => {
      const fakeCodex = async (bin, version, slugs) => {
        await mkdir(path.dirname(bin), { recursive: true });
        await writeFile(bin, [
          "#!/bin/sh",
          `[ "$1" = "--version" ] && { echo 'codex-cli ${version}'; exit 0; }`,
          '[ "$1 $2" = "debug models" ] || exit 2',
          `printf '%s\\n' '${JSON.stringify({ models: slugs.map((slug) => ({ slug })) })}'`,
          "",
        ].join("\n"));
        await chmod(bin, 0o755);
      };
      // A newer Codex is sent a longer list.
      const appSlugs = ["gpt-example-sol", "gpt-example-newest"];
      const cliSlugs = ["gpt-example-cli"];
      await fakeCodex(path.join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex"), app, appSlugs);
      if (cli) {
        await fakeCodex(path.join(home, ".npm-global", "bin", "codex"), cli, cliSlugs);
      }
      const withCli = wins === "cli";
      const moduleUrl = new URL("../../lib/harnesses/codex/stock-models.mjs", import.meta.url).href;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import { refreshCodexStockModels, cachedCodexStockModels } from ${JSON.stringify(moduleUrl)};
        assert.equal(await refreshCodexStockModels({ codexHome: ${JSON.stringify(path.join(home, ".codex"))}, home: ${JSON.stringify(home)}, resolverOptions: { root: ${JSON.stringify(home)}, platform: 'darwin' } }), true);
        assert.deepEqual(cachedCodexStockModels().map((row) => row.slug), ${JSON.stringify(withCli ? cliSlugs : appSlugs)});
      `], { // PATH is empty so a host codex (e.g. /usr/bin/codex) is never found or run.
      env: { ...process.env, HOME: home, PATH: "", NEXUS_TEST: "", NEXUS_DETECT_LOGIN_SHELL: "0", NEXUS_CACHE_DIR: path.join(home, "cache") }, encoding: "utf8", timeout: 15_000 });
      assert.equal(child.status, 0, child.stderr);
    });
  });
}

it("supplies sibling interpreters and the Node runtime to resolved scripts", { skip: process.platform === "win32" }, async () => {
  await withTempHome("resolve-interpreter-", async (home) => {
    const bin = path.join(home, "example-harness");
    await writeFile(bin, "#!/usr/bin/env example-interpreter\n", { mode: 0o755 });
    await writeFile(path.join(home, "example-interpreter"), '#!/bin/sh\nprintf "example-ok"\n', { mode: 0o755 });
    const env = { PATH: "", HOME: home };
    assert.notEqual(spawnSync(bin, [], { env }).status, 0);
    const childEnv = harnessCommandEnv(bin, env);
    assert.deepEqual(childEnv.PATH.split(path.delimiter), [home, path.dirname(stableNodeExec(process.execPath))]);
    assert.equal(spawnSync(bin, [], { env: childEnv, encoding: "utf8" }).stdout, "example-ok");
    assert.equal(harnessCommandEnv("example-harness", env), env);
    assert.equal(harnessCommandEnv(bin, { PATH: "/example/bin" }).PATH.split(path.delimiter)[0], "/example/bin");
    assert.equal(harnessCommandEnv(bin, childEnv).PATH, childEnv.PATH);
    const preferred = path.join(home, "preferred");
    await mkdir(preferred);
    await writeFile(path.join(preferred, "example-interpreter"), '#!/bin/sh\nprintf "preferred-ok"\n', { mode: 0o755 });
    assert.equal(spawnSync(bin, [], { env: harnessCommandEnv(bin, { PATH: preferred }), encoding: "utf8" }).stdout, "preferred-ok");
    assert.equal(env.PATH, "");
  });
});

it("shares the default login PATH promise but keeps injected lookups independent", { skip: process.platform === "win32" }, async () => {
  await withTempHome("resolve-memo-", async (home) => {
    const shell = path.join(home, "login-shell");
    const counter = path.join(home, "calls");
    await writeFile(shell, `#!/bin/sh\nprintf 'call\\n' >> ${JSON.stringify(counter)}\n/bin/sh -c "$3"\n`, { mode: 0o755 });
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { HOME: home, PATH: "", SHELL: shell, NEXUS_TEST: "", NEXUS_DETECT_LOGIN_SHELL: "1" });
      resetHarnessCommandPathForTests();
      const options = { root: home };
      assert.deepEqual(await Promise.all([
        resolveHarnessCommandAsync("example-absent", home, options),
        resolveHarnessCommandAsync("example-other", home, options),
      ]), ["", ""]);
      assert.equal(await readFile(counter, "utf8"), "call\n");
      await resolveHarnessCommandAsync("example-absent", home, { ...options, shell });
      await resolveHarnessCommandAsync("example-absent", home, { ...options, env: { ...process.env } });
      assert.equal(await readFile(counter, "utf8"), "call\ncall\ncall\n");
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      resetHarnessCommandPathForTests();
    }
  });
});
