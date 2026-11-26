/**
 * In-memory implementation of `window.claudeos` for `vite` in a browser, the screenshot script and the tests.
 * It is only installed when the Electron preload did NOT provide `window.claudeos` (see main.tsx), so production
 * never touches it. Everything is scripted and offline: a streamed answer with markdown, a code block, thinking,
 * tool calls (incl. a screenshot image), approval requests, a sign-in flow and a doctor report.
 *
 * Select a scenario with `?mock=signedout|onboarding|approval|streaming|empty` (default `empty`) and the stream
 * speed with `?speed=fast|slow`.
 */
import {
  type ApprovalDecision,
  type ApprovalRequest,
  type Attachment,
  type AuthStatus,
  type ChatEvent,
  type ClaudeOSApi,
  type ColorScheme,
  type Conversation,
  DEFAULT_SETTINGS,
  type DoctorReport,
  type LoginEvent,
  type PanelCommand,
  type PanelSettings,
  type PanelState,
  type SendMessageRequest,
  clampPanelWidth,
} from '../../shared/protocol';

export type MockMode = 'empty' | 'signedout' | 'onboarding' | 'approval' | 'streaming' | 'notinstalled';

export interface MockOptions {
  mode?: MockMode;
  /** Milliseconds between scripted stream steps (0 = next macrotask). */
  tickMs?: number;
  /** Seed the Recents list with sample conversations. */
  seedHistory?: boolean;
  now?: () => number;
}

interface Emitter<T> {
  on(cb: (v: T) => void): () => void;
  emit(v: T): void;
  readonly size: number;
}

/**
 * Tiny event emitter. With `buffer`, values emitted before anyone listens are delivered on the next macrotask after
 * the first subscription — to every listener present by then (the UI subscribes several hooks in one commit).
 */
function emitter<T>(buffer = false): Emitter<T> {
  const listeners = new Set<(v: T) => void>();
  const pending: T[] = [];
  return {
    on(cb) {
      listeners.add(cb);
      if (buffer && pending.length) {
        setTimeout(() => pending.splice(0).forEach((v) => listeners.forEach((l) => l(v))), 0);
      }
      return () => {
        listeners.delete(cb);
      };
    },
    emit(v) {
      if (listeners.size === 0 && buffer) pending.push(v);
      else listeners.forEach((cb) => cb(v));
    },
    get size() {
      return listeners.size;
    },
  };
}

export interface MockControls {
  emitChat(e: ChatEvent): void;
  emitCommand(c: PanelCommand): void;
  emitLogin(e: LoginEvent): void;
  setColorScheme(s: ColorScheme): void;
  setAuth(status: Partial<AuthStatus>): void;
  /** Approval decisions received from the UI. */
  readonly decisions: ApprovalDecision[];
  /** Every chat.send request received. */
  readonly sent: SendMessageRequest[];
  readonly saved: Conversation[];
  readonly settings: PanelSettings;
  /** Live listener counts, used by tests to assert components unsubscribe on unmount. */
  listenerCounts(): Record<string, number>;
}

export type MockApi = ClaudeOSApi & { mock: MockControls };

// ───────────────────────────── Scripted content ─────────────────────────────

const THINKING =
  'They want to know what is filling the disk. I should measure the biggest folders in their home directory first, ' +
  'then open Disk Usage Analyzer and take a screenshot so I can describe it visually.';

const ANSWER_INTRO = 'I’ll check what’s taking up space in your home folder.';

const ANSWER_BODY = `## Here’s where your space went

Your home folder uses **38 GB**. Most of it is in three places:

| Folder | Size | Notes |
|---|---|---|
| \`~/Videos\` | 18 GB | Screen recordings from March |
| \`~/Downloads\` | 9.4 GB | Two ISO images (7.8 GB) |
| \`~/.cache\` | 4.1 GB | Safe to clear — apps rebuild it |

The cache is the easy win. To clear anything older than a month yourself:

\`\`\`bash
# Remove cached files not used in 30 days
find ~/.cache -type f -atime +30 -delete
du -sh ~/.cache
\`\`\`

> Tip: Disk Usage Analyzer (now open) lets you click any ring to drill in.

Want me to move the old recordings to your external drive?`;

