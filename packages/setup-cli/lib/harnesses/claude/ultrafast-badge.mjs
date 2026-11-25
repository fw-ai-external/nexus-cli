/**
 * The Ultra-fast badge at the front of the Claude Code status line while the
 * account's boost is on: "ϟ Ultra-fast 100%, 5h 00m left".
 *
 * The status line never asks the network for it. The banner mod
 * (mods/ultrafast-fireworks) checks the account's Ultra-fast status and records the
 * boost window in {@link ULTRAFAST_BOOST_FILE}; the status line reads that
 * small file when it draws. `nexus claude on` and `off` remove it, so a
 * boost never shows for another account's key.
 */

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/** Where the banner mod records the boost window, relative to HOME. */
export const ULTRAFAST_BOOST_FILE = path.join(".nexus", "ultrafast-boost.json");
/** A record older than this is ignored: the mod refreshes it every few minutes. */
export const ULTRAFAST_BOOST_MAX_AGE_MS = 24 * 60 * 60_000;

function boostFile(home) {
  return path.join(home, ULTRAFAST_BOOST_FILE);
}

/** Time left as hours and minutes, e.g. "5h 00m", or "45m" under an hour. */
export function formatTimeLeft(ms) {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The badge's parts for a recorded boost at `now`: the share of the window
 * still left ("100%", or "" when the window's start is unknown) and the time
 * left ("5h 00m"). Null when no boost is on, the record is stale or malformed,
 * or `NEXUS_ULTRAFAST_STATUS=0`.
 * @param {unknown} record
 * @param {number} now
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ share: string, left: string } | null}
 */
export function ultrafastBadgeParts(record, now, env = process.env) {
  if (env.NEXUS_ULTRAFAST_STATUS === "0") return null;
  if (!record || typeof record !== "object" || record.active !== true) return null;
  const { activatedAt, expiresAt, updatedAt } = record;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
  if (typeof updatedAt !== "number" || now - updatedAt > ULTRAFAST_BOOST_MAX_AGE_MS || updatedAt > now + 60_000) return null;
  const total = typeof activatedAt === "number" && Number.isFinite(activatedAt) ? expiresAt - activatedAt : 0;
  const share = total > 0 ? `${Math.min(100, Math.max(0, Math.round(((expiresAt - now) / total) * 100)))}%` : "";
  return { share, left: formatTimeLeft(expiresAt - now) };
}

/**
 * The recorded boost's badge parts for the status line, or null. Never
 * throws: a missing or unreadable file means no badge.
 * @param {string} home
 * @param {number} [now]
 */
export async function readUltrafastBadge(home, now = Date.now()) {
  if (!home) return null;
  try {
    return ultrafastBadgeParts(JSON.parse(await readFile(boostFile(home), "utf8")), now);
  } catch {
    return null;
  }
}

/** Forget the recorded boost (when `nexus claude on` or `off` changes the key). Never throws. */
export async function clearUltrafastBadge(home) {
  if (!home) return;
  try {
    await rm(boostFile(home), { force: true });
  } catch {}
}
