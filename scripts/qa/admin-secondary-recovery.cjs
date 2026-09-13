'use strict';
/* global document, innerWidth */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, evidence } = require('./browser');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-secondary-recovery');
function html(source, name, props) {
  return `<!doctype html><html class="admin-app"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/index.css"></head><body><main id="root" class="admin-shell-v2" style="padding:24px"></main><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const React=(await import('/node_modules/.vite/deps/react.js')).default;
const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const Component=(await import(${JSON.stringify(source)}))[${JSON.stringify(name)}];
createRoot(document.getElementById('root')).render(React.createElement(Component,${JSON.stringify(props)}));
</script></body></html>`;
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), passed: false, errors: [], requests: [], screenshots: [] };
  let server, browser;
  try {
    server = await previewServer(root);
    browser = await launchBrowser();
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'America/New_York', serviceWorkers: 'block' });
      page.setDefaultTimeout(20000);
      page.on('pageerror', error => report.errors.push(error.message));
      let failCategories = true, failStats = true;
      await page.routeWebSocket('**/*', socket => socket.close());
      await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== server.baseUrl) return route.abort();
        if (url.pathname === '/qa-categories') return route.fulfill({ contentType: 'text/html', body: html('/src/components/admin/MobileServiceLibrary.jsx', 'default', { initialView: 'categories' }) });
        if (url.pathname === '/qa-stats') return route.fulfill({ contentType: 'text/html', body: html('/src/pages/admin/DiscountsTabs.jsx', 'DiscountsSection', {}) });
        if (!url.pathname.startsWith('/api/')) return route.continue();
        assert.equal(request.method(), 'GET', 'Recovery must not write business data');
        report.requests.push(url.pathname);
        if (url.pathname === '/api/admin/services') return route.fulfill(failCategories ? { status: 503, json: {} } : { json: { services: [], total: 0 } });
        if (url.pathname === '/api/admin/discounts') return route.fulfill({ json: [] });
        if (url.pathname === '/api/admin/discounts/stats') return route.fulfill(failStats ? { status: 503, json: {} } : { json: { totalApplied: 0, totalGiven: 0, discounts: [] } });
        throw new Error(`Unexpected API request ${url.pathname}`);
      });
      async function capture(name) {
        await page.evaluate(async () => {
          await document.fonts.ready;
          const faces = await document.fonts.load('14px Roboto');
          if (!faces.length || faces.some(face => face.status !== 'loaded')) throw new Error('Roboto unavailable');
        });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No page overflow');
        const file = path.join(output, `${name}-${width}.png`);
        await page.screenshot({ path: file, fullPage: true });
        report.screenshots.push(file);
      }
      await page.goto(`${server.baseUrl}/qa-categories`);
      await page.getByRole('alert').filter({ hasText: 'Could not load categories.' }).waitFor();
      assert.equal(await page.getByText('No categories').count(), 0);
      await capture('categories-error');
      failCategories = false;
      await page.getByRole('button', { name: 'Try again' }).click();
      await page.getByText('No categories').waitFor();
      assert.equal(await page.getByRole('alert').count(), 0);
      await capture('categories-empty');
      await page.goto(`${server.baseUrl}/qa-stats`);
      await page.getByRole('tab', { name: 'Stats' }).click();
      await page.getByRole('alert').filter({ hasText: 'Could not load discount statistics.' }).waitFor();
      assert.equal(await page.getByText('Total Applications').count(), 0);
      await capture('stats-error');
      failStats = false;
      await page.getByRole('button', { name: 'Try again' }).click();
      await page.getByText('$0.00', { exact: true }).waitFor();
      assert.equal(await page.getByRole('alert').count(), 0);
      await capture('stats-zero');
      await page.close();
    }
    assert.deepEqual(report.errors, []);
    report.passed = true;
    console.log('Category and statistics recovery passed at 1440px and 390px.');
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    try { if (browser) await browser.close(); }
    finally { if (server) await server.close(); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
