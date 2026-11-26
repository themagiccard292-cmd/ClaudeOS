import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, PANEL_MIN_WIDTH, type Conversation, type PanelCommand } from '../src/shared/protocol';
import { ApprovalBroker, clampApprovalTimeout } from '../src/main/core/approvals';
import { FORBIDDEN_ENV_VARS, findOnPath, resolveClaudeBinary, sanitizedEnv } from '../src/main/core/claude-binary';
import { computePanelBounds, computeStrut, setStrut, strutArgs, xidFromHandle, ZERO_STRUT } from '../src/main/core/dock';
import { fallbackReport, parseDoctorReport, runDoctor } from '../src/main/core/doctor';
import { describePaths, formatSize, toAbsolutePath } from '../src/main/core/files';
import { createFileLogger, scrub } from '../src/main/core/logger';
import { ConversationStore, OnboardingStamp, SettingsStore, mergeSettings, defaultConfigDir } from '../src/main/core/stores';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'claudeos-misc-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const exe = (path: string, body = '#!/bin/sh\nexit 0\n') => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
};

describe('claude-binary', () => {
  it('strips every API/provider variable and keeps the rest', () => {
    const env = Object.fromEntries(FORBIDDEN_ENV_VARS.map((k) => [k, 'x']));
    expect(sanitizedEnv({ ...env, PATH: '/bin', HOME: '/h' })).toEqual({ PATH: '/bin', HOME: '/h' });
    expect(FORBIDDEN_ENV_VARS).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']));
  });
  it('resolves CLAUDEOS_CLAUDE_BIN → PATH → fixed fallbacks', () => {
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    const claude = exe(join(bin, 'claude'));
    const override = exe(join(tmp, 'fake'));
    expect(resolveClaudeBinary({ CLAUDEOS_CLAUDE_BIN: override, PATH: bin })).toBe(override);
    expect(resolveClaudeBinary({ CLAUDEOS_CLAUDE_BIN: join(tmp, 'missing'), PATH: bin })).toBeNull();
    expect(resolveClaudeBinary({ PATH: `relative:${bin}` })).toBe(claude);
    expect(resolveClaudeBinary({ PATH: '' }, (p) => p === '/usr/bin/claude')).toBe('/usr/bin/claude');
    expect(resolveClaudeBinary({ PATH: '' }, () => false)).toBeNull();
    writeFileSync(join(tmp, 'notexec'), '');
    expect(findOnPath('notexec', tmp)).toBeNull();
  });
});

