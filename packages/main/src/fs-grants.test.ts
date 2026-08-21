import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertReadable,
  assertWritableDir,
  deniedWriteReason,
  grantFile,
  grantReadDir,
  grantWriteDir,
  resetGrants,
} from './fs-grants.js';

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
