import { useEffect, useState } from 'react';
import type { Plugin } from '@workbench/plugin-sdk';
import { definePanel } from '@workbench/plugin-sdk/react';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',   // routes output through DOMPurify
  theme: 'default',
});

const SAMPLE = `graph TD
  M[plugin.json] -->|read at startup| S[Shell]
  S -->|builds| Menu
  Menu -->|onCommand| A[activate]
  A -->|registerPanel| P[mount el, ctx]
  P -->|returns| T[teardown]`;

/** mermaid.render needs a unique id per call or it reuses cached DOM. */
let renderSeq = 0;

function MermaidPanel() {
  const [source, setSource] = useState(SAMPLE);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      renderSeq += 1;
      mermaid
        .render(`mmd-${renderSeq}`, source)
        .then((result) => {
          if (cancelled) return;
          setSvg(result.svg);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // keep the last good SVG on screen; only surface the message
          setError(err instanceof Error ? err.message : String(err));
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source]);

  return (
    <div style={styles.root}>
      <div style={styles.pane}>
        <label style={styles.label} htmlFor="mermaid-source">Source</label>
        <textarea
          id="mermaid-source"
          style={styles.textarea}
          value={source}
          spellCheck={false}
          onChange={(e) => setSource(e.target.value)}
        />
        {error !== null && <pre style={styles.error}>{error}</pre>}
      </div>
      <div style={styles.pane}>
        <label style={styles.label}>Preview</label>
        <div
          style={styles.preview}
          // mermaid sanitises its own output at securityLevel 'strict'
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 1,
    height: '100%',
    background: 'var(--chrome-border, #d4d4d8)',
    font: '13px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  },
  pane: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    background: 'var(--workspace-bg, #fff)',
  },
  label: {
    padding: '6px 10px',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--chrome-muted, #71717a)',
    borderBottom: '1px solid var(--chrome-border, #d4d4d8)',
  },
  textarea: {
    flex: 1,
    resize: 'none',
    border: 'none',
    outline: 'none',
    padding: 12,
    font: "12px/1.6 'SF Mono', ui-monospace, monospace",
    color: 'inherit',
    background: 'transparent',
  },
  preview: {
    flex: 1,
    overflow: 'auto',
    padding: 12,
    display: 'grid',
    placeItems: 'center',
  },
  error: {
    margin: 0,
    padding: '8px 12px',
    whiteSpace: 'pre-wrap',
    font: "11px/1.5 'SF Mono', ui-monospace, monospace",
    color: 'var(--error-fg, #b91c1c)',
    background: 'var(--error-bg, #fef2f2)',
    borderTop: '1px solid currentColor',
  },
};

export const plugin: Plugin = {
  activate(ctx) {
    ctx.log.info('mermaid-viewer activating');
    ctx.registerPanel('mermaid.main', definePanel(MermaidPanel));
    ctx.registerCommand('mermaid.open', () => ctx.workspace.openPanel('mermaid.main'));
  },

  deactivate() {
    console.log('mermaid-viewer deactivating');
  },
};
