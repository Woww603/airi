import type { Buffer } from 'node:buffer'

import { createOpenAI } from '@xsai-ext/providers/create'
import { generateSpeech } from '@xsai/generate-speech'
import { generateTranscription } from '@xsai/generate-transcription'

import { CLASSIC_DISCORD_VOICE_AUDIO_FORMAT } from './classic-voice-audio'

/**
 * A direct OpenAI-compatible speech request is capped even when a caller does
 * not provide a narrower voice-turn deadline. This is a provider safety limit,
 * not a retry interval; retrying the same participant audio could double-submit it.
 */
const DEFAULT_OPENAI_SPEECH_REQUEST_TIMEOUT_MS = 30_000
/**
 * Providers that ignore AbortSignal remain tracked until their real promise
 * settles. The cap fails closed before another request starts, preventing a
 * timeout storm from creating unbounded detached fetches.
 */
const MAX_ACTIVE_SPEECH_PROVIDER_TASKS = 64
/** Leaves capacity for a new exact speaker generation when active owners are busy. */
const RESERVED_SPEECH_PROVIDER_TASKS_FOR_NEW_OWNERS = 16
/** One non-cooperative speaker generation cannot consume the process registry. */
const MAX_ACTIVE_SPEECH_PROVIDER_TASKS_PER_OWNER = 4
/** One Discord participant may retain one full replacement generation, but no more. */
const MAX_ACTIVE_SPEECH_PROVIDER_TASKS_PER_PRINCIPAL = 8

interface ActiveSpeechProviderTask {
  ownerKey: string
  principalKey: string
  task: Promise<unknown>
}

const activeSpeechProviderTasks = new Set<ActiveSpeechProviderTask>()

/**
 * OpenAI-compatible speech-to-text request settings.
 */
export interface OpenAITranscriptionConfig {
  /** API key sent only to the configured speech provider. */
  apiKey?: string
  /** Optional OpenAI-compatible API base URL. */
  baseURL?: string
  /** Speech-to-text model identifier. */
  model?: string
}

/**
 * OpenAI-compatible text-to-speech request settings.
 */
export interface OpenAITextToSpeechConfig {
  /** API key sent only to the configured speech provider. */
  apiKey?: string
  /** Optional OpenAI-compatible API base URL. */
  baseURL?: string
  /** Text-to-speech model identifier. */
  model: string
  /** Voice identifier understood by the configured provider. */
  voice: string
}

/** Cancellation controls shared by one external speech-provider request. */
export interface SpeechProviderRequestOptions {
  /** Cancels the provider fetch when its Discord voice generation is invalidated. @default undefined */
  abortSignal?: AbortSignal
  /** Absolute wall-clock deadline shared by STT, chat, TTS, and audio handoff. @default The owning boundary's configured request deadline. */
  deadlineAt?: number
  /** Maximum provider duration when `deadlineAt` is absent or later. @default 30000 */
  requestTimeoutMs?: number
  /** Exact guild/channel/generation/user owner for late-result identity and the per-generation cap. @default "unscoped" */
  ownerKey?: string
  /** Stable participant identity that owns cross-generation fairness. @default The normalized `ownerKey` */
  principalKey?: string
}

/** Sanitized failure categories exposed by the shared speech-provider boundary. */
export type SpeechProviderFailureKind = 'cancelled' | 'provider-failure' | 'timeout'

/**
 * Sanitized error from an external speech-provider request.
 *
 * Use when:
 * - A Discord voice lifecycle cancels exact-generation STT or TTS work.
 * - A provider deadline expires or the provider rejects its request.
 *
 * Expects:
 * - Provider response bodies, URLs, credentials, prompts, and transcripts are not copied into `message`.
 *
 * Returns:
 * - A stable category suitable for structured logs and user-safe status mapping.
 */
export class SpeechProviderRequestError extends Error {
  /** Stable category that does not expose provider response details. */
  readonly kind: SpeechProviderFailureKind

