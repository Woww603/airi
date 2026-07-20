import { describe, expect, it, vi } from 'vitest'

import { handlePing } from './ping'

/**
 * @example
 * describe('Discord ping command', () => {})
 */
describe('discord ping command', () => {
  /**
   * @example
   * it('replies exactly once with Pong', async () => {})
   */
  it('replies exactly once with Pong', async () => {
    const reply = vi.fn(async () => {})

    await Reflect.apply(handlePing, undefined, [{ reply }])

    expect(reply).toHaveBeenCalledOnce()
    expect(reply).toHaveBeenCalledWith('Pong!')
  })
})
