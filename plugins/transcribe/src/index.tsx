import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileFilter, PanelContext, Plugin } from '@workbench/plugin-sdk';
import { definePanel } from '@workbench/plugin-sdk/react';
import {
  AsrClient,
  DEFAULT_DAEMON_URL,
  DaemonError,
  START_COMMAND,
  asDaemonError,
  type AsrJob,
  type Probe,
  type Transcript,
} from './client.js';
import {
  DEFAULT_MODEL,
  MODELS,
  OTHER_LANGUAGES,
  PINNED_LANGUAGES,
  checkLanguage,
  languageLabel,
  modelLabel,
} from './capabilities.js';
import { formatBytes, formatDuration, formatTimestamp } from './format.js';
import { transcriptMarkdown } from './markdown.js';
import { startPoller } from './poller.js';
import { addRecent, markSaved, parseRecent, timeAgo, type RecentEntry } from './recent.js';
import { pickReattach } from './reattach.js';

const PANEL_ID = 'transcribe.main';

/** Both runtimes decode through ffmpeg, so anything it reads is fair game. */
const FILTERS: FileFilter[] = [
  {
    name: 'Audio and video',
    extensions: ['m4a', 'mp3', 'wav', 'aiff', 'aif', 'caf', 'flac', 'ogg', 'opus', 'aac',
      'mp4', 'mov', 'm4v', 'mkv', 'webm'],
  },
];

type FileRequest =
  | { kind: 'pick' }
  | { kind: 'run'; path: string; model: string; language: string };

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
export const requests = mailbox<FileRequest>();

type View =
  | { kind: 'empty' }
  | { kind: 'probing'; path: string }
  | { kind: 'configured'; probe: Probe }
  | { kind: 'running'; probe: Probe | null; job: AsrJob }
  | { kind: 'finished'; probe: Probe | null; job: AsrJob };

/** Content routed here carries a path in `meta.path`, or it is useless to us (C2). */
function payloadPath(payload: unknown): string | undefined | null {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const meta = (payload as { meta?: unknown }).meta;
  if (typeof meta === 'object' && meta !== null) {
    const path = (meta as { path?: unknown }).path;
    if (typeof path === 'string' && path !== '') return path;
  }
  return null;   // content, but no path to hand the daemon
}

// ─── panel ───────────────────────────────────────────────────

