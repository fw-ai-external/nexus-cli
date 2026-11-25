import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { readFile, rm, stat } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { shimTrustOptions } from "./platform.mjs";
import {
  claimDesktopToken, createDesktopToken, desktopTokenFingerprint, desktopTokenFingerprintPath, readDesktopToken, rotateDesktopToken, desktopTokenPath,
} from "./desktop-token.mjs";
import { ensurePrivateParent } from "../../io/private-files.mjs";
import { writeFileAtomic } from "../../io/atomic-write.mjs";

const runExec = promisify(execFile);
const storeUrl = new URL("../../keys/secret-store.mjs", import.meta.url).href;
const credentialUpdates = new Map();

export async function removeDesktopCredential(dataDir) {
  await rm(desktopTokenPath(dataDir), { force: true });
  await rm(desktopTokenFingerprintPath(dataDir), { force: true });
}

export function shimKeyEnvironment(home, { env = process.env, platform = process.platform, realHome = os.homedir() } = {}) {
  const result = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...shimTrustOptions(env).env };
  if (platform === "linux") {
    if (env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) && path.resolve(home) === path.resolve(realHome)) {
      result.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
    }
    result.XDG_RUNTIME_DIR = `/run/user/${process.getuid?.()}`;
    result.DBUS_SESSION_BUS_ADDRESS = `unix:path=${result.XDG_RUNTIME_DIR}/bus`;
  }
  return result;
}

export async function readServiceGatewayKey(home, { run = runExec, timeoutMs = 5000, ...options } = {}) {
  try {
    const env = shimKeyEnvironment(home, options);
    const script = `const { getSecret } = await import(${JSON.stringify(storeUrl)}); process.stdout.write(JSON.stringify({key: await getSecret(process.env.HOME)}));`;
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
      env, timeout: timeoutMs, maxBuffer: 16 * 1024, windowsHide: true,
    });
    const key = JSON.parse(stdout).key;
    return typeof key === "string" && !key.startsWith("fpk_") ? key.trim() : "";
  } catch { return ""; }
}

export function selectDesktopCredential({ home, dataDir, key, rotate = false, writeProfile, readServiceKey = readServiceGatewayKey, warn = () => {} }) {
  const active = credentialUpdates.get(dataDir);
  if (!writeProfile && !active?.writeProfile && active?.key === key && active.rotate === rotate) return active.promise;
  const promise = (async () => {
    await active?.promise.catch(() => {});
    const available = await readServiceKey(home).catch(() => "");
    const expected = Buffer.from(key);
    const actual = Buffer.from(available);
    if (actual.length && actual.length === expected.length && timingSafeEqual(actual, expected)) {
      const previous = await readDesktopToken(dataDir);
      // A token another process created between the read above and this
      // claim is treated like one that was already there: its fingerprint
      // decides whether it may be kept for this key.
      const claimed = previous ? null : await claimDesktopToken(dataDir);
      const existing = previous ?? (claimed.created ? null : claimed.token);
      let token = existing ?? claimed.token;
      const fingerprintPath = desktopTokenFingerprintPath(dataDir);
      const fingerprint = (value) => desktopTokenFingerprint(value, key);
      const priorFingerprint = await readFile(fingerprintPath, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      const rotating = Boolean(existing) && (rotate || priorFingerprint?.trim() !== fingerprint(token));
      if (rotating) token = createDesktopToken();
      const rollback = await writeProfile?.(token);
      let fingerprintWritten = false;
      try {
        ensurePrivateParent(fingerprintPath);
        await writeFileAtomic(fingerprintPath, `${fingerprint(token)}\n`, { mode: 0o600 });
        fingerprintWritten = true;
        if (rotating) await rotateDesktopToken(dataDir, token);
      } catch (error) {
        await rollback?.();
        if (fingerprintWritten) {
          if (priorFingerprint === null) await rm(fingerprintPath, { force: true });
          else await writeFileAtomic(fingerprintPath, priorFingerprint, { mode: 0o600 });
        }
        throw error;
      }
      return token;
    }
    warn("Claude Desktop is using the real key because the background shim can't unlock key storage.");
    await writeProfile?.(key);
    return key;
  })().finally(() => {
    if (credentialUpdates.get(dataDir)?.promise === promise) credentialUpdates.delete(dataDir);
  });
  credentialUpdates.set(dataDir, { key, rotate, writeProfile, promise });
  return promise;
}

async function readStoredGatewayKey(home) {
  const { getSecret } = await import("../../keys/secret-store.mjs");
  return getSecret(home, { fresh: true });
}

export function createStoredGatewayKeyLoader({ home, readKey = readStoredGatewayKey, now = Date.now, timeoutMs = 5000 }) {
  let memo;
  let pending;
  let generation = 0;
  let rejected;
  const loader = async () => {
    try {
      const info = await stat(path.join(home, ".nexus", "config.json")).catch(() => null);
      const stamp = info ? `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}` : "";
      if (memo?.stamp === stamp && (memo.key || now() < memo.retryAt)) return memo.key;
      if (pending?.stamp !== stamp) {
        const version = ++generation;
        const rejection = rejected;
        rejected = null;
        let timer;
        const read = Promise.resolve().then(() => readKey(home)).then((value) => {
          const key = typeof value === "string" ? value.trim() : "";
          return key.startsWith("fpk_") ? "" : key;
        }).catch(() => "");
        const promise = Promise.race([
          read,
          new Promise((resolve) => { timer = setTimeout(() => resolve(""), Math.min(timeoutMs, 5000)); }),
        ]).then((key) => {
          if (version !== generation) return "";
          memo = { key, stamp, retryAt: now() + 1000,
            recheckAt: rejection?.stamp === stamp && rejection.key === key ? now() + 5 * 60_000 : 0 };
          return key;
        }).finally(() => {
          clearTimeout(timer);
          if (pending?.version === version) pending = null;
        });
        pending = { stamp, version, promise };
      }
      return await pending.promise;
    } catch { return ""; }
  };
  loader.invalidate = (rejectedKey) => {
    if (memo?.key === rejectedKey && now() >= memo.recheckAt) {
      rejected = { key: rejectedKey, stamp: memo.stamp };
      memo = null;
    }
  };
  return loader;
}
