// The steps the banner mod's hooks run after each boost check, when a play
// starts, on each drawn frame and when a conversation ends (`register.tsx`
// calls these; it can't load outside Claude Code), run in session order.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { abandonPlay, afterBoostCheck, confirmAutoModel, conversationSeen, frameDrawn, loadMarker, newSession, nextCheck, saveFailed, sessionEnded, sessionModel, startPlay, stopForModel, takeSave, modelStatsLine, MODEL_READ_TIMEOUT_MS } from "../../mods/ultrafast-fireworks/hooks/session.mjs";
import { keyFingerprint } from "../../mods/ultrafast-fireworks/hooks/rewards.mjs";

const NOW = Date.parse("2026-11-20T18:00:00Z");
const KEY = keyFingerprint("fw_test_key");
const BOOST = { active: true, activationId: "window-a1", activatedAt: NOW - 60_000, expiresAt: NOW + 3_600_000, reason: "" };

/** One check as the hooks run it: decide, start the play, draw a frame. */
function checkAndDraw(session, { status = BOOST, entrypoint = "cli", model = "auto[1m]", now = NOW, draw = true } = {}) {
  const result = afterBoostCheck(session, { status, entrypoint, model, now });
  if (result.play) {
    startPlay(session, result.key, false);
    if (draw) frameDrawn(session, false);
  }
  return result;
}

