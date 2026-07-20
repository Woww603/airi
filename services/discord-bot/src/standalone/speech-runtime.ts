import type { Buffer } from 'node:buffer'

import type { OpenAITextToSpeechConfig, OpenAITranscriptionConfig, SpeechProviderRequestOptions } from '../pipelines/openai-speech'

import { describeOpenAICompatibleProvider, executeSpeechProviderRequest, synthesizeOpenAICompatible, transcribeOpenAICompatible } from '../pipelines/openai-speech'

const DEFAULT_STT_MODEL = 'whisper-1'
const DEFAULT_TTS_MODEL = 'tts-1'
const DEFAULT_TTS_VOICE = 'alloy'
const DEFAULT_STT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_TTS_REQUEST_TIMEOUT_MS = 30_000

/**
 * STT and TTS provider settings for standalone Discord voice chat.
 */
export interface StandaloneSpeechRuntimeConfig {
  /** Batch speech-to-text settings. */
  stt: OpenAITranscriptionConfig
  /** Maximum STT provider duration when the voice turn has no earlier deadline. @default 30000 */
  sttRequestTimeoutMs?: number
  /** Text-to-speech settings for AIRI replies. */
  tts: OpenAITextToSpeechConfig
  /** Maximum TTS provider duration when the voice turn has no earlier deadline. @default 30000 */
  ttsRequestTimeoutMs?: number
}

/**
 * External speech provider operations used by the standalone runtime.
 */
export interface StandaloneSpeechRuntimeProviders {
  /** Converts one bounded WAV utterance into text. */
  transcribe: (wavBuffer: Buffer, config: OpenAITranscriptionConfig, options?: SpeechProviderRequestOptions) => Promise<string>
  /** Converts the final spoken reply text into provider audio bytes. */
  synthesize: (text: string, config: OpenAITextToSpeechConfig, options?: SpeechProviderRequestOptions) => Promise<ArrayBuffer>
}

function optionalText(value: string | undefined) {
  return value?.trim() || undefined
}

/**
 * Normalizes a standalone speech-provider timeout.
 *
 * Before:
 * - `"600000"`
 * - `"not-a-number"`
 *
 * After:
 * - `120000`
 * - the supplied fallback
 */
function normalizeSpeechRequestTimeout(
  value: number | string | undefined,
  fallback: number,
): number {
  const parsed = typeof value === 'number'
    ? value
    : Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed))
    return fallback

  // Five seconds rejects accidental near-zero configuration while two minutes
  // remains a hard ceiling for a single STT or TTS network request.
  return Math.min(120_000, Math.max(5_000, Math.trunc(parsed)))
}

/**
 * Resolves standalone STT and TTS settings without depending on AIRI desktop state.
 *
 * Use when:
 * - The standalone controller reads `.env.local` for a bot start or restart.
 * - STT and TTS may share one OpenAI-compatible speech provider credential.
 *
 * Expects:
 * - Provider-specific model and voice identifiers may override the defaults.
 *
 * Returns:
 * - Separate STT and TTS settings; TTS falls back to the STT credential and base URL.
 */
export function resolveStandaloneSpeechRuntimeConfig(env: NodeJS.ProcessEnv): StandaloneSpeechRuntimeConfig {
  const sttApiKey = optionalText(env.OPENAI_STT_API_KEY)
  const sttBaseURL = optionalText(env.OPENAI_STT_API_BASE_URL)

  return {
    stt: {
      apiKey: sttApiKey,
      baseURL: sttBaseURL,
      model: optionalText(env.OPENAI_STT_MODEL) ?? DEFAULT_STT_MODEL,
    },
    sttRequestTimeoutMs: normalizeSpeechRequestTimeout(
      env.AIRI_DISCORD_STT_TIMEOUT_MS,
      DEFAULT_STT_REQUEST_TIMEOUT_MS,
    ),
    tts: {
      apiKey: optionalText(env.OPENAI_TTS_API_KEY) ?? sttApiKey,
      baseURL: optionalText(env.OPENAI_TTS_API_BASE_URL) ?? sttBaseURL,
      model: optionalText(env.OPENAI_TTS_MODEL) ?? DEFAULT_TTS_MODEL,
      voice: optionalText(env.OPENAI_TTS_VOICE) ?? DEFAULT_TTS_VOICE,
    },
    ttsRequestTimeoutMs: normalizeSpeechRequestTimeout(
      env.AIRI_DISCORD_TTS_TIMEOUT_MS,
      DEFAULT_TTS_REQUEST_TIMEOUT_MS,
    ),
  }
}

