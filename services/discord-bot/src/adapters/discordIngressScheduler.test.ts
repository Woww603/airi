import { describe, expect, it, vi } from 'vitest'

import { DiscordIngressScheduler } from './discordIngressScheduler'

/**
 * @example
 * describe('Discord ingress envelope scheduler', () => {})
 */
describe('discord ingress envelope scheduler', () => {
  /**
   * @example
   * it('falls back to finite hard bounds for invalid options for Discord audit D-023', async () => {})
   */
  it('falls back to finite hard bounds for invalid options for Discord audit D-023', async () => {
    const scheduler = new DiscordIngressScheduler({
      maxPendingPerSession: Number.NaN,
      maxPendingTotal: Number.POSITIVE_INFINITY,
    })
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    // ROOT CAUSE:
    //
    // Math.max(1, NaN) remains NaN and Infinity remains Infinity. Public invalid
    // capacity options therefore disabled both comparisons and made retained
    // envelope ownership unbounded instead of falling back to safe defaults.
    const sameSession = Array.from({ length: 8 }, () => scheduler.schedule('session-a', () => held))
    /** @example expect(sameSession.every(result => result.accepted)).toBe(true) */
    expect(sameSession.every(result => result.accepted)).toBe(true)
    /** @example expect(scheduler.schedule('session-a', async () => {})).toEqual({ accepted: false, reason: 'session-capacity' }) */
    expect(scheduler.schedule('session-a', async () => {})).toEqual({
      accepted: false,
      reason: 'session-capacity',
    })

    release()
    await Promise.all(sameSession.map(result => result.accepted ? result.task : Promise.resolve()))

    let releaseGlobal = () => {}
    const heldGlobal = new Promise<void>((resolve) => {
      releaseGlobal = resolve
    })
    const global = Array.from({ length: 64 }, (_, index) => scheduler.schedule(`global-${index}`, () => heldGlobal))
    /** @example expect(global.every(result => result.accepted)).toBe(true) */
    expect(global.every(result => result.accepted)).toBe(true)
    /** @example expect(scheduler.schedule('global-overflow', async () => {})).toEqual({ accepted: false, reason: 'global-capacity' }) */
    expect(scheduler.schedule('global-overflow', async () => {})).toEqual({
      accepted: false,
      reason: 'global-capacity',
    })

    releaseGlobal()
    await Promise.all(global.map(result => result.accepted ? result.task : Promise.resolve()))
    /** @example expect(scheduler.pendingCount).toBe(0) */
    expect(scheduler.pendingCount).toBe(0)
  })

  /**
   * @example
   * it('bounds global envelopes and restores capacity for Discord audit D-023', async () => {})
   */
  it('bounds global envelopes and restores capacity for Discord audit D-023', async () => {
    const scheduler = new DiscordIngressScheduler()
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const operations = Array.from({ length: 64 }, () => vi.fn(() => held))

    // ROOT CAUSE:
    //
    // Reference admission previously had no process-level envelope queue, so
    // high-cardinality sessions could each retain another deferred lookup. The
    // shared scheduler now includes active plus waiting work in a global hard
    // bound and releases each record only when its own task settles.
    const accepted = operations.map((operation, index) => scheduler.schedule(`session-${index}`, operation))
    await Promise.resolve()
    /** @example expect(accepted.every(result => result.accepted)).toBe(true) */
    expect(accepted.every(result => result.accepted)).toBe(true)
    /** @example expect(scheduler.pendingCount).toBe(64) */
    expect(scheduler.pendingCount).toBe(64)

    const denied = scheduler.schedule('session-overflow', async () => {})
    /** @example expect(denied).toEqual({ accepted: false, reason: 'global-capacity' }) */
    expect(denied).toEqual({ accepted: false, reason: 'global-capacity' })

    release()
    await Promise.all(accepted.map(result => result.accepted ? result.task : Promise.resolve()))
    /** @example expect(scheduler.pendingCount).toBe(0) */
    expect(scheduler.pendingCount).toBe(0)

    const recovery = scheduler.schedule('session-recovery', async () => 'recovered')
    /** @example expect(recovery.accepted).toBe(true) */
    expect(recovery.accepted).toBe(true)
    if (recovery.accepted)
      await expect(recovery.task).resolves.toBe('recovered')
    /** @example expect(scheduler.pendingCount).toBe(0) */
    expect(scheduler.pendingCount).toBe(0)
    await scheduler.drain()
  })
})