describe('stores', () => {
  it('settings: defaults, validation, clamping, atomic persistence', async () => {
    const s = new SettingsStore(join(tmp, 'cfg'));
    expect(await s.get()).toEqual(DEFAULT_SETTINGS);
    const next = await s.set({ panelWidth: 10, model: 'sonnet', effort: 'nope', theme: 'dark', reserveSpace: false, bogus: 1 });
    expect(next).toEqual({ ...DEFAULT_SETTINGS, panelWidth: PANEL_MIN_WIDTH, model: 'sonnet', theme: 'dark', reserveSpace: false });
    expect(JSON.parse(readFileSync(join(tmp, 'cfg', 'panel.json'), 'utf8'))).toEqual(next);
    expect(statSync(join(tmp, 'cfg', 'panel.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(tmp, 'cfg')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(await new SettingsStore(join(tmp, 'cfg')).get()).toEqual(next);
    expect(mergeSettings(DEFAULT_SETTINGS, { panelWidth: 99999, model: '-x' })).toMatchObject({ panelWidth: 1100, model: 'opus' });
  });

  it('settings: corrupt file falls back to defaults; concurrent sets end with the last one', async () => {
    mkdirSync(join(tmp, 'c2'));
    writeFileSync(join(tmp, 'c2', 'panel.json'), '{oops');
    const s = new SettingsStore(join(tmp, 'c2'));
    expect(await s.get()).toEqual(DEFAULT_SETTINGS);
    await Promise.all([s.set({ panelWidth: 500 }), s.set({ panelWidth: 600 }), s.set({ panelWidth: 700 })]);
    expect(JSON.parse(readFileSync(join(tmp, 'c2', 'panel.json'), 'utf8')).panelWidth).toBe(700);
  });

  const conv = (id: string, updatedAt: number): Conversation => ({
    id,
    title: `t-${id}`,
    createdAt: 1,
    updatedAt,
    model: 'opus',
    messageCount: 1,
    effort: 'medium',
    messages: [{ id: 'm', role: 'user', blocks: [{ kind: 'text', text: 'hi' }], createdAt: 1 }],
  });

  it('conversations: save/get/list sorted/remove, ids validated, corrupt files skipped', async () => {
    const store = new ConversationStore(tmp);
    await store.save(conv('a', 10));
    await store.save({ ...conv('b', 30), sessionId: 'sess' });
    await store.save(conv('c_-1', 20));
    writeFileSync(join(store.directory, 'broken.json'), '{');
    writeFileSync(join(store.directory, 'wrong-id.json'), JSON.stringify(conv('other', 99)));
    writeFileSync(join(store.directory, '..evil.json'), JSON.stringify(conv('x', 1)));
    const list = await store.list();
    expect(list.map((c) => c.id)).toEqual(['b', 'c_-1', 'a']);
    expect(list[0]).toEqual({ id: 'b', title: 't-b', createdAt: 1, updatedAt: 30, model: 'opus', messageCount: 1, sessionId: 'sess' });
    expect((await store.get('a'))?.messages).toHaveLength(1);
    expect(await store.get('../etc/passwd')).toBeNull();
    await expect(store.save({ ...conv('a', 1), id: '../../x' })).rejects.toThrow();
    await expect(store.save({ nope: true })).rejects.toThrow();
    await expect(store.remove('../x')).rejects.toThrow();
    await store.remove('a');
    expect(await store.get('a')).toBeNull();
  });

  it('onboarding stamp and config dir resolution', async () => {
    const st = new OnboardingStamp(join(tmp, 'o'));
    expect(await st.isDone()).toBe(false);
    await st.markDone();
    expect(await st.isDone()).toBe(true);
    expect(defaultConfigDir({ CLAUDEOS_CONFIG_DIR: '/cfg' })).toBe('/cfg');
    expect(defaultConfigDir({ XDG_CONFIG_HOME: '/x' })).toBe('/x/claudeos');
  });
});

describe('files', () => {
  it('describes files, dirs, images and missing paths; rejects relative; accepts file:// and dedupes', async () => {
    const f = join(tmp, 'a.txt');
    writeFileSync(f, 'hello');
    const img = join(tmp, 'p.JPG');
    writeFileSync(img, 'xx');
    const out = await describePaths([f, 'relative.txt', pathToFileURL(img).href, img, tmp, join(tmp, 'gone'), 42, 'https://x/y']);
    expect(out).toEqual([
      { id: f, path: f, name: 'a.txt', kind: 'file', sizeBytes: 5, mimeType: 'text/plain' },
      { id: img, path: img, name: 'p.JPG', kind: 'image', sizeBytes: 2, mimeType: 'image/jpeg' },
      { id: tmp, path: tmp, name: tmp.split('/').pop(), kind: 'directory' },
      { id: join(tmp, 'gone'), path: join(tmp, 'gone'), name: 'gone', kind: 'missing' },
    ]);
    expect(toAbsolutePath('/a/b/../c/')).toBe('/a/c');
    expect(toAbsolutePath('/a\0b')).toBeNull();
    expect(formatSize(12 * 1024)).toBe('12 KB');
    expect(formatSize(1536 * 1024)).toBe('1.5 MB');
    expect(formatSize(100)).toBe('100 B');
  });
});

describe('doctor', () => {
  it('parses and validates doctor JSON', () => {
    expect(parseDoctorReport('{"ok":false,"checks":[{"id":"a","label":"A","status":"ok"},{"id":"b","label":"B","status":"weird"},{"id":"c","label":"C","status":"fail","detail":"d","fix":"f"}]}')).toEqual({
      ok: false,
      checks: [
        { id: 'a', label: 'A', status: 'ok' },
        { id: 'c', label: 'C', status: 'fail', detail: 'd', fix: 'f' },
      ],
    });
    expect(parseDoctorReport('{"checks":[{"id":"a","label":"A","status":"warn"}]}')?.ok).toBe(true);
    expect(parseDoctorReport('garbage')).toBeNull();
  });

  it('runs claudeos-doctor --json from PATH', async () => {
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    exe(join(bin, 'claudeos-doctor'), `#!/bin/sh\n[ "$1" = "--json" ] || exit 2\necho '{"ok":true,"checks":[{"id":"uinput","label":"Input","status":"ok"}]}'\n`);
    expect(await runDoctor({ env: { PATH: bin } })).toEqual({ ok: true, checks: [{ id: 'uinput', label: 'Input', status: 'ok' }] });
  });

  it('falls back to an in-process warn report', async () => {
    const r = await runDoctor({ env: { PATH: '', XDG_SESSION_TYPE: 'wayland' }, isExec: () => false });
    expect(r.checks[0]).toMatchObject({ id: 'doctor', status: 'warn' });
    expect(r.checks.find((c) => c.id === 'claude')?.status).toBe('fail');
    expect(r.ok).toBe(false);
    expect(fallbackReport({ CLAUDEOS_CLAUDE_BIN: '/c' }, () => true).ok).toBe(true);
  });
});

describe('dock', () => {
  const wa = { x: 0, y: 32, width: 1920, height: 1048 };
  it('computes right-anchored, full-height, clamped bounds', () => {
    expect(computePanelBounds(wa, 440)).toEqual({ x: 1480, y: 32, width: 440, height: 1048 });
    expect(computePanelBounds(wa, 5000)).toEqual({ x: 820, y: 32, width: 1100, height: 1048 });
    expect(computePanelBounds({ x: 1920, y: 0, width: 1280, height: 1024 }, 100)).toEqual({ x: 2860, y: 0, width: 340, height: 1024 });
  });
  it('computes struts in X pixels', () => {
    expect(computeStrut({ x: 1480, y: 32, width: 440, height: 1048 }, 1920)).toEqual([0, 440, 0, 0, 0, 0, 32, 1079, 0, 0, 0, 0]);
    expect(computeStrut({ x: 1480, y: 0, width: 440, height: 1000 }, 1920, 2)).toEqual([0, 880, 0, 0, 0, 0, 0, 1999, 0, 0, 0, 0]);
  });
  it('builds xprop argv and never throws', async () => {
    expect(strutArgs(0x3a00007, ZERO_STRUT)[0]).toEqual(['-id', '0x3a00007', '-f', '_NET_WM_STRUT_PARTIAL', '32c', '-set', '_NET_WM_STRUT_PARTIAL', '0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0']);
    const calls: string[][] = [];
    expect(await setStrut(0x10, [0, 440, 0, 0, 0, 0, 0, 99, 0, 0, 0, 0], async (f, a) => (calls.push([f, ...a]), true))).toBe(true);
    expect(calls[1]).toEqual(['xprop', '-id', '0x10', '-f', '_NET_WM_STRUT', '32c', '-set', '_NET_WM_STRUT', '0, 440, 0, 0']);
    expect(await setStrut(0x10, ZERO_STRUT, async () => { throw new Error('boom'); })).toBe(false);
    expect(await setStrut(null, ZERO_STRUT, async () => true)).toBe(false);
    const h = Buffer.alloc(8);
    h.writeUInt32LE(0x3a00007, 0);
    expect(xidFromHandle(h)).toBe(0x3a00007);
    expect(xidFromHandle(Buffer.alloc(2))).toBeNull();
  });
});

describe('logger', () => {
  it('scrubs tokens and the home dir, and rotates by size', () => {
    expect(scrub('key sk-ant-oat01-abcdef in /home/u/x', '/home/u')).toBe('key [redacted] in ~/x');
    expect(scrub('Authorization: Bearer abc.def', '/h')).toBe('Authorization: Bearer [redacted]');
    expect(scrub('refresh_token=abcdefghijk123', '/h')).toBe('refresh_token=[redacted]');
    const file = join(tmp, 'logs', 'panel.log');
    const log = createFileLogger({ file, maxBytes: 300 });
    for (let i = 0; i < 20; i++) log.info('event', { i });
    log.debug('hidden');
    expect(statSync(file).size).toBeLessThanOrEqual(300);
    expect(statSync(`${file}.1`).size).toBeGreaterThan(0);
    expect(readFileSync(file, 'utf8')).not.toContain('hidden');
  });
});

describe('ApprovalBroker', () => {
  it('times out to deny, clamps timeouts, cancelAll denies everything', async () => {
    const cmds: PanelCommand[] = [];
    const b = new ApprovalBroker({ sendCommand: (c) => cmds.push(c) });
    vi.useFakeTimers();
    try {
      const p = b.request({ tool: 'Bash', input: {}, summary: 's', risk: 'low', timeoutMs: 1500, source: 'claude-code' });
      vi.advanceTimersByTime(1600);
      expect(await p).toEqual({ decision: 'deny', message: 'No decision was made in time' });
    } finally {
      vi.useRealTimers();
    }
    const p1 = b.request({ tool: 'A', input: 1, summary: 'a', risk: 'high', source: 'mcp' });
    const p2 = b.request({ tool: 'B', input: 2, summary: 'b', risk: 'high', source: 'mcp' });
    b.cancelAll('renderer reloaded');
    expect(await p1).toMatchObject({ decision: 'deny' });
    expect(await p2).toMatchObject({ decision: 'deny' });
    expect(cmds.filter((c) => c.type === 'approval-cancelled')).toHaveLength(3);
    expect(clampApprovalTimeout(10)).toBe(1000);
    expect(clampApprovalTimeout('x')).toBe(120000);
    const ac = new AbortController();
    ac.abort();
    expect(await b.request({ tool: 'A', input: 1, summary: 'a', risk: 'high', source: 'mcp' }, ac.signal)).toMatchObject({ decision: 'deny' });
    const p3 = b.request({ tool: 'A', input: 1, summary: 'a', risk: 'high', source: 'mcp' });
    const id = (cmds.at(-1) as Extract<PanelCommand, { type: 'approval-request' }>).request.id;
    expect(b.respond({ id, decision: 'deny', message: 'no thanks' })).toBe(true);
    expect(await p3).toEqual({ decision: 'deny', message: 'no thanks' });
  });
});
