import minecraftData from 'minecraft-data'

import { describe, expect, it } from 'vitest'

import { McData } from './mcdata'

describe('mcData', () => {
  // ROOT CAUSE:
  //
  // The Levenshtein matrix used Array.fill with one row instance, so every
  // matrix row aliased the same array. Updating one distance corrupted all
  // rows and made close block-name typos resolve to unrelated short names.
  //
  // Each matrix row must be allocated independently.
  /**
   * @example
   * new McData(minecraftData('1.20.4')).getClosestBlockName('stne') === 'stone'
   */
  it('finds the closest block name for a one-character omission', () => {
    const data = new McData(minecraftData('1.20.4'))

    expect(data.getClosestBlockName('stne')).toBe('stone')
    expect(data.getClosestBlockName('diamnd_ore')).toBe('diamond_ore')
  })
})
