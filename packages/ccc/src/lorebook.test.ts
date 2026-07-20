import type { CharacterBook } from './export/types'

import { describe, expect, it } from 'vitest'

import { evaluateCharacterBook } from './index'

function createBook(overrides: Partial<CharacterBook> = {}): CharacterBook {
  return {
    entries: [],
    extensions: {},
    ...overrides,
  }
}

/**
 * @example
 * describe('Character Card V3 lorebook evaluation', () => {})
 */
describe('character card V3 lorebook evaluation', () => {
  /**
   * @example
   * it('activates literal and selective entries inside the scan depth', () => {})
   */
  it('activates literal and selective entries inside the scan depth', () => {
    const result = evaluateCharacterBook(createBook({
      scan_depth: 2,
      entries: [
        {
          content: 'The observatory belongs to Mira.',
          enabled: true,
          extensions: {},
          insertion_order: 20,
          keys: ['observatory'],
          use_regex: false,
        },
        {
          content: 'The silver key opens the observatory vault.',
          enabled: true,
          extensions: {},
          insertion_order: 10,
          keys: ['silver key'],
          secondary_keys: ['Mira'],
          selective: true,
          use_regex: false,
        },
      ],
    }), {
      messages: [
        'The silver key was lost long ago.',
        'Mira watches the stars.',
        'We reached the observatory tonight.',
      ],
    })

    expect(result.beforeCharacter).toEqual([])
    expect(result.afterCharacter).toEqual(['The observatory belongs to Mira.'])
    expect(result.entries.map(entry => entry.status)).toEqual(['included', 'unmatched'])
  })

  /**
   * @example
   * it('does not scan conversation messages when scan depth is zero', () => {})
   */
  it('does not scan conversation messages when scan depth is zero', () => {
    const result = evaluateCharacterBook(createBook({
      scan_depth: 0,
      entries: [
        {
          content: 'This must not be injected.',
          enabled: true,
          extensions: {},
          insertion_order: 10,
          keys: ['observatory'],
          use_regex: false,
        },
      ],
    }), {
      messages: ['We reached the observatory.'],
    })

    expect(result.afterCharacter).toEqual([])
    expect(result.entries[0]?.status).toBe('unmatched')
  })

  /**
   * @example
   * it('activates constant and recursively discovered entries once', () => {})
   */
  it('activates constant and recursively discovered entries once', () => {
    const result = evaluateCharacterBook(createBook({
      recursive_scanning: true,
      entries: [
        {
          constant: true,
          content: 'AIRI remembers the moon archive.',
          enabled: true,
          extensions: {},
          insertion_order: 5,
          keys: [],
          position: 'before_char',
          use_regex: false,
        },
        {
          content: 'The moon archive is guarded by Selene.',
          enabled: true,
          extensions: {},
          insertion_order: 10,
          keys: ['moon archive'],
          use_regex: false,
        },
      ],
    }), {
      messages: ['Tell me something you always remember.'],
    })

    expect(result.beforeCharacter).toEqual(['AIRI remembers the moon archive.'])
    expect(result.afterCharacter).toEqual(['The moon archive is guarded by Selene.'])
    expect(result.entries.map(entry => entry.status)).toEqual(['included', 'included'])
  })

  /**
   * @example
   * it('evicts lower-priority entries without changing prompt order', () => {})
   */
  it('evicts lower-priority entries without changing prompt order', () => {
    const result = evaluateCharacterBook(createBook({
      token_budget: 7,
      entries: [
        {
          constant: true,
          content: 'first',
          enabled: true,
          extensions: {},
          insertion_order: 30,
          keys: [],
          priority: 10,
          use_regex: false,
        },
        {
          constant: true,
          content: 'second',
          enabled: true,
          extensions: {},
          insertion_order: 10,
          keys: [],
          priority: 30,
          use_regex: false,
        },
        {
          constant: true,
          content: 'third',
          enabled: true,
          extensions: {},
          insertion_order: 20,
          keys: [],
          priority: 20,
          use_regex: false,
        },
      ],
    }), {
      estimateTokens: content => content.length,
      messages: [],
    })

    expect(result.afterCharacter).toEqual(['second'])
    expect(result.usedTokens).toBe(6)
    expect(result.entries.map(entry => entry.status)).toEqual([
      'budget-evicted',
      'included',
      'budget-evicted',
    ])
  })

  /**
   * @example
   * it('keeps unsupported regex entries observable without executing them', () => {})
   */
  it('keeps unsupported regex entries observable without executing them', () => {
    const result = evaluateCharacterBook(createBook({
      entries: [
        {
          content: 'Never execute imported regular expressions on the UI thread.',
          enabled: true,
          extensions: {},
          insertion_order: 10,
          keys: ['/(a+)+$/'],
          use_regex: true,
        },
        {
          content: '',
          enabled: true,
          extensions: {},
          insertion_order: 20,
          keys: ['safe'],
          use_regex: false,
        },
        {
          content: 'Disabled.',
          enabled: false,
          extensions: {},
          insertion_order: 30,
          keys: ['safe'],
          use_regex: false,
        },
      ],
    }), {
      messages: ['safe aaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'],
    })

    expect(result.afterCharacter).toEqual([])
    expect(result.entries.map(entry => entry.status)).toEqual([
      'regex-unsupported',
      'empty',
      'disabled',
    ])
  })
})
