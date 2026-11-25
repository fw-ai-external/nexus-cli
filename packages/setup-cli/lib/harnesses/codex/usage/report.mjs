/**
 * `nexus codex usage`: Codex rollout logs priced into the same report shape
 * `claude usage` builds, so both share the pricing, the snapshot tables and
 * the interactive display.
 *
 * Codex writes one `rollout-<timestamp>-<thread id>.jsonl` per thread under
 * `<codex home>/sessions/YYYY/MM/DD/`. A subagent (or guardian review) is its
 * own thread with its own rollout, linked back by `parent_thread_id` in the
 * first `session_meta` record.
 */

import { createReadStream } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { computeClaudeUsageCost } from "../../claude/usage/pricing.mjs";
import { sanitize } from "../../../ui/sanitize.mjs";
import { addUsage, sumUsage } from "../../claude/usage/cost.mjs";
import {
  cleanSessionName,
  expandHome,
  fileExists,
  numberValue,
  parseLastN,
  rowHasUsage,
} from "../../claude/usage/report.mjs";
import { usageSignature } from "./served-models.mjs";

const ROLLOUT_RE = /^rollout-.*\.jsonl$/;
const THREAD_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** Bytes of a rollout's start the live parser re-checks to notice a rewrite. */
const HEAD_CHECK_BYTES = 256;
/** `session_meta` carries the base instructions inline, so the first line can be long. */
const HEAD_LIMIT_BYTES = 4 * 1024 * 1024;
/** Advice in the unpriced note: catalog refresh can't price a router call. */
const CODEX_UNPRICED_HINT = "Codex logs only the requested model, so an `auto` call is priced once the model"
  + " that served it is looked up with your Fireworks key; the next run retries any that weren't (-v says why)."
  + " For another model, refresh the catalog (nexus model list --refresh) or see https://docs.fireworks.ai/serverless/pricing.";
/**
 * Context Codex injects as a user message, not something the user typed:
 * tagged blocks, whose tag names always carry an `_` or `-`
 * (`<environment_context>`, `<external_codex_apps_open_page>`,
 * `<subagent_notification>`, …), and Markdown headers it prepends (`# AGENTS.md
 * instructions`, with or without ` for <dir>`; `# Files mentioned by the
 * user:`). A typed prompt that starts with a plain tag such as `<config>` is
 * kept; one that starts with an `_`/`-` tag is the rare miss.
 */
const INJECTED_PROMPT_RE = /^\s*(?:<[A-Za-z]+[_-]|# AGENTS\.md instructions\b|# Files (?:mentioned|pasted) by the user\b)/;




async function collectRollouts(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectRollouts(full);
    return entry.isFile() && ROLLOUT_RE.test(entry.name) ? [full] : [];
  }));
  return nested.flat();
}


/**
 * Rollouts in day folders (`YYYY/MM/DD`) on or after `fromDay`. Folders are
 * compared level by level, so earlier years and months are never opened.
 *
 * @param {string} sessionsDir
 * @param {string} fromDay
 */
async function collectRolloutsFrom(sessionsDir, fromDay) {
  const floor = fromDay.split(path.sep);
  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nested = await Promise.all(entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Only the levels on the floor's own path can be "before" it.
        const onFloorPath = path.relative(sessionsDir, dir).split(path.sep).filter(Boolean)
          .every((part, i) => part === floor[i]);
        if (depth < floor.length && onFloorPath && entry.name < floor[depth]) return [];
        return walk(full, depth + 1);
      }
      return entry.isFile() && ROLLOUT_RE.test(entry.name) ? [full] : [];
    }));
    return nested.flat();
  };
  return walk(sessionsDir, 0);
}

/**
 * A model id read from a log or the lookup, safe to print: control sequences
 * stripped and whitespace removed (model ids never contain any).
 *
 * @param {unknown} value
 */
export function cleanModelId(value) {
  return typeof value === "string" ? sanitize(value).replace(/\s+/g, "") : "";
}

/** Thread id from a rollout filename; the basename when it carries none. */
export function codexThreadIdFromPath(filePath) {
  return path.basename(filePath).match(THREAD_ID_RE)?.[1] ?? sanitize(path.basename(filePath, ".jsonl"));
}

/** An id-shaped value (letters, digits, `-`, `_`), as Codex writes thread ids. */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * An id read from a rollout, or "" when it isn't id-shaped. Thread ids are
 * printed to the terminal and sent in the lookup URL, so log content that
 * isn't a plain id is never used as one.
 */
