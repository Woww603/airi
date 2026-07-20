import type { MenuItemConstructorOptions } from 'electron'

/**
 * Builds the native application menu used by the Discord dashboard.
 *
 * Use when:
 * - Creating the packaged Electron window menu.
 * - Verifying that native text-editing shortcuts remain available.
 *
 * Expects:
 * - `productName` is the user-facing application name.
 * - `quit` shuts down the Electron application.
 *
 * Returns:
 * - An Electron menu template with application actions.
 */
export function createApplicationMenuTemplate(productName: string, quit: () => void): MenuItemConstructorOptions[] {
  return [
    {
      label: productName,
      submenu: [
        {
          accelerator: 'CommandOrControl+Q',
          click: quit,
          label: `退出 ${productName}`,
        },
      ],
    },
    {
      label: '编辑',
      role: 'editMenu',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
  ]
}
