import { describe, expect, it } from 'vitest'

import { removeDiscordBotMention } from './discordMention'

/**
 * @example
 * describe('discord bot mention normalization', () => {})
 */
describe('discord bot mention normalization', () => {
  /**
   * @example
   * it('removes only AIRI mentions and preserves referenced users', () => {})
   */
  it('removes only AIRI mentions and preserves referenced users', () => {
    expect(removeDiscordBotMention('<@123> ask <@456> and <@!789>', '123')).toBe('ask <@456> and <@!789>')
    expect(removeDiscordBotMention('<@!123> hello', '123')).toBe('hello')
  })
})
