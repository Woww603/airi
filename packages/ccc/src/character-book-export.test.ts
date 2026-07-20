import type { CharacterBook } from './export/types'

import { describe, expect, it } from 'vitest'

import { exportToJSON } from './index'

/**
 * @example
 * describe('Character Card V3 lorebook export', () => {})
 */
describe('character card V3 lorebook export', () => {
  /**
   * @example
   * it('preserves the portable character book without rewriting extension data', () => {})
   */
  it('preserves the portable character book without rewriting extension data', () => {
    const characterBook: CharacterBook = {
      description: 'Mira lore',
      entries: [
        {
          content: 'The observatory belongs to Mira.',
          enabled: true,
          extensions: {
            custom_source: 'portable-card',
          },
          id: 'observatory-lore',
          insertion_order: 10,
          keys: ['observatory'],
          position: 'before_char',
          use_regex: false,
        },
      ],
      extensions: {
        custom_book_version: 2,
      },
      recursive_scanning: true,
      scan_depth: 4,
      token_budget: 256,
    }

    const exported = exportToJSON({
      characterBook,
      name: 'Mira',
      version: '1.0.0',
    })

    expect(exported.data.character_book).toEqual(characterBook)
    expect(exported.data.character_book).toBe(characterBook)
  })
})
