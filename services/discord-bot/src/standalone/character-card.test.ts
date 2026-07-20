import { describe, expect, it } from 'vitest'

import {
  buildStandaloneCharacterCardPrompt,
  parseStandaloneCharacterCardJson,
  updateStandaloneCharacterCard,
} from './character-card'

/**
 * @example
 * describe('standalone character card', () => {})
 */
describe('standalone character card', () => {
  /**
   * @example
   * it('imports Character Card V3 JSON into standalone fields', () => {})
   */
  it('imports Character Card V3 JSON into standalone fields', () => {
    const card = parseStandaloneCharacterCardJson(JSON.stringify({
      data: {
        alternate_greetings: ['alt hello'],
        character_version: '3.1.0',
        creator: 'tester',
        creator_notes: 'local notes',
        description: 'Imported description.',
        first_mes: 'hello',
        name: 'mika',
        personality: 'direct',
        post_history_instructions: 'after history',
        scenario: 'discord',
        system_prompt: 'You are mika.',
      },
    }))

    /**
     * @example
     * expect(card.name).toBe('mika')
     */
    expect(card.name).toBe('mika')
    /**
     * @example
     * expect(card.greetings).toEqual(['hello', 'alt hello'])
     */
    expect(card.greetings).toEqual(['hello', 'alt hello'])
    /**
     * @example
     * expect(card.postHistoryInstructions).toBe('after history')
     */
    expect(card.postHistoryInstructions).toBe('after history')
  })

  /**
   * @example
   * it('recovers cards when dotenv parsing expanded JSON string newlines', () => {})
   */
  it('recovers cards when dotenv parsing expanded JSON string newlines', () => {
    const card = parseStandaloneCharacterCardJson([
      '{',
      '  "creator": "Woww",',
      '  "description": "line one',
      'line two",',
      '  "name": "airi",',
      '  "personality": "soft",',
      '  "scenario": "discord",',
      '  "systemPrompt": "stay in character",',
      '  "postHistoryInstructions": "keep scope",',
      '  "version": "1.3"',
      '}',
    ].join('\n'))

    /**
     * @example
     * expect(card.creator).toBe('Woww')
     */
    expect(card.creator).toBe('Woww')
    /**
     * @example
     * expect(card.description).toBe('line one\nline two')
     */
    expect(card.description).toBe('line one\nline two')
  })

  /**
   * @example
   * it('builds a prompt from the active card fields', () => {})
   */
  it('builds a prompt from the active card fields', () => {
    const card = updateStandaloneCharacterCard(parseStandaloneCharacterCardJson(undefined), {
      characterDescription: 'Standalone description.',
      characterName: 'mika',
      characterPersonality: 'precise',
      characterPostHistoryInstructions: 'after',
      characterScenario: 'discord',
      characterSystemPrompt: 'You are mika.',
      characterVersion: '2.0.0',
    })
    const prompt = buildStandaloneCharacterCardPrompt(card)

    /**
     * @example
     * expect(prompt).toContain('Active AIRI character card:')
     */
    expect(prompt).toContain('Active AIRI character card:')
    /**
     * @example
     * expect(prompt).toContain('Standalone description.')
     */
    expect(prompt).toContain('Standalone description.')
    /**
     * @example
     * expect(prompt).toContain('You are mika.')
     */
    expect(prompt).toContain('You are mika.')
  })
})
