/**
 * The Fetch API adapter the boost check uses (see fetchBoostStatus in
 * ../ultrafast-fireworks/hooks/rewards.mjs): a hard deadline, no redirects,
 * and the body read only up to the response cap. Shared by the status server
 * and `nexus login` (lib/harnesses/codex/ultrafast.mjs).
 */

import { MAX_RESPONSE_CHARS } from "../ultrafast-fireworks/hooks/rewards.mjs";

/** `fetch` for the boost check: a hard deadline, and the body read only up to the cap. */
export async function httpFetch(url, init, { timeoutMs = 10_000 } = {}) {
  const response = await fetch(url, { headers: init.headers, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  const headers = {};
  for (const [name, value] of response.headers) headers[name.toLowerCase()] = value;
  let text = "";
  if (response.body) {
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length > MAX_RESPONSE_CHARS) {
        text = text.slice(0, MAX_RESPONSE_CHARS + 1);
        break;
      }
    }
  }
  return { status: response.status, ok: response.ok, headers, text };
}
