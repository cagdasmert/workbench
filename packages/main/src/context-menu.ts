import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

/**
 * Right-click menu for editable fields and selected text.
 *
 * Electron ships no context menu at all — without this, right-clicking a
 * textarea does nothing. Built from `role:` entries so the actions are handled
 * natively by the focused element, which is also what makes them work inside a
 * plugin's own DOM without the shell knowing anything about it.
 */
export function installContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const { editFlags, isEditable, selectionText, misspelledWord } = params;
    const hasSelection = selectionText.trim().length > 0;

    const items: MenuItemConstructorOptions[] = [];

    if (misspelledWord !== '' && params.dictionarySuggestions.length > 0) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 4)) {
        items.push({
          label: suggestion,
          click: () => win.webContents.replaceMisspelling(suggestion),
        });
      }
      items.push({ type: 'separator' });
    }

    if (isEditable) {
      items.push(
        { role: 'undo', enabled: editFlags.canUndo },
        { role: 'redo', enabled: editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: editFlags.canCut },
      );
    }

    if (isEditable || hasSelection) {
      items.push({ role: 'copy', enabled: editFlags.canCopy });
    }

    if (isEditable) {
      items.push(
        { role: 'paste', enabled: editFlags.canPaste },
        { role: 'delete', enabled: editFlags.canDelete },
      );
    }

    if (items.length > 0) items.push({ type: 'separator' });
    items.push({ role: 'selectAll', enabled: editFlags.canSelectAll });

    Menu.buildFromTemplate(items).popup({ window: win, x: params.x, y: params.y });
  });
}
