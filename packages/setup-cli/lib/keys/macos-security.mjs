import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { KEYRING_OP_TIMEOUT_MS } from "./keyring-timeout.mjs";

const runExec = promisify(execFile);
const SECURITY = "/usr/bin/security";
const SECURITY_ACL_COMMENT = "nexus-acl:security";
const INTERACTIVE_READ_TIMEOUT_MS = 120_000;
export const MAC_SECRET_UNREAD = Symbol("macOS secret not read");

export class MacKeychainAccessError extends Error {
  constructor(message = "macOS Keychain access was denied or timed out. Re-run and allow access.") {
    super(message);
    this.name = "MacKeychainAccessError";
  }
}

// security's interactive parser is not a shell. Reject its ambiguous characters.
export function securityQuote(value) {
  if (/[\r\n\0'"\\]/u.test(value)) {
    throw new Error("macOS Keychain values cannot contain newlines, quotes, backslashes or NUL.");
  }
  return `"${value}"`;
}

export function runSecurity(args, { input, timeoutMs = KEYRING_OP_TIMEOUT_MS, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(SECURITY, args, { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new MacKeychainAccessError());
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => {});
    child.once("error", () => {
      clearTimeout(timer);
      reject(new MacKeychainAccessError());
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new MacKeychainAccessError(), { code }));
    });
    child.stdin.end(input);
  });
}

export async function deleteMacSecret(service, account, { run = runExec, timeoutMs = KEYRING_OP_TIMEOUT_MS } = {}) {
  try {
    await run(SECURITY, ["delete-generic-password", "-s", service, "-a", account], { timeout: timeoutMs, killSignal: "SIGKILL" });
  } catch (error) {
    if (error.code !== 44) throw new MacKeychainAccessError();
  }
}

export async function writeMacSecret(service, account, secret, { run = runSecurity, read = readMacSecret, remove = deleteMacSecret } = {}) {
  const command = `add-generic-password -U -s ${securityQuote(service)} -a ${securityQuote(account)} -j ${securityQuote(SECURITY_ACL_COMMENT)} -w ${securityQuote(secret)}\n`;
  // Updating a Node-created item preserves its ACL; recreate it instead.
  await remove(service, account);
  try {
    await run(["-i"], { input: command });
    if (await read(service, account, { nativeRead: null }) !== secret) throw new Error();
  } catch {
    throw new MacKeychainAccessError("macOS Keychain write or verification failed after deleting the old item. Re-run `nexus login` to restore the key.");
  }
}

async function readNativeSecret(service, account, { run = runExec, timeoutMs = KEYRING_OP_TIMEOUT_MS } = {}) {
  // The native API is synchronous. Isolate it so its permission dialog cannot
  // block the CLI's event loop or defeat the subprocess timeout.
  const script = `import { getPassword } from "cross-keychain"; process.stdout.write(JSON.stringify(await getPassword(process.argv[1], process.argv[2])));`;
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script, service, account], {
    cwd: new URL("../../", import.meta.url),
    env: { ...process.env, TS_KEYRING_BACKEND: "native-macos" },
    timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
  });
  return JSON.parse(stdout);
}

async function restoreNativeSecret(service, account, value) {
  await deleteMacSecret(service, account);
  const script = `import { setPassword } from "cross-keychain"; import { readFileSync } from "node:fs"; await setPassword(process.argv[1], process.argv[2], readFileSync(0, "utf8"));`;
  const pending = runExec(process.execPath, ["--input-type=module", "-e", script, service, account], {
    cwd: new URL("../../", import.meta.url),
    env: { ...process.env, TS_KEYRING_BACKEND: "native-macos" },
    timeout: KEYRING_OP_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
  });
  pending.child.stdin.on("error", () => {});
  pending.child.stdin.end(value);
  await pending;
}

export async function readMacSecret(service, account, {
  run = runExec, nativeRead = readNativeSecret, write = writeMacSecret, restore = restoreNativeSecret,
  timeoutMs = KEYRING_OP_TIMEOUT_MS,
  isTTY = process.stdin.isTTY,
  migrate = true,
} = {}) {
  let metadata;
  try {
    metadata = await run(SECURITY, ["find-generic-password", "-s", service, "-a", account], {
      timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
    });
  } catch (error) {
    if (error.code === 44) return null;
    throw new MacKeychainAccessError();
  }
  const comment = metadata.stdout.match(/^\s*"icmt"<blob>="([^"]*)"\s*$/mu)?.[1];
  if (comment === SECURITY_ACL_COMMENT) {
    try {
      const { stdout } = await run(SECURITY, ["find-generic-password", "-s", service, "-a", account, "-w"], {
        timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
      });
      return stdout.replace(/\n$/u, "");
    } catch (error) {
      if (error.code === 44) return null;
      throw new MacKeychainAccessError();
    }
  }
  if (!migrate || !isTTY) return MAC_SECRET_UNREAD;
  let value;
  try {
    value = await nativeRead?.(service, account, {
      timeoutMs: isTTY ? INTERACTIVE_READ_TIMEOUT_MS : KEYRING_OP_TIMEOUT_MS,
    });
  } catch {
    throw new MacKeychainAccessError();
  }
  if (typeof value !== "string" || !value) throw new MacKeychainAccessError();
  try {
    await write(service, account, value);
  } catch {
    try {
      await restore(service, account, value);
    } catch {
      throw new MacKeychainAccessError("macOS Keychain migration and recovery failed. Re-run `nexus login` to restore the key.");
    }
  }
  return value;
}
