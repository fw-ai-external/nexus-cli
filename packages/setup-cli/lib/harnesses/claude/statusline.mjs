/**
 * Claude Code status line: the Fireworks model actually being routed (plus the
 * applied FireRouter routing level when a firerouter slot is active), the last
 * call's generated-token rate, plus a cost computed from Fireworks rates.
 *
 * Claude Code's own `cost.total_cost_usd` prices every call against Anthropic's
 * list, so on a Fireworks gateway it reports a number the user is never billed.
 * The session transcript records the real model id and token usage per API call,
 * so the cost here is recomputed from it with the same engine `claude usage`
 * uses — which prices each call by its own model, and therefore stays correct
 * across a session that switched slots mid-flight.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { shellQuote } from "../../cli/path.mjs";
import { preferDataDirPath } from "../../system/data-dir.mjs";
import { stableNodeExec } from "../../system/node-exec.mjs";
import { keyExpiresSoon, readMintedKeyState } from "../../keys/mint-api-key.mjs";
import {
  appendLatestRouterSuffix,
  lookupModelSpec,
  resolveFireworksModelLabel,
  resolveSpecSlug,
  specShortIdFromModelRef,
} from "../../fireworks/model-specs.mjs";
import { lookupFireworksPricing } from "../../fireworks/pricing.mjs";
import { canonicalOpenAiModelId, isOpenAiPricedModelId, providerListPricing } from "../../demo/list-pricing.mjs";
import {
  firerouterRouteMembers,
  isAnthropicModelId,
  isAutoModelId,
  isClaudeNativeModel,
  isClosedFirerouterMember,
  isFirerouterModel,
  isFirerouterModelPattern,
} from "../../fireworks/model-id.mjs";
import { autoDisplayName, firerouterDisplayName, prettyModelName } from "../../fireworks/models.mjs";
import { stripViaFireworksSuffix } from "../../fireworks/label-suffix.mjs";
import { LOGO_CELLS_STATUS_LINE, besideLogo } from "../../ui/brand-logo.mjs";
import { truecolor } from "../../ui/palette.mjs";
import { terminalTheme } from "../../ui/color.mjs";
import { CLI_COLORS, DATA_COLORS } from "../../ui/tokens.mjs";
import { UNPRICED_TEXT, addUsage } from "./usage/cost.mjs";
import { readUltrafastBadge } from "./ultrafast-badge.mjs";
import {
  formatUsageCost,
  formatUsageCachePct,
} from "./usage/format.mjs";
import {
  claimSessionPriceHealing,
  sessionIdFromTranscript,
  spawnPriceRefresh,
  waitForPricedUsage,
} from "./statusline-refresh.mjs";

/** The helper Claude Code spawns on every status line refresh. */
function statusLineScript() {
  return preferDataDirPath(fileURLToPath(new URL("../../../bin/claude-statusline.mjs", import.meta.url)));
}

/** Substring that identifies a Nexus-managed statusLine command. */
const STATUSLINE_MARKER = "bin/claude-statusline.mjs";

/**
 * Shell command for the `statusLine.command` field.
 *
 * `process.execPath` rather than a bare `node`: Claude Code spawns the status
 * line through a shell whose PATH may not include the Node that runs the CLI
 * (same reason apiKeyHelper embeds it — see fireconnectExportCommand).
 */
export function claudeStatusLineCommand() {
  return `${shellQuote(stableNodeExec(process.execPath))} ${shellQuote(statusLineScript())}`;
}

/**
 * The `statusLine` block Nexus writes into settings.json.
 *
 * No `refreshInterval`: cost and the last call's rate only change when a call
 * completes, and Claude Code already re-runs the command on every assistant
 * message. A timer would re-read the transcript for unchanged numbers.
 */
export function claudeStatusLineSettings() {
  return { type: "command", command: claudeStatusLineCommand() };
}

/**
 * True when `statusLine` is one Nexus wrote (so `on` may replace it and
 * `off` may remove it). A user's own status line matches nothing here and is
 * left alone.
 * @param {unknown} statusLine
 */
