import { Check, ExternalLink, SquareTerminal, TerminalSquare } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { AuthStatus, LoginEvent } from '../../shared/protocol';
import { api } from '../lib/api';
import { ClaudeStarburst } from './ClaudeStarburst';
import { CopyButton } from './CodeBlock';
import { Spinner } from './Spinner';

type Phase =
  | { step: 'idle' }
  | { step: 'starting' }
  | { step: 'browser'; url?: string; needCode: boolean }
  | { step: 'terminal' }
  | { step: 'success' }
  | { step: 'failed'; message: string };

/** Pure: how a LoginEvent moves the sign-in UI. */
export function reduceLogin(phase: Phase, e: LoginEvent): Phase {
  switch (e.type) {
    case 'started':
      return { step: 'starting' };
    case 'url':
      return { step: 'browser', url: e.url, needCode: phase.step === 'browser' && phase.needCode };
    case 'need-code':
      return { step: 'browser', url: phase.step === 'browser' ? phase.url : undefined, needCode: true };
    case 'success':
      return { step: 'success' };
    case 'failed':
      return { step: 'failed', message: e.message };
    case 'cancelled':
      return { step: 'idle' };
    case 'fallback-terminal':
      return { step: 'terminal' };
    default:
      return phase;
  }
}

/**
 * "Sign in with your Claude account" — drives `claude auth login --claudeai` (Claude Pro/Max subscription OAuth)
 * through the main process and reflects every LoginEvent. Used in the panel and in the onboarding wizard.
 */
export function SignInCard({ onSignedIn, compact = false }: { onSignedIn: (status: AuthStatus) => void; compact?: boolean }) {
  const [phase, setPhase] = useState<Phase>({ step: 'idle' });
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const codeId = useId();

  useEffect(() => {
    return api().auth.onLoginEvent((e) => {
      setPhase((p) => reduceLogin(p, e));
      setSubmitting(false);
      if (e.type === 'success') onSignedIn(e.status);
    });
  }, [onSignedIn]);

  const start = async () => {
    setPhase({ step: 'starting' });
    setCode('');
    try {
      await api().auth.login();
    } catch (err) {
      setPhase({ step: 'failed', message: err instanceof Error ? err.message : 'Sign-in could not start.' });
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setSubmitting(true);
    await api().auth.submitCode(code.trim());
  };

  const checkAgain = async () => {
    const status = await api().auth.status();
    if (status.loggedIn) {
      setPhase({ step: 'success' });
      onSignedIn(status);
    }
  };

  const inProgress = phase.step === 'starting' || phase.step === 'browser' || phase.step === 'terminal';

  return (
    <section
      className="rounded-2xl border border-line bg-surface p-5 font-sans shadow-card"
      aria-labelledby={`${codeId}-title`}
      data-testid="signin-card"
    >
      {!compact && <ClaudeStarburst size={28} className="mb-3" />}
      <h2 id={`${codeId}-title`} className="font-serif text-[21px] font-normal leading-tight text-ink">
        {phase.step === 'success' ? 'You’re signed in' : 'Sign in with your Claude account'}
      </h2>

      {phase.step === 'idle' && (
        <>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            ClaudeOS uses your Claude Pro or Max subscription. Your browser will open so you can sign in securely.
          </p>
          <button type="button" className="btn-primary mt-4 h-9 w-full text-[13.5px]" onClick={() => void start()}>
            Sign in with Claude
          </button>
        </>
      )}

      {phase.step === 'starting' && (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-muted" role="status">
          <Spinner size={14} className="text-accent" /> Starting sign-in…
        </p>
      )}

      {phase.step === 'browser' && (
        <div className="mt-3 space-y-3">
          <p className="flex items-center gap-2 text-[13px] text-muted" role="status">
            <Spinner size={14} className="text-accent" />
            {phase.needCode ? 'Paste the code shown in your browser.' : 'Finish signing in in your browser…'}
          </p>
          {phase.url && (
            <div className="rounded-lg border border-line bg-sunken p-2">
              <div className="truncate px-1 font-mono text-[11.5px] text-muted" title={phase.url}>
                {phase.url}
              </div>
              <div className="mt-1.5 flex gap-1">
                <CopyButton text={phase.url} label="Copy link" />
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium text-muted hover:bg-hover hover:text-ink"
                  onClick={() => phase.url && void api().system.openExternal(phase.url)}
                >
                  <ExternalLink size={12} aria-hidden /> Open again
                </button>
              </div>
            </div>
          )}
          {phase.needCode && (
            <form onSubmit={submit} className="space-y-2">
              <label htmlFor={codeId} className="block text-[12px] font-medium text-ink">
                Authentication code
              </label>
              <div className="flex gap-2">
                <input
                  id={codeId}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste code here"
                  className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 font-mono text-[12.5px] text-ink outline-none focus:border-accent"
                />
                <button type="submit" className="btn-primary h-9" disabled={!code.trim() || submitting}>
                  {submitting ? <Spinner size={13} /> : 'Submit'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {phase.step === 'terminal' && (
        <div className="mt-3 space-y-3">
          <p className="flex items-start gap-2 text-[13px] leading-relaxed text-muted">
            <SquareTerminal size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden /> A terminal window opened to finish signing in. Follow the steps there, then come back.
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-primary" onClick={() => void checkAgain()}>
              I’ve signed in
            </button>
            <button type="button" className="btn-quiet" onClick={() => void api().system.openTerminalLogin()}>
              Open terminal again
            </button>
          </div>
        </div>
      )}

      {phase.step === 'success' && (
        <p className="mt-2 flex items-center gap-2 text-[13px] text-muted" role="status">
          <Check size={15} className="text-ok" aria-hidden /> Signed in with your Claude account.
        </p>
      )}

      {phase.step === 'failed' && (
        <div className="mt-2">
          <p className="text-[13px] text-danger" role="alert">
            {phase.message}
          </p>
          <button type="button" className="btn-primary mt-3 w-full" onClick={() => void start()}>
            Try again
          </button>
        </div>
      )}

      {inProgress && (
        <button
          type="button"
          className="btn-ghost mt-3 h-7 px-2 text-[12px]"
          onClick={() => void api().auth.cancelLogin()}
        >
          Cancel
        </button>
      )}
    </section>
  );
}

/** Calm notice when the `claude` CLI is missing. */
export function NotInstalledCard({ onRecheck, onRunDoctor }: { onRecheck: () => void; onRunDoctor: () => void }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5 font-sans shadow-card" data-testid="not-installed">
      <TerminalSquare size={22} className="mb-3 text-muted" aria-hidden />
      <h2 className="font-serif text-[20px] font-normal text-ink">Claude Code isn’t installed</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">
        The panel talks to Claude through the Claude Code command-line tool, which ClaudeOS normally sets up for you. The
        setup check shows what’s missing and how to fix it.
      </p>
      <div className="mt-4 flex gap-2">
        <button type="button" className="btn-primary" onClick={onRunDoctor}>
          Run setup check
        </button>
        <button type="button" className="btn-quiet" onClick={onRecheck}>
          Check again
        </button>
      </div>
    </section>
  );
}
