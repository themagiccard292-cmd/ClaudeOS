/**
 * One long-lived `claude -p --input-format stream-json` process per conversation (ARCHITECTURE C3).
 *
 * Lifecycle per conversation:
 *   send() → spawn (status "starting") → write user turn (status "running") → stream events → `result` (status "idle")
 *   stop() → SIGINT, SIGKILL after 3 s → status "idle"; the next send() respawns with `--resume <sessionId>`.
 *   Unexpected exit → `error` event with the last stderr lines + status "error"; the next send() respawns with --resume.
 *   A change of model/effort/permission mode, or an attachment directory outside $HOME that the running process was not
 *   started with (`--add-dir`), restarts the idle process with --resume before the turn is written.
 *   Idle processes are reaped after 30 minutes; shutdown() kills everything.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readFile as fsReadFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, sep } from 'node:path';
import {
  EFFORTS,
  type Attachment,
  type ChatEvent,
  type ConversationStatus,
  type EffortLevel,
  type PermissionMode,
  type SendMessageRequest,
  type SendResult,
} from '../../shared/protocol';
import { resolveClaudeBinary, sanitizedEnv } from './claude-binary';
import { describePaths, EMBEDDABLE_IMAGE_TYPES, formatSize, MAX_EMBEDDED_IMAGE_BYTES } from './files';
import { nullLogger, type Logger } from './logger';
import { LineSplitter, looksLikeAuthError, StreamTranslator } from './stream-parser';

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export const PERMISSION_PROMPT_TOOL = 'mcp__claudeos-desktop__request_permission';
export const DEFAULT_MCP_CONFIG = '/etc/claudeos/mcp.json';
export const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Values that end up in argv must never start with '-' so they cannot be mistaken for flags.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,99}$/;
const PERMISSION_MODES: readonly PermissionMode[] = ['acceptEdits', 'manual', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const MAX_TEXT_CHARS = 1_000_000;
const MAX_ATTACHMENTS = 100;
const STDERR_TAIL_LINES = 20;

export interface SessionManagerOptions {
  emit: (event: ChatEvent) => void;
  spawn?: SpawnFn;
  resolveClaude?: () => string | null;
  /** Base environment; API/provider variables are always stripped from it. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  mcpConfigPath?: string;
  logger?: Logger;
  idleTimeoutMs?: number;
  killGraceMs?: number;
  readFile?: (path: string) => Promise<Buffer>;
}

interface ProcessOptions {
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
}

interface Session {
  conversationId: string;
  proc: ChildProcess | null;
  exited: Promise<void> | null;
  options: ProcessOptions | null;
  addDirs: Set<string>;
  sessionId: string | undefined;
  status: ConversationStatus;
  turnActive: boolean;
  /** Set while we deliberately end the process; suppresses the "unexpected exit" error. */
  ending: 'stop' | 'quiet' | null;
  authNotified: boolean;
  stderrTail: string[];
  idleTimer: NodeJS.Timeout | null;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly spawnFn: SpawnFn;
  private readonly resolveClaude: () => string | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDir: string;
  private readonly mcpConfigPath: string;
  private readonly log: Logger;
  private readonly idleTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly readFile: (path: string) => Promise<Buffer>;
  private shuttingDown = false;

  constructor(private readonly opts: SessionManagerOptions) {
    const env = opts.env ?? process.env;
    this.spawnFn = opts.spawn ?? (nodeSpawn as SpawnFn);
    this.resolveClaude = opts.resolveClaude ?? (() => resolveClaudeBinary(env));
    this.env = sanitizedEnv(env);
    this.homeDir = opts.homeDir ?? env.HOME ?? homedir();
    this.mcpConfigPath = opts.mcpConfigPath ?? env.CLAUDEOS_MCP_CONFIG ?? DEFAULT_MCP_CONFIG;
    this.log = opts.logger ?? nullLogger;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60 * 1000;
    this.killGraceMs = opts.killGraceMs ?? 3000;
    this.readFile = opts.readFile ?? fsReadFile;
  }

  /** Current status of a conversation ("idle" when unknown). */
  status(conversationId: string): ConversationStatus {
    return this.sessions.get(conversationId)?.status ?? 'idle';
  }

  /** Builds the claude argv (exported for tests via the instance to keep flag order in one place). */
  buildArgs(options: ProcessOptions, resumeSessionId: string | undefined, addDirs: Iterable<string>): string[] {
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--model',
      options.model,
      '--effort',
      options.effort,
      '--permission-mode',
      options.permissionMode,
      '--permission-prompt-tool',
      PERMISSION_PROMPT_TOOL,
      '--mcp-config',
      this.mcpConfigPath,
    ];
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    for (const dir of addDirs) args.push('--add-dir', dir);
    return args;
  }

  async send(req: SendMessageRequest): Promise<SendResult> {
    const invalid = validateSendRequest(req);
    if (invalid) return { ok: false, error: invalid };
    if (this.shuttingDown) return { ok: false, error: 'The panel is shutting down' };

    const session = this.getSession(req.conversationId);
    if (session.turnActive || session.status === 'starting' || session.status === 'stopping') {
      return { ok: false, error: 'Claude is still working on the previous message' };
    }
    this.clearIdleTimer(session);

    const binary = this.resolveClaude();
    if (!binary) {
      const message = 'Claude Code is not installed. Run claudeos-doctor for help.';
      this.setStatus(session, 'error', message);
      return { ok: false, error: message };
    }

    // Never trust the renderer's view of the attachments: re-stat the paths.
    const attachments = await describePaths(req.attachments.map((a) => a?.path));
    const neededDirs = this.outsideHomeDirs(attachments);
    const options: ProcessOptions = { model: req.model, effort: req.effort, permissionMode: req.permissionMode };

    if (session.proc && !this.canReuse(session, options, neededDirs)) {
      this.log.info('session.restart', { reason: 'options-or-dirs-changed' });
      await this.terminate(session, 'quiet');
    }

    let line: string;
    try {
      line = await this.buildUserLine(req.text, attachments);
    } catch (err) {
      return { ok: false, error: `Could not read an attachment: ${(err as Error).message}` };
    }

    if (!session.proc) {
      for (const d of neededDirs) session.addDirs.add(d);
      const resume = session.sessionId ?? req.resumeSessionId;
      this.spawnProcess(session, binary, options, resume);
    }
    const proc = session.proc;
    if (!proc?.stdin || proc.stdin.destroyed) {
      return { ok: false, error: 'Claude could not be started' };
    }
    session.turnActive = true;
    session.authNotified = false;
    proc.stdin.write(line + '\n');
    this.setStatus(session, 'running');
    return { ok: true };
  }

  /** Interrupts the running turn: SIGINT, SIGKILL after the grace period. Resolves once the process exited. */
  async stop(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    if (!session.proc) {
      if (session.status !== 'idle') this.setStatus(session, 'idle');
      return;
    }
    this.setStatus(session, 'stopping');
    await this.terminate(session, 'stop');
  }

  /** Kills every claude process (app quit). */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all([...this.sessions.values()].map((s) => this.terminate(s, 'quiet')));
  }

  // ───────────────────────────── internals ─────────────────────────────

  private getSession(conversationId: string): Session {
    let s = this.sessions.get(conversationId);
    if (!s) {
      s = {
        conversationId,
        proc: null,
        exited: null,
        options: null,
        addDirs: new Set(),
        sessionId: undefined,
        status: 'idle',
        turnActive: false,
        ending: null,
        authNotified: false,
        stderrTail: [],
        idleTimer: null,
      };
      this.sessions.set(conversationId, s);
    }
    return s;
  }

  private canReuse(session: Session, options: ProcessOptions, neededDirs: string[]): boolean {
    const o = session.options;
    if (!o || o.model !== options.model || o.effort !== options.effort || o.permissionMode !== options.permissionMode) return false;
    return neededDirs.every((d) => session.addDirs.has(d));
  }

  /** Directories outside $HOME that claude needs `--add-dir` for to read the attachments. */
  private outsideHomeDirs(attachments: Attachment[]): string[] {
    const home = this.homeDir.endsWith(sep) ? this.homeDir : this.homeDir + sep;
    const dirs = new Set<string>();
    for (const a of attachments) {
      if (a.kind === 'missing') continue;
      const dir = a.kind === 'directory' ? a.path : dirname(a.path);
      if (dir === this.homeDir || dir.startsWith(home)) continue;
      dirs.add(dir);
    }
    return [...dirs];
  }

  private async buildUserLine(text: string, attachments: Attachment[]): Promise<string> {
    const content: Record<string, unknown>[] = [];
    const images: Record<string, unknown>[] = [];
    if (attachments.length > 0) {
      const lines = ['The user attached:'];
      for (const a of attachments) {
        const embed =
          a.kind === 'image' &&
          a.mimeType !== undefined &&
          EMBEDDABLE_IMAGE_TYPES.includes(a.mimeType) &&
          (a.sizeBytes ?? Infinity) <= MAX_EMBEDDED_IMAGE_BYTES;
        if (embed) {
          const data = await this.readFile(a.path);
          images.push({ type: 'image', source: { type: 'base64', media_type: a.mimeType, data: data.toString('base64') } });
        }
        lines.push(`- ${a.path} (${describeKind(a)}${embed ? '; also embedded below' : ''})`);
      }
      lines.push('Read them with your tools as needed.');
      content.push({ type: 'text', text: lines.join('\n') });
    }
    if (text.length > 0) content.push({ type: 'text', text });
    content.push(...images);
    return JSON.stringify({ type: 'user', message: { role: 'user', content } });
  }

  private spawnProcess(session: Session, binary: string, options: ProcessOptions, resume: string | undefined): void {
    const args = this.buildArgs(options, resume, session.addDirs);
    this.setStatus(session, 'starting');
    this.log.info('session.spawn', { resume: Boolean(resume), addDirs: session.addDirs.size, model: options.model });

    let proc: ChildProcess;
    try {
      proc = this.spawnFn(binary, args, { cwd: this.homeDir, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.emit({ type: 'error', conversationId: session.conversationId, message: `Could not start Claude: ${(err as Error).message}` });
      this.setStatus(session, 'error', 'Could not start Claude');
      return;
    }
    session.proc = proc;
    session.options = options;
    session.ending = null;
    session.stderrTail = [];

    const translator = new StreamTranslator(session.conversationId, { onDebug: (m) => this.log.debug('stream', { note: m }) });
    const stdout = new LineSplitter((line) => this.onEvents(session, proc, translator.handleLine(line)), {
      onOverflow: (n) => this.log.warn('stream.line-too-long', { chars: n }),
    });
    const stderr = new LineSplitter((line) => this.onStderrLine(session, proc, line), { maxLineLength: 64 * 1024 });

    proc.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    // EPIPE on a dying process must not crash the main process; the exit handler reports it.
    proc.stdin?.on('error', (err) => this.log.debug('session.stdin-error', { code: (err as NodeJS.ErrnoException).code }));

    session.exited = new Promise<void>((resolve) => {
      let done = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void => {
        if (done) return;
        done = true;
        stdout.end();
        stderr.end();
        this.onEvents(session, proc, translator.flush());
        this.onExit(session, proc, code, signal, spawnError);
        resolve();
      };
      proc.once('error', (err) => finish(null, null, err));
      proc.once('close', (code, signal) => finish(code, signal));
    });
  }

  private onEvents(session: Session, proc: ChildProcess, events: ChatEvent[]): void {
    if (session.proc !== proc) return; // late output of a replaced process
    for (const e of events) {
      if (e.type === 'session') session.sessionId = e.sessionId;
      this.emit(e);
      if (e.type === 'turn-complete') {
        session.turnActive = false;
        if (looksLikeAuthError(e.resultText, e.isError)) this.notifyAuth(session);
        this.setStatus(session, 'idle');
        this.armIdleTimer(session);
      }
    }
  }

  private onStderrLine(session: Session, proc: ChildProcess, line: string): void {
    if (session.proc !== proc) return;
    session.stderrTail.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
    if (session.stderrTail.length > STDERR_TAIL_LINES) session.stderrTail.shift();
    if (looksLikeAuthError(line, true)) this.notifyAuth(session);
  }

  private notifyAuth(session: Session): void {
    if (session.authNotified) return;
    session.authNotified = true;
    this.log.info('session.auth-required');
    this.emit({ type: 'auth-required', conversationId: session.conversationId });
  }

  private onExit(session: Session, proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void {
    if (session.proc !== proc) return;
    const ending = session.ending;
    const wasActive = session.turnActive;
    session.proc = null;
    session.exited = null;
    session.options = null;
    session.turnActive = false;
    session.ending = null;
    this.clearIdleTimer(session);
    this.log.info('session.exit', { code, signal, ending: ending ?? 'unexpected' });

    if (ending === 'quiet') return;
    if (ending === 'stop') {
      this.setStatus(session, 'idle');
      return;
    }
    if (!wasActive && !spawnError && code === 0) {
      // Clean exit between turns (e.g. stdin closed): nothing to report.
      this.setStatus(session, 'idle');
      return;
    }
    const tail = session.stderrTail.slice(-5).join('\n').trim();
    const reason = spawnError
      ? `Could not start Claude: ${spawnError.message}`
      : `Claude exited unexpectedly (${signal ? `signal ${signal}` : `code ${code}`})`;
    const message = tail ? `${reason}\n${tail}` : reason;
    if (looksLikeAuthError(tail, true)) this.notifyAuth(session);
    this.emit({ type: 'error', conversationId: session.conversationId, message });
    this.setStatus(session, 'error', reason);
  }

  /** Ends the session's process: SIGINT, then SIGKILL after the grace period. Resolves on exit. */
  private async terminate(session: Session, ending: 'stop' | 'quiet'): Promise<void> {
    this.clearIdleTimer(session);
    const proc = session.proc;
    const exited = session.exited;
    if (!proc || !exited) return;
    session.ending = ending;
    proc.stdin?.end();
    proc.kill('SIGINT');
    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        this.log.warn('session.sigkill');
        proc.kill('SIGKILL');
      }
    }, this.killGraceMs);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }

  private armIdleTimer(session: Session): void {
    this.clearIdleTimer(session);
    if (!session.proc) return;
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null;
      if (session.proc && !session.turnActive) {
        this.log.info('session.reap-idle');
        void this.terminate(session, 'quiet');
      }
    }, this.idleTimeoutMs);
    session.idleTimer.unref?.();
  }

  private clearIdleTimer(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  private setStatus(session: Session, status: ConversationStatus, error?: string): void {
    session.status = status;
    this.emit({ type: 'status', conversationId: session.conversationId, status, ...(error ? { error } : {}) });
  }

  private emit(e: ChatEvent): void {
    try {
      this.opts.emit(e);
    } catch (err) {
      this.log.error('session.emit-failed', { message: (err as Error).message });
    }
  }
}

