import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { StandaloneDashboardCounterStore } from './dashboard-state-store'

const tempDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

/**
 * @example
 * describe('StandaloneDashboardCounterStore', () => {})
 */
describe('standalone dashboard counter store', () => {
  /**
   * @example
   * it('atomically persists counters and reloads them after restart', async () => {})
   */
  it('atomically persists counters and reloads them after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'airi-dashboard-state-'))
    tempDirectories.push(directory)
    const filePath = join(directory, 'dashboard-state.json')
    const store = new StandaloneDashboardCounterStore({ debounceMs: 60_000, filePath })

    expect(await store.load()).toEqual({
      acceptedMessages: 0,
      failedReplies: 0,
      rejectedMessages: 0,
      successfulReplies: 0,
    })

    store.schedule({
      acceptedMessages: 8,
      failedReplies: 2,
      rejectedMessages: 3,
      successfulReplies: 6,
    })
    await store.flush()

    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      counters: {
        acceptedMessages: 8,
        failedReplies: 2,
        rejectedMessages: 3,
        successfulReplies: 6,
      },
      version: 1,
    })
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    expect(await new StandaloneDashboardCounterStore({ filePath }).load()).toEqual({
      acceptedMessages: 8,
      failedReplies: 2,
      rejectedMessages: 3,
      successfulReplies: 6,
    })
  })

  /**
   * @example
   * it('fails closed to zero counters for malformed local state', async () => {})
   */
  it('fails closed to zero counters for malformed local state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'airi-dashboard-state-'))
    tempDirectories.push(directory)
    const filePath = join(directory, 'dashboard-state.json')
    await writeFile(filePath, JSON.stringify({ counters: { acceptedMessages: -9 }, version: 1 }))

    expect(await new StandaloneDashboardCounterStore({ filePath }).load()).toEqual({
      acceptedMessages: 0,
      failedReplies: 0,
      rejectedMessages: 0,
      successfulReplies: 0,
    })
  })

  /**
   * @example
   * it('reports persistence failure without serializing filesystem Error text', async () => {})
   */
  it('reports persistence failure without serializing filesystem Error text for P2-B', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'airi-dashboard-state-'))
    tempDirectories.push(directory)
    const pathSentinel = 'synthetic-private-counter-path-sentinel'
    const blockedParent = join(directory, pathSentinel)
    await writeFile(blockedParent, 'not-a-directory')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = new StandaloneDashboardCounterStore({
      debounceMs: 60_000,
      filePath: join(blockedParent, 'dashboard-state.json'),
    })

    // ROOT CAUSE:
    //
    // The persistence queue converted an arbitrary filesystem Error with
    // `errorMessageFrom` and sent the path-bearing text to console/file logs.
    store.schedule({
      acceptedMessages: 1,
      failedReplies: 0,
      rejectedMessages: 0,
      successfulReplies: 1,
    })
    await store.flush()

    const serialized = JSON.stringify(consoleError.mock.calls)
    // @example
    expect(serialized).not.toContain(pathSentinel)
    // @example
    expect(serialized).toContain('dashboard-counter-persistence-failure')
  })
})
