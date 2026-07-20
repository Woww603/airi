import { Buffer } from 'node:buffer'
import { Transform } from 'node:stream'

import { DECODE_SAMPLE_RATE } from '../constants/audio'

/** Configuration accepted by the deliberately separate PCM16 gates. */
export interface Pcm16GateOptions {
  /** Consecutive time above the RMS threshold required before audio is accepted. */
  confirmationMs: number
  /** Maximum audio retained before confirmation so the beginning of speech is preserved. */
  preRollMs: number
  /** Normalized PCM16 RMS threshold in the inclusive range 0..1. */
  rmsThreshold: number
  /** Mono PCM sample rate used to convert byte counts into duration. */
  sampleRate: number
}

/** Fixed result of classic local interruption detection. */
export type Pcm16InterruptionGateStatus
  = | 'confirmed'
    | 'rejected:below-threshold'
    | 'rejected:insufficient-duration'
    | 'rejected:no-samples'

/**
 * Admits safe, sustained energetic PCM to Qwen without classifying speech.
 *
 * Use when:
 * - Transport-level speaking events also fire for environmental noise.
 * - Confirmed speech needs a bounded pre-roll so its first syllable is retained.
 *
 * Expects:
 * - Little-endian mono PCM16 chunks from one continuous speaker turn.
 * - {@link reset} is called before evaluating a new transport speaking event.
 *
 * Returns:
 * - Buffered audio once confirmed, then each subsequent chunk immediately.
 */
export class Pcm16InterruptionGate {
  private readonly confirmationSamples: number
  private readonly confirmationWindowSamples: number
  private readonly frameSamples: number
  private readonly maxPreRollBytes: number
  private readonly preRoll: Buffer
  private readonly rmsThreshold: number
  private preRollLength = 0
  private preRollStart = 0
  private confirmed = false
  private readonly energyWindow: Array<{ samples: number, voiced: boolean }> = []
  private analysisRemainder = Buffer.alloc(0)
  private hasEvaluatedSamples = false
  private pendingPcmByte: Buffer | undefined
  private voicedSamples = 0

  constructor(options: Pcm16GateOptions) {
    if (!Number.isFinite(options.confirmationMs) || options.confirmationMs <= 0)
      throw new RangeError('PCM16 input safety confirmationMs must be positive.')
    if (!Number.isFinite(options.preRollMs) || options.preRollMs <= 0)
      throw new RangeError('PCM16 input safety preRollMs must be positive.')
    if (!Number.isFinite(options.rmsThreshold) || options.rmsThreshold < 0 || options.rmsThreshold > 1)
      throw new RangeError('PCM16 input safety rmsThreshold must be between 0 and 1.')
    if (!Number.isSafeInteger(options.sampleRate) || options.sampleRate <= 0)
      throw new RangeError('PCM16 input safety sampleRate must be a positive integer.')

    // Permit a brief natural dip without letting unrelated distant frames add up.
    this.confirmationSamples = Math.ceil(options.sampleRate * options.confirmationMs / 1_000)
    this.confirmationWindowSamples = this.confirmationSamples * 2
    this.frameSamples = Math.max(1, Math.floor(options.sampleRate / 50))
    const requestedPreRollBytes = Math.max(2, Math.floor(options.sampleRate * 2 * options.preRollMs / 1_000 / 2) * 2)
    // A power-of-two ring keeps modulo writes inexpensive while retaining an
    // exact PCM16-aligned lower bound for short pre-roll windows.
    this.maxPreRollBytes = 2 ** Math.ceil(Math.log2(requestedPreRollBytes))
    this.preRoll = Buffer.allocUnsafe(this.maxPreRollBytes)
    this.rmsThreshold = options.rmsThreshold
  }

  /** Resets the stream assembler and admission result for a new input turn. */
  reset() {
    this.preRollLength = 0
    this.preRollStart = 0
    this.confirmed = false
    this.energyWindow.length = 0
    this.analysisRemainder = Buffer.alloc(0)
    this.hasEvaluatedSamples = false
    this.pendingPcmByte = undefined
    this.voicedSamples = 0
  }