function safeId(value) {
  const id = typeof value === "string" ? value : "";
  return SAFE_ID_RE.test(id) ? id : "";
}

/** The first line of a rollout, read without loading the whole file. */
async function readFirstLine(filePath) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const chunks = [];
    let total = 0;
    const buffer = Buffer.alloc(64 * 1024);
    while (total < HEAD_LIMIT_BYTES) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)));
        break;
      }
      chunks.push(Buffer.from(chunk));
      total += bytesRead;
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sessionMetaFrom(line) {
  try {
    const record = JSON.parse(line);
    return record?.type === "session_meta" && record.payload && typeof record.payload === "object"
      ? record.payload
      : null;
  } catch {
    return null;
  }
}

/** Parent thread of a subagent / guardian rollout, or "" for a top-level thread. */
function parentThreadOf(meta) {
  if (!meta) return "";
  const spawn = meta.source?.subagent?.thread_spawn;
  return String(meta.parent_thread_id || spawn?.parent_thread_id || "");
}

/** Short label for a subagent thread: its nickname, else what spawned it. */
function subagentLabel(meta, threadId) {
  // Both parts come from the log and are printed to a terminal: strip control
  // sequences and fold whitespace, as Claude's subagent labels do.
  const clean = cleanSessionName;
  const kind = clean(meta?.agent_nickname) || clean(meta?.source?.subagent?.other) || "agent";
  return `${kind}-${clean(threadId).slice(-8)}`;
}

async function describeRollout(filePath) {
  const [info, head] = await Promise.all([stat(filePath), readFirstLine(filePath)]);
  const meta = sessionMetaFrom(head);
  return {
    filePath,
    mtimeMs: info.mtimeMs,
    threadId: safeId(meta?.id) || codexThreadIdFromPath(filePath),
    parentThreadId: parentThreadOf(meta),
    meta,
  };
}

function rolloutRoots(codexHome) {
  return [path.join(codexHome, "sessions")];
}

/** A rollout's day folder (`YYYY/MM/DD`) relative to the sessions root. */
function dayOf(sessionsDir, filePath) {
  return path.relative(sessionsDir, path.dirname(filePath));
}

/**
 * Describe every rollout that could be a subagent of `parents`: a subagent
 * starts after its parent, so only the parents' day folders and later count.
 * The lookback picks parent sessions; it never trims a picked session's
 * subagents, so a session's totals are the same however it was selected.
 *
 * @param {object[]} parents described parent rollouts
 * @param {object[]} described rollouts already described
 * @param {string[]} files every rollout path
 * @param {string} sessionsDir
 */
