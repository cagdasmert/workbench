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
