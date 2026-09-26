import { describe, expect, it } from 'vitest';
import type { ImageModel } from './client.js';
import {
  afterRun, commandRequest, DEFAULT_GENERATE_MODEL, emptyForm, MAX_SEED, modelOptions, placeholders,
  rollSeed, runStatus, toGenerateRequest, type GenerateForm,
} from './form.js';

const Z: ImageModel = {
  repo: DEFAULT_GENERATE_MODEL, family: 'z-image-turbo', role: 'generate', negative: false,
  defaults: { steps: 9, width: 1024, height: 1024 },
};
const QWEN: ImageModel = {
  repo: 'mflux-community/qwen-image-edit-2511-mflux-q6', family: 'qwen-image-edit', role: 'edit', negative: false,
  defaults: { steps: 20, width: null, height: null },
};

const form = (patch: Partial<GenerateForm>): GenerateForm => ({ ...emptyForm(DEFAULT_GENERATE_MODEL), ...patch });
const opts = { negative: false, outDir: '' };

describe('toGenerateRequest', () => {
  it('sends only the prompt and model when nothing else is set, leaving steps to the model (criterion 1)', () => {
    expect(toGenerateRequest(form({ prompt: '  a green gate ' }), opts))
      .toEqual({ ok: true, req: { prompt: 'a green gate', model: DEFAULT_GENERATE_MODEL } });
  });

  it('sends every field that is set', () => {
    const f = form({ prompt: 'x', steps: '12', width: '768', height: '512', seed: '7', seedLocked: true, negative: 'blur' });
    expect(toGenerateRequest(f, { negative: true, outDir: ' /pics ' })).toEqual({
      ok: true,
      req: {
        prompt: 'x', model: DEFAULT_GENERATE_MODEL, negative: 'blur', steps: 12, width: 768, height: 512,
        seed: 7, out_dir: '/pics',
      },
    });
  });

  it('leaves an unlocked seed out, which the daemon reads as random', () => {
    expect(toGenerateRequest(form({ prompt: 'x', seed: '7', seedLocked: false }), opts))
      .toEqual({ ok: true, req: { prompt: 'x', model: DEFAULT_GENERATE_MODEL } });
  });

  it('drops a negative prompt the model cannot take', () => {
    expect(toGenerateRequest(form({ prompt: 'x', negative: 'blur' }), opts))
      .toEqual({ ok: true, req: { prompt: 'x', model: DEFAULT_GENERATE_MODEL } });
  });

  it('refuses what cannot be sent at all', () => {
    expect(toGenerateRequest(form({ prompt: '   ' }), opts)).toEqual({ ok: false, error: 'Write a prompt first.' });
    expect(toGenerateRequest(form({ prompt: 'x', steps: '9a' }), opts))
      .toEqual({ ok: false, error: 'Steps must be a whole number' });
  });
});

describe('commandRequest', () => {
  const settings = { model: DEFAULT_GENERATE_MODEL, outDir: '' };

  it('takes the configured model for an empty one, and treats 0 as not set (the manifest says so)', () => {
    expect(commandRequest(['a gate', '', 0, 0], settings))
      .toEqual({ ok: true, req: { prompt: 'a gate', model: DEFAULT_GENERATE_MODEL } });
    expect(commandRequest(['a gate'], settings))
      .toEqual({ ok: true, req: { prompt: 'a gate', model: DEFAULT_GENERATE_MODEL } });
  });

  it('passes a model, steps, seed and the output folder through', () => {
    expect(commandRequest(['a gate', '/m/z-image-turbo', 4, 9], { model: 'x', outDir: '/pics' })).toEqual({
      ok: true, req: { prompt: 'a gate', model: '/m/z-image-turbo', steps: 4, seed: 9, out_dir: '/pics' },
    });
  });

  it('needs a prompt', () => {
    expect(commandRequest([], settings)).toEqual({ ok: false, error: 'imagegen.generate needs a prompt.' });
  });
});

describe('modelOptions', () => {
  it('lists the downloaded models for the role', () => {
    expect(modelOptions([Z, QWEN], DEFAULT_GENERATE_MODEL, 'generate')).toEqual([
      { value: DEFAULT_GENERATE_MODEL, label: 'z-image-turbo-mflux-q8', info: Z, missing: false },
    ]);
  });

  it('puts a configured repo the catalog lacks first, marked not downloaded', () => {
    const [first] = modelOptions([Z], 'org/z-image-turbo-other', 'generate');
    expect(first).toEqual({ value: 'org/z-image-turbo-other', label: 'z-image-turbo-other — not downloaded', info: null, missing: true });
  });

  it('never marks a folder path missing: the catalog cannot know about it', () => {
    const [first] = modelOptions([Z], '/Users/me/models/z-image-turbo-q8', 'generate');
    expect(first).toEqual({ value: '/Users/me/models/z-image-turbo-q8', label: 'z-image-turbo-q8', info: null, missing: false });
  });
});

describe('seed, placeholders and status', () => {
  it('rolls a seed in 1..MAX_SEED', () => {
    expect(rollSeed(() => 0)).toBe(1);
    expect(rollSeed(() => 0.999_999_999)).toBeLessThanOrEqual(MAX_SEED);
  });

  it('shows the seed a run used when the seed is unlocked, and keeps a locked one', () => {
    expect(afterRun(form({ seed: '' }), 42).seed).toBe('42');
    expect(afterRun(form({ seed: '7', seedLocked: true }), 42).seed).toBe('7');
  });

  it("shows the model's own defaults as placeholders", () => {
    expect(placeholders(Z)).toEqual({ steps: '9', width: '1024', height: '1024' });
    expect(placeholders(null)).toEqual({ steps: 'default', width: 'default', height: 'default' });
  });

  it('says "Loading model…" exactly while percent is null (spec decision 7)', () => {
    expect(runStatus(null)).toBe('Loading model…');
    expect(runStatus(33.4)).toBe('Generating 33%');
  });
});
