/**
 * C1 panel control socket: NDJSON request/response over a unix socket (dir 0700, socket 0600).
 *
 * Every request line gets exactly one response line carrying the same `id`. `approval-request` replies only once the
 * human decided (or the request timed out → deny). Malformed input never crashes the server: bad JSON, unknown shapes
 * and over-long lines (> 1 MiB) answer `{ok:false,error:"bad-request"}`.
 */
import { lstatSync, chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import type { RiskLevel } from '../../shared/protocol';
import { RISK_LEVELS, type ApprovalInput, type ApprovalOutcome } from './approvals';
import { nullLogger, type Logger } from './logger';
import { LineSplitter } from './stream-parser';

export const MAX_REQUEST_LINE = 1024 * 1024;
const MAX_CONNECTIONS = 64;

export interface PanelStatusInfo {
  visible: boolean;
  width: number;
  signedIn: boolean | null;
  version: string;
}

/** What the socket server asks of the app. Implemented by the Electron glue; faked in tests. */
export interface PanelController {
  toggle(): boolean | Promise<boolean>;
  show(): boolean | Promise<boolean>;
  hide(): boolean | Promise<boolean>;
  newChat(): void | Promise<void>;
  /** Returns the number of attachments added. */
  attach(paths: string[], newChat: boolean): number | Promise<number>;
  ask(text: string, paths: string[], send: boolean): void | Promise<void>;
  onboarding(): void | Promise<void>;
  status(): PanelStatusInfo | Promise<PanelStatusInfo>;
  /** Called after the `quit` reply has been flushed. */
  quit(): void;
  requestApproval(input: Omit<ApprovalInput, 'source'>, signal: AbortSignal): Promise<ApprovalOutcome>;
}

/** Default socket location (ARCHITECTURE §2). */
export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env, uid: number = process.getuid?.() ?? 0): string {
  if (env.CLAUDEOS_PANEL_SOCKET && isAbsolute(env.CLAUDEOS_PANEL_SOCKET)) return env.CLAUDEOS_PANEL_SOCKET;
  if (env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR)) return join(env.XDG_RUNTIME_DIR, 'claudeos', 'panel.sock');
  return join('/tmp', `claudeos-${uid}`, 'panel.sock');
}

export type SocketProbe = 'live' | 'stale' | 'absent';

/** Checks whether something is accepting connections on `path`. */
export function probeSocket(path: string, timeoutMs = 1000): Promise<SocketProbe> {
  return new Promise((resolve) => {
    const sock = createConnection(path);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve('stale');
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve('live');
    });
    sock.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(err.code === 'ENOENT' ? 'absent' : 'stale');
    });
  });
}

/** Sends one request and resolves with the first response line (client side, used for single-instance forwarding). */
export function sendRequest(path: string, request: Record<string, unknown>, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);
    sock.setEncoding('utf8');
    sock.once('connect', () => sock.write(JSON.stringify(request) + '\n'));
    sock.on('data', (d: string) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      sock.destroy();
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      } catch (err) {
        reject(err as Error);
      }
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export class SocketInUseError extends Error {
  constructor(readonly socketPath: string) {
    super(`another panel instance is listening on ${socketPath}`);
  }
}

/** Ensures the socket directory exists, is a real directory owned by us and is mode 0700. */
function prepareSocketDir(dir: string, uid: number | undefined): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`socket directory is not a directory: ${dir}`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`socket directory is owned by another user: ${dir}`);
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

type Reply = Record<string, unknown>;

export interface PanelServerOptions {
  socketPath: string;
  controller: PanelController;
  logger?: Logger;
}

