import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Run } from '../types'
import {
  BANNER_MS,
  bannerFrame,
  bannerRows,
  COLORS,
  MAX_ROWS,
} from './frames.mjs'
import { fetchBoostStatus, fireworksKeyFromEnv, keyFingerprint, mockOrigin } from './rewards.mjs'
import type { BoostStatus } from './rewards.mjs'
import { abandonPlay, afterBoostCheck, confirmAutoModel, conversationSeen, frameDrawn, loadMarker, newSession, nextCheck, saveFailed, modelStatsLine, sessionEnded, sessionModel, startPlay, stopForModel, takeSave } from './session.mjs'
import type { SessionState } from './session.mjs'

const COMMAND = 'ultrafast-demo'
// run-3: `rows` is back, for the sky above the banner.
const run = atom({ plugin: 'nexus-ultrafast', key: 'run' } as const, null, { shape: 'run-3' })
// Bumped on every frame; the band hook reads it, so each bump redraws it.
const tick = atom({ plugin: 'nexus-ultrafast', key: 'tick' } as const, 0)
// The activation this conversation has shown. In $.state rather than module
// memory, so a hot reload of the mod doesn't replay it; a /clear resets it.
const played = atom({ plugin: 'nexus-ultrafast', key: 'played' } as const, '')

const DEFAULT_FPS = 20
const MAX_FPS = 60
const DEMO_STATUS = { reason: 'You sent 5M tokens!', hours: 5 }
// Ask the account's Ultra-fast status at most this often; a window lasts hours. Against
// a local mock, every few seconds, so trying the banner doesn't wait.
const BOOST_CHECK_MS = 2 * 60_000
const MOCK_CHECK_MS = 5_000
// After the status route answers 404 (the account's gateway doesn't serve it
// yet), check far less often, so sessions don't keep asking for a route that
// isn't there.
const ROUTE_MISSING_CHECK_MS = 30 * 60_000
// Where the boost window is recorded for the Nexus status line's
// "ϟ Ultra-fast 100%, 5h 00m left" badge, relative to HOME.
const BOOST_FILE = '.nexus/ultrafast-boost.json'

type Stats = {
  fps: number
  ticks: number
  renders: number
  renderGaps: number[]
  lastRenderAt: number
  maxRows: number
  bodyColumns: number
  startedAt: number
}

// The module's own variables start over on a hot reload; `run` in $.state
// does not, so a reload mid-play leaves at most one stale frame, which
// bannerFrame ends by itself once BANNER_MS has passed.
const local: {
  timer: Timer | null
  guard: Timer | null
  stats: Stats | null
  lastReport: string
  // How the last boost check ended, for `/ultrafast-demo stats`.
  lastCheck: string
  // The model the last check read ("" when Claude Code couldn't say) and
  // why, for `/ultrafast-demo stats`.
  lastModel: { model: string, why: string } | null
  // Whether the play running now was asked for with /ultrafast-demo: only
  // those end with the timing toast.
  demo: boolean
  lastBoostCheck: number
  // The wait before the next check: BOOST_CHECK_MS, or longer after a 404.
  checkInterval: number
  // The key's account ID, kept in memory only (never written), keyed by a
  // fingerprint of the key, so a check skips /verifyApiKey.
  account: { fingerprint?: string, accountId?: string }
  checking: boolean
  poll: Timer | null
  // An activation that starts playing is recorded as played only once a
  // frame has actually been drawn, so one hidden behind a survey, or stopped
  // for leaving Auto before a frame drew, plays again.
  // This conversation's played marker (see session.mjs). `playedKey` is
  // loaded from, and saved to, the `played` atom.
  session: SessionState
  // The last status a check fetched, reused until the next one is due.
  lastStatus: { status: BoostStatus, fetchedAt: number, keyPrint: string } | null
} = {
  timer: null,
  guard: null,
  stats: null,
  lastReport: 'No play yet. Run /ultrafast-demo first.',
  lastCheck: 'No boost check yet.',
  lastModel: null,
  demo: false,
  lastBoostCheck: 0,
  checkInterval: BOOST_CHECK_MS,
  account: {},
  checking: false,
  poll: null,
  session: newSession(),
  lastStatus: null,
}

