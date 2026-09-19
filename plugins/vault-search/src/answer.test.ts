import { describe, expect, it } from 'vitest';
import type { Hit } from './client.js';
import { MAX_PASSAGES, answerMarkdown, buildMessages, cleanAnswer, hitsMarkdown, parseAnswer, pickLoadedModel } from './answer.js';

function hit(n: number, over: Partial<Hit> = {}): Hit {
  return {
    folder: 'Calismalar',
    path: `/v/Calismalar/notes/Note ${n}.md`,
    rel_path: `notes/Note ${n}.md`,
    title: `Note ${n}`,
    heading: '',
    chunk: `passage ${n}`,
    score: 0.5,
    start_line: 1,
    ...over,
  };
}

describe('buildMessages', () => {
  it('numbers passages as the cards are numbered, with title and section', () => {
    const [system, user] = buildMessages('Kepek için ne kullanılır?', [
      hit(1, { heading: 'Note 1 › Tedavi', chunk: 'Ketokonazol şampuan.' }),
      hit(2),
    ]);
    expect(system?.role).toBe('system');
    expect(system?.content).toMatch(/\[n\]/);
    expect(system?.content).toMatch(/language of the question/);
    expect(user?.content).toContain('[1] Note 1 › Tedavi\nKetokonazol şampuan.');
    expect(user?.content).toContain('[2] Note 2\npassage 2');
    expect(user?.content.trimEnd().endsWith('Question: Kepek için ne kullanılır?')).toBe(true);
  });

  it('sends at most MAX_PASSAGES passages, each cut to size', () => {
    const hits = Array.from({ length: 10 }, (_, i) => hit(i + 1, { chunk: 'x'.repeat(5_000) }));
    const user = buildMessages('q', hits)[1]?.content ?? '';
    expect(user).toContain(`[${MAX_PASSAGES}]`);
    expect(user).not.toContain(`[${MAX_PASSAGES + 1}]`);
    expect(user.length).toBeLessThan(MAX_PASSAGES * 1_300 + 500);
  });
});

describe('parseAnswer', () => {
  it('splits single, comma and adjacent citations', () => {
    expect(parseAnswer('A [1]. B [2, 3] and C[1][3].', 3)).toEqual([
      { text: 'A ' }, { cite: 1 }, { text: '. B ' }, { cite: 2 }, { cite: 3 },
      { text: ' and C' }, { cite: 1 }, { cite: 3 }, { text: '.' },
    ]);
  });

  it('leaves out-of-range numbers as the text the model wrote', () => {
    expect(parseAnswer('See [7] and [0].', 3)).toEqual([{ text: 'See [7] and [0].' }]);
  });

  it('cuts a reply at a leaked chat-template token', () => {
    // GLM-4.7-flash in LM Studio does not stop at its turn: it writes the next
    // user turn itself until max_tokens.
    expect(parseAnswer('Ketokonazol şampuan [1].<|user|>\nSoru: …\nModel: …', 1)).toEqual([
      { text: 'Ketokonazol şampuan ' }, { cite: 1 }, { text: '.' },
    ]);
    expect(parseAnswer('Cevap.<|im_end|>\n<|im_start|>user', 1)).toEqual([{ text: 'Cevap.' }]);
  });

  it('strips reasoning blocks first', () => {
    expect(parseAnswer('<think>let me see [2]</think>\nCevap [1].', 2)).toEqual([
      { text: 'Cevap ' }, { cite: 1 }, { text: '.' },
    ]);
  });
});

describe('cleanAnswer', () => {
  it('is empty when the model only thought', () => {
    expect(cleanAnswer('<think>still going')).toBe('');
    expect(cleanAnswer('<|assistant|>')).toBe('');
  });
});

describe('pickLoadedModel', () => {
  it('takes the first loaded llm, never an embedding model', () => {
    const v0 = {
      data: [
        { id: 'text-embedding-nomic', type: 'embeddings', state: 'loaded' },
        { id: 'qwen/qwen3-coder-30b', type: 'llm', state: 'not-loaded' },
        { id: 'zai-org/glm-4.7-flash', type: 'llm', state: 'loaded' },
      ],
    };
    expect(pickLoadedModel(v0)).toBe('zai-org/glm-4.7-flash');
  });

  it('is null for nothing loaded or a shape it does not know', () => {
    expect(pickLoadedModel({ data: [{ id: 'a', type: 'llm', state: 'not-loaded' }] })).toBeNull();
    expect(pickLoadedModel('nope')).toBeNull();
    expect(pickLoadedModel({ data: 'x' })).toBeNull();
  });
});

describe('markdown for the bus', () => {
  it('turns citations into wikilinks and lists the sources', () => {
    const md = answerMarkdown('Soru?', 'Cevap [2].', [hit(1), hit(2)]);
    expect(md).toContain('> Soru?');
    expect(md).toContain('Cevap [[Note 2]].');
    expect(md).toContain('## Sources');
    expect(md).toContain('1. [[Note 1]] — Calismalar');
  });

  it('lists hits as wikilinks when there is no answer', () => {
    const md = hitsMarkdown('Soru?', [hit(1)]);
    expect(md).toContain('- [[Note 1]] — Calismalar');
    expect(md).not.toContain('## Sources');
  });
});
