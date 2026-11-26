import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApprovalRequest } from '../../shared/protocol';
import { installMock } from '../test/utils';
import { ApprovalCard, useApprovals } from './ApprovalCard';

function Harness() {
  const { queue, respond } = useApprovals();
  const current = queue[0];
  return current ? (
    <ApprovalCard key={current.id} request={current} queued={queue.length - 1} onDecide={(d, m) => respond(current.id, d, m)} />
  ) : (
    <p>no approvals</p>
  );
}

const req = (id: string, risk: ApprovalRequest['risk'] = 'high', timeoutMs = 120_000): ApprovalRequest => ({
  id,
  tool: 'mcp__claudeos-desktop__run_command',
  input: { command: `sudo thing ${id}` },
  summary: `Run: sudo thing ${id}`,
  risk,
  reason: 'Uses sudo.',
  source: 'mcp',
  timeoutMs,
});

describe('ApprovalCard', () => {
  it('queues requests and answers allow / deny in order', async () => {
    const mock = installMock();
    render(<Harness />);
    act(() => {
      mock.mock.emitCommand({ type: 'approval-request', request: req('a') });
      mock.mock.emitCommand({ type: 'approval-request', request: req('b', 'medium') });
    });
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Run: sudo thing a');
    expect(screen.getByText('$ sudo thing a')).toBeInTheDocument();
    expect(screen.getByText('+1 waiting')).toBeInTheDocument();
    expect(screen.getByText('High risk')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Run: sudo thing b');
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(screen.getByText('no approvals')).toBeInTheDocument();
    expect(mock.mock.decisions).toEqual([
      { id: 'a', decision: 'allow', message: undefined },
      { id: 'b', decision: 'deny', message: undefined },
    ]);
  });

  it('Escape denies; the card takes focus instead of Allow', async () => {
    const mock = installMock();
    render(<Harness />);
    act(() => mock.mock.emitCommand({ type: 'approval-request', request: req('x') }));
    expect(screen.getByRole('alertdialog')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(mock.mock.decisions).toEqual([{ id: 'x', decision: 'deny', message: undefined }]);
  });

  it('critical risk requires the "I understand" checkbox', async () => {
    const mock = installMock();
    render(<Harness />);
    act(() => mock.mock.emitCommand({ type: 'approval-request', request: req('c', 'critical') }));
    const allow = screen.getByRole('button', { name: 'Allow once' });
    expect(allow).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /I understand/ }));
    expect(allow).toBeEnabled();
    await userEvent.click(allow);
    expect(mock.mock.decisions[0]).toMatchObject({ id: 'c', decision: 'allow' });
  });

  it('times out to deny and is dismissed by approval-cancelled', () => {
    vi.useFakeTimers();
    const mock = installMock();
    render(<Harness />);
    act(() => mock.mock.emitCommand({ type: 'approval-request', request: req('t', 'medium', 2000) }));
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('1s')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1500));
    expect(mock.mock.decisions).toEqual([{ id: 't', decision: 'deny', message: 'Timed out waiting for confirmation.' }]);
    act(() => mock.mock.emitCommand({ type: 'approval-request', request: req('z') }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    act(() => mock.mock.emitCommand({ type: 'approval-cancelled', id: 'z' }));
    expect(screen.getByText('no approvals')).toBeInTheDocument();
    expect(mock.mock.decisions).toHaveLength(1);
  });
});
