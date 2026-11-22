

import { signInViaDeviceFlow, signInViaLocalhostCallback } from "../browser-auth.mjs";
import { KEY_ACTIONS_VERSION, signInViaWebApp, usePasteCode, webAuthorizeVersion } from "../web-authorize.mjs";
import { resolveSignInOptions } from "./sign-in-token.mjs";
import { readGlobalConfig, writeGlobalConfig } from "../../config/global-config.mjs";
import {
  keysUrlFor,
  resolveFireworksApiKeyValue,
  tryReadKeychainSecret,
} from "../../keys/api-key.mjs";
import { sanitize } from "../../ui/sanitize.mjs";
import { createUserJit } from "../sso-account.mjs";
import { WEB_SIGNUP_URL } from "../sign-in-page.mjs";
import {
  BROWSER_SIGNIN_NO_ACCOUNT_FAILURE,
  accountIdOfUserName,
  listAccountsForIdToken,
  mintApiKeyForAccount,
  mintedKeyName,
  planCliKeyAction,
  readMintedKeyState,
  apiKeyFingerprint,
  clearMintedKeyState,
  revokeMintedKey,
  settleCliKey,
} from "../../keys/mint-api-key.mjs";
import { deleteSecret } from "../../keys/secret-store.mjs";
import { PAGE_REUSED_FAILURE } from "../browser-auth.mjs";
import { verifyFireworksApiKey } from "../../keys/verify-api-key.mjs";
import { accent, link, withSpinner } from "../../ui/term.mjs";
import {
  fail,
  printSuccessBlock,
  storeApiKey,
} from "./output.mjs";
import { activeKeySourceNote } from "../../keys/storage-report.mjs";
import {
  promptAccountChoice,
  promptAccountKind,
  promptYesNo,
} from "./prompts.mjs";

const ACCOUNT_KIND_TIMEOUT_MS = 5_000;

/**
 * What a sign-in ended with, for `nexus login --json`. Flows fill it in; it
 * never holds the key or any token.
 * @typedef {Object} SignInReport
 * @property {{ code: string, message: string } | null} [error]
 * @property {{ email: string, accountId: string, userName: string, keyId: string, keyName: string, keyReused: boolean, keyExpiresAt?: string, previousKey?: PreviousKeyOutcome } | null} [signedIn]
 *   `previousKey`: set when this sign-in replaced this machine's previous key.
 */

/**
 * @typedef {"deleted" | "kept" | "unknown"} PreviousKeyOutcome
 */

/**
 * Options only the web-app flow understands (`nexus login --browser`).
 * @typedef {Object} WebFlowOptions
 * @property {(event: Record<string, string>) => void} [onEvent]
 * @property {boolean} [noOpen]
 * @property {boolean} [signup]
 * @property {string} [selectAccount]
 * @property {string} [pasteCode]  "on" with --paste-code (opt-in); otherwise the loopback, over SSH too.
 */

/**
 * Record the first failure only: later lines ("didn't complete") are
 * consequences of it.
 * @param {SignInReport | undefined} report @param {string} code @param {string} message
 */
function reportError(report, code, message) {
  if (report && !report.signedIn && !report.error) {
    report.error = { code, message };
  }
}

/**
 * Who the browser sign-in came back as, shown before a key is created so a
 * sign-in that returned an unexpected identity is visible.
 * @param {string} email
 * @param {string} accountName  accounts/<id>
 */
