import {
  isModelAccessDenial,
  isModelIdValidationApplicable,
  isModelInCatalog,
  modelNotAvailableMessage,
} from "./model-access.mjs";
import { loadServerlessCatalog } from "./models.mjs";
import { fireworksInferenceUrl } from "./residency.mjs";

export { isModelIdValidationApplicable, modelNotAvailableMessage };

/**
 * Throw if any provided model id isn't a real Fireworks serverless model.
 *
 * Fetches the live serverless catalog once and checks every applicable id
 * against it. Validation is skipped (no throw) when:
 *   - no id needs validating (all empty / firerouter / custom deployment), or
 *   - the catalog fetch fails (offline) — we can't verify, so we don't block.
 *
 * @param {string[]} modelIds
 * @param {{ apiKey: string }} opts
 * @returns {Promise<void>}
 */
export async function assertRequestedModelsServable(modelIds, { apiKey } = {}) {
  const applicable = modelIds.filter(Boolean).filter(isModelIdValidationApplicable);
  if (applicable.length === 0) return;
  let catalog;
  try {
    ({ catalog } = await loadServerlessCatalog({ apiKey }));
  } catch {
    return; // offline / fetch failed — can't verify, don't block
  }
  if (!Array.isArray(catalog) || catalog.length === 0) return;
  for (const id of applicable) {
    // Match the shortened ref, not its last segment. A last-segment hit would
    // admit `fireworks/kimi-k3` or `accounts/acme/models/kimi-k3` whenever the
    // public slug is listed.
    if (!isModelInCatalog(id, catalog)) {
      throw new Error(modelNotAvailableMessage(id));
    }
  }
}

/** Single-id convenience wrapper around {@link assertRequestedModelsServable}. */
export function assertRequestedModelServable(modelId, opts) {
  return assertRequestedModelsServable([modelId], opts);
}
/**
 * Servability probe: catalog membership alone is not enough — the catalog
 * lists retired models (dated snapshots, superseded generations) with full
 * metadata and no flag, so the only retirement signal is a request: 404
 * "Model not found" at POST /inference/v1/messages. A Model Access policy
 * 403 means the account can't use it. Anything else (2xx, 429, other 4xx)
 * means the model serves. 16-token probe; call from setup paths
 * only (never a hot path); NEXUS_TEST gates real calls.
 * @param {string} modelId
 * @param {string} apiKey
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<boolean>}
 */
export async function probeModelServable(modelId, apiKey, { timeoutMs = 8_000, fetchImpl = fetch } = {}) {
  if (process.env.NEXUS_TEST === "1") return true;
  try {
    const res = await fetchImpl(fireworksInferenceUrl("https://api.fireworks.ai/inference/v1/messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: modelId, max_tokens: 8, messages: [{ role: "user", content: "ok" }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 403) {
      // The account's Model Access policy refuses this model: it serves, but
      // not for this account. Any other 403 is no verdict on the model.
      const body = await res.text().catch(() => "");
      return !isModelAccessDenial(res.status, body);
    }
    return res.status !== 404;
  } catch {
    return true; // network trouble is not a verdict; keep the model
  }
}

/**
 * Filter model ids to the servable ones, probing in parallel.
 * @param {string[]} modelIds
 * @param {string} apiKey
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<string[]>}
 */
export async function servableModels(modelIds, apiKey, options = {}) {
  const verdicts = await Promise.allSettled(modelIds.map((id) => probeModelServable(id, apiKey, options)));
  return modelIds.filter((_, i) => verdicts[i].status !== "fulfilled" || verdicts[i].value);
}
