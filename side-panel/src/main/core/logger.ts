/**
 * Tiny size-rotated logger for the panel main process (~/.cache/claudeos/panel.log).
 *
 * Privacy rules: callers log events and metadata only — never message text, file paths of user data or credentials.
 * As a second line of defence every line passes through `scrub()`, which masks anything token-shaped and the user's
 * home directory.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Masks OAuth/API tokens, bearer headers, long opaque strings and the home directory. */
export function scrub(text: string, home: string = homedir()): string {
  let out = text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/((?:access|refresh|id)?_?token["'=:\s]+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]');
  if (home && home !== '/') out = out.split(home).join('~');
  return out;
}

export interface FileLoggerOptions {
  file?: string;
  maxBytes?: number;
  level?: LogLevel;
  /** Mirror lines to stderr (dev). */
  echo?: boolean;
}

export function defaultLogFile(env: NodeJS.ProcessEnv = process.env): string {
  const cache = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.startsWith('/') ? env.XDG_CACHE_HOME : join(homedir(), '.cache');
  return join(cache, 'claudeos', 'panel.log');
}

/** Creates a logger that appends to `file`, rotating to `file.1` once it exceeds `maxBytes`. Never throws. */
export function createFileLogger(opts: FileLoggerOptions = {}): Logger {
  const file = opts.file ?? defaultLogFile();
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  const minLevel = LEVEL_ORDER[opts.level ?? 'info'];
  let dirReady = false;

  const write = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < minLevel) return;
    const parts = [new Date().toISOString(), level.toUpperCase(), event];
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (v === undefined) continue;
      parts.push(`${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
    }
    const line = scrub(parts.join(' ')) + '\n';
    if (opts.echo) process.stderr.write(line);
    try {
      if (!dirReady) {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        dirReady = true;
      }
      try {
        if (statSync(file).size + line.length > maxBytes) renameSync(file, `${file}.1`);
      } catch {
        // file does not exist yet
      }
      appendFileSync(file, line, { mode: 0o600 });
    } catch {
      // Logging must never break the panel.
    }
  };

  return {
    debug: (e, f) => write('debug', e, f),
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
  };
}

/** Logger that discards everything (tests). */
export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
