#!/usr/bin/env node
'use strict';

/**
 * Before/after screenshots of the real lawn report page for GATE_LAWN_REPORT_LAYOUT.
 * Local only: no database, no network beyond the dev server. Needs the Vite dev server running:
 *
 *   cd client && npx vite --port 5191        (leave it running)
 *   node scripts/screenshot-lawn-report-layout.js [--port 5191] [--out ~/lawn-report-layout-preview] [--widths 390,1280]
 *
 * Writes <visit>-<off|on>-<width>.png for the visits spot, granular and clean (full page, reduced
 * motion so the score rings show their final numbers). The page is rendered by
 * client/preview-lawn-report-layout.html from the saved payloads in
 * client/src/pages/__fixtures__/lawn-layout (regenerate with scripts/generate-lawn-report-layout-fixtures.js).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};
const port = arg('port', '5191');
const out = arg('out', path.join(os.homedir(), 'lawn-report-layout-preview'));
const widths = arg('widths', '390,1280').split(',').map(Number);
const VISITS = ['spot', 'granular', 'clean'];
// GATE_LAWN_REPORT_POLISH visits: before (gate off) and after (gate on), written as <visit>-off / <visit>-on.
const POLISH_VISITS = ['mixed', 'single'];

async function shoot(browser, visit, layout, width) {
  const query = POLISH_VISITS.includes(visit) ? `layout=on&polish=${layout}` : `layout=${layout}`;
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`http://localhost:${port}/preview-lawn-report-layout.html?scenario=${visit}&${query}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.addStyleTag({ content: '[data-preview-bar]{display:none !important}' });
  const file = path.join(out, `${visit}-${layout}-${width}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  process.stdout.write(`${file}\n`);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  for (const visit of [...VISITS, ...POLISH_VISITS]) {
    for (const layout of ['off', 'on']) {
      for (const width of widths) await shoot(browser, visit, layout, width);
    }
  }
  await browser.close();
})();
