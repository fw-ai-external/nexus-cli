import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import os from "node:os";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { PAGE_REUSED_FAILURE, pkcePair, waitForCallback } from "./browser-auth.mjs";
import { isRemoteContext } from "../config/remote-context.mjs";
import { keysUrlFor, keysUrlOverrideNote } from "../keys/api-key.mjs";
import { BROWSER_SIGNIN_NO_ACCOUNT_FAILURE, BROWSER_SSO_UNSUPPORTED_HINT, isSafeMintedKey, mintedKeyName, parseKeyExpireTime } from "../keys/mint-api-key.mjs";
import { warnInsecureUrlOverride } from "../system/url-override-warning.mjs";
import { link, openInBrowser } from "../ui/term.mjs";

/**
 * Web-app sign-in for `nexus login`, the way Claude Code signs in through
 * claude.ai: the browser opens the Nexus authorize page on the web app, the
 * user signs in there (or is already signed in), picks the account and
 * approves. The CLI redeems the one-time code, and the web app answers with
 * a new API key for this machine on that account. The CLI only ever holds a
 * PKCE verifier and the key; no password, session or identity-provider token
 * passes through it.
 *
 * Every key the CLI makes or deletes on a Nexus account goes through this
 * approval (an `action`): `signin` makes a key, `refresh` makes one and
 * deletes this machine's previous key (`key_id`), `revoke` only deletes
 * `key_id`. The web app checks the key belongs to the signed-in user; no API
 * key ever deletes a key.
 *
 * Contract:
 *   GET  {web}/nexus/cli/authorize?response_type=code&code_challenge&code_challenge_method=S256
 *        &state&redirect_uri&client=nexus-cli&host[&account_hint][&screen_hint=signup]
 *        [&action=refresh|revoke&key_id]   (version 3; absent action = signin)
 *        → redirects to {redirect_uri}?code&state (or ?error=access_denied&state).
 *          redirect_uri is the loopback listener, or (version 3) the exact
 *          string urn:ietf:wg:oauth:2.0:oob: then the web app never redirects;
 *          it shows the code and the user pastes it into the terminal
 *          (paste-the-code, for SSH/WSL where the browser can't reach this machine).
 *   POST {web}/api/v2/nexus/cli/token  {grant_type: "authorization_code", code, code_verifier, redirect_uri[, display_name]}
 *        → signin/refresh: 200 {api_key, key_id, display_name, parent[, expire_time][, previous_key_revoked][, confirm_deadline]}
 *          (parent = accounts/{account}/users/{user}, the account picked on the page;
 *          expire_time = RFC 3339 time the key stops working, 7 days out; a web
 *          app that predates key expiry omits it, and a malformed one is ignored;
 *          previous_key_revoked (refresh) = the key_id key is gone;
 *          confirm_deadline (refresh) = the old key stays until the CLI
 *          confirms it stored the new one, by this RFC 3339 time, else the
 *          server keeps the old key and deletes the new one)
 *   POST {web}/api/v2/nexus/cli/token  {grant_type: "confirm_refresh", code, code_verifier, redirect_uri, key_id}
 *        (refresh with confirm_deadline: the redeem's code, verifier and
 *        redirect; key_id = the new key) → 200 {previous_key_revoked}
 *          (true: the old key is deleted; false: both keys exist)
 *        → 4xx/5xx {error, error_description}: invalid_grant (refused, late,
 *          replayed or another key) | invalid_request | slow_down | temporarily_unavailable
 *        → revoke: 200 {revoked: true}
 *        → 4xx/5xx {error, error_description}: invalid_grant (bad/used code, PKCE or
 *          redirect mismatch, account needs SSO) | invalid_request | unsupported_grant_type
 *          | account_suspended (403) | key_limit_reached (403) | slow_down (429)
 *          | temporarily_unavailable (503)
 *          display_name must match ^[a-z0-9-]{1,64}$ (else the web app names it "nexus-cli").
 *   GET  {web}/api/v2/nexus/cli/token → 200 {version: 3}   (discovery probe; 2 = signin over loopback only)
 *
 * When the browser lands on the callback, its request is held open until the
 * key exists and then redirected to {web}/nexus/cli/success?host (or
 * ?error=<code>&host on failure), plus &action=refresh|revoke for those
 * approvals so the page says what happened (sign-in omits it; an older page
 * ignores it). No code, verifier, token, key or key id ever goes into that URL.
 *
 * This is the only browser sign-in for developer accounts (enterprise SSO is
 * `nexus login --account`). NEXUS_WEB_AUTH=on skips the probe (development
 * against a local web app), off turns browser sign-in off, auto probes.
 */
export const WEB_APP_URL = (process.env.NEXUS_WEB_APP_URL?.trim() || "https://app.fireworks.ai").replace(/\/+$/, "");

const CALLBACK_PORT = 18000;
/** The forward an SSH user needs, run on their own computer. */
const portForwardHint = (port) => `ssh -L ${port}:localhost:${port} <this machine>`;
/** The same forward as a ~/.ssh/config line, for people who reconnect often. */
const portForwardConfig = (port) => `LocalForward ${port} localhost:${port}`;
/** Paste-the-code is phishable, so its prompt says whose code to paste. */
const PASTE_WARNING = "Only paste a code from a browser you are using right now. Never paste a code someone sent you.";
const WEB_CALLBACK_PATH = "/callback";
/**
 * The default loopback redirect. The web app and control plane accept
 * http://localhost:<port>/callback (or 127.0.0.1) for any port from 1024 to
 * 65535; the canonical policy, with OOB_REDIRECT_URI, is
 * test/fixtures/nexus-cli-redirect-uris.json (version 2).
 */
