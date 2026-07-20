/** Discord's documented message-content limit, measured in UTF-16 code units. */
export const DISCORD_TEXT_MAX_LENGTH = 2_000

/** One exact Discord principal may retain only four non-cancellable reference fetches. */
const MAX_ACTIVE_REFERENCE_FETCHES_PER_PRINCIPAL = 4

/** Bounds non-cancellable Discord reference fetches across both adapter modes. */
const MAX_ACTIVE_REFERENCE_FETCHES = 32

/** Keeps capacity available for a replacement adapter lifecycle after old fetches hang. */
const RESERVED_REFERENCE_FETCHES_FOR_NEW_OWNERS = 8

/** A reply reference must resolve quickly enough to remain part of current ingress. */
const DEFAULT_REFERENCE_FETCH_TIMEOUT_MS = 5_000

/** Bounds non-cancellable Discord REST work across adapter instances and lifecycle churn. */
const MAX_ACTIVE_DISCORD_TRANSPORTS = 32

/** One trusted stable principal cannot retain more than four non-cancellable REST calls. */
const MAX_ACTIVE_DISCORD_TRANSPORTS_PER_PRINCIPAL = 4

/** Keeps global slots available when an existing principal has hanging REST calls. */
const RESERVED_DISCORD_TRANSPORTS_FOR_NEW_PRINCIPALS = 8

interface ActiveReferenceFetch {
  principalKey: string
  task: Promise<unknown>
}

const activeReferenceFetches = new Set<ActiveReferenceFetch>()

interface ActiveDiscordTransport {
  principalKey: string
  task: Promise<unknown>
}

const activeDiscordTransports = new Set<ActiveDiscordTransport>()

/**
 * Discord text payload that suppresses model-generated user, role, and everyone mentions.
 */
export interface SafeDiscordTextPayload {
  /** Discord mention policy applied to all generated bot output. */
  allowedMentions: {
    /** Empty so model output is always treated as text instead of a notification command. */
    parse: []
  }
  /** Visible message text. */
  content: string
}

/** Stable reasons Discord text cannot be safely partitioned. */
export type DiscordTextChunkingErrorKind = 'grapheme-too-long' | 'segmenter-unavailable'

/**
 * Sanitized failure raised before any Discord send when text cannot be chunked safely.
 */
export class DiscordTextChunkingError extends Error {
  /** Stable failure category without any model-generated content. */
  readonly kind: DiscordTextChunkingErrorKind

  constructor(kind: DiscordTextChunkingErrorKind) {
    super(kind === 'segmenter-unavailable'
      ? 'Discord text delivery requires a grapheme segmenter.'
      : 'Discord text contains a grapheme larger than the message limit.')
    this.kind = kind
    this.name = 'DiscordTextChunkingError'
  }
}

/**
 * Sanitized partial-delivery failure for one ordered Discord reply.
 */
export class DiscordTextDeliveryError extends Error {
  /** Chunks confirmed by the Discord send boundary before failure. */
  readonly deliveredChunks: number
  /** Number of chunks in the original exact text. */
  readonly totalChunks: number
  /** Fixed owning-boundary reason; never a Discord.js error message. */
  readonly reason: 'capacity' | 'send-failure'

  constructor(deliveredChunks: number, totalChunks: number, reason: 'capacity' | 'send-failure' = 'send-failure') {
    super('Discord text delivery failed before every chunk was sent.')
    this.deliveredChunks = deliveredChunks
    this.name = 'DiscordTextDeliveryError'
    this.reason = reason
    this.totalChunks = totalChunks
  }
}

/** Sanitized signal that shared Discord REST capacity is exhausted. */
export class DiscordTransportCapacityError extends Error {
  constructor() {
    super('Discord transport capacity is temporarily exhausted.')
    this.name = 'DiscordTransportCapacityError'
  }
}

/** Result of admitting one raw non-cancellable Discord REST operation. */
export type DiscordTransportStartResult<T>
  = | { accepted: true, task: Promise<T> }
    | { accepted: false, activeTransportCount: number, reason: 'capacity' }

/** Result of waiting for raw Discord transport or exact lifecycle cancellation. */
export type DiscordTransportBoundaryResult<T>
  = | { completed: true, value: T }
    | { completed: false }

/**
 * Result of one ordered Discord text delivery.
 */
