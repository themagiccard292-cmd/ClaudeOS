/**
 * Locating the `claude` CLI and building the environment every `claude` child process runs with.
 *
 * ClaudeOS authenticates exclusively through the Claude Pro/Max subscription OAuth flow, so any variable that would
 * switch Claude Code to API-key or third-party-provider auth is removed before spawning (ARCHITECTURE §0).
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Variables that must never reach a spawned `claude` process. */
export const FORBIDDEN_ENV_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

/** Fixed fallback locations checked after `$PATH` (npm -g installs to /usr/local/bin on Ubuntu). */
export const FALLBACK_CLAUDE_PATHS: readonly string[] = ['/usr/local/bin/claude', '/usr/bin/claude'];

/** Returns a copy of `env` without the API/provider variables. Never mutates the input. */
export function sanitizedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (FORBIDDEN_ENV_VARS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/** True when `path` is an existing regular file the current user may execute. */
export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Looks `name` up on a `$PATH`-style string. Only absolute PATH entries are considered. */
export function findOnPath(name: string, pathValue: string | undefined, isExec = isExecutableFile): string | null {
  if (!pathValue) return null;
  for (const dir of pathValue.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (isExec(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolves the claude binary: `$CLAUDEOS_CLAUDE_BIN` → `$PATH` → /usr/local/bin/claude → /usr/bin/claude.
 * An explicit `CLAUDEOS_CLAUDE_BIN` that is not executable yields null (it is never silently ignored, so tests
 * pointing at a fake binary cannot accidentally fall through to the real CLI).
 */
export function resolveClaudeBinary(env: NodeJS.ProcessEnv = process.env, isExec = isExecutableFile): string | null {
  const override = env.CLAUDEOS_CLAUDE_BIN;
  if (override) return isExec(override) ? override : null;
  const onPath = findOnPath('claude', env.PATH, isExec);
  if (onPath) return onPath;
  return FALLBACK_CLAUDE_PATHS.find((p) => isExec(p)) ?? null;
}
