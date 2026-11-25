/**
 * Pure logic for the Codex Ultra-fast footer and pet: no I/O.
 * statusline-server.mjs does the I/O; tests import this file directly.
 *
 * A boost is the shape `fetchBoostStatus` returns
 * (mods/ultrafast-fireworks/hooks/rewards.mjs): `{ active, activationId,
 * activatedAt, expiresAt, reason }`, with times in ms on this machine's clock
 * and either time possibly null.
 */

export const COLOR = Object.freeze({ amber: "#ffba50", text: "#ffffff", fg: "#e4e4eb", dim: "#8e8e9f", red: "#ff5f5f" });

// --- boost --------------------------------------------------------------------------------

/** No boost: plain footer, plain pet, no "ended" note. */
export const NO_BOOST = Object.freeze({ active: false, activationId: "", activatedAt: null, expiresAt: null, reason: "" });

const finiteOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * A boost status from untrusted JSON (the status cache on disk), or null when
 * it isn't one. Never throws.
 */
export function boostFromJson(value) {
  if (!value || typeof value !== "object" || typeof value.active !== "boolean") return null;
  const activatedAt = finiteOrNull(value.activatedAt);
  const expiresAt = finiteOrNull(value.expiresAt);
  if ((value.activatedAt != null && activatedAt == null) || (value.expiresAt != null && expiresAt == null)) return null;
  if (activatedAt != null && expiresAt != null && activatedAt > expiresAt) return null;
  return {
    active: value.active,
    activationId: typeof value.activationId === "string" ? value.activationId.slice(0, 256) : "",
    activatedAt,
    expiresAt,
    reason: typeof value.reason === "string" ? value.reason.slice(0, 200) : "",
  };
}

/** Whether `boost` is running at `now`. An active boost with no end runs until told otherwise. */
export function isRunning(boost, now) {
  if (!boost?.active) return false;
  return boost.expiresAt == null || boost.expiresAt > now;
}

/**
 * Share of the boost window left at `now`, 0..1: 0 when not running, 1 when
 * running without known start and end (an open window reads as full).
 */
export function remaining(boost, now) {
  if (!isRunning(boost, now)) return 0;
  const { activatedAt, expiresAt } = boost;
  if (activatedAt == null || expiresAt == null) return 1;
  const total = expiresAt - activatedAt;
  return total > 0 ? Math.min(1, Math.max(0, (expiresAt - now) / total)) : 1;
}