/**
 * Owns standalone Discord speech provider calls and configuration readiness.
 *
 * Use when:
 * - Discord voice input needs batch STT without AIRI desktop.
 * - A final standalone model reply needs TTS bytes for Discord playback.
 *
 * Expects:
 * - Both STT and TTS API keys are configured before `/summon` is accepted.
 *
 * Returns:
 * - Provider text for STT and binary Ogg Opus audio for TTS.
 */
export class StandaloneSpeechRuntime {
  private readonly config: StandaloneSpeechRuntimeConfig
  private readonly providers: StandaloneSpeechRuntimeProviders
  private readonly providersOwnRequestBoundary: boolean

  constructor(
    config: StandaloneSpeechRuntimeConfig,
    providers?: StandaloneSpeechRuntimeProviders,
  ) {
    this.config = config
    this.providersOwnRequestBoundary = providers === undefined
    this.providers = providers ?? {
      synthesize: synthesizeOpenAICompatible,
      transcribe: transcribeOpenAICompatible,
    }
  }

  /** Returns whether both speech directions have provider credentials. */
  isConfigured(): boolean {
    return Boolean(this.config.stt.apiKey && this.config.tts.apiKey)
  }

  /** Returns non-secret STT/TTS provider labels for the public voice consent message. */
  getProviderDisclosure(): { stt: string, tts: string } {
    return {
      stt: describeOpenAICompatibleProvider(this.config.stt.baseURL),
      tts: describeOpenAICompatibleProvider(this.config.tts.baseURL),
    }
  }

  /** Converts one Discord WAV utterance into provider text. */
  async transcribe(wavBuffer: Buffer, options?: SpeechProviderRequestOptions): Promise<string> {
    if (!this.config.stt.apiKey)
      throw new Error('OPENAI_STT_API_KEY is required for standalone Discord voice chat.')

    const requestTimeoutMs = normalizeSpeechRequestTimeout(
      this.config.sttRequestTimeoutMs,
      DEFAULT_STT_REQUEST_TIMEOUT_MS,
    )
    if (this.providersOwnRequestBoundary) {
      return this.providers.transcribe(wavBuffer, this.config.stt, {
        ...options,
        requestTimeoutMs,
      })
    }

    return executeSpeechProviderRequest(
      'transcription',
      options ?? {},
      requestTimeoutMs,
      boundedOptions => this.providers.transcribe(wavBuffer, this.config.stt, boundedOptions),
    )
  }

  /** Converts final AIRI reply text into Ogg Opus bytes for Discord playback. */
  async synthesize(text: string, options?: SpeechProviderRequestOptions): Promise<ArrayBuffer> {
    if (!this.config.tts.apiKey)
      throw new Error('OPENAI_TTS_API_KEY or OPENAI_STT_API_KEY is required for standalone Discord voice chat.')

    const requestTimeoutMs = normalizeSpeechRequestTimeout(
      this.config.ttsRequestTimeoutMs,
      DEFAULT_TTS_REQUEST_TIMEOUT_MS,
    )
    if (this.providersOwnRequestBoundary) {
      return this.providers.synthesize(text, this.config.tts, {
        ...options,
        requestTimeoutMs,
      })
    }

    return executeSpeechProviderRequest(
      'synthesis',
      options ?? {},
      requestTimeoutMs,
      boundedOptions => this.providers.synthesize(text, this.config.tts, boundedOptions),
    )
  }
}
