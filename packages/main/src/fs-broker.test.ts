import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginManifest } from '@workbench/plugin-sdk';

/**
 * `registerFsBroker` only talks to Electron through `ipcMain.handle` and
 * `dialog.showOpenDialog`. Faking both lets the four-check composition in
 * `fs:copyFile` (and the permission check on `fs:pickDirectoryForWrite`) run
 * for real, against a real temp filesystem, with no Electron process at all.
 *
 * `vi.hoisted` is required here: `vi.mock` factories run before the rest of
 * the module body, so anything they reference has to be created through it
 * rather than as an ordinary top-level `const`.
 */
const { handlers, dialogMock } = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const dialogMock = {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
  };
  return { handlers, dialogMock };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  dialog: dialogMock,
}));

const { registerFsBroker } = await import('./fs-broker.js');
const { grantFile, grantReadDir, grantWriteDir, resetGrants } = await import('./fs-grants.js');
const { loadFsPermissions, FS_WRITE_PERMISSION } = await import('./fs-permissions.js');

const PLUGIN_ID = 'image-viewer';

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

/** `fs:copyFile` takes (event, pluginId, source, destDir). */
function copyFile(pluginId: unknown, source: unknown, destDir: unknown): Promise<unknown> {
  const handler = handlers.get('fs:copyFile');
  if (handler === undefined) throw new Error('fs:copyFile was never registered');
  return Promise.resolve(handler(undefined, pluginId, source, destDir));
}

/** `fs:pickDirectoryForWrite` takes (event, pluginId, defaultPath). */
function pickDirectoryForWrite(pluginId: unknown, defaultPath?: unknown): Promise<unknown> {
  const handler = handlers.get('fs:pickDirectoryForWrite');
  if (handler === undefined) throw new Error('fs:pickDirectoryForWrite was never registered');
  return Promise.resolve(handler(undefined, pluginId, defaultPath));
}

let root: string;
let source: string;
let dest: string;

beforeEach(async () => {
  resetGrants();
  handlers.clear();
  dialogMock.showOpenDialog.mockClear();
  dialogMock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
  registerFsBroker(() => null);

  // realpath because os.tmpdir() is itself a symlink on macOS (/var -> /private/var)
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'wb-broker-')));
  dest = path.join(root, 'dest');
  await mkdir(dest);
  source = path.join(root, 'photo.png');
  await writeFile(source, 'SOURCE-BYTES');

  loadFsPermissions([manifest(PLUGIN_ID, [FS_WRITE_PERMISSION])]);
});

describe('fs:copyFile — the four-check composition', () => {
  it('refuses a plugin without the write permission, and writes nothing', async () => {
    loadFsPermissions([manifest(PLUGIN_ID)]);   // no permissions declared
    grantFile(await realpath(source));
    grantWriteDir(await realpath(dest));

    await expect(copyFile(PLUGIN_ID, source, dest)).rejects.toThrow(/declares no/);
    expect(await readdir(dest)).toEqual([]);
  });

  it('copies the bytes when the plugin is permitted and both paths are granted', async () => {
    grantFile(await realpath(source));
    grantWriteDir(await realpath(dest));

    const result = await copyFile(PLUGIN_ID, source, dest);

    expect(result).toEqual({ name: 'photo.png', renamed: false });
    expect(await readFile(path.join(dest, 'photo.png'), 'utf8')).toBe('SOURCE-BYTES');
  });

  it('refuses a source that was never read-granted', async () => {
    grantWriteDir(await realpath(dest));
    // source is deliberately never granted

    await expect(copyFile(PLUGIN_ID, source, dest)).rejects.toThrow(/not inside anything granted/);
    expect(await readdir(dest)).toEqual([]);
  });

  it('refuses a destination that was never write-granted', async () => {
    grantFile(await realpath(source));
    // dest is deliberately never granted

    await expect(copyFile(PLUGIN_ID, source, dest)).rejects.toThrow(/not granted for writing/);
    expect(await readdir(dest)).toEqual([]);
  });

  it('refuses a destination that is write-granted but deny-listed', async () => {
    grantFile(await realpath(source));
    // /etc is a real, pre-existing system directory — denying it does not
    // depend on this machine's home directory, unlike the plugin-directory case.
    const denied = await realpath('/etc');
    grantWriteDir(denied);

    await expect(copyFile(PLUGIN_ID, source, '/etc')).rejects.toThrow(/system directory/);
  });

  it('refuses non-string arguments before touching the filesystem', async () => {
    grantFile(await realpath(source));
    grantWriteDir(await realpath(dest));

    await expect(copyFile(123, source, dest)).rejects.toThrow(/expects a plugin id/);
    await expect(copyFile(PLUGIN_ID, { evil: true }, dest)).rejects.toThrow(/expects a source path/);
    await expect(copyFile(PLUGIN_ID, source, undefined)).rejects.toThrow(/expects a destination path/);
    expect(await readdir(dest)).toEqual([]);
  });

  it('refuses a symlinked source that escapes every grant, even from inside a granted dir', async () => {
    const grantedDir = path.join(root, 'granted');
    const outsideDir = path.join(root, 'outside');
    await mkdir(grantedDir);
    await mkdir(outsideDir);
    const secret = path.join(outsideDir, 'secret.png');
    await writeFile(secret, 'SECRET-BYTES');
    const escapeLink = path.join(grantedDir, 'escape.png');
    await symlink(secret, escapeLink);

    grantReadDir(grantedDir);
    grantWriteDir(await realpath(dest));

    // escapeLink sits inside a granted read directory, but resolves outside it —
    // this is the case that would catch fs-broker passing the raw, unresolved
    // argument into copyFileExclusive instead of assertReadable's resolved return.
    await expect(copyFile(PLUGIN_ID, escapeLink, dest)).rejects.toThrow(/not inside anything granted/);
    expect(await readdir(dest)).toEqual([]);
  });
});

describe('fs:pickDirectoryForWrite — permission check', () => {
  it('refuses a plugin without the write permission, before the dialog ever shows', async () => {
    loadFsPermissions([manifest(PLUGIN_ID)]);   // no permissions declared

    await expect(pickDirectoryForWrite(PLUGIN_ID, root)).rejects.toThrow(/declares no/);
    expect(dialogMock.showOpenDialog).not.toHaveBeenCalled();
  });

  it('shows the dialog for a plugin that declares the permission', async () => {
    dialogMock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    await pickDirectoryForWrite(PLUGIN_ID, root);

    expect(dialogMock.showOpenDialog).toHaveBeenCalledTimes(1);
  });
});
