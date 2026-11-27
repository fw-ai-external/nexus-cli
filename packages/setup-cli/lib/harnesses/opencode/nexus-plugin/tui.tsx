/** @jsxImportSource @opentui/solid */
/**
 * Fireworks Nexus for OpenCode: a card in the session sidebar (the Fireworks
 * symbol and one line on what Nexus is), and the Ultra-fast celebration.
 *
 * Ultra-fast: when the account's Ultra-fast boost starts, a 5-second fireworks
 * banner plays once along the bottom of the screen (the `app` slot), and
 * while the boost runs, the prompt footer shows "ϟ Ultra-fast 100%, 5h 00m
 * left". The banner's frames are the Claude Code mod's (frames.mjs), and the
 * boost check is its rewards.mjs; `nexus opencode on` copies both here.
 *
 * The logo is the same mark the Nexus CLI prints (lib/ui/brand-logo.mjs): the
 * symbol as Braille dots, each column colored along the CLI's logo gradient,
 * transparent background. It renders in every terminal, no image support needed.
 *
 * Installed by `nexus opencode` into ~/.config/opencode/plugins/fireworks-nexus/
 * (OpenCode auto-discovers plugin folders there) and removed by `off`. No
 * build step: OpenCode compiles .tsx plugins itself and provides solid-js and
 * @opentui/*. Needs OpenCode 2.x; 1.x ignores the folder.
 *
 * It runs inside OpenCode, so it must never be what breaks OpenCode:
 * - no import of @opencode/plugin: the module is a plain `{ id, setup }`
 *   object (what Plugin.define returns), so a 2.x release that moves or renames
 *   that package can't fail the import;
 * - setup is wrapped in try/catch, in case the slot API changes;
 * - the card renders inside an ErrorBoundary, and theme colors are read with
 *   fallbacks, so a render error shows nothing instead of crashing the TUI.
 */
import { ErrorBoundary, Show, createSignal } from "solid-js"
import { fileURLToPath } from "node:url"

// Same art as lib/ui/brand-logo.mjs LOGO_CELLS_SMALL.
const LOGO_CELLS = [
  "⠀⣠⡀⢻⣀⡟⢀⣄⠀",
  "⢠⣬⣹⡎⠛⢱⣏⣥⡄",
]
// lib/ui/tokens.mjs LOGO_GRADIENT, interpolated per column like the CLI does.
const GRADIENT = ["#D97547", "#DE4A7D", "#D361AD", "#D494BB"]
const WIDTH = [...LOGO_CELLS[0]].length

function gradientAt(position: number) {
  const t = Math.min(1, Math.max(0, position)) * (GRADIENT.length - 1)
  const index = Math.min(GRADIENT.length - 2, Math.floor(t))
  const local = t - index
  const [from, to] = [GRADIENT[index], GRADIENT[index + 1]].map((hex) => {
    const value = Number.parseInt(hex.slice(1), 16)
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
  })
  const channels = from.map((channel, i) => Math.round(channel + (to[i] - channel) * local))
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}

const COLUMN_COLORS = [...Array(WIDTH).keys()].map((column) => gradientAt(column / (WIDTH - 1)))

/** A theme text color, or `fallback` if this OpenCode's theme lacks it. */
function themeText(context: any, key: string, fallback: string) {
  try {
    return context?.theme?.text?.[key] ?? fallback
  } catch {
    return fallback
  }
}

function NexusCard(props: { context: any }) {
  return (
    <box flexShrink={0} flexDirection="row" gap={1}>
      <box flexShrink={0}>
        {LOGO_CELLS.map((row) => (
          <text>
            {[...row].map((char, column) => <span style={{ fg: COLUMN_COLORS[column] }}>{char}</span>)}
          </text>
        ))}
      </box>
      <box flexDirection="column" justifyContent="center">
        <text fg={themeText(props.context, "base", "#E6E6E6")}><b>Fireworks Nexus</b></text>
        <text fg={themeText(props.context, "muted", "#8A8A8A")}>Hosted on Fireworks</text>
      </box>
    </box>
  )
}


// ---------------------------------------------------------------------------
// Ultra-fast
//
// frames.mjs, rewards.mjs and ultrafast.mjs are imported dynamically, so a
// folder missing one of them (or a module that fails to load) costs only the
// Ultra-fast parts; the card above still shows. Every timer is cleared by
// setup's cleanup, so a plugin reload never leaves one running.

