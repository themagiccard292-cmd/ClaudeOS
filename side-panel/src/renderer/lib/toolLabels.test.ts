import { baseToolName, humanizeToolName, toolIcon, toolLabel, toolSummary } from './toolLabels';

describe('toolLabels', () => {
  it('strips the MCP server prefix', () => {
    expect(baseToolName('mcp__claudeos-desktop__run_command')).toBe('run_command');
    expect(baseToolName('mcp__my_server__do_it')).toBe('do_it');
    expect(baseToolName('Bash')).toBe('Bash');
  });

  it.each([
    ['Bash', 'Running command…', 'Ran command'],
    ['mcp__claudeos-desktop__run_command', 'Running command…', 'Ran command'],
    ['mcp__claudeos-desktop__mouse_click', 'Clicking…', 'Clicked'],
    ['mcp__claudeos-desktop__type_text', 'Typing…', 'Typed'],
    ['mcp__claudeos-desktop__key_press', 'Pressing keys…', 'Pressed keys'],
    ['mcp__claudeos-desktop__screenshot', 'Taking a screenshot…', 'Took a screenshot'],
    ['mcp__claudeos-desktop__open_app', 'Opening app…', 'Opened app'],
    ['Read', 'Reading file…', 'Read file'],
    ['Edit', 'Editing file…', 'Edited file'],
    ['Write', 'Writing file…', 'Wrote file'],
    ['Glob', 'Finding files…', 'Found files'],
    ['Grep', 'Searching files…', 'Searched files'],
    ['WebFetch', 'Fetching page…', 'Fetched page'],
    ['WebSearch', 'Searching the web…', 'Searched the web'],
  ])('%s → present while running, past when done', (name, running, done) => {
    expect(toolLabel(name, 'running')).toBe(running);
    expect(toolLabel(name, 'done')).toBe(done);
    expect(toolLabel(name, 'error')).toBe(done);
  });

  it('humanises unknown tools', () => {
    expect(humanizeToolName('mcp__x__frobnicateWidgets')).toBe('Frobnicate widgets');
    expect(toolLabel('mcp__x__resize_photo', 'running')).toBe('Using Resize photo…');
    expect(toolLabel('mcp__x__resize_photo', 'done')).toBe('Used Resize photo');
    expect(toolIcon('mcp__x__resize_photo')).toBe('tool');
  });

  it('summarises inputs on one line', () => {
    expect(toolSummary('Bash', { command: 'ls -la\n  ~/Downloads' })).toBe('ls -la ~/Downloads');
    expect(toolSummary('mcp__claudeos-desktop__mouse_click', { x: 10, y: 20 })).toBe('(10, 20)');
    expect(toolSummary('mcp__claudeos-desktop__mouse_click', { x: 10, y: 20, button: 'right', clicks: 2 })).toBe('right click (10, 20) · double');
    expect(toolSummary('mcp__claudeos-desktop__mouse_drag', { from_x: 1, from_y: 2, to_x: 3, to_y: 4 })).toBe('(1, 2) → (3, 4)');
    expect(toolSummary('Read', { file_path: '/etc/hosts' })).toBe('/etc/hosts');
    expect(toolSummary('mcp__claudeos-desktop__key_press', { keys: 'ctrl+alt+t' })).toBe('ctrl+alt+t');
    expect(toolSummary('mcp__claudeos-desktop__scroll', { dy: -3 })).toBe('Up 3');
    expect(toolSummary('Mystery', { foo: 1, bar: 'fallback text' })).toBe('fallback text');
    expect(toolSummary('Mystery', null)).toBe('');
    expect(toolSummary('Bash', { command: 'x'.repeat(300) }, 20)).toHaveLength(20);
  });
});
