import chokidar from 'chokidar';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { pluginRoots } from './plugins.js';

const DEBOUNCE_MS = 100;

/**
 * Watch plugin build *output* and tell the renderer. Main deliberately does not
 * build anything — the dev orchestrator owns every esbuild context.
 *
 * Two reasons. Architecturally, keeping build tooling out of the privileged
 * process keeps main's job to window, manifests, and files. Practically, if main
 * watched src/ and triggered its own build, chokidar could fire while the editor
 * was still writing and `plugin:changed` could be sent before the bundle was
 * coherent — an intermittent "reload did nothing" roughly one save in twenty.
 * Watching dist/ makes "build finished" causally precede "notify renderer".
 *
 * Note: chokidar 5 removed glob support, so this watches the resolved dist
 * directories rather than a `plugins/-star-/dist/index.js` pattern.
 */
export function watchPluginBuilds(win: BrowserWindow): () => Promise<void> {
  const targets = [...pluginRoots.entries()].map(([id, root]) => ({
    id,
    dist: path.join(root, 'dist'),
  }));

  if (targets.length === 0) {
    return async () => undefined;
  }

  const timers = new Map<string, NodeJS.Timeout>();

  const watcher = chokidar.watch(targets.map((t) => t.dist), {
    ignoreInitial: true,
    depth: 0,
  });

  watcher.on('all', (event, file) => {
    if (event !== 'add' && event !== 'change') return;
    if (path.basename(file) !== 'index.js') return;

    const target = targets.find((t) => file.startsWith(t.dist + path.sep));
    if (target === undefined) return;

    // Debounce: esbuild writes, and a single editor save can still fire twice.
    const existing = timers.get(target.id);
    if (existing !== undefined) clearTimeout(existing);
    timers.set(target.id, setTimeout(() => {
      timers.delete(target.id);
      if (win.isDestroyed()) return;
      console.log(`[plugins] ${target.id} rebuilt — notifying renderer`);
      win.webContents.send('plugin:changed', target.id);
    }, DEBOUNCE_MS));
  });

  return async () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    await watcher.close();
  };
}
