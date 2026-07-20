/** Default exact-session envelope capacity, including the active envelope. */
const DEFAULT_MAX_PENDING_PER_SESSION = 8

/** Default process envelope capacity across active and queued exact sessions. */
const DEFAULT_MAX_PENDING_TOTAL = 64

function normalizeCapacity(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value))
    return fallback

  const normalized = Math.trunc(value ?? fallback)
  return normalized >= 1 ? normalized : fallback
}

/** Policy for Discord admission work that must precede rate/provider side effects. */
export interface DiscordIngressSchedulerOptions {
  /** Maximum active and queued envelopes retained for one exact session. @default 8 */
  maxPendingPerSession?: number
  /** Maximum active and queued envelopes retained across the adapter. @default 64 */
  maxPendingTotal?: number
}

/** Immediate admission result for one exact-session Discord envelope. */
export type DiscordIngressScheduleResult<T>
  = | { accepted: true, task: Promise<T> }
    | { accepted: false, reason: 'global-capacity' | 'session-capacity' }

/**
 * Serializes Discord admission envelopes per exact session under hard bounds.
 *
 * Use when:
 * - Mention, DM, and authoritative reply lookup must preserve gateway order.
 * - Unrelated exact sessions must continue independently.
 *
 * Expects:
 * - The caller supplies the canonical guild/channel/user or DM/user session id.
 * - Lifecycle cancellation is owned by the scheduled operation.
 *
 * Returns:
 * - Immediate bounded admission plus a task that preserves operation failures.
 */
export class DiscordIngressScheduler {
  private readonly maxPendingPerSession: number
  private readonly maxPendingTotal: number
  private readonly pendingBySessionId = new Map<string, number>()
  private readonly tailsBySessionId = new Map<string, Promise<void>>()
  private totalPending = 0

  constructor(options: DiscordIngressSchedulerOptions = {}) {
    this.maxPendingPerSession = normalizeCapacity(options.maxPendingPerSession, DEFAULT_MAX_PENDING_PER_SESSION)
    this.maxPendingTotal = normalizeCapacity(options.maxPendingTotal, DEFAULT_MAX_PENDING_TOTAL)
  }

  /** Number of active and queued admission envelopes retained by this scheduler. */
  get pendingCount(): number {
    return this.totalPending
  }

  /**
   * Enqueues one operation behind earlier envelopes from the same exact session.
   *
   * Use when:
   * - Static policy has accepted the envelope without consuming rate quota.
   *
   * Expects:
   * - `operation` observes its adapter lifecycle signal and releases promptly on stop.
   *
   * Returns:
   * - A capacity rejection, or a task running FIFO within the session.
   */
  schedule<T>(sessionId: string, operation: () => Promise<T> | T): DiscordIngressScheduleResult<T> {
    const sessionPending = this.pendingBySessionId.get(sessionId) ?? 0
    if (sessionPending >= this.maxPendingPerSession)
      return { accepted: false, reason: 'session-capacity' }
    if (this.totalPending >= this.maxPendingTotal)
      return { accepted: false, reason: 'global-capacity' }

    this.totalPending += 1
    this.pendingBySessionId.set(sessionId, sessionPending + 1)
    const previousTail = this.tailsBySessionId.get(sessionId) ?? Promise.resolve()
    const operationTask = previousTail
      .catch(() => undefined)
      .then(operation)
    let tail: Promise<void>
    const task = operationTask.then(
      (value) => {
        this.release(sessionId, tail)
        return value
      },
      (error) => {
        this.release(sessionId, tail)
        throw error
      },
    )
    tail = task.then(
      () => undefined,
      () => undefined,
    )
    this.tailsBySessionId.set(sessionId, tail)
    return { accepted: true, task }
  }

  /** Waits for the currently retained envelope tails without admitting new ownership. */
  drain(): Promise<void> {
    return Promise.all(this.tailsBySessionId.values()).then(() => undefined)
  }

  private release(sessionId: string, tail: Promise<void>): void {
    this.totalPending = Math.max(0, this.totalPending - 1)
    const remaining = Math.max(0, (this.pendingBySessionId.get(sessionId) ?? 1) - 1)
    if (remaining === 0)
      this.pendingBySessionId.delete(sessionId)
    else
      this.pendingBySessionId.set(sessionId, remaining)
    if (this.tailsBySessionId.get(sessionId) === tail)
      this.tailsBySessionId.delete(sessionId)
  }
}
