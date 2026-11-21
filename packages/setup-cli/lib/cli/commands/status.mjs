import process from "node:process";
import { keyStatusSummary, keyStoreUnreadableError, resolveFireworksKeyWithSource } from "../../keys/api-key.mjs";
import { identityLabel, verifyFireworksApiKey } from "../../keys/verify-api-key.mjs";
import { detectEnvironment } from "../../system/environment.mjs";
import { accent } from "../../ui/term.mjs";
import { muted, primary, symbols } from "../../ui.mjs";
import { printBoolField, printField, printSectionHeader } from "../../harness/status-display.mjs";
import { harnessModelAccess } from "../../harness/engine.mjs";
import {
  formatBlockedModelsStatusNote,
  formatModelAccessUncheckedNote,
  staleCatalogDate,
} from "../../fireworks/model-access.mjs";
import { warn } from "../../ui.mjs";
import { listHarnesses } from "../../harness/registry.mjs";
import { detectInstalledHarnessesAsync } from "../../harness/detect.mjs";
import { harnessRows, printHarnessRows } from "./harnesses.mjs";
import { harnessKeyCurrent } from "../../keys/key-current.mjs";
import { activeKeySourceNote } from "../../keys/storage-report.mjs";
import {
  accountUnsupportedResidency,
  refreshAccountResidency,
  residencyInferenceHost,
  unsupportedResidencyNote,
} from "../../fireworks/residency.mjs";
import { readGlobalConfig } from "../../config/global-config.mjs";
import {
  apiKeyFingerprint,
  formatExpiry,
  keyExpiresSoon,
  readMintedKeyState,
} from "../../keys/mint-api-key.mjs";

