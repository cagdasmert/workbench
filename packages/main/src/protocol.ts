import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pluginRoots } from './plugins.js';

/** Must run before app.whenReady(). */
export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'plugin',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Serve plugin bundles over plugin://<id>/<file>. Must run after app.whenReady().
 *
 * The three response headers are load-bearing. In dev the renderer's origin is the
 * Vite dev server, so importing plugin:// is a cross-origin module fetch — and module
 * scripts always fetch in CORS mode. Without the ACAO header the import fails CORS;
 * without an explicit JS content-type Chromium refuses to execute the module.
 */
export function handlePluginProtocol(): void {
  protocol.handle('plugin', async (request) => {
    const url = new URL(request.url);
    const root = pluginRoots.get(url.hostname);
    if (!root) return new Response('not found', { status: 404 });

    const distRoot = path.join(root, 'dist');
    const filePath = path.resolve(distRoot, '.' + decodeURIComponent(url.pathname));
    const rel = path.relative(distRoot, filePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return new Response('forbidden', { status: 403 });   // path traversal guard
    }

    try {
      return new Response(await readFile(filePath), {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',       // hot reload must never hit a cache
        },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}
