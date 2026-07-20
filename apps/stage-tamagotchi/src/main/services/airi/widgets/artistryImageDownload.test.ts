import { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'

import { downloadImageAsDataUrl } from './artistryImageDownload'

/**
 * @example
 * describe('artistry image download limits', () => {})
 */
describe('artistry image download limits', () => {
  /**
   * @example
   * it('rejects oversized declared and streamed bodies', async () => {})
   */
  it('rejects oversized declared and streamed bodies', async () => {
    const declaredFetcher = vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4E, 0x47]), {
      headers: { 'content-length': '5' },
    }))

    // @example
    await expect(downloadImageAsDataUrl('https://images.example/result', {
      fetcher: declaredFetcher,
      maxBytes: 4,
    })).rejects.toThrow('Generated image exceeds the download limit')

    const streamedFetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x89, 0x50, 0x4E]))
        controller.enqueue(new Uint8Array([0x47, 0x00]))
        controller.close()
      },
    })))

    // @example
    await expect(downloadImageAsDataUrl('https://images.example/result', {
      fetcher: streamedFetcher,
      maxBytes: 4,
    })).rejects.toThrow('Generated image exceeds the download limit')
  })

  /**
   * @example
   * it('returns only a recognized bounded image as a data URL', async () => {})
   */
  it('returns only a recognized bounded image as a data URL', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    const fetcher = vi.fn(async () => new Response(pngBytes))

    const result = await downloadImageAsDataUrl('https://images.example/result', { fetcher })

    // @example
    expect(result).toBe(`data:image/png;base64,${Buffer.from(pngBytes).toString('base64')}`)
  })

  /**
   * @example
   * it('rejects non-network URLs before fetching', async () => {})
   */
  it('rejects non-network URLs before fetching', async () => {
    const fetcher = vi.fn<typeof fetch>()

    // @example
    await expect(downloadImageAsDataUrl('file:///etc/passwd', { fetcher })).rejects.toThrow('Generated image URL must use HTTP or HTTPS')
    // @example
    expect(fetcher).not.toHaveBeenCalled()
  })
})
