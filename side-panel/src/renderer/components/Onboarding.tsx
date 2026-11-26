import clsx from 'clsx';
import { ArrowLeft, Ban, Check, Hand, Keyboard, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthStatus } from '../../shared/protocol';
import { api } from '../lib/api';
import { SignInCard } from './AuthCards';
import { ClaudeStarburst } from './ClaudeStarburst';
import { DoctorList } from './DoctorList';
import { Spinner } from './Spinner';

export const STEPS = ['welcome', 'signin', 'doctor', 'safety', 'done'] as const;
export type Step = (typeof STEPS)[number];
const STEP_NAMES: Record<Step, string> = {
  welcome: 'Welcome',
  signin: 'Sign in',
  doctor: 'Computer control',
  safety: 'Safety',
  done: 'Done',
};

function StepIndicator({ step }: { step: Step }) {
  const index = STEPS.indexOf(step);
  return (
    <ol className="flex items-center gap-1.5" aria-label={`Step ${index + 1} of ${STEPS.length}: ${STEP_NAMES[step]}`}>
      {STEPS.map((s, i) => (
        <li
          key={s}
          aria-current={i === index ? 'step' : undefined}
          className={clsx(
            'h-1.5 rounded-full transition-all duration-300',
            i === index ? 'w-6 bg-accent' : i < index ? 'w-1.5 bg-accent/50' : 'w-1.5 bg-line',
          )}
        >
          <span className="sr-only">{STEP_NAMES[s]}</span>
        </li>
      ))}
    </ol>
  );
}

function SafetyItem({ Icon, title, children }: { Icon: typeof Hand; title: string; children: string }) {
  return (
    <li className="flex gap-3 rounded-xl border border-line bg-surface p-3.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
        <Icon size={16} aria-hidden />
      </span>
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-ink">{title}</div>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{children}</p>
      </div>
    </li>
  );
}