const BANNER_FRAME_MS = 50 // 20 fps, as the Claude Code mod plays it
const BADGE_REFRESH_MS = 15_000
const BADGE_COLOR = "#F2A866" // the Claude Code status line badge's orange
const DEMO_REASON = "You sent 5M tokens!"
const DEMO_HOURS = 5
const STORAGE_KEY = "ultrafast"

type Status = { reason?: string; expiresAt?: number | null }
type Modules = { frames: any; rewards: any; ultrafast: any }
type Playing = { startedAt: number; rows: number; status: Status }

/** A named tone's color, or the tone itself when it is a hex color (the logo's gradient). */
function toneColor(colors: Record<string, string | null>, tone: string | null) {
  if (!tone) return undefined
  if (tone.startsWith("#")) return tone
  return colors[tone] ?? undefined
}

function Banner(props: { context: any; modules: Modules; playing: Playing; now: number }) {
  const frame = () => {
    try {
      const width = Number(props.context?.renderer?.width) || 80
      return props.modules.frames.bannerFrame({
        elapsedMs: props.now - props.playing.startedAt,
        // frames.mjs adds the 5 columns Claude Code keeps at the band's edge,
        // so the banner centers on the whole terminal row.
        columns: Math.max(1, width - 5),
        rows: props.playing.rows,
        status: props.playing.status,
        now: props.now,
      })
    } catch {
      return null
    }
  }
  return (
    <Show when={frame()}>
      {(rows) => (
        <box flexShrink={0} flexDirection="column">
          {rows().map((runs: any[]) => (
            <text>
              {runs.length === 0
                ? " "
                : runs.map((run) => (
                    <span style={{ fg: toneColor(props.modules.frames.COLORS, run.tone) }}>
                      {run.bold ? <b>{run.text}</b> : run.text}
                    </span>
                  ))}
            </text>
          ))}
        </box>
      )}
    </Show>
  )
}

function Badge(props: { modules: Modules; boost: any; now: number }) {
  const parts = () => {
    try {
      return props.modules.ultrafast.badgeParts(props.boost, props.now)
    } catch {
      return null
    }
  }
  return (
    <Show when={parts()}>
      {(p) => (
        <text flexShrink={0}>
          <span style={{ fg: BADGE_COLOR }}><b>ϟ Ultra-fast</b></span>
          {` ${[p().share, `${p().left} left`].filter(Boolean).join(", ")}`}
        </text>
      )}
    </Show>
  )
}

