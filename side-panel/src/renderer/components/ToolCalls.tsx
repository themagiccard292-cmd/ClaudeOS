import clsx from 'clsx';
import {
  AppWindow,
  Bell,
  Bot,
  Camera,
  Check,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  FilePen,
  FileText,
  Folder,
  Globe,
  Keyboard,
  ListChecks,
  Monitor,
  MousePointerClick,
  MoveRight,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  Timer,
  Trash2,
  Search,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { MessageBlock } from '../../shared/protocol';
import { truncate } from '../lib/format';
import { type ToolIconKey, baseToolName, toolIcon, toolLabel, toolSummary } from '../lib/toolLabels';
import { Spinner } from './Spinner';

type ToolBlock = Extract<MessageBlock, { kind: 'tool' }>;

const ICONS: Record<ToolIconKey, LucideIcon> = {
  terminal: SquareTerminal,
  mouse: MousePointerClick,
  keyboard: Keyboard,
  camera: Camera,
  monitor: Monitor,
  app: AppWindow,
  globe: Globe,
  window: AppWindow,
  clipboard: ClipboardList,
  'file-read': FileText,
  'file-edit': FilePen,
  folder: Folder,
  search: Search,
  trash: Trash2,
  move: MoveRight,
  settings: Settings2,
  bell: Bell,
  timer: Timer,
  list: ListChecks,
  agent: Bot,
  shield: ShieldCheck,
  tool: Wrench,
};

export const OUTPUT_LIMIT = 4000;
/** Summaries that are code-like (commands, paths, patterns) render in mono; the rest in the UI font. */
const MONO_SUMMARY = new Set<ToolIconKey>(['terminal', 'file-read', 'file-edit', 'folder', 'search', 'move', 'trash', 'keyboard']);

/** Pretty-print a tool input; shell tools show the bare command. */
function formatInput(name: string, input: unknown): { text: string; isCommand: boolean } {
  const base = baseToolName(name).toLowerCase();
  if ((base === 'bash' || base === 'run_command') && input && typeof input === 'object' && 'command' in input) {
    const cmd = (input as { command: unknown }).command;
    if (typeof cmd === 'string') return { text: cmd, isCommand: true };
  }
  if (input === undefined || input === null) return { text: '', isCommand: false };
  if (typeof input === 'object' && Object.keys(input).length === 0) return { text: '', isCommand: false };
  try {
    return { text: JSON.stringify(input, null, 2), isCommand: false };
  } catch {
    return { text: String(input), isCommand: false };
  }
}

/** Full-window view of a screenshot; Escape or click closes it. */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="animate-fade-up fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <img src={src} alt={alt} className="max-h-full max-w-full rounded-lg shadow-pop" />
      <button ref={closeRef} type="button" className="sr-only" onClick={onClose}>
        Close image
      </button>
    </div>
  );
}

function ToolBody({ block }: { block: ToolBlock }) {
  const [showAll, setShowAll] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const input = formatInput(block.name, block.input);
  const output = block.output ?? '';
  const shown = showAll ? { text: output, truncated: false } : truncate(output, OUTPUT_LIMIT);
  return (
    <div className="space-y-2 px-3 pb-3 pt-0.5">
      {input.text && (
        <pre
          className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-sunken px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink"
          aria-label="Input"
        >
          {input.isCommand ? <span className="select-none text-muted">$ </span> : null}
          {input.text}
        </pre>
      )}
      {block.imageDataUrl && (
        <>
          <button
            type="button"
            className="block overflow-hidden rounded-lg border border-line transition-opacity hover:opacity-90"
            onClick={() => setZoomed(true)}
            aria-label="Enlarge screenshot"
          >
            <img src={block.imageDataUrl} alt="Screenshot returned by the tool" className="block max-h-52 w-auto max-w-full" />
          </button>
          {zoomed && <ImageLightbox src={block.imageDataUrl} alt="Screenshot" onClose={() => setZoomed(false)} />}
        </>
      )}
      {output && (
        <div>
          <pre
            className={clsx(
              'max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line px-3 py-2 font-mono text-[11.5px] leading-relaxed',
              block.isError ? 'text-danger' : 'text-muted',
            )}
            aria-label="Output"
          >
            {shown.text}
            {shown.truncated && '…'}
          </pre>
          {shown.truncated && (
            <button type="button" className="btn-ghost mt-1 h-7 px-2 text-[12px]" onClick={() => setShowAll(true)}>
              Show more ({(output.length - OUTPUT_LIMIT).toLocaleString()} more characters)
            </button>
          )}
        </div>
      )}
      {!input.text && !output && !block.imageDataUrl && <p className="text-[12px] text-muted">No details yet.</p>}
    </div>
  );
}

/** One tool call: icon · label · summary · status, expandable to the input/output. */
export function ToolRow({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const iconKey = toolIcon(block.name);
  const Icon = ICONS[iconKey];
  const monoSummary = MONO_SUMMARY.has(iconKey);
  const label = toolLabel(block.name, block.status);
  const summary = toolSummary(block.name, block.input);
  return (
    <div className="font-sans" data-testid="tool-row" data-status={block.status}>
      <button
        type="button"
        className="group flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-hover/60"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon size={15} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
        <span className="shrink-0 text-[13px] font-medium text-ink">{label}</span>
        {summary && (
          <span className={clsx('min-w-0 flex-1 truncate text-muted', monoSummary ? 'font-mono text-[11.5px]' : 'text-[12.5px]')}>
            {summary}
          </span>
        )}
        {!summary && <span className="flex-1" />}
        <span className="flex shrink-0 items-center gap-1.5">
          {block.status === 'running' && <Spinner size={13} className="text-accent" label="Running" />}
          {block.status === 'done' && <Check size={14} className="text-ok" aria-label="Done" />}
          {block.status === 'error' && <CircleAlert size={14} className="text-danger" aria-label="Failed" />}
          <ChevronRight
            size={14}
            aria-hidden
            className={clsx('text-muted transition-transform duration-150', open && 'rotate-90')}
          />
        </span>
      </button>
      {open && (
        <div id={bodyId}>
          <ToolBody block={block} />
        </div>
      )}
    </div>
  );
}

/** Consecutive tool calls grouped into one hairline card. */
export function ToolGroup({ blocks }: { blocks: ToolBlock[] }) {
  return (
    <div className="my-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface/60" data-testid="tool-group">
      {blocks.map((b) => (
        <ToolRow key={b.toolUseId} block={b} />
      ))}
    </div>
  );
}
