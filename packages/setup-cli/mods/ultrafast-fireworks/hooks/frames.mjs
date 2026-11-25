/**
 * Ultra-fast activation banner frames for the band above Claude Code's prompt.
 *
 * Pure layout, no engine calls: the hooks module asks for the frame at a
 * moment and draws the runs it gets back. Tests import this file directly.
 *
 * A port of the design prototype's "Banner" animation, nine rows tall:
 *
 *   row 0    left empty, a gap between Claude Code's text and the fireworks
 *   row 1-4  the Fireworks symbol (Nexus's small mark, scaled up 2x)
 *   row 5    blank
 *   row 6    ϟ  U L T R A - F A S T   A C T I V A T E D  ϟ
 *   row 7    blank, so the title and subtitle breathe
 *   row 8    the subtitle
 *
 * 1. Wipe, 10 steps 65 ms apart: a `━` streak runs left to right on the title
 *    (18 cells, `ϟ` at its head) and subtitle rows (12 cells, `»`), revealing
 *    them. The logo shows from the start.
 * 2. Hold, 54 ticks 80 ms apart: 21 fireworks on a fixed schedule rise from
 *    the bottom for 5 ticks, then burst in 7 stages into rings that widen,
 *    sag and fade, among 10 twinkles a tick. Nothing draws over the logo or
 *    the text, or where something already drew this tick.
 * 3. At BANNER_MS it ends and the band is Claude Code's again.
 *
 * Positions follow the prototype's 120-column terminal: `width` there is the
 * band's body plus the 5 columns Claude Code keeps for its `[–]` mark, so the
 * banner centers on the whole terminal row. A shorter band drops the top row
 * of sky, then shows just the title, the blank row and the subtitle, and at
 * two rows only the title and subtitle.
 */

export const BANNER_MS = 5_000;
export const ROWS = 2;
export const MAX_ROWS = 9;
/** Rows above this stay empty, so nothing touches the text above the band. */
export const FIRST_SPARK_ROW = 1;
export const LOGO_ROW = 1;
export const TITLE_ROW = 6;
export const SUBTITLE_ROW = 8;
const BOTTOM_ROW = MAX_ROWS - 1;
export const WIPE_STEP_MS = 65;
export const WIPE_STEPS = 10;
export const WIPE_MS = WIPE_STEP_MS * WIPE_STEPS;
export const TICK_MS = 80;
export const TICKS = 54;
/** Columns Claude Code keeps at the band's right edge for its `[–]` mark. */
const GUTTER = 5;

/** Hex colors per tone, from the prototype's palette. */
export const COLORS = Object.freeze({
  amber: "#ffba50",
  amberHi: "#ffdb9f",
  amberLo: "#f98d00",
  bloom: "#de4a7d",
  bloomHi: "#f0acd6",
  purple: "#d361ad",
  text: "#ffffff",
  fg: "#e4e4eb",
  dim: "#8e8e9f",
  faint: "#4c4c57",
  g0: "#d97547",
  g1: "#db635e",
  g2: "#dd5075",
  g3: "#db518b",
  g4: "#d65a9f",
  g5: "#d368af",
  g6: "#d47eb5",
  g7: "#d494bb",
});

export const TITLE = "ϟ  U L T R A - F A S T   A C T I V A T E D  ϟ";

/**
 * The status line's 8x2 Fireworks mark: a copy of LOGO_CELLS_STATUS_LINE in
 * lib/ui/brand-logo.mjs (the mod can't import outside its folder; a test keeps
 * the two equal). The banner draws it scaled up 2x, see scaleLogo.
 */
export const LOGO_SOURCE = Object.freeze(["⠀⣄⡘⣧⣼⢃⣠⠀", "⠴⠬⠿⠎⠱⠯⠥⠦"]);

// Braille dot bits by [dot row][dot column] within a cell.
const DOT_BITS = [[1, 8], [2, 16], [4, 32], [64, 128]];
const BRAILLE = 0x2800;

/**
 * Scale Braille art up 2x, smoothing diagonals (the EPX rule, as the
 * prototype does): every dot becomes four, and a corner of the four is set
 * when the two neighbours toward it agree and the two away from it don't.
 * @returns {string[]} rows twice as many, cells twice as wide
 */
