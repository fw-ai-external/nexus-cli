import { signInViaDeviceFlow, signInViaLocalhostCallback } from "../browser-auth.mjs";
import { getOAuthArgumentsForAccount } from "../sso-account.mjs";
import { keysUrlFor } from "../../keys/api-key.mjs";

export async function resolveSignInOptions(accountId) {
  const args = await getOAuthArgumentsForAccount(accountId);
  return args.ok
    ? { ok: true, cognitoDomain: args.cognitoDomain, clientId: args.clientId }
    : args;
}

/** Obtain a sign-in token without creating or storing an API key. Never throws. */
export async function signInForKeyManagement({ ssoAccountId = "", accountType, onStatus = () => {} } = {}, {
  localhost = signInViaLocalhostCallback,
  device = signInViaDeviceFlow,
  resolveSso = resolveSignInOptions,
} = {}) {
  try {
    const status = (line) => { try { onStatus(line); } catch {} };
    const options = ssoAccountId ? await resolveSso(ssoAccountId) : null;
    if (options && !options.ok) return options;
    const tokens = await localhost({
      onStatus: status,
      keysUrl: keysUrlFor(accountType),
      ...(options ?? { nexusSignInPage: accountType !== "platform", ssoSignIn: getOAuthArgumentsForAccount }),
    });
    if (tokens.ok || tokens.fatal || ssoAccountId) return tokens;
    return await device({ onStatus: status, onStart: () => status("Let's try a one-time code instead.") });
  } catch {
    return { ok: false, failure: "Browser sign-in did not finish." };
  }
}
