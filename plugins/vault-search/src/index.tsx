import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Content, PanelContext, Plugin } from '@workbench/plugin-sdk';
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
import { MAX_PASSAGES, answerMarkdown, buildMessages, hitsMarkdown, parseAnswer, type AnswerPart } from './answer.js';
import { AnswerError, answerWith, type Answer, type AnswerSettings } from './llm.js';
import { startPoller } from './poller.js';
import { staleness, type Staleness, type Tone } from './staleness.js';
import { excerpt, highlight, progressOf, wikilink } from './text.js';

const PANEL_ID = 'vault.main';
const DEFAULT_LIMIT = 8;
const DEFAULT_MODEL = 'sentence-transformers/LaBSE';
const DEFAULT_CHUNK_SIZE = 512;
/** After this long, "Searching…" becomes "Loading the model…" — the cold worker is the only slow case. */
const SLOW_MS = 1_500;
/** A paragraph routed in over the bus becomes the query (use case 3); LaBSE reads ~256 tokens of it anyway. */
const MAX_ROUTED_CHARS = 2_000;
const DEFAULT_ANSWER: AnswerSettings = {
  answerUrl: 'http://localhost:1234/v1',
  answerModel: '',
  fallbackModel: 'mlx-community/Qwen3-0.6B-4bit',
};

/** What a command asks of the panel. Plain data: it crosses the mailbox, not a callback. */
type Request =
  | { kind: 'search'; query: string; limit: number; answer?: true; routed?: true }
  | { kind: 'reindex'; full: boolean };

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
    /** Whether a mounted panel is receiving — the bus handler claims content only then. */
    get listening(): boolean { return listener !== undefined; },
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
export const requests = mailbox<Request>();

function clampLimit(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(50, Math.round(v))) : DEFAULT_LIMIT;
}

// ─── panel ───────────────────────────────────────────────────

