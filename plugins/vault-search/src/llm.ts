import type { PluginContext } from '@workbench/plugin-sdk';
import { cleanAnswer, pickLoadedModel, type ChatMessage } from './answer.js';
import { asDaemonError, type VaultClient } from './client.js';

/**
 * Where an answer comes from. LM Studio first — it is already the local
 * workhorse, and whatever model is loaded there is the one the user chose —
 * then the daemon's text.py when LM Studio is not there to ask.
 *
 * "Not there" means unreachable, or reachable with no model loaded and none
 * named. An error LM Studio *returns* is shown, not rerouted: a model that
 * failed on this prompt is information, and quietly answering with a smaller
 * model instead would hide it.
 */

export interface AnswerSettings {
  answerUrl: string;
  /** An LM Studio model id; empty means whichever model LM Studio has loaded. */
  answerModel: string;
  /** A catalog repo for text.py. */
  fallbackModel: string;
}

export interface Answer {
  text: string;
  model: string;
  backend: 'lmstudio' | 'daemon';
}

export class AnswerError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'AnswerError';
  }
}

const MAX_TOKENS = 1_024;

interface ChatResponse {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: unknown }>;
  error?: { message?: unknown } | string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Throws only for a denied host; any other failure to connect means "not there". */
async function reach(ctx: PluginContext, url: string, init: Parameters<PluginContext['net']['fetch']>[1]) {
  try {
    return await ctx.net.fetch(url, init);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/denied/i.test(message)) {
      throw new AnswerError(`${url} is not in this plugin's net:fetch permissions.`,
        'answerUrl can only point at localhost:1234 or 127.0.0.1:1234 — anything else needs a new entry in plugins/vault-search/plugin.json.');
    }
    return null;
  }
}

async function viaLmStudio(ctx: PluginContext, s: AnswerSettings, messages: ChatMessage[],
  onStage: (stage: string) => void): Promise<Answer | 'absent'> {
  const base = s.answerUrl.replace(/\/$/, '');
  let model = s.answerModel;
  if (model === '') {
    onStage('Asking LM Studio which model is loaded…');
    // LM Studio's own REST API; the OpenAI-compatible /v1/models lists every
    // downloaded model, loaded or not, which cannot tell us what to ask.
    const res = await reach(ctx, `${new URL(base).origin}/api/v0/models`, { timeoutMs: 5_000 });
    if (res === null || !res.ok) return 'absent';
    try {
      model = pickLoadedModel(JSON.parse(res.body)) ?? '';
    } catch {
      return 'absent';
    }
    if (model === '') return 'absent';
  }

  onStage(`Asking ${model} in LM Studio…`);
  const res = await reach(ctx, `${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: MAX_TOKENS, stream: false }),
    // A named model that is not loaded yet is JIT-loaded first: tens of seconds for a 30B.
    timeoutMs: 180_000,
  });
  if (res === null) return 'absent';

  let parsed: ChatResponse;
  try {
    parsed = JSON.parse(res.body) as ChatResponse;
  } catch {
    throw new AnswerError(`LM Studio answered ${res.status} with a non-JSON body.`);
  }
  if (!res.ok) {
    const detail = typeof parsed.error === 'string' ? parsed.error
      : typeof parsed.error?.message === 'string' ? parsed.error.message : `HTTP ${res.status}`;
    throw new AnswerError(`LM Studio: ${detail}`, s.answerModel === '' ? undefined : 'Check the answerModel setting.');
  }
  const choice = parsed.choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== 'string') throw new AnswerError('LM Studio returned no answer text.');
  if (cleanAnswer(text) === '') {
    // A reasoning model can spend the whole budget thinking and never answer.
    throw new AnswerError(
      choice?.finish_reason === 'length'
        ? `${model} used its whole ${MAX_TOKENS}-token budget before answering.`
        : `${model} returned an empty answer.`,
      typeof choice?.message?.reasoning_content === 'string'
        ? 'It is a reasoning model: load a non-reasoning one in LM Studio, or name one in the answerModel setting.'
        : undefined,
    );
  }
  return { text, model: typeof parsed.model === 'string' ? parsed.model : model, backend: 'lmstudio' };
}

async function viaDaemon(client: VaultClient, s: AnswerSettings, messages: ChatMessage[],
  isCurrent: () => boolean): Promise<Answer | null> {
  let job;
  try {
    job = await client.generateText({ messages, model: s.fallbackModel, max_tokens: MAX_TOKENS });
    while (job.state === 'running') {
      await sleep(1_000);
      if (!isCurrent()) return null;
      job = await client.textJob(job.id);
    }
  } catch (err: unknown) {
    const e = asDaemonError(err);
    throw new AnswerError(e.message, e.hint);
  }
  if (job.state !== 'done' || job.result == null) {
    throw new AnswerError(`${s.fallbackModel} failed: ${job.error ?? job.state}`);
  }
  return { text: job.result.text, model: job.result.model, backend: 'daemon' };
}

/**
 * Resolves to null when the caller moved on (`isCurrent()` went false) — a
 * newer search owns the answer box now, and this one must not write to it.
 */
export async function answerWith(
  ctx: PluginContext,
  client: VaultClient,
  settings: AnswerSettings,
  messages: ChatMessage[],
  onStage: (stage: string) => void,
  isCurrent: () => boolean,
): Promise<Answer | null> {
  const first = await viaLmStudio(ctx, settings, messages, onStage);
  if (first !== 'absent') return first;
  if (!isCurrent()) return null;
  onStage(`LM Studio has no model to ask — answering with ${settings.fallbackModel} in modelctld…`);
  return viaDaemon(client, settings, messages, isCurrent);
}
