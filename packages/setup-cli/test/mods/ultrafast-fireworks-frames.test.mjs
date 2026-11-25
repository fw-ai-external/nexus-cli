import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LOGO_CELLS_STATUS_LINE } from "../../lib/ui/brand-logo.mjs";
import {
  BANNER_MS,
  COLORS,
  FIREWORKS,
  LOGO,
  LOGO_SOURCE,
  MAX_ROWS,
  LOGO_ROW,
  RISE_TICKS,
  SUBTITLE_ROW,
  STAGE_TICKS,
  TICKS,
  TITLE_ROW,
  TICK_MS,
  TITLE,
  WIPE_MS,
  WIPE_STEPS,
  WIPE_STEP_MS,
  activationToPlay,
  showsBanner,
  FLAG_MAX_AGE_MS,
  bannerFrame,
  bannerRows,
  burstMarks,
  burstStage,
  holdMarks,
  noise,
  ring,
  scaleLogo,
  subtitleCells,
  toRuns,
} from "../../mods/ultrafast-fireworks/hooks/frames.mjs";

const NOW = Date.UTC(2026, 0, 1);
const STATUS = { active: true, reason: "You sent 5M tokens!", expiresAt: NOW + 5 * 3_600_000 };
const SUBTITLE = "You sent 5M tokens! Enjoy faster responses for the next 5h";
// The prototype's terminal is 120 columns; Claude Code keeps 5 of them for
// the band's [–] mark, so the band's body is 115.
const BODY = 115;
const text = (row) => row.map((run) => run.text).join("");
const rowsAt = (elapsedMs, rows = MAX_ROWS, columns = BODY) =>
  bannerFrame({ elapsedMs, columns, rows, status: STATUS, now: NOW }).map(text);
const cellsOf = (row) => row.flatMap((run) => [...run.text].map((ch) => ({ ch, tone: run.tone, bold: run.bold })));
const holdAt = (tick) => WIPE_MS + tick * TICK_MS;
const logoLine = (i) => LOGO[i].replaceAll("⠀", " ").trim();

