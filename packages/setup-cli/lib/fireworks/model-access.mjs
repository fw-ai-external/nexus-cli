/**
 * Models an account may use, read off the served serverless catalog.
 *
 * The catalog `GET /v1/serverless/models` returns is per account: models (and
 * serving modes) the account can't use are left out of it. So the catalog the
 * CLI already caches is the list of allowed models, and a harness setting that
 * names a model outside it will be refused by the gateway. This module
 * compares configured models with that catalog, phrases the result, and
 * recognizes the gateway's Model Access refusal so callers can refresh the
 * catalog cache right away instead of waiting for the TTL.
 *
 * Nothing here rewrites harness settings: callers report, and `on` asks
 * before switching a model.
 */
import process from "node:process";
import {
  AUTO_MODEL_ID,
  NEXUS_AUTO_MODEL_ID,
  isAnthropicModelId,
  isAutoModelId,
  isFirerouterRouteRef,
  normalizeModelId,
  shortFireworksModelRef,
} from "./model-id.mjs";
import { catalogKeyFingerprint, catalogTtlMs, readCatalogCache } from "./serverless-catalog-cache.mjs";

// Custom (user-deployed) Fireworks models are served on the gateway but aren't
// listed in the public serverless catalog, so catalog checks let them through.
const CUSTOM_DEPLOYMENT_REF_RE = /^accounts\/[^/]+\/deployments\/[^/]+(\[1m\])?$/i;

/**
 * Whether a model id must resolve in the serverless catalog.
 * Gateway ids that are never catalog rows skip the check: rooted
 * `firerouter` routes, `auto` / `auto-*`, concrete Anthropic ids, and
 * private `accounts/…/deployments/…`. The Claude `claude-default` sentinel
 * is not one of those — only Claude Code understands it. Empty means the
 * harness default.
 * @param {string} modelId
 * @returns {boolean}
 */
export function isModelIdValidationApplicable(modelId) {
  if (!modelId) {
    return false;
  }
  const ref = shortFireworksModelRef(modelId);
  const servedOutsideCatalog = isFirerouterRouteRef(ref)
    || isAutoModelId(ref)
    || isAnthropicModelId(ref)
    || CUSTOM_DEPLOYMENT_REF_RE.test(ref);
  return !servedOutsideCatalog;
}

/**
 * The model `on` offers in place of ones the account can't use, picked from
 * the rows the API returned (never a list `auto` was added to): `auto` when
 * the catalog lists it, else the first served `-latest` alias (not a fast
 * one), else the first served model. "" when nothing qualifies, so nothing
 * is offered. `auto` is not assumed: an account's catalog can leave it out.
 * @param {Array<{ id?: string, shortId?: string }>} entries
 * @param {{ exclude?: string[] }} [options] models never to offer (the blocked ones)
 * @returns {string}
 */
export function pickReplacementModel(entries, { exclude = [] } = {}) {
  const rows = (entries ?? []).filter((entry) => typeof entry?.shortId === "string" && entry.shortId);
  const excluded = new Set(exclude.map(catalogRef));
  const usable = rows.filter((entry) => !excluded.has(entry.shortId));
  if (usable.some((entry) => entry.shortId === AUTO_MODEL_ID || shortFireworksModelRef(entry.id) === AUTO_MODEL_ID)) {
    return AUTO_MODEL_ID;
  }
  const concrete = usable.filter((entry) => !isAutoModelId(entry.shortId));
  const latest = concrete.find((entry) => entry.shortId.endsWith("-latest") && !entry.shortId.endsWith("-fast-latest"));
  const model = concrete.find((entry) => String(entry.id ?? "").includes("/models/"));
  return (latest ?? model)?.shortId ?? "";
}

/** Why a configured model can be missing from the account's catalog. */
export const MODEL_ACCESS_POLICY_HINT =
  "Your organization's Model Access policy may block it.";