function TranscribePanel({ ctx }: { ctx: PanelContext }) {
  const [daemonUrl, setDaemonUrl] = useState(DEFAULT_DAEMON_URL);
  const [token, setToken] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [language, setLanguage] = useState('auto');
  const [timestamps, setTimestamps] = useState(true);
  const [vaultDir, setVaultDir] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  // TRAP 1 (change log 6, 13): storage and settings are async. Nothing is
  // saved, and the daemon is not contacted, until both have been read.
  const [loaded, setLoaded] = useState(false);

  const [connected, setConnected] = useState(false);
  const [offline, setOffline] = useState<DaemonError | null>(null);
  const [error, setError] = useState<DaemonError | null>(null);
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [view, setView] = useState<View>({ kind: 'empty' });
  // Read by `connect` to tell a transcript already seen from one that finished
  // while no panel was open. Loaded in the same batch as `loaded`, so it is
  // current by the time `connect` first runs.
  const recentRef = useRef(recent);
  recentRef.current = recent;

  const client = useMemo(
    () => new AsrClient(ctx.plugin, daemonUrl, token),
    [ctx, daemonUrl, token],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [u, t, settingModel, ts, lastModel, lastLanguage, dir, savedRecent] = await Promise.all([
        ctx.plugin.settings.get('daemonUrl'),
        ctx.plugin.settings.get('token'),
        ctx.plugin.settings.get('model'),
        ctx.plugin.settings.get('timestamps'),
        ctx.plugin.storage.get('lastModel'),
        ctx.plugin.storage.get('lastLanguage'),
        ctx.plugin.storage.get('vaultDir'),
        ctx.plugin.storage.get('recent'),
      ]);
      if (cancelled) return;
      if (typeof u === 'string' && u !== '') setDaemonUrl(u);
      if (typeof t === 'string') setToken(t);
      if (typeof ts === 'boolean') setTimestamps(ts);
      if (typeof lastModel === 'string' && lastModel !== '') setModel(lastModel);
      else if (typeof settingModel === 'string' && settingModel !== '') setModel(settingModel);
      if (typeof lastLanguage === 'string' && lastLanguage !== '') setLanguage(lastLanguage);
      if (typeof dir === 'string' && dir !== '') setVaultDir(dir);
      setRecent(parseRecent(savedRecent));
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [ctx]);

  // TRAP 2 (change log 15): onChange returns a Disposable, not a cleanup function.
  useEffect(() => {
    const sub = ctx.plugin.settings.onChange((key, value) => {
      if (key === 'daemonUrl' && typeof value === 'string' && value !== '') setDaemonUrl(value);
      if (key === 'token' && typeof value === 'string') setToken(value);
      if (key === 'model' && typeof value === 'string' && value !== '') setModel(value);
      if (key === 'timestamps' && typeof value === 'boolean') setTimestamps(value);
    });
    return () => { void sub.dispose(); };
  }, [ctx]);

  useEffect(() => {
    if (!loaded) return;
    void ctx.plugin.storage.set('lastModel', model);
    void ctx.plugin.storage.set('lastLanguage', language);
  }, [ctx, loaded, model, language]);

  useEffect(() => {
    if (!loaded) return;
    void ctx.plugin.storage.set('vaultDir', vaultDir);
    void ctx.plugin.storage.set('recent', recent);
  }, [ctx, loaded, vaultDir, recent]);

  const fail = useCallback((err: unknown) => {
    const e = asDaemonError(err);
    if (e.kind === 'offline') setOffline(e);
    else setError(e);
  }, []);

  const connect = useCallback(async () => {
    setOffline(null);
    try {
      await client.health();
      setConnected(true);
      // C4: a job outlives the panel that started it. Ask the daemon — the
      // only thing that knows — rather than trusting a remembered id.
      const { jobs } = await client.jobs();
      const pick = pickReattach(jobs, new Set(recentRef.current.map((e) => e.jobId)));
      if (pick?.kind === 'running') {
        setView((v) => (v.kind === 'empty' ? { kind: 'running', probe: null, job: pick.job } : v));
      } else if (pick?.kind === 'done') {
        const full = await client.job(pick.job.id);   // the list view carries no result
        setView((v) => (v.kind === 'empty' ? { kind: 'finished', probe: null, job: full } : v));
      }
      // Only to mark models that would 404; a failure here costs nothing.
      setInstalled(await client.installed().catch(() => null));
    } catch (err: unknown) {
      setConnected(false);
      fail(err);
    }
  }, [client, fail]);

  useEffect(() => { if (loaded) void connect(); }, [loaded, connect]);

  // ─── actions ───────────────────────────────────────────────

  const load = useCallback(async (path: string): Promise<Probe | undefined> => {
    setError(null);
    setView({ kind: 'probing', path });
    try {
      const probe = await client.probe(path);
      setView({ kind: 'configured', probe });
      return probe;
    } catch (err: unknown) {
      fail(err);
      setView({ kind: 'empty' });
      return undefined;
    }
  }, [client, fail]);

  const choose = useCallback(async () => {
    const path = await ctx.plugin.fs.pickFile(FILTERS);
    if (path !== undefined) await load(path);
  }, [ctx, load]);

  const run = useCallback(async (probe: Probe, runModel: string, runLanguage: string) => {
    setError(null);
    try {
      const job = await client.start({ path: probe.path, model: runModel, language: runLanguage });
      setView({ kind: 'running', probe, job });
    } catch (err: unknown) {
      fail(err);
    }
  }, [client, fail]);

  const cancel = useCallback(async (job: AsrJob) => {
    setError(null);
    try {
      await client.cancel(job.id);
    } catch (err: unknown) {
      fail(err);   // most likely 409: it finished while the click was in flight
    }
  }, [client, fail]);

  /** Hand the transcript to whichever plugin accepts markdown. The shell routes it. */
  const send = useCallback(async (job: AsrJob, result: Transcript, filename: string) => {
    const title = filename.replace(/\.[^.]+$/, '');
    await ctx.plugin.bus.emit({
      type: 'text/markdown',
      data: transcriptMarkdown(result, { title, timestamps }),
      meta: { filename: `${title}.md`, jobId: job.id, language: result.language, model: result.model },
    });
  }, [ctx, timestamps]);

  /** `pickDirectory` is the consent gesture and the path chooser (C2); cancel means no. */
  const chooseFolder = useCallback(async (): Promise<string | undefined> => {
    const dir = await ctx.plugin.fs.pickDirectory();
    if (dir !== undefined) setVaultDir(dir);
    return dir;
  }, [ctx]);

  const save = useCallback(async (job: AsrJob): Promise<string | undefined> => {
    setError(null);
    const dir = vaultDir ?? await chooseFolder();
    if (dir === undefined) return undefined;
    try {
      const { path } = await client.save({ job_id: job.id, dir, timestamps });
      setRecent((list) => markSaved(list, job.id, path));
      return path;
    } catch (err: unknown) {
      fail(err);
      return undefined;
    }
  }, [client, vaultDir, chooseFolder, timestamps, fail]);

  const openRecent = useCallback(async (entry: RecentEntry) => {
    setError(null);
    try {
      const job = await client.job(entry.jobId);
      setView(job.state === 'running'
        ? { kind: 'running', probe: null, job }
        : { kind: 'finished', probe: null, job });
    } catch (err: unknown) {
      const e = asDaemonError(err);
      if (e.kind !== 'api') {
        fail(e);
        return;
      }
      setError(new DaemonError(
        `The daemon no longer has ${entry.filename} — it forgets jobs when it restarts.`,
        entry.savedPath === null ? 'It was never saved; transcribe the file again.' : `Saved copy: ${entry.savedPath}`,
        'api',
      ));
    }
  }, [client, fail]);

  // Commands and routed content, once the daemon is reachable. The handler
  // lives in a ref so a changed client does not drop a queued request.
  const onRequest = useRef<(req: FileRequest) => void>(() => undefined);
  onRequest.current = (req) => {
    if (req.kind === 'pick') {
      void choose();
      return;
    }
    const runModel = req.model !== '' ? req.model : model;
    setModel(runModel);
    setLanguage(req.language);
    void load(req.path).then((probe) => {
      if (probe?.has_audio === true) void run(probe, runModel, req.language);
    });
  };

  useEffect(() => {
    if (!connected) return undefined;
    return requests.receive((req) => onRequest.current(req));
  }, [connected]);

  // TRAP 3 (change log 9): routed content arrives as ctx.payload, a Content.
  const payloadHandled = useRef(false);
  useEffect(() => {
    if (!connected || payloadHandled.current || ctx.payload === undefined) return;
    payloadHandled.current = true;
    const path = payloadPath(ctx.payload);
    if (typeof path === 'string') void load(path);
    else if (path === null) {
      void ctx.plugin.ui.notify('Transcribe needs a file on disk — choose the file instead.', 'warn');
    }
  }, [ctx, connected, load]);

  // ─── polling ───────────────────────────────────────────────

  const runningId = view.kind === 'running' ? view.job.id : null;
  useEffect(() => {
    if (runningId === null) return undefined;
    const poller = startPoller<AsrJob>({
      fetch: () => client.job(runningId),
      onValue: (job) => {
        setView((v) => {
          if (v.kind !== 'running' || v.job.id !== job.id) return v;
          return job.state === 'running' ? { ...v, job } : { kind: 'finished', probe: v.probe, job };
        });
      },
      onError: (err) => {
        const e = asDaemonError(err);
        // A 404 means the daemon restarted and forgot the job. Anything else
        // (offline included) may be a restart in progress: keep polling.
        if (e.kind !== 'api') return;
        setView((v) => (v.kind !== 'running' ? v : {
          kind: 'finished',
          probe: v.probe,
          job: { ...v.job, state: 'failed', error: `${e.message} — the daemon forgets jobs when it restarts.` },
        }));
      },
      next: (job) => (job.state === 'running' ? 1_000 : undefined),
    });
    return () => poller.stop();
  }, [client, runningId]);

  // A finished transcript joins `recent` once — keyed on the job, so reopening
  // it from the list refreshes its place without adding a duplicate.
  const doneJob = view.kind === 'finished' && view.job.state === 'done' ? view.job : null;
  const doneFilename = view.kind === 'finished' ? view.probe?.name : undefined;
  useEffect(() => {
    if (doneJob === null || !doneJob.result) return;
    const result = doneJob.result;
    setRecent((list) => addRecent(list, {
      jobId: doneJob.id,
      filename: doneFilename ?? doneJob.params.path?.split('/').pop() ?? doneJob.id,
      when: (doneJob.finished ?? doneJob.started) * 1_000,
      model: result.model,
      chars: result.text.length,
      savedPath: null,
    }));
  }, [doneJob, doneFilename]);

  // ─── render ────────────────────────────────────────────────

  if (offline !== null) {
    return (
      <div style={S.root}>
        <Offline error={offline} url={daemonUrl} onRetry={() => void connect()} />
      </div>
    );
  }

  if (!connected) {
    return <div style={S.root}><p style={S.connecting}>Connecting to {daemonUrl}…</p></div>;
  }

  const warning = checkLanguage(model, language);
  const blocked = warning?.level === 'block' || (installed !== null && !installed.includes(model));

  const pickers = (
    <>
      <Pickers
        model={model}
        language={language}
        installed={installed}
        onModel={setModel}
        onLanguage={setLanguage}
      />
      {warning !== null && (
        <p style={warning.level === 'block' ? S.block : S.warn}>
          {warning.message}
          {model !== DEFAULT_MODEL && (
            <button type="button" style={S.inlineFix} onClick={() => setModel(DEFAULT_MODEL)}>
              Use {modelLabel(DEFAULT_MODEL)}
            </button>
          )}
        </p>
      )}
    </>
  );

  return (
    <div style={S.root}>
      {error !== null && <ErrorBar error={error} onDismiss={() => setError(null)} />}
      <div style={S.body}>
        <div style={S.column}>
          {view.kind === 'empty' && (
            <>
              <div style={S.pickArea}>
                <button type="button" style={S.primary} onClick={() => void choose()}>
                  Choose file…
                </button>
                <p style={S.mutedSmall}>Audio or video — m4a, mp3, wav, mp4, mov and anything ffmpeg reads.</p>
              </div>
              {pickers}
              <Recent entries={recent} onOpen={(e) => void openRecent(e)} />
            </>
          )}

          {view.kind === 'probing' && (
            <p style={S.muted}>Reading {view.path.split('/').pop()}…</p>
          )}

          {view.kind === 'configured' && (
            <>
              <FileCard probe={view.probe} onChange={() => void choose()} />
              {pickers}
              {!view.probe.has_audio && (
                <p style={S.warn}>This file has no audio track, so there is nothing to transcribe.</p>
              )}
              {installed !== null && !installed.includes(model) && (
                <p style={S.warn}>
                  {modelLabel(model)} is not downloaded. Pull it from the Models panel first.
                </p>
              )}
              <div style={S.actions}>
                <button
                  type="button"
                  style={!view.probe.has_audio || blocked ? { ...S.primary, ...S.disabled } : S.primary}
                  disabled={!view.probe.has_audio || blocked}
                  onClick={() => void run(view.probe, model, language)}
                >
                  Transcribe
                </button>
              </div>
            </>
          )}

          {view.kind === 'running' && (
            <Running probe={view.probe} job={view.job} onCancel={() => cancel(view.job)} />
          )}

          {view.kind === 'finished' && (
            view.job.state === 'done' && view.job.result
              ? (
                <Done
                  key={view.job.id}
                  ctx={ctx}
                  job={view.job}
                  result={view.job.result}
                  savedPath={recent.find((e) => e.jobId === view.job.id)?.savedPath ?? null}
                  vaultDir={vaultDir}
                  onSave={() => save(view.job)}
                  onSend={(result) => send(
                    view.job,
                    result,
                    view.probe?.name ?? view.job.params.path?.split('/').pop() ?? 'transcript',
                  )}
                  onChangeFolder={() => void chooseFolder()}
                  onNew={() => setView({ kind: 'empty' })}
                />
              )
              : (
                <Failed
                  job={view.job}
                  onRetry={view.probe === null ? undefined : () => {
                    if (view.probe !== null) setView({ kind: 'configured', probe: view.probe });
                  }}
                  onNew={() => setView({ kind: 'empty' })}
                />
              )
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
            <p style={S.muted}>Transcription runs in modelctld. Start it with:</p>
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

function Pickers({ model, language, installed, onModel, onLanguage }: {
  model: string;
  language: string;
  installed: string[] | null;
  onModel: (repo: string) => void;
  onLanguage: (code: string) => void;
}) {
  const known = MODELS.some((m) => m.repo === model);
  const missing = (repo: string) => (installed !== null && !installed.includes(repo) ? ' (not downloaded)' : '');
  return (
    <div style={S.pickers}>
      <label style={S.field}>
        <span style={S.label}>Model</span>
        <select style={S.select} value={model} onChange={(e) => onModel(e.target.value)}>
          {MODELS.map((m) => (
            <option key={m.repo} value={m.repo}>{m.label} — {m.note}{missing(m.repo)}</option>
          ))}
          {!known && <option value={model}>{model}{missing(model)}</option>}
        </select>
      </label>
      <label style={S.field}>
        <span style={S.label}>Language</span>
        <select style={S.select} value={language} onChange={(e) => onLanguage(e.target.value)}>
          {PINNED_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          <optgroup label="Other">
            {OTHER_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </optgroup>
        </select>
      </label>
    </div>
  );
}

function FileCard({ probe, onChange }: { probe: Probe; onChange: () => void }) {
  return (
    <div style={S.card}>
      <div style={{ minWidth: 0 }}>
        <div style={S.fileName} title={probe.path}>{probe.name}</div>
        <div style={S.mutedSmall}>{formatDuration(probe.duration)} · {formatBytes(probe.size)}</div>
      </div>
      <button type="button" style={S.linkButton} onClick={onChange}>Choose another…</button>
    </div>
  );
}

function Running({ probe, job, onCancel }: {
  probe: Probe | null; job: AsrJob; onCancel: () => Promise<void>;
}) {
  const [cancelling, setCancelling] = useState(false);
  const percent = job.percent;
  const lastLine = job.log !== undefined && job.log.length > 0 ? job.log[job.log.length - 1] : job.last_line;
  return (
    <div style={S.card}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={S.runningHead}>
          <span style={S.fileName}>{probe?.name ?? job.params.path?.split('/').pop() ?? job.id}</span>
          <span style={S.mutedSmall}>
            {percent === null ? 'starting…' : `${Math.round(percent)}%`} · {formatTimestamp(job.elapsed)}
            <button
              type="button"
              style={S.linkButton}
              disabled={cancelling}
              onClick={() => {
                setCancelling(true);
                void onCancel().finally(() => setCancelling(false));
              }}
            >
              {cancelling ? 'cancelling…' : 'Cancel'}
            </button>
          </span>
        </div>
        <div style={S.track}>
          <div style={{ ...S.bar, width: `${percent ?? 0}%` }} />
        </div>
        <div style={S.lastLine} title={lastLine}>{lastLine ?? ''}</div>
      </div>
    </div>
  );
}

function Done({ ctx, job, result, savedPath, vaultDir, onSave, onSend, onChangeFolder, onNew }: {
  ctx: PanelContext;
  job: AsrJob;
  result: Transcript;
  /** From `recent` — so a transcript reopened after saving shows where it went. */
  savedPath: string | null;
  vaultDir: string | null;
  onSave: () => Promise<string | undefined>;
  onSend: (result: Transcript) => Promise<void>;
  onChangeFolder: () => void;
  onNew: () => void;
}) {
  const [copied, setCopied] = useState<number | 'all' | 'path' | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (copied === null) return undefined;
    const t = setTimeout(() => setCopied(null), 1_200);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async (text: string, which: number | 'all' | 'path') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
    } catch {
      await ctx.plugin.ui.notify('Could not write to the clipboard.', 'warn');
    }
  };

  const segments = result.segments.filter((s) => s.text.trim() !== '');
  const lines = segments.map((s) => `[${formatTimestamp(s.start)}] ${s.text.trim()}`);

  return (
    <>
      <div style={S.doneBar}>
        {savedPath === null
          ? (
            <button
              type="button"
              style={saving ? { ...S.primary, ...S.disabled } : S.primary}
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void onSave().finally(() => setSaving(false));
              }}
            >
              {saving ? 'Saving…' : vaultDir === null ? 'Save to vault…' : 'Save to vault'}
            </button>
          )
          : (
            <button
              type="button"
              style={S.savedPath}
              title={`${savedPath} — click to copy the path`}
              onClick={() => void copy(savedPath, 'path')}
            >
              {copied === 'path' ? 'Path copied' : `Saved as ${savedPath.split('/').pop() ?? savedPath}`}
            </button>
          )}
        <button type="button" style={S.button} onClick={() => void copy(lines.join('\n'), 'all')}>
          {copied === 'all' ? 'Copied' : 'Copy all'}
        </button>
        <button type="button" style={S.button} title="Send as markdown to another plugin" onClick={() => void onSend(result)}>
          Send to…
        </button>
        <span style={S.meta}>
          {modelLabel(result.model)} · {languageLabel(result.language)} · {formatDuration(result.duration)} of
          audio in {formatDuration(job.elapsed)}
        </span>
        <button type="button" style={S.linkButton} onClick={onNew}>New transcription</button>
      </div>
      {savedPath !== null && (
        <p style={S.folderLine} title={savedPath}>
          <span style={S.folderPath}>in {savedPath.slice(0, savedPath.lastIndexOf('/')) || '/'}</span>
        </p>
      )}
      {savedPath === null && vaultDir !== null && (
        <p style={S.folderLine}>
          <span style={S.folderPath} title={vaultDir}>into {vaultDir}</span>
          <button type="button" style={S.linkButton} onClick={onChangeFolder}>change</button>
        </p>
      )}
      {segments.length === 0
        ? <p style={S.muted}>No speech found.</p>
        : (
          <div style={S.segments}>
            {segments.map((s, i) => (
              <p key={`${s.start}-${i}`} style={S.segment}>
                <button
                  type="button"
                  style={S.stamp}
                  title="Copy this line"
                  onClick={() => void copy(lines[i] ?? '', i)}
                >
                  {copied === i ? 'copied' : formatTimestamp(s.start)}
                </button>
                <span>{s.text.trim()}</span>
              </p>
            ))}
          </div>
        )}
    </>
  );
}

function Recent({ entries, onOpen }: { entries: RecentEntry[]; onOpen: (e: RecentEntry) => void }) {
  if (entries.length === 0) return null;
  const now = Date.now();
  return (
    <div style={S.recent}>
      <div style={S.label}>Recent</div>
      {entries.map((e) => (
        <button key={e.jobId} type="button" style={S.recentRow} onClick={() => onOpen(e)}>
          <span style={S.fileName}>{e.filename}</span>
          <span style={S.mutedSmall}>
            {modelLabel(e.model)} · {e.chars.toLocaleString()} chars · {timeAgo(e.when, now)}
            {e.savedPath !== null && ' · saved'}
          </span>
        </button>
      ))}
    </div>
  );
}

function Failed({ job, onRetry, onNew }: { job: AsrJob; onRetry?: (() => void) | undefined; onNew: () => void }) {
  const cancelled = job.state === 'cancelled';
  const tail = (job.log ?? []).slice(-15).join('\n');
  return (
    <div>
      <h2 style={S.h2}>{cancelled ? 'Cancelled' : 'Transcription failed'}</h2>
      {cancelled
        // Something the user chose, not something that went wrong: no log.
        ? <p style={S.muted}>Stopped at {Math.round(job.percent ?? 0)}%. Nothing was kept.</p>
        : (
          <>
            {job.error !== null && <p style={S.errorText}>{job.error}</p>}
            {tail !== '' && <pre style={S.code}>{tail}</pre>}
          </>
        )}
      <div style={S.actions}>
        {onRetry !== undefined && <button type="button" style={S.primary} onClick={onRetry}>Try again</button>}
        <button type="button" style={S.button} onClick={onNew}>Choose another file</button>
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
  mutedSmall: { color: 'var(--chrome-muted, #71717a)', fontSize: 12, margin: 0 },
  warn: { color: 'var(--warn-fg, #d97706)', fontSize: 12, margin: '8px 0 0' },
  block: { color: 'var(--error-fg, #dc2626)', fontSize: 12, margin: '8px 0 0', fontWeight: 500 },
  inlineFix: {
    font: 'inherit',
    fontSize: 12,
    marginLeft: 8,
    padding: '1px 8px',
    borderRadius: 4,
    border: '1px solid currentColor',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  errorText: { color: 'var(--error-fg, #b91c1c)', margin: '8px 0' },
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
    marginBottom: 16,
  },
  pickers: { display: 'flex', gap: 12, flexWrap: 'wrap', margin: '12px 0 0' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 240px', minWidth: 0 },
  label: { fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--chrome-muted, #71717a)' },
  select: {
    font: 'inherit',
    padding: '4px 6px',
    borderRadius: 5,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    color: 'inherit',
    minWidth: 0,
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--chrome-bg, #f4f4f5)',
  },
  fileName: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  actions: { display: 'flex', gap: 8, marginTop: 16 },
  runningHead: { display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 },
  track: { height: 6, borderRadius: 3, background: 'var(--chrome-border, #d4d4d8)', overflow: 'hidden' },
  bar: { height: '100%', background: '#2563eb', transition: 'width .4s ease' },
  lastLine: {
    marginTop: 8,
    font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
    color: 'var(--chrome-muted, #71717a)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minHeight: '1.4em',
  },
  doneBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingBottom: 10,
    marginBottom: 8,
    borderBottom: '1px solid var(--chrome-border, #d4d4d8)',
  },
  meta: {
    flex: 1,
    minWidth: 0,
    color: 'var(--chrome-muted, #71717a)',
    fontSize: 12,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  savedPath: {
    font: 'inherit',
    fontSize: 12,
    maxWidth: 360,
    padding: '4px 10px',
    borderRadius: 5,
    border: '1px solid var(--ok-fg, #15803d)',
    background: 'transparent',
    color: 'var(--ok-fg, #16a34a)',
    cursor: 'pointer',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // The path shrinks and truncates; the "change" link beside it never does.
  folderLine: {
    display: 'flex',
    alignItems: 'baseline',
    margin: '-2px 0 10px',
    fontSize: 12,
    color: 'var(--chrome-muted, #71717a)',
  },
  folderPath: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  recent: { marginTop: 24, display: 'flex', flexDirection: 'column', gap: 2 },
  recentRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 12,
    font: 'inherit',
    padding: '6px 8px',
    margin: '0 -8px',
    border: 'none',
    borderRadius: 5,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
  },
  segments: { userSelect: 'text' },
  segment: { display: 'flex', gap: 10, margin: '0 0 8px', alignItems: 'baseline' },
  stamp: {
    flex: '0 0 auto',
    minWidth: 52,
    font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: '1px 4px',
    border: 'none',
    borderRadius: 4,
    background: 'transparent',
    color: 'var(--chrome-muted, #71717a)',
    cursor: 'pointer',
    textAlign: 'left',
  },
};

// ─── plugin ──────────────────────────────────────────────────

export const plugin: Plugin = {
  activate(ctx) {
    ctx.log.info('transcribe activating');
    ctx.registerPanel(PANEL_ID, definePanel(TranscribePanel));
    ctx.registerCommand('transcribe.open', () => ctx.workspace.openPanel(PANEL_ID));

    // Positional args in schema order: path, model, language (C5).
    ctx.registerCommand('transcribe.file', async (...args: unknown[]) => {
      const path = typeof args[0] === 'string' ? args[0] : '';
      const model = typeof args[1] === 'string' ? args[1] : '';
      const language = typeof args[2] === 'string' && args[2] !== '' ? args[2] : 'auto';
      await ctx.workspace.openPanel(PANEL_ID);
      requests.send(path === '' ? { kind: 'pick' } : { kind: 'run', path, model, language });
    });
  },

  deactivate() {
    // Registrations are the host's to unwind (invariant 8). Module state is
    // ours: a request no panel drained must not leak into the next activation.
    requests.clear();
  },
};
