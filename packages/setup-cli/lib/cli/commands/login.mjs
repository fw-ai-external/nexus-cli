import process, { stdin } from "node:process";

import {
  assertKeyStoreReadable,
  keyStoreUnreadableError,
  keysUrlFor,
  keysUrlForHome,
  refreshCatalogCacheForHome,
  resolveFireworksApiKeyValue,
} from "../../keys/api-key.mjs";
import { isEnabledFireworksHarness, readGlobalConfig, writeGlobalConfig } from "../../config/global-config.mjs";
import { HARNESS_COMMANDS } from "../../harness/id.mjs";
import { deleteSecret, hasSecret } from "../../keys/secret-store.mjs";
import { syncBakedKeysAfterStore } from "../../keys/sync.mjs";
import { identityLabel, verifyFireworksApiKey } from "../../keys/verify-api-key.mjs";
import {
  accountIdOfUserName,
  apiKeyFingerprint,
  clearMintedKeyState,
  formatExpiry,
  keyExpiresSoon,
  readMintedKeyState,
  revokeMintedKey,
} from "../../keys/mint-api-key.mjs";
import {
  savedAutoProviderKeyStatus,
  unsetAutoProviderKeys,
} from "../../keys/auto-provider-keys.mjs";
import { accent, check, link, withSpinner } from "../../ui/term.mjs";
import { runBrowserSignIn, runInteractiveSignIn, runSsoBrowserFlow, signInSucceeded } from "../../auth/login/flows.mjs";
import {
  fail,
  loginNonInteractive,
  runJsonCommand,
} from "../../auth/login/output.mjs";
import { promptYesNo } from "../../auth/login/prompts.mjs";
import { signInForKeyManagement } from "../../auth/login/sign-in-token.mjs";
import { KEY_ACTIONS_VERSION, revokeViaWebApp, usePasteCode, webAuthorizeVersion } from "../../auth/web-authorize.mjs";

import { KEYS_URL } from "../../auth/login/output.mjs";

export { KEYS_URL };
export {
  promptAccountChoice,
  promptAccountKind,
  promptYesNo,
} from "../../auth/login/prompts.mjs";
export { runInteractiveSignIn, signInSucceeded } from "../../auth/login/flows.mjs";

function requireHome(ctx) {
  const home = ctx.home || (process.env.HOME ?? "");
  if (!home) {
    throw new Error("HOME is not set; pass --home or set HOME");
  }
  return home;
}

async function readStdinToken() {
  let data = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) {
    data += chunk;
  }
  return data.trim();
}

function printKeyRotationHints({ tty = stdin.isTTY } = {}) {
  if (tty) {
    console.log(`  Rotate without prompting:  ${accent("nexus login --force")}`);
  } else {
    // Without a terminal the only sign-in is an API key you made on the keys page.
    console.log(`  Use another key (no terminal): ${accent("nexus login --api-key <key>")} or --with-token < key.txt`);
  }
}

/**
 * Sign-in failure codes → the codes `--json` callers branch on.
 * Anything not listed is "internal".
 */
const JSON_ERROR_CODES = {
  access_denied: "cancelled",
  timeout: "timeout",
  port_in_use: "port_in_use",
  account_suspended: "account_suspended",
  key_limit_reached: "key_limit_reached",
  no_account: "no_account",
  invalid_grant: "invalid_grant",
  temporarily_unavailable: "unavailable",
  slow_down: "unavailable",
  network: "network",
  keychain: "keychain",
  no_browser: "no_browser",
  paste_needs_tty: "paste_needs_tty",
  // A refresh the server didn't confirm: this machine kept its previous key.
  refresh_unconfirmed: "refresh_unconfirmed",
  // The sign-in's local page was opened in a second browser, so it stopped.
  contested: "contested",
};

