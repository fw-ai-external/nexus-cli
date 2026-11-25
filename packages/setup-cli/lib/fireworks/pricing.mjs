import {
  FIREWORKS_PRICING_DOCS_URL,
  catalogCacheCandidates,
  resolveLiveRouterBaseModelId,
  specShortIdFromModelRef,
  lookupModelSpec,
  isUsableCachedServerlessPricing,
  lookupSpecPricing,
  resolveSpecSlug,
} from "./model-specs.mjs";
import { cachedNexusPlan, lookupCachedServerlessPricing } from "./serverless-catalog-cache.mjs";

export { FIREWORKS_PRICING_DOCS_URL };

function pricingCandidates(modelRef) {
  return catalogCacheCandidates(modelRef);
}

/**
 * @param {string} modelRef Full model/router ID or short ID.
 * @returns {{ slug: string, label: string, input: number, cachedInput: number, output: number, tier: string, source: string } | null}
 */
export function lookupFireworksPricing(modelRef) {
  for (const candidate of pricingCandidates(modelRef)) {
    const cached = lookupCachedServerlessPricing(candidate);
    if (isUsableCachedServerlessPricing(modelRef, cached)) {
      return cached;
    }
  }

  const spec = lookupModelSpec(modelRef);
  const pricing = lookupSpecPricing(modelRef);
  if (!pricing) {
    return null;
  }

  return {
    slug: resolveSpecSlug(modelRef),
    label: spec.label,
    ...pricing,
    tier: pricing.tier ?? "standard",
    source: FIREWORKS_PRICING_DOCS_URL,
  };
}

/** Plan tiers billed at the standard model's rates for Ultra-fast calls. */
const ULTRAFAST_AT_STANDARD_PLAN_TIERS = new Set(["PRO"]);
/** Plan states that don't count: an ended plan, or one not yet paid for. */
const PLAN_STATES_WITHOUT_STANDARD_PRICING = new Set(["ENDED", "PENDING_PAYMENT"]);

/**
 * Whether the account's Ultra-fast calls are billed at the standard model's
 * rates: its cached plan is Pro (Nexus Pass included) and in force.
 * `NEXUS_ULTRAFAST_STANDARD_PRICING=0` turns it off.
 * @returns {boolean}
 */
export function ultrafastPricedAtStandard() {
  if (process.env.NEXUS_ULTRAFAST_STANDARD_PRICING === "0") {
    return false;
  }
  const { tier, state } = cachedNexusPlan();
  return ULTRAFAST_AT_STANDARD_PLAN_TIERS.has(tier) && !PLAN_STATES_WITHOUT_STANDARD_PRICING.has(state);
}

/**
 * The standard-tier price of the model an Ultra-fast router or model serves:
 * the catalog's router base model, else the ref without its `-ultrafast`
 * suffix. Null when there is none, or it isn't priced at the standard tier.
 * @param {string} modelRef
 */
export function standardPricingForUltrafast(modelRef) {
  const shortId = specShortIdFromModelRef(modelRef);
  const candidates = [
    resolveLiveRouterBaseModelId(modelRef),
    shortId.endsWith("-ultrafast") ? shortId.slice(0, -"-ultrafast".length) : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const pricing = lookupFireworksPricing(candidate);
    if (pricing && pricing.tier === "standard") {
      return pricing;
    }
  }
  return null;
}

/** Minimal USD format for catalog rates: "$1.4", "$2", "$0.044".
Unknown/non-finite renders "—" (mirrors the catalog table + demo guards). */
export function formatUsd(value) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  const text = value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `$${text}`;
}

/** Compact in/out display for tables: "$1.40 / $4.40" */
export function formatPricingInOut(pricing) {
  if (!pricing) {
    return "—";
  }
  return `${formatUsd(pricing.input)} / ${formatUsd(pricing.output)}`;
}

/** Claude Code /model picker: "$2/$10 per Mtok" (input/output only). */
export function formatAnthropicStylePerMtok(pricing) {
  if (!pricing) {
    return null;
  }
  return `${formatUsd(pricing.input)}/${formatUsd(pricing.output)} per Mtok`;
}

export function attachPricing(modelRef) {
  const pricing = lookupFireworksPricing(modelRef);
  if (!pricing) {
    return null;
  }
  return {
    inputPerMillion: pricing.input,
    cachedInputPerMillion: pricing.cachedInput,
    outputPerMillion: pricing.output,
    tier: pricing.tier,
    label: pricing.label,
    source: pricing.source,
    display: formatPricingInOut(pricing),
  };
}

export const CLAUDE_CODE_PRICING_DISCLAIMER = (
  "Claude Code /model cost estimates use Anthropic list prices, not Fireworks. "
  + "Use nexus claude status or nexus model list for Fireworks rates."
);
