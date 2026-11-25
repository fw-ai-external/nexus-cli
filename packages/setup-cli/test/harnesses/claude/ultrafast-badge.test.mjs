import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import process from "node:process";

import { claudeStatusLineWidth, fitClaudeStatusLineRows, renderClaudeStatusLine } from "../../../lib/harnesses/claude/statusline.mjs";
import {
  ULTRAFAST_BOOST_FILE,
  clearUltrafastBadge,
  formatTimeLeft,
  readUltrafastBadge,
  ultrafastBadgeParts,
} from "../../../lib/harnesses/claude/ultrafast-badge.mjs";
import { withTempHome } from "../../helpers.mjs";

const NOW = Date.parse("2026-11-20T16:00:00Z");
const HOUR = 3_600_000;
const RECORD = { active: true, activatedAt: NOW, expiresAt: NOW + 5 * HOUR, updatedAt: NOW };

// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

async function writeRecord(home, record) {
  const file = path.join(home, ULTRAFAST_BOOST_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(record));
}

describe("Ultra-fast badge", () => {
  it("shows the share of the window and the time left", () => {
    assert.deepEqual(ultrafastBadgeParts(RECORD, NOW, {}), { share: "100%", left: "5h 00m" });
    assert.deepEqual(ultrafastBadgeParts(RECORD, NOW + (2 * 60 + 25) * 60_000, {}), { share: "52%", left: "2h 35m" });
    assert.deepEqual(ultrafastBadgeParts(RECORD, NOW + 5 * HOUR - 10 * 60_000, {}), { share: "3%", left: "10m" });
    // Without the window's start, the share is left out.
    assert.deepEqual(ultrafastBadgeParts({ ...RECORD, activatedAt: null }, NOW, {}), { share: "", left: "5h 00m" });
    assert.equal(formatTimeLeft(59 * 60_000), "59m");
  });

  it("shows nothing for an ended, inactive, stale or malformed record, or with the switch off", () => {
    assert.equal(ultrafastBadgeParts(RECORD, NOW + 5 * HOUR, {}), null);
    assert.equal(ultrafastBadgeParts({ ...RECORD, active: false }, NOW, {}), null);
    assert.equal(ultrafastBadgeParts({ ...RECORD, updatedAt: NOW - 25 * HOUR, expiresAt: NOW + HOUR }, NOW, {}), null);
    assert.equal(ultrafastBadgeParts({ ...RECORD, updatedAt: undefined }, NOW, {}), null);
    assert.equal(ultrafastBadgeParts("nope", NOW, {}), null);
    assert.equal(ultrafastBadgeParts(RECORD, NOW, { NEXUS_ULTRAFAST_STATUS: "0" }), null);
  });

  it("reads the record the banner mod writes, and `on`/`off` clear it", async () => {
    await withTempHome("ultrafast-badge", async (home) => {
      assert.equal(await readUltrafastBadge(home, NOW), null);
      await writeRecord(home, RECORD);
      assert.deepEqual(await readUltrafastBadge(home, NOW), { share: "100%", left: "5h 00m" });
      await clearUltrafastBadge(home);
      assert.equal(existsSync(path.join(home, ULTRAFAST_BOOST_FILE)), false);
      assert.equal(await readUltrafastBadge(home, NOW), null);
    });
  });

  it("fits the rows to the terminal: the warning moves down, then shortens, then the badge compacts", () => {
    const parts = {
      badge: { share: "84%", left: "4h 13m" },
      keyExpiry: "⚠ key expires in 14h · run nexus login",
      shortKeyExpiry: "⚠ key expires in 14h",
      usage: ["━━━━━━━━━━━━━━━━", "$0.0056"],
      legend: ["━ GLM 5.3 Flash 0% cache"],
    };
    const rows = (width) => fitClaudeStatusLineRows({ ...parts, width }).map(stripAnsi);
    const [wide1, wide2] = rows(140);
    assert.match(wide1, /^ϟ Ultra-fast 84%, 4h 13m left · ⚠ key expires in 14h · run nexus login · ━/);
    assert.equal(wide2, "━ GLM 5.3 Flash 0% cache");
    const [mid1, mid2] = rows(90);
    assert.match(mid1, /^ϟ Ultra-fast 84%, 4h 13m left · ━/);
    assert.equal(mid2, "⚠ key expires in 14h · run nexus login · ━ GLM 5.3 Flash 0% cache");
    const [narrow1, narrow2] = rows(50);
    assert.match(narrow1, /^ϟ Ultra-fast 4h 13m left · ━/);
    assert.equal(narrow2, "⚠ key expires in 14h · ━ GLM 5.3 Flash 0% cache");
    // Down to here everything fits; narrower, Claude Code cuts the end with "…".
    for (const width of [140, 90]) {
      for (const row of rows(width)) assert.ok([...row].length <= width, `${width}: ${row}`);
    }
    // Without a boost or a warning, nothing moves.
    assert.deepEqual(fitClaudeStatusLineRows({ ...parts, badge: null, keyExpiry: "", shortKeyExpiry: "", width: 30 }).map(stripAnsi),
      ["━━━━━━━━━━━━━━━━ · $0.0056", "━ GLM 5.3 Flash 0% cache"]);
    assert.equal(claudeStatusLineWidth({ COLUMNS: "120" }), 120 - 13);
    assert.equal(claudeStatusLineWidth({}), 100 - 13);
  });

  it("leads the status line's first row while the boost is on", async () => {
    const previousColumns = process.env.COLUMNS;
    process.env.COLUMNS = "200";
    after(() => {
      if (previousColumns === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = previousColumns;
    });
    await withTempHome("ultrafast-badge-line", async (home) => {
      const input = { model: { id: "accounts/fireworks/models/glm-5p3-flash" } };
      await writeRecord(home, { ...RECORD, activatedAt: Date.now(), expiresAt: Date.now() + 5 * HOUR, updatedAt: Date.now() });
      const [first] = stripAnsi(await renderClaudeStatusLine(input, { home })).split("\n");
      assert.match(first, /ϟ Ultra-fast 100%, (5h 00m|4h 59m) left · /, first);
      // The badge leads, ahead of a key-expiry warning.
      const mintedFile = path.join(home, ".nexus", "minted-key.json");
      await writeFile(mintedFile, JSON.stringify({
        keyId: "example-key",
        userName: "user@example.com",
        keyFingerprint: "example-fingerprint",
        expiresAt: new Date(Date.now() + 14 * HOUR).toISOString(),
      }));
      const [withWarning] = stripAnsi(await renderClaudeStatusLine(input, { home })).split("\n");
      assert.match(withWarning, /ϟ Ultra-fast .* left · ⚠ key expires in /, withWarning);
      await clearUltrafastBadge(home);
      assert.doesNotMatch(stripAnsi(await renderClaudeStatusLine(input, { home })), /Ultra-fast/);
    });
  });
});
