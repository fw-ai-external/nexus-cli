import process from "node:process";
import {
  NEXUS_KEYS_URL,
  assertFireworksKeyUsable,
  persistApiKeyToKeychain,
  verifyFailureLine,
} from "../../keys/api-key.mjs";
import { activeKeySourceNote, assertBackendCanStore, keyStorageSummaryLine } from "../../keys/storage-report.mjs";
import { identityLabel } from "../../keys/verify-api-key.mjs";
import { printHarnessRows } from "../../cli/commands/harnesses.mjs";
import { HARNESS_COMMANDS } from "../../harness/id.mjs";
import { accent, bold, check, withSpinner } from "../../ui/term.mjs";

// Re-exported for the login flows/command that already import these from here.
export const KEYS_URL = NEXUS_KEYS_URL;
export { verifyFailureLine };

export function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

/**
 * Run a `--json` command (NDJSON): stdout carries only JSON lines, each with
 * a `type`, and the last is always `{"type":"result",...}`; everything for
 * people goes to stderr. `run` gets `emit` for progress events and returns
 * the result; `exitCode` on it overrides the default (0 ok, 1 failed).
 * `claimResult` lets a caller that may answer on its own (a signal handler)
 * make sure only one result line is ever written: the result is written only
 * if it returns true.
 * @param {(emit: (event: Record<string, unknown>) => void) => Promise<Record<string, unknown> & { exitCode?: number }>} run
 * @param {{ claimResult?: () => boolean }} [options]
 */
export async function runJsonCommand(run, { claimResult = () => true, closed = () => false } = {}) {
  // Swap the stream's write, not console.log: spinners and prompts write to
  // stdout directly.
  const { stdout, stderr } = process;
  const write = stdout.write;
  const line = (event) => write.call(stdout, `${JSON.stringify(event)}\n`);
  // Once the result line is claimed (a cancel answered first), no event may
  // follow it: the reader treats the result as the last line.
  const emit = (event) => {
    if (!closed()) line(event);
  };
  stdout.write = (...args) => stderr.write(...args);
  /** @type {Record<string, unknown> & { exitCode?: number }} */
  let result;
  try {
    result = await run(emit);
  } catch (error) {
    result = { ok: false, error: { code: "internal", message: error?.message ?? String(error) } };
  } finally {
    stdout.write = write;
  }
  // A caller that already answered (a cancel) owns the one result line.
  if (!claimResult()) {
    return;
  }
  const { exitCode, ...rest } = result;
  line({ type: "result", ...rest });
  process.exitCode = exitCode ?? (rest.ok ? 0 : 1);
}

/**
 * @param {string} home
 * @param {string} apiKey
 * @param {"nexus"|"platform"|"unknown"} [accountType]
 */
export async function storeApiKey(home, apiKey, accountType = "unknown", { mintedKey } = {}) {
  const { backend, message } = await keyStorageSummaryLine(home);
  await assertBackendCanStore(backend, home);
  /** @type {string[]} */
  const notes = [];
  /** @type {{ label: string, hint: string }[] | null} */
  let unconfirmed = null;
  // A new key refetches the model catalog (bounded, up to a few seconds).
  await withSpinner("Saving your key…", () => persistApiKeyToKeychain(home, apiKey, {
    backend,
    accountType,
    mintedKey,
    onNote: (line) => notes.push(line),
    onKeySync: (list) => { unconfirmed = list; },
  }));
  // The storage summary is only worth a line in the success block when it is
  // a warning (plaintext fallback). `nexus status` has the full picture.
  // `unconfirmed`: harnesses that may still send the previous key (null when
  // the harness sync didn't report).
  return { message: backend.backend === "plaintext" ? message : "", notes, unconfirmed };
}

/**
 * @param {import("../../keys/verify-api-key.mjs").VerifyResult} result
 */
function signedInLine(result) {
  const who = identityLabel(result);
  return who ? `${check()} Signed in as ${who}.` : `${check()} Signed in.`;
}

/**
 * @param {import("../../keys/verify-api-key.mjs").VerifyResult | { email: string, accountId: string }} result
 * @param {string[]} [notes]
 */
export function printSuccessBlock(result, notes = [], { nextHint = true } = {}) {
  console.log("");
  console.log(`  ${signedInLine(result)}`);
  for (const note of notes.filter(Boolean)) {
    console.log(`  ${note}`);
  }
  console.log(`  Remove it from this machine anytime with  ${accent("nexus logout")}`);
  console.log("");
  if (nextHint) {
    printNextSteps();
  }
}

function printNextSteps() {
  const featured = HARNESS_COMMANDS.filter((row) => row.featured)
    .map(({ command, name }) => ({ command: `nexus ${command}`, name }));
  console.log(`  ${bold("Next, connect a harness:")}`);
  printHarnessRows(featured, { indent: "    ", style: accent });
  console.log("");
  console.log(`  Using another harness? See them all with  ${accent("nexus status")}`);
}

/**
 * @param {string} home
 * @param {string} key
 * @param {"nexus"|"platform"|"unknown"} [accountType]
 */
export async function loginNonInteractive(home, key, accountType = "unknown") {
  if (!key) {
    fail("No key provided. Run nexus login --with-token < key.txt to sign in non-interactively.");
    return;
  }
  let result;
  try {
    result = await assertFireworksKeyUsable(key);
  } catch (error) {
    fail(error.message);
    return;
  }
  const stored = await storeApiKey(home, key, accountType);
  console.log(signedInLine(result));
  for (const note of [...stored.notes, activeKeySourceNote(key)].filter(Boolean)) {
    console.log(note);
  }
}