export interface DiscordTextDeliveryResult {
  /** Chunks confirmed by the transport boundary. */
  deliveredChunks: number
  /** Whether all chunks were sent or lifecycle cancellation stopped the sequence. */
  status: 'cancelled' | 'delivered'
  /** Total chunks derived from the exact source text. */
  totalChunks: number
}

/**
 * Lifecycle controls for one shared Discord text delivery.
 */
export interface DiscordTextDeliveryOptions {
  /** Additional generation gate checked before and after each external send. */
  isActive?: () => boolean
  /** Exact turn or adapter lifecycle cancellation signal. */
  signal?: AbortSignal
}

/**
 * Input required to verify that a Discord message replies to the current bot.
 */
export interface DiscordReplyReferenceInput {
  /** Current authenticated Discord bot id. */
  botUserId?: string
  /** Absolute ingress deadline. @default Date.now() + 5000 */
  deadlineAt?: number
  /** Fetches the authoritative referenced-message author from Discord. */
  fetchReferencedAuthorId: () => Promise<string | undefined>
  /** Generation gate checked before provider work and after every settlement. */
  isActive?: () => boolean
  /** Stable trusted Discord user key used for fair capacity isolation across channels and generations. */
  principalKey: string
  /** Discord message id present only for a real reply reference. */
  referencedMessageId?: string | null
  /** Adapter lifecycle cancellation signal. */
  signal?: AbortSignal
}

/** Sanitized outcome of one authoritative Discord reply-reference lookup. */
export type DiscordReplyReferenceResult
  = | { matched: true, reason: 'matched' }
    | {
      matched: false
      reason:
        | 'author-mismatch'
        | 'cancelled'
        | 'capacity'
        | 'deadline-expired'
        | 'fetch-failure'
        | 'inactive-generation'
        | 'missing-reference'
        | 'referenced-message-missing'
        | 'timeout'
    }

/**
 * Builds Discord output without allowing generated text to trigger mentions.
 *
 * Use when:
 * - AIRI sends model output, privacy notices, or error messages to Discord.
 *
 * Expects:
 * - `content` is already normalized for Discord's message length limit.
 *
 * Returns:
 * - A Discord.js message payload with all parsed mentions disabled.
 */
export function createSafeDiscordTextPayload(content: string): SafeDiscordTextPayload {
  return {
    allowedMentions: { parse: [] },
    content,
  }
}

/**
 * Starts one raw Discord REST operation under shared principal/global hard bounds.
 *
 * Use when:
 * - Discord.js exposes no AbortSignal for a send or fetch operation.
 * - Adapter stop must release its waiter while the raw promise remains retained.
 *
 * Expects:
 * - `principalKey` is derived from a trusted Discord user or application id and remains stable across lifecycle churn.
 *
 * Returns:
 * - The actual raw promise when admitted, otherwise a content-free capacity decision.
 */
export function startDiscordTransport<T>(
  principalKey: string,
  operation: () => Promise<T> | T,
): DiscordTransportStartResult<T> {
  let principalCount = 0
  for (const record of activeDiscordTransports) {
    if (record.principalKey === principalKey)
      principalCount += 1
  }
  const hasCapacity = principalCount < MAX_ACTIVE_DISCORD_TRANSPORTS_PER_PRINCIPAL
    && activeDiscordTransports.size < MAX_ACTIVE_DISCORD_TRANSPORTS
    && (
      principalCount === 0
      || activeDiscordTransports.size < MAX_ACTIVE_DISCORD_TRANSPORTS - RESERVED_DISCORD_TRANSPORTS_FOR_NEW_PRINCIPALS
    )
  if (!hasCapacity) {
    return {
      accepted: false,
      activeTransportCount: activeDiscordTransports.size,
      reason: 'capacity',
    }
  }

  const task = Promise.resolve().then(operation)
  const record: ActiveDiscordTransport = { principalKey, task }
  activeDiscordTransports.add(record)
  void task.then(
    () => activeDiscordTransports.delete(record),
    () => activeDiscordTransports.delete(record),
  )
  return { accepted: true, task }
}

/**
 * Waits for raw Discord work or exact lifecycle cancellation without abandoning rejection observation.
 *
 * Use when:
 * - The raw operation cannot be aborted but later chunks and side effects must stop immediately.
 *
 * Expects:
 * - The raw promise is retained by {@link startDiscordTransport} until actual settlement.
 *
 * Returns:
 * - A completed value or a cancellation marker; raw rejection is still propagated while current.
 */
