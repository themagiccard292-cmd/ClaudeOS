/**
 * Persistent user state under `$CLAUDEOS_CONFIG_DIR` (default ~/.config/claudeos):
 *   panel.json                 settings (validated + clamped, defaults from protocol.ts)
 *   conversations/<id>.json    one file per conversation
 *   onboarding-done            first-run wizard stamp
 * Writes are atomic (temp file + rename) so a crash never leaves a half-written file.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  DEFAULT_SETTINGS,
  EFFORTS,
  PANEL_MAX_WIDTH_ABS,
  PANEL_MIN_WIDTH,
  type Conversation,
  type ConversationSummary,
  type PanelSettings,
  type PermissionMode,
  type ThemePreference,
} from '../../shared/protocol';
import { CONVERSATION_ID_RE } from './session-manager';

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDEOS_CONFIG_DIR && isAbsolute(env.CLAUDEOS_CONFIG_DIR)) return env.CLAUDEOS_CONFIG_DIR;
  const xdg = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  return join(xdg, 'claudeos');
}

/** Writes `data` to `file` atomically (same-directory temp file + rename), mode 0600. */
export async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

const PERMISSION_MODES: readonly PermissionMode[] = ['acceptEdits', 'manual', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];
const MODEL_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,99}$/;

/**
 * Merges an untrusted patch into `base`, dropping invalid fields and clamping the width to the absolute bounds
 * (the work-area-dependent clamp happens in the window layer).
 */
export function mergeSettings(base: PanelSettings, patch: unknown): PanelSettings {
  const out: PanelSettings = { ...base };
  if (typeof patch !== 'object' || patch === null) return out;
  const p = patch as Record<string, unknown>;
  if (typeof p.model === 'string' && MODEL_ALIAS_RE.test(p.model)) out.model = p.model;
  if (EFFORTS.some((e) => e.id === p.effort)) out.effort = p.effort as PanelSettings['effort'];
  if (PERMISSION_MODES.includes(p.permissionMode as PermissionMode)) out.permissionMode = p.permissionMode as PermissionMode;
  if (typeof p.panelWidth === 'number' && Number.isFinite(p.panelWidth)) {
    out.panelWidth = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH_ABS, Math.round(p.panelWidth)));
  }
  if (typeof p.reserveSpace === 'boolean') out.reserveSpace = p.reserveSpace;
  if (THEMES.includes(p.theme as ThemePreference)) out.theme = p.theme as ThemePreference;
  if (typeof p.historyOpen === 'boolean') out.historyOpen = p.historyOpen;
  return out;
}

export class SettingsStore {
  private cache: PanelSettings | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  get file(): string {
    return join(this.dir, 'panel.json');
  }

  async get(): Promise<PanelSettings> {
    if (this.cache) return { ...this.cache };
    let loaded: unknown = {};
    try {
      loaded = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      // missing or corrupt → defaults
    }
    this.cache = mergeSettings(DEFAULT_SETTINGS, loaded);
    return { ...this.cache };
  }

  /** Applies a validated patch, persists it and returns the new settings. */
  async set(patch: unknown): Promise<PanelSettings> {
    const next = mergeSettings(await this.get(), patch);
    this.cache = next;
    const data = JSON.stringify(next, null, 2) + '\n';
    // Serialise writes so an older snapshot can never overwrite a newer one.
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await atomicWrite(this.file, data);
    });
    await this.writeChain;
    return { ...next };
  }
}

export function isValidConversationId(id: unknown): id is string {
  return typeof id === 'string' && CONVERSATION_ID_RE.test(id);
}

/** Structural check of a conversation coming from the renderer or from disk. */
export function isConversation(v: unknown): v is Conversation {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    isValidConversationId(c.id) &&
    typeof c.title === 'string' &&
    typeof c.createdAt === 'number' &&
    typeof c.updatedAt === 'number' &&
    typeof c.model === 'string' &&
    typeof c.messageCount === 'number' &&
    typeof c.effort === 'string' &&
    Array.isArray(c.messages) &&
    (c.sessionId === undefined || typeof c.sessionId === 'string')
  );
}

/** Max serialized conversation size (screenshots make these big, but not unbounded). */
export const MAX_CONVERSATION_BYTES = 50 * 1024 * 1024;

export class ConversationStore {
  constructor(private readonly dir: string) {}

  get directory(): string {
    return join(this.dir, 'conversations');
  }

  private fileFor(id: string): string {
    if (!isValidConversationId(id)) throw new Error('invalid conversation id');
    return join(this.directory, `${id}.json`);
  }

  /** Summaries sorted by updatedAt (newest first). Corrupt or foreign files are skipped. */
  async list(): Promise<ConversationSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return [];
    }
    const out: ConversationSummary[] = [];
    for (const name of names) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!isValidConversationId(id)) continue;
      const conv = await this.get(id);
      if (!conv) continue;
      out.push({
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        model: conv.model,
        messageCount: conv.messageCount,
        ...(conv.sessionId ? { sessionId: conv.sessionId } : {}),
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Conversation | null> {
    if (!isValidConversationId(id)) return null;
    try {
      const file = this.fileFor(id);
      if ((await stat(file)).size > MAX_CONVERSATION_BYTES) return null;
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      return isConversation(parsed) && parsed.id === id ? parsed : null;
    } catch {
      return null;
    }
  }

  async save(conversation: unknown): Promise<void> {
    if (!isConversation(conversation)) throw new Error('invalid conversation');
    const data = JSON.stringify(conversation);
    if (data.length > MAX_CONVERSATION_BYTES) throw new Error('conversation too large');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await atomicWrite(this.fileFor(conversation.id), data);
  }

  async remove(id: string): Promise<void> {
    if (!isValidConversationId(id)) throw new Error('invalid conversation id');
    await rm(this.fileFor(id), { force: true });
  }
}

/** The `onboarding-done` stamp (also read by claudeos-firstboot, C9). */
export class OnboardingStamp {
  constructor(private readonly dir: string) {}

  get file(): string {
    return join(this.dir, 'onboarding-done');
  }

  async isDone(): Promise<boolean> {
    try {
      await stat(this.file);
      return true;
    } catch {
      return false;
    }
  }

  async markDone(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await atomicWrite(this.file, `${new Date().toISOString()}\n`);
  }
}
