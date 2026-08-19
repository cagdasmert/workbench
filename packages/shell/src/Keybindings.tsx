import { useState } from 'react';
import type { Binding, CommandDescriptor } from '@workbench/plugin-host';
import { chordFromEvent, conflicts } from '@workbench/plugin-host';

function pretty(chord: string): string {
  if (chord === '') return '—';
  return chord
    .split('+')
    .map((part) => ({ cmd: '⌘', alt: '⌥', ctrl: '⌃', shift: '⇧' }[part] ?? part.toUpperCase()))
    .join('');
}

export function Keybindings({
  bindings,
  commands,
  onSet,
  onClose,
}: {
  bindings: Binding[];
  commands: CommandDescriptor[];
  onSet: (command: string, key: string | null) => void;
  onClose: () => void;
}) {
  const [recording, setRecording] = useState<string | null>(null);
  const clash = conflicts(bindings);

  const titleFor = (id: string) => commands.find((c) => c.id === id)?.title ?? id;

  // Commands with no binding at all are still listed — you cannot rebind what
  // the UI refuses to show.
  const rows: Binding[] = [
    ...bindings,
    ...commands
      .filter((c) => !bindings.some((b) => b.command === c.id))
      .map((c): Binding => ({
        command: c.id, key: '', source: 'default', defaultKey: undefined,
      })),
  ].sort((a, b) => titleFor(a.command).localeCompare(titleFor(b.command)));

  return (
    <div className="shell-scrim" onMouseDown={onClose}>
      <div className="keys-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          Keyboard Shortcuts
          <button type="button" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <p className="keys-hint">
          Your changes are stored separately from plugin defaults, so updating a
          plugin never overwrites them.
        </p>

        <ul>
          {rows.map((b) => {
            const isRecording = recording === b.command;
            const clashing = b.key !== '' && clash.has(b.key);

            return (
              <li key={b.command}>
                <span className="keys-title">
                  {titleFor(b.command)}
                  <span className="keys-id">{b.command}</span>
                </span>

                {clashing && <span className="keys-clash">conflict</span>}
                {b.source === 'user' && <span className="keys-badge">custom</span>}

                <button
                  type="button"
                  className={isRecording ? 'keys-chord keys-recording' : 'keys-chord'}
                  onClick={() => setRecording(isRecording ? null : b.command)}
                  onKeyDown={(e) => {
                    if (!isRecording) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.key === 'Escape') { setRecording(null); return; }
                    const chord = chordFromEvent(e);
                    if (chord === null) return;      // modifier alone — keep listening
                    onSet(b.command, chord);
                    setRecording(null);
                  }}
                >
                  {isRecording ? 'press keys…' : pretty(b.key)}
                </button>

                <button
                  type="button"
                  className="keys-clear"
                  title={b.source === 'user' ? 'Reset to default' : 'Unbind'}
                  onClick={() => onSet(b.command, b.source === 'user' ? null : '')}
                >
                  {b.source === 'user' ? '↺' : '✕'}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
