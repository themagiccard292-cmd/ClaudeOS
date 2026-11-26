/**
 * Opening URLs outside the panel. Only http(s) URLs are ever handed to `xdg-open`; everything else (file:, javascript:,
 * custom schemes…) is refused, so neither the renderer nor model output can launch arbitrary handlers.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { sanitizedEnv } from './claude-binary';
import type { SpawnFn } from './session-manager';

/** Returns the normalised URL when it is a valid http/https URL, else null. */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url.toString();
}

/** Opens an http(s) URL with xdg-open (detached). Returns false when the URL is refused or spawning fails. */
export function openExternalUrl(raw: unknown, spawnFn: SpawnFn = nodeSpawn as SpawnFn, env: NodeJS.ProcessEnv = process.env): boolean {
  const url = safeExternalUrl(raw);
  if (!url) return false;
  try {
    const child = spawnFn('xdg-open', [url], { detached: true, stdio: 'ignore', env: sanitizedEnv(env) });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