function setupUltrafast(context: any): () => void {
  const env: Record<string, string | undefined> = (globalThis as any).process?.env ?? {}
  const [modules, setModules] = createSignal<Modules | null>(null)
  const [playing, setPlaying] = createSignal<Playing | null>(null)
  const [boost, setBoost] = createSignal<any>(null)
  const [now, setNow] = createSignal(Date.now())
  let frameTimer: ReturnType<typeof setInterval> | null = null
  let stopTimer: ReturnType<typeof setTimeout> | null = null
  let poll: ReturnType<typeof setInterval> | null = null
  let disposed = false

  // The activation played last, kept across restarts in OpenCode's plugin
  // storage so a boost plays its banner once; in memory if that's missing.
  let lastPlayed = ""
  let stored: any = null
  let mutate: any = null
  try {
    ;[stored, mutate] = context?.storage?.store?.(STORAGE_KEY, { initial: { played: "" } }) ?? []
  } catch {}
  const playedKey = () => {
    try {
      // Memory first: a storage write that failed must not replay a banner.
      return String(lastPlayed || stored?.played || "")
    } catch {
      return lastPlayed
    }
  }
  const markPlayed = (key: string) => {
    lastPlayed = key
    try {
      mutate?.((draft: any) => {
        draft.played = key
      })?.catch?.(() => {})
    } catch {}
  }

  const stop = () => {
    if (frameTimer) clearInterval(frameTimer)
    if (stopTimer) clearTimeout(stopTimer)
    frameTimer = null
    stopTimer = null
    setPlaying(null)
  }
  const play = (status: Status) => {
    const loaded = modules()
    if (!loaded || disposed) return
    stop()
    const startedAt = Date.now()
    setNow(startedAt)
    setPlaying({
      startedAt,
      rows: loaded.ultrafast.bannerRowsFor(context?.renderer?.height, loaded.frames.MAX_ROWS),
      status,
    })
    frameTimer = setInterval(() => setNow(Date.now()), BANNER_FRAME_MS)
    // The banner ends itself at BANNER_MS; this ends the timer in any case.
    stopTimer = setTimeout(stop, loaded.frames.BANNER_MS + 250)
  }

  const clock = setInterval(() => {
    if (!frameTimer) setNow(Date.now())
  }, BADGE_REFRESH_MS)

  Promise.all([import("./frames.mjs"), import("./rewards.mjs"), import("./ultrafast.mjs")])
    .then(([frames, rewards, ultrafast]) => {
      if (disposed) return
      setModules({ frames, rewards, ultrafast })
      const pluginDir = fileURLToPath(new URL(".", import.meta.url))
      const fetchStatus = ultrafast.boundedFetch(globalThis.fetch)
      // rewards.mjs's account cache: the key's account is looked up once per key.
      const accountCache = {}
      const checker = ultrafast.createBoostChecker({
        env,
        isMock: (url: unknown) => Boolean(rewards.mockOrigin(url)),
        check: ({ mockUrl }: { mockUrl: unknown }) =>
          ultrafast.checkBoost({
            fetchBoostStatus: rewards.fetchBoostStatus,
            mockOrigin: rewards.mockOrigin,
            fetch: fetchStatus,
            pluginDir,
            mockUrl,
            cache: accountCache,
          }),
        onStatus: (status: any) => {
          if (disposed) return
          setBoost(status.active ? status : null)
          // The time the answer arrived, not when the check started: a boost
          // that ended while the check waited must not play its banner.
          const arrived = Date.now()
          const decision = frames.activationToPlay({ fetchedAt: arrived, status }, playedKey(), arrived)
          if (!decision.play || !decision.status) return
          markPlayed(decision.key)
          play({ reason: String(decision.status.reason ?? ""), expiresAt: decision.status.expiresAt ?? null })
        },
      })
      checker.tick()
      // The checker keeps its own pace (minutes, or seconds against a mock).
      poll = setInterval(() => checker.tick(), ultrafast.MOCK_CHECK_MS)
    })
    .catch(() => {})

  // `/ultrafast-demo` previews the banner, like the Claude Code mod's. The
  // layer is made inside a rendered component, as OpenCode's own plugins do:
  // the keymap ties it to that component's lifetime.
  function DemoCommand() {
    try {
      context?.keymap?.layer?.(() => ({
        // Reachable from the prompt and everywhere else, as OpenCode's own /stats is.
        mode: "global",
        commands: [
          {
            id: "fireworks.nexus.ultrafast-demo",
            title: "Play the Ultra-fast banner",
            description: "Preview the banner Nexus shows when an Ultra-fast boost starts",
            group: "Fireworks Nexus",
            slash: { name: "ultrafast-demo" },
            palette: true,
            run: () => {
              play({ reason: DEMO_REASON, expiresAt: Date.now() + DEMO_HOURS * 3_600_000 })
            },
          },
        ],
      }))
    } catch {}
    return null
  }

  try {
    context?.ui?.slot?.({
      append: "app",
      render: () => (
        <ErrorBoundary fallback={() => null}>
          {/* Only once the banner's modules loaded, so the command never does nothing. */}
          <Show when={modules()}>
            <DemoCommand />
          </Show>
          <Show when={modules() && playing()}>
            {(current) => <Banner context={context} modules={modules()!} playing={current()} now={now()} />}
          </Show>
        </ErrorBoundary>
      ),
    })
    context?.ui?.slot?.({
      append: "prompt.footer.status",
      render: () => (
        <ErrorBoundary fallback={() => null}>
          <Show when={modules()}>{(loaded) => <Badge modules={loaded()} boost={boost()} now={now()} />}</Show>
        </ErrorBoundary>
      ),
    })
  } catch {}

  return () => {
    disposed = true
    stop()
    clearInterval(clock)
    if (poll) clearInterval(poll)
  }
}

export default {
  id: "fireworks.nexus",
  setup(context: any) {
    try {
      context?.ui?.slot?.({
        prepend: "sidebar.content",
        render: () => (
          <ErrorBoundary fallback={() => null}>
            <NexusCard context={context} />
          </ErrorBoundary>
        ),
      })
    } catch {
      // An OpenCode without this slot API just doesn't get the card.
    }
    try {
      return setupUltrafast(context)
    } catch {
      // Without Ultra-fast, the card still shows.
    }
  },
}
