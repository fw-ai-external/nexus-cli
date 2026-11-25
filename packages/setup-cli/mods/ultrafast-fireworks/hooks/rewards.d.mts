export type BoostStatus = {
  active: boolean
  activationId: string
  activatedAt: number | null
  expiresAt: number | null
  reason: string
}

export type BoostFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ status: number, ok: boolean, headers: Record<string, string>, text: string }>

export const FIREWORKS_GATEWAY_URL: string
export const POWERUP_SOURCE: string
export const MOCK_API_KEY: string
export const MAX_RESPONSE_CHARS: number
export const REQUEST_TIMEOUT_MS: number
export const INACTIVE: Readonly<BoostStatus>
export function fireworksKeyFromEnv(env: unknown): string
export function mockOrigin(value: unknown): string | null
export function sanitizeReason(value: unknown): string
export function runningWindow(
  response: unknown,
  now: number,
): { id: string, source: string, sourceId: string, start: number | null, serverStart: number | null, end: number | null } | null
export function windowRewardReason(
  response: unknown,
  window: { source: string, sourceId: string } | null,
): string
export function fetchBoostStatus(options: {
  fetch: BoostFetch
  key: string
  mockUrl?: unknown
  now: number
  outcome?: { text?: string, status?: number }
  cache?: { fingerprint?: string, accountId?: string }
  timeoutMs?: number
  after?: (ms: number, fn: () => void) => { cancel(): void }
}): Promise<BoostStatus | null>
export function keyFingerprint(key: string, mockUrl?: unknown): string
