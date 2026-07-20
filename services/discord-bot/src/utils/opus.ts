import { Buffer } from 'node:buffer'
import { Transform } from 'node:stream'

import OpusScript from 'opusscript'

import { errorMessageFrom } from '@moeru/std'

export class OpusDecoder extends Transform {
  private decoder: OpusScript

  /**
   * @param sampleRate - The audio sample rate (e.g., 16000 Hz)
   * @param channels - Number of audio channels (e.g., 1 for mono)
   */
  constructor(sampleRate: 8000 | 12000 | 16000 | 24000 | 48000, channels: number) {
    super()
    this.decoder = new OpusScript(sampleRate, channels)
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
    try {
      // Decode Opus chunk to PCM
      const pcm = this.decoder.decode(chunk)
      if (pcm) {
        this.push(Buffer.from(pcm))
      }
      callback()
    }
    catch (error) {
      const decoderError = new Error(errorMessageFrom(error) ?? 'Unknown Opus decoder failure.', { cause: error })
      this.emit('error', decoderError)
      callback(decoderError)
    }
  }

  _flush(callback: (error?: Error | null, data?: Buffer) => void) {
    callback()
  }
}