// Saves a play the render hook counted: $.state refuses writes while a
// render draws, so frameDrawn only marks it and this writes it afterwards.
async function savePlayed($: EngineInterface): Promise<void> {
  const key = takeSave(local.session)
  if (key === null) return
  try {
    await update($, played, () => key)
  } catch {
    // Try again next time; until then the in-memory marker stands.
    saveFailed(local.session)
  }
}

// Whether the boost check is off: the kill switch, or the CLI's test runs.
async function checkOff($: EngineInterface): Promise<boolean> {
  return (await $.env.get('NEXUS_ULTRAFAST_STATUS')) === '0' || (await $.env.get('NEXUS_TEST')) === '1'
}

// A new conversation in the same process (/clear, resume): stop any banner
// still running from the old one (a demo too, without its timing toast) and
// forget what it played. The cooldown stays: the next check replays a running
// boost from the last status fetched (see nextCheck), not a new request.
async function startOver($: EngineInterface): Promise<void> {
  if (local.timer || local.guard) await stop($, true)
  try {
    if (await read($, played)) await update($, played, () => '')
  } catch {
    // Keep the cleared marker due, so the next check neither reads back the
    // old conversation's key nor skips retrying the write.
    saveFailed(local.session)
  }
}

async function stop($: EngineInterface, quiet = false): Promise<void> {
  await savePlayed($)
  local.timer?.cancel()
  local.guard?.cancel()
  local.timer = null
  local.guard = null
  try {
    await update($, run, () => null)
  } catch {}
  const stats = local.stats
  if (stats) {
    local.stats = null
    local.lastReport = report(stats, await $.clock.now())
    // Timing numbers are for whoever ran the demo; a real activation ends quietly.
    if (local.demo && !quiet) $.ui.toast(local.lastReport, { timeoutMs: 8000 })
  }
}

async function play($: EngineInterface, status: Run['status'], fps: number, rows: number, demo = false, key = '', confirm?: () => Promise<boolean>): Promise<void> {
  await stop($)
  // The last word on an automatic play, as close to publishing it as it can
  // be: a switch away from Auto after this is a switch mid-banner, which the
  // next check stops.
  if (confirm && !(await confirm())) return
  local.demo = demo
  startPlay(local.session, key, demo)
  const startedAt = await $.clock.now()
  local.stats = {
    fps, ticks: 0, renders: 0, renderGaps: [], lastRenderAt: 0,
    maxRows: 0, bodyColumns: 0, startedAt,
  }
  await update($, run, () => ({ startedAt, fps, rows, status }))
  // Bounded twice over: the interval stops itself after the banner's frames,
  // and a one-shot guard stops it in any case shortly after.
  const maxTicks = Math.ceil((BANNER_MS / 1000) * fps) + 2
  let ticks = 0
  local.timer = $.clock.every(Math.max(1, Math.round(1000 / fps)), () => {
    ticks += 1
    if (local.stats) local.stats.ticks = ticks
    if (ticks > maxTicks) {
      stop($).catch(() => {})
      return
    }
    update($, tick, n => n + 1).catch(() => {})
    savePlayed($).catch(() => {})
  })
  local.guard = $.clock.after(BANNER_MS + 250, () => {
    stop($).catch(() => {})
  })
}

async function readSessionModel($: EngineInterface) {
  const modelRead: { why?: string } = {}
  const model = await sessionModel(() => $.session.model(), { after: (ms, fn) => $.clock.after(ms, fn), outcome: modelRead })
  const result = { model, why: modelRead.why ?? '' }
  local.lastModel = result
  return result
}

