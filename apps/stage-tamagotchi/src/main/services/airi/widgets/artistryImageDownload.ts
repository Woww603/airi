import { Buffer } from 'node:buffer'

/** Options controlling bounded image downloads from generation providers. */
export interface ArtistryImageDownloadOptions {
  /** Fetch implementation used for the network boundary. @default globalThis.fetch */
  fetcher?: typeof fetch
  /** Maximum response body size in bytes. @default 16777216 */
  maxBytes?: number
  /** Maximum time for headers and body consumption in milliseconds. @default 30000 */
  timeoutMs?: number
}

function detectImageMimeType(bytes: Uint8Array) {
  // Magic-number validation prevents HTML, SVG, and other active content from being
  // mislabeled as an image data URL by a compromised provider endpoint.
  if (bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4E
    && bytes[3] === 0x47
    && bytes[4] === 0x0D
    && bytes[5] === 0x0A
    && bytes[6] === 0x1A
    && bytes[7] === 0x0A) {
    return 'image/png'
  }

  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF)
    return 'image/jpeg'

  const header = Buffer.from(bytes.subarray(0, 12)).toString('ascii')
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a'))
    return 'image/gif'
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP')
    return 'image/webp'

  return undefined
}

/**
 * Downloads one generated image with transport, time, size, and file-type limits.
 *
 * Use when:
 * - A generation provider returns an image URL that must cross into the renderer
 *
 * Expects:
 * - Provider URLs use HTTP or HTTPS
 * - Generated outputs are PNG, JPEG, GIF, or WebP
 *
 * Returns:
 * - A bounded image data URL whose MIME type was derived from file bytes
 */
export async function downloadImageAsDataUrl(url: string, options: ArtistryImageDownloadOptions = {}) {
  const parsedUrl = new URL(url)
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')
    throw new Error('Generated image URL must use HTTP or HTTPS')

  const maxBytes = typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes)
    ? Math.min(64 * 1024 * 1024, Math.max(1, Math.floor(options.maxBytes)))
    : 16 * 1024 * 1024
  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
    ? Math.min(120_000, Math.max(1_000, Math.floor(options.timeoutMs)))
    : 30_000
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof timeout === 'object')
    timeout.unref?.()

  try {
    const response = await (options.fetcher ?? fetch)(parsedUrl, { signal: controller.signal })
    if (!response.ok)
      throw new Error(`Generated image request failed with HTTP ${response.status}`)

    const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
      throw new Error('Generated image exceeds the download limit')
    if (!response.body)
      throw new Error('Generated image response has no body')

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let totalBytes = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done)
        break
      if (!value)
        continue

      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error('Generated image exceeds the download limit')
      }
      chunks.push(value)
    }

    const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), totalBytes)
    const mimeType = detectImageMimeType(bytes)
    if (!mimeType)
      throw new Error('Generated image has an unsupported file type')

    return `data:${mimeType};base64,${bytes.toString('base64')}`
  }
  finally {
    clearTimeout(timeout)
  }
}
