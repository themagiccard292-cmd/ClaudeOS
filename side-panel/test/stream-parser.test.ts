import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatEvent } from '../src/shared/protocol';
import { LineSplitter, looksLikeAuthError, StreamTranslator, toolResultContent } from '../src/main/core/stream-parser';

const FIXTURES = join(import.meta.dirname, 'fixtures');

function play(name: string, chunkSize?: number): { events: ChatEvent[]; debug: string[] } {
  const debug: string[] = [];
  const t = new StreamTranslator('c1', { onDebug: (m) => debug.push(m) });
  const events: ChatEvent[] = [];
  const splitter = new LineSplitter((line) => events.push(...t.handleLine(line)));
  const data = readFileSync(join(FIXTURES, name));
  if (chunkSize) for (let i = 0; i < data.length; i += chunkSize) splitter.push(data.subarray(i, i + chunkSize));
  else splitter.push(data);
  splitter.end();
  events.push(...t.flush());
  return { events, debug };
}

const textOf = (events: ChatEvent[]) =>
  events.flatMap((e) => (e.type === 'assistant-text-delta' ? [e.text] : [])).join('');

describe('LineSplitter', () => {
  it('reassembles partial chunks, CRLF and split UTF-8 sequences', () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l));
    const buf = Buffer.from('{"a":"héllo"}\r\n\n{"b":1}\n{"c":"€"}', 'utf8');
    for (const byte of buf) s.push(Buffer.from([byte]));
    s.end();
    expect(lines).toEqual(['{"a":"héllo"}', '{"b":1}', '{"c":"€"}']);
  });

  it('handles very long lines and drops lines over the cap', () => {
    const lines: string[] = [];
    const overflow: number[] = [];
    const s = new LineSplitter((l) => lines.push(l), { maxLineLength: 10_000, onOverflow: (n) => overflow.push(n) });
    s.push('x'.repeat(9_000) + '\n');
    s.push('y'.repeat(6_000));
    s.push('y'.repeat(6_000) + '\nok\n');
    s.end();
    expect(lines.map((l) => l.length)).toEqual([9_000, 2]);
    expect(overflow).toHaveLength(1);

    const big: string[] = [];
    const s2 = new LineSplitter((l) => big.push(l));
    const payload = JSON.stringify({ data: 'A'.repeat(8 * 1024 * 1024) });
    for (let i = 0; i < payload.length; i += 65_536) s2.push(payload.slice(i, i + 65_536));
    s2.push('\n');
    expect(big[0]).toHaveLength(payload.length);
  });
});

describe('StreamTranslator fixtures', () => {
  it('text-only: streams text once, ignores junk, completes the turn', () => {
    const { events, debug } = play('text-only.ndjson', 7);
    expect(events[0]).toMatchObject({ type: 'session', sessionId: '5f1c2b9e-7a1d-4c4e-9b8a-2d7f0e3a6c11', model: 'claude-opus-5-5' });
    expect((events[0] as Extract<ChatEvent, { type: 'session' }>).mcpServers).toEqual([{ name: 'claudeos-desktop', status: 'connected' }]);
    expect(textOf(events)).toBe("Hello! I'm Claude, running on ClaudeOS. How can I help?");
    expect(events.filter((e) => e.type === 'assistant-message-complete')).toEqual([
      { type: 'assistant-message-complete', conversationId: 'c1', messageId: 'msg_01TextOnly' },
    ]);
    expect(events.at(-1)).toEqual({
      type: 'turn-complete',
      conversationId: 'c1',
      isError: false,
      resultText: "Hello! I'm Claude, running on ClaudeOS. How can I help?",
      costUsd: 0.0123,
      durationMs: 2312,
      numTurns: 1,
    });
    expect(debug.some((d) => d.includes('non-JSON'))).toBe(true);
  });

  it('thinking: emits thinking deltas and text without duplication', () => {
    const { events } = play('thinking.ndjson');
    const thinking = events.flatMap((e) => (e.type === 'thinking-delta' ? [e.text] : [])).join('');
    expect(thinking).toBe('17*23 = 17*20 + 17*3 = 340 + 51 = 391.');
    expect(textOf(events)).toBe('17 × 23 = **391**.');
    expect(events.filter((e) => e.type === 'assistant-message-complete')).toHaveLength(1);
  });

  it('tool call: assembles input JSON, emits the tool once, converts the screenshot to a data URL', () => {
    const { events } = play('tool-screenshot.ndjson', 13);
    const tools = events.filter((e) => e.type === 'tool-use');
    expect(tools).toEqual([
      {
        type: 'tool-use',
        conversationId: 'c1',
        messageId: 'msg_03ToolCall',
        toolUseId: 'toolu_01Shot',
        name: 'mcp__claudeos-desktop__screenshot',
        input: { max_dimension: 1568 },
      },
    ]);
    const result = events.find((e) => e.type === 'tool-result');
    expect(result).toMatchObject({ toolUseId: 'toolu_01Shot', isError: false, output: 'Screenshot 1920x1080 scaled to 1568x882 (scale 0.8167)' });
    expect((result as { imageDataUrl?: string }).imageDataUrl).toMatch(/^data:image\/png;base64,iVBOR/);
    expect(textOf(events)).toBe('Let me take a screenshot.I can see the GNOME desktop with Firefox open.');
    expect(textOf(events)).not.toContain('subagent');
    const order = events.map((e) => e.type);
    expect(order.indexOf('tool-use')).toBeLessThan(order.indexOf('tool-result'));
    expect(events.filter((e) => e.type === 'assistant-message-complete').map((e) => (e as { messageId: string }).messageId)).toEqual([
      'msg_03ToolCall',
      'msg_04Answer',
    ]);
  });

  it('error result: falls back to the complete message for truncated tool JSON; error tool result; error turn', () => {
    const { events } = play('error-result.ndjson');
    expect(events.find((e) => e.type === 'tool-use')).toMatchObject({ toolUseId: 'toolu_02Bash', input: { command: 'rm -rf /', description: 'x' } });
    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({ isError: true, output: 'Permission denied: blocked by ClaudeOS safety policy' });
    expect(events.at(-1)).toMatchObject({ type: 'turn-complete', isError: true, resultText: 'Reached maximum number of turns (3)', numTurns: 3 });
  });

  it('not logged in: non-streamed message text appears once and the result is an auth error', () => {
    const { events } = play('not-logged-in.ndjson');
    expect(textOf(events)).toBe('Not logged in · Please run /login');
    const done = events.at(-1) as Extract<ChatEvent, { type: 'turn-complete' }>;
    expect(done.isError).toBe(true);
    expect(looksLikeAuthError(done.resultText, done.isError)).toBe(true);
    expect(events.filter((e) => e.type === 'assistant-message-complete')).toHaveLength(1);
  });
});

