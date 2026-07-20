import type { QwenRealtimeSessionEvents } from './qwen-realtime'

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  QwenRealtimeRuntime,
  resolveQwenRealtimeConfig,
} from './qwen-realtime'

class FakeSocket extends EventEmitter {
  readonly closes: Array<{ code: number, reason: string }> = []
  readonly sent: string[] = []
  bufferedAmount = 0
  sendError: Error | undefined
  readyState = 0

  close(code = 1000, reason = 'closed') {
    this.closes.push({ code, reason })
    this.readyState = 3
    this.emit('close', code, Buffer.from(reason))
  }

  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    // NOTICE:
    // This fake models an obsolete socket emitting after its runtime listeners
    // were detached, so stale transport events remain observable to the test
    // harness without becoming an EventEmitter-only uncaught exception.
    // Root cause: Node EventEmitter throws for an unhandled `error`, while the
    // production lifecycle has already released this socket generation.
    // Source/context: stale-generation assertion below in this test file.
    // Removal condition: replace this EventEmitter fake with a WebSocket fake
    // that natively models detached error-event delivery.
    if (eventName === 'error' && this.listenerCount('error') === 0)
      return false

    return super.emit(eventName, ...args)
  }

  send(data: string) {
    if (this.sendError)
      throw this.sendError
    this.sent.push(data)
  }
}

interface QwenServerWireEvent {
  delta?: string
  event_id?: string
  item_id?: string
  response?: {
    id?: string
    status?: string
  }
  response_id?: string
  transcript?: string
  type: string
}

/** Emits one public Qwen server wire event without inventing omitted identities. */
function emitQwenServerEvent(socket: FakeSocket, event: QwenServerWireEvent): void {
  socket.emit('message', Buffer.from(JSON.stringify(event)), false)
}

/** Connects a configured Qwen runtime through its public socket boundary. */
async function connectFakeQwen(socket: FakeSocket, events: QwenRealtimeSessionEvents) {
  const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
    AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
    DASHSCOPE_API_KEY: 'dashscope-secret',
    QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
  }), { socketFactory: () => socket })
  const sessionPromise = runtime.connect(events)
  socket.readyState = 1
  socket.emit('open')
  emitQwenServerEvent(socket, { event_id: 'session-configured', type: 'session.updated' })
  return sessionPromise
}

afterEach(() => {
  vi.useRealTimers()
})

/**
 * @example
 * describe('Qwen Realtime runtime', () => {})
 */
