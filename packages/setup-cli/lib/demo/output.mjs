/**
 * Output-directory writer for `nexus demo`.
 *
 * Everything the demo produces lands on disk for auditability and `--no-open`:
 *   {out}/prompt.txt            exact prompt sent to both
 *   {out}/rates.json            per-token rates used, per provider, with source
 *   {out}/result.json           full measured result (times, tokens, costs, ratios)
 *   {out}/incumbent/app.html    the incumbent's generated app
 *   {out}/incumbent/stream.log  raw token stream + timestamps (JSONL)
 *   {out}/fireworks/app.html    GLM 5.2 Fast's generated app
 *   {out}/fireworks/stream.log  raw token stream + timestamps (JSONL)
 *   {out}/compare.html          self-contained comparison page (also file://-openable)
 */

import { cp, lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../io/atomic-write.mjs";
import { writeJson } from "../io/json.mjs";

function unsafeOutput() {
  return new Error("Unsafe demo output: symlinks and special files are not allowed.");
}

async function outputEntry(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function assertOutputDirectory(dir, outDir = dir) {
  const resolved = path.resolve(dir);
  const root = path.resolve(outDir);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw unsafeOutput();
  if (resolved !== root) await assertOutputDirectory(path.dirname(resolved), root);
  const entry = await outputEntry(resolved);
  if (entry && !entry.isDirectory()) throw unsafeOutput();
}

async function assertOutputFile(filePath, outDir = path.dirname(filePath)) {
  await assertOutputDirectory(path.dirname(filePath), outDir);
  const entry = await outputEntry(filePath);
  if (entry && !entry.isFile()) throw unsafeOutput();
}

async function assertOutputTree(dir, outDir = dir) {
  await assertOutputDirectory(dir, outDir);
  if (!await outputEntry(dir)) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await assertOutputTree(full, outDir);
    else await assertOutputFile(full, outDir);
  }
}

async function writeOutputFile(filePath, data, outDir = path.dirname(filePath)) {
  await assertOutputFile(filePath, outDir);
  await writeFileAtomic(filePath, data);
}

/**
 * @param {string} outDir
 * @param {{
 *   prompt: { title: string, text: string, source: string, presetId?: string },
 *   seed: number,
 *   mode: "race" | "replay",
 *   challengerModel: string,
 * }} header
 * @returns {Promise<{ outDir: string, incumbentDir: string, fireworksDir: string }>}
 */
export async function prepareOutputDir(outDir, header) {
  await assertOutputTree(outDir);
  const incumbentDir = path.join(outDir, "incumbent");
  const fireworksDir = path.join(outDir, "fireworks");
  await assertOutputDirectory(incumbentDir, outDir);
  await assertOutputDirectory(fireworksDir, outDir);
  await mkdir(incumbentDir, { recursive: true });
  await mkdir(fireworksDir, { recursive: true });
  await writeOutputFile(path.join(outDir, "prompt.txt"), header.prompt.text);
  return { outDir, incumbentDir, fireworksDir };
}

/**
 * @param {string} dir
 * @param {{ t: number, text: string }[]} tokenLog
 * @param {string} [outDir]
 */
export async function writeStreamLog(dir, tokenLog, outDir = dir) {
  const lines = tokenLog.map((entry) => JSON.stringify(entry)).join("\n");
  await writeOutputFile(path.join(dir, "stream.log"), `${lines}\n`, outDir);
}

/**
 * @param {string} dir
 * @param {string} html
 * @param {string} [outDir]
 */
export async function writeAppHtml(dir, html, outDir = dir) {
  await writeOutputFile(path.join(dir, "app.html"), html, outDir);
}

/**
 * @param {string} outDir
 * @param {import("./measurement.mjs").DemoResult} result
 * @param {{ incumbent: object, fireworks: object }} rates
 */
export async function writeResultJson(outDir, result, rates) {
  await assertOutputFile(path.join(outDir, "result.json"));
  await assertOutputFile(path.join(outDir, "rates.json"));
  // Atomic (temp + rename) via writeJson, so a Ctrl-C / crash mid-write can't
  // leave a truncated result.json or rates.json for readers to parse.
  await writeJson(path.join(outDir, "result.json"), result);
  await writeJson(path.join(outDir, "rates.json"), { incumbent: rates.incumbent, fireworks: rates.fireworks });
}

/**
 * @param {string} outDir
 * @param {string} html
 */
export async function writeCompareHtml(outDir, html) {
  await writeOutputFile(path.join(outDir, "compare.html"), html);
}

/** Preserve scratch artifacts without following existing output links. */
export async function collectWorkDir(cwd, outDir, side) {
  if (!cwd) return;
  try {
    if ((await readdir(cwd)).length === 0) return;
  } catch {
    return;
  }
  const dest = path.join(outDir, "work", side);
  try {
    await assertOutputTree(dest, outDir);
    await rm(dest, { recursive: true, force: true });
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(cwd, dest, { recursive: true, force: true });
  } catch { /* artifacts are a nicety; never break the run over them */ }
}

/**
 * Best-effort recovery of an app that a harness wrote to a file instead of
 * printing to stdout. Walks `dir` (a few levels deep) for `.html`/`.htm` files
 * and returns the contents of the largest one, or "" if none is found. Never
 * throws — a missing dir / read error yields "".
 *
 * @param {string} dir
 * @param {{ maxDepth?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function readBestHtmlFromDir(dir, { maxDepth = 3 } = {}) {
  if (!dir) {
    return "";
  }
  let best = { size: -1, path: "" };
  const walk = async (current, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      // Skip symlinks: this scans a tmp cwd the raced `claude -p` process
      // writes to, and a model can write `*.html` as a symlink to an arbitrary
      // readable path (e.g. /etc/passwd). stat/readFile follow symlinks, which
      // would exfiltrate that file's contents into the demo's compare.html.
      // Dirent from readdir({withFileTypes}) reports the link's own type, so
      // isSymbolicLink() catches both symlinked files and symlinked dirs.
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(full, depth + 1);
      } else if (/\.html?$/i.test(entry.name)) {
        try {
          const s = await stat(full);
          if (s.size > best.size) best = { size: s.size, path: full };
        } catch { /* skip */ }
      }
    }
  };
  await walk(dir, 0);
  if (!best.path) {
    return "";
  }
  try {
    return await readFile(best.path, "utf8");
  } catch {
    return "";
  }
}
