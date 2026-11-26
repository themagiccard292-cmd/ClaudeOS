/**
 * Friendly labels for tool calls shown in the transcript ("Running command…" → "Ran command").
 * Covers Claude Code's built-in tools and the `claudeos-desktop` MCP tools (docs/ARCHITECTURE.md C4).
 * Pure data + functions so it is unit-tested; the React side maps `icon` keys to lucide icons.
 */

export type ToolIconKey =
  | 'terminal'
  | 'mouse'
  | 'keyboard'
  | 'camera'
  | 'monitor'
  | 'app'
  | 'globe'
  | 'window'
  | 'clipboard'
  | 'file-read'
  | 'file-edit'
  | 'folder'
  | 'search'
  | 'trash'
  | 'move'
  | 'settings'
  | 'bell'
  | 'timer'
  | 'list'
  | 'agent'
  | 'shield'
  | 'tool';

interface ToolSpec {
  running: string;
  done: string;
  icon: ToolIconKey;
  /** Produce the one-line summary of the input; return undefined to use the generic fallback. */
  summary?: (input: Record<string, unknown>) => string | undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const pathOf = (i: Record<string, unknown>) => str(i.file_path) ?? str(i.path) ?? str(i.notebook_path);
const commandOf = (i: Record<string, unknown>) => str(i.command);
const coords = (x: unknown, y: unknown) => {
  const nx = num(x);
  const ny = num(y);
  return nx !== undefined && ny !== undefined ? `(${nx}, ${ny})` : undefined;
};

const SPECS: Record<string, ToolSpec> = {
  // Shell
  bash: { running: 'Running command…', done: 'Ran command', icon: 'terminal', summary: commandOf },
  run_command: { running: 'Running command…', done: 'Ran command', icon: 'terminal', summary: commandOf },
  bashoutput: { running: 'Reading output…', done: 'Read output', icon: 'terminal' },
  killshell: { running: 'Stopping command…', done: 'Stopped command', icon: 'terminal' },

  // Screen & input (computer control)
  screenshot: {
    running: 'Taking a screenshot…',
    done: 'Took a screenshot',
    icon: 'camera',
    summary: (i) => (i.region ? 'Region of the screen' : 'Whole screen'),
  },
  screen_info: { running: 'Checking the screen…', done: 'Checked the screen', icon: 'monitor' },
  mouse_click: {
    running: 'Clicking…',
    done: 'Clicked',
    icon: 'mouse',
    summary: (i) => {
      const at = coords(i.x, i.y) ?? 'at the pointer';
      const button = str(i.button) && i.button !== 'left' ? `${String(i.button)} ` : '';
      const clicks = num(i.clicks);
      const times = clicks && clicks > 1 ? (clicks === 2 ? ' · double' : ` · ×${clicks}`) : '';
      return `${button ? `${button}click ` : ''}${at}${times}`;
    },
  },
  mouse_move: { running: 'Moving the pointer…', done: 'Moved the pointer', icon: 'mouse', summary: (i) => coords(i.x, i.y) },
  mouse_drag: {
    running: 'Dragging…',
    done: 'Dragged',
    icon: 'mouse',
    summary: (i) => {
      const from = coords(i.from_x, i.from_y);
      const to = coords(i.to_x, i.to_y);
      return from && to ? `${from} → ${to}` : undefined;
    },
  },
  scroll: {
    running: 'Scrolling…',
    done: 'Scrolled',
    icon: 'mouse',
    summary: (i) => {
      const dy = num(i.dy) ?? 0;
      const dx = num(i.dx) ?? 0;
      if (dy) return dy > 0 ? `Down ${dy}` : `Up ${-dy}`;
      if (dx) return dx > 0 ? `Right ${dx}` : `Left ${-dx}`;
      return undefined;
    },
  },
  type_text: { running: 'Typing…', done: 'Typed', icon: 'keyboard', summary: (i) => (str(i.text) ? `“${String(i.text)}”` : undefined) },
  key_press: { running: 'Pressing keys…', done: 'Pressed keys', icon: 'keyboard', summary: (i) => str(i.keys) },
  wait: { running: 'Waiting…', done: 'Waited', icon: 'timer', summary: (i) => (num(i.seconds) !== undefined ? `${String(i.seconds)} s` : undefined) },

  // Windows & apps
  list_windows: { running: 'Listing windows…', done: 'Listed windows', icon: 'window' },
  focus_window: { running: 'Switching window…', done: 'Switched window', icon: 'window', summary: (i) => str(i.id_or_title) },
  open_app: { running: 'Opening app…', done: 'Opened app', icon: 'app', summary: (i) => str(i.name) },
  open_url: { running: 'Opening link…', done: 'Opened link', icon: 'globe', summary: (i) => str(i.url) },

  // Clipboard
  clipboard_read: { running: 'Reading the clipboard…', done: 'Read the clipboard', icon: 'clipboard' },
  clipboard_write: { running: 'Copying to the clipboard…', done: 'Copied to the clipboard', icon: 'clipboard' },

  // Files (Claude Code built-ins and MCP equivalents)
  read: { running: 'Reading file…', done: 'Read file', icon: 'file-read', summary: pathOf },
  read_file: { running: 'Reading file…', done: 'Read file', icon: 'file-read', summary: pathOf },
  write: { running: 'Writing file…', done: 'Wrote file', icon: 'file-edit', summary: pathOf },
  write_file: { running: 'Writing file…', done: 'Wrote file', icon: 'file-edit', summary: pathOf },
  edit: { running: 'Editing file…', done: 'Edited file', icon: 'file-edit', summary: pathOf },
  multiedit: { running: 'Editing file…', done: 'Edited file', icon: 'file-edit', summary: pathOf },
  notebookedit: { running: 'Editing notebook…', done: 'Edited notebook', icon: 'file-edit', summary: pathOf },
  glob: { running: 'Finding files…', done: 'Found files', icon: 'search', summary: (i) => str(i.pattern) },
  grep: { running: 'Searching files…', done: 'Searched files', icon: 'search', summary: (i) => str(i.pattern) },
  search_files: {
    running: 'Searching files…',
    done: 'Searched files',
    icon: 'search',
    summary: (i) => str(i.query) ?? str(i.pattern) ?? str(i.name),
  },
  ls: { running: 'Listing folder…', done: 'Listed folder', icon: 'folder', summary: pathOf },
  list_dir: { running: 'Listing folder…', done: 'Listed folder', icon: 'folder', summary: pathOf },
  move_path: {
    running: 'Moving…',
    done: 'Moved',
    icon: 'move',
    summary: (i) => {
      const src = str(i.src) ?? str(i.source) ?? str(i.from);
      const dst = str(i.dst) ?? str(i.destination) ?? str(i.to);
      return src && dst ? `${src} → ${dst}` : (src ?? dst);
    },
  },
  delete_path: {
    running: 'Moving to Trash…',
    done: 'Moved to Trash',
    icon: 'trash',
    summary: pathOf,
  },

  // Web
  webfetch: { running: 'Fetching page…', done: 'Fetched page', icon: 'globe', summary: (i) => str(i.url) },
  websearch: { running: 'Searching the web…', done: 'Searched the web', icon: 'globe', summary: (i) => str(i.query) },

  // System
  system_info: { running: 'Checking the system…', done: 'Checked the system', icon: 'monitor' },
  notify: { running: 'Sending notification…', done: 'Sent notification', icon: 'bell', summary: (i) => str(i.title) },
  gsettings: {
    running: 'Changing a setting…',
    done: 'Changed a setting',
    icon: 'settings',
    summary: (i) => [str(i.schema), str(i.key)].filter(Boolean).join(' ') || undefined,
  },
  systemd: {
    running: 'Managing a service…',
    done: 'Managed a service',
    icon: 'settings',
    summary: (i) => [str(i.action), str(i.unit)].filter(Boolean).join(' ') || undefined,
  },
  dbus_call: { running: 'Calling D-Bus…', done: 'Called D-Bus', icon: 'settings', summary: (i) => str(i.method) },
  request_permission: { running: 'Asking permission…', done: 'Asked permission', icon: 'shield', summary: (i) => str(i.tool_name) },

  // Planning / agents
  todowrite: { running: 'Updating the plan…', done: 'Updated the plan', icon: 'list' },
  task: { running: 'Running an agent…', done: 'Ran an agent', icon: 'agent', summary: (i) => str(i.description) },
  agent: { running: 'Running an agent…', done: 'Ran an agent', icon: 'agent', summary: (i) => str(i.description) },
};

/** "mcp__claudeos-desktop__run_command" → "run_command"; "Bash" stays "Bash". */
export function baseToolName(name: string): string {
  const m = /^mcp__.+?__(.+)$/.exec(name);
  return m?.[1] ?? name;
}

/** "searchFiles" / "search_files" / "search-files" → "Search files". */
export function humanizeToolName(name: string): string {
  const words = baseToolName(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Tool';
}

function specFor(name: string): ToolSpec | undefined {
  return SPECS[baseToolName(name).toLowerCase()];
}

export type ToolStatus = 'running' | 'done' | 'error';

/** Present tense while running, past tense when finished (also for errors: the status icon carries the failure). */
export function toolLabel(name: string, status: ToolStatus): string {
  const spec = specFor(name);
  if (spec) return status === 'running' ? spec.running : spec.done;
  const human = humanizeToolName(name);
  return status === 'running' ? `Using ${human}…` : `Used ${human}`;
}

export function toolIcon(name: string): ToolIconKey {
  return specFor(name)?.icon ?? 'tool';
}

/** One-line summary of a tool input (command, coordinates, path …), max `max` chars, single line. */
export function toolSummary(name: string, input: unknown, max = 120): string {
  const rec = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  let text = specFor(name)?.summary?.(rec);
  if (!text) {
    // Generic fallback: first non-empty string value, else nothing.
    text = Object.values(rec).find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  }
  if (!text) return '';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
