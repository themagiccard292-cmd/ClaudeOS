/**
 * Wires the electron-free core services to Electron: windows, IPC, the C1 socket server and app lifecycle.
 * Implements `PanelController` for socket commands (and for commands given on the first launch's command line).
 */
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, nativeTheme, type WebContents } from 'electron';
import { IPC, type PanelCommand, type PanelSettings, type PanelState } from '../../shared/protocol';
import { PRELOAD_IPC } from '../../preload/channels';
import { ApprovalBroker, type ApprovalInput, type ApprovalOutcome } from '../core/approvals';
import { AuthManager, openTerminalLogin } from '../core/auth';
import { openExternalUrl } from '../core/external';
import { describePaths } from '../core/files';
import type { Logger } from '../core/logger';
import { PanelServer, type PanelController, type PanelStatusInfo } from '../core/panel-server';
import { SessionManager } from '../core/session-manager';
import { ConversationStore, OnboardingStamp, SettingsStore } from '../core/stores';
import { registerIpc } from './ipc';
import { createOnboardingWindow, currentColorScheme, hardenSession, PanelWindow } from './windows';

interface Delivery {
  ready: boolean;
  queue: PanelCommand[];
}

export interface ClaudeOSAppOptions {
  log: Logger;
  configDir: string;
  socketPath: string;
  /** Start with the panel hidden. */
  background: boolean;
}

export class ClaudeOSApp implements PanelController {
  readonly server: PanelServer;
  private readonly log: Logger;
  private readonly settingsStore: SettingsStore;
  private readonly conversations: ConversationStore;
  private readonly stamp: OnboardingStamp;
  private readonly approvals: ApprovalBroker;
  private readonly sessions: SessionManager;
  private readonly auth: AuthManager;
  private panel!: PanelWindow;
  private onboardingWin: BrowserWindow | null = null;
  private readonly deliveries = new Map<number, Delivery>();
  private signedIn: boolean | null = null;
  private currentReserve = true;
  private shuttingDown = false;
  private readonly preload = join(__dirname, 'preload.cjs');

  constructor(private readonly opts: ClaudeOSAppOptions) {
    this.log = opts.log;
    this.settingsStore = new SettingsStore(opts.configDir);
    this.conversations = new ConversationStore(opts.configDir);
    this.stamp = new OnboardingStamp(opts.configDir);
    this.approvals = new ApprovalBroker({ sendCommand: (c) => this.sendCommand(c) });
    this.sessions = new SessionManager({
      logger: this.log,
      emit: (e) => {
        if (e.type === 'auth-required') this.signedIn = false;
        this.broadcast(IPC.chatEvent, e);
      },
    });
    this.auth = new AuthManager({
      logger: this.log,
      openUrl: (url) => openExternalUrl(url),
      openTerminal: () => openTerminalLogin(),
      emit: (e) => {
        if (e.type === 'success') this.signedIn = e.status.loggedIn;
        this.broadcast(IPC.authEvent, e);
      },
    });
    this.server = new PanelServer({ socketPath: opts.socketPath, controller: this, logger: this.log });
  }

  /** Creates the windows and registers IPC. Call after `app.whenReady()`, before `server.start()`. */
  async init(): Promise<void> {
    hardenSession();
    const settings = await this.settingsStore.get();
    nativeTheme.themeSource = settings.theme;
    this.currentReserve = settings.reserveSpace;
    nativeTheme.on('updated', () => {
      this.broadcast(IPC.systemColorSchemeChanged, currentColorScheme());
      this.broadcastPanelState();
    });

    this.panel = new PanelWindow({
      preload: this.preload,
      log: this.log,
      width: settings.panelWidth,
      reserveSpace: settings.reserveSpace,
      onVisibilityChange: (visible) => {
        this.sendCommand({ type: 'visibility', visible });
        this.broadcastPanelState();
      },
      onGeometryChange: () => this.broadcastPanelState(),
    });
    this.track(this.panel.win.webContents, true);
    // Let the panel's close handler (which normally just hides) through once the app is really quitting.
    app.on('before-quit', () => this.panel.markQuitting());

    ipcMain.on(PRELOAD_IPC.commandsReady, (event) => {
      const d = this.deliveries.get(event.sender.id);
      if (!d || d.ready) return;
      d.ready = true;
      for (const c of d.queue.splice(0)) event.sender.send(IPC.panelCommand, c);
    });

    registerIpc({
      log: this.log,
      sessions: this.sessions,
      conversations: this.conversations,
      settings: this.settingsStore,
      stamp: this.stamp,
      auth: this.auth,
      approvals: this.approvals,
      isTrustedSender: (wc) => this.deliveries.has(wc.id),
      panelState: (wc) => this.panelState(wc),
      hidePanel: () => void this.panel.hide(),
      setPanelWidth: (w) => this.panel.setWidth(w),
      settingsChanged: (patch) => this.applySettings(patch),
      completeOnboarding: () => this.completeOnboarding(),
      colorScheme: currentColorScheme,
    });

    if (!this.opts.background) this.panel.show();
    void this.refreshSignedIn();
  }

  // ───────────────────────────── PanelController (socket + argv) ─────────────────────────────

  toggle(): boolean {
    return this.panel.toggle();
  }

  show(): boolean {
    return this.panel.show();
  }

  hide(): boolean {
    return this.panel.hide();
  }