describe("ultrafast mod: the banner's layout", () => {
  it("is nine rows: sky, the logo, a blank row, the title, a blank row and the subtitle", () => {
    const rows = rowsAt(holdAt(0));
    assert.equal(rows.length, MAX_ROWS);
    assert.equal(MAX_ROWS, 9);
    // The subtitle is the last row: no sky under it.
    assert.equal(SUBTITLE_ROW, MAX_ROWS - 1);
    // The top row stays empty all show long: a gap under Claude Code's text.
    for (let ms = WIPE_MS; ms < BANNER_MS; ms += TICK_MS) assert.equal(rowsAt(ms)[0].trim(), "", `${ms}`);
    for (let i = 0; i < 4; i += 1) assert.ok(rows[LOGO_ROW + i].includes(logoLine(i)), rows[LOGO_ROW + i]);
    assert.ok(rows[TITLE_ROW].includes(TITLE));
    // A blank row keeps the title and subtitle apart (sparks may still
    // twinkle out at its ends).
    const start = rows[SUBTITLE_ROW].indexOf(SUBTITLE);
    assert.equal([...rows[TITLE_ROW + 1]].slice(start - 2, start + SUBTITLE.length + 2).join("").trim(), "");
    assert.ok(rows[SUBTITLE_ROW].includes(SUBTITLE));
  });

  it("centers the logo, title and subtitle on the whole terminal row", () => {
    const rows = rowsAt(WIPE_MS - 1 + 1);
    const width = BODY + 5;
    assert.equal(rows[TITLE_ROW].indexOf(TITLE), Math.floor((width - [...TITLE].length) / 2));
    assert.equal(rows[SUBTITLE_ROW].indexOf(SUBTITLE), Math.floor((width - SUBTITLE.length) / 2));
    assert.equal(rows[LOGO_ROW + 3].indexOf(logoLine(3)), Math.floor((width - [...LOGO[0]].length) / 2));
  });

  it("draws the status line's mark scaled up 2x, in the logo gradient", () => {
    assert.deepEqual([...LOGO_SOURCE], [...LOGO_CELLS_STATUS_LINE]);
    assert.deepEqual([...LOGO], [
      "⠀⠀⠀⠀⠀⢾⣷⡀⢀⣾⡷⠀⠀⠀⠀⠀",
      "⠀⠀⢿⣦⣄⠈⢿⣿⣿⡿⠁⣠⣴⡿⠀⠀",
      "⢀⣤⡈⠙⣿⣷⣄⠝⠫⣠⣾⠛⠋⢁⣤⡀",
      "⠛⠛⠛⠛⠛⠛⠋⠀⠀⠙⠛⠛⠛⠛⠛⠛",
    ]);
    // Twice the rows and columns; blank stays blank; a lone block gets its corners rounded.
    assert.deepEqual(scaleLogo(["⠀"]), ["⠀⠀", "⠀⠀"]);
    assert.deepEqual(scaleLogo(["⣿"]), ["⣾⣷", "⢿⡿"]);
    const frame = bannerFrame({ elapsedMs: holdAt(0), columns: BODY, rows: MAX_ROWS, status: STATUS, now: NOW });
    const tones = new Set(frame.slice(LOGO_ROW, LOGO_ROW + 4).flatMap(cellsOf).filter((c) => /[⠁-⣿]/.test(c.ch) && c.tone?.startsWith("g")).map((c) => c.tone));
    assert.deepEqual([...tones].sort(), ["g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7"]);
  });

  it("shrinks to fit a shorter band, keeping the space under the title while it can", () => {
    assert.equal(bannerRows(40, 99), MAX_ROWS);
    assert.equal(bannerRows(MAX_ROWS - 1, 99), MAX_ROWS - 1);
    assert.equal(bannerRows(1, 99), 2);
    // One row short: the top row of sky goes.
    const short = rowsAt(holdAt(10), MAX_ROWS - 1);
    assert.equal(short.length, MAX_ROWS - 1);
    assert.ok(short[TITLE_ROW - 1].includes(TITLE) && short[SUBTITLE_ROW - 1].includes(SUBTITLE));
    // Shorter still: the title, the blank row and the subtitle.
    for (const rows of [3, 5, MAX_ROWS - 2]) {
      const frame = rowsAt(holdAt(10), rows);
      assert.equal(frame.length, 3);
      assert.ok(frame[0].includes(TITLE) && frame[2].includes(SUBTITLE));
    }
    // Two: the title and subtitle alone.
    const two = rowsAt(holdAt(10), 2);
    assert.equal(two.length, 2);
    assert.ok(two[0].includes(TITLE) && two[1].includes(SUBTITLE));
  });

  it("ends at BANNER_MS and draws nothing before the start", () => {
    assert.equal(bannerFrame({ elapsedMs: -1, columns: BODY }), null);
    // A boost that has ended never draws, even mid-play.
    assert.equal(bannerFrame({ elapsedMs: 1_000, columns: BODY, status: { ...STATUS, expiresAt: NOW }, now: NOW }), null);
    assert.equal(bannerFrame({ elapsedMs: 1_000, columns: BODY, status: { ...STATUS, expiresAt: NOW - 1 }, now: NOW }), null);
    assert.ok(bannerFrame({ elapsedMs: 1_000, columns: BODY, status: { ...STATUS, expiresAt: NOW + 1 }, now: NOW }));
    assert.ok(bannerFrame({ elapsedMs: 1_000, columns: BODY, status: { ...STATUS, expiresAt: null }, now: NOW }), "no end time: draws");
    assert.equal(bannerFrame({ elapsedMs: BANNER_MS, columns: BODY }), null);
    assert.equal(bannerFrame({ elapsedMs: Number.NaN, columns: BODY }), null);
    assert.ok(bannerFrame({ elapsedMs: BANNER_MS - 1, columns: BODY }));
    assert.ok(WIPE_MS + TICKS * TICK_MS <= BANNER_MS);
  });
});

describe("ultrafast mod: the wipe", () => {
  it("runs ten steps 65 ms apart, the streak moving right each step", () => {
    assert.equal(WIPE_STEPS, 10);
    assert.equal(WIPE_STEP_MS, 65);
    let last = -1;
    for (let step = 0; step < WIPE_STEPS; step += 1) {
      const head = rowsAt(step * WIPE_STEP_MS)[TITLE_ROW].indexOf("━ϟ");
      if (head >= 0) {
        assert.ok(head > last, `step ${step}`);
        last = head;
      }
    }
    assert.ok(last > 0);
  });

  it("puts ━ streaks with ϟ and » heads on the title and subtitle rows", () => {
    const rows = rowsAt(4 * WIPE_STEP_MS);
    assert.match(rows[TITLE_ROW], /━{18}ϟ/);
    // The » sits on the subtitle streak's last cell.
    assert.match(rows[SUBTITLE_ROW], /━{11}»/);
    const head = rows[TITLE_ROW].indexOf("━ϟ") + 1;
    assert.equal(rows[TITLE_ROW].slice(head + 1).trim(), "");
    assert.ok(rows[TITLE_ROW].slice(0, head - 18).trim().startsWith("ϟ"), rows[TITLE_ROW]);
  });

  it("shows the logo from the first step", () => {
    const rows = rowsAt(0);
    for (let i = 0; i < 4; i += 1) assert.ok(rows[LOGO_ROW + i].includes(logoLine(i)));
  });
});