const EXIT_CANCELLED = 130;
const EXIT_USAGE = 2;
const SIGN_IN_NOT_FINISHED = "Sign-in didn't finish. Run nexus login to try again.";
const NO_TERMINAL_SIGN_IN = "nexus login needs a terminal: browser sign-in asks you to approve. "
  + "Without one (CI, scripts), sign in with an API key: nexus login --with-token < key.txt";

/**
 * `nexus login --browser [--json] [--no-open] [--signup] [--select-account <id>]`:
 * straight to browser sign-in. Keeps this machine's key when it still works
 * for the account picked in the browser (`--force` replaces it).
 * With --json, stdout is NDJSON: optional events
 *   {type: "authorize_url", url, expiresAt}, {type: "waiting"}, {type: "exchanging"}
 * then always one
 *   {type: "result", ok: true, email, name, accountId, userName, key: {id, name, created}, reused[, previousKey]}
 *   {type: "result", ok: false, error: {code, message}}
 * Without a terminal, a browser that can't be opened fails at once
 * (code "no_browser") instead of waiting for an approval nobody can give.
 * `key.expiresAt` (ISO 8601) is there when the web app said when the key
 * expires (keys it makes now last 7 days); older web apps don't say.
 * `previousKey` ("deleted" | "kept" | "unknown") is there when this sign-in
 * replaced this machine's previous key.
 * Exit 0 / 1, or 130 when cancelled (browser Cancel, SIGINT or SIGTERM).
 * The key is never printed.
 * @param {string} home
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function runBrowserLogin(home, ctx) {
  // Once the code is being exchanged, a key exists or is about to, and the
  // flow is storing it: a cancel then waits for the flow's own result rather
  // than exiting mid-write.
  let exchanging = false;
  const signIn = async (emitEvent = () => {}) => {
    const emit = (event) => {
      if (event?.type === "exchanging") exchanging = true;
      emitEvent(event);
    };
    // The web app makes a key server-side; refuse before that when the
    // encrypted key store can't take it (master-key mismatch).
    try {
      await assertKeyStoreReadable(home);
    } catch (error) {
      fail(error.message);
      return { ok: false, error: { code: "keychain", message: error.message } };
    }
    /** @type {import("../../auth/login/flows.mjs").SignInReport} */
    const report = {};
    await runBrowserSignIn(home, {
      rotate: ctx.force,
      json: ctx.json,
      report,
      nextHint: !ctx.json,
      web: {
        onEvent: emit,
        noOpen: ctx.noOpen,
        signup: ctx.signup,
        selectAccount: ctx.selectAccount,
        pasteCode: ctx.pasteCode,
      },
    });
    if (report.signedIn) {
      const { email, accountId, userName, keyId, keyName, keyReused, keyExpiresAt, previousKey } = report.signedIn;
      return {
        ok: true,
        email,
        name: "",
        accountId,
        userName,
        key: { id: keyId, name: keyName, created: !keyReused, ...(keyExpiresAt ? { expiresAt: keyExpiresAt } : {}) },
        reused: keyReused,
        ...(previousKey ? { previousKey } : {}),
      };
    }
    const code = JSON_ERROR_CODES[report.error?.code ?? ""] ?? "internal";
    return {
      ok: false,
      error: { code, message: report.error?.message ?? "Browser sign-in didn't complete." },
      ...(code === "cancelled" ? { exitCode: EXIT_CANCELLED } : {}),
    };
  };
  if (!ctx.json) {
    await signIn();
    return;
  }
  // The app stops a sign-in by signalling us. While it is only waiting for
  // the browser: answer, free the callback port (exiting closes it) and go,
  // well inside the app's ~2s grace period. Once the exchange has started,
  // exiting could cut off the key store mid-write, so the flow finishes and
  // its result is the one written. Either way exactly one result line goes out.
  // Bound before runJsonCommand points stdout's write at stderr.
  const writeStdout = process.stdout.write.bind(process.stdout);
  let resultClaimed = false;
  const claimResult = () => {
    if (resultClaimed) return false;
    resultClaimed = true;
    return true;
  };
  const cancel = () => {
    if (exchanging || !claimResult()) {
      return;
    }
    const exit = () => process.exit(EXIT_CANCELLED);
    setTimeout(exit, 500).unref();
    // Exit once the line is flushed: pipe writes can be asynchronous.
    writeStdout(`${JSON.stringify({ type: "result", ok: false, error: { code: "cancelled", message: "Sign-in was cancelled." } })}\n`, exit);
  };
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  try {
    await runJsonCommand(signIn, { claimResult, closed: () => resultClaimed });
  } finally {
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
  }
}

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
/**
 * With --json, a missing HOME still ends in a result line.
 * @returns {Promise<string>} "" when the JSON result was already written.
 */
