import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { copyOpusScriptRuntime } from './copy-opusscript-runtime.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

describe('airi Discord packaged audio assets', () => {
  it('copies identical non-empty WASM for the bundled Discord input decoder', async () => {
    const destinationDirectory = await mkdtemp(join(tmpdir(), 'airi-discord-opus-wasm-'))
    temporaryDirectories.push(destinationDirectory)

    const result = await copyOpusScriptRuntime(destinationDirectory)
    const bundledWasmPath = join(destinationDirectory, 'opusscript_native_wasm.wasm')
    const moduleWasmPath = join(result.moduleDirectory, 'build', 'opusscript_native_wasm.wasm')
    const [bundledWasm, moduleWasm] = await Promise.all([
      readFile(bundledWasmPath),
      readFile(moduleWasmPath),
    ])

    expect(result.bytes).toBeGreaterThan(0)
    expect(bundledWasm.length).toBeGreaterThan(0)
    expect(bundledWasm.equals(moduleWasm)).toBe(true)
  })

  it('makes OpusScript resolvable from the Electron main bundle for Discord playback', async () => {
    const destinationDirectory = await mkdtemp(join(tmpdir(), 'airi-discord-opus-runtime-'))
    temporaryDirectories.push(destinationDirectory)

    // ROOT CAUSE:
    //
    // @discordjs/voice loads an Opus encoder with require('opusscript') only
    // when raw PCM playback starts. Copying only the Emscripten WASM asset lets
    // AIRI decode Discord input, but leaves Qwen's reply without an encoder.
    //
    // Before the fix, resolution from out/main/index.js throws MODULE_NOT_FOUND.
    // The runtime copy provides a complete resolvable module beside that entry.
    await copyOpusScriptRuntime(destinationDirectory)

    const requireFromMainBundle = createRequire(join(destinationDirectory, 'index.js'))
    const resolvedPath = requireFromMainBundle.resolve('opusscript')
    const OpusScript = requireFromMainBundle('opusscript')
    const encoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO)
    const packet = encoder.encode(Buffer.alloc(960 * 2 * 2), 960)
    encoder.delete()

    const expectedPath = await realpath(join(destinationDirectory, 'node_modules', 'opusscript', 'index.js'))
    expect(resolvedPath).toBe(expectedPath)
    expect(packet.length).toBeGreaterThan(0)
  })
})