async function withSubagentCandidates(parents, described, files, sessionsDir) {
  if (parents.length === 0) return described;
  const firstDay = parents.map((p) => dayOf(sessionsDir, p.filePath)).sort()[0];
  const known = new Set(described.map((r) => r.filePath));
  const extra = await Promise.all(files
    .filter((filePath) => !known.has(filePath) && dayOf(sessionsDir, filePath) >= firstDay)
    .map(describeRollout));
  return [...described, ...extra].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Top-level rollouts, newest first, plus every rollout that could be one of
 * their subagents (for subagent lookup).
 *
 * @param {{ codexHome: string, home?: string, session?: string, lastN?: number|string, withinDays?: number|string }} args
 */
export async function findCodexRollouts({ codexHome, home = "", session = "", lastN = 1, withinDays } = {}) {
  if (!codexHome) {
    throw new Error("The Codex home directory is required to find Codex session logs.");
  }
  const sessionsDir = rolloutRoots(codexHome)[0];

  const explicit = session && /[/\\]|\.jsonl$/i.test(session)
    ? path.resolve(expandHome(session, home))
    : "";
  const files = (await Promise.all(rolloutRoots(codexHome).map(collectRollouts))).flat();
  if (explicit && await fileExists(explicit)) {
    // A path names the session exactly; its subagents still come along.
    const parent = await describeRollout(explicit);
    return { parents: [parent], all: await withSubagentCandidates([parent], [parent], files, sessionsDir) };
  }
  if (files.length === 0) {
    throw new Error(`No Codex session logs found under ${sessionsDir}`);
  }
  let withMtime = await Promise.all(files.map(async (filePath) => ({
    filePath,
    mtimeMs: (await stat(filePath).catch(() => null))?.mtimeMs ?? 0,
  })));
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (withinDays != null && withinDays !== "") {
    const days = Number(withinDays);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error("withinDays must be a positive number.");
    }
    const cutoffMs = Date.now() - days * 86_400_000;
    withMtime = withMtime.filter(({ mtimeMs }) => mtimeMs >= cutoffMs);
  }

  // Reading a rollout's head can mean megabytes, so read as few as possible.
  const describeAll = async (list) => (await Promise.all(list.map(({ filePath }) => describeRollout(filePath))))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (session) {
    const needle = session.toLowerCase();
    const matches = (r) => r.threadId.toLowerCase().startsWith(needle)
      || path.basename(r.filePath, ".jsonl").toLowerCase().includes(needle);
    // Rollout filenames carry the thread id, so try those first.
    const named = withMtime.filter(({ filePath }) => codexThreadIdFromPath(filePath).toLowerCase().startsWith(needle)
      || path.basename(filePath, ".jsonl").toLowerCase().includes(needle));
    let recent = await describeAll(named);
    let match = recent.find(matches);
    if (!match) {
      recent = await describeAll(withMtime);
      match = recent.find(matches);
    }
    if (!match) {
      throw new Error(`No Codex session log matching '${session}' under ${sessionsDir}`);
    }
    return { parents: [match], all: await withSubagentCandidates([match], recent, files, sessionsDir) };
  }

  // Newest first, a batch at a time, until enough top-level sessions turn up.
  const want = parseLastN(lastN);
  const recent = [];
  const BATCH = 32;
  for (let i = 0; i < withMtime.length && recent.filter((r) => !r.parentThreadId).length < want; i += BATCH) {
    recent.push(...await describeAll(withMtime.slice(i, i + BATCH)));
  }
  recent.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const parents = recent.filter((r) => !r.parentThreadId).slice(0, want);
  return { parents, all: await withSubagentCandidates(parents, recent, files, sessionsDir) };
}

function promptFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join(" ");
}

/** A Codex usage payload in the field names `computeClaudeUsageCost` prices. */
export function codexUsageToClaudeUsage(usage = {}) {
  const input = numberValue(usage.input_tokens);
  const cached = numberValue(usage.cached_input_tokens);
  const cacheWrite = numberValue(usage.cache_write_input_tokens);
  // OpenAI-style `input_tokens` is the WHOLE prompt, cached share included —
  // unlike Anthropic's, which is only the uncached remainder. Split it into the
  // disjoint buckets the pricer expects, or cached tokens bill twice.
  return {
    input_tokens: Math.max(0, input - cached - cacheWrite),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: cacheWrite,
    // Reasoning tokens are already inside `output_tokens`.
    output_tokens: numberValue(usage.output_tokens),
  };
}

/**
 * A parser that reads one rollout record at a time and reports what each one
 * means: a new turn, a typed prompt, an API call, or the turn settling. The
 * snapshot report and the live meter share it, so a call gets the same `key`
 * in both, and a served model cached under that key stays attached.
 *
 * Current Codex writes a `token_usage_record` per response, followed by an
 * `event_msg`/`token_count` that repeats it. Older builds write only
 * `token_count`, which can also repeat the same cumulative total, so those
 * count only until a `token_usage_record` appears, and only when the running
 * total moves.
 *
 * Each call's `key` is stable across runs and unique across sessions: the
 * response id, else the rollout's thread id (`scope`) with the call's log
 * timestamp and position.
 *
 * @param {{ scope?: string }} [options]
 */