export const WEB_CALLBACK_URI = `http://localhost:${CALLBACK_PORT}${WEB_CALLBACK_PATH}`;
/** Paste-the-code: the web app shows the code instead of redirecting. Exact string. */
export const OOB_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";
/**
 * When 18000 is taken and the browser is on this machine, the sign-in
 * listens on a random port in this range instead (the redirect policy, v2,
 * allows any loopback port from 1024), retried a few times if that's taken too.
 */
const FALLBACK_PORT_MIN = 49152;
const FALLBACK_PORT_MAX = 65535;
const FALLBACK_PORT_ATTEMPTS = 5;
/** The listener's port: 18000, unless NEXUS_WEB_CALLBACK_PORT (tests) says otherwise. */
export const webCallbackPort = (env = process.env) => {
  const port = Number(env.NEXUS_WEB_CALLBACK_PORT);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : CALLBACK_PORT;
};
/**
 * Whether a sign-in on `port` may fall back to a random port: only on the
 * default 18000, never when NEXUS_WEB_CALLBACK_PORT pins it (tests).
 */
export const defaultPortFallback = (port, env = process.env) => port === CALLBACK_PORT && !String(env.NEXUS_WEB_CALLBACK_PORT ?? "").trim();
/** The redirect_uri sent to the authorize page and the redeem for a listener on `port`. */
export const webCallbackUri = (port) => (port === CALLBACK_PORT ? WEB_CALLBACK_URI : `http://localhost:${port}${WEB_CALLBACK_PATH}`);
const AUTHORIZE_PATH = "/nexus/cli/authorize";
const TOKEN_PATH = "/api/v2/nexus/cli/token";
/** The token route's contract version this CLI speaks: 3 adds actions and paste-the-code. */
export const PROTOCOL_VERSION = 3;
/** The oldest version browser sign-in works with: signin over loopback only. */
const MIN_PROTOCOL_VERSION = 2;
/** The version that has refresh/revoke actions and the oob redirect. */
export const KEY_ACTIONS_VERSION = 3;
/** @typedef {"signin" | "refresh" | "revoke"} WebAction */
const PROBE_TIMEOUT_MS = 2_000;
const EXCHANGE_TIMEOUT_MS = 15_000;
// The whole answer to the browser, exchange and storing included. Storing can
// wait on a keychain prompt, so this is generous; past it the browser and the
// terminal both get an answer instead of waiting forever.
const COMPLETE_TIMEOUT_MS = 120_000;
const CALLBACK_TIMEOUT_MS = 300_000;
/** Codes pasted for one paste-the-code run (each after a fresh approval). */
const PASTE_ATTEMPTS = 3;
/**
 * A pasted code the web app refused (invalid_grant). Its PKCE verifier lives
 * only in the terminal that opened the URL, so a code approved from another
 * terminal's URL (or someone else's) never redeems here; the web app answers
 * the same for an expired or used code, so the line covers all three.
 */
export const PASTED_CODE_REFUSED = "That code wasn't issued for this terminal, or it expired.";

/**
 * @typedef {Object} WebSignInResult
 * @property {boolean} ok
 * @property {string} key        This machine's fw_ key ("" on failure).
 * @property {string} keyId      Key id, for `nexus logout` revocation.
 * @property {string} userName   accounts/{account}/users/{user} the key belongs to.
 * @property {string} accountId
 * @property {string} email      Not part of the token response; "" (the key's verify fills it in).
 * @property {boolean} reused    True when the key already on this machine was kept.
 * @property {string[]} notes    Extra lines for the terminal (old key left in place, …).
 * @property {string} failure    One-line reason for the terminal ("" when ok).
 * @property {boolean} fatal     True when retrying another flow won't help (user cancelled).
 * @property {string} error      Error code for the success page and --json ("" when ok).
 * @property {string} [expiresAt] ISO time the kept key expires, when known.
 * @property {() => Promise<RefreshConfirmation>} [confirmRefresh] refresh with
 *   a confirm deadline: call once the new key is stored, to have the server
 *   delete the old key. Holds the code and verifier in memory only.
 */

/**
 * @typedef {Object} RefreshConfirmation
 * @property {boolean} ok            The server accepted the confirm.
 * @property {boolean} targetRevoked The old key is deleted (false: both keys exist).
 * @property {string} failure        One-line reason ("" when ok).
 * @property {string} error          Error code ("" when ok).
 * @property {boolean} [indeterminate] Not ok, and whether the server confirmed
 *   is unknown: the request may have landed (network error or timeout after
 *   sending, a 5xx, or an unreadable 200). The old key's state tells.
 */

/**
 * The key the web app made for this sign-in.
 * @typedef {Object} RedeemedKey
 * @property {boolean} ok
 * @property {string} key
 * @property {string} keyId
 * @property {string} parent     accounts/{account}/users/{user}
 * @property {string} accountId
 * @property {string} [expiresAt] ISO time the key expires, when the web app said.
 * @property {boolean} [previousKeyRevoked] refresh only: the web app deleted the key it replaces.
 * @property {string} [confirmDeadline] refresh only: ISO time by which the CLI must confirm.
 * @property {string} failure
 * @property {string} error
 */

/**
 * Turns the redeemed key into the one this machine keeps, with notes for the
 * terminal (a previous key left active, …). Never deletes a key.
 * @typedef {(redeemed: RedeemedKey) => Promise<{ key: string, keyId: string, displayName?: string, expiresAt?: string, reused?: boolean, notes?: string[] }>} SettleKey
 */

const failed = (failure, fatal = false, error = "server_error") => ({
  ok: false, key: "", keyId: "", userName: "", accountId: "", email: "", reused: false, notes: [], failure, fatal, error,
});

