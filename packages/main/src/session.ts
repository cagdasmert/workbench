import { app, ipcMain, screen, type BrowserWindow } from 'electron';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export interface Session {
  bounds?: { x: number; y: number; width: number; height: number };
  activePanelId?: string;
}

const DEFAULT_BOUNDS = { width: 1280, height: 820 };

let session: Session = {};
let saveTimer: NodeJS.Timeout | null = null;

function sessionFile(): string {
  return path.join(app.getPath('userData'), 'sessions', 'last.json');
}

export async function loadSession(): Promise<void> {
  try {
    const raw = await readFile(sessionFile(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) session = parsed as Session;
  } catch {
    session = {};
  }
}

function scheduleSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void (async () => {
      try {
        const file = sessionFile();
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify(session, null, 2), 'utf8');
        await rename(`${file}.tmp`, file);
      } catch (err) {
        console.error('[session] save failed', err);
      }
    })();
  }, 400);
}

/**
 * Restored bounds have to be re-validated against the *current* displays. A
 * window saved on an external monitor that is no longer attached would otherwise
 * be restored entirely offscreen, with no way to drag it back.
 */
export function initialBounds(): { width: number; height: number; x?: number; y?: number } {
  const saved = session.bounds;
  if (saved === undefined) return DEFAULT_BOUNDS;

  const visible = screen.getAllDisplays().some((display) => {
    const a = display.workArea;
    // require a reasonable overlap, not merely a touching corner
    const overlapX = Math.min(saved.x + saved.width, a.x + a.width) - Math.max(saved.x, a.x);
    const overlapY = Math.min(saved.y + saved.height, a.y + a.height) - Math.max(saved.y, a.y);
    return overlapX > 120 && overlapY > 80;
  });

  if (!visible) {
    console.warn('[session] saved window bounds are offscreen — using defaults');
    return { width: saved.width, height: saved.height };
  }
  return saved;
}

export function trackWindow(win: BrowserWindow): void {
  const remember = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    session.bounds = win.getNormalBounds();
    scheduleSave();
  };
  win.on('resize', remember);
  win.on('move', remember);
}

export function registerSessionBroker(): void {
  ipcMain.handle('session:get', () => session);

  ipcMain.handle('session:setPanel', (_e, rawPanelId: unknown) => {
    if (rawPanelId === null || rawPanelId === undefined) {
      delete session.activePanelId;
    } else if (typeof rawPanelId === 'string') {
      session.activePanelId = rawPanelId;
    } else {
      throw new Error('session:setPanel expects a panel id or null');
    }
    scheduleSave();
  });
}
