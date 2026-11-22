/**
 * Live cost meter for `nexus codex usage`.
 *
 * Claude Code's meter (`claude/usage/live.mjs`) does the drawing, keys, agents
 * pane and session switching. This module supplies the Codex side: a
 * translator from rollout lines to the records that meter reads, the session's
 * subagent rollouts, the session list, and a background refresh of the models
 * Fireworks served for `auto` calls.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { runClaudeUsageLive } from "../../claude/usage/live.mjs";
import { CLAUDE_USAGE_PICKER_DAYS, promptClaudeUsageSession } from "../../claude/usage/session-picker.mjs";
import {
  codexServedLookup,
  codexSessionAgents,
  codexThreadIdFromPath,
  codexUsageToClaudeUsage,
  createCodexCallParser,
  findCodexRollouts,
  readCodexSessionTree,
  readCodexThreadNames,
  readCodexUsages,
} from "./report.mjs";
import { resolveServedModels, SERVED_LOOKUP_RATE_LIMITED } from "./served-models.mjs";

/** The server records a call a few seconds after Codex logs it; don't ask before then. */
const SERVED_SETTLE_MS = 5_000;
/** Background lookups per unresolved call before the meter stops asking (about a minute). */
const MAX_LOOKUP_TRIES = 6;
/** Shown for a turn whose rollout has no typed prompt (a subagent's, usually). */
const NO_PROMPT = "(no typed prompt)";

/**
 * A per-run translator from Codex rollout records to the user / assistant
 * records the shared meter tallies. Calls whose served model is known are
 * labelled and priced as that model.
 *
 * `scope` is the rollout's thread id, so call keys match the tree parser's.
 * `isInherited` names response ids the session credits to an earlier rollout
 * (a fork's copied history); those calls are skipped, not metered twice.
 *
 * @param {Map<string, { model: string }>} [served]
 * @param {{ scope?: string, isInherited?: (responseId: string) => boolean }} [options]
 * @returns {(record: any) => any[]}
 */
export function createCodexMeterTranslator(served = new Map(), { scope = "", isInherited = () => false } = {}) {
  const parser = createCodexCallParser({ scope });
  // The meter row open for the current Codex turn, if any. `started` is set
  // once its `task_started` has been seen: a prompt can be logged just before
  // its turn starts, and that turn must keep the prompt's row rather than
  // open a placeholder one.
  /** @type {{ started: boolean, calls: number } | null} */
  let open = null;
  // A `task_started` whose row hasn't been opened yet.
  let turnPending = false;
  const openTurn = (text, started) => {
    open = { started, calls: 0 };
    return { type: "user", message: { content: text } };
  };
  return (record) => {
    const out = [];
    for (const event of parser.push(record)) {
      if (event.kind === "turn") {
        if (open && !open.started && open.calls === 0) {
          open.started = true; // the prompt logged just before this turn began
        } else {
          open = null;
          turnPending = true;
        }
      } else if (event.kind === "prompt") {
        if (!open) out.push(openTurn(event.text, turnPending));
        turnPending = false;
      } else if (event.kind === "call") {
        if (event.call.responseId && isInherited(event.call.responseId)) continue;
        if (!open) out.push(openTurn(NO_PROMPT, true));
        turnPending = false;
        open.calls += 1;
        const { call } = event;
        out.push({
          type: "assistant",
          message: {
            id: call.key,
            model: served.get(call.key)?.model || call.model,
            usage: codexUsageToClaudeUsage(call.usage),
          },
        });
      } else if (event.kind === "settled" && open) {
        out.push({ type: "assistant", message: { stop_reason: "end_turn" } });
        open = null; // the next prompt opens a new row
      }
    }
    return out;
  };
}

/**
 * Recent top-level Codex sessions for the picker, newest first. Sessions with
 * no calls yet are kept: a session that just started is the one you want to
 * watch.
 *
 * @param {{ codexHome: string, home: string, withinDays?: number, now?: number, resolveServedForPicker?: any }} opts
 */
export async function listRecentCodexUsageSessions({ codexHome, home, withinDays = CLAUDE_USAGE_PICKER_DAYS, now = Date.now(), resolveServedForPicker }) {
  let group;
  try {
    group = await readCodexUsages({ codexHome, home, lastN: 100, withinDays, resolveServed: resolveServedForPicker, includeEmpty: true });
  } catch (error) {
    if (error instanceof Error && /No Codex session logs found/.test(error.message)) return [];
    throw error;
  }
  return Promise.all(group.sessions.map(async (report) => ({
    filePath: report.path,
    sessionId: report.sessionId,
    mtimeMs: (await stat(report.path).catch(() => null))?.mtimeMs ?? now,
    report,
    now,
  })));
}

/**
 * Prompt for a recent Codex session to live-track (same rules as Claude's:
 * one session or no TTY picks the newest, Esc/q returns null).
 *
 * @param {{ codexHome: string, home: string, withinDays?: number, input?: NodeJS.ReadStream, output?: NodeJS.WriteStream, resolveServedForPicker?: any }} opts
 */
export function promptCodexUsageSession({ codexHome, home, withinDays = CLAUDE_USAGE_PICKER_DAYS, input, output, resolveServedForPicker }) {
  return promptClaudeUsageSession({
    home,
    withinDays,
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
    harnessName: "Codex",
    logDir: path.join(codexHome, "sessions"),
    listSessions: (opts) => listRecentCodexUsageSessions({ ...opts, codexHome, home, resolveServedForPicker }),
  });
}

