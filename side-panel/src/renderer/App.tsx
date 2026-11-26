import { Paperclip } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthStatus, PanelSettings } from '../shared/protocol';
import { ApprovalCard, useApprovals } from './components/ApprovalCard';
import { NotInstalledCard, SignInCard } from './components/AuthCards';
import { Composer } from './components/Composer';
import { DoctorList } from './components/DoctorList';
import { EmptyState } from './components/EmptyState';
import { Header } from './components/Header';
import { DRAWER_OVERLAY_BELOW, HistoryDrawer } from './components/HistoryDrawer';
import { MessageList } from './components/Messages';
import { Onboarding } from './components/Onboarding';
import { ResizeHandle } from './components/ResizeHandle';
import { SettingsPopover } from './components/SettingsPopover';
import { Sheet } from './components/Sheet';
import { useTheme } from './hooks/useTheme';
import { useWindowWidth } from './hooks/useWindowWidth';
import { api } from './lib/api';
import { EMPTY_DRAFT } from './state/conversationStore';
import { SettingsProvider, useSettings } from './state/settings';
import { useConversationStore } from './state/useConversationStore';

const ONBOARDING_HASH = '#onboarding';

/** '#onboarding' (or a window the main process created for the wizard) renders the first-boot flow. */
function useRoute(): 'panel' | 'onboarding' {
  const [onboarding, setOnboarding] = useState(() => window.location.hash === ONBOARDING_HASH);
  useEffect(() => {
    let alive = true;
    const onHash = () => setOnboarding(window.location.hash === ONBOARDING_HASH);
    window.addEventListener('hashchange', onHash);
    api()
      .panel.getState()
      .then((s) => alive && s.onboardingWindow && setOnboarding(true))
      .catch(() => undefined);
    const off = api().panel.onCommand((c) => {
      if (c.type === 'show-onboarding') {
        window.location.hash = ONBOARDING_HASH;
        setOnboarding(true);
      }
    });
    return () => {
      alive = false;
      window.removeEventListener('hashchange', onHash);
      off();
    };
  }, []);
  return onboarding ? 'onboarding' : 'panel';
}

/** Ticking clock for relative timestamps (once a minute). */
function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function hasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

