export type SessionState = { playedKey: string, pendingKey: string, saveDue: boolean, conversationId: string }
export type BoostRecord = { active: boolean, activatedAt: number | null, expiresAt: number | null, updatedAt: number }
export function newSession(): SessionState
export function afterBoostCheck(
  session: SessionState,
  check: { status: { active: boolean, activatedAt?: number | null, expiresAt?: number | null, reason?: string }, entrypoint: unknown, model: unknown, now: number, fetchedAt?: number, demoRunning?: boolean },
): { record: BoostRecord, play: { reason?: string, expiresAt?: number | null } | null, key: string }
export const MODEL_READ_TIMEOUT_MS: number
export function sessionModel(read: () => unknown, options?: { timeoutMs?: number, after?: (ms: number, fn: () => void) => { cancel?(): void } | undefined, outcome?: { why?: string } }): Promise<string>
export function confirmAutoModel(readModel: () => Promise<{ model: string, why: string }>): Promise<boolean>
export function modelStatsLine(model: unknown, why?: unknown): string
export function stopForModel(input: { playing: boolean, demo: boolean, model: unknown, why: unknown }): boolean
export function startPlay(session: SessionState, key: string, demo: boolean): void
export function abandonPlay(session: SessionState): void
export function frameDrawn(session: SessionState, demo: boolean): boolean
export function sessionEnded(session: SessionState, reason: unknown): boolean
export function takeSave(session: SessionState): string | null
export function conversationSeen(session: SessionState, id: unknown): boolean
export function nextCheck<S extends { active: boolean }>(input: {
  now: number
  lastCheck: number
  interval: number
  keyPrint: string
  last: { status: S, fetchedAt: number, keyPrint: string } | null
}): { fetch: boolean, status: S | null, fetchedAt: number }
export function saveFailed(session: SessionState): void
export function loadMarker(session: SessionState, stored: unknown): void
