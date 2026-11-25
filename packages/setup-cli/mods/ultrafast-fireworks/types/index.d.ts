/** One play of the banner. */
export type Run = {
  /** Clock time the banner started, ms since the epoch. */
  startedAt: number
  /** Redraws asked per second. */
  fps: number
  /** Rows asked for, sky included; the band's maxRows caps it. */
  rows: number
  /** The account flag behind the subtitle (reason, expiresAt), or a demo one. */
  status: { reason: string; expiresAt: number | null }
}

declare module 'claude-code' {
  interface PluginState {
    'nexus-ultrafast': { run: Shaped<Run | null>; tick: number; played: string }
  }
}