/**
 * The gateway's refusal for a model the account's policy doesn't allow. Only
 * this wording counts: other 403s (a revoked key, a network policy, a request
 * whose model couldn't be resolved for the policy check) say nothing about
 * the catalog.
 */
const MODEL_ACCESS_DENIAL_RE = /model[- ]access policy does not allow/i;

/**
 * Whether an upstream response is a Model Access policy refusal.
 * @param {number} status
 * @param {string} body
 */
export function isModelAccessDenial(status, body) {
  return status === 403 && typeof body === "string" && MODEL_ACCESS_DENIAL_RE.test(body);
}

/**
 * The error for a `--model` the account's served catalog doesn't list. The
 * catalog only lists models this account may use, so a missing id is either
 * misspelled or blocked for the account. Most accounts have no policy, so
 * the spelling comes first.
 * @param {string} modelId
 */
export function modelNotAvailableMessage(modelId) {
  return `Model "${shortFireworksModelRef(modelId)}" isn't in this account's model list. `
    + "Check the spelling; if it's right, your organization's Model Access policy may block it. "
    + "Run `nexus model list --refresh` to see the models you can use.";
}

/**
 * The catalog-comparable form of a configured model id: short ref, no
 * context suffix.
 * @param {string} modelId
 */
function catalogRef(modelId) {
  return String(shortFireworksModelRef(normalizeModelId(String(modelId ?? "").trim())) ?? "")
    .replace(/\[1m\]$/i, "");
}

/**
 * The catalog form of a model id as a harness stores it. Harnesses spell
 * some ids their own way: the `auto` mix as `nexus-auto` (Hermes) or
 * `nexus/auto` (Cursor), and a selection as `fireworks/<id>` (Copilot CLI).
 * One place, so a new harness can't bring back a false "blocked".
 * Only for configured models: a `--model` value is matched as typed.
 * @param {string} modelId
 */
function configuredCatalogRef(modelId) {
  const raw = String(modelId ?? "").trim();
  const lower = raw.toLowerCase();
  if (lower === "nexus-auto" || lower === NEXUS_AUTO_MODEL_ID) {
    return AUTO_MODEL_ID;
  }
  const unqualified = /^fireworks\//i.test(raw) ? raw.slice("fireworks/".length) : raw;
  return catalogRef(unqualified);
}

/**
 * Whether `modelId` is a row of `catalog`, by short id or full resource name.
 * Matches the shortened ref, never only its last segment, so
 * `accounts/other/models/x` does not pass on the strength of a public `x`.
 * @param {string} modelId
 * @param {Array<{ id?: string, shortId?: string }>} catalog
 */
export function isModelInCatalog(modelId, catalog) {
  const ref = catalogRef(modelId);
  if (!ref) {
    return false;
  }
  return (catalog ?? []).some((entry) => entry?.shortId === ref || entry?.id === ref);
}

/**
 * The configured models the catalog doesn't serve. Ids served outside the
 * catalog (the `auto` mix, Anthropic models, custom deployments, and any the
 * harness names in `servedOutsideCatalog`) are never reported.
 * @param {Array<{ slot: string, model: string }>} configured
 * @param {Array<{ id?: string, shortId?: string }>} catalog
 * @param {{ servedOutsideCatalog?: (modelId: string) => boolean }} [options]
 * @returns {Array<{ slot: string, model: string }>}
 */
export function blockedConfiguredModels(configured, catalog, { servedOutsideCatalog } = {}) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    return [];
  }
  const seen = new Set();
  const blocked = [];
  for (const entry of configured ?? []) {
    const stored = typeof entry?.model === "string" ? entry.model.trim() : "";
    const model = configuredCatalogRef(stored);
    if (!model || !isModelIdValidationApplicable(model)) {
      continue;
    }
    if (servedOutsideCatalog?.(stored) || isModelInCatalog(model, catalog)) {
      continue;
    }
    const key = `${entry.slot}\u0000${model}`;
    if (!seen.has(key)) {
      seen.add(key);
      blocked.push({ slot: entry.slot, model });
    }
  }
  return blocked;
}

