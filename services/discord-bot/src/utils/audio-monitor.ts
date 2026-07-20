import type { Readable } from 'node:stream'

import { Buffer } from 'node:buffer'

import { useLogg } from '@guiiai/logg'

// eliza/packages/client-discord/src/voice.ts at develop · elizaOS/eliza
// https://github.com/elizaOS/eliza/blob/develop/packages/client-discord/src/voice.ts
export class AudioMonitor {
  private readable: Readable
  private buffers: Buffer[] = []
  private currentSize = 0
  private maxSize: number
  private lastFlagged: number = -1
  private ended: boolean = false
  private logger = useLogg('AudioMonitor').useGlobalConfig()
  private readonly dataHandler: (chunk: Buffer) => void
  private readonly endHandler: () => void
  private readonly speakingStartedHandler: () => void
  private readonly speakingStoppedHandler: () => void

  constructor(
    readable: Readable,
    maxSize: number,
    onStart: () => void,
    callback: (buffer: Buffer) => void,
  ) {
    if (!Number.isSafeInteger(maxSize) || maxSize <= 0)
      throw new RangeError('AudioMonitor maxSize must be a positive integer.')

    this.readable = readable
    this.maxSize = maxSize
    this.dataHandler = (chunk: Buffer) => {
      // this.logger.log('AudioMonitor got data');
      if (this.lastFlagged < 0) {
        this.lastFlagged = this.buffers.length
      }
      this.buffers.push(chunk)
      this.currentSize += chunk.length

      while (this.currentSize > this.maxSize && this.buffers.length > 0) {
        const first = this.buffers[0]
        const overflow = this.currentSize - this.maxSize
        if (first.length <= overflow) {
          this.buffers.shift()
          this.currentSize -= first.length
          this.lastFlagged = Math.max(0, this.lastFlagged - 1)
          continue
        }

        this.buffers[0] = first.subarray(overflow)
        this.currentSize -= overflow
      }
    }
    this.endHandler = () => {
      this.logger.log('AudioMonitor ended')
      this.ended = true
      if (this.lastFlagged < 0)
        return
      callback(this.getBufferFromStart())
      this.lastFlagged = -1
    }
    this.speakingStoppedHandler = () => {
      if (this.ended)
        return
      this.logger.log('Speaking stopped')
      if (this.lastFlagged < 0)
        return
      callback(this.getBufferFromStart())
      this.lastFlagged = -1
    }
    this.speakingStartedHandler = () => {
      if (this.ended)
        return
      onStart()
      this.logger.log('Speaking started')
      this.reset()
    }

    this.readable.on('data', this.dataHandler)
    this.readable.on('end', this.endHandler)
    this.readable.on('speakingStopped', this.speakingStoppedHandler)
    this.readable.on('speakingStarted', this.speakingStartedHandler)
  }

  stop() {
    this.readable.off('data', this.dataHandler)
    this.readable.off('end', this.endHandler)
    this.readable.off('speakingStopped', this.speakingStoppedHandler)
    this.readable.off('speakingStarted', this.speakingStartedHandler)
  }

  isFlagged() {
    return this.lastFlagged >= 0
  }

  getBufferFromFlag() {
    if (this.lastFlagged < 0) {
      return null
    }
    const buffer = Buffer.concat(this.buffers.slice(this.lastFlagged))
    return buffer
  }

  getBufferFromStart() {
    const buffer = Buffer.concat(this.buffers)
    return buffer
  }

  reset() {
    this.buffers = []
    this.currentSize = 0
    this.lastFlagged = -1
  }

  isEnded() {
    return this.ended
  }
}
