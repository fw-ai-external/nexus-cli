/** @jsxImportSource @opentui/solid */
/**
 * Fireworks Nexus card for OpenCode's session sidebar: the Fireworks symbol and
 * one line on what Nexus is.
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
import { ErrorBoundary } from "solid-js"

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
  },
}