/** First-boot wizard (docs/ARCHITECTURE.md C9): Welcome → Sign in → Computer-control check → Safety → Done. */
export function Onboarding() {
  const [step, setStep] = useState<Step>('welcome');
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [finishing, setFinishing] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const index = STEPS.indexOf(step);

  useEffect(() => {
    let alive = true;
    api()
      .auth.status()
      .then((s) => alive && setAuth(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Move focus to each step's heading so screen readers announce the change.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const onSignedIn = useCallback((s: AuthStatus) => setAuth(s), []);
  const go = (delta: number) => setStep(STEPS[Math.max(0, Math.min(STEPS.length - 1, index + delta))]!);

  const finish = async () => {
    setFinishing(true);
    try {
      await api().system.completeOnboarding();
    } finally {
      await api().panel.hide();
      setFinishing(false);
    }
  };

  const signedIn = auth?.loggedIn === true;
  const heading = 'font-serif text-[30px] font-normal leading-[1.15] tracking-[-0.01em] text-ink outline-none';

  return (
    <div className="flex h-full flex-col bg-bg font-sans" data-testid="onboarding">
      <div className="drag-region flex h-12 shrink-0 items-center justify-center">
        <StepIndicator step={step} />
      </div>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-[30rem] flex-col justify-center px-6 py-6">
          {step === 'welcome' && (
            <div className="text-center">
              <ClaudeStarburst size={56} animateIn className="mx-auto" />
              <h1 ref={headingRef} tabIndex={-1} className={clsx(heading, 'mt-6')}>
                Welcome to ClaudeOS
              </h1>
              <p className="mx-auto mt-4 max-w-[26rem] font-serif text-[16.5px] leading-relaxed text-muted">
                Claude lives in a panel at the edge of your screen. Ask it to find files, change settings, fix problems
                or work through apps with you — it can see your screen and use the mouse and keyboard, and it always
                checks with you before anything risky.
              </p>
            </div>
          )}

          {step === 'signin' && (
            <div>
              <h1 ref={headingRef} tabIndex={-1} className={heading}>
                Sign in with Claude
              </h1>
              <p className="mb-5 mt-3 text-[13.5px] leading-relaxed text-muted">
                ClaudeOS uses your Claude Pro or Max subscription — there’s nothing else to set up or pay for. Sign-in
                happens in your browser.
              </p>
              {signedIn ? (
                <div className="flex items-center gap-2.5 rounded-2xl border border-line bg-surface p-4 shadow-card" role="status">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ok/15 text-ok">
                    <Check size={15} aria-hidden />
                  </span>
                  <span className="text-[13.5px] text-ink">You’re signed in to your Claude account.</span>
                </div>
              ) : auth && !auth.claudeInstalled ? (
                <p className="rounded-2xl border border-line bg-surface p-4 text-[13px] text-muted">
                  Claude Code isn’t installed yet, so sign-in isn’t possible right now. Continue to the setup check to see
                  how to fix it.
                </p>
              ) : (
                <SignInCard onSignedIn={onSignedIn} compact />
              )}
            </div>
          )}

          {step === 'doctor' && (
            <div>
              <h1 ref={headingRef} tabIndex={-1} className={heading}>
                Computer control
              </h1>
              <p className="mb-4 mt-3 text-[13.5px] leading-relaxed text-muted">
                Claude needs a few system pieces to see your screen and use the keyboard and mouse.
              </p>
              <DoctorList />
            </div>
          )}

          {step === 'safety' && (
            <div>
              <h1 ref={headingRef} tabIndex={-1} className={heading}>
                You stay in control
              </h1>
              <ul className="mt-5 space-y-2.5">
                <SafetyItem Icon={ShieldCheck} title="Risky actions ask first">
                  Installing or removing software, using sudo, deleting many files, permanent deletes and system changes
                  show a card in the panel. Nothing happens until you click Allow.
                </SafetyItem>
                <SafetyItem Icon={Ban} title="Dangerous actions are blocked">
                  Wiping disks, deleting system folders and similar destructive commands never run — not even if you
                  approve them.
                </SafetyItem>
                <SafetyItem Icon={Hand} title="Stop anytime">
                  Press Esc or the stop button to interrupt Claude immediately. Super+C shows or hides the panel.
                </SafetyItem>
                <SafetyItem Icon={Keyboard} title="Your screen is just information">
                  Claude treats text it sees on screen or in files as data, not as instructions to follow.
                </SafetyItem>
              </ul>
            </div>
          )}

          {step === 'done' && (
            <div className="text-center">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-accent/10">
                <ClaudeStarburst size={32} animateIn />
              </span>
              <h1 ref={headingRef} tabIndex={-1} className={clsx(heading, 'mt-6')}>
                You’re all set
              </h1>
              <p className="mx-auto mt-3 max-w-[24rem] text-[14px] leading-relaxed text-muted">
                Press <kbd className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[12px] text-ink">Super</kbd>{' '}
                + <kbd className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[12px] text-ink">C</kbd> or
                click Claude in the dock whenever you need a hand.
              </p>
            </div>
          )}
        </div>
      </main>
      <footer className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3.5">
        {index > 0 && step !== 'done' ? (
          <button type="button" className="btn-ghost" onClick={() => go(-1)}>
            <ArrowLeft size={14} aria-hidden /> Back
          </button>
        ) : (
          <span />
        )}
        <span className="flex-1" />
        {step === 'signin' && !signedIn && (
          <button type="button" className="btn-ghost text-[12.5px]" onClick={() => go(1)}>
            Skip for now
          </button>
        )}
        {step === 'done' ? (
          <button type="button" className="btn-primary h-9 px-4" onClick={() => void finish()} disabled={finishing}>
            {finishing && <Spinner size={13} />} Start using Claude
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary h-9 px-4"
            onClick={() => go(1)}
            disabled={step === 'signin' && !signedIn}
          >
            {step === 'welcome' ? 'Get started' : 'Continue'}
          </button>
        )}
      </footer>
    </div>
  );
}
