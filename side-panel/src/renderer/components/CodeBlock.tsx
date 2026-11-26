import { Check, Copy } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

/** Copy-to-clipboard button that flips to "Copied" for 1.5 s. */
export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied; leave the button as-is rather than claim success.
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className={
        className ??
        'inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-sans text-[11.5px] font-medium text-muted transition-colors hover:bg-hover hover:text-ink'
      }
      aria-label={copied ? 'Copied' : `${label} code`}
    >
      {copied ? <Check size={13} aria-hidden className="text-ok" /> : <Copy size={13} aria-hidden />}
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </button>
  );
}

/** Fenced code rendered as a card: header with language + Copy, then the highlighted code. */
export function CodeBlock({ language, code, children }: { language?: string; code: string; children: ReactNode }) {
  return (
    <div className="not-prose my-3 overflow-hidden rounded-xl border border-line bg-surface font-sans" data-testid="code-card">
      <div className="flex h-8 items-center justify-between border-b border-line pl-3 pr-1.5">
        <span className="font-mono text-[11.5px] lowercase text-muted">{language || 'text'}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[1.6]">{children}</pre>
    </div>
  );
}
