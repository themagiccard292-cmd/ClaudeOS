import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { GREETING } from './components/EmptyState';
import { installMock } from './test/utils';

describe('App (panel)', () => {
  it('shows the greeting, fills the composer from a suggestion and streams a full answer', async () => {
    const mock = installMock({ tickMs: 8 });
    render(<App />);
    expect(await screen.findByText(GREETING)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'What’s using my disk space?' }));
    const box = screen.getByLabelText('Message Claude');
    expect(box).toHaveValue('What’s using my disk space?');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(await screen.findByText(/Want me to move the old recordings/, {}, { timeout: 4000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 1, name: 'What’s using my disk space?' })).toBeInTheDocument();
    expect(screen.getByText('Took a screenshot')).toBeInTheDocument();
    expect(screen.getByTestId('code-card')).toBeInTheDocument();
    await waitFor(() => expect(mock.mock.saved).toHaveLength(1));
    expect(box).toHaveValue('');
  });

  it('Escape stops a running turn, otherwise hides the panel', async () => {
    const mock = installMock({ tickMs: 8 });
    const stop = vi.spyOn(mock.chat, 'stop');
    const hide = vi.spyOn(mock.panel, 'hide');
    render(<App />);
    await userEvent.type(await screen.findByLabelText('Message Claude'), 'hi{Enter}');
    await screen.findByRole('button', { name: 'Stop' });
    await userEvent.keyboard('{Escape}');
    expect(stop).toHaveBeenCalled();
    await screen.findByRole('button', { name: 'Send message' }, { timeout: 4000 });
    await userEvent.keyboard('{Escape}');
    expect(hide).toHaveBeenCalled();
  });

  it('history drawer: persisted open state, select, delete with confirm, new chat', async () => {
    const mock = installMock();
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Show history' }));
    await waitFor(() => expect(mock.mock.settings.historyOpen).toBe(true));
    const nav = screen.getByRole('navigation', { name: 'Conversation history' });
    await userEvent.click(within(nav).getByText('Set up the office printer'));
    expect(await screen.findByText('Your HP LaserJet is now the default printer.')).toBeInTheDocument();
    // jsdom's window is 1024 px wide → push mode, drawer stays open
    expect(within(nav).getByText('Set up the office printer').closest('button')).toHaveAttribute('aria-current', 'page');

    await userEvent.click(within(nav).getByRole('button', { name: 'Delete Why does my Wi-Fi keep dropping?' }));
    await userEvent.click(within(nav).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(within(nav).getByRole('button', { name: 'Delete Why does my Wi-Fi keep dropping?' }));
    await userEvent.click(within(nav).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(within(nav).queryByText('Why does my Wi-Fi keep dropping?')).not.toBeInTheDocument());

    await userEvent.click(within(nav).getByRole('button', { name: 'New chat' }));
    expect(await screen.findByText(GREETING)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hide history' }));
    await waitFor(() => expect(mock.mock.settings.historyOpen).toBe(false));
  });

  it('overlays the drawer on narrow panels and closes it on Escape', async () => {
    const mock = installMock();
    await mock.settings.set({ historyOpen: true });
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    render(<App />);
    expect(await screen.findByTestId('drawer-scrim')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(mock.mock.settings.historyOpen).toBe(false));
    Object.defineProperty(window, 'innerWidth', { value: original, configurable: true });
  });

  it('drag-and-drop files shows an overlay and adds pills', async () => {
    const mock = installMock();
    const describe = vi.spyOn(mock.files, 'describe');
    render(<App />);
    const panel = await screen.findByTestId('panel');
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: 'none' };
    fireEvent.dragEnter(panel, { dataTransfer });
    expect(screen.getByTestId('drop-overlay')).toHaveTextContent('Drop files to attach');
    fireEvent.dragOver(panel, { dataTransfer });
    fireEvent.drop(panel, { dataTransfer });
    expect(screen.queryByTestId('drop-overlay')).not.toBeInTheDocument();
    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    expect(describe).toHaveBeenCalledWith(['/home/you/Downloads/notes.txt']);
  });

  it('handles attach / ask / new-chat / show-onboarding panel commands', async () => {
    const mock = installMock();
    render(<App />);
    await screen.findByText(GREETING);
    act(() =>
      mock.mock.emitCommand({
        type: 'attach',
        newChat: false,
        attachments: [{ id: '/home/you/a.pdf', path: '/home/you/a.pdf', name: 'a.pdf', kind: 'file', sizeBytes: 10 }],
      }),
    );
    expect(await screen.findByText('a.pdf')).toBeInTheDocument();
    act(() => mock.mock.emitCommand({ type: 'ask', text: 'Summarise this', send: true, attachments: [] }));
    await waitFor(() => expect(mock.mock.sent).toHaveLength(1));
    expect(mock.mock.sent[0]).toMatchObject({ text: 'Summarise this', attachments: [expect.objectContaining({ name: 'a.pdf' })] });
    await screen.findByRole('button', { name: 'Send message' }, { timeout: 4000 });
    act(() => mock.mock.emitCommand({ type: 'new-chat' }));
    expect(await screen.findByText(GREETING)).toBeInTheDocument();
    act(() => mock.mock.emitCommand({ type: 'show-onboarding' }));
    expect(await screen.findByRole('heading', { name: 'Welcome to ClaudeOS' })).toBeInTheDocument();
  });

  it('shows sign-in instead of the composer when signed out or when auth-required arrives', async () => {
    const mock = installMock();
    render(<App />);
    const box = await screen.findByLabelText('Message Claude');
    mock.mock.setAuth({ loggedIn: false });
    await userEvent.type(box, 'hello{Enter}');
    expect(await screen.findByTestId('signin-card')).toBeInTheDocument();
    expect(screen.queryByLabelText('Message Claude')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }));
    await userEvent.type(await screen.findByLabelText('Authentication code'), 'GOOD-CODE{Enter}');
    expect(await screen.findByLabelText('Message Claude')).toBeInTheDocument();
  });

  it('shows the not-installed card and the setup check', async () => {
    installMock({ mode: 'notinstalled' });
    render(<App />);
    expect(await screen.findByTestId('not-installed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run setup check' }));
    expect(await screen.findByRole('dialog', { name: 'Setup check' })).toBeInTheDocument();
    expect(await screen.findByText('Super+C shortcut')).toBeInTheDocument();
  });

  it('settings popover changes permission mode, dock mode and signs out', async () => {
    const mock = installMock();
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /Plan mode/ }));
    await userEvent.click(within(dialog).getByRole('switch'));
    await waitFor(() => expect(mock.mock.settings).toMatchObject({ permissionMode: 'plan', reserveSpace: false }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByTestId('signin-card')).toBeInTheDocument();
  });
});

describe('theme', () => {
  it('follows getColorScheme/onColorScheme and honours the override', async () => {
    const mock = installMock();
    mock.mock.setColorScheme('dark');
    render(<App />);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    act(() => mock.mock.setColorScheme('light'));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    act(() => mock.mock.setColorScheme('light'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    await userEvent.click(screen.getByRole('radio', { name: 'System' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
  });
});

describe('cleanup', () => {
  it('every subscription is released on unmount', async () => {
    const mock = installMock();
    const { unmount } = render(<App />);
    await screen.findByText(GREETING);
    expect(mock.mock.listenerCounts().chat).toBeGreaterThan(0);
    unmount();
    expect(Object.values(mock.mock.listenerCounts()).every((n) => n === 0)).toBe(true);
  });

  it('onboarding route also unsubscribes everything', async () => {
    window.location.hash = '#onboarding';
    const mock = installMock({ mode: 'onboarding' });
    const { unmount } = render(<App />);
    expect(await screen.findByTestId('onboarding')).toBeInTheDocument();
    unmount();
    expect(Object.values(mock.mock.listenerCounts()).every((n) => n === 0)).toBe(true);
  });
});
