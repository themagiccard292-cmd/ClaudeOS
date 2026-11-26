#!/usr/bin/env node
// Render SVGs to PNG with Playwright/Chromium (deviceScaleFactor 1, transparent background).
// Usage: render_assets.js <in.svg> <out.png> <width> <height> [more triples...]
'use strict';
const fs = require('fs');
const { chromium } = require('playwright');

(async () => {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.length % 4 !== 0) {
    console.error('usage: render_assets.js <in.svg> <out.png> <w> <h> ...');
    process.exit(2);
  }
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < args.length; i += 4) {
      const [src, out, w, h] = [args[i], args[i + 1], Number(args[i + 2]), Number(args[i + 3])];
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      // about:blank pages cannot load file:// URLs, so embed the SVG as a data URI.
      const url = 'data:image/svg+xml;base64,' + fs.readFileSync(src).toString('base64');
      await page.setContent(
        `<html><body style="margin:0;background:transparent"><img src="${url}" width="${w}" height="${h}" style="display:block"></body></html>`
      );
      await page.waitForFunction(() => document.images[0].complete);
      await page.screenshot({ path: out, omitBackground: true });
      await page.close();
      console.log(`rendered ${out} (${w}x${h})`);
    }
  } finally {
    await browser.close();
  }
})();
