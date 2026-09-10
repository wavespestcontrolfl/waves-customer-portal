'use strict';
// Frontend-only proof: synthetic API responses; block external traffic and sockets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webkit } = require('playwright');
const { previewServer, launchBrowser, evidence, waitForFonts } = require('./browser');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/turf-height-ui');
const items = [
  { id: 7, customerName: 'Pat Example — long customer name for mobile review', grassType: 'st_augustine', band: { min: 3, max: 4 }, measuredAt: '2026-09-01T16:00:00Z', manualHeightIn: 3.5, ocrHeightIn: 2, ocrConfidence: 0.9, verificationStatus: 'discrepancy', gaugePhotoUrl: null },
  { id: 8, customerName: 'Sam Example', grassType: 'zoysia', band: { min: 2, max: 3 }, measuredAt: '2026-09-02T16:00:00Z', manualHeightIn: 0, ocrHeightIn: null, ocrConfidence: null, verificationStatus: 'ocr_failed', gaugePhotoUrl: null },
];
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), passed: false, sizes: [], requests: [], unmatched: [], pageErrors: [] };
  let server, chrome, safari;
  try {
    server = await previewServer(root);
    chrome = await launchBrowser();
    safari = await webkit.launch();
    for (const [name, browser, hasTouch] of [['desktop', chrome, false], ['mobile', safari, true]]) {
      const context = await browser.newContext({ viewport: { width: hasTouch ? 390 : 1440, height: 900 }, hasTouch, serviceWorkers: 'block', timezoneId: 'America/New_York' });
      const page = await context.newPage();
      let failRead = false, failWrite = true;
      let current = [...items];
      await page.addInitScript(() => {
        const originalFetch = window.fetch.bind(window);
        window.fetch = (input, options) => String(input).endsWith('/admin/usage/track')
          ? Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
          : originalFetch(input, options);
        localStorage.setItem('waves_admin_token', 'synthetic-local-token');
        localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-user', role: 'admin', name: 'Fixture operator' }));
      });
      page.on('pageerror', (error) => report.pageErrors.push(error.message));
      await page.routeWebSocket('**/*', (socket) => socket.close());
      await page.route('**/*', async (route) => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== server.baseUrl || url.pathname.startsWith('/socket.io')) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        let body, status = 200;
        if (url.pathname === '/api/admin/turf-height/review') {
          report.requests.push({ method: request.method(), path: url.pathname });
          status = failRead ? 500 : 200;
          body = failRead ? { error: 'Synthetic read failure' } : { items: current };
        } else if (/^\/api\/admin\/turf-height\/(7|8)\/resolve$/.test(url.pathname)) {
          assert.equal(request.method(), 'PATCH');
          assert.deepEqual(request.postDataJSON(), { status: 'verified' });
          report.requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
          await new Promise((resolve) => setTimeout(resolve, 200));
          status = failWrite ? 409 : 200;
          body = failWrite ? { error: 'Reading is locked' } : { ok: true };
          if (!failWrite) current = current.filter((item) => !url.pathname.includes(`/${item.id}/`));
        } else if (url.pathname === '/api/admin/auth/me') body = { id: 'fixture-user', role: 'admin', name: 'Fixture operator' };
        else if (url.pathname === '/api/admin/feature-flags') body = { flags: {} };
        else if (['/api/admin/notifications/unread-count', '/api/admin/communications/unread-count'].includes(url.pathname)) body = { count: 0, conversations: 0 };
        else if (url.pathname === '/api/admin/usage/track') body = { ok: true };
        else { report.unmatched.push(url.pathname); status = 404; body = {}; }
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.goto(`${server.baseUrl}/admin/turf-height?proof=retained`);
      await page.getByText(items[0].customerName, { exact: true }).waitFor();
      await waitForFonts(page);
      const flagged = page.getByText(items[0].customerName, { exact: true });
      const border = await flagged.evaluate((el) => getComputedStyle(el.closest('.bg-white')).borderColor);
      assert.equal(border, 'rgb(200, 49, 47)', 'Discrepancy keeps its alert border');
      const surface = page.locator('[data-ui-density="comfortable"]').filter({ has: page.getByRole('heading', { name: 'Turf height review' }) });
      for (const width of [390, 700, 820, 1024, 1440]) {
        for (const height of [900, 390]) {
          await page.setViewportSize({ width, height });
          const metrics = await surface.evaluate((node) => ({
            overflow: document.documentElement.scrollWidth > innerWidth,
            controls: [...node.querySelectorAll('button')].map((el) => ({ height: el.getBoundingClientRect().height, font: parseFloat(getComputedStyle(el).fontSize) })),
          }));
          assert.equal(metrics.overflow, false, `overflow ${name} ${width}x${height}`);
          for (const control of metrics.controls) { assert.ok(control.height >= 44); assert.ok(control.font >= 14); }
          report.sizes.push({ name, width, height, ...metrics });
        }
      }
      await page.setViewportSize({ width: hasTouch ? 390 : 1440, height: 900 });
      await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
      const confirm = page.getByRole('button', { name: 'Confirm reading', exact: true }).first();
      await confirm.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('alert').filter({ hasText: 'Reading is locked' }).waitFor();
      assert.equal(await confirm.isEnabled(), true);
      await page.screenshot({ path: path.join(output, `${name}-error.png`), fullPage: true });
      failWrite = false;
      await confirm.click();
      await page.getByText(items[0].customerName, { exact: true }).waitFor({ state: 'detached' });
      assert.equal(await page.getByText('0″', { exact: true }).count(), 1);
      await page.getByRole('button', { name: 'Confirm reading', exact: true }).click();
      await page.getByText(/Nothing to review/).waitFor();
      failRead = true;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Failed to load' }).waitFor();
      assert.equal(await page.getByText(/Nothing to review/).count(), 0);
      failRead = false;
      current = [...items];
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByText(items[0].customerName, { exact: true }).waitFor();
      await page.reload();
      await page.getByText(items[0].customerName, { exact: true }).waitFor();
      assert.equal(new URL(page.url()).search, '?proof=retained');
      await context.close();
    }
    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await safari?.close(); await chrome?.close(); await server?.close();
  }
  console.log(`Turf height UI proof passed: ${report.sizes.length} viewport cases. Evidence: ${output}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