export function createCodexCallParser({ scope = "" } = {}) {
  /** @type {Map<string, number>} */
  const turnNumbers = new Map();
  /** @type {Map<string, string>} */
  const modelOfTurn = new Map();
  let model = "";
  let turn = 0;
  let lastTotal = "";
  let sawUsageRecords = false;
  let calls = 0;

  /** The turn number for `turnId`, and whether this record opened it. */
  const turnFor = (turnId) => {
    if (!turnId) return { no: turn, opened: false };
    if (!turnNumbers.has(turnId)) {
      turn += 1;
      turnNumbers.set(turnId, turn);
      return { no: turn, opened: true };
    }
    return { no: turnNumbers.get(turnId), opened: false };
  };

  const call = (args) => {
    const result = callFrom({ ...args, index: calls, scope });
    calls += 1;
    return result;
  };

  return {
    get currentTurn() {
      return turn;
    },
    /**
     * @param {any} record one parsed rollout line
     * @returns {Array<{ kind: "turn", turn: number } | { kind: "prompt", text: string, turn: number }
     *   | { kind: "call", call: ReturnType<typeof callFrom> } | { kind: "settled" }>}
     */
    push(record) {
      if (!record || typeof record !== "object") return [];
      const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
      if (record.type === "turn_context") {
        // Model ids are printed in every view; strip terminal control sequences here.
        const turnModel = cleanModelId(payload.model);
        if (turnModel) {
          model = turnModel;
          if (payload.turn_id) modelOfTurn.set(payload.turn_id, model);
        }
        return [];
      }
      if (record.type === "event_msg" && payload.type === "task_started") {
        const { no, opened } = turnFor(payload.turn_id);
        // A resumed session can mix Codex builds, so whether `token_count`
        // duplicates a `token_usage_record` is decided per turn.
        if (opened) sawUsageRecords = false;
        return opened ? [{ kind: "turn", turn: no }] : [];
      }
      if (record.type === "event_msg" && (payload.type === "task_complete" || payload.type === "turn_aborted")) {
        return [{ kind: "settled" }];
      }
      if (record.type === "event_msg" && payload.type === "thread_settings_applied") {
        const settingsModel = cleanModelId(payload.thread_settings?.model);
        if (settingsModel) model = settingsModel;
        return [];
      }
      if ((record.type === "event_msg" && payload.type === "user_message")
        || (record.type === "response_item" && payload.type === "message" && payload.role === "user")) {
        // Prompts become session names and meter rows, printed to a terminal.
        const prompt = cleanSessionName(promptFromContent(payload.message ?? payload.content));
        return prompt && !INJECTED_PROMPT_RE.test(prompt) ? [{ kind: "prompt", text: prompt, turn }] : [];
      }
      if (record.type === "token_usage_record") {
        const { no, opened } = turnFor(payload.turn_id);
        sawUsageRecords = true;
        const events = opened ? [{ kind: "turn", turn: no }] : [];
        events.push({
          kind: "call",
          call: call({
            model: modelOfTurn.get(payload.turn_id) || model || "?",
            usage: payload.usage ?? {},
            turn: no,
            responseId: typeof payload.response_id === "string" ? payload.response_id : "",
            timestamp: record.timestamp,
          }),
        });
        return events;
      }
      if (!sawUsageRecords && record.type === "event_msg" && payload.type === "token_count" && payload.info) {
        const total = JSON.stringify(payload.info.total_token_usage ?? null);
        if (total === lastTotal) return [];
        lastTotal = total;
        return [{
          kind: "call",
          call: call({
            model: model || "?",
            usage: payload.info.last_token_usage ?? {},
            turn,
            responseId: "",
            timestamp: record.timestamp,
          }),
        }];
      }
      return [];
    },
  };
}

/**
 * One unpriced call per API call in a rollout, plus the session's turn count
 * and first typed prompt.
 */
export function parseCodexCalls(text, { scope = "" } = {}) {
  const parser = createCodexCallParser({ scope });
  const calls = [];
  let firstPrompt = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; /* torn write */
    }
    for (const event of parser.push(record)) {
      if (event.kind === "call") calls.push(event.call);
      else if (event.kind === "prompt" && !firstPrompt) firstPrompt = event.text;
    }
  }
  return { calls, currentTurn: parser.currentTurn, firstPrompt };
}

function callFrom({ model, usage, turn, responseId, timestamp, index, scope = "" }) {
  const signature = usageSignature(usage.input_tokens, usage.cached_input_tokens, usage.output_tokens);
  return {
    key: responseId || `${scope ? `${scope}@` : ""}${timestamp ?? ""}#${index}:${signature}`,
    model,
    usage,
    turn,
    responseId,
    signature,
    at: typeof timestamp === "string" ? timestamp : "",
  };
}

/**
 * Price parsed calls. A call `served` resolves (see `served-models.mjs`) is
 * priced as the model that actually ran, keeping the requested one alongside.
 *
 * @param {ReturnType<typeof parseCodexCalls>} parsed
 * @param {Map<string, { model: string, billedBy: string | null }>} [served]
 */