/**
 * @typedef {{
 *   checked: boolean,
 *   reason?: "nothing-configured" | "no-catalog" | "other-account",
 *   catalogUpdatedAt: string | null,
 *   stale?: boolean,
 *   blocked: Array<{ slot: string, model: string }>,
 * }} ModelAccessReport
 */

/**
 * Compare configured models with the cached catalog, for `status`. Reads the
 * disk cache under `home` only: no network, no key read, never throws.
 * `checked` is false (with a `reason`) when nothing is configured, when there
 * is no cached catalog, or when it was fetched with a key other than
 * `apiKey`, the key the harness sends: another account's catalog says nothing
 * about this one. Without an `apiKey` the cache is taken as the stored key's
 * (signing in refreshes it). `stale` is true when the catalog is older than
 * its refresh interval, so a policy change since may not show yet.
 * @param {Array<{ slot: string, model: string }>} configured
 * @param {{ servedOutsideCatalog?: (modelId: string) => boolean, home?: string, apiKey?: string }} [options]
 * @returns {ModelAccessReport}
 */
export function modelAccessReport(configured, { servedOutsideCatalog, home, apiKey } = {}) {
  const unchecked = (reason) => ({ checked: false, reason, catalogUpdatedAt: null, blocked: [] });
  if (!(configured ?? []).some((entry) => typeof entry?.model === "string" && entry.model.trim())) {
    return unchecked("nothing-configured");
  }
  try {
    const cache = readCatalogCache(home || undefined);
    const entries = cache?.snapshot?.entries ?? [];
    if (!entries.length) {
      return unchecked("no-catalog");
    }
    const key = typeof apiKey === "string" ? apiKey.trim() : "";
    if (key && cache.keyFingerprint && cache.keyFingerprint !== catalogKeyFingerprint(key)) {
      return unchecked("other-account");
    }
    return {
      checked: true,
      catalogUpdatedAt: cache.cachedAt > 0 ? new Date(cache.cachedAt).toISOString() : null,
      stale: !(cache.cachedAt > 0) || Date.now() - cache.cachedAt >= catalogTtlMs(),
      blocked: blockedConfiguredModels(configured, entries, { servedOutsideCatalog }),
    };
  } catch {
    return unchecked("no-catalog");
  }
}

/**
 * `<model> (<slot>)` for one blocked entry; the slot is left out when it is
 * the harness's only model.
 * @param {{ slot: string, model: string }} entry
 */
function describeBlocked({ slot, model }) {
  return slot && slot !== "main" ? `${model} (${slot})` : model;
}

/**
 * One sentence naming the blocked models.
 * @param {Array<{ slot: string, model: string }>} blocked
 */
export function formatBlockedModels(blocked) {
  const names = blocked.map(describeBlocked);
  const subject = names.length === 1 ? names[0] : names.join(", ");
  const verb = names.length === 1 ? "isn't" : "aren't";
  return `${subject} ${verb} available to this account. ${MODEL_ACCESS_POLICY_HINT}`;
}

/**
 * Status copy for a harness whose configured models include blocked ones.
 * @param {string} harnessCommand e.g. `claude`
 * @param {Array<{ slot: string, model: string }>} blocked
 */
export function formatBlockedModelsStatusNote(harnessCommand, blocked, {
  advice = `Run \`nexus ${harnessCommand} on\` to switch to an allowed model.`,
  asOf = "",
} = {}) {
  const when = asOf ? ` (per the model catalog from ${asOf}; run \`nexus model list --refresh\` to recheck)` : "";
  return `${formatBlockedModels(blocked)}${when} Requests to ${blocked.length === 1 ? "it" : "them"} will fail. ${advice}`;
}

/**
 * The status line for a report that couldn't be checked, or "" when there is
 * nothing to say (nothing configured, or it was checked).
 * @param {ModelAccessReport | undefined} report
 */