export function waitForDiscordTransportBoundary<T>(
  operation: Promise<T>,
  abortSignal: AbortSignal,
): Promise<DiscordTransportBoundaryResult<T>> {
  if (abortSignal.aborted)
    return Promise.resolve({ completed: false })

  return new Promise<DiscordTransportBoundaryResult<T>>((resolve, reject) => {
    const stopWaiting = () => {
      abortSignal.removeEventListener('abort', stopWaiting)
      resolve({ completed: false })
    }
    abortSignal.addEventListener('abort', stopWaiting, { once: true })
    operation.then(
      (value) => {
        abortSignal.removeEventListener('abort', stopWaiting)
        resolve({ completed: true, value })
      },
      (error) => {
        abortSignal.removeEventListener('abort', stopWaiting)
        reject(error)
      },
    )
  })
}

function hasReferenceFetchCapacity(principalKey: string): boolean {
  let principalCount = 0
  for (const record of activeReferenceFetches) {
    if (record.principalKey === principalKey)
      principalCount += 1
  }

  if (principalCount >= MAX_ACTIVE_REFERENCE_FETCHES_PER_PRINCIPAL)
    return false
  if (activeReferenceFetches.size >= MAX_ACTIVE_REFERENCE_FETCHES)
    return false

  return principalCount === 0
    || activeReferenceFetches.size < MAX_ACTIVE_REFERENCE_FETCHES - RESERVED_REFERENCE_FETCHES_FOR_NEW_OWNERS
}

function isReferenceLookupActive(input: DiscordReplyReferenceInput, deadlineAt: number): boolean {
  return !input.signal?.aborted
    && Date.now() < deadlineAt
    && (input.isActive?.() ?? true)
}

function describeInactiveReferenceLookup(input: DiscordReplyReferenceInput, deadlineAt: number): DiscordReplyReferenceResult {
  if (input.signal?.aborted)
    return { matched: false, reason: 'cancelled' }
  if (Date.now() >= deadlineAt)
    return { matched: false, reason: 'deadline-expired' }
  return { matched: false, reason: 'inactive-generation' }
}

/**
 * Splits exact Discord output without breaking an extended grapheme cluster.
 *
 * Use when:
 * - Model output may exceed Discord's 2,000 UTF-16-unit content limit.
 * - Whitespace, combining marks, emoji modifiers, and ZWJ sequences must survive exactly.
 *
 * Expects:
 * - The JavaScript runtime exposes the standard `Intl.Segmenter` API.
 *
 * Returns:
 * - Ordered chunks whose concatenation exactly equals `content`; empty content yields no chunks.
 */
export function splitDiscordText(content: string): string[] {
  if (content.length === 0)
    return []
  if (typeof Intl.Segmenter !== 'function')
    throw new DiscordTextChunkingError('segmenter-unavailable')

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const chunks: string[] = []
  let chunk = ''
  for (const { segment } of segmenter.segment(content)) {
    if (segment.length > DISCORD_TEXT_MAX_LENGTH)
      throw new DiscordTextChunkingError('grapheme-too-long')
    if (chunk.length + segment.length > DISCORD_TEXT_MAX_LENGTH) {
      chunks.push(chunk)
      chunk = segment
      continue
    }
    chunk += segment
  }
  if (chunk)
    chunks.push(chunk)
  return chunks
}

/**
 * Delivers exact Discord text sequentially under one shared partial-send contract.
 *
 * Use when:
 * - Bridge or standalone output may need multiple Discord messages.
 * - Cancellation must stop future chunks without retrying already attempted content.
 *
 * Expects:
 * - `sendChunk` returns `false` only when its owning transport was cancelled before confirmation.
 * - The caller keeps raw non-cancellable Discord work bounded outside this text policy.
 *
 * Returns:
 * - Delivered/total counts and a delivered or cancelled status; send failures throw a sanitized error.
 */