/** Error codes the success page knows how to explain; anything else shows as server_error. */
const PAGE_ERRORS = new Set(["access_denied", "invalid_grant", "no_account", "account_suspended", "key_limit_reached", "slow_down", "temporarily_unavailable"]);

const PARENT_PATTERN = /^accounts\/([^/]+)\/users\/[^/]+$/;

/**
 * The name the web pages show for this machine: the macOS Computer Name
 * ("Sam's MacBook Pro") when available, else the short hostname. Asynchronous,
 * so a slow scutil doesn't block the event loop (it's bounded at 1s).
 * @param {{ platform?: NodeJS.Platform, run?: (cmd: string, args: string[]) => string | Promise<string> }} [options]
 * @returns {Promise<string>}
 */
export async function computerName({
  platform = process.platform,
  run = (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", timeout: 1000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  }),
} = {}) {
  if (platform === "darwin") {
    try {
      const name = String(await run("scutil", ["--get", "ComputerName"])).trim();
      if (name) {
        return name;
      }
    } catch {
      // Fall through to the hostname.
    }
  }
  return os.hostname().split(".")[0];
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"on" | "off" | "auto"}
 */
export function webAuthMode(env = process.env) {
  const value = String(env.NEXUS_WEB_AUTH ?? "").trim().toLowerCase();
  if (["on", "1", "true"].includes(value)) {
    return "on";
  }
  if (["off", "0", "false"].includes(value)) {
    return "off";
  }
  return "auto";
}

/**
 * The CLI token endpoint's contract version (2 or more), or 0 when the web
 * app doesn't serve it. Bounded by a short timeout; any failure (offline,
 * 404, unexpected body) means 0.
 * @param {{ baseUrl?: string, timeoutMs?: number }} [options]
 * @returns {Promise<number>}
 */
export async function probeWebAuthorizeVersion({ baseUrl = WEB_APP_URL, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const response = await fetch(`${baseUrl}${TOKEN_PATH}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return 0;
    }
    const body = await response.json().catch(() => null);
    const version = body?.version;
    // Only versions this CLI speaks: a newer, incompatible contract falls back like a missing probe.
    return Number.isInteger(version) && version >= MIN_PROTOCOL_VERSION && version <= PROTOCOL_VERSION ? version : 0;
  } catch {
    return 0;
  }
}

/**
 * The web app's contract version for this run: 0 when browser sign-in is off
 * or unavailable. NEXUS_WEB_AUTH=on assumes the current version without a
 * probe; `auto` stays 0 under NEXUS_TEST so specs never probe the real web app.
 * @param {{ env?: NodeJS.ProcessEnv, probe?: () => Promise<number> }} [options]
 * @returns {Promise<number>}
 */
export async function webAuthorizeVersion({ env = process.env, probe = probeWebAuthorizeVersion } = {}) {
  const mode = webAuthMode(env);
  if (mode !== "auto") {
    return mode === "on" ? PROTOCOL_VERSION : 0;
  }
  if (env.NEXUS_TEST === "1") {
    return 0;
  }
  return probe();
}

/**
 * Whether to use paste-the-code (the oob redirect) instead of the loopback
 * callback: only when asked for with `--paste-code` (`flag` "on"). It's an
 * opt-in fallback, never automatic: a code shown in a browser can be phished
 * (someone sends the approval link and asks for the code back, and PKCE
 * doesn't help because they hold the verifier). Over SSH the default is the
 * loopback through a forwarded port. A web app older than version 3 has no
 * oob redirect.
 * @param {{ flag?: string, version?: number }} [options]
 */
export function usePasteCode({ flag = "", version = PROTOCOL_VERSION } = {}) {
  return flag === "on" && version >= KEY_ACTIONS_VERSION;
}

/**
 * @param {number} status @param {Record<string, unknown>} body @param {string} baseUrl @param {WebAction} [action]
 * @returns {RedeemedKey}
 */
function exchangeFailure(status, body, baseUrl, action = "signin") {
  const error = typeof body?.error === "string" ? body.error : "";
  if (error === "invalid_grant") {
    if (action === "revoke") {
      return redeemFailed("The approval code expired, was already used or didn't match. Try again.", error);
    }
    // Also what an account that must sign in with SSO gets.
    return redeemFailed("The sign-in code expired or was already used. Run nexus login to try again "
      + "(teams that sign in with custom SSO: nexus login --account <account-id>).", error);
  }
  if (error === "invalid_request" || error === "unsupported_grant_type") {
    return redeemFailed(`The web app didn't accept this version of Nexus's sign-in request (${error}). Run nexus update, then nexus login.`, "server_error");
  }
  if (error === "no_account") {
    return redeemFailed(BROWSER_SIGNIN_NO_ACCOUNT_FAILURE, error);
  }
  if (error === "key_limit_reached") {
    // The code isn't spent: deleting a key and approving again works.
    return redeemFailed(`Your Fireworks account has reached its API key limit. Delete an API key at ${keysUrlFor("nexus")}, then sign in again.`, error);
  }
  if (error === "account_suspended") {
    return redeemFailed(`Your Fireworks account is suspended. Add credits at ${baseUrl}/account/billing, then run nexus login again.`, error);
  }
  if (error === "slow_down" || status === 429) {
    return redeemFailed("Too many sign-in attempts. Wait a minute and try again.", "slow_down");
  }
  if (error === "temporarily_unavailable" || status === 503) {
    return redeemFailed("Browser sign-in isn't available right now. Try again in a moment.", "temporarily_unavailable");
  }
  return redeemFailed(`The web app rejected the sign-in (${error || `HTTP ${status}`}).`, PAGE_ERRORS.has(error) ? error : "server_error");
}

/** @returns {RedeemedKey} */
function redeemFailed(failure, error = "server_error") {
  return { ok: false, key: "", keyId: "", parent: "", accountId: "", failure, error };
}

/**
 * POST the code (+ PKCE verifier) to the token route.
 * @returns {Promise<{ response: Response, body: Record<string, unknown> } | { failed: RedeemedKey }>}
 */
async function postCode({ baseUrl, code, verifier, redirectUri, keyName, timeoutMs }) {
  try {
    const response = await fetch(`${baseUrl}${TOKEN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        ...(keyName ? { display_name: keyName } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    return { response, body: body && typeof body === "object" ? body : {} };
  } catch (error) {
    return {
      failed: redeemFailed(error?.name === "TimeoutError"
        ? "Timed out finishing the sign-in. Try again."
        : `Couldn't reach the sign-in service (${error?.message ?? "network error"}).`, "network"),
    };
  }
}

/**
 * Trade the one-time code (+ PKCE verifier) for this machine's new key
 * (action signin or refresh).
 * @param {{ baseUrl: string, code: string, verifier: string, redirectUri: string, keyName: string, timeoutMs?: number }} options
 * @returns {Promise<RedeemedKey>}
 */
export async function exchangeWebCode({ baseUrl, code, verifier, redirectUri, keyName, timeoutMs = EXCHANGE_TIMEOUT_MS }) {
  const posted = await postCode({ baseUrl, code, verifier, redirectUri, keyName, timeoutMs });
  if ("failed" in posted) {
    return posted.failed;
  }
  const { response, body } = posted;
  if (!response.ok) {
    return exchangeFailure(response.status, body, baseUrl);
  }
  const text = (value) => (typeof value === "string" ? value : "");
  const key = text(body?.api_key);
  const keyId = text(body?.key_id);
  const parent = text(body?.parent);
  const accountId = PARENT_PATTERN.exec(parent)?.[1] ?? "";
  // Same bar as a key minted here: it gets written into harness configs.
  if (!isSafeMintedKey(key) || !keyId || !accountId) {
    // The server may still have made a key. No API key deletes a key, so
    // say which one to revoke, so retries don't pile keys up toward the
    // account's limit. The key itself is never printed.
    const cleanup = key ? ` Revoke the API key ${keyName} at ${link(keysUrlFor("nexus"))}.` : "";
    return redeemFailed(`The sign-in service returned an unexpected response.${cleanup}`);
  }
  const expiresAt = parseKeyExpireTime(body?.expire_time);
  // A refresh that waits for the CLI's confirm hasn't deleted anything yet,
  // so its "revoked: false" isn't news; the confirm says what happened.
  const confirmDeadline = parseKeyExpireTime(body?.confirm_deadline);
  return {
    ok: true, key, keyId, parent, accountId,
    ...(expiresAt ? { expiresAt } : {}),
    ...(confirmDeadline ? { confirmDeadline }
      : typeof body?.previous_key_revoked === "boolean" ? { previousKeyRevoked: body.previous_key_revoked } : {}),
    failure: "", error: "",
  };
}

/**
 * Confirm a refresh after the new key `keyId` is stored here, so the server
 * deletes the key it replaces. Authenticated by the same code and verifier
 * as the redeem, never an API key. Past `deadline` it isn't sent (the server
 * has already rolled the refresh back). Never throws.
 * @param {{ baseUrl: string, code: string, verifier: string, redirectUri: string, keyId: string, deadline: string, timeoutMs?: number, now?: number }} options
 * @returns {Promise<RefreshConfirmation>}
 */
export async function confirmWebRefresh({ baseUrl, code, verifier, redirectUri, keyId, deadline, timeoutMs = EXCHANGE_TIMEOUT_MS, now = Date.now() }) {
  const refused = (failure, error) => ({ ok: false, targetRevoked: false, failure, error });
  // The request may have been processed: the caller checks the old key.
  const unknown = (failure, error) => ({ ...refused(failure, error), indeterminate: true });
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= now) {
    return refused("the confirmation window passed", "confirm_expired");
  }
  let response;
  let body;
  try {
    response = await fetch(`${baseUrl}${TOKEN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grant_type: "confirm_refresh", code, code_verifier: verifier, redirect_uri: redirectUri, key_id: keyId }),
      // Never past the deadline: a late confirm is refused anyway.
      signal: AbortSignal.timeout(Math.min(timeoutMs, deadlineMs - now)),
    });
    body = await response.json().catch(() => ({}));
  } catch (error) {
    return unknown(error?.name === "TimeoutError"
      ? "confirming timed out"
      : `couldn't reach the sign-in service (${error?.message ?? "network error"})`, "network");
  }
  if (!response.ok) {
    const error = typeof body?.error === "string" && body.error ? body.error : `http_${response.status}`;
    // A 4xx is a definite refusal (nothing was confirmed); a 5xx may have
    // failed after the confirm committed.
    return (response.status >= 500 ? unknown : refused)(`the sign-in service refused the confirmation (${error})`, error);
  }
  if (typeof body?.previous_key_revoked !== "boolean") {
    return unknown("the sign-in service returned an unexpected response", "server_error");
  }
  return { ok: true, targetRevoked: body.previous_key_revoked, failure: "", error: "" };
}

/**
 * Redeem a revoke code: the web app deletes the key the code was approved
 * for (one already gone counts as deleted) and makes none.
 * @param {{ baseUrl: string, code: string, verifier: string, redirectUri: string, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, failure: string, error: string }>}
 */
export async function exchangeRevokeCode({ baseUrl, code, verifier, redirectUri, timeoutMs = EXCHANGE_TIMEOUT_MS }) {
  const posted = await postCode({ baseUrl, code, verifier, redirectUri, keyName: "", timeoutMs });
  if ("failed" in posted) {
    return { ok: false, failure: posted.failed.failure, error: posted.failed.error };
  }
  const { response, body } = posted;
  if (!response.ok) {
    const { failure, error } = exchangeFailure(response.status, body, baseUrl, "revoke");
    return { ok: false, failure, error };
  }
  if (body.revoked !== true) {
    return { ok: false, failure: "The sign-in service returned an unexpected response.", error: "server_error" };
  }
  return { ok: true, failure: "", error: "" };
}

/**
 * Redeem the code and settle which key this machine keeps. The redeem is
 * bounded by its own timeout and `settle` by its calls', so the whole thing
 * is too.
 * @param {{ baseUrl: string, code: string, verifier: string, redirectUri: string, keyName: string, settle: SettleKey, exchangeTimeoutMs: number }} options
 * @returns {Promise<WebSignInResult>}
 */
async function redeemForKey({ baseUrl, code, verifier, redirectUri, keyName, settle, exchangeTimeoutMs }) {
  const redeemed = await exchangeWebCode({ baseUrl, code, verifier, redirectUri, keyName, timeoutMs: exchangeTimeoutMs });
  if (!redeemed.ok) {
    return failed(redeemed.failure, false, redeemed.error);
  }
  let kept;
  try {
    kept = await settle(redeemed);
  } catch {
    // The new key exists either way: keep it rather than lose it.
    kept = { key: redeemed.key, keyId: redeemed.keyId, ...(redeemed.expiresAt ? { expiresAt: redeemed.expiresAt } : {}) };
  }
  return {
    ok: true,
    key: kept.key,
    keyId: kept.keyId,
    userName: redeemed.parent,
    accountId: redeemed.accountId,
    email: "",
    displayName: kept.displayName || "",
    reused: Boolean(kept.reused),
    ...(kept.expiresAt ? { expiresAt: kept.expiresAt } : {}),
    ...(redeemed.confirmDeadline ? {
      confirmRefresh: () => confirmWebRefresh({ baseUrl, code, verifier, redirectUri, keyId: redeemed.keyId, deadline: redeemed.confirmDeadline, timeoutMs: exchangeTimeoutMs }),
    } : {}),
    notes: kept.notes ?? [],
    ...(kept.previousKey ? { previousKey: kept.previousKey } : {}),
    failure: "",
    fatal: false,
    error: "",
  };
}

/**
 * Read the code the web app shows (paste-the-code) from the terminal. The
 * prompt goes to stderr, so `--json` stdout stays NDJSON. Resolves "" on
 * Ctrl-C, EOF or timeout.
 * @param {string} question @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string>}
 */
export async function readPastedCode(question, { timeoutMs = CALLBACK_TIMEOUT_MS } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: Boolean(process.stdin.isTTY) });
  const signal = AbortSignal.timeout(timeoutMs);
  const closed = new Promise((resolve) => rl.once("close", () => resolve("")));
  try {
    return String(await Promise.race([rl.question(question, { signal }), closed]) ?? "").trim();
  } catch {
    return "";
  } finally {
    rl.close();
  }
}

/** Whether this run has printed the NEXUS_KEYS_URL note. */
let keysUrlNoted = false;

/** Tests only: let the next sign-in print the NEXUS_KEYS_URL note again. */
export function resetKeysUrlNoteForTests() {
  keysUrlNoted = false;
}

/**
 * The browser half every action shares: send the user to the authorize page
 * for `action`, get the one-time code back (loopback callback, or pasted with
 * `pasteCode`), and run `redeem` on it. On the loopback, `redeem` and
 * `finish` run while the browser's request is held open, so its page says
 * "done" only once they have. Without a terminal (`interactive` false), a
 * browser that can't be opened ends it at once (error "no_browser"): nobody
 * would see the URL. With paste-the-code, a code the web app refuses as
 * invalid_grant gets a fresh approval and another paste, never a fallback.
 * @template {{ ok: boolean, failure: string, fatal?: boolean, error: string }} R
 * @param {{
 *   action: WebAction, keyId: string, accountHint: string, signup: boolean,
 *   redeem: (code: string, verifier: string, redirectUri: string) => Promise<R>,
 *   fail: (failure: string, fatal: boolean, error: string) => R,
 *   finish: ((result: R) => Promise<{ ok: boolean }>) | null,
 *   onStatus: (line: string) => void, onEvent: (event: Record<string, string>) => void,
 *   openBrowser: boolean, noOpen: boolean, open: (url: string) => Promise<boolean>,
 *   pasteCode: boolean, interactive: boolean, readCode: typeof readPastedCode,
 *   baseUrl: string, host: string, port: number, timeoutMs: number, completeTimeoutMs: number,
 *   portFallback?: boolean,
 * }} options
 *
 * `portFallback`: when `port` (18000) is taken, listen on a random free port
 * instead. Only for a browser on this machine (never over SSH/WSL, where the
 * user forwards 18000 by name) and never with paste-the-code (no listener).
 * Nothing is shown or opened before a port binds, so a retry is invisible
 * apart from one status line.
 * @returns {Promise<R>}
 */
async function authorizeOnWebApp(options) {
  warnInsecureUrlOverride(options.baseUrl, "NEXUS_WEB_APP_URL");
  const keysNote = keysUrlNoted ? "" : keysUrlOverrideNote(options.baseUrl, process.env.NEXUS_KEYS_URL);
  if (keysNote) {
    keysUrlNoted = true;
    console.warn(keysNote);
  }
  const first = await authorizeOnPort(options);
  if (first.error !== "port_in_use" || !options.portFallback || !options.openBrowser || options.pasteCode) {
    return first;
  }
  let result = first;
  for (let attempt = 0; attempt < FALLBACK_PORT_ATTEMPTS; attempt += 1) {
    const port = randomInt(FALLBACK_PORT_MIN, FALLBACK_PORT_MAX + 1);
    if (attempt === 0) {
      options.onStatus(`Port ${options.port} is in use, so this sign-in uses port ${port} instead.`);
    }
    result = await authorizeOnPort({ ...options, port });
    if (result.error !== "port_in_use") {
      return result;
    }
  }
  return result;
}

/** authorizeOnWebApp on one port. @returns {Promise<any>} */
async function authorizeOnPort({
  action, keyId, accountHint, signup, redeem, fail, finish,
  onStatus, onEvent, openBrowser, noOpen, open, pasteCode, interactive, readCode,
  baseUrl, host, port, timeoutMs, completeTimeoutMs,
}) {
  host ??= await computerName();
  const redirectUri = pasteCode ? OOB_REDIRECT_URI : webCallbackUri(port);
  // Each approval gets its own verifier: a code is bound to the challenge of
  // the URL it was approved from.
  const authorization = () => {
    const { verifier, challenge, state } = pkcePair();
    const url = `${baseUrl}${AUTHORIZE_PATH}?` + new URLSearchParams({
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      redirect_uri: redirectUri,
      client: "nexus-cli",
      host,
      ...(signup && action === "signin" ? { screen_hint: "signup" } : {}),
      ...(accountHint ? { account_hint: accountHint } : {}),
      ...(action !== "signin" ? { action, key_id: keyId } : {}),
    }).toString();
    return { verifier, state, url };
  };
  const first = authorization();
  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // An event sink must never break the sign-in.
    }
  };
  const announce = (url) => emit({ type: "authorize_url", url, expiresAt: new Date(Date.now() + timeoutMs).toISOString() });
  const what = action === "revoke" ? "approve revoking this machine's API key" : "sign in";
  const run = async (code, verifier) => {
    emit({ type: "exchanging" });
    try {
      return await redeem(code, verifier, redirectUri);
    } catch {
      return fail("Sign-in failed unexpectedly. Try again.", false, "server_error");
    }
  };
  // `contested` goes to `finish` so storing stays contest-aware for its whole
  // transaction: a second browser loading the page before or while the key
  // is stored makes `finish` put the previous credential back.
  const store = async (result, contested = () => false) => {
    if (!result.ok || !finish) return true;
    const stored = await finish(result, { contested }).catch(() => ({ ok: false }));
    return Boolean(stored?.ok);
  };

  if (pasteCode) {
    if (!interactive) {
      return fail("Pasting the code from the browser needs an interactive terminal. "
        + `Run this in a terminal, or forward the sign-in port (${portForwardHint(port)}) and run without --paste-code.`, false, "paste_needs_tty");
    }
    let current = first;
    announce(current.url);
    emit({ type: "waiting" });
    onStatus(`Open this URL in a browser on any computer to ${what}:\n  ${link(current.url)}`);
    onStatus("After you approve, the page shows a code. Paste it here, and never share it with anyone.");
    onStatus(PASTE_WARNING);
    onStatus(`(Forwarding the sign-in port is safer: reconnect with ${portForwardHint(port)} and run again without --paste-code.)`);
    let question = "  Paste the code shown in your browser: ";
    for (let attempt = 1; ; attempt += 1) {
      const code = String(await readCode(question, { timeoutMs }).catch(() => "") ?? "").trim();
      if (!code) {
        return fail("No code was pasted, so nothing changed.", true, "access_denied");
      }
      const result = await run(code, current.verifier);
      if (result.ok || result.error !== "invalid_grant") {
        await store(result);
        return result;
      }
      // Not this terminal's code (or expired, or used): the API-key paste
      // wouldn't help, a fresh approval from this terminal's URL does. An
      // account that must sign in with SSO gets invalid_grant too, so a
      // sign-in's messages keep the SSO hint that exchangeFailure gives.
      const ssoHint = action === "revoke" ? "" : ` ${BROWSER_SSO_UNSUPPORTED_HINT}`;
      if (attempt >= PASTE_ATTEMPTS) {
        return fail(`${PASTED_CODE_REFUSED}${ssoHint}`, true, "invalid_grant");
      }
      current = authorization();
      announce(current.url);
      onStatus(`Open this URL in a browser on any computer to ${what}:\n  ${link(current.url)}`);
      onStatus(`${PASTED_CODE_REFUSED} Approve again from the URL above and paste the new code.${ssoHint}`);
      question = "  Paste the new code (or press Enter to stop): ";
    }
  }

  // The action only (never the key id): the page words "signed in" vs
  // "key replaced" vs "key revoked" from it.
  const successPage = (error) => `${baseUrl}/nexus/cli/success?`
    + new URLSearchParams({
      ...(error ? { error: PAGE_ERRORS.has(error) ? error : "server_error" } : {}),
      host,
      ...(action === "signin" ? {} : { action }),
    }).toString();
  // Runs while the browser's callback request is held open; its redirect is
  // the browser's answer, so the page only says "done" once the key exists
  // (or is deleted). Every step inside is bounded by its own timeout, and the
  // whole answer by completeTimeoutMs.
  // The answer still running when the deadline answered the browser: the
  // terminal waits for it (storing, or a refresh's rollback) instead of
  // leaving it detached from the command.
  let pending = null;
  const complete = (outcome, guard = {}) => {
    let timer;
    const answered = answer(outcome, guard);
    pending = answered;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve({
        redirect: successPage("server_error"),
        late: true,
        result: fail(
          action === "revoke"
            ? "Finishing the revoke took too long. Check the API keys page to see whether the key is gone."
            : "Finishing the sign-in took too long. Run nexus status to see whether a key was saved.",
          // Fatal: the store may still finish, so don't start key paste on top of it.
          true,
          "server_error",
        ),
      }), completeTimeoutMs);
      timer.unref?.();
    });
    return Promise.race([answered, deadline]).finally(() => clearTimeout(timer))
      .then((done) => (done.late ? { redirect: done.redirect, result: { ...done.result, late: true } } : done));
  };
  const answer = async (outcome, { contested = () => false } = {}) => {
    // A second browser loaded the local page: whose code this is can't be
    // told, so it's neither redeemed nor, if already redeemed, stored here.
    const stopped = () => fail(PAGE_REUSED_FAILURE, true, "contested");
    if (contested()) {
      return { redirect: successPage("access_denied"), result: stopped() };
    }
    const result = outcome.code
      ? await run(outcome.code, first.verifier)
      : fail(outcome.failure, outcome.fatal, outcome.fatal ? "access_denied" : "server_error");
    if (contested()) {
      return { redirect: successPage("access_denied"), result: stopped() };
    }
    if (!(await store(result, contested))) {
      return contested()
        ? { redirect: successPage("access_denied"), result: stopped() }
        : { redirect: successPage("server_error"), result };
    }
    return { redirect: successPage(result.ok ? "" : result.error), result };
  };

  // Opening the browser can return after the approval has already landed
  // (the authorize_url event is out before it): once the flow has settled,
  // its late status lines are dropped, so they never follow a --json result.
  let settled = false;
  const result = await waitForCallback(first.url, first.state, async (url, stop) => {
    announce(url);
    emit({ type: "waiting" });
    if (noOpen) {
      onStatus(`Waiting for the approval at:\n  ${link(url)}`);
      return;
    }
    if (!openBrowser) {
      onStatus(`Open this URL in a browser to ${what}:\n  ${link(url)}`);
      onStatus(`Over SSH, the browser on your own computer reaches this machine through a forwarded port. If this session doesn't forward it, reconnect with:  ${portForwardHint(port)}`);
      onStatus(`  (or add  ${portForwardConfig(port)}  to this host in ~/.ssh/config), then open the URL above.`);
      onStatus(`Can't forward the port? Run with --paste-code to paste a code instead. ${PASTE_WARNING}`);
      return;
    }
    const opened = await open(url);
    if (settled) {
      return;
    }
    if (opened) {
      onStatus(`Opened your browser — ${action === "revoke" ? "approve revoking the key" : "approve the sign-in"} there.`);
      onStatus(`If nothing opened, go to:\n  ${link(url)}`);
      return;
    }
    if (!interactive) {
      // No browser opened and no terminal to show the URL to (CI, a script):
      // nobody can approve, so don't wait out the timeout. The desktop app
      // runs here without a terminal too, but its browser opens.
      stop({
        code: "",
        failure: action === "revoke"
          ? "couldn't open a browser here to approve it, and there's no terminal to show the URL in"
          : "Couldn't open a browser here, and there's no terminal to show the sign-in URL in. "
            + "Run nexus login in a terminal, or pass --no-open and open the authorize_url yourself.",
        fatal: false,
        reason: "no_browser",
      });
      return;
    }
    onStatus(`Couldn't open a browser here. To ${what}, open this URL in a browser on this machine:\n  ${link(url)}`);
  // The URL handed to the browser opener can be read by other users on a
  // shared machine, so it's a one-time local page owned by the first browser
  // that opens it (the same guard as the Cognito sign-in page); it redirects
  // to the web app. A second browser loading it stops the sign-in, and the
  // callback only counts with that page's cookie, so a local user who
  // approved with their own account can't land a code here.
  }, { timeoutMs, port, path: WEB_CALLBACK_PATH, complete, signInPage: true, pageRedirect: true });
  settled = true;
  if (!result.late && pending && "code" in result && !result.code) {
    // The listener stopped (the page was contested) while an answer was in
    // flight: wait for it, so a store it started is rolled back before the
    // command returns, then report the stop.
    let graceTimer;
    const grace = new Promise((resolve) => {
      graceTimer = setTimeout(resolve, completeTimeoutMs);
      graceTimer.unref?.();
    });
    await Promise.race([pending.catch(() => null), grace]).finally(() => clearTimeout(graceTimer));
  }
  if (result.late && pending) {
    // The browser was told it took too long; give the work one more deadline
    // to finish here, so a refresh's rollback isn't cut off, then report
    // what actually happened.
    onStatus("Still finishing on this machine…");
    let graceTimer;
    const grace = new Promise((resolve) => {
      graceTimer = setTimeout(() => resolve(null), completeTimeoutMs);
      graceTimer.unref?.();
    });
    const settled = await Promise.race([pending.then((done) => done.result, () => null), grace])
      .finally(() => clearTimeout(graceTimer));
    const { late: _late, ...timedOut } = result;
    return settled ?? timedOut;
  }
  // No browser outcome at all (listener timeout, port in use, no browser): pass it through.
  return "error" in result && typeof result.ok === "boolean"
    ? result
    : fail(result.failure, result.fatal, result.reason ?? (result.fatal ? "access_denied" : "no_callback"));
}

