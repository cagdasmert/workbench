import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PanelContext, Plugin, PluginContext } from '@workbench/plugin-sdk';
import { definePanel } from '@workbench/plugin-sdk/react';
import {
  CatalogClient,
  CatalogError,
  DEFAULT_DAEMON_URL,
  START_HINT,
  TASKS,
  fitColor,
  type Doctor,
  type Health,
  type Inventory,
  type Job,
  type LocalModel,
  type SearchHit,
  type SearchResult,
} from './client.js';

const STORAGE_KEY = 'session';
type Tab = 'installed' | 'search' | 'drives';

/**
 * A type alias, not an interface, and that is load-bearing: `storage.get<T>`
 * constrains T to `JsonValue`, and TypeScript grants an implicit index
 * signature to object type aliases but never to interfaces. Declaring this as
 * an interface fails the constraint even though the shape is plainly JSON.
 */
type Session = {
  tab: Tab;
  query: string;
  task: string;
};

const EMPTY_SESSION: Session = { tab: 'installed', query: '', task: '' };

type SearchRequest = { query: string; task: string };
type PullRequest = { repo: string; to: string };

/**
 * Bridges a command invocation to whichever panel instance is mounted. A
 * command can fire before the panel has mounted — `openPanel` resolves when
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
export const searchRequests = mailbox<SearchRequest>();
export const pullRequests = mailbox<PullRequest>();

// ─── panel ───────────────────────────────────────────────────

function ModelManagerPanel({ ctx }: { ctx: PanelContext }) {
  const [daemonUrl, setDaemonUrl] = useState(DEFAULT_DAEMON_URL);
  const [token, setToken] = useState('');
  const [fetchSizes, setFetchSizes] = useState(false);

  const [session, setSession] = useState<Session>(EMPTY_SESSION);
  // TRAP 1 (change log 6, 13): storage is async. Without this flag the debounced
  // save below fires with the initial value before the restore resolves, and
  // wipes the saved session on every mount.
  const [restored, setRestored] = useState(false);

  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<CatalogError | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [results, setResults] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<CatalogError | null>(null);
  const [confirming, setConfirming] = useState<LocalModel | null>(null);

  const client = useMemo(
    () => new CatalogClient(ctx.plugin, daemonUrl, token),
    [ctx, daemonUrl, token],
  );

  // Settings are read here and written only by the shell's settings sheet —
  // one writer, so onChange can be trusted.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [u, t, s] = await Promise.all([
        ctx.plugin.settings.get('daemonUrl'),
        ctx.plugin.settings.get('token'),
        ctx.plugin.settings.get('fetchSizes'),
      ]);
      if (cancelled) return;
      if (typeof u === 'string' && u !== '') setDaemonUrl(u);
      if (typeof t === 'string') setToken(t);
      if (typeof s === 'boolean') setFetchSizes(s);
    })();
    return () => { cancelled = true; };
  }, [ctx]);

  // TRAP 2 (change log 15): onChange returns a Disposable, not the plain
  // cleanup function useEffect wants.
  useEffect(() => {
    const sub = ctx.plugin.settings.onChange((key, value) => {
      if (key === 'daemonUrl' && typeof value === 'string' && value !== '') setDaemonUrl(value);
      if (key === 'token' && typeof value === 'string') setToken(value);
      if (key === 'fetchSizes' && typeof value === 'boolean') setFetchSizes(value);
    });
    return () => { void sub.dispose(); };
  }, [ctx]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await ctx.plugin.storage.get<Session>(STORAGE_KEY);
      if (cancelled) return;
      if (saved !== undefined && typeof saved === 'object') {
        setSession({ ...EMPTY_SESSION, ...saved });
      }
      setRestored(true);
    })();
    return () => { cancelled = true; };
  }, [ctx]);

  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => {
      void ctx.plugin.storage.set(STORAGE_KEY, { ...session });
    }, 400);
    return () => clearTimeout(timer);
  }, [ctx, session, restored]);

  // ─── loading ───────────────────────────────────────────────

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const h = await client.health();
      setHealth(h);
      setHealthError(null);
      if (!h.configured) return;
      const [inv, doc] = await Promise.all([client.inventory(), client.doctor()]);
      setInventory(inv);
      setDoctor(doc);
    } catch (err: unknown) {
      const e = err instanceof CatalogError ? err : new CatalogError(String(err));
      setHealth(null);
      setHealthError(e);
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  // One poll loop for every job, not one per job started here — that is what
  // makes a pull kicked off from the command palette (or before this panel was
  // opened) show up in the strip below.
  const running = jobs.some((j) => j.state === 'running');
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (healthError !== null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sawRunning = running;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const { jobs: next } = await client.jobs();
        if (stopped) return;
        const nowRunning = next.some((j) => j.state === 'running');
        // A job that just finished changed the catalog on disk.
        if (sawRunning && !nowRunning) void refreshRef.current();
        sawRunning = nowRunning;
        setJobs(next);
        timer = setTimeout(() => void tick(), nowRunning ? 1_000 : 8_000);
      } catch {
        // A dropped poll is not a failed job; the daemon may be restarting.
        if (!stopped) timer = setTimeout(() => void tick(), 8_000);
      }
    };

    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `running` is
    // deliberately out of the deps: the loop reschedules itself at the right
    // cadence, and re-running this effect would restart it on every tick.
  }, [client, healthError]);

  // ─── actions ───────────────────────────────────────────────

  const runSearch = useCallback(async (query: string, task: string) => {
    if (query.trim() === '') return;
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      setResults(await client.search({ query, task, sizes: fetchSizes }));
    } catch (err: unknown) {
      setError(err instanceof CatalogError ? err : new CatalogError(String(err)));
    } finally {
      setSearching(false);
    }
  }, [client, fetchSizes]);

  const act = useCallback(async (fn: () => Promise<Job>) => {
    setError(null);
    try {
      const job = await fn();
      setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
    } catch (err: unknown) {
      setError(err instanceof CatalogError ? err : new CatalogError(String(err)));
    }
  }, []);

  // A mailbox holds one listener and hands over anything already waiting the
  // moment it subscribes, so these subscribe once at mount. The handlers live
  // in refs: re-subscribing whenever a callback changed would tear down the
  // listener a queued request is about to be delivered to.
  const onSearch = useRef<(r: SearchRequest) => void>(() => undefined);
  onSearch.current = ({ query, task }) => {
    setSession((s) => ({ ...s, tab: 'search', query, task }));
    void runSearch(query, task);
  };
  useEffect(() => searchRequests.receive((r) => onSearch.current(r)), []);

  const onPull = useRef<(r: PullRequest) => void>(() => undefined);
  onPull.current = ({ repo, to }) => {
    void act(() => client.pull(repo, to === '' ? undefined : to));
  };
  useEffect(() => pullRequests.receive((r) => onPull.current(r)), []);

  const locations = useMemo(
    () => (doctor?.roots ?? []).map((r) => r.name),
    [doctor],
  );

  const otherLocation = useCallback(
    (current: string) => locations.find((l) => l !== current),
    [locations],
  );

  /** Hand a model to whichever plugin accepts it. Nothing does yet — the
   *  runtimes (image, TTS) are what will. Declared now so they need no change
   *  here when they arrive. */
  const share = useCallback(async (m: LocalModel) => {
    await ctx.plugin.bus.emit({
      type: 'application/vnd.modelctl.model+json',
      data: { repo: m.repo, path: m.path, task: m.task, location: m.location },
      meta: { sourcePluginId: ctx.plugin.id },
    });
    await ctx.plugin.ui.notify(`${m.repo} sent to the bus`);
  }, [ctx]);

  // ─── render ────────────────────────────────────────────────

  if (healthError !== null) {
    return (
      <div style={S.root}>
        <Offline error={healthError} url={daemonUrl} onRetry={() => void refresh()} />
      </div>
    );
  }

  if (health !== null && !health.configured) {
    return (
      <div style={S.root}>
        <div style={S.centered}>
          <h2 style={S.h2}>modelctl has no config yet</h2>
          <p style={S.muted}>
            The daemon is running, but there is no catalog for it to serve.
          </p>
          <pre style={S.code}>
            modelctl init --internal ~/.cache/huggingface/hub \{'\n'}
            {'  '}--external /Volumes/DRIVE/hf-cache --default external
          </pre>
          <button type="button" style={S.button} onClick={() => void refresh()}>Recheck</button>
        </div>
      </div>
    );
  }

  return (
    <div style={S.root}>
      <div style={S.toolbar}>
        {(['installed', 'search', 'drives'] as const).map((t) => (
          <button
            key={t}
            type="button"
            style={{ ...S.tab, ...(session.tab === t ? S.tabActive : {}) }}
            onClick={() => setSession((s) => ({ ...s, tab: t }))}
          >
            {t === 'installed' ? 'Installed' : t === 'search' ? 'Hugging Face' : 'Drives'}
            {t === 'installed' && inventory !== null && (
              <span style={S.count}>{inventory.models.length}</span>
            )}
          </button>
        ))}
        <span style={S.meta}>
          {health !== null
            ? `${daemonUrl.replace(/^https?:\/\//, '')} · ${inventory?.models.length ?? 0} models`
            : 'connecting…'}
        </span>
        <button type="button" style={S.button} onClick={() => void refresh()}>Refresh</button>
      </div>

      {error !== null && <ErrorBar error={error} onDismiss={() => setError(null)} />}

      {inventory !== null && inventory.unavailable_roots.length > 0 && (
        <div style={S.warnBar}>
          {inventory.unavailable_roots.join(', ')} not mounted — showing what is reachable.
        </div>
      )}

      <div style={S.body}>
        {session.tab === 'installed' && (
          <Installed
            inventory={inventory}
            otherLocation={otherLocation}
            onMove={(m, to) => void act(() => client.move(m.repo, to))}
            onDelete={(m) => setConfirming(m)}
            onShare={(m) => void share(m)}
          />
        )}
        {session.tab === 'search' && (
          <Search
            session={session}
            searching={searching}
            results={results}
            fetchSizes={fetchSizes}
            locations={locations}
            defaultLocation={health?.default ?? ''}
            onChange={(patch) => setSession((s) => ({ ...s, ...patch }))}
            onRun={() => void runSearch(session.query, session.task)}
            onPull={(repo, to) => void act(() => client.pull(repo, to === '' ? undefined : to))}
          />
        )}
        {session.tab === 'drives' && <Drives doctor={doctor} />}
      </div>

      <Jobs jobs={jobs} onCancel={(id) => void client.cancel(id).catch(() => undefined)} />

      {confirming !== null && (
        <Confirm
          model={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const m = confirming;
            setConfirming(null);
            void act(() => client.remove(m.repo));
          }}
        />
      )}
    </div>
  );
}