export function formatModelAccessUncheckedNote(report) {
  if (!report || report.checked) return "";
  if (report.reason === "no-catalog") {
    return "Model access: not checked, no model catalog is cached yet. Run `nexus model list --refresh`.";
  }
  if (report.reason === "other-account") {
    return "Model access: not checked, the cached model catalog belongs to another key. "
      + "Run `nexus model list --refresh`.";
  }
  return "";
}

/**
 * The day a stale report's catalog was fetched (`2026-11-08`), or "" when
 * the catalog is fresh.
 * @param {ModelAccessReport | undefined} report
 */
export function staleCatalogDate(report) {
  if (!report?.stale) return "";
  return report.catalogUpdatedAt ? report.catalogUpdatedAt.slice(0, 10) : "an earlier run";
}

/**
 * Whether a catalog has ever been cached here. `on` compares configured
 * models only then: a cold cache means a first `on` (nothing configured yet)
 * or no network, and the check must not add a wait to either.
 */
export function hasCachedCatalog() {
  try {
    return Boolean(readCatalogCache()?.snapshot?.entries?.length);
  } catch {
    return false;
  }
}

/** Whether `on` can ask a question: a terminal on both ends, outside tests. */
export function canPromptForModelSwitch(ctx = {}) {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
    && !ctx.quiet
    && process.env.NEXUS_TEST !== "1";
}

/**
 * On `on`, tell the user about configured models the account can't use and
 * ask whether to switch them to `replacement` (see {@link pickReplacementModel}).
 * Without a terminal (Nexus Desktop, scripts, upgrades) nothing is switched:
 * the settings are left as they are and the note says how to switch (one
 * short line on a quiet run). With no replacement to offer, the note says so
 * and nothing is asked. `ctx.askModelSwitch` stands in for the terminal
 * prompt (tests drive the yes path through it). Never throws.
 * @param {{
 *   ctx?: object,
 *   harnessCommand: string,
 *   blocked: Array<{ slot: string, model: string }>,
 *   replacement: string,
 *   switchCommand?: string,
 *   ask?: (question: string) => Promise<boolean | null>,
 *   note?: (message: string) => void,
 * }} args
 * @returns {Promise<boolean>} whether the user agreed to switch to `replacement`
 */
export async function offerModelAccessSwitch({
  ctx = {},
  harnessCommand,
  blocked,
  replacement,
  switchCommand = `nexus ${harnessCommand} on --model ${replacement}`,
  ask,
  note = (message) => process.stderr.write(`${message}\n`),
}) {
  if (!blocked?.length) {
    return false;
  }
  try {
    const summary = formatBlockedModels(blocked);
    const them = blocked.length === 1 ? "it" : "them";
    // A quiet run (an upgrade's re-`on`) still gets one line: it is the only
    // time the user hears about it before requests start failing.
    if (!replacement) {
      note(ctx.quiet
        ? `${summary} Run \`nexus model list --refresh\` to see the models you can use.`
        : `${summary} This account's catalog lists no model to switch to, so Nexus left your settings as they are. `
          + "Run `nexus model list --refresh` to see the models you can use.");
      return false;
    }
    if (!ask && typeof ctx.askModelSwitch !== "function" && !canPromptForModelSwitch(ctx)) {
      note(ctx.quiet
        ? `${summary} To switch, run: ${switchCommand}`
        : `${summary} Nexus left your settings as they are, so requests to ${them} will fail. `
          + `To switch, run: ${switchCommand}`);
      return false;
    }
    note(summary);
    const question = `Switch ${them} to ${replacement}?`;
    const answer = ask
      ? await ask(question)
      : typeof ctx.askModelSwitch === "function"
        ? await ctx.askModelSwitch(question)
      : await (await import("../auth/login/prompts.mjs")).promptYesNo(question);
    if (answer !== true) {
      note(`Kept as is. To switch later, run: ${switchCommand}`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