/**
 * Sign in through the web app: `action` signin makes a key on the account
 * picked on the page; refresh (version 3) makes one on `accountHint`'s
 * account and deletes this machine's previous key `keyId` (the response's
 * `previousKeyRevoked` says whether that worked). The code comes back to this
 * machine's localhost:18000/callback, or with `pasteCode` (version 3) the web
 * app shows it and the user pastes it here. On SSH/WSL without paste-the-code
 * (`openBrowser: false`) the CLI prints the URL, and the browser on the user's
 * own computer reaches the listener through a forwarded port (or WSL's
 * localhost forwarding). The listener is on 18000; when that's taken and
 * the browser is on this machine, it falls back to a random free port (see
 * authorizeOnWebApp's `portFallback`). `port` pins it (tests).
 *
 * `onEvent` gets machine-readable progress for `nexus login --json`:
 * {type: "authorize_url", url, expiresAt}, {type: "waiting"}, {type: "exchanging"}.
 * `noOpen` leaves opening the URL to whoever reads those events.
 * `settle` turns the redeemed key into the one this machine keeps (notes).
 * `finish`, when given, stores the key while the browser waits; the browser
 * is told "signed in" only if it returns ok, and its outcome is the caller's
 * to report.
 * @param {{ onStatus?: (line: string) => void, onEvent?: (event: Record<string, string>) => void, openBrowser?: boolean, noOpen?: boolean, signup?: boolean, selectAccount?: string, action?: "signin" | "refresh", keyId?: string, accountHint?: string, pasteCode?: boolean, interactive?: boolean, readCode?: typeof readPastedCode, open?: (url: string) => Promise<boolean>, baseUrl?: string, keyName?: string, settle?: SettleKey, finish?: (result: WebSignInResult) => Promise<{ ok: boolean }>, host?: string, port?: number, portFallback?: boolean, timeoutMs?: number, exchangeTimeoutMs?: number, completeTimeoutMs?: number }} [options]
 * @returns {Promise<WebSignInResult>}
 */
