import { useEffect, useState } from 'react';
import type { JsonValue, PluginManifest, PropertySchema, SettingsSchema } from '@workbench/plugin-sdk';

type Values = Record<string, Record<string, JsonValue>>;

/**
 * One control per declared property. This is the whole point of
 * `contributes.settings`: a plugin describes what it has, and never ships a form.
 */
function Field({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: PropertySchema;
  value: JsonValue | undefined;
  onChange: (next: JsonValue) => void;
}) {
  const current = value ?? schema.default ?? (schema.type === 'boolean' ? false : '');

  return (
    <label className="settings-field">
      <span className="settings-label">
        {name}
        {schema.description !== undefined && (
          <span className="settings-desc">{schema.description}</span>
        )}
      </span>

      {schema.type === 'boolean' && (
        <input
          type="checkbox"
          checked={current === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      )}

      {schema.type === 'number' && (
        <input
          type="number"
          value={String(current)}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isNaN(n)) onChange(n);
          }}
        />
      )}

      {schema.type === 'string' && schema.enum !== undefined && (
        <select value={String(current)} onChange={(e) => onChange(e.target.value)}>
          {schema.enum.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      )}

      {schema.type === 'string' && schema.enum === undefined && (
        <input
          type="text"
          value={String(current)}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}

export function SettingsPanel({
  manifests,
  onClose,
}: {
  manifests: PluginManifest[];
  onClose: () => void;
}) {
  const [schemas, setSchemas] = useState<Record<string, SettingsSchema>>({});
  const [values, setValues] = useState<Values>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await window.workbenchHost.settingsSchemas();
      if (cancelled) return;
      setSchemas(loaded);

      const entries = await Promise.all(
        Object.keys(loaded).map(async (id) =>
          [id, await window.workbenchHost.settingsAll(id)] as const),
      );
      if (!cancelled) setValues(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, []);

  const write = async (pluginId: string, key: string, next: JsonValue) => {
    // optimistic; main rejects anything the schema does not allow
    setValues((prev) => ({ ...prev, [pluginId]: { ...prev[pluginId], [key]: next } }));
    try {
      await window.workbenchHost.settingsSet(pluginId, key, next);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      // main rejected it — reload the authoritative values rather than guessing
      const authoritative = await window.workbenchHost.settingsAll(pluginId);
      setValues((prev) => ({ ...prev, [pluginId]: authoritative }));
    }
  };

  const nameFor = (id: string) => manifests.find((m) => m.id === id)?.name ?? id;
  const ids = Object.keys(schemas).sort((a, b) => nameFor(a).localeCompare(nameFor(b)));

  return (
    <div className="shell-scrim" onMouseDown={onClose}>
      <div className="settings-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          Settings
          <button type="button" onClick={onClose} aria-label="Close">✕</button>
        </header>

        {error !== null && <p className="settings-error">{error}</p>}

        {ids.length === 0 && (
          <p className="settings-empty">No plugin declares any settings.</p>
        )}

        {ids.map((id) => (
          <section key={id}>
            <h3>{nameFor(id)}</h3>
            {Object.entries(schemas[id] ?? {}).map(([key, prop]) => (
              <Field
                key={key}
                name={key}
                schema={prop}
                value={values[id]?.[key]}
                onChange={(next) => void write(id, key, next)}
              />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