async function requireHomeOrJsonResult(ctx) {
  if (!ctx.json || ctx.home || process.env.HOME) {
    return requireHome(ctx);
  }
  await runJsonCommand(async () => ({
    ok: false,
    error: { code: "usage", message: "HOME is not set; pass --home or set HOME" },
    exitCode: EXIT_USAGE,
  }));
  return "";
}

/**
 * Flag combinations login can't honour: one would silently win over the
 * other (`--browser --account acme` would skip that team's SSO), or a
 * browser-only flag would be ignored.
 * @returns {string} the usage error, or "".
 */
export function loginFlagConflict(ctx, { tty = Boolean(stdin.isTTY) } = {}) {
  if (ctx.paste) {
    return "--paste: pasting an API key at a terminal isn't supported. Run nexus login to sign in through your browser "
      + "(over SSH it prints a link and asks for the code).";
  }
  const keyFlags = [ctx.withToken && "--with-token", ctx.apiKeyFromFlag && "--api-key"].filter(Boolean);
  if (keyFlags.length && tty) {
    // API keys are for headless use only; at a terminal, people approve in the browser.
    return `${keyFlags.join(", ")}: at a terminal, sign in through your browser with nexus login. `
      + "API-key sign-in is for running without a terminal (CI, scripts): nexus login --with-token < key.txt";
  }
  if (ctx.browser) {
    const other = [
      ctx.withToken && "--with-token",
      ctx.apiKeyFromFlag && "--api-key",
      ctx.account?.trim() && "--account",
    ].filter(Boolean);
    if (other.length) {
      return `nexus login --browser can't be combined with ${other.join(", ")}.`;
    }
    return "";
  }
  const browserOnly = [
    ctx.noOpen && "--no-open",
    ctx.signup && "--signup",
    ctx.selectAccount && "--select-account",
  ].filter(Boolean);
  return browserOnly.length ? `${browserOnly.join(", ")} only work${browserOnly.length > 1 ? "" : "s"} with nexus login --browser.` : "";
}

