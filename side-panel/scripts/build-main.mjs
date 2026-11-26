// Bundles the Electron main + preload into CommonJS (package.json is "type": "module", so output is .cjs).
// The preload runs sandboxed, so it must be a single self-contained file (only `electron` stays external).
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: false,
  external: ['electron'],
  logLevel: 'info',
  define: { __CLAUDEOS_VERSION__: JSON.stringify(version) },
};
await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.cjs' });
await build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/main/preload.cjs' });
