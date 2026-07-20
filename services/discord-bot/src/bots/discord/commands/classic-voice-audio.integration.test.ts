import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

const isolatedDirectory = mkdtempSync(join(tmpdir(), 'airi-d030-no-ffmpeg-'))
const summonModuleUrl = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'summon.ts')).href
const tsxLoaderUrl = import.meta.resolve('tsx')

function createOggPage(sequence: number, headerType: number, granulePosition: bigint, segment: Buffer): Buffer {
  const page = Buffer.alloc(28 + segment.length)
  page.write('OggS', 0, 'ascii')
  page.writeUInt8(0, 4)
  page.writeUInt8(headerType, 5)
  page.writeBigUInt64LE(granulePosition, 6)
  page.writeUInt32LE(0xD030, 14)
  page.writeUInt32LE(sequence, 18)
  page.writeUInt8(1, 26)
  page.writeUInt8(segment.length, 27)
  segment.copy(page, 28)
  page.writeUInt32LE(calculateOggChecksum(page), 22)
  return page
}

function createMinimalDiscordOggOpus(): Buffer {
  const opusHead = Buffer.alloc(19)
  opusHead.write('OpusHead', 0, 'ascii')
  opusHead.writeUInt8(1, 8)
  opusHead.writeUInt8(2, 9)
  opusHead.writeUInt32LE(48_000, 12)
  const opusTags = Buffer.alloc(16)
  opusTags.write('OpusTags', 0, 'ascii')
  const opusPacket = Buffer.from([0xF8, 0xFF, 0xFE])
  return Buffer.concat([
    createOggPage(0, 2, 0n, opusHead),
    createOggPage(1, 0, 0n, opusTags),
    createOggPage(2, 4, 960n, opusPacket),
  ])
}

function calculateOggChecksum(page: Buffer): number {
  const checksumInput = Buffer.from(page)
  checksumInput.fill(0, 22, 26)
  let checksum = 0
  for (const byte of checksumInput) {
    checksum ^= byte << 24
    for (let bit = 0; bit < 8; bit++) {
      checksum = (checksum & 0x8000_0000) !== 0
        ? ((checksum << 1) ^ 0x04C1_1DB7) >>> 0
        : (checksum << 1) >>> 0
    }
  }
  return checksum >>> 0
}

function readOggPages(stream: Buffer): Buffer[] {
  const pages: Buffer[] = []
  let offset = 0
  while (offset < stream.length) {
    if (stream.subarray(offset, offset + 4).toString('ascii') !== 'OggS')
      throw new Error('Synthetic Ogg fixture contains an invalid capture pattern.')

    const segmentCount = stream.readUInt8(offset + 26)
    const segmentTable = stream.subarray(offset + 27, offset + 27 + segmentCount)
    const payloadLength = segmentTable.reduce((total, length) => total + length, 0)
    const pageLength = 27 + segmentCount + payloadLength
    pages.push(stream.subarray(offset, offset + pageLength))
    offset += pageLength
  }
  return pages
}

function runProductionPlayback(fixture: Buffer, expectCorrupt: boolean) {
  const childSource = `
    import { Buffer } from 'node:buffer'
    import { Readable } from 'node:stream'
    import { VoiceManager } from ${JSON.stringify(summonModuleUrl)}

    const manager = new VoiceManager(
      { user: { id: 'synthetic-d030-bot' } },
      async () => undefined,
      async () => '',
    )
    const controller = new AbortController()
    const scope = { channelId: 'synthetic-d030-channel', generation: 1, guildId: 'synthetic-d030-guild' }
    try {
      await manager.playAudioStream(
        { subscribe: () => undefined },
        Readable.from(Buffer.from(process.env.SYNTHETIC_D030_AUDIO, 'base64')),
        controller.signal,
        scope,
        Date.now() + 5_000,
      )
      if (${JSON.stringify(expectCorrupt)})
        throw new Error('corrupt classic voice audio was accepted')
      const playback = [...Reflect.get(manager, 'activeClassicPlaybacks').values()][0]
      const edgeTypes = playback.player.state.resource?.edges?.map(edge => edge.type) ?? []
      if (!edgeTypes.includes('ogg/opus demuxer'))
        throw new Error('classic voice resource did not install the Ogg Opus demuxer')
      controller.abort()
      console.log(JSON.stringify({ edgeTypes }))
      process.exit(0)
    }
    catch (error) {
      if (${JSON.stringify(expectCorrupt)} && error?.name === 'DiscordVoiceAudioFormatError') {
        console.log(JSON.stringify({ errorName: error.name }))
        process.exit(0)
      }
      console.error(error?.stack ?? String(error))
      process.exit(1)
    }
  `

  return spawnSync(process.execPath, [
    '--import',
    tsxLoaderUrl,
    '--input-type=module',
    '--eval',
    childSource,
  ], {
    cwd: isolatedDirectory,
    encoding: 'utf8',
    env: {
      HOME: isolatedDirectory,
      NO_COLOR: '1',
      PATH: isolatedDirectory,
      SYNTHETIC_D030_AUDIO: fixture.toString('base64'),
      TMPDIR: isolatedDirectory,
    },
    timeout: 10_000,
  })
}