export async function runLoginCommand(ctx) {
  const home = await requireHomeOrJsonResult(ctx);
  if (!home) {
    return;
  }
  const conflict = loginFlagConflict(ctx);
  if (conflict) {
    if (ctx.json) {
      await runJsonCommand(async () => ({ ok: false, error: { code: "usage", message: conflict }, exitCode: EXIT_USAGE }));
    } else {
      fail(conflict);
      process.exitCode = EXIT_USAGE;
    }
    return;
  }
  if (ctx.browser) {
    await runBrowserLogin(home, ctx);
    return;
  }
  if (ctx.json) {
    await runJsonCommand(async () => ({
      ok: false,
      error: { code: "usage", message: "nexus login --json needs --browser." },
      exitCode: EXIT_USAGE,
    }));
    return;
  }

  // Headless only (loginFlagConflict refused these at a terminal). The key is
  // stored as given: refresh and revoke of it never authenticate with it.
  if (ctx.withToken) {
    await loginNonInteractive(home, await readStdinToken(), ctx.accountType || "unknown");
    return;
  }

  if (ctx.apiKeyFromFlag) {
    await loginNonInteractive(home, ctx.apiKey.trim());
    return;
  }

  // Browser sign-in creates a key server-side; refuse before that when the
  // encrypted key store can't take it (master-key mismatch). The --with-token /
  // --api-key paths above hit the same error at store time.
  await assertKeyStoreReadable(home);

  if (ctx.account?.trim()) {
    const handled = await runSsoBrowserFlow(home, ctx.account.trim());
    if (!handled) {
      fail(SIGN_IN_NOT_FINISHED);
    }
    return;
  }

  let replacing = false;
  let storedCheck = null;
  const existing = await resolveFireworksApiKeyValue({ apiKey: "", home });
  if (existing) {
    const result = await withSpinner("Checking your credentials…", () => verifyFireworksApiKey(existing));
    storedCheck = { key: existing, result };
    if (result.ok || result.reason !== "rejected") {
      const who = result.ok ? identityLabel(result) : "";
      // When browser sign-in made this key, say when it expires, so a short-lived
      // key's date is visible well before its last-day warning.
      const minted = await readMintedKeyState(home).catch(() => null);
      const expiresAt = minted?.keyFingerprint === apiKeyFingerprint(existing) ? minted.expiresAt ?? "" : "";
      const expiring = Boolean(expiresAt) && keyExpiresSoon(expiresAt);
      const expiry = expiresAt && !expiring ? `key expires ${formatExpiry(expiresAt)}` : "";
      console.log(
        result.ok
          ? `${check()} Already signed in${who ? ` as ${who}` : ""}${expiry ? ` (${expiry})` : ""}.`
          : `${check()} Already signed in (couldn't verify with the Fireworks API right now${expiry ? `; ${expiry}` : ""}).`,
      );
      // Harness configs bake the key as a literal and go stale on rotation.
      if (result.ok) {
        for (const note of await syncBakedKeysAfterStore(home, existing)) {
          console.log(`  ${note}`);
        }
      }
      if (expiring) {
        console.log(`  This machine's API key expires ${formatExpiry(expiresAt)}: sign in again to replace it.`);
      }
      printKeyRotationHints();
      const rotate = stdin.isTTY
        && (ctx.force || await promptYesNo("  Sign in again and replace this machine's key?", { defaultYes: false }));
      if (!rotate) {
        // The account's plan may have changed since the catalog was cached.
        // A rotation skips this: storing the new key refetches its catalog.
        if (result.ok) {
          await withSpinner("Refreshing your model list…", () => refreshCatalogCacheForHome(home, existing));
        }
        return;
      }
      // The user asked for a new key: browser sign-in must not keep this one.
      replacing = true;
    } else {
      console.log("Your stored key was rejected by the Fireworks API — let's replace it.");
    }
  }

  if (!stdin.isTTY) {
    fail(NO_TERMINAL_SIGN_IN);
    return;
  }

  await runInteractiveSignIn(home, { rotate: replacing, web: { pasteCode: ctx.pasteCode }, storedCheck });
}

/**
 * `nexus logout [--revoke] [--json] [--paste-code]`. Revoking the key browser
 * sign-in created takes the user's approval in the browser: a Nexus account's
 * through the web app (action=revoke; loopback, or paste-the-code over
 * SSH/WSL), a Fireworks Platform or SSO account's with a Cognito sign-in
 * token at a terminal. The key never deletes itself. --json never prompts on
 * the terminal and always tries to revoke (for a Nexus key it opens the
 * browser and waits for the approval; the loopback needs no terminal), then
 * prints one NDJSON line:
 *   {type: "result", ok: true, keyDeleted, warnings}   local state is cleared
 *   {type: "result", ok: false, error: {code: "keychain" | "internal", message}}
 * keyDeleted is false (with a warning when there was a key to delete) when it
 * couldn't be deleted on Fireworks (cancelled, failed, unsupported, or no
 * browser opened: then it doesn't wait for an approval). A key browser
 * sign-in didn't create (--with-token, --paste) is only removed from this
 * machine, with a warning that it stays active on Fireworks.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
/**
 * Connected harnesses keep their own copy of the key in their settings, and
 * logout leaves their routing alone: say so, and how to remove the copies.
 * @param {Record<string, { enabled?: boolean, provider?: string }>} harnesses
 */
