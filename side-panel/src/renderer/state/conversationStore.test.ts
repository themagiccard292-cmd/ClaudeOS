import { DEFAULT_SETTINGS } from '../../shared/protocol';
import { createMockApi } from '../dev/mockApi';
import { ConversationStore, mergeAttachments } from './conversationStore';

function setup() {
  const api = createMockApi({ tickMs: 0, seedHistory: false });
  let n = 0;
  const store = new ConversationStore(api, () => 1000, () => `id-${++n}`);
  const off = api.chat.onEvent(store.handleEvent);
  return { api, store, off };
}

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!cond()) throw new Error('condition not met');
};

describe('ConversationStore', () => {
  it('sends, streams, titles, saves on turn-complete and resumes with the session id', async () => {
    const { api, store, off } = setup();
    const id = store.active.id;
    await store.send('What is using my disk space today please tell me', [], DEFAULT_SETTINGS);
    expect(store.active.title).toBe('What is using my disk space today…');
    expect(api.mock.sent[0]).toMatchObject({ conversationId: id, model: 'opus', effort: 'medium', resumeSessionId: undefined });
    await waitFor(() => api.mock.saved.length === 1);
    expect(store.active.status).toBe('idle');
    expect(store.active.sessionId).toMatch(/^mock-session-/);
    expect(api.mock.saved[0]!.messages.length).toBe(2);
    expect(store.getSnapshot().recents.map((r) => r.id)).toEqual([id]);

    await store.send('and again', [], DEFAULT_SETTINGS);
    expect(api.mock.sent[1]!.resumeSessionId).toBe(store.active.sessionId);
    off();
  });

  it('ignores empty sends and keeps drafts per conversation', async () => {
    const { api, store } = setup();
    await store.send('   ', [], DEFAULT_SETTINGS);
    expect(api.mock.sent).toHaveLength(0);
    store.setDraftText('draft one');
    store.addAttachments([{ id: '/a', path: '/a', name: 'a', kind: 'file' }]);
    store.addAttachments([{ id: '/a', path: '/a', name: 'a', kind: 'file' }]);
    expect(store.draft().attachments).toHaveLength(1);
    store.removeAttachment('/a');
    expect(store.draft()).toEqual({ text: 'draft one', attachments: [] });
  });

  it('new chat saves the current conversation; select loads from history; remove resets', async () => {
    const { api, store } = setup();
    api.chat.onEvent(store.handleEvent);
    await store.send('hello', [], DEFAULT_SETTINGS);
    await waitFor(() => store.active.status === 'idle' && api.mock.saved.length > 0);
    const first = store.active.id;
    await store.newChat(DEFAULT_SETTINGS);
    expect(store.active.id).not.toBe(first);
    const second = store.active.id;
    await store.newChat(DEFAULT_SETTINGS); // empty → reused
    expect(store.active.id).toBe(second);

    const fresh = new ConversationStore(api);
    await fresh.select(first);
    expect(fresh.active.messages.length).toBe(2);
    await fresh.remove(first, DEFAULT_SETTINGS);
    expect(fresh.active.id).not.toBe(first);
    expect(await api.conversations.get(first)).toBeNull();
  });

  it('reports send failures and flags auth-required', async () => {
    const { api, store } = setup();
    api.chat.send = async () => ({ ok: false, error: 'spawn failed' });
    await store.send('hi', [], DEFAULT_SETTINGS);
    expect(store.active).toMatchObject({ status: 'error', error: 'spawn failed' });
    store.handleEvent({ type: 'auth-required', conversationId: store.active.id });
    expect(store.getSnapshot().authRequired).toBe(true);
    store.clearAuthRequired();
    expect(store.getSnapshot().authRequired).toBe(false);
  });

  it('stop interrupts a running turn', async () => {
    const { api, store } = setup();
    const stop = vi.spyOn(api.chat, 'stop');
    await store.send('hi', [], DEFAULT_SETTINGS);
    await store.stop();
    expect(stop).toHaveBeenCalledWith(store.active.id);
    await waitFor(() => store.active.status === 'idle');
  });

  it('merges attachments by id', () => {
    const a = { id: '1', path: '/1', name: '1', kind: 'file' as const };
    const b = { id: '2', path: '/2', name: '2', kind: 'file' as const };
    expect(mergeAttachments([a], [a, b]).map((x) => x.id)).toEqual(['1', '2']);
  });
});