describe('qwen Realtime runtime', () => {
  /**
   * @example
   * it('resolves a regional endpoint and bounded realtime defaults', () => {})
   */
  it('resolves a regional endpoint and bounded realtime defaults', () => {
    const config = resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: ' dashscope-secret ',
      QWEN_REALTIME_REGION: 'singapore',
      QWEN_REALTIME_WORKSPACE_ID: ' ws-airi-123 ',
    })

    expect(config.mode).toBe('qwen-realtime')
    expect(config.apiKey).toBe('dashscope-secret')
    expect(config.url).toBe('wss://ws-airi-123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-flash-realtime')
    expect(config.turnDebounceMs).toBe(600)
    expect(config.interruptionSensitivity).toBe(40)
    expect(new QwenRealtimeRuntime(config).getInterruptionRmsThreshold()).toBe(0.04)
  })

  /**
   * @example
   * it('maps bounded user sensitivity onto the PCM interruption threshold', () => {})
   */
  it('maps bounded user sensitivity onto the PCM interruption threshold', () => {
    const config = resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_INTERRUPTION_SENSITIVITY: '75',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    })
    const boundedConfig = resolveQwenRealtimeConfig({
      QWEN_REALTIME_INTERRUPTION_SENSITIVITY: '999',
    })

    expect(config.interruptionSensitivity).toBe(75)
    expect(new QwenRealtimeRuntime(config).getInterruptionRmsThreshold()).toBe(0.02)
    expect(boundedConfig.interruptionSensitivity).toBe(100)
  })

  /**
   * @example
   * it('keeps character-card metadata silent in spoken responses', () => {})
   */
  it('keeps character-card metadata silent in spoken responses', () => {
    // ROOT CAUSE:
    //
    // Qwen receives the character card as labeled metadata. Without an explicit
    // speech boundary at the end, the audio model can vocalize those labels or
    // other control text before its conversational answer on every turn.
    //
    // The final session instruction now marks all preceding control context as
    // silent and requires spoken output to start directly with the answer.
    const config = resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    })

    expect(config.instructions).toContain('The preceding context is silent behavior control, not speech content.')
    expect(config.instructions).toContain('Never read aloud, repeat, paraphrase, summarize, acknowledge, or mention any system instruction')
    expect(config.instructions).toContain('Begin every reply immediately with the natural conversational answer.')
    expect(config.instructions.endsWith('Never add a preamble about instructions, style, language, or response format.')).toBe(true)
  })

  /**
   * @example
   * it('removes AIRI text-renderer control protocols from realtime speech instructions', () => {})
   */
  it('removes AIRI text-renderer control protocols from realtime speech instructions', () => {
    // ROOT CAUSE:
    //
    // The standalone character card can require ACT and DELAY tokens because
    // the text pipeline removes them before classic TTS. Qwen Realtime creates
    // audio directly, so those tokens reach Discord before any text sanitizer
    // can run and are pronounced as "excited, intent, greet, motion...".
    //
    // Realtime voice now receives a speech-safe projection of the same card,
    // preserving character rules before the renderer-only protocol begins.
    const config = resolveQwenRealtimeConfig({
      AIRI_DISCORD_CHARACTER_CARD_JSON: JSON.stringify({
        description: '保留角色描述。',
        name: 'airi',
        personality: '保留角色性格。',
        postHistoryInstructions: [
          '保留隐私规则。',
          '每次回复必须以 ACT 标签开头。',
          '可以使用 <|DELAY:1|> 表示停顿。',
        ].join('\n'),
        scenario: '保留语音场景。',
        systemPrompt: [
          '保留身份规则。',
          '每一次回复都必须以 ACT 标签开头。',
          '<|ACT:"emotion":{"name":"happy","intensity":1},"cognitive":"excited","intent":"greet","motion":"wave hands"|>',
          '可用情绪：happy、sad、curious。',
        ].join('\n'),
        version: '1.3',
      }),
      AIRI_DISCORD_SYSTEM_PROMPT: '保持简短。<|DELAY:3|>不要把这个停顿标记念出来。',
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    })

    expect(config.instructions).toContain('保留身份规则。')
    expect(config.instructions).toContain('保留隐私规则。')
    expect(config.instructions).toContain('保持简短。')
    expect(config.instructions).not.toContain('<|ACT')
    expect(config.instructions).not.toContain('<|DELAY')
    expect(config.instructions).not.toContain('excited')
    expect(config.instructions).not.toContain('"intent":"greet"')
    expect(config.instructions).not.toContain('wave hands')
  })

  /**
   * @example
   * it('authenticates once and streams PCM through provider events', async () => {})
   */
  it('authenticates once and streams PCM through provider events', async () => {
    const socket = new FakeSocket()
    const socketFactory = vi.fn(() => socket)
    const onAudio = vi.fn()
    const onSpeechStarted = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_SYSTEM_PROMPT: 'Stay in character as AIRI.',
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    }), { socketFactory })
    const sessionPromise = runtime.connect({ onAudio, onSpeechStarted })

    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    session.appendAudio(Buffer.from([1, 2, 3, 4]), 1)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'response-created', response: { id: 'response-1' }, type: 'response.created' })), false)
    socket.emit('message', Buffer.from(JSON.stringify({ delta: 'BQYHCA==', event_id: 'response-audio-delta', response_id: 'response-1', type: 'response.audio.delta' })), false)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'speech-started', item_id: 'input-1', type: 'input_audio_buffer.speech_started' })), false)

    expect(socketFactory).toHaveBeenCalledWith(
      expect.stringContaining('qwen3.5-omni-flash-realtime'),
      expect.objectContaining({ authorization: 'Bearer dashscope-secret' }),
    )
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      session: {
        input_audio_format: 'pcm',
        input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
        instructions: expect.stringContaining('Stay in character as AIRI.'),
        modalities: ['text', 'audio'],
        output_audio_format: 'pcm',
        turn_detection: {
          silence_duration_ms: 600,
          threshold: 0.58,
          type: 'semantic_vad',
        },
      },
      type: 'session.update',
    })
    expect(JSON.parse(socket.sent[1])).toMatchObject({
      audio: 'AQIDBA==',
      type: 'input_audio_buffer.append',
    })
    expect(socket.sent.map(event => JSON.parse(event).type)).toEqual([
      'session.update',
      'input_audio_buffer.append',
    ])
    expect(onAudio).toHaveBeenCalledWith(Buffer.from([5, 6, 7, 8]), { responseId: 'response-1' })
    expect(onSpeechStarted).toHaveBeenCalledWith({ inputSequence: 1, itemId: 'input-1' })
  })

  /**
   * @example
   * it('emits payload-free Voice diagnostics from provider and send boundaries', async () => {})
   */
  it('emits payload-free Voice diagnostics from provider and send boundaries', async () => {
    const socket = new FakeSocket()
    const onInputCleared = vi.fn()
    const onInputCommitted = vi.fn()
    const onResponseCancelled = vi.fn()
    const onResponseCreated = vi.fn()
    const onSpeechStopped = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory: () => socket })
    const sessionPromise = runtime.connect({
      onInputCleared,
      onInputCommitted,
      onResponseCancelled,
      onResponseCreated,
      onSpeechStopped,
    })

    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise

    // ROOT CAUSE:
    //
    // The runtime updated its private input/response state at real Qwen
    // WebSocket and send boundaries but exposed no payload-free lifecycle
    // signals. Diagnostics therefore could not distinguish receiver input from
    // a provider commit, response creation, or a locally accepted clear/cancel.
    //
    // The session event contract now reports only fixed lifecycle transitions
    // after the owning provider event or successful socket send. No provider
    // event object, audio, transcript, endpoint, or credential crosses it.
    session.appendAudio(Buffer.from([1, 2, 3, 4]), 1)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'input-1-committed', item_id: 'input-1', type: 'input_audio_buffer.committed' })), false)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'input-1-speech-stopped', item_id: 'input-1', type: 'input_audio_buffer.speech_stopped' })), false)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'response-1-created', response: { id: 'response-1' }, type: 'response.created' })), false)
    session.cancelResponse()
    session.appendAudio(Buffer.from([5, 6, 7, 8]), 2)
    session.abortInput()

    // @example
    expect(onInputCommitted.mock.calls).toEqual([[{ inputSequence: 1, itemId: 'input-1' }]])
    // @example
    expect(onSpeechStopped.mock.calls).toEqual([[{ itemId: 'input-1' }]])
    // @example
    expect(onResponseCreated.mock.calls).toEqual([[{ responseId: 'response-1' }]])
    // @example
    expect(onResponseCancelled.mock.calls).toEqual([[{ responseId: 'response-1' }]])
    // @example
    expect(onInputCleared.mock.calls).toEqual([[{ inputSequence: 2 }]])
    // @example
    expect(socket.sent.map(event => JSON.parse(event).type)).toEqual([
      'session.update',
      'input_audio_buffer.append',
      'response.cancel',
      'input_audio_buffer.append',
      'input_audio_buffer.clear',
    ])

    session.close()
  })

  /**
   * @example
   * it('reproduces Discord audit P2-A by preserving provider identity across parsed events', async () => {})
   */
  it('reproduces Discord audit P2-A by preserving provider identity across parsed events', async () => {
    const socket = new FakeSocket()
    const onAudio = vi.fn()
    const onAudioDone = vi.fn()
    const onInputCommitted = vi.fn()
    const onResponseCancelled = vi.fn()
    const onResponseCreated = vi.fn()
    const onResponseDone = vi.fn()
    const onSpeechStarted = vi.fn()
    const onSpeechStopped = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory: () => socket })
    const sessionPromise = runtime.connect({
      onAudio,
      onAudioDone,
      onInputCommitted,
      onResponseCancelled,
      onResponseCreated,
      onResponseDone,
      onSpeechStarted,
      onSpeechStopped,
    })

    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise

    // ROOT CAUSE:
    //
    // Qwen follows the Realtime event shape: response lifecycle identity is
    // carried by `response.id` or `response_id`, while VAD/input identity is
    // carried by `item_id`. The parser discarded every one of those fields and
    // invoked zero-argument callbacks, forcing VoiceManager to guess which
    // overlapping turn owned a late response event.
    //
    // The parser now projects only the bounded opaque identity fields into an
    // internal callback contract. Provider payloads never cross that boundary.
    session.appendAudio(Buffer.from([1, 2, 3, 4]), 1)
    socket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'input-item-2-speech-started',
      item_id: 'input-item-2',
      type: 'input_audio_buffer.speech_started',
    })), false)
    socket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'input-item-2-speech-stopped',
      item_id: 'input-item-2',
      type: 'input_audio_buffer.speech_stopped',
    })), false)
    socket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'input-item-2-committed',
      item_id: 'input-item-2',
      type: 'input_audio_buffer.committed',
    })), false)
    socket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-2-created',
      response: { id: 'response-2' },
      type: 'response.created',
    })), false)
    socket.emit('message', Buffer.from(JSON.stringify({
      delta: 'BQYHCA==',
      event_id: 'response-2-audio-delta',
      item_id: 'output-item-2',
      response_id: 'response-2',
      type: 'response.audio.delta',
    })), false)
    socket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-2-audio-done',
      item_id: 'output-item-2',
      response_id: 'response-2',
      type: 'response.audio.done',
    })), false)
    session.cancelResponse()
    socket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-2-done',
      response: { id: 'response-2', status: 'completed' },
      type: 'response.done',
    })), false)

    // @example
    expect(onSpeechStarted).toHaveBeenCalledWith({ inputSequence: 1, itemId: 'input-item-2' })
    // @example
    expect(onSpeechStopped).toHaveBeenCalledWith({ inputSequence: 1, itemId: 'input-item-2' })
    // @example
    expect(onInputCommitted).toHaveBeenCalledWith({ inputSequence: 1, itemId: 'input-item-2' })
    // @example
    expect(onResponseCreated).toHaveBeenCalledWith({ responseId: 'response-2' })
    // @example
    expect(onAudio).toHaveBeenCalledWith(
      Buffer.from([5, 6, 7, 8]),
      { itemId: 'output-item-2', responseId: 'response-2' },
    )
    // @example
    expect(onAudioDone).toHaveBeenCalledWith({
      itemId: 'output-item-2',
      responseId: 'response-2',
    })
    // @example
    expect(onResponseCancelled).toHaveBeenCalledWith({ responseId: 'response-2' })
    // @example
    expect(onResponseDone).toHaveBeenCalledWith({ responseId: 'response-2' }, 'completed')

    session.close()
  })

  /**
   * @example
   * it('reproduces Discord audit P3 by counting only audio that reached the active Qwen socket', async () => {})
   */
  it('reproduces Discord audit P3 by counting only audio that reached the active Qwen socket', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const onError = vi.fn()
    const onInputAudioSent = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_VAD_SILENCE_DURATION_MS: '200',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory: () => socket })
    const sessionPromise = runtime.connect({ onError, onInputAudioSent })

    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise

    // ROOT CAUSE:
    //
    // Voice diagnostics counted only VoiceManager's direct append call. The
    // provider boundary then sent three additional trailing-silence chunks in
    // `finishInput`, so the displayed provider-input count was lower than the
    // actual successful WebSocket sends. Counting above the socket boundary
    // also could not distinguish captured audio from synthetic VAD padding.
    //
    // The owning runtime now emits one payload-free increment only after each
    // non-empty audio append successfully returns from the current socket send.
    expect(session.appendAudio(Buffer.from([1, 2, 3, 4]), 41)).toBe(true)
    expect(session.appendAudio(Buffer.alloc(0), 41)).toBe(true)

    socket.sendError = new Error('synthetic-send-failure')
    // ROOT CAUSE:
    //
    // `sendEventTo` lets an arbitrary WebSocket `send()` exception escape the
    // Discord decoder data listener. The public append boundary must instead
    // reject the chunk and use the normal recoverable transport lifecycle.
    expect(session.appendAudio(Buffer.from([9, 9]), 41)).toBe(false)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      category: 'transport-error',
      disposition: 'recoverable',
    }))
    socket.sendError = undefined

    session.finishInput()
    await vi.advanceTimersByTimeAsync(200)

    // @example
    expect(onInputAudioSent.mock.calls).toEqual([
      [{ byteLength: 4, chunkCount: 1, inputSequence: 41, kind: 'user-audio' }],
    ])
    // @example
    expect(socket.sent.map(event => JSON.parse(event).type)).toEqual([
      'session.update',
      'input_audio_buffer.append',
      'input_audio_buffer.append',
    ])

    session.close()
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit P3 without stale silence after socket replacement', async () => {})
   */
  it('reproduces Discord audit P3 without stale silence after socket replacement', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const onInputAudioSent = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_VAD_SILENCE_DURATION_MS: '200',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const sessionPromise = runtime.connect({ onInputAudioSent })
    const firstSocket = socketFactory.mock.results[0]?.value

    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    session.appendAudio(Buffer.from([1, 2, 3, 4]), 51)
    session.finishInput()
    firstSocket.close(1006, 'synthetic transport replacement')

    await vi.advanceTimersByTimeAsync(250)
    const replacementSocket = socketFactory.mock.results[1]?.value
    replacementSocket.readyState = 1
    replacementSocket.emit('open')
    replacementSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    session.appendAudio(Buffer.from([5, 6]), 52)
    session.finishInput()
    await vi.advanceTimersByTimeAsync(200)

    // @example
    expect(onInputAudioSent.mock.calls).toEqual([
      [{ byteLength: 4, chunkCount: 1, inputSequence: 51, kind: 'user-audio' }],
      [{ byteLength: 2, chunkCount: 1, inputSequence: 52, kind: 'user-audio' }],
      [{ byteLength: 3_200, chunkCount: 1, inputSequence: 52, kind: 'synthetic-silence' }],
      [{ byteLength: 3_200, chunkCount: 1, inputSequence: 52, kind: 'synthetic-silence' }],
      [{ byteLength: 3_200, chunkCount: 1, inputSequence: 52, kind: 'synthetic-silence' }],
    ])
    // @example
    expect(firstSocket.sent.map(event => JSON.parse(event).type)).toEqual([
      'session.update',
      'input_audio_buffer.append',
    ])
    // @example
    expect(replacementSocket.sent.map(event => JSON.parse(event).type)).toEqual([
      'session.update',
      'input_audio_buffer.append',
      'input_audio_buffer.append',
      'input_audio_buffer.append',
      'input_audio_buffer.append',
    ])

    session.close()
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit P2-A when an older response completes late', async () => {})
   */
  it('reproduces Discord audit P2-A when an older response completes late', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const onAudio = vi.fn()
    const onResponseDone = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const sessionPromise = runtime.connect({ onAudio, onResponseDone })
    const firstSocket = socketFactory.mock.results[0]?.value

    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-1-created',
      response: { id: 'response-1' },
      type: 'response.created',
    })), false)
    session.cancelResponse()
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-2-created',
      response: { id: 'response-2' },
      type: 'response.created',
    })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-1-cancelled',
      response: { id: 'response-1', status: 'cancelled' },
      type: 'response.done',
    })), false)

    await vi.advanceTimersByTimeAsync(110 * 60 * 1_000)

    // @example
    expect(firstSocket.closes).toHaveLength(0)
    // @example
    expect(socketFactory).toHaveBeenCalledOnce()

    firstSocket.emit('message', Buffer.from(JSON.stringify({
      delta: 'BQYHCA==',
      event_id: 'response-2-audio-delta',
      item_id: 'output-item-2',
      response_id: 'response-2',
      type: 'response.audio.delta',
    })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-2-done',
      response: { id: 'response-2', status: 'completed' },
      type: 'response.done',
    })), false)
    await vi.advanceTimersByTimeAsync(1)

    // @example
    expect(onAudio).toHaveBeenCalledWith(
      Buffer.from([5, 6, 7, 8]),
      { itemId: 'output-item-2', responseId: 'response-2' },
    )
    // @example
    expect(onResponseDone.mock.calls).toEqual([
      [{ responseId: 'response-1' }, 'cancelled'],
      [{ responseId: 'response-2' }, 'completed'],
    ])
    // @example
    expect(firstSocket.closes).toEqual([
      { code: 1000, reason: 'Qwen Realtime session rotation' },
    ])
    // @example
    expect(socketFactory).toHaveBeenCalledTimes(2)

    session.close()
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit P2-A when an old cancel completes before the next response starts', async () => {})
   */
  it('reproduces Discord audit P2-A when an old cancel completes before the next response starts', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const sessionPromise = runtime.connect()
    const firstSocket = socketFactory.mock.results[0]?.value

    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    session.appendAudio(Buffer.from([1, 2]), 1)
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'input-item-1-committed',
      item_id: 'input-item-1',
      type: 'input_audio_buffer.committed',
    })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-1-created',
      response: { id: 'response-1' },
      type: 'response.created',
    })), false)
    session.cancelResponse()
    session.appendAudio(Buffer.from([3, 4]), 2)
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'input-item-2-committed',
      item_id: 'input-item-2',
      type: 'input_audio_buffer.committed',
    })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-1-cancelled',
      response: { id: 'response-1', status: 'cancelled' },
      type: 'response.done',
    })), false)

    // ROOT CAUSE:
    //
    // `response.done` cleared one global `responseAwaiting` flag even when the
    // awaiting state belonged to a newer committed input. When the cancelled
    // response completed before the new response was created, rotation could
    // close the socket and discard that newer turn.
    //
    // Response creation owns clearing the commit-awaiting state. A terminal
    // event now changes only the response identity that it actually names.
    await vi.advanceTimersByTimeAsync(110 * 60 * 1_000)

    // @example
    expect(firstSocket.closes).toHaveLength(0)
    // @example
    expect(socketFactory).toHaveBeenCalledOnce()

    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-2-created',
      response: { id: 'response-2' },
      type: 'response.created',
    })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-2-done',
      response: { id: 'response-2', status: 'completed' },
      type: 'response.done',
    })), false)
    await vi.advanceTimersByTimeAsync(1)

    // @example
    expect(firstSocket.closes).toEqual([
      { code: 1000, reason: 'Qwen Realtime session rotation' },
    ])
    // @example
    expect(socketFactory).toHaveBeenCalledTimes(2)

    session.close()
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit P2-A with two committed inputs awaiting responses', async () => {})
   */
  it('reproduces Discord audit P2-A with two committed inputs awaiting responses', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const sessionPromise = runtime.connect()
    const firstSocket = socketFactory.mock.results[0]?.value

    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    session.appendAudio(Buffer.from([1, 2]), 1)
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'input-item-1-committed',
      item_id: 'input-item-1',
      type: 'input_audio_buffer.committed',
    })), false)
    session.appendAudio(Buffer.from([3, 4]), 2)
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'input-item-2-committed',
      item_id: 'input-item-2',
      type: 'input_audio_buffer.committed',
    })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-1-created',
      response: { id: 'response-1' },
      type: 'response.created',
    })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-1-done',
      response: { id: 'response-1', status: 'completed' },
      type: 'response.done',
    })), false)

    // ROOT CAUSE:
    //
    // A boolean represented every provider response still owed for committed
    // input. Creating the first response cleared it even when another committed
    // input was queued, making the socket appear idle before response 2 existed.
    //
    // The runtime now counts outstanding response creations and decrements only
    // at the corresponding creation boundary.
    await vi.advanceTimersByTimeAsync(110 * 60 * 1_000)

    // @example
    expect(firstSocket.closes).toHaveLength(0)
    // @example
    expect(socketFactory).toHaveBeenCalledOnce()

    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-2-created',
      response: { id: 'response-2' },
      type: 'response.created',
    })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-2-done',
      response: { id: 'response-2', status: 'completed' },
      type: 'response.done',
    })), false)
    await vi.advanceTimersByTimeAsync(1)

    // @example
    expect(firstSocket.closes).toEqual([
      { code: 1000, reason: 'Qwen Realtime session rotation' },
    ])
    // @example
    expect(socketFactory).toHaveBeenCalledTimes(2)

    session.close()
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit P2-A without guessing a missing provider identity', async () => {})
   */
  it('reproduces Discord audit P2-A without guessing a missing provider identity', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const onAudio = vi.fn()
    const onResponseDone = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const sessionPromise = runtime.connect({ onAudio, onResponseDone })
    const firstSocket = socketFactory.mock.results[0]?.value

    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-current-created',
      response: { id: 'response-current' },
      type: 'response.created',
    })), false)

    await vi.advanceTimersByTimeAsync(110 * 60 * 1_000)

    // @example
    expect(firstSocket.closes).toHaveLength(0)
    // @example
    expect(socketFactory).toHaveBeenCalledOnce()

    firstSocket.emit('message', Buffer.from(JSON.stringify({
      delta: 'BQYHCA==',
      event_id: 'response-current-audio-second',
      item_id: 'output-current',
      response_id: 'response-current',
      type: 'response.audio.delta',
    })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'response-current-done-second',
      response: { id: 'response-current', status: 'completed' },
      type: 'response.done',
    })), false)
    await vi.advanceTimersByTimeAsync(1)

    // @example
    expect(onAudio).toHaveBeenNthCalledWith(
      1,
      Buffer.from([5, 6, 7, 8]),
      { itemId: 'output-current', responseId: 'response-current' },
    )
    // @example
    expect(onResponseDone).toHaveBeenNthCalledWith(
      1,
      { responseId: 'response-current' },
      'completed',
    )
    // @example
    expect(firstSocket.closes).toEqual([
      { code: 1000, reason: 'Qwen Realtime session rotation' },
    ])

    session.close()
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /** @example it('rejects an unsolicited anonymous provider commit without a pending aggregate', async () => {}) */
  it('rejects an unsolicited anonymous provider commit without a pending aggregate', async () => {
    const socket = new FakeSocket()
    const onInputCommitted = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory: () => socket })
    const sessionPromise = runtime.connect({ onInputCommitted })
    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise

    // ROOT CAUSE:
    //
    // A provider commit with neither an item identity nor a locally pending
    // aggregate cannot safely belong to any Discord capture. Forwarding it
    // invites a caller to fall back to its latest or finished capture.
    // Deliberate identityless negative: this malformed provider event must fail closed.
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'input_audio_buffer.committed' })), false)

    expect(onInputCommitted).not.toHaveBeenCalled()
    session.close()
  })

  /**
   * @example
   * it('reproduces Discord audit D-017 by redacting provider and transport error details', async () => {})
   */
  it('reproduces Discord audit D-017 by redacting provider and transport error details', async () => {
    const socket = new FakeSocket()
    const onError = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory: () => socket })
    const sessionPromise = runtime.connect({ onError })
    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise

    // ROOT CAUSE:
    //
    // Provider `error.message`, JSON parser failures, and WebSocket Error values
    // were forwarded verbatim to the Discord voice owner. Structured logging at
    // that boundary could therefore serialize an upstream URL, response body,
    // token, or other provider-controlled text. The runtime must reduce every
    // external failure to a stable classification before invoking callbacks.
    socket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'provider-error',
      error: {
        message: 'https://provider.invalid?token=provider-secret body=provider-body',
      },
      type: 'error',
    })), false)
    socket.emit('error', new Error('https://transport.invalid?token=transport-secret body=transport-body'))

    /**
     * @example
     * expect(onError).toHaveBeenCalledTimes(2)
     */
    expect(onError).toHaveBeenCalledTimes(2)
    /**
     * @example
     * expect(onError).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'provider-error' }))
     */
    expect(onError).toHaveBeenNthCalledWith(1, expect.objectContaining({
      category: 'provider-error',
      disposition: 'terminal',
    }))
    /**
     * @example
     * expect(onError).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'transport-error' }))
     */
    expect(onError).toHaveBeenNthCalledWith(2, expect.objectContaining({
      category: 'transport-error',
      disposition: 'recoverable',
    }))
    /**
     * @example
     * expect(JSON.stringify(onError.mock.calls)).not.toContain('provider-secret')
     */
    expect(JSON.stringify(onError.mock.calls)).not.toContain('provider.invalid')
    expect(JSON.stringify(onError.mock.calls)).not.toContain('transport.invalid')
    expect(JSON.stringify(onError.mock.calls)).not.toContain('secret')
    expect(JSON.stringify(onError.mock.calls)).not.toContain('body')

    session.close()
  })

  /**
   * @example
   * it('reproduces Discord audit D-016 by aborting a connecting socket and clearing its lifecycle timers', async () => {})
   */
  it('reproduces Discord audit D-016 by aborting a connecting socket and clearing its lifecycle timers', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const abortController = new AbortController()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory: () => socket })
    const connectTask = runtime.connect({}, { signal: abortController.signal })

    // ROOT CAUSE:
    //
    // The provider boundary previously exposed no AbortSignal while awaiting
    // `session.updated`. VoiceManager could forget the Promise, but the real
    // WebSocket and its configuration timer remained alive after Discord stop.
    abortController.abort(new Error('synthetic voice generation stopped'))

    /**
     * @example
     * await expect(connectTask).rejects.toThrow('Qwen Realtime connection cancelled.')
     */
    await expect(connectTask).rejects.toEqual({
      category: 'connection-cancelled',
      disposition: 'terminal',
    })
    /**
     * @example
     * expect(socket.closes).toEqual([{ code: 1000, reason: 'Discord voice generation cancelled' }])
     */
    expect(socket.closes).toEqual([
      { code: 1000, reason: 'Discord voice generation cancelled' },
    ])
    /**
     * @example
     * expect(vi.getTimerCount()).toBe(0)
     */
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-015 by aborting one pending Qwen input exactly once', async () => {})
   */
  it('reproduces Discord audit D-015 by aborting one pending Qwen input exactly once', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory: () => socket })
    const sessionPromise = runtime.connect()
    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    session.appendAudio(Buffer.from([1, 2, 3, 4]), 1)
    session.finishInput()

    // ROOT CAUSE:
    //
    // Revoking a speaker destroyed its Discord receiver but left the already
    // admitted provider buffer and trailing-silence timer alive. A later speaker
    // could therefore commit stale audio from the revoked turn.
    session.abortInput()
    session.abortInput()
    await vi.advanceTimersByTimeAsync(3_000)
    const eventTypes = socket.sent.map(event => JSON.parse(event).type)

    /**
     * @example
     * expect(eventTypes.filter(type => type === 'input_audio_buffer.clear')).toHaveLength(1)
     */
    expect(eventTypes.filter(type => type === 'input_audio_buffer.clear')).toHaveLength(1)
    /**
     * @example
     * expect(eventTypes.filter(type => type === 'input_audio_buffer.append')).toHaveLength(1)
     */
    expect(eventTypes.filter(type => type === 'input_audio_buffer.append')).toHaveLength(1)
    session.close()
    /**
     * @example
     * expect(vi.getTimerCount()).toBe(0)
     */
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('does not force a response for energy-only input rejected by semantic VAD', async () => {})
   */
  // Report artifact: /Users/owen.j/Desktop/Screen Recording 2026-07-13 at 22.54.29.mov
  it('does not force a response for energy-only input rejected by semantic VAD', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_VAD_SILENCE_DURATION_MS: '800',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    }), { socketFactory: () => socket })
    const sessionPromise = runtime.connect()

    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise

    // ROOT CAUSE:
    //
    // The manual-mode runtime issued `input_audio_buffer.commit` followed by
    // `response.create` for every local RMS gate activation. Sustained fan noise
    // can cross an energy threshold, so the model was explicitly ordered to
    // answer even though no human had spoken.
    //
    // Semantic VAD now owns speech confirmation. Discord end events add trailing
    // silence after the local debounce but never force a commit or response.
    session.appendAudio(Buffer.from([1, 2, 3, 4]), 1)
    session.finishInput()
    await vi.advanceTimersByTimeAsync(799)

    expect(socket.sent.map(event => JSON.parse(event).type)).toEqual([
      'session.update',
      'input_audio_buffer.append',
    ])

    await vi.advanceTimersByTimeAsync(1)
    const turnEventTypes = socket.sent.map(event => JSON.parse(event).type)

    expect(turnEventTypes).toContain('input_audio_buffer.append')
    expect(turnEventTypes).not.toContain('input_audio_buffer.commit')
    expect(turnEventTypes).not.toContain('response.create')

    await vi.advanceTimersByTimeAsync(1_300)
    expect(socket.sent.map(event => JSON.parse(event).type)).toContain('input_audio_buffer.clear')
  })

  /**
   * @example
   * it('keeps the turn open when Discord speech resumes during the debounce', async () => {})
   */
  it('keeps the turn open when Discord speech resumes during the debounce', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const onInputAudioSent = vi.fn()
    const onInputCommitted = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_VAD_SILENCE_DURATION_MS: '800',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    }), { socketFactory: () => socket })
    const sessionPromise = runtime.connect({ onInputAudioSent, onInputCommitted })

    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    session.appendAudio(Buffer.from([1, 2]), 61)
    session.finishInput()
    await vi.advanceTimersByTimeAsync(700)
    session.appendAudio(Buffer.from([3, 4]), 62)
    await vi.advanceTimersByTimeAsync(800)

    expect(socket.sent.map(event => JSON.parse(event).type)).toEqual([
      'session.update',
      'input_audio_buffer.append',
      'input_audio_buffer.append',
    ])

    session.finishInput()
    await vi.advanceTimersByTimeAsync(800)
    const completedTurnEventTypes = socket.sent.map(event => JSON.parse(event).type)

    expect(completedTurnEventTypes.filter(type => type === 'input_audio_buffer.append')).toHaveLength(11)
    expect(completedTurnEventTypes).not.toContain('input_audio_buffer.commit')
    expect(completedTurnEventTypes).not.toContain('response.create')

    // ROOT CAUSE:
    //
    // Discord can close and reopen its speaking indicator inside Qwen's VAD
    // debounce while the provider still owns one input buffer. Deriving the
    // delayed silence owner from VoiceManager's newest turn split one provider
    // input across two diagnostics turns.
    //
    // The provider has one pending aggregate owner (61), but each successful
    // Discord append remains attributable to its actual capture. Delayed
    // synthetic silence and the eventual provider commit remain owner-owned.
    const increments = onInputAudioSent.mock.calls.map(([increment]) => increment)
    expect(increments.filter(increment => increment.kind === 'user-audio')).toEqual([
      { byteLength: 2, chunkCount: 1, inputSequence: 61, kind: 'user-audio' },
      { byteLength: 2, chunkCount: 1, inputSequence: 62, kind: 'user-audio' },
    ])
    expect(increments
      .filter(increment => increment.kind === 'synthetic-silence')
      .every(increment => increment.inputSequence === 61)).toBe(true)
    expect(increments).toHaveLength(
      socket.sent.map(event => JSON.parse(event)).filter(event => event.type === 'input_audio_buffer.append').length,
    )
    socket.emit('message', Buffer.from(JSON.stringify({
      event_id: 'debounced-input-committed',
      item_id: 'debounced-input-item',
      type: 'input_audio_buffer.committed',
    })), false)
    expect(onInputCommitted).toHaveBeenCalledWith({
      inputSequence: 61,
      itemId: 'debounced-input-item',
    })
  })

  /**
   * @example
   * it('cancels only a provider-confirmed active response', async () => {})
   */
  it('cancels only a provider-confirmed active response', async () => {
    const socket = new FakeSocket()
    const onResponseCancelled = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    }), { socketFactory: () => socket })
    const sessionPromise = runtime.connect({ onResponseCancelled })

    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise

    session.cancelResponse()

    expect(socket.sent.map(event => JSON.parse(event).type)).toEqual([
      'session.update',
    ])
    expect(onResponseCancelled).not.toHaveBeenCalled()

    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'response-created', response: { id: 'response-active' }, type: 'response.created' })), false)
    session.cancelResponse()
    expect(socket.sent.map(event => JSON.parse(event).type)).toEqual([
      'session.update',
      'response.cancel',
    ])
    expect(onResponseCancelled.mock.calls).toEqual([[{ responseId: 'response-active' }]])
  })

  /** @example it('does not let an old committed event instance consume a newer pending input', async () => {}) */
  it('does not let an old committed event instance consume a newer pending input', async () => {
    const socket = new FakeSocket()
    const onInputCommitted = vi.fn()
    const session = await connectFakeQwen(socket, { onInputCommitted })

    expect(session.appendAudio(Buffer.from([1, 2]), 1)).toBe(true)
    emitQwenServerEvent(socket, { event_id: 'commit-1', type: 'input_audio_buffer.committed' })
    expect(session.appendAudio(Buffer.from([3, 4]), 2)).toBe(true)
    emitQwenServerEvent(socket, { event_id: 'commit-1', type: 'input_audio_buffer.committed' })

    // ROOT CAUSE:
    //
    // The parser discarded the provider event instance identity. A delayed
    // commit for input 1 was therefore indistinguishable from a new commit and
    // consumed input 2 after it became pending.
    //
    // Seen server event ids must be checked before any pending-input mutation;
    // only commit-2 may consume the second public append.
    expect(onInputCommitted.mock.calls).toEqual([[{ inputSequence: 1 }]])
    emitQwenServerEvent(socket, { event_id: 'commit-2', type: 'input_audio_buffer.committed' })
    expect(onInputCommitted.mock.calls).toEqual([
      [{ inputSequence: 1 }],
      [{ inputSequence: 2 }],
    ])
  })

  /** @example it('deduplicates a committed provider item even when its event instance changes', async () => {}) */
  it('deduplicates a committed provider item even when its event instance changes', async () => {
    const socket = new FakeSocket()
    const onInputCommitted = vi.fn()
    const session = await connectFakeQwen(socket, { onInputCommitted })

    expect(session.appendAudio(Buffer.from([1, 2]), 1)).toBe(true)
    emitQwenServerEvent(socket, { event_id: 'commit-item-a', item_id: 'item-1', type: 'input_audio_buffer.committed' })
    emitQwenServerEvent(socket, { event_id: 'commit-item-b', item_id: 'item-1', type: 'input_audio_buffer.committed' })
    expect(session.appendAudio(Buffer.from([3, 4]), 2)).toBe(true)

    // ROOT CAUSE:
    //
    // `event_id` names a transport delivery while `item_id` names the
    // committed provider input. Retrying that item with another delivery id
    // must not consume the next pending capture.
    expect(onInputCommitted.mock.calls).toEqual([[
      { inputSequence: 1, itemId: 'item-1' },
    ]])
    emitQwenServerEvent(socket, { event_id: 'commit-item-2', item_id: 'item-2', type: 'input_audio_buffer.committed' })
    expect(onInputCommitted.mock.calls).toEqual([
      [{ inputSequence: 1, itemId: 'item-1' }],
      [{ inputSequence: 2, itemId: 'item-2' }],
    ])
  })

  /** @example it('scopes server event identities to one reconnect generation', async () => {}) */
  it('scopes server event identities to one reconnect generation', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const onInputCommitted = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    }), { socketFactory })
    const sessionPromise = runtime.connect({ onInputCommitted })
    const firstSocket = socketFactory.mock.results[0]?.value
    if (!firstSocket)
      throw new Error('Expected the first Qwen socket.')
    firstSocket.readyState = 1
    firstSocket.emit('open')
    emitQwenServerEvent(firstSocket, { event_id: 'session-reused', type: 'session.updated' })
    const session = await sessionPromise

    expect(session.appendAudio(Buffer.from([1, 2]), 1)).toBe(true)
    firstSocket.close(1006, 'synthetic transport loss')
    await vi.advanceTimersByTimeAsync(250)
    const secondSocket = socketFactory.mock.results[1]?.value
    if (!secondSocket)
      throw new Error('Expected the replacement Qwen socket.')
    secondSocket.readyState = 1
    secondSocket.emit('open')
    emitQwenServerEvent(secondSocket, { event_id: 'session-reused', type: 'session.updated' })

    // ROOT CAUSE:
    //
    // Server event ids are meaningful only within a WebSocket generation. A
    // global seen-id cache would reject a legitimate replacement socket, while
    // an obsolete socket must not consume the new generation's pending input.
    expect(session.appendAudio(Buffer.from([3, 4]), 2)).toBe(true)
    emitQwenServerEvent(firstSocket, { event_id: 'commit-reused', item_id: 'item-old', type: 'input_audio_buffer.committed' })
    expect(onInputCommitted).not.toHaveBeenCalled()
    emitQwenServerEvent(secondSocket, { event_id: 'commit-reused', item_id: 'item-new', type: 'input_audio_buffer.committed' })
    expect(onInputCommitted.mock.calls).toEqual([[
      { inputSequence: 2, itemId: 'item-new' },
    ]])
  })

  /** @example it('deduplicates response.created by response identity even when provider event instances differ', async () => {}) */
  it('deduplicates response.created by response identity even when provider event instances differ', async () => {
    const socket = new FakeSocket()
    const onResponseCreated = vi.fn()
    const session = await connectFakeQwen(socket, { onResponseCreated })

    expect(session.appendAudio(Buffer.from([1, 2]), 1)).toBe(true)
    emitQwenServerEvent(socket, { event_id: 'commit-r1', type: 'input_audio_buffer.committed' })
    expect(session.appendAudio(Buffer.from([3, 4]), 2)).toBe(true)
    emitQwenServerEvent(socket, { event_id: 'commit-r2', type: 'input_audio_buffer.committed' })
    emitQwenServerEvent(socket, { event_id: 'created-r1-a', response: { id: 'response-1' }, type: 'response.created' })
    emitQwenServerEvent(socket, { event_id: 'created-r1-b', response: { id: 'response-1' }, type: 'response.created' })

    // ROOT CAUSE:
    //
    // event_id identifies a delivery instance, while response_id identifies
    // the response lifecycle. Replaying the same response with another event
    // id must not consume the second committed response backlog entry.
    expect(onResponseCreated.mock.calls).toEqual([[{ responseId: 'response-1' }]])
    emitQwenServerEvent(socket, { event_id: 'done-r1', response: { id: 'response-1', status: 'completed' }, type: 'response.done' })
    emitQwenServerEvent(socket, { event_id: 'created-r2', response: { id: 'response-2' }, type: 'response.created' })
    expect(onResponseCreated.mock.calls).toEqual([
      [{ responseId: 'response-1' }],
      [{ responseId: 'response-2' }],
    ])
  })

  /** @example it('delivers each response audio event instance exactly once without suppressing a later delta', async () => {}) */
  it('delivers each response audio event instance exactly once without suppressing a later delta', async () => {
    const socket = new FakeSocket()
    const onAudio = vi.fn()
    const session = await connectFakeQwen(socket, { onAudio })

    expect(session.appendAudio(Buffer.from([1, 2]), 1)).toBe(true)
    emitQwenServerEvent(socket, { event_id: 'commit-audio', type: 'input_audio_buffer.committed' })
    emitQwenServerEvent(socket, { event_id: 'created-audio', response: { id: 'response-audio' }, type: 'response.created' })
    emitQwenServerEvent(socket, { delta: 'AQIDBA==', event_id: 'delta-1', response_id: 'response-audio', type: 'response.audio.delta' })
    emitQwenServerEvent(socket, { delta: 'AQIDBA==', event_id: 'delta-1', response_id: 'response-audio', type: 'response.audio.delta' })
    emitQwenServerEvent(socket, { delta: 'BQYHCA==', event_id: 'delta-2', response_id: 'response-audio', type: 'response.audio.delta' })

    // ROOT CAUSE:
    //
    // Audio delta replay previously reached Discord twice because the parser
    // did not retain server event ids. Deduplication must be event-instance
    // scoped, so a distinct later delta for the same response still streams.
    expect(onAudio.mock.calls).toEqual([
      [Buffer.from([1, 2, 3, 4]), { responseId: 'response-audio' }],
      [Buffer.from([5, 6, 7, 8]), { responseId: 'response-audio' }],
    ])
  })

  /** @example it('fails closed when a committed input has neither provider item nor event identity', async () => {}) */
  it('fails closed when a committed input has neither provider item nor event identity', async () => {
    const socket = new FakeSocket()
    const onError = vi.fn()
    const onInputCommitted = vi.fn()
    const session = await connectFakeQwen(socket, { onError, onInputCommitted })

    expect(session.appendAudio(Buffer.from([1, 2]), 1)).toBe(true)
    // Deliberate identityless negative: no item_id or event_id.
    emitQwenServerEvent(socket, { type: 'input_audio_buffer.committed' })

    // ROOT CAUSE:
    //
    // An anonymous commit cannot be correlated with a provider delivery or
    // item lifecycle. Falling back to the only pending input lets old traffic
    // consume a new capture. The public session must terminally fail closed.
    expect(onInputCommitted).not.toHaveBeenCalled()
    expect(onError.mock.calls).toEqual([[expect.objectContaining({ category: 'invalid-event', disposition: 'terminal' })]])
    expect(socket.closes).toEqual([{ code: 1000, reason: 'Qwen Realtime invalid server event' }])
  })

  /** @example it('fails closed when response.created has no response identity', async () => {}) */
  it('fails closed when response.created has no response identity', async () => {
    const socket = new FakeSocket()
    const onError = vi.fn()
    const onResponseCreated = vi.fn()
    const session = await connectFakeQwen(socket, { onError, onResponseCreated })

    expect(session.appendAudio(Buffer.from([1, 2]), 1)).toBe(true)
    emitQwenServerEvent(socket, { event_id: 'commit-created', type: 'input_audio_buffer.committed' })
    // Deliberate identityless negative: event_id alone is not response identity.
    emitQwenServerEvent(socket, { event_id: 'created-without-response-id', type: 'response.created' })

    // ROOT CAUSE:
    //
    // A server delivery id identifies an event instance, not its response
    // lifecycle. Without response_id, consuming the current response backlog
    // would let an old anonymous created event steal a later response slot.
    expect(onResponseCreated).not.toHaveBeenCalled()
    expect(onError.mock.calls).toEqual([[expect.objectContaining({ category: 'invalid-event', disposition: 'terminal' })]])
    expect(socket.closes).toEqual([{ code: 1000, reason: 'Qwen Realtime invalid server event' }])
  })

  /** @example it('fails closed when response audio has no response or event identity', async () => {}) */
  it('fails closed when response audio has no response or event identity', async () => {
    const socket = new FakeSocket()
    const onAudio = vi.fn()
    const onError = vi.fn()
    await connectFakeQwen(socket, { onAudio, onError })

    // Deliberate identityless negative: neither response_id nor event_id.
    emitQwenServerEvent(socket, { delta: 'AQIDBA==', type: 'response.audio.delta' })

    // ROOT CAUSE:
    //
    // Audio without both response_id and event_id cannot be assigned to a
    // response lifecycle or deduplicated. Emitting it would bind it to the
    // latest response and make replay audible in Discord.
    expect(onAudio).not.toHaveBeenCalled()
    expect(onError.mock.calls).toEqual([[expect.objectContaining({ category: 'invalid-event', disposition: 'terminal' })]])
    expect(socket.closes).toEqual([{ code: 1000, reason: 'Qwen Realtime invalid server event' }])
  })

  /** @example it('does not let a mismatched or duplicate response.done terminate the active response', async () => {}) */
  it('does not let a mismatched or duplicate response.done terminate the active response', async () => {
    const socket = new FakeSocket()
    const onResponseDone = vi.fn()
    const session = await connectFakeQwen(socket, { onResponseDone })

    expect(session.appendAudio(Buffer.from([1, 2]), 1)).toBe(true)
    emitQwenServerEvent(socket, { event_id: 'commit-done', type: 'input_audio_buffer.committed' })
    emitQwenServerEvent(socket, { event_id: 'created-done', response: { id: 'response-active' }, type: 'response.created' })
    emitQwenServerEvent(socket, { event_id: 'done-mismatch', response: { id: 'response-other', status: 'completed' }, type: 'response.done' })

    // ROOT CAUSE:
    //
    // response.done previously notified the manager even when it named a
    // different response. That callback could retire the active Discord
    // playback owner. Only the exact active response may terminally complete.
    expect(onResponseDone).not.toHaveBeenCalled()
    emitQwenServerEvent(socket, { event_id: 'done-active', response: { id: 'response-active', status: 'completed' }, type: 'response.done' })
    emitQwenServerEvent(socket, { event_id: 'done-active-duplicate', response: { id: 'response-active', status: 'completed' }, type: 'response.done' })
    expect(onResponseDone.mock.calls).toEqual([[{ responseId: 'response-active' }, 'completed']])
  })

  /** @example it('does not replay an assistant transcript event or bind an anonymous transcript to the latest response', async () => {}) */
  it('does not replay an assistant transcript event or bind an anonymous transcript to the latest response', async () => {
    const socket = new FakeSocket()
    const onAssistantTranscript = vi.fn()
    const session = await connectFakeQwen(socket, { onAssistantTranscript })

    expect(session.appendAudio(Buffer.from([1, 2]), 1)).toBe(true)
    emitQwenServerEvent(socket, { event_id: 'commit-transcript', type: 'input_audio_buffer.committed' })
    emitQwenServerEvent(socket, { event_id: 'created-transcript', response: { id: 'response-transcript' }, type: 'response.created' })
    emitQwenServerEvent(socket, { event_id: 'transcript-1', response_id: 'response-transcript', transcript: 'hello', type: 'response.audio_transcript.done' })
    emitQwenServerEvent(socket, { event_id: 'transcript-1', response_id: 'response-transcript', transcript: 'hello', type: 'response.audio_transcript.done' })
    // Deliberate malformed negative: an event id cannot replace transcript response identity.
    emitQwenServerEvent(socket, { event_id: 'transcript-orphan', transcript: 'old turn', type: 'response.audio_transcript.done' })

    // ROOT CAUSE:
    //
    // A transcript has to name its stable response identity. Otherwise an old
    // provider message can be attributed to whichever response happens to be
    // active. Its event instance must also be exactly-once.
    expect(onAssistantTranscript.mock.calls).toEqual([['hello', { responseId: 'response-transcript' }]])
  })

  /** @example it('does not accept a late response between transport error and close', async () => {}) */
  it('does not accept a late response between transport error and close', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const onAudio = vi.fn()
    const onError = vi.fn()
    const onResponseCreated = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    }), { socketFactory })
    const sessionPromise = runtime.connect({ onAudio, onError, onResponseCreated })
    const firstSocket = socketFactory.mock.results[0]?.value
    if (!firstSocket)
      throw new Error('Expected the first Qwen socket.')
    firstSocket.readyState = 1
    firstSocket.emit('open')
    emitQwenServerEvent(firstSocket, { event_id: 'session-configured', type: 'session.updated' })
    const session = await sessionPromise

    expect(session.appendAudio(Buffer.from([1, 2]), 1)).toBe(true)
    emitQwenServerEvent(firstSocket, { event_id: 'input-1-committed', item_id: 'input-1', type: 'input_audio_buffer.committed' })
    firstSocket.emit('error', new Error('synthetic transport error'))

    // ROOT CAUSE:
    //
    // A transport error schedules recovery but left the obsolete socket's
    // message listener live until close. A delayed response in that window
    // could create active playback on a transport the runtime already retired.
    emitQwenServerEvent(firstSocket, { event_id: 'late-response-created', response: { id: 'late-response' }, type: 'response.created' })
    emitQwenServerEvent(firstSocket, { delta: 'AQIDBA==', event_id: 'late-response-audio', response_id: 'late-response', type: 'response.audio.delta' })
    expect(onError.mock.calls).toEqual([[{ category: 'transport-error', disposition: 'recoverable' }]])
    expect(onResponseCreated).not.toHaveBeenCalled()
    expect(onAudio).not.toHaveBeenCalled()

    firstSocket.close(1006, 'synthetic transport close')
    await vi.advanceTimersByTimeAsync(250)
    const secondSocket = socketFactory.mock.results[1]?.value
    if (!secondSocket)
      throw new Error('Expected the replacement Qwen socket.')
    secondSocket.readyState = 1
    secondSocket.emit('open')
    emitQwenServerEvent(secondSocket, { event_id: 'session-configured', type: 'session.updated' })
    expect(session.appendAudio(Buffer.from([3, 4]), 2)).toBe(true)
    emitQwenServerEvent(secondSocket, { event_id: 'input-2-committed', item_id: 'input-2', type: 'input_audio_buffer.committed' })
    emitQwenServerEvent(secondSocket, { event_id: 'response-2-created', response: { id: 'response-2' }, type: 'response.created' })
    emitQwenServerEvent(secondSocket, { delta: 'BQYHCA==', event_id: 'response-2-audio', response_id: 'response-2', type: 'response.audio.delta' })
    expect(onResponseCreated.mock.calls).toEqual([[{ responseId: 'response-2' }]])
    expect(onAudio.mock.calls).toEqual([[
      Buffer.from([5, 6, 7, 8]),
      { responseId: 'response-2' },
    ]])
  })

  /** @example it('rejects pre-configuration transport errors before late server events can configure the generation', async () => {}) */
  it('rejects pre-configuration transport errors before late server events can configure the generation', async () => {
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const onAssistantTranscript = vi.fn()
    const onAudio = vi.fn()
    const onError = vi.fn()
    const onResponseCreated = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    }), { socketFactory })
    const failedConnect = runtime.connect({ onAssistantTranscript, onAudio, onError, onResponseCreated })
    const firstSocket = socketFactory.mock.results[0]?.value
    if (!firstSocket)
      throw new Error('Expected the unconfigured Qwen socket.')
    firstSocket.readyState = 1
    firstSocket.emit('open')
    const rejected = expect(failedConnect).rejects.toEqual({
      category: 'transport-error',
      disposition: 'recoverable',
    })

    // ROOT CAUSE:
    //
    // An error before session.updated rejects connect, but the old generation
    // remained message-active until the rejected promise closed it. A provider
    // can synchronously deliver stale configuration and response events in
    // that error-to-close window, mutating a generation that never configured.
    firstSocket.emit('error', new Error('synthetic pre-configuration transport error'))
    emitQwenServerEvent(firstSocket, { event_id: 'late-preconfiguration-session', type: 'session.updated' })
    emitQwenServerEvent(firstSocket, {
      event_id: 'late-preconfiguration-response',
      response: { id: 'late-preconfiguration-response' },
      type: 'response.created',
    })
    emitQwenServerEvent(firstSocket, {
      delta: 'AQIDBA==',
      event_id: 'late-preconfiguration-audio',
      response_id: 'late-preconfiguration-response',
      type: 'response.audio.delta',
    })
    emitQwenServerEvent(firstSocket, {
      event_id: 'late-preconfiguration-transcript',
      response_id: 'late-preconfiguration-response',
      transcript: 'must not escape the rejected generation',
      type: 'response.audio_transcript.done',
    })

    await rejected
    firstSocket.emit('close', 1006, Buffer.from('late transport close'))
    expect(onError).not.toHaveBeenCalled()
    expect(onResponseCreated).not.toHaveBeenCalled()
    expect(onAudio).not.toHaveBeenCalled()
    expect(onAssistantTranscript).not.toHaveBeenCalled()
    expect(firstSocket.closes).toEqual([{
      code: 1000,
      reason: 'Qwen Realtime setup failed',
    }])

    const recoveredConnect = runtime.connect({ onAssistantTranscript, onAudio, onError, onResponseCreated })
    const secondSocket = socketFactory.mock.results[1]?.value
    if (!secondSocket)
      throw new Error('Expected the replacement Qwen socket.')
    secondSocket.readyState = 1
    secondSocket.emit('open')
    emitQwenServerEvent(secondSocket, { event_id: 'recovered-session', type: 'session.updated' })
    const recoveredSession = await recoveredConnect
    expect(recoveredSession.appendAudio(Buffer.from([5, 6]), 1)).toBe(true)
    emitQwenServerEvent(secondSocket, {
      event_id: 'recovered-input-committed',
      item_id: 'recovered-input',
      type: 'input_audio_buffer.committed',
    })
    emitQwenServerEvent(secondSocket, {
      event_id: 'recovered-response-created',
      response: { id: 'recovered-response' },
      type: 'response.created',
    })
    emitQwenServerEvent(secondSocket, {
      delta: 'BQY=',
      event_id: 'recovered-response-audio',
      response_id: 'recovered-response',
      type: 'response.audio.delta',
    })
    expect(onResponseCreated.mock.calls).toEqual([[
      { responseId: 'recovered-response' },
    ]])
    expect(onAudio.mock.calls).toEqual([[
      Buffer.from([5, 6]),
      { responseId: 'recovered-response' },
    ]])
  })

  /** @example it('owns a pre-configuration provider wire error as a terminal connect failure', async () => {}) */
  it('owns a pre-configuration provider wire error as a terminal connect failure', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const onAssistantTranscript = vi.fn()
    const onAudio = vi.fn()
    const onError = vi.fn()
    const onResponseCreated = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    }), { socketFactory: () => socket })
    const failedConnect = runtime.connect({ onAssistantTranscript, onAudio, onError, onResponseCreated })
    socket.readyState = 1
    socket.emit('open')
    // ROOT CAUSE:
    //
    // A provider wire error before session.updated notified onError but did
    // not own the pending connect promise or socket lifecycle. The following
    // late server events could therefore configure and revive that rejected
    // generation instead of being terminally contained.
    emitQwenServerEvent(socket, {
      event_id: 'preconfiguration-provider-error',
      type: 'error',
    })
    expect(onError.mock.calls).toEqual([[
      { category: 'provider-error', disposition: 'terminal' },
    ]])
    emitQwenServerEvent(socket, { event_id: 'late-provider-error-session', type: 'session.updated' })
    emitQwenServerEvent(socket, {
      event_id: 'late-provider-error-response',
      response: { id: 'late-provider-error-response' },
      type: 'response.created',
    })
    emitQwenServerEvent(socket, {
      delta: 'AQIDBA==',
      event_id: 'late-provider-error-audio',
      response_id: 'late-provider-error-response',
      type: 'response.audio.delta',
    })
    emitQwenServerEvent(socket, {
      event_id: 'late-provider-error-transcript',
      response_id: 'late-provider-error-response',
      transcript: 'must not escape the terminal provider error',
      type: 'response.audio_transcript.done',
    })

    await expect(failedConnect).rejects.toEqual({
      category: 'provider-error',
      disposition: 'terminal',
    })
    expect(onResponseCreated).not.toHaveBeenCalled()
    expect(onAudio).not.toHaveBeenCalled()
    expect(onAssistantTranscript).not.toHaveBeenCalled()
    socket.emit('close', 1006, Buffer.from('late transport close'))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(socket.closes).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  /** @example it('does not let an unsolicited item-only commit consume a later pending input', async () => {}) */
  it('does not let an unsolicited item-only commit consume a later pending input', async () => {
    const socket = new FakeSocket()
    const onError = vi.fn()
    const onInputCommitted = vi.fn()
    const session = await connectFakeQwen(socket, { onError, onInputCommitted })

    // ROOT CAUSE:
    //
    // An item-only commit is still a stable provider identity. Dropping an
    // unsolicited item without recording its semantic tombstone lets that old
    // item consume a later pending Discord capture when it is replayed.
    emitQwenServerEvent(socket, {
      item_id: 'old-item-only',
      type: 'input_audio_buffer.committed',
    })
    expect(session.appendAudio(Buffer.from([1, 2]), 7)).toBe(true)
    session.finishInput()
    emitQwenServerEvent(socket, {
      item_id: 'old-item-only',
      type: 'input_audio_buffer.committed',
    })
    expect(onInputCommitted).not.toHaveBeenCalled()
    emitQwenServerEvent(socket, {
      item_id: 'fresh-item-only',
      type: 'input_audio_buffer.committed',
    })
    expect(onInputCommitted.mock.calls).toEqual([[
      { inputSequence: 7, itemId: 'fresh-item-only' },
    ]])
    expect(onError).not.toHaveBeenCalled()
    session.close()
  })

  /** @example it('does not let a replayed item with a new delivery event consume a later pending input', async () => {}) */
  it('does not let a replayed item with a new delivery event consume a later pending input', async () => {
    const socket = new FakeSocket()
    const onError = vi.fn()
    const onInputCommitted = vi.fn()
    const session = await connectFakeQwen(socket, { onError, onInputCommitted })

    // ROOT CAUSE:
    //
    // event_id names a delivery, not the committed input. A new event_id must
    // not erase the prior item identity when that unsolicited provider item
    // is replayed after a local append becomes pending.
    emitQwenServerEvent(socket, {
      event_id: 'old-item-delivery-a',
      item_id: 'old-item-with-event',
      type: 'input_audio_buffer.committed',
    })
    expect(session.appendAudio(Buffer.from([3, 4]), 8)).toBe(true)
    session.finishInput()
    emitQwenServerEvent(socket, {
      event_id: 'old-item-delivery-b',
      item_id: 'old-item-with-event',
      type: 'input_audio_buffer.committed',
    })
    expect(onInputCommitted).not.toHaveBeenCalled()
    emitQwenServerEvent(socket, {
      event_id: 'fresh-item-delivery',
      item_id: 'fresh-item-with-event',
      type: 'input_audio_buffer.committed',
    })
    expect(onInputCommitted.mock.calls).toEqual([[
      { inputSequence: 8, itemId: 'fresh-item-with-event' },
    ]])
    expect(onError).not.toHaveBeenCalled()
    session.close()
  })

  /** @example it('fails closed for an assistant transcript without a delivery event identity', async () => {}) */
  it('fails closed for an assistant transcript without a delivery event identity', async () => {
    const socket = new FakeSocket()
    const onAssistantTranscript = vi.fn()
    const onError = vi.fn()
    const session = await connectFakeQwen(socket, { onAssistantTranscript, onError })
    expect(session.appendAudio(Buffer.from([1, 2]), 1)).toBe(true)
    emitQwenServerEvent(socket, { event_id: 'assistant-input-committed', item_id: 'assistant-input', type: 'input_audio_buffer.committed' })
    emitQwenServerEvent(socket, { event_id: 'assistant-response-created', response: { id: 'assistant-response' }, type: 'response.created' })

    // ROOT CAUSE:
    //
    // response_id identifies a lifecycle but cannot distinguish a duplicate
    // transcript delivery. A missing event_id therefore cannot be exact-once.
    emitQwenServerEvent(socket, { response_id: 'assistant-response', transcript: 'first assistant transcript', type: 'response.audio_transcript.done' })
    expect(onAssistantTranscript).not.toHaveBeenCalled()
    expect(onError.mock.calls).toEqual([[expect.objectContaining({ category: 'invalid-event', disposition: 'terminal' })]])
    expect(socket.closes).toEqual([{ code: 1000, reason: 'Qwen Realtime invalid server event' }])
  })

  /** @example it('fails closed for a user transcript without a delivery event identity', async () => {}) */
  it('fails closed for a user transcript without a delivery event identity', async () => {
    const socket = new FakeSocket()
    const onError = vi.fn()
    const onUserTranscript = vi.fn()
    await connectFakeQwen(socket, { onError, onUserTranscript })

    // ROOT CAUSE:
    //
    // item_id identifies the user item but not an individual transcript
    // delivery. Without event_id, a delayed provider replay cannot be deduped.
    emitQwenServerEvent(socket, { item_id: 'user-item', transcript: 'first user transcript', type: 'conversation.item.input_audio_transcription.completed' })
    expect(onUserTranscript).not.toHaveBeenCalled()
    expect(onError.mock.calls).toEqual([[expect.objectContaining({ category: 'invalid-event', disposition: 'terminal' })]])
    expect(socket.closes).toEqual([{ code: 1000, reason: 'Qwen Realtime invalid server event' }])
  })

  /** @example it('deduplicates assistant transcript semantics across distinct delivery event identities', async () => {}) */
  it('deduplicates assistant transcript semantics across distinct delivery event identities', async () => {
    const socket = new FakeSocket()
    const onAssistantTranscript = vi.fn()
    const session = await connectFakeQwen(socket, { onAssistantTranscript })
    expect(session.appendAudio(Buffer.from([1, 2]), 1)).toBe(true)
    emitQwenServerEvent(socket, { event_id: 'assistant-input-committed', item_id: 'assistant-input', type: 'input_audio_buffer.committed' })
    emitQwenServerEvent(socket, { event_id: 'assistant-response-created', response: { id: 'assistant-response' }, type: 'response.created' })

    // ROOT CAUSE:
    //
    // A new event_id bypasses delivery dedupe. Transcript delivery must still
    // be exactly-once for a stable response identity.
    emitQwenServerEvent(socket, { event_id: 'assistant-transcript-a', response_id: 'assistant-response', transcript: 'first assistant transcript', type: 'response.audio_transcript.done' })
    emitQwenServerEvent(socket, { event_id: 'assistant-transcript-b', response_id: 'assistant-response', transcript: 'second assistant transcript', type: 'response.audio_transcript.done' })
    expect(onAssistantTranscript.mock.calls).toEqual([[
      'first assistant transcript',
      { responseId: 'assistant-response' },
    ]])
  })

  /** @example it('deduplicates user transcript semantics across distinct delivery event identities', async () => {}) */
  it('deduplicates user transcript semantics across distinct delivery event identities', async () => {
    const socket = new FakeSocket()
    const onUserTranscript = vi.fn()
    await connectFakeQwen(socket, { onUserTranscript })

    // ROOT CAUSE:
    //
    // A new event_id bypasses delivery dedupe. User transcript delivery must
    // be exactly-once for a stable item identity.
    emitQwenServerEvent(socket, { event_id: 'user-transcript-a', item_id: 'user-item', transcript: 'first user transcript', type: 'conversation.item.input_audio_transcription.completed' })
    emitQwenServerEvent(socket, { event_id: 'user-transcript-b', item_id: 'user-item', transcript: 'second user transcript', type: 'conversation.item.input_audio_transcription.completed' })
    expect(onUserTranscript.mock.calls).toEqual([[
      'first user transcript',
      { itemId: 'user-item' },
    ]])
  })

  /** @example it('fails closed when mixed committed-input identities reach the shared capacity', async () => {}) */
  it('fails closed when mixed committed-input identities reach the shared capacity', async () => {
    const socket = new FakeSocket()
    const onError = vi.fn()
    const onInputCommitted = vi.fn()
    const onResponseCreated = vi.fn()
    const session = await connectFakeQwen(socket, { onError, onInputCommitted, onResponseCreated })

    // ROOT CAUSE:
    //
    // Item-only commits and event-only commits are independently admitted by
    // the current parser. The real runtime boundary is 65,535 identities, so
    // an event-only commit after 65,535 distinct item identities must fail
    // closed rather than silently consume a pending input forever.
    //
    // This exercises that production hard boundary through appendAudio and
    // formal server commits; a smaller, test-only threshold would not prove
    // the mixed-identity capacity contract.
    const committedInputIdentityCapacity = 65_535
    for (let inputSequence = 1; inputSequence <= committedInputIdentityCapacity; inputSequence += 1) {
      expect(session.appendAudio(Buffer.from([inputSequence & 0xFF, 0]), inputSequence)).toBe(true)
      if (inputSequence === 1)
        session.finishInput()
      emitQwenServerEvent(socket, {
        item_id: `mixed-capacity-item-${inputSequence}`,
        type: 'input_audio_buffer.committed',
      })
    }

    expect(onInputCommitted).toHaveBeenCalledTimes(committedInputIdentityCapacity)
    expect(onError).not.toHaveBeenCalled()
    expect(session.appendAudio(Buffer.from([0, 1]), committedInputIdentityCapacity + 1)).toBe(true)
    emitQwenServerEvent(socket, {
      event_id: 'mixed-capacity-overflow',
      type: 'input_audio_buffer.committed',
    })

    expect(onInputCommitted).toHaveBeenCalledTimes(committedInputIdentityCapacity)
    expect(onError.mock.calls).toEqual([[
      { category: 'invalid-event', disposition: 'terminal' },
    ]])
    expect(socket.closes).toEqual([{ code: 1000, reason: 'Qwen Realtime invalid server event' }])

    emitQwenServerEvent(socket, {
      event_id: 'mixed-capacity-late-response',
      response: { id: 'mixed-capacity-late-response' },
      type: 'response.created',
    })
    expect(onResponseCreated).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  /** @example it('does not let a duplicate committed item consume a newer pending input', async () => {}) */
  it('does not let a duplicate committed item consume a newer pending input', async () => {
    const socket = new FakeSocket()
    const onInputCommitted = vi.fn()
    const onResponseCreated = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    }), { socketFactory: () => socket })
    const sessionPromise = runtime.connect({ onInputCommitted, onResponseCreated })
    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise

    expect(session.appendAudio(Buffer.from([1, 2]), 1)).toBe(true)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'item-1-committed', item_id: 'item-1', type: 'input_audio_buffer.committed' })), false)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'response-1-created', response: { id: 'response-1' }, type: 'response.created' })), false)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'response-1-done', response: { id: 'response-1', status: 'completed' }, type: 'response.done' })), false)

    expect(session.appendAudio(Buffer.from([3, 4]), 2)).toBe(true)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'item-1-committed', item_id: 'item-1', type: 'input_audio_buffer.committed' })), false)

    // ROOT CAUSE:
    //
    // A delayed duplicate commit for an already terminal provider item must
    // not clear the newer pending input or manufacture another callback.
    expect(onInputCommitted.mock.calls).toEqual([[{ inputSequence: 1, itemId: 'item-1' }]])
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'item-2-committed', item_id: 'item-2', type: 'input_audio_buffer.committed' })), false)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'response-2-created', response: { id: 'response-2' }, type: 'response.created' })), false)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'response-2-done', response: { id: 'response-2', status: 'completed' }, type: 'response.done' })), false)
    expect(onInputCommitted.mock.calls).toEqual([
      [{ inputSequence: 1, itemId: 'item-1' }],
      [{ inputSequence: 2, itemId: 'item-2' }],
    ])
    expect(onResponseCreated.mock.calls).toEqual([
      [{ responseId: 'response-1' }],
      [{ responseId: 'response-2' }],
    ])
  })

  /** @example it('keeps a second committed response pending when response.created is duplicated', async () => {}) */
  it('keeps a second committed response pending when response.created is duplicated', async () => {
    const socket = new FakeSocket()
    const onResponseCreated = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    }), { socketFactory: () => socket })
    const sessionPromise = runtime.connect({ onResponseCreated })
    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    expect(session.appendAudio(Buffer.from([1, 2]), 1)).toBe(true)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'item-1-committed', item_id: 'item-1', type: 'input_audio_buffer.committed' })), false)
    expect(session.appendAudio(Buffer.from([3, 4]), 2)).toBe(true)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'item-2-committed', item_id: 'item-2', type: 'input_audio_buffer.committed' })), false)

    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'response-1-created', response: { id: 'response-1' }, type: 'response.created' })), false)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'response-1-created', response: { id: 'response-1' }, type: 'response.created' })), false)

    // ROOT CAUSE:
    //
    // Repeated provider response.created must not decrement the awaiting-input
    // count twice and make rotation consider response-2 nonexistent.
    expect(onResponseCreated.mock.calls).toEqual([[
      { responseId: 'response-1' },
    ]])
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'response-1-done', response: { id: 'response-1', status: 'completed' }, type: 'response.done' })), false)
    expect(socket.closes).toHaveLength(0)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'response-2-created', response: { id: 'response-2' }, type: 'response.created' })), false)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'response-2-done', response: { id: 'response-2', status: 'completed' }, type: 'response.done' })), false)
    expect(onResponseCreated.mock.calls).toEqual([
      [{ responseId: 'response-1' }],
      [{ responseId: 'response-2' }],
    ])
  })

  /** @example it('rejects append traffic on a recovered socket before its session configuration completes', async () => {}) */
  it('rejects append traffic on a recovered socket before its session configuration completes', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const onInputAudioSent = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    }), { socketFactory })
    const sessionPromise = runtime.connect({ onInputAudioSent })
    const first = socketFactory.mock.results[0]?.value
    if (!first)
      throw new Error('Expected the initial Qwen socket.')
    first.readyState = 1
    first.emit('open')
    first.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise

    first.emit('close', 1006, Buffer.from('synthetic transport loss'))
    await vi.advanceTimersByTimeAsync(250)
    const second = socketFactory.mock.results[1]?.value
    if (!second)
      throw new Error('Expected the recovered Qwen socket.')
    second.readyState = 1
    second.emit('open')

    // ROOT CAUSE:
    //
    // A transport OPEN event only proves a WebSocket handshake. The Qwen
    // session is not configured until the matching session.updated event, so
    // input sent in this interval can be accepted by a stale protocol state.
    expect(session.appendAudio(Buffer.from([1, 2]), 7)).toBe(false)
    expect(second.sent.map(frame => JSON.parse(frame).type)).toEqual(['session.update'])
    expect(onInputAudioSent).not.toHaveBeenCalled()

    second.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    expect(session.appendAudio(Buffer.from([3, 4]), 7)).toBe(true)
    expect(second.sent.map(frame => JSON.parse(frame).type)).toEqual([
      'session.update',
      'input_audio_buffer.append',
    ])
    expect(onInputAudioSent).toHaveBeenCalledWith({ byteLength: 2, chunkCount: 1, inputSequence: 7, kind: 'user-audio' })
  })

  /** @example it('ignores a retired duplicate response identity while a newer response is active', async () => {}) */
  it('ignores a retired duplicate response identity while a newer response is active', async () => {
    const socket = new FakeSocket()
    const onResponseCancelled = vi.fn()
    const onResponseCreated = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    }), { socketFactory: () => socket })
    const sessionPromise = runtime.connect({ onResponseCancelled, onResponseCreated })

    socket.readyState = 1
    socket.emit('open')
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise

    expect(session.appendAudio(Buffer.from([1, 2]), 1)).toBe(true)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'input-1-committed', item_id: 'input-1', type: 'input_audio_buffer.committed' })), false)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'response-1-created', response: { id: 'response-1' }, type: 'response.created' })), false)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'response-1-done', response: { id: 'response-1', status: 'completed' }, type: 'response.done' })), false)

    expect(session.appendAudio(Buffer.from([3, 4]), 2)).toBe(true)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'input-2-committed', item_id: 'input-2', type: 'input_audio_buffer.committed' })), false)
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'response-2-created', response: { id: 'response-2' }, type: 'response.created' })), false)

    // ROOT CAUSE:
    //
    // A late duplicate response.created previously replaced the active response
    // identity even after that response had reached its terminal boundary. A
    // subsequent cancel then targeted and reported the retired response twice.
    socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'response-1-created-late', response: { id: 'response-1' }, type: 'response.created' })), false)
    session.cancelResponse()
    session.cancelResponse()

    expect(onResponseCreated.mock.calls).toEqual([
      [{ responseId: 'response-1' }],
      [{ responseId: 'response-2' }],
    ])
    expect(socket.sent.map(frame => JSON.parse(frame)).filter(event => event.type === 'response.cancel')).toEqual([
      expect.objectContaining({ type: 'response.cancel' }),
    ])
    expect(onResponseCancelled.mock.calls).toEqual([[
      { responseId: 'response-2' },
    ]])
  })

  /**
   * @example
   * it('reconnects an established session after an unexpected socket close', async () => {})
   */
  it('reconnects an established session after an unexpected socket close', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const onClose = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    }), { socketFactory })
    const sessionPromise = runtime.connect({ onClose })
    const firstSocket = socketFactory.mock.results[0]?.value

    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise

    // ROOT CAUSE:
    //
    // The first unexpected Qwen WebSocket close permanently marked the public
    // session closed. VoiceManager then retained no usable upstream transport,
    // so every later Discord utterance was dropped until `/summon` ran again.
    //
    // An established call now keeps the same session handle and reconnects the
    // authenticated/configured socket with bounded backoff.
    firstSocket.close(1006, 'network lost')
    await vi.advanceTimersByTimeAsync(249)

    expect(socketFactory).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1)
    const secondSocket = socketFactory.mock.results[1]?.value
    secondSocket.readyState = 1
    secondSocket.emit('open')
    secondSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)

    expect(socketFactory).toHaveBeenCalledTimes(2)
    expect(onClose).not.toHaveBeenCalled()
    expect(session.appendAudio(Buffer.from([5, 6, 7, 8]), 1)).toBe(true)
    expect(JSON.parse(secondSocket.sent[1])).toMatchObject({
      audio: 'BQYHCA==',
      type: 'input_audio_buffer.append',
    })

    session.close()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(socketFactory).toHaveBeenCalledTimes(2)
  })

  /**
   * @example
   * it('fails closed once when recovery attempts are exhausted', async () => {})
   */
  it('fails closed once when recovery attempts are exhausted', async () => {
    vi.useFakeTimers()
    const firstSocket = new FakeSocket()
    const socketFactory = vi.fn(() => {
      if (socketFactory.mock.calls.length === 1)
        return firstSocket
      throw new Error('synthetic socket factory failure')
    })
    const onError = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    }), { socketFactory })
    const sessionPromise = runtime.connect({ onError })
    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    await sessionPromise

    firstSocket.close(1006, 'network lost')
    await vi.runAllTimersAsync()

    expect(socketFactory).toHaveBeenCalledTimes(6)
    expect(onError).toHaveBeenCalledWith({
      category: 'transport-exhausted',
      disposition: 'terminal',
    })
    expect(onError.mock.calls.filter(([failure]) => failure.category === 'transport-exhausted')).toHaveLength(1)
  })

  /**
   * @example
   * it('rotates a healthy socket before the provider session limit', async () => {})
   */
  it('rotates a healthy socket before the provider session limit', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      QWEN_REALTIME_WORKSPACE_ID: 'ws-airi-123',
    }), { socketFactory })
    const sessionPromise = runtime.connect()
    const firstSocket = socketFactory.mock.results[0]?.value

    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise

    // Qwen currently caps one Realtime connection at 120 minutes. Rotate ten
    // minutes early so a long Discord call does not hit the hard limit while
    // the model is generating or the user is speaking.
    await vi.advanceTimersByTimeAsync(110 * 60 * 1_000)
    await vi.advanceTimersByTimeAsync(1)

    expect(socketFactory).toHaveBeenCalledTimes(2)
    const secondSocket = socketFactory.mock.results[1]?.value
    secondSocket.readyState = 1
    secondSocket.emit('open')
    secondSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    expect(JSON.parse(secondSocket.sent[0])).toMatchObject({ type: 'session.update' })

    session.close()
  })

  /**
   * @example
   * it('reproduces Discord audit D-017 by preserving an active input turn until its response reaches idle', async () => {})
   */
  it('reproduces Discord audit D-017 by preserving an active input turn until its response reaches idle', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const onResponseDone = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const sessionPromise = runtime.connect({ onResponseDone })
    const firstSocket = socketFactory.mock.results[0]?.value

    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise

    // ROOT CAUSE:
    //
    // The fixed 110-minute timer closed the current WebSocket without checking
    // whether Discord audio was still pending, committed input was awaiting a
    // response, or provider output was active. The close handler then erased
    // those turn flags, so the buffered utterance and response were silently
    // lost before the replacement socket could be configured.
    //
    // Rotation now enters a generation-owned drain state. It closes only after
    // the current input, commit, and response reach a provider-confirmed idle
    // boundary; the same turn is never replayed or submitted twice.
    session.appendAudio(Buffer.from([1, 2, 3, 4]), 1)
    await vi.advanceTimersByTimeAsync(110 * 60 * 1_000)

    // @example
    expect(firstSocket.readyState).toBe(1)
    // @example
    expect(firstSocket.closes).toHaveLength(0)
    // @example
    expect(socketFactory).toHaveBeenCalledOnce()

    session.finishInput()
    await vi.advanceTimersByTimeAsync(600)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'drain-input-speech-started', item_id: 'drain-input', type: 'input_audio_buffer.speech_started' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'drain-input-committed', item_id: 'drain-input', type: 'input_audio_buffer.committed' })), false)

    // @example
    expect(firstSocket.closes).toHaveLength(0)

    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'drain-response-created', response: { id: 'drain-response' }, type: 'response.created' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'drain-response-done', response: { id: 'drain-response', status: 'completed' }, type: 'response.done' })), false)
    await vi.advanceTimersByTimeAsync(1)

    // @example
    expect(firstSocket.closes).toEqual([
      { code: 1000, reason: 'Qwen Realtime session rotation' },
    ])
    // @example
    expect(socketFactory).toHaveBeenCalledTimes(2)
    // @example
    expect(onResponseDone).toHaveBeenCalledOnce()
    // @example
    expect(firstSocket.sent.map(event => JSON.parse(event).type)).not.toContain('input_audio_buffer.commit')

    session.close()
  })

  /**
   * @example
   * it('reproduces Discord audit D-017 by not truncating active provider output', async () => {})
   */
  it('reproduces Discord audit D-017 by not truncating active provider output', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const onAudio = vi.fn()
    const onResponseDone = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const sessionPromise = runtime.connect({ onAudio, onResponseDone })
    const firstSocket = socketFactory.mock.results[0]?.value

    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'output-response-created', response: { id: 'output-response' }, type: 'response.created' })), false)

    await vi.advanceTimersByTimeAsync(110 * 60 * 1_000)

    // @example
    expect(firstSocket.readyState).toBe(1)
    // @example
    expect(socketFactory).toHaveBeenCalledOnce()

    firstSocket.emit('message', Buffer.from(JSON.stringify({ delta: 'BQYHCA==', event_id: 'output-response-audio-delta', response_id: 'output-response', type: 'response.audio.delta' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'output-response-audio-done', response_id: 'output-response', type: 'response.audio.done' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'output-response-done', response: { id: 'output-response', status: 'completed' }, type: 'response.done' })), false)
    await vi.advanceTimersByTimeAsync(1)

    // @example
    expect(onAudio).toHaveBeenCalledWith(Buffer.from([5, 6, 7, 8]), { responseId: 'output-response' })
    // @example
    expect(onResponseDone).toHaveBeenCalledOnce()
    // @example
    expect(firstSocket.closes).toHaveLength(1)
    // @example
    expect(socketFactory).toHaveBeenCalledTimes(2)

    session.close()
  })

  /**
   * @example
   * it('reproduces Discord audit D-017 by reporting bounded rotation grace without cutting the turn', async () => {})
   */
  it('reproduces Discord audit D-017 by reporting bounded rotation grace without cutting the turn', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const onError = vi.fn()
    const onWarning = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const sessionPromise = runtime.connect({ onError, onWarning })
    const firstSocket = socketFactory.mock.results[0]?.value

    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    session.appendAudio(Buffer.from([1, 2, 3, 4]), 1)

    // The drain grace ends two minutes before the provider's documented hard
    // lifetime, leaving a bounded window to finish the preserved turn safely.
    await vi.advanceTimersByTimeAsync(118 * 60 * 1_000)

    // @example
    expect(firstSocket.readyState).toBe(1)
    // @example
    expect(firstSocket.closes).toHaveLength(0)
    // @example
    expect(onWarning).toHaveBeenCalledOnce()
    // @example
    expect(onWarning).toHaveBeenCalledWith({
      category: 'rotation-overdue',
      disposition: 'recoverable',
    })
    // @example
    expect(onError).not.toHaveBeenCalled()

    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'overdue-input-committed', item_id: 'overdue-input', type: 'input_audio_buffer.committed' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'overdue-response-created', response: { id: 'overdue-response' }, type: 'response.created' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'overdue-response-done', response: { id: 'overdue-response', status: 'completed' }, type: 'response.done' })), false)
    await vi.advanceTimersByTimeAsync(1)

    // @example
    expect(firstSocket.closes).toHaveLength(1)
    // @example
    expect(socketFactory).toHaveBeenCalledTimes(2)
    // @example
    expect(onWarning).toHaveBeenCalledOnce()

    session.close()
  })

  /**
   * @example
   * it('reproduces Discord audit D-017 by failing active input observably before provider hard close', async () => {})
   */
  it('reproduces Discord audit D-017 by failing active input observably before provider hard close', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const onError = vi.fn()
    const onResponseDone = vi.fn()
    const onWarning = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const sessionPromise = runtime.connect({ onError, onResponseDone, onWarning })
    const firstSocket = socketFactory.mock.results[0]?.value

    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    session.appendAudio(Buffer.from([1, 2, 3, 4]), 1)

    // A warning at 118 minutes preserves the accepted turn. If it still has no
    // idle boundary at 119 minutes, the runtime emits an explicit safe failure
    // before closing, rather than waiting for a silent provider hard close.
    await vi.advanceTimersByTimeAsync(119 * 60 * 1_000)

    // @example
    expect(onWarning).toHaveBeenCalledOnce()
    // @example
    expect(onError).toHaveBeenCalledOnce()
    // @example
    expect(onError).toHaveBeenCalledWith({
      category: 'active-turn-timeout',
      disposition: 'terminal',
    })
    // @example
    expect(onResponseDone).not.toHaveBeenCalled()
    // @example
    expect(firstSocket.closes).toEqual([
      { code: 1000, reason: 'Qwen Realtime active-turn safety failure' },
    ])
    await vi.advanceTimersByTimeAsync(1)
    // @example
    expect(socketFactory).toHaveBeenCalledTimes(2)

    const secondSocket = socketFactory.mock.results[1]?.value
    secondSocket.readyState = 1
    secondSocket.emit('open')
    secondSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'old-generation-input-committed', item_id: 'old-generation-input', type: 'input_audio_buffer.committed' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'old-generation-response-created', response: { id: 'old-generation-response' }, type: 'response.created' })), false)
    firstSocket.emit('close', 1006, Buffer.from('late provider hard close'))

    // @example
    expect(onError).toHaveBeenCalledOnce()
    // @example
    expect(session.appendAudio(Buffer.from([5, 6, 7, 8]), 1)).toBe(true)

    session.close()
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-017 by ending active output observably before provider hard close', async () => {})
   */
  it('reproduces Discord audit D-017 by ending active output observably before provider hard close', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const onAudio = vi.fn()
    const onAudioDone = vi.fn()
    const onError = vi.fn()
    const onResponseDone = vi.fn()
    const onWarning = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const sessionPromise = runtime.connect({
      onAudio,
      onAudioDone,
      onError,
      onResponseDone,
      onWarning,
    })
    const firstSocket = socketFactory.mock.results[0]?.value

    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'timeout-response-created', response: { id: 'timeout-response' }, type: 'response.created' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ delta: 'AQIDBA==', event_id: 'timeout-response-audio', response_id: 'timeout-response', type: 'response.audio.delta' })), false)

    await vi.advanceTimersByTimeAsync(119 * 60 * 1_000)

    // @example
    expect(onWarning).toHaveBeenCalledOnce()
    // @example
    expect(onError).toHaveBeenCalledOnce()
    // @example
    expect(onAudio).toHaveBeenCalledOnce()
    // @example
    expect(onAudioDone).toHaveBeenCalledOnce()
    // @example
    expect(onResponseDone).toHaveBeenCalledOnce()
    // @example
    expect(onResponseDone).toHaveBeenCalledWith({ responseId: 'timeout-response' }, 'aborted')
    // @example
    expect(firstSocket.closes).toEqual([
      { code: 1000, reason: 'Qwen Realtime active-turn safety failure' },
    ])
    await vi.advanceTimersByTimeAsync(1)
    // @example
    expect(socketFactory).toHaveBeenCalledTimes(2)

    const secondSocket = socketFactory.mock.results[1]?.value
    secondSocket.readyState = 1
    secondSocket.emit('open')
    secondSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ delta: 'BQYHCA==', event_id: 'timeout-response-audio-late', response_id: 'timeout-response', type: 'response.audio.delta' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'timeout-response-done-late', response: { id: 'timeout-response', status: 'completed' }, type: 'response.done' })), false)
    firstSocket.emit('close', 1006, Buffer.from('late provider hard close'))

    // @example
    expect(onAudio).toHaveBeenCalledOnce()
    // @example
    expect(onAudioDone).toHaveBeenCalledOnce()
    // @example
    expect(onResponseDone).toHaveBeenCalledOnce()
    // @example
    expect(onError).toHaveBeenCalledOnce()
    // @example
    expect(session.appendAudio(Buffer.from([5, 6, 7, 8]), 1)).toBe(true)

    session.close()
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-017 by ignoring stale provider callbacks after rotation', async () => {})
   */
  it('reproduces Discord audit D-017 by ignoring stale provider callbacks after rotation', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const onAudio = vi.fn()
    const onError = vi.fn()
    const onInputCommitted = vi.fn()
    const onResponseCreated = vi.fn()
    const onSpeechStopped = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const sessionPromise = runtime.connect({
      onAudio,
      onError,
      onInputCommitted,
      onResponseCreated,
      onSpeechStopped,
    })
    const firstSocket = socketFactory.mock.results[0]?.value

    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    await vi.advanceTimersByTimeAsync(110 * 60 * 1_000 + 1)
    const secondSocket = socketFactory.mock.results[1]?.value

    secondSocket.readyState = 1
    secondSocket.emit('open')
    secondSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ delta: 'AQIDBA==', event_id: 'stale-response-audio', response_id: 'stale-response', type: 'response.audio.delta' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'completed-input-committed', item_id: 'completed-input', type: 'input_audio_buffer.committed' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'completed-input-speech-stopped', item_id: 'completed-input', type: 'input_audio_buffer.speech_stopped' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'stale-response-created', response: { id: 'stale-response' }, type: 'response.created' })), false)
    firstSocket.emit('error', new Error('stale synthetic socket error'))
    firstSocket.emit('close', 1006, Buffer.from('stale close'))

    // @example
    expect(onAudio).not.toHaveBeenCalled()
    // @example
    expect(onError).not.toHaveBeenCalled()
    // @example
    expect(onInputCommitted).not.toHaveBeenCalled()
    // @example
    expect(onSpeechStopped).not.toHaveBeenCalled()
    // @example
    expect(onResponseCreated).not.toHaveBeenCalled()
    // @example
    expect(socketFactory).toHaveBeenCalledTimes(2)
    // @example
    expect(session.appendAudio(Buffer.from([5, 6, 7, 8]), 1)).toBe(true)
    // @example
    expect(JSON.parse(secondSocket.sent[1])).toMatchObject({
      audio: 'BQYHCA==',
      type: 'input_audio_buffer.append',
    })

    session.close()
  })

  /**
   * @example
   * it('reproduces Discord audit D-017 by ignoring a duplicate commit after its response completed', async () => {})
   */
  it('reproduces Discord audit D-017 by ignoring a duplicate commit after its response completed', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const sessionPromise = runtime.connect()
    const firstSocket = socketFactory.mock.results[0]?.value

    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    session.appendAudio(Buffer.from([1, 2, 3, 4]), 1)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'completed-input-committed', item_id: 'completed-input', type: 'input_audio_buffer.committed' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'completed-response-created', response: { id: 'completed-response' }, type: 'response.created' })), false)
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'completed-response-done', response: { id: 'completed-response', status: 'completed' }, type: 'response.done' })), false)

    // ROOT CAUSE:
    //
    // A duplicate commit arriving after `response.done` recreated the local
    // awaiting-response flag even though no local input remained. Rotation then
    // treated an already-complete turn as active until the hard deadline.
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'completed-input-committed', item_id: 'completed-input', type: 'input_audio_buffer.committed' })), false)
    await vi.advanceTimersByTimeAsync(110 * 60 * 1_000 + 1)

    // @example
    expect(firstSocket.closes).toEqual([
      { code: 1000, reason: 'Qwen Realtime session rotation' },
    ])
    // @example
    expect(socketFactory).toHaveBeenCalledTimes(2)

    session.close()
  })

  /**
   * @example
   * it('reproduces Discord audit D-017 by cancelling deferred rotation when the session stops', async () => {})
   */
  it('reproduces Discord audit D-017 by cancelling deferred rotation when the session stops', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const onError = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const sessionPromise = runtime.connect({ onError })
    const firstSocket = socketFactory.mock.results[0]?.value

    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    session.appendAudio(Buffer.from([1, 2, 3, 4]), 1)
    await vi.advanceTimersByTimeAsync(110 * 60 * 1_000)
    session.close()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000)

    // @example
    expect(socketFactory).toHaveBeenCalledOnce()
    // @example
    expect(onError).not.toHaveBeenCalled()
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-017 by closing a replacement socket when stop races configuration', async () => {})
   */
  it('reproduces Discord audit D-017 by closing a replacement socket when stop races configuration', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const onError = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const sessionPromise = runtime.connect({ onError })
    const firstSocket = socketFactory.mock.results[0]?.value

    firstSocket.readyState = 1
    firstSocket.emit('open')
    firstSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const session = await sessionPromise
    await vi.advanceTimersByTimeAsync(110 * 60 * 1_000 + 1)
    const replacementSocket = socketFactory.mock.results[1]?.value

    // @example
    expect(replacementSocket.readyState).toBe(0)

    session.close()
    replacementSocket.readyState = 1
    replacementSocket.emit('open')
    replacementSocket.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    await vi.advanceTimersByTimeAsync(120 * 60 * 1_000)

    // @example
    expect(replacementSocket.closes).toEqual([
      { code: 1000, reason: 'Discord voice call ended' },
    ])
    // @example
    expect(socketFactory).toHaveBeenCalledTimes(2)
    // @example
    expect(onError).not.toHaveBeenCalled()
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('reproduces Discord audit D-017 by isolating rotation across simultaneous sessions', async () => {})
   */
  it('reproduces Discord audit D-017 by isolating rotation across simultaneous sessions', async () => {
    vi.useFakeTimers()
    const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket(), new FakeSocket()]
    const socketFactory = vi.fn(() => sockets.shift()!)
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory })
    const sessionAPromise = runtime.connect()
    const firstSocketA = socketFactory.mock.results[0]?.value
    const sessionBPromise = runtime.connect()
    const firstSocketB = socketFactory.mock.results[1]?.value

    firstSocketA.readyState = 1
    firstSocketA.emit('open')
    firstSocketA.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    firstSocketB.readyState = 1
    firstSocketB.emit('open')
    firstSocketB.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    const sessionA = await sessionAPromise
    const sessionB = await sessionBPromise
    sessionA.appendAudio(Buffer.from([1, 2, 3, 4]), 1)

    await vi.advanceTimersByTimeAsync(110 * 60 * 1_000 + 1)

    // @example
    expect(firstSocketA.readyState).toBe(1)
    // @example
    expect(firstSocketA.closes).toHaveLength(0)
    // @example
    expect(firstSocketB.closes).toHaveLength(1)
    // @example
    expect(socketFactory).toHaveBeenCalledTimes(3)

    firstSocketA.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-a-input-committed', item_id: 'session-a-input', type: 'input_audio_buffer.committed' })), false)
    firstSocketA.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-a-response-created', response: { id: 'session-a-response' }, type: 'response.created' })), false)
    firstSocketA.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-a-response-done', response: { id: 'session-a-response', status: 'completed' }, type: 'response.done' })), false)
    await vi.advanceTimersByTimeAsync(1)

    // @example
    expect(firstSocketA.closes).toHaveLength(1)
    // @example
    expect(socketFactory).toHaveBeenCalledTimes(4)

    sessionA.close()
    sessionB.close()
    // @example
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('exhausts alternating recovery failures on the documented five-attempt backoff budget', async () => {})
   */
  it('exhausts alternating factory, close, and configuration failures on the five-attempt backoff budget', async () => {
    vi.useFakeTimers()
    const initial = new FakeSocket()
    const immediateClose = new FakeSocket()
    const configurationTimeout = new FakeSocket()
    const finalClose = new FakeSocket()
    const factory = vi.fn(() => {
      switch (factory.mock.calls.length) {
        case 1: return initial
        case 2: throw new Error('synthetic factory failure')
        case 3: return immediateClose
        case 4: return configurationTimeout
        case 5: throw new Error('synthetic factory failure')
        case 6: return finalClose
        default: throw new Error('a sixth recovery socket must not be created')
      }
    })
    const onError = vi.fn()
    const runtime = new QwenRealtimeRuntime(resolveQwenRealtimeConfig({
      AIRI_DISCORD_VOICE_CALL_MODE: 'qwen-realtime',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-sentinel',
      QWEN_REALTIME_WORKSPACE_ID: 'synthetic-workspace',
    }), { socketFactory: factory })
    const sessionPromise = runtime.connect({ onError })
    initial.readyState = 1
    initial.emit('open')
    initial.emit('message', Buffer.from(JSON.stringify({ event_id: 'session-configured', type: 'session.updated' })), false)
    await sessionPromise

    initial.close(1006, 'transport lost')
    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(500)
    immediateClose.close(1006, 'immediate close')
    await vi.advanceTimersByTimeAsync(1_000)
    configurationTimeout.readyState = 1
    configurationTimeout.emit('open')
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(4_000)
    finalClose.close(1006, 'final close')

    expect(factory).toHaveBeenCalledTimes(6)
    expect(onError.mock.calls.filter(([failure]) => failure.category === 'transport-exhausted')).toEqual([
      [{ category: 'transport-exhausted', disposition: 'terminal' }],
    ])
    expect(vi.getTimerCount()).toBe(0)
  })
})
