'use strict';
/* global document, localStorage, getComputedStyle, innerWidth */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, evidence, waitForFonts } = require('./browser');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-price-notices-foundation');
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), passed: false, requests: [], unmatched: [], errors: [] };
  const server = await previewServer(root);
  const browser = await launchBrowser().catch(async error => { await server.close(); throw error; });
  try {
    for (const width of [1440, 390, 820]) {
      let failSend = true;
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 1440, serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      await page.routeWebSocket('**/*', socket => socket.close());
      page.on('pageerror', e => report.errors.push(e.message));
      await page.addInitScript(() => {
        localStorage.setItem('waves_admin_token', 'synthetic-token');
        localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-admin', role: 'admin', name: 'Fixture operator' }));
      });
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== server.baseUrl || url.pathname.startsWith('/socket.io')) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const key = `${request.method()} ${url.pathname}`;
        report.requests.push({ width, key, body: request.postDataJSON() });
        let body = {}, status = 200;
        if (key === 'GET /api/admin/auth/me') body = { id: 'fixture-admin', role: 'admin', name: 'Fixture operator' };
        else if (key === 'GET /api/admin/feature-flags') body = { flags: {} };
        else if (url.pathname.endsWith('/unread-count')) body = { count: 0 };
        else if (key === 'POST /api/admin/usage/track') body = { ok: true };
        else if (key === 'POST /api/admin/price-change/preview') body = { count: 1, invalidCount: 0, overCap: false, digest: 'fixture-digest', rows: [{ customerId: 'fixture-customer', name: 'Avery Example', current: '$39', next: '$42', hasEmail: true, hasPhone: true }] };
        else if (key === 'POST /api/admin/price-change/send') {
          status = failSend ? 409 : 200;
          body = failSend ? { error: 'Synthetic preview drift. Build a fresh preview.' } : { ok: true, message: 'Notices sent.' };
        } else { report.unmatched.push(key); status = 404; body = { error: 'Unmatched fixture' }; }
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.goto(`${server.baseUrl}/admin/pricing-logic?area=notices&source=qa`);
      const change = page.getByLabel('Change ($ / month)', { exact: true });
      await change.fill('3');
      await page.getByRole('button', { name: 'Preview affected customers' }).click();
      await page.getByText('Avery Example', { exact: true }).waitFor();
      await waitForFonts(page);
      await page.screenshot({ path: path.join(output, `notices-${width}.png`), fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      for (const label of ['Location', 'Adjustment', 'Change ($ / month)', 'Effective date']) {
        const metrics = await page.getByLabel(label, { exact: true }).evaluate(el => ({ height: el.getBoundingClientRect().height, font: parseFloat(getComputedStyle(el).fontSize) }));
        assert.ok(metrics.height >= 44 && metrics.font >= 16, JSON.stringify(metrics));
      }
      // Editing invalidates the preview and cannot submit a stale notice batch.
      await change.fill('4');
      await page.getByRole('button', { name: 'Preview affected customers' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Send 1 notices' }).count(), 0);
      await page.getByRole('button', { name: 'Preview affected customers' }).click();
      const date = await page.getByLabel('Effective date').inputValue();
      await page.getByRole('button', { name: 'Send 1 notices' }).click();
      await page.getByRole('alert').filter({ hasText: 'Synthetic preview drift' }).waitFor();
      assert.equal(await change.inputValue(), '4');
      assert.equal(await page.getByRole('button', { name: 'Send 1 notices' }).count(), 0);
      failSend = false;
      await page.getByRole('button', { name: 'Preview affected customers' }).click();
      await page.getByRole('button', { name: 'Send 1 notices' }).click();
      await page.getByRole('status').filter({ hasText: 'Notices sent.' }).waitFor();
      const sent = report.requests.filter(r => r.width === width && r.key.endsWith('/send')).at(-1);
      assert.deepEqual(sent.body, { increase: { type: 'amount', value: 4 }, effectiveDate: date, cadenceLabel: 'month', expectedCount: 1, expectedDigest: 'fixture-digest' });
      await context.close();
    }
    assert.deepEqual(report.unmatched, []); assert.deepEqual(report.errors, []); report.passed = true;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close(); await server.close();
  }
  console.log(JSON.stringify({ passed: report.passed, output }));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