describe("the banner mod's session steps", () => {
  it("records the boost but plays nothing where there's no band, or in the desktop app", () => {
    for (const entrypoint of ["sdk-cli", "sdk-ts", "claude-vscode", "claude-desktop"]) {
      const session = newSession();
      const { record, play } = checkAndDraw(session, { entrypoint });
      assert.equal(play, null, entrypoint);
      assert.deepEqual(record, { active: true, activatedAt: BOOST.activatedAt, expiresAt: BOOST.expiresAt, updatedAt: NOW });
      assert.deepEqual(session, newSession(), entrypoint);
    }
  });

  it("records the boost but plays nothing on a model a boost doesn't speed up", () => {
    // What `$.session.model()` gives for `--model opus`, `sonnet` and a
    // concrete Fireworks model, and "" where Claude Code can't say.
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "example-model", "accounts/example-account/models/example-model", "", undefined]) {
      const session = newSession();
      // Called directly: checkAndDraw's default would replace `undefined`.
      const { record, play } = afterBoostCheck(session, { status: BOOST, entrypoint: "cli", model, now: NOW });
      assert.equal(play, null, String(model));
      assert.deepEqual(record, { active: true, activatedAt: BOOST.activatedAt, expiresAt: BOOST.expiresAt, updatedAt: NOW });
      assert.deepEqual(session, newSession(), String(model));
    }
  });

  it("plays once a session switches to Auto during a boost, and not again after switching back and forth", () => {
    const session = newSession();
    assert.equal(checkAndDraw(session, { model: "claude-opus-5-5" }).play, null);
    assert.ok(checkAndDraw(session, { model: "auto", now: NOW + 5_000 }).play);
    assert.equal(checkAndDraw(session, { model: "claude-opus-5-5", now: NOW + 10_000 }).play, null);
    assert.equal(checkAndDraw(session, { model: "auto[1m]", now: NOW + 15_000 }).play, null);
  });

  it("reads the session's model, or \"\" when Claude Code can't say", async () => {
    assert.equal(await sessionModel(async () => "auto[1m]"), "auto[1m]");
    assert.equal(await sessionModel(() => "claude-opus-5-5"), "claude-opus-5-5");
    assert.equal(await sessionModel(async () => { throw new Error("no such API"); }), "");
    assert.equal(await sessionModel(() => { throw new TypeError("not a function"); }), "");
    for (const odd of [undefined, null, 42, { id: "auto" }]) assert.equal(await sessionModel(async () => odd), "", String(odd));
  });

  it("rejects a candidate play if the session leaves Auto while a boost check is pending", async () => {
    const session = newSession();
    let model = "auto[1m]";
    const readModel = async () => {
      const outcome = {};
      const current = await sessionModel(() => model, { outcome });
      return { model: current, why: outcome.why };
    };
    const { model: initialModel } = await readModel();
    const { promise: boostStatus, resolve } = Promise.withResolvers();
    const pendingPlay = boostStatus.then(async status => {
      const decision = afterBoostCheck(session, { entrypoint: "cli", model: initialModel, now: NOW, status });
      assert.ok(decision.play, "the initial model would start the banner");
      return await confirmAutoModel(readModel) ? decision.play : null;
    });
    model = "example-model";
    resolve(BOOST);
    assert.equal(await pendingPlay, null);
    model = "auto[1m]";
    assert.equal(await confirmAutoModel(readModel), true);
    assert.equal(await confirmAutoModel(async () => ({ model: "", why: "timeout" })), false);
  });

  it("gives up on a model read that never answers, so later checks still run", async () => {
    // A fake clock that fires the deadline at once: the stalled read loses.
    const waits = [];
    const after = (ms, fn) => {
      waits.push(ms);
      queueMicrotask(fn);
      return { cancel() {} };
    };
    assert.equal(await sessionModel(() => new Promise(() => {}), { after }), "");
    assert.deepEqual(waits, [MODEL_READ_TIMEOUT_MS]);
    // An answer before the deadline wins and cancels it.
    let cancelled = false;
    const slow = (ms, fn) => ({ cancel() { cancelled = true; } });
    assert.equal(await sessionModel(async () => "auto", { after: slow }), "auto");
    assert.equal(cancelled, true);
    // A deadline that can't be set isn't waited past: the read is skipped.
    const noClock = {};
    assert.equal(await sessionModel(() => new Promise(() => {}), { after: () => { throw new Error("no clock"); }, outcome: noClock }), "");
    assert.equal(noClock.why, "no-clock");
    // Each way of getting nothing says why.
    const never = () => ({ cancel() {} });
    for (const [read, clock, why] of [
      [() => new Promise(() => {}), after, "timeout"],
      [async () => { throw new Error("no such API"); }, never, "error"],
      [async () => 42, never, "not-string"],
      [async () => "auto", never, "ok"],
    ]) {
      const outcome = {};
      await sessionModel(read, { after: clock, outcome });
      assert.equal(outcome.why, why);
    }
  });

  it("says in stats which model the last check read, and when it couldn't read one", () => {
    assert.equal(modelStatsLine("auto[1m]"), "Session model: auto[1m]");
    assert.match(modelStatsLine("claude-opus-5-5"), /^Session model: claude-opus-5-5 \(not Nexus Auto: no banner\)$/);
    for (const unknown of ["", "  ", undefined]) assert.match(modelStatsLine(unknown), /^Session model: unknown \(this Claude Code doesn't report it/, String(unknown));
    // A slow answer isn't reported as a build that can't say.
    assert.match(modelStatsLine("", "timeout"), /^Session model: unknown \(Claude Code didn't answer in time/);
    assert.match(modelStatsLine("", "no-clock"), /^Session model: unknown \(the read couldn't be timed/);
    // A repository's settings can name the model: escapes, controls, bidi
    // overrides and newlines never reach the terminal.
    const hostile = "auto\u001b]0;pwned\u0007\n\u202eevil\u001b[2J";
    const line = modelStatsLine(hostile);
    assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
    assert.match(line, /\(not Nexus Auto: no banner\)$/);
  });

  it("stops a running automatic banner once the session leaves Auto, never a demo", () => {
    assert.equal(stopForModel({ playing: true, demo: false, model: "claude-opus-5-5", why: "ok" }), true);
    assert.equal(stopForModel({ playing: true, demo: false, model: "", why: "ok" }), true);
    assert.equal(stopForModel({ playing: true, demo: false, model: "auto[1m]", why: "ok" }), false);
    assert.equal(stopForModel({ playing: true, demo: true, model: "claude-opus-5-5", why: "ok" }), false);
    assert.equal(stopForModel({ playing: false, demo: false, model: "claude-opus-5-5", why: "ok" }), false);
    for (const why of ["timeout", "error", "no-clock", "not-string"]) {
      assert.equal(stopForModel({ playing: true, demo: false, model: "", why }), false, why);
    }
  });

  it("plays again on Auto a banner stopped for leaving Auto before anyone saw it", () => {
    const session = newSession();
    const { play } = checkAndDraw(session, { draw: false });
    assert.ok(play);
    if (stopForModel({ playing: true, demo: false, model: "example-model", why: "ok" })) abandonPlay(session);
    assert.equal(frameDrawn(session, false), false, "the pending play was dropped");
    assert.equal(takeSave(session), null, "nothing counts as played without a frame");
    assert.equal(checkAndDraw(session, { model: "example-model", now: NOW + 5_000 }).play, null, "still off Auto");
    assert.ok(checkAndDraw(session, { now: NOW + 10_000 }).play, "back on Auto: the unseen boost plays");
  });

  it("never replays a banner that drew before the session left Auto", () => {
    const session = newSession();
    const { play, key } = checkAndDraw(session);
    assert.ok(play);
    assert.equal(takeSave(session), key);
    if (stopForModel({ playing: true, demo: false, model: "example-model", why: "ok" })) abandonPlay(session);
    assert.equal(takeSave(session), null);
    assert.equal(checkAndDraw(session, { now: NOW + 10_000 }).play, null, "back on Auto: already seen");
  });

  it("plays once per session in the terminal, and again in each new session", () => {
    const entrypoint = "cli";
    const first = newSession();
    assert.ok(checkAndDraw(first, { entrypoint }).play, entrypoint);
    assert.equal(checkAndDraw(first, { entrypoint, now: NOW + 120_000 }).play, null, entrypoint);
    assert.ok(checkAndDraw(newSession(), { entrypoint, now: NOW + 240_000 }).play, entrypoint);
  });

  it("plays again after a /clear or a resume, but not after other session ends", () => {
    for (const reason of ["clear", "resume"]) {
      const session = newSession();
      checkAndDraw(session);
      for (const other of ["prompt_input_exit", "logout", "other"]) assert.equal(sessionEnded(session, other), false);
      assert.equal(checkAndDraw(session, { now: NOW + 60_000 }).play, null);
      assert.equal(sessionEnded(session, reason), true);
      assert.equal(takeSave(session), null, "a reset leaves nothing to save");
      assert.ok(checkAndDraw(session, { now: NOW + 120_000 }).play, reason);
    }
  });

  it("starts over when a check sees another session id, the fallback for a missed session.end", () => {
    const session = newSession();
    assert.equal(conversationSeen(session, "session-1"), false);
    checkAndDraw(session);
    assert.equal(conversationSeen(session, "session-1"), false);
    assert.equal(checkAndDraw(session, { now: NOW + 60_000 }).play, null);
    // An unknown id changes nothing.
    assert.equal(conversationSeen(session, ""), false);
    assert.equal(conversationSeen(session, undefined), false);
    assert.equal(conversationSeen(session, "session-2"), true);
    assert.ok(checkAndDraw(session, { now: NOW + 120_000 }).play);
  });

  it("reuses the last status inside the cooldown instead of asking the network", () => {
    const interval = 120_000;
    const last = { status: BOOST, fetchedAt: NOW, keyPrint: KEY };
    assert.deepEqual(nextCheck({ now: NOW + interval, lastCheck: NOW, interval, keyPrint: KEY, last }), { fetch: true, status: null, fetchedAt: NOW + interval });
    assert.deepEqual(nextCheck({ now: NOW + 5_000, lastCheck: NOW, interval, keyPrint: KEY, last }), { fetch: false, status: BOOST, fetchedAt: NOW });
    // Nothing running: nothing to reuse.
    assert.deepEqual(nextCheck({ now: NOW + 5_000, lastCheck: NOW, interval, keyPrint: KEY, last: { status: { active: false }, fetchedAt: NOW, keyPrint: KEY } }).status, null);
    assert.deepEqual(nextCheck({ now: NOW + 5_000, lastCheck: NOW, interval, keyPrint: KEY, last: null }).status, null);
  });

  it("never replays another key's boost from the cache", () => {
    const interval = 120_000;
    const last = { status: BOOST, fetchedAt: NOW, keyPrint: KEY };
    const other = keyFingerprint("fw_other_key");
    assert.notEqual(other, KEY);
    assert.equal(nextCheck({ now: NOW + 5_000, lastCheck: NOW, interval, keyPrint: other, last }).status, null);
    // No key at all.
    assert.equal(keyFingerprint(""), "");
    assert.equal(nextCheck({ now: NOW + 5_000, lastCheck: NOW, interval, keyPrint: "", last }).status, null);
    assert.equal(nextCheck({ now: NOW + 5_000, lastCheck: NOW, interval, keyPrint: "", last: { ...last, keyPrint: "" } }).status, null);
    // The mock counts as its own key, so mock mode can still reuse a status.
    assert.notEqual(keyFingerprint("", "http://127.0.0.1:8799"), "");
    assert.doesNotMatch(KEY, /fw_/);
  });

  it("retries a failed save and keeps the newer marker in memory until it lands", () => {
    const session = newSession();
    checkAndDraw(session);
    assert.equal(takeSave(session), "window-a1");
    // The $.state write rejected.
    saveFailed(session);
    // The next check reads $.state, which still holds the old (empty) value.
    loadMarker(session, "");
    assert.equal(session.playedKey, "window-a1");
    assert.equal(checkAndDraw(session, { now: NOW + 60_000 }).play, null, "no replay while the save is pending");
    assert.equal(takeSave(session), "window-a1", "the save is tried again");
    // Saved now: the stored value is read back as usual.
    loadMarker(session, "window-a1");
    assert.equal(session.playedKey, "window-a1");
    loadMarker(session, undefined);
    assert.equal(session.playedKey, "");
  });

  it("keeps a cleared marker due when the reset's write fails", () => {
    const session = newSession();
    conversationSeen(session, "session-1");
    checkAndDraw(session);
    takeSave(session);
    // A new conversation, and the write clearing $.state fails.
    assert.equal(conversationSeen(session, "session-2"), true);
    saveFailed(session);
    // The next check reads the old conversation's key back from $.state.
    loadMarker(session, "window-a1");
    assert.equal(session.playedKey, "");
    assert.ok(checkAndDraw(session, { now: NOW + 60_000 }).play, "the new conversation still gets its banner");
    assert.equal(takeSave(session), "window-a1", "and the retried save records it");
  });

  it("holds a boost while a demo runs, then plays it", () => {
    const session = newSession();
    assert.equal(afterBoostCheck(session, { status: BOOST, entrypoint: "cli", model: "auto", now: NOW, demoRunning: true }).play, null);
    assert.ok(checkAndDraw(session, { now: NOW + 10_000 }).play, "plays once the demo is over");
  });

  it("replays a running boost right after a /clear from the last status, with no new request", () => {
    const interval = 120_000;
    const session = newSession();
    checkAndDraw(session);
    const last = { status: BOOST, fetchedAt: NOW, keyPrint: KEY };
    sessionEnded(session, "clear");
    // 10s later the cooldown hasn't passed: no fetch, but the cached boost plays.
    const due = nextCheck({ now: NOW + 10_000, lastCheck: NOW, interval, keyPrint: KEY, last });
    assert.equal(due.fetch, false);
    const { play, record } = afterBoostCheck(session, { status: due.status, entrypoint: "cli", model: "auto", now: NOW + 10_000, fetchedAt: due.fetchedAt });
    assert.ok(play);
    assert.equal(record.updatedAt, NOW, "a reused status keeps its fetch time");
  });

  it("saves a drawn play outside the render, once", () => {
    const session = newSession();
    assert.equal(takeSave(session), null);
    const { key } = afterBoostCheck(session, { status: BOOST, entrypoint: "cli", model: "auto", now: NOW });
    startPlay(session, key, false);
    assert.equal(frameDrawn(session, false), true);
    assert.equal(takeSave(session), "window-a1");
    assert.equal(takeSave(session), null);
    // Later frames of the same play have nothing new to save.
    assert.equal(frameDrawn(session, false), false);
    assert.equal(takeSave(session), null);
  });

  it("doesn't replay after a hot reload, which keeps the saved marker", () => {
    // $.state as the hooks use it: savePlayed writes what takeSave hands
    // out, and the next check reads it back.
    const state = { played: "" };
    const before = newSession();
    checkAndDraw(before);
    const saved = takeSave(before);
    if (saved !== null) state.played = saved;
    // A reload starts the module's memory over.
    const after = { ...newSession(), playedKey: state.played };
    assert.equal(checkAndDraw(after, { now: NOW + 120_000 }).play, null);
  });

  it("counts a play only once one of its own frames is drawn", () => {
    const hidden = newSession();
    checkAndDraw(hidden, { draw: false });
    // No frame drawn (a survey hid the band, say): the next check plays it.
    assert.ok(checkAndDraw(hidden, { now: NOW + 120_000 }).play);

    // A boost play starts, then a demo interrupts it before any boost frame
    // is drawn: the demo's frames don't count for the boost, which plays at
    // the next check.
    const demo = newSession();
    const { key } = afterBoostCheck(demo, { status: BOOST, entrypoint: "cli", model: "auto", now: NOW });
    startPlay(demo, key, false);
    assert.equal(demo.pendingKey, "window-a1");
    startPlay(demo, "", true);
    assert.equal(frameDrawn(demo, true), false);
    assert.equal(demo.playedKey, "");
    assert.equal(takeSave(demo), null);
    assert.ok(checkAndDraw(demo, { now: NOW + 120_000 }).play);
  });

  it("plays a new boost that starts while the session is open", () => {
    const session = newSession();
    checkAndDraw(session);
    assert.ok(checkAndDraw(session, { status: { ...BOOST, activationId: "window-a2" }, now: NOW + 120_000 }).play);
  });

  it("is what the hooks call, with the marker in $.state, never the shared store", () => {
    const register = readFileSync(new URL("../../mods/ultrafast-fireworks/hooks/register.tsx", import.meta.url), "utf8");
    assert.match(register, /loadMarker\(local\.session, await read\(\$, played\)\)/);
    assert.match(register, /afterBoostCheck\(local\.session,/);
    const check = register.slice(register.indexOf("async function checkBoost("), register.indexOf("async function decideAndPlay("));
    const decide = register.slice(register.indexOf("async function decideAndPlay("), register.indexOf("export const register"));
    const assertBefore = (body, first, second) => {
      const index = body.indexOf(first);
      assert.ok(index >= 0 && index < body.indexOf(second), `${first} must run before ${second}`);
    };
    assertBefore(check, "readSessionModel(", "nextCheck(");
    assertBefore(check, "stopForModel(", "nextCheck(");
    assertBefore(check, "abandonPlay(", "stop(");
    // The final Auto check runs inside play(), after its setup and right
    // before the banner is published.
    const playBody = register.slice(register.indexOf("async function play(")).slice(0, register.slice(register.indexOf("async function play(")).indexOf("\n}\n"));
    assertBefore(playBody, "await stop($)", "await confirm()");
    assertBefore(playBody, "await confirm()", "startPlay(");
    assertBefore(playBody, "await confirm()", "update($, run,");
    assert.ok(decide.includes("confirmAutoModel(() => readSessionModel($))"), "the automatic play passes the confirmation");
    assert.match(register, /startPlay\(local\.session, key, demo\)/);
    assert.match(register, /frameDrawn\(local\.session, local\.demo\)/);
    assert.match(register, /sessionEnded\(local\.session, e\.reason\)/);
    assert.match(register, /conversationSeen\(local\.session, conversation\)/);
    assert.match(register, /takeSave\(local\.session\)/);
    assert.doesNotMatch(register, /\$\.store\./);
    // $.state refuses writes during a render: the render hook may only mark
    // the play, and the marker is written by savePlayed and startOver alone.
    const render = register.slice(register.indexOf("on('ui.render'"));
    assert.ok(render.length < register.length, "found the render hook");
    assert.doesNotMatch(render.slice(0, render.indexOf("\n  })\n")), /update\(\$, played/);
    assert.equal(register.match(/update\(\$, played,/g)?.length, 2);
    // The marker is saved while the banner runs (the frame timer), when it
    // stops, and before each check reads it back.
    const timer = register.slice(register.indexOf("local.timer = $.clock.every("));
    assert.match(timer.slice(0, timer.indexOf("\n  })\n")), /savePlayed\(\$\)/);
    const stopBody = register.slice(register.indexOf("async function stop("));
    assert.match(stopBody.slice(0, stopBody.indexOf("\n}\n")), /await savePlayed\(\$\)/);
    assert.match(register, /await savePlayed\(\$\)\n\s*loadMarker\(local\.session, await read\(\$, played\)\)/);
    // A failed save is retried, not dropped.
    const saveBody = register.slice(register.indexOf("async function savePlayed(")).slice(0, register.slice(register.indexOf("async function savePlayed(")).indexOf("\n}\n"));
    assert.match(saveBody, /catch \{[^}]*saveFailed\(local\.session\)/);
    // A cached boost never cuts a running demo short.
    assert.match(register, /demoRunning: local\.demo && Boolean\(local\.timer\)/);
    // ...checked again right before playing, since a demo can start mid-check.
    assert.match(register, /if \(!toPlay \|\| \(local\.demo && local\.timer\)\) return\n\s*await play\(/);
    // A failed reset stays due.
    const resetBody = register.slice(register.indexOf("async function startOver(")).slice(0, register.slice(register.indexOf("async function startOver(")).indexOf("\n}\n"));
    assert.match(resetBody, /catch \{[^}]*saveFailed\(local\.session\)/);
    // The cache is tied to the key that fetched it.
    assert.match(register, /local\.lastStatus = \{ status, fetchedAt: now, keyPrint \}/);
    assert.match(register, /if \(local\.lastStatus && local\.lastStatus\.keyPrint !== keyPrint\) local\.lastStatus = null/);
    // A new conversation stops whatever banner is running, a demo included,
    // quietly, and keeps the check cooldown.
    const startOverBody = register.slice(register.indexOf("async function startOver(")).slice(0, register.slice(register.indexOf("async function startOver(")).indexOf("\n}\n"));
    assert.match(startOverBody, /^\s*if \(local\.timer \|\| local\.guard\) await stop\(\$, true\)$/m);
    assert.doesNotMatch(startOverBody, /local\.demo|return|lastBoostCheck/);
    assert.doesNotMatch(register, /local\.lastBoostCheck = 0/);
    // The reset is off where the check is off (kill switch, NEXUS_TEST).
    assert.match(register, /checkOff\(\$\)\s*\.then\(off => \(off \? undefined : startOver\(\$\)\)\)/);
    assert.match(register, /nextCheck\(\{ now, lastCheck: local\.lastBoostCheck, interval, keyPrint, last: local\.lastStatus \}\)/);
  });
});
