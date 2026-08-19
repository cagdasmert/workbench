import { protocol, net } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The shell's own origin in a packaged build.
 *
 * `loadFile()` gives the renderer a `file://` origin, and `onHeadersReceived`
 * never fires for `file://` — which means the strict CSP from §6.4 has protected
 * dev and *nothing else* since M0. Serving the shell over a real scheme is what
 * makes architecture §9 true for a shipped app.
 *
 * The policy is set on the response here rather than through `webRequest`, so it
 * cannot be silently skipped by a scheme that does not emit header events.
 */
const CSP = "default-src 'self' app:; script-src 'self' app: plugin:; "
  + "style-src 'self' app: 'unsafe-inline'; img-src 'self' app: data: blob: plugin:; "
  + "connect-src 'self' app: plugin:; object-src 'none'; base-uri 'none'; frame-ancestors 'none';";

export const APP_ORIGIN = 'app://shell';

/** Must run before app.whenReady(), alongside the plugin scheme. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

export function handleAppProtocol(shellDist: string): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname);
    const filePath = path.resolve(shellDist, `.${rel === '/' ? '/index.html' : rel}`);

    // Same guard as the plugin scheme: resolve, then prove containment.
    const contained = path.relative(shellDist, filePath);
    if (contained.startsWith('..') || path.isAbsolute(contained)) {
      return new Response('forbidden', { status: 403 });
    }

    const res = await net.fetch(pathToFileURL(filePath).toString());
    if (!res.ok) return new Response('not found', { status: 404 });

    const headers = new Headers(res.headers);
    // Only the document carries the policy; assets inherit it from the page.
    if (filePath.endsWith('.html')) headers.set('content-security-policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}