export function isFireconnectStatusLine(statusLine) {
  if (!statusLine || typeof statusLine !== "object") {
    return false;
  }
  const command = /** @type {{ command?: unknown }} */ (statusLine).command;
  return typeof command === "string" && command.replaceAll("\\", "/").includes(STATUSLINE_MARKER);
}

/**
 * Add the managed status line, preserving a user's own.
 *
 * A stale Nexus command (absolute helper path from a previous install
 * location) is refreshed: after an upgrade/reinstall the old path no longer
 * exists, so keeping it would silently break the line.
 * @param {Record<string, unknown>} settings
 * @returns {Record<string, unknown>}
 */
export function withClaudeStatusLine(settings) {
  const current = claudeStatusLineSettings();
  if (Object.hasOwn(settings, "statusLine")) {
    if (!isFireconnectStatusLine(settings.statusLine)) {
      return settings;
    }
    if (settings.statusLine.command === current.command) {
      return settings;
    }
  }
  return { ...settings, statusLine: current };
}

/**
 * Remove the managed status line. Returns `{ settings, changed }` like the
 * sibling strip helpers in core.mjs so callers don't diff before and after.
 * @param {Record<string, unknown>} settings
 * @returns {{ settings: Record<string, unknown>, changed: boolean }}
 */
export function stripClaudeStatusLine(settings) {
  if (!isFireconnectStatusLine(settings?.statusLine)) {
    return { settings, changed: false };
  }
  const next = { ...settings };
  delete next.statusLine;
  return { settings: next, changed: true };
}

// Raw ANSI escapes (stdout is a pipe, not a TTY). Every SGR must end with `m`.
const BRAND_HEX = (CLI_COLORS[terminalTheme()] ?? CLI_COLORS.dark).primary;
const COLOR = process.env.NO_COLOR ? null : {
  bold: "\x1b[1m",
  primary: "\x1b[39m",
  secondary: "\x1b[2m\x1b[39m",
  accent: truecolor(BRAND_HEX),
  reset: "\x1b[0m",
};

// Data colors for bar segments and swatches only; text uses COLOR tokens above.
const SERIES_COLORS = Object.freeze([
  DATA_COLORS.teal,
  DATA_COLORS.coral,
  DATA_COLORS.green,
  DATA_COLORS.peach,
  DATA_COLORS.rose,
  DATA_COLORS.deepGreen,
  DATA_COLORS.blush,
  DATA_COLORS.sky,
  DATA_COLORS.amber,
  DATA_COLORS.flare,
].map(truecolor));

/** @param {keyof typeof COLOR} name @param {string} text */
function paint(name, text) {
  return COLOR ? `${COLOR[name]}${text}${COLOR.reset}` : String(text);
}