function bakedKeyCopiesNote(harnesses) {
  const ids = Object.keys(harnesses).filter((id) => isEnabledFireworksHarness(harnesses, id));
  if (!ids.length) {
    return "";
  }
  const names = ids.map((id) => HARNESS_COMMANDS.find((entry) => entry.command === id)?.name ?? id);
  const commands = ids.map((id) => accent(`nexus ${id} off`)).join(", ");
  return `Note: ${names.join(", ")} still ${ids.length === 1 ? "has" : "have"} a copy of the key in `
    + `${ids.length === 1 ? "its" : "their"} settings and can keep using it until it is revoked. `
    + `To remove the ${ids.length === 1 ? "copy" : "copies"}: ${commands}`;
}

/**
 * A key with no minted-key record here: a pasted or --with-token key, or
 * one browser sign-in made whose record was lost or never written. Logout
 * can't tell which key to revoke, so it only leaves this machine.
 * @param {string} keysUrl
 */
/**
 * Said before the key is removed: logging out only removes it here.
 * @param {string} keysUrl
 */
export function localOnlyNotice(keysUrl) {
  return `This machine has no record of creating this API key, so logging out only removes it from this machine `
    + `and it stays active on Fireworks. Revoke it at ${keysUrl} if you no longer need it.`;
}

export function localOnlyLine(keysUrl) {
  return `This API key was only removed from this machine (this machine has no record of creating it), `
    + `so it stays active on Fireworks. Revoke it at ${keysUrl} if you no longer need it.`;
}

/**
 * Nobody could be asked to approve the revoke (no browser opened, or a
 * Platform/SSO key's sign-in needs a terminal): the key was left, and this
 * says why and until when.
 * @param {{ label: string, expiresAt?: string, why?: string }} key @param {string} keysUrl
 */
function stillActiveWarning({ label, expiresAt, why = "" }, keysUrl) {
  const reason = why ? ` (${why})` : "";
  return expiresAt
    ? `${label} stays active until ${expiresAt.slice(0, 10)}${reason}; revoke it at ${keysUrl}`
    : `${label} stays active until you revoke it${reason} at ${keysUrl}`;
}

/** Why a Fireworks Platform or company-SSO key isn't revoked without a terminal. */
const NEEDS_TERMINAL_WHY = "revoking a Fireworks Platform or company SSO key needs a browser sign-in from a terminal: "
  + "run nexus logout --revoke in a terminal";

function keychainCopyLeftError() {
  return new Error(
    "Not logged out: a saved copy of the key couldn't be removed from here "
      + "(the OS keychain over SSH or while locked, or the encrypted key file). "
      + "Run `nexus logout` again at the desktop with the keychain unlocked.",
  );
}