describe('StreamTranslator robustness', () => {
  it('never throws on garbage and ignores unknown types', () => {
    const t = new StreamTranslator('c');
    for (const v of [null, 1, 'x', [], {}, { type: 'stream_event' }, { type: 'stream_event', event: { type: 'content_block_delta' } }, { type: 'assistant', message: { content: 'nope' } }, { type: 'user', message: { content: [{ type: 'tool_result' }] } }, { type: 'system', subtype: 'init' }, { type: 'mystery', foo: 1 }]) {
      expect(() => t.handle(v)).not.toThrow();
    }
    expect(t.handleLine('{not json')).toEqual([]);
  });

  it('emits text from a complete assistant message when no partial events were streamed', () => {
    const t = new StreamTranslator('c');
    const ev = t.handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] } });
    expect(ev.map((e) => e.type)).toEqual(['assistant-text-delta', 'tool-use']);
    const again = t.handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } });
    expect(again).toEqual([]);
    expect(t.handle({ type: 'result', subtype: 'success', result: 'Hi' }).map((e) => e.type)).toEqual(['assistant-message-complete', 'turn-complete']);
  });

  it('maps stream error events to error ChatEvents', () => {
    const t = new StreamTranslator('c');
    expect(t.handle({ type: 'stream_event', event: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } })).toEqual([
      { type: 'error', conversationId: 'c', message: 'Overloaded' },
    ]);
  });

  it('flush closes a message interrupted mid-stream', () => {
    const t = new StreamTranslator('c');
    t.handle({ type: 'stream_event', event: { type: 'message_start', message: { id: 'mx' } } });
    expect(t.flush()).toEqual([{ type: 'assistant-message-complete', conversationId: 'c', messageId: 'mx' }]);
  });
});

describe('toolResultContent', () => {
  it('handles strings, arrays and truncation', () => {
    expect(toolResultContent('plain')).toEqual({ output: 'plain' });
    expect(toolResultContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toEqual({ output: 'a\nb' });
    expect(toolResultContent([{ type: 'image', source: { type: 'base64', media_type: 'text/html', data: 'x' } }])).toEqual({ output: '' });
    expect(toolResultContent('z'.repeat(200_000)).output.length).toBeLessThan(110_000);
  });
});

describe('looksLikeAuthError', () => {
  it('only trusts weak hints on stderr/error results', () => {
    expect(looksLikeAuthError('Not logged in · Please run /login', false)).toBe(true);
    expect(looksLikeAuthError('OAuth uses authentication codes', false)).toBe(false);
    expect(looksLikeAuthError('API Error: 401 {"type":"authentication_error"}', true)).toBe(true);
    expect(looksLikeAuthError(undefined, true)).toBe(false);
  });
});
