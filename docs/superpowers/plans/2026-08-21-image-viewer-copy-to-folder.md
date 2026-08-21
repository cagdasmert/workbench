# Copy to Folder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user select one or more images in the image viewer and copy them into a folder of their choosing, with recently used destinations offered as one-click shortcuts.

**Architecture:** This adds the first write path to a stack that has been read-only end to end, so most of the work is in the main process, not the plugin. The frozen-shaped `fs` surface gains two methods (SDK 1.7, additive); a new write-grant set in main is kept strictly separate from the read grants; and the copy itself is exclusive-create only, which is what stops a planted symlink from escaping the grant. The plugin layer is ordinary React state plus a self-rendered menu.

**Tech Stack:** TypeScript 7 (strict), Electron 43, React 19, Vitest 4, npm workspaces, esbuild for plugin bundles.

**Spec:** `docs/superpowers/specs/2026-08-21-image-viewer-copy-to-folder-design.md`

## Global Constraints

- TypeScript `strict: true`. No `any` — use `unknown` and narrow.
- Every `PluginContext` method is async, even where a sync answer exists.
- Nothing non-serializable crosses the plugin boundary. `CopyResult` is a plain object.
- Plugins never import `fs`, `path`, `electron`, or any Node builtin.
- `packages/plugin-host` must not import Electron. It speaks only to `window.workbenchHost`.
- `packages/plugin-sdk/src/index.ts` imports nothing. Types only.
- ESM everywhere except `packages/preload`, which stays CJS.
- Relative imports inside packages carry a `.js` extension, including in TypeScript sources.
- `vitest.config.ts` collects only `packages/*/src/**/*.test.ts`. Tests live beside their source; plugins have no test harness and are verified by hand.
- Verification commands: `npm test`, `npm run typecheck`, `npm run dev`.
- New permission string, exact spelling: `fs:write:user-selected`.
- SDK version after this work: `1.7.0`.

---

### Task 1: The contract, end to end

Adds the two methods to the SDK and plumbs them through bridge, preload and host. The main-process handlers do not exist yet, so calling `copyFile` after this task rejects with an unhandled-channel error — that is expected and is fixed in Task 6.

**Files:**
- Modify: `packages/plugin-sdk/src/index.ts` (the `fs` block inside `PluginContext`, and a new exported interface)
- Modify: `packages/plugin-sdk/package.json:3` (version `1.6.0` → `1.7.0`)
- Modify: `packages/plugin-host/src/bridge.ts:17` (after `readFile`)
- Modify: `packages/plugin-host/src/host.ts:541-546` (the `fs:` block)
- Modify: `packages/preload/src/index.ts:20` (after `readFile`)
- Test: `packages/plugin-host/src/host.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CopyResult { name: string; renamed: boolean }` exported from `@workbench/plugin-sdk`; `PluginContext.fs.pickDirectoryForWrite(defaultPath?: string): Promise<string | undefined>`; `PluginContext.fs.copyFile(sourcePath: string, destDir: string): Promise<CopyResult>`; bridge methods `pickDirectoryForWrite(defaultPath?: string)` and `copyFile(pluginId: string, sourcePath: string, destDir: string)`.

Note the asymmetry: the **bridge** `copyFile` takes a `pluginId` first argument and the **plugin-facing** `copyFile` does not. The host injects it, exactly as it already does for `netFetch` and `storageGet`. A plugin cannot name a different plugin.

- [ ] **Step 1: Write the failing test**

Add to `packages/plugin-host/src/host.test.ts`, after the existing `proxies ctx.fs straight through to the bridge` test:

```ts
  it('proxies the write half of ctx.fs, injecting the plugin id on copyFile', async () => {
    const calls: string[] = [];
    const fsBridge: WorkbenchHostBridge = {
      ...bridge,
      pickDirectoryForWrite: async (defaultPath) => {
        calls.push(`pickDirectoryForWrite:${defaultPath ?? ''}`);
        return '/tmp/exports';
      },
      copyFile: async (pluginId, source, destDir) => {
        calls.push(`copyFile:${pluginId}:${source}:${destDir}`);
        return { name: 'photo-1.png', renamed: true };
      },
    };

    let result: { name: string; renamed: boolean } | undefined;
    const plugin: Plugin = {
      async activate(ctx) {
        const dir = await ctx.fs.pickDirectoryForWrite('/tmp/last-used');
        if (dir !== undefined) result = await ctx.fs.copyFile('/tmp/photo.png', dir);
      },
    };
    const host = createPluginHost({
      bridge: fsBridge,
      importModule: async () => ({ plugin }),
    });
    host.load([manifest()]);

    await host.activate(PLUGIN_ID);

    expect(calls).toEqual([
      'pickDirectoryForWrite:/tmp/last-used',
      `copyFile:${PLUGIN_ID}:/tmp/photo.png:/tmp/exports`,
    ]);
    expect(result).toEqual({ name: 'photo-1.png', renamed: true });
    expect(host.get(PLUGIN_ID)?.state).toBe('active');
  });
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run packages/plugin-host/src/host.test.ts`

Expected: FAIL. The shared `bridge` literal at the top of the file does not have the new methods, so TypeScript reports that the object literal is missing properties, and `ctx.fs.pickDirectoryForWrite` is not a function.

- [ ] **Step 3: Add the types to the SDK**

In `packages/plugin-sdk/src/index.ts`, inside `PluginContext`, add to the `fs` block immediately after `readFile`:

```ts
    /**
     * Grants write access to the chosen directory for this session. Deliberately
     * separate from `pickDirectory`: browsing a folder must never make it
     * writable, so the two grant sets never mix.
     *
     * `defaultPath` only positions the dialog. It is a convenience for offering
     * recent destinations and confers nothing on its own — the grant is still
     * the user confirming the dialog.
     */
    pickDirectoryForWrite(defaultPath?: string): Promise<string | undefined>;

    /**
     * Copies one file into a directory granted by `pickDirectoryForWrite`.
     *
     * Never overwrites. On a name collision the copy lands as `name-1.ext`,
     * `name-2.ext`, and the name actually written comes back in the result.
     * That is not politeness about user data: the copy is exclusive-create, and
     * refusing an existing destination is what stops a symlink planted at the
     * destination filename from redirecting the write outside the grant.
     *
     * One file per call. The plugin loops and owns its own concurrency, for the
     * same reason `readDir` does not recurse.
     */
    copyFile(sourcePath: string, destDir: string): Promise<CopyResult>;
```

Then add this exported interface next to `DirEntry`, near the bottom of the file:

```ts
export interface CopyResult {
  /** Basename actually written. Differs from the source on a collision. */
  name: string;
  renamed: boolean;
}
```

- [ ] **Step 4: Bump the SDK version**

In `packages/plugin-sdk/package.json`, change `"version": "1.6.0"` to `"version": "1.7.0"`.

