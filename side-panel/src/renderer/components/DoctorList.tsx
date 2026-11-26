import { CircleAlert, CircleCheck, CircleX, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { DoctorReport } from '../../shared/protocol';
import { api } from '../lib/api';
import { Spinner } from './Spinner';

const STATUS = {
  ok: { Icon: CircleCheck, cls: 'text-ok', label: 'OK' },
  warn: { Icon: CircleAlert, cls: 'text-amber', label: 'Warning' },
  fail: { Icon: CircleX, cls: 'text-danger', label: 'Failed' },
} as const;

/** Runs `claudeos-doctor --json` through the main process and shows the checklist with fix hints. */
export function DoctorList() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [running, setRunning] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      setReport(await api().system.doctor());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The setup check could not run.');
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api()
      .system.doctor()
      .then((r) => alive && setReport(r))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : 'The setup check could not run.'))
      .finally(() => alive && setRunning(false));
    return () => {
      alive = false;
    };
  }, []);

  const failing = report?.checks.filter((c) => c.status !== 'ok').length ?? 0;

  return (
    <div className="font-sans" data-testid="doctor">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[12.5px] text-muted" aria-live="polite">
          {running
            ? 'Checking your system…'
            : error
              ? error
              : failing === 0
                ? 'Everything looks good.'
                : `${failing} ${failing === 1 ? 'item needs' : 'items need'} attention.`}
        </p>
        <button type="button" className="btn-ghost h-7 px-2 text-[12px]" onClick={() => void run()} disabled={running}>
          {running ? <Spinner size={12} /> : <RefreshCw size={12} aria-hidden />}
          Re-check
        </button>
      </div>
      {report && (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {report.checks.map((c) => {
            const s = STATUS[c.status];
            return (
              <li key={c.id} className="flex gap-2.5 px-3 py-2.5" data-status={c.status}>
                <s.Icon size={16} className={`mt-px shrink-0 ${s.cls}`} aria-label={s.label} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-ink">{c.label}</div>
                  {c.detail && <div className="break-words text-[12px] text-muted">{c.detail}</div>}
                  {c.fix && c.status !== 'ok' && (
                    <div className="mt-1 break-words rounded-md bg-sunken px-2 py-1 font-mono text-[11.5px] text-ink">{c.fix}</div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
