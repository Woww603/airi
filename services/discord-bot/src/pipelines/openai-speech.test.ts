import { Buffer } from 'node:buffer'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { synthesizeOpenAICompatible, transcribeOpenAICompatible } from './openai-speech'

const speechMocks = vi.hoisted(() => ({
  generateSpeech: vi.fn(),
  generateTranscription: vi.fn(),
}))

vi.mock('@xsai-ext/providers/create', () => ({
  createOpenAI: () => ({
    speech: () => ({ apiKey: 'redacted', model: 'synthetic-tts-model' }),
    transcription: () => ({ apiKey: 'redacted', model: 'synthetic-stt-model' }),
  }),
}))

vi.mock('@xsai/generate-speech', () => ({
  generateSpeech: speechMocks.generateSpeech,
}))

vi.mock('@xsai/generate-transcription', () => ({
  generateTranscription: speechMocks.generateTranscription,
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

/**
 * @example
 * describe('speech provider boundary for OpenAI-compatible endpoints', () => {})
 */
describe('speech provider boundary for OpenAI-compatible endpoints', () => {
  /**
   * @example
   * it('Discord audit D-030 requests the Opus format consumed by classic Discord voice', async () => {})
   */
  it('requests the Opus format consumed by classic Discord voice for Discord audit D-030', async () => {
    speechMocks.generateSpeech.mockResolvedValue(new ArrayBuffer(0))

    // ROOT CAUSE:
    //
    // The provider boundary requested MP3 while classic Discord playback
    // declared the resulting bytes arbitrary. Discord Voice therefore selected
    // its FFmpeg transcoding graph even though xsAI and Discord both expose a
    // direct Opus/Ogg Opus contract.
    await synthesizeOpenAICompatible(
      'SYNTHETIC_D030_TTS_TEXT',
      { apiKey: 'synthetic-key', model: 'synthetic-model', voice: 'synthetic-voice' },
    )

    // @example
    expect(speechMocks.generateSpeech).toHaveBeenCalledWith(expect.objectContaining({
      responseFormat: 'opus',
    }))
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by aborting a never-resolving STT fetch at its deadline', async () => {})
   */
  it('reproduces Discord audit D-018 by aborting a never-resolving STT fetch at its deadline', async () => {
    vi.useFakeTimers()
    let providerSignal: AbortSignal | undefined
    let resolveLateProvider = (_result: { text: string }) => {}
    const lateProvider = new Promise<{ text: string }>((resolve) => {
      resolveLateProvider = resolve
    })
    speechMocks.generateTranscription.mockImplementation(async (input: { abortSignal?: AbortSignal }) => {
      providerSignal = input.abortSignal
      return lateProvider
    })

    const request = transcribeOpenAICompatible(
      Buffer.from([1, 2, 3]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
    )
    const outcome = request.then(
      () => ({ kind: 'resolved', name: 'resolved' }),
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(30_000)

    // ROOT CAUSE:
    //
    // The OpenAI-compatible boundary passed AbortSignal through but owned no
    // deadline. A fetch that never resolved therefore survived until process exit.
    // @example
    await expect(outcome).resolves.toMatchObject({
      kind: 'timeout',
      name: 'SpeechProviderTimeoutError',
    })
    // @example
    expect(providerSignal?.aborted).toBe(true)
    resolveLateProvider({ text: 'discarded late transcription' })
    await vi.advanceTimersByTimeAsync(0)
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by rejecting cancelled TTS before ignored late bytes can escape', async () => {})
   */
  it('reproduces Discord audit D-018 by rejecting cancelled TTS before ignored late bytes can escape', async () => {
    vi.useFakeTimers()
    let resolveLate = (_audio: ArrayBuffer) => {}
    const lateAudio = new Promise<ArrayBuffer>((resolve) => {
      resolveLate = resolve
    })
    speechMocks.generateSpeech.mockImplementation(async () => lateAudio)
    const lifecycle = new AbortController()
    const request = synthesizeOpenAICompatible(
      'SYNTHETIC_TTS_SENTINEL',
      { apiKey: 'synthetic-key', model: 'synthetic-model', voice: 'synthetic-voice' },
      { abortSignal: lifecycle.signal },
    )
    const outcome = request.then(
      () => ({ kind: 'resolved', name: 'resolved' }),
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(0)
    lifecycle.abort(new Error('Synthetic Discord voice generation stopped.'))

    // ROOT CAUSE:
    //
    // Some compatible providers do not settle their promise when fetch is
    // aborted. The old caller remained attached and could hand late audio to a
    // replacement Discord player after stop/restart.
    // @example
    await expect(outcome).resolves.toMatchObject({
      kind: 'cancelled',
      name: 'SpeechProviderCancelledError',
    })

    resolveLate(new Uint8Array([9, 9, 9]).buffer)
    await vi.advanceTimersByTimeAsync(0)

    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('rechecks an absolute deadline at provider start for Discord audit D-018', async () => {})
   */
  it('rechecks an absolute deadline at provider start for Discord audit D-018', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    speechMocks.generateTranscription.mockResolvedValue({ text: 'must not start after deadline' })

    const request = transcribeOpenAICompatible(
      Buffer.from([1, 2, 3]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      { deadlineAt: 1_001 },
    )
    vi.setSystemTime(1_002)

    // ROOT CAUSE:
    //
    // The boundary checked the absolute deadline before scheduling provider
    // start, but not inside the start microtask. If synchronous work crossed the
    // deadline first, the provider still received stale audio before its timer
    // phase could abort. The start gate now rechecks wall-clock time atomically.
    // @example
    await expect(request).rejects.toMatchObject({
      kind: 'timeout',
      name: 'SpeechProviderTimeoutError',
    })
    // @example
    expect(speechMocks.generateTranscription).not.toHaveBeenCalled()
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('does not start a provider after synchronous lifecycle cancellation for Discord audit D-018', async () => {})
   */
  it('does not start a provider after synchronous lifecycle cancellation for Discord audit D-018', async () => {
    vi.useFakeTimers()
    const lifecycle = new AbortController()
    speechMocks.generateTranscription.mockResolvedValue({ text: 'must not start' })

    const request = transcribeOpenAICompatible(
      Buffer.from([1, 2, 3]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      { abortSignal: lifecycle.signal },
    )
    lifecycle.abort(new Error('synthetic generation stopped'))

    // ROOT CAUSE:
    //
    // Lifecycle cancellation was checked before listener registration but not
    // immediately after it or inside the provider-start microtask. An abort in
    // that gap could be missed and start a provider after stop/restart.
    await expect(request).rejects.toMatchObject({
      kind: 'cancelled',
      name: 'SpeechProviderCancelledError',
    })
    expect(speechMocks.generateTranscription).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('rechecks an absolute deadline before publishing provider output for Discord audit D-018', async () => {})
   */
  it('rechecks an absolute deadline before publishing provider output for Discord audit D-018', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    let providerSignal: AbortSignal | undefined
    let resolveProvider = (_result: { text: string }) => {}
    speechMocks.generateTranscription.mockImplementation(async (input: { abortSignal?: AbortSignal }) => {
      providerSignal = input.abortSignal
      return new Promise<{ text: string }>((resolve) => {
        resolveProvider = resolve
      })
    })

    const request = transcribeOpenAICompatible(
      Buffer.from([1, 2, 3]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      { deadlineAt: 1_001, ownerKey: 'synthetic-generation-1' },
    )
    await vi.advanceTimersByTimeAsync(0)
    // @example
    expect(speechMocks.generateTranscription).toHaveBeenCalledOnce()

    vi.setSystemTime(1_002)
    resolveProvider({ text: 'must not publish after deadline' })

    // ROOT CAUSE:
    //
    // A provider promise may resolve while JavaScript is synchronously blocked
    // past its deadline. Its continuation can run before the timer phase, so a
    // start-only check still published stale transcription into chat/playback.
    // Result publication now rechecks the same absolute deadline and aborts it.
    // @example
    await expect(request).rejects.toMatchObject({
      kind: 'timeout',
      name: 'SpeechProviderTimeoutError',
    })
    // @example
    expect(providerSignal?.aborted).toBe(true)

    speechMocks.generateTranscription.mockResolvedValueOnce({ text: 'registry recovered' })
    // @example
    await expect(transcribeOpenAICompatible(
      Buffer.from([4, 5, 6]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      { ownerKey: 'synthetic-generation-1' },
    )).resolves.toBe('registry recovered')
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('classifies a provider rejection after its absolute deadline for Discord audit D-018', async () => {})
   */
  it('classifies a provider rejection after its absolute deadline for Discord audit D-018', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    let providerSignal: AbortSignal | undefined
    let rejectProvider = (_error: Error) => {}
    speechMocks.generateTranscription.mockImplementation(async (input: { abortSignal?: AbortSignal }) => {
      providerSignal = input.abortSignal
      return new Promise<{ text: string }>((_resolve, reject) => {
        rejectProvider = reject
      })
    })

    const request = transcribeOpenAICompatible(
      Buffer.from([1, 2, 3]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      { deadlineAt: 1_001, ownerKey: 'synthetic-rejected-generation-1' },
    )
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(1_002)
    rejectProvider(new Error('synthetic raw provider detail must not escape'))

    // ROOT CAUSE:
    //
    // The rejection path categorized the provider error before checking the
    // absolute deadline. A late native rejection could therefore race the timer
    // and surface the wrong lifecycle result. Signal and deadline ownership now
    // take precedence over the sanitized provider-failure fallback.
    const outcome = await request.catch((error: unknown) => error)
    // @example
    expect(outcome).toMatchObject({
      kind: 'timeout',
      name: 'SpeechProviderTimeoutError',
    })
    // @example
    expect(outcome).not.toMatchObject({ message: expect.stringContaining('synthetic raw provider detail') })
    // @example
    expect(providerSignal?.aborted).toBe(true)

    speechMocks.generateTranscription.mockResolvedValueOnce({ text: 'rejected registry recovered' })
    // @example
    await expect(transcribeOpenAICompatible(
      Buffer.from([4, 5, 6]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      { ownerKey: 'synthetic-rejected-generation-1' },
    )).resolves.toBe('rejected registry recovered')
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by capping provider work that remains detached after timeout', async () => {})
   */
  it('reproduces Discord audit D-018 by capping provider work that remains detached after timeout', async () => {
    vi.useFakeTimers()
    const providerSignals: AbortSignal[] = []
    const releaseProviderTasks: Array<() => void> = []
    speechMocks.generateTranscription.mockImplementation(async (input: { abortSignal?: AbortSignal }) => {
      if (input.abortSignal)
        providerSignals.push(input.abortSignal)
      return new Promise<{ text: string }>((resolve) => {
        releaseProviderTasks.push(() => resolve({ text: 'discarded late text' }))
      })
    })
    const ownerARequests = Array.from({ length: 4 }, (_, index) => {
      return transcribeOpenAICompatible(
        Buffer.from([index]),
        { apiKey: 'synthetic-key', model: 'synthetic-model' },
        {
          deadlineAt: Date.now() + 10,
          ownerKey: 'guild-a:channel-a:generation-1:user-a',
          principalKey: 'user-a',
        },
      ).then(
        () => 'resolved',
        (error: unknown) => error instanceof Error ? error.name : 'rejected',
      )
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)

    // ROOT CAUSE:
    //
    // Promise.race released the visible Discord request but forgot the provider
    // promise when AbortSignal was ignored. Repeated timeouts could therefore
    // create unbounded live fetches. The provider boundary now retains active
    // tasks until their real settlement, applies a per-owner orphan cap, and
    // reserves global capacity for another speaker or replacement generation.
    // @example
    await expect(Promise.all(ownerARequests)).resolves.toEqual(
      Array.from({ length: 4 }).fill('SpeechProviderTimeoutError'),
    )
    // @example
    expect(providerSignals).toHaveLength(4)
    // @example
    expect(providerSignals.every(signal => signal.aborted)).toBe(true)
    // @example
    expect(vi.getTimerCount()).toBe(0)

    const rejectedOwnerAStart = vi.fn(async () => ({ text: 'must not start' }))
    speechMocks.generateTranscription.mockImplementation(rejectedOwnerAStart)
    // @example
    await expect(transcribeOpenAICompatible(
      Buffer.from([99]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      { ownerKey: 'guild-a:channel-a:generation-1:user-a', principalKey: 'user-a' },
    )).rejects.toMatchObject({
      kind: 'provider-failure',
      name: 'SpeechProviderCapacityError',
    })
    // @example
    expect(rejectedOwnerAStart).not.toHaveBeenCalled()

    speechMocks.generateTranscription.mockResolvedValueOnce({ text: 'channel B completed' })
    // @example
    await expect(transcribeOpenAICompatible(
      Buffer.from([100]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      { ownerKey: 'guild-b:channel-b:generation-1:user-b', principalKey: 'user-b' },
    )).resolves.toBe('channel B completed')

    let replacementSignal: AbortSignal | undefined
    let resolveReplacement = (_result: { text: string }) => {}
    speechMocks.generateTranscription.mockImplementationOnce(async (input: { abortSignal?: AbortSignal }) => {
      replacementSignal = input.abortSignal
      return new Promise<{ text: string }>((resolve) => {
        resolveReplacement = resolve
      })
    })
    const replacement = transcribeOpenAICompatible(
      Buffer.from([101]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      {
        deadlineAt: Date.now() + 100,
        ownerKey: 'guild-a:channel-a:generation-2:user-a',
        principalKey: 'user-a',
      },
    )
    await vi.advanceTimersByTimeAsync(0)

    for (const release of releaseProviderTasks)
      release()
    await vi.advanceTimersByTimeAsync(0)

    // @example
    expect(replacementSignal?.aborted).toBe(false)
    resolveReplacement({ text: 'replacement generation completed' })
    // @example
    await expect(replacement).resolves.toBe('replacement generation completed')
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by bounding one participant across replacement generations', async () => {})
   */
  it('reproduces Discord audit D-018 by bounding one participant across replacement generations', async () => {
    vi.useFakeTimers()
    const releaseProviderTasks: Array<() => void> = []
    const provider = vi.fn(async () => {
      return new Promise<{ text: string }>((resolve) => {
        releaseProviderTasks.push(() => resolve({ text: 'discarded late text' }))
      })
    })
    speechMocks.generateTranscription.mockImplementation(provider)
    const startGeneration = (generation: number) => {
      return Array.from({ length: 4 }, (_, index) => transcribeOpenAICompatible(
        Buffer.from([generation, index]),
        { apiKey: 'synthetic-key', model: 'synthetic-model' },
        {
          deadlineAt: Date.now() + 10,
          ownerKey: `guild-a:channel-a:generation-${generation}:user-a`,
          principalKey: 'user-a',
        },
      ).then(
        () => 'resolved',
        (error: unknown) => error instanceof Error ? error.name : 'rejected',
      ))
    }
    const generationOne = startGeneration(1)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    const generationTwo = startGeneration(2)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)

    // ROOT CAUSE:
    //
    // Capacity used the generation-bearing owner as its only fairness identity.
    // Repeated restarts therefore looked like unrelated owners and one Discord
    // participant could consume every process slot with non-cooperative fetches.
    // A stable principal cap now permits one replacement while bounding rotations.
    // @example
    await expect(Promise.all([...generationOne, ...generationTwo])).resolves.toEqual(
      Array.from({ length: 8 }).fill('SpeechProviderTimeoutError'),
    )
    // @example
    expect(provider).toHaveBeenCalledTimes(8)

    const excessA = transcribeOpenAICompatible(
      Buffer.from([3]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      {
        deadlineAt: Date.now() + 10,
        ownerKey: 'guild-a:channel-a:generation-3:user-a',
        principalKey: 'user-a',
      },
    ).then(
      () => 'resolved',
      (error: unknown) => error instanceof Error ? error.name : 'rejected',
    )
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    const providerCallsAfterExcess = provider.mock.calls.length

    speechMocks.generateTranscription.mockResolvedValueOnce({ text: 'participant B completed' })
    // @example
    await expect(transcribeOpenAICompatible(
      Buffer.from([4]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      {
        ownerKey: 'guild-b:channel-b:generation-1:user-b',
        principalKey: 'user-b',
      },
    )).resolves.toBe('participant B completed')

    for (const release of releaseProviderTasks)
      release()
    await vi.advanceTimersByTimeAsync(0)
    speechMocks.generateTranscription.mockResolvedValueOnce({ text: 'participant A recovered' })
    // @example
    await expect(transcribeOpenAICompatible(
      Buffer.from([5]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      {
        ownerKey: 'guild-a:channel-a:generation-4:user-a',
        principalKey: 'user-a',
      },
    )).resolves.toBe('participant A recovered')
    // @example
    await expect(excessA).resolves.toBe('SpeechProviderCapacityError')
    // @example
    expect(providerCallsAfterExcess).toBe(8)
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by reserving process capacity for a new participant', async () => {})
   */
  it('reproduces Discord audit D-018 by reserving process capacity for a new participant', async () => {
    vi.useFakeTimers()
    const releaseProviderTasks: Array<() => void> = []
    const provider = vi.fn(async () => {
      return new Promise<{ text: string }>((resolve) => {
        releaseProviderTasks.push(() => resolve({ text: 'settled reserved-capacity task' }))
      })
    })
    speechMocks.generateTranscription.mockImplementation(provider)
    const activeRequests = Array.from({ length: 48 }, (_, index) => {
      return transcribeOpenAICompatible(
        Buffer.from([index]),
        { apiKey: 'synthetic-key', model: 'synthetic-model' },
        {
          deadlineAt: Date.now() + 1_000,
          ownerKey: `guild-${index}:channel-${index}:generation-1:user-${index}`,
          principalKey: `user-${index}`,
        },
      )
    })
    await vi.advanceTimersByTimeAsync(0)

    const existingPrincipal = transcribeOpenAICompatible(
      Buffer.from([49]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      {
        deadlineAt: Date.now() + 10,
        ownerKey: 'guild-0:channel-0:generation-2:user-0',
        principalKey: 'user-0',
      },
    ).then(
      () => 'resolved',
      (error: unknown) => error instanceof Error ? error.name : 'rejected',
    )
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    const providerCallsAfterExistingPrincipal = provider.mock.calls.length

    speechMocks.generateTranscription.mockResolvedValueOnce({ text: 'new participant completed' })
    const newPrincipal = transcribeOpenAICompatible(
      Buffer.from([50]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      {
        deadlineAt: Date.now() + 10,
        ownerKey: 'guild-new:channel-new:generation-1:user-new',
        principalKey: 'user-new',
      },
    ).then(
      text => text,
      (error: unknown) => error instanceof Error ? error.name : 'rejected',
    )
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)

    // ROOT CAUSE:
    //
    // A global cap without reserved capacity lets already-active participants
    // occupy the final slots through replacement generations. At the reserved
    // threshold, an existing principal now fails closed while a genuinely new
    // participant can still start.
    for (const release of releaseProviderTasks)
      release()
    // @example
    await expect(Promise.all(activeRequests)).resolves.toEqual(
      Array.from({ length: 48 }).fill('settled reserved-capacity task'),
    )
    await vi.advanceTimersByTimeAsync(0)

    // @example
    await expect(newPrincipal).resolves.toBe('new participant completed')
    // @example
    await expect(existingPrincipal).resolves.toBe('SpeechProviderCapacityError')
    // @example
    expect(providerCallsAfterExistingPrincipal).toBe(48)
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by keeping high-cardinality detached provider work globally bounded', async () => {})
   */
  it('reproduces Discord audit D-018 by keeping high-cardinality detached provider work globally bounded', async () => {
    vi.useFakeTimers()
    const releaseProviderTasks: Array<() => void> = []
    const provider = vi.fn(async () => {
      return new Promise<{ text: string }>((resolve) => {
        releaseProviderTasks.push(() => resolve({ text: 'discarded late text' }))
      })
    })
    speechMocks.generateTranscription.mockImplementation(provider)
    const requests = Array.from({ length: 64 }, (_, index) => {
      return transcribeOpenAICompatible(
        Buffer.from([index]),
        { apiKey: 'synthetic-key', model: 'synthetic-model' },
        {
          deadlineAt: Date.now() + 10,
          ownerKey: `guild-${index}:channel-${index}:generation-1:user-${index}`,
          principalKey: `user-${index}`,
        },
      ).then(
        () => 'resolved',
        (error: unknown) => error instanceof Error ? error.name : 'rejected',
      )
    })
    await vi.advanceTimersByTimeAsync(0)

    // ROOT CAUSE:
    //
    // Per-owner limits alone still allowed high-cardinality inputs to retain an
    // unbounded number of non-cooperative provider tasks. A process hard cap is
    // retained alongside reserved new-owner capacity and exact record cleanup.
    // @example
    expect(provider).toHaveBeenCalledTimes(64)
    // @example
    await expect(transcribeOpenAICompatible(
      Buffer.from([100]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      { ownerKey: 'guild-65:channel-65:generation-1:user-65', principalKey: 'user-65' },
    )).rejects.toMatchObject({
      kind: 'provider-failure',
      name: 'SpeechProviderCapacityError',
    })
    // @example
    expect(provider).toHaveBeenCalledTimes(64)

    await vi.advanceTimersByTimeAsync(10)
    // @example
    await expect(Promise.all(requests)).resolves.toEqual(
      Array.from({ length: 64 }).fill('SpeechProviderTimeoutError'),
    )
    // @example
    expect(vi.getTimerCount()).toBe(0)

    for (const release of releaseProviderTasks)
      release()
    await vi.advanceTimersByTimeAsync(0)
    // @example
    expect(vi.getTimerCount()).toBe(0)

    speechMocks.generateTranscription.mockResolvedValueOnce({ text: 'registry recovered' })
    // @example
    await expect(transcribeOpenAICompatible(
      Buffer.from([101]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      { ownerKey: 'guild-65:channel-65:generation-2:user-65', principalKey: 'user-65' },
    )).resolves.toBe('registry recovered')
    // @example
    expect(speechMocks.generateTranscription).toHaveBeenCalledTimes(65)
  })
})
