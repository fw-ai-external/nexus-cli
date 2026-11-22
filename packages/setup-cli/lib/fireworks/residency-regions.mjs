// The data residencies Nexus can set harnesses up for, with the inference
// origin each must use. Only US has a public endpoint
// (https://docs.fireworks.ai/accounts/data-residency).
export const RESIDENCY_INFERENCE_ORIGINS = Object.freeze({
  US: "https://us.api.fireworks.ai",
});

/**
 * `value` as a residency Nexus supports, or "" for anything else.
 * @param {unknown} value
 * @returns {"US" | ""}
 */
export function supportedResidency(value) {
  const key = String(value ?? "").trim().toUpperCase();
  return Object.hasOwn(RESIDENCY_INFERENCE_ORIGINS, key) ? /** @type {"US"} */ (key) : "";
}