function describeKind(a: Attachment): string {
  switch (a.kind) {
    case 'directory':
      return 'directory';
    case 'missing':
      return 'missing — the path no longer exists';
    default: {
      const parts: string[] = [a.kind];
      const size = formatSize(a.sizeBytes);
      if (size) parts.push(size);
      if (a.mimeType) parts.push(a.mimeType);
      return parts.join(', ');
    }
  }
}

/** Returns an error string for an invalid request (the renderer is never trusted), or null. */
export function validateSendRequest(req: unknown): string | null {
  if (typeof req !== 'object' || req === null) return 'Invalid request';
  const r = req as Partial<SendMessageRequest>;
  if (typeof r.conversationId !== 'string' || !CONVERSATION_ID_RE.test(r.conversationId)) return 'Invalid conversation id';
  if (typeof r.text !== 'string' || r.text.length > MAX_TEXT_CHARS) return 'Invalid message text';
  if (!Array.isArray(r.attachments) || r.attachments.length > MAX_ATTACHMENTS) return 'Invalid attachments';
  if (r.attachments.some((a) => typeof a !== 'object' || a === null || typeof a.path !== 'string')) return 'Invalid attachments';
  if (r.text.trim().length === 0 && r.attachments.length === 0) return 'Nothing to send';
  if (typeof r.model !== 'string' || !MODEL_RE.test(r.model)) return 'Invalid model';
  if (!EFFORTS.some((e) => e.id === r.effort)) return 'Invalid effort level';
  if (!PERMISSION_MODES.includes(r.permissionMode as PermissionMode)) return 'Invalid permission mode';
  if (r.resumeSessionId !== undefined && (typeof r.resumeSessionId !== 'string' || !SESSION_ID_RE.test(r.resumeSessionId))) {
    return 'Invalid session id';
  }
  return null;
}
