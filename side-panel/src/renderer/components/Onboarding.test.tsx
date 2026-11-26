import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installMock, renderWithSettings } from '../test/utils';
import { Onboarding } from './Onboarding';

describe('Onboarding', () => {
  it('welcome → sign in → doctor → safety → done, then completes and hides', async () => {
    const mock = installMock({ mode: 'onboarding' });
    const complete = vi.spyOn(mock.system, 'completeOnboarding');
    const hide = vi.spyOn(mock.panel, 'hide');
    renderWithSettings(<Onboarding />);
    expect(screen.getByRole('heading', { name: 'Welcome to ClaudeOS' })).toBeInTheDocument();
    expect(screen.getByLabelText('Step 1 of 5: Welcome')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Get started' }));

    expect(screen.getByRole('heading', { name: 'Sign in with Claude' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Claude' }));
    await userEvent.type(await screen.findByLabelText('Authentication code'), 'CODE-42{Enter}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Skip for now' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByRole('heading', { name: 'Computer control' })).toBeInTheDocument();
    expect(await screen.findByText('Keyboard & mouse control')).toBeInTheDocument();
    expect(screen.getByText('2 items need attention.')).toBeInTheDocument();
    expect(screen.getByText(/sudo usermod -aG input/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Sign in with Claude' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByRole('heading', { name: 'You stay in control' })).toBeInTheDocument();
    expect(screen.getByText('Dangerous actions are blocked')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start using Claude' }));
    expect(complete).toHaveBeenCalled();
    await waitFor(() => expect(hide).toHaveBeenCalled());
  });

  it('lets the user skip sign-in', async () => {
    installMock({ mode: 'onboarding' });
    renderWithSettings(<Onboarding />);
    await userEvent.click(screen.getByRole('button', { name: 'Get started' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Skip for now' }));
    expect(screen.getByRole('heading', { name: 'Computer control' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/api key/i);
  });
});
