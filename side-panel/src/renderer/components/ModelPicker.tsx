import clsx from 'clsx';
import { Check, ChevronDown } from 'lucide-react';
import { useCallback, useId, useRef, useState } from 'react';
import { EFFORTS, type EffortLevel, MODELS, modelPillLabel } from '../../shared/protocol';
import { useDismiss } from '../hooks/useDismiss';
import { useSettings } from '../state/settings';

/** Compact "Opus 5.5 · Med" pill that opens the model list + effort segmented control. Persists via settings.set. */
export function ModelPicker() {
  const { settings, update } = useSettings();
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, popRef, btnRef);

  const choose = (model: string) => void update({ model });
  const setEffort = (effort: EffortLevel) => void update({ effort });

  const onEffortKey = (e: React.KeyboardEvent, index: number) => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = EFFORTS[(index + delta + EFFORTS.length) % EFFORTS.length]!;
    setEffort(next.id);
    (e.currentTarget.parentElement?.children[EFFORTS.indexOf(next)] as HTMLElement | undefined)?.focus();
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        className={clsx(
          'inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[12.5px] font-medium text-muted transition-colors hover:bg-hover hover:text-ink',
          open && 'bg-hover text-ink',
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-label={`Model and effort: ${modelPillLabel(settings)}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="truncate">{modelPillLabel(settings)}</span>
        <ChevronDown size={13} aria-hidden className="shrink-0" />
      </button>
      {open && (
        <div
          ref={popRef}
          id={popId}
          role="dialog"
          aria-label="Model and effort"
          className="animate-fade-up absolute bottom-full right-0 z-40 mb-2 w-[17.5rem] max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-1.5 shadow-pop"
        >
          <div role="radiogroup" aria-label="Model">
            {MODELS.map((m) => {
              const active = m.alias === settings.model;
              return (
                <button
                  key={m.alias}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => choose(m.alias)}
                  className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-ink">{m.label}</span>
                    <span className="block text-[12px] text-muted">{m.description}</span>
                  </span>
                  <Check size={15} aria-hidden className={clsx('mt-0.5 shrink-0 text-accent', !active && 'invisible')} />
                </button>
              );
            })}
          </div>
          <div className="mx-1 my-1.5 border-t border-line" />
          <div className="px-1.5 pb-1 pt-0.5">
            <div className="mb-1.5 text-[11.5px] font-medium text-muted" id={`${popId}-effort`}>
              Effort
            </div>
            <div role="radiogroup" aria-labelledby={`${popId}-effort`} className="grid grid-cols-5 gap-0.5 rounded-lg bg-sunken p-0.5">
              {EFFORTS.map((e, i) => {
                const active = e.id === settings.effort;
                return (
                  <button
                    key={e.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={e.label}
                    tabIndex={active ? 0 : -1}
                    onKeyDown={(ev) => onEffortKey(ev, i)}
                    onClick={() => setEffort(e.id)}
                    className={clsx(
                      'h-7 rounded-md text-[12px] font-medium transition-colors',
                      active ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink',
                    )}
                  >
                    {e.short}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
