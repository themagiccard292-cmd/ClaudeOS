import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChatEvent, SendMessageRequest } from '../src/shared/protocol';
import { SessionManager, validateSendRequest, type SpawnFn } from '../src/main/core/session-manager';

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let tmp: string;
let home: string;
let logFile: string;
let managers: SessionManager[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'claudeos-sm-'));
  home = join(tmp, 'home');
  mkdirSync(home);
  logFile = join(tmp, 'fake.log');
  managers = [];
});

afterEach(async () => {
  await Promise.all(managers.map((m) => m.shutdown()));
  rmSync(tmp, { recursive: true, force: true });
});

interface Harness {
  manager: SessionManager;
  events: ChatEvent[];
  waitFor: (pred: (e: ChatEvent) => boolean, timeoutMs?: number) => Promise<ChatEvent>;
  spawnCalls: { cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined; cwd: unknown }[];
}

function harness(scenario: string, extraEnv: Record<string, string> = {}, opts: { killGraceMs?: number; idleTimeoutMs?: number } = {}): Harness {
  const events: ChatEvent[] = [];
  const waiters: { pred: (e: ChatEvent) => boolean; resolve: (e: ChatEvent) => void }[] = [];
  const spawnCalls: Harness['spawnCalls'] = [];
  const spawnFn: SpawnFn = (cmd, args, options) => {
    spawnCalls.push({ cmd, args, env: options.env, cwd: options.cwd });
    return spawn(cmd, args, options);
  };
  const env = {
    ...process.env,
    HOME: home,
    FAKE_CLAUDE_SCENARIO: scenario,
    FAKE_CLAUDE_LOG: logFile,
    ANTHROPIC_API_KEY: 'sk-ant-should-never-leak',
    ANTHROPIC_AUTH_TOKEN: 'tok',
    ANTHROPIC_BASE_URL: 'https://evil.example',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    ...extraEnv,
  };
  const manager = new SessionManager({
    emit: (e) => {
      events.push(e);
      for (const w of [...waiters]) {
        if (w.pred(e)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(e);
        }
      }
    },
    spawn: spawnFn,
    resolveClaude: () => FAKE,
    env,
    homeDir: home,
    mcpConfigPath: '/etc/claudeos/mcp.json',
    ...opts,
  });
  managers.push(manager);
  const waitFor = (pred: (e: ChatEvent) => boolean, timeoutMs = 8000) => {
    const existing = events.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise<ChatEvent>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out; events: ${JSON.stringify(events.map((e) => e.type))}`)), timeoutMs);
      waiters.push({ pred, resolve: (e) => (clearTimeout(t), resolve(e)) });
    });
  };
  return { manager, events, waitFor, spawnCalls };
}

const req = (over: Partial<SendMessageRequest> = {}): SendMessageRequest => ({
  conversationId: 'conv1',
  text: 'Hello there',
  attachments: [],
  model: 'opus',
  effort: 'high',
  permissionMode: 'acceptEdits',
  ...over,
});

const logLines = () => readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const isStatus = (s: string) => (e: ChatEvent) => e.type === 'status' && e.status === s;

describe('SessionManager', () => {
  it('spawns claude with the C3 flags, cwd=$HOME and a sanitized env, and streams a turn', async () => {
    const h = harness('text');
    expect(await h.manager.send(req())).toEqual({ ok: true });
    await h.waitFor((e) => e.type === 'turn-complete');
    await h.waitFor(isStatus('idle'));

    const call = h.spawnCalls[0]!;
    expect(call.cwd).toBe(home);
    expect(call.args).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--replay-user-messages', '--model', 'opus', '--effort', 'high', '--permission-mode', 'acceptEdits',
      '--permission-prompt-tool', 'mcp__claudeos-desktop__request_permission', '--mcp-config', '/etc/claudeos/mcp.json',
    ]);
    expect(call.args).not.toContain('--dangerously-skip-permissions');
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
      expect(call.env?.[k]).toBeUndefined();
    }
    // …and the child really did not see them.
    expect(logLines()[0]!.env).toEqual({});

    const types = h.events.map((e) => e.type);
    expect(types).toContain('session');
    expect(h.events.filter((e) => e.type === 'status').map((e) => (e as { status: string }).status)).toEqual(['starting', 'running', 'idle']);
    const text = h.events.flatMap((e) => (e.type === 'assistant-text-delta' ? [e.text] : [])).join('');
    expect(text).toBe('Hello from fake Claude (turn 1, 11 chars)');
  });

  it('keeps one process per conversation and reuses it across turns', async () => {
    const h = harness('text');
    await h.manager.send(req());
    await h.waitFor((e) => e.type === 'turn-complete');
    await h.manager.send(req({ text: 'again' }));
    await h.waitFor((e) => e.type === 'turn-complete' && h.events.filter((x) => x.type === 'turn-complete').length === 2);
    expect(h.spawnCalls).toHaveLength(1);
    await h.manager.send(req({ conversationId: 'conv2' }));
    await h.waitFor((e) => e.type === 'turn-complete' && e.conversationId === 'conv2');
    expect(h.spawnCalls).toHaveLength(2);
  });

  it('rejects a send while a turn is running and validates requests', async () => {
    const h = harness('slow');
    await h.manager.send(req());
    expect(await h.manager.send(req())).toMatchObject({ ok: false });
    expect(validateSendRequest({ ...req(), conversationId: '../x' })).toBe('Invalid conversation id');
    expect(validateSendRequest({ ...req(), model: '--dangerously-skip-permissions' })).toBe('Invalid model');
    expect(validateSendRequest({ ...req(), effort: 'turbo' })).toBe('Invalid effort level');
    expect(validateSendRequest({ ...req(), permissionMode: 'yolo' })).toBe('Invalid permission mode');
    expect(validateSendRequest({ ...req(), text: ' ', attachments: [] })).toBe('Nothing to send');
    expect(validateSendRequest(null)).toBe('Invalid request');
  });

  it('writes the attachments preamble, embeds small images and adds --add-dir for outside dirs (restarting with --resume)', async () => {
    const h = harness('text');
    await h.manager.send(req());
    await h.waitFor((e) => e.type === 'turn-complete');

    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    const img = join(outside, 'shot.png');
    writeFileSync(img, PNG);
    const doc = join(home, 'notes.txt');
    writeFileSync(doc, 'hello');
    await h.manager.send(
      req({
        text: 'look',
        attachments: [
          { id: img, path: img, name: 'shot.png', kind: 'file' },
          { id: doc, path: doc, name: 'notes.txt', kind: 'image' }, // the renderer's kind is not trusted
        ],
      }),
    );
    await h.waitFor((e) => e.type === 'turn-complete' && h.events.filter((x) => x.type === 'turn-complete').length === 2);

    expect(h.spawnCalls).toHaveLength(2);
    const args = h.spawnCalls[1]!.args;
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('fake-session-0001');
    expect(args[args.indexOf('--add-dir') + 1]).toBe(outside);

    const turns = logLines().filter((l) => l.turn).map((l) => l.turn as { message: { content: Record<string, unknown>[] } });
    const content = turns.at(-1)!.message.content;
    expect(content[0]!.type).toBe('text');
    expect(content[0]!.text).toContain(`- ${img} (image, 70 B, image/png; also embedded below)`);
    expect(content[0]!.text).toContain(`- ${doc} (file, 5 B, text/plain)`);
    expect(content[1]).toEqual({ type: 'text', text: 'look' });
    expect(content[2]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });
  });

  it('restarts with --resume when the model changes', async () => {
    const h = harness('text');
    await h.manager.send(req());
    await h.waitFor((e) => e.type === 'turn-complete');
    await h.manager.send(req({ model: 'sonnet' }));
    await h.waitFor((e) => e.type === 'turn-complete' && h.events.filter((x) => x.type === 'turn-complete').length === 2);
    expect(h.spawnCalls).toHaveLength(2);
    expect(h.spawnCalls[1]!.args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--resume', 'fake-session-0001']));
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
  });

  it('uses resumeSessionId from the request for a fresh process', async () => {
    const h = harness('text');
    await h.manager.send(req({ resumeSessionId: 'abc-123' }));
    await h.waitFor((e) => e.type === 'turn-complete');
    expect(h.spawnCalls[0]!.args).toEqual(expect.arrayContaining(['--resume', 'abc-123']));
  });

  it('stop() sends SIGINT, reports idle, and the next send resumes', async () => {
    const h = harness('slow');
    await h.manager.send(req());
    await h.waitFor((e) => e.type === 'assistant-text-delta');
    await h.manager.stop('conv1');
    const statuses = h.events.filter((e) => e.type === 'status').map((e) => (e as { status: string }).status);
    expect(statuses.slice(-2)).toEqual(['stopping', 'idle']);
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
    expect(h.events.some((e) => e.type === 'assistant-message-complete')).toBe(true);
  });

  it('escalates to SIGKILL when the process ignores SIGINT', async () => {
    const h = harness('slow', { FAKE_CLAUDE_IGNORE_SIGINT: '1' }, { killGraceMs: 300 });
    await h.manager.send(req());
    await h.waitFor((e) => e.type === 'assistant-text-delta');
    const started = Date.now();
    await h.manager.stop('conv1');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(h.manager.status('conv1')).toBe('idle');
  });

  it('reports an unexpected exit with the stderr tail, then respawns with --resume', async () => {
    const h = harness('crash');
    await h.manager.send(req({ resumeSessionId: 'sess-9' }));
    const err = await h.waitFor((e) => e.type === 'error');
    expect((err as { message: string }).message).toContain('code 3');
    expect((err as { message: string }).message).toContain('Fatal: the fake backend crashed');
    await h.waitFor(isStatus('error'));
    await h.manager.send(req());
    await h.waitFor((e) => e.type === 'error' && h.events.filter((x) => x.type === 'error').length === 2);
    expect(h.spawnCalls[1]!.args).toEqual(expect.arrayContaining(['--resume', 'sess-9']));
  });

  it('detects "not logged in" and emits auth-required once per turn', async () => {
    const h = harness('auth');
    await h.manager.send(req());
    await h.waitFor((e) => e.type === 'turn-complete');
    await h.waitFor(isStatus('idle'));
    expect(h.events.filter((e) => e.type === 'auth-required')).toHaveLength(1);
  });

  it('error results end the turn with isError and keep the process', async () => {
    const h = harness('error');
    await h.manager.send(req());
    const done = await h.waitFor((e) => e.type === 'turn-complete');
    expect(done).toMatchObject({ isError: true, resultText: 'Something went wrong' });
    expect(h.events.some((e) => e.type === 'auth-required')).toBe(false);
  });

  it('reaps idle processes and respawns transparently', async () => {
    const h = harness('text', {}, { idleTimeoutMs: 200 });
    await h.manager.send(req());
    await h.waitFor((e) => e.type === 'turn-complete');
    await new Promise((r) => setTimeout(r, 700));
    await h.manager.send(req({ text: 'later' }));
    await h.waitFor((e) => e.type === 'turn-complete' && h.events.filter((x) => x.type === 'turn-complete').length === 2);
    expect(h.spawnCalls).toHaveLength(2);
    expect(h.spawnCalls[1]!.args).toEqual(expect.arrayContaining(['--resume', 'fake-session-0001']));
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
  });

  it('reports a missing claude binary', async () => {
    const events: ChatEvent[] = [];
    const m = new SessionManager({ emit: (e) => events.push(e), resolveClaude: () => null, homeDir: home });
    const r = await m.send(req());
    expect(r.ok).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'error' });
  });
});
