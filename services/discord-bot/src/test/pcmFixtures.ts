import { Buffer } from 'node:buffer'

import OpusScript from 'opusscript'

/** A deterministic PCM sample position shared across generated transport chunks. */
export interface Pcm16Cursor {
  /** Absolute 16 kHz mono sample position. */
  sampleIndex: number
}

/** Precomputed 200/400/600 Hz harmonic waveform for representative classic interruption input. */
const speechWavetable = [
  0,
  4423,
  8754,
  12908,
  16802,
  20364,
  23535,
  26267,
  28529,
  30304,
  31591,
  32403,
  32767,
  32721,
  32313,
  31596,
  30628,
  29468,
  28174,
  26797,
  25386,
  23979,
  22607,
  21289,
  20039,
  18857,
  17738,
  16669,
  15633,
  14609,
  13575,
  12510,
  11395,
  10215,
  8960,
  7625,
  6212,
  4729,
  3187,
  1604,
  0,
  -1604,
  -3187,
  -4729,
  -6212,
  -7625,
  -8960,
  -10215,
  -11395,
  -12510,
  -13575,
  -14609,
  -15633,
  -16669,
  -17738,
  -18857,
  -20039,
  -21289,
  -22607,
  -23979,
  -25386,
  -26797,
  -28174,
  -29468,
  -30628,
  -31596,
  -32313,
  -32721,
  -32767,
  -32403,
  -31591,
  -30304,
  -28529,
  -26267,
  -23535,
  -20364,
  -16802,
  -12908,
  -8754,
  -4423,
] as const

/** Fixed non-DC low-noise waveform with a peak of 400. */
const lowNoiseWavetable = [0, 400, -400, 240, -240, 160, -160, 80, -80, 40, -40, 0] as const

/** 20 ms speech-energy envelope, expressed in thousandths. */
const speechEnvelope = [1000, 780, 920, 700, 860, 740, 960, 820] as const

/** Creates a cursor whose phase remains continuous across generated PCM chunks. */
export function createPcm16Cursor(): Pcm16Cursor {
  return { sampleIndex: 0 }
}

/**
 * Produces deterministic voiced PCM16 without resetting waveform phase per transport chunk.
 *
 * Use when:
 * - A test needs conversational energy that is distinct from DC or isolated clicks.
 * - PCM is deliberately split into arbitrary or odd-byte transport chunks.
 *
 * Expects:
 * - `sampleCount` is a whole number of 16 kHz mono samples.
 *
 * Returns:
 * - Little-endian PCM16 whose cursor continues at the following sample.
 */
export function speechPcm16(cursor: Pcm16Cursor, sampleCount: number, peak = 2_000): Buffer {
  const pcm = Buffer.alloc(sampleCount * 2)
  for (let index = 0; index < sampleCount; index += 1) {
    const sampleIndex = cursor.sampleIndex + index
    const waveform = speechWavetable[sampleIndex % speechWavetable.length]
    const envelope = speechEnvelope[Math.floor(sampleIndex / 320) % speechEnvelope.length]
    pcm.writeInt16LE(Math.trunc(waveform * peak * envelope / 32_767_000), index * 2)
  }
  cursor.sampleIndex += sampleCount
  return pcm
}

/**
 * Produces deterministic, quiet non-DC PCM16 without resetting its sample cursor.
 *
 * Use when:
 * - A test needs low environmental noise rather than stationary DC.
 *
 * Expects:
 * - `sampleCount` is a whole number of 16 kHz mono samples.
 *
 * Returns:
 * - Little-endian PCM16 with a peak of 400.
 */
export function lowNoisePcm16(cursor: Pcm16Cursor, sampleCount: number): Buffer {
  const pcm = Buffer.alloc(sampleCount * 2)
  for (let index = 0; index < sampleCount; index += 1)
    pcm.writeInt16LE(lowNoiseWavetable[(cursor.sampleIndex + index) % lowNoiseWavetable.length], index * 2)
  cursor.sampleIndex += sampleCount
  return pcm
}

/** Creates stationary PCM16 for tests that explicitly verify DC rejection. */
export function constantPcm16(amplitude: number, sampleCount: number): Buffer {
  const pcm = Buffer.alloc(sampleCount * 2)
  for (let index = 0; index < sampleCount; index += 1) {
    pcm.writeInt16LE(amplitude, index * 2)
  }
  return pcm
}

/**
 * Produces a deterministic sparse click train with optional DC bias.
 *
 * Before:
 * - `clickTrainPcm16(320, 12.5)`
 *
 * After:
 * - 40 full-scale impulses separated by seven silent samples
 */
export function clickTrainPcm16(
  sampleCount: number,
  activePercent: number,
  options: { alternating?: boolean, dcBias?: number } = {},
): Buffer {
  if (!Number.isFinite(activePercent) || activePercent <= 0 || activePercent > 100)
    throw new RangeError('Click-train activePercent must be in the range (0, 100].')

  const pcm = Buffer.alloc(sampleCount * 2)
  for (let index = 0; index < sampleCount; index += 1) {
    // Evenly distribute impulses so the requested ratio remains exact across
    // long fixtures instead of accidentally testing one burst shape.
    const isImpulse = Math.floor((index + 1) * activePercent / 100) > Math.floor(index * activePercent / 100)
    pcm.writeInt16LE(
      isImpulse
        ? (options.alternating && Math.floor(index * activePercent / 100) % 2 === 1 ? -32_767 : 32_767)
        : (options.dcBias ?? 0),
      index * 2,
    )
  }
  return pcm
}

/** Creates a 12.5% full-scale click train for tests that explicitly verify transient rejection. */
export function sparseClickPcm16(sampleCount: number): Buffer {
  return clickTrainPcm16(sampleCount, 12.5)
}

