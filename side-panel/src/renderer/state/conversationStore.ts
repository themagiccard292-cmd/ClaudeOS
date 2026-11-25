import type {
  Attachment,
  ChatEvent,
  ClaudeOSApi,
  Conversation,
  ConversationSummary,
  EffortLevel,
  PanelSettings,
  StoredMessage,
} from '../../shared/protocol';
import { deriveTitle } from '../lib/format';
import { type ChatState, INITIAL_CHAT_STATE, reduceChatEvent } from './chatReducer';

export interface ConversationState extends ChatState {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  effort: EffortLevel;
}

export interface Draft {
  text: string;
  attachments: Attachment[];
}

export interface StoreSnapshot {
  activeId: string;
  conversations: Record<string, ConversationState>;
  /** Composer drafts per conversation, kept in memory only. */
  drafts: Record<string, Draft>;
  recents: ConversationSummary[];
  /** Set when the backend reported that the user must sign in. */
  authRequired: boolean;
}

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] };
const UNTITLED = 'New chat';

export function toConversation(c: ConversationState): Conversation {
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    sessionId: c.sessionId,
    model: c.model,
    effort: c.effort,
    messageCount: c.messages.length,
    messages: c.messages,
  };
}

/** Merge pills, keeping the first occurrence of each id (paths are ids). */
export function mergeAttachments(current: Attachment[], added: Attachment[]): Attachment[] {
  const seen = new Set(current.map((a) => a.id));
  return [...current, ...added.filter((a) => !seen.has(a.id) && (seen.add(a.id), true))];
}

/**
 * Conversation store: an external store (useSyncExternalStore) so side effects — sending, saving on turn-complete,
 * loading history — live next to the state they modify. All event folding goes through the pure `reduceChatEvent`.
 */
export class ConversationStore {
  private snapshot: StoreSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: ClaudeOSApi,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {
    const first = this.blank({ model: 'opus', effort: 'medium' });
    this.snapshot = { activeId: first.id, conversations: { [first.id]: first }, drafts: {}, recents: [], authRequired: false };
  }