export async function signInViaWebApp({
  onStatus = () => {},
  onEvent = () => {},
  openBrowser = !isRemoteContext(),
  noOpen = false,
  signup = false,
  selectAccount = "",
  action = "signin",
  keyId = "",
  accountHint = "",
  pasteCode = false,
  interactive = Boolean(process.stdin.isTTY),
  readCode = readPastedCode,
  open = openInBrowser,
  baseUrl = WEB_APP_URL,
  keyName = mintedKeyName(),
  settle = async (redeemed) => ({ key: redeemed.key, keyId: redeemed.keyId, ...(redeemed.expiresAt ? { expiresAt: redeemed.expiresAt } : {}) }),
  finish = null,
  host = undefined,
  port = webCallbackPort(),
  portFallback = defaultPortFallback(port),
  timeoutMs = CALLBACK_TIMEOUT_MS,
  exchangeTimeoutMs = EXCHANGE_TIMEOUT_MS,
  completeTimeoutMs = COMPLETE_TIMEOUT_MS,
} = {}) {
  const refresh = action === "refresh" && Boolean(keyId);
  return authorizeOnWebApp({
    action: refresh ? "refresh" : "signin",
    keyId: refresh ? keyId : "",
    // A refresh stays on the key's account.
    accountHint: (refresh ? accountHint : "") || selectAccount,
    signup,
    redeem: (code, verifier, redirectUri) => redeemForKey({ baseUrl, code, verifier, redirectUri, keyName, settle, exchangeTimeoutMs }),
    fail: (failure, fatal, error) => failed(failure, fatal, error),
    finish,
    onStatus, onEvent, openBrowser, noOpen, open, pasteCode, interactive, readCode,
    baseUrl, host, port, timeoutMs, completeTimeoutMs, portFallback,
  });
}