function Panel() {
  const { settings, update } = useSettings();
  const [store, snap] = useConversationStore(api());
  const conv = snap.conversations[snap.activeId]!;
  const draft = snap.drafts[snap.activeId] ?? EMPTY_DRAFT;
  const busy = conv.status === 'starting' || conv.status === 'running' || conv.status === 'stopping';

  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<PanelSettings>(settings);
  const { queue, respond } = useApprovals();
  const width = useWindowWidth();
  const now = useNow();

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const refreshAuth = useCallback(async () => {
    try {
      setAuth(await api().auth.status());
    } catch {
      setAuth({ claudeInstalled: true, loggedIn: false, error: 'Could not check sign-in status.' });
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api()
      .auth.status()
      .then((s) => alive && setAuth(s))
      .catch(() => alive && setAuth({ claudeInstalled: true, loggedIn: false }));
    return () => {
      alive = false;
    };
  }, []);

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const sendDraft = useCallback(() => {
    const d = store.draft();
    void store.send(d.text, d.attachments, settingsRef.current);
  }, [store]);

  const newChat = useCallback(async () => {
    await store.newChat(settingsRef.current);
    focusComposer();
  }, [store, focusComposer]);

  // Commands from the socket / CLI / Nautilus.
  useEffect(
    () =>
      api().panel.onCommand((c) => {
        switch (c.type) {
          case 'attach':
            void (async () => {
              if (c.newChat) await store.newChat(settingsRef.current);
              store.addAttachments(c.attachments);
              focusComposer();
            })();
            break;
          case 'ask':
            store.setDraftText(c.text);
            store.addAttachments(c.attachments);
            if (c.send) sendDraft();
            else focusComposer();
            break;
          case 'new-chat':
            void newChat();
            break;
          case 'visibility':
            if (c.visible) focusComposer();
            break;
          default:
            break;
        }
      }),
    [store, sendDraft, newChat, focusComposer],
  );

  // Escape: stop a running turn, otherwise hide the panel. Popovers/cards/sheets stop the event before it gets here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || queue.length > 0) return;
      if (busy) void store.stop();
      else void api().panel.hide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, queue.length, store]);

  // Drag & drop files onto the panel.
  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = async (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => api().files.pathForFile(f))
      .filter((p): p is string => Boolean(p));
    if (paths.length === 0) return;
    store.addAttachments(await api().files.describe(paths));
    focusComposer();
  };

  const drawerOpen = settings.historyOpen;
  const overlay = width < DRAWER_OVERLAY_BELOW;
  const toggleDrawer = () => void update({ historyOpen: !drawerOpen });
  const closeDrawer = useCallback(() => void update({ historyOpen: false }), [update]);
  const signedIn = auth?.loggedIn === true && !snap.authRequired;

  const onSignedIn = useCallback(
    (s: AuthStatus) => {
      setAuth(s);
      store.clearAuthRequired();
      focusComposer();
    },
    [store, focusComposer],
  );

  let dock: React.ReactNode;
  if (auth && !auth.claudeInstalled) {
    dock = (
      <div className="px-3 pb-3">
        <NotInstalledCard onRecheck={() => void refreshAuth()} onRunDoctor={() => setDoctorOpen(true)} />
      </div>
    );
  } else if (auth && !signedIn) {
    dock = (
      <div className="px-3 pb-3">
        <SignInCard onSignedIn={onSignedIn} />
      </div>
    );
  } else {
    dock = (
      <Composer
        text={draft.text}
        attachments={draft.attachments}
        status={conv.status}
        textareaRef={textareaRef}
        onTextChange={(t) => store.setDraftText(t)}
        onAddAttachments={(a) => store.addAttachments(a)}
        onRemoveAttachment={(id) => store.removeAttachment(id)}
        onSend={sendDraft}
        onStop={() => void store.stop()}
      />
    );
  }

  const current = queue[0];

  return (
    <div
      className="relative flex h-full overflow-hidden bg-bg"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => void onDrop(e)}
      data-testid="panel"
    >
      <ResizeHandle initialWidth={settings.panelWidth} />
      <HistoryDrawer
        open={drawerOpen}
        overlay={overlay}
        recents={snap.recents}
        activeId={snap.activeId}
        now={now}
        onNewChat={() => {
          void newChat();
          if (overlay) closeDrawer();
        }}
        onSelect={(id) => {
          void store.select(id);
          if (overlay) closeDrawer();
        }}
        onDelete={(id) => void store.remove(id, settingsRef.current)}
        onClose={closeDrawer}
      />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <Header
          title={conv.messages.length ? conv.title : 'New chat'}
          drawerOpen={drawerOpen}
          settingsOpen={settingsOpen}
          settingsButtonRef={settingsBtnRef}
          onToggleDrawer={toggleDrawer}
          onNewChat={() => void newChat()}
          onToggleSettings={() => setSettingsOpen((o) => !o)}
          onHide={() => void api().panel.hide()}
        />
        {settingsOpen && (
          <SettingsPopover
            anchorRef={settingsBtnRef}
            onClose={() => setSettingsOpen(false)}
            onRunDoctor={() => setDoctorOpen(true)}
            onSignedOut={() => void refreshAuth()}
            signedIn={signedIn}
          />
        )}
        {conv.messages.length === 0 ? (
          <EmptyState
            onSuggest={(t) => {
              store.setDraftText(t);
              focusComposer();
            }}
          />
        ) : (
          <MessageList messages={conv.messages} status={conv.status} error={conv.error} conversationId={conv.id} />
        )}
        <div className="shrink-0">
          {current && (
            <ApprovalCard
              key={current.id}
              request={current}
              queued={queue.length - 1}
              onDecide={(d, message) => respond(current.id, d, message)}
            />
          )}
          {dock}
        </div>
      </div>
      {dragOver && (
        <div
          className="pointer-events-none absolute inset-2 z-50 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-accent/70 bg-bg/90 text-ink"
          data-testid="drop-overlay"
        >
          <Paperclip size={22} className="text-accent" aria-hidden />
          <span className="font-serif text-[18px]">Drop files to attach</span>
        </div>
      )}
      {doctorOpen && (
        <Sheet title="Setup check" onClose={() => setDoctorOpen(false)}>
          <DoctorList />
        </Sheet>
      )}
    </div>
  );
}

function ThemedRoot() {
  const { settings } = useSettings();
  useTheme(settings.theme);
  const route = useRoute();
  return route === 'onboarding' ? <Onboarding /> : <Panel />;
}

export function App() {
  return (
    <SettingsProvider>
      <ThemedRoot />
    </SettingsProvider>
  );
}
