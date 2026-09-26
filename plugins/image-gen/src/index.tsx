import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PanelContext, Plugin } from '@workbench/plugin-sdk';
import { definePanel } from '@workbench/plugin-sdk/react';
import {
  asDaemonError, DaemonError, DEFAULT_DAEMON_URL, ImageClient, START_COMMAND,
  type ImageJob, type ImageModel,
} from './client.js';
import {
  addHistory, DEFAULT_HISTORY_LIMIT, describeEntry, fromJob, historyLimit, parseHistory, shortModel,
  type HistoryEntry,
} from './history.js';
import {
  afterRun, commandRequest, DEFAULT_GENERATE_MODEL, emptyForm, modelOptions, placeholders,
  rollSeed, runStatus, toGenerateRequest, toggleLock, type GenerateForm,
} from './form.js';
import { startPoller } from './poller.js';
import { planReattach } from './reattach.js';

const PANEL_ID = 'imagegen.main';

/**
 * A job was started outside the panel, by the imagegen.generate command. The
 * daemon stays the only record of it. This only tells an already-mounted panel
 * to look again, because `openPanel` on the active panel does not remount it.
 * A panel mounted later finds the job itself (spec decision 17), so nothing is
 * queued.
 */
function nudge() {
  const listeners = new Set<() => void>();
  return {
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    notify(): void { for (const fn of [...listeners]) fn(); },
    /** On deactivate: a panel from this activation must not hear the next one. */
    clear(): void { listeners.clear(); },
    get size(): number { return listeners.size; },
  };
}

export const jobStarted = nudge();

type Problem = { message: string; hint?: string | undefined };

