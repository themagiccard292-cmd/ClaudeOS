/**
 * Claude Pro/Max subscription sign-in (ARCHITECTURE C3 "Auth flow"). API keys are never involved:
 * status = `claude auth status --json`, login = `claude auth login --claudeai`, logout = `claude auth logout`.
 *
 * Nothing printed by the CLI is logged or persisted; only coarse events ("login.started", exit codes) are.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { AuthStatus, LoginEvent } from '../../shared/protocol';
import { findOnPath, resolveClaudeBinary, sanitizedEnv } from './claude-binary';
import { nullLogger, type Logger } from './logger';
import type { SpawnFn } from './session-manager';

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

const MAX_CAPTURE = 256 * 1024;

/** Runs a short-lived command with captured output and a hard timeout. Never rejects. */
export function runCommand(
  spawnFn: SpawnFn,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let proc: ChildProcess;
    try {
      proc = spawnFn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout, stderr, error: err as Error });
      return;
    }
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout?.on('data', (c: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += c.toString('utf8');
    });
    proc.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += c.toString('utf8');
    });
    let settled = false;
    const done = (r: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    proc.once('error', (err) => done({ code: null, stdout, stderr, error: err }));
    proc.once('close', (code) => done({ code, stdout, stderr }));
  });
}

/** Removes ANSI escape sequences (colours, cursor movement, OSC hyperlinks). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g, '');
}

/** First https:// URL in `text`, without trailing punctuation. */
export function extractUrl(text: string): string | null {
  const m = /https:\/\/[^\s"'<>`]+/.exec(stripAnsi(text));
  return m ? m[0].replace(/[).,;:!?\]]+$/, '') : null;
}

const NEED_CODE_RE = /(paste|enter|input)[^\n]{0,40}\bcode\b|authori[sz]ation code|code here/i;
const TTY_RE = /raw mode|\bnot a tty\b|\btty\b|isatty|interactive terminal/i;

/** Parses `claude auth status --json` output (tolerates noise around the JSON object). */
export function parseAuthStatus(stdout: string): Omit<AuthStatus, 'claudeInstalled' | 'version'> | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end < start) return null;
  try {
    const obj = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof obj !== 'object' || obj === null) return null;
    const out: Omit<AuthStatus, 'claudeInstalled' | 'version'> = { loggedIn: obj.loggedIn === true };
    if (typeof obj.authMethod === 'string') out.authMethod = obj.authMethod;
    if (typeof obj.apiProvider === 'string') out.apiProvider = obj.apiProvider;
    return out;
  } catch {
    return null;
  }
}

export interface TerminalLauncherDeps {
  which?: (name: string) => string | null;
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
}

/**
 * Opens a terminal running `claudeos-login` (the TTY sign-in helper from system-config):
 * `ptyxis -- claudeos-login`, else `x-terminal-emulator -e claudeos-login`. Returns false when neither exists.
 */
