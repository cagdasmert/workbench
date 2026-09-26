import type { GenerateRequest, ImageModel } from './client.js';
import { shortModel } from './history.js';

/** The manifest's default for the `model` setting, copied verbatim. */
export const DEFAULT_GENERATE_MODEL = 'mflux-community/z-image-turbo-mflux-q8';

export const MAX_SEED = 2 ** 31 - 1;

/**
 * The Generate form as the panel holds it. Numbers stay text as typed, so a
 * half-typed value is not lost; they become numbers only in the request.
 */
export type GenerateForm = {
  prompt: string;
  negative: string;
  model: string;
  steps: string;
  width: string;
  height: string;
  seed: string;
  /** Locked: every run sends `seed`. Unlocked: every run is random. */
  seedLocked: boolean;
};

export function emptyForm(model: string): GenerateForm {
  return { prompt: '', negative: '', model, steps: '', width: '', height: '', seed: '', seedLocked: false };
}

/** A model given as a folder, rather than a repo id modelctl finds (spec decision 5). */
export function isPath(model: string): boolean {
  return model.startsWith('/') || model.startsWith('~');
}

export type ModelOption = {
  value: string;
  label: string;
  /** How to run it; null for a folder path, or a repo that is not downloaded. */
  info: ImageModel | null;
  /** A repo id the catalog does not have: the daemon would answer 404. */
  missing: boolean;
};

/**
 * The model select: every downloaded model for `role`, plus the configured one
 * when the catalog does not list it. A folder path is never marked missing,
 * because the catalog cannot know about it (spec decision 5).
 */
export function modelOptions(catalog: readonly ImageModel[], configured: string, role: ImageModel['role']): ModelOption[] {
  const rows = catalog.filter((m) => m.role === role);
  const options: ModelOption[] = rows.map((m) => ({ value: m.repo, label: shortModel(m.repo), info: m, missing: false }));
  if (configured !== '' && !rows.some((m) => m.repo === configured)) {
    const missing = !isPath(configured);
    options.unshift({
      value: configured,
      label: missing ? `${shortModel(configured)} — not downloaded` : shortModel(configured),
      info: null,
      missing,
    });
  }
  return options;
}

type Parsed = { ok: true; value: number | undefined } | { ok: false; error: string };

function wholeNumber(name: string, text: string): Parsed {
  const t = text.trim();
  if (t === '') return { ok: true, value: undefined };
  if (!/^\d+$/.test(t)) return { ok: false, error: `${name} must be a whole number` };
  return { ok: true, value: Number(t) };
}

export type FormResult = { ok: true; req: GenerateRequest } | { ok: false; error: string };

/**
 * The form as a POST body. Ranges are the daemon's to check, and its 400 names
 * the limit, so this refuses only what cannot be sent at all. An unlocked seed
 * is left out, which the daemon reads as random.
 */
export function toGenerateRequest(form: GenerateForm, opts: { negative: boolean; outDir: string }): FormResult {
  const prompt = form.prompt.trim();
  if (prompt === '') return { ok: false, error: 'Write a prompt first.' };
  const steps = wholeNumber('Steps', form.steps);
  if (!steps.ok) return steps;
  const width = wholeNumber('Width', form.width);
  if (!width.ok) return width;
  const height = wholeNumber('Height', form.height);
  if (!height.ok) return height;
  const seed: Parsed = form.seedLocked ? wholeNumber('Seed', form.seed) : { ok: true, value: undefined };
  if (!seed.ok) return seed;
  const negative = opts.negative ? form.negative.trim() : '';
  const outDir = opts.outDir.trim();
  return {
    ok: true,
    req: {
      prompt,
      model: form.model,
      ...(negative === '' ? {} : { negative }),
      ...(steps.value === undefined ? {} : { steps: steps.value }),
      ...(width.value === undefined ? {} : { width: width.value }),
      ...(height.value === undefined ? {} : { height: height.value }),
      ...(seed.value === undefined ? {} : { seed: seed.value }),
      ...(outDir === '' ? {} : { out_dir: outDir }),
    },
  };
}

/**
 * imagegen.generate's positional args, in schema order: prompt, model, steps,
 * seed (C5). 0 and '' mean "not set", as the manifest declares.
 */
export function commandRequest(args: readonly unknown[], settings: { model: string; outDir: string }): FormResult {
  const [prompt, model, steps, seed] = args;
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, error: 'imagegen.generate needs a prompt.' };
  }
  const positive = (v: unknown): number | undefined =>
    (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);
  const stepsV = positive(steps);
  const seedV = positive(seed);
  const outDir = settings.outDir.trim();
  return {
    ok: true,
    req: {
      prompt: prompt.trim(),
      model: typeof model === 'string' && model.trim() !== '' ? model.trim() : settings.model,
      ...(stepsV === undefined ? {} : { steps: stepsV }),
      ...(seedV === undefined ? {} : { seed: seedV }),
      ...(outDir === '' ? {} : { out_dir: outDir }),
    },
  };
}

/** A random seed the daemon accepts: 1..MAX_SEED. */
export function rollSeed(random: () => number = Math.random): number {
  return 1 + Math.floor(random() * MAX_SEED);
}

/** A field the daemon would accept as a fixed seed: trimmed, and a positive whole number. */
function isLockableSeed(text: string): boolean {
  const t = text.trim();
  return /^\d+$/.test(t) && Number(t) > 0;
}

/**
 * After a run: the form keeps its seed only when it was locked on a seed the
 * run could actually have used. Otherwise — unlocked, or locked on something
 * that is not a positive whole number, such as an empty field or '0' — the
 * field is overwritten with the seed the run used, so it can be locked
 * afterwards to reproduce the image. `seedLocked` is never changed here.
 */
export function afterRun(form: GenerateForm, usedSeed: number): GenerateForm {
  if (form.seedLocked && isLockableSeed(form.seed)) return form;
  return { ...form, seed: String(usedSeed) };
}

/**
 * The 🔒 button. Unlocking just flips the flag; the field is left alone.
 * Locking also fills the field when it is not already a positive whole
 * number, so "lock, then generate twice" reproduces the same image.
 */
export function toggleLock(form: GenerateForm, random: () => number = Math.random): GenerateForm {
  if (form.seedLocked) return { ...form, seedLocked: false };
  if (isLockableSeed(form.seed)) return { ...form, seedLocked: true };
  return { ...form, seed: String(rollSeed(random)), seedLocked: true };
}

/** The model's own defaults, shown as placeholders so an empty field is not a mystery (criterion 1). */
export function placeholders(info: ImageModel | null): { steps: string; width: string; height: string } {
  const show = (v: number | null | undefined): string => (v === null || v === undefined ? 'default' : String(v));
  return { steps: show(info?.defaults.steps), width: show(info?.defaults.width), height: show(info?.defaults.height) };
}

/** `percent` is null exactly while the model loads (spec decision 7). */
export function runStatus(percent: number | null): string {
  return percent === null ? 'Loading model…' : `Generating ${Math.round(percent)}%`;
}
