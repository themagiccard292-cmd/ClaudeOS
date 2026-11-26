import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { Attachment, ConversationStatus } from '../../shared/protocol';
import { installMock, renderWithSettings } from '../test/utils';
import { Composer } from './Composer';

function Harness({ status = 'idle', onSend = vi.fn(), onStop = vi.fn() }: { status?: ConversationStatus; onSend?: () => void; onStop?: () => void }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([
    { id: '/gone.txt', path: '/gone.txt', name: 'gone.txt', kind: 'missing' },
  ]);
  return (
    <Composer
      text={text}
      attachments={attachments}
      status={status}
      onTextChange={setText}
      onAddAttachments={(a) => setAttachments((x) => [...x, ...a])}
      onRemoveAttachment={(id) => setAttachments((x) => x.filter((a) => a.id !== id))}
      onSend={onSend}
      onStop={onStop}
    />
  );
}

describe('Composer', () => {
  it('sends on Enter, inserts a newline on Shift+Enter and never sends while composing (IME)', async () => {
    installMock();
    const onSend = vi.fn();
    renderWithSettings(<Harness onSend={onSend} />);
    const box = screen.getByLabelText('Message Claude');
    await userEvent.type(box, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(box).toHaveValue('line one\nline two');
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.type(box, '{Enter}');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('disables send when empty and shows stop while a turn runs', async () => {
    installMock();
    const onStop = vi.fn();
    const { rerender } = renderWithSettings(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove gone.txt' }));
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    rerender(<Harness status="running" onStop={onStop} />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
  });

  it('adds files and folders from the + menu as pills; missing files are flagged', async () => {
    installMock();
    renderWithSettings(<Harness />);
    expect(screen.getByText('gone.txt')).toHaveClass('line-through');
    expect(screen.getByText('Not found')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add files or folders' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Add files/ }));
    expect(await screen.findByText('Quarterly report.pdf')).toBeInTheDocument();
    expect(screen.getByText('receipt.png')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add files or folders' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Add folder/ }));
    expect(await screen.findByText('garden-planner')).toBeInTheDocument();
    expect(screen.getAllByTestId('attachment-pill')).toHaveLength(4);
    await userEvent.click(screen.getByRole('button', { name: 'Remove receipt.png' }));
    expect(screen.getAllByTestId('attachment-pill')).toHaveLength(3);
  });

  it('model & effort popover persists through settings.set', async () => {
    const mock = installMock();
    renderWithSettings(<Harness />);
    const pill = await screen.findByRole('button', { name: /Model and effort: Opus 5.5 · Med/ });
    await userEvent.click(pill);
    const sonnet = screen.getByRole('radio', { name: /Sonnet 5.5/ });
    await userEvent.click(sonnet);
    await userEvent.click(screen.getByRole('radio', { name: 'Extra high' }));
    await waitFor(() => expect(mock.mock.settings).toMatchObject({ model: 'sonnet', effort: 'xhigh' }));
    expect(screen.getByRole('button', { name: /Sonnet 5.5 · XHigh/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Sonnet 5.5/ })).toHaveAttribute('aria-checked', 'true');
    // Escape closes the popover without bubbling to the panel.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Model and effort' })).not.toBeInTheDocument();
  });
});