  /**
   * Evaluates one PCM chunk and releases it only after safety admission.
   *
   * Use when:
   * - A decoded Discord PCM chunk arrives for the active speaker.
   *
   * Expects:
   * - The chunk contains little-endian mono PCM16 at the configured sample rate.
   *
   * Returns:
   * - `undefined` while gated, pre-roll chunks upon confirmation, or the current chunk afterward.
   */
  push(pcm: Buffer): Buffer[] | undefined {
    if (this.confirmed)
      return pcm.length === 0 ? [] : this.copyForRelease(pcm)

    // Empty decoder notifications contain no audio. Keeping them would make
    // pre-roll unbounded without contributing any evidence.
    if (pcm.length === 0)
      return undefined

    const input = this.pendingPcmByte
      ? Buffer.concat([this.pendingPcmByte, pcm])
      : pcm
    const completeByteLength = input.length - input.length % 2
    this.pendingPcmByte = completeByteLength === input.length
      ? undefined
      : Buffer.from(input.subarray(completeByteLength))
    if (completeByteLength === 0)
      return undefined

    // Normalize odd decoder chunks before both consumers see them, preserving
    // PCM16 boundaries even when Discord splits a sample across packets.
    const completePcm = input.subarray(0, completeByteLength)
    const preRollBeforeCurrent = this.copyPreRoll()
    if (this.voicedSamples === 0)
      this.analysisRemainder = Buffer.alloc(0)
    this.analyze(Buffer.concat([this.analysisRemainder, completePcm]))
    this.appendPreRoll(completePcm)

    if (this.voicedSamples < this.confirmationSamples)
      return undefined

    this.confirmed = true
    const release = preRollBeforeCurrent.length === 0
      ? this.copyPreRoll()
      : Buffer.concat([preRollBeforeCurrent, completePcm])
    return this.copyForRelease(release)
  }

  /**
   * Evaluates fixed sample-domain frames so transport chunk boundaries cannot
   * change the classification of the same PCM stream.
   */
  private analyze(pcm: Buffer): void {
    const frameBytes = this.frameSamples * 2
    const completeFrameBytes = pcm.length - pcm.length % frameBytes
    this.analysisRemainder = completeFrameBytes === pcm.length
      ? Buffer.alloc(0)
      : Buffer.from(pcm.subarray(completeFrameBytes))

    for (let frameOffset = 0; frameOffset < completeFrameBytes; frameOffset += frameBytes)
      this.analyzeFrame(pcm.subarray(frameOffset, frameOffset + frameBytes))
  }

  /** Classifies waveform variation without being fooled by DC or sparse spikes. */
  private analyzeFrame(frame: Buffer): void {
    const sampleCount = frame.length / 2
    let activeSamples = 0
    let transitions = 0
    let acPeak = 0
    let mean = 0
    let m2 = 0
    let previousSample: number | undefined
    for (let offset = 0; offset < frame.length; offset += 2) {
      const rawSample = frame.readInt16LE(offset)
      const sample = rawSample / 32_768
      const count = offset / 2 + 1
      const delta = sample - mean
      mean += delta / count
      m2 += delta * (sample - mean)
      acPeak = Math.max(acPeak, Math.abs(sample - mean))
      if (Math.abs(rawSample) >= this.rmsThreshold * 32_768)
        activeSamples += 1
      if (previousSample !== undefined && Math.abs(sample - previousSample) >= Math.max(1 / 32_768, 0.01 * acPeak))
        transitions += 1
      previousSample = sample
    }
    const voiced = Math.sqrt(m2 / sampleCount) >= this.rmsThreshold
      && activeSamples / sampleCount >= 0.2
      && transitions / Math.max(1, sampleCount - 1) >= 0.3
    this.hasEvaluatedSamples = true
    this.energyWindow.push({ samples: sampleCount, voiced })
    if (voiced)
      this.voicedSamples += sampleCount
    this.trimEnergyWindow()
  }

  /** Returns the current fixed gate outcome without exposing PCM or RMS data. */
  getStatus(): Pcm16InterruptionGateStatus {
    this.sealAnalysis()
    if (this.confirmed)
      return 'confirmed'
    if (!this.hasEvaluatedSamples)
      return 'rejected:no-samples'
    if (this.voicedSamples === 0)
      return 'rejected:below-threshold'
    return 'rejected:insufficient-duration'
  }

