/**
 * What the mod does after each boost check, when a play counts, and what a
 * `/clear` resets, as plain functions over the session's state, so tests can
 * run the same sequence the hooks run (`register.tsx` can't load outside
 * Claude Code).
 *
 * The played marker belongs to one conversation: the hooks keep it in
 * `$.state`, which a hot reload of the mod keeps, and reset it when a `/clear`
 * ends the conversation. A new session or a `/clear` starts with nothing
 * played, so while a boost is running the banner plays once in each.
 */

import { activationToPlay, boostsModel, showsBanner } from "./frames.mjs";
import { sanitizeReason } from "./rewards.mjs";

/**
 * `saveDue`: `playedKey` changed during a render, where `$.state` can't be
 * written, so the hooks save it from outside one ({@link takeSave}).
 * `conversationId`: the session id the state belongs to.
 * @returns {{ playedKey: string, pendingKey: string, saveDue: boolean, conversationId: string }}
 */
export function newSession() {
  return { playedKey: "", pendingKey: "", saveDue: false, conversationId: "" };
}

/**
 * After a boost check answered `status`: the record for the status line
 * badge (written whatever the entrypoint), and the status to play now with
 * its activation `key`, or null. Changes nothing: {@link startPlay} does,
 * once the play begins.
 * @param {{ playedKey: string, pendingKey: string }} session
 * `fetchedAt` is when `status` was fetched (default `now`; earlier for the
 * last status reused by {@link nextCheck}). `model` is the session's main
 * loop model: only a Nexus Auto session plays ({@link boostsModel}), and a
 * session that switches to Auto during a boost plays at its next check.
 * `demoRunning`: a `/ultrafast-demo` is playing.
 * @param {{ status: { active: boolean, activatedAt?: number | null, expiresAt?: number | null }, entrypoint: unknown, model: unknown, now: number, fetchedAt?: number, demoRunning?: boolean }} check
 */
export function afterBoostCheck(session, { status, entrypoint, model, now, fetchedAt = now, demoRunning = false }) {
  const record = { active: status.active, activatedAt: status.activatedAt ?? null, expiresAt: status.expiresAt ?? null, updatedAt: fetchedAt };
  // Headless runs and apps without the band have nothing to play in, and
  // Claude Desktop keeps automatic playback off ({@link showsBanner}).
  if (!showsBanner(entrypoint)) return { record, play: null, key: "" };
  // A boost speeds up Nexus Auto only: on another model nothing is faster.
  // Left unplayed, so switching to Auto later in the boost plays it then.
  if (!boostsModel(model)) return { record, play: null, key: "" };
  const decision = activationToPlay({ fetchedAt, status }, session.playedKey, now);
  if (!decision.play || !decision.status) return { record, play: null, key: "" };
  // A running /ultrafast-demo isn't cut short: the boost stays unplayed, so
  // a later check plays it once the demo is over.
  if (demoRunning) return { record, play: null, key: "" };
  return { record, play: decision.status, key: decision.key };
}

/** How long reading the session's model may take before the check goes on without it. */
export const MODEL_READ_TIMEOUT_MS = 2_000;

/**
 * The session's main loop model from `read` (the hooks pass
 * `() => $.session.model()`), or "" when it can't say. `outcome.why` says
 * which: "ok", "timeout" (no answer within `timeoutMs`, timed with `after`,
 * the hooks' `$.clock.after`; the late answer is ignored), "no-clock" (the
 * deadline couldn't be set, so the read isn't waited on at all), "error"
 * (the call threw or rejected) or "not-string". Every path settles within
 * the deadline or at once, so a stalled read never holds up later checks.
 * Never throws; "" means no banner ({@link boostsModel}).
 * @param {() => unknown} read
 * @param {{ timeoutMs?: number, after?: (ms: number, fn: () => void) => { cancel?(): void } | undefined, outcome?: { why?: string } }} [options]
 * @returns {Promise<string>}
 */
export function sessionModel(read, { timeoutMs = MODEL_READ_TIMEOUT_MS, after, outcome = {} } = {}) {
  const schedule = after ?? ((ms, fn) => {
    const id = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(id) };
  });
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (value, why) => {
      if (settled) return;
      settled = true;
      try {
        timer?.cancel?.();
      } catch {}
      const ok = typeof value === "string";
      outcome.why = ok ? "ok" : why ?? "not-string";
      resolve(ok ? value : "");
    };
    try {
      timer = schedule(timeoutMs, () => finish(undefined, "timeout"));
    } catch {
      // Without a deadline a stalled read could hold the check forever.
      finish(undefined, "no-clock");
      return;
    }
    Promise.resolve()
      .then(read)
      .then((value) => finish(value), () => finish(undefined, "error"));
  });
}

export async function confirmAutoModel(readModel) {
  const { model, why } = await readModel();
  return why === "ok" && boostsModel(model);
}

const UNKNOWN_MODEL = {
  timeout: "unknown (Claude Code didn't answer in time: no banner this check)",
  "no-clock": "unknown (the read couldn't be timed: no banner this check)",
};

/**
 * The `/ultrafast-demo stats` line for the model the last check read, so a
 * session on another model can be told from a Claude Code that can't say,
 * or one that didn't answer in time (`why`, from {@link sessionModel}). The
 * model can come from a repository's own settings, so it goes to the
 * terminal sanitized: one printable line, no escape, control or bidi
 * characters.
 * @param {unknown} model
 * @param {unknown} [why]
 */
