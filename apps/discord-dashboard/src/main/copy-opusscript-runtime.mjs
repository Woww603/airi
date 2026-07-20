import process from 'node:process'

import { copyFile, mkdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFilePath = fileURLToPath(import.meta.url)
const defaultDestinationDirectory = fileURLToPath(new URL('../../out/main/', import.meta.url))
const requireFromDiscordBot = createRequire(
  fileURLToPath(new URL('../../../../services/discord-bot/package.json', import.meta.url)),
)

const moduleRuntimeFiles = [
  'LICENSE',
  'package.json',
  'index.js',
  join('build', 'COPYING.libopus'),
  join('build', 'opusscript_native_wasm.js'),
  join('build', 'opusscript_native_wasm.wasm'),
]

function resolveOpusScriptPackageDirectory() {
  return dirname(requireFromDiscordBot.resolve('opusscript/package.json'))
}

async function copyVerifiedFile(sourcePath, targetPath) {
  const source = await stat(sourcePath)
  if (!source.isFile() || source.size === 0)
    throw new Error(`OpusScript runtime source is missing or empty: ${sourcePath}`)

  await mkdir(dirname(targetPath), { recursive: true })
  await copyFile(sourcePath, targetPath)

  const target = await stat(targetPath)
  if (!target.isFile() || target.size !== source.size)
    throw new Error(`OpusScript runtime copy is incomplete: ${targetPath}`)

  return target.size
}

/**
 * Copies the OpusScript assets needed by both bundled decoding and dynamic Discord playback encoding.
 *
 * Use when:
 * - Building the standalone AIRI Discord Electron main process.
 * - Packaging raw PCM playback through `@discordjs/voice` without a native Opus dependency.
 *
 * Expects:
 * - The Discord Bot workspace dependency graph resolves `opusscript`.
 * - The destination is the directory containing the Electron main entry.
 *
 * Returns:
 * - The copied file paths and their verified total byte count.
 */
export async function copyOpusScriptRuntime(destinationDirectory = defaultDestinationDirectory) {
  const packageDirectory = resolveOpusScriptPackageDirectory()
  const copiedPaths = []
  let bytes = 0

  // The bundled decoder's Emscripten glue resolves this WASM beside index.js.
  const bundledWasmSourcePath = join(packageDirectory, 'build', 'opusscript_native_wasm.wasm')
  const bundledWasmTargetPath = join(destinationDirectory, 'opusscript_native_wasm.wasm')
  bytes += await copyVerifiedFile(bundledWasmSourcePath, bundledWasmTargetPath)
  copiedPaths.push(bundledWasmTargetPath)

  // @discordjs/voice intentionally discovers encoders with a dynamic require.
  // Node starts that lookup beside out/main/index.js, so the module must live here.
  const moduleDirectory = join(destinationDirectory, 'node_modules', 'opusscript')
  for (const relativePath of moduleRuntimeFiles) {
    const targetPath = join(moduleDirectory, relativePath)
    bytes += await copyVerifiedFile(join(packageDirectory, relativePath), targetPath)
    copiedPaths.push(targetPath)
  }

  return { bytes, copiedPaths, moduleDirectory }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(currentFilePath)) {
  copyOpusScriptRuntime()
    .then(({ bytes, moduleDirectory }) => {
      console.info(`Copied OpusScript runtime (${bytes} bytes) to ${moduleDirectory}`)
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