- [ ] **Step 5: Add the bridge methods**

In `packages/plugin-host/src/bridge.ts`, add `CopyResult` to the type import from `@workbench/plugin-sdk`, then add after the `readFile` line:

```ts
  pickDirectoryForWrite(defaultPath?: string): Promise<string | undefined>;
  copyFile(pluginId: string, sourcePath: string, destDir: string): Promise<CopyResult>;
```

- [ ] **Step 6: Wire the host**

In `packages/plugin-host/src/host.ts`, extend the `fs:` block so it reads:

```ts
      fs: {
        pickFile: async (filters) => this.bridge.pickFile(filters),
        pickDirectory: async () => this.bridge.pickDirectory(),
        pickDirectoryForWrite: async (defaultPath) =>
          this.bridge.pickDirectoryForWrite(defaultPath),
        readDir: async (dirPath) => this.bridge.readDir(dirPath),
        readFile: async (filePath) => this.bridge.readFile(filePath),
        copyFile: async (sourcePath, destDir) =>
          this.bridge.copyFile(pluginId, sourcePath, destDir),
      },
```

- [ ] **Step 7: Expose them in preload**

In `packages/preload/src/index.ts`, add after the `readFile` line:

```ts
  pickDirectoryForWrite: (defaultPath?: string) =>
    ipcRenderer.invoke('fs:pickDirectoryForWrite', defaultPath),
  copyFile: (pluginId: string, sourcePath: string, destDir: string) =>
    ipcRenderer.invoke('fs:copyFile', pluginId, sourcePath, destDir),
```

- [ ] **Step 8: Fill in the shared test bridge**

In `packages/plugin-host/src/host.test.ts`, add to the shared `bridge` literal after `readFile`:

```ts
  pickDirectoryForWrite: async () => undefined,
  copyFile: async () => ({ name: '', renamed: false }),
```

- [ ] **Step 9: Run the tests and the typechecker**

Run: `npm test`
Expected: PASS, including the new test. All 29 existing tests still pass.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/plugin-sdk packages/plugin-host packages/preload
git commit -m "SDK 1.7: add the write half of the fs surface"
```

---

### Task 2: Extract the grant policy out of the Electron shell

`fs-broker.ts` currently mixes Electron dialogs with the grant policy, which means the policy cannot be unit-tested without an Electron harness. This task moves the policy into a module that imports only Node builtins, with **no behaviour change**. Tests written first describe the behaviour that already exists, so a green run proves the extraction was faithful.

**Files:**
- Create: `packages/main/src/fs-grants.ts`
- Create: `packages/main/src/fs-grants.test.ts`
- Modify: `packages/main/src/fs-broker.ts` (delete the moved code, import it instead)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `grantFile(real: string): void`, `grantReadDir(real: string): void`, `assertReadable(target: string): Promise<string>`, `isInside(parent: string, child: string): boolean`, `resetGrants(): void`. All exported from `packages/main/src/fs-grants.js`.

`resetGrants()` exists for tests only. Say so in its docblock — a reader who finds an unused export otherwise deletes it.

- [ ] **Step 1: Write the failing test**

Create `packages/main/src/fs-grants.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertReadable, grantFile, grantReadDir, resetGrants } from './fs-grants.js';

let root: string;

beforeEach(async () => {
  resetGrants();
  // realpath because macOS hands back /var/... which is a symlink to /private/var
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'wb-grants-')));
});

afterEach(() => { resetGrants(); });

