import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseStandaloneEnvFile, readStandaloneEnvFileIfExists, writeStandaloneEnvValues } from './env-file'

/**
 * @example
 * describe('standalone env file helpers', () => {})
 */
describe('standalone env file helpers', () => {
  /**
   * @example
   * it('parses quoted dotenv values used by the dashboard', () => {})
   */
  it('parses quoted dotenv values used by the dashboard', () => {
    const parsed = parseStandaloneEnvFile([
      '# comment',
      'DISCORD_TOKEN=\'discord-token\'',
      'DEEPSEEK_MODEL="deepseek-v4-flash"',
      'AIRI_DISCORD_SYSTEM_PROMPT="hello\\nAIRI"',
    ].join('\n'))

    /**
     * @example
     * expect(parsed.DISCORD_TOKEN).toBe('discord-token')
     */
    expect(parsed.DISCORD_TOKEN).toBe('discord-token')
    /**
     * @example
     * expect(parsed.DEEPSEEK_MODEL).toBe('deepseek-v4-flash')
     */
    expect(parsed.DEEPSEEK_MODEL).toBe('deepseek-v4-flash')
    /**
     * @example
     * expect(parsed.AIRI_DISCORD_SYSTEM_PROMPT).toBe('hello\nAIRI')
     */
    expect(parsed.AIRI_DISCORD_SYSTEM_PROMPT).toBe('hello\nAIRI')
  })

  /**
   * @example
   * it('preserves JSON string escapes while decoding JSON structure newlines', () => {})
   */
  it('preserves JSON string escapes while decoding JSON structure newlines', () => {
    const parsed = parseStandaloneEnvFile([
      'AIRI_DISCORD_CHARACTER_CARD_JSON=\'{\\n  "creator": "Woww",\\n  "description": "line one\\nline two",\\n  "systemPrompt": "Use <|ACT:\\"emotion\\":\\"happy\\"|>"\\n}\'',
    ].join('\n'))

    /**
     * @example
     * expect(JSON.parse(parsed.AIRI_DISCORD_CHARACTER_CARD_JSON).creator).toBe('Woww')
     */
    expect(JSON.parse(parsed.AIRI_DISCORD_CHARACTER_CARD_JSON).creator).toBe('Woww')
    /**
     * @example
     * expect(JSON.parse(parsed.AIRI_DISCORD_CHARACTER_CARD_JSON).description).toBe('line one\nline two')
     */
    expect(JSON.parse(parsed.AIRI_DISCORD_CHARACTER_CARD_JSON).description).toBe('line one\nline two')
    /**
     * @example
     * expect(JSON.parse(parsed.AIRI_DISCORD_CHARACTER_CARD_JSON).systemPrompt).toContain('"emotion":"happy"')
     */
    expect(JSON.parse(parsed.AIRI_DISCORD_CHARACTER_CARD_JSON).systemPrompt).toContain('"emotion":"happy"')
  })

  /**
   * @example
   * it('preserves unrelated lines and appends missing dashboard keys', async () => {})
   */
  it('preserves unrelated lines and appends missing dashboard keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airi-discord-env-'))
    const envPath = join(dir, '.env.local')

    try {
      await writeFile(envPath, [
        '# keep me',
        'DISCORD_TOKEN=\'old-token\'',
        'OPENAI_API_KEY=\'proxy-key\'',
      ].join('\n'))

      await writeStandaloneEnvValues(envPath, {
        AIRI_DISCORD_MODE: 'standalone',
        DEEPSEEK_MODEL: 'deepseek-v4-flash',
        DISCORD_TOKEN: 'new-token',
      })
      const source = await readFile(envPath, 'utf-8')

      /**
       * @example
       * expect(source).toContain('# keep me')
       */
      expect(source).toContain('# keep me')
      /**
       * @example
       * expect(source).toContain("DISCORD_TOKEN='new-token'")
       */
      expect(source).toContain('DISCORD_TOKEN=\'new-token\'')
      /**
       * @example
       * expect(source).toContain("OPENAI_API_KEY='proxy-key'")
       */
      expect(source).toContain('OPENAI_API_KEY=\'proxy-key\'')
      /**
       * @example
       * expect(source).toContain("DEEPSEEK_MODEL='deepseek-v4-flash'")
       */
      expect(source).toContain('DEEPSEEK_MODEL=\'deepseek-v4-flash\'')
      // ROOT CAUSE:
      //
      // Dashboard writes relied on the process umask, so `.env.local` commonly
      // remained mode 0644 even though it stores Discord and model API secrets.
      expect((await stat(envPath)).mode & 0o777).toBe(0o600)
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  /**
   * @example
   * it('returns an empty object when optional env files are missing', async () => {})
   */
  it('returns an empty object when optional env files are missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airi-discord-env-'))

    try {
      /**
       * @example
       * await expect(readStandaloneEnvFileIfExists(join(dir, '.missing'))).resolves.toEqual({})
       */
      await expect(readStandaloneEnvFileIfExists(join(dir, '.missing'))).resolves.toEqual({})
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })
})