export class PanelServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly aborts = new Set<AbortController>();
  private readonly log: Logger;

  constructor(private readonly opts: PanelServerOptions) {
    this.log = opts.logger ?? nullLogger;
  }

  get socketPath(): string {
    return this.opts.socketPath;
  }

  /** Starts listening. Throws SocketInUseError when a live instance already owns the socket. */
  async start(): Promise<void> {
    const path = this.opts.socketPath;
    // sockaddr_un.sun_path is 108 bytes including the terminating NUL.
    if (Buffer.byteLength(path) > 107) throw new Error(`socket path is too long (max 107 bytes): ${path}`);
    prepareSocketDir(dirname(path), process.getuid?.());
    const probe = await probeSocket(path);
    if (probe === 'live') throw new SocketInUseError(path);
    if (probe === 'stale') {
      this.log.info('socket.remove-stale');
      try {
        unlinkSync(path);
      } catch {
        // raced with someone else's cleanup
      }
    }
    const server = createServer((sock) => this.onConnection(sock));
    server.maxConnections = MAX_CONNECTIONS;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(path, 0o600);
    server.on('error', (err) => this.log.error('socket.error', { message: err.message }));
    this.server = server;
    this.log.info('socket.listening');
  }

  /** Stops accepting, denies in-flight approvals (via abort), closes clients and removes the socket file. */
  async stop(): Promise<void> {
    for (const a of this.aborts) a.abort();
    this.aborts.clear();
    const server = this.server;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      if (lstatSync(this.opts.socketPath).isSocket()) unlinkSync(this.opts.socketPath);
    } catch {
      // already gone
    }
  }

  private onConnection(sock: Socket): void {
    this.sockets.add(sock);
    const abort = new AbortController();
    this.aborts.add(abort);
    const splitter = new LineSplitter((line) => void this.onLine(sock, line, abort.signal), {
      maxLineLength: MAX_REQUEST_LINE,
      onOverflow: () => this.write(sock, { ok: false, error: 'bad-request' }),
    });
    sock.on('data', (chunk: Buffer) => splitter.push(chunk));
    sock.on('end', () => splitter.end());
    sock.on('error', () => undefined);
    sock.on('close', () => {
      this.sockets.delete(sock);
      this.aborts.delete(abort);
      // Client went away: pending approvals for it are cancelled (→ deny).
      abort.abort();
    });
  }

  private write(sock: Socket, reply: Reply, cb?: () => void): void {
    if (sock.destroyed || !sock.writable) {
      cb?.();
      return;
    }
    sock.write(JSON.stringify(reply) + '\n', () => cb?.());
  }

  private async onLine(sock: Socket, line: string, signal: AbortSignal): Promise<void> {
    let req: unknown;
    try {
      req = JSON.parse(line);
    } catch {
      this.write(sock, { ok: false, error: 'bad-request' });
      return;
    }
    if (typeof req !== 'object' || req === null || Array.isArray(req)) {
      this.write(sock, { ok: false, error: 'bad-request' });
      return;
    }
    const r = req as Record<string, unknown>;
    const idPart: Reply = typeof r.id === 'string' || typeof r.id === 'number' ? { id: r.id } : {};
    if (typeof r.cmd !== 'string') {
      this.write(sock, { ...idPart, ok: false, error: 'bad-request' });
      return;
    }
    let reply: Reply;
    try {
      reply = await this.handle(r.cmd, r, signal);
    } catch (err) {
      this.log.error('socket.command-failed', { cmd: r.cmd, message: (err as Error).message });
      reply = { ok: false, error: 'internal-error' };
    }
    if (r.cmd === 'quit' && reply.ok === true) {
      this.write(sock, { ...idPart, ...reply }, () => this.opts.controller.quit());
      return;
    }
    this.write(sock, { ...idPart, ...reply });
  }

  /**
   * Validates and executes one request (without the `id`/`quit` socket plumbing). Also used for commands given on the
   * app's own command line at first launch.
   */
  async handle(cmd: string, r: Record<string, unknown>, signal: AbortSignal = new AbortController().signal): Promise<Reply> {
    const c = this.opts.controller;
    const bad: Reply = { ok: false, error: 'bad-request' };
    this.log.info('socket.command', { cmd: /^[a-z-]{1,32}$/.test(cmd) ? cmd : 'invalid' });
    switch (cmd) {
      case 'toggle':
        return { ok: true, visible: await c.toggle() };
      case 'show':
        return { ok: true, visible: await c.show() };
      case 'hide':
        return { ok: true, visible: await c.hide() };
      case 'new-chat':
        await c.newChat();
        return { ok: true };
      case 'attach': {
        const paths = absolutePaths(r.paths);
        if (!paths || paths.length === 0) return bad;
        if (r.newChat !== undefined && typeof r.newChat !== 'boolean') return bad;
        return { ok: true, attached: await c.attach(paths, r.newChat === true) };
      }
      case 'ask': {
        if (typeof r.text !== 'string') return bad;
        const paths = r.paths === undefined ? [] : absolutePaths(r.paths);
        if (!paths) return bad;
        if (r.send !== undefined && typeof r.send !== 'boolean') return bad;
        await c.ask(r.text, paths, r.send === true);
        return { ok: true };
      }
      case 'onboarding':
        await c.onboarding();
        return { ok: true };
      case 'status':
        return { ok: true, ...(await c.status()) };
      case 'quit':
        return { ok: true };
      case 'approval-request': {
        if (typeof r.tool !== 'string' || typeof r.summary !== 'string') return bad;
        if (typeof r.risk !== 'string' || !RISK_LEVELS.includes(r.risk as RiskLevel)) return bad;
        if (r.reason !== undefined && typeof r.reason !== 'string') return bad;
        if (r.timeoutMs !== undefined && typeof r.timeoutMs !== 'number') return bad;
        const outcome = await c.requestApproval(
          {
            tool: r.tool,
            input: r.input,
            summary: r.summary,
            risk: r.risk as RiskLevel,
            ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
            ...(typeof r.timeoutMs === 'number' ? { timeoutMs: r.timeoutMs } : {}),
          },
          signal,
        );
        return { ok: true, decision: outcome.decision === 'allow' ? 'allow' : 'deny', ...(outcome.message ? { message: outcome.message } : {}) };
      }
      default:
        return { ok: false, error: 'unknown-command' };
    }
  }
}

/** Validates a list of absolute path strings (max 500). */
function absolutePaths(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > 500) return null;
  if (!v.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 4096 && isAbsolute(p) && !p.includes('\0'))) return null;
  return v as string[];
}
