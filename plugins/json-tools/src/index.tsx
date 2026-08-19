import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PanelContext, Plugin } from '@workbench/plugin-sdk';
import { definePanel } from '@workbench/plugin-sdk/react';
import { TreeNode, countNodes, topLevelPaths, type Json } from './tree.js';

const STORAGE_KEY = 'session';

const SAMPLE = JSON.stringify(
  {
    plugin: 'json-tools',
    apiVersion: '1.0',
    contributes: { panels: [{ id: 'json.main', title: 'JSON' }] },
    persisted: true,
    reloadCount: 0,
  },
  null,
  2,
);

interface Session {
  text: string;
  expanded: string[];
  [k: string]: Json;
}

function isSession(v: unknown): v is Session {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as { text?: unknown; expanded?: unknown };
  return typeof s.text === 'string'
    && Array.isArray(s.expanded)
    && s.expanded.every((e) => typeof e === 'string');
}

function JsonPanel({ ctx }: { ctx: PanelContext }) {
  const [text, setText] = useState(SAMPLE);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['$']));
  const [restored, setRestored] = useState(false);

  // ── restore, once, before any save can run ────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await ctx.plugin.storage.get(STORAGE_KEY);
      if (cancelled) return;
      if (isSession(saved)) {
        setText(saved.text);
        setExpanded(new Set(saved.expanded));
      }
      setRestored(true);
    })();
    return () => { cancelled = true; };
  }, [ctx]);

  // ── save, debounced, only after restore has happened ──────────────
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!restored) return;      // never overwrite saved state with the sample
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void ctx.plugin.storage.set(STORAGE_KEY, {
        text,
        expanded: [...expanded],
      });
    }, 400);
    return () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    };
  }, [ctx, text, expanded, restored]);

  const parsed = useMemo<{ value: Json } | { error: string }>(() => {
    try {
      return { value: JSON.parse(text) as Json };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [text]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const reformat = useCallback((indent: number) => {
    if (!('value' in parsed)) return;
    setText(JSON.stringify(parsed.value, null, indent));
  }, [parsed]);

  const expandAll = useCallback(() => {
    if (!('value' in parsed)) return;
    setExpanded(new Set(['$', ...topLevelPaths(parsed.value)]));
  }, [parsed]);

  const ok = 'value' in parsed;

  return (
    <div style={styles.root}>
      <div style={styles.toolbar}>
        <button type="button" style={styles.button} disabled={!ok} onClick={() => reformat(2)}>Format</button>
        <button type="button" style={styles.button} disabled={!ok} onClick={() => reformat(0)}>Minify</button>
        <button type="button" style={styles.button} disabled={!ok} onClick={expandAll}>Expand</button>
        <button type="button" style={styles.button} onClick={() => setExpanded(new Set(['$']))}>Collapse</button>
        <span style={styles.meta}>
          {ok
            ? `valid · ${countNodes(parsed.value)} nodes · ${text.length} chars`
            : 'invalid JSON'}
        </span>
      </div>

      <div style={styles.split}>
        <textarea
          style={styles.textarea}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
        <div style={styles.tree}>
          {ok
            ? <TreeNode name="$" value={parsed.value} path="$" expanded={expanded} onToggle={toggle} />
            : <pre style={styles.error}>{parsed.error}</pre>}
        </div>
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
  meta: { marginLeft: 'auto', color: 'var(--chrome-muted, #71717a)', fontSize: 12 },
  split: { flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, minHeight: 0, background: 'var(--chrome-border, #d4d4d8)' },
  textarea: {
    resize: 'none',
    border: 'none',
    outline: 'none',
    padding: 12,
    font: "12px/1.6 'SF Mono', ui-monospace, monospace",
    color: 'inherit',
    background: 'var(--workspace-bg, #fff)',
  },
  tree: {
    overflow: 'auto',
    padding: 12,
    background: 'var(--workspace-bg, #fff)',
    font: "12px/1.7 'SF Mono', ui-monospace, monospace",
  },
  error: {
    margin: 0,
    whiteSpace: 'pre-wrap',
    color: 'var(--error-fg, #b91c1c)',
  },
};

export const plugin: Plugin = {
  activate(ctx) {
    ctx.log.info('json-tools activating');
    ctx.registerPanel('json.main', definePanel(JsonPanel));
    ctx.registerCommand('json.open', () => ctx.workspace.openPanel('json.main'));
  },

  deactivate() {
    console.log('json-tools deactivating');
  },
};
