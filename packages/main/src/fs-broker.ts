import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import type { FileFilter } from '@workbench/plugin-sdk';

/**
 * Paths the user explicitly chose through a file dialog, this session only.
 *
 * This is what makes the declared permission `fs:read:user-selected` mean
 * something. Without it, `fs:readFile` over the bridge is an arbitrary-file-read
 * primitive handed to the renderer — the exact thing architecture §9 says must
 * never cross. Nothing is persisted; a restart starts from zero grants.
 */
const grantedPaths = new Set<string>();

/** The renderer is a local RPC boundary. Treat every argument as hostile. */
function sanitizeFilters(raw: unknown): FileFilter[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: FileFilter[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, extensions } = entry as { name?: unknown; extensions?: unknown };
    if (typeof name !== 'string') continue;
    if (!Array.isArray(extensions)) continue;
    const exts = extensions.filter((e): e is string => typeof e === 'string');
    if (exts.length === 0) continue;
    out.push({ name, extensions: exts });
  }
  return out.length > 0 ? out : undefined;
}

export function registerFsBroker(win: BrowserWindow): void {
  ipcMain.handle('fs:pickFile', async (_event, rawFilters: unknown) => {
    const filters = sanitizeFilters(rawFilters);
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      ...(filters === undefined ? {} : { filters }),
    });

    const picked = result.canceled ? undefined : result.filePaths[0];
    if (picked === undefined) return undefined;

    grantedPaths.add(picked);   // the dialog IS the grant
    return picked;
  });

  ipcMain.handle('fs:readFile', async (_event, rawPath: unknown) => {
    if (typeof rawPath !== 'string') {
      throw new Error('fs:readFile expects a path string');
    }
    if (!grantedPaths.has(rawPath)) {
      throw new Error(
        `fs:read denied — "${rawPath}" was not granted by pickFile in this session`,
      );
    }
    return await readFile(rawPath);
  });
}
