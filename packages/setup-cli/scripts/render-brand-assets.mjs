#!/usr/bin/env node
/**
 * Regenerate the Fireworks symbol assets from the brand SVG
 * (lib/ui/brand/fireworks-symbol.svg). Dev-only: needs Playwright, which is
 * not a CLI dependency. Run from packages/setup-cli, passing Playwright's
 * entry point if it isn't resolvable from here:
 *
 *   node scripts/render-brand-assets.mjs [path/to/playwright/index.mjs]
 *
 * Every surface uses one mark: the symbol as a grid of dots, each column
 * colored along the CLI's logo gradient (lib/ui/tokens.mjs LOGO_GRADIENT),
 * on a transparent background. In terminals the dots are Braille characters;
 * Codex's pet needs an image, so its sprite sheet draws the same dots.
 *
 * Writes lib/ui/brand/codex-pet/spritesheet.png (8x9 cells of 192x208) and
 * prints the Braille cell art pasted into lib/ui/brand-logo.mjs and the
 * OpenCode plugin.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { LOGO_GRADIENT } = await import("../lib/ui/tokens.mjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const brandDir = path.join(here, "..", "lib", "ui", "brand");
const { chromium } = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : "playwright");


// The symbol's three strokes, split out of the single brand path so the pet
// can animate them one at a time. Path order: center V, left, right swoosh.
const svgSource = readFileSync(path.join(brandDir, "fireworks-symbol.svg"), "utf8");
const strokes = svgSource.match(/ d="([^"]+)"/)[1].split(/(?=M)/);
if (strokes.length !== 3) {
  throw new Error(`expected 3 subpaths in the brand symbol, found ${strokes.length}`);
}
const [V, LEFT, RIGHT] = [0, 1, 2];

/**
 * Black-on-transparent SVG of the symbol (a mask; color comes later). Each
 * stroke can scale about the symbol's bottom-center, where the strokes meet.
 * @param {number[]} scales in path order
 * @param {string} viewBox
 */
