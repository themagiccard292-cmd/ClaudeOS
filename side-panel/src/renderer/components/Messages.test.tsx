import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StoredMessage } from '../../shared/protocol';
import { installMock } from '../test/utils';
import { AssistantMessage, MessageList, UserMessage } from './Messages';
import { OUTPUT_LIMIT } from './ToolCalls';

const md = `## Heading

Some **bold** text and \`inline\` code with a [link](https://example.com).

| A | B |
|---|---|
| 1 | 2 |

\`\`\`python
print("hi")
\`\`\``;

const assistant: StoredMessage = {
  id: 'a1',
  role: 'assistant',
  createdAt: 0,
  blocks: [
    { kind: 'thinking', text: 'secret reasoning' },
    { kind: 'text', text: md },
    { kind: 'tool', toolUseId: 't1', name: 'mcp__claudeos-desktop__run_command', input: { command: 'ls ~' }, output: 'x'.repeat(OUTPUT_LIMIT + 50), status: 'done' },
    { kind: 'tool', toolUseId: 't2', name: 'mcp__claudeos-desktop__screenshot', input: {}, output: 'ok', imageDataUrl: 'data:image/png;base64,AA', status: 'done' },
    { kind: 'tool', toolUseId: 't3', name: 'mcp__claudeos-desktop__mouse_click', input: { x: 1, y: 2 }, status: 'running' },
  ],
};

describe('messages', () => {
  it('renders markdown: headings, tables, inline code; links open externally', async () => {
    const mock = installMock();
    const open = vi.spyOn(mock.system, 'openExternal');
    render(<AssistantMessage message={assistant} streaming={false} />);
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('inline').tagName).toBe('CODE');
    await userEvent.click(screen.getByRole('link', { name: 'link' }));
    expect(open).toHaveBeenCalledWith('https://example.com');
  });

  it('renders code blocks as cards with language, highlighting and a Copy button', async () => {
    installMock();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<AssistantMessage message={assistant} streaming={false} />);
    const card = screen.getByTestId('code-card');
    expect(within(card).getByText('python')).toBeInTheDocument();
    expect(card.querySelector('.hljs-built_in, .hljs-string')).not.toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('print("hi")');
    expect(await within(card).findByText('Copied')).toBeInTheDocument();
  });

  it('keeps thinking collapsed by default', async () => {
    installMock();
    render(<AssistantMessage message={assistant} streaming={false} />);
    expect(screen.queryByText('secret reasoning')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Thought process' }));
    expect(screen.getByText('secret reasoning')).toBeInTheDocument();
  });

  it('groups tool calls; rows expand/collapse, truncate long output and enlarge screenshots', async () => {
    installMock();
    render(<AssistantMessage message={assistant} streaming />);
    expect(screen.getAllByTestId('tool-group')).toHaveLength(1);
    const rows = screen.getAllByTestId('tool-row');
    expect(rows.map((r) => r.dataset.status)).toEqual(['done', 'done', 'running']);
    expect(screen.getByText('Clicking…')).toBeInTheDocument();
    const ran = screen.getByRole('button', { name: /Ran command/ });
    expect(ran).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(ran);
    expect(ran).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Input')).toHaveTextContent('$ ls ~');
    expect(screen.getByLabelText('Output').textContent!.length).toBe(OUTPUT_LIMIT + 1);
    await userEvent.click(screen.getByRole('button', { name: /Show more/ }));
    expect(screen.getByLabelText('Output').textContent!.length).toBe(OUTPUT_LIMIT + 50);
    await userEvent.click(ran);
    expect(screen.queryByLabelText('Input')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Took a screenshot/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Enlarge screenshot' }));
    expect(screen.getByRole('dialog', { name: 'Screenshot' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows user bubbles with attachment pills, a working indicator and errors', () => {
    installMock();
    const user: StoredMessage = {
      id: 'u1',
      role: 'user',
      createdAt: 0,
      blocks: [{ kind: 'text', text: 'Look at this' }],
      attachments: [{ id: '/a.pdf', path: '/a.pdf', name: 'a.pdf', kind: 'file', sizeBytes: 2048 }],
    };
    render(<UserMessage message={user} />);
    expect(screen.getByText('Look at this')).toBeInTheDocument();
    expect(screen.getByText('a.pdf')).toBeInTheDocument();
    const { rerender } = render(<MessageList messages={[user]} status="running" conversationId="c" />);
    expect(screen.getByText('Claude is working')).toBeInTheDocument();
    rerender(<MessageList messages={[user]} status="idle" error="Something broke" conversationId="c" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something broke');
  });
});
