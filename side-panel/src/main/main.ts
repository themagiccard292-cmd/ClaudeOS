/**
 * Electron entry point of the ClaudeOS panel (`claudeos-panel-app`).
 *
 * Single instance through the C1 socket: if a live panel already listens, this process forwards its command line
 * (default `show`; nothing for `--background`) and exits. Otherwise it becomes the panel: windows, IPC and the socket.
 */
import { app } from 'electron';
import { join } from 'node:path';
import { parseLaunchArgs } from './core/argv';
import { createFileLogger } from './core/logger';
import { probeSocket, sendRequest, defaultSocketPath, SocketInUseError } from './core/panel-server';
import { defaultConfigDir } from './core/stores';
import { ClaudeOSApp } from './electron/app';

const env = process.env;

// ── Chromium switches: must be set before `ready` ──
// GNOME 50 is Wayland-only; XWayland lets the panel position itself, stay on top and publish struts (ARCHITECTURE §1.1).
app.commandLine.appendSwitch('ozone-platform', env.CLAUDEOS_OZONE || 'x11');
// WM_CLASS → matches StartupWMClass in claudeos-panel.desktop.
app.commandLine.appendSwitch('class', 'claudeos-panel');
// The Chromium sandbox stays on (SUID chrome-sandbox + AppArmor profile); opt-out only for debugging.
if (env.CLAUDEOS_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox');
app.setName('claudeos-panel');
app.setDesktopName('claudeos-panel.desktop');

const configDir = defaultConfigDir(env);
// Chromium profile data lives next to our own state (and follows CLAUDEOS_CONFIG_DIR in tests).
app.setPath('userData', join(configDir, 'electron'));

const log = createFileLogger({ echo: !app.isPackaged });
const socketPath = defaultSocketPath(env);
const launch = parseLaunchArgs(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd());

/** Hands our command line to the running instance and exits. */
async function forwardAndExit(): Promise<never> {
  let code = 0;
  if (launch.request || !launch.background) {
    try {
      const reply = await sendRequest(socketPath, launch.request ?? { cmd: 'show' });
      if (launch.request?.cmd === 'status') process.stdout.write(JSON.stringify(reply) + '\n');
      if (reply.ok !== true) code = 1;
    } catch (err) {
      process.stderr.write(`claudeos-panel: ${(err as Error).message}\n`);
      code = 1;
    }
  }
  app.exit(code);
  return process.exit(code);
}

async function main(): Promise<void> {
  if ((await probeSocket(socketPath)) === 'live') await forwardAndExit();

  await app.whenReady();
  log.info('app.start', { version: app.getVersion(), background: launch.background });
  const panelApp = new ClaudeOSApp({ log, configDir, socketPath, background: launch.background || launch.request !== null });
  await panelApp.init();
  try {
    await panelApp.server.start();
  } catch (err) {
    if (err instanceof SocketInUseError) {
      // Lost a start-up race against another instance.
      await panelApp.shutdown();
      await forwardAndExit();
    }
    log.error('socket.start-failed', { message: (err as Error).message });
  }

  // Commands from the first launch's own command line (e.g. `claudeos-panel-app attach -- /x`).
  if (launch.request) {
    const reply = await panelApp.server.handle(String(launch.request.cmd), launch.request);
    if (launch.request.cmd === 'status') process.stdout.write(JSON.stringify(reply) + '\n');
    if (launch.request.cmd === 'quit') app.quit();
  }

  // The panel keeps running with no visible window (it is hidden, not closed).
  app.on('window-all-closed', () => undefined);

  let cleanedUp = false;
  app.on('will-quit', (event) => {
    if (cleanedUp) return;
    event.preventDefault();
    void panelApp.shutdown().finally(() => {
      cleanedUp = true;
      app.quit();
    });
  });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => app.quit());
}

main().catch((err: unknown) => {
  log.error('app.fatal', { message: (err as Error).message });
  app.exit(1);
});
