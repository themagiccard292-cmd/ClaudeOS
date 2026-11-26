/**
 * Command line of the Electron app itself (`claudeos-panel-app [command] [args] [--background]`).
 *
 * The launcher (C2) normally sends commands over the socket, but the app accepts the same grammar so that a direct
 * launch (or a second instance) behaves identically: the parsed request is either executed locally on first launch or
 * forwarded to the running instance. Chromium switches (`--ozone-platform=x11`, `--enable-features=…`) are ignored.
 */
import { isAbsolute, resolve } from 'node:path';

export const COMMANDS = ['toggle', 'show', 'hide', 'new-chat', 'attach', 'ask', 'onboarding', 'status', 'quit'] as const;
export type CommandName = (typeof COMMANDS)[number];

export interface LaunchArgs {
  /** Start hidden; do nothing when an instance already runs. */
  background: boolean;
  /** C1 request to run, or null when no command was given. */
  request: Record<string, unknown> | null;
}

const toAbs = (p: string, cwd: string): string => (isAbsolute(p) ? p : resolve(cwd, p));

export function parseLaunchArgs(args: readonly string[], cwd: string): LaunchArgs {
  let background = false;
  let send = false;
  let command: CommandName | null = null;
  const positional: string[] = [];
  const paths: string[] = [];
  let endOfOptions = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!endOfOptions && a === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && a.startsWith('-')) {
      if (a === '--background') background = true;
      else if (a === '--send') send = true;
      else if (a === '--path' && i + 1 < args.length) paths.push(args[++i]!);
      else if (a.startsWith('--path=')) paths.push(a.slice('--path='.length));
      // anything else is a Chromium/Electron switch (or --no-spawn): ignored
      continue;
    }
    if (!command && !endOfOptions && (COMMANDS as readonly string[]).includes(a)) {
      command = a as CommandName;
      continue;
    }
    positional.push(a);
  }

  if (!command) return { background, request: null };
  switch (command) {
    case 'attach':
      return { background, request: { cmd: 'attach', paths: [...positional, ...paths].map((p) => toAbs(p, cwd)) } };
    case 'ask':
      return {
        background,
        request: { cmd: 'ask', text: positional.join(' '), send, paths: paths.map((p) => toAbs(p, cwd)) },
      };
    default:
      return { background, request: { cmd: command } };
  }
}
