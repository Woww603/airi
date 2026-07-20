/** Fixed categories emitted by a native realtime voice provider. */
export type RealtimeVoiceProviderFailureCategory
  = | 'configuration-timeout'
    | 'connection-cancelled'
    | 'invalid-event'
    | 'provider-error'
    | 'rotation-overdue'
    | 'transport-closed'
    | 'transport-error'
    | 'transport-exhausted'
    | 'active-turn-timeout'

/**
 * Safe lifecycle outcome crossing a realtime provider boundary.
 *
 * Providers construct this value. Consumers must use `disposition`, rather
 * than provider-controlled Error names or messages, for ownership decisions.
 */
export interface RealtimeVoiceProviderFailure {
  /** Fixed, content-free category suitable for diagnostics. */
  readonly category: RealtimeVoiceProviderFailureCategory
  /** Whether the current Discord voice owner remains valid. */
  readonly disposition: 'recoverable' | 'terminal'
}

const failureBrand = new WeakSet<object>()

/**
 * Creates a provider-owned, content-free failure outcome.
 *
 * Consumers must pass untrusted callback values through {@link normalizeRealtimeVoiceProviderFailure}
 * instead of inspecting provider-controlled object fields.
 */
export function createRealtimeVoiceProviderFailure(
  category: RealtimeVoiceProviderFailureCategory,
  disposition: RealtimeVoiceProviderFailure['disposition'],
): RealtimeVoiceProviderFailure {
  const failure = Object.freeze({ category, disposition })
  failureBrand.add(failure)
  return failure
}

/**
 * Parses a provider failure without allowing hostile objects to escape into lifecycle code.
 *
 * Unknown, forged, and getter/proxy-backed values fail closed as terminal failures.
 */
export function normalizeRealtimeVoiceProviderFailure(value: unknown): RealtimeVoiceProviderFailure {
  try {
    if (typeof value === 'object' && value !== null && failureBrand.has(value))
      return value as RealtimeVoiceProviderFailure
  }
  catch {
    // Proxies are untrusted provider input; do not let their traps affect cleanup.
  }
  return createRealtimeVoiceProviderFailure('provider-error', 'terminal')
}
