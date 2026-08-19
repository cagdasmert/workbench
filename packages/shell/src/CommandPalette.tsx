import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandDescriptor } from '@workbench/plugin-host';

/**
 * Subsequence match, the same rule editors use: every character of the query
 * must appear in order. Returns the matched indices for highlighting, or null.
 */
function fuzzyMatch(text: string, query: string): number[] | null {
  if (query === '') return [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const hits: number[] = [];
  let at = 0;
  for (const ch of needle) {
    const found = hay.indexOf(ch, at);
    if (found === -1) return null;
    hits.push(found);
    at = found + 1;
  }
  return hits;
}

/** Earlier matches and tighter runs rank higher. */
function score(hits: number[]): number {
  if (hits.length === 0) return 0;
  const first = hits[0] ?? 0;
  const spread = (hits[hits.length - 1] ?? 0) - first;
  return -(first * 2 + spread);
}

function Highlight({ text, hits }: { text: string; hits: number[] }) {
  if (hits.length === 0) return <>{text}</>;
  const set = new Set(hits);
  return (
    <>
      {[...text].map((ch, i) => (
        <span key={i} style={set.has(i) ? styles.hit : undefined}>{ch}</span>
      ))}
    </>
  );
}

export function CommandPalette({
  commands,
  onRun,
  onClose,
}: {
  commands: CommandDescriptor[];
  onRun: (command: CommandDescriptor) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const matches = useMemo(() => {
    const scored = commands
      .map((command) => {
        const hits = fuzzyMatch(command.title, query);
        return hits === null ? null : { command, hits, score: score(hits) };
      })
      .filter((m): m is { command: CommandDescriptor; hits: number[]; score: number } => m !== null);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 50);
  }, [commands, query]);

  useEffect(() => { setCursor(0); }, [query]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const run = (index: number) => {
    const hit = matches[index];
    if (hit !== undefined) onRun(hit.command);
  };

  return (
    <div style={styles.scrim} onMouseDown={onClose}>
      <div style={styles.panel} onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          style={styles.input}
          value={query}
          placeholder="Run a command…"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, matches.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(cursor);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <ul ref={listRef} style={styles.list}>
          {matches.length === 0 && <li style={styles.empty}>No matching command</li>}
          {matches.map(({ command, hits }, i) => (
            <li
              key={command.id}
              style={{ ...styles.row, ...(i === cursor ? styles.rowActive : {}) }}
              onMouseMove={() => setCursor(i)}
              onClick={() => run(i)}
            >
              <span style={styles.title}>
                <Highlight text={command.title} hits={hits} />
              </span>
              {command.args !== undefined && <span style={styles.badge}>args</span>}
              <span style={styles.source}>{command.source}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  scrim: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.32)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingTop: '12vh',
    zIndex: 100,
  },
  panel: {
    width: 'min(620px, 90vw)',
    background: 'var(--chrome-bg, #f4f4f5)',
    border: '1px solid var(--chrome-border, #d4d4d8)',
    borderRadius: 10,
    boxShadow: '0 18px 48px rgba(0,0,0,0.32)',
    overflow: 'hidden',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '13px 16px',
    border: 'none',
    outline: 'none',
    font: '15px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    color: 'inherit',
    background: 'var(--workspace-bg, #fff)',
    borderBottom: '1px solid var(--chrome-border, #d4d4d8)',
  },
  list: { listStyle: 'none', margin: 0, padding: 4, maxHeight: '48vh', overflowY: 'auto' },
  row: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    padding: '7px 12px',
    borderRadius: 6,
    cursor: 'pointer',
    font: '13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  },
  rowActive: { background: 'var(--accent-bg, rgba(59,130,246,0.16))' },
  title: { flex: 1, minWidth: 0 },
  hit: { fontWeight: 700, color: 'var(--accent-fg, #2563eb)' },
  badge: {
    fontSize: 10,
    padding: '1px 5px',
    borderRadius: 4,
    color: 'var(--chrome-muted, #71717a)',
    border: '1px solid var(--chrome-border, #d4d4d8)',
  },
  source: { fontSize: 11, color: 'var(--chrome-muted, #71717a)' },
  empty: { padding: '10px 12px', color: 'var(--chrome-muted, #71717a)', fontSize: 13 },
};
