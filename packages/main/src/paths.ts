import { app } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where plugins live, in priority order.
 *
 * Packaged and unpackaged resolve to completely different trees, and getting
 * this wrong produces a `.app` that opens with no plugins and no error — the
 * scan finds an absent directory, warns, and returns an empty list.
 *
 * Packaged:
 *   1. `userData/plugins`      — user-installed, writable, wins on id collision
 *   2. `resourcesPath/plugins` — shipped with the app, read-only
 *
 * Unpackaged: the repo's own `plugins/`, which is also what the dev orchestrator
 * builds into and what the file watcher watches.
 */
export function pluginSearchPaths(): string[] {
  if (!app.isPackaged) {
    return [path.join(here, '../../../plugins')];
  }
  return [
    path.join(app.getPath('userData'), 'plugins'),
    path.join(process.resourcesPath, 'plugins'),
  ];
}

/** The built renderer. Inside the asar when packaged, alongside it in dev. */
export function shellDist(): string {
  return app.isPackaged
    ? path.join(app.getAppPath(), 'packages/shell/dist')
    : path.join(here, '../../shell/dist');
}

/**
 * Preload must exist on disk as a real file — it is `.cjs` and is loaded by
 * Electron itself, not by our code, so it must stay unpacked from the asar.
 */
export function preloadScript(): string {
  return app.isPackaged
    ? path.join(app.getAppPath(), 'packages/preload/dist/index.cjs')
    : path.join(here, '../../preload/dist/index.cjs');
}
