import clsx from 'clsx';
import { ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ApprovalRequest, RiskLevel } from '../../shared/protocol';
import { api } from '../lib/api';
import { humanizeToolName } from '../lib/toolLabels';

const RISK: Record<RiskLevel, { label: string; text: string; ring: string; band: string; border: string }> = {
  low: { label: 'Low risk', text: 'text-muted', ring: 'stroke-muted', band: 'bg-muted/10', border: 'border-line' },
  medium: { label: 'Needs your OK', text: 'text-amber', ring: 'stroke-amber', band: 'bg-amber/10', border: 'border-amber/40' },
  high: { label: 'High risk', text: 'text-danger', ring: 'stroke-danger', band: 'bg-danger/10', border: 'border-danger/40' },
  critical: { label: 'Critical', text: 'text-danger', ring: 'stroke-danger', band: 'bg-danger/15', border: 'border-danger/60' },
};

function previewOf(input: unknown): string {
  if (input && typeof input === 'object' && 'command' in input && typeof (input as { command: unknown }).command === 'string') {
    return `$ ${(input as { command: string }).command}`;
  }
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return String(input);
  }
}

function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}

/** Ring that empties as the approval times out. */
function CountdownRing({ fraction, label, className }: { fraction: number; label: string; className: string }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex h-6 w-6 items-center justify-center" aria-hidden>
      <svg viewBox="0 0 24 24" className="h-6 w-6 -rotate-90">
        <circle cx="12" cy="12" r={r} fill="none" strokeWidth="2.2" className="stroke-line" />
        <circle
          cx="12"
          cy="12"
          r={r}
          fill="none"
          strokeWidth="2.2"
          strokeLinecap="round"
          className={clsx(className, 'transition-[stroke-dashoffset] duration-1000 ease-linear')}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.max(0, Math.min(1, fraction)))}
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}

export interface ApprovalCardProps {
  request: ApprovalRequest;
  /** How many more requests are waiting behind this one. */
  queued: number;
  onDecide: (decision: 'allow' | 'deny', message?: string) => void;
}

/**
 * Safety confirmation docked above the composer. Deny is the default/safe action: Esc denies, focus starts on the
 * card (not on Allow), critical risk needs an explicit "I understand" tick, and the timeout denies.
 */
export function ApprovalCard({ request, queued, onDecide }: ApprovalCardProps) {
  const [remaining, setRemaining] = useState(request.timeoutMs);
  const [understood, setUnderstood] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const decided = useRef(false);
  const ids = useId();
  const risk = RISK[request.risk];
  const critical = request.risk === 'critical';

  const decide = useCallback(
    (d: 'allow' | 'deny', message?: string) => {
      if (decided.current) return;
      decided.current = true;
      onDecide(d, message);
    },
    [onDecide],
  );

  // Countdown; the main process also enforces the timeout (deny), this just mirrors it visibly.
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      const left = request.timeoutMs - (Date.now() - started);
      setRemaining(left);
      if (left <= 0) {
        clearInterval(timer);
        decide('deny', 'Timed out waiting for confirmation.');
      }
    }, 250);
    return () => clearInterval(timer);
  }, [request.timeoutMs, decide]);

  useEffect(() => {
    cardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      decide('deny');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [decide]);

  return (
    <section
      ref={cardRef}
      tabIndex={-1}
      role="alertdialog"
      aria-labelledby={`${ids}-t`}
      aria-describedby={`${ids}-d`}
      data-testid="approval-card"
      data-risk={request.risk}
      className={clsx('animate-fade-up mx-3 mb-2 overflow-hidden rounded-2xl border bg-surface font-sans shadow-card outline-none', risk.border)}
    >
      <div className={clsx('flex items-center gap-2 whitespace-nowrap px-4 py-2', risk.band)}>
        <ShieldAlert size={15} className={clsx('shrink-0', risk.text)} aria-hidden />
        <span className={clsx('shrink-0 text-[12px] font-semibold', risk.text)}>{risk.label}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={request.tool}>
          · {humanizeToolName(request.tool)}
        </span>
        {queued > 0 && <span className="shrink-0 text-[11.5px] text-muted">+{queued} waiting</span>}
        <CountdownRing
          fraction={remaining / request.timeoutMs}
          label={`${formatRemaining(remaining)} left`}
          className={risk.ring}
        />
        <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted" aria-hidden>
          {formatRemaining(remaining)}
        </span>
      </div>
      <div className="space-y-2.5 px-4 pb-4 pt-3">
        <h2 id={`${ids}-t`} className="break-words text-[14px] font-medium leading-snug text-ink">
          {request.summary}
        </h2>
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-sunken px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink">
          {previewOf(request.input)}
        </pre>
        <p id={`${ids}-d`} className="text-[12.5px] leading-relaxed text-muted">
          {request.reason ?? 'This action needs your confirmation before it runs.'}
        </p>
        {critical && (
          <label className="flex items-start gap-2 text-[12.5px] text-ink">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
            />
            I understand this can’t be undone.
          </label>
        )}
        <div className="flex justify-end gap-2 pt-0.5">
          <button type="button" className="btn-quiet h-8 min-w-[5.5rem]" onClick={() => decide('deny')}>
            Deny
          </button>
          <button
            type="button"
            className={clsx('btn h-8 min-w-[5.5rem] text-white hover:brightness-105', critical || request.risk === 'high' ? 'bg-danger' : 'bg-accent')}
            disabled={critical && !understood}
            onClick={() => decide('allow')}
          >
            Allow once
          </button>
        </div>
      </div>
    </section>
  );
}

/** Queue of pending approval requests fed by PanelCommands; responds through approvals.respond. */
export function useApprovals(): { queue: ApprovalRequest[]; respond: (id: string, decision: 'allow' | 'deny', message?: string) => void } {
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);
  useEffect(
    () =>
      api().panel.onCommand((c) => {
        if (c.type === 'approval-request') setQueue((q) => (q.some((r) => r.id === c.request.id) ? q : [...q, c.request]));
        if (c.type === 'approval-cancelled') setQueue((q) => q.filter((r) => r.id !== c.id));
      }),
    [],
  );
  const respond = useCallback((id: string, decision: 'allow' | 'deny', message?: string) => {
    setQueue((q) => q.filter((r) => r.id !== id));
    void api().approvals.respond({ id, decision, message });
  }, []);
  return { queue, respond };
}
