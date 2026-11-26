/**
 * ipcMain handlers for every channel in protocol.ts `IPC`. The renderer is never trusted: each handler checks the
 * sender is one of our windows and validates its payload before touching the core services.
 */
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { isAbsolute } from 'node:path';
import { IPC, type ApprovalDecision, type ColorScheme, type PanelState } from '../../shared/protocol';
import type { ApprovalBroker } from '../core/approvals';
import { openTerminalLogin, type AuthManager } from '../core/auth';
import { runDoctor } from '../core/doctor';
import { openExternalUrl } from '../core/external';
import { describePaths, toAbsolutePath } from '../core/files';
import type { Logger } from '../core/logger';
import type { SessionManager } from '../core/session-manager';
import { isValidConversationId, type ConversationStore, type OnboardingStamp, type SettingsStore } from '../core/stores';
import { revealInFileManager } from './windows';

export interface IpcServices {
  log: Logger;
  sessions: SessionManager;
  conversations: ConversationStore;
  settings: SettingsStore;
  stamp: OnboardingStamp;
  auth: AuthManager;
  approvals: ApprovalBroker;
  /** True for webContents that belong to our panel/onboarding windows. */
  isTrustedSender: (wc: WebContents) => boolean;
  panelState: (wc: WebContents) => PanelState;
  hidePanel: () => void;
  setPanelWidth: (width: number) => number;
  /** Applies settings side effects (width, reserveSpace, theme) and broadcasts the change. */
  settingsChanged: (patch: Record<string, unknown>) => Promise<void>;
  completeOnboarding: () => Promise<void>;
  colorScheme: () => ColorScheme;
}

class UntrustedSenderError extends Error {}

export function registerIpc(s: IpcServices): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: A) => R | Promise<R>): void => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!s.isTrustedSender(event.sender)) throw new UntrustedSenderError('untrusted sender');
      try {
        return await fn(event, ...(args as A));
      } catch (err) {
        s.log.warn('ipc.failed', { channel, message: (err as Error).message });
        throw err;
      }
    });
  };

  // chat
  handle(IPC.chatSend, (_e, req: unknown) => s.sessions.send(req as never));
  handle(IPC.chatStop, async (_e, id: unknown) => {
    if (isValidConversationId(id)) await s.sessions.stop(id);
  });

  // conversations
  handle(IPC.convList, () => s.conversations.list());
  handle(IPC.convGet, (_e, id: unknown) => (isValidConversationId(id) ? s.conversations.get(id) : null));
  handle(IPC.convSave, (_e, conv: unknown) => s.conversations.save(conv));
  handle(IPC.convRemove, async (_e, id: unknown) => {
    if (!isValidConversationId(id)) throw new Error('invalid conversation id');
    await s.conversations.remove(id);
  });

  // settings
  handle(IPC.settingsGet, () => s.settings.get());
  handle(IPC.settingsSet, async (_e, patch: unknown) => {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return s.settings.get();
    await s.settingsChanged(patch as Record<string, unknown>);
    return s.settings.get();
  });

  // auth
  handle(IPC.authStatus, () => s.auth.status());
  handle(IPC.authLogin, (_e, opts: unknown) => {
    const o = typeof opts === 'object' && opts !== null ? (opts as Record<string, unknown>) : {};
    const email = typeof o.email === 'string' && /^[^\s@]{1,128}@[^\s@]{1,255}$/.test(o.email) ? o.email : undefined;
    return s.auth.login({ sso: o.sso === true, ...(email ? { email } : {}) });
  });
  handle(IPC.authSubmitCode, (_e, code: unknown) => {
    if (typeof code !== 'string') throw new Error('invalid code');
    return s.auth.submitCode(code);
  });
  handle(IPC.authCancel, () => s.auth.cancel());
  handle(IPC.authLogout, () => s.auth.logout());

  // panel
  handle(IPC.panelGetState, (e) => s.panelState(e.sender));
  handle(IPC.panelHide, () => s.hidePanel());
  handle(IPC.panelSetWidth, async (_e, width: unknown) => {
    if (typeof width !== 'number' || !Number.isFinite(width)) throw new Error('invalid width');
    const applied = s.setPanelWidth(width);
    await s.settingsChanged({ panelWidth: applied });
    return applied;
  });

  // files
  handle(IPC.filesPick, async (e, opts: unknown) => {
    const directories = typeof opts === 'object' && opts !== null && (opts as { directories?: unknown }).directories === true;
    const parent = BrowserWindow.fromWebContents(e.sender);
    const dialogOpts: Electron.OpenDialogOptions = {
      title: directories ? 'Attach folders' : 'Attach files',
      properties: [directories ? 'openDirectory' : 'openFile', 'multiSelections'],
    };
    const res = parent ? await dialog.showOpenDialog(parent, dialogOpts) : await dialog.showOpenDialog(dialogOpts);
    return res.canceled ? [] : describePaths(res.filePaths);
  });
  handle(IPC.filesDescribe, (_e, paths: unknown) => (Array.isArray(paths) ? describePaths(paths) : []));
  handle(IPC.filesReveal, (_e, path: unknown) => {
    const abs = toAbsolutePath(path);
    if (!abs || !isAbsolute(abs)) throw new Error('invalid path');
    revealInFileManager(abs);
  });

  // approvals: only decisions for ids that are actually pending are accepted
  handle(IPC.approvalRespond, (_e, decision: unknown) => {
    if (typeof decision !== 'object' || decision === null) return;
    const d = decision as Partial<ApprovalDecision>;
    if (typeof d.id !== 'string' || !s.approvals.has(d.id)) return;
    if (d.decision !== 'allow' && d.decision !== 'deny') return;
    s.approvals.respond({
      id: d.id,
      decision: d.decision,
      ...(typeof d.message === 'string' && d.message.length <= 2000 ? { message: d.message } : {}),
    });
  });

  // system
  handle(IPC.systemDoctor, () => runDoctor());
  handle(IPC.systemOpenExternal, (_e, url: unknown) => {
    if (!openExternalUrl(url)) throw new Error('only http(s) links can be opened');
  });
  handle(IPC.systemOpenTerminalLogin, () => {
    if (!openTerminalLogin()) throw new Error('No terminal emulator found. Open a terminal and run: claudeos-login');
  });
  handle(IPC.systemOnboardingDone, () => s.stamp.isDone());
  handle(IPC.systemCompleteOnboarding, () => s.completeOnboarding());
  handle(IPC.systemColorScheme, () => s.colorScheme());
}