  private trimEnergyWindow(): void {
    let windowSamples = this.energyWindow.reduce((total, frame) => total + frame.samples, 0)
    while (windowSamples > this.confirmationWindowSamples && this.energyWindow.length > 0) {
      const oldest = this.energyWindow[0]
      const overflowSamples = windowSamples - this.confirmationWindowSamples
      if (oldest.samples <= overflowSamples) {
        this.energyWindow.shift()
        windowSamples -= oldest.samples
        if (oldest.voiced)
          this.voicedSamples -= oldest.samples
        continue
      }
      oldest.samples -= overflowSamples
      windowSamples -= overflowSamples
      if (oldest.voiced)
        this.voicedSamples -= overflowSamples
    }
  }

  private sealAnalysis(): void {
    if (this.confirmed || this.analysisRemainder.length === 0)
      return
    const tail = this.analysisRemainder
    this.analysisRemainder = Buffer.alloc(0)
    this.analyzeFrame(tail)
    if (this.voicedSamples >= this.confirmationSamples)
      this.confirmed = true
  }

  /** Appends PCM16 samples to the fixed-size circular pre-roll store. */
  private appendPreRoll(pcm: Buffer): void {
    for (let offset = 0; offset < pcm.length; offset += 2) {
      if (this.preRollLength === this.maxPreRollBytes) {
        this.preRollStart = (this.preRollStart + 2) % this.maxPreRollBytes
        this.preRollLength -= 2
      }
      const target = (this.preRollStart + this.preRollLength) % this.maxPreRollBytes
      this.preRoll[target] = pcm[offset]
      this.preRoll[(target + 1) % this.maxPreRollBytes] = pcm[offset + 1]
      this.preRollLength += 2
    }
  }

  /** Copies chronological pre-roll without exposing an upstream Buffer parent. */
  private copyPreRoll(): Buffer {
    const output = Buffer.allocUnsafeSlow(this.preRollLength)
    for (let offset = 0; offset < this.preRollLength; offset += 1)
      output[offset] = this.preRoll[(this.preRollStart + offset) % this.maxPreRollBytes]
    return output
  }

  /** Copies releases into bounded independent backing stores. */
  private copyForRelease(pcm: Buffer): Buffer[] {
    const copies: Buffer[] = []
    const releaseChunkBytes = Math.min(this.maxPreRollBytes, this.frameSamples * 2)
    for (let offset = 0; offset < pcm.length; offset += releaseChunkBytes) {
      const copy = Buffer.allocUnsafeSlow(Math.min(releaseChunkBytes, pcm.length - offset))
      pcm.copy(copy, 0, offset, offset + copy.length)
      copies.push(copy)
    }
    return copies
  }
}

/** Fixed terminal result of Qwen's PCM16 energetic input safety boundary. */
export type Pcm16InputSafetyGateStatus
  = | 'admitted'
    | 'rejected:below-threshold'
    | 'rejected:incomplete-sample'
    | 'rejected:insufficient-duration'
    | 'rejected:no-samples'

/**
 * Admits sustained energetic AC PCM for Qwen without deciding whether it is speech.
 *
 * Use when:
 * - A Qwen input capture must reject silence, DC, sparse impulses, and malformed PCM.
 *
 * Expects:
 * - Little-endian mono PCM16 chunks from one capture.
 *
 * Returns:
 * - PCM after energetic admission; {@link finalize} owns the terminal result.
 */
export class Pcm16InputSafetyGate {
  private readonly confirmationSamples: number
  private readonly confirmationWindowSamples: number
  private readonly frameSamples: number
  private readonly maxPreRollBytes: number
  private readonly releaseChunkBytes: number
  private readonly preRoll: Buffer
  private readonly threshold: number
  private readonly frames: Array<{ readonly samples: number, readonly energetic: boolean }> = []
  private analysisRemainder = Buffer.alloc(0)
  private finalized = false
  private finalStatus: Pcm16InputSafetyGateStatus | undefined
  private admitted = false
  private hasSamples = false
  private pendingPcmByte: Buffer | undefined
  private preRollLength = 0
  private preRollStart = 0
  private energeticSamples = 0

