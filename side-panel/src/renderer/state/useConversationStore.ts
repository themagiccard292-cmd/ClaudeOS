import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ClaudeOSApi } from '../../shared/protocol';
import { ConversationStore, type StoreSnapshot } from './conversationStore';

/** One ConversationStore per panel, wired to the main process's chat event stream for its lifetime. */
export function useConversationStore(api: ClaudeOSApi): [ConversationStore, StoreSnapshot] {
  const [store] = useState(() => new ConversationStore(api));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    const off = api.chat.onEvent(store.handleEvent);
    void store.refreshRecents();
    return off;
  }, [api, store]);
  return [store, snapshot];
}
