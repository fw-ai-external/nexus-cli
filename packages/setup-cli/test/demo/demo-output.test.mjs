import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runDemoClean } from "../../lib/demo/command.mjs";
import {
  collectWorkDir, prepareOutputDir, writeAppHtml, writeCompareHtml, writeResultJson, writeStreamLog,
} from "../../lib/demo/output.mjs";

const unsafe = { message: "Unsafe demo output: symlinks and special files are not allowed." };
const prepare = (dir) => prepareOutputDir(dir, { prompt: { text: "example prompt" } });
const result = (dir) => writeResultJson(dir, {}, { incumbent: {}, fireworks: {} });
const writers = [
  ["prompt.txt", prepare],
  ["compare.html", (dir) => writeCompareHtml(dir, "<html>example</html>")],
  ["result.json", result],
  ["rates.json", result],
  ...["incumbent", "fireworks"].flatMap((side) => [
    [`${side}/app.html`, (dir) => writeAppHtml(path.join(dir, side), "<html>example</html>", dir)],
    [`${side}/stream.log`, (dir) => writeStreamLog(path.join(dir, side), [], dir)],
  ]),
];

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus-demo-output-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [name, write] of writers) {
  test(`output: ${name} creates and replaces regular files`, async () => {
    await fixture(async (root) => {
      const out = path.join(root, "nexus-demo");
      await write(out);
      const content = await readFile(path.join(out, name), "utf8");
      await write(out);
      assert.equal(await readFile(path.join(out, name), "utf8"), content);
      assert.equal((await lstat(path.join(out, name))).isFile(), true);
    });
  });

  for (const dangling of [false, true]) {
    test(`output: ${name} refuses a ${dangling ? "dangling" : "live"} leaf symlink`, { skip: process.platform === "win32" }, async () => {
      await fixture(async (root) => {
        const out = path.join(root, "nexus-demo");
        const leaf = path.join(out, name);
        const outside = path.join(root, "outside.txt");
        await mkdir(path.dirname(leaf), { recursive: true });
        if (!dangling) await writeFile(outside, "keep me");
        await symlink(outside, leaf);
        await assert.rejects(prepare(out), unsafe);
        await assert.rejects(write(out), unsafe);
        assert.equal((await lstat(leaf)).isSymbolicLink(), true);
        if (dangling) await assert.rejects(lstat(outside), { code: "ENOENT" });
        else assert.equal(await readFile(outside, "utf8"), "keep me");
      });
    });
  }

  test(`output: ${name} refuses a non-file leaf`, async () => {
    await fixture(async (root) => {
      const out = path.join(root, "nexus-demo");
      await mkdir(path.join(out, name), { recursive: true });
      await assert.rejects(write(out), unsafe);
    });
  });

  for (const parentLink of [false, true]) {
    test(`output: ${name} ${parentLink ? "allows a symlinked parent" : "refuses a symlinked output directory"}`, { skip: process.platform === "win32" }, async () => {
      await fixture(async (root) => {
        const outside = path.join(root, "outside");
        const alias = path.join(root, "alias");
        await mkdir(outside);
        await writeFile(path.join(outside, "keep.txt"), "keep me");
        await symlink(outside, alias, "dir");
        if (parentLink) {
          await write(path.join(alias, "nexus-demo"));
          assert.equal((await lstat(path.join(outside, "nexus-demo", name))).isFile(), true);
          assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "keep me");
        } else {
          await assert.rejects(write(alias), unsafe);
          assert.deepEqual(await readdir(outside), ["keep.txt"]);
        }
      });
    });
  }
}

for (const side of ["incumbent", "fireworks"]) {
  for (const [name, write] of [
    ["preparation", prepare],
    ["app", (dir) => writeAppHtml(path.join(dir, side), "", dir)],
    ["stream", (dir) => writeStreamLog(path.join(dir, side), [], dir)],
  ]) {
    test(`output: ${name} refuses a symlinked ${side} directory`, { skip: process.platform === "win32" }, async () => {
      await fixture(async (root) => {
        const out = path.join(root, "nexus-demo");
        const outside = path.join(root, "outside");
        await mkdir(out);
        await mkdir(outside);
        await symlink(outside, path.join(out, side), "dir");
        await assert.rejects(write(out), unsafe);
        assert.deepEqual(await readdir(outside), []);
        await assert.rejects(lstat(path.join(out, "prompt.txt")), { code: "ENOENT" });
      });
    });
  }
}