// Asks the account's Ultra-fast status whether a window is running, and plays the banner for
// an activation this session has not played yet. One request chain at a
// time, at most once per BOOST_CHECK_MS (ROUTE_MISSING_CHECK_MS after a 404); called from hooks without being
// awaited, and never throws.
async function checkBoost($: EngineInterface): Promise<void> {
  if (local.checking) return
  // Set before the first await, so overlapping hooks never start a second
  // chain; the finally below clears it on every return.
  local.checking = true
  try {
    if (await checkOff($)) return
    // Another conversation in this process, seen by its session id: the
    // fallback for a /clear or resume whose session.end this mod didn't see.
    let conversation = ''
    try {
      conversation = await $.session.id()
    } catch {}
    if (conversationSeen(local.session, conversation)) await startOver($)
    // The main loop's model, read on every check whether or not a boost is
    // on (the person can switch it with /model or Desktop's picker): only
    // Nexus Auto plays. A Claude Code that can't say counts as no model, so
    // no banner. Bounded like the boost fetch: a read that never answers
    // must not hold `checking` and stop every later check.
    const { model, why } = await readSessionModel($)
    // Left Auto while the banner runs: end it now rather than finish the play.
    if (stopForModel({ playing: Boolean(local.timer), demo: local.demo, model, why })) {
      abandonPlay(local.session)
      await stop($, true)
    }
    const mockUrl = await $.env.get('NEXUS_ULTRAFAST_MOCK_URL')
    const interval = mockOrigin(mockUrl) ? MOCK_CHECK_MS : local.checkInterval
    const now = await $.clock.now()
    // The key `nexus claude on` wrote into the user's own settings: never a
    // project's, so a repository can't swap in a key of its own. Read on
    // every check (a local read), so a cached status is only reused for the
    // key that fetched it.
    const user = await $.settings.read({ source: 'user' })
    const key = fireworksKeyFromEnv(user?.env)
    const keyPrint = keyFingerprint(key, mockUrl)
    // Another key, or none: the last account's boost is never replayed.
    if (local.lastStatus && local.lastStatus.keyPrint !== keyPrint) local.lastStatus = null
    const due = nextCheck({ now, lastCheck: local.lastBoostCheck, interval, keyPrint, last: local.lastStatus })
    if (!due.fetch) {
      if (due.status) await decideAndPlay($, due.status, model, now, due.fetchedAt, false)
      return
    }
    local.lastBoostCheck = now
    const outcome: { text?: string, status?: number } = {}
    const status = await fetchBoostStatus({
      fetch: (url, init) => $.http.fetch(url, init),
      key,
      mockUrl,
      now,
      outcome,
      cache: local.account,
      // $.http.fetch has no deadline of its own: without this, one request
      // that never answers would hold `checking` forever and stop every
      // later check.
      after: (ms, fn) => $.clock.after(ms, fn),
    })
    local.checkInterval = outcome.status === 404 ? ROUTE_MISSING_CHECK_MS : BOOST_CHECK_MS
    local.lastCheck = `${new Date(now).toISOString()}: ${outcome.text ?? 'no answer'}`
    if (!status) return
    local.lastStatus = { status, fetchedAt: now, keyPrint }
    await decideAndPlay($, status, model, now, now, true)
  } catch {
    // No answer: the next check tries again.
  } finally {
    local.checking = false
  }
}

