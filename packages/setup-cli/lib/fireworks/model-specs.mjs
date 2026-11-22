import {
  lookupCachedContextLength,
  lookupCachedInputModalities,
  lookupCachedRouterBaseModel,
  lookupCachedServerlessPricing,
  lookupCachedSupportsTools,
  lookupCatalogEntryById,
} from "./serverless-catalog-cache.mjs";
import { stripViaFireworksSuffix } from "./label-suffix.mjs";

/** @see https://docs.fireworks.ai/serverless/pricing */
export const FIREWORKS_PRICING_DOCS_URL = "https://docs.fireworks.ai/serverless/pricing";

/** Standard serverless model metadata keyed by short ID. Limits align with models.dev / pi-mono. */
export const FIREWORKS_MODEL_SPECS = {
  "deepseek-v4-pro": {
    label: "DeepSeek V4 Pro",
    pricing: { input: 1.32, cachedInput: 0.044, output: 3.96 },
    capabilities: { contextWindow: 1_000_000, maxOutputTokens: 384_000, vision: false, toolCalling: true },
  },
  "deepseek-v4-pro-0813": {
    label: "DeepSeek V4 Pro (0813)",
    pricing: { input: 1.32, cachedInput: 0.044, output: 3.96 },
    capabilities: { contextWindow: 1_000_000, maxOutputTokens: 384_000, vision: false, toolCalling: true },
  },
  "deepseek-v4-flash": {
    label: "DeepSeek V4 Flash",
    pricing: { input: 0.22, cachedInput: 0.007, output: 0.66 },
    capabilities: { contextWindow: 1_000_000, maxOutputTokens: 384_000, vision: false, toolCalling: true },
  },
  "deepseek-v4-flash-0731": {
    label: "DeepSeek V4 Flash (0731)",
    pricing: { input: 0.22, cachedInput: 0.007, output: 0.66 },
    capabilities: { contextWindow: 1_000_000, maxOutputTokens: 384_000, vision: false, toolCalling: true },
  },
  "deepseek-v4p1-flash": {
    label: "DeepSeek V4.1 Flash",
    pricing: { input: 0.30, cachedInput: 0.006, output: 1.20 },
    capabilities: { contextWindow: 1_048_576, maxOutputTokens: 384_000, vision: true, toolCalling: true },
  },
  "deepseek-v4p1-flash-us": {
    label: "DeepSeek V4.1 Flash (US)",
    pricing: { input: 0.45, cachedInput: 0.009, output: 1.80 },
    capabilities: { contextWindow: 1_048_576, maxOutputTokens: 384_000, vision: true, toolCalling: true },
  },
  "deepseek-v4p1-flash-1017": {
    label: "DeepSeek V4.1 Flash 1017",
    pricing: { input: 0.30, cachedInput: 0.006, output: 1.20 },
    capabilities: { contextWindow: 1_048_576, maxOutputTokens: 384_000, vision: true, toolCalling: true },
  },
  "deepseek-v4p1-flash-1017-us": {
    label: "DeepSeek V4.1 Flash 1017 (US)",
    pricing: { input: 0.45, cachedInput: 0.009, output: 1.80 },
    capabilities: { contextWindow: 1_048_576, maxOutputTokens: 384_000, vision: true, toolCalling: true },
  },
  "deepseek-v4p1-flash-1017-ultrafast": {
    label: "DeepSeek V4.1 Flash 1017 Ultra-fast",
    pricing: { input: 1.20, cachedInput: 0.024, output: 4.80, tier: "ultrafast" },
    capabilities: { contextWindow: 1_048_576, maxOutputTokens: 384_000, vision: true, toolCalling: true },
  },
  "glm-5p3": {
    label: "GLM 5.3",
    pricing: { input: 1.40, cachedInput: 0.26, output: 4.40 },
    capabilities: { contextWindow: 1_048_576, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "glm-5p3-flash": {
    label: "GLM 5.3 Flash",
    pricing: { input: 0.15, cachedInput: 0.03, output: 0.50 },
    capabilities: { contextWindow: 1_048_576, maxOutputTokens: 131_072, vision: true, toolCalling: true },
  },
  "glm-5p3-us": {
    label: "GLM 5.3 (US)",
    pricing: { input: 2.10, cachedInput: 0.39, output: 6.60 },
    capabilities: { contextWindow: 1_048_576, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "glm-5p3-flash-us": {
    label: "GLM 5.3 Flash (US)",
    pricing: { input: 0.225, cachedInput: 0.045, output: 0.75 },
    capabilities: { contextWindow: 1_048_576, maxOutputTokens: 131_072, vision: true, toolCalling: true },
  },
  "glm-5p2": {
    label: "GLM 5.2",
    pricing: { input: 1.40, cachedInput: 0.14, output: 4.40 },
    capabilities: { contextWindow: 1_048_575, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "glm-5p1": {
    label: "GLM 5.1",
    pricing: { input: 1.40, cachedInput: 0.26, output: 4.40 },
    capabilities: { contextWindow: 202_800, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "glm-5p1-fast": {
    label: "GLM 5.1 Fast",
    pricing: { input: 2.80, cachedInput: 0.52, output: 8.80, tier: "fast" },
    capabilities: { contextWindow: 202_800, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "glm-5p2-fast": {
    label: "GLM 5.2 Fast",
    pricing: { input: 2.10, cachedInput: 0.21, output: 6.60, tier: "fast" },
    capabilities: { contextWindow: 1_048_575, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "glm-5p3-fast": {
    label: "GLM 5.3 Fast",
    pricing: { input: 2.10, cachedInput: 0.39, output: 6.60, tier: "fast" },
    capabilities: { contextWindow: 1_048_576, maxOutputTokens: 131_072, vision: false, toolCalling: true },
  },
  "kimi-k3": {
    label: "Kimi K3",
    pricing: { input: 3.00, cachedInput: 0.30, output: 15.00 },
    capabilities: { contextWindow: 1_040_000, maxOutputTokens: 131_072, vision: true, toolCalling: true },
  },
  "kimi-k3-us": {
    label: "Kimi K3 (US)",
    pricing: { input: 4.50, cachedInput: 0.45, output: 22.50 },
    capabilities: { contextWindow: 1_040_000, maxOutputTokens: 131_072, vision: true, toolCalling: true },
  },
  "kimi-k3-fast": {
    label: "Kimi K3 Fast",
    pricing: { input: 4.50, cachedInput: 0.45, output: 22.50, tier: "fast" },
    capabilities: { contextWindow: 1_040_000, maxOutputTokens: 131_072, vision: true, toolCalling: true },
  },
  "kimi-k2p7-code": {
    label: "Kimi K2.7 Code",
    pricing: { input: 0.95, cachedInput: 0.19, output: 4.00 },
    capabilities: { contextWindow: 262_000, maxOutputTokens: 262_000, vision: true, toolCalling: true },
  },
  "kimi-k2p6": {
    label: "Kimi K2.6",
    pricing: { input: 0.95, cachedInput: 0.16, output: 4.00 },
    capabilities: { contextWindow: 262_000, maxOutputTokens: 262_000, vision: true, toolCalling: true },
  },
  "kimi-k2p6-fast": {
    label: "Kimi K2.6 Fast",
    pricing: { input: 2.00, cachedInput: 0.30, output: 8.00, tier: "fast" },
    capabilities: { contextWindow: 262_000, maxOutputTokens: 262_000, vision: true, toolCalling: true },
  },
  "kimi-k2p6-turbo": {
    label: "Kimi K2.6 Turbo",
    pricing: { input: 2.00, cachedInput: 0.30, output: 8.00, tier: "fast" },
    capabilities: { contextWindow: 262_000, maxOutputTokens: 262_000, vision: true, toolCalling: true },
  },
  "kimi-k2p5": {
    label: "Kimi K2.5",
    pricing: { input: 0.60, cachedInput: 0.10, output: 3.00 },
    capabilities: { contextWindow: 262_144, maxOutputTokens: 32_768, vision: true, toolCalling: true },
  },
  "minimax-m2p5": {
    label: "MiniMax 2.5",
    pricing: { input: 0.30, cachedInput: 0.03, output: 1.20 },
    capabilities: { contextWindow: 196_608, maxOutputTokens: 24_576, vision: false, toolCalling: true },
  },
  "minimax-m2p7": {
    label: "MiniMax 2.7",
    pricing: { input: 0.30, cachedInput: 0.06, output: 1.20 },
    capabilities: { contextWindow: 196_608, maxOutputTokens: 196_608, vision: false, toolCalling: true },
  },
  "minimax-m3": {
    label: "MiniMax M3",
    pricing: { input: 0.30, cachedInput: 0.06, output: 1.20 },
    capabilities: { contextWindow: 512_000, maxOutputTokens: 512_000, vision: true, toolCalling: true },
  },
  "qwen3p7-plus": {
    label: "Qwen 3.7 Plus",
    pricing: { input: 0.40, cachedInput: 0.08, output: 1.60 },
    capabilities: { contextWindow: 262_144, maxOutputTokens: 65_536, vision: true, toolCalling: true },
    api: { contextLength: 262_144, supportsImageInput: true },
  },
  "qwen3p6-plus": {
    label: "Qwen 3.6 Plus",
    pricing: { input: 0.50, cachedInput: 0.10, output: 3.00 },
    capabilities: { contextWindow: 262_144, maxOutputTokens: 32_768, vision: true, toolCalling: true },
  },
  "gpt-oss-120b": {
    label: "GPT-OSS 120B",
    pricing: { input: 0.15, cachedInput: 0.015, output: 0.60 },
    capabilities: { contextWindow: 131_072, maxOutputTokens: 32_768, vision: false, toolCalling: true },
  },
  "gpt-oss-20b": {
    label: "GPT-OSS 20B",
    pricing: { input: 0.07, cachedInput: 0.035, output: 0.30 },
    capabilities: { contextWindow: 131_072, maxOutputTokens: 32_768, vision: false, toolCalling: false },
  },
  inkling: {
    label: "Inkling",
    pricing: { input: 1.00, cachedInput: 0.17, output: 4.05 },
    capabilities: { contextWindow: 1_048_576, maxOutputTokens: 131_072, vision: true, toolCalling: true },
    modelsDev: false,
  },
  "nemotron-3-ultra-nvfp4": {
    label: "NVIDIA Nemotron 3 Ultra NVFP4",
    capabilities: { contextWindow: 262_144, maxOutputTokens: 32_768, vision: false, toolCalling: true },
  },
  firerouter: {
    label: "Nexus Auto",
    capabilities: {
      contextWindow: 1_048_575,
      maxOutputTokens: 131_072,
      vision: true,
      toolCalling: true,
    },
  },
  auto: {
    label: "Nexus Auto",
    capabilities: {
      contextWindow: 1_048_575,
      maxOutputTokens: 131_072,
      vision: true,
      toolCalling: true,
    },
  },
};

/**
 * Bare gateway slug for the default auto mix. Variants (`auto-instant`) share
 * the same no-resource-path rule: the gateway serves them under the slug, not
 * `accounts/fireworks/...`.
 */
export const AUTO_MODEL_ID = "auto";

/**
 * The `auto` mix as harnesses that can't use a bare `auto` name it (Cursor,
 * Codex). The gateway serves it as the same mix, so every harness that sends
 * it must use this one constant.
 */
export const NEXUS_AUTO_MODEL_ID = `nexus/${AUTO_MODEL_ID}`;

/** Retired latency-first auto mix. Still recognized (labels, pricing, migration of stored selections); no longer supported as a selection. */
export const AUTO_INSTANT_MODEL_ID = "auto-instant";

/**
 * Auto mixes to synthesize in `model list`. Acceptance is wider ({@link
 * canonicalAutoModelId} matches any `auto-*`); this list only controls which
 * names get a discoverable row when the serverless API omits them.
 */
export const KNOWN_AUTO_MODEL_IDS = [AUTO_MODEL_ID];

/** Cursor's built-in picker — not a Fireworks auto mix. */
const NON_GATEWAY_AUTO_IDS = new Set(["auto-smart"]);
export { NON_GATEWAY_AUTO_IDS };

/**
 * Canonical short slug for an auto mix (`auto`, `auto-instant`). Empty when
 * the ref is not an auto mix.
 *
 * Matched on the whole ref, never per path segment: a slash means the ref names
 * something else that merely contains an auto-shaped part (a custom
 * `accounts/auto-corp/...` resource, a `firerouter/auto-instant` selection), and
 * collapsing it to a bare mix slug would send the gateway the wrong model.
 * @param {string} model
 * @returns {string}
 */
export function canonicalAutoModelId(model) {
  if (typeof model !== "string") {
    return "";
  }
  const slug = model.replace(/\[1m\]$/i, "").trim().toLowerCase();
  if (!slug || slug.includes("/") || NON_GATEWAY_AUTO_IDS.has(slug)) {
    return "";
  }
  return slug === AUTO_MODEL_ID || slug.startsWith(`${AUTO_MODEL_ID}-`) ? slug : "";
}

/**
 * Whether a model reference is the `auto` mix or an `auto-*` variant
 * (`auto-instant`). Unrelated to `firerouter*`: these route open models only
 * and never need an Anthropic credential. Cursor-native `auto-smart` is not
 * matched.
 * @param {string} model
 * @returns {boolean}
 */
export function isAutoModelId(model) {
  return canonicalAutoModelId(model) !== "";
}

/** True when any path segment matches the `firerouter*` prefix. */
export function isFirerouterModelPattern(model) {
  if (typeof model !== "string") {
    return false;
  }
  return model.replace(/\[1m\]$/i, "")
    .trim()
    .toLowerCase()
    .split("/")
    .some((part) => part.startsWith("firerouter"));
}

export const DEFAULT_MODEL_CAPABILITIES = {
  vision: false,
  toolCalling: true,
};

export function specShortIdFromModelRef(modelRef) {
  if (!modelRef) {
    return "";
  }
  const stripped = modelRef.replace(/\[1m\]$/i, "");
  return stripped.split("/").at(-1) ?? stripped;
}

/** @param {string} modelRef */
export function routerCatalogIdCandidates(modelRef) {
  const stripped = String(modelRef ?? "").replace(/\[1m\]$/i, "");
  const shortId = specShortIdFromModelRef(modelRef);
  /** @type {string[]} */
  const candidates = [];
  if (stripped.includes("/routers/")) {
    candidates.push(stripped);
  }
  if (shortId) {
    candidates.push(`accounts/fireworks/routers/${shortId}`);
  }
  return [...new Set(candidates)];
}

/** Live base model for a router alias from the warmed serverless catalog, if known. */
export function resolveLiveRouterBaseModelId(modelRef) {
  for (const routerId of routerCatalogIdCandidates(modelRef)) {
    const baseModelId = lookupCachedRouterBaseModel(routerId);
    if (baseModelId) {
      return baseModelId;
    }
  }
  return null;
}

/** Append a serving-tier word ("Fast", "Ultra-fast") unless the label already ends with it. */
function appendTierLabel(label, tier) {
  const trimmed = stripViaFireworksSuffix(label);
  return trimmed.toLowerCase().endsWith(` ${tier.toLowerCase()}`) ? trimmed : `${trimmed} ${tier}`;
}

/** Display word for each non-standard serving tier a router can have. */
export const SERVING_TIER_LABELS = Object.freeze({ fast: "Fast", ultrafast: "Ultra-fast" });

/** True for Ultra-fast mode router slugs (`*-ultrafast`). */
export function isUltrafastShortId(shortId) {
  return Boolean(shortId?.endsWith?.("-ultrafast"));
}

/**
 * Whether a catalog entry is an Ultra-fast router: the row's own serving mode,
 * or the `-ultrafast` slug when the entry carries no mode.
 * @param {{ shortId?: string, serverlessMode?: string }} entry
 */
export function isUltrafastEntry(entry) {
  return entry?.serverlessMode === "ultrafast" || isUltrafastShortId(entry?.shortId);
}

/**
 * Whether `routerRef` is a serving-mode router (Fast, Ultra-fast, Turbo) of the
 * model `servedRef` names: the same model at its own rates. Reads the catalog's
 * router base model and pricing tier; a cold cache falls back to the slug
 * (`<model>-fast`, `<model>-ultrafast`, `<model>-turbo`).
 * @param {string} routerRef
 * @param {string} servedRef
 * @returns {boolean}
 */
export function isModeRouterOf(routerRef, servedRef) {
  const served = specShortIdFromModelRef(servedRef);
  const slugBase = specShortIdFromModelRef(routerRef).match(/^(.+)-(?:fast|ultrafast|turbo)$/)?.[1];
  const baseModelId = resolveLiveRouterBaseModelId(routerRef);
  if (!baseModelId) {
    return slugBase === served;
  }
  if (specShortIdFromModelRef(baseModelId) !== served) {
    return false;
  }
  // A router row without usable SKUs has no cached tier; its static spec or slug still names the mode.
  const tier = routerCatalogIdCandidates(routerRef)
    .map((routerId) => lookupCachedServerlessPricing(routerId)?.tier)
    .find(Boolean) ?? lookupModelSpec(routerRef)?.pricing?.tier;
  return Object.hasOwn(SERVING_TIER_LABELS, tier ?? "") || Boolean(slugBase);
}

/** True when the ref is a stable `-latest` router alias (incl. `-fast-latest`). */
export function isLatestRouterAlias(modelRef) {
  return specShortIdFromModelRef(modelRef).endsWith("-latest");
}

export function appendLatestRouterSuffix(modelRef, label) {
  if (!isLatestRouterAlias(modelRef)) {
    return label;
  }
  const trimmed = String(label).trim();
  return / \(Latest\)$/i.test(trimmed) ? trimmed : `${trimmed} (Latest)`;
}

/**
 * Human-readable label for a router entry from its resolved base model name.
 * Used while building the catalog before the serverless cache is active.
 * @param {string} routerId
 * @param {string} baseDisplayName
 * @param {{ pricingTier?: string }} [options]
 * @returns {string}
 */
export function resolveRouterEntryDisplayName(routerId, baseDisplayName, { pricingTier } = {}) {
  const shortId = specShortIdFromModelRef(routerId);
  const label = stripViaFireworksSuffix(baseDisplayName);
  if (shortId.endsWith("-turbo")) {
    return appendLatestRouterSuffix(routerId, label);
  }
  if (isUltrafastShortId(shortId) || pricingTier === "ultrafast") {
    return appendLatestRouterSuffix(routerId, appendTierLabel(label, SERVING_TIER_LABELS.ultrafast));
  }
  const needsFastTier = shortId.endsWith("-fast-latest")
    || shortId.endsWith("-fast")
    || shortId.endsWith("-fast-us")
    || pricingTier === "fast";
  const withTier = needsFastTier ? appendTierLabel(label, SERVING_TIER_LABELS.fast) : label;
  return appendLatestRouterSuffix(routerId, isUsRouterShortId(shortId) ? appendUsRegionLabel(withTier) : withTier);
}

/** True for a US-only router slug (`kimi-k3-us`, `glm-5p3-flash-us`). */
function isUsRouterShortId(shortId) {
  return String(shortId).endsWith("-us");
}

/**
 * Whether a ref names a US-only router (`kimi-k3-us`, `glm-5.3-flash-us`, even
 * spelled `accounts/fireworks/models/kimi-k3-us`), as opposed to a model whose
 * own id ends in `-us`. A `-us` slug is a router when the path says so, a US
 * spec names it, or the live catalog lists it as one.
 */
function isUsRouterRef(modelRef) {
  const shortId = String(specShortIdFromModelRef(modelRef)).toLowerCase();
  if (!isUsRouterShortId(shortId)) {
    return false;
  }
  return String(modelRef ?? "").includes("/routers/")
    || isRouterShortId(shortId)
    || isRouterShortId(resolveSpecSlug(modelRef));
}

/**
 * Whether a ref is a US router with no static spec of its own. US rates are
 * set per model, so such a router has no known price: its base model's global
 * rate never applies. Its base model's capabilities still do.
 */
function isUnpricedUsRouter(modelRef) {
  return isUsRouterRef(modelRef) && !isUsRouterShortId(resolveSpecSlug(modelRef));
}

/** Static rates for a ref, or null (see isUnpricedUsRouter). */
export function lookupSpecPricing(modelRef) {
  return isUnpricedUsRouter(modelRef) ? null : lookupModelSpec(modelRef)?.pricing ?? null;
}

/** Append " (US)" unless the label already ends with it. */
function appendUsRegionLabel(label) {
  const trimmed = String(label).trim();
  return / \(US\)$/i.test(trimmed) ? trimmed : `${trimmed} (US)`;
}

function fastSpecSlugForBase(baseSlug, routerShortId) {
  if (FIREWORKS_MODEL_SPECS[routerShortId]) {
    return routerShortId;
  }
  if (!routerShortId.endsWith("-fast-latest") && !routerShortId.endsWith("-fast")) {
    return baseSlug;
  }
  return baseSlug.endsWith("-fast") ? baseSlug : `${baseSlug}-fast`;
}

export function resolveSpecSlug(modelRef) {
  const shortId = specShortIdFromModelRef(modelRef);
  if (FIREWORKS_MODEL_SPECS[shortId]) {
    return shortId;
  }
  const folded = String(shortId).toLowerCase().replace(/(\d)\.(\d)/g, "$1p$2");
  if (folded !== shortId && FIREWORKS_MODEL_SPECS[folded]) {
    return folded;
  }
  const baseModelId = resolveLiveRouterBaseModelId(modelRef);
  if (baseModelId) {
    return fastSpecSlugForBase(specShortIdFromModelRef(baseModelId), shortId);
  }
  return shortId;
}

/**
 * Human-readable label from the live catalog base model when available.
 * @param {string} modelRef
 * @returns {string | null}
 */
export function resolveFireworksModelLabel(modelRef) {
  const shortId = specShortIdFromModelRef(modelRef);
  const routerSpec = FIREWORKS_MODEL_SPECS[shortId];
  if ((shortId.endsWith("-turbo") || shortId.endsWith("-us")) && routerSpec?.label) {
    return routerSpec.label;
  }
  const baseModelId = resolveLiveRouterBaseModelId(modelRef);
  if (!baseModelId) {
    return FIREWORKS_MODEL_SPECS[shortId]?.label ?? null;
  }

  const baseEntry = lookupCatalogEntryById(baseModelId);
  const label = baseEntry?.displayName
    ?? FIREWORKS_MODEL_SPECS[specShortIdFromModelRef(baseModelId)]?.label
    ?? null;
  if (!label) {
    // A model listed only through its router has no row of its own; the
    // router's row already carries the router's display name.
    return routerCatalogIdCandidates(modelRef)
      .map((routerId) => lookupCatalogEntryById(routerId)?.displayName)
      .find(Boolean) ?? null;
  }

  const routerPricing = routerCatalogIdCandidates(modelRef)
    .map((routerId) => lookupCachedServerlessPricing(routerId))
    .find(Boolean);
  return resolveRouterEntryDisplayName(
    routerCatalogIdCandidates(modelRef)[0] ?? `accounts/fireworks/routers/${shortId}`,
    label,
    { pricingTier: routerPricing?.tier },
  );
}

export function lookupModelSpec(modelRef) {
  if (isFirerouterModelPattern(modelRef)) {
    return FIREWORKS_MODEL_SPECS.firerouter;
  }
  if (isAutoModelId(modelRef)) {
    return FIREWORKS_MODEL_SPECS.auto;
  }
  const slug = resolveSpecSlug(modelRef);
  return FIREWORKS_MODEL_SPECS[slug] ?? null;
}

/**
 * Whether a bare short slug is a router (not a model). Suffix-based so new
 * `*-fast` / `*-ultrafast` / `*-latest` / `*-turbo` router slugs are classified
 * correctly without needing a hand-maintained list — `fullFireworksResourceId` relies on
 * this to pick `routers/` vs `models/`, so a stale list would mis-expand a
 * real router id to a non-existent `accounts/fireworks/models/...` path.
 * US-only router slugs (`kimi-k3-us`) carry no router suffix, so a static spec
 * for the slug is treated as a router too — every other spec key names a model
 * with a `models/` path, while the US spec keys name documented US routers.
 * So is a `-us` slug the live catalog lists as a router.
 * @param {string} shortId
 * @returns {boolean}
 */
export function isRouterShortId(shortId) {
  if (typeof shortId !== "string") {
    return false;
  }
  return shortId.startsWith("firerouter")
    || shortId.endsWith("-latest")
    || shortId.endsWith("-fast")
    || isUltrafastShortId(shortId)
    || shortId.endsWith("-turbo")
    || (isUsRouterShortId(shortId) && (
      Boolean(FIREWORKS_MODEL_SPECS[shortId])
      || Boolean(lookupCachedRouterBaseModel(`accounts/fireworks/routers/${shortId}`))
    ));
}

function canonicalResourceIdForCache(modelRef) {
  const stripped = String(modelRef ?? "").replace(/\[1m\]$/i, "").trim();
  if (!stripped) {
    return "";
  }
  if (stripped.startsWith("accounts/fireworks/")) {
    return stripped;
  }
  if (stripped.includes("/")) {
    return "";
  }
  const shortId = specShortIdFromModelRef(modelRef);
  if (isRouterShortId(shortId)) {
    return `accounts/fireworks/routers/${shortId}`;
  }
  return `accounts/fireworks/models/${shortId}`;
}

/** True when pricing lookups must resolve to fast-tier cache or static rates. */
export function requiresFastTierPricing(modelRef) {
  const shortId = specShortIdFromModelRef(modelRef);
  return shortId.endsWith("-fast-latest")
    || shortId.endsWith("-fast")
    || shortId.endsWith("-fast-us")
    || shortId.endsWith("-turbo");
}

/** True for Spot routers (`*-spot`), which bill their own discounted rates. */
export function requiresSpotTierPricing(modelRef) {
  return specShortIdFromModelRef(modelRef).endsWith("-spot");
}

/** True when cached pricing tier matches what a model/router ref expects. */
export function pricingMatchesModelRefTier(modelRef, pricing) {
  if (!pricing) {
    return false;
  }
  if (pricing.tier === "priority") {
    return false;
  }
  if (requiresSpotTierPricing(modelRef)) {
    return pricing.tier === "spot";
  }
  // Other mode tiers (spot, or a mode added later) only price their own
  // `*-<mode>` router, never a standard ref.
  if (pricing.tier && pricing.tier !== "standard" && pricing.tier !== "fast") {
    return specShortIdFromModelRef(modelRef).endsWith(`-${pricing.tier}`);
  }
  const wantsFast = requiresFastTierPricing(modelRef);
  return wantsFast ? pricing.tier === "fast" : pricing.tier !== "fast";
}

/** Usable live cache pricing for a ref; tier must match the ref's expectations. */
export function isUsableCachedServerlessPricing(modelRef, pricing) {
  // A US router is priced from its US spec only. The catalog never caches a
  // rate for one, and a rate an older catalog cached was its global model's.
  if (!pricing || (pricing.input <= 0 && pricing.output <= 0) || isUsRouterRef(modelRef)) {
    return false;
  }
  return pricingMatchesModelRefTier(modelRef, pricing);
}

/** Canonical cache keys for a model/router ref (short slug, full id, resolved spec). */
export function catalogCacheCandidates(modelRef) {
  const candidates = [modelRef];
  const canonical = canonicalResourceIdForCache(modelRef);
  if (canonical && canonical !== modelRef) {
    candidates.push(canonical);
  }
  for (const routerId of routerCatalogIdCandidates(modelRef)) {
    candidates.push(routerId);
  }
  const resolvedSlug = resolveSpecSlug(modelRef);
  candidates.push(`accounts/fireworks/models/${resolvedSlug}`);
  candidates.push(`accounts/fireworks/routers/${resolvedSlug}`);
  return [...new Set(candidates)];
}

function firstCachedContextLength(modelRef) {
  for (const candidate of catalogCacheCandidates(modelRef)) {
    const value = lookupCachedContextLength(candidate);
    if (value) {
      return value;
    }
  }
  return null;
}

function firstCachedInputModalities(modelRef) {
  for (const candidate of catalogCacheCandidates(modelRef)) {
    const value = lookupCachedInputModalities(candidate);
    if (value) {
      return value;
    }
  }
  return null;
}

function firstCachedSupportsTools(modelRef) {
  for (const candidate of catalogCacheCandidates(modelRef)) {
    const value = lookupCachedSupportsTools(candidate);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function firstCachedServerlessPricing(modelRef) {
  for (const candidate of catalogCacheCandidates(modelRef)) {
    const value = lookupCachedServerlessPricing(candidate);
    if (isUsableCachedServerlessPricing(modelRef, value)) {
      return value;
    }
  }
  return null;
}

export const DEFAULT_FIREWORKS_MODEL_LIMITS = {
  contextWindow: 1_000_000,
  maxTokens: 131_072,
  vision: false,
};

/** @param {{ vision?: boolean }} limits */
export function fireworksInputModalities(limits) {
  return limits?.vision ? ["text", "image"] : ["text"];
}

/** Harness-neutral context and modality limits for a Fireworks model or router. */
function resolveFireworksCatalogLimits(modelRef, {
  cachedContextLength,
  cachedModalities,
  specCapabilities,
}) {
  if (!specCapabilities && !cachedContextLength && !cachedModalities) {
    return { ...DEFAULT_FIREWORKS_MODEL_LIMITS };
  }
  return {
    contextWindow: cachedContextLength ?? specCapabilities?.contextWindow ?? DEFAULT_FIREWORKS_MODEL_LIMITS.contextWindow,
    maxTokens: specCapabilities?.maxOutputTokens ?? DEFAULT_FIREWORKS_MODEL_LIMITS.maxTokens,
    vision: cachedModalities
      ? cachedModalities.includes("image")
      : (specCapabilities?.vision ?? DEFAULT_FIREWORKS_MODEL_LIMITS.vision),
  };
}

/** Per-million-token cost block for Pi models.json `cost` fields. */
function resolveFireworksCatalogCost(modelRef, specPricing) {
  const pricing = firstCachedServerlessPricing(modelRef) ?? specPricing;
  if (!pricing) {
    return null;
  }
  return {
    input: pricing.input,
    output: pricing.output,
    cacheRead: pricing.cachedInput ?? 0,
    cacheWrite: 0,
  };
}

/** Per-million-token cost block for Pi models.json `cost` fields. */
export function lookupFireworksModelCost(modelRef) {
  const pricing = firstCachedServerlessPricing(modelRef)
    ?? lookupSpecPricing(modelRef);
  if (!pricing) {
    return null;
  }
  return {
    input: pricing.input,
    output: pricing.output,
    cacheRead: pricing.cachedInput ?? 0,
    cacheWrite: 0,
  };
}

/**
 * Canonical Fireworks catalog snapshot for a model/router ref.
 * Static specs and the warmed serverless cache are merged once here.
 * @param {string} modelRef
 * @returns {{
 *   limits: { contextWindow: number, maxTokens: number, vision: boolean },
 *   cost: { input: number, output: number, cacheRead: number, cacheWrite: number } | null,
 *   input: string[],
 *   toolCalling: boolean | null,
 *   cache: {
 *     contextLength: number | null,
 *     inputModalities: string[] | null,
 *     supportsTools: boolean | null,
 *   },
 * }}
 */
export function resolveFireworksCatalog(modelRef) {
  const spec = lookupModelSpec(modelRef);
  const cachedContextLength = firstCachedContextLength(modelRef);
  const cachedModalities = firstCachedInputModalities(modelRef);
  const cachedSupportsTools = firstCachedSupportsTools(modelRef);
  const limits = resolveFireworksCatalogLimits(modelRef, {
    cachedContextLength,
    cachedModalities,
    specCapabilities: spec?.capabilities,
  });
  return {
    limits,
    cost: resolveFireworksCatalogCost(modelRef, lookupSpecPricing(modelRef)),
    input: fireworksInputModalities(limits),
    toolCalling: cachedSupportsTools ?? spec?.capabilities?.toolCalling ?? null,
    cache: {
      contextLength: cachedContextLength,
      inputModalities: cachedModalities,
      supportsTools: cachedSupportsTools,
    },
  };
}

/** @param {string} modelRef */
export function lookupFireworksModelLimits(modelRef) {
  return resolveFireworksCatalog(modelRef).limits;
}

export const MODEL_API_OVERRIDES = Object.fromEntries(
  Object.entries(FIREWORKS_MODEL_SPECS)
    .filter(([, spec]) => spec.api)
    .map(([slug, spec]) => [`accounts/fireworks/models/${slug}`, spec.api]),
);