/** "5h 00m", "47m", "<1m". */
export function timeLeft(ms) {
  const minutes = Math.ceil(ms / 60_000);
  if (!(minutes >= 1)) return "<1m";
  const h = Math.floor(minutes / 60);
  return h ? `${h}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

/**
 * "10:20 PT": the wall-clock time in the given (default: this process's) time
 * zone, 12-hour without AM/PM since the note only shows for minutes, then the
 * zone's short name ("PT", "ET"; "GMT+1" where the generic name is long).
 */
export function localClock(ms, timeZone = undefined) {
  const date = new Date(ms);
  const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).formatToParts(date);
  const get = (list, type) => list.find((part) => part.type === type)?.value ?? "";
  let zone = "";
  for (const timeZoneName of ["shortGeneric", "short"]) {
    try {
      zone = get(new Intl.DateTimeFormat("en-US", { timeZoneName, timeZone }).formatToParts(date), "timeZoneName");
      if (zone && !zone.includes(" ")) break;
    } catch {}
  }
  return `${get(parts, "hour")}:${get(parts, "minute")}${zone ? ` ${zone}` : ""}`;
}

// --- pet ------------------------------------------------------------------------------------
// Nexus's pet sheet (lib/ui/brand/codex-pet/spritesheet.png, 8x9 cells, the
// size Codex requires) keeps the dotted Fireworks logo in cell 0 and its
// working pops in 56..59. scripts/render-codex-ultrafast-pet.mjs paints the
// boost tile into these cells:

export const PET_FRAME_COUNT = 72;
export const LEVELS = 8;
export const TILE = Object.freeze({
  flash: 1,
  rise: Object.freeze([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), // liquid rising to (i + 1) / 10, with sparkles
  levelBase: 12, // level n (1..8), surface frame w (0..2): 12 + 3 * (n - 1) + w
  low: Object.freeze([36, 37, 38]), // almost empty: embers; 38 has the bolt greyed (the blink)
});
/** Under this share left, the tank reads as out: embers and a blinking bolt. */
export const LOW = 0.08;

/** The three surface frames for fill level 1..8. */
export function levelFrames(level) {
  const n = Math.min(LEVELS, Math.max(1, Math.trunc(level)));
  return [0, 1, 2].map((wave) => TILE.levelBase + 3 * (n - 1) + wave);
}

/** The fill level (1..8) for a share left above LOW. */
export function fillLevel(left) {
  return Math.min(LEVELS, Math.max(1, Math.ceil(left * LEVELS)));
}

export const PET_BASE = Object.freeze({
  id: "fireworks-nexus",
  displayName: "Fireworks Nexus",
  description: "The Fireworks symbol. Lights up while Codex works on Fireworks.",
  spritesheetPath: "spritesheet.png",
  frame: Object.freeze({ width: 192, height: 208, columns: 8, rows: 9 }),
});

/**
 * Today's pet: the dotted logo, popping while Codex works. Codex also defines
 * `running-right`, `running-left`, `waving` and `jumping` over sheet rows 1..4,
 * where the boost tile now lives, so every manifest pins them to the logo.
 */
const LOGO = Object.freeze({ frames: [0] });
const EXTRA = Object.freeze({ "running-right": LOGO, "running-left": LOGO, waving: LOGO, jumping: LOGO });
export const PLAIN_ANIMATIONS = Object.freeze({
  idle: LOGO,
  running: Object.freeze({ frames: [56, 57, 58, 59], fps: 4, loop: true }),
  waiting: LOGO,
  review: LOGO,
  failed: LOGO,
  ...EXTRA,
});

/**
 * The pet manifest for the boost at `now`. Codex reads it when the pet loads
 * (launch, or /pet), so during a boost a launch plays the tile flashing and
 * filling to the current level (non-looping, then `level` loops); the state
 * animations restart on every pet state change, so all of them show the level.
 */
export function petManifest(boost, now) {
  const left = remaining(boost, now);
  if (!(left > 0)) return { ...PET_BASE, animations: PLAIN_ANIMATIONS };
  let level, rise;
  if (left < LOW) {
    level = { frames: [36, 37, 36, 37, 36, 38, 36, 38, 36, 37], fps: 4, loop: true };
    rise = [TILE.flash, TILE.flash, 36];
  } else {
    const n = fillLevel(left);
    level = { frames: levelFrames(n), fps: 3, loop: true };
    const steps = Math.max(2, Math.min(TILE.rise.length, Math.round((n / LEVELS) * TILE.rise.length)));
    rise = [TILE.flash, TILE.flash, ...TILE.rise.slice(0, steps)];
  }
  return {
    ...PET_BASE,
    animations: {
      idle: { frames: rise, fps: 8, loop: false, fallback: "level" },
      level,
      running: { ...level, fps: level.fps * 2 },
      waiting: level,
      review: level,
      failed: level,
      ...EXTRA,
    },
  };
}

// --- terminal display width ----------------------------------------------------------------

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\u200b-\u200d\ufe00-\ufe0f]$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
function isWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f)
    || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd);
}
/** Terminal columns `text` occupies: wide CJK and emoji count 2, combining marks 0. */
export function displayWidth(text) {
  let n = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || ZERO_WIDTH.test(ch)) continue;
    n += isWide(cp) || (cp > 0xffff && PICTOGRAPHIC.test(ch)) ? 2 : 1;
  }
  return n;
}
/** `text` cut to at most `max` columns, ending in "…" when cut ("" when max < 1). */
export function truncate(text, max) {
  const s = String(text);
  if (displayWidth(s) <= max) return s;
  if (max < 1) return "";
  let out = "";
  for (const ch of s) {
    if (displayWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** Text from the snapshot or the backend goes to the terminal: one printable line. */
export function oneLine(value, max = 200) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// --- footer --------------------------------------------------------------------------------

/** Codex's UI tree collapses runs of ASCII spaces, so layout spaces are U+00A0. */
const NB = (s) => s.replace(/ /g, " ");
const node = (text, color, bold) => ({ type: "text", props: { color, weight: bold ? "bold" : undefined }, children: [NB(text)] });
const width = (parts) => parts.reduce((n, [text]) => n + displayWidth(text), 0);
const MIN_GAP = 3;
export const ENDED_NOTE_MS = 10 * 60_000;

/**
 * The footer's UI tree, replacing Codex's own status line:
 *
 *   example-model high · ~/acme-api              ϟ Ultra-fast on
 *                                                    5h 00m left
 *
 * `columns` is the terminal width (0 when unknown: the badge then follows the
 * text). Every row fits in `columns - 3` (Codex insets the status line 2
 * columns; 1 more stays spare): the folder shortens first, then the badge,
 * then the model name. After a boost ends, a red "ϟ Ultra-fast ended at 10:20
 * PT" shows for ENDED_NOTE_MS. The footer is always two rows (the second
 * blank without a boost): Codex anchors the pet's 5-row box to the footer's
 * bottom, so a constant height keeps the box's top three rows over the prompt
 * box, where the pet frames are drawn. `sawBoost` is reported for callers.
 * @returns {{ tree: object, sawBoost: boolean }}
 */
export function footerTree({ state, boost, endedAt = null, now, columns = 0, sawBoost = false, home = "", timeZone = undefined }) {
  const thread = state?.thread ?? {};
  const model = thread.model ?? {};
  const cwd = oneLine(String(thread.workspace?.cwd ?? ""), 4096);
  let where = home && cwd && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
  const shown = oneLine(String(model.display_name ?? model.displayName ?? model.id ?? "")).split("/").pop();
  let name = [shown, oneLine(String(model.reasoning_level ?? model.reasoningLevel ?? ""), 20)].filter(Boolean).join(" ");
  const running = isRunning(boost, now);
  const endedRecently = !running && endedAt != null && now >= endedAt && now - endedAt < ENDED_NOTE_MS;
  const badgeChoices = running
    ? [["ϟ Ultra-fast on", COLOR.amber], ["ϟ Ultra-fast", COLOR.amber], ["ϟ on", COLOR.amber]]
    : endedRecently
      ? [[`ϟ Ultra-fast ended at ${localClock(endedAt, timeZone)}`, COLOR.red], ["ϟ Ultra-fast ended", COLOR.red], ["ϟ ended", COLOR.red]]
      : [];
  const room = columns > 0 ? Math.max(1, columns - 3) : 0;
  let badge = badgeChoices.length ? [badgeChoices[0]] : [];

  if (room) {
    const nameFloor = Math.min(displayWidth(name), 8);
    for (const choice of badgeChoices) {
      badge = [choice];
      if (nameFloor + MIN_GAP + displayWidth(choice[0]) <= room) break;
    }
    if (badge.length && nameFloor + MIN_GAP + width(badge) > room) badge = [];
    const forLeft = room - (badge.length ? MIN_GAP + width(badge) : 0);
    const forWhere = forLeft - displayWidth(name) - 3;
    if (displayWidth(where) > forWhere) {
      const parts = where.split("/");
      while (parts.length > 1 && displayWidth(`…/${parts.join("/")}`) > forWhere) parts.shift();
      where = `…/${parts.join("/")}`;
      if (displayWidth(where) > forWhere) where = "";
    }
    name = truncate(name, forLeft);
  }
  const leftParts = [[name, COLOR.amber], ...(where ? [[" · ", COLOR.dim], [where, COLOR.dim]] : [])];
  const rows = [[leftParts, badge]];
  const keep = sawBoost || running;
  if (running && boost.expiresAt != null) {
    const time = `${timeLeft(boost.expiresAt - now)} left`;
    rows.push([[], [[room ? truncate(time, room) : time, COLOR.text, true]]]);
  } else {
    rows.push([[], [[" ", COLOR.dim]]]);
  }
  const children = [];
  rows.forEach(([l, r], i) => {
    if (i) children.push("\n");
    children.push(...l.filter(([s]) => s).map(([s, c, b]) => node(s, c, b)));
    if (r.length) {
      const gap = room ? room - width(l) - width(r) : MIN_GAP;
      children.push(NB(" ".repeat(Math.max(i ? 0 : MIN_GAP, gap))));
      children.push(...r.map(([s, c, b]) => node(s, c, b)));
    }
  });
  return { tree: { type: "text", children }, sawBoost: keep };
}

/** The plain text of a UI tree (tests and logs). */
export function treeText(tree) {
  if (tree == null) return "";
  if (typeof tree === "string") return tree;
  return (tree.children ?? []).map(treeText).join("");
}
