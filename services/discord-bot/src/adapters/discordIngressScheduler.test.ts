import type { DiscordIngressSchedulerOptions } from './discordIngressScheduler'

import { describe, expect, it } from 'vitest'

import { DiscordIngressScheduler } from './discordIngressScheduler'

function deferred(): { promise: Promise<void>, resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/**
 * @example
 * describe('Discord ingress envelope scheduler', () => {})
 */
describe('discord ingress envelope scheduler', () => {
  /**
   * ROOT CAUSE:
   *
   * CSR-07 counted only exact sessions, so one Discord user could fill every
   * active slot through many sessions. Retained admission and active dispatch
   * must instead be bounded separately by stable principal.
   *
   * @example
   * it('processes a valid principal burst while another principal makes fair progress for CSR-07', async () => {})
   */
  it('processes a valid principal burst while another principal makes fair progress for CSR-07', async () => {
    const scheduler = new DiscordIngressScheduler({
      maxActivePerPrincipal: 2,
      maxActiveTotal: 4,
      maxPendingPerPrincipal: 16,
      maxPendingPerSession: 1,
      maxPendingTotal: 20,
    })
    const held = deferred()
    const executionOrder: string[] = []
    let attackerActive = 0
    let maxAttackerActive = 0
    const attacker = Array.from({ length: 12 }, (_, index) => scheduler.schedule(
      'discord-user-attacker',
      `attacker-session-${index}`,
      async () => {
        attackerActive += 1
        maxAttackerActive = Math.max(maxAttackerActive, attackerActive)
        executionOrder.push(`attacker-${index}`)
        await held.promise
        attackerActive -= 1
      },
    ))
    const victim = scheduler.schedule('discord-user-victim', 'victim-session', async () => {
      executionOrder.push('victim')
    })

    await Promise.resolve()
    /** @example expect(attacker.every(result => result.accepted)).toBe(true) */
    expect(attacker.every(result => result.accepted)).toBe(true)
    /** @example expect(victim.accepted).toBe(true) */
    expect(victim.accepted).toBe(true)
    /** @example expect(maxAttackerActive).toBe(2) */
    expect(maxAttackerActive).toBe(2)
    /** @example expect(executionOrder).toContain('victim') */
    expect(executionOrder).toContain('victim')

    held.resolve()
    await Promise.all(attacker.map(result => result.accepted ? result.task : Promise.resolve()))
    if (victim.accepted)
      await victim.task
    /** @example expect(executionOrder.filter(entry => entry.startsWith('attacker-'))).toHaveLength(12) */
    expect(executionOrder.filter(entry => entry.startsWith('attacker-'))).toHaveLength(12)
    /** @example expect(executionOrder.indexOf('victim')).toBeLessThan(executionOrder.indexOf('attacker-11')) */
    expect(executionOrder.indexOf('victim')).toBeLessThan(executionOrder.indexOf('attacker-11'))
    /** @example expect(scheduler.pendingCount).toBe(0) */
    expect(scheduler.pendingCount).toBe(0)
  })

  /**
   * @example
   * it('preserves FIFO ordering within an exact session', async () => {})
   */
  it('preserves FIFO ordering within an exact session', async () => {
    const scheduler = new DiscordIngressScheduler()
    const order: number[] = []
    const scheduled = Array.from({ length: 8 }, (_, index) => scheduler.schedule('principal-a', 'session-a', async () => {
      order.push(index)
    }))

    await Promise.all(scheduled.map(result => result.accepted ? result.task : Promise.resolve()))
    /** @example expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]) */
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  /**
   * @example
   * it('rejects every malformed or inconsistent capacity deterministically', () => {})
   */
  it('rejects every malformed or inconsistent capacity deterministically', () => {
    const optionNames: Array<keyof DiscordIngressSchedulerOptions> = [
      'maxActivePerPrincipal',
      'maxActiveTotal',
      'maxPendingPerPrincipal',
      'maxPendingPerSession',
      'maxPendingTotal',
    ]
    const malformed = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 0.5, 1.5]

    for (const optionName of optionNames) {
      for (const value of malformed) {
        /** @example expect(() => new DiscordIngressScheduler({ maxPendingTotal: Number.NaN })).toThrow(RangeError) */
        expect(() => new DiscordIngressScheduler({ [optionName]: value })).toThrow(RangeError)
      }
    }
    /** @example expect(() => new DiscordIngressScheduler({ maxActivePerPrincipal: 4, maxActiveTotal: 4 })).toThrow(RangeError) */
    expect(() => new DiscordIngressScheduler({ maxActivePerPrincipal: 4, maxActiveTotal: 4 })).toThrow(RangeError)
    /** @example expect(() => new DiscordIngressScheduler({ maxPendingPerPrincipal: 4, maxPendingTotal: 4 })).toThrow(RangeError) */
    expect(() => new DiscordIngressScheduler({ maxPendingPerPrincipal: 4, maxPendingTotal: 4 })).toThrow(RangeError)
    /** @example expect(() => new DiscordIngressScheduler({ maxActivePerPrincipal: 3, maxPendingPerPrincipal: 2 })).toThrow(RangeError) */
    expect(() => new DiscordIngressScheduler({ maxActivePerPrincipal: 3, maxPendingPerPrincipal: 2 })).toThrow(RangeError)
    /** @example expect(() => new DiscordIngressScheduler({ maxActiveTotal: 5, maxPendingTotal: 4 })).toThrow(RangeError) */
    expect(() => new DiscordIngressScheduler({ maxActiveTotal: 5, maxPendingTotal: 4 })).toThrow(RangeError)
  })

  /**
   * @example
   * it('enforces the complete default 8/8/56/64/64 envelope and restores capacity', async () => {})
   */
  it('enforces the complete default 8/8/56/64/64 envelope and restores capacity', async () => {
    const scheduler = new DiscordIngressScheduler()
    const heldSession = deferred()
    const sameSession = Array.from({ length: 8 }, () => scheduler.schedule('session-principal', 'session-a', () => heldSession.promise))

    /** @example expect(sameSession.every(result => result.accepted)).toBe(true) */
    expect(sameSession.every(result => result.accepted)).toBe(true)
    /** @example expect(scheduler.schedule('session-principal', 'session-a', () => heldSession.promise)).toEqual({ accepted: false, reason: 'session-capacity' }) */
    expect(scheduler.schedule('session-principal', 'session-a', () => heldSession.promise)).toEqual({
      accepted: false,
      reason: 'session-capacity',
    })
    heldSession.resolve()
    await Promise.all(sameSession.map(result => result.accepted ? result.task : Promise.resolve()))

    const heldPrincipal = deferred()
    let activeForPrincipal = 0
    let maxActiveForPrincipal = 0
    const samePrincipal = Array.from({ length: 56 }, (_, index) => scheduler.schedule('principal-a', `principal-session-${index}`, async () => {
      activeForPrincipal += 1
      maxActiveForPrincipal = Math.max(maxActiveForPrincipal, activeForPrincipal)
      await heldPrincipal.promise
      activeForPrincipal -= 1
    }))
    await Promise.resolve()
    /** @example expect(samePrincipal.every(result => result.accepted)).toBe(true) */
    expect(samePrincipal.every(result => result.accepted)).toBe(true)
    /** @example expect(maxActiveForPrincipal).toBe(8) */
    expect(maxActiveForPrincipal).toBe(8)
    /** @example expect(scheduler.schedule('principal-a', 'principal-overflow', () => heldPrincipal.promise)).toEqual({ accepted: false, reason: 'principal-capacity' }) */
    expect(scheduler.schedule('principal-a', 'principal-overflow', () => heldPrincipal.promise)).toEqual({
      accepted: false,
      reason: 'principal-capacity',
    })
    heldPrincipal.resolve()
    await Promise.all(samePrincipal.map(result => result.accepted ? result.task : Promise.resolve()))

    const heldGlobal = deferred()
    let activeTotal = 0
    let maxActiveTotal = 0
    const global = Array.from({ length: 64 }, (_, index) => scheduler.schedule(
      `global-principal-${Math.floor(index / 8)}`,
      `global-session-${index}`,
      async () => {
        activeTotal += 1
        maxActiveTotal = Math.max(maxActiveTotal, activeTotal)
        await heldGlobal.promise
        activeTotal -= 1
      },
    ))
    await Promise.resolve()
    /** @example expect(global.every(result => result.accepted)).toBe(true) */
    expect(global.every(result => result.accepted)).toBe(true)
    /** @example expect(maxActiveTotal).toBe(64) */
    expect(maxActiveTotal).toBe(64)
    /** @example expect(scheduler.pendingCount).toBe(64) */
    expect(scheduler.pendingCount).toBe(64)
    /** @example expect(scheduler.schedule('global-overflow', 'global-overflow', () => heldGlobal.promise)).toEqual({ accepted: false, reason: 'global-capacity' }) */
    expect(scheduler.schedule('global-overflow', 'global-overflow', () => heldGlobal.promise)).toEqual({
      accepted: false,
      reason: 'global-capacity',
    })
    heldGlobal.resolve()
    await Promise.all(global.map(result => result.accepted ? result.task : Promise.resolve()))
    /** @example expect(scheduler.pendingCount).toBe(0) */
    expect(scheduler.pendingCount).toBe(0)

    const recovered = scheduler.schedule('recovery-principal', 'recovery-session', async () => 'recovered')
    /** @example expect(recovered.accepted).toBe(true) */
    expect(recovered.accepted).toBe(true)
    if (recovered.accepted) {
      /** @example await expect(recovered.task).resolves.toBe('recovered') */
      await expect(recovered.task).resolves.toBe('recovered')
    }
  })

  /**
   * @example
   * it('rejects bounded overflow without reserving capacity', async () => {})
   */
  it('rejects bounded overflow without reserving capacity', async () => {
    const scheduler = new DiscordIngressScheduler({
      maxActivePerPrincipal: 1,
      maxActiveTotal: 2,
      maxPendingPerPrincipal: 2,
      maxPendingPerSession: 1,
      maxPendingTotal: 4,
    })
    const held = deferred()
    const attacker = [
      scheduler.schedule('principal-a', 'session-a1', () => held.promise),
      scheduler.schedule('principal-a', 'session-a2', () => held.promise),
    ]
    /** @example expect(scheduler.schedule('principal-a', 'session-a3', () => held.promise)).toEqual({ accepted: false, reason: 'principal-capacity' }) */
    expect(scheduler.schedule('principal-a', 'session-a3', () => held.promise)).toEqual({
      accepted: false,
      reason: 'principal-capacity',
    })
    const victim = [
      scheduler.schedule('principal-b', 'session-b1', () => held.promise),
      scheduler.schedule('principal-b', 'session-b2', () => held.promise),
    ]
    /** @example expect(scheduler.schedule('principal-c', 'session-c1', () => held.promise)).toEqual({ accepted: false, reason: 'global-capacity' }) */
    expect(scheduler.schedule('principal-c', 'session-c1', () => held.promise)).toEqual({
      accepted: false,
      reason: 'global-capacity',
    })
    /** @example expect(scheduler.pendingCount).toBe(4) */
    expect(scheduler.pendingCount).toBe(4)

    held.resolve()
    await Promise.all([...attacker, ...victim].map(result => result.accepted ? result.task : Promise.resolve()))
    /** @example expect(scheduler.pendingCount).toBe(0) */
    expect(scheduler.pendingCount).toBe(0)
  })

  /**
   * @example
   * it('releases accounting after success and handler failure', async () => {})
   */
  it('releases accounting after success and handler failure', async () => {
    const scheduler = new DiscordIngressScheduler({
      maxActivePerPrincipal: 1,
      maxActiveTotal: 2,
      maxPendingPerPrincipal: 2,
      maxPendingTotal: 4,
    })
    const successful = scheduler.schedule('principal-a', 'session-a', async () => 'completed')
    const failed = scheduler.schedule('principal-b', 'session-b', async () => {
      throw new Error('expected failure')
    })

    if (successful.accepted) {
      /** @example await expect(successful.task).resolves.toBe('completed') */
      await expect(successful.task).resolves.toBe('completed')
    }
    if (failed.accepted) {
      /** @example await expect(failed.task).rejects.toThrow('expected failure') */
      await expect(failed.task).rejects.toThrow('expected failure')
    }
    await scheduler.drain()
    /** @example expect(scheduler.pendingCount).toBe(0) */
    expect(scheduler.pendingCount).toBe(0)
  })

  /**
   * @example
   * it('releases active and queued accounting during cancellation and shutdown', async () => {})
   */
  it('releases active and queued accounting during cancellation and shutdown', async () => {
    const scheduler = new DiscordIngressScheduler({
      maxActivePerPrincipal: 1,
      maxActiveTotal: 2,
      maxPendingPerPrincipal: 3,
      maxPendingPerSession: 2,
      maxPendingTotal: 4,
    })
    const lifecycle = new AbortController()
    const untilAbort = () => new Promise<void>((resolve, reject) => {
      if (lifecycle.signal.aborted) {
        reject(lifecycle.signal.reason)
        return
      }
      lifecycle.signal.addEventListener('abort', () => reject(lifecycle.signal.reason), { once: true })
    })
    const active = scheduler.schedule('principal-a', 'session-a', untilAbort)
    const queued = scheduler.schedule('principal-a', 'session-a', untilAbort)

    lifecycle.abort(new Error('adapter stopped'))
    if (active.accepted) {
      /** @example await expect(active.task).rejects.toThrow('adapter stopped') */
      await expect(active.task).rejects.toThrow('adapter stopped')
    }
    if (queued.accepted) {
      /** @example await expect(queued.task).rejects.toThrow('adapter stopped') */
      await expect(queued.task).rejects.toThrow('adapter stopped')
    }
    await scheduler.drain()
    /** @example expect(scheduler.pendingCount).toBe(0) */
    expect(scheduler.pendingCount).toBe(0)
  })

  /**
   * @example
   * it('settles double-resolution attempts once without counter underflow', async () => {})
   */
  it('settles double-resolution attempts once without counter underflow', async () => {
    const scheduler = new DiscordIngressScheduler()
    const scheduled = scheduler.schedule('principal-a', 'session-a', () => new Promise<string>((resolve, reject) => {
      resolve('first')
      resolve('second')
      reject(new Error('late rejection'))
    }))

    if (scheduled.accepted) {
      /** @example await expect(scheduled.task).resolves.toBe('first') */
      await expect(scheduled.task).resolves.toBe('first')
      /** @example await expect(scheduled.task).resolves.toBe('first') */
      await expect(scheduled.task).resolves.toBe('first')
    }
    /** @example expect(scheduler.pendingCount).toBe(0) */
    expect(scheduler.pendingCount).toBe(0)
    const recovered = scheduler.schedule('principal-a', 'session-a', async () => 'recovered')
    /** @example expect(recovered.accepted).toBe(true) */
    expect(recovered.accepted).toBe(true)
    if (recovered.accepted) {
      /** @example await expect(recovered.task).resolves.toBe('recovered') */
      await expect(recovered.task).resolves.toBe('recovered')
    }
  })

  /**
   * @example
   * it('coalesces 1,024 concurrent drain callers', async () => {})
   */
  it('coalesces 1,024 concurrent drain callers', async () => {
    const scheduler = new DiscordIngressScheduler()
    const held = deferred()
    const scheduled = scheduler.schedule('principal-a', 'session-a', () => held.promise)
    const drains = Array.from({ length: 1_024 }, () => scheduler.drain())

    /** @example expect(new Set(drains)).toHaveLength(1) */
    expect(new Set(drains)).toHaveLength(1)
    held.resolve()
    if (scheduled.accepted)
      await scheduled.task
    await Promise.all(drains)
    /** @example expect(scheduler.pendingCount).toBe(0) */
    expect(scheduler.pendingCount).toBe(0)
  })
})