  constructor(options: Pcm16GateOptions) {
    if (!Number.isFinite(options.confirmationMs) || options.confirmationMs <= 0)
      throw new RangeError('PCM16 input safety confirmationMs must be positive.')
    if (!Number.isFinite(options.preRollMs) || options.preRollMs <= 0)
      throw new RangeError('PCM16 input safety preRollMs must be positive.')
    if (!Number.isFinite(options.rmsThreshold) || options.rmsThreshold < 0 || options.rmsThreshold > 1)
      throw new RangeError('PCM16 input safety rmsThreshold must be between 0 and 1.')
    if (!Number.isSafeInteger(options.sampleRate) || options.sampleRate <= 0)
      throw new RangeError('PCM16 input safety sampleRate must be a positive integer.')
    this.confirmationSamples = Math.ceil(options.sampleRate * options.confirmationMs / 1_000)
    this.confirmationWindowSamples = this.confirmationSamples * 2
    this.frameSamples = Math.max(1, Math.floor(options.sampleRate / 50))
    this.maxPreRollBytes = Math.max(2, Math.floor(options.sampleRate * 2 * options.preRollMs / 1_000 / 2) * 2)
    this.releaseChunkBytes = Math.max(2, Math.floor(options.sampleRate / 50) * 2)
    this.preRoll = Buffer.allocUnsafe(this.maxPreRollBytes)
    this.threshold = options.rmsThreshold * 32_768
  }

  /** Resets this boundary for another independent capture. */
  reset(): void {
    this.frames.length = 0
    this.analysisRemainder = Buffer.alloc(0)
    this.finalized = false
    this.finalStatus = undefined
    this.admitted = false
    this.hasSamples = false
    this.pendingPcmByte = undefined
    this.preRollLength = 0
    this.preRollStart = 0
    this.energeticSamples = 0
  }

  /** Adds one capture chunk and releases complete PCM only after admission. */
  push(pcm: Buffer): Buffer[] | undefined {
    if (this.finalized)
      throw new Error('Cannot push PCM after local input finalization.')
    if (pcm.length === 0)
      return undefined

    const input = this.pendingPcmByte
      ? Buffer.concat([this.pendingPcmByte, pcm])
      : pcm
    const completeByteLength = input.length - input.length % 2
    this.pendingPcmByte = completeByteLength === input.length
      ? undefined
      : Buffer.from(input.subarray(completeByteLength))
    if (completeByteLength === 0)
      return undefined

    const completePcm = input.subarray(0, completeByteLength)
    if (this.admitted)
      return this.release(completePcm)

    this.hasSamples = true
    const retainedBeforeCurrent = this.copyPreRoll()
    this.analyze(completePcm)
    if (this.energeticSamples < this.confirmationSamples) {
      this.appendPreRoll(completePcm)
      return undefined
    }

    this.admitted = true
    return this.release(Buffer.concat([retainedBeforeCurrent, completePcm]))
  }

  /** Returns a pure query of the current local safety outcome. */
  getStatus(): Pcm16InputSafetyGateStatus {
    if (this.finalStatus)
      return this.finalStatus
    if (this.admitted)
      return 'admitted'
    if (!this.hasSamples)
      return 'rejected:no-samples'
    if (this.energeticSamples === 0)
      return 'rejected:below-threshold'
    if (this.energeticSamples < this.confirmationSamples)
      return 'rejected:insufficient-duration'
    return 'admitted'
  }

  /** Finalizes exactly once, binding the terminal status to all released capture PCM. */
  finalize(): { readonly released: Buffer[], readonly status: Pcm16InputSafetyGateStatus } {
    if (this.finalized)
      return { released: [], status: this.finalStatus! }
    if (this.pendingPcmByte) {
      this.finalStatus = 'rejected:incomplete-sample'
    }
    else {
      this.flushAnalysisRemainder()
      this.finalStatus = this.getStatus()
    }
    this.finalized = true
    return {
      released: this.finalStatus === 'admitted' && !this.admitted
        ? this.release(this.copyPreRoll())
        : [],
      status: this.finalStatus,
    }
  }

