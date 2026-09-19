import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PanelContext, Plugin } from '@workbench/plugin-sdk';
import { definePanel } from '@workbench/plugin-sdk/react';
import {
  DEFAULT_DAEMON_URL,
  DaemonError,
  START_COMMAND,
  VaultClient,
  asDaemonError,
  type EmbedJob,
  type Folder,
  type Hit,
  type SearchResult,
} from './client.js';
import { startPoller } from './poller.js';
import { excerpt, highlight, progressOf, wikilink } from './text.js';

const PANEL_ID = 'vault.main';
const DEFAULT_LIMIT = 8;
const DEFAULT_MODEL = 'sentence-transformers/LaBSE';
const DEFAULT_CHUNK_SIZE = 512;
/** After this long, "Searching…" becomes "Loading the model…" — the cold worker is the only slow case. */
const SLOW_MS = 1_500;

interface SearchRequest {
  query: string;
  limit: number;
}

/**
 * A command can fire before the panel has mounted — `openPanel` resolves when
 * the panel is asked for, not when React has rendered it. So a request is held
 * until someone is listening, rather than emitted into an empty room.
 */
function mailbox<T>() {
  let pending: T | undefined;
  let listener: ((v: T) => void) | undefined;
  return {
    get pending(): T | undefined { return pending; },
    /** On deactivate: a request nobody drained must not surface in the next activation. */
    clear(): void { pending = undefined; },
    send(v: T): void {
      if (listener !== undefined) listener(v);
      else pending = v;
    },
    receive(l: (v: T) => void): () => void {
      listener = l;
      if (pending !== undefined) {
        const v = pending;
        pending = undefined;
        l(v);
      }
      return () => { if (listener === l) listener = undefined; };
    },
  };
}

/** Exported for the disposal test only; the host reads nothing but `plugin`. */
export const requests = mailbox<SearchRequest>();

function clampLimit(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(50, Math.round(v))) : DEFAULT_LIMIT;
}

// ─── panel ───────────────────────────────────────────────────