export function priceCodexCalls(parsed, served = new Map()) {
  const rows = parsed.calls.map((call) => {
    const hit = served.get(call.key);
    const row = {
      ...computeClaudeUsageCost(hit?.model || call.model, codexUsageToClaudeUsage(call.usage)),
      turn: call.turn,
    };
    if (hit?.model && hit.model !== call.model) row.requestedModel = call.model;
    if (hit?.billedBy) row.billedBy = hit.billedBy;
    return row;
  });
  rows.currentTurn = parsed.currentTurn;
  rows.firstPrompt = parsed.firstPrompt;
  return rows;
}

/** Calls whose requested model has no price of its own (`auto` and other routers). */
function needsServedModel(call) {
  return !computeClaudeUsageCost(call.model, {}).priced;
}

/** One priced row per API call in a rollout (no served-model lookup). */
export function parseCodexUsageLog(text) {
  return priceCodexCalls(parseCodexCalls(text));
}


function reportFromRows(rollout, rows, { sessionName = "" } = {}) {
  const usedRows = rows.filter(rowHasUsage);
  const lastRow = rows.at(-1);
  const report = {
    path: rollout.filePath,
    sessionId: rollout.threadId,
    requests: usedRows.length,
    rows: usedRows,
    currentTurnModel: lastRow && lastRow.turn === rows.currentTurn ? lastRow.model : "",
    totals: sumUsage(usedRows),
    estimated: usedRows.some((row) => row.estimated),
    unpriced: usedRows.filter((row) => row.priced === false).length,
  };
  if (sessionName) report.sessionName = sessionName;
  return report;
}

/**
 * Thread names Codex keeps in `session_index.jsonl` (later lines win, so a
 * rename overrides the first title).
 */
export async function readCodexThreadNames(codexHome) {
  /** @type {Map<string, string>} */
  const names = new Map();
  let text;
  try {
    text = await readFile(path.join(codexHome, "session_index.jsonl"), "utf8");
  } catch {
    return names;
  }
  for (const line of text.split(/\r?\n/)) {
    try {
      const entry = JSON.parse(line);
      const name = cleanSessionName(entry?.thread_name);
      if (entry?.id && name) names.set(String(entry.id), name);
    } catch {
      /* skip */
    }
  }
  return names;
}

/** Subagent rollouts of `threadId`, including their own subagents. */
function descendantsOf(threadId, all) {
  const out = [];
  const queue = [threadId];
  const seen = new Set(queue);
  while (queue.length) {
    const parent = queue.shift();
    for (const rollout of all) {
      if (rollout.parentThreadId === parent && !seen.has(rollout.threadId)) {
        seen.add(rollout.threadId);
        out.push(rollout);
        queue.push(rollout.threadId);
      }
    }
  }
  return out.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/**
 * `parseCodexCalls` for a file, read a line at a time: a long session (or one
 * huge tool output) never has to fit in memory as a single string.
 *
 * @param {string} filePath
 */
export async function parseCodexCallsFromFile(filePath) {
  const parser = createCodexCallParser({ scope: codexThreadIdFromPath(filePath) });
  const calls = [];
  let firstPrompt = "";
  const lines = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; /* torn write */
    }
    for (const event of parser.push(record)) {
      if (event.kind === "call") calls.push(event.call);
      else if (event.kind === "prompt" && !firstPrompt) firstPrompt = event.text;
    }
  }
  return { calls, currentTurn: parser.currentTurn, firstPrompt };
}

async function parseRollout(rollout) {
  return { rollout, parsed: await parseCodexCallsFromFile(rollout.filePath) };
}

/**
 * `parseCodexCallsFromFile` for a caller that re-reads the same rollouts on a
 * timer (the live meter): `state` keeps the parser, the byte offset and any
 * unfinished last line, so each read parses only what was appended since. A
 * file that shrank was rewritten and is parsed again from the start.
 *
 * @param {string} filePath
 * @param {{ parser?: ReturnType<typeof createCodexCallParser>, offset?: number, partial?: Buffer, calls?: object[], firstPrompt?: string }} state
 */
export function parseCodexCallsIncremental(filePath, state) {
  // The live meter refreshes the tree from two timers; reads of one file take
  // turns, or both would parse the same appended bytes into one parser.
  const run = (state.queue ?? Promise.resolve()).then(() => parseAppended(filePath, state));
  state.queue = run.catch(() => {});
  return run;
}