describe("ultrafast mod: the fireworks", () => {
  it("rise for five ticks, then burst in seven stages", () => {
    assert.equal(RISE_TICKS, 5);
    assert.deepEqual([...STAGE_TICKS], [1, 2, 2, 3, 2, 2, 2]);
    assert.equal(burstStage(0), 0);
    assert.equal(burstStage(1), 1);
    assert.equal(burstStage(2), 1);
    assert.equal(burstStage(13), 6);
    assert.equal(burstStage(14), -1);
    const glyphs = (stage) => burstMarks(4, 50, "amber", "amberHi", "✦", 2.6, stage).map((m) => m.ch).join("");
    assert.match(glyphs(0), /^✦·+$/);
    assert.match(glyphs(1), /^✺✦+$/);
    assert.match(glyphs(4), /✧/);
    assert.equal(glyphs(7), "");
  });

  it("launch a rocket from the bottom that climbs to its burst row", () => {
    const [launch, burstRow, at] = FIREWORKS[0];
    const x = Math.round((BODY + 5) * at);
    const rocketRow = (tick) => holdMarks(tick, BODY + 5).find((m) => m.ch === "•" && m.x === x)?.row;
    assert.equal(rocketRow(launch), MAX_ROWS - 1);
    assert.ok(rocketRow(launch + 2) < MAX_ROWS - 1);
    assert.ok(rocketRow(launch + 4) >= burstRow);
    assert.equal(rocketRow(launch + RISE_TICKS), undefined);
  });

  it("draw rings 2.2 times as wide as tall", () => {
    const points = ring(5, 50, 2, 16, "✦", ["amber", "amberHi"]);
    assert.equal(Math.max(...points.map((p) => p.x)) - 50, Math.round(2 * 2.2));
    assert.equal(Math.max(...points.map((p) => p.row)) - 5, 2);
    assert.deepEqual([...new Set(points.map((p) => p.tone))], ["amber", "amberHi"]);
  });

  it("never cover the logo, title or subtitle, and stay inside the band's body", () => {
    for (let tick = 0; tick < TICKS; tick += 1) {
      const rows = rowsAt(holdAt(tick));
      for (const row of rows) assert.ok([...row].length <= BODY, `tick ${tick}`);
      assert.ok(rows[TITLE_ROW].includes(TITLE) && rows[SUBTITLE_ROW].includes(SUBTITLE), `tick ${tick}`);
      for (let i = 0; i < 4; i += 1) assert.ok(rows[LOGO_ROW + i].includes(logoLine(i)), `tick ${tick}`);
    }
  });

  it("fill both sides over the hold", () => {
    const seen = { left: 0, right: 0 };
    for (let tick = 0; tick < TICKS; tick += 1) {
      for (const row of rowsAt(holdAt(tick)).slice(0, 7)) {
        [...row].forEach((ch, col) => {
          if (/[✦✧✺*•]/.test(ch)) seen[col < BODY / 2 ? "left" : "right"] += 1;
        });
      }
    }
    assert.ok(seen.left > 20 && seen.right > 20, JSON.stringify(seen));
  });

  it("twinkle from seeded noise, the same every play", () => {
    assert.equal(noise(3, 4), noise(3, 4));
    assert.ok(noise(3, 4) >= 0 && noise(3, 4) < 1);
    assert.deepEqual(rowsAt(holdAt(17)), rowsAt(holdAt(17)));
  });

  it("use only tones that have a color", () => {
    for (let ms = 0; ms < BANNER_MS; ms += 40) {
      for (const row of bannerFrame({ elapsedMs: ms, columns: BODY, rows: MAX_ROWS, status: STATUS, now: NOW })) {
        for (const run of row) assert.ok(run.tone === null || run.tone in COLORS, `${ms}ms: ${run.tone}`);
      }
    }
  });
});