afterAll(() => {
  rmSync(isolatedDirectory, { force: true, recursive: true })
})

/**
 * @example
 * describe('classic Discord Ogg Opus production playback', () => {})
 */
describe('classic Discord Ogg Opus production playback', () => {
  /**
   * @example
   * it('Discord audit D-030 uses a spec-valid synthetic Ogg Opus fixture', () => {})
   */
  it('uses a spec-valid synthetic Ogg Opus fixture for Discord audit D-030', () => {
    // ROOT CAUSE:
    //
    // The original regression fixture used zero Ogg CRC fields and omitted
    // the mandatory OpusTags header. prism-media happened to accept those
    // malformed pages, so the test did not prove a real provider-compatible
    // Ogg Opus stream reaches Discord's production demux path.
    const pages = readOggPages(createMinimalDiscordOggOpus())

    // @example
    expect(pages).toHaveLength(3)
    // @example
    expect(pages[0].subarray(28, 36).toString('ascii')).toBe('OpusHead')
    // @example
    expect(pages[1].subarray(28, 36).toString('ascii')).toBe('OpusTags')
    // @example
    expect(pages[2].readUInt8(5)).toBe(4)
    // @example
    expect(pages[2].readBigUInt64LE(6)).toBe(960n)
    for (const page of pages) {
      // @example
      expect(page.readUInt32LE(22)).toBe(calculateOggChecksum(page))
      // @example
      expect(page.readUInt32LE(22)).not.toBe(0)
    }
  })

  /**
   * @example
   * it('Discord audit D-030 consumes valid Ogg Opus without an FFmpeg executable', () => {})
   */
  it('consumes valid Ogg Opus without an FFmpeg executable for Discord audit D-030', () => {
    // ROOT CAUSE:
    //
    // StreamType.Arbitrary always constructed Discord Voice's FFmpeg pipeline.
    // A clean runtime with an empty PATH and no cwd-local binary therefore
    // failed even for an Ogg Opus payload that Discord can demux directly.
    const result = runProductionPlayback(createMinimalDiscordOggOpus(), false)

    // @example
    expect(result.status, result.stderr).toBe(0)
    // @example
    expect(result.stdout).toContain('ogg/opus demuxer')
    // @example
    expect(result.stderr).not.toContain('FFmpeg/avconv not found')
  })

  /**
   * @example
   * it('Discord audit D-030 rejects corrupt provider bytes before playback', () => {})
   */
  it('rejects corrupt provider bytes before playback for Discord audit D-030', () => {
    // ROOT CAUSE:
    //
    // xsAI returns only an ArrayBuffer and does not preserve a response MIME
    // type. Without probing the provider bytes, changing the input type would
    // merely relabel arbitrary or corrupt data as Ogg Opus.
    const result = runProductionPlayback(Buffer.from('SYNTHETIC_CORRUPT_D030_AUDIO'), true)

    // @example
    expect(result.status, result.stderr).toBe(0)
    // @example
    expect(result.stdout).toContain('DiscordVoiceAudioFormatError')
    // @example
    expect(result.stderr).not.toContain('SYNTHETIC_CORRUPT_D030_AUDIO')
  })
})
