import clsx from 'clsx';
import { MessageSquare, PanelLeftClose, SquarePen, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ConversationSummary } from '../../shared/protocol';
import { formatRelativeTime } from '../lib/format';

export const DRAWER_WIDTH = 256;
/**
 * Below this panel width the drawer overlays the chat instead of pushing it. Pushing only makes sense when the chat
 * keeps a usable width (≥ ~340 px) next to the drawer; at the 440 px default it would be left with 184 px.
 */
export const DRAWER_OVERLAY_BELOW = DRAWER_WIDTH + 340;

export interface HistoryDrawerProps {
  open: boolean;
  overlay: boolean;
  recents: ConversationSummary[];
  activeId: string;
  now: number;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

function RecentRow({
  c,
  active,
  now,
  onSelect,
  onDelete,
}: {
  c: ConversationSummary;
  active: boolean;
  now: number;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <li className="rounded-lg bg-hover px-2.5 py-2" data-testid="recent-confirm">
        <p className="truncate text-[12.5px] text-ink">Delete “{c.title}”?</p>
        <div className="mt-1.5 flex justify-end gap-1">
          <button type="button" className="btn-ghost h-7 px-2 text-[12px]" onClick={() => setConfirming(false)} autoFocus>
            Cancel
          </button>
          <button
            type="button"
            className="btn h-7 bg-danger px-2 text-[12px] text-white hover:brightness-105"
            onClick={() => onDelete(c.id)}
          >
            Delete
          </button>
        </div>
      </li>
    );
  }
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => onSelect(c.id)}
        aria-current={active ? 'page' : undefined}
        className={clsx(
          'relative flex w-full min-w-0 items-center gap-2 rounded-lg py-2 pl-3 pr-9 text-left transition-colors',
          active ? 'bg-hover text-ink' : 'text-ink/85 hover:bg-hover/70',
        )}
      >
        {active && <span className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-accent" aria-hidden />}
        <span className="min-w-0 flex-1 truncate text-[13px]">{c.title}</span>
        <span className="shrink-0 text-[11px] text-muted group-hover:invisible group-focus-within:invisible">
          {formatRelativeTime(c.updatedAt, now)}
        </span>
      </button>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        aria-label={`Delete ${c.title}`}
        className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted opacity-0 transition-opacity hover:bg-bg hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash2 size={14} aria-hidden />
      </button>
    </li>
  );
}

/** Collapsible history drawer inside the panel (pushes the chat when wide, overlays it when narrow). */
export function HistoryDrawer({ open, overlay, recents, activeId, now, onNewChat, onSelect, onDelete, onClose }: HistoryDrawerProps) {
  // Escape closes the overlaying drawer (before the global "Escape hides the panel" handler sees it).
  useEffect(() => {
    if (!open || !overlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, overlay, onClose]);
  return (
    <>
      {overlay && open && (
        <div className="animate-fade-up absolute inset-0 z-20 bg-black/20" onClick={onClose} aria-hidden data-testid="drawer-scrim" />
      )}
      <nav
        aria-label="Conversation history"
        aria-hidden={!open}
        inert={!open}
        style={{ width: DRAWER_WIDTH, marginLeft: !overlay && !open ? -DRAWER_WIDTH : 0 }}
        className={clsx(
          'flex h-full shrink-0 flex-col border-r border-line bg-sunken transition-[margin,transform] duration-200 ease-out',
          overlay && 'absolute inset-y-0 left-0 z-30 shadow-pop',
          overlay && !open && '-translate-x-full shadow-none',
        )}
      >
        <div className="flex items-center gap-1 px-2.5 pb-1 pt-2.5">
          <button
            type="button"
            onClick={onNewChat}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-hover"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-white">
              <SquarePen size={13} aria-hidden />
            </span>
            New chat
          </button>
          <button type="button" className="icon-btn" aria-label="Close history" onClick={onClose} title="Close history">
            <PanelLeftClose size={17} strokeWidth={1.8} aria-hidden />
          </button>
        </div>
        <h2 className="px-5 pb-1 pt-3 text-[11.5px] font-medium text-muted">Recents</h2>
        {recents.length === 0 ? (
          <div className="flex flex-1 flex-col items-center px-6 pt-10 text-center text-[12.5px] text-muted">
            <MessageSquare size={20} aria-hidden className="mb-2 opacity-60" />
            Your conversations will appear here.
          </div>
        ) : (
          <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 pb-3">
            {recents.map((c) => (
              <RecentRow key={c.id} c={c} active={c.id === activeId} now={now} onSelect={onSelect} onDelete={onDelete} />
            ))}
          </ul>
        )}
      </nav>
    </>
  );
}
