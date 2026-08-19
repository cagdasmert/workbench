import type { PluginManifest } from '@workbench/plugin-sdk';

const MODIFIER_ORDER = ['cmd', 'alt', 'ctrl', 'shift'] as const;

export interface Binding {
  command: string;
  key: string;
  /** Where the effective value came from — what the rebind UI shows. */
  source: 'default' | 'user';
  defaultKey: string | undefined;
}

/** The chord a keyboard event represents, in the same canonical form manifests use. */
export function chordFromEvent(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  const key = e.key.toLowerCase();
  if (['meta', 'control', 'alt', 'shift'].includes(key)) return null;  // modifier alone

  const mods: string[] = [];
  if (e.metaKey) mods.push('cmd');
  if (e.altKey) mods.push('alt');
  if (e.ctrlKey) mods.push('ctrl');
  if (e.shiftKey) mods.push('shift');

  const named = key === ' ' ? 'space' : key;
  mods.sort((a, b) =>
    MODIFIER_ORDER.indexOf(a as typeof MODIFIER_ORDER[number])
    - MODIFIER_ORDER.indexOf(b as typeof MODIFIER_ORDER[number]));
  return [...mods, named].join('+');
}

/**
 * Merge declared defaults with user overrides. Overrides always win, and an
 * override of `''` means deliberately unbound — which is why this cannot be a
 * plain `{...defaults, ...overrides}`: an unbound command must disappear from
 * the chord map while still being listed in the UI as overridden.
 */
export function resolveBindings(
  manifests: PluginManifest[],
  shellDefaults: Array<{ command: string; key: string }>,
  overrides: Record<string, string>,
): Binding[] {
  const defaults = new Map<string, string>();
  for (const { command, key } of shellDefaults) defaults.set(command, key);
  for (const m of manifests) {
    for (const kb of m.contributes.keybindings ?? []) defaults.set(kb.command, kb.key);
  }

  const commands = new Set([...defaults.keys(), ...Object.keys(overrides)]);
  const out: Binding[] = [];

  for (const command of commands) {
    const defaultKey = defaults.get(command);
    const override = overrides[command];
    out.push({
      command,
      key: override ?? defaultKey ?? '',
      source: override === undefined ? 'default' : 'user',
      defaultKey,
    });
  }
  return out.sort((a, b) => a.command.localeCompare(b.command));
}

/** Chord → command, skipping unbound entries. Later wins on a conflict. */
export function chordMap(bindings: Binding[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of bindings) {
    if (b.key !== '') map.set(b.key, b.command);
  }
  return map;
}

/** Commands sharing a chord — surfaced in the UI rather than silently resolved. */
export function conflicts(bindings: Binding[]): Map<string, string[]> {
  const byChord = new Map<string, string[]>();
  for (const b of bindings) {
    if (b.key === '') continue;
    byChord.set(b.key, [...(byChord.get(b.key) ?? []), b.command]);
  }
  return new Map([...byChord].filter(([, cmds]) => cmds.length > 1));
}