async function parseAppended(filePath, state) {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    // A rewrite can be any length, so compare the file's first bytes (its
    // session_meta line) with what was parsed, not only its size.
    let rewritten = size < (state.offset ?? 0);
    if (!rewritten && state.head?.length) {
      const now = Buffer.alloc(state.head.length);
      const { bytesRead } = await handle.read(now, 0, now.length, 0);
      rewritten = bytesRead < now.length || !now.equals(state.head);
    }
    if (!state.parser || rewritten) {
      Object.assign(state, {
        parser: createCodexCallParser({ scope: codexThreadIdFromPath(filePath) }),
        offset: 0,
        partial: Buffer.alloc(0),
        head: Buffer.alloc(0),
        calls: [],
        firstPrompt: "",
      });
    }
    if (size > state.offset) {
      const fresh = Buffer.alloc(size - state.offset);
      const { bytesRead } = await handle.read(fresh, 0, fresh.length, state.offset);
      state.offset += bytesRead;
      // Keep up to HEAD_CHECK_BYTES of the file's start for rewrite detection,
      // topped up while the file is still shorter than that.
      if (state.head.length < HEAD_CHECK_BYTES) {
        const head = Buffer.alloc(Math.min(state.offset, HEAD_CHECK_BYTES));
        const read = await handle.read(head, 0, head.length, 0);
        state.head = head.subarray(0, read.bytesRead);
      }
      // Split on the last newline as bytes, so a multi-byte character cut by
      // the read boundary is decoded only once it's whole.
      const pending = Buffer.concat([state.partial, fresh.subarray(0, bytesRead)]);
      const end = pending.lastIndexOf(0x0a);
      state.partial = end < 0 ? pending : pending.subarray(end + 1);
      if (end >= 0) {
        for (const line of pending.subarray(0, end).toString("utf8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            continue; /* torn write */
          }
          for (const event of state.parser.push(record)) {
            if (event.kind === "call") state.calls.push(event.call);
            else if (event.kind === "prompt" && !state.firstPrompt) state.firstPrompt = event.text;
          }
        }
      }
    }
    return { calls: state.calls, currentTurn: state.parser.currentTurn, firstPrompt: state.firstPrompt };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** A session's parent and subagent rollouts, parsed but not yet priced. */
async function parseSession(parent, all, parse = parseRollout) {
  const [main, ...subagents] = await Promise.all([parent, ...descendantsOf(parent.threadId, all ?? [])].map(parse));
  return dedupeSessionCalls({ main, subagents });
}

/**
 * Count each API call once across a session tree. A forked rollout (or a
 * subagent started with the parent's context) copies earlier records,
 * response ids included, so the same billed call appears in two logs. The
 * first occurrence, parent first, keeps it; later ones are dropped. Calls
 * with no response id can't be told apart and are all kept.
 *
 * @param {{ main: { parsed: { calls: { responseId: string }[] } }, subagents: { parsed: { calls: { responseId: string }[] } }[] }} session
 */
export function dedupeSessionCalls(session) {
  /** Response id -> the rollout that first logged it. */
  const firstIn = new Map();
  const keep = ({ rollout, parsed }) => {
    // Response ids this rollout repeats from an EARLIER rollout (a fork's
    // copied history), so the live meter can skip them when it tails this file
    // on its own. A repeat within the same rollout isn't listed: the meter
    // already counts one call per id within a log, and listing it would make
    // the meter skip the original too.
    const inherited = [];
    const calls = parsed.calls.filter((call) => {
      if (!call.responseId) return true;
      const owner = firstIn.get(call.responseId);
      if (owner === undefined) {
        firstIn.set(call.responseId, rollout.filePath);
        return true;
      }
      if (owner !== rollout.filePath) inherited.push(call.responseId);
      return false;
    });
    return { rollout, parsed: { ...parsed, calls, inherited } };
  };
  const main = keep(session.main);
  return { main, subagents: session.subagents.map(keep) };
}

/**
 * What the served-model lookup needs for one session. Codex sends the ROOT
 * thread id as the session on every request, a subagent's included, so one
 * lookup covers the whole tree.
 */
function servedLookupFor(session) {
  const meta = session.main.rollout.meta;
  // The server lists the whole tree's calls in time order, and calls without a
  // response id are paired by order, so interleave parent and subagents by
  // when each call was logged, by instant (a timestamp may carry an offset).
  // Undated calls (old logs) follow, in log order.
  // `notBefore`: when the nearest dated call before it in its own rollout
  // completed (any model), or the rollout's start when none is. A rollout's
  // calls run one after another, so the call started no earlier; the server
  // records a call when it starts, Codex when it ends, so this bounds the
  // lookup. With neither, it's "" and the lookup reads from the session start.
  const all = [session.main, ...session.subagents]
    .flatMap(({ rollout, parsed }) => {
      let lastDated = typeof rollout.meta?.timestamp === "string" ? rollout.meta.timestamp : "";
      return parsed.calls.map((call) => {
        const entry = { call, notBefore: lastDated };
        if (call.at && Number.isFinite(Date.parse(call.at))) lastDated = call.at;
        return entry;
      });
    })
    .filter(({ call }) => needsServedModel(call))
    .map(({ call: { key, responseId, signature, at }, notBefore }) => ({ key, responseId, signature, at, notBefore, ms: Date.parse(at) }));
  const dated = all.filter((call) => Number.isFinite(call.ms)).sort((a, b) => a.ms - b.ms);
  const calls = [...dated, ...all.filter((call) => !Number.isFinite(call.ms))]
    .map(({ key, responseId, signature, at, notBefore }) => ({ key, responseId, signature, at, notBefore }));
  return {
    sessionId: safeId(meta?.session_id) || session.main.rollout.threadId,
    startedAt: typeof meta?.timestamp === "string" ? meta.timestamp : "",
    calls,
  };
}

function priceSession(session, names, served) {
  const { rollout } = session.main;
  const mainRows = priceCodexCalls(session.main.parsed, served);
  const report = reportFromRows(rollout, mainRows, {
    sessionName: names.get(rollout.threadId) || mainRows.firstPrompt,
  });
  const subagents = session.subagents
    .map(({ rollout: sub, parsed }) => ({
      ...reportFromRows(sub, priceCodexCalls(parsed, served)),
      id: subagentLabel(sub.meta, sub.threadId),
    }))
    .filter((subagent) => subagent.rows.length > 0);
  return {
    ...report,
    unpricedHint: CODEX_UNPRICED_HINT,
    subagents,
    grandTotals: subagents.reduce((totals, subagent) => addUsage(totals, subagent.totals), report.totals),
    grandRequests: report.requests + subagents.reduce((total, subagent) => total + subagent.requests, 0),
    estimated: report.estimated || subagents.some((subagent) => subagent.estimated),
    unpriced: report.unpriced + subagents.reduce((total, subagent) => total + subagent.unpriced, 0),
  };
}

/**
 * Parse every session, resolve served models for the router calls in one
 * batch, then price.
 *
 * @param {object[]} parents
 * @param {object[] | null} all
 * @param {string} codexHome
 * @param {ResolveServed} [resolveServed]
 */
async function readSessionReports(parents, all, codexHome, resolveServed) {
  const [sessions, names] = await Promise.all([
    Promise.all(parents.map((parent) => parseSession(parent, all))),
    readCodexThreadNames(codexHome),
  ]);
  let served = new Map();
  if (resolveServed) {
    const lookups = sessions.map(servedLookupFor).filter((lookup) => lookup.calls.length > 0);
    if (lookups.length > 0) {
      try {
        served = await resolveServed(lookups);
      } catch {
        /* the lookup is best effort; costs stay n/a */
      }
    }
  }
  return sessions.map((session) => priceSession(session, names, served));
}

/**
 * One session's parent and subagent rollouts, parsed, for the live meter.
 *
 * Rollout heads never change once written, so `cache` (filePath -> description)
 * lets a caller that re-reads the tree every few seconds describe each rollout
 * once. Only rollouts in the parent's day folder or later can be its
 * subagents, so earlier days are skipped.
 *
 * @param {{ codexHome: string, sessionPath: string, cache?: Map<string, Promise<object>> }} args
 */
export async function readCodexSessionTree({ codexHome, sessionPath, cache = new Map(), parseState = new Map() }) {
  const describe = (filePath) => {
    if (!cache.has(filePath)) {
      const promise = describeRollout(filePath);
      cache.set(filePath, promise);
      // A rollout seen before its session_meta line was complete has no
      // parent yet; read it again on the next poll rather than keep that.
      promise.then((rollout) => { if (!rollout.meta) cache.delete(filePath); }, () => cache.delete(filePath));
    }
    return cache.get(filePath);
  };
  const sessionsDir = rolloutRoots(codexHome)[0];
  const dayOf = (filePath) => path.relative(sessionsDir, path.dirname(filePath));
  const parent = await describe(sessionPath);
  const parentDay = dayOf(sessionPath);
  const files = [...new Set([sessionPath, ...await collectRolloutsFrom(sessionsDir, parentDay)])];
  const all = (await Promise.allSettled(files.map(describe)))
    .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  // Each rollout keeps its parse state across calls, so a refresh reads only
  // what was appended.
  const parse = async (rollout) => {
    if (!parseState.has(rollout.filePath)) parseState.set(rollout.filePath, {});
    return { rollout, parsed: await parseCodexCallsIncremental(rollout.filePath, parseState.get(rollout.filePath)) };
  };
  return parseSession(parent, all, parse);
}

/**
 * The served-model lookup for a session tree: every call that needs a served
 * model, with the session's root id and start time.
 *
 * @param {Awaited<ReturnType<typeof readCodexSessionTree>>} tree
 */
export function codexServedLookup(tree) {
  return servedLookupFor(tree);
}

/**
 * Main + subagent entries for the live meter's agents pane and picker, priced
 * with whatever served models are known so far.
 *
 * @param {Awaited<ReturnType<typeof readCodexSessionTree>>} tree
 * @param {Map<string, { model: string, billedBy: string | null }>} [served]
 * @param {Map<string, string>} [names] thread names from `readCodexThreadNames`
 */
export function codexSessionAgents(tree, served = new Map(), names = new Map()) {
  const { rollout, parsed } = tree.main;
  const mainRows = priceCodexCalls(parsed, served);
  const agents = [{
    kind: "main",
    id: "main",
    label: "Main",
    filePath: rollout.filePath,
    report: reportFromRows(rollout, mainRows, { sessionName: names.get(rollout.threadId) || mainRows.firstPrompt }),
  }];
  for (const { rollout: sub, parsed: subParsed } of tree.subagents) {
    agents.push({
      kind: "subagent",
      id: sub.threadId,
      label: subagentLabel(sub.meta, sub.threadId),
      filePath: sub.filePath,
      report: reportFromRows(sub, priceCodexCalls(subParsed, served)),
    });
  }
  return agents;
}

function reportHasUsage(report) {
  return report.rows.length > 0 || report.subagents.some((subagent) => subagent.rows.length > 0);
}

/**
 * @typedef {(lookups: { sessionId: string, startedAt: string, calls: { key: string, responseId: string, signature: string }[] }[])
 *   => Promise<Map<string, { model: string, billedBy: string | null }>>} ResolveServed
 */

/**
 * The latest (or `session`-matched) Codex session, priced, with its subagents.
 *
 * @param {{ codexHome: string, home?: string, session?: string, resolveServed?: ResolveServed }} args
 */
export async function readCodexUsage({ codexHome, home = "", session = "", withinDays, resolveServed }) {
  const { parents, all } = await findCodexRollouts({ codexHome, home, session, lastN: 1, withinDays });
  if (parents.length === 0) {
    throw new Error(`No Codex session logs found under ${rolloutRoots(codexHome)[0]}`);
  }
  return (await readSessionReports(parents, all, codexHome, resolveServed))[0];
}

/**
 * The latest N top-level Codex sessions, in the group shape
 * `formatClaudeUsageReports` and the interactive display take.
 *
 * `includeEmpty` keeps sessions with no calls yet (the live picker wants a
 * session that has only just started).
 *
 * @param {{ codexHome: string, home?: string, session?: string, lastN?: number|string, withinDays?: number|string, resolveServed?: ResolveServed, includeEmpty?: boolean }} args
 */
export async function readCodexUsages({ codexHome, home = "", session = "", lastN = 1, withinDays, resolveServed, includeEmpty = false } = {}) {
  const requestedLastN = parseLastN(lastN);
  const { parents, all } = await findCodexRollouts({ codexHome, home, session, lastN, withinDays });
  const reports = await readSessionReports(parents, all, codexHome, resolveServed);
  const sessions = includeEmpty ? reports : reports.filter(reportHasUsage);
  return {
    sessions,
    grandTotals: sessions.reduce((totals, report) => addUsage(totals, report.grandTotals), sumUsage([])),
    grandRequests: sessions.reduce((total, report) => total + report.grandRequests, 0),
    unpricedHint: CODEX_UNPRICED_HINT,
    estimated: sessions.some((report) => report.estimated),
    unpriced: sessions.reduce((total, report) => total + report.unpriced, 0),
    lastN: sessions.length,
    requestedLastN,
    sessionCount: sessions.length,
  };
}
