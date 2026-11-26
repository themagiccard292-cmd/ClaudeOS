import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installMock } from '../test/utils';
import { NotInstalledCard, SignInCard, reduceLogin } from './AuthCards';

describe('SignInCard', () => {
  it('walks started → url → need-code → success with the subscription login', async () => {
    const mock = installMock({ mode: 'signedout' });
    const login = vi.spyOn(mock.auth, 'login');
    const open = vi.spyOn(mock.system, 'openExternal');
    const onSignedIn = vi.fn();
    render(<SignInCard onSignedIn={onSignedIn} />);
    expect(screen.getByText(/Claude Pro or Max subscription/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/api key/i);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }));
    expect(login).toHaveBeenCalled();
    expect(await screen.findByText(/claude\.ai\/oauth\/authorize/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Open again/ }));
    expect(open).toHaveBeenCalledWith(expect.stringContaining('https://claude.ai/oauth'));
    const field = await screen.findByLabelText('Authentication code');
    await userEvent.type(field, 'ABCD-1234{Enter}');
    expect(await screen.findByText('You’re signed in')).toBeInTheDocument();
    expect(onSignedIn).toHaveBeenCalledWith(expect.objectContaining({ loggedIn: true }));
  });

  it('shows failures with retry, supports cancel and the terminal fallback', async () => {
    const mock = installMock({ mode: 'signedout' });
    const cancel = vi.spyOn(mock.auth, 'cancelLogin');
    render(<SignInCard onSignedIn={vi.fn()} />);
    act(() => mock.mock.emitLogin({ type: 'started' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Sign in with Claude' })).toBeInTheDocument();
    act(() => mock.mock.emitLogin({ type: 'failed', message: 'Browser closed' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Browser closed');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    act(() => mock.mock.emitLogin({ type: 'fallback-terminal' }));
    expect(screen.getByText(/terminal window opened/)).toBeInTheDocument();
    mock.mock.setAuth({ loggedIn: true });
    await userEvent.click(screen.getByRole('button', { name: 'I’ve signed in' }));
    expect(await screen.findByText('You’re signed in')).toBeInTheDocument();
  });

  it('reduceLogin keeps the URL when the code prompt arrives', () => {
    const withUrl = reduceLogin({ step: 'starting' }, { type: 'url', url: 'https://x' });
    expect(reduceLogin(withUrl, { type: 'need-code' })).toEqual({ step: 'browser', url: 'https://x', needCode: true });
  });

  it('unsubscribes from login events on unmount', () => {
    const mock = installMock();
    const { unmount } = render(<SignInCard onSignedIn={vi.fn()} />);
    expect(mock.mock.listenerCounts().login).toBe(1);
    unmount();
    expect(mock.mock.listenerCounts().login).toBe(0);
  });
});

describe('NotInstalledCard', () => {
  it('offers a setup check and re-check', async () => {
    const onRecheck = vi.fn();
    const onRunDoctor = vi.fn();
    render(<NotInstalledCard onRecheck={onRecheck} onRunDoctor={onRunDoctor} />);
    expect(screen.getByText('Claude Code isn’t installed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run setup check' }));
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onRunDoctor).toHaveBeenCalled();
    expect(onRecheck).toHaveBeenCalled();
  });
});
