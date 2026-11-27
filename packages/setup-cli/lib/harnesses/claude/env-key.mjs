/**
 * Dependency-light Claude Code environment key & helper ownership checks.
 * Shared by `core.mjs`, `statusline.mjs`, and `credit-standing.mjs` so the
 * status-line hot path stays free of heavy harness/config imports while using
 * the exact same precedence rules.
 */

import { fireworksKeyFromCustomHeaders } from "../../firerouter/custom-headers.mjs";
import { fireworksKeyOrEmpty } from "../../keys/key-type.mjs";

/**
 * Extract the active Fireworks key from Claude Code's settings environment:
 * the `X-Fireworks-Api-Key` line inside `ANTHROPIC_CUSTOM_HEADERS` first
 * (matching the gateway header precedence in `firerouter/core.mjs` and
 * `resolveClaudeAuthState`), then `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN`.
 * @param {{ env?: NodeJS.ProcessEnv | Record<string, string | undefined> }} [options]
 * @returns {string}
 */
export function claudeFireworksKeyFrom({ env = {} } = {}) {
  // X-Fireworks-Api-Key wins on the gateway over any x-api-key / Authorization
  // injected from ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.
  return fireworksKeyOrEmpty(fireworksKeyFromCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS))
    || fireworksKeyOrEmpty(env.ANTHROPIC_API_KEY)
    || fireworksKeyOrEmpty(env.ANTHROPIC_AUTH_TOKEN);
}

/**
 * Whether `helper` is Nexus's own apiKeyHelper — the one recorded at `on`, or
 * a `nexus`/`fireconnect` `key export` command — rather than the user's.
 * @param {unknown} helper
 * @param {{ managedApiKeyHelper?: string }} [state]
 * @returns {boolean}
 */
export function isNexusApiKeyHelper(helper, state = {}) {
  if (typeof helper !== "string" || !helper) {
    return false;
  }
  if (state.managedApiKeyHelper && helper === state.managedApiKeyHelper) {
    return true;
  }
  return /(?:^|[/\\])(?:fireconnect|nexus)(?:\.mjs|\.cmd)?['"]?(?:\s|$)/.test(helper)
    && /(?:^|\s)key\s+export(?:\s|$)/.test(helper);
}
