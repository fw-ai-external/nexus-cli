import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { builtinDeletePassword, builtinGetPassword, builtinSetPassword } from "../../../lib/keys/builtin-file-secret-store.mjs";

// Stands in for cross-keychain: a Secret Service that is always listed. Also
// stands in for keychain-item-probe.mjs, the attribute-only macOS lookup
// (logged as `itemExists`), which never reads the secret.
// FAKE_KEYCHAIN=broken refuses writes (no default collection), working keeps
// secrets, forgetful accepts writes and keeps nothing.
// FAKE_KEYCHAIN_BACKEND names the listed native backend (default
// secret-service), and FAKE_KEYCHAIN_LOG, when set, gets one line per call
// (`getPassword`, `itemExists`) so specs can count secret reads.
// TS_KEYRING_BACKEND=file (what Nexus sets over SSH) uses the encrypted file,
// as the real module's file backend does.
const mode = process.env.FAKE_KEYCHAIN;
const fileBackend = () => process.env.TS_KEYRING_BACKEND === "file";
const logCall = (op) => {
  if (process.env.FAKE_KEYCHAIN_LOG) {
    appendFileSync(process.env.FAKE_KEYCHAIN_LOG, `${op}\n`);
  }
};
const storePath = () => path.join(process.env.HOME, "fake-keychain.json");
const readStore = () => {
  try {
    return JSON.parse(readFileSync(storePath(), "utf8"));
  } catch {
    return {};
  }
};

export async function resolve(specifier, context, nextResolve) {
  return specifier === "cross-keychain" || specifier.endsWith("/keychain-item-probe.mjs") || specifier.endsWith("/macos-security.mjs")
    ? { url: import.meta.url, shortCircuit: true }
    : nextResolve(specifier, context);
}

export class MacKeychainAccessError extends Error {
  constructor() {
    super("macOS Keychain access was denied or timed out. Re-run and allow access.");
  }
}
export const MAC_SECRET_UNREAD = Symbol("macOS secret not read");
export async function readMacSecret(service, account, { migrate = true } = {}) {
  if (process.env.FAKE_KEYCHAIN_UNMARKED === "1") {
    if (!migrate || !process.stdin.isTTY) {
      logCall("skipNativeRead");
      return MAC_SECRET_UNREAD;
    }
    throw new Error("Unmarked item attempted a native read");
  }
  return getPassword(service, account);
}
export const writeMacSecret = setPassword;
export const deleteMacSecret = deletePassword;

export async function macKeychainItemExists(service, account) {
  logCall("itemExists");
  return mode === "working" && Object.hasOwn(readStore(), `${service}/${account}`);
}

export async function listBackends() {
  return [{ id: process.env.FAKE_KEYCHAIN_BACKEND || "secret-service", priority: 5 }, { id: "file", priority: 1 }];
}

export async function setPassword(service, account, value) {
  if (fileBackend()) return builtinSetPassword(service, account, value);
  if (mode === "broken") {
    throw new Error("Secret Service: no result found");
  }
  if (mode === "working") {
    writeFileSync(storePath(), JSON.stringify({ ...readStore(), [`${service}/${account}`]: value }));
  }
}

export async function getPassword(service, account) {
  logCall("getPassword");
  if (fileBackend()) return builtinGetPassword(service, account);
  if (mode === "denied") throw new MacKeychainAccessError();
  return mode === "working" ? readStore()[`${service}/${account}`] ?? null : null;
}

export async function deletePassword(service, account) {
  if (fileBackend()) return builtinDeletePassword(service, account);
  if (mode !== "working") {
    throw new Error("keychain locked");
  }
  const store = readStore();
  delete store[`${service}/${account}`];
  writeFileSync(storePath(), JSON.stringify(store));
}

export function dataRoot() {
  return "";
}
