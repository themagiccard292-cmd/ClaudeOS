#!/usr/bin/env node
/**
 * Visual verification: builds the renderer, serves dist/renderer on a free local port (the in-memory mock API is
 * used automatically because there is no Electron preload) and captures the key screens with Playwright/Chromium
 * into docs/screenshots/. Usage: node scripts/screenshots.mjs [--no-build] [--only name,name]
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = join(pkgRoot, 'dist/renderer');
const outDir = resolve(pkgRoot, '../docs/screenshots');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

/** Playwright is installed globally in the dev image, not as a package dependency. */
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return createRequire(join(globalRoot, 'noop.js'))('playwright');
  }
}

if (!args.includes('--no-build')) {
  const r = spawnSync('npx', ['vite', 'build', '--config', 'vite.config.ts', '--logLevel', 'warn'], { cwd: pkgRoot, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!existsSync(join(distDir, 'index.html'))) {
  console.error('dist/renderer is missing; run without --no-build');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(distDir, rel);
  if (!file.startsWith(distDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(distDir, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/index.html`;

/** Each shot: query string, colour scheme and the steps that bring the UI into the state to capture. */
const SHOTS = [
  { name: 'empty-light', query: '?mock=empty', scheme: 'light', ready: (p) => p.getByText('How can I help you on ClaudeOS today?').waitFor() },
  { name: 'empty-dark', query: '?mock=empty', scheme: 'dark', ready: (p) => p.getByText('How can I help you on ClaudeOS today?').waitFor() },
  { name: 'chat-light', query: '?mock=streaming&speed=fast', scheme: 'light', ready: chatReady },
  { name: 'chat-dark', query: '?mock=streaming&speed=fast', scheme: 'dark', ready: chatReady },
  {
    name: 'approval-light',
    query: '?mock=approval',
    scheme: 'light',
    ready: (p) => p.getByTestId('approval-card').waitFor(),
  },
  {
    name: 'drawer-open-light',
    query: '?mock=empty',
    scheme: 'light',
    ready: async (p) => {
      await p.getByRole('button', { name: 'Show history' }).click();
      await p.getByText('Recents').waitFor();
      await p.waitForTimeout(350);
    },
  },
  {
    name: 'onboarding-signin-light',
    query: '?mock=onboarding#onboarding',
    scheme: 'light',
    ready: async (p) => {
      await p.getByRole('button', { name: 'Get started' }).click();
      await p.getByRole('button', { name: 'Sign in with Claude' }).click();
      await p.getByLabel('Authentication code').waitFor();
    },
  },
  {
    name: 'onboarding-doctor-dark',
    query: '?mock=onboarding#onboarding',
    scheme: 'dark',
    ready: async (p) => {
      await p.getByRole('button', { name: 'Get started' }).click();
      await p.getByRole('button', { name: 'Skip for now' }).click();
      await p.getByTestId('doctor').locator('li').first().waitFor();
    },
  },
  { name: 'signedout-light', query: '?mock=signedout', scheme: 'light', ready: (p) => p.getByTestId('signin-card').waitFor() },
];

async function chatReady(p) {
  await p.getByText('Want me to move the old recordings').waitFor({ timeout: 20000 });
  await p.getByRole('button', { name: 'Send message' }).waitFor();
  // Expand the screenshot tool row so the inline image shows, then frame tool calls + code card together.
  await p.getByRole('button', { name: /Took a screenshot/ }).click();
  await p.getByRole('img', { name: 'Screenshot returned by the tool' }).waitFor();
  await p.evaluate(() => {
    const scroller = document.querySelector('[data-testid="message-scroller"]');
    const group = document.querySelector('[data-testid="tool-group"]');
    if (scroller && group) scroller.scrollTop = group.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 72;
  });
}

mkdirSync(outDir, { recursive: true });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
let failed = false;
try {
  for (const shot of SHOTS) {
    if (only && !only.has(shot.name)) continue;
    const context = await browser.newContext({
      viewport: { width: 440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: shot.scheme,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => {
      failed = true;
      console.error(`[${shot.name}] page error: ${e.message}`);
    });
    page.on('console', (m) => m.type() === 'error' && console.error(`[${shot.name}] console: ${m.text()}`));
    await page.goto(`${base}${shot.query}`);
    await page.evaluate(() => document.fonts.ready);
    await shot.ready(page);
    // Park the pointer over empty space so nothing is captured in a hover state.
    await page.mouse.move(430, 300);
    await page.waitForTimeout(150);
    const file = join(outDir, `${shot.name}.png`);
    await page.screenshot({ path: file });
    console.log(`${shot.name}.png  ${Math.round(statSync(file).size / 1024)} KB`);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