export function scaleLogo(rows) {
  const cells = rows.map((row) => [...row].map((ch) => (ch.codePointAt(0) ?? BRAILLE) - BRAILLE));
  const dotCols = 2 * cells[0].length;
  const dotRows = 4 * cells.length;
  const dot = (x, y) => x >= 0 && y >= 0 && x < dotCols && y < dotRows
    && (cells[y >> 2][x >> 1] & DOT_BITS[y & 3][x & 1]) !== 0;
  const scaled = (x, y) => {
    const sx = x >> 1;
    const sy = y >> 1;
    const centre = dot(sx, sy);
    const up = dot(sx, sy - 1);
    const right = dot(sx + 1, sy);
    const left = dot(sx - 1, sy);
    const down = dot(sx, sy + 1);
    const [towardV, towardH] = [y & 1 ? down : up, x & 1 ? right : left];
    const [awayV, awayH] = [y & 1 ? up : down, x & 1 ? left : right];
    return towardV === towardH && towardV !== awayV && towardH !== awayH ? towardV : centre;
  };
  return Array.from({ length: 2 * cells.length }, (_, row) => Array.from({ length: dotCols }, (_, col) => {
    let code = BRAILLE;
    DOT_BITS.forEach((bits, dy) => bits.forEach((bit, dx) => {
      if (scaled(2 * col + dx, 4 * row + dy)) code |= bit;
    }));
    return String.fromCodePoint(code);
  }).join(""));
}

export const LOGO = Object.freeze(scaleLogo(LOGO_SOURCE));

// Big fireworks in the hold: [tick it launches, row it bursts on, where across
// the width (a fraction), first color, second color, ring glyph, radius].
export const FIREWORKS = Object.freeze([
  [0, 1, 0.14, "amber", "amberHi", "✦", 2.6],
  [1, 6, 0.9, "bloomHi", "purple", "*", 1.5],
  [2, 2, 0.82, "bloomHi", "bloom", "*", 2.6],
  [4, 1, 0.4, "amberHi", "amber", "✦", 2.2],
  [6, 8, 0.1, "amberHi", "text", "✦", 1.4],
  [7, 1, 0.66, "amber", "amberLo", "✦", 2.5],
  [8, 2, 0.3, "purple", "bloomHi", "*", 2.6],
  [10, 6, 0.78, "amber", "amberHi", "✦", 1.5],
  [12, 1, 0.58, "bloomHi", "amberHi", "*", 2.2],
  [13, 1, 0.93, "amberHi", "amber", "✦", 2.6],
  [15, 8, 0.22, "bloomHi", "purple", "*", 1.4],
  [17, 2, 0.06, "amber", "bloomHi", "✦", 2.5],
  [19, 1, 0.45, "purple", "amberHi", "*", 2],
  [20, 1, 0.76, "amberHi", "bloomHi", "✦", 2.6],
  [22, 6, 0.92, "amber", "amberHi", "✦", 1.5],
  [24, 2, 0.2, "bloomHi", "amber", "*", 2.6],
  [26, 1, 0.88, "amber", "purple", "✦", 2.6],
  [27, 8, 0.07, "purple", "bloomHi", "*", 1.4],
  [29, 1, 0.36, "amberHi", "amber", "✦", 2.5],
  [31, 1, 0.62, "bloomHi", "purple", "*", 2.6],
  [33, 6, 0.8, "amberHi", "text", "✦", 1.5],
]);
/** Ticks a firework rises before it bursts. */
export const RISE_TICKS = 5;
/** Ticks each burst stage lasts. */
export const STAGE_TICKS = Object.freeze([1, 2, 2, 3, 2, 2, 2]);

// The streak's tones from tail to head.
const STREAK = ["faint", "faint", "faint", "faint", "amberLo", "amberLo", "amberLo", "amberLo",
  "amber", "amber", "amber", "amber", "amber", "amberHi", "amberHi", "amberHi", "amberHi", "amberHi"];

/**
 * The time left on the activation, by the same rule as the status line's
 * badge (minutes rounded up), so the two never disagree on screen: "5h",
 * "4h 13m", "45m". Whole hours drop the minutes.
 */
