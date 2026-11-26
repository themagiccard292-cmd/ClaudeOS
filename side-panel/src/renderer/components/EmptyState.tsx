import { FolderOpen, HardDrive, Monitor, SunMoon } from 'lucide-react';
import { ClaudeStarburst } from './ClaudeStarburst';

export const GREETING = 'How can I help you on ClaudeOS today?';

export const SUGGESTIONS = [
  { text: 'Organise my Downloads folder', icon: FolderOpen },
  { text: 'What’s using my disk space?', icon: HardDrive },
  { text: 'Take a screenshot and explain what’s on screen', icon: Monitor },
  { text: 'Open Settings and turn on dark mode', icon: SunMoon },
] as const;

/** Centered welcome: starburst, serif greeting and quiet suggestion chips that fill the composer. */
export function EmptyState({ onSuggest }: { onSuggest: (text: string) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-6 pt-4 text-center">
      <ClaudeStarburst size={44} animateIn />
      <h1 className="mt-5 max-w-[22rem] font-serif text-[27px] font-normal leading-[1.2] tracking-[-0.01em] text-ink">{GREETING}</h1>
      <ul className="mt-7 flex w-full max-w-[22rem] flex-col gap-2" aria-label="Suggestions">
        {SUGGESTIONS.map(({ text, icon: Icon }) => (
          <li key={text}>
            <button
              type="button"
              onClick={() => onSuggest(text)}
              className="flex w-full items-center gap-2.5 rounded-xl border border-line/80 bg-surface/50 px-3.5 py-2.5 text-left text-[13px] text-muted transition-colors hover:border-line hover:bg-surface hover:text-ink"
            >
              <Icon size={15} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 truncate">{text}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