/** Blend `hex` toward `toward` (both #RRGGBB); amount is 0..1. */
function blendHex(hex, toward, amount) {
  const parse = (value) => Number.parseInt(value.slice(1), 16);
  const [from, to] = [parse(hex), parse(toward)];
  const channel = (shift) => Math.round(
    (((from >> shift) & 255) * (1 - amount)) + (((to >> shift) & 255) * amount),
  );
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Rate intensity rises with speed: brand, bold brand, then bold and brighter
 * (lighter on a dark terminal, darker on a light one). The number is always
 * readable; faster responses gain contrast.
 */
const RATE_TIERS = COLOR ? (() => {
  const theme = terminalTheme();
  const bright = blendHex(BRAND_HEX, theme === "light" ? "#000000" : "#FFFFFF", 0.35);
  return [
    { below: 500, sgr: truecolor(BRAND_HEX) },
    { below: 1_000, sgr: `\x1b[1m${truecolor(BRAND_HEX)}` },
    { below: Number.POSITIVE_INFINITY, sgr: `\x1b[1m${truecolor(bright)}` },
  ];
})() : null;

/** Paint a rate with the tier for its speed; plain text without color. */
function rateTier(tps) {
  // Tier on the displayed magnitude, so a 99.6 that reads "100" is not faint.
  const magnitude = tps >= 10 ? Math.round(tps) : tps;
  return RATE_TIERS?.find((entry) => magnitude < entry.below) ?? RATE_TIERS?.at(-1);
}

function paintRate(tps, text) {
  const tier = rateTier(tps);
  return tier ? `${tier.sgr}${text}${COLOR.reset}` : String(text);
}

/**
 * Five full-height cells, each shaded by how much of it is filled. Partial
 * block glyphs left the rest of their cell blank, which read as a gap; shade
 * density keeps the bar continuous and thick.
 */
const RATE_BAR_WIDTH = 5;
const RATE_BAR_MAX = 2_000;
const RATE_SHADES = ["▒", "▓", "█"];

function rateBar(tps) {
  // Square root, not linear: most real rates sit in the hundreds, and a linear
  // scale left them as a sliver. Full still means RATE_BAR_MAX.
  const ratio = Math.min(1, Math.max(0, tps / RATE_BAR_MAX));
  const filled = Math.sqrt(ratio) * RATE_BAR_WIDTH;
  let filledText = "";
  let emptyCount = 0;
  for (let cell = 0; cell < RATE_BAR_WIDTH; cell += 1) {
    const level = Math.min(1, Math.max(0, filled - cell));
    if (level <= 0) {
      emptyCount += 1;
      continue;
    }
    const shade = RATE_SHADES[
      Math.min(RATE_SHADES.length - 1, Math.floor(level * RATE_SHADES.length))
    ];
    filledText += shade;
  }
  const tier = rateTier(tps);
  const empty = "░".repeat(emptyCount);
  return tier
    ? `${tier.sgr}${filledText}${COLOR.reset}${paint("secondary", empty)}`
    : `${filledText}${empty}`;
}

/** A mark in a series hue: bar segment or swatch, never prose. */
function paintSeries(index, mark) {
  if (!COLOR) {
    return String(mark);
  }
  return `${SERIES_COLORS[index % SERIES_COLORS.length]}${mark}${COLOR.reset}`;
}

function sep() {
  return paint("secondary", "·");
}

/** Join non-empty parts with the dim separator. */
function joinParts(parts) {
  return parts.filter(Boolean).join(` ${sep()} `);
}

/**
 * The bar's fill glyph, doubling as the legend swatch so a legend entry reads as
 * a piece of the bar. Heavy horizontal rule (U+2501): unambiguous single-column
 * width in every terminal, unlike the square/circle glyphs legends usually use,
 * which are East-Asian-ambiguous and can render double-wide and misalign.
 */
const BAR_MARK = "━";

// Multiple rightwards arrows: the slot routed this turn to one of several
// models, rather than pinning one directly. Lone glyph so the status line's
// width goes to the model name.
const ROUTED_MODEL_MARK = "⇉";

/**
 * Stacked bar by spend share (not call count). Width only — no in-bar labels.
 * @param {Array<{ label: string, costShare: number }>} models largest first
 * @param {number} width total bar width in cells
 * @returns {string}
 */
function renderModelBar(models, width) {
  if (models.length === 0) {
    return "";
  }
  const gaps = models.length - 1;
  const inkWidth = Math.max(models.length, width - gaps);
  const widths = models.map((m) => Math.max(1, Math.round(m.costShare * inkWidth)));
  const drift = inkWidth - widths.reduce((sum, w) => sum + w, 0);
  if (drift !== 0) {
    widths[0] = Math.max(1, widths[0] + drift);
  }
  return models
    .map((model, index) => paintSeries(index, BAR_MARK.repeat(widths[index])))
    .join(" ");
}

/** Drop trailing parenthetical qualifiers when they fit the legend width. */
function compactModelLabel(label) {
  return String(label).replace(/\s*\([^)]*\)\s*$/, "").trim() || String(label);
}

/** True when `modelId` routes across multiple models per user turn (matches `firerouterTagline`). */
function isPerTurnRouterSlot(modelId) {
  if (isAutoModelId(modelId) || isFirerouterModel(modelId)) return true;
  const members = firerouterRouteMembers(modelId);
  return members.length > 1
    || (members.length === 1 && (isAutoModelId(members[0]) || isClosedFirerouterMember(members[0])));
}

/**
 * Human label for the routed model (mirrors picker naming without importing core.mjs).
 * @param {string} modelId
 * @returns {string}
 */