function ImagesPanel({ ctx }: { ctx: PanelContext }) {
  const [daemonUrl, setDaemonUrl] = useState(DEFAULT_DAEMON_URL);
  const [token, setToken] = useState('');
  const [configuredModel, setConfiguredModel] = useState(DEFAULT_GENERATE_MODEL);
  const [outDir, setOutDir] = useState('');
  const [limit, setLimit] = useState(DEFAULT_HISTORY_LIMIT);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // TRAP 1 (change log 6, 13): storage and settings are async. Nothing is saved,
  // and the daemon is not contacted, until both have been read.
  const [loaded, setLoaded] = useState(false);

  const [offline, setOffline] = useState<DaemonError | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  // F10: null until client.models() resolves, so a missing/undownloaded model
  // is never flagged from an empty catalog that just hasn't loaded yet.
  const [catalog, setCatalog] = useState<ImageModel[] | null>(null);
  const [form, setForm] = useState<GenerateForm>(() => emptyForm(DEFAULT_GENERATE_MODEL));
  const [running, setRunning] = useState<ImageJob | null>(null);
  // null shows the newest entry.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // F8: true from a Generate/Cancel click until that request settles.
  const [pending, setPending] = useState(false);

  // Read inside callbacks that must not be rebuilt every time these change.
  const historyRef = useRef(history);
  historyRef.current = history;
  const limitRef = useRef(limit);
  limitRef.current = limit;
  // F5: the array set by the load effect, so the persist effect can tell "just
  // loaded" apart from "changed since" without writing back what it just read.
  const loadedRef = useRef<HistoryEntry[] | null>(null);

  const client = useMemo(() => new ImageClient(ctx.plugin, daemonUrl, token), [ctx, daemonUrl, token]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [u, t, m, o, l, h] = await Promise.all([
        ctx.plugin.settings.get('daemonUrl'),
        ctx.plugin.settings.get('token'),
        ctx.plugin.settings.get('model'),
        ctx.plugin.settings.get('outputDir'),
        ctx.plugin.settings.get('historyLimit'),
        ctx.plugin.storage.get('history'),
      ]);
      if (cancelled) return;
      if (typeof u === 'string' && u !== '') setDaemonUrl(u);
      if (typeof t === 'string') setToken(t);
      const model = typeof m === 'string' && m.trim() !== '' ? m.trim() : DEFAULT_GENERATE_MODEL;
      setConfiguredModel(model);
      setForm((f) => ({ ...f, model }));
      if (typeof o === 'string') setOutDir(o);
      const lim = historyLimit(l);
      setLimit(lim);
      const parsed = parseHistory(h, lim);
      loadedRef.current = parsed;
      setHistory(parsed);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [ctx]);

  // TRAP 2 (change log 15): onChange returns a Disposable, not a cleanup function.
  useEffect(() => {
    const sub = ctx.plugin.settings.onChange((key, value) => {
      if (key === 'daemonUrl' && typeof value === 'string' && value !== '') setDaemonUrl(value);
      if (key === 'token' && typeof value === 'string') setToken(value);
      if (key === 'model' && typeof value === 'string' && value.trim() !== '') {
        const model = value.trim();
        setConfiguredModel(model);
        setForm((f) => ({ ...f, model }));
      }
      if (key === 'outputDir' && typeof value === 'string') setOutDir(value);
      if (key === 'historyLimit') setLimit(historyLimit(value));
    });
    return () => { void sub.dispose(); };
  }, [ctx]);

  useEffect(() => {
    if (!loaded) return;
    // Skip the write that would just echo back what the load effect read.
    if (history === loadedRef.current) return;
    void ctx.plugin.storage.set('history', history);
  }, [ctx, loaded, history]);

  const fail = useCallback((err: unknown) => {
    const e = asDaemonError(err);
    if (e.kind === 'offline') setOffline(e);
    else setProblem(e);
  }, []);

  /** Adds a finished job to the strip. `fresh`: it is the run this panel was watching. */
  const record = useCallback((job: ImageJob, fresh: boolean) => {
    const entry = fromJob(job);
    if (entry === null) return;
    setHistory((list) => addHistory(list, entry, limitRef.current));
    if (fresh) {
      setSelectedId(entry.id);
      setForm((f) => afterRun(f, entry.seed));
    }
  }, []);

  // C4 and spec decision 17: ask the daemon, the only thing that knows, what is
  // running and what finished while no panel was watching.
  const scan = useCallback(async () => {
    const { jobs } = await client.jobs();
    const plan = planReattach(jobs, new Set(historyRef.current.map((e) => e.id)));
    if (plan.running !== null) setRunning(plan.running);
    for (const id of plan.unrecorded) record(await client.job(id), false);
  }, [client, record]);

  const connect = useCallback(async () => {
    setOffline(null);
    try {
      await client.health();
      setCatalog(await client.models());
      await scan();
    } catch (err: unknown) {
      fail(err);
    }
  }, [client, scan, fail]);

  useEffect(() => { if (loaded) void connect(); }, [loaded, connect]);

  // A job the imagegen.generate command started while this panel was open.
  useEffect(() => jobStarted.subscribe(() => { void scan().catch(fail); }), [scan, fail]);

  // ─── polling ───────────────────────────────────────────────

  const runningId = running?.id ?? null;
  useEffect(() => {
    if (runningId === null) return undefined;
    const poller = startPoller<ImageJob>({
      fetch: () => client.job(runningId),
      onValue: (job) => {
        if (job.state === 'running') {
          setRunning(job);
          return;
        }
        setRunning(null);
        if (job.state === 'done') record(job, true);
        else if (job.state === 'failed') setProblem({ message: job.error ?? 'The generation failed.' });
      },
      onError: (err) => {
        const e = asDaemonError(err);
        // offline: the daemon may just be restarting — keep polling quietly.
        if (e.kind === 'offline') return;
        // A 404 means the daemon restarted and forgot the job outright.
        if (e.kind === 'api' && e.status === 404) {
          setRunning(null);
          setProblem({ message: `${e.message} — the daemon forgets jobs when it restarts.` });
          return;
        }
        // Anything else: show it, but keep polling — the loop may still recover.
        setProblem(e);
      },
      next: (job) => (job.state === 'running' ? 1_000 : undefined),
    });
    return () => poller.stop();
  }, [client, runningId, record]);

  // ─── actions ───────────────────────────────────────────────

  const options = useMemo(() => modelOptions(catalog ?? [], configuredModel, 'generate'), [catalog, configuredModel]);
  const option = options.find((o) => o.value === form.model) ?? null;
  const info = option?.info ?? null;
  const hints = placeholders(info);
  // F2: the limit trims what is shown, never what is stored — pruning storage
  // itself happens only in addHistory (next result) and parseHistory (at load).
  const visible = useMemo(() => history.slice(0, limit), [history, limit]);
  const selected = visible.find((e) => e.id === selectedId) ?? visible[0] ?? null;

  const run = useCallback(async () => {
    setProblem(null);
    const built = toGenerateRequest(form, { negative: info?.negative ?? false, outDir });
    if (!built.ok) {
      setProblem({ message: built.error });
      return;
    }
    // F8: guards the click itself, from here to the request settling, so a
    // double-click cannot fire two requests before the first one answers.
    setPending(true);
    try {
      setRunning(await client.generate(built.req));
    } catch (err: unknown) {
      fail(err);
    } finally {
      setPending(false);
    }
  }, [client, form, info, outDir, fail]);

  const cancel = useCallback(async () => {
    if (running === null) return;
    setPending(true);
    try {
      await client.cancel(running.id);
    } catch (err: unknown) {
      fail(err);   // most likely 409: it finished while the click was in flight
    } finally {
      setPending(false);
    }
  }, [client, running, fail]);

  const edit = (patch: Partial<GenerateForm>): void => setForm((f) => ({ ...f, ...patch }));

  // ─── render ────────────────────────────────────────────────

  if (!loaded) {
    return <div style={S.root}><div style={S.connecting}>Loading…</div></div>;
  }
  if (offline !== null) {
    return <div style={S.root}><Offline error={offline} url={daemonUrl} onRetry={() => void connect()} /></div>;
  }

  const busy = running !== null;
  // F10: never call a model missing before the catalog has actually loaded.
  const missing = catalog !== null && (option?.missing ?? false);
  const canRun = !busy && !missing && !pending && form.prompt.trim() !== '';

  return (
    <div style={S.root}>
      {problem !== null && <ErrorBar problem={problem} onDismiss={() => setProblem(null)} />}
      <div style={S.body}>
        <div style={S.column}>
          <textarea
            style={S.prompt}
            rows={3}
            placeholder="What to draw — ⌘↩ to generate"
            autoFocus
            value={form.prompt}
            onChange={(e) => edit({ prompt: e.target.value })}
            onKeyDown={(e) => {
              // F9: an IME composing an Enter (e.g. to commit kana/hanzi) must
              // not also submit the form.
              if (e.key === 'Enter' && e.metaKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (canRun) void run();
              }
            }}
          />
          {info?.negative === true && (
            <textarea
              style={S.negative}
              rows={2}
              placeholder="Negative prompt (optional)"
              value={form.negative}
              onChange={(e) => edit({ negative: e.target.value })}
            />
          )}
          <div style={S.row}>
            <label style={S.field}>
              <span style={S.label}>Model</span>
              <select style={S.select} value={form.model} onChange={(e) => edit({ model: e.target.value })}>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <NumberField label="Steps" value={form.steps} placeholder={hints.steps} onChange={(v) => edit({ steps: v })} />
            <NumberField label="Width" value={form.width} placeholder={hints.width} onChange={(v) => edit({ width: v })} />
            <NumberField label="Height" value={form.height} placeholder={hints.height} onChange={(v) => edit({ height: v })} />
            <label style={S.field}>
              <span style={S.label}>Seed</span>
              <span style={S.seed}>
                <input
                  style={{ ...S.input, width: 110 }}
                  inputMode="numeric"
                  placeholder="random"
                  value={form.seed}
                  onChange={(e) => {
                    // F1: typing a number locks it; clearing the field unlocks it.
                    const v = e.target.value;
                    edit({ seed: v, seedLocked: v.trim() !== '' });
                  }}
                />
                <button
                  type="button"
                  style={S.iconButton}
                  title="Roll a new seed and lock it"
                  onClick={() => edit({ seed: String(rollSeed()), seedLocked: true })}
                >
                  🎲
                </button>
                <button
                  type="button"
                  style={form.seedLocked ? { ...S.iconButton, ...S.on } : S.iconButton}
                  title={form.seedLocked ? 'Seed locked: every run reuses it' : 'Seed unlocked: every run picks a new one'}
                  onClick={() => setForm((f) => toggleLock(f))}
                >
                  {form.seedLocked ? '🔒' : '🔓'}
                </button>
              </span>
            </label>
          </div>
          {missing && (
            <p style={S.warn}>
              {shortModel(form.model)} isn't downloaded. Pull it with modelctl:{' '}
              <code style={S.inlineCode}>modelctl pull {form.model}</code>
            </p>
          )}
          <div style={S.actions}>
            {busy
              ? (
                <button
                  type="button"
                  style={pending ? { ...S.button, ...S.disabled } : S.button}
                  disabled={pending}
                  onClick={() => void cancel()}
                >
                  Cancel
                </button>
              )
              : (
                <button
                  type="button"
                  style={canRun ? S.primary : { ...S.primary, ...S.disabled }}
                  disabled={!canRun}
                  onClick={() => void run()}
                >
                  Generate
                </button>
              )}
            {running !== null && <span style={S.status}>{runStatus(running.percent)}</span>}
          </div>
          <Result entry={selected} />
        </div>
      </div>
      <Strip entries={visible} running={running} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
    </div>
  );
}