function maskSvg(scales, viewBox) {
  const parts = strokes.map((d, index) => {
    const transform = `translate(433 400) scale(${scales[index]}) translate(-433 -400)`;
    return `<path fill="#000" transform="${transform}" d="${d}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="866" height="400">${parts.join("")}</svg>`;
}

const browser = await chromium.launch();
const page = await browser.newPage();

// --- Braille cell art -------------------------------------------------------
// Each size: [cols, rows, dotsWide, dotsTall, threshold, supersample,
// padBottom]. The symbol is drawn dotsWide x dotsTall, centered, with
// padBottom empty dot rows under it, in (cols*2) x (rows*4) dots; a dot is on
// when the mean alpha of its supersample x supersample block exceeds the
// threshold. statusLine is a dot row shorter than small with that row empty:
// a little smaller, with a gap above Claude Code's own line below it.
const SIZES = {
  small: [9, 2, 17, 8, 90, 4, 0],
  statusLine: [8, 2, 16, 7, 80, 4, 1],
  large: [17, 4, 34, 16, 110, 1, 0],
};
const braille = await page.evaluate(async ({ svg, sizes }) => {
  const img = new Image();
  img.src = `data:image/svg+xml;base64,${btoa(svg)}`;
  await img.decode();
  const bits = [[0, 0, 0x1], [0, 1, 0x2], [0, 2, 0x4], [1, 0, 0x8], [1, 1, 0x10], [1, 2, 0x20], [0, 3, 0x40], [1, 3, 0x80]];
  return Object.fromEntries(Object.entries(sizes).map(([name, [cols, rows, wide, tall, threshold, ss, pad]]) => {
    const W = cols * 2;
    const H = rows * 4;
    const canvas = document.createElement("canvas");
    canvas.width = W * ss;
    canvas.height = H * ss;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, ((W - wide) / 2) * ss, (H - tall - pad) * ss, wide * ss, tall * ss);
    const alpha = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const on = (x, y) => {
      let sum = 0;
      for (let i = 0; i < ss; i += 1) {
        for (let j = 0; j < ss; j += 1) {
          sum += alpha[((y * ss + j) * canvas.width + x * ss + i) * 4 + 3];
        }
      }
      return sum / (ss * ss) > threshold;
    };
    const lines = [];
    for (let r = 0; r < rows; r += 1) {
      let line = "";
      for (let c = 0; c < cols; c += 1) {
        line += String.fromCodePoint(0x2800 + bits.reduce((sum, [dx, dy, b]) => sum + (on(c * 2 + dx, r * 4 + dy) ? b : 0), 0));
      }
      lines.push(line);
    }
    return [name, lines];
  }));
}, { svg: svgSource, sizes: SIZES });

// --- Codex pet ----------------------------------------------------------------
// Idle in every cell (Codex's built-in animations reference cells up to index
// 69, so any state we don't override still shows the logo); the working
// sequence in row 7: each stroke grows in turn (left, center, right), then all
// three together. Each frame is the symbol rasterized to a dot grid, colored by
// column along the gradient, so it matches the Braille mark in the terminal.
const POP = 1.14;
const BASE = [1, 1, 1];
const pop = (indexes, scale = POP) => BASE.map((value, index) => (indexes.includes(index) ? scale : value));
const RUNNING = { 56: pop([LEFT]), 57: pop([V]), 58: pop([RIGHT]), 59: pop([LEFT, V, RIGHT], 1.07) };
// Room around the symbol for the largest pop; the grid matches that viewBox.
const PET_VIEWBOX = "-70 -66 1006 466";
const GRID = { cols: 30, rows: 14 };
const frames = [...Array(72).keys()].map((index) => maskSvg(RUNNING[index] ?? BASE, PET_VIEWBOX));
const sheet = await page.evaluate(async ({ frames, grid, gradient }) => {
  const CELL_W = 192;
  const CELL_H = 208;
  const out = document.createElement("canvas");
  out.width = CELL_W * 8;
  out.height = CELL_H * 9;
  const octx = out.getContext("2d");
  const pitch = 5.4; // px between dots: the mark is about 160 px wide in a 192 px cell
  const radius = 2.1;
  const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const colorAt = (position) => {
    const t = Math.min(1, Math.max(0, position)) * (gradient.length - 1);
    const index = Math.min(gradient.length - 2, Math.floor(t));
    const [from, to] = [rgb(gradient[index]), rgb(gradient[index + 1])];
    const local = t - index;
    return `rgb(${from.map((c, i) => Math.round(c + (to[i] - c) * local)).join(",")})`;
  };
  const mask = document.createElement("canvas");
  mask.width = grid.cols;
  mask.height = grid.rows;
  const mctx = mask.getContext("2d");
  for (let index = 0; index < frames.length; index += 1) {
    const img = new Image();
    img.src = `data:image/svg+xml;base64,${btoa(frames[index])}`;
    await img.decode();
    mctx.clearRect(0, 0, grid.cols, grid.rows);
    mctx.drawImage(img, 0, 0, grid.cols, grid.rows);
    const alpha = mctx.getImageData(0, 0, grid.cols, grid.rows).data;
    const ox = (index % 8) * CELL_W + (CELL_W - (grid.cols - 1) * pitch) / 2;
    const oy = Math.floor(index / 8) * CELL_H + (CELL_H - (grid.rows - 1) * pitch) / 2;
    for (let y = 0; y < grid.rows; y += 1) {
      for (let x = 0; x < grid.cols; x += 1) {
        if (alpha[(y * grid.cols + x) * 4 + 3] > 110) {
          octx.fillStyle = colorAt(x / (grid.cols - 1));
          octx.beginPath();
          octx.arc(ox + x * pitch, oy + y * pitch, radius, 0, Math.PI * 2);
          octx.fill();
        }
      }
    }
  }
  return out.toDataURL("image/png");
}, { frames, grid: GRID, gradient: LOGO_GRADIENT });
await browser.close();

const petDir = path.join(brandDir, "codex-pet");
mkdirSync(petDir, { recursive: true });
writeFileSync(path.join(petDir, "spritesheet.png"), Buffer.from(sheet.split(",")[1], "base64"));

for (const [name, art] of Object.entries(braille)) {
  console.log(`${name}:\n${JSON.stringify(art, null, 2)}`);
}