export function modelStatsLine(model, why) {
  const value = sanitizeReason(typeof model === "string" ? model : "");
  if (value) return `Session model: ${value}${boostsModel(model) ? "" : " (not Nexus Auto: no banner)"}`;
  return `Session model: ${UNKNOWN_MODEL[why] ?? "unknown (this Claude Code doesn't report it to mods: no banner)"}`;
}

/**
 * Whether a check should stop the banner now: an automatic play is running
 * and the session has left Nexus Auto, so the boost no longer applies to it.
 * A `/ultrafast-demo` play is the person's own and runs to its end.
 * @param {{ playing: boolean, demo: boolean, model: unknown, why: unknown }} input
 */
export function stopForModel({ playing, demo, model, why }) {
  return playing && !demo && why === "ok" && !boostsModel(model);
}

/**
 * A play begins: an automatic one waits in `pendingKey` until a frame is
 * drawn. A demo play clears it, so its frames never count for a boost.
 * @param {{ playedKey: string, pendingKey: string }} session
 * @param {string} key
 * @param {boolean} demo
 */
export function startPlay(session, key, demo) {
  session.pendingKey = demo ? "" : key;
}

/**
 * The banner stopped because the session left Nexus Auto: drop the pending
 * play without counting it. An activation counts only once a frame has
 * drawn ({@link frameDrawn}), so one stopped before anyone saw it plays
 * when the session is back on Auto during the same boost, like one a survey
 * hid; one that drew a frame never plays again in this conversation.
 * @param {{ pendingKey: string }} session
 */
export function abandonPlay(session) {
  session.pendingKey = "";
}

/**
 * A banner frame was drawn: the pending automatic play now counts as played.
 * A demo frame, or a play no frame showed (hidden by a survey, say), doesn't.
 * This runs inside a render, where `$.state` refuses writes, so it only marks
 * `saveDue`; answers whether `playedKey` changed.
 * @param {{ playedKey: string, pendingKey: string }} session
 * @param {boolean} demo
 */
export function frameDrawn(session, demo) {
  return !demo && markPendingPlay(session);
}

function markPendingPlay(session) {
  if (!session.pendingKey) return false;
  session.playedKey = session.pendingKey;
  session.pendingKey = "";
  session.saveDue = true;
  return true;
}

/**
 * The played key to save now, outside a render, or null when nothing changed
 * since the last save.
 * @param {{ playedKey: string, saveDue: boolean }} session
 * @returns {string | null}
 */
export function takeSave(session) {
  if (!session.saveDue) return null;
  session.saveDue = false;
  return session.playedKey;
}

/**
 * Writing what {@link takeSave} handed out failed: keep it due, so the next
 * save tries again.
 * @param {{ saveDue: boolean }} session
 */
export function saveFailed(session) {
  session.saveDue = true;
}

/**
 * The marker read back from `$.state` before a check. While a save is still
 * due (it failed), memory is newer, so the stored value is ignored.
 * @param {{ playedKey: string, saveDue: boolean }} session
 * @param {unknown} stored
 */
export function loadMarker(session, stored) {
  if (session.saveDue) return;
  session.playedKey = typeof stored === "string" ? stored : "";
}

function startOver(session) {
  session.playedKey = "";
  session.pendingKey = "";
  session.saveDue = false;
}

/**
 * The conversation ended. A `/clear` or a resume keeps the process (and the
 * mod) going under another session, so it starts over with nothing played.
 * @param {{ playedKey: string, pendingKey: string, saveDue: boolean }} session
 * @param {unknown} reason `session.end`'s reason
 * @returns {boolean} whether the session was reset
 */
export function sessionEnded(session, reason) {
  if (reason !== "clear" && reason !== "resume") return false;
  startOver(session);
  return true;
}

/**
 * A check saw the session id `id`. When it differs from the one the state
 * belongs to, another conversation took over without a `session.end` this
 * mod saw (an older Claude Code, say): start over. "" (unknown) changes
 * nothing.
 * @param {{ playedKey: string, pendingKey: string, saveDue: boolean, conversationId: string }} session
 * @param {unknown} id
 * @returns {boolean} whether the session was reset
 */
export function conversationSeen(session, id) {
  const value = typeof id === "string" ? id : "";
  if (!value) return false;
  const changed = session.conversationId !== "" && session.conversationId !== value;
  session.conversationId = value;
  if (changed) startOver(session);
  return changed;
}

/**
 * What a check does at `now`: ask the network once `interval` has passed
 * since `lastCheck`; until then, reuse the last status fetched, so a new
 * conversation (a `/clear`, a resume) plays a running boost at once without
 * sending a request before the cooldown is over.
 * The last status is reused only for the key it was fetched with
 * (`keyPrint`, from `keyFingerprint`): after the key changes or goes away,
 * another account's boost is never replayed.
 * @param {{ now: number, lastCheck: number, interval: number, keyPrint: string, last: { status: { active: boolean }, fetchedAt: number, keyPrint: string } | null }} input
 * @returns {{ fetch: boolean, status: object | null, fetchedAt: number }}
 */
export function nextCheck({ now, lastCheck, interval, keyPrint, last }) {
  if (now - lastCheck >= interval) return { fetch: true, status: null, fetchedAt: now };
  const sameKey = Boolean(keyPrint) && last?.keyPrint === keyPrint;
  if (sameKey && last?.status?.active === true) return { fetch: false, status: last.status, fetchedAt: last.fetchedAt };
  return { fetch: false, status: null, fetchedAt: 0 };
}