// After a check: write the record the status line badge reads (only for a
// status fetched now), and play the banner if this conversation hasn't.
async function decideAndPlay($: EngineInterface, status: BoostStatus, model: string, now: number, fetchedAt: number, fetched: boolean): Promise<void> {
  await savePlayed($)
  loadMarker(local.session, await read($, played))
  const { record, play: toPlay, key } = afterBoostCheck(local.session, {
    status,
    entrypoint: await $.env.get('CLAUDE_CODE_ENTRYPOINT'),
    model,
    now,
    fetchedAt,
    demoRunning: local.demo && Boolean(local.timer),
  })
  if (fetched) {
    // The status line shows the boost's time left from this record; it
    // never asks the network itself. HOME, or USERPROFILE where HOME isn't
    // set (Windows), as the status line reads it.
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    if (home) $.fs.write(`${home}/${BOOST_FILE}`, JSON.stringify(record)).catch(() => {})
  }
  // A demo may have started while this check ran: don't cut it short.
  if (!toPlay || (local.demo && local.timer)) return
  await play(
    $,
    { reason: String(toPlay.reason ?? ''), expiresAt: toPlay.expiresAt ?? null },
    DEFAULT_FPS,
    MAX_ROWS,
    false,
    key,
    // Re-read right before the banner is published, not before setup.
    () => confirmAutoModel(() => readSessionModel($)),
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Play the Ultra-fast activation banner',
      argumentHint: '[fps] [rows] | stats | stop',
    })
    checkBoost($).catch(() => {})
    // Idle sessions see a new boost too; checkBoost keeps its own pace.
    local.poll?.cancel()
    local.poll = $.clock.every(MOCK_CHECK_MS, () => {
      checkBoost($).catch(() => {})
    })
    return next(e)
  })

  // A /clear or a resume ends the conversation but keeps the process, with
  // no session.start after it: start the new one over (see startOver).
  on('session.end', ($, e, next) => {
    try {
      if (sessionEnded(local.session, e.reason)) {
        checkOff($)
          .then(off => (off ? undefined : startOver($)))
          .catch(() => {})
      }
    } catch {}
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    checkBoost($).catch(() => {})
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    if (args[0] === 'stats') {
      const model = local.lastModel === null ? 'Session model: not read yet.' : modelStatsLine(local.lastModel.model, local.lastModel.why)
      return { text: `${local.lastReport}\nLast boost check: ${local.lastCheck}\n${model}` }
    }
    if (args[0] === 'stop') {
      await stop($)
      return { text: 'Stopped.' }
    }
    const fps = clampInt(args[0], 1, MAX_FPS, DEFAULT_FPS)
    const rows = clampInt(args[1], 2, MAX_ROWS, MAX_ROWS)
    const now = await $.clock.now()
    await play($, { reason: DEMO_STATUS.reason, expiresAt: now + DEMO_STATUS.hours * 3_600_000 }, fps, rows, true)
    return { text: `Ultra-fast banner: ${fps} fps, up to ${rows} rows.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      const current = await read($, run)
      await read($, tick)
      if (!current || e.props.hasSurvey) return next(e)
      const now = await $.clock.now()
      const elapsedMs = now - current.startedAt
      const frame = bannerFrame({
        elapsedMs,
        columns: e.props.bodyColumns,
        rows: bannerRows(e.props.maxRows, current.rows),
        status: current.status,
        now,
      })
      if (!frame) return next(e)
      // Only marks the play: a render can't write $.state (see savePlayed).
      frameDrawn(local.session, local.demo)
      const stats = local.stats
      if (stats) {
        stats.renders += 1
        if (stats.lastRenderAt) stats.renderGaps.push(now - stats.lastRenderAt)
        stats.lastRenderAt = now
        stats.maxRows = e.props.maxRows
        stats.bodyColumns = e.props.bodyColumns
      }
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {frame.map(runs => (
            <Text wrap="truncate-end">
              {runs.length === 0
                ? ' '
                : runs.map(r => (
                    <Text
                      color={toneColor(r.tone)}
                      bold={r.bold}
                    >
                      {r.text}
                    </Text>
                  ))}
            </Text>
          ))}
        </Box>
      )
    } catch {
      return next(e)
    }
  })
}

// A named tone's color, or the tone itself when it is already a hex color
// (the logo's gradient columns); null and unknown tones take the terminal's.
function toneColor(tone: string | null): string | undefined {
  if (!tone) return undefined
  if (tone.startsWith('#')) return tone
  return COLORS[tone] ?? undefined
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function report(s: Stats, endedAt: number): string {
  // Rate over the frames actually drawn: first render to last.
  const seconds = Math.max(0.001, ((s.lastRenderAt || endedAt) - s.startedAt) / 1000)
  const gaps = [...s.renderGaps].sort((a, b) => a - b)
  const p95 = gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))] : 0
  const max = gaps.length ? gaps[gaps.length - 1] : 0
  return [
    `asked ${s.fps} fps`,
    `band maxRows ${s.maxRows}, ${s.bodyColumns} cols`,
    `${s.ticks} ticks, ${s.renders} renders in ${seconds.toFixed(1)}s = ${(s.renders / seconds).toFixed(1)} fps`,
    `gap p95 ${p95}ms, max ${max}ms`,
  ].join('; ')
}
