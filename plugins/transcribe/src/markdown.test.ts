import { describe, expect, it } from 'vitest';
import { transcriptMarkdown } from './markdown.js';
import type { Transcript } from './client.js';

const result: Transcript = {
  text: 'Merhaba dünya. İkinci cümle.',
  segments: [
    { start: 0, end: 2, text: ' Merhaba dünya. ' },
    { start: 65, end: 70, text: 'İkinci cümle.' },
    { start: 70, end: 71, text: '   ' },
  ],
  language: 'tr',
  duration: 71,
  model: 'mlx-community/whisper-large-v3-turbo',
};

describe('transcriptMarkdown — the body asr.render_markdown writes, minus front matter', () => {
  it('has a heading and timestamped paragraphs', () => {
    expect(transcriptMarkdown(result, { title: 'memo', timestamps: true }))
      .toBe('# memo\n\n[00:00] Merhaba dünya.\n\n[01:05] İkinci cümle.\n');
  });

  it('drops the timestamps when asked', () => {
    expect(transcriptMarkdown(result, { title: 'memo', timestamps: false }))
      .toBe('# memo\n\nMerhaba dünya.\n\nİkinci cümle.\n');
  });
});