  /** Processes fixed sample-domain frames so packet boundaries cannot poison admission. */
  private analyze(pcm: Buffer): void {
    const input = this.analysisRemainder.length === 0
      ? pcm
      : Buffer.concat([this.analysisRemainder, pcm])
    const frameBytes = this.frameSamples * 2
    let offset = 0
    while (offset + frameBytes <= input.length) {
      this.analyzeFrame(input.subarray(offset, offset + frameBytes))
      offset += frameBytes
    }
    this.analysisRemainder = offset === input.length ? Buffer.alloc(0) : Buffer.from(input.subarray(offset))

    // The confirmation boundary itself is sample-defined. Analyze its final
    // partial frame immediately once enough energetic audio could be admitted.
    if (
      this.analysisRemainder.length > 0
      && this.energeticSamples + this.analysisRemainder.length / 2 >= this.confirmationSamples
    ) {
      this.analyzeFrame(this.analysisRemainder)
      this.analysisRemainder = Buffer.alloc(0)
    }
  }

  /** Adds one bounded frame contribution and evicts its exact prior contribution. */
  private analyzeFrame(frame: Buffer): void {
    const samples = frame.length / 2
    const bins = new Uint16Array(128)
    for (let offset = 0; offset < frame.length; offset += 2) {
      const sample = frame.readInt16LE(offset)
      bins[(sample + 32_768) >>> 9] += 1
    }
    let modalBin = 0
    for (let bin = 1; bin < bins.length; bin += 1) {
      if (bins[bin] > bins[modalBin])
        modalBin = bin
    }
    // A fixed coarse modal baseline rejects DC-biased isolated impulses without
    // sorting or retaining the capture. It remains local to this bounded frame.
    const baseline = modalBin * 512 - 32_768 + 256
    let squaredAc = 0
    let active = 0
    let run = 0
    let longestRun = 0
    for (let offset = 0; offset < frame.length; offset += 2) {
      const ac = frame.readInt16LE(offset) - baseline
      squaredAc += ac * ac
      if (Math.abs(ac) < this.threshold) {
        run = 0
        continue
      }
      active += 1
      run += 1
      longestRun = Math.max(longestRun, run)
    }
    const rms = Math.sqrt(squaredAc / samples)
    const energetic = rms >= this.threshold && active / samples >= 0.2 && longestRun >= 2
    this.frames.push({ energetic, samples })
    if (energetic)
      this.energeticSamples += samples
    this.trimFrames()
  }

  /** Maintains a fixed rolling evidence window without retaining full capture PCM. */
  private trimFrames(): void {
    let windowSamples = this.frames.reduce((total, frame) => total + frame.samples, 0)
    while (windowSamples > this.confirmationWindowSamples && this.frames.length > 0) {
      const oldest = this.frames.shift()!
      windowSamples -= oldest.samples
      if (oldest.energetic)
        this.energeticSamples -= oldest.samples
    }
  }

  /** Seals the only partial fixed frame as part of terminal finalization. */
  private flushAnalysisRemainder(): void {
    if (this.analysisRemainder.length === 0)
      return
    this.analyzeFrame(this.analysisRemainder)
    this.analysisRemainder = Buffer.alloc(0)
  }

  /** Retains only bounded, complete PCM16 pre-roll until ownership transfers on admission. */
  private appendPreRoll(pcm: Buffer): void {
    for (let offset = 0; offset < pcm.length; offset += 2) {
      if (this.preRollLength === this.maxPreRollBytes) {
        this.preRollStart = (this.preRollStart + 2) % this.maxPreRollBytes
        this.preRollLength -= 2
      }
      const target = (this.preRollStart + this.preRollLength) % this.maxPreRollBytes
      this.preRoll[target] = pcm[offset]
      this.preRoll[(target + 1) % this.maxPreRollBytes] = pcm[offset + 1]
      this.preRollLength += 2
    }
  }

  /** Copies chronological pre-roll into a release-owned buffer. */
  private copyPreRoll(): Buffer {
    const output = Buffer.allocUnsafeSlow(this.preRollLength)
    for (let offset = 0; offset < this.preRollLength; offset += 1)
      output[offset] = this.preRoll[(this.preRollStart + offset) % this.maxPreRollBytes]
    return output
  }

  /** Splits released PCM into independent provider append buffers. */
  private release(pcm: Buffer): Buffer[] {
    const chunks: Buffer[] = []
    for (let offset = 0; offset < pcm.length; offset += this.releaseChunkBytes)
      chunks.push(Buffer.from(pcm.subarray(offset, offset + this.releaseChunkBytes)))
    return chunks
  }
}

