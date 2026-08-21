import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DirEntry, FileFilter } from '@workbench/plugin-sdk';
import {
  assertReadable, grantFile, grantReadDir, isReadDirGranted,
} from './fs-grants.js';

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

/**
 * Takes a getter rather than a window: `ipcMain.handle` can only be registered
 * once per channel, but the window it talks to is replaced whenever the user
 * closes and reopens it (macOS keeps the app alive with no window).
 */
export function registerFsBroker(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('fs:pickFile', async (_event, rawFilters: unknown) => {
    const filters = sanitizeFilters(rawFilters);
    const options = {
      properties: ['openFile' as const],
      ...(filters === undefined ? {} : { filters }),
    };
    const win = getWindow();
    const result = win === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(win, options);

    const picked = result.canceled ? undefined : result.filePaths[0];
    if (picked === undefined) return undefined;

    grantFile(await realpath(picked));   // the dialog IS the grant
    return picked;
  });

  ipcMain.handle('fs:pickDirectory', async () => {
    const win = getWindow();
    const options = { properties: ['openDirectory' as const] };
    const result = win === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(win, options);

    const picked = result.canceled ? undefined : result.filePaths[0];
    if (picked === undefined) return undefined;

    grantReadDir(await realpath(picked));
    return picked;
  });

  ipcMain.handle('fs:readDir', async (_event, rawPath: unknown): Promise<DirEntry[]> => {
    if (typeof rawPath !== 'string') throw new Error('fs:readDir expects a path string');

    // A granted directory is readable as itself, which assertReadable rejects
    // (it requires being strictly *inside* a grant), so check that case first.
    const real = await realpath(rawPath).catch(() => {
      throw new Error(`fs:readDir — "${rawPath}" does not exist`);
    });
    if (!isReadDirGranted(real)) await assertReadable(rawPath);

    const entries = await readdir(real, { withFileTypes: true });
    const out: DirEntry[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;          // skip dotfiles
      const full = path.join(real, e.name);
      try {
        const info = await stat(full);               // follows symlinks
        out.push({
          name: e.name,
          path: full,
          isDirectory: info.isDirectory(),
          size: info.size,
          modified: info.mtimeMs,
        });
      } catch {
        // unreadable entry (broken symlink, permissions) — skip it
      }
    }
    return out.sort((a, b) =>
      Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
  });

  ipcMain.handle('fs:readFile', async (_event, rawPath: unknown) => {
    if (typeof rawPath !== 'string') {
      throw new Error('fs:readFile expects a path string');
    }
    const real = await assertReadable(rawPath);
    return await readFile(real);
  });
}
