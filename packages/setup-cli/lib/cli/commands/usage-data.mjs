import process from "node:process";
import { resolveFireworksKeyWithSource } from "../../keys/api-key.mjs";
import { readMintedKeyState } from "../../keys/mint-api-key.mjs";
import { getShareNexusAnalytics, lookupUserNameForKey } from "../../fireworks/user-settings.mjs";

/**
 * `nexus usage-data`: a read-only command for the Nexus desktop app, which
 * never holds the Fireworks key. Its --json output is read by the app, so
 * keep its fields stable: test/cli/usage-data-command.test.mjs pins them, and
 * a change there needs a matching change in the app. Failures exit 1, and
 * messages never include the key, email or account ID.
 *
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
export async function runUsageDataCommand(ctx) {
  const result = await usageDataResult(ctx).catch(() => ({
    ok: false,
    code: "other",
    message: "Couldn't read your stored Fireworks key.",
  }));
  if (ctx.json) {
    console.log(JSON.stringify(result));
  } else if (result.ok) {
    console.log(`Analytics ID: ${result.nexusAnalyticsId ? "available" : "not available yet"}`);
  } else {
    console.error(result.message);
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

/**
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 * @returns {Promise<import("../../fireworks/user-settings.mjs").ShareNexusAnalyticsResult | { ok: false, code: string, message: string }>}
 */
async function usageDataResult(ctx) {
  const home = ctx.home || (process.env.HOME ?? "");
  const { key, source } = await resolveFireworksKeyWithSource({ apiKey: ctx.apiKey, home });
  if (!key) {
    return {
      ok: false,
      code: "not-signed-in",
      message: "Not signed in. Run nexus login to sign in.",
    };
  }

  const user = await resolveUserName(key, source, home);
  if (!user.ok) {
    return user;
  }
  return getShareNexusAnalytics(key, user.userName);
}

/**
 * Browser sign-in records the user the minted key belongs to, and storing any
 * other key clears that record, so it is current exactly when the stored key
 * is the one in use. Otherwise look the user up from the key itself.
 * @param {string} key
 * @param {import("../../keys/api-key.mjs").FireworksKeySource} source
 * @param {string} home
 */
async function resolveUserName(key, source, home) {
  if (source === "stored" && home) {
    const minted = await readMintedKeyState(home).catch(() => null);
    if (minted?.userName) {
      return { ok: true, userName: minted.userName };
    }
  }
  return lookupUserNameForKey(key);
}