export function formatRemaining(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)}h ${String(rest).padStart(2, "0")}m` : `${minutes / 60}h`;
}

/** Rows to draw: what the band allows and what was asked, within 2 and MAX_ROWS. */
export function bannerRows(maxRows, wanted = MAX_ROWS) {
  const allowed = Number.isFinite(maxRows) ? Math.floor(maxRows) : ROWS;
  const asked = Number.isFinite(wanted) ? Math.floor(wanted) : MAX_ROWS;
  return Math.max(ROWS, Math.min(MAX_ROWS, allowed, asked));
}

function cellsOf(text, tone, bold = false) {
  return [...text].map((ch) => ({ ch, tone: ch === " " ? null : tone, bold }));
}

/** The title cells, in the prototype's pale orange, bold. */
export function titleCells() {
  return cellsOf(TITLE, "amberHi", true);
}

/**
 * The subtitle: the grant's reason when there is one, with its figures bold
 * white, then the offer and the time left (bold orange). A reason too long for
 * the width is cut with an ellipsis, so the offer always shows. The offer
 * says "faster responses" without a figure: no speed-up figure is promised.
 */
export function subtitleCells(status, now, width) {
  const tail = cellsOf("Enjoy faster responses", "fg");
  const left = typeof status?.expiresAt === "number" ? status.expiresAt - now : 0;
  if (left > 0) {
    tail.push(...cellsOf(" for the next ", "fg"), ...cellsOf(formatRemaining(left), "amber", true));
  }
  const room = width - 4 - tail.length - 1;
  let reason = [...String(status?.reason ?? "")];
  if (reason.length > room) {
    reason = room > 1 ? [...reason.slice(0, room - 1), "…"] : [];
  }
  if (!reason.length) return tail;
  const text = reason.join("");
  const cells = [];
  let last = 0;
  for (const match of text.matchAll(/\d[\d.,]*\s*[KMBkmb]?\b(?:\s+[A-Za-z]+)?/g)) {
    cells.push(...cellsOf(text.slice(last, match.index), "fg"), ...cellsOf(match[0], "text", true));
    last = match.index + match[0].length;
  }
  cells.push(...cellsOf(text.slice(last), "fg"));
  return [...cells, ...cellsOf(" ", "fg"), ...tail];
}

/**
 * Points on a ring around (row, x): `count` of them, `radius` rows tall and
 * 2.2 times as wide, alternating `tones`. `sag` pulls the lower half down, as
 * sparks fall when they fade.
 */
export function ring(row, x, radius, count, glyph, tones, sag = 0, bold = false) {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    const drop = sag * (0.6 + 0.4 * Math.max(0, Math.sin(angle)));
    return {
      row: row + Math.round(Math.sin(angle) * radius + drop),
      x: x + Math.round(Math.cos(angle) * radius * 2.2),
      ch: glyph,
      tone: tones[i % 2],
      bold,
    };
  });
}

/** The burst stage `ticks` after a firework stops rising, or -1 once it's gone. */
export function burstStage(ticks) {
  let end = 0;
  for (let stage = 0; stage < STAGE_TICKS.length; stage += 1) {
    end += STAGE_TICKS[stage];
    if (ticks < end) return stage;
  }
  return -1;
}

/** A firework's marks at burst `stage`, centered on (row, x). */
export function burstMarks(row, x, first, second, glyph, radius, stage) {
  const tones = [first, second];
  const points = (scale) => Math.max(6, -2 & Math.round((scale * radius) / 3));
  switch (stage) {
    case 0:
      return [{ row, x, ch: "✦", tone: "text", bold: true },
        ...[[-1, 0], [1, 0], [0, -2], [0, 2]].map(([dr, dx]) => ({ row: row + dr, x: x + dx, ch: "·", tone: "amberHi", bold: false }))];
    case 1:
      return [{ row, x, ch: "✺", tone: first, bold: true }, ...ring(row, x, 0.45 * radius, points(8), glyph, tones, 0, true)];
    case 2:
      return [...ring(row, x, 0.75 * radius, points(12), glyph, tones, 0, true), ...ring(row, x, 0.35 * radius, points(6), "·", tones)];
    case 3:
      return [...ring(row, x, radius, points(16), glyph, tones, 0, true), ...ring(row, x, 0.55 * radius, points(10), "·", [second, "dim"])];
    case 4:
      return [...ring(row, x, 1.05 * radius, points(16), "✧", tones), ...ring(row, x, 0.6 * radius, points(8), "·", ["faint", "dim"])];
    case 5:
      return ring(row, x, 1.1 * radius, points(16), "·", tones, 0.5);
    case 6:
      return ring(row, x, 1.15 * radius, points(12), ".", ["amberLo", "faint"], 1);
    default:
      return [];
  }
}

/** The prototype's seeded noise, in [0, 1). */
export function noise(a, b) {
  return ((43758.5453 * Math.sin(127.1 * a + 311.7 * b)) % 1 + 1) % 1;
}

/** Every mark of the hold's `tick`, in drawing order (earlier marks win a cell). */
export function holdMarks(tick, width) {
  const marks = [];
  for (const [launch, burstRow, at, first, second, glyph, radius] of FIREWORKS) {
    const age = tick - launch;
    const x = Math.round(width * at);
    if (age < 0) continue;
    if (age < RISE_TICKS) {
      const row = Math.round(BOTTOM_ROW - (BOTTOM_ROW - burstRow) * (1 - (1 - age / RISE_TICKS) ** 2));
      marks.push({ row, x, ch: "•", tone: "text", bold: true }, { row: row + 1, x, ch: "|", tone: "amber", bold: false },
        { row: row + 2, x, ch: "'", tone: "amberLo", bold: false });
    } else {
      marks.push(...burstMarks(burstRow, x, first, second, glyph, radius, burstStage(age - RISE_TICKS)));
    }
  }
  for (let i = 0; i < 10; i += 1) {
    const a = noise(tick >> 2, i);
    marks.push({ row: Math.floor(MAX_ROWS * noise(i, tick >> 2)), x: Math.floor(a * width), ch: a < 0.5 ? "·" : ".", tone: i % 3 ? "faint" : "dim", bold: false });
  }
  return marks;
}

/** The left column that centers `length` cells in `width`. */
function centered(width, length) {
  return Math.floor((width - length) / 2);
}

/** The full grid at `elapsedMs`, `width` columns (gutter included). */
function fullGrid(elapsedMs, width, status, now) {
  const grid = Array.from({ length: MAX_ROWS }, () => Array.from({ length: width }, () => ({ ch: " ", tone: null, bold: false })));
  const put = (row, col, cell) => {
    if (row >= 0 && row < MAX_ROWS && col >= 0 && col < width) grid[row][col] = cell;
  };
  const logoLeft = centered(width, [...LOGO[0]].length);
  LOGO.forEach((line, row) => [...line].forEach((ch, i) => {
    if (ch !== "⠀") put(LOGO_ROW + row, logoLeft + i, { ch, tone: `g${i >> 1}`, bold: false });
  }));
  const title = titleCells();
  const subtitle = subtitleCells(status, now, width);
  const titleLeft = centered(width, title.length);
  const subtitleLeft = centered(width, subtitle.length);
  title.forEach((cell, i) => put(TITLE_ROW, titleLeft + i, cell));
  subtitle.forEach((cell, i) => put(SUBTITLE_ROW, subtitleLeft + i, cell));

  if (elapsedMs < WIPE_MS) {
    const step = Math.floor(elapsedMs / WIPE_STEP_MS);
    const head = Math.round(((step + 1) / WIPE_STEPS) * (width + STREAK.length));
    [TITLE_ROW, SUBTITLE_ROW].forEach((row, i) => {
      for (let col = Math.max(0, head - STREAK.length); col < width; col += 1) put(row, col, { ch: " ", tone: null, bold: false });
      const length = i === 0 ? 18 : 12;
      for (let k = 0; k < length; k += 1) put(row, head - length + k, { ch: "━", tone: STREAK[STREAK.length - length + k], bold: false });
    });
    put(TITLE_ROW, head, { ch: "ϟ", tone: "text", bold: true });
    put(SUBTITLE_ROW, head - 1, { ch: "»", tone: "amberHi", bold: true });
    return grid;
  }

  // The hold: marks land only on blank cells away from the logo and the text.
  const kept = [
    [LOGO_ROW - 1, LOGO_ROW + LOGO.length, logoLeft - 3, logoLeft + [...LOGO[0]].length + 2],
    [TITLE_ROW - 1, TITLE_ROW + 1, titleLeft - 2, titleLeft + title.length + 1],
    [SUBTITLE_ROW - 1, SUBTITLE_ROW + 1, subtitleLeft - 2, subtitleLeft + subtitle.length + 1],
  ];
  const isClear = (row, col) => row >= FIRST_SPARK_ROW && row < MAX_ROWS && col >= 0 && col < width - GUTTER
    && !kept.some(([top, bottom, first, last]) => row >= top && row <= bottom && col >= first && col <= last)
    && grid[row][col].ch === " ";
  const tick = Math.min(TICKS - 1, Math.floor((elapsedMs - WIPE_MS) / TICK_MS));
  for (const mark of holdMarks(tick, width)) {
    if (isClear(mark.row, mark.x)) grid[mark.row][mark.x] = { ch: mark.ch, tone: mark.tone, bold: mark.bold };
  }
  return grid;
}

/** Merge a row of cells into runs of one tone and weight, trailing blanks dropped. */
export function toRuns(cells) {
  let end = cells.length;
  while (end > 0 && cells[end - 1].ch === " ") end -= 1;
  const runs = [];
  for (const cell of cells.slice(0, end)) {
    const blank = cell.ch === " ";
    const tone = blank ? null : cell.tone;
    const bold = blank ? false : Boolean(cell.bold);
    const last = runs[runs.length - 1];
    if (last && (blank || (last.tone === tone && last.bold === bold))) {
      last.text += cell.ch;
    } else {
      runs.push({ text: cell.ch, tone, bold });
    }
  }
  return runs;
}

/**
 * The banner at `elapsedMs`, as rows of `{ text, tone, bold }` runs, or null
 * once it is over (or before it starts), or once the boost it announces has
 * ended (`status.expiresAt` at or before `now`): an expired boost never
 * draws, whenever the play began. `columns` is the band's body width;
 * the full banner needs `rows` of MAX_ROWS, else only the title and subtitle show.
 * @param {{ elapsedMs: number, columns: number, rows?: number, status?: object | null, now?: number }} opts
 * @returns {{ text: string, tone: string | null, bold: boolean }[][] | null}
 */
export function bannerFrame({ elapsedMs, columns, rows = ROWS, status = null, now = 0 }) {
  if (!(elapsedMs >= 0) || elapsedMs >= BANNER_MS) return null;
  const expiresAt = status && typeof status === "object" ? status.expiresAt : null;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= now) return null;
  const body = Math.max(1, Math.floor(columns) || 1);
  const grid = fullGrid(elapsedMs, body + GUTTER, status, now).map((row) => row.slice(0, body));
  return shrink(grid, bannerRows(rows, rows)).map(toRuns);
}

/**
 * The grid cut to a band of `rows`: all of it when it fits, then without the
 * top row of sky, then just the title, the blank row and the subtitle, and at
 * two rows the title and subtitle alone.
 */
function shrink(grid, rows) {
  if (rows >= MAX_ROWS) return grid;
  if (rows >= MAX_ROWS - 1) return grid.slice(1);
  if (rows >= 3) return grid.slice(TITLE_ROW, SUBTITLE_ROW + 1);
  return [grid[TITLE_ROW], grid[SUBTITLE_ROW]];
}

/** A boost status older than this is ignored. */
export const FLAG_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Whether this Claude Code plays the banner. Every Claude Code that reads the
 * user's settings loads the mod; it plays only in the terminal app ("cli",
 * also Claude Code's default when `CLAUDE_CODE_ENTRYPOINT` is unset). The
 * desktop app ("claude-desktop") draws the band too but is left out on
 * purpose: the animation is off there. Headless `claude -p` or SDK runs and
 * the VS Code extension have no band, so a play would only run a timer no one
 * sees.
 * @param {unknown} entrypoint
 */
export function showsBanner(entrypoint) {
  const value = typeof entrypoint === "string" ? entrypoint.trim() : "";
  return value === "" || value === "cli";
}

/**
 * Whether the session's model is one a boost speeds up: Ultra-fast applies to
 * Nexus Auto (`auto`, an `auto-*` variant, with or without Claude Code's
 * `[1m]` tag), so a session on a Claude model or a concrete Fireworks model
 * gets nothing faster and sees no banner. A copy of the CLI's
 * `isAutoModelId` (the mod can't import lib/; a parity test pins the two).
 * "" or anything else (a model this Claude Code can't report) is no.
 * @param {unknown} model the main loop's model, as `$.session.model()` gives it
 */
export function boostsModel(model) {
  if (typeof model !== "string") return false;
  const slug = model.replace(/\[1m\]$/i, "").trim().toLowerCase();
  if (!slug || slug.includes("/") || slug === "auto-smart") return false;
  return slug === "auto" || slug.startsWith("auto-");
}

/**
 * Whether a fetched boost status should play the banner now: the boost is
 * active, unexpired, and this activation hasn't played yet in this session
 * (`lastKey`). Each new session starts with none, so a running boost plays
 * once at the start of every new session.
 * @returns {{ play: boolean, key: string, status: object | null }}
 */
export function activationToPlay(cached, lastKey, now) {
  const status = cached && typeof cached === "object" ? cached.status : null;
  if (!status || status.active !== true) return { play: false, key: "", status: null };
  // A status never fetched, older than a day, or from a clock well ahead: no.
  const fetchedAt = typeof cached.fetchedAt === "number" ? cached.fetchedAt : 0;
  if (fetchedAt <= 0 || now - fetchedAt > FLAG_MAX_AGE_MS || fetchedAt > now + 60_000) {
    return { play: false, key: "", status: null };
  }
  if (typeof status.expiresAt === "number" && status.expiresAt <= now) return { play: false, key: "", status: null };
  const key = (typeof status.activationId === "string" && status.activationId)
    || (status.activatedAt != null ? `at:${status.activatedAt}` : "")
    || (status.expiresAt != null ? `until:${status.expiresAt}` : "")
    || "active";
  return { play: key !== lastKey, key, status };
}