test("output: work collection preserves files and replaces stale artifacts", async () => {
  await fixture(async (root) => {
    const cwd = path.join(root, "scratch");
    const out = path.join(root, "nexus-demo");
    const dest = path.join(out, "work", "incumbent");
    await mkdir(cwd);
    await collectWorkDir(null, out, "incumbent");
    await collectWorkDir(path.join(root, "missing"), out, "incumbent");
    await collectWorkDir(cwd, out, "incumbent");
    await assert.rejects(lstat(out), { code: "ENOENT" });
    await writeFile(path.join(cwd, "example.txt"), "example");
    await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, "stale.txt"), "stale");
    await collectWorkDir(cwd, out, "incumbent");
    assert.deepEqual(await readdir(dest), ["example.txt"]);
    assert.equal(await readFile(path.join(dest, "example.txt"), "utf8"), "example");
  });
});

for (const entry of [".", "work", "work/incumbent", "work/incumbent/nested"]) {
  test(`output: work collection refuses a symlink at ${entry}`, { skip: process.platform === "win32" }, async () => {
    await fixture(async (root) => {
      const cwd = path.join(root, "scratch");
      const out = path.join(root, "nexus-demo");
      const outside = path.join(root, "outside");
      const target = path.join(out, entry);
      await mkdir(cwd);
      await writeFile(path.join(cwd, "example.txt"), "example");
      await mkdir(outside);
      await writeFile(path.join(outside, "keep.txt"), "keep me");
      await mkdir(path.dirname(target), { recursive: true });
      await symlink(outside, target, "dir");
      await assert.doesNotReject(collectWorkDir(cwd, out, "incumbent"));
      assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "keep me");
      assert.deepEqual(await readdir(outside), ["keep.txt"]);
      assert.equal((await lstat(target)).isSymbolicLink(), true);
    });
  });
}

for (const parentLink of [false, true]) {
  test(`clean: ${parentLink ? "allows a symlinked parent" : "refuses a symlinked output directory"}`, { skip: process.platform === "win32" }, async () => {
    await fixture(async (root) => {
      const real = path.join(root, "real");
      const alias = path.join(root, "alias");
      const outside = parentLink ? path.join(real, "nexus-demo") : real;
      const tmpRoot = path.join(root, "tmp");
      await mkdir(outside, { recursive: true });
      await mkdir(tmpRoot);
      await writeFile(path.join(outside, "compare.html"), "keep me");
      await symlink(real, alias, "dir");
      const out = parentLink ? path.join(alias, "nexus-demo") : alias;
      if (parentLink) {
        await runDemoClean({ out, yes: true }, { tmpRoot });
        await assert.rejects(lstat(outside), { code: "ENOENT" });
      } else {
        await assert.rejects(runDemoClean({ out, yes: true }, { tmpRoot }), unsafe);
        assert.equal(await readFile(path.join(outside, "compare.html"), "utf8"), "keep me");
      }
      assert.equal((await lstat(alias)).isSymbolicLink(), true);
    });
  });
}

test("clean: removes nested links without deleting their targets", { skip: process.platform === "win32" }, async () => {
  await fixture(async (root) => {
    const out = path.join(root, "nexus-demo");
    const outside = path.join(root, "outside");
    const tmpRoot = path.join(root, "tmp");
    await mkdir(out);
    await mkdir(outside);
    await mkdir(tmpRoot);
    await writeFile(path.join(out, "compare.html"), "example");
    await writeFile(path.join(outside, "keep.txt"), "keep me");
    await symlink(outside, path.join(out, "incumbent"), "dir");
    await runDemoClean({ out, yes: true }, { tmpRoot });
    await assert.rejects(lstat(out), { code: "ENOENT" });
    assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "keep me");
  });
});
