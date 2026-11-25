/**
 * Turning filesystem paths into `Attachment` pills. Used for the socket `attach`/`ask` commands, the renderer's
 * `files.describe`, the native picker and — re-validated — every attachment that arrives with a chat turn.
 */
import { stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Attachment } from '../../shared/protocol';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/x-typescript',
  '.tsx': 'text/x-typescript',
  '.py': 'text/x-python',
  '.sh': 'application/x-sh',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

/** Image types Claude accepts as inline image blocks (C3). */
export const EMBEDDABLE_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_EMBEDDED_IMAGE_BYTES = 5 * 1024 * 1024;
/** Upper bound on paths accepted in one describe call (defends against absurd payloads). */
export const MAX_DESCRIBE_PATHS = 200;

export function mimeTypeForPath(path: string): string | undefined {
  return MIME_BY_EXT[extname(path).toLowerCase()];
}

/**
 * Normalises a path or file:// URI to an absolute path, or null when it is not acceptable (relative, empty, contains
 * NUL, non-file URI).
 */
export function toAbsolutePath(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 4096 || input.includes('\0')) return null;
  let p = input;
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(p);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    return null;
  }
  if (!isAbsolute(p)) return null;
  const n = normalize(p);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

/** Stats one absolute path into an Attachment. */
export async function describePath(path: string): Promise<Attachment> {
  const name = basename(path) || path;
  try {
    const st = await stat(path);
    if (st.isDirectory()) return { id: path, path, name, kind: 'directory' };
    const mimeType = mimeTypeForPath(path);
    return {
      id: path,
      path,
      name,
      kind: mimeType?.startsWith('image/') ? 'image' : 'file',
      sizeBytes: st.size,
      ...(mimeType ? { mimeType } : {}),
    };
  } catch {
    return { id: path, path, name, kind: 'missing' };
  }
}

/**
 * Describes a list of paths: non-absolute entries are rejected (dropped), file:// URIs accepted, duplicates removed
 * while keeping the first occurrence's order.
 */
export async function describePaths(paths: readonly unknown[]): Promise<Attachment[]> {
  const seen = new Set<string>();
  const accepted: string[] = [];
  for (const raw of paths.slice(0, MAX_DESCRIBE_PATHS)) {
    const abs = toAbsolutePath(raw);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    accepted.push(abs);
  }
  return Promise.all(accepted.map(describePath));
}

/** Human-readable size for the attachment preamble ("12 KB"). */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${units[unit]}`;
}
