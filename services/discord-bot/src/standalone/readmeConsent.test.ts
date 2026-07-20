import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('standalone Discord voice consent documentation', () => {
  /**
   * @example
   * it('documents the implemented participant consent lifecycle for N-002', async () => {})
   */
  it('documents the implemented participant consent lifecycle for N-002', async () => {
    const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8')

    // ROOT CAUSE:
    //
    // The README still described the pre-D-007 behavior where `/summon` relied
    // on off-platform agreement. Production now publishes provider disclosure,
    // requires session-scoped participant opt-in, and supports withdrawal before
    // or during capture, so the public safety contract contradicted the runtime.
    //
    // The documentation must name each lifecycle boundary and retain the raw
    // Qwen/text-filter limitation instead of replacing the warning with a vague
    // claim that voice is "consented".
    // @example
    expect(readme).not.toContain('still does not record consent from each participant')
    // @example
    expect(readme).toContain('Every current participant must opt in before AIRI joins')
    // @example
    expect(readme).toContain('New participants are not opted in automatically')
    // @example
    expect(readme).toContain('Withdraw consent')
    // @example
    expect(readme).toContain('Explicit withdrawal immediately marks the session pending and invalidates the active channel generation in both modes')
    // @example
    expect(readme).toContain('On a normal participant leave, Qwen commits any already-admitted trailing input before releasing that speaker\'s capture')
    // @example
    expect(readme).toContain('classic mode cancels that departing speaker\'s pending debounced turn and releases its capture')
    // @example
    expect(readme).toContain('Qwen invalidates the channel generation on withdrawal, move, or policy revocation')
    // @example
    expect(readme).toContain('raw Realtime audio cannot pass through text content filters')
  })
})
