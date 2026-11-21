import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensurePrivateParent } from "../../io/private-files.mjs";
import { writeFileAtomic } from "../../io/atomic-write.mjs";

export const CLAUDE_DESKTOP_TOKEN_PREFIX = "nexus-claude-desktop-";
export function desktopTokenPath(dataDir) { return path.join(dataDir, "claude-desktop-token"); }
export function isDesktopToken(value) {
  return typeof value === "string" && value.length === CLAUDE_DESKTOP_TOKEN_PREFIX.length + 64
    && /^nexus-claude-desktop-[0-9a-f]{64}$/.test(value);
}

async function tokenFile(dataDir) {
  const handle = await open(desktopTokenPath(dataDir), constants.O_RDONLY
    | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 128 || (process.platform !== "win32" && info.uid !== process.getuid())) return null;
    const token = (await handle.readFile("utf8")).trim();
    return isDesktopToken(token) ? { token } : null;
  } finally {
    await handle.close();
  }
}

export async function readDesktopToken(dataDir) {
  try { return (await tokenFile(dataDir))?.token ?? null; } catch { return null; }
}

export function createDesktopToken() { return `${CLAUDE_DESKTOP_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`; }

export async function rotateDesktopToken(dataDir, token = createDesktopToken()) {
  if (!isDesktopToken(token)) throw new Error("Desktop token is invalid.");
  ensurePrivateParent(desktopTokenPath(dataDir));
  await writeFileAtomic(desktopTokenPath(dataDir), `${token}\n`, { mode: 0o600 });
  return token;
}

export async function ensureDesktopToken(dataDir) {
  ensurePrivateParent(desktopTokenPath(dataDir));
  let handle;
  try {
    handle = await open(desktopTokenPath(dataDir), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
    const token = createDesktopToken();
    await handle.writeFile(`${token}\n`);
    return token;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally { await handle?.close(); }
  for (let attempt = 0; attempt < 20; attempt++) {
    const token = await readDesktopToken(dataDir);
    if (token) {
      const existing = await open(desktopTokenPath(dataDir), constants.O_RDONLY
        | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
      try {
        const info = await existing.stat();
        if (!info.isFile() || (process.platform !== "win32" && info.uid !== process.getuid())) break;
        await existing.chmod(0o600);
      } finally { await existing.close(); }
      return token;
    }
    await delay(5);
  }
  // A create that died before its write leaves an empty file; anything else stays the user's.
  if (await isEmptyTokenFile(dataDir)) return rotateDesktopToken(dataDir);
  throw new Error("Desktop token file is invalid. Remove it and run nexus claude-desktop on again.");
}

async function isEmptyTokenFile(dataDir) {
  try {
    const handle = await open(desktopTokenPath(dataDir), constants.O_RDONLY
      | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 128 || (process.platform !== "win32" && info.uid !== process.getuid())) return false;
      return (await handle.readFile("utf8")).trim() === "";
    } finally { await handle.close(); }
  } catch { return false; }
}
