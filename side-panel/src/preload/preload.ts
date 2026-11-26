/**
 * Preload (sandboxed, contextIsolation): exposes `window.claudeos` (ClaudeOSApi) to the renderer and nothing else.
 * Every call is a fixed IPC channel; main validates every payload again.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { IPC, type ClaudeOSApi, type Unsubscribe } from '../shared/protocol';
import { PRELOAD_IPC } from './channels';

/** Subscribes to a main → renderer channel; the returned function removes exactly this listener. */
function subscribe<T>(channel: string, cb: (value: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, value: T): void => cb(value);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/** Injected at build time by scripts/build-main.mjs (package.json version). */
declare const __CLAUDEOS_VERSION__: string;
const version = __CLAUDEOS_VERSION__;

const api: ClaudeOSApi = {
  version,
  chat: {
    send: (req) => ipcRenderer.invoke(IPC.chatSend, req),
    stop: (conversationId) => ipcRenderer.invoke(IPC.chatStop, conversationId),
    onEvent: (cb) => subscribe(IPC.chatEvent, cb),
  },
  conversations: {
    list: () => ipcRenderer.invoke(IPC.convList),
    get: (id) => ipcRenderer.invoke(IPC.convGet, id),
    save: (conversation) => ipcRenderer.invoke(IPC.convSave, conversation),
    remove: (id) => ipcRenderer.invoke(IPC.convRemove, id),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
    onChange: (cb) => subscribe(IPC.settingsChanged, cb),
  },
  auth: {
    status: () => ipcRenderer.invoke(IPC.authStatus),
    login: (opts) => ipcRenderer.invoke(IPC.authLogin, opts),
    submitCode: (code) => ipcRenderer.invoke(IPC.authSubmitCode, code),
    cancelLogin: () => ipcRenderer.invoke(IPC.authCancel),
    logout: () => ipcRenderer.invoke(IPC.authLogout),
    onLoginEvent: (cb) => subscribe(IPC.authEvent, cb),
  },
  panel: {
    getState: () => ipcRenderer.invoke(IPC.panelGetState),
    hide: () => ipcRenderer.invoke(IPC.panelHide),
    setWidth: (width) => ipcRenderer.invoke(IPC.panelSetWidth, width),
    onCommand: (cb) => {
      const unsubscribe = subscribe(IPC.panelCommand, cb);
      // Main queues commands (e.g. an `attach` that started the app) until someone listens.
      ipcRenderer.send(PRELOAD_IPC.commandsReady);
      return unsubscribe;
    },
    onState: (cb) => subscribe(IPC.panelState, cb),
  },
  files: {
    pick: (opts) => ipcRenderer.invoke(IPC.filesPick, opts),
    describe: (paths) => ipcRenderer.invoke(IPC.filesDescribe, paths),
    pathForFile: (file) => webUtils.getPathForFile(file),
    reveal: (path) => ipcRenderer.invoke(IPC.filesReveal, path),
  },
  approvals: {
    respond: (decision) => ipcRenderer.invoke(IPC.approvalRespond, decision),
  },
  system: {
    doctor: () => ipcRenderer.invoke(IPC.systemDoctor),
    openExternal: (url) => ipcRenderer.invoke(IPC.systemOpenExternal, url),
    openTerminalLogin: () => ipcRenderer.invoke(IPC.systemOpenTerminalLogin),
    isOnboardingDone: () => ipcRenderer.invoke(IPC.systemOnboardingDone),
    completeOnboarding: () => ipcRenderer.invoke(IPC.systemCompleteOnboarding),
    getColorScheme: () => ipcRenderer.invoke(IPC.systemColorScheme),
    onColorScheme: (cb) => subscribe(IPC.systemColorSchemeChanged, cb),
  },
};

contextBridge.exposeInMainWorld('claudeos', api);
