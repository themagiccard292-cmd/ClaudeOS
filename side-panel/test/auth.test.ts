import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoginEvent } from '../src/shared/protocol';
import { AuthManager, extractUrl, openTerminalLogin, parseAuthStatus, stripAnsi } from '../src/main/core/auth';
import type { SpawnFn } from '../src/main/core/session-manager';

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
let tmp: string;
let state: string;
let logFile: string;
let managers: AuthManager[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'claudeos-auth-'));
  state = join(tmp, 'auth.json');
  logFile = join(tmp, 'log');
  managers = [];
});
afterEach(() => {
  managers.forEach((m) => m.dispose());
  rmSync(tmp, { recursive: true, force: true });
});

function make(loginMode: string, openTerminal: () => boolean = () => false) {
  const events: LoginEvent[] = [];
  const opened: string[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const spawnFn: SpawnFn = (c, a, o) => {
    spawnArgs.push(a);
    return spawn(c, a, o);
  };
  const m = new AuthManager({
    emit: (e) => events.push(e),
    openUrl: (u) => opened.push(u),
    openTerminal,
    spawn: spawnFn,
    resolveClaude: () => FAKE,
    env: { ...process.env, FAKE_CLAUDE_AUTH_STATE: state, FAKE_CLAUDE_LOGIN: loginMode, FAKE_CLAUDE_LOG: logFile, ANTHROPIC_API_KEY: 'sk-ant-x' },
    pollIntervalMs: 100,
    loginTimeoutMs: 8000,
  });
  managers.push(m);
  const until = async (type: LoginEvent['type'], ms = 8000) => {
    const start = Date.now();
    while (!events.some((e) => e.type === type)) {
      if (Date.now() - start > ms) throw new Error(`no ${type}; got ${JSON.stringify(events)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { m, events, opened, until, spawnArgs };
}

describe('helpers', () => {
  it('strips ANSI and extracts the first https URL', () => {
    expect(stripAnsi('\u001b[2mhi\u001b[22m \u001b]8;;https://x\u0007link\u001b]8;;\u0007')).toBe('hi link');
    expect(extractUrl('visit: \u001b[4mhttps://claude.ai/oauth/authorize?a=1&b=2\u001b[24m.')).toBe('https://claude.ai/oauth/authorize?a=1&b=2');
    expect(extractUrl('no url http://insecure')).toBeNull();
  });
  it('parses auth status JSON with noise', () => {
    expect(parseAuthStatus('warn\n{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"x"}\n')).toEqual({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
    });
    expect(parseAuthStatus('nope')).toBeNull();
  });
});

describe('AuthManager', () => {
  it('status reports not installed when the binary is missing', async () => {
    const m = new AuthManager({ emit: () => {}, openUrl: () => {}, resolveClaude: () => null });
    expect(await m.status()).toEqual({ claudeInstalled: false, loggedIn: false });
  });

  it('status reads auth status --json and the version', async () => {
    writeFileSync(state, JSON.stringify({ loggedIn: true }));
    const { m } = make('code');
    expect(await m.status()).toEqual({ claudeInstalled: true, loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', version: '2.1.332' });
  });

  it('login with pasted code: url → need-code → submitCode → success', async () => {
    const { m, events, opened, until, spawnArgs } = make('code');
    await m.login();
    await until('need-code');
    expect(events[0]).toEqual({ type: 'started' });
    expect(events.find((e) => e.type === 'url')).toEqual({ type: 'url', url: 'https://claude.ai/oauth/authorize?code=true&client_id=fake-client&state=abc123' });
    expect(opened).toHaveLength(1);
    expect(spawnArgs[0]).toEqual(['auth', 'login', '--claudeai']);
    await m.submitCode('  good-code  ');
    await until('success');
    expect(events.at(-1)).toMatchObject({ type: 'success', status: { loggedIn: true } });
    // the login child never saw an API key
    expect(JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n')[0]!).env.ANTHROPIC_API_KEY).toBeNull();
    await expect(m.submitCode('again')).rejects.toThrow();
  });

  it('passes --sso / --email', async () => {
    const { m, until, spawnArgs } = make('browser');
    await m.login({ sso: true, email: 'a@b.c' });
    await until('success');
    expect(spawnArgs[0]).toEqual(['auth', 'login', '--claudeai', '--sso', '--email', 'a@b.c']);
  });

  it('login completed in the browser is detected (status poll / exit)', async () => {
    const { m, events, until } = make('browser');
    await m.login();
    await until('success');
    expect(events.filter((e) => e.type === 'success')).toHaveLength(1);
  });

  it('wrong code fails with the CLI message', async () => {
    const { m, events, until } = make('code');
    await m.login();
    await until('need-code');
    await m.submitCode('bad');
    await until('failed');
    expect(events.at(-1)).toEqual({ type: 'failed', message: 'OAuth error: Invalid code' });
  });

  it('TTY complaint falls back to a terminal and keeps polling', async () => {
    let opened = 0;
    const { m, events, until } = make('tty', () => {
      opened += 1;
      return true;
    });
    await m.login();
    await until('fallback-terminal');
    expect(opened).toBe(1);
    writeFileSync(state, JSON.stringify({ loggedIn: true })); // user signs in from the terminal
    await until('success');
    expect(events.map((e) => e.type)).toEqual(['started', 'fallback-terminal', 'success']);
  });

  it('TTY complaint without a terminal fails', async () => {
    const { m, until, events } = make('tty', () => false);
    await m.login();
    await until('failed');
    expect((events.at(-1) as { message: string }).message).toContain('claudeos-login');
  });

  it('cancel stops the flow and emits cancelled once', async () => {
    const { m, events, until } = make('code');
    await m.login();
    await until('need-code');
    await m.cancel();
    await m.cancel();
    expect(events.filter((e) => e.type === 'cancelled')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(events.at(-1)).toEqual({ type: 'cancelled' });
  });

  it('logout signs out and returns the new status', async () => {
    writeFileSync(state, JSON.stringify({ loggedIn: true }));
    const { m } = make('code');
    expect((await m.logout()).loggedIn).toBe(false);
  });
});

describe('openTerminalLogin', () => {
  it('prefers ptyxis, falls back to x-terminal-emulator, reports absence', () => {
    const calls: [string, readonly string[]][] = [];
    const fakeSpawn: SpawnFn = (c, a) => {
      calls.push([c, a]);
      return { on: () => undefined, unref: () => undefined } as never;
    };
    expect(openTerminalLogin({ which: (n) => (n === 'ptyxis' ? '/usr/bin/ptyxis' : '/usr/bin/xte'), spawn: fakeSpawn })).toBe(true);
    expect(openTerminalLogin({ which: (n) => (n === 'x-terminal-emulator' ? '/usr/bin/x-terminal-emulator' : null), spawn: fakeSpawn })).toBe(true);
    expect(openTerminalLogin({ which: () => null, spawn: fakeSpawn })).toBe(false);
    expect(calls).toEqual([
      ['/usr/bin/ptyxis', ['--', 'claudeos-login']],
      ['/usr/bin/x-terminal-emulator', ['-e', 'claudeos-login']],
    ]);
  });
});
