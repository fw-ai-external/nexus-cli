# `fireconnect claude usage`

Everything that reads Claude Code's session logs and turns them into cost.

## Entry points

The harness (`../index.mjs`) uses two, depending on the flags:

| Command | Path |
| --- | --- |
| `claude usage` on a TTY | `session-picker.mjs` → `live.mjs` → `meter.mjs` |
| `--json` / `--last-n` / `--plain` / non-TTY | `report.mjs` → `display.mjs` |

## Modules

**Shared**

- `pricing.mjs` — canonical provider-rate lookup and call pricing. Snapshot,
  live meter, statusline, and demo all call `computeClaudeUsageCost` here.
- `cost.mjs` — nullable cost representation (`null` means unavailable) and
  null-propagating total arithmetic.
- `report.mjs` — parses session JSONL, aggregates priced rows, and orchestrates
  snapshot output. When `requestedModel` names a serving-mode router (such as
  Fast or Ultra-fast) of the served model, rows use the router's label and
  rates rather than the base model returned in the response. The `[1m]` suffix
  is stripped before matching. With a cold catalog cache only serving-mode
  slugs (such as `-fast` or `-ultrafast`) match, so `-fast-latest` aliases keep the served
  model's rates until the catalog is cached. Other requests, including `auto`, keep the
  served model. The statusline reads these same report rows. When the first content
  block records its stream time (thinking or tool input), it also measures the newest
  call's generated-token rate (prefill and TTFT excluded); the statusline opts in, so
  `--json` keeps its report shape.
- `format.mjs` — cost and cache-percentage strings shared by the meter and both
  pickers.
- `agents.mjs` — discovers subagent logs and labels them from the `.meta.json`
  sidecar Claude Code writes next to each one.

**Snapshot**

- `display.mjs` — the table `--plain` and `--json`-less snapshots print.

**Live meter**, in dependency order — each layer may import from the ones above
it in this list, never below:

- `meter-style.mjs` — SGR colour codes, box glyphs, printable-width measurement.
  Colour is decided per run, so these are module-level `let`s that
  `applyMeterStyle` sets once; importers see the change through ES module live
  bindings.
- `meter-hooks.mjs` — the other leaf: like `meter-style.mjs` it imports nothing in this folder, so the two sit together at the bottom. Hooks for a harness whose logs are not Claude Code's: a
  per-run translator from its log lines to the records the meter tallies, and a
  throttled background refresh the tail loop never awaits. `codex usage` uses
  both (see `../../codex/usage/live.mjs`).
- `meter-layout.mjs` — the column table. Every width in the frame derives from
  `TOKEN_COLUMNS`, so a heading and its cells cannot drift apart.
- `meter-model.mjs` — pricing one call, `Tally`/`Turn`, and reading prompt text
  out of a log record. No rendering.
- `meter-render.mjs` — state in, lines of text out. Pure functions, so a frame
  can be rendered in a test without a Dashboard or a stream.
- `meter.mjs` — the `Dashboard` that accumulates records into tallies, plus the
  tail loop that feeds it.

**Navigation**

- `live.mjs` — orchestrates the session, owns the agents-pane state, and moves
  between agents and sessions.
- `session-picker.mjs`, `agent-picker.mjs` — the two interactive lists.

## Token columns

`uncached`, `cached`, and `write` are three **disjoint** buckets, priced
differently, and they are named the way the two vendors bill them:

| Column | API field | Rate |
| --- | --- | --- |
| `uncached` | `input_tokens` | 1× base |
| `cached` | `cache_read_input_tokens` | 0.1× base |
| `write` | `cache_creation_input_tokens` | 1.25× (5m) / 2× (1h) |
| `out` | `output_tokens` | ~5× base |

`input_tokens` is only the uncached remainder, not the whole prompt — which is
why a well-cached Opus turn reads `uncached 81 / cached 21.7M`. Fireworks bills
"cached prompt tokens" against "uncached tokens" and has no separate write price,
so `write` reads 0 on Fireworks models.

## Tests

`test/harnesses/claude/usage/` mirrors this folder. `modules.test.mjs` guards the
structure itself: the layering stays acyclic, the renderers stay pure, cost has
one call site, and each module stays inside a line budget.
