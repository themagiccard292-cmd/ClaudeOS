import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PanelCommand } from '../src/shared/protocol';
import { ApprovalBroker } from '../src/main/core/approvals';
import {
  defaultSocketPath,
  PanelServer,
  probeSocket,
  sendRequest,
  SocketInUseError,
  type PanelController,
} from '../src/main/core/panel-server';

let tmp: string;
let sockPath: string;
let server: PanelServer;
let commands: PanelCommand[];
let broker: ApprovalBroker;
let calls: string[];
let quitCalled: boolean;

function controller(): PanelController {
  let visible = false;
  return {
    toggle: () => ((visible = !visible), visible),
    show: () => (visible = true),
    hide: () => (visible = false),
    newChat: () => void calls.push('new-chat'),
    attach: (paths, newChat) => (calls.push(`attach:${newChat}:${paths.join(',')}`), paths.length),
    ask: (text, paths, send) => void calls.push(`ask:${text}:${paths.length}:${send}`),
    onboarding: () => void calls.push('onboarding'),
    status: () => ({ visible, width: 440, signedIn: null, version: '26.4.1' }),
    quit: () => {
      quitCalled = true;
    },
    requestApproval: (input, signal) => broker.request({ ...input, source: 'mcp' }, signal),
  };
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'claudeos-sock-'));
  sockPath = join(tmp, 'run', 'claudeos', 'panel.sock');
  commands = [];
  calls = [];
  quitCalled = false;
  let n = 0;
  broker = new ApprovalBroker({ sendCommand: (c) => commands.push(c), newId: () => `ap-${++n}` });
  server = new PanelServer({ socketPath: sockPath, controller: controller() });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  broker.cancelAll('test over');
  rmSync(tmp, { recursive: true, force: true });
});

/** A raw NDJSON client that collects reply lines. */
function client(): Promise<{ sock: Socket; send: (raw: string) => void; next: () => Promise<Record<string, unknown>>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(sockPath);
    const lines: Record<string, unknown>[] = [];
    const waiters: ((v: Record<string, unknown>) => void)[] = [];
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      buf += d;
      for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
        const obj = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        buf = buf.slice(nl + 1);
        const w = waiters.shift();
        if (w) w(obj);
        else lines.push(obj);
      }
    });
    sock.once('error', reject);
    sock.once('connect', () =>
      resolve({
        sock,
        send: (raw) => sock.write(raw),
        next: () => {
          const l = lines.shift();
          return l ? Promise.resolve(l) : new Promise((r) => waiters.push(r));
        },
        close: () => sock.destroy(),
      }),
    );
  });
}

