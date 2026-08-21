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
