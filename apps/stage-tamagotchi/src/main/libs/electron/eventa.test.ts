import type { IpcMainEvent } from 'electron'

import { describe, expect, it, vi } from 'vitest'

import { createSenderScopedIpcMain } from './eventa'

/**
 * Locks the sender boundary used by every window-specific Eventa context.
 *
 * @example
 * describe('sender-scoped Electron IPC', () => {
 *   expect(listener).toHaveBeenCalledTimes(1)
 * })
 */
describe('sender-scoped Electron IPC', () => {
  /**
   * Verifies messages from another renderer never reach the bound Eventa listener.
   *
   * @example
   * it('drops inbound messages from other WebContents', () => {
   *   expect(listener).not.toHaveBeenCalled()
   * })
   */
  it('drops inbound messages from other WebContents', () => {
    const registered = new Map<string, (event: IpcMainEvent, ...args: unknown[]) => void>()
    const source = {
      on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) {
        registered.set(channel, listener)
        return source
      },
      off(channel: string) {
        registered.delete(channel)
        return source
      },
    }
    const scoped = createSenderScopedIpcMain(source, 42)
    const listener = vi.fn()
    scoped.on('eventa-message', listener)

    registered.get('eventa-message')?.({ sender: { id: 7 } } as IpcMainEvent, 'forged')
    registered.get('eventa-message')?.({ sender: { id: 42 } } as IpcMainEvent, 'trusted')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ sender: { id: 42 } }), 'trusted')
  })

  /**
   * Verifies Eventa disposal removes the actual wrapped listener from IpcMain.
   *
   * @example
   * it('removes the wrapped source listener', () => {
   *   expect(registered.has('eventa-message')).toBe(false)
   * })
   */
  it('removes the wrapped source listener', () => {
    const registered = new Map<string, (event: IpcMainEvent, ...args: unknown[]) => void>()
    const source = {
      on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) {
        registered.set(channel, listener)
        return source
      },
      off(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) {
        if (registered.get(channel) === listener) {
          registered.delete(channel)
        }
        return source
      },
    }
    const scoped = createSenderScopedIpcMain(source, 42)
    const listener = vi.fn()
    scoped.on('eventa-message', listener)
    scoped.off('eventa-message', listener)

    expect(registered.has('eventa-message')).toBe(false)
  })
})