describe('assertReadable', () => {
  it('allows a file granted individually', async () => {
    const file = path.join(root, 'picked.png');
    await writeFile(file, 'x');
    grantFile(await realpath(file));

    await expect(assertReadable(file)).resolves.toBe(file);
  });

  it('allows a file inside a granted directory, at any depth', async () => {
    const nested = path.join(root, 'a', 'b');
    await mkdir(nested, { recursive: true });
    const file = path.join(nested, 'deep.png');
    await writeFile(file, 'x');
    grantReadDir(root);

    await expect(assertReadable(file)).resolves.toBe(file);
  });

  it('refuses a path that was never granted', async () => {
    const file = path.join(root, 'ungranted.png');
    await writeFile(file, 'x');

    await expect(assertReadable(file)).rejects.toThrow(/not inside anything granted/);
  });

  it('refuses a symlink inside a grant that resolves outside it', async () => {
    const inside = path.join(root, 'inside');
    const outside = path.join(root, 'outside');
    await mkdir(inside);
    await mkdir(outside);
    const secret = path.join(outside, 'secret.txt');
    await writeFile(secret, 'secret');
    await symlink(secret, path.join(inside, 'escape.png'));
    grantReadDir(inside);

    await expect(assertReadable(path.join(inside, 'escape.png')))
      .rejects.toThrow(/not inside anything granted/);
  });

  it('refuses a traversal that climbs out of a grant', async () => {
    const inside = path.join(root, 'inside');
    await mkdir(inside);
    const outside = path.join(root, 'out.txt');
    await writeFile(outside, 'x');
    grantReadDir(inside);

    await expect(assertReadable(path.join(inside, '..', 'out.txt')))
      .rejects.toThrow(/not inside anything granted/);
  });

  it('refuses a path that does not exist', async () => {
    await expect(assertReadable(path.join(root, 'nope.png')))
      .rejects.toThrow(/does not exist/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run packages/main/src/fs-grants.test.ts`
Expected: FAIL — `Cannot find module './fs-grants.js'`.

- [ ] **Step 3: Create the module**

Create `packages/main/src/fs-grants.ts`. This is the code currently in `fs-broker.ts`, moved verbatim apart from the added exports:

```ts
import { realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Paths the user explicitly chose through a file dialog, this session only.
 *
 * This is what makes the declared permission `fs:read:user-selected` mean
 * something. Without it, `fs:readFile` over the bridge is an arbitrary-file-read
 * primitive handed to the renderer. Nothing is persisted; a restart starts from
 * zero grants.
 *
 * Policy lives here rather than in `fs-broker.ts` so it can be tested without an
 * Electron harness. `fs-broker.ts` keeps the dialogs and the IPC.
 */
const grantedFiles = new Set<string>();

/**
 * Directories the user chose for reading. Picking a folder grants everything
 * inside it — a broader grant than picking a file, and the only way a folder
 * browser can work at all.
 *
 * Every set holds **symlink-resolved** paths, and every check resolves first.
 * Without that, a symlink inside a granted folder pointing at ~/.ssh would be
 * readable: the string sits under the granted prefix while the real file does not.
 */
const grantedReadDirs = new Set<string>();

/** Strictly inside — a directory is not "inside" itself. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function grantFile(real: string): void {
  grantedFiles.add(real);
}

export function grantReadDir(real: string): void {
  grantedReadDirs.add(real);
}

export function isReadDirGranted(real: string): boolean {
  return grantedReadDirs.has(real);
}

/** Tests only. Grants are session state; nothing in the app clears them. */
export function resetGrants(): void {
  grantedFiles.clear();
  grantedReadDirs.clear();
}

export async function assertReadable(target: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new Error(`fs:read denied — "${target}" does not exist`);
  }

  if (grantedFiles.has(real)) return real;
  for (const dir of grantedReadDirs) {
    if (isInside(dir, real)) return real;
  }
  throw new Error(
    `fs:read denied — "${target}" is not inside anything granted this session`,
  );
}
```

- [ ] **Step 4: Point fs-broker at it**

In `packages/main/src/fs-broker.ts`: delete `grantedFiles`, `grantedDirs` and `assertReadable` along with their docblocks, drop `realpath` from the `node:fs/promises` import only if it is no longer used (it still is — `fs:pickFile` and `fs:readDir` call it), and add:

```ts
import {
  assertReadable, grantFile, grantReadDir, isReadDirGranted,
} from './fs-grants.js';
```

Then replace the three former uses:
- in `fs:pickFile`, `grantedFiles.add(await realpath(picked))` → `grantFile(await realpath(picked))`
- in `fs:pickDirectory`, `grantedDirs.add(await realpath(picked))` → `grantReadDir(await realpath(picked))`
- in `fs:readDir`, `if (!grantedDirs.has(real))` → `if (!isReadDirGranted(real))`

- [ ] **Step 5: Run the tests and the typechecker**

Run: `npm test`
Expected: PASS — the six new tests plus everything from Task 1.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Verify by hand that reading still works**

Run: `npm run dev`, open the Image Viewer (⌘⇧I), click **Open folder…**, choose a folder of images.
Expected: thumbnails appear and arrow keys page through them, exactly as before. This task changed no behaviour; if browsing broke, the extraction was not faithful.

- [ ] **Step 7: Commit**

```bash
git add packages/main/src/fs-grants.ts packages/main/src/fs-grants.test.ts packages/main/src/fs-broker.ts
git commit -m "Extract fs grant policy so it can be tested without Electron"
```

---

### Task 3: Write grants and the destination deny-list

**Files:**
- Modify: `packages/main/src/fs-grants.ts`
- Modify: `packages/main/src/fs-grants.test.ts`

**Interfaces:**
- Consumes: `isInside`, `resetGrants` from Task 2.
- Produces: `grantWriteDir(real: string): void`, `assertWritableDir(target: string): Promise<string>`, `deniedWriteReason(real: string, home?: string): string | null`. `resetGrants()` now also clears write grants.

- [ ] **Step 1: Write the failing test**

Append to `packages/main/src/fs-grants.test.ts`. Add `grantWriteDir`, `assertWritableDir` and `deniedWriteReason` to the import at the top of the file first:

```ts
describe('assertWritableDir', () => {
  it('allows a directory granted for writing', async () => {
    grantWriteDir(root);
    await expect(assertWritableDir(root)).resolves.toBe(root);
  });

  it('allows a subdirectory of a write grant', async () => {
    const nested = path.join(root, 'sub');
    await mkdir(nested);
    grantWriteDir(root);
    await expect(assertWritableDir(nested)).resolves.toBe(nested);
  });

  it('refuses a directory that was only granted for reading', async () => {
    grantReadDir(root);
    await expect(assertWritableDir(root)).rejects.toThrow(/not granted for writing/);
  });

  it('refuses a directory that was never granted', async () => {
    await expect(assertWritableDir(root)).rejects.toThrow(/not granted for writing/);
  });

  it('refuses a traversal that climbs out of a write grant', async () => {
    const inside = path.join(root, 'inside');
    await mkdir(inside);
    grantWriteDir(inside);
    await expect(assertWritableDir(path.join(inside, '..')))
      .rejects.toThrow(/not granted for writing/);
  });

  it('refuses a symlinked directory that resolves outside the grant', async () => {
    const inside = path.join(root, 'inside');
    const outside = path.join(root, 'outside');
    await mkdir(inside);
    await mkdir(outside);
    await symlink(outside, path.join(inside, 'escape'));
    grantWriteDir(inside);

    await expect(assertWritableDir(path.join(inside, 'escape')))
      .rejects.toThrow(/not granted for writing/);
  });
});

describe('deniedWriteReason', () => {
  const home = '/Users/someone';

  it('denies the plugin directory, which is an install path', () => {
    const plugins = `${home}/Library/Application Support/Workbench/plugins`;
    expect(deniedWriteReason(plugins, home)).toMatch(/Workbench/);
  });

  it('denies anything inside the plugin directory', () => {
    const nested = `${home}/Library/Application Support/Workbench/plugins/evil`;
    expect(deniedWriteReason(nested, home)).not.toBeNull();
  });

  it('denies login-item and credential directories', () => {
    expect(deniedWriteReason(`${home}/Library/LaunchAgents`, home)).not.toBeNull();
    expect(deniedWriteReason('/Library/LaunchDaemons', home)).not.toBeNull();
    expect(deniedWriteReason(`${home}/.ssh`, home)).not.toBeNull();
    expect(deniedWriteReason(`${home}/.aws`, home)).not.toBeNull();
    expect(deniedWriteReason(`${home}/.config`, home)).not.toBeNull();
  });

  it('denies /Applications', () => {
    expect(deniedWriteReason('/Applications', home)).not.toBeNull();
  });

  it('denies the home directory itself but allows folders inside it', () => {
    expect(deniedWriteReason(home, home)).toMatch(/home directory/);
    expect(deniedWriteReason(`${home}/Pictures/Exports`, home)).toBeNull();
  });

  it('allows an ordinary folder', () => {
    expect(deniedWriteReason('/Volumes/Photos/2026', home)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run packages/main/src/fs-grants.test.ts`
Expected: FAIL — `grantWriteDir`, `assertWritableDir` and `deniedWriteReason` are not exported.

- [ ] **Step 3: Implement**

Add to `packages/main/src/fs-grants.ts`. Extend the import at the top to `import { homedir } from 'node:os';`:

```ts
/**
 * Directories the user chose **for writing**, held separately from the read
 * grants on purpose: opening a photo folder to browse it must never make that
 * folder writable. Session-only, symlink-resolved, exactly like the read sets.
 */
const grantedWriteDirs = new Set<string>();

export function grantWriteDir(real: string): void {
  grantedWriteDirs.add(real);
}

/**
 * Places a write grant is refused outright, even if the user picks them in the
 * dialog. The grant set is the real control; this is the backstop for a
 * mis-clicked or nudged dialog.
 *
 * The first entry is the one that matters. The app loads plugins from that
 * directory, so a plugin that can write there can install another plugin that
 * runs on next launch, with no prompt. The rest are the same class of problem
 * with a smaller blast radius: login persistence, credentials, shell startup.
 *
 * `home` is a parameter so the list is testable without depending on whose
 * machine the suite runs on.
 */
export function deniedWriteReason(real: string, home: string = homedir()): string | null {
  if (real === home) {
    return 'the home directory itself is too broad a write grant — pick a folder inside it';
  }

  const denied: Array<[string, string]> = [
    [`${home}/Library/Application Support/Workbench`, 'the Workbench plugin directory'],
    [`${home}/Library/LaunchAgents`, 'a login-item directory'],
    ['/Library/LaunchAgents', 'a login-item directory'],
    ['/Library/LaunchDaemons', 'a system daemon directory'],
    [`${home}/.ssh`, 'an SSH credential directory'],
    [`${home}/.aws`, 'a cloud credential directory'],
    [`${home}/.gnupg`, 'a key directory'],
    [`${home}/.config`, 'a configuration directory'],
    ['/Applications', 'the applications directory'],
    ['/System', 'a system directory'],
  ];

  for (const [prefix, description] of denied) {
    if (real === prefix || isInside(prefix, real)) return description;
  }
  return null;
}

export async function assertWritableDir(target: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new Error(`fs:write denied — "${target}" does not exist`);
  }

  const granted = grantedWriteDirs.has(real)
    || [...grantedWriteDirs].some((dir) => isInside(dir, real));
  if (!granted) {
    throw new Error(
      `fs:write denied — "${target}" is not granted for writing this session`,
    );
  }

  const reason = deniedWriteReason(real);
  if (reason !== null) {
    throw new Error(`fs:write denied — "${target}" is ${reason}`);
  }
  return real;
}
```

Then add `grantedWriteDirs.clear();` to the body of `resetGrants()`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, including all thirteen new assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/main/src/fs-grants.ts packages/main/src/fs-grants.test.ts
git commit -m "Add write grants, kept separate from read, plus a destination deny-list"
```

---

### Task 4: The exclusive copy

The security-critical task. `COPYFILE_EXCL` is what makes the copy unable to write outside its destination folder, and the test proves it rather than assuming it.

**Files:**
- Create: `packages/main/src/fs-copy.ts`
- Create: `packages/main/src/fs-copy.test.ts`

**Interfaces:**
- Consumes: `CopyResult` from `@workbench/plugin-sdk` (Task 1).
- Produces: `copyFileExclusive(sourcePath: string, destDir: string): Promise<CopyResult>`, `candidateName(original: string, attempt: number): string`, `MAX_COLLISION_ATTEMPTS: number`.

- [ ] **Step 1: Write the failing test**

Create `packages/main/src/fs-copy.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { candidateName, copyFileExclusive } from './fs-copy.js';

let root: string;
let dest: string;
let source: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'wb-copy-')));
  dest = path.join(root, 'dest');
  await mkdir(dest);
  source = path.join(root, 'photo.png');
  await writeFile(source, 'SOURCE-BYTES');
});

describe('candidateName', () => {
  it('returns the original name on the first attempt', () => {
    expect(candidateName('photo.png', 0)).toBe('photo.png');
  });

  it('inserts the attempt before the extension', () => {
    expect(candidateName('photo.png', 1)).toBe('photo-1.png');
    expect(candidateName('photo.png', 12)).toBe('photo-12.png');
  });

  it('handles a name with several dots', () => {
    expect(candidateName('shot.2026.png', 1)).toBe('shot.2026-1.png');
  });

  it('handles a name with no extension', () => {
    expect(candidateName('README', 1)).toBe('README-1');
  });
});

describe('copyFileExclusive', () => {
  it('copies a file under its own name when nothing is in the way', async () => {
    const result = await copyFileExclusive(source, dest);

    expect(result).toEqual({ name: 'photo.png', renamed: false });
    expect(await readFile(path.join(dest, 'photo.png'), 'utf8')).toBe('SOURCE-BYTES');
  });

  it('never overwrites — it renames, leaving the existing file untouched', async () => {
    await writeFile(path.join(dest, 'photo.png'), 'ALREADY-HERE');

    const result = await copyFileExclusive(source, dest);

    expect(result).toEqual({ name: 'photo-1.png', renamed: true });
    expect(await readFile(path.join(dest, 'photo.png'), 'utf8')).toBe('ALREADY-HERE');
    expect(await readFile(path.join(dest, 'photo-1.png'), 'utf8')).toBe('SOURCE-BYTES');
  });

  it('keeps counting past the first collision', async () => {
    await writeFile(path.join(dest, 'photo.png'), 'a');
    await writeFile(path.join(dest, 'photo-1.png'), 'b');

    expect(await copyFileExclusive(source, dest)).toEqual({ name: 'photo-2.png', renamed: true });
  });

  // The reason COPYFILE_EXCL is a security control and not a nicety. Without the
  // flag this copy follows the symlink and destroys a file outside `dest`.
  it('does not write through a symlink planted at the destination name', async () => {
    const outsideDir = path.join(root, 'outside');
    await mkdir(outsideDir);
    const secret = path.join(outsideDir, 'secret.txt');
    await writeFile(secret, 'SECRET');
    await symlink(secret, path.join(dest, 'photo.png'));

    const result = await copyFileExclusive(source, dest);

    expect(await readFile(secret, 'utf8')).toBe('SECRET');   // untouched
    expect(result).toEqual({ name: 'photo-1.png', renamed: true });
    expect(await readFile(path.join(dest, 'photo-1.png'), 'utf8')).toBe('SOURCE-BYTES');
  });

  it('does not create a file through a dangling symlink at the destination name', async () => {
    const outsideDir = path.join(root, 'outside');
    await mkdir(outsideDir);
    const ghost = path.join(outsideDir, 'ghost.txt');
    await symlink(ghost, path.join(dest, 'photo.png'));

    const result = await copyFileExclusive(source, dest);

    await expect(readFile(ghost, 'utf8')).rejects.toThrow();  // still does not exist
    expect(result).toEqual({ name: 'photo-1.png', renamed: true });
  });

  it('gives up rather than looping forever on a wall of collisions', async () => {
    await writeFile(path.join(dest, 'photo.png'), 'x');
    for (let i = 1; i <= 100; i += 1) {
      await writeFile(path.join(dest, `photo-${i}.png`), 'x');
    }

    await expect(copyFileExclusive(source, dest)).rejects.toThrow(/name collisions/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run packages/main/src/fs-copy.test.ts`
Expected: FAIL — `Cannot find module './fs-copy.js'`.

- [ ] **Step 3: Implement**

Create `packages/main/src/fs-copy.ts`:

```ts
import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import type { CopyResult } from '@workbench/plugin-sdk';

/**
 * How many `name-N` variants to try before giving up. A cap rather than an
 * unbounded loop: without one, a destination full of collisions spins forever
 * inside an IPC handler.
 */
export const MAX_COLLISION_ATTEMPTS = 100;

export function candidateName(original: string, attempt: number): string {
  if (attempt === 0) return original;
  const ext = path.extname(original);
  const stem = path.basename(original, ext);
  return `${stem}-${attempt}${ext}`;
}

/**
 * Copies one file into `destDir` without ever overwriting anything.
 *
 * `COPYFILE_EXCL` is load-bearing and must never be relaxed. It makes the
 * underlying open use `O_CREAT|O_EXCL`, which fails on an existing path
 * *including a symlink, even a dangling one*. Without it, a symlink planted at
 * the destination filename is followed and the bytes land wherever it points —
 * outside the granted directory entirely. Verified against both a live and a
 * dangling symlink in `fs-copy.test.ts`.
 *
 * Consequently the collision loop must never fall back to a non-exclusive copy
 * on its final attempt. It gives up instead.
 *
 * `sourcePath` and `destDir` are expected to be already resolved and authorised
 * by `fs-grants.ts`. This function is the mechanism, not the policy.
 */
export async function copyFileExclusive(
  sourcePath: string,
  destDir: string,
): Promise<CopyResult> {
  const original = path.basename(sourcePath);

  for (let attempt = 0; attempt <= MAX_COLLISION_ATTEMPTS; attempt += 1) {
    const name = candidateName(original, attempt);
    try {
      await copyFile(sourcePath, path.join(destDir, name), constants.COPYFILE_EXCL);
      return { name, renamed: attempt > 0 };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }

  throw new Error(
    `fs:copyFile — gave up after ${MAX_COLLISION_ATTEMPTS} name collisions for "${original}"`,
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS. Pay attention to the two symlink tests — they are the ones that would have failed before the flag was added.

- [ ] **Step 5: Prove the flag is what does the work**

Temporarily delete `, constants.COPYFILE_EXCL` from the `copyFile` call and run `npx vitest run packages/main/src/fs-copy.test.ts`.
Expected: the symlink tests FAIL, and `secret.txt` is reported as containing `SOURCE-BYTES`. Put the flag back and confirm they pass again.

This step exists because a future reader will otherwise assume the flag is stylistic. Do not skip it.

- [ ] **Step 6: Commit**

```bash
git add packages/main/src/fs-copy.ts packages/main/src/fs-copy.test.ts
git commit -m "Add exclusive-create copy, which is what keeps a write inside its grant"
```

---

### Task 5: Per-plugin write permission

`fs` has no per-plugin check today — a read grant is session-global. A write primitive is where that stops being acceptable. This mirrors `net-broker.ts`, which builds an allow-table from the manifests once at startup so a plugin cannot widen its own reach at runtime.

**Files:**
- Create: `packages/main/src/fs-permissions.ts`
- Create: `packages/main/src/fs-permissions.test.ts`

**Interfaces:**
- Consumes: `PluginManifest` from `@workbench/plugin-sdk`.
- Produces: `loadFsPermissions(manifests: PluginManifest[]): void`, `assertMayWrite(pluginId: string): void`, `FS_WRITE_PERMISSION: 'fs:write:user-selected'`.

- [ ] **Step 1: Write the failing test**

Create `packages/main/src/fs-permissions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '@workbench/plugin-sdk';
import { assertMayWrite, loadFsPermissions } from './fs-permissions.js';

function manifest(id: string, permissions?: string[]): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: '1.0',
    main: './dist/index.js',
    activationEvents: [],
    contributes: {},
    ...(permissions === undefined ? {} : { permissions }),
  };
}

describe('fs write permissions', () => {
  it('allows a plugin that declares fs:write:user-selected', () => {
    loadFsPermissions([manifest('image-viewer', ['fs:write:user-selected'])]);
    expect(() => assertMayWrite('image-viewer')).not.toThrow();
  });

  it('denies a plugin that declares only read', () => {
    loadFsPermissions([manifest('image-viewer', ['fs:read:user-selected'])]);
    expect(() => assertMayWrite('image-viewer')).toThrow(/declares no fs:write:user-selected/);
  });

  it('denies a plugin with no permissions at all', () => {
    loadFsPermissions([manifest('hello')]);
    expect(() => assertMayWrite('hello')).toThrow(/declares no fs:write:user-selected/);
  });

  it('denies a plugin that was never loaded', () => {
    loadFsPermissions([manifest('image-viewer', ['fs:write:user-selected'])]);
    expect(() => assertMayWrite('stranger')).toThrow(/declares no fs:write:user-selected/);
  });

  it('forgets permissions from a previous load', () => {
    loadFsPermissions([manifest('image-viewer', ['fs:write:user-selected'])]);
    loadFsPermissions([manifest('image-viewer')]);
    expect(() => assertMayWrite('image-viewer')).toThrow(/declares no fs:write:user-selected/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run packages/main/src/fs-permissions.test.ts`
Expected: FAIL — `Cannot find module './fs-permissions.js'`.

- [ ] **Step 3: Implement**

Create `packages/main/src/fs-permissions.ts`:

```ts
import type { PluginManifest } from '@workbench/plugin-sdk';

export const FS_WRITE_PERMISSION = 'fs:write:user-selected';

/**
 * Plugins that declared the write permission, built once from the manifests —
 * a plugin cannot widen its own reach at runtime.
 *
 * `fs` reads have no per-plugin check: grants are session-global, so any loaded
 * plugin can read a path another plugin was granted. That is a known gap. It is
 * not extended to writing, which is why this table exists.
 */
const mayWrite = new Set<string>();

export function loadFsPermissions(manifests: PluginManifest[]): void {
  mayWrite.clear();
  for (const m of manifests) {
    if ((m.permissions ?? []).includes(FS_WRITE_PERMISSION)) mayWrite.add(m.id);
  }
}

export function assertMayWrite(pluginId: string): void {
  if (!mayWrite.has(pluginId)) {
    throw new Error(`fs:write denied — ${pluginId} declares no ${FS_WRITE_PERMISSION} permission`);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/main/src/fs-permissions.ts packages/main/src/fs-permissions.test.ts
git commit -m "Check fs:write:user-selected per plugin, the way net:fetch is checked"
```

---

### Task 6: Wire the IPC handlers

Everything built in Tasks 2–5 is unreachable until this task connects it. After this, the SDK methods from Task 1 actually work.

**Files:**
- Modify: `packages/main/src/fs-broker.ts` (two new handlers)
- Modify: `packages/main/src/index.ts:133` (call `loadFsPermissions` beside `loadNetPermissions`)

**Interfaces:**
- Consumes: `assertReadable`, `assertWritableDir`, `grantWriteDir`, `deniedWriteReason` (Tasks 2–3); `copyFileExclusive` (Task 4); `loadFsPermissions`, `assertMayWrite` (Task 5).
- Produces: IPC channels `fs:pickDirectoryForWrite` and `fs:copyFile`, matching the preload calls added in Task 1.

- [ ] **Step 1: Add the imports**

In `packages/main/src/fs-broker.ts`, extend the `./fs-grants.js` import to include `assertWritableDir`, `deniedWriteReason` and `grantWriteDir`, and add:

```ts
import { copyFileExclusive } from './fs-copy.js';
import { assertMayWrite } from './fs-permissions.js';
```

- [ ] **Step 2: Add the write-dialog handler**

In `registerFsBroker`, after the existing `fs:pickDirectory` handler:

```ts
  ipcMain.handle('fs:pickDirectoryForWrite', async (_event, rawDefaultPath: unknown) => {
    const win = getWindow();
    const options = {
      properties: ['openDirectory' as const, 'createDirectory' as const],
      buttonLabel: 'Copy Here',
      // Only positions the dialog. The plugin supplies it from its own recent
      // list, so it is untrusted — which is fine, because the grant is still
      // whatever the user confirms, and that result is deny-list checked below.
      ...(typeof rawDefaultPath === 'string' ? { defaultPath: rawDefaultPath } : {}),
    };
    const result = win === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(win, options);

    const picked = result.canceled ? undefined : result.filePaths[0];
    if (picked === undefined) return undefined;

    const real = await realpath(picked);
    const reason = deniedWriteReason(real);
    if (reason !== null) {
      throw new Error(`fs:write denied — "${picked}" is ${reason}`);
    }

    grantWriteDir(real);   // the dialog IS the grant
    return picked;
  });
```

- [ ] **Step 3: Add the copy handler**

After the existing `fs:readFile` handler:

```ts
  ipcMain.handle('fs:copyFile', async (
    _event,
    rawPluginId: unknown,
    rawSource: unknown,
    rawDestDir: unknown,
  ): Promise<CopyResult> => {
    if (typeof rawPluginId !== 'string') throw new Error('fs:copyFile expects a plugin id');
    if (typeof rawSource !== 'string') throw new Error('fs:copyFile expects a source path');
    if (typeof rawDestDir !== 'string') throw new Error('fs:copyFile expects a destination path');

    // Order matters: cheapest and most categorical check first.
    assertMayWrite(rawPluginId);
    const source = await assertReadable(rawSource);
    const destDir = await assertWritableDir(rawDestDir);

    return await copyFileExclusive(source, destDir);
  });
```

Add `CopyResult` to the type import at the top of the file, which currently reads `import type { DirEntry, FileFilter } from '@workbench/plugin-sdk';`.

- [ ] **Step 4: Load the permissions at startup**

In `packages/main/src/index.ts`, change the import on line 11 to:

```ts
import { registerFsBroker } from './fs-broker.js';
import { loadFsPermissions } from './fs-permissions.js';
```

and add directly beneath the existing `loadNetPermissions(manifests);` on line 133:

```ts
  loadFsPermissions(manifests);
```

- [ ] **Step 5: Run the tests and the typechecker**

Run: `npm test`
Expected: PASS, no regressions.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/main/src/fs-broker.ts packages/main/src/index.ts
git commit -m "Wire fs:pickDirectoryForWrite and fs:copyFile through the broker"
```

---

### Task 7: Multi-select in the image viewer

No copying yet — just selection, which is worth landing and looking at on its own.

**Files:**
- Modify: `plugins/image-viewer/plugin.json` (permissions)
- Modify: `plugins/image-viewer/src/index.tsx`
- Modify: `plugins/image-viewer/src/Thumb.tsx`

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: in `ImagePanel`, `selected: Set<string>` state and `toggleSelect(i, e)`; `Thumb` gains a `checked: boolean` prop and an `onContextMenu` prop.

`Thumb`'s existing `selected` prop means "this is the image on the stage" and keeps that meaning. The new prop is `checked`, for "this is in the copy selection". Two different ideas; do not merge them.

- [ ] **Step 1: Declare the permission**

In `plugins/image-viewer/plugin.json`, change the `permissions` array to:

```json
  "permissions": [
    "fs:read:user-selected",
    "fs:write:user-selected"
  ]
```

- [ ] **Step 2: Add selection state**

In `plugins/image-viewer/src/index.tsx`, inside `ImagePanel`, add after the `dimensions` state:

```tsx
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchorRef = useRef<number | null>(null);
```

And clear it whenever a new folder is opened — inside `openFolder`, beside `setShown(null)`:

```tsx
      setSelected(new Set());
      anchorRef.current = null;
```

- [ ] **Step 3: Implement the click behaviour**

Add below `openFolder`:

```tsx
  /**
   * Finder's selection grammar: plain click replaces, cmd toggles, shift extends
   * from the last plain click. The anchor is the last non-shift click, which is
   * why it is a ref rather than derived from `index`.
   */
  const selectAt = useCallback((i: number, e: { metaKey: boolean; shiftKey: boolean }) => {
    const entry = images[i];
    if (entry === undefined) return;

    setSelected((prev) => {
      if (e.shiftKey && anchorRef.current !== null) {
        const [lo, hi] = anchorRef.current < i
          ? [anchorRef.current, i]
          : [i, anchorRef.current];
        const next = new Set(prev);
        for (let k = lo; k <= hi; k += 1) {
          const path = images[k]?.path;
          if (path !== undefined) next.add(path);
        }
        return next;
      }

      if (e.metaKey) {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        anchorRef.current = i;
        return next;
      }

      anchorRef.current = i;
      return new Set([entry.path]);
    });
  }, [images]);
```

- [ ] **Step 4: Route thumbnail clicks through it**

Replace the `onClick` on `Thumb` in the grid with both handlers, and pass `checked`:

```tsx
                <Thumb
                  key={entry.path}
                  ctx={ctx.plugin}
                  path={entry.path}
                  name={entry.name}
                  mime={mimeFor(entry.name) ?? 'application/octet-stream'}
                  selected={i === index}
                  checked={selected.has(entry.path)}
                  onClick={(e) => { selectAt(i, e); void show(i); }}
                />
```

- [ ] **Step 5: Add cmd+A**

In `onKeyDown`, before the closing brace of the handler:

```tsx
    } else if (e.key === 'a' && e.metaKey) {
      e.preventDefault();
      setSelected(new Set(images.map((entry) => entry.path)));
```

- [ ] **Step 6: Accept the new props in Thumb**

In `plugins/image-viewer/src/Thumb.tsx`, change the destructured props and their type to:

```tsx
export function Thumb({
  ctx,
  path,
  name,
  mime,
  selected,
  checked,
  onClick,
}: {
  ctx: PluginContext;
  path: string;
  name: string;
  mime: string;
  selected: boolean;
  checked: boolean;
  onClick: (e: { metaKey: boolean; shiftKey: boolean }) => void;
```

The `onClick` type is a structural subset of `React.MouseEvent`, not the event itself — a plugin should not need the DOM event to express "was cmd held", and the narrower type keeps `selectAt` testable by hand later.

- [ ] **Step 7: Show the checked state**

In `Thumb.tsx`, add to the `styles` object directly after `tileSelected`. Reuse the accent
variables `tileSelected` already uses — a second pair would drift from it the first time the
theme changes:

```tsx
  tileChecked: {
    boxShadow: 'inset 0 0 0 2px var(--accent-fg, #2563eb)',
  },
```

Then change the tile's `style` prop, currently
`style={{ ...styles.tile, ...(selected ? styles.tileSelected : {}) }}`, to:

```tsx
      style={{
        ...styles.tile,
        ...(selected ? styles.tileSelected : {}),
        ...(checked ? styles.tileChecked : {}),
      }}
```

Order matters: `tileChecked` is spread last so an image that is both on the stage and in the
selection shows the ring on top of the selected background, rather than the two fighting.

- [ ] **Step 8: Show the count in the strip header**

In `index.tsx`, replace the contents of `styles.stripHead`'s div:

```tsx
              {images.length} image{images.length === 1 ? '' : 's'}
              {selected.size > 0 && <span style={styles.skipped}>{selected.size} selected</span>}
              {selected.size === 0 && skipped > 0 && <span style={styles.skipped}>{skipped} skipped</span>}
```

- [ ] **Step 9: Verify by hand**

Run: `npm run dev`, open the Image Viewer, open a folder with at least five images.

Expected:
- clicking a thumbnail shows it on the stage and marks it as the only selection
- cmd-clicking a second and third toggles them in and out without changing the stage image
- shift-clicking extends a contiguous run from the last plain click
- ⌘A selects all, and the header reads "N selected"
- opening a different folder clears the selection

- [ ] **Step 10: Commit**

```bash
git add plugins/image-viewer
git commit -m "image-viewer: select more than one image at a time"
```

---

### Task 8: Copy to folder

**Files:**
- Modify: `plugins/image-viewer/src/index.tsx`

**Interfaces:**
- Consumes: `ctx.plugin.fs.pickDirectoryForWrite`, `ctx.plugin.fs.copyFile` (Task 1, working as of Task 6); `selected` and `selectAt` (Task 7).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add recent-folder state and its storage key**

At module scope in `index.tsx`, beside the other constants:

```tsx
const RECENTS_KEY = 'recentCopyTargets';
const MAX_RECENTS = 8;
```

Inside `ImagePanel`, after the `selected` state:

```tsx
  const [recents, setRecents] = useState<string[]>([]);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    void (async () => {
      const saved = await ctx.plugin.storage.get<string[]>(RECENTS_KEY);
      if (Array.isArray(saved)) setRecents(saved.filter((s) => typeof s === 'string'));
    })();
  }, [ctx]);
```

- [ ] **Step 2: Implement the copy**

Add below `selectAt`:

```tsx
  const rememberFolder = useCallback(async (dir: string) => {
    const next = [dir, ...recents.filter((r) => r !== dir)].slice(0, MAX_RECENTS);
    setRecents(next);
    await ctx.plugin.storage.set(RECENTS_KEY, next);
  }, [ctx, recents]);

  /**
   * `defaultPath` only positions the dialog, so a recent folder still costs one
   * confirmation. That is deliberate: write grants never outlive the session
   * that created them, and the dialog is the only thing that creates one.
   */
  const copyTo = useCallback(async (defaultPath?: string) => {
    setMenuAt(null);
    const paths = images.filter((e) => selected.has(e.path)).map((e) => e.path);
    if (paths.length === 0) return;

    let dir: string | undefined;
    try {
      dir = await ctx.plugin.fs.pickDirectoryForWrite(defaultPath);
    } catch (err: unknown) {
      await ctx.plugin.ui.notify(err instanceof Error ? err.message : String(err), 'error');
      return;
    }
    if (dir === undefined) return;

    let copied = 0;
    let renamed = 0;
    const failures: string[] = [];

    // Four at a time, the same cap the thumbnail loader uses.
    const queue = [...paths];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        try {
          const result = await ctx.plugin.fs.copyFile(next, dir);
          copied += 1;
          if (result.renamed) renamed += 1;
        } catch (err: unknown) {
          failures.push(err instanceof Error ? err.message : String(err));
        }
      }
    });
    await Promise.all(workers);

    if (copied > 0) await rememberFolder(dir);

    const where = dir.slice(dir.lastIndexOf('/') + 1);
    const parts = [`${copied} copied to ${where}`];
    if (renamed > 0) parts.push(`${renamed} renamed`);
    if (failures.length > 0) parts.push(`${failures.length} failed`);
    await ctx.plugin.ui.notify(parts.join(' · '), failures.length > 0 ? 'warn' : 'info');
    if (failures[0] !== undefined) ctx.plugin.log.warn('copy failed', failures[0]);
  }, [ctx, images, selected, rememberFolder]);
```

Note `copied` and `renamed` are incremented from four concurrent workers. That is safe here — JavaScript has no preemption, and `+= 1` between awaits cannot interleave.

- [ ] **Step 3: Add the menu component**

Add above the `styles` object, at module scope:

```tsx
function CopyMenu({
  at, recents, count, onPick, onClose,
}: {
  at: { x: number; y: number };
  recents: string[];
  count: number;
  onPick: (defaultPath?: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const dismiss = () => onClose();
    window.addEventListener('click', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('click', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, [onClose]);

  return (
    <div style={{ ...styles.menu, left: at.x, top: at.y }} onClick={(e) => e.stopPropagation()}>
      <button type="button" style={styles.menuItem} onClick={() => onPick(undefined)}>
        Copy {count} image{count === 1 ? '' : 's'} to folder…
      </button>
      {recents.length > 0 && <div style={styles.menuSep} />}
      {recents.map((dir) => (
        <button
          key={dir}
          type="button"
          style={styles.menuItem}
          title={dir}
          onClick={() => onPick(dir)}
        >
          {dir.slice(dir.lastIndexOf('/') + 1)}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Add the toolbar button**

In the toolbar, inside the `images.length > 0` fragment, after the Reset button:

```tsx
            <span style={styles.sep} />
            <button
              type="button"
              style={styles.button}
              disabled={selected.size === 0}
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                setMenuAt({ x: r.left, y: r.bottom + 4 });
              }}
            >
              Copy to…
            </button>
```

- [ ] **Step 5: Open the menu on right-click**

On the grid div, add a context-menu handler. Right-clicking an unselected thumbnail selects it first, matching Finder:

```tsx
            <div
              style={styles.grid}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuAt({ x: e.clientX, y: e.clientY });
              }}
            >
```

and on the `Thumb`, add:

```tsx
                  onContextMenu={() => {
                    if (!selected.has(entry.path)) {
                      selectAt(i, { metaKey: false, shiftKey: false });
                    }
                  }}
```

This requires `Thumb` to accept and forward `onContextMenu`. Add `onContextMenu?: () => void;`
to its prop type and `onContextMenu` to the destructured list, then put it on the `<button>`
alongside the existing `onClick`. It takes no argument because the grid, not the tile, is what
positions the menu — the tile only needs to fix the selection first. The grid's handler still
fires afterwards through bubbling.

- [ ] **Step 6: Render the menu**

Just before the closing `</div>` of the root element:

```tsx
      {menuAt !== null && selected.size > 0 && (
        <CopyMenu
          at={menuAt}
          recents={recents}
          count={selected.size}
          onPick={(defaultPath) => void copyTo(defaultPath)}
          onClose={() => setMenuAt(null)}
        />
      )}
```

- [ ] **Step 7: Add the menu styles**

Add to the `styles` object in `index.tsx`:

```tsx
  menu: {
    position: 'fixed',
    zIndex: 10,
    minWidth: 200,
    padding: 4,
    borderRadius: 8,
    border: '1px solid var(--chrome-border, #d4d4d8)',
    background: 'var(--workspace-bg, #fff)',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.18)',
    display: 'flex',
    flexDirection: 'column',
  },
  menuItem: {
    font: 'inherit',
    fontSize: 12,
    textAlign: 'left',
    padding: '6px 10px',
    borderRadius: 5,
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  menuSep: { height: 1, margin: '4px 6px', background: 'var(--chrome-border, #d4d4d8)' },
```

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Verify the happy path by hand**

Run: `npm run dev`. Open a folder of images, select three, click **Copy to…**, choose **Copy N images to folder…**, pick an empty destination.

Expected: the dialog's confirm button reads "Copy Here"; a notice reads `3 copied to <folder>`; all three files are in the destination in Finder.

Then right-click a thumbnail: the menu appears at the pointer and now lists that destination by its folder name. Pick it — the dialog opens *at* that folder.

- [ ] **Step 10: Verify the refusals by hand**

Still in `npm run dev`:

1. Copy the same three images to the same destination again.
   Expected: `3 copied to <folder> · 3 renamed`, and the destination now holds `photo.png` and `photo-1.png` — the originals are unmodified.
2. Click **Copy to…** and pick your home directory itself.
   Expected: an error notice saying the home directory is too broad a write grant. Nothing is copied.
3. Click **Copy to…** and navigate to `~/Library/Application Support/Workbench`.
   Expected: an error notice naming the plugin directory. Nothing is copied.

These three are the design's security claims made visible. If any of them copies a file, stop and fix before continuing.

- [ ] **Step 11: Commit**

```bash
git add plugins/image-viewer
git commit -m "image-viewer: copy the selection to a folder, with recent destinations"
```

---

### Task 9: Record the decision

The change log is how this project explains itself to its future self. An entry that only says "added copy" wastes the two findings that shaped the design.

**Files:**
- Modify: `docs/m1-shell-change-log.md` (append entry 31)

**Interfaces:** none.

- [ ] **Step 1: Append the entry**

Add at the end of `docs/m1-shell-change-log.md`:

```markdown
---

## 31 · The first write, and the flag that keeps it inside its grant

**Feature:** image viewer copy-to-folder · **Verdict:** SDK 1.6 → 1.7, additive — and the end
of the M1 contract freeze

Copying files cannot be done inside a plugin: the `fs` surface was read-only end to end. This
adds `pickDirectoryForWrite` and `copyFile`, the first write path in the app.

**Write grants are a separate set from read grants.** Reusing `grantedDirs` would have been
fewer moving parts and would have silently made every folder the user opened to *browse* into a
folder any plugin could *write to*. Entry 30 established that picking a folder is a bigger
promise than picking a file; picking a folder to write to is bigger still, and gets its own set.

**`COPYFILE_EXCL` is a security control, not a data-safety nicety.** This was verified rather
than assumed, and the result was worse than expected:

| destination is… | plain copy | with `COPYFILE_EXCL` |
|---|---|---|
| a symlink to a file outside the grant | **followed — the outside file is destroyed** | refused `EEXIST` |
| a dangling symlink outside the grant | **followed — a file is created outside the grant** | refused `EEXIST` |

A symlink planted at the destination filename turns a copy into a write anywhere on disk.
`O_CREAT|O_EXCL` fails on an existing path including a symlink, even a dangling one, which is
what closes it. So the auto-rename loop must never fall back to a non-exclusive copy on its last
attempt — it gives up instead. Both cases are asserted in `fs-copy.test.ts`.

**A write primitive can reach the plugin directory.** M4 loads plugins from
`~/Library/Application Support/Workbench/plugins/`. A write that can target it lets a plugin
install another plugin that runs on next launch, with no prompt — a one-session bug becomes
permanent. Hence a destination deny-list, where that path is the entry that matters and
LaunchAgents, `.ssh` and the shell dotfiles are the same class with less blast radius. The
home directory itself is refused as too broad; folders inside it are fine.

**`fs` gained its first per-plugin check.** Reads are still session-global — any loaded plugin
can read a path another was granted, which is a known gap. Writes are not: `fs:write:user-selected`
is checked per plugin against the manifests, the way `net:fetch:<host>` already was.

**Known limitation, recorded rather than hidden.** The destination directory is resolved at
check time and used at copy time. A local attacker able to swap it for a symlink in between
could redirect the write. Closing it needs directory-handle-relative writes, which Node does not
expose. Accepted for a local single-user app.

**Contract impact:** additive. `pickDirectoryForWrite`, `copyFile`, `CopyResult`. Nothing
existing changed shape — but the freeze that held from M1 to M4 is now formally over, replaced
by "additive minor bumps, existing signatures immovable" (CLAUDE.md, 2026-08-21).
```

- [ ] **Step 2: Full verification**

Run: `npm test`
Expected: PASS. Roughly 29 + 6 + 13 + 11 + 5 + 1 assertions across the suites.

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run build`
Expected: completes without error — the plugin bundle picks up the new code.

- [ ] **Step 3: Commit**

```bash
git add docs/m1-shell-change-log.md
git commit -m "Record why the first write primitive looks the way it does"
```

---

## Notes for the executor

**One spec deviation, deliberate.** The spec's test list says a symlinked destination should be
"denied". The implementation *continues* to `photo-1.png` instead: the outside file is untouched
either way, so the security property holds, and the user's copy still succeeds. Hard-failing
would be equally safe but less useful. Task 4's tests assert the continue-and-rename behaviour.

**Where to be careful.** Task 4 step 5 asks you to temporarily remove `COPYFILE_EXCL` and watch
the symlink tests fail. Do it. It is the only way the next person to read that file will believe
the comment.

**Plugins have no test harness.** `vitest.config.ts` collects `packages/*/src/**/*.test.ts`
only, so Tasks 7 and 8 are verified by hand through `npm run dev`. Those manual steps are the
test; do not skip them because the automated suite is green.