export function signedInIdentityLine(email, accountName) {
  const who = sanitize(email) || "an account with no email";
  const account = sanitize(String(accountName ?? "").replace(/^accounts\//, ""));
  return `Signed in as ${who}. Creating an API key in account ${account}.`;
}

/**
 * Verify, store, and record this machine's key. `mint(keyName)` either mints
 * it from an id_token here or hands back the one the web sign-in made or
 * kept (`reused`). `idToken` is the sign-in token that can delete a key this
 * can't keep; the web app's key comes without one, and a key never deletes
 * itself, so an unusable one is left for the user to revoke (the keys page).
 * `accountName` is set when the key is about to be created under it, so the
 * identity line can come first (the web app shows that on its own page).
 * Returns false to fall back to key paste, true when handled: signed in, or
 * a failure (the key couldn't be stored) that paste wouldn't fix.
 *
 * A refresh whose redeem carries `confirmRefresh` must be confirmed once the
 * new key is stored: only then does the server delete the old key, and
 * without it the server deletes the new key instead. `rollback` (this
 * machine's previous key and its record, still in memory) is stored again
 * when the confirm fails, so this machine never ends up holding only a key
 * the server is about to delete.
 *
 * `replaces` is this machine's previous key when the user asked to replace
 * it (see {@link replacedCliKey}). Once the new key is stored and the
 * Fireworks API accepts it, the previous key is deleted with `idToken`, the
 * same sign-in token `nexus logout --revoke` uses for it.
 */
async function completeMintedSignIn(home, {
  mint: mintKey,
  idToken = "",
  email,
  accountName = "",
  fallbackAccountId = "",
  rememberSsoAccountId = "",
  accountType = "unknown",
  nextHint = true,
  keyName = mintedKeyName(),
  say,
  report,
  done = {},
  verified = null,
  rollback = null,
  contested = () => false,
  previousCredential = null,
  replaces = null,
}) {
  if (accountName) {
    say(signedInIdentityLine(email, accountName));
  }
  // Only with a sign-in token: no API key ever deletes a key.
  const revokeUnused = ({ keyId, userName }) => (idToken
    ? revokeMintedKey({ idToken, keyId, userName })
    : Promise.resolve({ ok: false, failure: "no sign-in token" }));
  const outcome = await withSpinner("Signing you in…", async () => {
    const mint = await mintKey(keyName);
    if (!mint.ok) {
      return { failure: mint.failure, code: mint.error || "key_creation_failed" };
    }
    // A kept key was just checked when planning; don't ask the API again.
    const verify = mint.reused && verified ? verified : await verifyFireworksApiKey(mint.key);
    if (!verify.ok && verify.reason === "rejected") {
      // Nothing stores a new key, so delete it now or it stays on the account.
      const revoked = mint.reused ? { ok: true } : await revokeUnused(mint);
      const cleanup = revoked.ok ? "" : ` Revoke the unused key ${accent(keyName)} at ${link(keysUrlFor(accountType))}`;
      return { failure: `The Fireworks API rejected the key that was just created for you. Try again in a moment.${cleanup}`, code: "key_rejected" };
    }
    return { mint, verify };
  });
  if (outcome.failure) {
    say(outcome.failure);
    reportError(report, outcome.code, outcome.failure);
    return false;
  }

  const { mint } = outcome;
  const { key, keyId, userName } = mint;
  // A kept key keeps the name it was created with, not this run's.
  const shownName = mint.displayName || keyName;
  let stored;
  try {
    stored = await storeApiKey(home, key, accountType, {
      mintedKey: { keyId, userName, displayName: shownName, ...(mint.expiresAt ? { expiresAt: mint.expiresAt } : {}) },
    });
  } catch (error) {
    // A refresh waiting for its confirm: don't confirm a key this machine
    // couldn't store. Put the previous key (and record) back; unconfirmed, the
    // server deletes the new key and keeps the old one.
    if (mint.confirmRefresh) {
      return refreshNotConfirmed(home, {
        confirmed: { failure: `couldn't store the new key: ${error?.message ?? "unknown error"}` },
        rollback,
        keyName: shownName,
        accountType,
        report,
      });
    }
    // A key this machine resolves is still usable (and a recorded one revocable
    // by logout). One it can't resolve would stay active on the account with
    // nothing left to use or revoke it.
    const recorded = (await readMintedKeyState(home).catch(() => null))?.keyId === keyId;
    const held = recorded || (await resolveFireworksApiKeyValue({ home }).catch(() => ""))?.trim() === key;
    if (!held) {
      const revoked = await revokeUnused(mint);
      if (!revoked.ok) say(`Couldn't remove the unsaved API key ${accent(shownName)}. Revoke it at ${link(keysUrlFor(accountType))}`);
    }
    if (!report) {
      throw error;
    }
    // With a report (login --browser), handled here so --json reports
    // "keychain", not "internal".
    const failure = `Couldn't store the API key on this machine (${error?.message ?? "unknown error"}).`;
    reportError(report, "keychain", failure);
    fail(`  ${failure}`);
    return true;
  }
  /** @type {string[]} */
  const confirmNotes = [];
  /** @type {PreviousKeyOutcome | undefined} */
  let previousKey = mint.previousKey;
  // A second browser loaded the sign-in's local page before or while the key
  // was stored: whose approval this was can't be told, so the key just
  // stored is undone. A refresh isn't confirmed (the server then deletes
  // the new key) and puts the old key back.
  if (contested()) {
    if (mint.confirmRefresh) {
      return refreshNotConfirmed(home, {
        confirmed: { failure: "the sign-in link was opened in a second browser" },
        rollback, keyName: shownName, accountType, report,
      });
    }
    const restored = await restorePreviousCredential(home, previousCredential);
    const failure = restored
      ? PAGE_REUSED_FAILURE
      : `${PAGE_REUSED_FAILURE} The key it stored couldn't be removed: run nexus logout, then nexus login.`;
    reportError(report, "contested", failure);
    fail(`  ${failure}`);
    return true;
  }
  if (mint.confirmRefresh) {
    let confirmed = await withSpinner("Confirming the new key…", () => mint.confirmRefresh())
      .catch((error) => ({ ok: false, targetRevoked: false, failure: error?.message ?? "unknown error", error: "internal", indeterminate: true }));
    let inferred = false;
    if (!confirmed.ok && confirmed.indeterminate && rollback?.key) {
      // The confirm may have landed (its answer was lost, or the server
      // failed after committing). The old key tells: once confirmed, the
      // server deletes it, so a rejected old key means the new key is kept
      // there too. A key check is identity, not key management.
      const old = await withSpinner("Checking the previous key…", () => verifyFireworksApiKey(rollback.key, { timeoutMs: 10_000 }))
        .catch(() => null);
      if (old && !old.ok && old.reason === "rejected") {
        confirmed = { ok: true, targetRevoked: true, failure: "", error: "" };
        inferred = true;
      }
    }
    if (!confirmed.ok) {
      return refreshNotConfirmed(home, { confirmed, rollback, keyName: shownName, accountType, report });
    }
    const label = rollback?.record ? rollback.record.displayName || rollback.record.keyId : "the previous key";
    previousKey = confirmed.targetRevoked ? "deleted" : "kept";
    confirmNotes.push(confirmed.targetRevoked
      ? `Deleted this machine's previous key (${label}).${inferred ? " (The confirmation's answer was lost, but the previous key no longer works, so the replacement went through.)" : ""}`
      : `Couldn't delete this machine's previous key (${label}). Delete it at ${link(keysUrlFor(accountType))}`);
  }
  if (replaces && !mint.reused && replaces.keyId !== keyId) {
    const replaced = await revokeReplacedKey(replaces, {
      idToken,
      newKeyWorks: outcome.verify.ok,
      stillUsing: stored.unconfirmed,
    });
    previousKey = replaced.outcome;
    confirmNotes.push(replaced.line);
  }
  // The remembered SSO account is the one the current key came from, so a
  // sign-in through the shared page clears a former account's.
  await writeGlobalConfig(home, { ssoAccountId: rememberSsoAccountId });
  done.signedIn = true;
  const identity = outcome.verify.ok ? outcome.verify : { email, accountId: fallbackAccountId };
  if (report) {
    report.error = null;
    report.signedIn = {
      email: identity.email || email || "",
      accountId: identity.accountId || fallbackAccountId || "",
      userName,
      keyId,
      keyName: shownName,
      keyReused: Boolean(mint.reused),
      ...(mint.expiresAt ? { keyExpiresAt: mint.expiresAt } : {}),
      ...(previousKey ? { previousKey } : {}),
    };
  }
  printSuccessBlock(identity, [
    mint.reused
      ? `Kept this machine's API key ${accent(shownName)}. It still works.`
      : `Created API key ${accent(shownName)}. Revoke it anytime at ${link(keysUrlFor(accountType))}`,
    ...(mint.notes ?? []),
    ...confirmNotes,
    stored.message,
    ...stored.notes,
    activeKeySourceNote(key),
  ], { nextHint });
  return true;
}

/**
 * What a rotation does with this machine's current key, read before a
 * sign-in replaces it and its record:
 *   null       no record (a pasted or `--with-token` key), or a record of
 *              another key: not this CLI's to delete, and nothing to say.
 *   "unknown"  the record or the keychain can't be read, or the record has no
 *              fingerprint: it may be this CLI's key, so the user is told.
 *   "ours"     the record describes the stored key. `webApp` marks a key the
 *              Nexus web app made, which only the web app deletes.
 * Never throws.
 * @param {string} home
 * @returns {Promise<ReplacedKey | null>}
 *
 * @typedef {{ kind: "unknown", keyId?: undefined } | {
 *   kind: "ours", keyId: string, userName: string, displayName: string, webApp: boolean, keysUrl: string,
 * }} ReplacedKey
 */
async function replacedCliKey(home) {
  try {
    const [record, storedKey, config] = await Promise.all([
      readMintedKeyState(home),
      tryReadKeychainSecret(home),
      readGlobalConfig(home),
    ]);
    if (!record) return null;
    if (!record.keyFingerprint || !storedKey) return { kind: "unknown" };
    if (record.keyFingerprint !== apiKeyFingerprint(storedKey)) return null;
    return {
      kind: "ours",
      keyId: record.keyId,
      userName: record.userName,
      displayName: record.displayName,
      webApp: config.accountType === "nexus" && !config.ssoAccountId,
      keysUrl: keysUrlFor(config.accountType),
    };
  } catch {
    return { kind: "unknown" };
  }
}

/**
 * Delete the key a rotation replaced, with this sign-in's token, and say what
 * happened. The old key is kept (and the user told where to delete it) when
 * the new key couldn't be checked, a connected harness may still send the old
 * one (`stillUsing`, from the store's harness sync; null when the sync didn't
 * report, which keeps it too), there is no sign-in token, or the Nexus web
 * app made it. Never throws. Exported for tests.
 * @param {ReplacedKey} previous
 * @param {{ idToken: string, newKeyWorks: boolean, stillUsing: { label: string, hint: string }[] | null }} options
 * @returns {Promise<{ line: string, outcome: PreviousKeyOutcome }>} the line for
 *   the sign-in summary, and what happened to the previous key.
 */
export async function revokeReplacedKey(previous, { idToken, newKeyWorks, stillUsing }, { revoke = revokeMintedKey } = {}) {
  if (previous.kind === "unknown") {
    return { outcome: "unknown", line: "Couldn't tell whether this machine's previous key was made here, so it wasn't deleted. "
      + "If an older nexus-cli key for this machine is still listed on your API keys page, delete it there." };
  }
  const label = previous.displayName || previous.keyId;
  const deleteIt = `Delete it at ${link(previous.keysUrl)}`;
  const kept = (why, after = "") => ({ outcome: /** @type {const} */ ("kept"), line: `Kept this machine's previous key (${label}) ${why}. ${deleteIt}${after}` });
  if (previous.webApp) return kept("because the Nexus web app made it");
  if (!idToken) return kept("because this sign-in can't delete keys");
  if (!newKeyWorks) return kept("because the new key couldn't be checked yet", " once Nexus works.");
  if (!stillUsing) {
    return kept("because Nexus couldn't confirm that your connected harnesses use the new key",
      " after re-running `on` for each harness you connected (nexus status lists them).");
  }
  if (stillUsing.length) {
    const names = stillUsing.map(({ label }) => label).join(", ");
    const commands = stillUsing.map(({ hint }) => hint).join(", ");
    return kept(`because ${names} may still use it`, ` after running ${commands}.`);
  }
  const revoked = await withSpinner("Deleting this machine's previous key…",
    () => revoke({ idToken, keyId: previous.keyId, userName: previous.userName }))
    .catch((error) => ({ ok: false, failure: error?.message ?? "unknown error" }));
  return revoked.ok
    ? { outcome: "deleted", line: `Deleted this machine's previous key (${label}).` }
    : { outcome: "kept", line: `Couldn't delete this machine's previous key (${label}): ${revoked.failure.replace(/\.$/, "")}. ${deleteIt}` };
}

/**
 * Put this machine's credential back the way it was before a sign-in stored
 * a key: the previous key and its minted-key record (only when the record
 * describes that key), or nothing stored at all. Never throws.
 * @param {string} home
 * @param {{ key: string, record: { keyId: string, userName: string, displayName: string, expiresAt?: string } | null, accountType?: string } | null} previous
 * @returns {Promise<boolean>} true when restored.
 */
async function restorePreviousCredential(home, previous) {
  try {
    if (previous?.key) {
      const record = previous.record;
      await storeApiKey(home, previous.key, previous.accountType ?? "unknown", record ? {
        mintedKey: { keyId: record.keyId, userName: record.userName, displayName: record.displayName, ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}) },
      } : {});
    } else {
      await clearMintedKeyState(home);
      if (!(await deleteSecret(home))) {
        return false;
      }
      await writeGlobalConfig(home, { apiKey: "", accountType: "unknown" });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * A refresh the server didn't confirm: it keeps the old key and deletes the
 * new one, so put the old key (and its record) back here. Reported as
 * `refresh_unconfirmed`; the browser's page says it didn't finish.
 * @returns {Promise<true>} handled (a failure key paste wouldn't fix).
 */
async function refreshNotConfirmed(home, { confirmed, rollback, keyName, accountType, report }) {
  const keysUrl = keysUrlFor(accountType);
  const label = rollback?.record ? rollback.record.displayName || rollback.record.keyId : "";
  let restored = false;
  if (rollback?.key && rollback.record) {
    const { keyId, userName, displayName, expiresAt } = rollback.record;
    restored = await storeApiKey(home, rollback.key, accountType, {
      mintedKey: { keyId, userName, displayName, ...(expiresAt ? { expiresAt } : {}) },
    }).then(() => true, () => false);
  }
  const failure = restored
    ? `Couldn't finish replacing this machine's API key (${confirmed.failure}). Kept the previous key ${label}, `
      + `which still works; Fireworks deletes the new key ${keyName} within about 15 minutes. Run nexus login --force to try again.`
    : `Couldn't finish replacing this machine's API key (${confirmed.failure}), and couldn't put the previous key back. `
      + `Fireworks deletes the new key ${keyName} within about 15 minutes: run nexus login again. `
      + `If the previous key${label ? ` ${label}` : ""} is still listed at ${keysUrl}, delete it there.`;
  reportError(report, "refresh_unconfirmed", failure);
  fail(`  ${failure}`);
  return true;
}

/**
 * Web-app sign-in: the browser approves on the web app, which hands back a
 * new key. When this machine's own key is being replaced (`rotate`, or it
 * expires soon) the approval is a refresh, which also deletes the old key on
 * the server; when that key still works and nothing asks to replace it, it
 * is kept without opening the browser (planCliKeyAction).
 * @param {number} version  the web app's contract version (2 or more)
 * @returns {Promise<boolean>} true when handled (signed in, or a fatal stop).
 */
async function runWebAppFlow(home, { nextHint, say, rotate = false, report, web = {}, version, storedCheck = null }) {
  const keyName = mintedKeyName();
  const keysUrl = keysUrlFor("nexus");
  // Read before the browser opens: a keychain that can't be read (locked, or
  // access denied) would otherwise look like "no key stored here", leave the
  // old key on the account, and fail again when the new key is stored.
  let previous;
  let storedKey;
  try {
    previous = await readMintedKeyState(home);
  } catch (error) {
    // A damaged record, not the keychain: unlocking wouldn't help.
    const failure = `This machine's sign-in record (~/.nexus/minted-key.json) can't be read (${error?.message ?? "unknown error"}). `
      + `Delete that file and run ${accent("nexus login")} again.`;
    reportError(report, "internal", failure);
    fail(`  ${failure}`);
    return true;
  }
  try {
    storedKey = await tryReadKeychainSecret(home);
  } catch (error) {
    const failure = `Couldn't read this machine's saved key (${error?.message ?? "unknown error"}). `
      + `Unlock the keychain and run ${accent("nexus login")} again.`;
    reportError(report, "keychain", failure);
    fail(`  ${failure}`);
    return true;
  }
  const previousAccount = accountIdOfUserName(previous?.userName);
  // Only a Nexus key from the shared sign-in is the web app's to keep or
  // replace: a Fireworks Platform or company-SSO key is left as it is.
  const config = await readGlobalConfig(home).catch(() => ({}));
  const webAppKey = config.accountType === "nexus" && !config.ssoAccountId;
  // That key's own sign-in made it (Platform or company SSO): the web app
  // can't delete it, and the new key's note says so.
  const otherSignIn = Boolean(!webAppKey && previous && storedKey);
  // Asking for another account (or a new one) is a plain sign-in: a refresh
  // stays on the key's account, and keeping the key would ignore the ask.
  const otherAccount = !webAppKey || Boolean(web.signup || (web.selectAccount && web.selectAccount !== previousAccount));
  const plan = otherAccount
    ? { action: /** @type {const} */ ("signin"), rejected: false, expiring: false }
    : await planCliKeyAction({
      previous,
      storedKey,
      verify: (key) => verifyFireworksApiKey(key, { timeoutMs: 10_000 }),
      // login already checked this same key: don't ask the API again.
      checked: storedCheck && storedCheck.key === storedKey ? storedCheck.result : null,
      rotate,
    });
  if (plan.action === "keep") {
    return completeMintedSignIn(home, {
      mint: async () => ({
        ok: true,
        key: storedKey,
        keyId: previous.keyId,
        userName: previous.userName,
        displayName: previous.displayName,
        ...(previous.expiresAt ? { expiresAt: previous.expiresAt } : {}),
        reused: true,
      }),
      keyName,
      email: "",
      accountType: "nexus",
      fallbackAccountId: previousAccount,
      nextHint,
      say,
      report,
      verified: plan.check ?? null,
    });
  }
  // A web app older than version 3 only signs in: the old key stays (said so).
  const refresh = plan.action === "refresh" && version >= KEY_ACTIONS_VERSION;
  const { pasteCode: pasteFlag = "", ...webOptions } = web;
  const pasteCode = usePasteCode({ flag: pasteFlag, version });
  if (pasteFlag === "on" && !pasteCode) {
    say("This web app can't show a code to paste yet, so the browser has to reach this machine's sign-in port.");
  }
  // Storing runs while the browser waits, so its page says "signed in" only
  // once the key is saved here.
  let handled = false;
  let storeError = null;
  const finish = async (redeemed, { contested = () => false } = {}) => {
    const done = {};
    try {
      handled = await completeMintedSignIn(home, {
        mint: async () => redeemed,
        keyName,
        email: redeemed.email,
        // The web app only issues keys in Nexus accounts.
        accountType: "nexus",
        fallbackAccountId: redeemed.accountId,
        nextHint,
        say,
        report,
        done,
        // A refresh replaces this machine's own key: put it back if the
        // server never confirms the new one.
        rollback: refresh ? { key: storedKey, record: previous } : null,
        // What a contested sign-in puts back.
        contested,
        previousCredential: {
          key: storedKey,
          record: previous && storedKey && previous.keyFingerprint === apiKeyFingerprint(storedKey) ? previous : null,
          accountType: config.accountType ?? "unknown",
        },
      });
    } catch (error) {
      storeError = error;
    }
    return { ok: Boolean(done.signedIn) };
  };
  const result = await signInViaWebApp({
    onStatus: say,
    ...webOptions,
    ...(refresh ? {
      action: "refresh",
      keyId: previous.keyId,
      accountHint: previousAccount,
    } : {}),
    pasteCode,
    keyName,
    settle: async (fresh) => settleCliKey(fresh, {
      previous,
      plan,
      storedKey,
      refreshed: refresh,
      keysUrl: otherSignIn ? keysUrlFor(config.accountType) : keysUrl,
      otherSignIn,
    }),
    finish,
  });
  if (!result.ok) {
    reportError(report, result.error || "server_error", result.failure);
    if (result.fatal) {
      fail(`  ${result.failure} Run ${accent("nexus login")} to try again.`);
      return true;
    }
    say(result.failure);
    return false;
  }
  if (storeError) {
    throw storeError;
  }
  return handled;
}

/**
 * The accounts a browser sign-in can create its key in, narrowed to the kind
 * the user said they sign in with. When the sign-in has none of that kind,
 * login stops with a line saying where to go instead of creating the key in
 * an account of the other kind.
 * @param {{ accountNames: string[], nexusAccountNames: string[] }} listed
 * @param {"nexus" | "platform" | undefined} accountType
 * @returns {{ accountNames: string[], failure: string }}
 */
export function accountsForKind(listed, accountType) {
  if (accountType !== "nexus" && accountType !== "platform") {
    return { accountNames: listed.accountNames, failure: "" };
  }
  const nexus = new Set(listed.nexusAccountNames);
  const matching = listed.accountNames.filter((name) => nexus.has(name) === (accountType === "nexus"));
  if (matching.length || !listed.accountNames.length) {
    return { accountNames: matching, failure: "" };
  }
  return {
    accountNames: [],
    failure: accountType === "nexus"
      ? `No Nexus account is linked to this sign-in. Get a Nexus plan at ${link(WEB_SIGNUP_URL)}, `
        + `or run ${accent("nexus login")} again and pick 2 for your Fireworks Platform account.`
      : `No Fireworks Platform account is linked to this sign-in. Run ${accent("nexus login")} again `
        + "and pick 1 for your Nexus account, or sign in with the account you use at app.fireworks.ai.",
  };
}

/**
 * A check of the stored key that login already ran: `result` is
 * verifyFireworksApiKey's answer for `key`.
 * @typedef {{ key: string, result: { ok: boolean, reason: string } }} StoredKeyCheck
 */

/**
 * Browser sign-in. A Nexus account (or one not said yet) signs in only on the
 * web app; when the web app doesn't offer it (the probe answers no version 2 or later) or
 * it fails, interactive sign-in moves on to key paste. The web app's approval
 * page only lists Nexus accounts, so a Fireworks Platform account keeps the
 * Platform's hosted sign-in below.
 * @param {string} home
 * `storedCheck` is login's check of the stored key, reused rather than repeated.
 * @param {{ nextHint?: boolean, accountType?: "nexus" | "platform", rotate?: boolean, report?: SignInReport, json?: boolean, web?: WebFlowOptions, storedCheck?: StoredKeyCheck | null }} [options]
 * @returns {Promise<boolean>} true when handled (signed in, or a fatal stop).
 */
export async function runBrowserFlow(home, { nextHint = true, accountType, rotate = false, report, json = false, web = {}, storedCheck = null } = {}) {
  const say = (line) => console.log(`  ${line}`);
  console.log("");

  if (accountType !== "platform") {
    const version = await webAuthorizeVersion();
    if (!version) {
      const failure = "Browser sign-in isn't available right now. Try again in a moment.";
      reportError(report, "temporarily_unavailable", failure);
      say(failure);
    } else if (await runWebAppFlow(home, { nextHint, say, rotate, report, web, version, storedCheck })) {
      return true;
    }
    return false;
  }

  // Read before the sign-in stores the new key over it.
  const replaces = rotate ? await replacedCliKey(home) : null;
  const flows = [
    // The Fireworks Platform's hosted sign-in.
    () => signInViaLocalhostCallback({
      onStatus: say,
      keysUrl: keysUrlFor(accountType),
    }),
    // Offered only when the one-time code service answers.
    () => signInViaDeviceFlow({ onStatus: say, onStart: () => say("Let's try a one-time code instead.") }),
  ];

  let tokens = null;
  for (const flow of flows) {
    const result = await flow();
    if (result.ok) {
      tokens = result;
      break;
    }
    if (result.fatal) {
      fail(`  ${result.failure} Run ${accent("nexus login")} to try again.`);
      return true;
    }
    if (!result.silent) say(result.failure);
  }
  if (!tokens) {
    return false;
  }
  if (tokens.ssoAccountId) {
    return finishSsoSignIn(home, tokens, tokens.ssoAccountId, { nextHint, say, report, replaces });
  }

  const listed = await listAccountsForIdToken(tokens.idToken);
  let accountName = "";
  let accountFailure = "";
  if (!listed.ok) {
    accountFailure = listed.failure;
  } else if (listed.accountNames.length === 0) {
    accountFailure = BROWSER_SIGNIN_NO_ACCOUNT_FAILURE;
  } else {
    const { accountNames, failure } = accountsForKind(listed, accountType);
    if (failure) {
      accountFailure = failure;
    } else if (accountNames.length > 1) {
      const idx = await promptAccountChoice(accountNames);
      if (idx === null) {
        accountFailure = "Sign-in cancelled — no account selected.";
      } else {
        accountName = accountNames[idx];
      }
    } else {
      accountName = accountNames[0];
    }
  }

  if (accountFailure) {
    say(accountFailure);
    return false;
  }
  const completed = await completeMintedSignIn(home, {
    mint: (keyName) => mintApiKeyForAccount(tokens.idToken, accountName, { email: tokens.email, keyName }),
    idToken: tokens.idToken,
    email: tokens.email,
    accountName,
    accountType: listed.nexusAccountNames.includes(accountName) ? "nexus" : "platform",
    nextHint,
    say,
    report,
    replaces,
  });
  if (!completed) {
    return false;
  }
  return true;
}

/**
 * @param {string} home @param {string} accountId
 * `rotate` (the user asked for a new key) deletes this machine's previous
 * key once the new one works.
 * @param {{ nextHint?: boolean, report?: SignInReport, rotate?: boolean }} [options]
 * @returns {Promise<boolean>} true when handled (signed in, or a fatal stop).
 */
async function runSsoBrowserFlow(home, accountId, { nextHint = true, report, rotate = false } = {}) {
  const say = (line) => console.log(`  ${line}`);
  console.log("");
  const replaces = rotate ? await replacedCliKey(home) : null;

  const args = await resolveSignInOptions(accountId);
  if (!args.ok) {
    fail(`  ${args.failure}`);
    return true;
  }

  say(`Signing in through ${accent(accountId)}'s identity provider…`);
  const tokens = await signInViaLocalhostCallback({
    onStatus: say,
    cognitoDomain: args.cognitoDomain,
    clientId: args.clientId,
  });
  if (!tokens.ok) {
    if (tokens.fatal) {
      fail(`  ${tokens.failure} Run ${accent(`nexus login --account ${accountId}`)} to try again.`);
      return true;
    }
    say(tokens.failure);
    return false;
  }
  return finishSsoSignIn(home, tokens, accountId, { nextHint, say, report, replaces });
}

/** Join the custom-SSO account if needed, then mint and store its key. */
async function finishSsoSignIn(home, tokens, accountId, { nextHint, say, report, replaces = null }) {
  const jit = await createUserJit(tokens.idToken, accountId);
  if (!jit.ok) {
    fail(`  ${jit.failure}`);
    return true;
  }

  // Best-effort: an SSO sign-in names its account, so the list is only read
  // for the account kind; a failed or slow lookup leaves it unknown.
  // The request itself is aborted at the deadline, so a stalled response
  // can't keep the CLI running after sign-in.
  const listed = await listAccountsForIdToken(tokens.idToken, {
    signal: AbortSignal.timeout(ACCOUNT_KIND_TIMEOUT_MS),
  }).catch(() => null);
  const completed = await completeMintedSignIn(home, {
    mint: (keyName) => mintApiKeyForAccount(tokens.idToken, `accounts/${accountId}`, { email: tokens.email, keyName, ssoSignIn: true }),
    idToken: tokens.idToken,
    email: tokens.email,
    accountName: `accounts/${accountId}`,
    accountType: !listed?.ok ? "unknown"
      : listed.nexusAccountNames.includes(`accounts/${accountId}`) ? "nexus" : "platform",
    fallbackAccountId: accountId,
    rememberSsoAccountId: accountId,
    nextHint,
    say,
    report,
    replaces,
  });
  if (!completed) {
    return false;
  }
  return true;
}

/**
 * `nexus login --browser`: a Nexus account's browser sign-in only, no
 * chooser. There is no API-key fallback: a sign-in that doesn't finish fails.
 * @param {string} home
 * @param {{ nextHint?: boolean, rotate?: boolean, json?: boolean, report?: SignInReport, web?: WebFlowOptions }} [options]
 * @returns {Promise<boolean>} true when signed in.
 */
export async function runBrowserSignIn(home, { nextHint = true, rotate = false, json = false, report = {}, web = {} } = {}) {
  const handled = await runBrowserFlow(home, { nextHint, accountType: "nexus", rotate, report, json, web });
  if (report.signedIn) {
    return true;
  }
  if (handled) {
    return false;
  }
  reportError(report, "server_error", "Browser sign-in didn't complete.");
  fail(`Browser sign-in didn't complete. Run ${accent("nexus login")} to try again.`);
  return false;
}

/**
 * Asks which kind of account the user signs in with (unless `accountType` is
 * given); that kind picks the browser sign-in. Browser sign-in is the only
 * way in: there is no API-key fallback.
 * @param {string} home
 * `rotate` (the user asked for a new key) stops a Nexus browser sign-in from
 * keeping this machine's current key. `confirm` asks the remembered-SSO question.
 * @param {{ nextHint?: boolean, accountType?: "nexus" | "platform", rotate?: boolean, web?: WebFlowOptions, storedCheck?: StoredKeyCheck | null, confirm?: typeof promptYesNo }} [options]
 * @returns {Promise<boolean>}
 */
export async function runInteractiveSignIn(home, { nextHint = true, accountType: kind, rotate = false, web = {}, storedCheck = null, confirm = promptYesNo } = {}) {
  // A browser sign-in that stored and checked its key says so here, so it
  // isn't verified a second time.
  /** @type {SignInReport} */
  const report = {};
  // An account that signs in through its own identity provider refuses the
  // shared sign-in, so a remembered SSO account is offered first on re-login.
  const remembered = !kind ? (await readGlobalConfig(home)).ssoAccountId : "";
  if (remembered) {
    console.log("");
    const again = await confirm(
      `  Last time you signed in through ${accent(remembered)}'s company SSO. Use it again?`,
    );
    if (again === null) {
      // Ctrl-C leaves the cursor on the question's line.
      console.log("");
      fail(`Sign-in cancelled. Run ${accent("nexus login")} when you're ready.`);
      return false;
    }
    if (again) {
      const handled = await runSsoBrowserFlow(home, remembered, { nextHint, report, rotate });
      if (report.signedIn) {
        return true;
      }
      if (!handled) {
        fail(`Sign-in didn't finish. Run ${accent("nexus login")} to try again.`);
        return false;
      }
      return signInSucceeded(home);
    }
  }

  const accountType = kind ?? await promptAccountKind();
  if (!accountType) {
    fail(`Sign-in cancelled. Run ${accent("nexus login")} when you're ready.`);
    return false;
  }

  const handled = await runBrowserFlow(home, { nextHint, accountType, rotate, web, storedCheck, report });
  if (report.signedIn) {
    return true;
  }
  if (!handled) {
    fail(`Sign-in didn't finish. Run ${accent("nexus login")} to try again.`);
    return false;
  }

  return signInSucceeded(home);
}

/**
 * @param {string} home
 * @returns {Promise<boolean>}
 */
export async function signInSucceeded(home) {
  const stored = await resolveFireworksApiKeyValue({ apiKey: "", home });
  if (!stored) {
    return false;
  }
  const result = await verifyFireworksApiKey(stored);
  return result.ok || result.reason !== "rejected";
}

export { runSsoBrowserFlow };
