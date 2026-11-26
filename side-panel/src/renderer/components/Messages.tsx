import clsx from 'clsx';
import { ArrowDown, ChevronRight, CircleAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ConversationStatus, MessageBlock, StoredMessage } from '../../shared/protocol';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { AttachmentPill } from './AttachmentPill';
import { ClaudeStarburst } from './ClaudeStarburst';
import { Markdown } from './Markdown';
import { ToolGroup } from './ToolCalls';

type ToolBlock = Extract<MessageBlock, { kind: 'tool' }>;

/** Collapsed-by-default reasoning. */
export function ThinkingBlock({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="my-2 font-sans">
      <button
        type="button"
        className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[13px] text-muted transition-colors hover:text-ink"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight size={14} aria-hidden className={clsx('transition-transform duration-150', open && 'rotate-90')} />
        {active ? 'Thinking…' : 'Thought process'}
      </button>
      {open && (
        <div id={id} className="mt-1.5 whitespace-pre-wrap border-l-2 border-line pl-3 text-[13px] leading-relaxed text-muted">
          {text}
        </div>
      )}
    </div>
  );
}

export function UserMessage({ message }: { message: StoredMessage }) {
  const text = message.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('\n');
  return (
    <div className="flex flex-col items-end gap-1.5" data-testid="user-message">
      {message.attachments && message.attachments.length > 0 && (
        <div className="flex max-w-[90%] flex-wrap justify-end gap-1.5">
          {message.attachments.map((a) => (
            <AttachmentPill key={a.id} attachment={a} />
          ))}
        </div>
      )}
      {text && (
        <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl bg-bubble px-3.5 py-2.5 font-sans text-[14px] leading-[1.55] text-ink">
          {text}
        </div>
      )}
    </div>
  );
}

/** Group consecutive tool blocks so they render as one card. */
function segment(blocks: MessageBlock[]): (MessageBlock | ToolBlock[])[] {
  const out: (MessageBlock | ToolBlock[])[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.kind === 'tool') {
      if (Array.isArray(last)) last.push(b);
      else out.push([b]);
    } else out.push(b);
  }
  return out;
}

export function AssistantMessage({ message, streaming }: { message: StoredMessage; streaming: boolean }) {
  const parts = segment(message.blocks);
  return (
    <div className="min-w-0" data-testid="assistant-message">
      {parts.map((p, i) => {
        if (Array.isArray(p)) return <ToolGroup key={p[0]!.toolUseId} blocks={p} />;
        if (p.kind === 'text') return <Markdown key={i} text={p.text} />;
        if (p.kind === 'thinking') return <ThinkingBlock key={i} text={p.text} active={streaming && i === parts.length - 1} />;
        return null;
      })}
    </div>
  );
}

/** Pulsing starburst shown while Claude works. */
function WorkingIndicator({ status }: { status: ConversationStatus }) {
  return (
    <div className="flex h-7 items-center gap-2 text-[12.5px] text-muted" role="status" aria-live="polite">
      <ClaudeStarburst size={18} thinking />
      <span className="sr-only">{status === 'stopping' ? 'Stopping' : 'Claude is working'}</span>
    </div>
  );
}

const STICK_THRESHOLD = 48;

export interface MessageListProps {
  messages: StoredMessage[];
  status: ConversationStatus;
  error?: string;
  conversationId: string;
}

/**
 * Scrollable transcript. Follows new content while the user is at the bottom; once they scroll up it stops and
 * offers a "Jump to latest" pill instead of yanking them back down.
 */
export function MessageList({ messages, status, error, conversationId }: MessageListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const reduced = useReducedMotion();
  const busy = status === 'starting' || status === 'running' || status === 'stopping';
  const last = messages[messages.length - 1];

  const scrollToEnd = useCallback(
    (smooth: boolean) => {
      const el = scroller.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced ? 'smooth' : 'auto' });
    },
    [reduced],
  );

  // New conversation → start at the bottom.
  useLayoutEffect(() => {
    stuck.current = true;
    scrollToEnd(false);
  }, [conversationId, scrollToEnd]);

  // Content changed → follow if the user hasn't scrolled away.
  useLayoutEffect(() => {
    if (stuck.current) scrollToEnd(false);
  }, [messages, status, scrollToEnd]);

  // Images/fonts can change height after layout; keep following while stuck.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stuck.current) scrollToEnd(false);
    });
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [scrollToEnd]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    stuck.current = atBottom;
    setShowJump(!atBottom);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto" data-testid="message-scroller">
        <div className="mx-auto flex max-w-[46rem] flex-col gap-5 px-5 pb-6 pt-4" aria-live="off">
          {messages.map((m) =>
            m.role === 'user' ? (
              <UserMessage key={m.id} message={m} />
            ) : (
              <AssistantMessage key={m.id} message={m} streaming={busy && m === last} />
            ),
          )}
          {busy && <WorkingIndicator status={status} />}
          {error && !busy && (
            <div className="flex items-start gap-2 rounded-xl border border-danger/25 bg-danger/5 px-3 py-2.5 text-[13px] text-ink" role="alert">
              <CircleAlert size={15} className="mt-0.5 shrink-0 text-danger" aria-hidden />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <button
            type="button"
            onClick={() => {
              stuck.current = true;
              setShowJump(false);
              scrollToEnd(true);
            }}
            className="animate-fade-up pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink shadow-card hover:bg-hover"
          >
            <ArrowDown size={13} aria-hidden />
            Jump to latest
          </button>
        </div>
      )}
    </div>
  );
}
