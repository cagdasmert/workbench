import type { PluginContext } from '@workbench/plugin-sdk';

/**
 * The load-bearing part of `ai-layer-options.md` §4 — not the Ollama client
 * below it.
 *
 * If every AI-consuming plugin talks only to this, then Ollama-direct, a DeepSeek
 * Harness sidecar, a cloud API, or something that doesn't exist yet are all
 * interchangeable. Without it, the choice made today is the choice forever.
 *
 * Deliberately NOT in `@workbench/plugin-sdk`: the moment the shell exposes AI,
 * the app stops working offline and every plugin can reach a model implicitly.
 * AI is a plugin. Other plugins reach it through the content bus.
 */
export interface AiProvider {
  readonly id: string;
  complete(req: CompletionRequest): Promise<Completion>;
  capabilities(): Capabilities;
}

/**
 * M3+ only, implemented by a DSH sidecar if one ever arrives. Absent under
 * Option C — recorded here so the seam is visible rather than invented later.
 */
export interface AgentProvider extends AiProvider {
  startSession(opts: unknown): Promise<unknown>;
}

export interface CompletionRequest {
  system?: string;
  prompt: string;
  model?: string;
  temperature?: number;
}

export interface Completion {
  text: string;
  model: string;
}

export interface Capabilities {
  tools: boolean;
  vision: boolean;
  streaming: boolean;
}

/**
 * Known local servers. Both speak the OpenAI chat-completions API, so the only
 * difference is an endpoint and a default model — adding a third (vLLM, llama.cpp,
 * a cloud endpoint) is a row here, not code.
 */
export const BACKENDS = {
  lmstudio: {
    label: 'LM Studio',
    endpoint: 'http://localhost:1234/v1',
    defaultModel: 'liquid/lfm2.5-1.2b',
    hint: 'Start the server from LM Studio → Developer → Start Server.',
  },
  ollama: {
    label: 'Ollama',
    endpoint: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    hint: 'Run `ollama serve`, then `ollama pull llama3.2`.',
  },
} as const;

export type BackendId = keyof typeof BACKENDS;

export const DEFAULT_BACKEND: BackendId = 'lmstudio';

export function isBackendId(v: unknown): v is BackendId {
  return typeof v === 'string' && v in BACKENDS;
}

interface ChatChoice { message?: { content?: unknown } }
interface ChatResponse { choices?: ChatChoice[]; model?: unknown; error?: { message?: unknown } }

/**
 * OpenAI-compatible chat client. Ollama, LM Studio, and vLLM all speak this, so
 * "which runtime" is configuration rather than code.
 *
 * `stream()` from the architecture sketch is deliberately absent: streaming over
 * the IPC broker needs an event-channel design, and nothing on the backlog needs
 * it yet — text→mermaid and explain-this-JSON are one-shot completions. Adding it
 * later is a minor bump.
 */
export function createOpenAiCompatibleProvider(
  ctx: PluginContext,
  options: { backend?: BackendId; model?: string } = {},
): AiProvider {
  const backend = BACKENDS[options.backend ?? DEFAULT_BACKEND];
  const endpoint = backend.endpoint;
  const model = options.model !== undefined && options.model !== ''
    ? options.model
    : backend.defaultModel;

  return {
    id: `openai-compatible:${endpoint}`,

    capabilities() {
      return { tools: false, vision: false, streaming: false };
    },

    async complete(req: CompletionRequest): Promise<Completion> {
      const messages = [
        ...(req.system === undefined ? [] : [{ role: 'system', content: req.system }]),
        { role: 'user', content: req.prompt },
      ];

      const res = await ctx.net.fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: req.model ?? model,
          messages,
          temperature: req.temperature ?? 0.2,
          stream: false,
        }),
        timeoutMs: 120_000,
      });

      let parsed: ChatResponse;
      try {
        parsed = JSON.parse(res.body) as ChatResponse;
      } catch {
        throw new Error(
          `${endpoint} returned ${res.status} with a non-JSON body: `
          + `${res.body.slice(0, 160)}`,
        );
      }

      if (!res.ok) {
        const detail = typeof parsed.error?.message === 'string'
          ? parsed.error.message
          : `HTTP ${res.status}`;
        throw new Error(`${endpoint} — ${detail}`);
      }

      const text = parsed.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw new Error(`${endpoint} returned no completion text`);
      }

      return {
        text,
        model: typeof parsed.model === 'string' ? parsed.model : (req.model ?? model),
      };
    },
  };
}

/** `/v1/models` is part of the OpenAI-compatible surface both servers implement. */
export async function listModels(ctx: PluginContext, backend: BackendId): Promise<string[]> {
  const res = await ctx.net.fetch(`${BACKENDS[backend].endpoint}/models`, { timeoutMs: 5_000 });
  if (!res.ok) throw new Error(`${BACKENDS[backend].label} returned HTTP ${res.status}`);
  const parsed: unknown = JSON.parse(res.body);
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (m as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string')
    .sort();
}

const MERMAID_SYSTEM = `You convert prose into a single Mermaid diagram.
Reply with ONLY the mermaid source — no prose, no explanation, no markdown fences.
Start with a diagram type such as "graph TD", "sequenceDiagram", or "flowchart LR".`;

/** Models wrap output in fences no matter how firmly you ask them not to. */
export function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:mermaid)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

export async function textToMermaid(provider: AiProvider, text: string): Promise<string> {
  const { text: raw } = await provider.complete({
    system: MERMAID_SYSTEM,
    prompt: text,
  });
  return stripFences(raw);
}
