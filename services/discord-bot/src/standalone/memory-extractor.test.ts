import type { Message } from '@xsai/shared-chat'

import { describe, expect, it, vi } from 'vitest'

import { createStandaloneMemoryExtractor } from './memory-extractor'

/**
 * @example
 * describe('standalone memory extractor', () => {})
 */
describe('standalone memory extractor', () => {
  /**
   * @example
   * it('extracts bounded source-grounded facts with model provenance', async () => {})
   */
  it('extracts bounded source-grounded facts with model provenance', async () => {
    const requests: Message[][] = []
    const extractor = createStandaloneMemoryExtractor({
      apiKey: 'test-key',
      model: 'test-memory-model',
      timeoutMs: 5000,
    }, async (input) => {
      requests.push(input.messages)
      return {
        text: JSON.stringify({
          facts: [{
            confidence: 0.97,
            evidence: '我最喜欢的饮料是茉莉茶',
            factKey: 'preference.favorite_drink',
            memoryClass: 'preference',
          }],
        }),
      }
    })

    const result = await extractor({
      abortSignal: new AbortController().signal,
      assistantText: '记住了。',
      turn: {
        channelId: 'channel-1',
        directMessage: false,
        displayName: 'User A',
        guildId: 'guild-1',
        messageId: 'message-1',
        sessionId: 'guild-1-channel-1-user-a',
        text: '我最喜欢的饮料是茉莉茶',
        userId: 'user-a',
      },
    })

    /**
     * @example
     * expect(result.model).toBe('test-memory-model')
     */
    expect(result.model).toBe('test-memory-model')
    expect(result.facts).toEqual([{
      confidence: 0.97,
      evidence: '我最喜欢的饮料是茉莉茶',
      factKey: 'preference.favorite_drink',
      memoryClass: 'preference',
    }])
    expect(requests).toHaveLength(1)
    expect(requests[0][0].role).toBe('system')
    expect(requests[0][0].content).toContain('exact contiguous substring')
    expect(requests[0][1].content).toContain('我最喜欢的饮料是茉莉茶')
    expect(requests[0][1].content).not.toContain('记住了')
  })

  /**
   * @example
   * it('rejects malformed fact shapes instead of trusting model JSON', async () => {})
   */
  it('rejects malformed fact shapes instead of trusting model JSON', async () => {
    const extractor = createStandaloneMemoryExtractor({
      apiKey: 'test-key',
      model: 'test-memory-model',
      timeoutMs: 5000,
    }, async () => ({
      text: JSON.stringify({
        facts: [
          { confidence: 2, evidence: '蓝色', factKey: 'preference.color', memoryClass: 'preference' },
          { confidence: 0.9, evidence: '红色', factKey: '../unsafe-key', memoryClass: 'preference' },
          { confidence: 0.9, evidence: '绿色', factKey: 'preference.color', memoryClass: 'unsupported' },
        ],
      }),
    }))

    const result = await extractor({
      abortSignal: new AbortController().signal,
      assistantText: '好的。',
      turn: {
        channelId: 'dm-channel',
        directMessage: true,
        displayName: 'User A',
        messageId: 'message-2',
        sessionId: 'dm-user-a',
        text: '蓝色 红色 绿色',
        userId: 'user-a',
      },
    })

    /**
     * @example
     * expect(result.facts).toEqual([])
     */
    expect(result.facts).toEqual([])
  })

  /**
   * @example
   * it('bounds ignored extraction aborts without blocking another participant for Discord audit D-018', async () => {})
   */
  it('bounds ignored extraction aborts without blocking another participant for Discord audit D-018', async () => {
    vi.useFakeTimers()
    const releaseProviderTasks: Array<() => void> = []
    let recoverUserA = false
    const generator = vi.fn(async (input: { messages: Message[] }) => {
      const content = String(input.messages[1]?.content ?? '')
      if (content.includes('user B') || recoverUserA)
        return { text: '{"facts":[]}' }
      return new Promise<{ text: string }>((resolve) => {
        releaseProviderTasks.push(() => resolve({ text: '{"facts":[]}' }))
      })
    })
    const extractor = createStandaloneMemoryExtractor({
      apiKey: 'test-key',
      model: 'test-memory-model',
      timeoutMs: 10,
    }, generator)
    const turn = (userId: string, text: string) => ({
      channelId: 'voice-channel',
      directMessage: false,
      displayName: userId,
      guildId: 'synthetic-guild',
      sessionId: `synthetic-guild-voice-channel-${userId}`,
      text,
      userId,
    })
    const firstOwner = new AbortController().signal
    const secondOwner = new AbortController().signal
    const startOwner = (owner: AbortSignal) => Array.from({ length: 4 }, () => extractor({
      abortSignal: owner,
      assistantText: 'synthetic reply',
      turn: turn('user-a', 'user A preference'),
    }).then(
      () => 'resolved',
      (error: unknown) => error instanceof Error ? error.name : 'rejected',
    ))
    const retained = [...startOwner(firstOwner), ...startOwner(secondOwner)]
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    const retainedOutcomes = await Promise.all(retained)

    const replacementExtractor = createStandaloneMemoryExtractor({
      apiKey: 'test-key',
      model: 'test-memory-model',
      timeoutMs: 10,
    }, generator)
    const deniedReplacement = replacementExtractor({
      abortSignal: new AbortController().signal,
      assistantText: 'synthetic reply',
      turn: turn('user-a', 'user A replacement'),
    }).then(
      () => 'resolved',
      (error: unknown) => error instanceof Error ? error.name : 'rejected',
    )
    await vi.advanceTimersByTimeAsync(0)

    const userB = extractor({
      abortSignal: new AbortController().signal,
      assistantText: 'synthetic reply',
      turn: turn('user-b', 'user B preference'),
    })
    await vi.advanceTimersByTimeAsync(0)

    // ROOT CAUSE:
    //
    // Extraction timeout raced only the wrapper promise, so a provider ignoring
    // AbortSignal disappeared from accounting. Repeated voice generations could
    // start unbounded raw tasks and globally deny unrelated users. The provider
    // boundary now retains exact raw tasks through real settlement, caps both
    // owner and principal replacements, and reserves process slots for user B.
    // @example
    expect(retainedOutcomes).toEqual(Array.from({ length: 8 }).fill('TimeoutError'))
    // @example
    await expect(deniedReplacement).resolves.toBe('StandaloneMemoryCapacityError')
    // @example
    await expect(userB).resolves.toEqual({ facts: [], model: 'test-memory-model' })
    // @example
    expect(generator).toHaveBeenCalledTimes(9)

    for (const release of releaseProviderTasks)
      release()
    await vi.advanceTimersByTimeAsync(0)
    recoverUserA = true
    // @example
    await expect(extractor({
      abortSignal: new AbortController().signal,
      assistantText: 'synthetic reply',
      turn: turn('user-a', 'user A recovered'),
    })).resolves.toEqual({ facts: [], model: 'test-memory-model' })
    // @example
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  /**
   * @example
   * it('does not start or publish extraction past the voice deadline for Discord audit D-018', async () => {})
   */
  it('does not start or publish extraction past the voice deadline for Discord audit D-018', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    let resolveProvider = (_result: { text: string }) => {}
    let providerSignal: AbortSignal | undefined
    const generator = vi.fn(async (input) => {
      providerSignal = input.abortSignal
      return new Promise<{ text: string }>((resolve) => {
        resolveProvider = resolve
      })
    })
    const extractor = createStandaloneMemoryExtractor({
      apiKey: 'test-key',
      model: 'test-memory-model',
      timeoutMs: 30_000,
    }, generator)
    const turn = {
      channelId: 'voice-channel',
      directMessage: false,
      displayName: 'Synthetic speaker',
      guildId: 'synthetic-guild',
      sessionId: 'synthetic-guild-voice-channel-synthetic-user',
      text: 'synthetic memory source',
      userId: 'synthetic-user',
    }

    const expired = extractor({
      abortSignal: new AbortController().signal,
      assistantText: 'synthetic reply',
      deadlineAt: 1_000,
      turn,
    })
    await expect(expired).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(generator).not.toHaveBeenCalled()

    const delayedStart = extractor({
      abortSignal: new AbortController().signal,
      assistantText: 'synthetic reply',
      deadlineAt: 1_001,
      turn,
    })
    vi.setSystemTime(1_002)
    await expect(delayedStart).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(generator).not.toHaveBeenCalled()

    vi.setSystemTime(2_000)
    const late = extractor({
      abortSignal: new AbortController().signal,
      assistantText: 'synthetic reply',
      deadlineAt: 2_001,
      turn,
    })
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(2_002)
    resolveProvider({ text: '{"facts":[]}' })

    // ROOT CAUSE:
    //
    // Automatic extraction minted a fresh phase timeout and discarded the
    // voice admission deadline. A delayed provider microtask could start after
    // expiry, and a provider result could publish after the original turn was
    // already invalid. The extractor now uses the earlier absolute deadline at
    // both provider-start and provider-publication boundaries.
    await expect(late).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(generator).toHaveBeenCalledTimes(1)
    expect(providerSignal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  /**
   * @example
   * it('sanitizes extraction provider failures for Discord audit D-018', async () => {})
   */
  it('sanitizes extraction provider failures for Discord audit D-018', async () => {
    const secretSentinel = 'SYNTHETIC_TOKEN=https://provider.invalid/private body=SYNTHETIC_PROMPT'
    const extractor = createStandaloneMemoryExtractor({
      apiKey: 'test-key',
      model: 'test-memory-model',
      timeoutMs: 30_000,
    }, async () => {
      throw new Error(secretSentinel)
    })
    const outcome = await extractor({
      abortSignal: new AbortController().signal,
      assistantText: 'synthetic reply',
      turn: {
        channelId: 'synthetic-dm',
        directMessage: true,
        displayName: 'Synthetic user',
        sessionId: 'synthetic-session',
        text: 'synthetic source',
        userId: 'synthetic-user',
      },
    }).catch((error: unknown) => error)

    // ROOT CAUSE:
    //
    // The extraction boundary rethrew provider-controlled Error.message and the
    // memory store logged it. Compatible providers can include endpoint URLs,
    // response bodies, echoed prompts, or credentials in that message.
    expect(outcome).toMatchObject({
      message: 'Standalone memory extraction provider failed.',
      name: 'StandaloneMemoryProviderError',
    })
    expect(JSON.stringify(outcome)).not.toContain(secretSentinel)
    if (!(outcome instanceof Error))
      throw new TypeError('Expected a sanitized memory provider error.')
    expect(outcome.message).not.toContain('provider.invalid')
  })

  /**
   * @example
   * it('sanitizes invalid provider output before exposing parser errors for Discord audit D-018', async () => {})
   */
  it('sanitizes invalid provider output before exposing parser errors for Discord audit D-018', async () => {
    const secretSentinel = 'SYNTHETIC_TOKEN=https://provider.invalid/private body=SYNTHETIC_TRANSCRIPT'
    const extractor = createStandaloneMemoryExtractor({
      apiKey: 'test-key',
      model: 'test-memory-model',
      timeoutMs: 30_000,
    }, async () => ({ text: secretSentinel }))

    const outcome = await extractor({
      abortSignal: new AbortController().signal,
      assistantText: 'synthetic reply',
      turn: {
        channelId: 'synthetic-dm',
        directMessage: true,
        displayName: 'Synthetic user',
        sessionId: 'synthetic-session',
        text: 'synthetic source',
        userId: 'synthetic-user',
      },
    }).catch((error: unknown) => error)

    // ROOT CAUSE:
    //
    // JSON parsing happened after the provider request sanitizer returned.
    // Node's SyntaxError can quote the provider-controlled response fragment,
    // exposing echoed transcripts, URLs, response bodies, or credentials to
    // any caller that observes the extractor failure.
    //
    // The extractor now classifies parse and response-shape failures at its
    // owning boundary without retaining the raw parser message or response.
    expect(outcome).toMatchObject({
      message: 'Standalone memory extraction provider returned an invalid response.',
      name: 'StandaloneMemoryProviderError',
    })
    if (!(outcome instanceof Error))
      throw new TypeError('Expected a sanitized memory provider error.')
    expect(outcome.message).not.toContain(secretSentinel)
    expect(outcome.message).not.toContain('provider.invalid')
  })
})
