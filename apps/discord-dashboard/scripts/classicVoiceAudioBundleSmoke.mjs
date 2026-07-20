import process from 'node:process'

import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { errorMessageFrom } from '@moeru/std'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const appDirectory = resolve(scriptDirectory, '..')

function calculateOggChecksum(page) {
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

function createOggPage(sequence, headerType, granulePosition, segment) {
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

function createSyntheticOggOpus() {
  const opusHead = Buffer.alloc(19)
  opusHead.write('OpusHead', 0, 'ascii')
  opusHead.writeUInt8(1, 8)
  opusHead.writeUInt8(2, 9)
  opusHead.writeUInt32LE(48_000, 12)
  const opusTags = Buffer.alloc(16)
  opusTags.write('OpusTags', 0, 'ascii')
  const expectedPacket = Buffer.from([0xF8, 0xFF, 0xFE])
  return {
    expectedPacket,
    fixture: Buffer.concat([
      createOggPage(0, 2, 0n, opusHead),
      createOggPage(1, 0, 0n, opusTags),
      createOggPage(2, 4, 960n, expectedPacket),
    ]),
  }
}

function readOggPages(stream) {
  const pages = []
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

function validateSyntheticOggOpus(fixture) {
  const pages = readOggPages(fixture)
  if (pages.length !== 3)
    throw new Error('Synthetic Ogg Opus fixture must include OpusHead, OpusTags, and audio pages.')
  if (pages[0].subarray(28, 36).toString('ascii') !== 'OpusHead')
    throw new Error('Synthetic Ogg Opus fixture is missing its identification header.')
  if (pages[1].subarray(28, 36).toString('ascii') !== 'OpusTags')
    throw new Error('Synthetic Ogg Opus fixture is missing its comment header.')
  if (pages[2].readUInt8(5) !== 4 || pages[2].readBigUInt64LE(6) !== 960n)
    throw new Error('Synthetic Ogg Opus fixture has an invalid terminal audio page.')
  for (const page of pages) {
    const storedChecksum = page.readUInt32LE(22)
    if (storedChecksum === 0 || storedChecksum !== calculateOggChecksum(page))
      throw new Error('Synthetic Ogg Opus fixture has an invalid page checksum.')
  }
}

const electronStub = `
export const app = {
  commandLine: { appendSwitch() {} },
  exit() {},
  getPath() { return globalThis.process.env.HOME },
  on() {},
  quit() {},
  requestSingleInstanceLock() { return false },
  setName() {},
  setPath() {},
}
export class BrowserWindow {}
export const dialog = { showErrorBox() {} }
export const Menu = { buildFromTemplate() { return [] }, setApplicationMenu() {} }
`

const artifactInstrumentation = `
Promise.all([import('node:buffer'), import('node:stream')]).then(async ([bufferModule, streamModule]) => {
  const fixture = bufferModule.Buffer.from(globalThis.process.env.SYNTHETIC_D030_AUDIO ?? '', 'base64')
  const expectedPacket = bufferModule.Buffer.from(globalThis.process.env.SYNTHETIC_D030_PACKET ?? '', 'base64')
  const resource = await createClassicDiscordVoiceAudioResource(streamModule.Readable.from(fixture))
  const edgeTypes = resource.edges.map(edge => edge.type)
  if (edgeTypes.length !== 1 || edgeTypes[0] !== 'ogg/opus demuxer')
    throw new Error('Packaged classic voice resource selected an unexpected transformer.')

  const packet = await new Promise((resolve, reject) => {
    resource.playStream.once('data', resolve)
    resource.playStream.once('error', reject)
    resource.playStream.once('end', () => reject(new Error('Packaged Ogg Opus stream ended before a packet.')))
    resource.playStream.resume()
  })
  if (!bufferModule.Buffer.from(packet).equals(expectedPacket))
    throw new Error('Packaged Ogg Opus demuxer changed the synthetic packet.')

  globalThis.process.stdout.write(JSON.stringify({ edgeTypes, packetBytes: packet.length }))
}).catch((error) => {
  const message = error instanceof Error ? error.stack : String(error)
  globalThis.process.stderr.write(String(message) + '\\n')
  globalThis.process.exitCode = 1
})
`

/**
 * Executes the actual packaged application artifact's classic Discord audio boundary.
 *
 * Call stack:
 *
 * verifyClassicVoiceAudioBundle
 *   -> out/main/index.js with a synthetic Electron lifecycle boundary
 *     -> createClassicDiscordVoiceAudioResource
 *       -> Discord Voice Ogg Opus demuxer
 */
async function verifyClassicVoiceAudioBundle() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'airi-discord-audio-bundle-'))
  const artifactDirectory = join(temporaryDirectory, 'artifact')
  const electronModuleDirectory = join(artifactDirectory, 'node_modules', 'electron')
  const emptyPathDirectory = join(temporaryDirectory, 'empty-path')
  const artifactPath = join(artifactDirectory, 'index.js')

  try {
    const { expectedPacket, fixture } = createSyntheticOggOpus()
    validateSyntheticOggOpus(fixture)

    await cp(resolve(appDirectory, 'out', 'main'), artifactDirectory, { recursive: true })
    await mkdir(electronModuleDirectory, { recursive: true })
    await mkdir(emptyPathDirectory, { recursive: true })
    await writeFile(join(artifactDirectory, 'package.json'), '{"type":"module"}\n')
    await writeFile(join(electronModuleDirectory, 'package.json'), '{"name":"electron","type":"module","exports":"./index.js"}\n')
    await writeFile(join(electronModuleDirectory, 'index.js'), electronStub)
    await appendFile(artifactPath, artifactInstrumentation)

    const result = spawnSync(process.execPath, [artifactPath], {
      cwd: temporaryDirectory,
      encoding: 'utf8',
      env: {
        HOME: temporaryDirectory,
        NO_COLOR: '1',
        PATH: emptyPathDirectory,
        SYNTHETIC_D030_AUDIO: fixture.toString('base64'),
        SYNTHETIC_D030_PACKET: expectedPacket.toString('base64'),
        TMPDIR: temporaryDirectory,
      },
      timeout: 10_000,
    })
    if (result.status !== 0)
      throw new Error(`Classic voice application artifact smoke failed: ${result.stderr.trim() || `exit ${result.status}`}`)
    if (!result.stdout.includes('ogg/opus demuxer') || !result.stdout.includes('"packetBytes":3'))
      throw new Error('Classic voice application artifact smoke did not consume the synthetic Ogg Opus packet.')
    if (result.stderr.includes('FFmpeg/avconv not found'))
      throw new Error('Classic voice application artifact attempted to use an FFmpeg executable.')

    process.stdout.write('Verified packaged classic Discord Ogg Opus playback without FFmpeg.\n')
  }
  finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

verifyClassicVoiceAudioBundle().catch((error) => {
  process.stderr.write(`${errorMessageFrom(error) ?? 'Unknown classic voice bundle smoke failure.'}\n`)
  process.exitCode = 1
})
