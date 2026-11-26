import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';

/** Modal sheet over the panel (used for the setup check). Escape or the × closes it; focus returns afterwards. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-black/25" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="animate-fade-up mt-auto flex max-h-[88%] flex-col rounded-t-2xl border-t border-line bg-bg shadow-pop outline-none"
      >
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <h2 id={titleId} className="font-serif text-[19px] text-ink">
            {title}
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto px-4 pb-4 pt-2">{children}</div>
      </div>
    </div>
  );
}