/**
 * Produces a phase-continuous periodic PCM16 waveform for voice-gate boundary tests.
 *
 * Before:
 * - `periodicPcm16(cursor, 320, 50, 8_000)`
 *
 * After:
 * - One 20 ms 50 Hz PCM16 waveform whose phase continues in the next call
 */
export function periodicPcm16(
  cursor: Pcm16Cursor,
  sampleCount: number,
  frequencyHz: number,
  peak: number,
  options: { clipped?: boolean, dcBias?: number, envelope?: boolean } = {},
): Buffer {
  const pcm = Buffer.alloc(sampleCount * 2)
  for (let index = 0; index < sampleCount; index += 1) {
    const sampleIndex = cursor.sampleIndex + index
    const envelope = options.envelope ? 0.55 + 0.45 * Math.sin(2 * Math.PI * sampleIndex / 1_280) : 1
    const raw = Math.round(Math.sin(2 * Math.PI * frequencyHz * sampleIndex / 16_000) * peak * envelope)
    const clipped = options.clipped ? Math.max(-10_000, Math.min(10_000, raw)) : raw
    pcm.writeInt16LE(Math.max(-32_768, Math.min(32_767, clipped + (options.dcBias ?? 0))), index * 2)
  }
  cursor.sampleIndex += sampleCount
  return pcm
}

/**
 * Produces a phase-continuous square PCM16 waveform for energetic-admission tests.
 *
 * Before:
 * - `squarePcm16(cursor, 320, 80, 8_000)`
 *
 * After:
 * - One 20 ms bipolar AC chunk whose phase continues in the next call
 */
export function squarePcm16(cursor: Pcm16Cursor, sampleCount: number, frequencyHz: number, peak: number): Buffer {
  const pcm = Buffer.alloc(sampleCount * 2)
  for (let index = 0; index < sampleCount; index += 1) {
    const phase = Math.sin(2 * Math.PI * frequencyHz * (cursor.sampleIndex + index) / 16_000)
    pcm.writeInt16LE(phase >= 0 ? peak : -peak, index * 2)
  }
  cursor.sampleIndex += sampleCount
  return pcm
}

/**
 * Produces sparse impulses with many levels so admission cannot classify only fixture shape.
 *
 * Before:
 * - `multiLevelSparseImpulsePcm16(1_920, 1, 4_000)`
 *
 * After:
 * - 1% non-zero samples with alternating signed, DC-biased impulse levels
 */
export function multiLevelSparseImpulsePcm16(sampleCount: number, activePercent: number, dcBias: number): Buffer {
  const pcm = Buffer.alloc(sampleCount * 2)
  const levels = [3_000, 5_000, 7_000, 9_000, 11_000, 13_000, 15_000, 17_000, 19_000, 21_000, 23_000, 25_000, 27_000, 29_000, 31_000, 32_767]
  for (let index = 0; index < sampleCount; index += 1) {
    const isImpulse = Math.floor((index + 1) * activePercent / 100) > Math.floor(index * activePercent / 100)
    const level = levels[index % levels.length] ?? 0
    const signedLevel = index % 2 === 0 ? level : -level
    pcm.writeInt16LE(Math.max(-32_768, Math.min(32_767, (isImpulse ? signedLevel : 0) + dcBias)), index * 2)
  }
  return pcm
}

/**
 * Produces a phase-continuous low-fundamental harmonic waveform for energetic gate tests.
 *
 * Before:
 * - `voicedHarmonicPcm16(cursor, 320, 85, 20_000)`
 *
 * After:
 * - One 20 ms low-F0 waveform with fundamental, second/third harmonics, and an optional envelope
 */
export function voicedHarmonicPcm16(
  cursor: Pcm16Cursor,
  sampleCount: number,
  fundamentalHz: number,
  peak: number,
  options: { clipped?: boolean, envelope?: boolean } = {},
): Buffer {
  const pcm = Buffer.alloc(sampleCount * 2)
  for (let index = 0; index < sampleCount; index += 1) {
    const sampleIndex = cursor.sampleIndex + index
    const phase = 2 * Math.PI * fundamentalHz * sampleIndex / 16_000
    const envelope = options.envelope ? 0.55 + 0.45 * Math.sin(2 * Math.PI * sampleIndex / 1_280) : 1
    const waveform = (Math.sin(phase) + 0.35 * Math.sin(phase * 2) + 0.15 * Math.sin(phase * 3)) / 1.5
    const raw = Math.round(waveform * peak * envelope)
    const sample = options.clipped ? Math.max(-10_000, Math.min(10_000, raw)) : raw
    pcm.writeInt16LE(sample, index * 2)
  }
  cursor.sampleIndex += sampleCount
  return pcm
}

/**
 * Encodes consecutive 20 ms Opus packets from one PCM cursor and encoder lifecycle.
 *
 * Use when:
 * - A receive-stream test writes multiple Opus packets.
 *
 * Returns:
 * - Packet generators that preserve codec and waveform continuity between calls.
 */
export function createOpusPcm16Fixture() {
  const cursor = createPcm16Cursor()
  const encoder = new OpusScript(16_000, 1, OpusScript.Application.AUDIO)

  return {
    // This is an energetic local-admission fixture only. It does not model or
    // assert provider semantic VAD.
    nextEnergeticAcPacket: (frequencyHz = 50) => encoder.encode(periodicPcm16(cursor, 320, frequencyHz, 8_000), 320),
    nextLowNoisePacket: () => encoder.encode(lowNoisePcm16(cursor, 320), 320),
    nextSpeechPacket: (peak = 3_200) => encoder.encode(speechPcm16(cursor, 320, peak), 320),
  }
}
