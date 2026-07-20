import { Buffer } from 'node:buffer'

/** Metadata-safe diagnostic emitted for an invalid artistry payload. */
export interface ArtistryPayloadWarning {
  /** Logical field being parsed, never the field value. */
  context: string
  /** UTF-8 size used for debugging truncation and transport issues. */
  inputBytes: number
  /** Stable failure category that cannot contain provider-controlled text. */
  reason: 'invalid-json' | 'not-an-object'
}

/**
 * Normalizes an untrusted artistry payload into a plain record.
 *
 * Before:
 * - `'{"replicateApiKey":"secret"'`
 * - `'[1, 2, 3]'`
 *
 * After:
 * - `{}` plus a metadata-only warning
 * - `{}` plus a metadata-only warning
 */
export function parseArtistryRecord(
  input: unknown,
  options: {
    context?: string
    warn: (warning: ArtistryPayloadWarning) => void
  },
): Record<string, unknown> {
  if (isRecord(input))
    return input
  if (typeof input !== 'string' || !input.trim())
    return {}

  const inputBytes = Buffer.byteLength(input)
  try {
    const parsed = JSON.parse(input) as unknown
    if (isRecord(parsed))
      return parsed

    options.warn({
      context: options.context || 'unknown',
      inputBytes,
      reason: 'not-an-object',
    })
  }
  catch {
    options.warn({
      context: options.context || 'unknown',
      inputBytes,
      reason: 'invalid-json',
    })
  }

  return {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalizes provider diagnostics by replacing known credential values.
 *
 * Before:
 * - `"Request rejected for Bearer provider-secret-value"`
 *
 * After:
 * - `"Request rejected for Bearer [redacted]"`
 */
export function redactSensitiveArtistryText(text: string, sources: unknown[]): string {
  const secrets = collectSensitiveValues(sources)
    .sort((left, right) => right.length - left.length)

  let redacted = text
  for (const secret of secrets)
    redacted = redacted.split(secret).join('[redacted]')
  return redacted
}

function collectSensitiveValues(sources: unknown[]): string[] {
  const values = new Set<string>()
  const visited = new WeakSet<object>()
  const stack = sources.map(value => ({ depth: 0, value }))

  while (stack.length > 0 && values.size < 128) {
    const current = stack.pop()
    if (!current || current.depth > 4 || typeof current.value !== 'object' || current.value === null)
      continue
    if (visited.has(current.value))
      continue
    visited.add(current.value)

    for (const [key, value] of Object.entries(current.value)) {
      if (typeof value === 'string' && value.length >= 6 && /api.?key|token|secret|password|passphrase|authorization|cookie/i.test(key)) {
        values.add(value)
        continue
      }
      if (typeof value === 'object' && value !== null)
        stack.push({ depth: current.depth + 1, value })
    }
  }

  return Array.from(values)
}