function VaultPanel({ ctx }: { ctx: PanelContext }) {
  const [daemonUrl, setDaemonUrl] = useState(DEFAULT_DAEMON_URL);
  const [token, setToken] = useState('');
  const [embedModel, setEmbedModel] = useState(DEFAULT_MODEL);
  const [chunkSize, setChunkSize] = useState(DEFAULT_CHUNK_SIZE);
  const [query, setQuery] = useState('');
  // TRAP 1 (change log 6, 13): storage and settings are async. Nothing is
  // saved, and the daemon is not contacted, until both have been read.
  const [loaded, setLoaded] = useState(false);

  const [connected, setConnected] = useState(false);
  const [offline, setOffline] = useState<DaemonError | null>(null);
  const [error, setError] = useState<DaemonError | null>(null);
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [job, setJob] = useState<EmbedJob | null>(null);
  const [result, setResult] = useState<{ query: string; res: SearchResult } | null>(null);
  const [searching, setSearching] = useState(false);
  const [slow, setSlow] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const client = useMemo(() => new VaultClient(ctx.plugin, daemonUrl, token), [ctx, daemonUrl, token]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [u, t, m, c, last] = await Promise.all([
        ctx.plugin.settings.get('daemonUrl'),
        ctx.plugin.settings.get('token'),
        ctx.plugin.settings.get('embedModel'),
        ctx.plugin.settings.get('chunkSize'),
        ctx.plugin.storage.get('lastQuery'),
      ]);
      if (cancelled) return;
      if (typeof u === 'string' && u !== '') setDaemonUrl(u);
      if (typeof t === 'string') setToken(t);
      if (typeof m === 'string' && m !== '') setEmbedModel(m);
      if (typeof c === 'number' && c > 0) setChunkSize(c);
      if (typeof last === 'string') setQuery(last);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [ctx]);

  // TRAP 2 (change log 15): onChange returns a Disposable, not a cleanup function.
  useEffect(() => {
    const sub = ctx.plugin.settings.onChange((key, value) => {
      if (key === 'daemonUrl' && typeof value === 'string' && value !== '') setDaemonUrl(value);
      if (key === 'token' && typeof value === 'string') setToken(value);
      if (key === 'embedModel' && typeof value === 'string' && value !== '') setEmbedModel(value);
      if (key === 'chunkSize' && typeof value === 'number' && value > 0) setChunkSize(value);
    });
    return () => { void sub.dispose(); };
  }, [ctx]);

  const fail = useCallback((err: unknown) => {
    const e = asDaemonError(err);
    if (e.kind === 'offline') setOffline(e);
    else setError(e);
  }, []);

  const reloadFolders = useCallback(async () => {
    try {
      setFolders(await client.folders());
    } catch (err: unknown) {
      fail(err);
    }
  }, [client, fail]);

  const connect = useCallback(async () => {
    setOffline(null);
    try {
      await client.health();
      // C4: an index job outlives the panel that started it. Ask the daemon —
      // the only thing that knows — rather than trusting a remembered id.
      const [list, { jobs }] = await Promise.all([client.folders(), client.jobs()]);
      setFolders(list);
      const running = jobs.find((j) => j.kind === 'embed' && j.state === 'running');
      if (running !== undefined) setJob(running);
      setConnected(true);
    } catch (err: unknown) {
      setConnected(false);
      fail(err);
    }
  }, [client, fail]);

  useEffect(() => { if (loaded) void connect(); }, [loaded, connect]);

  // ─── indexing ──────────────────────────────────────────────

  const jobId = job?.state === 'running' ? job.id : null;
  useEffect(() => {
    if (jobId === null) return undefined;
    const poller = startPoller<EmbedJob>({
      fetch: () => client.job(jobId),
      onValue: (j) => {
        setJob(j);
        if (j.state === 'done') void reloadFolders();
        if (j.state === 'failed') setError(new DaemonError(j.error ?? 'Indexing failed.', undefined, 'api'));
      },
      // A failed poll (offline included) may be a restart in progress: keep polling.
      onError: () => undefined,
      next: (j) => (j.state === 'running' ? 1_000 : undefined),
    });
    return () => poller.stop();
  }, [client, jobId, reloadFolders]);

  /** `pickDirectory` is the consent gesture and the path chooser (C2); the daemon does the reading. */
  const chooseFolder = useCallback(async () => {
    setError(null);
    const path = await ctx.plugin.fs.pickDirectory();
    if (path === undefined) return;
    try {
      setJob(await client.addFolder({ path, model: embedModel, chunk_size: chunkSize }));
    } catch (err: unknown) {
      fail(err);
    }
  }, [ctx, client, embedModel, chunkSize, fail]);

  const cancel = useCallback(async (j: EmbedJob) => {
    try {
      await client.cancel(j.id);
    } catch (err: unknown) {
      fail(err);   // most likely 409: it finished while the click was in flight
    }
  }, [client, fail]);

  // ─── search ────────────────────────────────────────────────

  const searchSeq = useRef(0);
  const run = useCallback(async (q: string, limit = DEFAULT_LIMIT) => {
    const trimmed = q.trim();
    if (trimmed === '') return;
    const seq = ++searchSeq.current;
    setError(null);
    setSearching(true);
    setSlow(false);
    setExpanded(null);
    const slowTimer = setTimeout(() => { if (seq === searchSeq.current) setSlow(true); }, SLOW_MS);
    void ctx.plugin.storage.set('lastQuery', trimmed);
    try {
      const res = await client.search({ query: trimmed, limit });
      if (seq === searchSeq.current) setResult({ query: trimmed, res });
    } catch (err: unknown) {
      if (seq === searchSeq.current) fail(err);
    } finally {
      clearTimeout(slowTimer);
      if (seq === searchSeq.current) setSearching(false);
    }
  }, [ctx, client, fail]);

  // Commands, once the daemon is reachable. The handler lives in a ref so a
  // changed client does not drop a queued request.
  const onRequest = useRef<(req: SearchRequest) => void>(() => undefined);
  onRequest.current = (req) => {
    setQuery(req.query);
    void run(req.query, req.limit);
  };

  useEffect(() => {
    if (!connected) return undefined;
    return requests.receive((req) => onRequest.current(req));
  }, [connected]);

  const copyLink = useCallback(async (hit: Hit) => {
    try {
      await navigator.clipboard.writeText(wikilink(hit.rel_path));
      await ctx.plugin.ui.notify(`Copied ${wikilink(hit.rel_path)}`, 'info');
    } catch {
      await ctx.plugin.ui.notify('Could not write to the clipboard.', 'warn');
    }
  }, [ctx]);

  // ─── render ────────────────────────────────────────────────

  if (offline !== null) {
    return (
      <div style={S.root}>
        <Offline error={offline} url={daemonUrl} onRetry={() => void connect()} />
      </div>
    );
  }

  if (!connected || folders === null) {
    return <div style={S.root}><p style={S.connecting}>Connecting to {daemonUrl}…</p></div>;
  }

  const indexing = job !== null && job.state === 'running';

  return (
    <div style={S.root}>
      {error !== null && <ErrorBar error={error} onDismiss={() => setError(null)} />}
      <div style={S.body}>
        <div style={S.column}>
          {indexing && <Indexing job={job} onCancel={() => void cancel(job)} />}

          {!indexing && folders.length === 0 && (
            <div style={S.pickArea}>
              <p style={S.muted}>Nothing is indexed yet. The daemon reads the folder; notes never pass through the app.</p>
              <button type="button" style={S.primary} onClick={() => void chooseFolder()}>
                Choose a folder to index
              </button>
            </div>
          )}

          {folders.length > 0 && (
            <>
              <form
                style={S.searchRow}
                onSubmit={(e) => { e.preventDefault(); void run(query); }}
              >
                <input
                  style={S.input}
                  type="search"
                  autoFocus
                  placeholder="What are you looking for?"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button
                  type="submit"
                  style={{ ...S.primary, ...(query.trim() === '' || searching ? S.disabled : {}) }}
                  disabled={query.trim() === '' || searching}
                >
                  Search
                </button>
              </form>
              <p style={S.folderLine}>
                {folders.map((f) => `${f.name} · ${f.files} notes`).join('   ')}
              </p>

              {searching && <p style={S.muted}>{slow ? 'Loading the model…' : 'Searching…'}</p>}

              {!searching && result !== null && (
                <>
                  <p style={S.mutedSmall}>
                    {result.res.hits.length === 0
                      ? 'No notes matched.'
                      : `${result.res.hits.length} notes · ${result.res.took_ms} ms`}
                  </p>
                  <div style={S.cards}>
                    {result.res.hits.map((hit) => {
                      const key = `${hit.folder}/${hit.rel_path}`;
                      return (
                        <Card
                          key={key}
                          hit={hit}
                          query={result.query}
                          expanded={expanded === key}
                          onToggle={() => setExpanded((cur) => (cur === key ? null : key))}
                          onCopy={() => void copyLink(hit)}
                        />
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── sub-views ───────────────────────────────────────────────

function Offline({ error, url, onRetry }: { error: DaemonError; url: string; onRetry: () => void }) {
  return (
    <div style={S.centered}>
      <h2 style={S.h2}>{error.message}</h2>
      {error.kind === 'offline'
        ? (
          <>
            <p style={S.muted}>The vault index lives in modelctld. Start it with:</p>
            <pre style={S.code}>{START_COMMAND}</pre>
          </>
        )
        : <p style={S.muted}>{error.hint}</p>}
      <p style={S.mutedSmall}>Expecting it at {url}.</p>
      <button type="button" style={S.button} onClick={onRetry}>Retry</button>
    </div>
  );
}

function ErrorBar({ error, onDismiss }: { error: DaemonError; onDismiss: () => void }) {
  return (
    <div style={S.errorBar}>
      <div>
        <strong>{error.message}</strong>
        {error.hint !== undefined && <div style={S.mutedSmall}>{error.hint}</div>}
      </div>
      <button type="button" style={S.linkButton} onClick={onDismiss}>dismiss</button>
    </div>
  );
}

function Indexing({ job, onCancel }: { job: EmbedJob; onCancel: () => void }) {
  const progress = progressOf(job);
  const name = job.params.folders?.join(', ') ?? 'folder';
  const pct = progress === null || progress.total === 0 ? 0 : (100 * progress.done) / progress.total;
  return (
    <div style={S.indexing}>
      <div style={S.runningHead}>
        <span>
          Indexing <strong>{name}</strong>
          {progress === null ? ' — loading the model…' : ` — ${progress.done} / ${progress.total} files`}
        </span>
        <button type="button" style={S.button} onClick={onCancel}>Cancel</button>
      </div>
      <div style={S.track}><div style={{ ...S.bar, width: `${pct}%` }} /></div>
    </div>
  );
}

function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlight(text, query).map((span, i) => (span.hit
        ? <mark key={i} style={S.mark}>{span.text}</mark>
        : <span key={i}>{span.text}</span>))}
    </>
  );
}

function Card({ hit, query, expanded, onToggle, onCopy }: {
  hit: Hit;
  query: string;
  expanded: boolean;
  onToggle: () => void;
  onCopy: () => void;
}) {
  // The heading path starts with the title; show only what the title does not already say.
  const section = hit.heading.startsWith(`${hit.title} › `) ? hit.heading.slice(hit.title.length + 3) : '';
  return (
    <div
      style={S.hit}
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
    >
      <div style={S.hitHead}>
        <span style={S.hitTitle}>{hit.title}</span>
        <span style={S.tag}>{hit.folder}</span>
        <span style={S.score} title="cosine similarity">{hit.score.toFixed(2)}</span>
      </div>
      {section !== '' && <div style={S.section}>{section}</div>}
      <div style={expanded ? S.passageFull : S.passage}>
        <Marked text={expanded ? hit.chunk : excerpt(hit.chunk, query)} query={query} />
      </div>
      <div style={S.hitFoot}>
        <span style={S.path}>{hit.rel_path}{expanded ? `:${hit.start_line}` : ''}</span>
        <button
          type="button"
          style={S.linkButton}
          onClick={(e) => { e.stopPropagation(); onCopy(); }}
        >
          Copy link
        </button>
      </div>
    </div>
  );
}

// ─── styles ──────────────────────────────────────────────────

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
  column: { maxWidth: 760, margin: '0 auto', padding: '20px 20px 40px' },
  connecting: { padding: 24, color: 'var(--chrome-muted, #71717a)' },
  centered: { maxWidth: 520, margin: '12vh auto 0', padding: 24, textAlign: 'center' },
  h2: { fontSize: 15, fontWeight: 600, margin: '0 0 8px' },
  muted: { color: 'var(--chrome-muted, #71717a)', margin: '8px 0' },
  mutedSmall: { color: 'var(--chrome-muted, #71717a)', fontSize: 12, margin: '0 0 8px' },
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
  /** Inline styles have no :disabled — a disabled primary has to say so itself. */
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
  pickArea: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    padding: '28px 16px',
    borderRadius: 8,
    border: '1px dashed var(--chrome-border, #d4d4d8)',
    textAlign: 'center',
  },
  indexing: { marginBottom: 20 },
  runningHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 8 },
  track: { height: 6, borderRadius: 3, background: 'var(--chrome-border, #d4d4d8)', overflow: 'hidden' },
  bar: { height: '100%', background: '#2563eb', transition: 'width .4s ease' },
  searchRow: { display: 'flex', gap: 8 },
  input: {
    flex: 1,
    minWidth: 0,
    font: 'inherit',
    fontSize: 14,
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
  },
  folderLine: {
    margin: '6px 0 16px',
    fontSize: 12,
    color: 'var(--chrome-muted, #71717a)',
    whiteSpace: 'pre',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  cards: { display: 'flex', flexDirection: 'column', gap: 10 },
  hit: {
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--chrome-bg, #f4f4f5)',
    cursor: 'pointer',
    outlineOffset: 2,
  },
  hitHead: { display: 'flex', alignItems: 'baseline', gap: 8 },
  hitTitle: { fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tag: {
    flex: '0 0 auto',
    fontSize: 11,
    padding: '0 6px',
    borderRadius: 4,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    color: 'var(--chrome-muted, #71717a)',
  },
  score: {
    marginLeft: 'auto',
    flex: '0 0 auto',
    font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
    color: 'var(--chrome-muted, #71717a)',
  },
  section: { fontSize: 12, color: 'var(--chrome-muted, #71717a)', margin: '2px 0 0' },
  passage: { margin: '6px 0', whiteSpace: 'pre-wrap', userSelect: 'text' },
  passageFull: { margin: '6px 0', whiteSpace: 'pre-wrap', userSelect: 'text', cursor: 'text' },
  mark: { background: 'var(--highlight-bg, #fde68a)', color: 'inherit', borderRadius: 2, padding: '0 1px' },
  hitFoot: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  path: {
    fontSize: 11,
    color: 'var(--chrome-muted, #71717a)',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
};

// ─── plugin ──────────────────────────────────────────────────

export const plugin: Plugin = {
  activate(ctx) {
    ctx.log.info('vault-search activating');
    ctx.registerPanel(PANEL_ID, definePanel(VaultPanel));
    ctx.registerCommand('vault.open', () => ctx.workspace.openPanel(PANEL_ID));

    // Positional args in schema order: query, limit, answer (C5). `answer`
    // arrives with answer mode in M4; until then it is accepted and ignored.
    ctx.registerCommand('vault.search', async (...args: unknown[]) => {
      const query = typeof args[0] === 'string' ? args[0].trim() : '';
      await ctx.workspace.openPanel(PANEL_ID);
      if (query !== '') requests.send({ query, limit: clampLimit(args[1]) });
    });
  },

  deactivate() {
    // Registrations are the host's to unwind (invariant 8). Module state is
    // ours: a search no panel drained must not leak into the next activation.
    requests.clear();
  },
};
