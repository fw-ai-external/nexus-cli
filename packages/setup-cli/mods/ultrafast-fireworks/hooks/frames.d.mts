export type Run = { text: string; tone: string | null; bold: boolean }

export const TITLE: string
export const BANNER_MS: number
export const ROWS: number
export const MAX_ROWS: number
export function bannerRows(maxRows: number, wanted?: number): number
export const COLORS: Readonly<Record<string, string | null>>
export function bannerFrame(opts: {
  elapsedMs: number
  columns: number
  rows?: number
  status?: { reason?: string; expiresAt?: number | null } | null
  now?: number
}): Run[][] | null
export const FLAG_MAX_AGE_MS: number
export function showsBanner(entrypoint: unknown): boolean
export function boostsModel(model: unknown): boolean
export function activationToPlay(
  cached: unknown,
  lastKey: unknown,
  now: number,
): { play: boolean; key: string; status: { reason?: string; expiresAt?: number | null } | null }
