/**
 * ClaudeOS panel — shared IPC contract between the Electron main process (+ preload) and the React renderer.
 *
 * Owner: architecture. Both sides import from here. RULES:
 *  - Existing exports may only be changed by the architect; add new exports at the END of the relevant section.
 *  - The renderer talks to the world ONLY through `window.claudeos` (type `ClaudeOSApi`).
 *  - Main implements it in the preload (contextBridge) using the `IPC` channel names below.
 * See docs/ARCHITECTURE.md (C1–C3, C8, C9) for semantics.
 */

// ───────────────────────────── Models / effort / settings ─────────────────────────────

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Permission modes accepted by `claude --permission-mode` (2.1.x). */
// 'bypassPermissions' is deliberately absent: managed settings disable it (disableBypassPermissionsMode) and claude would refuse to start.
export type PermissionMode = 'acceptEdits' | 'manual' | 'plan' | 'auto' | 'dontAsk';

export interface ModelOption {
  /** Alias passed to `claude --model`. */
  alias: string;
  /** Label shown in the composer pill, e.g. "Opus 5.5". */
  label: string;
  description: string;
}

export const MODELS: readonly ModelOption[] = [
  { alias: 'opus', label: 'Opus 5.5', description: 'Most capable for complex work' },
  { alias: 'sonnet', label: 'Sonnet 5.5', description: 'Fast and smart for everyday tasks' },
  { alias: 'haiku', label: 'Haiku 5.5', description: 'Fastest for quick answers' },
  { alias: 'fable', label: 'Fable 5.2', description: 'Long-form and creative work' },
] as const;

export const EFFORTS: readonly { id: EffortLevel; label: string; short: string }[] = [
  { id: 'low', label: 'Low', short: 'Low' },
  { id: 'medium', label: 'Medium', short: 'Med' },
  { id: 'high', label: 'High', short: 'High' },
  { id: 'xhigh', label: 'Extra high', short: 'XHigh' },
  { id: 'max', label: 'Max', short: 'Max' },
] as const;

export type ThemePreference = 'system' | 'light' | 'dark';
export type ColorScheme = 'light' | 'dark';

export interface PanelSettings {
  model: string; // ModelOption.alias
  effort: EffortLevel;
  permissionMode: PermissionMode;
  /** Panel width in CSS px (right-docked). */
  panelWidth: number;
  /** Reserve screen space via _NET_WM_STRUT_PARTIAL (dock mode) instead of overlaying other windows. */
  reserveSpace: boolean;
  theme: ThemePreference;
  historyOpen: boolean;
}

export const PANEL_MIN_WIDTH = 340;
export const PANEL_DEFAULT_WIDTH = 440;
/** max width = min(this fraction of the work area, PANEL_MAX_WIDTH_ABS) */
export const PANEL_MAX_WIDTH_FRACTION = 0.6;
export const PANEL_MAX_WIDTH_ABS = 1100;

export const DEFAULT_SETTINGS: PanelSettings = {
  model: 'opus',
  effort: 'medium',
  permissionMode: 'acceptEdits',
  panelWidth: PANEL_DEFAULT_WIDTH,
  reserveSpace: true,
  theme: 'system',
  historyOpen: false,
};

/** Text for the compact composer pill, e.g. "Opus 5.5 · Med". Unknown aliases fall back to the alias itself. */
export function modelPillLabel(s: Pick<PanelSettings, 'model' | 'effort'>): string {
  const m = MODELS.find((x) => x.alias === s.model)?.label ?? s.model;
  const e = EFFORTS.find((x) => x.id === s.effort)?.short ?? s.effort;
  return `${m} · ${e}`;
}

export function clampPanelWidth(width: number, workAreaWidth: number): number {
  const max = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH_ABS, Math.floor(workAreaWidth * PANEL_MAX_WIDTH_FRACTION)));
  if (!Number.isFinite(width)) return PANEL_DEFAULT_WIDTH;
  return Math.max(PANEL_MIN_WIDTH, Math.min(max, Math.round(width)));
}

// ───────────────────────────── Attachments (the "+" pills) ─────────────────────────────

export interface Attachment {
  /** Stable id (e.g. the absolute path); used as React key. */
  id: string;
  /** Absolute path on the local filesystem. */
  path: string;
  /** Basename shown on the pill. */
  name: string;
  kind: 'file' | 'directory' | 'image' | 'missing';
  sizeBytes?: number;
  mimeType?: string;
}