  constructor(kind: SpeechProviderFailureKind, operation: 'synthesis' | 'transcription') {
    const operationLabel = operation === 'transcription' ? 'transcription' : 'synthesis'
    const message = kind === 'timeout'
      ? `Speech ${operationLabel} request timed out.`
      : kind === 'cancelled'
        ? `Speech ${operationLabel} request was cancelled.`
        : `Speech ${operationLabel} provider failed.`
    super(message)
    this.kind = kind
    this.name = kind === 'timeout'
      ? 'SpeechProviderTimeoutError'
      : kind === 'cancelled'
        ? 'SpeechProviderCancelledError'
        : 'SpeechProviderFailureError'
  }
}

/**
 * Rejects speech work before provider start when detached work reaches a hard bound.
 *
 * Use when:
 * - A non-cooperative provider keeps timed-out requests alive until real settlement.
 * - Per-owner or process capacity must fail closed without retaining new audio/text.
 *
 * Expects:
 * - The caller maps `provider-failure` to a user-safe retry status.
 *
 * Returns:
 * - A sanitized provider failure without endpoint, credential, or input details.
 */
export class SpeechProviderCapacityError extends SpeechProviderRequestError {
  constructor(operation: 'synthesis' | 'transcription') {
    super('provider-failure', operation)
    this.message = `Speech ${operation} provider capacity is temporarily exhausted.`
    this.name = 'SpeechProviderCapacityError'
  }
}

/**
 * Normalizes a provider owner without retaining unbounded caller-controlled text.
 *
 * Before:
 * - `" guild:channel:generation:user "`
 * - `undefined`
 *
 * After:
 * - `"guild:channel:generation:user"`
 * - `"unscoped"`
 */
function normalizeSpeechProviderOwnerKey(ownerKey: string | undefined): string {
  return ownerKey?.trim().slice(0, 256) || 'unscoped'
}

/**
 * Normalizes a stable provider fairness principal without parsing owner strings.
 *
 * Before:
 * - `" user-id "`
 * - `undefined` with owner `"guild:channel:generation:user"`
 *
 * After:
 * - `"user-id"`
 * - `"guild:channel:generation:user"`
 */
function normalizeSpeechProviderPrincipalKey(
  principalKey: string | undefined,
  ownerKey: string,
): string {
  return principalKey?.trim().slice(0, 256) || ownerKey
}

function hasSpeechProviderCapacity(ownerKey: string, principalKey: string): boolean {
  let ownerTaskCount = 0
  let principalTaskCount = 0
  for (const record of activeSpeechProviderTasks) {
    if (record.ownerKey === ownerKey)
      ownerTaskCount += 1
    if (record.principalKey === principalKey)
      principalTaskCount += 1
  }

  if (ownerTaskCount >= MAX_ACTIVE_SPEECH_PROVIDER_TASKS_PER_OWNER)
    return false
  if (principalTaskCount >= MAX_ACTIVE_SPEECH_PROVIDER_TASKS_PER_PRINCIPAL)
    return false
  if (activeSpeechProviderTasks.size >= MAX_ACTIVE_SPEECH_PROVIDER_TASKS)
    return false

  // Existing participants cannot consume the reserved tail by rotating their
  // generation key. A genuinely different participant can therefore start
  // unless the full process-level bound is occupied.
  return principalTaskCount === 0
    || activeSpeechProviderTasks.size < MAX_ACTIVE_SPEECH_PROVIDER_TASKS - RESERVED_SPEECH_PROVIDER_TASKS_FOR_NEW_OWNERS
}

function cancellationError(
  signal: AbortSignal,
  operation: 'synthesis' | 'transcription',
): SpeechProviderRequestError {
  return signal.reason instanceof SpeechProviderRequestError
    ? signal.reason
    : new SpeechProviderRequestError('cancelled', operation)
}