  newChat(): void {
    this.panel.show();
    this.sendCommand({ type: 'new-chat' });
  }

  async attach(paths: string[], newChat: boolean): Promise<number> {
    const attachments = await describePaths(paths);
    this.panel.show();
    this.sendCommand({ type: 'attach', attachments, newChat });
    return attachments.length;
  }

  async ask(text: string, paths: string[], send: boolean): Promise<void> {
    const attachments = await describePaths(paths);
    this.panel.show();
    this.sendCommand({ type: 'ask', text, send, attachments });
  }

  onboarding(): void {
    if (this.onboardingWin && !this.onboardingWin.isDestroyed()) {
      this.onboardingWin.show();
      this.onboardingWin.focus();
      return;
    }
    const win = createOnboardingWindow(this.preload, this.log);
    this.onboardingWin = win;
    this.track(win.webContents, false);
    win.on('closed', () => {
      if (this.onboardingWin === win) this.onboardingWin = null;
    });
  }

  status(): PanelStatusInfo {
    if (this.signedIn === null) void this.refreshSignedIn();
    return { visible: this.panel.visible, width: this.panel.currentWidth, signedIn: this.signedIn, version: app.getVersion() };
  }

  quit(): void {
    app.quit();
  }

  requestApproval(input: Omit<ApprovalInput, 'source'>, signal: AbortSignal): Promise<ApprovalOutcome> {
    this.panel.show();
    return this.approvals.request({ ...input, source: 'mcp' }, signal);
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /** Stops everything: approvals denied, claude processes killed, socket removed. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log.info('app.shutdown');
    this.panel?.markQuitting();
    this.approvals.cancelAll('The panel is closing');
    this.auth.dispose();
    await Promise.allSettled([this.server.stop(), this.sessions.shutdown()]);
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** Registers a renderer for broadcasts/commands and resets its delivery state on reload. */
  private track(wc: WebContents, isPanel: boolean): void {
    const id = wc.id;
    this.deliveries.set(id, { ready: false, queue: [] });
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      const d = this.deliveries.get(id);
      if (!d) return;
      d.ready = false;
      if (isPanel) {
        // Approval cards die with the old page: deny them rather than leave them dangling (fail closed).
        this.approvals.cancelAll('The panel was reloaded');
        d.queue = d.queue.filter((c) => c.type !== 'approval-cancelled');
      }
    });
    wc.on('render-process-gone', (_e, details) => {
      this.log.error('renderer.gone', { reason: details.reason });
      if (isPanel) this.approvals.cancelAll('The panel crashed');
      if (!wc.isDestroyed() && details.reason !== 'clean-exit') wc.reload();
    });
    wc.once('destroyed', () => this.deliveries.delete(id));
  }

  /** Panel commands go to the panel window only, queued until its renderer subscribed. */
  private sendCommand(command: PanelCommand): void {
    const wc = this.panel?.win.webContents;
    if (!wc || wc.isDestroyed()) return;
    const d = this.deliveries.get(wc.id);
    if (!d) return;
    if (d.ready) wc.send(IPC.panelCommand, command);
    else d.queue.push(command);
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      const wc = win.webContents;
      if (!wc.isDestroyed() && this.deliveries.has(wc.id)) wc.send(channel, payload);
    }
  }

  private panelState(wc?: WebContents): PanelState {
    const session = process.env.XDG_SESSION_TYPE;
    return {
      visible: this.panel.visible,
      width: this.panel.currentWidth,
      minWidth: this.panel.minWidth,
      maxWidth: this.panel.maxWidth,
      reserveSpace: this.currentReserve,
      sessionType: session === 'wayland' || session === 'x11' ? session : 'unknown',
      colorScheme: currentColorScheme(),
      onboardingWindow: Boolean(wc && this.onboardingWin && !this.onboardingWin.isDestroyed() && wc.id === this.onboardingWin.webContents.id),
    };
  }

  private broadcastPanelState(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      const wc = win.webContents;
      if (!wc.isDestroyed() && this.deliveries.has(wc.id)) wc.send(IPC.panelState, this.panelState(wc));
    }
  }

  /** Persists a settings patch and applies its live effects (width, reserveSpace, theme). */
  private async applySettings(patch: Record<string, unknown>): Promise<void> {
    const before: PanelSettings = await this.settingsStore.get();
    let next = await this.settingsStore.set(patch);
    if (next.reserveSpace !== before.reserveSpace) this.panel.setReserveSpace(next.reserveSpace);
    this.currentReserve = next.reserveSpace;
    if (next.panelWidth !== before.panelWidth || next.panelWidth !== this.panel.currentWidth) {
      const applied = this.panel.setWidth(next.panelWidth);
      if (applied !== next.panelWidth) next = await this.settingsStore.set({ panelWidth: applied });
    }
    if (next.theme !== before.theme) nativeTheme.themeSource = next.theme;
    this.broadcast(IPC.settingsChanged, next);
    this.broadcastPanelState();
  }

  private async completeOnboarding(): Promise<void> {
    await this.stamp.markDone();
    this.log.info('onboarding.done');
    const win = this.onboardingWin;
    this.onboardingWin = null;
    if (win && !win.isDestroyed()) win.close();
    this.panel.show();
  }

  private async refreshSignedIn(): Promise<void> {
    try {
      const st = await this.auth.status();
      this.signedIn = st.claudeInstalled ? st.loggedIn : false;
    } catch {
      // stays unknown
    }
  }
}
