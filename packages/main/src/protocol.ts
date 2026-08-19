import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pluginRoots } from './plugins.js';

/**
 * Extension → MIME. Plugins serve more than JavaScript: sourcemaps, images, wasm,
 * stylesheets. Defaulting to a script type would be actively wrong — a browser
 * handed `text/javascript` for a PNG refuses it — so unknown types fall back to
 * `application/octet-stream`.
 */
const MIME_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

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
          'content-type': contentTypeFor(filePath),
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',       // hot reload must never hit a cache
        },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}