/**
 * Live-track one Codex session.
 *
 * @param {{
 *   home: string,
 *   codexHome: string,
 *   session: string,
 *   apiKey?: string,
 *   plain?: boolean,
 *   withinDays?: number,
 *   resolveServedForPicker?: any,
 *   env?: NodeJS.ProcessEnv,
 *   input?: NodeJS.ReadStream,
 *   stream?: NodeJS.WritableStream,
 *   signal?: AbortSignal,
 *   pollMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} opts
 */
export async function runCodexUsageLive({
  home,
  codexHome,
  session,
  apiKey = "",
  plain = false,
  withinDays,
  resolveServedForPicker,
  env = process.env,
  input,
  stream,
  signal,
  pollMs,
  sleep,
  now = Date.now,
}) {
  /** Served models known so far, shared by every translator and the agents pane. */
  const served = new Map();
  /** Rollout heads never change, so describe each once per meter. */
  const treeCache = new Map();
  let names = new Map();
  try {
    names = await readCodexThreadNames(codexHome);
  } catch {
    /* names are decoration */
  }

  /** Per-rollout parse state, so each refresh reads only appended bytes. */
  const parseState = new Map();
  /** Per rollout: response ids it repeats from an earlier rollout in its session. */
  const inheritedByFile = new Map();
  const treeOf = async (sessionPath) => {
    const tree = await readCodexSessionTree({ codexHome, sessionPath, cache: treeCache, parseState });
    for (const { rollout, parsed } of [tree.main, ...tree.subagents]) {
      inheritedByFile.set(rollout.filePath, new Set(parsed.inherited ?? []));
    }
    return tree;
  };

  /**
   * Look up served models for calls that need one and have had time to land.
   * True when something new was learned (the meter then replays the log).
   * The cache answers first, so a finished session costs no request.
   */
  /** Lookups asked per call, so one the server never recorded stops being asked about. */
  const tries = new Map();
  const lookupServed = async (sessionPath, lookupEnv) => {
    const lookup = codexServedLookup(await treeOf(sessionPath));
    const cutoff = now() - SERVED_SETTLE_MS;
    // Ask only when a call that has had time to land is still unresolved, and
    // hasn't already been asked about MAX_LOOKUP_TRIES times (a call the
    // server never recorded would otherwise keep the lookup firing forever)...
    const pending = lookup.calls.filter((call) => !served.has(call.key)
      && (!call.at || Date.parse(call.at) <= cutoff)
      && (tries.get(call.key) ?? 0) < MAX_LOOKUP_TRIES);
    if (pending.length === 0) return false;
    if (lookupEnv?.NEXUS_SERVED_MODEL_LOOKUP !== "0") {
      for (const call of pending) tries.set(call.key, (tries.get(call.key) ?? 0) + 1);
    }
    // ...but hand over the whole session: resolved calls must keep their rows,
    // or a later call with the same token counts could be paired with one.
    let rateLimited = false;
    const found = await resolveServedModels({
      sessions: [lookup],
      apiKey,
      home,
      env: lookupEnv,
      onFailure: (reason) => { rateLimited ||= reason === SERVED_LOOKUP_RATE_LIMITED; },
    });
    // A rate-limited lookup never asked about these calls, so it doesn't use
    // up their tries: the meter keeps asking once the limit passes.
    if (rateLimited) {
      for (const call of pending) tries.set(call.key, Math.max(0, (tries.get(call.key) ?? 1) - 1));
    }
    let changed = false;
    for (const [key, value] of found) {
      if (!served.has(key)) {
        served.set(key, value);
        changed = true;
      }
    }
    return changed;
  };

  // Seed from the on-disk cache (no network) so the first frame is already
  // priced for anything looked up before.
  try {
    await lookupServed(session, { ...env, NEXUS_SERVED_MODEL_LOOKUP: "0" });
  } catch {
    /* start unpriced; the background refresh retries */
  }

  return runClaudeUsageLive({
    home,
    session,
    plain,
    ...(input ? { input } : {}),
    ...(stream ? { stream } : {}),
    ...(signal ? { signal } : {}),
    ...(pollMs ? { pollMs } : {}),
    ...(sleep ? { sleep } : {}),
    harnessName: "Codex",
    resolveSession: async ({ session: wanted }) => {
      if (wanted && path.isAbsolute(wanted)) return wanted;
      const { parents } = await findCodexRollouts({ codexHome, home, session: wanted, lastN: 1 });
      if (!parents[0]) throw new Error(`No Codex session logs found under ${path.join(codexHome, "sessions")}`);
      return parents[0].filePath;
    },
    listAgents: async (sessionPath) => codexSessionAgents(await treeOf(sessionPath), served, names),
    promptSession: (opts) => promptCodexUsageSession({ ...opts, codexHome, home, withinDays, resolveServedForPicker }),
    translate: (filePath) => createCodexMeterTranslator(served, {
      scope: codexThreadIdFromPath(filePath),
      isInherited: (responseId) => inheritedByFile.get(filePath)?.has(responseId) ?? false,
    }),
    sessionLabelOf: (filePath) => codexThreadIdFromPath(filePath).slice(0, 8),
    refreshServed: (sessionPath) => lookupServed(sessionPath, env),
  });
}
