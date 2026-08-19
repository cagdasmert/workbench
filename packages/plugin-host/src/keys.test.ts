import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '@workbench/plugin-sdk';
import { chordFromEvent, chordMap, conflicts, resolveBindings } from './keys.js';

function manifest(keybindings: Array<{ command: string; key: string }>): PluginManifest {
  return {
    id: 'p', name: 'P', version: '1.0.0', apiVersion: '1.0', main: './dist/index.js',
    activationEvents: [], contributes: { keybindings },
  };
}

const ev = (over: Partial<Parameters<typeof chordFromEvent>[0]>) => chordFromEvent({
  key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over,
});

describe('chordFromEvent', () => {
  it('orders modifiers canonically regardless of which are held', () => {
    expect(ev({ metaKey: true })).toBe('cmd+k');
    expect(ev({ metaKey: true, shiftKey: true })).toBe('cmd+shift+k');
    expect(ev({ shiftKey: true, altKey: true, metaKey: true })).toBe('cmd+alt+shift+k');
  });

  it('ignores a modifier pressed on its own', () => {
    expect(ev({ key: 'Meta', metaKey: true })).toBeNull();
    expect(ev({ key: 'Shift', shiftKey: true })).toBeNull();
  });

  it('names the space key', () => {
    expect(ev({ key: ' ', metaKey: true })).toBe('cmd+space');
  });
});

describe('resolveBindings', () => {
  it('lets a user override beat a plugin default', () => {
    const resolved = resolveBindings(
      [manifest([{ command: 'json.format', key: 'cmd+shift+f' }])],
      [],
      { 'json.format': 'cmd+alt+f' },
    );
    expect(resolved).toEqual([{
      command: 'json.format', key: 'cmd+alt+f', source: 'user', defaultKey: 'cmd+shift+f',
    }]);
  });

  it('keeps a new plugin default when the user never overrode it', () => {
    // the update-safety property: defaults are never snapshotted into the
    // override file, so a changed default simply takes effect
    const resolved = resolveBindings(
      [manifest([{ command: 'json.format', key: 'cmd+alt+j' }])],
      [],
      {},
    );
    expect(resolved[0]?.key).toBe('cmd+alt+j');
    expect(resolved[0]?.source).toBe('default');
  });

  it('treats an empty override as deliberately unbound, not missing', () => {
    const resolved = resolveBindings(
      [manifest([{ command: 'json.format', key: 'cmd+shift+f' }])],
      [],
      { 'json.format': '' },
    );
    expect(resolved[0]).toMatchObject({ key: '', source: 'user', defaultKey: 'cmd+shift+f' });
    // unbound disappears from the chord map but stays listed for the UI
    expect(chordMap(resolved).size).toBe(0);
  });

  it('lists a command bound only by the user, with no default', () => {
    const resolved = resolveBindings([], [], { 'shell.openSettings': 'cmd+,' });
    expect(resolved[0]).toEqual({
      command: 'shell.openSettings', key: 'cmd+,', source: 'user', defaultKey: undefined,
    });
  });

  it('reports conflicting chords instead of silently picking one', () => {
    const resolved = resolveBindings(
      [manifest([{ command: 'a', key: 'cmd+k' }, { command: 'b', key: 'cmd+k' }])],
      [],
      {},
    );
    expect([...conflicts(resolved).entries()]).toEqual([['cmd+k', ['a', 'b']]]);
  });
});
