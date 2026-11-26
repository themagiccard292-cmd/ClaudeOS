#!/usr/bin/env node
// Fake `claude` CLI for tests (used via CLAUDEOS_CLAUDE_BIN). Never talks to the network.
//
// Chat mode (`-p --input-format stream-json ...`): reads one stream-json user message per stdin line and plays a
// scripted transcript chosen by FAKE_CLAUDE_SCENARIO = text | tool | error | auth | slow | crash.
//   FAKE_CLAUDE_LOG             file that receives one JSON line per invocation ({argv, cwd, env}) and per user turn
//   FAKE_CLAUDE_IGNORE_SIGINT=1 keep running on SIGINT (exercises the SIGKILL escalation)
// Auth mode: `auth status [--json]`, `auth login [...]`, `auth logout`, driven by the JSON state file
// FAKE_CLAUDE_AUTH_STATE ({"loggedIn":bool}). FAKE_CLAUDE_LOGIN = code (default) | browser | tty selects the login flow.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const env = process.env;
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const log = (obj) => {
  if (env.FAKE_CLAUDE_LOG) appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify(obj) + '\n');
};
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ───────────── auth subcommands ─────────────
const readAuth = () => {
  try {
    return JSON.parse(readFileSync(env.FAKE_CLAUDE_AUTH_STATE, 'utf8'));
  } catch {
    return { loggedIn: false };
  }
};
const writeAuth = (state) => writeFileSync(env.FAKE_CLAUDE_AUTH_STATE, JSON.stringify(state));

if (argv[0] === '--version') {
  process.stdout.write('2.1.332 (Claude Code)\n');
  process.exit(0);
}

if (argv[0] === 'auth') {
  const sub = argv[1];
  if (sub === 'status') {
    const s = readAuth();
    out(s.loggedIn ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' } : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' });
    process.exit(s.loggedIn ? 0 : 1);
  }
  if (sub === 'logout') {
    writeAuth({ loggedIn: false });
    process.stdout.write('Successfully logged out from your Anthropic account.\n');
    process.exit(0);
  }
  if (sub === 'login') {
    log({ argv, env: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? null } });
    const mode = env.FAKE_CLAUDE_LOGIN ?? 'code';
    if (mode === 'tty') {
      process.stderr.write('Error: Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default.\n');
      process.exit(1);
    }
    process.stdout.write('Opening browser to sign in…\n');
    process.stdout.write(
      '\u001b[2mBrowser didn\'t open? Use the url below to sign in:\u001b[22m\n\nhttps://claude.ai/oauth/authorize?code=true&client_id=fake-client&state=abc123\n\n',
    );
    if (mode === 'browser') {
      await sleep(300);
      writeAuth({ loggedIn: true });
      process.stdout.write('Login successful.\n');
      process.exit(0);
    }
    process.stdout.write('Paste code here if prompted > ');
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      if (line.trim() === 'good-code') {
        writeAuth({ loggedIn: true });
        process.stdout.write('\nLogin successful.\n');
        process.exit(0);
      }
      process.stderr.write('OAuth error: Invalid code\n');
      process.exit(1);
    }
    process.exit(1);
  }
  process.stderr.write(`unknown auth subcommand ${sub}\n`);
  process.exit(2);
}

// ───────────── chat mode ─────────────
const FORBIDDEN = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
log({ argv, cwd: process.cwd(), env: Object.fromEntries(FORBIDDEN.filter((k) => k in env).map((k) => [k, env[k]])) });

if (env.FAKE_CLAUDE_IGNORE_SIGINT === '1') process.on('SIGINT', () => {});
else process.on('SIGINT', () => process.exit(130));

const scenario = env.FAKE_CLAUDE_SCENARIO ?? 'text';
const sessionId = flagValue('--resume') ?? 'fake-session-0001';
const model = flagValue('--model') ?? 'opus';
let turn = 0;

const init = () =>
  out({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: process.cwd(),
    model: `claude-${model}-test`,
    tools: ['Bash', 'Read', 'mcp__claudeos-desktop__screenshot'],
    mcp_servers: [{ name: 'claudeos-desktop', status: 'connected' }],
    permissionMode: flagValue('--permission-mode'),
  });

const ev = (event) => out({ type: 'stream_event', event, session_id: sessionId, parent_tool_use_id: null });

function streamText(id, text) {
  ev({ type: 'message_start', message: { id, role: 'assistant', content: [] } });
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const piece of text.match(/.{1,6}/gs) ?? []) ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
  ev({ type: 'content_block_stop', index: 0 });
  out({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] }, session_id: sessionId, parent_tool_use_id: null });
  ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
  ev({ type: 'message_stop' });
}

const result = (text, extra = {}) =>
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, total_cost_usd: 0.0012, duration_ms: 42, num_turns: 1, ...extra });

async function play(userMsg) {
  turn += 1;
  if (turn === 1) init();
  switch (scenario) {
    case 'text': {
      const first = userMsg?.message?.content?.find?.((b) => b.type === 'text')?.text ?? '';
      const reply = `Hello from fake Claude (turn ${turn}, ${first.length} chars)`;
      streamText(`msg_text_${turn}`, reply);
      result(reply);
      break;
    }
    case 'tool': {
      const id = `msg_tool_${turn}`;
      ev({ type: 'message_start', message: { id, role: 'assistant', content: [] } });
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__claudeos-desktop__screenshot', input: {} } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"max_dim' } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ension":800}' } });
      ev({ type: 'content_block_stop', index: 0 });
      out({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__claudeos-desktop__screenshot', input: { max_dimension: 800 } }] }, session_id: sessionId, parent_tool_use_id: null });
      ev({ type: 'message_stop' });
      out({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'Screenshot 1x1' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL_PNG } }] }] },
        session_id: sessionId,
        parent_tool_use_id: null,
      });
      streamText(`msg_tool_after_${turn}`, 'I can see your screen.');
      result('I can see your screen.', { num_turns: 2 });
      break;
    }
    case 'error':
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, duration_ms: 5, num_turns: 0, errors: ['Something went wrong'] });
      break;
    case 'auth':
      process.stderr.write('Not logged in · Please run /login\n');
      out({ type: 'assistant', message: { id: `msg_auth_${turn}`, role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, session_id: sessionId, parent_tool_use_id: null });
      result('Not logged in · Please run /login', { is_error: true, total_cost_usd: 0 });
      break;
    case 'slow':
      ev({ type: 'message_start', message: { id: `msg_slow_${turn}`, role: 'assistant', content: [] } });
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Thinking about it' } });
      await sleep(60_000);
      break;
    case 'crash':
      process.stderr.write('debug: starting\nFatal: the fake backend crashed\n');
      process.exit(3);
      break;
    default:
      break;
  }
}

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write('fake-claude: invalid stdin line\n');
    continue;
  }
  log({ turn: msg });
  // --replay-user-messages: echo the user turn back like the real CLI does.
  if (argv.includes('--replay-user-messages')) out({ ...msg, session_id: sessionId, parent_tool_use_id: null });
  await play(msg);
}
process.exit(0);
