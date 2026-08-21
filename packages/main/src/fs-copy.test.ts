import { beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
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

  it('treats a leading dot as part of the stem, not an extension', () => {
    expect(candidateName('.hidden', 1)).toBe('.hidden-1');
    expect(candidateName('.hidden.png', 1)).toBe('.hidden-1.png');
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

  it('propagates a non-EEXIST error instead of retrying it as a collision', async () => {
    const locked = path.join(root, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o500);

    await expect(copyFileExclusive(source, locked)).rejects.toThrow(/EACCES|EPERM/);

    await chmod(locked, 0o700);   // so the temp dir can be cleaned up
  });
});
