import { useCallback, useEffect, useRef, useState } from 'react';
import type { PanelContext, Plugin } from '@workbench/plugin-sdk';
import { definePanel } from '@workbench/plugin-sdk/react';

const FILTERS = [
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'] },
];

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

function mimeFor(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface Loaded {
  path: string;
  url: string;
  bytes: number;
}

function ImagePanel({ ctx }: { ctx: PanelContext }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [dimensions, setDimensions] = useState<string>('');

  // Object URLs are a manual resource. Held in a ref so the unmount cleanup can
  // revoke the last one without re-running on every state change.
  const urlRef = useRef<string | null>(null);
  const revoke = useCallback(() => {
    if (urlRef.current !== null) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);
  useEffect(() => revoke, [revoke]);

  const open = useCallback(async () => {
    setError(null);
    try {
      const picked = await ctx.plugin.fs.pickFile(FILTERS);
      if (picked === undefined) return;                 // user cancelled

      const bytes = await ctx.plugin.fs.readFile(picked);
      revoke();
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeFor(picked) }));
      urlRef.current = url;
      setLoaded({ path: picked, url, bytes: bytes.byteLength });
      setZoom(1);
      setDimensions('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ctx, revoke]);

  return (
    <div style={styles.root}>
      <div style={styles.toolbar}>
        <button type="button" style={styles.button} onClick={() => void open()}>
          Open image…
        </button>
        {loaded !== null && (
          <>
            <button type="button" style={styles.button} onClick={() => setZoom((z) => z / 1.25)}>−</button>
            <span style={styles.zoom}>{Math.round(zoom * 100)}%</span>
            <button type="button" style={styles.button} onClick={() => setZoom((z) => z * 1.25)}>+</button>
            <button type="button" style={styles.button} onClick={() => setZoom(1)}>Reset</button>
            <span style={styles.meta}>
              {loaded.path.split('/').pop()} · {formatBytes(loaded.bytes)}
              {dimensions !== '' ? ` · ${dimensions}` : ''}
            </span>
          </>
        )}
      </div>

      <div style={styles.stage}>
        {error !== null && <pre style={styles.error}>{error}</pre>}
        {error === null && loaded === null && (
          <p style={styles.empty}>No image open. Use <strong>Open image…</strong>.</p>
        )}
        {error === null && loaded !== null && (
          <img
            src={loaded.url}
            alt={loaded.path}
            style={{ ...styles.image, width: `${zoom * 100}%` }}
            onLoad={(e) => {
              const img = e.currentTarget;
              setDimensions(`${img.naturalWidth}×${img.naturalHeight}`);
            }}
            onError={() => setError('The file could not be decoded as an image.')}
          />
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    font: '13px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    background: 'var(--workspace-bg, #fff)',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderBottom: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--chrome-bg, #f4f4f5)',
  },
  button: {
    font: 'inherit',
    padding: '3px 10px',
    borderRadius: 5,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
    cursor: 'pointer',
  },
  zoom: { minWidth: 48, textAlign: 'center', color: 'var(--chrome-muted, #71717a)' },
  meta: {
    marginLeft: 'auto',
    color: 'var(--chrome-muted, #71717a)',
    fontSize: 12,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  stage: { flex: 1, overflow: 'auto', display: 'grid', placeItems: 'center', padding: 16 },
  image: { maxWidth: 'none', imageRendering: 'auto', display: 'block' },
  empty: { color: 'var(--chrome-muted, #71717a)' },
  error: {
    margin: 16,
    padding: '10px 14px',
    whiteSpace: 'pre-wrap',
    font: "12px/1.5 'SF Mono', ui-monospace, monospace",
    color: 'var(--error-fg, #b91c1c)',
    background: 'var(--error-bg, #fef2f2)',
    border: '1px solid currentColor',
    borderRadius: 6,
  },
};

export const plugin: Plugin = {
  activate(ctx) {
    ctx.log.info('image-viewer activating');
    ctx.registerPanel('image.main', definePanel(ImagePanel));
    ctx.registerCommand('image.open', () => ctx.workspace.openPanel('image.main'));
  },

  deactivate() {
    console.log('image-viewer deactivating');
  },
};