// ───────────────────────────── Chat ─────────────────────────────

export type ConversationStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'error';

export interface SendMessageRequest {
  conversationId: string;
  text: string;
  attachments: Attachment[];
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  /** Claude Code session id to `--resume` (from a previous `session` event); undefined for a new conversation. */
  resumeSessionId?: string;
}

export type SendResult = { ok: true } | { ok: false; error: string };

/** Streaming events main → renderer. One conversation can be active at a time per panel, but ids are always present. */
export type ChatEvent =
  | { type: 'status'; conversationId: string; status: ConversationStatus; error?: string }
  | {
      type: 'session';
      conversationId: string;
      sessionId: string;
      model: string;
      tools: string[];
      mcpServers: { name: string; status: string }[];
    }
  | { type: 'assistant-text-delta'; conversationId: string; messageId: string; text: string }
  | { type: 'thinking-delta'; conversationId: string; messageId: string; text: string }
  | { type: 'tool-use'; conversationId: string; messageId: string; toolUseId: string; name: string; input: unknown }
  | {
      type: 'tool-result';
      conversationId: string;
      toolUseId: string;
      output: string;
      isError: boolean;
      /** data: URL when the tool returned an image (e.g. screenshot). */
      imageDataUrl?: string;
    }
  | { type: 'assistant-message-complete'; conversationId: string; messageId: string }
  | {
      type: 'turn-complete';
      conversationId: string;
      isError: boolean;
      resultText?: string;
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
    }
  | { type: 'auth-required'; conversationId: string }
  | { type: 'error'; conversationId: string; message: string };

// ───────────────────────────── Persisted conversations (renderer reduces events, then saves) ─────────────────────────────

export type MessageBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool';
      toolUseId: string;
      name: string;
      input: unknown;
      output?: string;
      isError?: boolean;
      imageDataUrl?: string;
      status: 'running' | 'done' | 'error';
    };

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  blocks: MessageBlock[];
  attachments?: Attachment[];
  createdAt: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  model: string;
  messageCount: number;
}

export interface Conversation extends ConversationSummary {
  effort: EffortLevel;
  messages: StoredMessage[];
}

// ───────────────────────────── Approvals (safety confirmations) ─────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ApprovalRequest {
  id: string;
  /** Tool being gated, e.g. "Bash" or "mcp__claudeos-desktop__run_command". */
  tool: string;
  input: unknown;
  /** One-line human summary, e.g. "Run: sudo apt remove firefox". */
  summary: string;
  risk: RiskLevel;
  reason?: string;
  source: 'claude-code' | 'mcp';
  timeoutMs: number;
}

export interface ApprovalDecision {
  id: string;
  decision: 'allow' | 'deny';
  message?: string;
}

// ───────────────────────────── Auth (Claude Pro/Max subscription OAuth — never API keys) ─────────────────────────────

export interface AuthStatus {
  claudeInstalled: boolean;
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  version?: string;
  error?: string;
}

export type LoginEvent =
  | { type: 'started' }
  | { type: 'url'; url: string }
  | { type: 'need-code' }
  | { type: 'success'; status: AuthStatus }
  | { type: 'failed'; message: string }
  | { type: 'cancelled' }
  | { type: 'fallback-terminal' };

// ───────────────────────────── Doctor (claudeos-doctor --json) ─────────────────────────────