export function claudeStatusLineModelLabel(modelId) {
  const id = String(modelId ?? "").trim();
  if (!id) {
    return "unknown model";
  }
  if (isAutoModelId(id)) {
    return autoDisplayName(id);
  }
  // FireRouter compounds pin their own targets ("firerouter/astra" is the
  // Astra leg, not the bare router), so they read as the compound the
  // canonical display helper already builds. Bare `firerouter` renders as
  // "FireRouter" through that same helper, unchanged.
  if (isFirerouterModelPattern(id)) {
    return firerouterDisplayName(id);
  }
  const live = resolveFireworksModelLabel(id);
  if (live) {
    return stripViaFireworksSuffix(live);
  }
  const spec = lookupModelSpec(id);
  if (spec?.label) {
    return stripViaFireworksSuffix(appendLatestRouterSuffix(id, spec.label));
  }
  const pricing = lookupFireworksPricing(id);
  if (pricing?.label) {
    return stripViaFireworksSuffix(appendLatestRouterSuffix(id, pricing.label));
  }
  if (isAnthropicModelId(id)) {
    const anthropic = providerListPricing({ provider: "anthropic", modelId: id });
    if (anthropic?.label && !anthropic.estimated) {
      return anthropic.label;
    }
  }
  if (isOpenAiPricedModelId(id)) {
    const openai = providerListPricing({ provider: "openai", modelId: id });
    if (openai?.label && !openai.estimated) {
      return openai.label;
    }
  }
  const shortId = specShortIdFromModelRef(id) || id;
  if (!/(?:^|-)[a-z]?\d+p\d+(?:-|$)/.test(shortId)) {
    return shortId;
  }
  const withoutLatest = shortId.replace(/-latest$/, "");
  const region = withoutLatest.endsWith("-us") ? " (US)" : "";
  const base = withoutLatest.replace(/-us$/, "");
  return appendLatestRouterSuffix(id, `${prettyModelName(base)}${region}`);
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Fireworks-accurate usage for the session (parent + subagents).
 * @param {string} transcriptPath
 * @param {{ home?: string }} [opts]
 * @returns {Promise<{ cost: number, estimated: boolean, lastModel: string, tps: number | null, models: Array<{ label: string, share: number, calls: number, cost: number }>, cachePct: string } | null>}
 */
export async function claudeStatusLineUsage(transcriptPath, { home = process.env.HOME ?? "" } = {}) {
  const target = String(transcriptPath ?? "").trim();
  if (!target || !path.isAbsolute(target) || !await isFile(target)) {
    return null;
  }
  const { readClaudeUsage } = await import("./usage/report.mjs");
  const report = await readClaudeUsage({ home, session: target, includeTiming: true });
  const lastModel = report.currentTurnModel ?? report.rows.at(-1)?.model ?? "";
  const allRows = [
    ...report.rows,
    ...(report.subagents ?? []).flatMap((subagent) => subagent.rows),
  ];
  if (allRows.length === 0) {
    return null;
  }
  /** @type {Map<string, { calls: number, cost: number | null, input: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number }>} */
  const byModel = new Map();
  for (const row of allRows) {
    // OpenAI alias spellings (`astra`, `gpt-6`, `firerouter/astra`) name the
    // same rate-table row as `gpt-6-astra` but distinct spec slugs, so without
    // canonicalization one model renders as two legend rows.
    const sid = canonicalOpenAiModelId(row.model) ?? resolveSpecSlug(row.model);
    if (!sid) continue;
    const entry = byModel.get(sid)
      ?? {
        calls: 0,
        cost: 0,
        input: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      };
    byModel.set(sid, {
      ...entry,
      ...addUsage(entry, row),
      calls: entry.calls + 1,
    });
  }
  const totalCalls = allRows.length || 1;
  const modelTallies = [...byModel.values()];
  const hasUnpriced = modelTallies.some((entry) => entry.cost == null);
  const totalCost = modelTallies.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);
  const models = [...byModel.entries()]
    .sort((a, b) => (
      hasUnpriced
        ? b[1].calls - a[1].calls
        : (b[1].cost ?? 0) - (a[1].cost ?? 0) || b[1].calls - a[1].calls
    ))
    .map(([sid, entry]) => ({
      id: sid,
      label: claudeStatusLineModelLabel(sid),
      costShare: !hasUnpriced && totalCost > 0
        ? entry.cost / totalCost
        : entry.calls / totalCalls,
      share: entry.calls / totalCalls,
      calls: entry.calls,
      cost: entry.cost,
      cachePct: formatUsageCachePct(entry),
    }));
  return {
    cost: report.grandTotals.cost,
    estimated: report.estimated,
    lastModel,
    // The parent transcript's own last call: subagent logs carry their own
    // timing, but the line describes what the user just watched complete.
    tps: typeof report.lastCallDecodeTps === "number" ? report.lastCallDecodeTps : null,
    models,
    cachePct: formatUsageCachePct(report.grandTotals),
  };
}

