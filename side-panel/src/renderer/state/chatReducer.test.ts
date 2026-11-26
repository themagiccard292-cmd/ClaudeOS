import type { ChatEvent } from '../../shared/protocol';
import { type ChatState, INITIAL_CHAT_STATE, reduceChatEvent } from './chatReducer';

const cid = 'c1';
const fold = (events: ChatEvent[], start: ChatState = INITIAL_CHAT_STATE) =>
  events.reduce((s, e) => reduceChatEvent(s, e, 42), start);

describe('reduceChatEvent', () => {
  it('accumulates text deltas into one assistant message and sets running', () => {
    const s = fold([
      { type: 'assistant-text-delta', conversationId: cid, messageId: 'm1', text: 'Hel' },
      { type: 'assistant-text-delta', conversationId: cid, messageId: 'm1', text: 'lo' },
    ]);
    expect(s.status).toBe('running');
    expect(s.messages).toEqual([{ id: 'm1', role: 'assistant', blocks: [{ kind: 'text', text: 'Hello' }], createdAt: 42 }]);
  });

  it('keeps thinking, text and tools as separate ordered blocks', () => {
    const s = fold([
      { type: 'thinking-delta', conversationId: cid, messageId: 'm1', text: 'hmm ' },
      { type: 'thinking-delta', conversationId: cid, messageId: 'm1', text: 'ok' },
      { type: 'assistant-text-delta', conversationId: cid, messageId: 'm1', text: 'Checking.' },
      { type: 'tool-use', conversationId: cid, messageId: 'm1', toolUseId: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'assistant-text-delta', conversationId: cid, messageId: 'm1', text: 'Done.' },
    ]);
    expect(s.messages[0]!.blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool', 'text']);
    expect(s.messages[0]!.blocks[0]).toEqual({ kind: 'thinking', text: 'hmm ok' });
  });

  it('completes tool blocks from tool-result (incl. images and errors) and dedupes tool-use', () => {
    const s = fold([
      { type: 'tool-use', conversationId: cid, messageId: 'm1', toolUseId: 't1', name: 'screenshot', input: {} },
      { type: 'tool-use', conversationId: cid, messageId: 'm1', toolUseId: 't1', name: 'screenshot', input: { region: null } },
      { type: 'tool-use', conversationId: cid, messageId: 'm1', toolUseId: 't2', name: 'Bash', input: { command: 'false' } },
      { type: 'tool-result', conversationId: cid, toolUseId: 't1', output: 'ok', isError: false, imageDataUrl: 'data:image/png;base64,AA' },
      { type: 'tool-result', conversationId: cid, toolUseId: 't2', output: 'exit 1', isError: true },
    ]);
    const blocks = s.messages[0]!.blocks;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'tool', status: 'done', imageDataUrl: 'data:image/png;base64,AA', input: { region: null } });
    expect(blocks[1]).toMatchObject({ kind: 'tool', status: 'error', isError: true, output: 'exit 1' });
  });

  it('turn-complete idles, settles running tools and reports errors', () => {
    const running = fold([
      { type: 'status', conversationId: cid, status: 'running' },
      { type: 'tool-use', conversationId: cid, messageId: 'm1', toolUseId: 't1', name: 'Bash', input: {} },
    ]);
    const ok = reduceChatEvent(running, { type: 'turn-complete', conversationId: cid, isError: false });
    expect(ok.status).toBe('idle');
    expect(ok.error).toBeUndefined();
    expect(ok.messages[0]!.blocks[0]).toMatchObject({ status: 'error' });
    const bad = reduceChatEvent(running, { type: 'turn-complete', conversationId: cid, isError: true, resultText: 'Rate limited' });
    expect(bad.error).toBe('Rate limited');
  });

  it('handles status, session, error, auth-required and message-complete', () => {
    let s = fold([{ type: 'status', conversationId: cid, status: 'starting' }]);
    expect(s.status).toBe('starting');
    s = reduceChatEvent(s, { type: 'session', conversationId: cid, sessionId: 'S', model: 'opus', tools: [], mcpServers: [] });
    expect(s.sessionId).toBe('S');
    expect(reduceChatEvent(s, { type: 'assistant-message-complete', conversationId: cid, messageId: 'x' })).toBe(s);
    const err = reduceChatEvent(s, { type: 'error', conversationId: cid, message: 'boom' });
    expect(err).toMatchObject({ status: 'error', error: 'boom' });
    expect(reduceChatEvent(s, { type: 'auth-required', conversationId: cid }).status).toBe('idle');
  });

  it('ignores unknown events and empty deltas', () => {
    const s = fold([{ type: 'assistant-text-delta', conversationId: cid, messageId: 'm', text: '' }]);
    expect(s).toBe(INITIAL_CHAT_STATE);
    expect(reduceChatEvent(s, { type: 'mystery' } as unknown as ChatEvent)).toBe(s);
  });
});
