import type { WebSocketEvent } from '@proj-airi/server-shared/types'

const REDACTED_VALUE = '[REDACTED]'

// The exact normalized vocabulary documents the unprefixed protocol/config
// keys. Provider-prefixed variants are handled separately by anchored semantic
// suffixes; arbitrary substring matching is intentionally forbidden.
const NORMALIZED_SECRET_KEYS = new Set([
  'token',
  'authtoken',
  'authenticationtoken',
  'bottoken',
  'discordtoken',
  'discordbottoken',
  'accesstoken',
  'refreshtoken',
  'bearertoken',
  'apitoken',
  'oauthtoken',
  'webhooktoken',
  'idtoken',
  'sessiontoken',
  'apikey',
  'authorization',
  'password',
  'passphrase',
  'secret',
  'clientsecret',
  'secretkey',
  'secretaccesskey',
  'privatekey',
  'signingkey',
])

// Provider and transport prefixes are open-ended, while the secret-bearing
// domain suffix is stable. Anchoring at the end avoids broad substring matches:
// tokenCount, maxTokens, secretary, and authorizationUrl remain observable.
const NORMALIZED_SECRET_SUFFIXES = [
  'token',
  'apikey',
  'password',
  'passphrase',
  'secret',
  'secretkey',
  'privatekey',
  'authorization',
  'secretaccesskey',
  'signingkey',
] as const

/**
 * Normalizes a configuration key for secret-key classification.
 *
 * Before:
 * - "Access-Token"
 * - "private_key"
 * - "API Key"
 *
 * After:
 * - "accesstoken"
 * - "privatekey"
 * - "apikey"
 */
function normalizeSecretKey(key: string): string {
  return key.toLowerCase().replace(/[\s./:_-]+/g, '')
}

function isSecretKey(key: string): boolean {
  const normalizedKey = normalizeSecretKey(key)
  if (NORMALIZED_SECRET_KEYS.has(normalizedKey))
    return true

  return NORMALIZED_SECRET_SUFFIXES.some((suffix) => {
    return normalizedKey.length > suffix.length && normalizedKey.endsWith(suffix)
  })
}

/**
 * Redacts secret-bearing query values in an absolute URL without guessing at text.
 *
 * Before:
 * - "wss://provider.example/realtime?token=secret&safe=visible"
 * - "/relative?token=secret"
 *
 * After:
 * - "wss://provider.example/realtime?token=%5BREDACTED%5D&safe=visible"
 * - "/relative?token=secret"
 */
function redactAbsoluteUrlQuery(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    // NOTICE: Only WHATWG absolute URLs have an unambiguous query boundary.
    // Relative or malformed text stays observable rather than being guessed at.
    return value
  }

  let redacted = false
  const parameters = new URLSearchParams()
  for (const [key, parameterValue] of url.searchParams) {
    const secret = isSecretKey(key)
    parameters.append(key, secret ? REDACTED_VALUE : parameterValue)
    redacted ||= secret
  }

  if (!redacted)
    return value

  url.search = parameters.toString()
  return url.toString()
}

function cloneObservedValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'function' || typeof value === 'symbol')
    return '[UNSUPPORTED]'

  if (typeof value === 'string')
    return redactAbsoluteUrlQuery(value)

  if (value === null || typeof value !== 'object')
    return value

  const existing = seen.get(value)
  if (existing !== undefined)
    return existing

  if (value instanceof Date) {
    const clone = new Date(value.getTime())
    seen.set(value, clone)
    return clone
  }

  if (value instanceof RegExp) {
    const clone = new RegExp(value.source, value.flags)
    clone.lastIndex = value.lastIndex
    seen.set(value, clone)
    return clone
  }

  if (value instanceof ArrayBuffer) {
    const clone = value.slice(0)
    seen.set(value, clone)
    return clone
  }

  if (ArrayBuffer.isView(value)) {
    const clone = structuredClone(value)
    seen.set(value, clone)
    return clone
  }

  if (value instanceof Map) {
    const clone = new Map<unknown, unknown>()
    seen.set(value, clone)

    for (const [key, nestedValue] of value) {
      const clonedKey = cloneObservedValue(key, seen)
      clone.set(
        clonedKey,
        typeof key === 'string' && isSecretKey(key)
          ? REDACTED_VALUE
          : cloneObservedValue(nestedValue, seen),
      )
    }

    return clone
  }

  if (value instanceof Set) {
    const clone = new Set<unknown>()
    seen.set(value, clone)
    for (const nestedValue of value)
      clone.add(cloneObservedValue(nestedValue, seen))

    return clone
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = []
    seen.set(value, clone)
    for (const nestedValue of value)
      clone.push(cloneObservedValue(nestedValue, seen))

    return clone
  }

  const clone: Record<string, unknown> = {}
  seen.set(value, clone)

  for (const key of Object.keys(value)) {
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: isSecretKey(key)
        ? REDACTED_VALUE
        : cloneObservedValue(Reflect.get(value, key), seen),
    })
  }

  return clone
}

/**
 * Creates a diagnostic-safe websocket event for observers and inspectors.
 *
 * Use when:
 * - Emitting websocket traffic to diagnostic callbacks.
 * - Persisting an observed event in local Inspector history.
 *
 * Expects:
 * - A validated websocket event destined for, or parsed from, the real transport.
 * - Secret-bearing configuration fields use the documented exact key vocabulary.
 *
 * Returns:
 * - A deeply detached event whose secret-key subtrees are irreversibly replaced.
 * - A stable result when the function is applied to an already-redacted event.
 */
export function createRedactedObserverEvent<C = undefined>(event: WebSocketEvent<C>): WebSocketEvent<C> {
  return cloneObservedValue(event, new WeakMap()) as WebSocketEvent<C>
}
