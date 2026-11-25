#!/usr/bin/env node
/**
 * Paint the Ultra-fast boost tile into Nexus's Codex pet sprite sheet
 * (lib/ui/brand/codex-pet/spritesheet.png), in place. Dev-only, no
 * dependencies. Run from packages/setup-cli after render-brand-assets.mjs,
 * which redraws the whole sheet with the dotted logo:
 *
 *   node scripts/render-codex-ultrafast-pet.mjs
 *
 * The logo cells (0, and the working pops in 56..59) stay as they are; the
 * boost tile goes into the cells mods/codex-ultrafast/ultrafast.mjs names
 * (TILE): a flash, the liquid rising with sparkles, 8 fill levels with a moving
 * surface, and an almost-empty state with embers and a blinking bolt. The
 * server's pet.json uses these cells only while a boost is on.
 *
 * The tile is pixel art: 24x24 art pixels, drawn in the top 3/5 of a 192x208
 * cell and right-aligned. Codex draws the pet in a 9x5-cell box whose lower two
 * rows sit over the footer, so the footer text shows under the transparent
 * rest; and Codex stretches each frame into that box assuming cells 0.52 as
 * wide as tall, so art pixels are 1.25x wider than tall to land square on
 * typical fonts (about 0.46).
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LEVELS, TILE } from "../mods/codex-ultrafast/ultrafast.mjs";
import { decodePng, encodePng } from "./png.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHEET = path.join(here, "..", "lib", "ui", "brand", "codex-pet", "spritesheet.png");
const CELL_W = 192, CELL_H = 208, COLS = 8, ROWS = 9, ART = 24, SCALE = 5, WIDEN = 1.25;
const SCALE_X = SCALE * WIDEN;
const OX = Math.round(CELL_W - ART * SCALE_X - 4), OY = 3;

// --- the tile as a 24x24 grid of colors (null = transparent) ----------------------------------
const hex = (h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
const C = {
  rimTop: hex("#8b8d99"), rim: hex("#6d6f7b"), rimLow: hex("#45474f"), inside: hex("#141519"),
  glint: hex("#7a7c86"), glintLow: hex("#3c3e45"),
  fill: hex("#9b1a72"), fillLight: hex("#d23c78"), fillDark: hex("#76125a"), bubble: hex("#f08cc0"),
  flash: hex("#f8b8da"),
  outline: hex("#0d0d0f"), boltHi: hex("#ffd99a"), bolt: hex("#ffb03e"), boltLo: hex("#f08812"),
  boltDimHi: hex("#8a8b93"), boltDim: hex("#5d5e66"), boltDimLo: hex("#46474e"),
  ember: hex("#ff9614"), emberHi: hex("#ffc24c"),
  cream: hex("#ffe2a6"), white: hex("#ffffff"), pink: hex("#f4a6d4"),
};

const blank = () => Array.from({ length: ART }, () => Array(ART).fill(null));
function put(g, x, y, c, alpha = 1) {
  if (x < 0 || y < 0 || x >= ART || y >= ART || !c) return;
  const prev = g[y][x];
  g[y][x] = alpha >= 1 || !prev ? c : prev.map((v, i) => Math.round(v + (c[i] - v) * alpha));
}

/** Rounded tile: a 1-pixel rim with notched corners, lit from above. */
function tile(g) {
  for (let y = 0; y < ART; y++) for (let x = 0; x < ART; x++) {
    if ((x === 0 || x === ART - 1) && (y === 0 || y === ART - 1)) continue;
    const edge = x === 0 || y === 0 || x === ART - 1 || y === ART - 1;
    put(g, x, y, !edge ? C.inside : y === 0 ? C.rimTop : y === ART - 1 ? C.rimLow : C.rim);
  }
  for (const [x, y] of [[1, 1], [ART - 2, 1], [1, ART - 2], [ART - 2, ART - 2]]) put(g, x, y, C.rimLow);
}
const INNER = { x0: 1, y0: 1, x1: ART - 2, y1: ART - 2 };

function glint(g, overFill) {
  put(g, 2, 2, C.glint, overFill ? 0.5 : 1);
  put(g, 3, 2, C.glint, overFill ? 0.35 : 0.7);
  put(g, 2, 4, C.glintLow, overFill ? 0.4 : 1);
}