/**
 * Converts Qwen's 24 kHz mono PCM16 stream into Discord's 48 kHz stereo PCM16 stream.
 *
 * Use when:
 * - Qwen Realtime `response.audio.delta` bytes are played through `StreamType.Raw`.
 * - Provider chunks may split a 16-bit sample across adjacent WebSocket events.
 *
 * Expects:
 * - Little-endian signed PCM16 at 24 kHz with one channel.
 *
 * Returns:
 * - Little-endian signed PCM16 at 48 kHz with two identical channels.
 */
export class Pcm24kMonoTo48kStereoTransform extends Transform {
  private trailingByte: Buffer | undefined
  private previousSample: number | undefined

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const inputChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const input = this.trailingByte
      ? Buffer.concat([this.trailingByte, inputChunk])
      : inputChunk
    const completeByteLength = input.length - (input.length % 2)
    this.trailingByte = completeByteLength === input.length
      ? undefined
      : Buffer.from(input.subarray(completeByteLength))

    if (completeByteLength === 0) {
      callback()
      return
    }

    const sampleCount = completeByteLength / 2
    const outputSampleCount = (sampleCount - (this.previousSample === undefined ? 1 : 0)) * 4
    const output = Buffer.allocUnsafe(Math.max(0, outputSampleCount * 2))
    let outputOffset = 0

    for (let inputOffset = 0; inputOffset < completeByteLength; inputOffset += 2) {
      const currentSample = input.readInt16LE(inputOffset)
      if (this.previousSample === undefined) {
        this.previousSample = currentSample
        continue
      }

      const midpoint = Math.trunc((this.previousSample + currentSample) / 2)
      for (const sample of [this.previousSample, midpoint]) {
        output.writeInt16LE(sample, outputOffset)
        output.writeInt16LE(sample, outputOffset + 2)
        outputOffset += 4
      }
      this.previousSample = currentSample
    }

    if (outputOffset > 0)
      this.push(output.subarray(0, outputOffset))
    callback()
  }

  _flush(callback: (error?: Error | null) => void) {
    if (this.trailingByte) {
      callback(new Error('Qwen PCM stream ended with an incomplete 16-bit sample.'))
      return
    }

    if (this.previousSample !== undefined) {
      const output = Buffer.allocUnsafe(8)
      output.writeInt16LE(this.previousSample, 0)
      output.writeInt16LE(this.previousSample, 2)
      output.writeInt16LE(this.previousSample, 4)
      output.writeInt16LE(this.previousSample, 6)
      this.push(output)
    }
    callback()
  }
}

export function getWavHeader(
  audioLength: number,
  sampleRate: number,
  channelCount: number = 1,
  bitsPerSample: number = 16,
): Buffer {
  const wavHeader = Buffer.alloc(44)
  wavHeader.write('RIFF', 0)
  wavHeader.writeUInt32LE(36 + audioLength, 4) // Length of entire file in bytes minus 8
  wavHeader.write('WAVE', 8)
  wavHeader.write('fmt ', 12)
  wavHeader.writeUInt32LE(16, 16) // Length of format data
  wavHeader.writeUInt16LE(1, 20) // Type of format (1 is PCM)
  wavHeader.writeUInt16LE(channelCount, 22) // Number of channels
  wavHeader.writeUInt32LE(sampleRate, 24) // Sample rate
  wavHeader.writeUInt32LE(
    (sampleRate * bitsPerSample * channelCount) / 8,
    28,
  ) // Byte rate
  wavHeader.writeUInt16LE((bitsPerSample * channelCount) / 8, 32) // Block align ((BitsPerSample * Channels) / 8)
  wavHeader.writeUInt16LE(bitsPerSample, 34) // Bits per sample
  wavHeader.write('data', 36) // Data chunk header
  wavHeader.writeUInt32LE(audioLength, 40) // Data chunk size
  return wavHeader
}

export function convertOpusToWav(pcmBuffer: Buffer): Buffer {
  try {
    // Generate the WAV header
    const wavHeader = getWavHeader(
      pcmBuffer.length,
      DECODE_SAMPLE_RATE,
    )

    // Concatenate the WAV header and PCM data
    const wavBuffer = Buffer.concat([wavHeader, pcmBuffer])

    return wavBuffer
  }
  catch (error) {
    console.error('[audio] PCM-to-WAV conversion failed', {
      failureCategory: 'audio-wav-conversion-failure',
    })
    throw error
  }
}
