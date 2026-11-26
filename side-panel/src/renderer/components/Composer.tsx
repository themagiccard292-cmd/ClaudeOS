import clsx from 'clsx';
import { ArrowUp, FilePlus2, FolderPlus, Plus, Square } from 'lucide-react';
import { type RefObject, useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Attachment, ConversationStatus } from '../../shared/protocol';
import { useDismiss } from '../hooks/useDismiss';
import { api } from '../lib/api';
import { AttachmentPill } from './AttachmentPill';
import { ModelPicker } from './ModelPicker';

/** ~8 lines of 14px/1.5 text before the textarea starts scrolling. */
const MAX_TEXTAREA_PX = 8 * 21 + 8;

function AddMenu({ onAdd }: { onAdd: (a: Attachment[]) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, menuRef, btnRef);

  const pick = async (directories: boolean) => {
    setOpen(false);
    const picked = await api().files.pick({ directories });
    onAdd(picked);
    btnRef.current?.focus();
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        className={clsx('icon-btn h-8 w-8 rounded-lg border border-line', open && 'bg-hover text-ink')}
        aria-label="Add files or folders"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Plus size={16} aria-hidden />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Add"
          className="animate-fade-up absolute bottom-full left-0 z-40 mb-2 w-44 rounded-xl border border-line bg-surface p-1 shadow-pop"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
            const i = items.indexOf(document.activeElement as HTMLElement);
            items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
          }}
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-hover"
            onClick={() => void pick(false)}
          >
            <FilePlus2 size={15} className="text-muted" aria-hidden /> Add files…
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-hover"
            onClick={() => void pick(true)}
          >
            <FolderPlus size={15} className="text-muted" aria-hidden /> Add folder…
          </button>
        </div>
      )}
    </div>
  );
}

export interface ComposerProps {
  text: string;
  attachments: Attachment[];
  status: ConversationStatus;
  onTextChange: (text: string) => void;
  onAddAttachments: (a: Attachment[]) => void;
  onRemoveAttachment: (id: string) => void;
  onSend: () => void;
  onStop: () => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

/** Floating composer card: pills, auto-growing textarea, + menu, model pill and send/stop. */
export function Composer({
  text,
  attachments,
  status,
  onTextChange,
  onAddAttachments,
  onRemoveAttachment,
  onSend,
  onStop,
  textareaRef,
}: ComposerProps) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? localRef;
  const busy = status === 'starting' || status === 'running' || status === 'stopping';
  const canSend = !busy && (text.trim().length > 0 || attachments.length > 0);

  // Auto-grow: measure the content height, cap at ~8 lines, scroll beyond that.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = Math.min(el.scrollHeight, MAX_TEXTAREA_PX);
    el.style.height = `${Math.max(h, 24)}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_PX ? 'auto' : 'hidden';
  }, [text, ref]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition (e.g. Japanese input) uses Enter to commit a candidate — never send then.
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (canSend) onSend();
  };

  return (
    <div className="px-3 pb-3">
      <div className="rounded-2xl border border-line bg-surface shadow-card transition-colors focus-within:border-muted/40">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3" aria-label="Attachments">
            {attachments.map((a) => (
              <AttachmentPill key={a.id} attachment={a} onRemove={onRemoveAttachment} />
            ))}
          </div>
        )}
        <label className="sr-only" htmlFor="composer-input">
          Message Claude
        </label>
        <textarea
          id="composer-input"
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={attachments.length ? 'Ask about these files…' : 'Ask Claude anything…'}
          className="block w-full resize-none bg-transparent px-4 pt-3.5 font-sans text-[14px] leading-[21px] text-ink outline-none placeholder:text-muted/80 focus-visible:outline-none"
          spellCheck
        />
        <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-2">
          <AddMenu onAdd={onAddAttachments} />
          <div className="flex-1" />
          <ModelPicker />
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              disabled={status === 'stopping'}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-bg transition-opacity hover:opacity-85 disabled:opacity-50"
              aria-label="Stop"
              title="Stop (Esc)"
            >
              <Square size={11} fill="currentColor" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-[filter,opacity] hover:brightness-105 disabled:opacity-40"
              aria-label="Send message"
              title="Send (Enter)"
            >
              <ArrowUp size={17} strokeWidth={2.3} aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