export async function deliverDiscordText(
  content: string,
  sendChunk: (payload: SafeDiscordTextPayload) => Promise<boolean | unknown> | boolean | unknown,
  options: DiscordTextDeliveryOptions = {},
): Promise<DiscordTextDeliveryResult> {
  const chunks = splitDiscordText(content)
  if (chunks.length === 0) {
    return {
      deliveredChunks: 0,
      status: 'delivered',
      totalChunks: 0,
    }
  }

  let deliveredChunks = 0
  const active = () => !options.signal?.aborted && (options.isActive?.() ?? true)
  for (const chunk of chunks) {
    if (!active()) {
      return {
        deliveredChunks,
        status: 'cancelled',
        totalChunks: chunks.length,
      }
    }

    let outcome: boolean | unknown
    try {
      outcome = await sendChunk(createSafeDiscordTextPayload(chunk))
    }
    catch (error) {
      throw new DiscordTextDeliveryError(
        deliveredChunks,
        chunks.length,
        error instanceof DiscordTransportCapacityError ? 'capacity' : 'send-failure',
      )
    }
    if (outcome === false) {
      return {
        deliveredChunks,
        status: 'cancelled',
        totalChunks: chunks.length,
      }
    }

    deliveredChunks += 1
    if (!active()) {
      return {
        deliveredChunks,
        status: 'cancelled',
        totalChunks: chunks.length,
      }
    }
  }

  return {
    deliveredChunks,
    status: 'delivered',
    totalChunks: chunks.length,
  }
}

/**
 * Resolves whether a Discord message authoritatively replies to the current bot.
 *
 * Use when:
 * - A guild message has no explicit bot mention and reply ping may be disabled.
 * - Both standalone and bridge must apply identical fail-closed reference policy.
 *
 * Expects:
 * - `fetchReferencedAuthorId` fetches the referenced Discord message rather than trusting gateway reply metadata.
 * - `principalKey` remains stable for one trusted Discord user across channels and generations while `signal` and `isActive` gate the exact lifecycle.
 *
 * Returns:
 * - A match decision plus a fixed reason suitable for content-free audit logs.
 */
export async function resolveDiscordReplyReference(input: DiscordReplyReferenceInput): Promise<DiscordReplyReferenceResult> {
  if (!input.botUserId || !input.referencedMessageId)
    return { matched: false, reason: 'missing-reference' }

  const startedAt = Date.now()
  const requestedDeadline = input.deadlineAt !== undefined && Number.isFinite(input.deadlineAt)
    ? input.deadlineAt
    : startedAt + DEFAULT_REFERENCE_FETCH_TIMEOUT_MS
  const deadlineAt = Math.min(requestedDeadline, startedAt + DEFAULT_REFERENCE_FETCH_TIMEOUT_MS)
  if (!isReferenceLookupActive(input, deadlineAt))
    return describeInactiveReferenceLookup(input, deadlineAt)
  if (!hasReferenceFetchCapacity(input.principalKey))
    return { matched: false, reason: 'capacity' }

  let abortHandler: (() => void) | undefined
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const boundary = new Promise<'cancelled' | 'timeout'>((resolve) => {
    const cancel = () => resolve('cancelled')
    abortHandler = cancel
    input.signal?.addEventListener('abort', cancel, { once: true })
    if (input.signal?.aborted)
      cancel()
    timeoutHandle = setTimeout(resolve, Math.max(0, deadlineAt - startedAt), 'timeout')
  })
  const rawTask = Promise.resolve().then(() => {
    if (!isReferenceLookupActive(input, deadlineAt))
      throw new Error('Discord reply reference lookup stopped.')
    return input.fetchReferencedAuthorId()
  })
  const record: ActiveReferenceFetch = { principalKey: input.principalKey, task: rawTask }
  activeReferenceFetches.add(record)
  void rawTask.then(
    () => activeReferenceFetches.delete(record),
    () => activeReferenceFetches.delete(record),
  )

  const observedTask = rawTask.then(
    authorId => ({ authorId, status: 'resolved' as const }),
    () => ({ status: 'failed' as const }),
  )

  try {
    const outcome = await Promise.race([observedTask, boundary])
    if (outcome === 'cancelled')
      return { matched: false, reason: 'cancelled' }
    if (outcome === 'timeout')
      return { matched: false, reason: 'timeout' }
    if (outcome.status === 'failed')
      return { matched: false, reason: 'fetch-failure' }
    if (!isReferenceLookupActive(input, deadlineAt))
      return describeInactiveReferenceLookup(input, deadlineAt)
    if (!outcome.authorId)
      return { matched: false, reason: 'referenced-message-missing' }
    if (outcome.authorId !== input.botUserId)
      return { matched: false, reason: 'author-mismatch' }
    return { matched: true, reason: 'matched' }
  }
  finally {
    if (timeoutHandle !== undefined)
      clearTimeout(timeoutHandle)
    if (abortHandler)
      input.signal?.removeEventListener('abort', abortHandler)
  }
}