describe('PanelServer', () => {
  it('creates the dir 0700 and the socket 0600', () => {
    expect(statSync(join(tmp, 'run', 'claudeos')).mode & 0o777).toBe(0o700);
    expect(statSync(sockPath).mode & 0o777).toBe(0o600);
  });

  it('answers each command with the request id', async () => {
    expect(await sendRequest(sockPath, { id: 1, cmd: 'toggle' })).toEqual({ id: 1, ok: true, visible: true });
    expect(await sendRequest(sockPath, { id: 'b', cmd: 'hide' })).toEqual({ id: 'b', ok: true, visible: false });
    expect(await sendRequest(sockPath, { id: 3, cmd: 'show', extra: 'ignored' })).toEqual({ id: 3, ok: true, visible: true });
    expect(await sendRequest(sockPath, { id: 4, cmd: 'new-chat' })).toEqual({ id: 4, ok: true });
    expect(await sendRequest(sockPath, { id: 5, cmd: 'attach', paths: ['/a', '/b c'], newChat: true })).toEqual({ id: 5, ok: true, attached: 2 });
    expect(await sendRequest(sockPath, { id: 6, cmd: 'ask', text: 'hi', paths: ['/x'], send: true })).toEqual({ id: 6, ok: true });
    expect(await sendRequest(sockPath, { id: 7, cmd: 'onboarding' })).toEqual({ id: 7, ok: true });
    expect(await sendRequest(sockPath, { id: 8, cmd: 'status' })).toEqual({ id: 8, ok: true, visible: true, width: 440, signedIn: null, version: '26.4.1' });
    expect(await sendRequest(sockPath, { id: 9, cmd: 'frobnicate' })).toEqual({ id: 9, ok: false, error: 'unknown-command' });
    expect(calls).toEqual(['new-chat', 'attach:true:/a,/b c', 'ask:hi:1:true', 'onboarding']);
  });

  it('rejects bad requests without crashing', async () => {
    const c = await client();
    c.send('this is not json\n');
    expect(await c.next()).toEqual({ ok: false, error: 'bad-request' });
    c.send('[1,2]\n{"id":2}\n');
    expect(await c.next()).toEqual({ ok: false, error: 'bad-request' });
    expect(await c.next()).toEqual({ id: 2, ok: false, error: 'bad-request' });
    c.send('{"id":3,"cmd":"attach","paths":["relative/path"]}\n');
    expect(await c.next()).toEqual({ id: 3, ok: false, error: 'bad-request' });
    c.send('{"id":4,"cmd":"ask"}\n');
    expect(await c.next()).toEqual({ id: 4, ok: false, error: 'bad-request' });
    c.send('{"id":5,"cmd":"approval-request","tool":"Bash","summary":"x","risk":"extreme"}\n');
    expect(await c.next()).toEqual({ id: 5, ok: false, error: 'bad-request' });
    // over-long line (> 1 MiB) then a valid one on the same connection
    c.send('{"cmd":"status","pad":"' + 'x'.repeat(1024 * 1024 + 10) + '"}\n');
    expect(await c.next()).toEqual({ ok: false, error: 'bad-request' });
    c.send('{"id":6,"cmd":"status"}\n');
    expect(await c.next()).toMatchObject({ id: 6, ok: true });
    c.close();
  });

  it('handles several requests on one connection, split across writes', async () => {
    const c = await client();
    c.send('{"id":1,"cmd":"sh');
    c.send('ow"}\r\n{"id":2,"cmd":"status"}\n');
    expect(await c.next()).toEqual({ id: 1, ok: true, visible: true });
    expect(await c.next()).toMatchObject({ id: 2, visible: true });
    c.close();
  });

  it('approval-request waits for the human decision', async () => {
    const c = await client();
    c.send(JSON.stringify({ id: 'a1', cmd: 'approval-request', tool: 'mcp__claudeos-desktop__run_command', input: { command: 'sudo apt remove x' }, summary: 'Run: sudo apt remove x', risk: 'high', reason: 'sudo' }) + '\n');
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0]).toEqual({
      type: 'approval-request',
      request: { id: 'ap-1', tool: 'mcp__claudeos-desktop__run_command', input: { command: 'sudo apt remove x' }, summary: 'Run: sudo apt remove x', risk: 'high', reason: 'sudo', source: 'mcp', timeoutMs: 120000 },
    });
    expect(broker.respond({ id: 'nope', decision: 'allow' })).toBe(false);
    expect(broker.respond({ id: 'ap-1', decision: 'allow' })).toBe(true);
    expect(await c.next()).toEqual({ id: 'a1', ok: true, decision: 'allow' });
    c.close();
  });

  it('approval-request times out to deny and removes the card', async () => {
    const reply = await sendRequest(sockPath, { id: 1, cmd: 'approval-request', tool: 'Bash', input: {}, summary: 's', risk: 'low', timeoutMs: 1000 }, 5000);
    expect(reply).toMatchObject({ id: 1, ok: true, decision: 'deny' });
    expect(commands.map((c) => c.type)).toEqual(['approval-request', 'approval-cancelled']);
  });

  it('client disconnect cancels the pending approval', async () => {
    const c = await client();
    c.send(JSON.stringify({ cmd: 'approval-request', tool: 'Bash', input: {}, summary: 's', risk: 'critical' }) + '\n');
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    c.close();
    await vi.waitFor(() => expect(broker.list()).toHaveLength(0));
    expect(commands.at(-1)).toEqual({ type: 'approval-cancelled', id: 'ap-1' });
  });

  it('server shutdown denies in-flight approvals and removes the socket', async () => {
    const c = await client();
    c.send(JSON.stringify({ cmd: 'approval-request', tool: 'Bash', input: {}, summary: 's', risk: 'medium' }) + '\n');
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    await server.stop();
    expect(broker.list()).toHaveLength(0);
    expect(existsSync(sockPath)).toBe(false);
  });

  it('quit replies before calling the controller', async () => {
    expect(await sendRequest(sockPath, { id: 1, cmd: 'quit' })).toEqual({ id: 1, ok: true });
    await vi.waitFor(() => expect(quitCalled).toBe(true));
  });

  it('refuses to start over a live instance and cleans up stale sockets', async () => {
    const second = new PanelServer({ socketPath: sockPath, controller: controller() });
    await expect(second.start()).rejects.toBeInstanceOf(SocketInUseError);
    await server.stop();

    // A leftover socket path nobody listens on (crashed instance): connect() is refused.
    const stalePath = join(tmp, 'stale', 'panel.sock');
    mkdirSync(join(tmp, 'stale'), { mode: 0o755 });
    writeFileSync(stalePath, '');
    expect(await probeSocket(stalePath)).toBe('stale');
    const s3 = new PanelServer({ socketPath: stalePath, controller: controller() });
    await s3.start();
    expect(statSync(join(tmp, 'stale')).mode & 0o777).toBe(0o700); // tightened
    expect(await sendRequest(stalePath, { id: 1, cmd: 'status' })).toMatchObject({ ok: true });
    await s3.stop();
    expect(await probeSocket(stalePath)).toBe('absent');
  });

  it('tightens a too-permissive socket directory to 0700', () => {
    const dir = join(tmp, 'loose');
    mkdirSync(dir);
    chmodSync(dir, 0o777);
    const s = new PanelServer({ socketPath: join(dir, 'p.sock'), controller: controller() });
    return s.start().then(async () => {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      await s.stop();
    });
  });
});

describe('defaultSocketPath', () => {
  it('follows CLAUDEOS_PANEL_SOCKET, then XDG_RUNTIME_DIR, then /tmp/claudeos-$UID', () => {
    expect(defaultSocketPath({ CLAUDEOS_PANEL_SOCKET: '/x/y.sock', XDG_RUNTIME_DIR: '/run/user/1' }, 1)).toBe('/x/y.sock');
    expect(defaultSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }, 1000)).toBe('/run/user/1000/claudeos/panel.sock');
    expect(defaultSocketPath({}, 1000)).toBe('/tmp/claudeos-1000/panel.sock');
    expect(defaultSocketPath({ CLAUDEOS_PANEL_SOCKET: 'relative.sock' }, 5)).toBe('/tmp/claudeos-5/panel.sock');
  });
});