/** The bolt, 11x15: # outline, H highlight, O body, S shade. */
const BOLT = [
  ".....#####.",
  "....#HOOS#.",
  "....#HOS#..",
  "...#HOOS#..",
  "...#HOS#...",
  "..#HOO####.",
  "..#HOOOOOS#",
  ".#HOOOOOS#.",
  ".####OOS#..",
  "....#HOS#..",
  "...#HOS#...",
  "...#HS#....",
  "..#HS#.....",
  "..#S#......",
  "..##.......",
];
function bolt(g, dim = false) {
  const tone = dim
    ? { "#": C.outline, H: C.boltDimHi, O: C.boltDim, S: C.boltDimLo }
    : { "#": C.outline, H: C.boltHi, O: C.bolt, S: C.boltLo };
  BOLT.forEach((row, y) => [...row].forEach((ch, x) => tone[ch] && put(g, 6 + x, 4 + y, tone[ch])));
}

/** Liquid up to `level` (0..1), with a stepped surface that moves with `phase`, and rising bubbles. */
const WAVE = [0, 0, 1, 1, 1, 0, 0, 1];
function liquid(g, level, phase) {
  const depth = Math.round(level * (INNER.y1 - INNER.y0 + 1));
  if (depth <= 0) return;
  const top = INNER.y1 - depth + 1;
  for (let x = INNER.x0; x <= INNER.x1; x++) {
    const surface = Math.min(INNER.y1, top + (level < 1 ? WAVE[(x + phase * 3) % WAVE.length] : 0));
    for (let y = surface; y <= INNER.y1; y++) {
      put(g, x, y, y === surface && level < 1 ? C.fillLight : x === INNER.x0 ? C.fillLight : x === INNER.x1 ? C.fillDark : C.fill);
    }
  }
  if (level >= 1) for (let x = INNER.x0; x <= INNER.x1; x++) put(g, x, INNER.y0, C.fillLight);
  for (const [bx, by] of [[4, 19], [15, 16], [9, 21], [19, 12], [12, 9], [5, 13]]) {
    const y = by - phase;
    if (y > top + 1 && y <= INNER.y1) put(g, bx, y, C.bubble);
  }
}

function sparkle(g, x, y, c, big) {
  put(g, x, y, C.white);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) put(g, x + dx, y + dy, c);
  if (big) for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) put(g, x + dx, y + dy, c, 0.8);
}

function embers(g, phase) {
  for (let x = INNER.x0; x <= INNER.x1; x++) put(g, x, INNER.y1, C.ember);
  for (const x of [3, 9, 14, 19]) put(g, (x + phase * 2) % (INNER.x1 - 1) + 2, INNER.y1 - 1, C.emberHi);
}

// --- frames ---------------------------------------------------------------------------------
const cells = new Map();
const frame = (index, draw) => {
  const g = blank();
  tile(g);
  draw(g);
  cells.set(index, g);
};

frame(TILE.flash, (g) => {
  for (let y = INNER.y0; y <= INNER.y1; y++) for (let x = INNER.x0; x <= INNER.x1; x++) put(g, x, y, C.flash);
  bolt(g);
});
const BURST = [
  [[18, 4, C.cream, true], [3, 10, C.cream, false]],
  [[18, 4, C.cream, true], [4, 9, C.cream, true], [16, 18, C.pink, false]],
  [[19, 3, C.cream, false], [4, 9, C.white, true], [17, 17, C.pink, true], [6, 18, C.white, false]],
  [[5, 10, C.cream, false], [18, 16, C.pink, true], [6, 18, C.white, true], [20, 6, C.cream, false]],
  [[6, 18, C.pink, false], [18, 15, C.pink, false], [3, 5, C.cream, false]],
];
TILE.rise.forEach((cell, i) => frame(cell, (g) => {
  liquid(g, (i + 1) / TILE.rise.length, i % 3);
  glint(g, i > 6);
  bolt(g);
  for (const [x, y, c, big] of BURST[Math.min(BURST.length - 1, Math.floor(i / 2))]) sparkle(g, x, y, c, big);
}));
for (let level = 1; level <= LEVELS; level++) {
  for (let w = 0; w < 3; w++) {
    frame(TILE.levelBase + 3 * (level - 1) + w, (g) => {
      liquid(g, level / LEVELS, w);
      glint(g, level === LEVELS);
      bolt(g);
    });
  }
}
// The last low frame greys the bolt instead of dropping it: a pet still showing
// this after the boost ends (Codex keeps the loaded pet) reads as spent.
TILE.low.forEach((cell, i) => frame(cell, (g) => {
  glint(g);
  embers(g, i);
  bolt(g, i === TILE.low.length - 1);
}));