export interface DoctorCheck {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail?: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

// ───────────────────────────── Panel window / commands ─────────────────────────────

export interface PanelState {
  visible: boolean;
  width: number;
  minWidth: number;
  maxWidth: number;
  reserveSpace: boolean;
  sessionType: 'wayland' | 'x11' | 'unknown';
  colorScheme: ColorScheme;
  /** true when this window is the first-run wizard window, not the docked panel */
  onboardingWindow: boolean;
}

/** Commands pushed main → renderer (from the socket / CLI / Nautilus). */
export type PanelCommand =
  | { type: 'attach'; attachments: Attachment[]; newChat: boolean }
  | { type: 'ask'; text: string; send: boolean; attachments: Attachment[] }
  | { type: 'new-chat' }
  | { type: 'show-onboarding' }
  | { type: 'visibility'; visible: boolean }
  | { type: 'approval-request'; request: ApprovalRequest }
  | { type: 'approval-cancelled'; id: string };

// ───────────────────────────── The renderer-facing API (window.claudeos) ─────────────────────────────

export type Unsubscribe = () => void;

export interface ClaudeOSApi {
  version: string;
  chat: {
    send(req: SendMessageRequest): Promise<SendResult>;
    /** Interrupt the running turn (SIGINT → SIGKILL after 3 s). */
    stop(conversationId: string): Promise<void>;
    onEvent(cb: (e: ChatEvent) => void): Unsubscribe;
  };
  conversations: {
    list(): Promise<ConversationSummary[]>;
    get(id: string): Promise<Conversation | null>;
    save(conversation: Conversation): Promise<void>;
    remove(id: string): Promise<void>;
  };
  settings: {
    get(): Promise<PanelSettings>;
    set(patch: Partial<PanelSettings>): Promise<PanelSettings>;
    onChange(cb: (s: PanelSettings) => void): Unsubscribe;
  };
  auth: {
    status(): Promise<AuthStatus>;
    /** Starts `claude auth login --claudeai`; progress arrives via onLoginEvent. */
    login(opts?: { sso?: boolean; email?: string }): Promise<void>;
    submitCode(code: string): Promise<void>;
    cancelLogin(): Promise<void>;
    logout(): Promise<AuthStatus>;
    onLoginEvent(cb: (e: LoginEvent) => void): Unsubscribe;
  };
  panel: {
    getState(): Promise<PanelState>;
    hide(): Promise<void>;
    /** Resize from the drag handle. Returns the clamped width actually applied. */
    setWidth(width: number): Promise<number>;
    onCommand(cb: (c: PanelCommand) => void): Unsubscribe;
    onState(cb: (s: PanelState) => void): Unsubscribe;
  };
  files: {
    /** Native file/folder picker. */
    pick(opts?: { directories?: boolean }): Promise<Attachment[]>;
    /** Stat absolute paths into Attachment pills (missing paths → kind 'missing'). */
    describe(paths: string[]): Promise<Attachment[]>;
    /** Absolute path for a File dropped on the window (webUtils.getPathForFile). */
    pathForFile(file: File): string;
    reveal(path: string): Promise<void>;
  };
  approvals: {
    respond(decision: ApprovalDecision): Promise<void>;
  };
  system: {
    doctor(): Promise<DoctorReport>;
    openExternal(url: string): Promise<void>;
    openTerminalLogin(): Promise<void>;
    isOnboardingDone(): Promise<boolean>;
    completeOnboarding(): Promise<void>;
    getColorScheme(): Promise<ColorScheme>;
    onColorScheme(cb: (s: ColorScheme) => void): Unsubscribe;
  };
}

declare global {
  interface Window {
    claudeos: ClaudeOSApi;
  }
}

/** IPC channel names (main `ipcMain.handle` / webContents.send ↔ preload). */
export const IPC = {
  chatSend: 'chat:send',
  chatStop: 'chat:stop',
  chatEvent: 'chat:event',
  convList: 'conversations:list',
  convGet: 'conversations:get',
  convSave: 'conversations:save',
  convRemove: 'conversations:remove',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsChanged: 'settings:changed',
  authStatus: 'auth:status',
  authLogin: 'auth:login',
  authSubmitCode: 'auth:submit-code',
  authCancel: 'auth:cancel',
  authLogout: 'auth:logout',
  authEvent: 'auth:event',
  panelGetState: 'panel:get-state',
  panelHide: 'panel:hide',
  panelSetWidth: 'panel:set-width',
  panelCommand: 'panel:command',
  panelState: 'panel:state',
  filesPick: 'files:pick',
  filesDescribe: 'files:describe',
  filesReveal: 'files:reveal',
  approvalRespond: 'approvals:respond',
  systemDoctor: 'system:doctor',
  systemOpenExternal: 'system:open-external',
  systemOpenTerminalLogin: 'system:open-terminal-login',
  systemOnboardingDone: 'system:onboarding-done',
  systemCompleteOnboarding: 'system:complete-onboarding',
  systemColorScheme: 'system:color-scheme',
  systemColorSchemeChanged: 'system:color-scheme-changed',
} as const;
