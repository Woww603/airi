import { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'

import { clickTrainPcm16, constantPcm16, createPcm16Cursor, lowNoisePcm16, multiLevelSparseImpulsePcm16, periodicPcm16, sparseClickPcm16, speechPcm16, squarePcm16, voicedHarmonicPcm16 } from '../test/pcmFixtures'

import * as audioModule from './audio'

/** Public constructor configuration shared by the two deliberately separate PCM16 gates. */
interface Pcm16GateOptions {
  readonly confirmationMs: number
  readonly preRollMs: number
  readonly rmsThreshold: number
  readonly sampleRate: number
}

/** Public terminal result required from the planned Qwen-only admission boundary. */
interface Pcm16InputSafetyGateFinalization {
  readonly released: Buffer[]
  readonly status: 'admitted' | 'rejected:below-threshold' | 'rejected:incomplete-sample' | 'rejected:insufficient-duration' | 'rejected:no-samples'
}

/** Public capability required from the planned {@link Pcm16InputSafetyGate} boundary. */
interface Pcm16InputSafetyGate {
  finalize: () => Pcm16InputSafetyGateFinalization
  getStatus: () => Pcm16InputSafetyGateFinalization['status']
  push: (pcm: Buffer) => Buffer[] | undefined
  reset: () => void
}

interface Pcm16InputSafetyGateConstructor {
  new (options: Pcm16GateOptions): Pcm16InputSafetyGate
}

/** Classic barge-in remains a distinct public responsibility from Qwen input admission. */
interface Pcm16InterruptionGate {
  push: (pcm: Buffer) => Buffer[] | undefined
  reset: () => void
}

interface Pcm16InterruptionGateConstructor {
  new (options: Pcm16GateOptions): Pcm16InterruptionGate
}

/** Narrows only the planned public Qwen constructor; it never reaches into module internals. */
function hasPcm16InputSafetyGate(module: object): module is { readonly Pcm16InputSafetyGate: Pcm16InputSafetyGateConstructor } {
  return 'Pcm16InputSafetyGate' in module && typeof module.Pcm16InputSafetyGate === 'function'
}

/** Narrows only the planned public classic constructor; it never reaches into module internals. */
function hasPcm16InterruptionGate(module: object): module is { readonly Pcm16InterruptionGate: Pcm16InterruptionGateConstructor } {
  return 'Pcm16InterruptionGate' in module && typeof module.Pcm16InterruptionGate === 'function'
}

function createInputSafetyGate(options: Pcm16GateOptions): Pcm16InputSafetyGate | undefined {
  expect(hasPcm16InputSafetyGate(audioModule), 'Pcm16InputSafetyGate public constructor').toBe(true)
  if (!hasPcm16InputSafetyGate(audioModule))
    return undefined
  return new audioModule.Pcm16InputSafetyGate(options)
}

function createInterruptionGate(options: Pcm16GateOptions): Pcm16InterruptionGate | undefined {
  expect(hasPcm16InterruptionGate(audioModule), 'Pcm16InterruptionGate public constructor').toBe(true)
  if (!hasPcm16InterruptionGate(audioModule))
    return undefined
  return new audioModule.Pcm16InterruptionGate(options)
}

/**
 * @example
 * describe('Discord voice WAV encoding', () => {})
 */
describe('discord voice WAV encoding', () => {
  /**
   * @example
   * it('writes a valid mono PCM header with the exact payload length', () => {})
   */
  it('writes a valid mono PCM header with the exact payload length', () => {
    const header = audioModule.getWavHeader(8, 48_000)

    expect(header.toString('ascii', 0, 4)).toBe('RIFF')
    expect(header.readUInt32LE(4)).toBe(44)
    expect(header.toString('ascii', 8, 12)).toBe('WAVE')
    expect(header.readUInt16LE(20)).toBe(1)
    expect(header.readUInt16LE(22)).toBe(1)
    expect(header.readUInt32LE(24)).toBe(48_000)
    expect(header.readUInt16LE(34)).toBe(16)
    expect(header.readUInt32LE(40)).toBe(8)
  })

  /**
   * @example
   * it('preserves decoded PCM bytes after the WAV header', () => {})
   */
  it('preserves decoded PCM bytes after the WAV header', () => {
    const pcm = Buffer.from([1, 2, 3, 4])
    const wav = audioModule.convertOpusToWav(pcm)

    expect(wav.byteLength).toBe(48)
    expect(wav.subarray(44)).toEqual(pcm)
  })

  /**
   * @example
   * it('keeps conversion errors observable without logging external error content (Discord audit P2-B)', () => {})
   */
  it('keeps conversion errors observable without logging external error content (Discord audit P2-B)', () => {
    const privateSentinels = [
      'synthetic-error-message-sentinel',
      'https://provider.invalid/private?credential=synthetic-secret-sentinel',
      '/private/synthetic-user/audio-input.raw',
    ]
    const externalError = new Error(privateSentinels.join(' '))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const invalidAudio = {
      get length() {
        throw externalError
      },
    }

    // ROOT CAUSE:
    //
    // PCM-to-WAV conversion caught an external failure and passed the complete
    // Error object to console.error. Error messages and stacks can contain
    // provider URLs, local paths, Discord identifiers, or credentials.
    //
    // The conversion boundary now emits one fixed allowlisted category while
    // rethrowing the original failure unchanged to its owning caller.
    expect(() => Reflect.apply(audioModule.convertOpusToWav, undefined, [invalidAudio])).toThrow(externalError)

    const serializedLogs = JSON.stringify(errorSpy.mock.calls, (_key: string, value: unknown) => {
      if (value instanceof Error) {
        return {
          message: value.message,
          name: value.name,
          stack: value.stack,
        }
      }
      return value
    })
    for (const sentinel of privateSentinels)
      expect(serializedLogs).not.toContain(sentinel)
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith('[audio] PCM-to-WAV conversion failed', {
      failureCategory: 'audio-wav-conversion-failure',
    })

    errorSpy.mockRestore()
  })
})

/**
 * @example
 * describe('Qwen PCM output conversion', () => {})
 */
describe('qwen PCM output conversion', () => {
  /**
   * @example
   * it('upsamples 24 kHz mono PCM16 into 48 kHz stereo across odd chunk boundaries', async () => {})
   */
  it('upsamples 24 kHz mono PCM16 into 48 kHz stereo across odd chunk boundaries', async () => {
    const transform = new audioModule.Pcm24kMonoTo48kStereoTransform()
    const chunks: Buffer[] = []
    transform.on('data', chunk => chunks.push(Buffer.from(chunk)))

    transform.write(Buffer.from([0xE8]))
    transform.write(Buffer.from([0x03, 0xD0, 0x07]))
    transform.end()
    await new Promise<void>(resolve => transform.once('end', resolve))

    const output = Buffer.concat(chunks)
    const samples = Array.from({ length: output.length / 2 }, (_, index) => output.readInt16LE(index * 2))

    expect(samples).toEqual([
      1000,
      1000,
      1500,
      1500,
      2000,
      2000,
      2000,
      2000,
    ])
  })
})

/**
 * @example
 * describe('PCM16 Qwen input safety admission', () => {})
 */
describe('pcm16 Qwen input safety admission', () => {
  /**
   * @example
   * it('keeps silence, DC, and sparse impulses out of Qwen admission', () => {})
   */
  it('keeps silence, DC, and sparse impulses out of Qwen admission', () => {
    const createGate = () => createInputSafetyGate({ confirmationMs: 120, preRollMs: 250, rmsThreshold: 0.025, sampleRate: 16_000 })

    // ROOT CAUSE:
    //
    // Discord speaking events reflect transmitted microphone packets. Qwen's
    // local boundary is therefore an energetic/safety prefilter, not a human
    // speech classifier; the provider owns semantic VAD.
    //
    for (const [name, fixture] of [
      ['silence', Buffer.alloc(1_920)],
      ['DC', constantPcm16(4_000, 1_920)],
      ['sparse clicks', sparseClickPcm16(1_920)],
      ['19.9% DC-biased clicks', clickTrainPcm16(1_920, 19.9, { dcBias: 4_000 })],
      ['20% alternating DC-biased impulses', clickTrainPcm16(1_920, 20, { alternating: true, dcBias: 4_000 })],
      ['multi-level sparse DC-biased impulses', multiLevelSparseImpulsePcm16(1_920, 1, 4_000)],
    ] as const) {
      const gate = createGate()
      if (!gate)
        return
      gate.push(fixture)
      expect(gate.getStatus(), name).toBe('rejected:below-threshold')
    }
  })

  /** @example it('releases admitted PCM exactly once across arbitrary chunking and finalization', () => {}) */
  it('releases admitted PCM exactly once across arbitrary chunking and finalization', () => {
    const source = periodicPcm16(createPcm16Cursor(), 2_560, 50, 8_000)
    const plans = [
      { chunks: [source], name: 'one chunk' },
      { chunks: Array.from({ length: Math.ceil(source.length / 640) }, (_, index) => source.subarray(index * 640, index * 640 + 640)), name: '20 ms frames' },
      { chunks: Array.from({ length: Math.ceil(source.length / 127) }, (_, index) => source.subarray(index * 127, index * 127 + 127)), name: 'odd chunks' },
      { chunks: Array.from(source, byte => Buffer.from([byte])), name: 'one-byte feeds' },
    ]

    for (const { chunks, name } of plans) {
      const gate = createInputSafetyGate({ confirmationMs: 90, preRollMs: 250, rmsThreshold: 0.025, sampleRate: 16_000 })
      if (!gate)
        return
      const released = chunks.flatMap(chunk => gate.push(chunk) ?? [])
      const result = gate.finalize()
      expect(result.status, name).toBe('admitted')
      released.push(...result.released)
      const releasedPcm = Buffer.concat(released)
      expect(releasedPcm.byteLength, name).toBe(source.byteLength)
      expect(releasedPcm, name).toEqual(source)
    }
  })

  /** @example it('keeps an oversized admission chunk byte-exact across chunking', () => {}) */
  it('keeps an oversized admission chunk byte-exact across chunking', () => {
    const cursor = createPcm16Cursor()
    const retainedPrefix = lowNoisePcm16(cursor, 320)
    const oversizedCurrentChunk = speechPcm16(cursor, 6_000, 8_000)
    const source = Buffer.concat([retainedPrefix, oversizedCurrentChunk])
    const plans = [
      { chunks: [retainedPrefix, oversizedCurrentChunk], name: 'oversized admission chunk' },
      { chunks: Array.from({ length: Math.ceil(source.length / 640) }, (_, index) => source.subarray(index * 640, index * 640 + 640)), name: '20 ms frames' },
      { chunks: Array.from({ length: Math.ceil(source.length / 127) }, (_, index) => source.subarray(index * 127, index * 127 + 127)), name: 'odd chunks' },
      { chunks: Array.from(source, byte => Buffer.from([byte])), name: 'one-byte feeds' },
    ]

    // ROOT CAUSE:
    //
    // The pre-roll ring is bounded, but a current chunk can exceed it. If the
    // gate appends that whole chunk before forming the admission release, the
    // oldest bytes of the current chunk are overwritten and lost. Chunking then
    // changes provider input, even though PCM and admission are identical.
    //
    // Admission must transfer the retained aligned prefix plus every complete
    // byte from its current chunk, while `finalize` contributes no replay.
    expect(plans.map(plan => Buffer.concat(plan.chunks))).toEqual(plans.map(() => source))
    const outcomes = plans.map(({ chunks, name }) => {
      const gate = createInputSafetyGate({ confirmationMs: 120, preRollMs: 250, rmsThreshold: 0.025, sampleRate: 16_000 })
      if (!gate)
        throw new Error('Pcm16InputSafetyGate must be publicly constructible.')
      const released = chunks.flatMap(chunk => gate.push(chunk) ?? [])
      const firstFinalization = gate.finalize()
      released.push(...firstFinalization.released)
      return {
        bytes: Buffer.concat(released),
        name,
        secondFinalization: gate.finalize(),
        status: firstFinalization.status,
      }
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(plans.map(() => 'admitted'))
    expect(outcomes.map(outcome => outcome.bytes.equals(source))).toEqual(plans.map(() => true))
    expect(outcomes.map(outcome => outcome.secondFinalization)).toEqual(plans.map(() => ({ released: [], status: 'admitted' })))
  })

  /** @example it('delivers the retained admission window from the admission push', () => {}) */
  it('delivers the retained admission window from the admission push', () => {
    const gate = createInputSafetyGate({ confirmationMs: 90, preRollMs: 250, rmsThreshold: 0.025, sampleRate: 16_000 })
    if (!gate)
      return
    const cursor = createPcm16Cursor()
    const preAdmission = speechPcm16(cursor, 1_439, 8_000)
    const admissionSample = speechPcm16(cursor, 1, 8_000)
    const nextCompleteSample = speechPcm16(cursor, 1, 8_000)

    expect(gate.push(preAdmission)).toBeUndefined()

    // ROOT CAUSE:
    //
    // The caller can only append PCM returned from `push`. Deferring the
    // admission window to a later push or `finalize` either loses it when the
    // caller follows that API or replays data it has already appended.
    //
    // The admission push therefore transfers every still-retained complete
    // byte exactly once, including its own final sample.
    const admissionRelease = gate.push(admissionSample) ?? []
    const admissionPcm = Buffer.concat(admissionRelease)
    const expectedAdmissionPcm = Buffer.concat([preAdmission, admissionSample])
    expect(admissionPcm.byteLength).toBe(expectedAdmissionPcm.byteLength)
    expect(admissionPcm).toEqual(expectedAdmissionPcm)

    const nextRelease = gate.push(nextCompleteSample) ?? []
    expect(Buffer.concat(nextRelease)).toEqual(nextCompleteSample)

    const firstFinalization = gate.finalize()
    expect(firstFinalization).toEqual({ released: [], status: 'admitted' })
    expect(gate.finalize()).toEqual({ released: [], status: 'admitted' })
  })

  /** @example it('preserves PCM16 alignment before and after admission', () => {}) */
  it('preserves PCM16 alignment before and after admission', () => {
    const gate = createInputSafetyGate({ confirmationMs: 20, preRollMs: 20, rmsThreshold: 0.025, sampleRate: 16_000 })
    if (!gate)
      return
    const energetic = periodicPcm16(createPcm16Cursor(), 320, 60, 8_000)
    expect(gate.push(energetic.subarray(0, 1))).toBeUndefined()
    const admissionRelease = gate.push(energetic.subarray(1)) ?? []
    const admittedPcm = Buffer.concat(admissionRelease)
    expect(admittedPcm.byteLength).toBe(energetic.byteLength)
    expect(admittedPcm).toEqual(energetic)
    const sample = Buffer.from([0x34, 0x12])
    expect(gate.push(sample.subarray(0, 1))).toBeUndefined()
    expect(gate.push(sample.subarray(1))).toEqual([sample])
  })

  /** @example it('finalizes Qwen admission atomically and exactly once', () => {}) */
  it('finalizes Qwen admission atomically and exactly once', () => {
    const cases = [
      { expected: 'rejected:insufficient-duration' as const, samples: 1_439 },
      { expected: 'admitted' as const, samples: 1_440 },
      { expected: 'admitted' as const, samples: 1_441 },
      { expected: 'admitted' as const, samples: 1_520 },
    ]

    // ROOT CAUSE:
    //
    // getStatus sealed a partial analysis frame and changed the admission
    // result, but it had no corresponding public release operation. The
    // already-pushed tail was therefore silently absent from provider input.
    // Finalization must make terminal decision and PCM ownership one atomic
    // public step; a status query must remain observational only.
    for (const testCase of cases) {
      const gate = createInputSafetyGate({ confirmationMs: 90, preRollMs: 250, rmsThreshold: 0.025, sampleRate: 16_000 })
      if (!gate)
        return
      const input = speechPcm16(createPcm16Cursor(), testCase.samples, 8_000)
      const pushReleased = gate.push(input) ?? []

      expect(gate.getStatus(), `${testCase.samples} samples query`).toBe(testCase.expected)
      const firstFinalization = gate.finalize()
      expect(firstFinalization.status, `${testCase.samples} samples terminal status`).toBe(testCase.expected)
      const expectedReleased = testCase.expected === 'admitted' ? input : Buffer.alloc(0)
      const pushedPcm = Buffer.concat(pushReleased)
      const finalizedPcm = Buffer.concat(firstFinalization.released)
      expect(Buffer.concat([pushedPcm, finalizedPcm]), `${testCase.samples} samples total release`).toEqual(expectedReleased)
      expect(finalizedPcm, `${testCase.samples} samples terminal release`).toEqual(expectedReleased.subarray(pushedPcm.length))
      expect(gate.finalize()).toEqual({ released: [], status: testCase.expected })
      expect(() => gate.push(Buffer.from([0x34, 0x12]))).toThrow()
      gate.reset()
      expect(gate.push(speechPcm16(createPcm16Cursor(), 320, 8_000))).toBeUndefined()
    }

    const incompleteGate = createInputSafetyGate({ confirmationMs: 90, preRollMs: 250, rmsThreshold: 0.025, sampleRate: 16_000 })
    if (!incompleteGate)
      return
    incompleteGate.push(speechPcm16(createPcm16Cursor(), 1_440, 8_000).subarray(0, 2_879))
    expect(incompleteGate.finalize()).toEqual({ released: [], status: 'rejected:incomplete-sample' })

    const admittedOddGate = createInputSafetyGate({ confirmationMs: 90, preRollMs: 250, rmsThreshold: 0.025, sampleRate: 16_000 })
    if (!admittedOddGate)
      return
    const admittedPcm = speechPcm16(createPcm16Cursor(), 1_440, 8_000)
    const releasedBeforeOddTerminal = admittedOddGate.push(admittedPcm) ?? []
    const releasedWithDanglingByte = admittedOddGate.push(Buffer.from([0x34])) ?? []
    const oddTerminal = admittedOddGate.finalize()
    expect(oddTerminal).toEqual({ released: [], status: 'rejected:incomplete-sample' })
    expect(Buffer.concat([...releasedBeforeOddTerminal, ...releasedWithDanglingByte]).byteLength % 2).toBe(0)
  })

  /**
   * @example
   * it('admits sustained energetic AC without classifying it as speech', () => {})
   */
  it('admits sustained energetic AC without classifying it as speech', () => {
    const createGate = () => createInputSafetyGate({ confirmationMs: 120, preRollMs: 250, rmsThreshold: 0.025, sampleRate: 16_000 })
    const settle = (gate: Pcm16InputSafetyGate, nextPcm: () => Buffer) => {
      for (let index = 0; index < 6; index += 1)
        gate.push(nextPcm())
      return gate.getStatus()
    }

    // ROOT CAUSE:
    //
    // Hum is an energetic admission fixture, not a human-speech fixture.
    // Semantic classification belongs to Qwen's provider VAD, while this local
    // boundary only rejects unsafe non-audio-like input before socket append.
    for (const frequency of [50, 60]) {
      const cursor = createPcm16Cursor()
      const gate = createGate()
      if (!gate)
        return
      expect(settle(gate, () => periodicPcm16(cursor, 320, frequency, 8_000))).toBe('admitted')
    }
    for (const [fundamentalHz, clipped] of [[70, false], [85, true], [110, false], [140, true]] as const) {
      const cursor = createPcm16Cursor()
      const gate = createGate()
      if (!gate)
        return
      expect(settle(gate, () => voicedHarmonicPcm16(cursor, 320, fundamentalHz, 24_000, { clipped, envelope: true }))).toBe('admitted')
    }
    for (const frequency of [50, 80, 140]) {
      const cursor = createPcm16Cursor()
      const gate = createGate()
      if (!gate)
        return
      expect(settle(gate, () => squarePcm16(cursor, 320, frequency, 8_000))).toBe('admitted')
    }

    const prefixedGate = createGate()
    if (!prefixedGate)
      return
    const prefixCursor = createPcm16Cursor()
    for (let index = 0; index < 10; index += 1)
      prefixedGate.push(lowNoisePcm16(prefixCursor, 320))
    expect(settle(prefixedGate, () => squarePcm16(prefixCursor, 320, 60, 8_000))).toBe('admitted')
  })

  /** @example it('does not revoke a completed admission after later silence', () => {}) */
  it('does not revoke a completed admission after later silence', () => {
    const gate = createInputSafetyGate({ confirmationMs: 90, preRollMs: 250, rmsThreshold: 0.025, sampleRate: 16_000 })
    if (!gate)
      return
    const cursor = createPcm16Cursor()
    for (let index = 0; index < 6; index += 1)
      gate.push(speechPcm16(cursor, 320, 8_000))
    expect(gate.getStatus()).toBe('admitted')

    // Admission transfers ownership of the capture to the provider append
    // path. Later quiet PCM cannot retrospectively turn that transfer into a
    // local rejection.
    gate.push(Buffer.alloc(256_000))
    expect(gate.getStatus()).toBe('admitted')
  })

  /** @example it('keeps a long one-byte split capture ordered without replaying released bytes', () => {}) */
  it('keeps a long one-byte split capture ordered without replaying released bytes', () => {
    const gate = createInputSafetyGate({ confirmationMs: 90, preRollMs: 250, rmsThreshold: 0.025, sampleRate: 16_000 })
    if (!gate)
      return
    const source = speechPcm16(createPcm16Cursor(), 2_048, 8_000)
    const released = Array.from(source, byte => gate.push(Buffer.from([byte])) ?? []).flat()
    released.push(...gate.finalize().released)

    const releasedPcm = Buffer.concat(released)
    expect(releasedPcm.byteLength).toBe(source.byteLength)
    expect(releasedPcm).toEqual(source)
  })
})

/** @example describe('PCM16 classic interruption', () => {}) */
describe('pcm16 classic interruption', () => {
  /** @example it('interrupts playback for representative speech but not low-energy noise', () => {}) */
  it('interrupts playback for representative speech but not low-energy noise', () => {
    const options = { confirmationMs: 20, preRollMs: 20, rmsThreshold: 0.025, sampleRate: 16_000 }
    const speechGate = createInterruptionGate(options)
    if (!speechGate)
      return
    const noiseGate = createInterruptionGate(options)
    if (!noiseGate)
      return

    // Classic barge-in has its own interruption contract. Do not route the
    // Qwen energetic-AC fixture through this regression or infer semantic VAD.
    expect(speechGate.push(speechPcm16(createPcm16Cursor(), 320, 8_000))).toBeDefined()
    expect(noiseGate.push(lowNoisePcm16(createPcm16Cursor(), 320))).toBeUndefined()
  })
})
