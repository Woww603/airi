import { Worker } from 'node:worker_threads'

import { describe, expect, it, vi } from 'vitest'

import {
  createSafeDiscordTextPayload,
  deliverDiscordText,
  DiscordTextDeliveryError,
  resolveDiscordReplyReference,
  splitDiscordText,
  startDiscordTransport,
} from './discordSend'

/**
 * @example
 * describe('safe Discord output', () => {})
 */
describe('safe Discord output', () => {
  /**
   * @example
   * it('disables parsed mentions for model-generated text', () => {})
   */
  it('disables parsed mentions for model-generated text', () => {
    expect(createSafeDiscordTextPayload('@everyone ask <@123>')).toEqual({
      allowedMentions: { parse: [] },
      content: '@everyone ask <@123>',
    })
  })

  /**
   * @example
   * it('preserves exact graphemes at every Discord length boundary for Discord audit D-022', () => {})
   */
  it('preserves exact graphemes at every Discord length boundary for Discord audit D-022', () => {
    const family = '👨‍👩‍👧‍👦'
    const combined = 'a\u0301'
    const variation = '❤️'
    const boundaryText = `${'A'.repeat(1999)}${family}${combined}${variation}  \n tail `

    // ROOT CAUSE:
    //
    // Both adapters sliced raw UTF-16 at 2,000 and trimmed every remainder.
    // Surrogate pairs, combining sequences, variation selectors, ZWJ emoji, and
    // exact whitespace could therefore be broken or changed between messages.
    /** @example expect(splitDiscordText('')).toEqual([]) */
    expect(splitDiscordText('')).toEqual([])
    /** @example expect(splitDiscordText('A'.repeat(2000))).toEqual(['A'.repeat(2000)]) */
    expect(splitDiscordText('A'.repeat(2000))).toEqual(['A'.repeat(2000)])
    /** @example expect(splitDiscordText('A'.repeat(2001)).map(chunk => chunk.length)).toEqual([2000, 1]) */
    expect(splitDiscordText('A'.repeat(2001)).map(chunk => chunk.length)).toEqual([2000, 1])

    const chunks = splitDiscordText(boundaryText)
    /** @example expect(chunks.join('')).toBe(boundaryText) */
    expect(chunks.join('')).toBe(boundaryText)
    /** @example expect(chunks.every(chunk => chunk.length <= 2000)).toBe(true) */
    expect(chunks.every(chunk => chunk.length <= 2000)).toBe(true)
    /** @example expect(chunks.some(chunk => chunk.includes(family))).toBe(true) */
    expect(chunks.some(chunk => chunk.includes(family))).toBe(true)
    /** @example expect(chunks.some(chunk => chunk.includes(combined))).toBe(true) */
    expect(chunks.some(chunk => chunk.includes(combined))).toBe(true)
    /** @example expect(chunks.some(chunk => chunk.includes(variation))).toBe(true) */
    expect(chunks.some(chunk => chunk.includes(variation))).toBe(true)

    const longChunks = splitDiscordText('x'.repeat(6_001))
    /** @example expect(longChunks.map(chunk => chunk.length)).toEqual([2000, 2000, 2000, 1]) */
    expect(longChunks.map(chunk => chunk.length)).toEqual([2000, 2000, 2000, 1])
  })

  /**
   * @example
   * it('fails closed before sending an unsafe grapheme for Discord audit D-022', async () => {})
   */
  it('fails closed before sending an unsafe grapheme for Discord audit D-022', async () => {
    const send = vi.fn(async () => {})
    const oversizedGrapheme = `a${'\u0301'.repeat(2_000)}`

    // ROOT CAUSE:
    //
    // A single extended grapheme can itself exceed Discord's limit. Splitting it
    // would violate the Unicode contract, so chunk validation must finish before
    // the first external send and expose no model text in the structured error.
    /** @example await expect(deliverDiscordText(oversizedGrapheme, send)).rejects.toMatchObject({ kind: 'grapheme-too-long' }) */
    await expect(deliverDiscordText(oversizedGrapheme, send)).rejects.toMatchObject({
      kind: 'grapheme-too-long',
      name: 'DiscordTextChunkingError',
    })
    /** @example expect(send).not.toHaveBeenCalled() */
    expect(send).not.toHaveBeenCalled()
  })

  /**
   * @example
   * it('fails safely when the runtime has no Segmenter for Discord audit D-022', async () => {})
   */
  it('fails safely when the runtime has no Segmenter for Discord audit D-022', async () => {
    const moduleUrl = new URL('./discordSend.ts', import.meta.url).href
    const worker = new Worker(`
      const { parentPort } = require('node:worker_threads')
      delete Intl.Segmenter
      import(${JSON.stringify(moduleUrl)}).then(({ splitDiscordText }) => {
        try {
          splitDiscordText('synthetic text')
          parentPort.postMessage({ status: 'unexpected-success' })
        }
        catch (error) {
          parentPort.postMessage({ kind: error.kind, message: error.message, name: error.name })
        }
      }, error => parentPort.postMessage({ importError: error.message }))
    `, { eval: true })
    const outcome = await new Promise<Record<string, string>>((resolve, reject) => {
      worker.once('error', reject)
      worker.once('message', resolve)
    })

    // ROOT CAUSE:
    //
    // Falling back to code-unit slicing when Segmenter is absent recreates the
    // original corruption. A separate worker proves the runtime compatibility
    // branch without mutating built-ins shared by Vitest.
    /** @example expect(outcome).toEqual({ kind: 'segmenter-unavailable', name: 'DiscordTextChunkingError' }) */
    expect(outcome).toEqual({
      kind: 'segmenter-unavailable',
      message: 'Discord text delivery requires a grapheme segmenter.',
      name: 'DiscordTextChunkingError',
    })
    await worker.terminate()
  })

  /**
   * @example
   * it('reports sanitized partial delivery without retry for Discord audit D-022', async () => {})
   */
  it('reports sanitized partial delivery without retry for Discord audit D-022', async () => {
    const sends: string[] = []
    let active = true
    const send = vi.fn(async (payload: { content: string }) => {
      sends.push(payload.content)
      if (sends.length === 2)
        throw new Error('SYNTHETIC_SEND_PRIVATE_DETAIL')
    })

    // ROOT CAUSE:
    //
    // Adapter-local loops exposed no delivered/total state. Standalone also sent
    // a fallback after partial output, while bridge only logged a raw rejection.
    const outcome = await deliverDiscordText('A'.repeat(2_001), send).then(
      () => undefined,
      error => error,
    )
    /** @example expect(outcome).toBeInstanceOf(DiscordTextDeliveryError) */
    expect(outcome).toBeInstanceOf(DiscordTextDeliveryError)
    /** @example expect(outcome).toMatchObject({ deliveredChunks: 1, totalChunks: 2 }) */
    expect(outcome).toMatchObject({
      deliveredChunks: 1,
      message: 'Discord text delivery failed before every chunk was sent.',
      name: 'DiscordTextDeliveryError',
      totalChunks: 2,
    })
    /** @example expect(JSON.stringify(outcome)).not.toContain('PRIVATE_DETAIL') */
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE_DETAIL')
    /** @example expect(send).toHaveBeenCalledTimes(2) */
    expect(send).toHaveBeenCalledTimes(2)

    const cancelledSend = vi.fn(async () => {
      active = false
    })
    /** @example await expect(deliverDiscordText('B'.repeat(2001), cancelledSend, { isActive: () => active })).resolves.toMatchObject({ status: 'cancelled' }) */
    await expect(deliverDiscordText('B'.repeat(2_001), cancelledSend, {
      isActive: () => active,
    })).resolves.toEqual({
      deliveredChunks: 1,
      status: 'cancelled',
      totalChunks: 2,
    })
    /** @example expect(cancelledSend).toHaveBeenCalledOnce() */
    expect(cancelledSend).toHaveBeenCalledOnce()

    const emptySend = vi.fn()
    /** @example await expect(deliverDiscordText('', emptySend)).resolves.toEqual({ deliveredChunks: 0, status: 'delivered', totalChunks: 0 }) */
    await expect(deliverDiscordText('', emptySend)).resolves.toEqual({
      deliveredChunks: 0,
      status: 'delivered',
      totalChunks: 0,
    })
    /** @example expect(emptySend).not.toHaveBeenCalled() */
    expect(emptySend).not.toHaveBeenCalled()
  })

  /**
   * @example
   * it('reserves raw transport capacity across users for Discord audit D-022', async () => {})
   */
  it('reserves raw transport capacity across users for Discord audit D-022', async () => {
    const releases: Array<() => void> = []
    const retained = Array.from({ length: 4 }, () => startDiscordTransport(
      'discord-user-a',
      () => new Promise<void>((resolve) => {
        releases.push(resolve)
      }),
    ))
    await Promise.resolve()

    // ROOT CAUSE:
    //
    // Standalone awaited Discord.js sends directly. Since send has no AbortSignal,
    // one user could retain unbounded promises across channels and adapter stops.
    // A stable user principal now caps that user while reserved global capacity
    // lets an unrelated user continue.
    /** @example expect(retained.every(result => result.accepted)).toBe(true) */
    expect(retained.every(result => result.accepted)).toBe(true)
    const deniedSameUser = startDiscordTransport('discord-user-a', async () => {})
    /** @example expect(deniedSameUser).toMatchObject({ accepted: false, reason: 'capacity' }) */
    expect(deniedSameUser).toMatchObject({ accepted: false, reason: 'capacity' })

    const otherUser = startDiscordTransport('discord-user-b', async () => 'delivered')
    /** @example expect(otherUser.accepted).toBe(true) */
    expect(otherUser.accepted).toBe(true)
    if (otherUser.accepted)
      await expect(otherUser.task).resolves.toBe('delivered')

    for (const release of releases)
      release()
    await Promise.all(retained.map(result => result.accepted ? result.task : Promise.resolve()))
  })

  /**
   * @example
   * it('bounds authoritative reply reference fetches for Discord audit D-023', async () => {})
   */
  it('bounds authoritative reply reference fetches for Discord audit D-023', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const principalA = 'guild-a/channel-a/user-a'
    const principalB = 'guild-b/channel-b/user-b'
    const releases: Array<(authorId: string) => void> = []
    const fetchA = vi.fn(() => new Promise<string>((resolve) => {
      releases.push(resolve)
    }))
    const lookup = (principalKey: string, fetchReferencedAuthorId: () => Promise<string | undefined>) => resolveDiscordReplyReference({
      botUserId: 'bot-1',
      fetchReferencedAuthorId,
      principalKey,
      referencedMessageId: 'reference-1',
    })
    const retainedA = Array.from({ length: 4 }, () => lookup(principalA, fetchA))
    await vi.advanceTimersByTimeAsync(0)

    // ROOT CAUSE:
    //
    // Discord reference fetches cannot be aborted. A plain timeout race would let
    // one attacker retain unbounded raw fetches and exhaust unrelated reply ingress.
    const deniedA = lookup(principalA, fetchA)
    const userB = lookup(principalB, async () => 'bot-1')
    await vi.advanceTimersByTimeAsync(0)
    /** @example await expect(deniedA).resolves.toBe(false) */
    await expect(deniedA).resolves.toEqual({ matched: false, reason: 'capacity' })
    /** @example await expect(userB).resolves.toBe(true) */
    await expect(userB).resolves.toEqual({ matched: true, reason: 'matched' })
    /** @example expect(fetchA).toHaveBeenCalledTimes(4) */
    expect(fetchA).toHaveBeenCalledTimes(4)

    await vi.advanceTimersByTimeAsync(5_000)
    /** @example await expect(Promise.all(retainedA)).resolves.toEqual([false, false, false, false]) */
    await expect(Promise.all(retainedA)).resolves.toEqual([
      { matched: false, reason: 'timeout' },
      { matched: false, reason: 'timeout' },
      { matched: false, reason: 'timeout' },
      { matched: false, reason: 'timeout' },
    ])
    for (const release of releases)
      release('bot-1')
    await vi.advanceTimersByTimeAsync(0)
    /** @example expect(vi.getTimerCount()).toBe(0) */
    expect(vi.getTimerCount()).toBe(0)

    /** @example await expect(lookup(ownerA, async () => 'bot-1')).resolves.toBe(true) */
    await expect(lookup(principalA, async () => 'bot-1')).resolves.toEqual({ matched: true, reason: 'matched' })

    const globalReleases: Array<() => void> = []
    const globalFetch = vi.fn(() => new Promise<string>(() => {
      // Each raw task intentionally ignores local timeout; release closures are
      // assigned below through a second promise to keep actual settlement owned.
    }))
    const globallyRetained = Array.from({ length: 32 }, (_, index) => {
      let release = (_authorId: string) => {}
      const task = lookup(`discord-user-global-${index}`, () => new Promise<string>((resolve) => {
        release = resolve
      }))
      globalReleases.push(() => release('bot-1'))
      return task
    })
    await vi.advanceTimersByTimeAsync(0)
    const deniedGlobal = lookup('discord-user-global-overflow', globalFetch)
    /** @example await expect(deniedGlobal).resolves.toEqual({ matched: false, reason: 'capacity' }) */
    await expect(deniedGlobal).resolves.toEqual({ matched: false, reason: 'capacity' })
    /** @example expect(globalFetch).not.toHaveBeenCalled() */
    expect(globalFetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(Promise.all(globallyRetained)).resolves.toEqual(
      Array.from({ length: 32 }, () => ({ matched: false, reason: 'timeout' })),
    )
    for (const release of globalReleases)
      release()
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
  })

  /**
   * @example
   * it('fails closed for missing stale and rejected references for Discord audit D-023', async () => {})
   */
  it('fails closed for missing stale and rejected references for Discord audit D-023', async () => {
    const principalKey = 'guild/channel/user'
    /** @example await expect(isDiscordReplyToCurrentBot({ botUserId: 'bot-1', fetchReferencedAuthorId: async () => 'bot-1', owner })).resolves.toBe(false) */
    await expect(resolveDiscordReplyReference({
      botUserId: 'bot-1',
      fetchReferencedAuthorId: async () => 'bot-1',
      principalKey,
    })).resolves.toEqual({ matched: false, reason: 'missing-reference' })
    /** @example await expect(isDiscordReplyToCurrentBot({ botUserId: 'bot-1', fetchReferencedAuthorId: async () => undefined, owner, referencedMessageId: 'deleted' })).resolves.toBe(false) */
    await expect(resolveDiscordReplyReference({
      botUserId: 'bot-1',
      fetchReferencedAuthorId: async () => undefined,
      principalKey,
      referencedMessageId: 'deleted',
    })).resolves.toEqual({ matched: false, reason: 'referenced-message-missing' })
    /** @example await expect(isDiscordReplyToCurrentBot({ botUserId: 'bot-1', fetchReferencedAuthorId: async () => { throw new Error() }, owner, referencedMessageId: 'rejected' })).resolves.toBe(false) */
    await expect(resolveDiscordReplyReference({
      botUserId: 'bot-1',
      fetchReferencedAuthorId: async () => {
        throw new Error('SYNTHETIC_REFERENCE_PRIVATE_DETAIL')
      },
      principalKey,
      referencedMessageId: 'rejected',
    })).resolves.toEqual({ matched: false, reason: 'fetch-failure' })

    let active = true
    let release = (_authorId: string) => {}
    const stale = resolveDiscordReplyReference({
      botUserId: 'bot-1',
      fetchReferencedAuthorId: () => new Promise<string>((resolve) => {
        release = resolve
      }),
      isActive: () => active,
      principalKey,
      referencedMessageId: 'stale',
    })
    await Promise.resolve()
    active = false
    release('bot-1')
    /** @example await expect(stale).resolves.toBe(false) */
    await expect(stale).resolves.toEqual({ matched: false, reason: 'inactive-generation' })
  })
})
