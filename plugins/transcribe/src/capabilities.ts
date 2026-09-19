/**
 * What can be picked, and what each model can actually hear.
 *
 * The model → language table mirrors `LANGUAGES` in the daemon's asr.py —
 * change the two together. The daemon refuses a bad pair too; this copy exists
 * so the warning appears *before* a run, where it can still change the choice
 * (PRD §6: a tool that quietly mistranscribes is worse than no tool).
 */

export const DEFAULT_MODEL = 'mlx-community/whisper-large-v3-turbo';

const PARAKEET_V3: ReadonlySet<string> = new Set([
  'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it',
  'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk',
]);

/** repo → the only languages it can transcribe, or null for "whatever Whisper knows". */
export const LANGUAGES: Readonly<Record<string, ReadonlySet<string> | null>> = {
  'mlx-community/whisper-large-v3-turbo': null,
  'mlx-community/whisper-large-v3-mlx': null,
  'mlx-community/parakeet-tdt-0.6b-v3': PARAKEET_V3,
};

export interface LanguageWarning {
  /** `block` disables the run; `caution` only says what could go wrong. */
  level: 'block' | 'caution';
  message: string;
}

export function checkLanguage(repo: string, language: string): LanguageWarning | null {
  const supported = LANGUAGES[repo];
  if (supported === undefined || supported === null) return null;
  const name = modelLabel(repo);
  if (language === 'auto') {
    return {
      level: 'caution',
      message: `${name} only knows ${supported.size} European languages. Turkish audio comes back `
        + 'as confident, wrong words — not an error.',
    };
  }
  if (supported.has(language)) return null;
  return {
    level: 'block',
    message: `${name} can't transcribe ${languageLabel(language)} — it would return plausible `
      + 'wrong words instead of failing.',
  };
}

export interface ModelChoice {
  repo: string;
  label: string;
  note: string;
}

/** PRD §6. Order is the order of preference for this user. */
export const MODELS: readonly ModelChoice[] = [
  { repo: 'mlx-community/whisper-large-v3-turbo', label: 'Whisper large-v3 turbo', note: '1.6 GB · ~99 languages' },
  { repo: 'mlx-community/parakeet-tdt-0.6b-v3', label: 'Parakeet TDT 0.6B v3', note: '2.5 GB · 25 European, no Turkish · fastest' },
  { repo: 'mlx-community/whisper-large-v3-mlx', label: 'Whisper large-v3', note: '3 GB · ~99 languages · most accurate' },
];

export interface LanguageChoice {
  code: string;
  label: string;
}

/** What this user actually speaks, above the fold. */
export const PINNED_LANGUAGES: readonly LanguageChoice[] = [
  { code: 'auto', label: 'Detect automatically' },
  { code: 'tr', label: 'Turkish' },
  { code: 'en', label: 'English' },
];

/** Parakeet's 25 (minus English) plus a few Whisper-only ones, by name. */
export const OTHER_LANGUAGES: readonly LanguageChoice[] = [
  { code: 'ar', label: 'Arabic' },
  { code: 'bg', label: 'Bulgarian' },
  { code: 'zh', label: 'Chinese' },
  { code: 'hr', label: 'Croatian' },
  { code: 'cs', label: 'Czech' },
  { code: 'da', label: 'Danish' },
  { code: 'nl', label: 'Dutch' },
  { code: 'et', label: 'Estonian' },
  { code: 'fi', label: 'Finnish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'el', label: 'Greek' },
  { code: 'hu', label: 'Hungarian' },
  { code: 'it', label: 'Italian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'lv', label: 'Latvian' },
  { code: 'lt', label: 'Lithuanian' },
  { code: 'mt', label: 'Maltese' },
  { code: 'fa', label: 'Persian' },
  { code: 'pl', label: 'Polish' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ro', label: 'Romanian' },
  { code: 'ru', label: 'Russian' },
  { code: 'sk', label: 'Slovak' },
  { code: 'sl', label: 'Slovenian' },
  { code: 'es', label: 'Spanish' },
  { code: 'sv', label: 'Swedish' },
  { code: 'uk', label: 'Ukrainian' },
];

export function languageLabel(code: string | null): string {
  if (code === null) return 'unknown language';
  return [...PINNED_LANGUAGES, ...OTHER_LANGUAGES].find((l) => l.code === code)?.label ?? code;
}

export function modelLabel(repo: string): string {
  return MODELS.find((m) => m.repo === repo)?.label ?? repo;
}
