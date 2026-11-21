/**
 * The Fireworks symbol (no wordmark), one mark for every Nexus surface: the
 * symbol as a grid of Braille dots, each column colored along the CLI's logo
 * gradient (amber to pink, lib/ui/tokens.mjs LOGO_GRADIENT), on a transparent
 * background, so it reads on dark and light terminals alike.
 *
 * Used by the `nexus <harness>` success line, the install banner and the
 * Claude Code status line. The OpenCode plugin carries a copy of the same art,
 * and the Codex pet's sprite sheet draws the same dots as an image.
 *
 * The art is precomputed so hot paths (the status line) never decode an image.
 * Source: brand/fireworks-symbol.svg (viewBox 866x400). Regenerate with
 * scripts/render-brand-assets.mjs.
 */

import { truecolor } from "./palette.mjs";
import { LOGO_GRADIENT } from "./tokens.mjs";

/** 9x2 cells: beside the status line, the success line and OpenCode's card. */
export const LOGO_CELLS_SMALL = Object.freeze([
  "⠀⣠⡀⢻⣀⡟⢀⣄⠀",
  "⢠⣬⣹⡎⠛⢱⣏⣥⡄",
]);

/**
 * 8x2 cells: the Claude Code status line, which users see all the time, so the
 * mark is a dot row shorter than LOGO_CELLS_SMALL and that bottom dot row is
 * left empty: a little smaller, with a gap above Claude Code's own line.
 */
export const LOGO_CELLS_STATUS_LINE = Object.freeze([
  "⠀⣄⡘⣧⣼⢃⣠⠀",
  "⠴⠬⠿⠎⠱⠯⠥⠦",
]);

/** 17x4 cells: above the install banner. */
export const LOGO_CELLS_LARGE = Object.freeze([
  "⠀⠀⠀⠀⠀⠸⣿⡄⠀⢠⣿⠇⠀⠀⠀⠀⠀",
  "⠀⠀⣾⣦⡀⠀⢹⣷⠀⣾⡏⠀⢀⣴⣷⠀⠀",
  "⠀⠀⠀⠙⢿⣦⡀⢻⣾⡟⢀⣴⡿⠋⠀⠀⠀",
  "⣰⣶⣶⣶⣦⣽⡿⠀⠉⠀⢿⣯⣴⣶⣶⣶⣆",
]);

/** @param {string} hex */
function rgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Color at `position` (0 = left edge, 1 = right edge) along the logo gradient.
 * Same interpolation as theme.mjs logoGradientAt, kept here so the status line
 * doesn't load the theme module (and its ansis dependency) on every refresh.
 * @param {number} position
 * @returns {number[]}
 */
function gradientAt(position) {
  const t = Math.min(1, Math.max(0, position)) * (LOGO_GRADIENT.length - 1);
  const index = Math.min(LOGO_GRADIENT.length - 2, Math.floor(t));
  const local = t - index;
  const [from, to] = [rgb(LOGO_GRADIENT[index]), rgb(LOGO_GRADIENT[index + 1])];
  return from.map((channel, i) => Math.round(channel + (to[i] - channel) * local));
}

/** @param {number[]} color */
function foreground(color) {
  return truecolor(`#${color.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`);
}

/**
 * The symbol as painted cell rows, each column colored along the logo
 * gradient, no background. Without color, the plain dots are returned (still
 * recognizable, in the terminal's own color).
 * @param {readonly string[]} cells LOGO_CELLS_SMALL or LOGO_CELLS_LARGE
 * @param {{ color?: boolean }} [options]
 * @returns {string[]}
 */
export function paintLogoCells(cells, { color = true } = {}) {
  if (!color) {
    return [...cells];
  }
  const width = Math.max(...cells.map((row) => [...row].length));
  const columns = [...Array(width).keys()].map((column) => foreground(gradientAt(width > 1 ? column / (width - 1) : 0)));
  return cells.map((row) => `${[...row].map((char, column) => `${columns[column]}${char}`).join("")}\u001b[0m`);
}

/**
 * Put a logo (LOGO_CELLS_SMALL unless `cells` says otherwise) to the left of
 * `lines` (two rows; extra lines continue below, indented to line up).
 * Callers decide whether color is on.
 * @param {string[]} lines already-styled lines
 * @param {{ gap?: string, cells?: readonly string[] }} [options]
 * @returns {string[]}
 */
export function besideLogo(lines, { gap = "  ", cells = LOGO_CELLS_SMALL } = {}) {
  const logo = paintLogoCells(cells);
  const blank = " ".repeat([...cells[0]].length);
  const rows = Math.max(logo.length, lines.length);
  return [...Array(rows).keys()].map((index) => {
    const left = logo[index] ?? blank;
    const right = lines[index] ?? "";
    return right ? `${left}${gap}${right}` : left;
  });
}