// --- paint into the sheet --------------------------------------------------------------------
const sheet = decodePng(readFileSync(SHEET));
if (sheet.width !== CELL_W * COLS || sheet.height !== CELL_H * ROWS) {
  throw new Error(`expected a ${CELL_W * COLS}x${CELL_H * ROWS} sheet, found ${sheet.width}x${sheet.height}`);
}
// The logo cells (the normal pet) come from render-brand-assets.mjs centered
// in the whole cell, but only the top 3/5 of a cell lands over Codex's prompt
// box (the rest is over the footer). Move them all by one shared amount, so
// the working pops don't jump, until the idle logo (cell 0, what shows most
// of the time) is centered on those three rows. The pops grow upward from the
// logo's base, so centering all frames together would leave the idle logo
// low. A second run moves nothing.
const tileCells = new Set(cells.keys());
const BAND_CENTER = (3 * CELL_H / 5) / 2; // the middle of the cell's top three of five rows
/** First and last opaque row of a cell, or null when it is empty. */
function rowsOf(index) {
  const cx = (index % COLS) * CELL_W, cy = Math.floor(index / COLS) * CELL_H;
  let top = -1, bottom = -1;
  for (let y = 0; y < CELL_H; y++) {
    const row = (cy + y) * sheet.width + cx;
    for (let x = 0; x < CELL_W; x++) {
      if (sheet.data[(row + x) * 4 + 3] > 0) {
        if (top < 0) top = y;
        bottom = y;
        break;
      }
    }
  }
  return top < 0 ? null : { top, bottom };
}
const idle = rowsOf(0);
// Positive: move up. Never past a cell's top edge, for any logo frame.
let lift = idle ? Math.round((idle.top + idle.bottom + 1) / 2 - BAND_CENTER) : 0;
for (let index = 0; index < COLS * ROWS && lift > 0; index++) {
  if (tileCells.has(index)) continue;
  const rows = rowsOf(index);
  if (rows) lift = Math.min(lift, rows.top);
}
if (lift) {
  for (let index = 0; index < COLS * ROWS; index++) {
    if (tileCells.has(index)) continue;
    const cx = (index % COLS) * CELL_W, cy = Math.floor(index / COLS) * CELL_H;
    const copy = Buffer.alloc(CELL_W * 4 * CELL_H);
    for (let y = 0; y < CELL_H; y++) sheet.data.copy(copy, y * CELL_W * 4, ((cy + y) * sheet.width + cx) * 4, ((cy + y) * sheet.width + cx + CELL_W) * 4);
    for (let y = 0; y < CELL_H; y++) {
      const to = ((cy + y) * sheet.width + cx) * 4;
      const src = y + lift;
      if (src >= 0 && src < CELL_H) copy.copy(sheet.data, to, src * CELL_W * 4, (src + 1) * CELL_W * 4);
      else sheet.data.fill(0, to, to + CELL_W * 4);
    }
  }
}

for (const [index, g] of cells) {
  const cx = (index % COLS) * CELL_W, cy = Math.floor(index / COLS) * CELL_H;
  for (let y = cy; y < cy + CELL_H; y++) sheet.data.fill(0, (y * sheet.width + cx) * 4, (y * sheet.width + cx + CELL_W) * 4);
  for (let y = 0; y < ART; y++) {
    for (let x = 0; x < ART; x++) {
      const c = g[y][x];
      if (!c) continue;
      const xa = Math.round(x * SCALE_X), xb = Math.round((x + 1) * SCALE_X);
      for (let py = 0; py < SCALE; py++) {
        for (let px = xa; px < xb; px++) {
          const i = ((cy + OY + y * SCALE + py) * sheet.width + cx + OX + px) * 4;
          sheet.data[i] = c[0];
          sheet.data[i + 1] = c[1];
          sheet.data[i + 2] = c[2];
          sheet.data[i + 3] = 255;
        }
      }
    }
  }
}
writeFileSync(SHEET, encodePng(sheet));
console.log(`painted ${cells.size} boost cells${lift ? `, moved the logo ${lift > 0 ? "up" : "down"} ${Math.abs(lift)}px` : ""} into ${path.relative(process.cwd(), SHEET)}`);