export function openTerminalLogin(deps: TerminalLauncherDeps = {}): boolean {
  const env = sanitizedEnv(deps.env ?? process.env);
  const which = deps.which ?? ((n: string) => findOnPath(n, env.PATH));
  const spawnFn = deps.spawn ?? (nodeSpawn as SpawnFn);
  const candidates: [string, string[]][] = [
    ['ptyxis', ['--', 'claudeos-login']],
    ['x-terminal-emulator', ['-e', 'claudeos-login']],
  ];
  for (const [name, args] of candidates) {
    const bin = which(name);
    if (!bin) continue;
    try {
      const child = spawnFn(bin, args, { env, detached: true, stdio: 'ignore' });
      child.on('error', () => undefined);
      child.unref();
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export interface AuthManagerOptions {
  emit: (event: LoginEvent) => void;
  /** Opens the sign-in URL in the browser (xdg-open in production). */
  openUrl: (url: string) => void;
  /** Opens the terminal fallback; resolves false when no terminal is available. */
  openTerminal?: () => boolean | Promise<boolean>;
  spawn?: SpawnFn;
  resolveClaude?: () => string | null;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  pollIntervalMs?: number;
  loginTimeoutMs?: number;
  commandTimeoutMs?: number;
}

interface LoginAttempt {
  proc: ChildProcess | null;
  output: string;
  urlSeen: boolean;
  needCodeSent: boolean;
  finished: boolean;
  pollTimer: NodeJS.Timeout | null;
  deadline: NodeJS.Timeout | null;
  polling: boolean;
}

export class AuthManager {
  private readonly spawnFn: SpawnFn;
  private readonly resolveClaude: () => string | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: Logger;
  private readonly pollIntervalMs: number;
  private readonly loginTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private attempt: LoginAttempt | null = null;

  constructor(private readonly opts: AuthManagerOptions) {
    const env = opts.env ?? process.env;
    this.spawnFn = opts.spawn ?? (nodeSpawn as SpawnFn);
    this.resolveClaude = opts.resolveClaude ?? (() => resolveClaudeBinary(env));
    this.env = sanitizedEnv(env);
    this.log = opts.logger ?? nullLogger;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.loginTimeoutMs = opts.loginTimeoutMs ?? 10 * 60 * 1000;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 15_000;
  }

  get loginInProgress(): boolean {
    return this.attempt !== null && !this.attempt.finished;
  }

  async status(): Promise<AuthStatus> {
    const bin = this.resolveClaude();
    if (!bin) return { claudeInstalled: false, loggedIn: false };
    const [st, ver] = await Promise.all([
      runCommand(this.spawnFn, bin, ['auth', 'status', '--json'], this.env, this.commandTimeoutMs),
      runCommand(this.spawnFn, bin, ['--version'], this.env, this.commandTimeoutMs),
    ]);
    if (st.error && (st.error as NodeJS.ErrnoException).code === 'ENOENT') return { claudeInstalled: false, loggedIn: false };
    const version = /\d+\.\d+\.\d+[^\s]*/.exec(ver.stdout)?.[0];
    const parsed = parseAuthStatus(st.stdout);
    const base: AuthStatus = { claudeInstalled: true, loggedIn: false, ...(version ? { version } : {}) };
    if (!parsed) return { ...base, error: 'Could not read the sign-in status from Claude Code' };
    return { ...base, ...parsed };
  }

  /** Starts `claude auth login --claudeai`; progress is reported through `emit`. */
  async login(options: { sso?: boolean; email?: string } = {}): Promise<void> {
    if (this.attempt && !this.attempt.finished) this.finish(this.attempt, null);
    const bin = this.resolveClaude();
    if (!bin) {
      this.opts.emit({ type: 'failed', message: 'Claude Code is not installed.' });
      return;
    }
    const args = ['auth', 'login', '--claudeai'];
    if (options.sso) args.push('--sso');
    if (options.email) args.push('--email', options.email);

    const attempt: LoginAttempt = {
      proc: null,
      output: '',
      urlSeen: false,
      needCodeSent: false,
      finished: false,
      pollTimer: null,
      deadline: null,
      polling: false,
    };
    this.attempt = attempt;
    this.log.info('login.started', { sso: Boolean(options.sso) });
    this.opts.emit({ type: 'started' });

    let proc: ChildProcess;
    try {
      proc = this.spawnFn(bin, args, { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.finish(attempt, { type: 'failed', message: `Could not start Claude Code: ${(err as Error).message}` });
      return;
    }
    attempt.proc = proc;
    const onData = (chunk: Buffer): void => this.onLoginOutput(attempt, chunk.toString('utf8'));
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.stdin?.on('error', () => undefined);
    proc.once('error', (err) => {
      attempt.proc = null;
      this.finish(attempt, { type: 'failed', message: `Could not start Claude Code: ${err.message}` });
    });
    proc.once('close', (code) => {
      attempt.proc = null;
      void this.onLoginExit(attempt, code);
    });

    attempt.pollTimer = setInterval(() => void this.poll(attempt), this.pollIntervalMs);
    attempt.deadline = setTimeout(
      () => this.finish(attempt, { type: 'failed', message: 'Sign-in timed out. Please try again.' }),
      this.loginTimeoutMs,
    );
  }

  /** Sends the code the user pasted from the browser to the waiting CLI. */
  async submitCode(code: string): Promise<void> {
    const attempt = this.attempt;
    if (!attempt || attempt.finished || !attempt.proc?.stdin || attempt.proc.stdin.destroyed) {
      throw new Error('No sign-in is waiting for a code');
    }
    const clean = typeof code === 'string' ? code.trim() : '';
    // eslint-disable-next-line no-control-regex
    if (clean.length === 0 || clean.length > 4096 || /[\u0000-\u001f\u007f]/.test(clean)) {
      throw new Error('That code does not look right');
    }
    this.log.info('login.code-submitted');
    attempt.proc.stdin.write(clean + '\n');
  }

  async cancel(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt || attempt.finished) return;
    this.log.info('login.cancelled');
    this.finish(attempt, { type: 'cancelled' });
  }

  async logout(): Promise<AuthStatus> {
    await this.cancel();
    const bin = this.resolveClaude();
    if (!bin) return { claudeInstalled: false, loggedIn: false };
    const r = await runCommand(this.spawnFn, bin, ['auth', 'logout'], this.env, this.commandTimeoutMs);
    this.log.info('logout', { code: r.code });
    return this.status();
  }

  /** Stops timers and kills the login process (app quit). */
  dispose(): void {
    if (this.attempt && !this.attempt.finished) this.finish(this.attempt, null);
  }

  // ───────────────────────────── internals ─────────────────────────────

  private onLoginOutput(attempt: LoginAttempt, text: string): void {
    if (attempt.finished) return;
    if (attempt.output.length < 64 * 1024) attempt.output += stripAnsi(text);
    if (!attempt.urlSeen) {
      const url = extractUrl(attempt.output);
      if (url) {
        attempt.urlSeen = true;
        this.log.info('login.url');
        this.opts.emit({ type: 'url', url });
        try {
          this.opts.openUrl(url);
        } catch {
          // The URL is shown in the UI as well; failing to open a browser is not fatal.
        }
      }
    }
    if (!attempt.needCodeSent && NEED_CODE_RE.test(attempt.output)) {
      attempt.needCodeSent = true;
      this.opts.emit({ type: 'need-code' });
    }
  }

  private async onLoginExit(attempt: LoginAttempt, code: number | null): Promise<void> {
    if (attempt.finished) return;
    this.log.info('login.exit', { code });
    const st = await this.status();
    if (attempt.finished) return;
    if (st.loggedIn) {
      this.finish(attempt, { type: 'success', status: st });
      return;
    }
    if (code !== 0 && TTY_RE.test(attempt.output) && !attempt.urlSeen) {
      const opened = await this.opts.openTerminal?.();
      if (attempt.finished) return;
      if (opened) {
        // Keep polling: the user finishes the sign-in in the terminal.
        this.log.info('login.fallback-terminal');
        this.opts.emit({ type: 'fallback-terminal' });
        return;
      }
      this.finish(attempt, { type: 'failed', message: 'Sign-in needs a terminal. Open a terminal and run: claudeos-login' });
      return;
    }
    const lastLine = attempt.output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    const message = code === 0 ? 'Sign-in did not complete.' : (lastLine?.slice(0, 300) ?? `Sign-in failed (exit code ${code}).`);
    this.finish(attempt, { type: 'failed', message });
  }

  private async poll(attempt: LoginAttempt): Promise<void> {
    if (attempt.finished || attempt.polling) return;
    attempt.polling = true;
    try {
      const st = await this.status();
      if (!attempt.finished && st.loggedIn) {
        this.log.info('login.success');
        this.finish(attempt, { type: 'success', status: st });
      }
    } finally {
      attempt.polling = false;
    }
  }

  /** Ends an attempt exactly once: clears timers, kills the CLI, emits the final event (if any). */
  private finish(attempt: LoginAttempt, event: LoginEvent | null): void {
    if (attempt.finished) return;
    attempt.finished = true;
    if (attempt.pollTimer) clearInterval(attempt.pollTimer);
    if (attempt.deadline) clearTimeout(attempt.deadline);
    if (attempt.proc && attempt.proc.exitCode === null) attempt.proc.kill('SIGTERM');
    attempt.proc = null;
    if (this.attempt === attempt) this.attempt = null;
    if (event) this.opts.emit(event);
  }
}
