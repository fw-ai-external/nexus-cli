# Ultra-fast banner mod (prototype)

A Claude Code mod that plays the Ultra-fast activation banner in the band
above the prompt when the account's Ultra-fast boost turns on.

`nexus claude on` installs it on Claude Code 2.1.287 or newer by adding this
folder to `CLAUDE_CODE_PLUGIN_DIRS` in the settings `env` it manages, after
any entries of your own; `nexus claude off` removes only that entry. On
older Claude Code, or with `NEXUS_CLAUDE_MODS=0`, `on` leaves it out and no
banner plays.

## Try it without Nexus

```bash
claude --plugin-dir packages/setup-cli/mods/ultrafast-fireworks
```

Then, in the session:

- `/ultrafast-demo` plays the banner at 20 fps on its nine rows.
- `/ultrafast-demo <fps> <rows>` picks the redraw rate (1 to 60) and rows (2 to 9).
- `/ultrafast-demo stats` shows what the last play measured: the
  band's `maxRows` and width, and the redraw rate it got.
- `/ultrafast-demo stop` ends a play early.

## When it plays by itself

The mod asks the account's Ultra-fast status whether a window is running when a session
starts, after each turn, and while idle, at most once every two minutes, with
the Fireworks key `nexus claude on` wrote into your user settings (never a
project's). Requests go only to the Fireworks gateway. While a boost is on,
the banner plays once at the start of every new session and after each
`/clear` or resume, and once in a running session when a new boost starts.
It plays only while the session's model is Nexus Auto (`auto`, with or
without `[1m]`), the only model a boost speeds up: a session on a Claude model
or a concrete Fireworks model sees nothing, and one that switches to Auto
during a boost plays it then. So playing by itself needs more than the
2.1.287 that loads the mod: the Claude Code must also report the session's
model to mods (`$.session.model()`). 2.1.329 and newer do; where it can't
say, the banner stays off (`/ultrafast-demo` still plays). Claude Desktop
in third-party mode (`nexus claude-desktop on`) names Nexus Auto in its
picker with a Claude model id that only its local proxy routes to Auto, so
a session there reports that Claude id and the banner doesn't play. It plays only
in the terminal: the desktop app, the VS Code extension and headless
`claude -p` runs load the mod too but skip it. `NEXUS_ULTRAFAST_STATUS=0`
turns the check off.

To try it with a local stand-in for the rewards, run
`node scripts/mock-nexus-rewards.mjs` and start Claude Code with
`NEXUS_ULTRAFAST_MOCK_URL=http://127.0.0.1:8799`. The mod then checks every few
seconds and sends a placeholder key, never yours.

## Layout

| File | What it holds |
| --- | --- |
| `.claude-plugin/plugin.json` | The manifest. |
| `hooks/hooks.json` | Names the hooks module. |
| `hooks/register.tsx` | The hooks: the slash command, the boost check, the frame timer and the `AbovePrompt` drawing. |
| `hooks/frames.mjs` | Pure frame layout, shared with the tests (`test/mods/`). |
| `hooks/rewards.mjs` | Pure boost lookup over an injected fetch, and the key and mock checks, shared with the tests. |
| `hooks/session.mjs` | What happens after each boost check, on each drawn frame and when a `/clear` or resume starts a new conversation: the badge record, whether to play, and when a play counts. Shared with the tests. |
| `types/index.d.ts` | The `$.state` values the mod keeps. |

The banner is a port of the design prototype's "Banner" animation, nine
rows tall: an empty row (a gap below Claude Code's text), the Fireworks symbol (Nexus's small mark scaled up 2x, in the
logo gradient), a blank row, "ϟ  U L T R A - F A S T   A C T I V A T E D  ϟ",
a blank row and the subtitle. A `━` streak wipes across the title
and subtitle in ten 65 ms steps; then for 54 ticks of 80 ms (five seconds in
all), 21 fireworks on a fixed schedule rise and burst into rings that widen
and fade around the text, among seeded twinkles. It follows the prototype
with two changes: a blank row between the title and the subtitle, and a
subtitle that says "Enjoy faster responses" with no speed-up figure. A
shorter band drops the top row of sky, then shows just the title, the blank
row and the subtitle, and at two rows only the title and subtitle.
