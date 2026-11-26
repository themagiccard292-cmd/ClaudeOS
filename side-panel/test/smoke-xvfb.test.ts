/**
 * Optional smoke test: boots the packaged Electron app under Xvfb, asks it for `status` over the C1 socket through
 * the real launcher, then quits it. Skipped when xvfb-run or the packaged app is missing (CI-less sandboxes).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const app = join(root, 'dist-package/claudeos-panel-app-linux-x64/claudeos-panel-app');
const launcher = join(root, 'launcher/claudeos-panel');
const haveXvfb = spawnSync('which', ['xvfb-run']).status === 0;

describe.skipIf(!haveXvfb || !existsSync(app))('xvfb smoke', () => {
  it('starts, answers status and quits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claudeos-smoke-'));
    const env = {
      ...process.env,
      CLAUDEOS_PANEL_SOCKET: join(dir, 's.sock'),
      CLAUDEOS_CONFIG_DIR: join(dir, 'cfg'),
      CLAUDEOS_PANEL_APP: app,
      CLAUDEOS_NO_SANDBOX: '1',
      CLAUDEOS_OZONE: 'x11',
      HOME: dir,
    };
    // --no-sandbox on the command line: Chromium refuses to run as root (CI containers) without it.
    const script = `"$APP" --no-sandbox --ozone-platform=x11 --background >"$HOME/app.log" 2>&1 & pid=$!
rc=1; for _ in $(seq 100); do "$LAUNCHER" status --no-spawn >"$HOME/status.json" 2>/dev/null && rc=0 && break; sleep 0.3; done
"$LAUNCHER" quit --no-spawn >/dev/null 2>&1; sleep 1; kill $pid 2>/dev/null; exit $rc`;
    const child = spawn('xvfb-run', ['-a', 'bash', '-c', script], {
      env: { ...env, APP: app, LAUNCHER: launcher },
      stdio: 'ignore',
    });
    const code = await new Promise<number | null>((res) => child.on('exit', res));
    try {
      expect(code, readFileSync(join(dir, 'app.log'), 'utf8')).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'))).toMatchObject({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