// ─── sub-views ───────────────────────────────────────────────

function Offline({ error, url, onRetry }: {
  error: CatalogError; url: string; onRetry: () => void;
}) {
  return (
    <div style={S.centered}>
      <h2 style={S.h2}>{error.message}</h2>
      <p style={S.muted}>{error.hint ?? START_HINT}</p>
      <pre style={S.code}>
        cd /Users/cagdasmert/work/tools/huggingface{'\n'}
        .venv/bin/python modelctl.py serve
      </pre>
      <p style={S.mutedSmall}>Expecting it at {url}.</p>
      <button type="button" style={S.button} onClick={onRetry}>Retry</button>
    </div>
  );
}

function ErrorBar({ error, onDismiss }: { error: CatalogError; onDismiss: () => void }) {
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

function Installed({ inventory, otherLocation, onMove, onDelete, onShare }: {
  inventory: Inventory | null;
  otherLocation: (current: string) => string | undefined;
  onMove: (m: LocalModel, to: string) => void;
  onDelete: (m: LocalModel) => void;
  onShare: (m: LocalModel) => void;
}) {
  if (inventory === null) return <p style={S.empty}>Reading both drives…</p>;
  if (inventory.models.length === 0) {
    return <p style={S.empty}>No models downloaded. Try the Hugging Face tab.</p>;
  }
  return (
    <table style={S.table}>
      <thead>
        <tr>
          <th style={S.th}>Repo</th>
          <th style={S.th}>Task</th>
          <th style={S.th}>Where</th>
          <th style={{ ...S.th, textAlign: 'right' }}>Size</th>
          <th style={S.th} />
        </tr>
      </thead>
      <tbody>
        {inventory.models.map((m) => {
          const dest = otherLocation(m.location);
          return (
            <tr key={m.repo}>
              <td style={S.td} title={m.path}>{m.repo}</td>
              <td style={{ ...S.td, ...S.dim }}>{m.task ?? '—'}</td>
              <td style={S.td}><span style={S.pill}>{m.location}</span></td>
              <td style={{ ...S.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {m.size_human}
              </td>
              <td style={{ ...S.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                <button type="button" style={S.linkButton} onClick={() => onShare(m)}>
                  send
                </button>
                {dest !== undefined && (
                  <button type="button" style={S.linkButton} onClick={() => onMove(m, dest)}>
                    → {dest}
                  </button>
                )}
                <button
                  type="button"
                  style={{ ...S.linkButton, color: 'var(--error-fg, #b91c1c)' }}
                  onClick={() => onDelete(m)}
                >
                  delete
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td style={{ ...S.td, ...S.dim }} colSpan={5}>
            {inventory.models.length} models
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function Search({
  session, searching, results, fetchSizes, locations, defaultLocation, onChange, onRun, onPull,
}: {
  session: Session;
  searching: boolean;
  results: SearchResult | null;
  fetchSizes: boolean;
  locations: string[];
  defaultLocation: string;
  onChange: (patch: Partial<Session>) => void;
  onRun: () => void;
  onPull: (repo: string, to: string) => void;
}) {
  const [dest, setDest] = useState('');
  return (
    <div style={S.searchWrap}>
      <div style={S.searchBar}>
        <input
          style={S.input}
          value={session.query}
          placeholder="flux, whisper, kokoro…"
          spellCheck={false}
          onChange={(e) => onChange({ query: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') onRun(); }}
        />
        <select
          style={S.select}
          value={session.task}
          onChange={(e) => onChange({ task: e.target.value })}
        >
          {TASKS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <select style={S.select} value={dest} onChange={(e) => setDest(e.target.value)}>
          <option value="">{defaultLocation === '' ? 'default drive' : `${defaultLocation} (default)`}</option>
          {locations.filter((l) => l !== defaultLocation).map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        <button type="button" style={S.button} disabled={searching} onClick={onRun}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>

      {searching && fetchSizes && (
        <p style={S.mutedSmall}>Fetching sizes — one Hub request per result.</p>
      )}

      {results === null && !searching && (
        <p style={S.empty}>
          Search the Hub. Turn on “fetch sizes” in Settings to see download size and
          whether a model fits in RAM.
        </p>
      )}

      {results !== null && results.results.length === 0 && (
        <p style={S.empty}>No results.</p>
      )}

      {results !== null && results.results.length > 0 && (
        <>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Repo</th>
                <th style={S.th}>Task</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Downloads</th>
                {fetchSizes && <th style={{ ...S.th, textAlign: 'right' }}>Size</th>}
                {fetchSizes && <th style={S.th}>Fits</th>}
                <th style={S.th} />
              </tr>
            </thead>
            <tbody>
              {results.results.map((h: SearchHit) => (
                <tr key={h.repo}>
                  <td style={S.td}>{h.repo}</td>
                  <td style={{ ...S.td, ...S.dim }}>{h.task ?? '—'}</td>
                  <td style={{ ...S.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {h.downloads.toLocaleString()}
                  </td>
                  {fetchSizes && (
                    <td style={{ ...S.td, textAlign: 'right' }}>{h.size_human ?? '?'}</td>
                  )}
                  {fetchSizes && (
                    <td style={{ ...S.td, color: fitColor(h.fits) }}>{h.fits ?? '?'}</td>
                  )}
                  <td style={{ ...S.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {h.local !== null
                      ? <span style={S.pill}>on {h.local}</span>
                      : (
                        <button
                          type="button"
                          style={S.linkButton}
                          onClick={() => onPull(h.repo, dest)}
                        >
                          download
                        </button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {results.fits_note !== null && <p style={S.mutedSmall}>{results.fits_note}</p>}
        </>
      )}
    </div>
  );
}

function Drives({ doctor }: { doctor: Doctor | null }) {
  if (doctor === null) return <p style={S.empty}>Checking drives…</p>;
  return (
    <div style={S.drives}>
      {doctor.roots.map((r) => (
        <div key={r.name} style={S.card}>
          <div style={S.cardHead}>
            <strong>{r.name}</strong>
            {r.is_default === true && <span style={S.pill}>default</span>}
            <span style={{ ...S.pill, ...(r.mounted ? S.pillOk : S.pillBad) }}>
              {r.mounted ? 'mounted' : 'missing'}
            </span>
          </div>
          <div style={S.mutedSmall}>{r.path}</div>
          {r.mounted && (
            <dl style={S.dl}>
              <dt style={S.dt}>filesystem</dt><dd style={S.dd}>{r.filesystem}</dd>
              <dt style={S.dt}>symlinks</dt>
              <dd style={{ ...S.dd, color: r.symlinks === true ? undefined : 'var(--error-fg, #b91c1c)' }}>
                {r.symlinks === true ? 'yes' : 'no — cache runs duplicated'}
              </dd>
              <dt style={S.dt}>free</dt><dd style={S.dd}>{r.free_human}</dd>
              <dt style={S.dt}>models</dt><dd style={S.dd}>{r.models}</dd>
            </dl>
          )}
        </div>
      ))}
      {doctor.problems.length > 0 && (
        <div style={S.card}>
          <strong>Issues</strong>
          <ul style={S.ul}>
            {doctor.problems.map((p) => <li key={p} style={S.mutedSmall}>{p}</li>)}
          </ul>
        </div>
      )}
      <p style={S.mutedSmall}>
        config {doctor.config_path}
        {doctor.system_ram_human !== null && ` · ${doctor.system_ram_human} RAM`}
      </p>
    </div>
  );
}

function Jobs({ jobs, onCancel }: { jobs: Job[]; onCancel: (id: string) => void }) {
  const visible = jobs.filter((j) => j.state === 'running').concat(
    jobs.filter((j) => j.state !== 'running').slice(0, 2),
  );
  if (visible.length === 0) return null;
  return (
    <div style={S.jobs}>
      {visible.map((j) => (
        <div key={j.id} style={S.job}>
          <span style={S.jobKind}>{j.kind}</span>
          <span style={S.jobRepo}>{j.repo}</span>
          {j.state === 'running' && (
            <span style={S.bar}>
              <span style={{ ...S.barFill, width: `${j.percent ?? 0}%` }} />
            </span>
          )}
          <span style={{
            ...S.jobState,
            color: j.state === 'failed' ? 'var(--error-fg, #b91c1c)' : undefined,
          }}
          >
            {j.state === 'running'
              ? (j.last_line !== undefined && j.last_line !== '' ? j.last_line : 'starting…')
              : (j.error ?? j.state)}
          </span>
          {j.state === 'running' && (
            <button type="button" style={S.linkButton} onClick={() => onCancel(j.id)}>
              cancel
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Confirm({ model, onCancel, onConfirm }: {
  model: LocalModel; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div style={S.sheet}>
      <div style={S.sheetInner}>
        <strong>Delete {model.repo}?</strong>
        <p style={S.mutedSmall}>
          Frees {model.size_human} on {model.location}. The weights can be pulled again;
          nothing else is lost.
        </p>
        <div style={S.sheetActions}>
          <button type="button" style={S.button} onClick={onCancel}>Cancel</button>
          <button
            type="button"
            style={{ ...S.button, color: 'var(--error-fg, #b91c1c)' }}
            onClick={onConfirm}
          >
            Delete
          </button>
        </div>
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
    position: 'relative',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 12px',
    borderBottom: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--chrome-bg, #f4f4f5)',
  },
  tab: {
    font: 'inherit',
    padding: '3px 10px',
    borderRadius: 5,
    border: '1px solid transparent',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  tabActive: {
    background: 'var(--workspace-bg, #fff)',
    borderColor: 'var(--chrome-border, #d4d4d8)',
  },
  count: {
    marginLeft: 6,
    fontSize: 11,
    color: 'var(--chrome-muted, #71717a)',
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
  linkButton: {
    font: 'inherit',
    fontSize: 12,
    padding: '2px 6px',
    marginLeft: 4,
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    opacity: 0.75,
    cursor: 'pointer',
  },
  input: {
    font: 'inherit',
    flex: 1,
    minWidth: 120,
    padding: '4px 8px',
    borderRadius: 5,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
  },
  select: {
    font: 'inherit',
    fontSize: 12,
    padding: '3px 6px',
    borderRadius: 5,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
  },
  meta: {
    marginLeft: 'auto',
    color: 'var(--chrome-muted, #71717a)',
    fontSize: 12,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  body: { flex: 1, overflow: 'auto', minHeight: 0 },
  searchWrap: { display: 'flex', flexDirection: 'column' },
  searchBar: {
    display: 'flex',
    gap: 6,
    padding: '10px 12px',
    borderBottom: '1px solid var(--chrome-border, #d4d4d8)',
  },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: {
    textAlign: 'left',
    padding: '6px 12px',
    fontWeight: 500,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '.04em',
    color: 'var(--chrome-muted, #71717a)',
    borderBottom: '1px solid var(--chrome-border, #d4d4d8)',
    position: 'sticky',
    top: 0,
    background: 'var(--workspace-bg, #fff)',
  },
  td: {
    padding: '6px 12px',
    borderBottom: '1px solid var(--chrome-border, #e4e4e7)',
    verticalAlign: 'top',
  },
  dim: { color: 'var(--chrome-muted, #71717a)' },
  pill: {
    display: 'inline-block',
    padding: '1px 7px',
    marginRight: 4,
    borderRadius: 999,
    fontSize: 11,
    background: 'var(--chrome-bg, #f4f4f5)',
    border: '1px solid var(--chrome-border, #d4d4d8)',
  },
  pillOk: { color: 'var(--ok-fg, #15803d)' },
  pillBad: { color: 'var(--error-fg, #b91c1c)' },
  drives: { display: 'flex', flexDirection: 'column', gap: 10, padding: 12 },
  card: {
    padding: 12,
    borderRadius: 8,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--chrome-bg, #fafafa)',
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 },
  dl: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    gap: '2px 16px',
    margin: '10px 0 0',
    fontSize: 12,
  },
  dt: { color: 'var(--chrome-muted, #71717a)' },
  dd: { margin: 0 },
  ul: { margin: '6px 0 0', paddingLeft: 18 },
  jobs: {
    borderTop: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--chrome-bg, #f4f4f5)',
    padding: '6px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  job: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 },
  jobKind: {
    textTransform: 'uppercase',
    fontSize: 10,
    letterSpacing: '.05em',
    color: 'var(--chrome-muted, #71717a)',
    width: 34,
  },
  jobRepo: { fontWeight: 500, whiteSpace: 'nowrap' },
  bar: {
    width: 120,
    height: 4,
    borderRadius: 2,
    background: 'var(--chrome-border, #d4d4d8)',
    overflow: 'hidden',
    flexShrink: 0,
  },
  barFill: { display: 'block', height: '100%', background: 'currentColor', opacity: 0.6 },
  jobState: {
    color: 'var(--chrome-muted, #71717a)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    flex: 1,
    fontFamily: "'SF Mono', ui-monospace, monospace",
    fontSize: 11,
  },
  centered: {
    margin: 'auto',
    padding: 32,
    maxWidth: 560,
    textAlign: 'center',
  },
  h2: { margin: '0 0 6px', fontSize: 15, fontWeight: 600 },
  muted: { margin: '0 0 12px', color: 'var(--chrome-muted, #71717a)' },
  mutedSmall: {
    margin: '6px 12px',
    color: 'var(--chrome-muted, #71717a)',
    fontSize: 12,
  },
  code: {
    margin: '0 0 14px',
    padding: 10,
    textAlign: 'left',
    borderRadius: 6,
    background: 'var(--chrome-bg, #f4f4f5)',
    border: '1px solid var(--chrome-border, #d4d4d8)',
    font: "11px/1.6 'SF Mono', ui-monospace, monospace",
    whiteSpace: 'pre-wrap',
  },
  empty: { margin: 24, textAlign: 'center', color: 'var(--chrome-muted, #71717a)' },
  errorBar: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    padding: '8px 12px',
    background: 'var(--error-bg, #fef2f2)',
    borderBottom: '1px solid var(--chrome-border, #d4d4d8)',
    color: 'var(--error-fg, #b91c1c)',
    fontSize: 12,
  },
  warnBar: {
    padding: '6px 12px',
    fontSize: 12,
    color: 'var(--warn-fg, #b45309)',
    borderBottom: '1px solid var(--chrome-border, #d4d4d8)',
  },
  sheet: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(0,0,0,.25)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetInner: {
    maxWidth: 380,
    padding: 18,
    borderRadius: 10,
    background: 'var(--workspace-bg, #fff)',
    border: '1px solid var(--chrome-border, #d4d4d8)',
    boxShadow: '0 8px 30px rgba(0,0,0,.2)',
  },
  sheetActions: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 },
};

// ─── plugin ──────────────────────────────────────────────────

export const plugin: Plugin = {
  activate(ctx: PluginContext) {
    ctx.log.info('model-manager activating');
    ctx.registerPanel('model.main', definePanel(ModelManagerPanel));
    ctx.registerCommand('model.open', () => ctx.workspace.openPanel('model.main'));

    ctx.registerCommand('model.search', async (...args: unknown[]) => {
      const query = typeof args[0] === 'string' ? args[0] : '';
      const task = typeof args[1] === 'string' ? args[1] : '';
      await ctx.workspace.openPanel('model.main');
      if (query !== '') searchRequests.send({ query, task });
    });

    ctx.registerCommand('model.pull', async (...args: unknown[]) => {
      const repo = typeof args[0] === 'string' ? args[0] : '';
      const to = typeof args[1] === 'string' ? args[1] : '';
      if (repo === '') {
        await ctx.ui.notify('model.pull needs a repo id', 'warn');
        return;
      }
      await ctx.workspace.openPanel('model.main');
      pullRequests.send({ repo, to });
    });
  },

  deactivate() {
    // Registrations are the host's to unwind (invariant 8). Module state is
    // ours: a request no panel drained must not leak into the next activation.
    searchRequests.clear();
    pullRequests.clear();
  },
};