describe("ultrafast mod: text and runs", () => {
  it("says faster responses without a speed-up figure", () => {
    const subtitle = rowsAt(holdAt(0))[SUBTITLE_ROW];
    assert.ok(subtitle.includes(SUBTITLE));
    assert.doesNotMatch(subtitle, /\d+\s*×/);
  });

  it("cuts a long reason so the offer always shows", () => {
    const cells = subtitleCells({ reason: "x".repeat(200), expiresAt: NOW + 60_000 }, NOW, 60);
    const line = cells.map((c) => c.ch).join("");
    assert.ok(line.endsWith("Enjoy faster responses for the next 1m"));
    assert.ok(line.includes("…"));
    assert.ok(line.length <= 60);
  });

  it("merges cells into runs of one tone and weight, trailing blanks dropped", () => {
    const runs = toRuns([
      { ch: " ", tone: null }, { ch: "a", tone: "amber", bold: true }, { ch: "b", tone: "amber", bold: true },
      { ch: " ", tone: "amber" }, { ch: "c", tone: "amber", bold: true }, { ch: "d", tone: "amber", bold: false }, { ch: " ", tone: null },
    ]);
    assert.deepEqual(runs, [
      { text: " ", tone: null, bold: false },
      { text: "ab c", tone: "amber", bold: true },
      { text: "d", tone: "amber", bold: false },
    ]);
    assert.deepEqual(toRuns([{ ch: " ", tone: null }]), []);
  });
});

describe("ultrafast mod: activation from the status line's cached flag", () => {
  it("plays an active, unplayed activation once", () => {
    const cached = { fetchedAt: NOW, status: { active: true, activationId: "a1", expiresAt: NOW + 1000 } };
    assert.equal(activationToPlay(cached, undefined, NOW).play, true);
    assert.equal(activationToPlay(cached, undefined, NOW).key, "a1");
    assert.equal(activationToPlay(cached, "a1", NOW).play, false);
  });

  it("plays a running boost again in a new session, which starts with nothing played", () => {
    const cached = { fetchedAt: NOW, status: { active: true, activationId: "a1", expiresAt: NOW + 1000 } };
    assert.equal(activationToPlay(cached, "", NOW).play, true);
    // The session steps themselves are run in ultrafast-session.test.mjs.
  });

  it("ignores inactive, expired or malformed flags", () => {
    assert.equal(activationToPlay(null, undefined, NOW).play, false);
    assert.equal(activationToPlay("nope", undefined, NOW).play, false);
    assert.equal(activationToPlay({ status: { active: false } }, undefined, NOW).play, false);
    assert.equal(activationToPlay({ status: { active: true, expiresAt: NOW } }, undefined, NOW).play, false);
  });

  it("falls back to the window's times for the key", () => {
    const at = (status) => activationToPlay({ fetchedAt: NOW, status }, "", NOW).key;
    assert.equal(at({ active: true, activatedAt: 5 }), "at:5");
    assert.equal(at({ active: true, expiresAt: NOW + 9 }), `until:${NOW + 9}`);
    assert.equal(at({ active: true }), "active");
  });

  it("ignores a flag the status line would reject as stale", () => {
    const status = { active: true, activationId: "a1" };
    assert.equal(activationToPlay({ status }, undefined, NOW).play, false);
    assert.equal(activationToPlay({ fetchedAt: NOW - FLAG_MAX_AGE_MS - 1, status }, undefined, NOW).play, false);
    assert.equal(activationToPlay({ fetchedAt: NOW + 120_000, status }, undefined, NOW).play, false);
    assert.equal(activationToPlay({ fetchedAt: NOW - FLAG_MAX_AGE_MS + 1, status }, undefined, NOW).play, true);
  });
});

describe("where the banner plays", () => {
  it("plays only in the terminal app", () => {
    for (const entrypoint of ["cli", undefined, ""]) {
      assert.equal(showsBanner(entrypoint), true, String(entrypoint));
    }
    // These load the mod from the same user settings but have no band, or
    // (the desktop app) keep the animation off.
    for (const entrypoint of ["sdk-cli", "sdk-ts", "claude-vscode", "claude-desktop"]) {
      assert.equal(showsBanner(entrypoint), false, entrypoint);
    }
  });
});
