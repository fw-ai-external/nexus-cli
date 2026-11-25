# Ultra-fast in Codex's footer

A stdio MCP server that Codex runs as its custom status line provider (Codex's
experimental `features.tui_extensions_statusline`). `nexus codex on` registers
it on Codex 0.171.0 or newer; `nexus codex off` removes it
(`lib/harnesses/codex/ultrafast-patch.mjs`).

```
example-model high · ~/acme-api                         ϟ Ultra-fast on
                                                             5h 00m left
```

While a boost is on, it also rewrites the Nexus pet's `pet.json`, so the next
pet load shows a tile that fills with magenta when Codex starts and drains as
the boost runs out. Without a boost the pet is the usual dotted Fireworks logo.

## What it does

- **Footer.** Codex reads the server's `ui://fireworks-nexus/ultrafast`
  resource about once a second and paints the UI tree it returns. Codex turns
  the status line off for the session after one failed or slow (over 1 s)
  read, so a read only formats values already in memory.
  The footer is always two rows (the second is blank without a boost):
  Codex anchors the pet's 5-row box to the footer's bottom, so a constant
  height keeps the box's top three rows over the prompt box, where the pet
  frames are drawn.
- **Boost check.** Every two minutes, with the Fireworks key `nexus codex on`
  wrote into Codex's config (the `x-fireworks-api-key` header on
  `[model_providers.fireworks-ai]`), through the same check the Claude Code
  mod uses (`../ultrafast-fireworks/hooks/rewards.mjs`). Requests go only to
  the Fireworks API, with a deadline; no answer keeps what was last shown.
  The last status is cached in the pet folder for a day, so a new session
  shows a running boost right away.
- **Pet.** The tile frames live in Nexus's pet sheet, beside the logo
  (`scripts/render-codex-ultrafast-pet.mjs` paints them). Codex reads
  `pet.json` only when the pet loads (launch or `/pet`), and restarts the
  pet's animation on every state change, so the fill level is the one at
  launch.
  `nexus codex on` reinstalls the plain `pet.json`, so during a boost it
  writes the boost pet right away from this cache (same key only), and the
  next Codex shows the tile.
- **Account switches.** `nexus login` writes a new key into Codex's config and
  checks the new account's boost at once (3 s cap), caching it and setting the
  pet, so the next Codex is right even if it was closed. A running server
  notices the new key within 3 s (it watches the config's modification time)
  and checks right away; a cache or pet from another key is never reused.
- **Width.** Codex doesn't tell a status line provider how wide the terminal
  is, so the server finds the terminal the `codex` process runs in (`ps`, then
  `lsof` to pick among several by working folder, then `stty size`), on a
  timer with short timeouts. Without it, the badge follows the folder.

## Switches

| Variable | Effect |
| --- | --- |
| `NEXUS_CODEX_ULTRAFAST=0` | `nexus codex on` leaves the footer out. |
| `NEXUS_ULTRAFAST_STATUS=0` | No boost check (model and folder only). |
| `NEXUS_CODEX_ULTRAFAST_WIDTH=0` | No terminal width check. |
| `NEXUS_ULTRAFAST_MOCK_URL` | A loopback stand-in for the status API (`node scripts/mock-nexus-rewards.mjs`); a placeholder key is sent, never yours. |

Codex passes these through to the server (`env_vars` in its MCP table) along
with its usual environment; the Fireworks key never goes through the
environment.

## Files

| File | What it holds |
| --- | --- |
| `statusline-server.mjs` | The entry point Codex runs: wires the real clock, network, files and probe into the server. |
| `server.mjs` | The MCP server, with every side effect injected (tests run it in-process). |
| `http.mjs` | The `fetch` adapter for the boost check: a deadline, no redirects, a capped body. Shared with `nexus login`. |
| `files.mjs` | Bounded reads of small regular files, and all-at-once writes that never follow a symlink at the temp path. |
| `ultrafast.mjs` | Pure logic: the footer's UI tree, the pet manifest, boost records. |

Tests: `test/mods/codex-ultrafast.test.mjs` and
`test/harnesses/codex/codex-ultrafast.test.mjs`.
