import { Buffer } from 'node:buffer'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { AudioMonitor } from './audio-monitor'

/**
 * @example
 * describe('audio monitor', () => {})
 */
describe('audio monitor', () => {
  /**
   * @example
   * it('keeps only the newest audio bytes when the buffer reaches its cap', () => {})
   */
  it('keeps only the newest audio bytes when the buffer reaches its cap', () => {
    const readable = new PassThrough()
    const captured: Buffer[] = []
    const monitor = new AudioMonitor(readable, 4, () => {}, buffer => captured.push(buffer))

    readable.emit('speakingStarted')
    readable.write(Buffer.from([1, 2, 3]))
    readable.write(Buffer.from([4, 5, 6]))
    readable.emit('speakingStopped')

    expect(monitor.getBufferFromStart()).toEqual(Buffer.from([3, 4, 5, 6]))
    expect(captured).toEqual([Buffer.from([3, 4, 5, 6])])
  })

  /**
   * @example
   * it('removes only its own stream listeners when stopped', () => {})
   */
  it('removes only its own stream listeners when stopped', () => {
    const readable = new PassThrough()
    const unrelatedDataListener = vi.fn()
    readable.on('data', unrelatedDataListener)
    const monitor = new AudioMonitor(readable, 4, () => {}, () => {})

    monitor.stop()
    readable.emit('data', Buffer.from([1]))

    expect(unrelatedDataListener).toHaveBeenCalledOnce()
  })

  /**
   * @example
   * it('rejects a non-positive buffer cap before attaching listeners', () => {})
   */
  it('rejects a non-positive buffer cap before attaching listeners', () => {
    const readable = new PassThrough()

    expect(() => new AudioMonitor(readable, 0, () => {}, () => {})).toThrow('positive integer')
    expect(readable.listenerCount('data')).toBe(0)
  })
})
