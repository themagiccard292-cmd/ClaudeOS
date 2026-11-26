/**
 * The two BrowserWindows: the right-docked panel and the centered first-run wizard. Both load the same renderer
 * bundle (the wizard with `#onboarding`). All docking math lives in core/dock.ts; this file only applies it.
 */
import { join } from 'node:path';
import { BrowserWindow, nativeTheme, screen, session, shell, type Display, type WebContents } from 'electron';
import { PANEL_MIN_WIDTH, clampPanelWidth, type ColorScheme } from '../../shared/protocol';
import { computePanelBounds, computeStrut, setStrut, xidFromHandle, ZERO_STRUT, type Rect } from '../core/dock';
import { openExternalUrl, safeExternalUrl } from '../core/external';
import type { Logger } from '../core/logger';

const LIGHT_BG = '#F5F4EF';
const DARK_BG = '#262624';

export function currentColorScheme(): ColorScheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

/** Renderer entry: CLAUDEOS_DEV_URL (a localhost dev server) or the bundled file. */
export function rendererTarget(env: NodeJS.ProcessEnv = process.env): { url: string } | { file: string } {
  const dev = env.CLAUDEOS_DEV_URL;
  if (dev) {
    try {
      const u = new URL(dev);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
        return { url: u.toString() };
      }
    } catch {
      // fall through to the bundled renderer
    }
  }
  // dist/main/main.cjs → dist/renderer/index.html (inside app.asar when packaged)
  return { file: join(__dirname, '..', 'renderer', 'index.html') };
}

function loadRenderer(win: BrowserWindow, hash?: string): void {
  const target = rendererTarget();
  if ('url' in target) void win.loadURL(hash ? `${target.url}#${hash}` : target.url);
  else void win.loadFile(target.file, hash ? { hash } : {});
}

/**
 * Locks a renderer down: no new windows, no navigation away from the app, http(s) links go to the browser,
 * every permission request (camera, notifications, …) is denied except clipboard writes.
 */
export function hardenWebContents(wc: WebContents, log: Logger): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (safeExternalUrl(url)) openExternalUrl(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (url === wc.getURL()) return; // reload
    event.preventDefault();
    if (safeExternalUrl(url)) openExternalUrl(url);
    else log.warn('window.navigation-blocked');
  });
  wc.on('will-attach-webview', (event) => event.preventDefault());
}

export function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
}

const webPreferences = (preload: string): Electron.WebPreferences => ({
  preload,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  spellcheck: true,
});

export interface PanelWindowOptions {
  preload: string;
  log: Logger;
  width: number;
  reserveSpace: boolean;
  onVisibilityChange: (visible: boolean) => void;
  onGeometryChange: () => void;
}

/** The docked panel: frameless, always on top, right edge of the primary display's work area. */
export class PanelWindow {
  readonly win: BrowserWindow;
  private width: number;
  private reserveSpace: boolean;
  private quitting = false;
  private strutWarned = false;

  constructor(private readonly opts: PanelWindowOptions) {
    this.width = opts.width;
    this.reserveSpace = opts.reserveSpace;
    const bounds = this.bounds();
    this.win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'Claude',
      backgroundColor: nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG,
      webPreferences: webPreferences(opts.preload),
    });
    this.win.setAlwaysOnTop(true, 'floating');
    this.win.setVisibleOnAllWorkspaces(true);
    this.win.setMenu(null);
    hardenWebContents(this.win.webContents, opts.log);

    // Closing (e.g. Alt+F4) hides the panel; only quitting the app destroys it.
    this.win.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.hide();
    });
    for (const ev of ['display-metrics-changed', 'display-added', 'display-removed'] as const) {
      screen.on(ev as 'display-added', () => this.redock());
    }
    nativeTheme.on('updated', () => this.win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG));
    loadRenderer(this.win);
  }

  get visible(): boolean {
    return !this.win.isDestroyed() && this.win.isVisible();
  }

  get currentWidth(): number {
    return this.width;
  }

  /** Largest width the current display allows. */
  get maxWidth(): number {
    return clampPanelWidth(Number.MAX_SAFE_INTEGER, this.dockArea().width);
  }

  get minWidth(): number {
    return PANEL_MIN_WIDTH;
  }

  markQuitting(): void {
    this.quitting = true;
  }

  show(): boolean {
    if (this.win.isDestroyed()) return false;
    this.redock();
    this.win.show();
    this.win.focus();
    this.applyStrut();
    this.opts.onVisibilityChange(true);
    return true;
  }

  hide(): boolean {
    if (this.win.isDestroyed()) return false;
    this.win.hide();
    this.applyStrut();
    this.opts.onVisibilityChange(false);
    return false;
  }

  /** Super+C semantics: hide when visible and focused, otherwise bring it up and focus it. */
  toggle(): boolean {
    return this.visible && this.win.isFocused() ? this.hide() : this.show();
  }

  /** Applies a new width (clamped to the display) and returns the width actually used. */
  setWidth(width: number): number {
    this.width = clampPanelWidth(width, this.dockArea().width);
    this.redock();
    return this.width;
  }

  setReserveSpace(reserve: boolean): void {
    if (reserve === this.reserveSpace) return;
    this.reserveSpace = reserve;
    this.redock();
  }

  /** Re-applies bounds and struts (display/work-area changes, width changes). */
  redock(): void {
    if (this.win.isDestroyed()) return;
    const b = this.bounds();
    this.width = b.width;
    this.win.setBounds(b);
    this.applyStrut();
    this.opts.onGeometryChange();
  }

  private display(): Display {
    return screen.getPrimaryDisplay();
  }

  /**
   * The area the panel docks into. With reserveSpace the WM's work area already excludes our own strut, so the
   * right edge is taken from the display bounds to avoid the panel pushing itself left.
   */
  private dockArea(): Rect {
    const d = this.display();
    const wa = d.workArea;
    if (!this.reserveSpace) return wa;
    const right = d.bounds.x + d.bounds.width;
    return { x: wa.x, y: wa.y, width: right - wa.x, height: wa.height };
  }

  private bounds(): Rect {
    return computePanelBounds(this.dockArea(), this.width);
  }

  private applyStrut(): void {
    if (this.win.isDestroyed()) return;
    const xid = xidFromHandle(this.win.getNativeWindowHandle());
    const active = this.reserveSpace && this.win.isVisible();
    const rootRight = Math.max(...screen.getAllDisplays().map((d) => d.bounds.x + d.bounds.width));
    const strut = active ? computeStrut(this.win.getBounds(), rootRight, this.display().scaleFactor) : ZERO_STRUT;
    void setStrut(xid, strut).then((ok) => {
      if (!ok && active && !this.strutWarned) {
        this.strutWarned = true; // once per run: typically xprop is missing or no X display
        this.opts.log.warn('dock.strut-failed');
      }
    });
  }
}

/** The first-run wizard window (centered, normal stacking, same renderer with #onboarding). */
export function createOnboardingWindow(preload: string, log: Logger): BrowserWindow {
  const win = new BrowserWindow({
    width: 920,
    height: 680,
    minWidth: 720,
    minHeight: 560,
    center: true,
    show: false,
    title: 'Welcome to ClaudeOS',
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG,
    webPreferences: webPreferences(preload),
  });
  win.setMenu(null);
  hardenWebContents(win.webContents, log);
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  loadRenderer(win, 'onboarding');
  return win;
}

/** Reveals a file in the file manager (FileManager1 D-Bus via Electron, xdg-open fallback inside Electron). */
export function revealInFileManager(path: string): void {
  shell.showItemInFolder(path);
}
