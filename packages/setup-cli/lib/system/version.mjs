import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Machine-readable protocol support; additive and independent of release numbers.
 *   login-json             `login --browser --json` writes NDJSON progress events
 *                          on stdout and exactly one final {"type":"result"} line.
 *   logout-json            `logout --json` never prompts and writes exactly one
 *                          {"type":"result"} line.
 *   login-json-key-expiry  `login --browser --json` results may carry
 *                          `key.expiresAt` (ISO 8601) when the web app says.
 *   login-json-previous-key  `login --browser --json` results carry
 *                          `previousKey` ("deleted" | "kept" | "unknown") when
 *                          the sign-in replaced this machine's previous key.
 *                          `--json` is web-app sign-in only, so this reports the
 *                          web app's refresh; a Platform or company-SSO
 *                          rotation is reported in the terminal only.
 *   key-actions-v1         every key create/delete is approved in the browser
 *                          (web app actions signin/refresh/revoke); `logout
 *                          --revoke --json` opens the browser and waits for the
 *                          approval, then prints its one result line.
 *   paste-code             `--paste-code`: the browser shows a code to paste
 *                          into the terminal (oob redirect) instead of the loopback.
 */
export function cliVersionInfo() {
  return {
    version: readLocalVersion(),
    capabilities: ["login-account-type-v1", "login-json", "logout-json", "login-json-key-expiry", "login-json-previous-key", "key-actions-v1", "paste-code"],
  };
}

export function readLocalVersion() {
  try {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "";
  } catch {
    return "";
  }
}
