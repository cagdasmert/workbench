#!/usr/bin/env node
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const raw = process.argv[2];
if (raw === undefined) {
  console.error('usage: npm run create-plugin <id>\n  id: lowercase, digits and dashes, e.g. csv-viewer');
  process.exit(1);
}

const id = raw.trim();
if (!/^[a-z][a-z0-9-]*$/.test(id)) {
  // Plugin ids become filenames in plugin-data/ and hostnames in plugin:// URLs.
  console.error(`invalid id "${id}" — use lowercase letters, digits and dashes, starting with a letter`);
  process.exit(1);
}

const dir = path.join(ROOT, 'plugins', id);
try {
  await access(dir);
  console.error(`plugins/${id} already exists`);
  process.exit(1);
} catch { /* absent, which is what we want */ }

const title = id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
// House convention: json-tools -> json.*, mermaid-viewer -> mermaid.*,
// ai-provider -> ai.*. The first segment is the namespace.
const ns = id.split('-')[0];

const manifest = {
  id,
  name: title,
  version: '1.0.0',
  apiVersion: '1.0',
  main: './dist/index.js',
  activationEvents: [`onCommand:${ns}.open`],
  contributes: {
    panels: [{ id: `${ns}.main`, title }],
    menu: [{ command: `${ns}.open`, label: title, group: 'viewers' }],
    commands: [{ id: `${ns}.open`, title: `Open ${title}` }],
    settings: {
      greeting: {
        type: 'string',
        default: 'Hello',
        description: 'Shown at the top of the panel',
      },
    },
    keybindings: [],
    accepts: [],
    emits: [],
  },
  permissions: [],
};

/**
 * The three traps every stateful plugin has hit, pre-solved. See change log
 * entries 6, 13 and 15 — each was rediscovered in a separate plugin before this
 * template existed.
 */
const source = `import { useEffect, useState } from 'react';
import type { PanelContext, Plugin } from '@workbench/plugin-sdk';
import { definePanel } from '@workbench/plugin-sdk/react';

const STORAGE_KEY = 'session';

function ${title.replace(/ /g, '')}Panel({ ctx }: { ctx: PanelContext }) {
  const [greeting, setGreeting] = useState('Hello');
  const [text, setText] = useState('');

  // TRAP 1 (change log 6, 13): storage is async. Saving before the restore
  // resolves overwrites saved state with the initial value on every mount.
  // The \`restored\` flag is what stops that.
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await ctx.plugin.storage.get(STORAGE_KEY);
      if (cancelled) return;
      if (typeof saved === 'string') setText(saved);
      setRestored(true);
    })();
    return () => { cancelled = true; };
  }, [ctx]);

  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => { void ctx.plugin.storage.set(STORAGE_KEY, text); }, 400);
    return () => clearTimeout(timer);
  }, [ctx, text, restored]);

  // TRAP 2 (change log 15): onChange returns a Disposable, not the plain
  // cleanup function useEffect wants.
  useEffect(() => {
    void ctx.plugin.settings.get('greeting').then((v) => {
      if (typeof v === 'string') setGreeting(v);
    });
    const sub = ctx.plugin.settings.onChange((key, value) => {
      if (key === 'greeting' && typeof value === 'string') setGreeting(value);
    });
    return () => { void sub.dispose(); };
  }, [ctx]);

  // TRAP 3 (change log 9): content routed here arrives as ctx.payload, already
  // shaped as a Content object — not as a bare string.

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>{greeting} from {ctx.plugin.id}</h1>
      <textarea
        value={text}
        placeholder="Type — this persists across reloads."
        onChange={(e) => setText(e.target.value)}
        style={{ width: '100%', minHeight: 120, font: 'inherit' }}
      />
    </div>
  );
}

export const plugin: Plugin = {
  activate(ctx) {
    ctx.log.info('${id} activating');
    ctx.registerPanel('${ns}.main', definePanel(${title.replace(/ /g, '')}Panel));
    ctx.registerCommand('${ns}.open', () => ctx.workspace.openPanel('${ns}.main'));
  },

  deactivate() {
    console.log('${id} deactivating');
  },
};
`;

const pkg = {
  name: `@workbench-plugin/${id}`,
  version: '1.0.0',
  private: true,
  type: 'module',
  dependencies: { '@workbench/plugin-sdk': '*', react: '*', 'react-dom': '*' },
};

const tsconfig = {
  extends: '../../tsconfig.base.json',
  compilerOptions: {
    outDir: `../../.tsbuild/plugin-${id}`,
    rootDir: 'src',
    lib: ['ES2022', 'DOM'],
    jsx: 'react-jsx',
  },
  include: ['src'],
  references: [{ path: '../../packages/plugin-sdk' }],
};

await mkdir(path.join(dir, 'src'), { recursive: true });
await writeFile(path.join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
await writeFile(path.join(dir, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`);
await writeFile(path.join(dir, 'src', 'index.tsx'), source);

// The root tsconfig is a solution file; a package missing from it never typechecks.
const rootTsconfigPath = path.join(ROOT, 'tsconfig.json');
const rootTsconfig = JSON.parse(await (await import('node:fs/promises')).readFile(rootTsconfigPath, 'utf8'));
if (!rootTsconfig.references.some((r) => r.path === `plugins/${id}`)) {
  rootTsconfig.references.push({ path: `plugins/${id}` });
  await writeFile(rootTsconfigPath, `${JSON.stringify(rootTsconfig, null, 2)}\n`);
}

console.log(`created plugins/${id}

  npm install          # register the workspace
  npm run dev          # then open "${title}" from the Plugins menu

Everything is wired: manifest, panel, command, a setting, and persistence.
The three async traps that have bitten every plugin so far are pre-solved and
marked in the source — read them before deleting them.`);
