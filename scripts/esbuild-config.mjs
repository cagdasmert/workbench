import { readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_DIR = path.join(ROOT, 'plugins');

const shared = {
  bundle: true,
  target: 'es2022',
  logLevel: 'silent',
};

/** Main is ESM. Electron is external — it is provided by the runtime, not bundled. */
export const mainOptions = {
  ...shared,
  sourcemap: 'inline',
  entryPoints: [path.join(ROOT, 'packages/main/src/index.ts')],
  outfile: path.join(ROOT, 'packages/main/dist/index.js'),
  platform: 'node',
  format: 'esm',
  external: ['electron'],
};

/**
 * Preload must be CommonJS: Electron does not load ESM preload scripts under
 * `sandbox: true`. The .cjs extension is load-bearing, not stylistic — the
 * workspace root is `"type": "module"`, so an index.js here would be parsed as
 * ESM and silently fail to load.
 */
export const preloadOptions = {
  ...shared,
  sourcemap: 'inline',
  entryPoints: [path.join(ROOT, 'packages/preload/src/index.ts')],
  outfile: path.join(ROOT, 'packages/preload/dist/index.cjs'),
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
};

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * One esbuild config per plugin. Objects rather than shell strings so dev.mjs can
 * hand the identical options to watch mode — the two drifting apart is how you get
 * a plugin that works in dev and not in prod.
 *
 * React is bundled, not external: a fatter file, but it demonstrates that plugins
 * are self-contained, which is the property that matters when isolation arrives.
 */
export async function pluginBuildConfigs() {
  let dirents;
  try {
    dirents = await readdir(PLUGIN_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const configs = [];
  for (const entry of dirents) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PLUGIN_DIR, entry.name);

    let entryPoint;
    for (const candidate of ['src/index.tsx', 'src/index.ts']) {
      if (await exists(path.join(dir, candidate))) {
        entryPoint = path.join(dir, candidate);
        break;
      }
    }
    if (entryPoint === undefined) {
      console.warn(`[plugins] ${entry.name}: no src/index.ts(x), skipping`);
      continue;
    }

    configs.push({
      id: entry.name,
      dir,
      options: {
        ...shared,
        entryPoints: [entryPoint],
        outfile: path.join(dir, 'dist', 'index.js'),
        format: 'esm',
        jsx: 'automatic',
        // Linked, not inline: mermaid inlined is 27 MB and hot reload measured
        // 2.5 s. Linked keeps index.js at 8.4 MB and the map is only fetched
        // when DevTools asks for it.
        sourcemap: 'linked',
      },
    });
  }
  return configs;
}
