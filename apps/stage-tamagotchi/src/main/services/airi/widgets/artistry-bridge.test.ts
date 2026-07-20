import type { ArtistryJobStatus, ArtistryProvider } from './providers/base'

import { afterEach, describe, expect, it, vi } from 'vitest'

const artistryConfig = {
  get: vi.fn(() => ({
    artistryGlobals: {},
    artistryProvider: 'security-test',
  })),
}

vi.mock('injeca', () => ({
  injeca: {
    resolve: vi.fn(async () => ({ config: artistryConfig })),
  },
}))

/**
 * @example
 * describe('headless artistry resource limits', () => {})
 */
describe('headless artistry resource limits', async () => {
  const { artistryProviders, generateHeadless } = await import('./artistry-bridge')

  afterEach(() => {
    artistryProviders.delete('security-test')
  })

  /**
   * @example
   * it('rejects a third distinct concurrent generation', async () => {})
   */
  it('rejects a third distinct concurrent generation', async () => {
    const callbacks = new Map<string, (status: ArtistryJobStatus) => void>()
    const provider: ArtistryProvider = {
      id: 'security-test',
      name: 'Security test provider',
      generate: vi.fn(async _request => ({
        jobId: crypto.randomUUID(),
        providerJobId: crypto.randomUUID(),
      })),
      getStatus: vi.fn(async (): Promise<ArtistryJobStatus> => ({ status: 'running' })),
      setJobCallback: (jobId, callback) => callbacks.set(jobId, callback),
    }
    artistryProviders.set(provider.id, provider)

    const requests = [
      generateHeadless({ prompt: 'first' }),
      generateHeadless({ prompt: 'second' }),
      generateHeadless({ prompt: 'third' }),
    ]

    try {
      await vi.waitFor(() => {
        // @example
        expect(callbacks.size).toBe(2)
      })
    }
    finally {
      for (const callback of callbacks.values())
        callback({ status: 'succeeded' })
    }

    const results = await Promise.all(requests)

    // @example
    expect(results[2]).toEqual({ error: 'Too many image generations are already running.' })
  })
})