export async function runLogoutCommand(ctx, {
  tty = stdin.isTTY,
  confirm = promptYesNo,
  signIn = signInForKeyManagement,
  webRevoke = revokeViaWebApp,
  revokeKey = (args) => revokeThisMachinesKey(args, { signIn, webRevoke }),
} = {}) {
  const home = await requireHomeOrJsonResult(ctx);
  if (!home) {
    return;
  }
  if (!ctx.json) {
    await logout(home, ctx, { tty, confirm, revokeKey });
    return;
  }
  // Read before logout clears the account type it depends on.
  const keysUrl = await keysUrlForHome(home);
  let step = "internal";
  // The revoke can wait minutes on the browser. When the app stops it, answer
  // with a result line before exiting. Local state is only cleared after the
  // revoke settles, so a cancel before that leaves this machine signed in.
  const writeStdout = process.stdout.write.bind(process.stdout);
  // Exactly one result line: whichever of the cancel and the finished logout
  // claims it first writes it.
  let resultClaimed = false;
  const claimResult = () => {
    if (resultClaimed) return false;
    resultClaimed = true;
    return true;
  };
  const cancel = () => {
    if (!claimResult()) {
      return;
    }
    const exit = () => process.exit(EXIT_CANCELLED);
    setTimeout(exit, 500).unref();
    const message = step === "keychain"
      ? "Log out was cancelled while removing the stored key; run nexus logout again to finish."
      : "Log out was cancelled: you're still signed in on this machine. Run nexus logout again.";
    writeStdout(`${JSON.stringify({ type: "result", ok: false, error: { code: "cancelled", message } })}\n`, exit);
  };
  const run = async (emit) => {
    try {
      // A browser revoke's progress goes out like login --browser --json's:
      // {type: "authorize_url", url, expiresAt}, then {type: "waiting"}.
      const outcome = await logout(home, { ...ctx, revoke: true }, {
        tty: false, confirm, revokeKey, onEvent: emit, onClearing: () => { step = "keychain"; },
      });
      const warnings = [];
      if (outcome.revokeError && outcome.leftActive) {
        warnings.push(stillActiveWarning(outcome.leftActive, keysUrl));
      } else if (outcome.revokeError) {
        warnings.push(`Couldn't delete this machine's API key on Fireworks (${outcome.revokeError}). Delete it at ${keysUrl}`);
      }
      if (outcome.localOnly) {
        warnings.push(localOnlyLine(keysUrl));
      }
      return { ok: true, keyDeleted: outcome.keyRevoked, warnings };
    } catch (error) {
      return { ok: false, error: { code: step, message: error?.message ?? String(error) } };
    }
  };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  try {
    await runJsonCommand(run, { claimResult, closed: () => resultClaimed });
  } finally {
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
  }
}

/**
 * Revoke the key browser sign-in created on this machine, with the user's
 * approval in the browser. A Nexus account's key: the web app's revoke
 * action (version 3). A Fireworks Platform or SSO account's key (minted with
 * a Cognito sign-in): a sign-in token. Never with the API key itself. Never throws.
 * `onEvent` gets the web revoke's progress events (`logout --json`), and
 * `ctx.noOpen` leaves opening the URL to whoever reads them.
 * @param {{ minted: { keyId: string, userName: string }, config: { accountType?: string, ssoAccountId?: string }, ctx: import("../../harness/types.mjs").HarnessContext, tty: boolean, onEvent?: (event: Record<string, string>) => void }} args
 * @param {{ webRevoke?: typeof revokeViaWebApp, version?: () => Promise<number>, signIn?: typeof signInForKeyManagement, revoke?: typeof revokeMintedKey }} [deps]
 * @returns {Promise<{ ok: boolean, failure: string, error?: string }>}
 *   `error` "no_browser": no browser opened and no terminal, so nobody was asked;
 *   "needs_terminal": a Platform/SSO key, whose sign-in needs a terminal.
 */
