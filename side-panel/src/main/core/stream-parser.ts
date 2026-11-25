/**
 * Claude Code `--output-format stream-json` → protocol `ChatEvent` translation (ARCHITECTURE C3).
 *
 * Two layers:
 *  - `LineSplitter` turns an arbitrary byte stream into complete NDJSON lines (partial chunks, CRLF, split UTF-8
 *    sequences and multi-megabyte lines such as base64 screenshots are all handled).
 *  - `StreamTranslator` turns parsed objects into ChatEvents. It is deliberately forgiving: unknown message types and
 *    fields are ignored, malformed values are skipped, nothing throws.
 *
 * Text de-duplication: with `--include-partial-messages` Claude Code sends every assistant message twice — once as
 * `stream_event` deltas and once as a complete `assistant` message. Message ids that were seen in a `message_start`
 * are remembered and their text/thinking is not re-emitted from the complete message. Tool calls are keyed by
 * `tool_use.id` and emitted exactly once, as soon as their input JSON is complete.
 */
import { StringDecoder } from 'node:string_decoder';
import type { ChatEvent } from '../../shared/protocol';

// ───────────────────────────── NDJSON line splitting ─────────────────────────────

export interface LineSplitterOptions {
  /** Lines longer than this (in UTF-16 code units) are dropped. Default 64 MiB: big enough for screenshots. */
  maxLineLength?: number;
  onOverflow?: (length: number) => void;
}

export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private pieces: string[] = [];
  private pendingLength = 0;
  private overflowed = false;
  private readonly maxLineLength: number;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly opts: LineSplitterOptions = {},
  ) {
    this.maxLineLength = opts.maxLineLength ?? 64 * 1024 * 1024;
  }

  push(chunk: Buffer | string): void {
    this.consume(typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
  }

  /** Flushes a trailing line that was not newline-terminated. */
  end(): void {
    this.consume(this.decoder.end());
    if (this.pieces.length > 0 || this.overflowed) this.emitPending();
  }

  private consume(text: string): void {
    let start = 0;
    for (let nl = text.indexOf('\n', start); nl !== -1; nl = text.indexOf('\n', start)) {
      this.append(text.slice(start, nl));
      this.emitPending();
      start = nl + 1;
    }
    if (start < text.length) this.append(text.slice(start));
  }

  private append(piece: string): void {
    if (this.overflowed || piece.length === 0) return;
    if (this.pendingLength + piece.length > this.maxLineLength) {
      this.opts.onOverflow?.(this.pendingLength + piece.length);
      this.overflowed = true;
      this.pieces = [];
      this.pendingLength = 0;
      return;
    }
    this.pieces.push(piece);
    this.pendingLength += piece.length;
  }

  private emitPending(): void {
    const overflowed = this.overflowed;
    let line = this.pieces.length === 1 ? this.pieces[0]! : this.pieces.join('');
    this.pieces = [];
    this.pendingLength = 0;
    this.overflowed = false;
    if (overflowed) return;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim().length > 0) this.onLine(line);
  }
}

// ───────────────────────────── Auth error detection ─────────────────────────────

/** Phrases that unambiguously mean "not signed in", wherever they appear in an error result. */
const STRONG_AUTH_PATTERNS = [/not logged in/i, /please run \/login/i, /invalid api key/i, /oauth token (has )?expired/i];
/** Weaker hints (ARCHITECTURE C3) — only trusted on stderr or error results, never in normal answers. */
const WEAK_AUTH_PATTERNS = [/\/login\b/i, /authenticat/i, /\b401\b/, /oauth/i];

/**
 * True when `text` indicates the CLI is not signed in.
 * `trusted` = the text comes from stderr or an error result; otherwise only the strong phrases count, so an answer
 * that merely talks about authentication does not trigger the sign-in screen.
 */
export function looksLikeAuthError(text: string | undefined, trusted: boolean): boolean {
  if (!text) return false;
  if (STRONG_AUTH_PATTERNS.some((re) => re.test(text))) return true;
  return trusted && WEAK_AUTH_PATTERNS.some((re) => re.test(text));
}

// ───────────────────────────── stream-json → ChatEvent ─────────────────────────────

/** Tool output beyond this is truncated before it is sent to the renderer (and persisted by it). */
export const MAX_TOOL_OUTPUT_CHARS = 100_000;

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

interface StreamingToolBlock {
  toolUseId: string;
  name: string;
  json: string;
  initialInput: unknown;
}

interface StreamingMessage {
  messageId: string;
  tools: Map<number, StreamingToolBlock>;
}

export interface TranslatorOptions {
  onDebug?: (message: string) => void;
}

export class StreamTranslator {
  private sessionIdValue: string | undefined;
  private current: StreamingMessage | null = null;
  private readonly streamedMessageIds = new Set<string>();
  private readonly emittedToolUseIds = new Set<string>();
  /** Messages that produced output but have not been closed with `assistant-message-complete` yet. */
  private readonly openMessages = new Set<string>();
  private localIdCounter = 0;

  constructor(
    private readonly conversationId: string,
    private readonly opts: TranslatorOptions = {},
  ) {}

