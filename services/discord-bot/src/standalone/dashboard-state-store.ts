import type { StandaloneDashboardCounters } from './dashboard-state'

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const EMPTY_DASHBOARD_COUNTERS: StandaloneDashboardCounters = {
  acceptedMessages: 0,
  failedReplies: 0,
  rejectedMessages: 0,
  successfulReplies: 0,
}

/**
 * Options for the local dashboard counter store.
 */
export interface StandaloneDashboardCounterStoreOptions {
  /** Delay used to coalesce adjacent counter mutations. @default 250 */
  debounceMs?: number
  /** Absolute JSON state file path. */
  filePath: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCounter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function parseDashboardCounters(value: unknown): StandaloneDashboardCounters | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.counters))
    return undefined

  const counters = value.counters
  const acceptedMessages = parseCounter(counters.acceptedMessages)
  const failedReplies = parseCounter(counters.failedReplies)
  const rejectedMessages = parseCounter(counters.rejectedMessages)
  const successfulReplies = parseCounter(counters.successfulReplies)
  if (
    acceptedMessages === undefined
    || failedReplies === undefined
    || rejectedMessages === undefined
    || successfulReplies === undefined
  ) {
    return undefined
  }

  return { acceptedMessages, failedReplies, rejectedMessages, successfulReplies }
}

/**
 * Persists historical Dashboard counters with debounced atomic file replacement.
 *
 * Use when:
 * - The standalone App should keep totals across process restarts.
 * - Counter updates must not write a partially formed JSON file.
 *
 * Expects:
 * - One store instance owns `filePath` within the current process.
 *
 * Returns:
 * - Zeroed counters for missing or malformed state and flushable scheduled writes.
 */
export class StandaloneDashboardCounterStore {
  private readonly debounceMs: number
  private readonly filePath: string
  private pendingCounters: StandaloneDashboardCounters | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private writeQueue = Promise.resolve()

  constructor(options: StandaloneDashboardCounterStoreOptions) {
    this.debounceMs = Math.max(0, Math.trunc(options.debounceMs ?? 250))
    this.filePath = options.filePath
  }

  async load(): Promise<StandaloneDashboardCounters> {
    try {
      const parsed = parseDashboardCounters(JSON.parse(await readFile(this.filePath, 'utf8')))
      return parsed ?? { ...EMPTY_DASHBOARD_COUNTERS }
    }
    catch {
      return { ...EMPTY_DASHBOARD_COUNTERS }
    }
  }

  schedule(counters: StandaloneDashboardCounters): void {
    this.pendingCounters = { ...counters }
    if (this.timer)
      return

    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.debounceMs)
    this.timer.unref()
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }

    const counters = this.pendingCounters
    this.pendingCounters = undefined
    if (counters) {
      this.writeQueue = this.writeQueue.then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true })
        const temporaryPath = `${this.filePath}.tmp`
        await writeFile(temporaryPath, `${JSON.stringify({ counters, version: 1 }, null, 2)}\n`, { mode: 0o600 })
        await rename(temporaryPath, this.filePath)
      }).catch(() => {
        console.error('[discord-bot:standalone] failed to persist dashboard counters', {
          failureCategory: 'dashboard-counter-persistence-failure',
        })
      })
    }

    await this.writeQueue
  }
}
