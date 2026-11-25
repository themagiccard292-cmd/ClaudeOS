import type { ChatEvent, ConversationStatus, MessageBlock, StoredMessage } from '../../shared/protocol';

/** The per-conversation slice that streaming events modify. */
export interface ChatState {
  messages: StoredMessage[];
  status: ConversationStatus;
  error?: string;
  /** Claude Code session id; the next send passes it as `resumeSessionId`. */
  sessionId?: string;
}

export const INITIAL_CHAT_STATE: ChatState = { messages: [], status: 'idle' };

type ToolBlock = Extract<MessageBlock, { kind: 'tool' }>;

/** Return `messages` with the assistant message `messageId` replaced by `update(msg)` (created if missing). */
function withAssistantMessage(
  messages: StoredMessage[],
  messageId: string,
  now: number,
  update: (m: StoredMessage) => StoredMessage,
): StoredMessage[] {
  const index = messages.findIndex((m) => m.id === messageId && m.role === 'assistant');
  if (index === -1) {
    return [...messages, update({ id: messageId, role: 'assistant', blocks: [], createdAt: now })];
  }
  const next = messages.slice();
  next[index] = update(messages[index]!);
  return next;
}

/** Append streamed text to the trailing block of `kind`, or start a new block if the last block is different. */
function appendDelta(blocks: MessageBlock[], kind: 'text' | 'thinking', text: string): MessageBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind) {
    return [...blocks.slice(0, -1), { kind, text: last.text + text }];
  }
  return [...blocks, { kind, text }];
}

function mapToolBlocks(messages: StoredMessage[], fn: (b: ToolBlock) => ToolBlock): StoredMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (m.role !== 'assistant' || !m.blocks.some((b) => b.kind === 'tool')) return m;
    let touched = false;
    const blocks = m.blocks.map((b) => {
      if (b.kind !== 'tool') return b;
      const nb = fn(b);
      if (nb !== b) touched = true;
      return nb;
    });
    if (!touched) return m;
    changed = true;
    return { ...m, blocks };
  });
  return changed ? next : messages;
}

/** Tools still spinning when a turn ends (stopped / crashed) are closed so the UI never spins forever. */
function settleRunningTools(messages: StoredMessage[]): StoredMessage[] {
  return mapToolBlocks(messages, (b) =>
    b.status === 'running' ? { ...b, status: 'error', isError: true, output: b.output ?? 'Stopped before it finished.' } : b,
  );
}

/**
 * Pure reducer: fold one main-process ChatEvent into the conversation state.
 * Events for another conversation must be routed by the caller (this function does not check ids).
 */
export function reduceChatEvent(state: ChatState, event: ChatEvent, now: number = Date.now()): ChatState {
  switch (event.type) {
    case 'status': {
      const next: ChatState = { ...state, status: event.status, error: event.error };
      if (event.status === 'idle' || event.status === 'error') next.messages = settleRunningTools(state.messages);
      return next;
    }
    case 'session':
      return { ...state, sessionId: event.sessionId };
    case 'assistant-text-delta':
      if (!event.text) return state;
      return {
        ...state,
        status: state.status === 'starting' || state.status === 'idle' ? 'running' : state.status,
        messages: withAssistantMessage(state.messages, event.messageId, now, (m) => ({
          ...m,
          blocks: appendDelta(m.blocks, 'text', event.text),
        })),
      };
    case 'thinking-delta':
      if (!event.text) return state;
      return {
        ...state,
        status: state.status === 'starting' || state.status === 'idle' ? 'running' : state.status,
        messages: withAssistantMessage(state.messages, event.messageId, now, (m) => ({
          ...m,
          blocks: appendDelta(m.blocks, 'thinking', event.text),
        })),
      };
    case 'tool-use': {
      // The same tool_use can be reported twice (streamed start, then the complete message with the full input).
      const exists = state.messages.some((m) => m.blocks.some((b) => b.kind === 'tool' && b.toolUseId === event.toolUseId));
      if (exists) {
        return {
          ...state,
          messages: mapToolBlocks(state.messages, (b) => (b.toolUseId === event.toolUseId ? { ...b, input: event.input } : b)),
        };
      }
      return {
        ...state,
        status: state.status === 'starting' || state.status === 'idle' ? 'running' : state.status,
        messages: withAssistantMessage(state.messages, event.messageId, now, (m) => ({
          ...m,
          blocks: [
            ...m.blocks,
            { kind: 'tool', toolUseId: event.toolUseId, name: event.name, input: event.input, status: 'running' },
          ],
        })),
      };
    }
    case 'tool-result':
      return {
        ...state,
        messages: mapToolBlocks(state.messages, (b) =>
          b.toolUseId === event.toolUseId
            ? {
                ...b,
                output: event.output,
                isError: event.isError,
                imageDataUrl: event.imageDataUrl ?? b.imageDataUrl,
                status: event.isError ? 'error' : 'done',
              }
            : b,
        ),
      };
    case 'assistant-message-complete':
      // Blocks are already complete from the deltas; nothing to change.
      return state;
    case 'turn-complete': {
      const error = event.isError ? (event.resultText?.trim() || 'Claude couldn’t finish that request.') : undefined;
      return { ...state, status: 'idle', error, messages: settleRunningTools(state.messages) };
    }
    case 'auth-required':
      return { ...state, status: 'idle', messages: settleRunningTools(state.messages) };
    case 'error':
      return { ...state, status: 'error', error: event.message, messages: settleRunningTools(state.messages) };
    default:
      // Unknown events (newer main process) are ignored, never thrown on.
      return state;
  }
}
