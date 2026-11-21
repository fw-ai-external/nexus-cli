import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  LOGO_CELLS_LARGE,
  LOGO_CELLS_SMALL,
  LOGO_CELLS_STATUS_LINE,
  besideLogo,
  paintLogoCells,
} from "../../lib/ui/brand-logo.mjs";
import { logoGradientAt } from "../../lib/ui/theme.mjs";
import { LOGO_GRADIENT } from "../../lib/ui/tokens.mjs";

const BRAILLE_ROW = /^[⠀-⣿]+$/u;
const PAINTED_ROW = /^(?:\x1b\[38;[25];[\d;]+m[⠀-⣿])+\x1b\[0m$/u;
const PLUGIN = fileURLToPath(new URL("../../lib/harnesses/opencode/nexus-plugin/tui.tsx", import.meta.url));

/** SGR params of every painted cell in a row. */
function cellColors(row) {
  return [...row.matchAll(/\x1b\[([\d;]+)m[⠀-⣿]/gu)].map((match) => match[1]);
}

describe("brand logo", () => {
  it("ships rectangular Braille cell art at 9x2, 8x2 and 17x4", () => {
    for (const [art, cols, rows] of [[LOGO_CELLS_SMALL, 9, 2], [LOGO_CELLS_STATUS_LINE, 8, 2], [LOGO_CELLS_LARGE, 17, 4]]) {
      assert.equal(art.length, rows);
      for (const row of art) {
        assert.match(row, BRAILLE_ROW);
        assert.equal([...row].length, cols);
      }
    }
  });

  it("paints each column along the logo gradient with no background", () => {
    const painted = paintLogoCells(LOGO_CELLS_SMALL);
    assert.equal(painted.length, LOGO_CELLS_SMALL.length);
    for (const row of painted) {
      assert.match(row, PAINTED_ROW);
      assert.doesNotMatch(row, /\x1b\[48;/, "transparent: no background color");
    }
    const rows = painted.map(cellColors);
    assert.deepEqual(rows[0], rows[1], "a column has the same color on every row");
    assert.notEqual(rows[0][0], rows[0].at(-1), "left and right ends differ");
  });

  it("returns plain dots without color", () => {
    for (const row of paintLogoCells(LOGO_CELLS_SMALL, { color: false })) {
      assert.match(row, BRAILLE_ROW);
    }
  });

  it("keeps the OpenCode plugin's copy of the mark identical to the CLI's", () => {
    const source = readFileSync(PLUGIN, "utf8");
    const copy = source.match(/const LOGO_CELLS = \[([\s\S]*?)\]/)[1].match(/"([^"]+)"/g).map((row) => row.slice(1, -1));
    assert.deepEqual(copy, [...LOGO_CELLS_SMALL]);
  });

  it("puts the small logo beside two lines and indents any extra ones", () => {
    const rows = besideLogo(["ok Claude Code → Fireworks", "note", "more"]);
    assert.equal(rows.length, 3);
    assert.ok(rows[0].endsWith("\x1b[0m  ok Claude Code → Fireworks"));
    assert.ok(rows[1].endsWith("\x1b[0m  note"));
    assert.equal(rows[2], `${" ".repeat(9)}  more`);
    assert.match(besideLogo([])[0], PAINTED_ROW, "no text: the logo alone");
  });


  it("colors each column exactly as the CLI's logo gradient does", () => {
    process.env.COLORTERM = process.env.COLORTERM || "truecolor";
    const width = LOGO_CELLS_SMALL[0].length;
    const colors = cellColors(paintLogoCells(LOGO_CELLS_SMALL)[0]);
    colors.forEach((sgr, column) => {
      const expected = logoGradientAt(column / (width - 1)).replace(/^#/, "");
      const [r, g, b] = sgr.split(";").slice(-3).map(Number);
      const actual = [r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("");
      assert.equal(actual.toLowerCase(), expected.toLowerCase(), `column ${column}`);
    });
  });

  it("keeps the OpenCode plugin's gradient identical to the CLI's tokens", () => {
    const source = readFileSync(PLUGIN, "utf8");
    const copy = JSON.parse(source.match(/const GRADIENT = (\[[^\]]*\])/)[1]);
    assert.deepEqual(copy, [...LOGO_GRADIENT]);
  });

  it("keeps the status-line mark smaller, with its bottom dot row empty", () => {
    assert.ok([...LOGO_CELLS_STATUS_LINE[0]].length < [...LOGO_CELLS_SMALL[0]].length);
    // Braille dots 7 and 8 (0x40, 0x80) are a cell's bottom dot row.
    for (const char of LOGO_CELLS_STATUS_LINE.at(-1)) {
      assert.equal((char.codePointAt(0) - 0x2800) & 0xc0, 0, `bottom dot row lit in ${char}`);
    }
    const rows = besideLogo(["a", "b"], { cells: LOGO_CELLS_STATUS_LINE });
    assert.equal(rows.length, 2);
    assert.ok(rows[1].endsWith("\x1b[0m  b"));
  });
});
