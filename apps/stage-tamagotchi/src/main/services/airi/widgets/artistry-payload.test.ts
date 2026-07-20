import { describe, expect, it, vi } from 'vitest'

import { parseArtistryRecord, redactSensitiveArtistryText } from './artistry-payload'

/**
 * Keeps untrusted artistry payload contents out of persistent logs.
 *
 * @example
 * describe('parseArtistryRecord', () => {
 *   expect(warning).not.toContain('secret')
 * })
 */
describe('parseArtistryRecord', () => {
  /**
   * Reproduces the previous raw-input logging path for malformed JSON.
   *
   * @example
   * it('reports parse metadata without logging payload contents', () => {})
   */
  it('reports parse metadata without logging payload contents', () => {
    const warn = vi.fn()
    const secret = 'replicate-api-token-should-never-enter-logs'

    const result = parseArtistryRecord(`{"apiKey":"${secret}"`, {
      context: 'artistryGlobals',
      warn,
    })

    // ROOT CAUSE:
    //
    // The old robustParse catch block appended the first 100 characters of
    // malformed renderer input. Artistry globals commonly contain provider API
    // keys, so a single missing brace copied those credentials into disk logs.
    // @example
    expect(result).toEqual({})
    // @example
    expect(warn).toHaveBeenCalledOnce()
    // @example
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      context: 'artistryGlobals',
      inputBytes: expect.any(Number),
      reason: 'invalid-json',
    })
    // @example
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
  })

  /**
   * Keeps provider errors useful while removing configured credential values.
   *
   * @example
   * it('redacts known credential fields from provider error text', () => {})
   */
  it('redacts known credential fields from provider error text', () => {
    const secret = 'provider-secret-value'

    const redacted = redactSensitiveArtistryText(
      `Request rejected for Bearer ${secret}`,
      [{ replicateApiKey: secret, nested: { accessToken: 'nested-token-value' } }],
    )

    // @example
    expect(redacted).toBe('Request rejected for Bearer [redacted]')
    // @example
    expect(redacted).not.toContain(secret)
  })
})