export async function revokeThisMachinesKey({ minted, config, ctx, tty, onEvent = () => {} }, {
  webRevoke = revokeViaWebApp,
  version = webAuthorizeVersion,
  signIn = signInForKeyManagement,
  revoke = revokeMintedKey,
} = {}) {
  const say = (line) => console.log(line);
  try {
    // A company-SSO sign-in refuses the shared web app, so its key (even on
    // a Nexus account) is revoked with its own sign-in below.
    if (config.accountType === "nexus" && !config.ssoAccountId) {
      const webVersion = await version();
      if (webVersion < KEY_ACTIONS_VERSION) {
        return { ok: false, failure: webVersion
          ? "the web app can't revoke keys for Nexus yet (run nexus update later)"
          : "browser approval isn't available right now" };
      }
      const pasteCode = usePasteCode({ flag: ctx.pasteCode, version: webVersion });
      say("Approve revoking this machine's API key in the browser.");
      const revoked = await webRevoke({
        keyId: minted.keyId,
        accountHint: accountIdOfUserName(minted.userName),
        onStatus: (line) => say(`  ${line}`),
        onEvent,
        noOpen: Boolean(ctx.noOpen),
        pasteCode,
        interactive: tty,
      });
      return revoked.ok
        ? { ok: true, failure: "" }
        : { ok: false, failure: revoked.failure.replace(/\.$/, ""), ...(revoked.error ? { error: revoked.error } : {}) };
    }
    // A Cognito sign-in: the localhost callback, or a one-time code. Only at
    // a terminal.
    if (!tty) {
      return { ok: false, failure: "browser sign-in needs a terminal", error: "needs_terminal" };
    }
    say("Browser sign-in is needed to revoke this machine's API key.");
    const tokens = await signIn({ ssoAccountId: config.ssoAccountId, accountType: config.accountType, onStatus: say }).catch(() => null);
    if (!tokens?.ok || !tokens.idToken) {
      return { ok: false, failure: "browser sign-in did not finish" };
    }
    const revoked = await withSpinner("Revoking this machine's API key…",
      () => revoke({ idToken: tokens.idToken, keyId: minted.keyId, userName: minted.userName }));
    return revoked.ok ? revoked : { ok: false, failure: "Fireworks did not confirm deletion" };
  } catch (error) {
    return { ok: false, failure: error?.message ?? String(error) };
  }
}

/**
 * @param {string} home
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 * @param {{ tty?: boolean, confirm?: typeof promptYesNo, revokeKey?: typeof revokeThisMachinesKey, onClearing?: () => void }} [hooks]
 *   `onClearing` is called before local credentials are deleted.
 * @returns {Promise<{ signedOut: boolean, keyRevoked: boolean, revokeError?: string, leftActive?: { label: string, expiresAt?: string, why?: string }, localOnly?: boolean, providerKeysCleared: string[] }>}
 *   `leftActive`: nobody could be asked to approve the revoke (the key stays).
 *   `localOnly`: no record of creating the key here, so it was only removed here.
 */