const MODEL_BAR_WIDTH = 16;

/**
 * The last call's generated-token rate as status-line text, or "" when
 * unmeasured.
 *
 * Compact magnitudes at 1k/1M keep the segment a stable width, so a rate
 * crossing 999 -> 1000 does not shift everything after it. One decimal below
 * 10 so a slow model still reads as a rate rather than rounding to 0. Empty
 * (not "0 tok/s") when the transcript had no timing: the line omits figures it
 * cannot measure rather than making one up.
 * @param {number | null | undefined} tps
 * @returns {string}
 */
export function formatTokensPerSecond(tps) {
  if (typeof tps !== "number" || !Number.isFinite(tps) || !(tps > 0)) {
    return "";
  }
  const shown = tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10;
  if (shown >= 1_000_000) {
    return `${(shown / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (shown >= 1_000) {
    return `${(shown / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return shown > 0 ? String(shown) : "";
}

/** "5h", "45m": the time left on a key in its last day. */
function formatTimeLeft(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.ceil(minutes / 60)}h`;
}

/**
 * A warning for the key browser sign-in stored on this machine: in its last
 * day "key expires in 5h · run nexus login", after it "key expired · run nexus
 * login". Claude Code sends that key to Fireworks as is, and Fireworks only
 * says a rejected key is invalid, so this is where users learn what to do.
 * Reads the local sign-in record only (no keychain, no network); storing any
 * other key clears that record. Unlike `nexus status`, it can't check the
 * record's fingerprint against the key in use, because reading that key could
 * prompt the keychain on every turn. So it skips a record with no fingerprint
 * (written before fingerprints existed), which may describe a key this machine
 * no longer uses. "" otherwise, and on any error.
 * @param {string} home
 * @param {number} [now]
 * @returns {Promise<string>}
 */
export async function claudeStatusLineKeyExpiry(home, now = Date.now(), { short = false } = {}) {
  try {
    const minted = home ? await readMintedKeyState(home) : null;
    const expiresAt = minted?.keyFingerprint ? minted.expiresAt : "";
    if (!expiresAt || !keyExpiresSoon(expiresAt, now)) {
      return "";
    }
    const left = Date.parse(expiresAt) - now;
    const text = left > 0 ? `key expires in ${formatTimeLeft(left)}` : "key expired";
    if (short) return paint("accent", `⚠ ${text}`);
    return `${paint("accent", `⚠ ${text}`)} ${paint("secondary", "· run")} ${paint("primary", "nexus login")}`;
  } catch {
    return "";
  }
}

// Claude Code pads the status line by two columns each side, and the logo
// plus its gap takes nine more. Without COLUMNS, assume a common width.
const STATUS_LINE_INSET = 2 + 2 + [...LOGO_CELLS_STATUS_LINE[0]].length + 1;
const DEFAULT_STATUS_LINE_COLUMNS = 100;

/** Columns the status line's rows can use, from the COLUMNS Claude Code passes. */
export function claudeStatusLineWidth(env = process.env) {
  const columns = Number.parseInt(env.COLUMNS ?? "", 10);
  return (Number.isFinite(columns) && columns > 0 ? columns : DEFAULT_STATUS_LINE_COLUMNS) - STATUS_LINE_INSET;
}

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;]*m/g;

function visibleWidth(text) {
  return [...String(text).replace(SGR, "")].length;
}

/**
 * The two rows, fitted to `width`: the Ultra-fast badge and the key-expiry
 * warning lead the first row while they fit. When they don't, the warning
 * moves to the front of the second row (shortened to "⚠ key expires in 14h"
 * if that row would overflow), and then the badge drops its percentage.
 * Claude Code cuts what still doesn't fit with "…".
 * @param {{ badge: { share: string, left: string } | null, keyExpiry: string, shortKeyExpiry: string, usage: string[], legend: string[], width: number }} parts
 * @returns {[string, string]}
 */
export function fitClaudeStatusLineRows({ badge, keyExpiry, shortKeyExpiry, usage, legend, width }) {
  const fits = (text) => visibleWidth(text) <= width;
  let compact = false;
  let warningBelow = "";
  const rows = () => [
    joinParts([claudeStatusLineUltrafastBadge(badge, { compact }), warningBelow ? "" : keyExpiry, ...usage]),
    joinParts([warningBelow, ...legend]),
  ];
  if (!fits(rows()[0]) && keyExpiry) {
    warningBelow = keyExpiry;
    if (!fits(rows()[1])) warningBelow = shortKeyExpiry || keyExpiry;
  }
  if (!fits(rows()[0]) && badge) compact = true;
  return rows();
}

/**
 * "ϟ Ultra-fast 100%, 5h 00m left": the boost's name in orange, the share of
 * its window left in bold, then the time left. "" when no boost is on.
 * @param {{ share: string, left: string } | null} badge
 */
export function claudeStatusLineUltrafastBadge(badge, { compact = false } = {}) {
  if (!badge) return "";
  const name = COLOR ? `${COLOR.bold}${truecolor("#F2A866")}ϟ Ultra-fast\x1b[0m` : "ϟ Ultra-fast";
  const share = badge.share && !compact ? `${COLOR ? COLOR.bold : ""}${paint("primary", badge.share)}${COLOR ? "\x1b[0m" : ""}, ` : "";
  return `${name} ${share}${paint("primary", `${badge.left} left`)}`;
}

/**
 * Build the two-row status line from Claude Code's stdin payload.
 * @param {{
 *   model?: { id?: string, display_name?: string },
 *   transcript_path?: string,
 * }} input
 * @param {{ home?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function renderClaudeStatusLine(input = {}, { home = process.env.HOME ?? "" } = {}) {
  const slotModelId = input.model?.id ?? "";
  const slotLabel = isClaudeNativeModel(slotModelId)
    ? (input.model?.display_name || "Claude default")
    : claudeStatusLineModelLabel(slotModelId);

  let usage = null;
  try {
    usage = await claudeStatusLineUsage(input.transcript_path ?? "", { home });
  } catch {
    usage = null;
  }
  if (claimSessionPriceHealing({ home, transcriptPath: input.transcript_path ?? "", usage })) {
    // An unpriced model is in this session: warm the caches in a detached
    // runner and poll for the missing rates within a tight bound, so the line
    // prints dollars when the refresh is quick and never stalls when it is
    // not. Past the bound the runner keeps healing unfollowed and the next
    // turn is priced; the marker bounds the wait to one turn per session.
    // Healing must never break the render: any failure keeps stale usage.
    // (The claimed marker still bounds attempts to one per session.)
    try {
      const child = spawnPriceRefresh({
        home,
        sessionId: sessionIdFromTranscript(input.transcript_path ?? ""),
      });
    if (child) {
      // A failed heal resolves to null; keep the stale usage so the line
      // degrades to `cost n/a` instead of blanking.
      const healed = await waitForPricedUsage({
        readUsage: () => claudeStatusLineUsage(input.transcript_path ?? "", { home }),
        child,
      });
      if (healed != null) {
        usage = healed;
      }
    }
    } catch {
      // Keep stale usage; the next turn retries via a fresh marker.
    }
  }

  const multi = (usage?.models.length ?? 0) > 1;

  const bar = usage?.models.length
    ? renderModelBar(usage.models, MODEL_BAR_WIDTH)
    : "";
  const rawLabels = usage?.models.map((m) => m.label) ?? [];
  const compact = rawLabels.map(compactModelLabel);
  const labelCounts = new Map();
  for (const label of compact) {
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  const labels = compact.map((label, index) => (
    labelCounts.get(label) > 1 ? String(rawLabels[index]) : label
  ));

  const lastModel = usage?.lastModel?.trim() ?? "";
  const lastId = lastModel && lastModel !== "?"
    ? (canonicalOpenAiModelId(lastModel) ?? resolveSpecSlug(lastModel))
    : "";
  const isRouter = isPerTurnRouterSlot(slotModelId);
  const currentIndex = lastId && isRouter
    ? usage.models.findIndex((m) => m.id === lastId)
    : -1;
  // An unbilled latest call (zero usage so far) has no legend row yet: name it
  // from its own id, keeping the qualifier only if the compacted name would
  // collide with a billed legend row.
  const ownLabel = lastId ? claudeStatusLineModelLabel(lastId) : "";
  const routedLabel = currentIndex >= 0
    ? labels[currentIndex]
    : ownLabel && labels.includes(compactModelLabel(ownLabel)) ? ownLabel : compactModelLabel(ownLabel);
  const routedModel = bar && isRouter && routedLabel && (multi || currentIndex === -1)
    ? `${paint("accent", ROUTED_MODEL_MARK)} ${paint("primary", routedLabel)}`
    : "";
  const rate = formatTokensPerSecond(usage?.tps);
  // Gauge, then value: the bar shows relative speed at a glance, the number
  // supplies the measurement, and both gain contrast as the rate rises.
  const tps = rate
    ? `${rateBar(usage.tps)} ${paintRate(usage.tps, rate)} ${paint("primary", "TPS")}`
    : "";
  const now = Date.now();
  const keyExpiry = await claudeStatusLineKeyExpiry(home, now);
  const shortKeyExpiry = keyExpiry ? await claudeStatusLineKeyExpiry(home, now, { short: true }) : "";
  const usageParts = [
    bar || paint("secondary", slotLabel),
    usage && (usage.cost == null
      ? paint("secondary", `cost ${UNPRICED_TEXT}`)
      : `${usage.estimated ? "~" : ""}${COLOR ? COLOR.bold : ""}${paint("primary", formatUsageCost(usage.cost))}`),
    tps,
    routedModel,
  ];

  const legend = usage?.models.map((m, index) => {
    const label = labels[index];
    const cache = m.cachePct && m.cachePct !== "—" ? ` ${m.cachePct} cache` : "";
    const text = multi
      ? `${label} ${formatUsageCost(m.cost)}${cache}`
      : `${label}${cache}`;
    return `${paintSeries(index, BAR_MARK)} ${paint("primary", text)}`;
  }) ?? [];
  // The badge (while the account's Ultra-fast boost is on, recorded by the
  // banner mod) and the key-expiry warning lead, fitted to the terminal.
  const [line1, line2] = fitClaudeStatusLineRows({
    // HOME, or USERPROFILE where HOME isn't set (Windows), as the mod writes it.
    badge: await readUltrafastBadge(home || process.env.USERPROFILE || "", now),
    keyExpiry,
    shortKeyExpiry,
    usage: usageParts,
    legend,
    width: claudeStatusLineWidth(),
  });

  return withStatusLineLogo([line1, line2].filter(Boolean)).join("\n");
}

/**
 * Prefix the status line's two rows with the Fireworks symbol: two rows of
 * Braille cell art in the logo gradient, so the line keeps its height. It uses
 * the status-line mark (smaller, with an empty bottom dot row) because users
 * see it all the time.
 *
 * Claude Code strips inline-image escapes from status lines, so cell art is the
 * only way to draw the mark here. Skipped without color (bare dots read as
 * noise).
 * @param {string[]} lines
 * @returns {string[]}
 */
export function withStatusLineLogo(lines) {
  if (!COLOR) {
    return lines;
  }
  return besideLogo(lines, { gap: " ", cells: LOGO_CELLS_STATUS_LINE });
}
