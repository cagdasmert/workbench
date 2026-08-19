import { useCallback, useEffect, useRef, useState } from 'react';
import type { Content, PanelContext, Plugin } from '@workbench/plugin-sdk';
import { definePanel } from '@workbench/plugin-sdk/react';
import mermaid from 'mermaid';
import { Viewport, clamp, IDENTITY, type View } from './Viewport.js';

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

/** Last successful render, so the export command has something to emit. */
let lastSvg = '';

const themeRequests = {
  listeners: new Set<() => void>(),
  emit() { for (const l of this.listeners) l(); },
  on(l: () => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; },
};

/** mermaid.render needs a unique id per call or it reuses cached DOM. */
let renderSeq = 0;

/**
 * mermaid measures diagrams by appending a scratch element to document.body,
 * and does not always remove it — on failure it leaves the error graphic behind
 * entirely. Anything it left outside this panel is ours to clean up.
 */
function purgeStrayMermaidNodes(): void {
  for (const el of document.querySelectorAll('body > [id^="dmmd-"], body > [id^="mmd-"]')) {
    el.remove();
  }
  for (const el of document.querySelectorAll('body > svg[aria-roledescription="error"]')) {
    el.remove();
  }
}

function MermaidPanel({ ctx }: { ctx: PanelContext }) {
  // Routed here by the shell: ai-provider emits text/vnd.mermaid, this plugin
  // declares it in `accepts`, and neither knows about the other.
  const routed = typeof (ctx.payload as Content | undefined)?.data === 'string'
    ? String((ctx.payload as Content).data)
    : '';

  const [source, setSource] = useState(routed === '' ? SAMPLE : routed);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<View>(IDENTITY);
  const [fullscreen, setFullscreen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => themeRequests.on(() => setThemeTick((t) => t + 1)), []);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        // Validate first. mermaid.render() draws its own "Syntax error in text"
        // bomb straight into document.body on failure — outside this panel, over
        // the whole window, and impossible to style or dismiss. parse() throws
        // the same message with no DOM side effects at all.
        try {
          await mermaid.parse(source);
        } catch (err: unknown) {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          purgeStrayMermaidNodes();
          return;                       // keep the last good SVG on screen
        }

        renderSeq += 1;
        try {
          const result = await mermaid.render(`mmd-${renderSeq}`, source);
          if (cancelled) return;
          lastSvg = result.svg;
          setSvg(result.svg);
          setError(null);
        } catch (err: unknown) {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          purgeStrayMermaidNodes();
        }
      })();
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source, themeTick]);

  /**
   * Scale to fit and centre. Measured from the SVG's viewBox rather than its
   * bounding rect, because the rect already includes the current transform and
   * would make fit() depend on the zoom it is about to replace.
   */
  const fit = useCallback(() => {
    const stage = stageRef.current;
    const svgEl = stage?.querySelector('svg');
    if (stage === null || svgEl === null || svgEl === undefined) return;

    const stageBox = stage.getBoundingClientRect();
    const naturalW = svgEl.viewBox.baseVal.width;
    const naturalH = svgEl.viewBox.baseVal.height;
    if (naturalW === 0 || naturalH === 0 || stageBox.width === 0) return;

    const zoom = clamp(Math.min(
      (stageBox.width - 48) / naturalW,
      (stageBox.height - 48) / naturalH,
      1,
    ));
    setView({
      zoom,
      x: (stageBox.width - naturalW * zoom) / 2,
      y: (stageBox.height - naturalH * zoom) / 2,
    });
  }, []);

  // Fit on a new diagram, and again when the surface changes size — a view that
  // fitted the half-width pane does not fit the fullscreen one.
  useEffect(() => {
    if (svg === '') return;
    const id = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(id);
  }, [svg, fullscreen, fit]);

  /** Zoom about the centre of the stage, so the buttons and the wheel agree. */
  const zoomBy = useCallback((factor: number) => {
    const stage = stageRef.current;
    if (stage === null) return;
    const box = stage.getBoundingClientRect();
    const cx = box.width / 2;
    const cy = box.height / 2;

    setView((prev) => {
      const next = clamp(prev.zoom * factor);
      const ratio = next / prev.zoom;
      return { zoom: next, x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio };
    });
  }, []);

  // Escape leaves fullscreen. Captured on the window, so the shell's own
  // keybinding dispatcher does not see the keystroke first.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setFullscreen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [fullscreen]);

  const toolbar = (
    <div style={styles.toolbar}>
      <button type="button" style={styles.button} onClick={() => zoomBy(1 / 1.25)} title="Zoom out">−</button>
      <span style={styles.zoom}>{Math.round(view.zoom * 100)}%</span>
      <button type="button" style={styles.button} onClick={() => zoomBy(1.25)} title="Zoom in">+</button>
      <button type="button" style={styles.button} onClick={fit} title="Fit to window">Fit</button>
      <button type="button" style={styles.button} onClick={() => setView(IDENTITY)} title="Actual size">1:1</button>
      <button
        type="button"
        style={styles.button}
        onClick={() => setFullscreen((f) => !f)}
        title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
      >
        {fullscreen ? '⤡ Exit' : '⤢ Fullscreen'}
      </button>
      <span style={styles.hint}>drag to pan · ⌘/ctrl + scroll to zoom</span>
    </div>
  );

  const preview = (
    <div ref={stageRef} style={styles.stage}>
      <Viewport html={svg} view={view} onView={setView} />
    </div>
  );

  if (fullscreen) {
    // The plugin owns this subtree, so a fixed overlay covers the whole window
    // without the shell needing to know anything about it.
    return (
      <div style={styles.overlay}>
        {toolbar}
        {preview}
        {error !== null && <pre style={styles.error}>{error}</pre>}
      </div>
    );
  }

  return (
    <div style={styles.root}>
      <div style={styles.pane}>
        <label style={styles.label} htmlFor="mermaid-source">
          Source
          {error !== null && <span style={styles.badge}>syntax error</span>}
        </label>
        {/* Above the textarea, not below it: the textarea is flex:1, so an
            error placed after it sits at the very bottom of a full-height pane
            where it is easy to miss entirely. */}
        {error !== null && <pre style={styles.error}>{error}</pre>}
        <textarea
          id="mermaid-source"
          style={styles.textarea}
          value={source}
          spellCheck={false}
          onChange={(e) => setSource(e.target.value)}
        />
      </div>
      <div style={styles.pane}>
        {toolbar}
        {preview}
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
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 200,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--workspace-bg, #fff)',
    font: '13px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  },
  pane: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    background: 'var(--workspace-bg, #fff)',
  },
  badge: {
    marginLeft: 8,
    padding: '1px 6px',
    borderRadius: 999,
    fontSize: 10,
    letterSpacing: 0,
    textTransform: 'none',
    color: 'var(--error-fg, #b91c1c)',
    border: '1px solid currentColor',
  },
  label: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 10px',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--chrome-muted, #71717a)',
    borderBottom: '1px solid var(--chrome-border, #d4d4d8)',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 8px',
    borderBottom: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--chrome-bg, #f4f4f5)',
  },
  button: {
    font: 'inherit',
    fontSize: 12,
    minWidth: 28,
    padding: '2px 9px',
    borderRadius: 5,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
    cursor: 'pointer',
  },
  zoom: {
    minWidth: 46,
    textAlign: 'center',
    fontSize: 12,
    color: 'var(--chrome-muted, #71717a)',
  },
  hint: {
    marginLeft: 'auto',
    fontSize: 11,
    color: 'var(--chrome-muted, #71717a)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  stage: { display: 'flex', flex: 1, minHeight: 0 },
  textarea: {
    flex: 1,
    resize: 'none',
    border: 'none',
    outline: 'none',
    padding: 12,
    font: "12px/1.6 'SF Mono', ui-monospace, monospace",
    color: 'inherit',
    background: 'transparent',
    // explicit: the preview pane sets user-select:none, and this makes the
    // source pane's behaviour independent of anything an ancestor does
    userSelect: 'text',
    cursor: 'text',
  },
  error: {
    margin: 0,
    padding: '8px 12px',
    maxHeight: '30%',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    font: "11px/1.5 'SF Mono', ui-monospace, monospace",
    color: 'var(--error-fg, #b91c1c)',
    background: 'var(--error-bg, #fef2f2)',
    borderBottom: '1px solid currentColor',
    flexShrink: 0,
  },
};

export const plugin: Plugin = {
  activate(ctx) {
    ctx.log.info('mermaid-viewer activating');
    ctx.registerPanel('mermaid.main', definePanel(MermaidPanel));
    ctx.registerCommand('mermaid.open', () => ctx.workspace.openPanel('mermaid.main'));

    // Emits into the bus and names no destination. The shell routes it from the
    // `emits`/`accepts` in the manifests — this plugin does not know the image
    // viewer exists, and must not.
    ctx.registerCommand('mermaid.export', async () => {
      if (lastSvg === '') {
        await ctx.ui.notify('Nothing rendered yet', 'warn');
        return;
      }
      await ctx.bus.emit({
        type: 'image/svg+xml',
        data: lastSvg,
        meta: { filename: 'diagram.svg' },
      });
    });

    ctx.registerCommand('mermaid.theme', async (...args: unknown[]) => {
      const theme = typeof args[0] === 'string' ? args[0] : 'default';
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme as 'default' });
      themeRequests.emit();
      await ctx.workspace.openPanel('mermaid.main');
    });
  },

  deactivate() {
    console.log('mermaid-viewer deactivating');
  },
};
