type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function kindOf(value: Json): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function preview(value: Json): string {
  if (Array.isArray(value)) return `[] ${value.length} item${value.length === 1 ? '' : 's'}`;
  if (value !== null && typeof value === 'object') {
    const n = Object.keys(value).length;
    return `{} ${n} key${n === 1 ? '' : 's'}`;
  }
  return '';
}

const COLORS: Record<string, string> = {
  string: 'var(--json-string, #0a7d3f)',
  number: 'var(--json-number, #1d4ed8)',
  boolean: 'var(--json-bool, #a21caf)',
  null: 'var(--json-null, #71717a)',
};

function Leaf({ value }: { value: Json }) {
  const kind = kindOf(value);
  const text = kind === 'string' ? `"${String(value)}"` : String(value);
  return <span style={{ color: COLORS[kind] ?? 'inherit' }}>{text}</span>;
}

export function TreeNode({
  name,
  value,
  path,
  expanded,
  onToggle,
  depth = 0,
}: {
  name: string;
  value: Json;
  path: string;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  depth?: number;
}) {
  const branch = value !== null && typeof value === 'object';
  const open = expanded.has(path);

  const entries: Array<[string, Json]> = !branch
    ? []
    : Array.isArray(value)
      ? value.map((v, i) => [String(i), v])
      : Object.entries(value);

  return (
    <div style={{ paddingLeft: depth === 0 ? 0 : 14 }}>
      <div
        style={{ display: 'flex', gap: 6, cursor: branch ? 'pointer' : 'default' }}
        onClick={branch ? () => onToggle(path) : undefined}
      >
        <span style={{ width: 10, color: 'var(--chrome-muted, #71717a)' }}>
          {branch ? (open ? '▾' : '▸') : ''}
        </span>
        <span style={{ color: 'var(--json-key, #b45309)' }}>{name}</span>
        {!branch && <span style={{ color: 'var(--chrome-muted, #71717a)' }}>:</span>}
        {branch
          ? <span style={{ color: 'var(--chrome-muted, #71717a)' }}>{preview(value)}</span>
          : <Leaf value={value} />}
      </div>
      {branch && open && entries.map(([k, v]) => (
        <TreeNode
          key={`${path}.${k}`}
          name={k}
          value={v}
          path={`${path}.${k}`}
          expanded={expanded}
          onToggle={onToggle}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

export function countNodes(value: Json): number {
  if (value === null || typeof value !== 'object') return 1;
  const children = Array.isArray(value) ? value : Object.values(value);
  return 1 + children.reduce<number>((sum, child) => sum + countNodes(child), 0);
}

export type { Json };

/** Root-level collapse state helper: every container path, one level deep. */
export function topLevelPaths(value: Json): string[] {
  if (value === null || typeof value !== 'object') return [];
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value);
  return entries
    .filter(([, v]) => v !== null && typeof v === 'object')
    .map(([k]) => `$.${k}`);
}
