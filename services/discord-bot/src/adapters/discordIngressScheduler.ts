/** Default retained envelope capacity for one exact session. */
const DEFAULT_MAX_PENDING_PER_SESSION = 8

/** Default concurrent operations owned by one stable Discord principal. */
const DEFAULT_MAX_ACTIVE_PER_PRINCIPAL = 8

/** Leaves one eight-operation share of the global retained bound for unrelated principals. */
const DEFAULT_MAX_PENDING_PER_PRINCIPAL = 56

/** Default concurrent operations across the adapter. */
const DEFAULT_MAX_ACTIVE_TOTAL = 64

/** Default retained envelope capacity across active operations and the fair backlog. */
const DEFAULT_MAX_PENDING_TOTAL = 64

/** Rejects malformed capacities instead of silently changing the configured policy. */
function resolveCapacity(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined)
    return fallback
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a finite positive integer`)
  return value
}

interface PendingIngressOperation {
  operation: () => Promise<unknown> | unknown
  principalId: string
  reject: (reason?: unknown) => void
  resolve: (value: unknown) => void
  sessionId: string
}

/** Policy for Discord admission work that must precede rate/provider side effects. */
export interface DiscordIngressSchedulerOptions {
  /** Maximum concurrently running operations for one stable Discord principal. @default 8 */
  maxActivePerPrincipal?: number
  /** Maximum concurrently running operations across the adapter. @default 64 */
  maxActiveTotal?: number
  /** Maximum active and queued envelopes retained for one stable Discord principal. @default 56 */
  maxPendingPerPrincipal?: number
  /** Maximum active and queued envelopes retained for one exact session. @default 8 */
  maxPendingPerSession?: number
  /** Maximum active and queued envelopes retained across the adapter. @default 64 */
  maxPendingTotal?: number
}

/** Immediate admission result for one exact-session Discord envelope. */
export type DiscordIngressScheduleResult<T>
  = | { accepted: true, task: Promise<T> }
    | { accepted: false, reason: 'global-capacity' | 'principal-capacity' | 'session-capacity' }

/**
 * Serializes exact-session Discord ingress while fairly sharing bounded active capacity.
 *
 * Use when:
 * - Mention, DM, and authoritative reply lookup must preserve gateway order.
 * - Valid excess work should wait without letting one principal monopolize execution.
 *
 * Expects:
 * - The caller supplies a stable principal id that identifies one Discord user across sessions.
 * - The caller supplies the canonical guild/channel/user or DM/user session id.
 * - Lifecycle cancellation is owned by the scheduled operation.
 *
 * Returns:
 * - Immediate bounded admission plus a task dispatched FIFO per session and fairly across principals.
 */
export class DiscordIngressScheduler {
  private readonly activeByPrincipalId = new Map<string, number>()
  private readonly activeSessionIds = new Set<string>()
  private readonly maxActivePerPrincipal: number
  private readonly maxActiveTotal: number
  private readonly maxPendingPerPrincipal: number
  private readonly maxPendingPerSession: number
  private readonly maxPendingTotal: number
  private readonly pendingByPrincipalId = new Map<string, number>()
  private readonly pendingBySessionId = new Map<string, number>()
  private readonly queuedByPrincipalId = new Map<string, PendingIngressOperation[]>()
  private readonly readyPrincipalIds: string[] = []
  private activeTotal = 0
  private drainTask: Promise<void> | undefined
  private resolveDrainTask: (() => void) | undefined
  private totalPending = 0

  constructor(options: DiscordIngressSchedulerOptions = {}) {
    this.maxActivePerPrincipal = resolveCapacity('maxActivePerPrincipal', options.maxActivePerPrincipal, DEFAULT_MAX_ACTIVE_PER_PRINCIPAL)
    this.maxActiveTotal = resolveCapacity('maxActiveTotal', options.maxActiveTotal, DEFAULT_MAX_ACTIVE_TOTAL)
    this.maxPendingPerPrincipal = resolveCapacity('maxPendingPerPrincipal', options.maxPendingPerPrincipal, DEFAULT_MAX_PENDING_PER_PRINCIPAL)
    this.maxPendingPerSession = resolveCapacity('maxPendingPerSession', options.maxPendingPerSession, DEFAULT_MAX_PENDING_PER_SESSION)
    this.maxPendingTotal = resolveCapacity('maxPendingTotal', options.maxPendingTotal, DEFAULT_MAX_PENDING_TOTAL)

    if (this.maxActivePerPrincipal >= this.maxActiveTotal)
      throw new RangeError('maxActivePerPrincipal must be lower than maxActiveTotal')
    if (this.maxPendingPerPrincipal >= this.maxPendingTotal)
      throw new RangeError('maxPendingPerPrincipal must be lower than maxPendingTotal')
    if (this.maxActivePerPrincipal > this.maxPendingPerPrincipal)
      throw new RangeError('maxActivePerPrincipal must not exceed maxPendingPerPrincipal')
    if (this.maxActiveTotal > this.maxPendingTotal)
      throw new RangeError('maxActiveTotal must not exceed maxPendingTotal')
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
   * - `principalId` is stable across a user's guild and DM sessions.
   * - `operation` observes its adapter lifecycle signal and releases promptly on stop.
   *
   * Returns:
   * - A retained-capacity rejection, or a task dispatched within active capacity.
   */
  schedule<T>(principalId: string, sessionId: string, operation: () => Promise<T> | T): DiscordIngressScheduleResult<T> {
    const sessionPending = this.pendingBySessionId.get(sessionId) ?? 0
    if (sessionPending >= this.maxPendingPerSession)
      return { accepted: false, reason: 'session-capacity' }
    const principalPending = this.pendingByPrincipalId.get(principalId) ?? 0
    if (principalPending >= this.maxPendingPerPrincipal)
      return { accepted: false, reason: 'principal-capacity' }
    if (this.totalPending >= this.maxPendingTotal)
      return { accepted: false, reason: 'global-capacity' }

    let resolveTask: (value: T | PromiseLike<T>) => void = () => {}
    let rejectTask: (reason?: unknown) => void = () => {}
    const task = new Promise<T>((resolve, reject) => {
      resolveTask = resolve
      rejectTask = reject
    })
    const queued: PendingIngressOperation = {
      operation,
      principalId,
      reject: rejectTask,
      resolve: resolveTask,
      sessionId,
    }

    this.totalPending += 1
    this.pendingByPrincipalId.set(principalId, principalPending + 1)
    this.pendingBySessionId.set(sessionId, sessionPending + 1)
    const principalQueue = this.queuedByPrincipalId.get(principalId)
    if (principalQueue) {
      principalQueue.push(queued)
    }
    else {
      this.queuedByPrincipalId.set(principalId, [queued])
      this.readyPrincipalIds.push(principalId)
    }
    this.dispatch()

    return { accepted: true, task }
  }

  /** Waits until all currently retained work has settled. */
  drain(): Promise<void> {
    if (this.totalPending === 0)
      return Promise.resolve()

    if (!this.drainTask) {
      this.drainTask = new Promise<void>((resolve) => {
        this.resolveDrainTask = resolve
      })
    }
    return this.drainTask
  }

  /** Dispatches one runnable operation per principal turn until active capacity is full. */
  private dispatch(): void {
    let consecutiveBlockedPrincipals = 0
    while (this.activeTotal < this.maxActiveTotal && this.readyPrincipalIds.length > 0) {
      const principalId = this.readyPrincipalIds.shift()
      if (!principalId)
        return

      const queue = this.queuedByPrincipalId.get(principalId)
      if (!queue || queue.length === 0) {
        this.queuedByPrincipalId.delete(principalId)
        continue
      }

      const activeForPrincipal = this.activeByPrincipalId.get(principalId) ?? 0
      const runnableIndex = activeForPrincipal < this.maxActivePerPrincipal
        ? queue.findIndex(item => !this.activeSessionIds.has(item.sessionId))
        : -1
      if (runnableIndex < 0) {
        this.readyPrincipalIds.push(principalId)
        consecutiveBlockedPrincipals += 1
        if (consecutiveBlockedPrincipals >= this.readyPrincipalIds.length)
          return
        continue
      }

      const [record] = queue.splice(runnableIndex, 1)
      if (!record)
        continue
      if (queue.length === 0)
        this.queuedByPrincipalId.delete(principalId)
      else
        this.readyPrincipalIds.push(principalId)
      consecutiveBlockedPrincipals = 0
      this.start(record)
    }
  }

  private start(record: PendingIngressOperation): void {
    this.activeTotal += 1
    this.activeByPrincipalId.set(record.principalId, (this.activeByPrincipalId.get(record.principalId) ?? 0) + 1)
    this.activeSessionIds.add(record.sessionId)

    Promise.resolve()
      .then(record.operation)
      .then(
        value => this.settle(record, { succeeded: true, value }),
        error => this.settle(record, { error, succeeded: false }),
      )
  }

  private settle(record: PendingIngressOperation, outcome: { succeeded: true, value: unknown } | { error: unknown, succeeded: false }): void {
    this.activeTotal -= 1
    const principalActive = (this.activeByPrincipalId.get(record.principalId) ?? 1) - 1
    if (principalActive === 0)
      this.activeByPrincipalId.delete(record.principalId)
    else
      this.activeByPrincipalId.set(record.principalId, principalActive)
    this.activeSessionIds.delete(record.sessionId)

    this.releasePending(record.principalId, record.sessionId)
    if ('value' in outcome)
      record.resolve(outcome.value)
    else
      record.reject(outcome.error)
    this.dispatch()
  }

  private releasePending(principalId: string, sessionId: string): void {
    this.totalPending -= 1
    const principalRemaining = (this.pendingByPrincipalId.get(principalId) ?? 1) - 1
    if (principalRemaining === 0)
      this.pendingByPrincipalId.delete(principalId)
    else
      this.pendingByPrincipalId.set(principalId, principalRemaining)
    const sessionRemaining = (this.pendingBySessionId.get(sessionId) ?? 1) - 1
    if (sessionRemaining === 0)
      this.pendingBySessionId.delete(sessionId)
    else
      this.pendingBySessionId.set(sessionId, sessionRemaining)

    if (this.totalPending !== 0)
      return
    this.resolveDrainTask?.()
    this.resolveDrainTask = undefined
    this.drainTask = undefined
  }
}