  get sessionId(): string | undefined {
    return this.sessionIdValue;
  }

  /** Parses one NDJSON line. Invalid JSON is logged at debug level and ignored. */
  handleLine(line: string): ChatEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.opts.onDebug?.(`ignoring non-JSON stdout line (${line.length} chars)`);
      return [];
    }
    return this.handle(parsed);
  }

  handle(msg: unknown): ChatEvent[] {
    if (!isObj(msg)) return [];
    const out: ChatEvent[] = [];
    try {
      const sid = str(msg.session_id);
      if (sid) this.sessionIdValue = sid;
      switch (msg.type) {
        case 'system':
          this.onSystem(msg, out);
          break;
        case 'stream_event':
          if (!msg.parent_tool_use_id) this.onStreamEvent(msg.event, out);
          break;
        case 'assistant':
          if (!msg.parent_tool_use_id) this.onAssistant(msg.message, out);
          break;
        case 'user':
          if (!msg.parent_tool_use_id) this.onUser(msg.message, out);
          break;
        case 'result':
          this.onResult(msg, out);
          break;
        case 'error':
          this.onError(msg.error ?? msg.message, out);
          break;
        default:
          break;
      }
    } catch (err) {
      // Defensive: a translator bug must not take the conversation down.
      this.opts.onDebug?.(`translator error: ${(err as Error).message}`);
    }
    return out;
  }

  /** Closes every open message (used when the process exits mid-turn). */
  flush(): ChatEvent[] {
    const out: ChatEvent[] = [];
    this.closeOpen(out);
    this.current = null;
    return out;
  }

  private newLocalId(): string {
    this.localIdCounter += 1;
    return `local-msg-${this.localIdCounter}`;
  }

  private closeOpen(out: ChatEvent[], except?: string): void {
    for (const id of [...this.openMessages]) {
      if (id === except) continue;
      // A message still being streamed is closed by its own message_stop.
      if (this.current && this.current.messageId === id) continue;
      this.openMessages.delete(id);
      out.push({ type: 'assistant-message-complete', conversationId: this.conversationId, messageId: id });
    }
  }

  private onSystem(msg: Json, out: ChatEvent[]): void {
    if (msg.subtype !== 'init') return;
    const sessionId = str(msg.session_id);
    if (!sessionId) return;
    const tools = Array.isArray(msg.tools) ? msg.tools.filter((t): t is string => typeof t === 'string') : [];
    const mcpServers = Array.isArray(msg.mcp_servers)
      ? msg.mcp_servers.filter(isObj).flatMap((s) => {
          const name = str(s.name);
          return name ? [{ name, status: str(s.status) ?? 'unknown' }] : [];
        })
      : [];
    out.push({
      type: 'session',
      conversationId: this.conversationId,
      sessionId,
      model: str(msg.model) ?? '',
      tools,
      mcpServers,
    });
  }

  private onStreamEvent(event: unknown, out: ChatEvent[]): void {
    if (!isObj(event)) return;
    const cid = this.conversationId;
    switch (event.type) {
      case 'message_start': {
        const message = isObj(event.message) ? event.message : {};
        const messageId = str(message.id) ?? this.newLocalId();
        this.current = null; // a previous message that never got message_stop is closed below
        this.closeOpen(out, messageId);
        this.current = { messageId, tools: new Map() };
        this.streamedMessageIds.add(messageId);
        this.openMessages.add(messageId);
        break;
      }
      case 'content_block_start': {
        if (!this.current) return;
        const block = isObj(event.content_block) ? event.content_block : {};
        const index = num(event.index) ?? 0;
        const messageId = this.current.messageId;
        if (block.type === 'tool_use') {
          const toolUseId = str(block.id);
          if (toolUseId) {
            this.current.tools.set(index, { toolUseId, name: str(block.name) ?? 'tool', json: '', initialInput: block.input });
          }
        } else if (block.type === 'text' && str(block.text)) {
          out.push({ type: 'assistant-text-delta', conversationId: cid, messageId, text: block.text as string });
        } else if (block.type === 'thinking' && str(block.thinking)) {
          out.push({ type: 'thinking-delta', conversationId: cid, messageId, text: block.thinking as string });
        }
        break;
      }
      case 'content_block_delta': {
        if (!this.current) return;
        const delta = isObj(event.delta) ? event.delta : {};
        const messageId = this.current.messageId;
        if (delta.type === 'text_delta' && str(delta.text)) {
          out.push({ type: 'assistant-text-delta', conversationId: cid, messageId, text: delta.text as string });
        } else if (delta.type === 'thinking_delta' && str(delta.thinking)) {
          out.push({ type: 'thinking-delta', conversationId: cid, messageId, text: delta.thinking as string });
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const tool = this.current.tools.get(num(event.index) ?? 0);
          if (tool) tool.json += delta.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        if (!this.current) return;
        const index = num(event.index) ?? 0;
        const tool = this.current.tools.get(index);
        if (!tool) return;
        this.current.tools.delete(index);
        let input: unknown;
        if (tool.json.trim() === '') {
          input = tool.initialInput ?? {};
        } else {
          try {
            input = JSON.parse(tool.json);
          } catch {
            // Incomplete JSON: the complete `assistant` message will provide the input.
            this.opts.onDebug?.('tool input JSON incomplete at block stop; waiting for assistant message');
            return;
          }
        }
        this.emitToolUse(this.current.messageId, tool.toolUseId, tool.name, input, out);
        break;
      }
      case 'message_stop': {
        if (!this.current) return;
        const messageId = this.current.messageId;
        this.current = null;
        if (this.openMessages.delete(messageId)) {
          out.push({ type: 'assistant-message-complete', conversationId: cid, messageId });
        }
        break;
      }
      case 'error':
        this.onError(event.error, out);
        break;
      default:
        break;
    }
  }

  private emitToolUse(messageId: string, toolUseId: string, name: string, input: unknown, out: ChatEvent[]): void {
    if (this.emittedToolUseIds.has(toolUseId)) return;
    this.emittedToolUseIds.add(toolUseId);
    out.push({ type: 'tool-use', conversationId: this.conversationId, messageId, toolUseId, name, input });
  }

  private onAssistant(message: unknown, out: ChatEvent[]): void {
    if (!isObj(message)) return;
    const messageId = str(message.id) ?? this.newLocalId();
    const streamed = this.streamedMessageIds.has(messageId);
    const content = Array.isArray(message.content) ? message.content : [];
    const cid = this.conversationId;
    if (!streamed) {
      this.closeOpen(out, messageId);
      this.openMessages.add(messageId);
    }
    for (const block of content) {
      if (!isObj(block)) continue;
      if (block.type === 'text' && !streamed && str(block.text)) {
        out.push({ type: 'assistant-text-delta', conversationId: cid, messageId, text: block.text as string });
      } else if (block.type === 'thinking' && !streamed && str(block.thinking)) {
        out.push({ type: 'thinking-delta', conversationId: cid, messageId, text: block.thinking as string });
      } else if (block.type === 'tool_use') {
        const toolUseId = str(block.id);
        if (toolUseId) this.emitToolUse(messageId, toolUseId, str(block.name) ?? 'tool', block.input ?? {}, out);
      }
    }
  }

  private onUser(message: unknown, out: ChatEvent[]): void {
    if (!isObj(message) || !Array.isArray(message.content)) return; // replayed user text or unknown shape
    const results = message.content.filter((b): b is Json => isObj(b) && b.type === 'tool_result');
    if (results.length === 0) return;
    this.closeOpen(out);
    for (const block of results) {
      const toolUseId = str(block.tool_use_id);
      if (!toolUseId) continue;
      const { output, imageDataUrl } = toolResultContent(block.content);
      out.push({
        type: 'tool-result',
        conversationId: this.conversationId,
        toolUseId,
        output,
        isError: block.is_error === true,
        ...(imageDataUrl ? { imageDataUrl } : {}),
      });
    }
  }

  private onResult(msg: Json, out: ChatEvent[]): void {
    this.closeOpen(out);
    this.current = null;
    const subtype = str(msg.subtype) ?? '';
    const isError = msg.is_error === true || subtype.startsWith('error');
    let resultText = str(msg.result);
    if (resultText === undefined && Array.isArray(msg.errors)) {
      const errors = msg.errors.filter((e): e is string => typeof e === 'string');
      if (errors.length > 0) resultText = errors.join('\n');
    }
    const event: Extract<ChatEvent, { type: 'turn-complete' }> = { type: 'turn-complete', conversationId: this.conversationId, isError };
    if (resultText !== undefined) event.resultText = resultText;
    const cost = num(msg.total_cost_usd);
    if (cost !== undefined) event.costUsd = cost;
    const duration = num(msg.duration_ms);
    if (duration !== undefined) event.durationMs = duration;
    const turns = num(msg.num_turns);
    if (turns !== undefined) event.numTurns = turns;
    out.push(event);
  }

  private onError(error: unknown, out: ChatEvent[]): void {
    const message = isObj(error) ? str(error.message) : str(error);
    out.push({ type: 'error', conversationId: this.conversationId, message: message ?? 'Claude reported an error' });
  }
}

/** Flattens tool_result content (string or block array) into text plus the first embedded image as a data: URL. */
export function toolResultContent(content: unknown): { output: string; imageDataUrl?: string } {
  let output = '';
  let imageDataUrl: string | undefined;
  if (typeof content === 'string') {
    output = content;
  } else if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (!isObj(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      else if (block.type === 'image' && !imageDataUrl && isObj(block.source)) {
        const src = block.source;
        const mediaType = str(src.media_type);
        const data = str(src.data);
        if (src.type === 'base64' && mediaType && /^image\/[a-z0-9.+-]+$/i.test(mediaType) && data) {
          imageDataUrl = `data:${mediaType};base64,${data}`;
        }
      }
    }
    output = texts.join('\n');
  }
  if (output.length > MAX_TOOL_OUTPUT_CHARS) {
    output = `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… [output truncated: ${output.length - MAX_TOOL_OUTPUT_CHARS} more characters]`;
  }
  return imageDataUrl ? { output, imageDataUrl } : { output };
}
