import clsx from 'clsx';
import { FileText, FileWarning, Folder, Image as ImageIcon, X } from 'lucide-react';
import type { Attachment } from '../../shared/protocol';
import { formatBytes } from '../lib/format';

const ICONS = { file: FileText, directory: Folder, image: ImageIcon, missing: FileWarning } as const;

/** A file/folder pill. Images show an icon (file:// previews are not allowed by the CSP). */
export function AttachmentPill({ attachment, onRemove }: { attachment: Attachment; onRemove?: (id: string) => void }) {
  const Icon = ICONS[attachment.kind];
  const missing = attachment.kind === 'missing';
  const size = attachment.kind === 'directory' ? 'Folder' : missing ? 'Not found' : formatBytes(attachment.sizeBytes);
  return (
    <span
      className={clsx(
        'group inline-flex h-8 min-w-0 max-w-[15rem] items-center gap-1.5 rounded-lg border bg-surface pl-2 text-[12.5px]',
        onRemove ? 'pr-1' : 'pr-2.5',
        missing ? 'border-amber/45' : 'border-line',
      )}
      title={missing ? `${attachment.path} (missing)` : attachment.path}
      data-testid="attachment-pill"
    >
      <span
        className={clsx(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
          missing ? 'text-amber' : attachment.kind === 'image' ? 'bg-accent/10 text-accent' : 'bg-sunken text-muted',
        )}
      >
        <Icon size={13} strokeWidth={1.9} aria-hidden />
      </span>
      <span className={clsx('min-w-0 truncate font-medium', missing && 'text-muted line-through')}>{attachment.name}</span>
      {size && <span className={clsx('shrink-0 text-[11px]', missing ? 'text-amber' : 'text-muted')}>{size}</span>}
      {onRemove && (
        <button
          type="button"
          className="ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink"
          aria-label={`Remove ${attachment.name}`}
          onClick={() => onRemove(attachment.id)}
        >
          <X size={13} aria-hidden />
        </button>
      )}
    </span>
  );
}