/**
 * `nexus status`: report sign-in state, machine environment, and where
 * the key is stored.
 *
 * Combines a LIVE auth check (the active key validated against the gateway,
 * with an identity line), host environment (OS/distro/WSL, Node, shell), and the
 * static storage report (config ref, secret backend, per-harness runtime source). Exit 1 when not signed in or the key is
 * rejected, so scripts can gate on it; a key that can't be reached to verify
 * stays exit 0 (present, just unverifiable right now).
 *
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
export async function runStatusCommand(ctx) {
  const home = ctx.home || (process.env.HOME ?? "");
  if (!home) {
    throw new Error("HOME is not set; pass --home or set HOME");
  }

  const summary = await keyStatusSummary(home);
  // The global `harnesses[*].enabled` flag in ~/.nexus/config.json is not
  // reliably maintained (only Claude writes it; older CLI versions and several
  // adapters never flip it), so it drifts from ground truth. Override each
  // entry's `enabled` from the adapter's real config — the same source
  // `<harness> status` reports — so the summary reflects what's actually routed.
  const [connectedRows, installedIds] = await Promise.all([
    harnessRows(ctx, home),
    detectInstalledHarnessesAsync(home),
  ]);
  const installed = new Set(installedIds);
  const rows = connectedRows.map((row) => ({ ...row, installed: installed.has(row.id) }));
  const routed = new Set(rows.filter((row) => row.connected).map((row) => row.id));
  for (const h of summary.perHarness) {
    h.enabled = routed.has(h.id);
    // false also covers "can't tell on this platform" (see checkHarnessInstall).
    h.installed = installed.has(h.id);
  }
  // Present harnesses in stable registry order (claude, opencode, …).
  const adapters = listHarnesses();
  const byId = new Map(summary.perHarness.map((h) => [h.id, h]));
  summary.perHarness = adapters.map((a) => byId.get(a.id)).filter(Boolean);
  const environment = detectEnvironment({ home });
  const { key: active, source } = await resolveFireworksKeyWithSource({ apiKey: "", home });
  // Reuses the key resolved above (no second keychain read); only routed
  // harnesses are compared, and no key ever leaves harnessKeyCurrent. This
  // re-reads each routed harness's config (a sqlite3 read for Cursor, VS Code
  // and the Copilot app) — file reads only, in parallel.
  const harnessCtx = { ...ctx, home, settingsPath: "", configPath: "", dataDir: "" };
  // Each routed harness's configured models against the cached catalog
  // (file reads only, no network): which of them the account can't use.
  await Promise.all(adapters.map(async (adapter) => {
    const entry = byId.get(adapter.id);
    if (entry) {
      entry.keyCurrent = entry.enabled ? await harnessKeyCurrent(adapter, harnessCtx, active) : null;
      entry.modelAccess = entry.enabled
        ? await harnessModelAccess(adapter, harnessCtx, { activeKey: active ?? "" })
        : null;
    }
  }));
  const keyExpiresAt = source === "stored" && active ? await storedKeyExpiry(home, active) : "";

  // signedIn: true = verified; false = no key or rejected (exit 1);
  // null = a key is present but the API couldn't be reached (exit 0).
  /** @type {{ signedIn: boolean|null, email: string, accountId: string, reason: string, detail?: string }} */
  let auth;
  const unreadable = active ? null : keyStoreUnreadableError();
  if (unreadable) {
    auth = { signedIn: false, email: "", accountId: "", reason: "key-store-undecryptable", detail: unreadable.message };
  } else if (!active) {
    auth = { signedIn: false, email: "", accountId: "", reason: "no-key" };
  } else {
    const result = await verifyFireworksApiKey(active);
    if (result.ok) {
      auth = {
        signedIn: true,
        email: result.email,
        accountId: result.accountId,
        reason: "",
      };
    } else if (result.reason === "rejected") {
      auth = { signedIn: false, email: "", accountId: "", reason: "rejected", ...(keyExpired(keyExpiresAt) ? { detail: "expired" } : {}) };
    } else {
      auth = { signedIn: null, email: "", accountId: "", reason: "unreachable" };
    }
  }

  // The account's data residency decides which inference host its harnesses
  // must use. Read only for a verified key; a failed read keeps the cached one,
  // and with none it stays unknown (null): nothing is compared or advised.
  // The key was verified above, so its account ID skips a second check.
  const residency = auth.signedIn ? await refreshAccountResidency(active, { accountId: auth.accountId }) : null;
  const unsupportedResidency = residency === null ? accountUnsupportedResidency() : "";
  const harnessResidency = (await readGlobalConfig(home)).harnesses;
  for (const h of summary.perHarness) {
    // Azure routing doesn't call Fireworks endpoints, so residency doesn't apply.
    const entry = harnessResidency[h.id];
    h.residencyCurrent = h.enabled && residency !== null && entry?.provider !== "azure"
      ? (entry?.residency ?? "") === residency
      : null;
  }

  if (ctx.json) {
    console.log(JSON.stringify({
      auth,
      activeKeySource: source,
      // When the web app said when the stored key expires (ISO 8601), else null.
      keyExpiresAt: keyExpiresAt || null,
      environment,
      residency: residency === null
        ? null
        : { value: residency, inferenceHost: residencyInferenceHost(residency) || "api.fireworks.ai" },
      ...(unsupportedResidency ? { unsupportedResidency } : {}),
      ...summary,
    }, null, 2));
  } else {
    printAuthLine(auth, keyExpiresAt);
    printActiveKeyLine(source, summary);
    printKeyExpiry(keyExpiresAt, auth);
    if (residency) {
      printField("Data residency", `${residency} (inference on ${residencyInferenceHost(residency)})`);
    } else if (unsupportedResidency) {
      console.log(warn(unsupportedResidencyNote(unsupportedResidency)));
    }
    console.log("");
    printEnvironment(environment);
    console.log("");
    printStorage(summary, source);
    console.log("");
    printSectionHeader("Harnesses");
    printHarnessRows(rows);
    printBlockedModelLines(summary.perHarness, adapters);
    printResidencyMismatchLines(summary.perHarness, adapters, residency);
  }

  if (auth.signedIn === false) {
    process.exitCode = 1;
  }
}