// ─── sub-views ───────────────────────────────────────────────

function NumberField({ label, value, placeholder, onChange }: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  return (
    <label style={S.field}>
      <span style={S.label}>{label}</span>
      <input
        style={{ ...S.input, width: 72 }}
        inputMode="numeric"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** The selected image, and always the path it was written to (criterion 5). */
function Result({ entry }: { entry: HistoryEntry | null }) {
  if (entry === null) {
    return <p style={S.muted}>Nothing generated yet. Write a prompt and press Generate.</p>;
  }
  return (
    <figure style={S.result}>
      <img
        style={S.preview}
        src={`data:image/jpeg;base64,${entry.thumb_b64}`}
        alt={entry.prompt ?? entry.instruction ?? entry.path}
      />
      <figcaption style={S.caption}>
        <div style={S.path} title={entry.path}>{entry.path}</div>
        <div style={S.mutedSmall}>{describeEntry(entry)}</div>
        {entry.prompt !== null && <div style={S.mutedSmall}>{entry.prompt}</div>}
      </figcaption>
    </figure>
  );
}

/** Persistent, newest first, with a placeholder tile while a job runs (PRD §4). */
function Strip({ entries, running, selectedId, onSelect }: {
  entries: HistoryEntry[];
  running: ImageJob | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (entries.length === 0 && running === null) return null;
  return (
    <div style={S.strip}>
      {running !== null && <div style={{ ...S.tile, ...S.pending }}>{runStatus(running.percent)}</div>}
      {entries.map((e) => (
        <Tile key={e.id} entry={e} selected={e.id === selectedId} onSelect={onSelect} />
      ))}
    </div>
  );
}

/**
 * F6: memoized so a prompt keystroke or a poll tick — which change other state
 * the strip's parent holds, not any entry — do not rebuild every tile's
 * `data:` URL, about 200 of them at the default history limit.
 */
const Tile = memo(function Tile({ entry, selected, onSelect }: {
  entry: HistoryEntry;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      title={entry.prompt ?? entry.path}
      style={selected ? { ...S.tile, ...S.selected } : S.tile}
      onClick={() => onSelect(entry.id)}
    >
      <img style={S.thumb} src={`data:image/jpeg;base64,${entry.thumb_b64}`} alt="" />
      <span style={S.tileLabel}>{shortModel(entry.model)}</span>
      <span style={S.tileLabel}>{entry.seed}</span>
    </button>
  );
});

function Offline({ error, url, onRetry }: { error: DaemonError; url: string; onRetry: () => void }) {
  return (
    <div style={S.centered}>
      <h2 style={S.h2}>{error.message}</h2>
      <p style={S.muted}>Image generation runs in modelctld. Start it with:</p>
      <pre style={S.code}>{START_COMMAND}</pre>
      <p style={S.mutedSmall}>Expecting it at {url}.</p>
      <button type="button" style={S.button} onClick={onRetry}>Retry</button>
    </div>
  );
}

function ErrorBar({ problem, onDismiss }: { problem: Problem; onDismiss: () => void }) {
  return (
    <div style={S.errorBar}>
      <div>
        <strong>{problem.message}</strong>
        {problem.hint !== undefined && <div style={S.mutedSmall}>{problem.hint}</div>}
      </div>
      <button type="button" style={S.linkButton} onClick={onDismiss}>dismiss</button>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    font: '13px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    background: 'var(--workspace-bg, #fff)',
    color: 'var(--chrome-fg, inherit)',
  },
  body: { flex: 1, overflow: 'auto', minHeight: 0 },
  column: { maxWidth: 820, margin: '0 auto', padding: '20px 20px 32px' },
  connecting: { padding: 24, color: 'var(--chrome-muted, #71717a)' },
  centered: { maxWidth: 520, margin: '12vh auto 0', padding: 24, textAlign: 'center' },
  h2: { fontSize: 15, fontWeight: 600, margin: '0 0 8px' },
  muted: { color: 'var(--chrome-muted, #71717a)', margin: '16px 0' },
  mutedSmall: { color: 'var(--chrome-muted, #71717a)', fontSize: 12, margin: 0 },
  warn: { color: 'var(--warn-fg, #d97706)', fontSize: 12, margin: '8px 0 0' },
  code: {
    textAlign: 'left',
    font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: '10px 12px',
    borderRadius: 6,
    background: 'var(--chrome-bg, #f4f4f5)',
    border: '1px solid var(--chrome-border, #d4d4d8)',
    overflowX: 'auto',
    whiteSpace: 'pre',
  },
  inlineCode: { font: '12px ui-monospace, SFMono-Regular, Menlo, monospace' },
  button: {
    font: 'inherit',
    padding: '4px 12px',
    borderRadius: 5,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
    cursor: 'pointer',
  },
  primary: {
    font: 'inherit',
    fontWeight: 500,
    padding: '5px 16px',
    borderRadius: 5,
    border: '1px solid #1d4ed8',
    background: '#2563eb',
    color: '#fff',
    cursor: 'pointer',
  },
  /** Inline styles have no :disabled; a disabled primary has to say so itself. */
  disabled: { opacity: 0.4, cursor: 'not-allowed' },
  linkButton: {
    font: 'inherit',
    fontSize: 12,
    padding: '2px 6px',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    opacity: 0.75,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  errorBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    padding: '8px 12px',
    background: 'var(--error-bg, #fef2f2)',
    color: 'var(--error-fg, #b91c1c)',
    borderBottom: '1px solid var(--chrome-border, #d4d4d8)',
  },
  prompt: {
    width: '100%',
    boxSizing: 'border-box',
    font: 'inherit',
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
    resize: 'vertical',
  },
  negative: {
    width: '100%',
    boxSizing: 'border-box',
    font: 'inherit',
    fontSize: 12,
    marginTop: 8,
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
    resize: 'vertical',
  },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12, marginTop: 12 },
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  label: { fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--chrome-muted, #71717a)' },
  select: {
    font: 'inherit',
    padding: '4px 6px',
    borderRadius: 5,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
    minWidth: 0,
    maxWidth: 280,
  },
  input: {
    font: 'inherit',
    padding: '4px 6px',
    borderRadius: 5,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
  },
  seed: { display: 'flex', alignItems: 'center', gap: 4 },
  iconButton: {
    font: 'inherit',
    padding: '3px 6px',
    borderRadius: 5,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    cursor: 'pointer',
  },
  on: { background: 'var(--chrome-bg, #f4f4f5)', borderColor: '#2563eb' },
  actions: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 },
  status: { color: 'var(--chrome-muted, #71717a)' },
  result: { margin: '20px 0 0', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 },
  preview: { maxWidth: '100%', width: 512, borderRadius: 6, border: '1px solid var(--chrome-border, #d4d4d8)' },
  caption: { display: 'flex', flexDirection: 'column', gap: 2, maxWidth: '100%' },
  path: {
    font: '12px ui-monospace, SFMono-Regular, Menlo, monospace',
    userSelect: 'text',
    wordBreak: 'break-all',
  },
  strip: {
    display: 'flex',
    gap: 8,
    padding: '8px 12px',
    overflowX: 'auto',
    borderTop: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--chrome-bg, #f4f4f5)',
    flexShrink: 0,
  },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    width: 88,
    flexShrink: 0,
    padding: 4,
    borderRadius: 6,
    border: '2px solid transparent',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
  },
  pending: {
    justifyContent: 'center',
    height: 112,
    boxSizing: 'border-box',
    fontSize: 11,
    textAlign: 'center',
    color: 'var(--chrome-muted, #71717a)',
    border: '2px dashed var(--chrome-border, #d4d4d8)',
    cursor: 'default',
  },
  selected: { borderColor: '#2563eb' },
  thumb: { width: 76, height: 76, objectFit: 'cover', borderRadius: 4 },
  tileLabel: {
    fontSize: 10,
    maxWidth: 80,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--chrome-muted, #71717a)',
  },
};

// ─── plugin ──────────────────────────────────────────────────

export const plugin: Plugin = {
  activate(ctx) {
    ctx.log.info('image-gen activating');
    ctx.registerPanel(PANEL_ID, definePanel(ImagesPanel));
    ctx.registerCommand('imagegen.open', () => ctx.workspace.openPanel(PANEL_ID));

    // Positional args in schema order: prompt, model, steps, seed (C5). The
    // command posts the job itself (spec decision 18), so it works with no
    // panel at all, which the S2 MCP server will rely on.
    ctx.registerCommand('imagegen.generate', async (...args: unknown[]) => {
      const [url, token, model, outDir] = await Promise.all([
        ctx.settings.get('daemonUrl'),
        ctx.settings.get('token'),
        ctx.settings.get('model'),
        ctx.settings.get('outputDir'),
      ]);
      const built = commandRequest(args, {
        model: typeof model === 'string' && model.trim() !== '' ? model.trim() : DEFAULT_GENERATE_MODEL,
        outDir: typeof outDir === 'string' ? outDir : '',
      });
      if (!built.ok) {
        // F3: the palette invokes a command with no args at all, so "needs a
        // prompt" is not a warning worth showing — it is just an empty form.
        // Open the panel (its textarea autofocuses) instead of failing.
        await ctx.workspace.openPanel(PANEL_ID);
        return;
      }
      const client = new ImageClient(
        ctx,
        typeof url === 'string' && url !== '' ? url : DEFAULT_DAEMON_URL,
        typeof token === 'string' ? token : '',
      );
      try {
        await client.generate(built.req);
      } catch (err: unknown) {
        const e = asDaemonError(err);
        await ctx.ui.notify(e.hint === undefined ? e.message : `${e.message} — ${e.hint}`, 'error');
        return;
      }
      await ctx.workspace.openPanel(PANEL_ID);
      jobStarted.notify();
    });
  },

  deactivate() {
    // Registrations are the host's to unwind (invariant 8). Module state is
    // ours: a panel subscription must not outlive this activation.
    jobStarted.clear();
  },
};