function VaultPanel({ ctx }: { ctx: PanelContext }) {
  const [daemonUrl, setDaemonUrl] = useState(DEFAULT_DAEMON_URL);
  const [token, setToken] = useState('');
  const [embedModel, setEmbedModel] = useState(DEFAULT_MODEL);
  const [chunkSize, setChunkSize] = useState(DEFAULT_CHUNK_SIZE);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [query, setQuery] = useState('');
  /** Folder names a search is limited to; empty means all. Names only (PRD §8). */
  const [scope, setScope] = useState<string[]>([]);
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
  const [showFolders, setShowFolders] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [answerMode, setAnswerMode] = useState(false);
  const [answerSettings, setAnswerSettings] = useState<AnswerSettings>(DEFAULT_ANSWER);
  const [answer, setAnswer] = useState<AnswerView>({ kind: 'idle' });
  const cardEls = useRef(new Map<number, HTMLDivElement>());

  const client = useMemo(() => new VaultClient(ctx.plugin, daemonUrl, token), [ctx, daemonUrl, token]);
  const settings = useMemo(() => ({ model: embedModel, chunkSize }), [embedModel, chunkSize]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [u, t, m, c, auto, last, savedScope, mode, aUrl, aModel, fModel] = await Promise.all([
        ctx.plugin.settings.get('daemonUrl'),
        ctx.plugin.settings.get('token'),
        ctx.plugin.settings.get('embedModel'),
        ctx.plugin.settings.get('chunkSize'),
        ctx.plugin.settings.get('autoRefresh'),
        ctx.plugin.storage.get('lastQuery'),
        ctx.plugin.storage.get('scope'),
        ctx.plugin.storage.get('answerMode'),
        ctx.plugin.settings.get('answerUrl'),
        ctx.plugin.settings.get('answerModel'),
        ctx.plugin.settings.get('fallbackModel'),
      ]);
      if (cancelled) return;
      if (typeof u === 'string' && u !== '') setDaemonUrl(u);
      if (typeof t === 'string') setToken(t);
      if (typeof m === 'string' && m !== '') setEmbedModel(m);
      if (typeof c === 'number' && c > 0) setChunkSize(c);
      if (typeof auto === 'boolean') setAutoRefresh(auto);
      if (typeof last === 'string') setQuery(last);
      if (Array.isArray(savedScope)) setScope(savedScope.filter((x): x is string => typeof x === 'string'));
      if (typeof mode === 'boolean') setAnswerMode(mode);
      setAnswerSettings({
        answerUrl: typeof aUrl === 'string' && aUrl !== '' ? aUrl : DEFAULT_ANSWER.answerUrl,
        answerModel: typeof aModel === 'string' ? aModel : DEFAULT_ANSWER.answerModel,
        fallbackModel: typeof fModel === 'string' && fModel !== '' ? fModel : DEFAULT_ANSWER.fallbackModel,
      });
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
      if (key === 'autoRefresh' && typeof value === 'boolean') setAutoRefresh(value);
      if (key === 'answerUrl' && typeof value === 'string' && value !== '') setAnswerSettings((a) => ({ ...a, answerUrl: value }));
      if (key === 'answerModel' && typeof value === 'string') setAnswerSettings((a) => ({ ...a, answerModel: value }));
      if (key === 'fallbackModel' && typeof value === 'string' && value !== '') setAnswerSettings((a) => ({ ...a, fallbackModel: value }));
    });
    return () => { void sub.dispose(); };
  }, [ctx]);

  useEffect(() => {
    if (loaded) void ctx.plugin.storage.set('scope', scope);
  }, [ctx, loaded, scope]);

  useEffect(() => {
    if (loaded) void ctx.plugin.storage.set('answerMode', answerMode);
  }, [ctx, loaded, answerMode]);

  const fail = useCallback((err: unknown) => {
    const e = asDaemonError(err);
    if (e.kind === 'offline') setOffline(e);
    else setError(e);
  }, []);

  /** A folder removed elsewhere must not linger in the scope, or every search would 404. */
  const applyFolders = useCallback((list: Folder[]) => {
    setFolders(list);
    setScope((cur) => {
      const kept = cur.filter((n) => list.some((f) => f.name === n));
      return kept.length === cur.length ? cur : kept;
    });
  }, []);

  const reloadFolders = useCallback(async () => {
    try {
      applyFolders(await client.folders());
    } catch (err: unknown) {
      fail(err);
    }
  }, [client, applyFolders, fail]);

  const connect = useCallback(async () => {
    setOffline(null);
    try {
      await client.health();
      // C4: an index job outlives the panel that started it. Ask the daemon —
      // the only thing that knows — rather than trusting a remembered id.
      const [list, { jobs }] = await Promise.all([client.folders(), client.jobs()]);
      applyFolders(list);
      const running = jobs.find((j) => j.kind === 'embed' && j.state === 'running');
      if (running !== undefined) setJob(running);
      setConnected(true);
    } catch (err: unknown) {
      setConnected(false);
      fail(err);
    }
  }, [client, applyFolders, fail]);

  useEffect(() => { if (loaded) void connect(); }, [loaded, connect]);

  // ─── indexing ──────────────────────────────────────────────

  /**
   * Folders still to refresh after the running job. One job at a time: every
   * folder may use a different model, and the daemon's one-job-per-model rule
   * would 409 a second job on the same one anyway.
   */
  const queue = useRef<Array<{ name: string; full: boolean }>>([]);

  const startRefresh = useCallback(async (name: string, full: boolean): Promise<void> => {
    setError(null);
    try {
      // Without `full` the daemon uses the folder's own settings, so this never
      // changes a model behind the user's back; with it, the new settings apply.
      setJob(await client.refresh(full ? { name, full, model: embedModel, chunk_size: chunkSize } : { name }));
    } catch (err: unknown) {
      queue.current = [];
      fail(err);
    }
  }, [client, embedModel, chunkSize, fail]);

  const refreshMany = useCallback((items: Array<{ name: string; full: boolean }>) => {
    const [first, ...rest] = items;
    if (first === undefined) return;
    queue.current = rest;
    void startRefresh(first.name, first.full);
  }, [startRefresh]);

  /** Changed folders whose settings still match — the ones a plain refresh can fix. */
  const staleNames = useCallback((list: Folder[]): string[] => list
    .filter((f) => { const s = staleness(f, Date.now() / 1000, settings); return s.tone === 'stale'; })
    .map((f) => f.name), [settings]);

  const onJobEnd = useRef<(j: EmbedJob) => void>(() => undefined);
  onJobEnd.current = (j) => {
    void reloadFolders();
    if (j.state === 'failed') {
      queue.current = [];
      setError(new DaemonError(j.error ?? 'Indexing failed.', undefined, 'api'));
      return;
    }
    if (j.state === 'cancelled') {
      queue.current = [];
      return;
    }
    refreshMany(queue.current);
  };

  const jobId = job?.state === 'running' ? job.id : null;
  useEffect(() => {
    if (jobId === null) return undefined;
    const poller = startPoller<EmbedJob>({
      fetch: () => client.job(jobId),
      onValue: (j) => {
        setJob(j);
        if (j.state !== 'running') onJobEnd.current(j);
      },
      // A failed poll (offline included) may be a restart in progress: keep polling.
      onError: () => undefined,
      next: (j) => (j.state === 'running' ? 1_000 : undefined),
    });
    return () => poller.stop();
  }, [client, jobId]);

  // autoRefresh: once per mount, only when nothing is already running, and
  // never for a folder whose settings changed — that one waits for a click.
  const autoDone = useRef(false);
  useEffect(() => {
    if (!connected || folders === null || autoDone.current) return;
    autoDone.current = true;
    if (!autoRefresh || job?.state === 'running') return;
    refreshMany(staleNames(folders).map((name) => ({ name, full: false })));
  }, [connected, folders, autoRefresh, job, refreshMany, staleNames]);

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
    queue.current = [];
    try {
      await client.cancel(j.id);
    } catch (err: unknown) {
      fail(err);   // most likely 409: it finished while the click was in flight
    }
  }, [client, fail]);

  const remove = useCallback(async (name: string) => {
    setError(null);
    try {
      await client.removeFolder(name);
      setResult(null);
      await reloadFolders();
    } catch (err: unknown) {
      fail(err);
    }
  }, [client, reloadFolders, fail]);

  const confirmed = useCallback((c: Confirm) => {
    setConfirm(null);
    if (c.kind === 'remove') void remove(c.name);
    else if (c.name === null) refreshMany((folders ?? []).map((f) => ({ name: f.name, full: true })));
    else refreshMany([{ name: c.name, full: true }]);
  }, [remove, refreshMany, folders]);

  const reindex = useCallback((full: boolean) => {
    if (folders === null || folders.length === 0) return;
    if (full) {
      setShowFolders(true);
      setConfirm({ kind: 'full', name: null });
      return;
    }
    const names = staleNames(folders);
    if (names.length === 0) void ctx.plugin.ui.notify('Every folder is up to date.', 'info');
    else refreshMany(names.map((name) => ({ name, full: false })));
  }, [ctx, folders, staleNames, refreshMany]);

  // ─── search ────────────────────────────────────────────────

  const searchSeq = useRef(0);

  /** PRD §4 answer mode: the top passages to a local LLM, the answer above the cards. */
  const ask = useCallback(async (seq: number, q: string, hits: Hit[]) => {
    const isCurrent = () => seq === searchSeq.current;
    setAnswer({ kind: 'working', stage: 'Preparing…' });
    try {
      const got = await answerWith(ctx.plugin, client, answerSettings, buildMessages(q, hits),
        (stage) => { if (isCurrent()) setAnswer({ kind: 'working', stage }); }, isCurrent);
      if (got !== null && isCurrent()) {
        setAnswer({ kind: 'done', answer: got, parts: parseAnswer(got.text, Math.min(hits.length, MAX_PASSAGES)) });
      }
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const e = err instanceof AnswerError ? err : new AnswerError(String(err));
      setAnswer({ kind: 'error', message: e.message, ...(e.hint === undefined ? {} : { hint: e.hint }) });
    }
  }, [ctx, client, answerSettings]);

  /** `remember: false` for text routed in: it may be another note's content, and storage never holds that (PRD §11.6). */
  const run = useCallback(async (q: string, limit = DEFAULT_LIMIT, withAnswer = answerMode, remember = true) => {
    const trimmed = q.trim();
    if (trimmed === '') return;
    const seq = ++searchSeq.current;
    setError(null);
    setSearching(true);
    setSlow(false);
    setExpanded(null);
    setAnswer({ kind: 'idle' });
    const slowTimer = setTimeout(() => { if (seq === searchSeq.current) setSlow(true); }, SLOW_MS);
    if (remember) void ctx.plugin.storage.set('lastQuery', trimmed);
    try {
      const res = await client.search({ query: trimmed, limit, ...(scope.length > 0 ? { folders: scope } : {}) });
      if (seq !== searchSeq.current) return;
      setResult({ query: trimmed, res });
      clearTimeout(slowTimer);
      setSearching(false);
      // Retrieval shows first; the answer arrives above it when it is ready.
      if (withAnswer && res.hits.length > 0) void ask(seq, trimmed, res.hits);
    } catch (err: unknown) {
      if (seq === searchSeq.current) fail(err);
    } finally {
      clearTimeout(slowTimer);
      if (seq === searchSeq.current) setSearching(false);
    }
  }, [ctx, client, scope, fail, answerMode, ask]);

  // Commands, once the daemon is reachable and the folders are known. The
  // handler lives in a ref so a changed client does not drop a queued request.
  const onRequest = useRef<(req: Request) => void>(() => undefined);
  onRequest.current = (req) => {
    if (req.kind === 'reindex') {
      reindex(req.full);
      return;
    }
    setQuery(req.query);
    if (req.answer === true) setAnswerMode(true);
    void run(req.query, req.limit, req.answer === true || answerMode, req.routed !== true);
  };

  const ready = connected && folders !== null;
  useEffect(() => {
    if (!ready) return undefined;
    return requests.receive((req) => onRequest.current(req));
  }, [ready]);

  // Content routed here (use case 3: a paragraph from another panel) arrives
  // as ctx.payload when the bus handler declined it — no panel was listening.
  const payloadHandled = useRef(false);
  useEffect(() => {
    if (!ready || payloadHandled.current || ctx.payload === undefined) return;
    payloadHandled.current = true;
    const data = (ctx.payload as Content).data;
    if (typeof data === 'string' && data.trim() !== '') {
      const q = data.trim().slice(0, MAX_ROUTED_CHARS);
      setQuery(q);
      void run(q, DEFAULT_LIMIT, answerMode, false);
    }
  }, [ctx, ready, run, answerMode]);

  const send = useCallback(async () => {
    if (result === null) return;
    const md = answer.kind === 'done'
      ? answerMarkdown(result.query, answer.answer.text, result.res.hits)
      : hitsMarkdown(result.query, result.res.hits);
    await ctx.plugin.bus.emit({ type: 'text/markdown', data: md, meta: { filename: 'vault-search.md', query: result.query } });
  }, [ctx, result, answer]);

  const showCite = useCallback((n: number) => {
    const hit = result?.res.hits[n - 1];
    if (hit === undefined) return;
    setExpanded(`${hit.folder}/${hit.rel_path}`);
    cardEls.current.get(n)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [result]);

  const copyLink = useCallback(async (hit: Hit) => {
    try {
      await navigator.clipboard.writeText(wikilink(hit.rel_path));
      await ctx.plugin.ui.notify(`Copied ${wikilink(hit.rel_path)}`, 'info');
    } catch {
      await ctx.plugin.ui.notify('Could not write to the clipboard.', 'warn');
    }
  }, [ctx]);

  const toggleScope = useCallback((name: string) => {
    setScope((cur) => (cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]));
  }, []);

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
  const now = Date.now() / 1000;
  const states = folders.map((f) => ({ folder: f, st: staleness(f, now, settings) }));
  const attention = states.filter((s) => s.st.tone !== 'ok').length;
  const foldersOpen = showFolders || (result === null && !searching) || confirm !== null;

  return (
    <div style={S.root}>
      {error !== null && <ErrorBar error={error} onDismiss={() => setError(null)} />}
      <div style={S.body}>
        <div style={S.column}>
          {indexing && <Indexing job={job} queued={queue.current.length} onCancel={() => void cancel(job)} />}

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
                <label style={S.toggle} title="Send the top passages to a local model and answer above the results">
                  <input type="checkbox" checked={answerMode} onChange={(e) => setAnswerMode(e.target.checked)} />
                  Answer
                </label>
                <button
                  type="submit"
                  style={{ ...S.primary, ...(query.trim() === '' || searching ? S.disabled : {}) }}
                  disabled={query.trim() === '' || searching}
                >
                  Search
                </button>
              </form>

              <div style={S.scopeRow}>
                {folders.length > 1 && folders.map((f) => (
                  <button
                    key={f.name}
                    type="button"
                    style={{ ...S.chip, ...(scope.includes(f.name) ? S.chipOn : {}) }}
                    aria-pressed={scope.includes(f.name)}
                    title={scope.length === 0 ? 'Searching every folder — click to search only this one' : undefined}
                    onClick={() => toggleScope(f.name)}
                  >
                    {f.name}
                  </button>
                ))}
                {folders.length === 1 && <span>{folders[0]?.name} · {folders[0]?.files} notes</span>}
                <button type="button" style={S.linkButton} onClick={() => setShowFolders((v) => !v)}>
                  {foldersOpen ? 'Hide folders' : `Folders${attention > 0 ? ` (${attention})` : ''}`}
                </button>
              </div>

              {foldersOpen && (
                <div style={S.folders}>
                  {states.map(({ folder, st }) => (
                    <FolderRow
                      key={folder.name}
                      folder={folder}
                      st={st}
                      busy={indexing}
                      confirm={confirm}
                      onRefresh={() => (st.needsFull
                        ? setConfirm({ kind: 'full', name: folder.name })
                        : refreshMany([{ name: folder.name, full: false }]))}
                      onRemove={() => setConfirm({ kind: 'remove', name: folder.name })}
                      onConfirm={confirmed}
                      onCancel={() => setConfirm(null)}
                    />
                  ))}
                  {confirm?.kind === 'full' && confirm.name === null && (
                    <ConfirmBar
                      text={`Re-embed all ${folders.reduce((n, f) => n + f.files, 0)} notes in every folder? This takes a while.`}
                      action="Re-index all"
                      onConfirm={() => confirmed(confirm)}
                      onCancel={() => setConfirm(null)}
                    />
                  )}
                  <div style={S.folderActions}>
                    <button type="button" style={S.button} disabled={indexing} onClick={() => void chooseFolder()}>
                      Add folder
                    </button>
                    {staleNames(folders).length > 1 && (
                      <button type="button" style={S.button} disabled={indexing} onClick={() => reindex(false)}>
                        Refresh all changed
                      </button>
                    )}
                  </div>
                </div>
              )}

              {searching && <p style={S.muted}>{slow ? 'Loading the model…' : 'Searching…'}</p>}

              {!searching && result !== null && (
                <>
                  <AnswerBox view={answer} onCite={showCite} />
                  <div style={S.resultsHead}>
                    <span style={S.mutedSmallInline}>
                      {result.res.hits.length === 0
                        ? 'No notes matched.'
                        : `${result.res.hits.length} notes · ${result.res.took_ms} ms`}
                    </span>
                    {result.res.hits.length > 0 && (
                      <button type="button" style={S.linkButton} onClick={() => void send()}
                        title="Send as markdown to a plugin that accepts it">
                        Send
                      </button>
                    )}
                  </div>
                  <div style={S.cards}>
                    {result.res.hits.map((hit, i) => {
                      const key = `${hit.folder}/${hit.rel_path}`;
                      return (
                        <Card
                          key={key}
                          n={i + 1}
                          cardRef={(el) => { if (el === null) cardEls.current.delete(i + 1); else cardEls.current.set(i + 1, el); }}
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

/** A pending destructive or slow action. `name: null` means every folder. */
type Confirm = { kind: 'full'; name: string | null } | { kind: 'remove'; name: string };

function FolderRow({ folder, st, busy, confirm, onRefresh, onRemove, onConfirm, onCancel }: {
  folder: Folder;
  st: Staleness;
  busy: boolean;
  confirm: Confirm | null;
  onRefresh: () => void;
  onRemove: () => void;
  onConfirm: (c: Confirm) => void;
  onCancel: () => void;
}) {
  const mine = confirm !== null && confirm.name === folder.name ? confirm : null;
  return (
    <div style={S.folderRow}>
      <div style={S.folderHead}>
        <span style={S.folderName} title={folder.path}>{folder.name}</span>
        <span style={S.mutedSmallInline}>{folder.files} notes</span>
        <span style={{ ...S.stale, ...TONE[st.tone] }}>{st.text}</span>
        <span style={S.folderButtons}>
          <button type="button" style={S.linkButton} disabled={busy || folder.changed === null} onClick={onRefresh}>
            {st.needsFull ? 'Re-index' : 'Refresh'}
          </button>
          <button type="button" style={S.linkButton} disabled={busy} onClick={onRemove}>Remove</button>
        </span>
      </div>
      {mine?.kind === 'full' && (
        <ConfirmBar
          text={`Re-embed all ${folder.files} notes in ${folder.name} with the new settings? This takes a while.`}
          action="Re-index"
          onConfirm={() => onConfirm(mine)}
          onCancel={onCancel}
        />
      )}
      {mine?.kind === 'remove' && (
        <ConfirmBar
          text={`Remove ${folder.name} from the index? The notes themselves are not touched.`}
          action="Remove"
          onConfirm={() => onConfirm(mine)}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}

function ConfirmBar({ text, action, onConfirm, onCancel }: {
  text: string;
  action: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={S.confirm}>
      <span>{text}</span>
      <span style={S.folderButtons}>
        <button type="button" style={S.primary} onClick={onConfirm}>{action}</button>
        <button type="button" style={S.button} onClick={onCancel}>Cancel</button>
      </span>
    </div>
  );
}


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

function Indexing({ job, queued, onCancel }: { job: EmbedJob; queued: number; onCancel: () => void }) {
  const progress = progressOf(job);
  const name = job.params.folders?.join(', ') ?? 'folder';
  const pct = progress === null || progress.total === 0 ? 0 : (100 * progress.done) / progress.total;
  return (
    <div style={S.indexing}>
      <div style={S.runningHead}>
        <span>
          Indexing <strong>{name}</strong>
          {progress === null ? ' — loading the model…' : ` — ${progress.done} / ${progress.total} files`}
          {queued > 0 && <span style={S.mutedSmallInline}>{`  · ${queued} more after this`}</span>}
        </span>
        <button type="button" style={S.button} onClick={onCancel}>Cancel</button>
      </div>
      <div style={S.track}><div style={{ ...S.bar, width: `${pct}%` }} /></div>
    </div>
  );
}

type AnswerView =
  | { kind: 'idle' }
  | { kind: 'working'; stage: string }
  | { kind: 'done'; answer: Answer; parts: AnswerPart[] }
  | { kind: 'error'; message: string; hint?: string };

function AnswerBox({ view, onCite }: { view: AnswerView; onCite: (n: number) => void }) {
  if (view.kind === 'idle') return null;
  if (view.kind === 'working') return <div style={S.answer}><span style={S.mutedSmallInline}>{view.stage}</span></div>;
  if (view.kind === 'error') {
    return (
      <div style={S.answer}>
        <span style={S.answerError}>No answer: {view.message}</span>
        {view.hint !== undefined && <div style={S.mutedSmall}>{view.hint}</div>}
      </div>
    );
  }
  const { answer, parts } = view;
  const cited = parts.some((p) => 'cite' in p);
  return (
    <div style={S.answer}>
      <div style={S.answerText}>
        {parts.map((p, i) => ('cite' in p
          ? <button key={i} type="button" style={S.cite} onClick={() => onCite(p.cite)}>{p.cite}</button>
          : <span key={i}>{p.text}</span>))}
      </div>
      <div style={S.answerFoot}>
        {!cited && <span style={S.answerWarn}>No sources cited — treat with care. </span>}
        via {answer.backend === 'lmstudio' ? 'LM Studio' : 'modelctld'} · {answer.model}
      </div>
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

function Card({ n, cardRef, hit, query, expanded, onToggle, onCopy }: {
  n: number;
  cardRef: (el: HTMLDivElement | null) => void;
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
      ref={cardRef}
      style={S.hit}
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
    >
      <div style={S.hitHead}>
        <span style={S.num}>{n}</span>
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
  toggle: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, whiteSpace: 'nowrap', cursor: 'pointer' },
  answer: {
    padding: '10px 12px',
    marginBottom: 12,
    borderRadius: 8,
    border: '1px solid #93c5fd',
    background: 'var(--answer-bg, rgba(37, 99, 235, 0.06))',
  },
  answerText: { whiteSpace: 'pre-wrap', userSelect: 'text', lineHeight: 1.6 },
  answerFoot: { marginTop: 6, fontSize: 11, color: 'var(--chrome-muted, #71717a)' },
  answerWarn: { color: 'var(--warn-fg, #d97706)' },
  answerError: { color: 'var(--error-fg, #b91c1c)' },
  cite: {
    font: '10px ui-monospace, SFMono-Regular, Menlo, monospace',
    verticalAlign: 'super',
    padding: '0 4px',
    margin: '0 1px',
    borderRadius: 3,
    border: '1px solid #93c5fd',
    background: 'transparent',
    color: '#2563eb',
    cursor: 'pointer',
  },
  num: {
    flex: '0 0 auto',
    font: '10px ui-monospace, SFMono-Regular, Menlo, monospace',
    minWidth: 16,
    textAlign: 'center',
    padding: '0 3px',
    borderRadius: 3,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    color: 'var(--chrome-muted, #71717a)',
  },
  resultsHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 0 8px' },
  scopeRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    margin: '8px 0 12px',
    fontSize: 12,
    color: 'var(--chrome-muted, #71717a)',
  },
  chip: {
    font: 'inherit',
    fontSize: 12,
    padding: '1px 10px',
    borderRadius: 999,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  chipOn: { background: '#2563eb', borderColor: '#1d4ed8', color: '#fff' },
  folders: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '10px 12px',
    marginBottom: 16,
    borderRadius: 8,
    border: '1px solid var(--chrome-border, #d4d4d8)',
  },
  folderRow: { display: 'flex', flexDirection: 'column', gap: 6 },
  folderHead: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 },
  folderName: { fontWeight: 600, whiteSpace: 'nowrap' },
  mutedSmallInline: { color: 'var(--chrome-muted, #71717a)', fontSize: 12, whiteSpace: 'nowrap' },
  stale: { fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  folderButtons: { marginLeft: 'auto', display: 'flex', gap: 4, flex: '0 0 auto' },
  folderActions: { display: 'flex', gap: 8, marginTop: 4 },
  confirm: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '8px 10px',
    borderRadius: 6,
    background: 'var(--chrome-bg, #f4f4f5)',
    fontSize: 12,
  },
  path: {
    fontSize: 11,
    color: 'var(--chrome-muted, #71717a)',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
};

const TONE: Record<Tone, React.CSSProperties> = {
  ok: { color: 'var(--chrome-muted, #71717a)' },
  stale: { color: 'var(--warn-fg, #d97706)' },
  warn: { color: 'var(--error-fg, #dc2626)' },
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
      if (query !== '') {
        requests.send({ kind: 'search', query, limit: clampLimit(args[1]), ...(args[2] === true ? { answer: true } : {}) });
      }
    });

    // Positional: full. Changed files only unless asked; a full re-index is confirmed in the panel.
    ctx.registerCommand('vault.reindex', async (...args: unknown[]) => {
      await ctx.workspace.openPanel(PANEL_ID);
      requests.send({ kind: 'reindex', full: args[0] === true });
    });

    // Use case 3: a paragraph from another panel → the notes it should cite.
    ctx.bus.onReceive((content) => {
      if (typeof content.data !== 'string' || content.data.trim() === '') return undefined;
      // The shell mounts one panel at a time, so while the sender's panel is
      // showing nobody listens here. Claiming the content then would drop it:
      // `handled` stops the host before it opens this panel (change log 36).
      if (!requests.listening) return undefined;
      requests.send({ kind: 'search', query: content.data.trim().slice(0, MAX_ROUTED_CHARS), limit: DEFAULT_LIMIT, routed: true });
      return { handled: true };
    });
  },

  deactivate() {
    // Registrations are the host's to unwind (invariant 8). Module state is
    // ours: a search no panel drained must not leak into the next activation.
    requests.clear();
  },
};
