import { useEffect, useRef, useState } from 'react';
import type { PluginContext } from '@workbench/plugin-sdk';

/**
 * Bounded-concurrency loader.
 *
 * A folder of 500 photos would otherwise fire 500 simultaneous IPC round trips
 * on mount, each returning a full-resolution buffer over the bridge. Four at a
 * time keeps the UI responsive and the transfers small enough to interleave.
 */
class Queue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await job();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

const queue = new Queue(4);

export function Thumb({
  ctx,
  path,
  name,
  mime,
  selected,
  checked,
  onClick,
  onContextMenu,
}: {
  ctx: PluginContext;
  path: string;
  name: string;
  mime: string;
  selected: boolean;
  checked: boolean;
  onClick: (e: { metaKey: boolean; shiftKey: boolean }) => void;
  onContextMenu?: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Only decode what the user can actually see. Everything below the fold in a
  // large folder stays a placeholder until it scrolls into view.
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;

    let cancelled = false;
    let objectUrl: string | null = null;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();

      void queue.run(async () => {
        if (cancelled) return;
        try {
          const bytes = await ctx.fs.readFile(path);
          if (cancelled) return;
          objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
          setUrl(objectUrl);
        } catch {
          if (!cancelled) setFailed(true);
        }
      });
    }, { rootMargin: '200px' });

    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [ctx, path, mime]);

  // Keep the selected tile visible when navigating with the keyboard.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={name}
      style={{
        ...styles.tile,
        ...(selected ? styles.tileSelected : {}),
        ...(checked ? styles.tileChecked : {}),
      }}
    >
      <span style={styles.frame}>
        {url !== null && <img src={url} alt={name} style={styles.img} />}
        {url === null && !failed && <span style={styles.pending} />}
        {failed && <span style={styles.failed}>!</span>}
      </span>
      <span style={styles.name}>{name}</span>
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: 5,
    border: '1px solid transparent',
    borderRadius: 7,
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
    textAlign: 'center',
  },
  tileSelected: {
    borderColor: 'var(--accent-fg, #2563eb)',
    background: 'var(--accent-bg, rgba(59,130,246,0.14))',
  },
  tileChecked: {
    boxShadow: 'inset 0 0 0 2px var(--accent-fg, #2563eb)',
  },
  frame: {
    display: 'grid',
    placeItems: 'center',
    height: 84,
    borderRadius: 5,
    overflow: 'hidden',
    background: 'var(--chrome-bg, #f4f4f5)',
  },
  img: { maxWidth: '100%', maxHeight: 84, display: 'block', objectFit: 'contain' },
  pending: { width: 18, height: 18, borderRadius: 4, background: 'var(--chrome-border, #d4d4d8)' },
  failed: { color: 'var(--error-fg, #b91c1c)', fontWeight: 700 },
  name: {
    fontSize: 10,
    lineHeight: 1.3,
    color: 'var(--chrome-muted, #71717a)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
};
