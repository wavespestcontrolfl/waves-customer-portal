// Renders icons/icon.svg to the PNG sizes manifest.json lists.
// Usage: node extensions/bug-identifier/scripts/render-icons.mjs
// Set CHROMIUM_PATH to use a Chromium other than the one Playwright installed.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const iconsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const svg = await readFile(join(iconsDir, 'icon.svg'), 'utf8');

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: join(iconsDir, `icon-${size}.png`), omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('icons rendered');