/**
 * State, in one line, which key tools will use (the stored credential; a
 * shell FIREWORKS_API_KEY is never used).
 * @param {import("../../keys/api-key.mjs").FireworksKeySource} source
 * @param {Awaited<ReturnType<import("../../keys/api-key.mjs").keyStatusSummary>>} summary
 */
function printActiveKeyLine(source, summary) {
  if (source === "stored") {
    console.log(`Active key: stored credential — ${summary.backendLabel}.`);
  }
}

/**
 * When the stored key expires, from the record browser sign-in keeps (file
 * read only). "" when unknown or the record is for another key.
 * @param {string} home
 * @param {string} key
 */
async function storedKeyExpiry(home, key) {
  const minted = await readMintedKeyState(home).catch(() => null);
  return minted?.expiresAt && minted.keyFingerprint === apiKeyFingerprint(key) ? minted.expiresAt : "";
}

/** @param {string} expiresAt */
function keyExpired(expiresAt) {
  return Boolean(expiresAt) && Date.parse(expiresAt) <= Date.now();
}

/**
 * The stored key's expiry, and a warning in its last day.
 * @param {string} expiresAt
 * @param {{ signedIn: boolean|null }} auth
 */
function printKeyExpiry(expiresAt, auth) {
  if (!expiresAt || auth.signedIn === false) {
    return;
  }
  const remainingMs = Date.parse(expiresAt) - Date.now();
  if (remainingMs <= 0) {
    // Expired even if the API couldn't be reached to say so.
    printField("Key expires", `${expiresAt.slice(0, 10)} (expired)`);
    console.log(warn(`This machine's API key has expired. Run ${accent("nexus login")} to replace it.`));
    return;
  }
  const days = Math.ceil(remainingMs / 86_400_000);
  printField("Key expires", `${expiresAt.slice(0, 10)} (${days === 1 ? "in 1 day" : `in ${days} days`})`);
  if (keyExpiresSoon(expiresAt)) {
    console.log(warn(`This machine's API key expires ${formatExpiry(expiresAt)}. Run ${accent("nexus login")} to replace it.`));
  }
}

/**
 * @param {{ signedIn: boolean|null, email: string, accountId: string, reason: string, detail?: string }} auth
 * @param {string} [keyExpiresAt]
 */
function printAuthLine(auth, keyExpiresAt = "") {
  if (auth.signedIn === true) {
    console.log(formatSignedInLine(auth));
    return;
  }
  if (auth.reason === "no-key") {
    console.log(`Not signed in. Run ${accent("nexus login")} to sign in.`);
    return;
  }
  if (auth.reason === "key-store-undecryptable") {
    console.log(`Not signed in: the stored key can't be read.\n${auth.detail}`);
    return;
  }
  if (auth.reason === "rejected" && auth.detail === "expired") {
    console.log(`This machine's API key expired ${formatExpiry(keyExpiresAt)}. Run ${accent("nexus login")} to sign in again.`);
    return;
  }
  if (auth.reason === "rejected") {
    console.log(`A stored key was found, but the Fireworks API rejected it. Run ${accent("nexus login")} to replace it.`);
    return;
  }
  console.log("A Fireworks API key is stored, but the Fireworks API couldn't be reached to verify it.");
}

/**
 * @param {{ signedIn: boolean|null, email: string, accountId: string, reason: string }} auth
 */
function formatSignedInLine(auth) {
  const { email, accountId } = auth;
  const mark = primary(symbols.ok);
  if (email && accountId) {
    return `${mark} Signed in as ${email} (account: ${accountId}).`;
  }
  const who = identityLabel({ email, accountId });
  return who ? `${mark} Signed in as ${who}.` : `${mark} Signed in.`;
}

/**
 * @param {ReturnType<typeof detectEnvironment>} environment
 */
