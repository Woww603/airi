import { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'

import { resolveStandaloneSpeechRuntimeConfig, StandaloneSpeechRuntime } from './speech-runtime'

/**
 * @example
 * describe('standalone STT and TTS runtime', () => {})
 */
describe('standalone STT and TTS runtime', () => {
  /**
   * @example
   * it('resolves separate STT and TTS settings with bounded defaults', () => {})
   */
  it('resolves separate STT and TTS settings with bounded defaults', () => {
    const config = resolveStandaloneSpeechRuntimeConfig({
      OPENAI_STT_API_BASE_URL: ' https://speech.example/v1 ',
      OPENAI_STT_API_KEY: ' speech-key ',
      OPENAI_STT_MODEL: ' whisper-large-v3 ',
      AIRI_DISCORD_STT_TIMEOUT_MS: '999999',
      AIRI_DISCORD_TTS_TIMEOUT_MS: '1',
      OPENAI_TTS_MODEL: ' tts-model ',
      OPENAI_TTS_VOICE: ' airi-voice ',
    })

    expect(config.stt).toEqual({
      apiKey: 'speech-key',
      baseURL: 'https://speech.example/v1',
      model: 'whisper-large-v3',
    })
    expect(config.tts).toEqual({
      apiKey: 'speech-key',
      baseURL: 'https://speech.example/v1',
      model: 'tts-model',
      voice: 'airi-voice',
    })
    // @example
    expect(config.sttRequestTimeoutMs).toBe(120_000)
    // @example
    expect(config.ttsRequestTimeoutMs).toBe(5_000)

    const runtime = new StandaloneSpeechRuntime(config)
    expect(runtime.getProviderDisclosure()).toEqual({
      stt: 'the OpenAI-compatible provider at speech.example',
      tts: 'the OpenAI-compatible provider at speech.example',
    })
  })

  /**
   * @example
   * it('transcribes WAV input and synthesizes the exact spoken reply text', async () => {})
   */
  it('transcribes WAV input and synthesizes the exact spoken reply text', async () => {
    const transcribe = vi.fn(async () => 'transcribed text')
    const synthesize = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer)
    const runtime = new StandaloneSpeechRuntime({
      stt: { apiKey: 'stt-key', model: 'whisper-1' },
      tts: { apiKey: 'tts-key', model: 'tts-1', voice: 'alloy' },
    }, { synthesize, transcribe })

    await expect(runtime.transcribe(Buffer.from([9]))).resolves.toBe('transcribed text')
    const audio = await runtime.synthesize('AIRI 的语音回复')

    expect(transcribe).toHaveBeenCalledWith(Buffer.from([9]), {
      apiKey: 'stt-key',
      model: 'whisper-1',
    }, {
      abortSignal: expect.any(AbortSignal),
      deadlineAt: expect.any(Number),
    })
    expect(synthesize).toHaveBeenCalledWith('AIRI 的语音回复', {
      apiKey: 'tts-key',
      model: 'tts-1',
      voice: 'alloy',
    }, {
      abortSignal: expect.any(AbortSignal),
      deadlineAt: expect.any(Number),
    })
    expect(Buffer.from(audio)).toEqual(Buffer.from([1, 2, 3]))
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by preserving one turn deadline across STT and TTS', async () => {})
   */
  it('reproduces Discord audit D-018 by preserving one turn deadline across STT and TTS', async () => {
    vi.useFakeTimers()
    const providerDeadlines: number[] = []
    const runtime = new StandaloneSpeechRuntime({
      stt: { apiKey: 'synthetic-stt-key', model: 'synthetic-stt-model' },
      sttRequestTimeoutMs: 120_000,
      tts: { apiKey: 'synthetic-tts-key', model: 'synthetic-tts-model', voice: 'synthetic-voice' },
      ttsRequestTimeoutMs: 120_000,
    }, {
      synthesize: vi.fn(async (_text, _config, options) => {
        if (options?.deadlineAt !== undefined)
          providerDeadlines.push(options.deadlineAt)
        return new Uint8Array([1]).buffer
      }),
      transcribe: vi.fn(async (_wavBuffer, _config, options) => {
        if (options?.deadlineAt !== undefined)
          providerDeadlines.push(options.deadlineAt)
        return 'synthetic shared-deadline transcript'
      }),
    })
    const turnDeadlineAt = Date.now() + 10_000

    await runtime.transcribe(Buffer.from([1]), { deadlineAt: turnDeadlineAt })
    await vi.advanceTimersByTimeAsync(6_000)
    await runtime.synthesize('SYNTHETIC_SHARED_DEADLINE_REPLY', { deadlineAt: turnDeadlineAt })

    // ROOT CAUSE:
    //
    // Independent relative STT and TTS timers can silently grant a fresh full
    // lifetime to each phase. The runtime now carries the admission-time absolute
    // deadline and intersects it with each provider's configured phase cap.
    // @example
    expect(providerDeadlines).toEqual([turnDeadlineAt, turnDeadlineAt])
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by releasing a timed-out STT request and accepting the next turn', async () => {})
   */
  it('reproduces Discord audit D-018 by releasing a timed-out STT request and accepting the next turn', async () => {
    vi.useFakeTimers()
    let providerSignal: AbortSignal | undefined
    let providerCalls = 0
    let resolveTimedOutProvider = (_text: string) => {}
    const timedOutProvider = new Promise<string>((resolve) => {
      resolveTimedOutProvider = resolve
    })
    const transcribe = vi.fn(async (_wavBuffer: Buffer, _config: object, options?: { abortSignal?: AbortSignal }) => {
      providerCalls += 1
      providerSignal = options?.abortSignal
      if (providerCalls > 1)
        return 'recovered transcription'

      return timedOutProvider
    })
    const runtime = new StandaloneSpeechRuntime({
      stt: { apiKey: 'synthetic-stt-key', model: 'synthetic-stt-model' },
      tts: { apiKey: 'synthetic-tts-key', model: 'synthetic-tts-model', voice: 'synthetic-voice' },
    }, {
      synthesize: vi.fn(async () => new ArrayBuffer(0)),
      transcribe,
    })
    let firstOutcome = 'pending'
    void runtime.transcribe(Buffer.from([1])).then(
      () => {
        firstOutcome = 'resolved'
      },
      (error: unknown) => {
        firstOutcome = error instanceof Error ? error.name : 'rejected'
      },
    )

    // ROOT CAUSE:
    //
    // StandaloneSpeechRuntime forwarded the provider promise directly. A provider
    // fetch that never settled therefore retained the exact speaker processing gate
    // forever; there was no deadline controller or boundary rejection to release it.
    await vi.advanceTimersByTimeAsync(30_000)

    // @example
    expect(firstOutcome).toBe('SpeechProviderTimeoutError')
    // @example
    expect(providerSignal?.aborted).toBe(true)
    // @example
    await expect(runtime.transcribe(Buffer.from([2]))).resolves.toBe('recovered transcription')
    resolveTimedOutProvider('discarded late transcription')
    await vi.advanceTimersByTimeAsync(0)
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by cancelling TTS when the provider ignores AbortSignal', async () => {})
   */
  it('reproduces Discord audit D-018 by cancelling TTS when the provider ignores AbortSignal', async () => {
    vi.useFakeTimers()
    let providerSignal: AbortSignal | undefined
    let resolveLateProvider = (_audio: ArrayBuffer) => {}
    const lateProvider = new Promise<ArrayBuffer>((resolve) => {
      resolveLateProvider = resolve
    })
    const runtime = new StandaloneSpeechRuntime({
      stt: { apiKey: 'synthetic-stt-key', model: 'synthetic-stt-model' },
      tts: { apiKey: 'synthetic-tts-key', model: 'synthetic-tts-model', voice: 'synthetic-voice' },
    }, {
      synthesize: vi.fn(async (_text, _config, options) => {
        providerSignal = options?.abortSignal
        return lateProvider
      }),
      transcribe: vi.fn(async () => ''),
    })
    const lifecycle = new AbortController()
    let outcome = 'pending'
    void runtime.synthesize('SYNTHETIC_TTS_SENTINEL', { abortSignal: lifecycle.signal }).then(
      () => {
        outcome = 'resolved'
      },
      (error: unknown) => {
        outcome = error instanceof Error ? error.name : 'rejected'
      },
    )
    await vi.advanceTimersByTimeAsync(0)
    lifecycle.abort(new Error('Synthetic voice generation replaced.'))
    await vi.advanceTimersByTimeAsync(0)

    // ROOT CAUSE:
    //
    // Passing AbortSignal to fetch was treated as sufficient cancellation. If a
    // compatible provider ignored the signal, the TTS promise remained pending and
    // its late bytes could cross stop/restart into a replacement voice generation.
    // @example
    expect(outcome).toBe('SpeechProviderCancelledError')
    // @example
    expect(providerSignal?.aborted).toBe(true)

    resolveLateProvider(new Uint8Array([9, 9, 9]).buffer)
    await Promise.resolve()
    await Promise.resolve()

    // @example
    expect(outcome).toBe('SpeechProviderCancelledError')
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by timing out only the exact speech request', async () => {})
   */
  it('reproduces Discord audit D-018 by timing out only the exact speech request', async () => {
    vi.useFakeTimers()
    const signals = new Map<string, AbortSignal>()
    let resolveA = (_text: string) => {}
    const providerA = new Promise<string>((resolve) => {
      resolveA = resolve
    })
    let resolveB = (_text: string) => {}
    const providerB = new Promise<string>((resolve) => {
      resolveB = resolve
    })
    const runtime = new StandaloneSpeechRuntime({
      stt: { apiKey: 'synthetic-stt-key', model: 'synthetic-stt-model' },
      tts: { apiKey: 'synthetic-tts-key', model: 'synthetic-tts-model', voice: 'synthetic-voice' },
    }, {
      synthesize: vi.fn(async () => new ArrayBuffer(0)),
      transcribe: vi.fn(async (wavBuffer, _config, options) => {
        const request = wavBuffer[0] === 1 ? 'A' : 'B'
        if (options?.abortSignal)
          signals.set(request, options.abortSignal)
        return request === 'A' ? providerA : providerB
      }),
    })
    const now = Date.now()
    const requestA = runtime.transcribe(Buffer.from([1]), { deadlineAt: now + 20 }).then(
      () => 'resolved',
      (error: unknown) => error instanceof Error ? error.name : 'rejected',
    )
    const requestB = runtime.transcribe(Buffer.from([2]), { deadlineAt: now + 40 }).then(
      text => text,
      (error: unknown) => error instanceof Error ? error.name : 'rejected',
    )

    await vi.advanceTimersByTimeAsync(20)

    // ROOT CAUSE:
    //
    // The old speech path had no request-owned deadline/controller. A global
    // cleanup would either leave A hung or risk cancelling unrelated channel B.
    // Each provider request now owns only its timer, controller, and late-result gate.
    // @example
    await expect(requestA).resolves.toBe('SpeechProviderTimeoutError')
    // @example
    expect(signals.get('A')?.aborted).toBe(true)
    // @example
    expect(signals.get('B')?.aborted).toBe(false)

    resolveB('channel B transcription')
    // @example
    await expect(requestB).resolves.toBe('channel B transcription')
    resolveA('discarded late channel A transcription')
    await vi.advanceTimersByTimeAsync(0)
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by refusing provider start after the absolute deadline', async () => {})
   */
  it('reproduces Discord audit D-018 by refusing provider start after the absolute deadline', async () => {
    vi.useFakeTimers()
    const transcribe = vi.fn(async () => 'must not run')
    const runtime = new StandaloneSpeechRuntime({
      stt: { apiKey: 'synthetic-stt-key', model: 'synthetic-stt-model' },
      tts: { apiKey: 'synthetic-tts-key', model: 'synthetic-tts-model', voice: 'synthetic-voice' },
    }, {
      synthesize: vi.fn(async () => new ArrayBuffer(0)),
      transcribe,
    })

    // ROOT CAUSE:
    //
    // Provider start used only a relative fetch lifetime. Work that had already
    // expired while waiting for debounce/decode could still disclose audio to STT.
    // @example
    await expect(runtime.transcribe(Buffer.from([1]), {
      deadlineAt: Date.now() - 1,
    })).rejects.toMatchObject({
      kind: 'timeout',
      message: 'Speech transcription request timed out.',
      name: 'SpeechProviderTimeoutError',
    })
    // @example
    expect(transcribe).not.toHaveBeenCalled()
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by sanitizing provider failures without leaking request details', async () => {})
   */
  it('reproduces Discord audit D-018 by sanitizing provider failures without leaking request details', async () => {
    const secretSentinel = 'SYNTHETIC_TOKEN_AND_TRANSCRIPT_SENTINEL'
    const runtime = new StandaloneSpeechRuntime({
      stt: { apiKey: 'synthetic-stt-key', model: 'synthetic-stt-model' },
      tts: { apiKey: 'synthetic-tts-key', model: 'synthetic-tts-model', voice: 'synthetic-voice' },
    }, {
      synthesize: vi.fn(async () => new ArrayBuffer(0)),
      transcribe: vi.fn(async () => {
        throw new Error(`https://speech.example?token=${secretSentinel} body=${secretSentinel}`)
      }),
    })

    // ROOT CAUSE:
    //
    // Raw provider errors can contain URLs, response bodies, or echoed transcript
    // text. Passing those errors to Discord/audit logs disclosed request details.
    let errorMessage = ''
    await runtime.transcribe(Buffer.from([1])).catch((error: unknown) => {
      errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    })

    // @example
    expect(errorMessage).toBe('SpeechProviderFailureError: Speech transcription provider failed.')
    // @example
    expect(errorMessage).not.toContain(secretSentinel)
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by containing a provider rejection arriving after cancellation', async () => {})
   */
  it('reproduces Discord audit D-018 by containing a provider rejection arriving after cancellation', async () => {
    vi.useFakeTimers()
    let rejectLateProvider = (_error: Error) => {}
    const lateProvider = new Promise<string>((_resolve, reject) => {
      rejectLateProvider = reject
    })
    const runtime = new StandaloneSpeechRuntime({
      stt: { apiKey: 'synthetic-stt-key', model: 'synthetic-stt-model' },
      tts: { apiKey: 'synthetic-tts-key', model: 'synthetic-tts-model', voice: 'synthetic-voice' },
    }, {
      synthesize: vi.fn(async () => new ArrayBuffer(0)),
      transcribe: vi.fn(async () => lateProvider),
    })
    const lifecycle = new AbortController()
    const outcome = runtime.transcribe(Buffer.from([1]), { abortSignal: lifecycle.signal }).then(
      () => 'resolved',
      (error: unknown) => error instanceof Error ? error.name : 'rejected',
    )
    await vi.advanceTimersByTimeAsync(0)
    lifecycle.abort(new Error('Synthetic speaker generation stopped.'))

    // ROOT CAUSE:
    //
    // A provider that ignored AbortSignal could reject after the Discord turn
    // had already been cancelled. Without an attached late-result boundary that
    // rejection became process-global while the old turn no longer owned it.
    // @example
    await expect(outcome).resolves.toBe('SpeechProviderCancelledError')

    rejectLateProvider(new Error('SYNTHETIC_LATE_PROVIDER_BODY'))
    await vi.advanceTimersByTimeAsync(0)

    // Vitest treats any unhandled late rejection as a test-file error.
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })
})