  // ── useSyncExternalStore plumbing ──
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): StoreSnapshot => this.snapshot;

  private set(update: (s: StoreSnapshot) => StoreSnapshot): void {
    const next = update(this.snapshot);
    if (next === this.snapshot) return;
    this.snapshot = next;
    for (const l of this.listeners) l();
  }

  private patchConversation(id: string, update: (c: ConversationState) => ConversationState): void {
    this.set((s) => {
      const c = s.conversations[id];
      if (!c) return s;
      const nc = update(c);
      return nc === c ? s : { ...s, conversations: { ...s.conversations, [id]: nc } };
    });
  }

  private blank(defaults: Pick<PanelSettings, 'model' | 'effort'>): ConversationState {
    const t = this.now();
    return { ...INITIAL_CHAT_STATE, id: this.newId(), title: UNTITLED, createdAt: t, updatedAt: t, ...defaults };
  }

  get active(): ConversationState {
    return this.snapshot.conversations[this.snapshot.activeId]!;
  }

  // ── History ──
  async refreshRecents(): Promise<void> {
    try {
      const list = await this.api.conversations.list();
      this.set((s) => ({ ...s, recents: [...list].sort((a, b) => b.updatedAt - a.updatedAt) }));
    } catch {
      // History is a convenience; an unreadable store simply shows an empty list.
    }
  }

  private async save(id: string): Promise<void> {
    const c = this.snapshot.conversations[id];
    if (!c || c.messages.length === 0) return;
    try {
      await this.api.conversations.save(toConversation(c));
    } finally {
      await this.refreshRecents();
    }
  }

  /** Start a fresh conversation (saving the current one). Re-uses the current one if it is still empty. */
  async newChat(defaults: Pick<PanelSettings, 'model' | 'effort'>): Promise<void> {
    const current = this.active;
    if (current.messages.length === 0) {
      this.set((s) => ({ ...s, drafts: { ...s.drafts, [current.id]: EMPTY_DRAFT } }));
      return;
    }
    const fresh = this.blank(defaults);
    this.set((s) => ({ ...s, activeId: fresh.id, conversations: { ...s.conversations, [fresh.id]: fresh } }));
    await this.save(current.id);
  }

  async select(id: string): Promise<void> {
    if (this.snapshot.conversations[id]) {
      this.set((s) => ({ ...s, activeId: id }));
      return;
    }
    const loaded = await this.api.conversations.get(id);
    if (!loaded) {
      await this.refreshRecents();
      return;
    }
    const state: ConversationState = {
      id: loaded.id,
      title: loaded.title,
      createdAt: loaded.createdAt,
      updatedAt: loaded.updatedAt,
      model: loaded.model,
      effort: loaded.effort,
      sessionId: loaded.sessionId,
      messages: loaded.messages,
      status: 'idle',
    };
    this.set((s) => ({ ...s, activeId: id, conversations: { ...s.conversations, [id]: state } }));
  }

  async remove(id: string, defaults: Pick<PanelSettings, 'model' | 'effort'>): Promise<void> {
    await this.api.conversations.remove(id);
    if (id === this.snapshot.activeId) {
      const fresh = this.blank(defaults);
      this.set((s) => {
        const conversations = { ...s.conversations, [fresh.id]: fresh };
        delete conversations[id];
        return { ...s, activeId: fresh.id, conversations };
      });
    } else {
      this.set((s) => {
        if (!s.conversations[id]) return s;
        const conversations = { ...s.conversations };
        delete conversations[id];
        return { ...s, conversations };
      });
    }
    await this.refreshRecents();
  }

  // ── Drafts ──
  draft(id = this.snapshot.activeId): Draft {
    return this.snapshot.drafts[id] ?? EMPTY_DRAFT;
  }

  setDraftText(text: string): void {
    const id = this.snapshot.activeId;
    this.set((s) => ({ ...s, drafts: { ...s.drafts, [id]: { ...(s.drafts[id] ?? EMPTY_DRAFT), text } } }));
  }

  addAttachments(added: Attachment[]): void {
    if (added.length === 0) return;
    const id = this.snapshot.activeId;
    this.set((s) => {
      const d = s.drafts[id] ?? EMPTY_DRAFT;
      return { ...s, drafts: { ...s.drafts, [id]: { ...d, attachments: mergeAttachments(d.attachments, added) } } };
    });
  }

  removeAttachment(attachmentId: string): void {
    const id = this.snapshot.activeId;
    this.set((s) => {
      const d = s.drafts[id] ?? EMPTY_DRAFT;
      return { ...s, drafts: { ...s.drafts, [id]: { ...d, attachments: d.attachments.filter((a) => a.id !== attachmentId) } } };
    });
  }

  // ── Chat ──
  async send(text: string, attachments: Attachment[], settings: PanelSettings): Promise<void> {
    const conv = this.active;
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || conv.status === 'starting' || conv.status === 'running' || conv.status === 'stopping') {
      return;
    }
    const t = this.now();
    const message: StoredMessage = {
      id: this.newId(),
      role: 'user',
      blocks: trimmed ? [{ kind: 'text', text: trimmed }] : [],
      attachments: attachments.length ? attachments : undefined,
      createdAt: t,
    };
    const id = conv.id;
    this.set((s) => ({
      ...s,
      drafts: { ...s.drafts, [id]: EMPTY_DRAFT },
      conversations: {
        ...s.conversations,
        [id]: {
          ...conv,
          title: conv.messages.length === 0 ? deriveTitle(trimmed, attachments.map((a) => a.name)) : conv.title,
          messages: [...conv.messages, message],
          status: 'starting',
          error: undefined,
          updatedAt: t,
          model: settings.model,
          effort: settings.effort,
        },
      },
    }));
    let result: Awaited<ReturnType<ClaudeOSApi['chat']['send']>>;
    try {
      result = await this.api.chat.send({
        conversationId: id,
        text: trimmed,
        attachments,
        model: settings.model,
        effort: settings.effort,
        permissionMode: settings.permissionMode,
        resumeSessionId: conv.sessionId,
      });
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!result.ok) {
      const error = result.error;
      this.patchConversation(id, (c) => ({ ...c, status: 'error', error }));
    }
  }

  async stop(): Promise<void> {
    const id = this.snapshot.activeId;
    const c = this.active;
    if (c.status !== 'starting' && c.status !== 'running') return;
    this.patchConversation(id, (cs) => ({ ...cs, status: 'stopping' }));
    await this.api.chat.stop(id);
  }

  clearAuthRequired(): void {
    this.set((s) => (s.authRequired ? { ...s, authRequired: false } : s));
  }

  /** Route one ChatEvent to its conversation; saves when a turn completes. */
  handleEvent = (event: ChatEvent): void => {
    const target = this.snapshot.conversations[event.conversationId];
    if (!target) return;
    const t = this.now();
    this.patchConversation(event.conversationId, (c) => {
      const reduced = reduceChatEvent(c, event, t);
      return reduced === c ? c : { ...c, ...reduced, updatedAt: event.type === 'turn-complete' ? t : c.updatedAt };
    });
    if (event.type === 'auth-required') this.set((s) => ({ ...s, authRequired: true }));
    if (event.type === 'turn-complete') void this.save(event.conversationId);
  };
}
