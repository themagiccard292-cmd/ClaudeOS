// Packages the built app with @electron/packager -> dist-package/claudeos-panel-app-linux-x64/claudeos-panel-app
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { packager } from '@electron/packager';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const stage = 'dist-package/stage';
rmSync('dist-package', { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync('dist/main', `${stage}/dist/main`, { recursive: true });
cpSync('dist/renderer', `${stage}/dist/renderer`, { recursive: true });
// Minimal runtime package.json: no node_modules needed, everything is bundled.
writeFileSync(`${stage}/package.json`, JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: 'dist/main/main.cjs', license: pkg.license }, null, 2));

const out = await packager({
  dir: stage,
  out: 'dist-package',
  name: 'claudeos-panel-app',
  executableName: 'claudeos-panel-app',
  platform: 'linux',
  arch: 'x64',
  overwrite: true,
  prune: false,
  asar: true,
  electronVersion: JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8')).version,
});
console.log('packaged:', out.join(', '));