/**
 * Runs one external speech request behind an absolute deadline and lifecycle signal.
 *
 * Use when:
 * - STT or TTS providers may ignore `AbortSignal` or never settle.
 * - Late provider resolution must be detached from the Discord voice generation.
 *
 * Expects:
 * - `request` performs only the external provider operation and honors the supplied signal when possible.
 * - `timeoutMs` is the maximum duration when the caller has no earlier absolute deadline.
 *
 * Returns:
 * - The provider result, or a sanitized timeout/cancellation/provider failure.
 */
export async function executeSpeechProviderRequest<T>(
  operation: 'synthesis' | 'transcription',
  options: SpeechProviderRequestOptions,
  timeoutMs: number,
  request: (boundedOptions: { abortSignal: AbortSignal, deadlineAt: number }) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now()
  const boundedTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.min(120_000, Math.max(1, timeoutMs))
    : DEFAULT_OPENAI_SPEECH_REQUEST_TIMEOUT_MS
  const timeoutDeadlineAt = startedAt + boundedTimeoutMs
  const requestedDeadlineAt = options.deadlineAt !== undefined && Number.isFinite(options.deadlineAt)
    ? options.deadlineAt
    : timeoutDeadlineAt
  const deadlineAt = Math.min(requestedDeadlineAt, timeoutDeadlineAt)

  if (options.abortSignal?.aborted)
    throw cancellationError(options.abortSignal, operation)
  if (deadlineAt <= startedAt)
    throw new SpeechProviderRequestError('timeout', operation)

  const requestController = new AbortController()
  const ownerKey = normalizeSpeechProviderOwnerKey(options.ownerKey)
  const principalKey = normalizeSpeechProviderPrincipalKey(options.principalKey, ownerKey)
  let lifecycleAbortHandler: (() => void) | undefined
  let rejectBoundary = (_error: SpeechProviderRequestError) => {}
  const cancellationBoundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject
  })
  const cancel = (error: SpeechProviderRequestError) => {
    if (requestController.signal.aborted)
      return

    requestController.abort(error)
    rejectBoundary(error)
  }
  const expire = () => {
    const error = new SpeechProviderRequestError('timeout', operation)
    cancel(error)
    return error
  }

  const lifecycleSignal = options.abortSignal
  if (lifecycleSignal) {
    lifecycleAbortHandler = () => cancel(cancellationError(lifecycleSignal, operation))
    lifecycleSignal.addEventListener('abort', lifecycleAbortHandler, { once: true })
    if (lifecycleSignal.aborted)
      lifecycleAbortHandler()
  }

  // The timer owns the absolute provider deadline. It is cleared on every
  // success/failure/cancellation path so fake-clock and long-running sessions
  // cannot accumulate detached timeout handles.
  const deadlineTimer = setTimeout(() => {
    cancel(new SpeechProviderRequestError('timeout', operation))
  }, Math.max(0, deadlineAt - startedAt))

  const providerPromise = Promise.resolve().then(() => {
    if (requestController.signal.aborted)
      throw cancellationError(requestController.signal, operation)
    if (lifecycleSignal?.aborted)
      throw cancellationError(lifecycleSignal, operation)
    if (Date.now() >= deadlineAt)
      throw expire()
    if (!hasSpeechProviderCapacity(ownerKey, principalKey))
      throw new SpeechProviderCapacityError(operation)

    let task: Promise<T>
    try {
      task = request({
        abortSignal: requestController.signal,
        deadlineAt,
      })
    }
    catch {
      throw new SpeechProviderRequestError('provider-failure', operation)
    }

    const record: ActiveSpeechProviderTask = { ownerKey, principalKey, task }
    activeSpeechProviderTasks.add(record)
    void task.then(
      () => activeSpeechProviderTasks.delete(record),
      () => activeSpeechProviderTasks.delete(record),
    )
    return task
  })

  try {
    const result = await Promise.race([providerPromise, cancellationBoundary])
    if (requestController.signal.aborted)
      throw cancellationError(requestController.signal, operation)
    if (lifecycleSignal?.aborted)
      throw cancellationError(lifecycleSignal, operation)
    if (Date.now() >= deadlineAt)
      throw expire()
    return result
  }
  catch (error) {
    if (requestController.signal.aborted)
      throw cancellationError(requestController.signal, operation)
    if (lifecycleSignal?.aborted)
      throw cancellationError(lifecycleSignal, operation)
    if (Date.now() >= deadlineAt)
      throw expire()
    if (error instanceof SpeechProviderRequestError)
      throw error

    // Provider details can contain endpoint URLs, response bodies, or echoed
    // input. Preserve observability through the stable category, not raw text.
    throw new SpeechProviderRequestError('provider-failure', operation)
  }
  finally {
    clearTimeout(deadlineTimer)
    if (lifecycleSignal && lifecycleAbortHandler)
      lifecycleSignal.removeEventListener('abort', lifecycleAbortHandler)
  }
}

