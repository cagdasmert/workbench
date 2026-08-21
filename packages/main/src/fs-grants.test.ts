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
