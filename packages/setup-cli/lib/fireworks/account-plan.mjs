import process from "node:process";

import { verifyFireworksApiKey } from "../keys/verify-api-key.mjs";
import { fireworksGatewayFetchSignal } from "./gateway-fetch.mjs";
import { FIREWORKS_GATEWAY_URL } from "./models.mjs";

// Plan tiers whose only Fireworks model is the `auto` mix.
const AUTO_ONLY_PLAN_TIERS = new Set(["PRO", "TEAMS"]);

/**
 * Whether the account's Nexus plan limits its coding catalog to the `auto`
 * mix: a Pro or Teams plan in any state, as the gateway gates it. Enterprise
 * and accounts without a plan are not limited. Never throws; a lookup that
 * could not get an answer (network, timeout, 429, 5xx) answers null, so callers
 * can tell it from an account without a plan. A rejected key or plan request
 * answers false: the gateway enforces the plan at inference.
 * `NEXUS_PLAN_CATALOG_FILTER=0` turns the check off.
 * @param {string} apiKey
 * @param {{ timeoutMs?: number }} [options] bounds the whole lookup; 0 keeps the gateway default.
 * @returns {Promise<boolean | null>}
 */
export async function planLimitsCatalogToAuto(apiKey, options = {}) {
  if (process.env.NEXUS_PLAN_CATALOG_FILTER === "0") {
    return false;
  }
  const plan = await fetchNexusPlan(apiKey, options);
  return planTierLimitsCatalogToAuto(plan ? plan.catalogTier : null);
}

/**
 * Whether a plan tier from {@link fetchNexusPlanTier} limits the catalog to
 * `auto`; null (no answer) stays null. `NEXUS_PLAN_CATALOG_FILTER=0` answers
 * false.
 * @param {string | null} tier
 * @returns {boolean | null}
 */
export function planTierLimitsCatalogToAuto(tier) {
  if (process.env.NEXUS_PLAN_CATALOG_FILTER === "0") {
    return false;
  }
  return tier === null ? null : AUTO_ONLY_PLAN_TIERS.has(tier);
}

/** No plan: an account without one, or a rejected key or plan request. */
const NO_PLAN = Object.freeze({ catalogTier: "", tier: "", state: "" });

/**
 * The account's Nexus plans, read two ways:
 * - `catalogTier`: the tier the gateway gates the catalog by, the newest
 *   plan that hasn't ended (else the newest ended one);
 * - `tier` and `state`: the plan in force for billing, an active one first,
 *   so a newer replacement waiting for payment doesn't hide it.
 * All "" for an account without a plan or a rejected key or plan request;
 * null when the lookup got no answer (network, timeout, 429, 5xx). Never
 * throws.
 * @param {string} apiKey
 * @param {{ timeoutMs?: number }} [options] bounds the whole lookup; 0 keeps the gateway default.
 * @returns {Promise<{ catalogTier: string, tier: string, state: string } | null>}
 */
export async function fetchNexusPlan(apiKey, { timeoutMs = 0 } = {}) {
  // Specs stay offline: they describe the account's plan tier and state, or
  // UNAVAILABLE for a failed lookup, instead. NEXUS_TEST_PLAN_CATALOG_TIER
  // sets the catalog's tier apart from the plan in force.
  if (process.env.NEXUS_TEST === "1") {
    const tier = process.env.NEXUS_TEST_PLAN_TIER ?? "";
    if (tier === "UNAVAILABLE") return null;
    return {
      catalogTier: process.env.NEXUS_TEST_PLAN_CATALOG_TIER ?? tier,
      tier,
      state: tier ? process.env.NEXUS_TEST_PLAN_STATE ?? "ACTIVE" : "",
    };
  }
  try {
    const gatewayUrl = process.env.NEXUS_GATEWAY_URL?.trim() || FIREWORKS_GATEWAY_URL;
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
    const verified = await verifyFireworksApiKey(apiKey, { gatewayUrl, timeoutMs, quiet: true });
    const accountId = String(verified?.accountId ?? "").trim().replace(/^accounts\//, "");
    if (!verified?.ok || !accountId) {
      return verified?.ok || isDefiniteRefusal(verified?.status) ? { ...NO_PLAN } : null;
    }
    const remainingTimeoutMs = deadline > 0 ? deadline - Date.now() : 0;
    if (deadline > 0 && remainingTimeoutMs <= 0) {
      return null;
    }
    const response = await fetch(`${gatewayUrl}/v1/accounts/${encodeURIComponent(accountId)}/nexusPlans`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: deadline > 0 ? AbortSignal.timeout(remainingTimeoutMs) : fireworksGatewayFetchSignal(),
    });
    if (!response.ok) {
      return isDefiniteRefusal(response.status) ? { ...NO_PLAN } : null;
    }
    const { nexusPlans } = await response.json();
    const plans = Array.isArray(nexusPlans) ? nexusPlans : [];
    const plan = planInForce(plans);
    const tier = typeof plan?.tier === "string" ? plan.tier : "";
    const catalogTier = currentPlan(plans)?.tier;
    return {
      catalogTier: typeof catalogTier === "string" ? catalogTier : "",
      tier,
      state: tier && typeof plan?.state === "string" ? plan.state : "",
    };
  } catch {
    return null;
  }
}

/** A 4xx other than 429: the gateway answered, and retrying won't change it. */
function isDefiniteRefusal(status) {
  return status >= 400 && status < 500 && status !== 429;
}

/** The plan the catalog is gated by: one that has not ended, else the newest ended one (the list is newest first). */
function currentPlan(plans) {
  return plans.find((plan) => plan?.state !== "ENDED") ?? plans[0];
}

/** States in which a plan is being paid for and used. */
const IN_FORCE_STATES = new Set(["ACTIVE", "CANCELING"]);

/**
 * The plan in force (the list is newest first): an active one, so a newer
 * replacement still waiting for payment doesn't hide it; else one that has
 * not ended; else the newest ended one.
 */
function planInForce(plans) {
  return plans.find((plan) => IN_FORCE_STATES.has(plan?.state))
    ?? plans.find((plan) => plan?.state !== "ENDED")
    ?? plans[0];
}