/**
 * Describes an OpenAI-compatible provider without exposing credentials or URL paths.
 *
 * Use when:
 * - Discord must publicly disclose the actual speech vendor/host before capture.
 * - A custom compatible endpoint needs a stable, non-secret participant label.
 *
 * Expects:
 * - `baseURL` may be absent for OpenAI's default endpoint.
 *
 * Returns:
 * - A provider label containing at most the normalized endpoint host.
 */
export function describeOpenAICompatibleProvider(baseURL?: string): string {
  if (!baseURL?.trim())
    return 'OpenAI at api.openai.com'

  try {
    const host = new URL(baseURL).host
    return host === 'api.openai.com'
      ? 'OpenAI at api.openai.com'
      : `the OpenAI-compatible provider at ${host}`
  }
  catch {
    return 'the configured OpenAI-compatible provider'
  }
}

/**
 * Sends one bounded WAV utterance to an OpenAI-compatible transcription endpoint.
 *
 * Use when:
 * - Discord audio has already been decoded and wrapped as WAV.
 * - Bridge and standalone modes need the same remote STT contract.
 *
 * Expects:
 * - `wavBuffer` contains one complete WAV utterance.
 *
 * Returns:
 * - Provider transcription text without logging the spoken content.
 */
export async function transcribeOpenAICompatible(
  wavBuffer: Buffer,
  config: OpenAITranscriptionConfig,
  options: SpeechProviderRequestOptions = {},
) {
  return executeSpeechProviderRequest('transcription', options, options.requestTimeoutMs ?? DEFAULT_OPENAI_SPEECH_REQUEST_TIMEOUT_MS, async (boundedOptions) => {
    const provider = createOpenAI(config.apiKey ?? '', config.baseURL)
    const wavFile = new Blob([Uint8Array.from(wavBuffer)], { type: 'audio/wav' })
    const result = await generateTranscription({
      ...provider.transcription(config.model ?? 'whisper-1'),
      abortSignal: boundedOptions.abortSignal,
      file: wavFile,
    })

    return result.text
  })
}

/**
 * Sends final spoken text to an OpenAI-compatible speech endpoint.
 *
 * Use when:
 * - Standalone AIRI has produced the final reply shown to the conversation runtime.
 * - Discord needs Ogg Opus bytes for direct voice playback.
 *
 * Expects:
 * - `text` is the final TTS target, not raw provider or stored text.
 *
 * Returns:
 * - Ogg Opus audio bytes returned by the configured speech provider.
 */
export async function synthesizeOpenAICompatible(
  text: string,
  config: OpenAITextToSpeechConfig,
  options: SpeechProviderRequestOptions = {},
) {
  return executeSpeechProviderRequest('synthesis', options, options.requestTimeoutMs ?? DEFAULT_OPENAI_SPEECH_REQUEST_TIMEOUT_MS, async (boundedOptions) => {
    const provider = createOpenAI(config.apiKey ?? '', config.baseURL)
    return generateSpeech({
      ...provider.speech(config.model),
      abortSignal: boundedOptions.abortSignal,
      input: text,
      responseFormat: CLASSIC_DISCORD_VOICE_AUDIO_FORMAT.providerResponseFormat,
      voice: config.voice,
    })
  })
}
