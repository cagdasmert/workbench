import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DirEntry, PanelContext, Plugin } from '@workbench/plugin-sdk';
import { definePanel } from '@workbench/plugin-sdk/react';
import { Thumb } from './Thumb.js';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

function mimeFor(filePath: string): string | null {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const RECENTS_KEY = 'recentCopyTargets';
const MAX_RECENTS = 8;

interface Shown {
  path: string;
  name: string;
  url: string;
  bytes: number;
}

/** Content routed here over the bus, rather than read from disk. */
function fromPayload(payload: unknown): Shown | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { type, data, meta } = payload as { type?: unknown; data?: unknown; meta?: unknown };
  if (typeof type !== 'string' || !type.startsWith('image/')) return null;

  const blob = typeof data === 'string'
    ? new Blob([data], { type })
    : data instanceof Uint8Array
      ? new Blob([data as unknown as BlobPart], { type })
      : null;
  if (blob === null) return null;

  const name = (meta as { filename?: unknown } | undefined)?.filename;
  return {
    path: typeof name === 'string' ? name : type,
    name: typeof name === 'string' ? name : type,
    url: URL.createObjectURL(blob),
    bytes: blob.size,
  };
}

function ImagePanel({ ctx }: { ctx: PanelContext }) {
  const [folder, setFolder] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [index, setIndex] = useState(-1);
  const [shown, setShown] = useState<Shown | null>(() => fromPayload(ctx.payload));
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [dimensions, setDimensions] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [recents, setRecents] = useState<string[]>([]);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const anchorRef = useRef<number | null>(null);
  // `recents` drives rendering; this ref is what `rememberFolder` computes from.
  // Two copies can overlap — the dialog is modal but the copy loop is not — and
  // a closed-over state value would let the second write clobber the first.
  const recentsRef = useRef<string[]>([]);
  const wroteRecentsRef = useRef(false);

  useEffect(() => {
    void (async () => {
      const saved = await ctx.plugin.storage.get<string[]>(RECENTS_KEY);
      // A copy that finished before this resolved already holds the newer list.
      if (wroteRecentsRef.current) return;
      if (Array.isArray(saved)) {
        const clean = saved.filter((s) => typeof s === 'string');
        recentsRef.current = clean;
        setRecents(clean);
      }
    })();
  }, [ctx]);

  const rootRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<string | null>(shown?.url ?? null);
  const revoke = useCallback(() => {
    if (urlRef.current !== null) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);
  useEffect(() => revoke, [revoke]);

  const images = useMemo(
    () => entries.filter((e) => !e.isDirectory && mimeFor(e.name) !== null),
    [entries],
  );

  /** Load one image by its position in `images`. */
  const show = useCallback(async (next: number) => {
    const entry = images[next];
    if (entry === undefined) return;
    setError(null);
    try {
      const bytes = await ctx.plugin.fs.readFile(entry.path);
      revoke();
      const url = URL.createObjectURL(
        new Blob([bytes], { type: mimeFor(entry.name) ?? 'application/octet-stream' }),
      );
      urlRef.current = url;
      setShown({ path: entry.path, name: entry.name, url, bytes: bytes.byteLength });
      setIndex(next);
      setZoom(1);
      setDimensions('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ctx, images, revoke]);

  const step = useCallback((delta: number) => {
    if (images.length === 0) return;
    // wrap, so holding an arrow at either end keeps working
    const next = (index + delta + images.length) % images.length;
    void show(next);
  }, [images.length, index, show]);

  const openFolder = useCallback(async () => {
    setError(null);
    try {
      const picked = await ctx.plugin.fs.pickDirectory();
      if (picked === undefined) return;
      const listed = await ctx.plugin.fs.readDir(picked);
      setFolder(picked);
      setEntries(listed);
      setIndex(-1);
      revoke();
      setShown(null);
      setSelected(new Set());
      anchorRef.current = null;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ctx, revoke]);

  /**
   * Finder's selection grammar: plain click replaces, cmd toggles, shift extends
   * from the last plain click. The anchor is the last non-shift click, which is
   * why it is a ref rather than derived from `index`.
   */
  const selectAt = useCallback((i: number, e: { metaKey: boolean; shiftKey: boolean }) => {
    const entry = images[i];
    if (entry === undefined) return;

    setSelected((prev) => {
      if (e.shiftKey && anchorRef.current !== null) {
        const [lo, hi] = anchorRef.current < i
          ? [anchorRef.current, i]
          : [i, anchorRef.current];
        const next = new Set(prev);
        for (let k = lo; k <= hi; k += 1) {
          const path = images[k]?.path;
          if (path !== undefined) next.add(path);
        }
        return next;
      }

      if (e.metaKey) {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        anchorRef.current = i;
        return next;
      }

      anchorRef.current = i;
      return new Set([entry.path]);
    });
  }, [images]);

  const rememberFolder = useCallback(async (dir: string) => {
    const next = [dir, ...recentsRef.current.filter((r) => r !== dir)].slice(0, MAX_RECENTS);
    recentsRef.current = next;
    wroteRecentsRef.current = true;
    setRecents(next);
    await ctx.plugin.storage.set(RECENTS_KEY, next);
  }, [ctx]);

  /**
   * `defaultPath` only positions the dialog, so a recent folder still costs one
   * confirmation. That is deliberate: write grants never outlive the session
   * that created them, and the dialog is the only thing that creates one.
   */
  const copyTo = useCallback(async (defaultPath?: string) => {
    setMenuAt(null);
    const paths = images.filter((e) => selected.has(e.path)).map((e) => e.path);
    if (paths.length === 0) return;

    let dir: string | undefined;
    try {
      dir = await ctx.plugin.fs.pickDirectoryForWrite(defaultPath);
    } catch (err: unknown) {
      await ctx.plugin.ui.notify(err instanceof Error ? err.message : String(err), 'error');
      return;
    }
    if (dir === undefined) return;
    // `dir` is a `let`, so TypeScript widens it back to `string | undefined`
    // inside the worker closures below. Bind it to a const to keep the narrowing.
    const destination = dir;

    let copied = 0;
    let renamed = 0;
    const failures: string[] = [];

    // Four at a time, the same cap the thumbnail loader uses.
    const queue = [...paths];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        try {
          const result = await ctx.plugin.fs.copyFile(next, destination);
          copied += 1;
          if (result.renamed) renamed += 1;
        } catch (err: unknown) {
          failures.push(err instanceof Error ? err.message : String(err));
        }
      }
    });
    await Promise.all(workers);

    if (copied > 0) await rememberFolder(destination);

    const where = destination.slice(destination.lastIndexOf('/') + 1);
    const parts = [`${copied} copied to ${where}`];
    if (renamed > 0) parts.push(`${renamed} renamed`);
    if (failures.length > 0) parts.push(`${failures.length} failed`);
    await ctx.plugin.ui.notify(parts.join(' · '), failures.length > 0 ? 'warn' : 'info');
    if (failures[0] !== undefined) ctx.plugin.log.warn('copy failed', failures[0]);
  }, [ctx, images, selected, rememberFolder]);

  const closeMenu = useCallback(() => setMenuAt(null), []);

  // Open the first image once a folder has been listed.
  useEffect(() => {
    if (images.length > 0 && index === -1) void show(0);
  }, [images.length, index, show]);

  // Arrow keys. Scoped to this panel via focus rather than bound globally, so
  // they do not fight the shell or any other plugin for the keyboard.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      void show(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      void show(images.length - 1);
    } else if (e.key === 'a' && e.metaKey) {
      // The shell's Edit menu also binds ⌘A (menu.ts, `role: 'editMenu'`), and a
      // native key equivalent is resolved outside the DOM. We cannot suppress it
      // from here, so the strip is `user-select: none` instead — whichever handler
      // wins, the visible result is our selection and nothing else.
      e.preventDefault();
      setSelected(new Set(images.map((entry) => entry.path)));
    }
  }, [step, show, images]);

  useEffect(() => { rootRef.current?.focus(); }, []);

  const skipped = entries.filter((e) => !e.isDirectory).length - images.length;

  return (
    <div ref={rootRef} tabIndex={-1} style={styles.root} onKeyDown={onKeyDown}>
      <div style={styles.toolbar}>
        <button type="button" style={styles.button} onClick={() => void openFolder()}>
          Open folder…
        </button>

        {images.length > 0 && (
          <>
            <button type="button" style={styles.button} onClick={() => step(-1)} title="Previous (←)">‹</button>
            <span style={styles.counter}>{index + 1} / {images.length}</span>
            <button type="button" style={styles.button} onClick={() => step(1)} title="Next (→)">›</button>
            <span style={styles.sep} />
            <button type="button" style={styles.button} onClick={() => setZoom((z) => z / 1.25)}>−</button>
            <span style={styles.counter}>{Math.round(zoom * 100)}%</span>
            <button type="button" style={styles.button} onClick={() => setZoom((z) => z * 1.25)}>+</button>
            <button type="button" style={styles.button} onClick={() => setZoom(1)}>Reset</button>
            <span style={styles.sep} />
            <button
              type="button"
              style={styles.button}
              disabled={selected.size === 0}
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                setMenuAt({ x: r.left, y: r.bottom + 4 });
              }}
            >
              Copy to…
            </button>
          </>
        )}

        <span style={styles.meta}>
          {shown !== null
            ? `${shown.name} · ${formatBytes(shown.bytes)}${dimensions !== '' ? ` · ${dimensions}` : ''}`
            : folder !== null ? folder : ''}
        </span>
      </div>

      <div style={styles.body}>
        <div style={styles.stage}>
          {error !== null && <pre style={styles.error}>{error}</pre>}
          {error === null && shown === null && (
            <p style={styles.empty}>
              {folder === null
                ? <>No folder open. Use <strong>Open folder…</strong>.</>
                : <>No images in this folder.</>}
            </p>
          )}
          {error === null && shown !== null && (
            <img
              src={shown.url}
              alt={shown.name}
              style={{ ...styles.image, width: `${zoom * 100}%` }}
              onLoad={(e) => {
                const img = e.currentTarget;
                setDimensions(`${img.naturalWidth}×${img.naturalHeight}`);
              }}
              onError={() => setError('The file could not be decoded as an image.')}
            />
          )}
        </div>

        {images.length > 0 && (
          <div style={styles.strip}>
            <div style={styles.stripHead}>
              {images.length} image{images.length === 1 ? '' : 's'}
              {selected.size > 0 && <span style={styles.skipped}>{selected.size} selected</span>}
              {selected.size === 0 && skipped > 0 && <span style={styles.skipped}>{skipped} skipped</span>}
            </div>
            <div
              style={styles.grid}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuAt({ x: e.clientX, y: e.clientY });
              }}
            >
              {images.map((entry, i) => (
                <Thumb
                  key={entry.path}
                  ctx={ctx.plugin}
                  path={entry.path}
                  name={entry.name}
                  mime={mimeFor(entry.name) ?? 'application/octet-stream'}
                  selected={i === index}
                  checked={selected.has(entry.path)}
                  onClick={(e) => { selectAt(i, e); void show(i); }}
                  onContextMenu={() => {
                    if (!selected.has(entry.path)) {
                      selectAt(i, { metaKey: false, shiftKey: false });
                    }
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {menuAt !== null && selected.size > 0 && (
        <CopyMenu
          at={menuAt}
          recents={recents}
          count={selected.size}
          onPick={(defaultPath) => void copyTo(defaultPath)}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}

function CopyMenu({
  at, recents, count, onPick, onClose,
}: {
  at: { x: number; y: number };
  recents: string[];
  count: number;
  onPick: (defaultPath?: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const dismiss = () => onClose();
    window.addEventListener('click', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('click', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, [onClose]);

  return (
    <div style={{ ...styles.menu, left: at.x, top: at.y }} onClick={(e) => e.stopPropagation()}>
      <button type="button" style={styles.menuItem} onClick={() => onPick(undefined)}>
        Copy {count} image{count === 1 ? '' : 's'} to folder…
      </button>
      {recents.length > 0 && <div style={styles.menuSep} />}
      {recents.map((dir) => (
        <button
          key={dir}
          type="button"
          style={styles.menuItem}
          title={dir}
          onClick={() => onPick(dir)}
        >
          {dir.slice(dir.lastIndexOf('/') + 1)}
        </button>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    outline: 'none',
    font: '13px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    background: 'var(--workspace-bg, #fff)',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 12px',
    borderBottom: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--chrome-bg, #f4f4f5)',
  },
  button: {
    font: 'inherit',
    fontSize: 12,
    minWidth: 26,
    padding: '3px 10px',
    borderRadius: 5,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
    cursor: 'pointer',
  },
  counter: { minWidth: 54, textAlign: 'center', fontSize: 12, color: 'var(--chrome-muted, #71717a)' },
  sep: { width: 1, height: 16, background: 'var(--chrome-border, #d4d4d8)', margin: '0 3px' },
  meta: {
    marginLeft: 'auto',
    fontSize: 12,
    color: 'var(--chrome-muted, #71717a)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    direction: 'rtl',
  },
  body: { flex: 1, display: 'flex', minHeight: 0 },
  stage: { flex: 1, overflow: 'auto', display: 'grid', placeItems: 'center', padding: 16 },
  image: { maxWidth: 'none', display: 'block' },
  empty: { color: 'var(--chrome-muted, #71717a)' },
  strip: {
    width: 260,
    display: 'flex',
    flexDirection: 'column',
    borderLeft: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    userSelect: 'none',
  },
  stripHead: {
    display: 'flex',
    gap: 8,
    padding: '6px 10px',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--chrome-muted, #71717a)',
    borderBottom: '1px solid var(--chrome-border, #d4d4d8)',
  },
  skipped: { marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 },
  grid: {
    flex: 1,
    overflowY: 'auto',
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(108px, 1fr))',
    gap: 2,
    padding: 6,
    alignContent: 'start',
    userSelect: 'none',
  },
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
  menu: {
    position: 'fixed',
    zIndex: 10,
    minWidth: 200,
    padding: 4,
    borderRadius: 8,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.18)',
    display: 'flex',
    flexDirection: 'column',
  },
  menuItem: {
    font: 'inherit',
    fontSize: 12,
    textAlign: 'left',
    padding: '6px 10px',
    borderRadius: 5,
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  menuSep: { height: 1, margin: '4px 6px', background: 'var(--chrome-border, #d4d4d8)' },
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
