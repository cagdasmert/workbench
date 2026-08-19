import { useCallback, useEffect, useState } from 'react';
import type { Content, PanelContext, Plugin, PluginContext } from '@workbench/plugin-sdk';
import { definePanel } from '@workbench/plugin-sdk/react';
import { createOpenAiCompatibleProvider, textToMermaid, type AiProvider } from './provider.js';

const SAMPLE = 'A user opens a file. The shell reads its manifest, activates the '
  + 'matching plugin, mounts its panel, and the plugin renders the file.';

/** Bridges a command invocation to whichever panel instance is mounted. */
const prompts = {
  listeners: new Set<(text: string) => void>(),
  emit(text: string) { for (const l of this.listeners) l(text); },
  on(l: (text: string) => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; },
};

function AiPanel({ ctx }: { ctx: PanelContext }) {
  const incoming = typeof (ctx.payload as Content | undefined)?.data === 'string'
    ? String((ctx.payload as Content).data)
    : '';

  const [text, setText] = useState(incoming === '' ? SAMPLE : incoming);
  const [status, setStatus] = useState<'idle' | 'running'>('idle');
  const [result, setResult] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (source: string) => {
    setStatus('running');
    setError(null);
    setResult('');
    try {
      const provider = createOpenAiCompatibleProvider(ctx.plugin);
      const mermaid = await textToMermaid(provider, source);
      setResult(mermaid);
      // Named no destination — the shell routes it to whoever accepts
      // text/vnd.mermaid. This plugin does not know the mermaid viewer exists.
      await ctx.plugin.bus.emit({ type: 'text/vnd.mermaid', data: mermaid });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatus('idle');
    }
  }, [ctx]);

  useEffect(() => prompts.on((incomingText) => {
    setText(incomingText);
    void run(incomingText);
  }), [run]);

  return (
    <div style={styles.root}>
      <div style={styles.toolbar}>
        <button
          type="button"
          style={styles.button}
          disabled={status === 'running'}
          onClick={() => void run(text)}
        >
          {status === 'running' ? 'Generating…' : 'Diagram this text'}
        </button>
        <span style={styles.meta}>
          {status === 'running' ? 'waiting on the model…' : 'localhost:11434 · OpenAI-compatible'}
        </span>
      </div>

      <div style={styles.split}>
        <textarea
          style={styles.textarea}
          value={text}
          spellCheck={false}
          placeholder="Describe something to diagram…"
          onChange={(e) => setText(e.target.value)}
        />
        <div style={styles.output}>
          {error !== null && (
            <pre style={styles.error}>
              {error}
              {'\n\n'}
              Is a model server running? Try:{'\n'}
              {'  ollama serve'}{'\n'}
              {'  ollama pull llama3.2'}
            </pre>
          )}
          {error === null && result === '' && (
            <p style={styles.empty}>
              The generated mermaid source appears here, and is emitted onto the
              content bus for whichever plugin accepts <code>text/vnd.mermaid</code>.
            </p>
          )}
          {error === null && result !== '' && <pre style={styles.result}>{result}</pre>}
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
  split: {
    flex: 1,
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 1,
    minHeight: 0,
    background: 'var(--chrome-border, #d4d4d8)',
  },
  textarea: {
    resize: 'none',
    border: 'none',
    outline: 'none',
    padding: 12,
    font: "12px/1.6 'SF Mono', ui-monospace, monospace",
    color: 'inherit',
    background: 'var(--workspace-bg, #fff)',
  },
  output: { overflow: 'auto', padding: 12, background: 'var(--workspace-bg, #fff)' },
  result: { margin: 0, whiteSpace: 'pre-wrap', font: "12px/1.6 'SF Mono', ui-monospace, monospace" },
  empty: { margin: 0, color: 'var(--chrome-muted, #71717a)' },
  error: {
    margin: 0,
    whiteSpace: 'pre-wrap',
    font: "12px/1.5 'SF Mono', ui-monospace, monospace",
    color: 'var(--error-fg, #b91c1c)',
  },
};

export const plugin: Plugin = {
  activate(ctx: PluginContext) {
    ctx.log.info('ai-provider activating');
    ctx.registerPanel('ai.main', definePanel(AiPanel));
    ctx.registerCommand('ai.open', () => ctx.workspace.openPanel('ai.main'));

    ctx.registerCommand('ai.textToMermaid', async (...args: unknown[]) => {
      const text = typeof args[0] === 'string' ? args[0] : '';
      await ctx.workspace.openPanel('ai.main');
      if (text !== '') prompts.emit(text);
    });

    // Any plugin emitting text/plain can land here — "explain this" for free.
    ctx.bus.onReceive((content) => {
      if (typeof content.data !== 'string') return;
      prompts.emit(content.data);
      return { handled: true };
    });
  },

  deactivate() {
    console.log('ai-provider deactivating');
  },
};

export type { AiProvider };