/**
 * @typedef {Object} WebRevokeResult
 * @property {boolean} ok        True when the key is deleted (or was already gone).
 * @property {string} failure    One-line reason ("" when ok).
 * @property {boolean} fatal     True when the user cancelled.
 * @property {string} error      Error code ("" when ok).
 */

/**
 * Revoke key `keyId` (on `accountHint`'s account) through the web app
 * (version 3): the user approves in the browser, and the redeem deletes the
 * key server-side. Nothing here authenticates with an API key. Same code
 * transport as signInViaWebApp (loopback, or `pasteCode`).
 * @param {{ keyId: string, accountHint?: string, onStatus?: (line: string) => void, openBrowser?: boolean, noOpen?: boolean, pasteCode?: boolean, interactive?: boolean, readCode?: typeof readPastedCode, open?: (url: string) => Promise<boolean>, baseUrl?: string, host?: string, port?: number, portFallback?: boolean, timeoutMs?: number, exchangeTimeoutMs?: number, completeTimeoutMs?: number, onEvent?: (event: Record<string, string>) => void }} options
 * @returns {Promise<WebRevokeResult>}
 */
export async function revokeViaWebApp({
  keyId,
  accountHint = "",
  onStatus = () => {},
  onEvent = () => {},
  openBrowser = !isRemoteContext(),
  noOpen = false,
  pasteCode = false,
  interactive = Boolean(process.stdin.isTTY),
  readCode = readPastedCode,
  open = openInBrowser,
  baseUrl = WEB_APP_URL,
  host = undefined,
  port = webCallbackPort(),
  portFallback = defaultPortFallback(port),
  timeoutMs = CALLBACK_TIMEOUT_MS,
  exchangeTimeoutMs = EXCHANGE_TIMEOUT_MS,
  completeTimeoutMs = COMPLETE_TIMEOUT_MS,
}) {
  const revokeFailed = (failure, fatal = false, error = "server_error") => ({ ok: false, failure, fatal, error });
  if (!keyId) {
    return revokeFailed("this machine has no record of which key to revoke");
  }
  return authorizeOnWebApp({
    action: "revoke",
    keyId,
    accountHint,
    signup: false,
    redeem: async (code, verifier, redirectUri) => {
      const revoked = await exchangeRevokeCode({ baseUrl, code, verifier, redirectUri, timeoutMs: exchangeTimeoutMs });
      return { ...revoked, fatal: false };
    },
    fail: revokeFailed,
    finish: null,
    onStatus, onEvent, openBrowser, noOpen, open, pasteCode, interactive, readCode,
    baseUrl, host, port, timeoutMs, completeTimeoutMs, portFallback,
  });
}
