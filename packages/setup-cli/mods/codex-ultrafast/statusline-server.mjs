#!/usr/bin/env node
/**
 * Entry point Codex runs for the Ultra-fast status line (registered by
 * `nexus codex on`; see server.mjs for what it does). This file only wires the
 * real clock, network, files and terminal probe into the server.
 *
 * Environment (set by `on` in the MCP table, or passed through by Codex):
 *   NEXUS_CODEX_CONFIG       Codex's config.toml, where `on` wrote the Fireworks key
 *   NEXUS_CODEX_PET_DIR      the Nexus pet folder (absent when the user chose their own pet)
 *   NEXUS_CODEX_STATUS_CACHE the last boost status, in Nexus's data folder (kept across `off` and `on`)
 *   NEXUS_ULTRAFAST_STATUS=0 no boost check (the footer shows model and folder only)
 *   NEXUS_ULTRAFAST_MOCK_URL a loopback stand-in for the status API (development)
 *   NEXUS_CODEX_ULTRAFAST_WIDTH=0  no terminal width probe (the badge follows the text)
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseToml } from "../../lib/harnesses/codex/toml.mjs";
import { readText, writeAtomic } from "./files.mjs";
import { httpFetch } from "./http.mjs";
import { createStatusServer } from "./server.mjs";

const run = (cmd, args) => new Promise((resolve) => {
  try {
    execFile(cmd, args, { timeout: 800, maxBuffer: 1 << 20 }, (error, stdout) => resolve(error ? "" : String(stdout)));
  } catch {
    resolve("");
  }
});

/**
 * The width of the terminal Codex runs in: Codex doesn't pass it to a status
 * line provider. The Codex TUI is the `codex` process with a terminal; with
 * several, the one whose working directory is the displayed thread's.
 */
async function probeColumns(cwd) {
  if (process.platform === "win32") return 0;
  const ps = await run("ps", ["-A", "-o", "pid=,tty=,comm="]);
  const tuis = ps.split("\n").map((line) => line.trim().split(/\s+/)).filter(([pid, tty, comm]) =>
    /^\d+$/.test(pid ?? "") && /^[A-Za-z0-9/]+$/.test(tty ?? "") && tty !== "??" && tty !== "?" && path.basename(comm ?? "") === "codex");
  if (!tuis.length) return 0;
  let pick = tuis[0];
  if (tuis.length > 1 && cwd) {
    const out = await run("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", tuis.map(([pid]) => pid).join(",")]);
    let pid = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("p")) pid = line.slice(1);
      else if (line.startsWith("n") && line.slice(1) === cwd) pick = tuis.find(([p]) => p === pid) ?? pick;
    }
  }
  const flag = process.platform === "darwin" ? "-f" : "-F";
  const size = (await run("stty", [flag, `/dev/${pick[1]}`, "size"])).trim().split(/\s+/).map(Number);
  return size[1] > 0 ? size[1] : 0;
}

const server = createStatusServer({
  env: process.env,
  now: Date.now,
  fetch: httpFetch,
  readText,
  writeAtomic,
  mtime: async (file) => (await stat(file)).mtimeMs,
  parseToml,
  probeColumns,
  send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
  home: os.homedir(),
  setInterval,
  clearInterval,
  // Codex keeps an MCP server's stderr in its own logs; stdout is the protocol.
  log: (line) => process.stderr.write(`nexus codex ultrafast: ${line}\n`),
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => server.receive(chunk));
process.stdin.on("end", () => {
  server.stop();
  process.exit(0);
});
process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});
server.start();