const DU_OUTPUT = `38G\t/home/you
18G\t/home/you/Videos
9.4G\t/home/you/Downloads
4.1G\t/home/you/.cache
3.2G\t/home/you/Pictures
1.1G\t/home/you/Documents`;

/** A small vector "screenshot" (Disk Usage Analyzer on a warm desktop), as a data URL. */
export const SAMPLE_SCREENSHOT = `data:image/svg+xml;base64,${btoa(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
<defs><linearGradient id="w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E8C4A8"/><stop offset="1" stop-color="#C9785A"/></linearGradient></defs>
<rect width="640" height="400" fill="url(#w)"/>
<rect width="640" height="22" fill="#1E1E1C"/><text x="320" y="15" font-family="sans-serif" font-size="11" fill="#ECEAE3" text-anchor="middle">Tue 14:32</text>
<rect x="70" y="50" width="500" height="310" rx="10" fill="#FAF9F6" stroke="#D8D5CC"/>
<rect x="70" y="50" width="500" height="36" rx="10" fill="#EFEDE7"/><rect x="70" y="76" width="500" height="10" fill="#EFEDE7"/>
<text x="320" y="73" font-family="sans-serif" font-size="13" font-weight="600" fill="#3a3834" text-anchor="middle">Disk Usage Analyzer</text>
<g transform="translate(220 220)"><circle r="95" fill="#F1E3DA"/>
<path d="M0 0 L0 -95 A95 95 0 0 1 90 30 Z" fill="#D97757"/><path d="M0 0 L90 30 A95 95 0 0 1 -20 93 Z" fill="#E9A285"/>
<path d="M0 0 L-20 93 A95 95 0 0 1 -88 36 Z" fill="#B85C3E"/><path d="M0 0 L-88 36 A95 95 0 0 1 -60 -74 Z" fill="#F3C6B2"/>
<circle r="38" fill="#FAF9F6"/><text y="5" font-family="sans-serif" font-size="14" font-weight="600" fill="#3a3834" text-anchor="middle">38 GB</text></g>
<g font-family="sans-serif" font-size="12" fill="#3a3834"><rect x="350" y="140" width="10" height="10" fill="#D97757"/><text x="368" y="149">Videos  18 GB</text>
<rect x="350" y="170" width="10" height="10" fill="#E9A285"/><text x="368" y="179">Downloads  9.4 GB</text>
<rect x="350" y="200" width="10" height="10" fill="#B85C3E"/><text x="368" y="209">.cache  4.1 GB</text>
<rect x="350" y="230" width="10" height="10" fill="#F3C6B2"/><text x="368" y="239">Other  6.5 GB</text></g>
</svg>`,
)}`;

const SAMPLE_APPROVALS: ApprovalRequest[] = [
  {
    id: 'appr-1',
    tool: 'mcp__claudeos-desktop__run_command',
    input: { command: 'sudo apt remove --purge thunderbird' },
    summary: 'Run: sudo apt remove --purge thunderbird',
    risk: 'high',
    reason: 'Uses sudo and removes a system package.',
    source: 'mcp',
    timeoutMs: 120_000,
  },
  {
    id: 'appr-2',
    tool: 'mcp__claudeos-desktop__delete_path',
    input: { path: '/home/you/Videos/recordings-2026-03', permanent: true },
    summary: 'Permanently delete ~/Videos/recordings-2026-03',
    risk: 'critical',
    reason: 'Permanent deletion skips the Trash and cannot be undone.',
    source: 'mcp',
    timeoutMs: 120_000,
  },
];

const DOCTOR: DoctorReport = {
  ok: false,
  checks: [
    { id: 'claude', label: 'Claude Code installed', status: 'ok', detail: 'claude 2.1.332' },
    { id: 'auth', label: 'Signed in to Claude', status: 'ok', detail: 'Claude Max subscription' },
    { id: 'session', label: 'Desktop session', status: 'ok', detail: 'GNOME 50 on Wayland' },
    { id: 'screenshot', label: 'Screenshots', status: 'ok', detail: 'GNOME Shell screenshot portal' },
    {
      id: 'uinput',
      label: 'Keyboard & mouse control',
      status: 'fail',
      detail: '/dev/uinput is not writable by your user.',
      fix: 'Run “sudo usermod -aG input $USER”, then log out and back in.',
    },
    {
      id: 'ydotoold',
      label: 'Input service (ydotoold)',
      status: 'warn',
      detail: 'Socket not found; it starts on demand.',
      fix: 'systemctl --user enable --now ydotoold',
    },
    { id: 'mcp', label: 'Computer-control tools', status: 'ok', detail: 'claudeos-desktop ready' },
    { id: 'keybinding', label: 'Super+C shortcut', status: 'ok' },
  ],
};

function sampleConversations(now: number): Conversation[] {
  const h = 3_600_000;
  const mk = (id: string, title: string, ago: number, user: string, reply: string): Conversation => ({
    id,
    title,
    createdAt: now - ago,
    updatedAt: now - ago,
    model: 'opus',
    effort: 'medium',
    sessionId: `session-${id}`,
    messageCount: 2,
    messages: [
      { id: `${id}-u`, role: 'user', blocks: [{ kind: 'text', text: user }], createdAt: now - ago },
      { id: `${id}-a`, role: 'assistant', blocks: [{ kind: 'text', text: reply }], createdAt: now - ago + 4000 },
    ],
  });
  return [
    mk('c-wifi', 'Why does my Wi-Fi keep dropping?', 0.4 * h, 'Why does my Wi-Fi keep dropping?', 'Let’s look at the NetworkManager log first.'),
    mk('c-downloads', 'Organise my Downloads folder', 5 * h, 'Organise my Downloads folder', 'I sorted 214 files into five folders.'),
    mk('c-printer', 'Set up the office printer', 30 * h, 'Set up the office printer', 'Your HP LaserJet is now the default printer.'),
    mk('c-backup', 'Back up Documents to the USB drive', 4 * 24 * h, 'Back up Documents to the USB drive', 'Done — 3.1 GB copied and verified.'),
  ];
}

function attachmentFor(path: string): Attachment {
  const name = path.split('/').filter(Boolean).pop() ?? path;
  if (path.includes('missing')) return { id: path, path, name, kind: 'missing' };
  if (!/\.[a-z0-9]+$/i.test(name)) return { id: path, path, name, kind: 'directory' };
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return { id: path, path, name, kind: 'image', sizeBytes: 482_113, mimeType: 'image/png' };
  return { id: path, path, name, kind: 'file', sizeBytes: 12_870 };
}

// ───────────────────────────── The mock ─────────────────────────────

export function createMockApi(options: MockOptions = {}): MockApi {
  const mode = options.mode ?? 'empty';
  const tickMs = options.tickMs ?? 30;
  const now = options.now ?? Date.now;

  const chat = emitter<ChatEvent>();
  const commands = emitter<PanelCommand>(true);
  const login = emitter<LoginEvent>();
  const settingsCh = emitter<PanelSettings>();
  const stateCh = emitter<PanelState>();
  const scheme = emitter<ColorScheme>();

  let settings: PanelSettings = { ...DEFAULT_SETTINGS };
  let auth: AuthStatus = {
    claudeInstalled: mode !== 'notinstalled',
    loggedIn: mode === 'empty' || mode === 'approval' || mode === 'streaming',
    authMethod: 'claude.ai',
    version: '2.1.332',
  };
  const store = new Map<string, Conversation>();
  if (options.seedHistory ?? true) for (const c of sampleConversations(now())) store.set(c.id, c);

  const decisions: ApprovalDecision[] = [];
  const sent: SendMessageRequest[] = [];
  const saved: Conversation[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  let onboardingDone = mode !== 'onboarding';
  let currentScheme: ColorScheme =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

  /** Run `steps` one per tick for a conversation; stop() cancels the remaining ones. */
  function runScript(conversationId: string, steps: (() => void)[]) {
    const handles: ReturnType<typeof setTimeout>[] = [];
    steps.forEach((step, i) => handles.push(setTimeout(step, tickMs * (i + 1))));
    timers.set(conversationId, handles);
  }

  function chunk(text: string): string[] {
    return text.match(/\S+\s*|\s+/g)?.reduce<string[]>((acc, word, i) => {
      if (i % 3 === 0) acc.push(word);
      else acc[acc.length - 1] += word;
      return acc;
    }, []) ?? [text];
  }

  function scriptedTurn(req: SendMessageRequest): (() => void)[] {
    const cid = req.conversationId;
    const n = sent.length;
    const mid = `msg-${n}`;
    const tool = (toolUseId: string, name: string, input: unknown) => () =>
      chat.emit({ type: 'tool-use', conversationId: cid, messageId: mid, toolUseId, name, input });
    const result = (toolUseId: string, output: string, imageDataUrl?: string) => () =>
      chat.emit({ type: 'tool-result', conversationId: cid, toolUseId, output, isError: false, imageDataUrl });
    const text = (t: string) => chunk(t).map((c) => () => chat.emit({ type: 'assistant-text-delta', conversationId: cid, messageId: mid, text: c }));
    const thinking = chunk(THINKING).map((c) => () => chat.emit({ type: 'thinking-delta', conversationId: cid, messageId: mid, text: c }));
    return [
      () => chat.emit({ type: 'status', conversationId: cid, status: 'running' }),
      () =>
        chat.emit({
          type: 'session',
          conversationId: cid,
          sessionId: req.resumeSessionId ?? `mock-session-${cid.slice(0, 8)}`,
          model: req.model,
          tools: ['Bash', 'Read', 'mcp__claudeos-desktop__screenshot'],
          mcpServers: [{ name: 'claudeos-desktop', status: 'connected' }],
        }),
      ...thinking,
      ...text(ANSWER_INTRO),
      tool(`tu-${n}-1`, 'mcp__claudeos-desktop__run_command', { command: 'du -h --max-depth=1 ~ | sort -hr | head -n 6' }),
      result(`tu-${n}-1`, DU_OUTPUT),
      tool(`tu-${n}-2`, 'mcp__claudeos-desktop__open_app', { name: 'Disk Usage Analyzer' }),
      result(`tu-${n}-2`, 'Launched org.gnome.baobab'),
      tool(`tu-${n}-3`, 'mcp__claudeos-desktop__screenshot', {}),
      result(`tu-${n}-3`, 'Screenshot 640×400 (scale 1.0)', SAMPLE_SCREENSHOT),
      ...text(`\n\n${ANSWER_BODY}`),
      () => chat.emit({ type: 'assistant-message-complete', conversationId: cid, messageId: mid }),
      () => {
        timers.delete(cid);
        chat.emit({ type: 'turn-complete', conversationId: cid, isError: false, costUsd: 0, durationMs: 9200, numTurns: 4 });
      },
    ];
  }

  const api: MockApi = {
    version: '26.4.1-mock',
    chat: {
      async send(req) {
        sent.push(req);
        if (!auth.loggedIn) {
          setTimeout(() => chat.emit({ type: 'auth-required', conversationId: req.conversationId }), tickMs);
          return { ok: true };
        }
        runScript(req.conversationId, scriptedTurn(req));
        return { ok: true };
      },
      async stop(conversationId) {
        timers.get(conversationId)?.forEach(clearTimeout);
        timers.delete(conversationId);
        setTimeout(() => chat.emit({ type: 'turn-complete', conversationId, isError: false }), tickMs);
      },
      onEvent: (cb) => chat.on(cb),
    },
    conversations: {
      async list() {
        return [...store.values()].map(({ messages: _m, effort: _e, ...summary }) => summary);
      },
      async get(id) {
        return store.get(id) ?? null;
      },
      async save(c) {
        saved.push(c);
        store.set(c.id, c);
      },
      async remove(id) {
        store.delete(id);
      },
    },
    settings: {
      async get() {
        return settings;
      },
      async set(patch) {
        settings = { ...settings, ...patch };
        if (patch.panelWidth !== undefined) settings.panelWidth = clampPanelWidth(patch.panelWidth, 1920);
        settingsCh.emit(settings);
        return settings;
      },
      onChange: (cb) => settingsCh.on(cb),
    },
    auth: {
      async status() {
        return auth;
      },
      async login() {
        const steps: LoginEvent[] = [
          { type: 'started' },
          { type: 'url', url: 'https://claude.ai/oauth/authorize?code=true&client_id=claude-code&state=mock' },
          { type: 'need-code' },
        ];
        steps.forEach((e, i) => setTimeout(() => login.emit(e), tickMs * (i + 1) * 3));
      },
      async submitCode(code) {
        setTimeout(() => {
          if (code.trim().length < 4) {
            login.emit({ type: 'failed', message: 'That code didn’t work. Copy it again from the browser.' });
            return;
          }
          auth = { ...auth, loggedIn: true, authMethod: 'claude.ai' };
          login.emit({ type: 'success', status: auth });
        }, tickMs);
      },
      async cancelLogin() {
        setTimeout(() => login.emit({ type: 'cancelled' }), 0);
      },
      async logout() {
        auth = { ...auth, loggedIn: false };
        return auth;
      },
      onLoginEvent: (cb) => login.on(cb),
    },
    panel: {
      async getState() {
        return {
          visible: true,
          width: settings.panelWidth,
          minWidth: 340,
          maxWidth: 1100,
          reserveSpace: settings.reserveSpace,
          sessionType: 'wayland',
          colorScheme: currentScheme,
          onboardingWindow: mode === 'onboarding',
        };
      },
      async hide() {
        stateCh.emit({ ...(await api.panel.getState()), visible: false });
      },
      async setWidth(width) {
        const w = clampPanelWidth(width, 1920);
        settings = { ...settings, panelWidth: w };
        return w;
      },
      onCommand: (cb) => commands.on(cb),
      onState: (cb) => stateCh.on(cb),
    },
    files: {
      async pick(opts) {
        return opts?.directories
          ? [attachmentFor('/home/you/Projects/garden-planner')]
          : [attachmentFor('/home/you/Documents/Quarterly report.pdf'), attachmentFor('/home/you/Pictures/receipt.png')];
      },
      async describe(paths) {
        return paths.map(attachmentFor);
      },
      pathForFile(file) {
        return `/home/you/Downloads/${file.name}`;
      },
      async reveal() {},
    },
    approvals: {
      async respond(d) {
        decisions.push(d);
      },
    },
    system: {
      async doctor() {
        return DOCTOR;
      },
      async openExternal() {},
      async openTerminalLogin() {},
      async isOnboardingDone() {
        return onboardingDone;
      },
      async completeOnboarding() {
        onboardingDone = true;
      },
      async getColorScheme() {
        return currentScheme;
      },
      onColorScheme: (cb) => scheme.on(cb),
    },
    mock: {
      emitChat: (e) => chat.emit(e),
      emitCommand: (c) => commands.emit(c),
      emitLogin: (e) => login.emit(e),
      setColorScheme(s) {
        currentScheme = s;
        scheme.emit(s);
      },
      setAuth(patch) {
        auth = { ...auth, ...patch };
      },
      decisions,
      sent,
      saved,
      get settings() {
        return settings;
      },
      listenerCounts: () => ({
        chat: chat.size,
        commands: commands.size,
        login: login.size,
        settings: settingsCh.size,
        state: stateCh.size,
        scheme: scheme.size,
      }),
    },
  };

  // Scenario kick-off: commands are buffered until the UI subscribes.
  if (mode === 'approval') SAMPLE_APPROVALS.forEach((request) => commands.emit({ type: 'approval-request', request }));
  if (mode === 'streaming') commands.emit({ type: 'ask', text: 'What’s using my disk space?', send: true, attachments: [] });

  return api;
}

/** Browser/dev entry: install the mock as `window.claudeos`, configured from the URL. */
export function installMockApi(): MockApi {
  const params = new URLSearchParams(window.location.search);
  const mode = (params.get('mock') ?? 'empty') as MockMode;
  const speed = params.get('speed');
  const mock = createMockApi({ mode, tickMs: speed === 'fast' ? 4 : speed === 'slow' ? 120 : 30 });
  if (mode === 'onboarding' && window.location.hash !== '#onboarding') window.location.hash = '#onboarding';
  window.claudeos = mock;
  // Surface the scripted controls for manual poking in devtools.
  (window as unknown as { __claudeosMock: MockControls }).__claudeosMock = mock.mock;
  return mock;
}
