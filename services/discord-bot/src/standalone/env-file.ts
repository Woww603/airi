import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Parsed dotenv-style values keyed by environment variable name.
 */
export type StandaloneEnvValues = Record<string, string>

interface EnvLine {
  key?: string
  raw: string
}

/**
 * Normalizes dotenv line endings.
 *
 * Before:
 * - "A=1\r\nB=2"
 *
 * After:
 * - "A=1\nB=2"
 */
function normalizeEnvSource(source: string) {
  return source.replace(/\r\n?/g, '\n')
}

function stripExportPrefix(line: string) {
  const trimmed = line.trim()
  return trimmed.startsWith('export ')
    ? trimmed.slice('export '.length).trim()
    : trimmed
}

function stripQuotedEnvValue(value: string) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }

  return trimmed
}

/**
 * Normalizes encoded JSON stored in dotenv values.
 *
 * Before:
 * - "{\\n  \"description\": \"hello\\nworld\"\\n}"
 *
 * After:
 * - "{\n  \"description\": \"hello\\nworld\"\n}"
 */
function normalizeJsonEnvValue(value: string) {
  const trimmed = value.trim()
  let source = stripQuotedEnvValue(trimmed)
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'string')
        source = parsed
    }
    catch {
      source = stripQuotedEnvValue(trimmed)
    }
  }

  let inString = false
  let escaped = false
  let normalized = ''

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]

    if (!inString) {
      if (char === '\\' && source[index + 1] === 'n') {
        normalized += '\n'
        index += 1
        continue
      }

      if (char === '"')
        inString = true

      normalized += char
      continue
    }

    if (escaped) {
      normalized += char
      escaped = false
      continue
    }

    if (char === '\\') {
      normalized += char
      escaped = true
      continue
    }

    if (char === '"')
      inString = false

    normalized += char
  }

  return normalized
}

function parseEnvValue(key: string, value: string) {
  const trimmed = value.trim()
  if (key.endsWith('_JSON'))
    return normalizeJsonEnvValue(trimmed)

  if (
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return stripQuotedEnvValue(trimmed)
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }

  const commentIndex = trimmed.indexOf(' #')
  return commentIndex >= 0
    ? trimmed.slice(0, commentIndex).trim()
    : trimmed
}

function parseEnvLine(raw: string): EnvLine {
  const normalized = stripExportPrefix(raw)
  const separatorIndex = normalized.indexOf('=')
  if (separatorIndex <= 0)
    return { raw }

  const key = normalized.slice(0, separatorIndex).trim()
  if (!/^[A-Z_]\w*$/i.test(key))
    return { raw }

  return { key, raw }
}

function quoteEnvValue(value: string) {
  const normalized = value.replace(/\r\n?/g, '\n').replace(/\n/g, '\\n')
  if (!normalized.includes('\''))
    return `'${normalized}'`

  return JSON.stringify(normalized)
}

/**
 * Parses dotenv-style content used by the standalone dashboard.
 *
 * Before:
 * - "DEEPSEEK_MODEL='deepseek-v4-flash'"
 *
 * After:
 * - `{ DEEPSEEK_MODEL: "deepseek-v4-flash" }`
 */
export function parseStandaloneEnvFile(source: string): StandaloneEnvValues {
  const values: StandaloneEnvValues = {}
  for (const rawLine of normalizeEnvSource(source).split('\n')) {
    const line = parseEnvLine(rawLine)
    if (!line.key)
      continue

    const separatorIndex = stripExportPrefix(rawLine).indexOf('=')
    values[line.key] = parseEnvValue(line.key, stripExportPrefix(rawLine).slice(separatorIndex + 1))
  }

  return values
}

/**
 * Reads a dotenv file if it exists.
 *
 * Use when:
 * - The dashboard needs to merge current process env with edited `.env.local`.
 * - Missing local config should be treated as an empty override.
 *
 * Expects:
 * - `filePath` points to a user-owned dotenv file.
 *
 * Returns:
 * - Parsed env values, or an empty object when the file does not exist.
 */
export async function readStandaloneEnvFileIfExists(filePath: string): Promise<StandaloneEnvValues> {
  try {
    return parseStandaloneEnvFile(await readFile(filePath, 'utf-8'))
  }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return {}

    throw error
  }
}

/**
 * Writes selected dotenv values while preserving unrelated lines.
 *
 * Use when:
 * - The local dashboard saves Discord/DeepSeek settings into `.env.local`.
 * - Existing comments and unrelated service settings should remain intact.
 *
 * Expects:
 * - `updates` only contains keys that should be materialized in the env file.
 *
 * Returns:
 * - The complete dotenv source written to disk.
 */
export async function writeStandaloneEnvValues(filePath: string, updates: StandaloneEnvValues): Promise<string> {
  let existingSource = ''
  try {
    existingSource = await readFile(filePath, 'utf-8')
  }
  catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT')
      throw error
  }

  const usedKeys = new Set<string>()
  const lines = normalizeEnvSource(existingSource)
    .split('\n')
    .filter((line, index, sourceLines) => index < sourceLines.length - 1 || line.length > 0)
    .map((rawLine) => {
      const parsed = parseEnvLine(rawLine)
      if (!parsed.key || !(parsed.key in updates))
        return rawLine

      usedKeys.add(parsed.key)
      return `${parsed.key}=${quoteEnvValue(updates[parsed.key] ?? '')}`
    })

  for (const [key, value] of Object.entries(updates)) {
    if (usedKeys.has(key))
      continue

    lines.push(`${key}=${quoteEnvValue(value)}`)
  }

  const nextSource = `${lines.join('\n').trimEnd()}\n`
  await mkdir(dirname(filePath), { recursive: true })
  // Dashboard config contains Discord and model provider secrets. The explicit
  // mode protects new files; chmod also repairs permissive existing files.
  await writeFile(filePath, nextSource, { encoding: 'utf-8', mode: 0o600 })
  await chmod(filePath, 0o600)
  return nextSource
}