async function logout(home, ctx, { tty = stdin.isTTY, confirm = promptYesNo, revokeKey = revokeThisMachinesKey, onEvent = () => {}, onClearing = () => {} } = {}) {
  const config = await readGlobalConfig(home);
  const hadSecret = await hasSecret(home);
  if (!hadSecret) {
    // The stored key exists but can't be decrypted. Deleting the store would
    // discard every secret in it, so leave it and explain the recovery.
    const unreadable = keyStoreUnreadableError();
    if (unreadable) {
      throw new Error(`Not logged out: the stored key can't be read, so nothing was changed.\n${unreadable.message}`);
    }
  }
  const envNote = process.env.FIREWORKS_API_KEY?.trim()
    ? `Note: FIREWORKS_API_KEY is still set in your environment; Nexus ignores it.`
    : "";
  const bakedLine = bakedKeyCopiesNote(config.harnesses ?? {});

  const savedProviderKeys = savedAutoProviderKeyStatus(config);
  const providersToClear = ["anthropic", "openai"].filter((provider) => savedProviderKeys[provider]);
  if (!hadSecret && !config.apiKey) {
    // This session may not see a keychain copy (over SSH, or locked): delete
    // it anyway, and fail if that couldn't be confirmed.
    if (!(await deleteSecret(home))) {
      throw keychainCopyLeftError();
    }
    // A missing credential must not leave a previous account's classification.
    if (config.accountType !== "unknown") {
      await writeGlobalConfig(home, { accountType: "unknown" });
    }
    if (providersToClear.length) {
      await unsetAutoProviderKeys(home, providersToClear);
      console.log("Logged out — removed the saved provider keys from this machine.");
    } else {
      console.log("Not signed in — no stored credentials to clear.");
    }
    if (bakedLine) {
      console.log(bakedLine);
    }
    if (envNote) {
      console.log(envNote);
    }
    return { signedOut: false, keyRevoked: false, providerKeysCleared: providersToClear };
  }

  const minted = await readMintedKeyState(home);
  let keyRevoked = false;
  let revokeError = "";
  let leftActive = null;
  const KEYS_URL = keysUrlFor(config.accountType);
  if (minted) {
    let revokeLine;
    const label = minted.displayName || "the API key created by this machine";
    let shouldRevoke = ctx.revoke;
    if (!ctx.revoke && tty) {
      console.log(`Browser sign-in created an API key for this machine (${accent(label)}).`);
      shouldRevoke = await confirm("Revoke it too? You approve it in the browser. It stops working everywhere it's used.");
    }
    if (shouldRevoke) {
      // Approved in the browser; the key itself never deletes a key.
      const revoked = await revokeKey({ minted, config, ctx, tty, onEvent });
      keyRevoked = revoked.ok;
      revokeError = revoked.failure;
      if (revoked.error === "no_browser" || revoked.error === "needs_terminal") {
        leftActive = {
          label,
          ...(minted.expiresAt ? { expiresAt: minted.expiresAt } : {}),
          ...(revoked.error === "needs_terminal" ? { why: NEEDS_TERMINAL_WHY } : {}),
        };
      }
      if (revoked.ok) {
        revokeLine = `${check()} Revoked ${accent(label)} server-side.`;
      } else {
        // An explicit revoke must not report success and erase the only local
        // retry record when Fireworks didn't confirm the deletion. --json
        // (the desktop app) logs out anyway and reports it as a warning; at a
        // terminal the user may choose that too.
        console.log(`Couldn't revoke ${accent(label)}: ${revoked.failure}.`);
        const logOutAnyway = ctx.json || (tty && await confirm(`Log out anyway? ${label} stays active until you revoke it at ${KEYS_URL}.`, { defaultYes: false }).catch(() => false));
        if (!logOutAnyway) {
          throw new Error(`Couldn't revoke ${label}: ${revoked.failure}. Your stored key and revoke record were kept. Try nexus logout --revoke again, or revoke it at ${KEYS_URL}.`);
        }
        revokeLine = `Left ${accent(label)} active — revoke it at ${link(KEYS_URL)}`;
      }
    } else {
      revokeLine = `Left ${accent(label)} active — revoke it anytime at ${link(KEYS_URL)}`;
    }
    // Print it now: the record goes next, and a later step may still throw.
    console.log(revokeLine);
  } else {
    // Nothing recorded to revoke (a pasted or --with-token key): say it
    // lives on, now, before a later step can throw. It isn't removed yet, so
    // this line doesn't claim it was.
    console.log(localOnlyNotice(link(KEYS_URL)));
  }

  onClearing();
  if (minted) {
    await clearMintedKeyState(home);
  }

  if (!(await deleteSecret(home))) {
    throw keychainCopyLeftError();
  }
  if (config.apiKey || config.accountType !== "unknown") {
    await writeGlobalConfig(home, { apiKey: "", accountType: "unknown" });
  }
  // Saved Anthropic/OpenAI keys are credentials too: leaving them would let
  // the next account on this machine send (and be billed through) them.
  if (providersToClear.length) {
    await unsetAutoProviderKeys(home, providersToClear);
  }
  console.log("Logged out — removed the stored key from this machine.");
  if (bakedLine) {
    console.log(bakedLine);
  }
  if (envNote) {
    console.log(envNote);
  }
  return {
    signedOut: true,
    keyRevoked,
    ...(revokeError ? { revokeError } : {}),
    ...(leftActive ? { leftActive } : {}),
    ...(minted ? {} : { localOnly: true }),
    providerKeysCleared: providersToClear,
  };
}
