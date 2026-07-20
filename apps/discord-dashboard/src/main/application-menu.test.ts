import { describe, expect, it, vi } from 'vitest'

import { createApplicationMenuTemplate } from './application-menu'

/**
 * @example
 * describe('application menu', () => {})
 */
describe('application menu', () => {
  /**
   * @example
   * it('keeps native clipboard shortcuts available in credential fields', () => {})
   */
  it('keeps native clipboard shortcuts available in credential fields', () => {
    const template = createApplicationMenuTemplate('AIRI Discord', vi.fn())
    const editMenu = template.find(item => item.role === 'editMenu')

    /**
     * @example
     * expect(editMenu).toBeDefined()
     */
    expect(editMenu).toBeDefined()
    /**
     * @example
     * expect(editMenu?.submenu).toEqual(expect.arrayContaining([]))
     */
    expect(editMenu?.submenu).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'copy' }),
      expect.objectContaining({ role: 'cut' }),
      expect.objectContaining({ role: 'paste' }),
      expect.objectContaining({ role: 'selectAll' }),
    ]))
  })
})
