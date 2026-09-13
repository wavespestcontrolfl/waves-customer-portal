'use strict';
/* global document, localStorage, innerWidth, getComputedStyle */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, evidence, waitForFonts } = require('./browser');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-pricing-audit-foundation');
const fixture = {
  coverage: { completedServiceCount: 12, includedServiceCount: 10, excludedMissingQuoteCount: 1, excludedMissingActualCount: 1 },
  summary: { serviceCount: 10, avgQuotedMinutes: 40, avgActualMinutes: 50, weightedPercentVariance: 25, totalDollarMarginImpact: -70, outlierCount: 1 },
  segments: [{ key: 'fixture', label: 'Example segment', serviceCount: 10, avgQuotedMinutes: 40, avgActualMinutes: 50, avgVarianceMinutes: 10, weightedPercentVariance: 25, totalDollarMarginImpact: -70, avgDollarMarginImpact: -7, outlierCount: 1 }],
  outliers: [{ serviceId: 'fixture-service', completedAt: '2026-09-10T12:00:00Z', customerId: 'fixture-customer', customerName: 'Avery Example', serviceType: 'Mowing', lawnCareTrack: 'Standard', sqftBand: '8,000-8,499', zone: 'Example zone', technician: 'Fixture technician', quotedMinutes: 42, actualMinutes: 90, varianceMinutes: 48, percentVariance: 114, dollarMarginImpact: -28, zScore: 2.7, billingCohort: 'Annual Prepay' }],
  availableFilters: { serviceTypes: ['Mowing'], lawnCareTracks: ['Standard'], sqftBands: ['8,000-8,499'], zones: [{ id: 'zone-1', label: 'Example zone' }], technicians: [{ id: 'tech-1', label: 'Fixture technician' }], months: ['2026-09'], billingCohorts: ['Annual Prepay'] },
};
// The existing audit leaf is mounted directly to isolate it from the remaining
// Pricing workspaces. This entry is intercepted in memory; no public stub ships.
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/index.css"><link rel="stylesheet" href="/src/styles/brand-tokens.css"></head><body><main id="root" class="admin-shell-v2" style="padding:16px"></main><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const React = (await import('/node_modules/.vite/deps/react.js')).default;
const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const Page = (await import('/src/pages/admin/PricingRealityCheckPage.jsx')).default;
createRoot(document.getElementById('root')).render(React.createElement(Page));
</script></body></html>`;
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), passed: false, requests: [], unmatched: [], errors: [] };
  const server = await previewServer(root);
  const browser = await launchBrowser().catch(async error => { await server.close(); throw error; });
  try {
    for (const width of [1440, 390, 820]) {
      let failure = false, empty = false;
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 1440, serviceWorkers: 'block' });
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on('pageerror', e => report.errors.push(e.message));
      await page.routeWebSocket('**/*', socket => socket.close());
      await page.addInitScript(() => localStorage.setItem('waves_admin_token', 'synthetic-token'));
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== server.baseUrl) return route.abort();
        if (url.pathname === '/qa-pricing-audit') return route.fulfill({ contentType: 'text/html', body: html });
        if (!url.pathname.startsWith('/api/')) return route.continue();
        if (url.pathname !== '/api/admin/pricing-reality-check' || request.method() !== 'GET') { report.unmatched.push(request.method() + ' ' + url.pathname); return route.abort(); }
        report.requests.push({ width, query: Object.fromEntries(url.searchParams) });
        const body = failure ? { error: 'Synthetic audit unavailable' } : empty ? { ...fixture, coverage: { includedServiceCount: 0 } } : fixture;
        await route.fulfill({ status: failure ? 503 : 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.goto(`${server.baseUrl}/qa-pricing-audit`);
      await page.getByText('Example segment', { exact: true }).waitFor();
      await waitForFonts(page);
      const titleStyle = await page.getByRole('heading', { name: 'Audit', exact: true }).evaluate(el => ({ font: getComputedStyle(el).fontFamily, size: parseFloat(getComputedStyle(el).fontSize) }));
      assert.ok(titleStyle.font.includes('Roboto') && titleStyle.size === 22, JSON.stringify(titleStyle));
      await page.screenshot({ path: path.join(output, `audit-${width}.png`), fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const fields = await page.locator('select').evaluateAll(nodes => nodes.map(n => ({ height: n.getBoundingClientRect().height, font: parseFloat(getComputedStyle(n).fontSize) })));
      assert.ok(fields.every(f => f.height >= 44 && f.font >= 16), JSON.stringify(fields));
      await page.getByLabel('Service type', { exact: true }).selectOption('Mowing');
      await Promise.all([page.waitForResponse(r => r.url().includes('groupBy=technician')), page.getByRole('button', { name: 'Technician', exact: true }).click()]);
      assert.equal(await page.getByRole('button', { name: 'Technician', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.getByRole('link', { name: 'Avery Example' }).getAttribute('href'), '/admin/customers?customerId=fixture-customer');
      failure = true;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Synthetic audit unavailable' }).waitFor();
      failure = false; empty = true;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByText('No completed services with both quoted and actual minutes were found for this window.').waitFor();
      assert.equal(await page.getByLabel('Service type', { exact: true }).inputValue(), 'Mowing');
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
