import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
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

/**
 * Directories the user chose **for writing**, held separately from the read
 * grants on purpose: opening a photo folder to browse it must never make that
 * folder writable. Session-only, symlink-resolved, exactly like the read sets.
 */
const grantedWriteDirs = new Set<string>();

export function grantWriteDir(real: string): void {
  grantedWriteDirs.add(real);
}

/** Tests only. Grants are session state; nothing in the app clears them. */
export function resetGrants(): void {
  grantedFiles.clear();
  grantedReadDirs.clear();
  grantedWriteDirs.clear();
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

  // Anything *containing* the home directory is broader still — this covers
  // both `/` and `/Users` without naming either.
  if (isInside(real, home)) {
    return 'above the home directory, which is far too broad a write grant';
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
    ['/Library', 'a system library directory'],
    ['/usr', 'a system directory'],
    ['/bin', 'a system directory'],
    ['/sbin', 'a system directory'],
    ['/etc', 'a system directory'],
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