function printEnvironment(environment) {
  const distro = environment.os.distro?.prettyName ? ` — ${environment.os.distro.prettyName}` : "";
  const version = environment.cliVersion || "?";
  const gitInstall = environment.fireconnect.isGitInstall ? " (git install)" : "";

  printSectionHeader("Environment");
  printField("Platform", `${environment.kind} (${environment.os.platform}/${environment.os.arch})${distro}`);
  printField("Node", environment.node.version);
  printField("Shell", environment.shell || "(unknown)");
  printField("Nexus CLI", `v${version}${gitInstall}`);
}

/**
 * @param {Awaited<ReturnType<import("../../keys/api-key.mjs").keyStatusSummary>>} summary
 * @param {import("../../keys/api-key.mjs").FireworksKeySource} source
 */
function printStorage(summary, source) {
  printSectionHeader("Storage");
  printField("Config ref", summary.configRef);
  printField("Secret backend", summary.backendLabel);
  if (summary.location && summary.keychainPresent) {
    printField("Location", summary.location);
  }
  if (summary.backendError) {
    printField("Backend issue", summary.backendError);
  }
  printBoolField("Key stored", summary.keychainPresent);
  // Nexus never reads FIREWORKS_API_KEY; only say so when it explains a
  // missing key (someone exported one and expected Nexus to use it).
  if (source === "none" && summary.envPresent) {
    console.log(muted(activeKeySourceNote("")));
  }
  if (summary.backend === "file" && summary.keychainPresent) {
    console.log("");
    console.log(muted(
      "Sandbox/CI tip: file-config harnesses bake the API key into their config files. "
        + "To inject the stored key elsewhere, use `nexus key export`.",
    ));
  }
}

/**
 * One warning per routed harness whose configured models include ones the
 * account's served catalog doesn't list, and a muted line for a routed
 * harness whose models couldn't be checked.
 * @param {Array<{ id: string, modelAccess?: import("../../fireworks/model-access.mjs").ModelAccessReport | null }>} perHarness
 * @param {Array<{ id: string, modelAccessAdvice?: string }>} [adapters] advice when `on` isn't the fix
 */
function printBlockedModelLines(perHarness, adapters = []) {
  const lines = [];
  const adviceById = new Map(adapters.map((a) => [a.id, a.modelAccessAdvice]));
  for (const h of perHarness) {
    const report = h.modelAccess;
    if (report?.blocked?.length) {
      const advice = adviceById.get(h.id);
      const note = formatBlockedModelsStatusNote(h.id, report.blocked, {
        ...(advice ? { advice } : {}),
        asOf: staleCatalogDate(report),
      });
      lines.push(warn(`${h.id}: ${note}`));
    } else if (formatModelAccessUncheckedNote(report)) {
      lines.push(muted(`${h.id}: ${formatModelAccessUncheckedNote(report)}`));
    }
  }
  if (!lines.length) {
    return;
  }
  console.log("");
  for (const line of lines) {
    console.log(line);
  }
}

/**
 * One line per routed harness whose endpoint was written for another residency
 * than the account's now: its requests get 403 "region not allowed" until a
 * re-`on` rewrites it.
 * @param {Array<{ id: string, residencyCurrent?: boolean | null }>} perHarness
 * @param {Array<{ id: string, label: string }>} adapters
 * @param {string} residency
 */
function printResidencyMismatchLines(perHarness, adapters, residency) {
  const labels = new Map(adapters.map((a) => [a.id, a.label]));
  const host = residencyInferenceHost(residency) || "api.fireworks.ai";
  for (const h of perHarness) {
    if (h.residencyCurrent !== false) continue;
    console.log(warn(
      `${labels.get(h.id) ?? h.id} isn't set up for your account's data residency, so its requests may be refused `
      + `with "region not allowed". Run: nexus ${h.id} on (it will use ${host}).`,
    ));
  }
}
