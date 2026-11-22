import process, { stdout } from "node:process";
import { spawn } from "node:child_process";
import { browserOpenCommand } from "../system/win-command.mjs";

import { withSpinner as withSpinnerBase } from "./spinner.mjs";

export { colorsEnabled as colorEnabled } from "./color.mjs";
export { accent, bold, check } from "./style.mjs";
export { hyperlinksEnabled, link } from "./links.mjs";

/** Login narrates on stdout; model-list spinners use stderr (ui.mjs default). */
export function withSpinner(text, work) {
  return withSpinnerBase(text, work, { stream: stdout });
}

/**
 * Open a URL with the platform opener.
 * @param {string} url
 * @param {{ platform?: string, spawnFn?: typeof spawn, graceMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export function openInBrowser(url, { platform = process.platform, spawnFn = spawn, graceMs = 1500 } = {}) {
  const [command, args] = browserOpenCommand(url, { platform });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, args, { stdio: "ignore", detached: true });
    } catch {
      resolve(false);
      return;
    }
    let timer = null;
    let settled = false;
    const settle = (ok) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.unref();
      resolve(ok);
    };
    child.on("error", () => settle(false));
    child.on("exit", (code) => settle(code === 0));
    timer = setTimeout(() => settle(true), graceMs);
  });
}
