import clsx from 'clsx';
import { PanelLeft, PanelRightClose, Settings2, SquarePen } from 'lucide-react';
import type { RefObject } from 'react';

export interface HeaderProps {
  title: string;
  drawerOpen: boolean;
  settingsOpen: boolean;
  settingsButtonRef: RefObject<HTMLButtonElement | null>;
  onToggleDrawer: () => void;
  onNewChat: () => void;
  onToggleSettings: () => void;
  onHide: () => void;
}

/** Top bar. The bar itself drags the (frameless) window; buttons opt out. */
export function Header({
  title,
  drawerOpen,
  settingsOpen,
  settingsButtonRef,
  onToggleDrawer,
  onNewChat,
  onToggleSettings,
  onHide,
}: HeaderProps) {
  return (
    <header className="drag-region flex h-12 shrink-0 items-center gap-1 px-2.5">
      <button
        type="button"
        className={clsx('icon-btn', drawerOpen && 'bg-hover text-ink')}
        aria-label={drawerOpen ? 'Hide history' : 'Show history'}
        aria-expanded={drawerOpen}
        onClick={onToggleDrawer}
        title="History"
      >
        <PanelLeft size={17} strokeWidth={1.8} aria-hidden />
      </button>
      <h1 className="min-w-0 flex-1 truncate px-1.5 text-[13.5px] font-medium text-ink" title={title}>
        {title}
      </h1>
      <button type="button" className="icon-btn" aria-label="New chat" onClick={onNewChat} title="New chat">
        <SquarePen size={16} strokeWidth={1.8} aria-hidden />
      </button>
      <button
        ref={settingsButtonRef}
        type="button"
        className={clsx('icon-btn', settingsOpen && 'bg-hover text-ink')}
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        onClick={onToggleSettings}
        title="Settings"
      >
        <Settings2 size={16} strokeWidth={1.8} aria-hidden />
      </button>
      <button type="button" className="icon-btn" aria-label="Hide panel" onClick={onHide} title="Hide panel (Esc)">
        <PanelRightClose size={17} strokeWidth={1.8} aria-hidden />
      </button>
    </header>
  );
}
