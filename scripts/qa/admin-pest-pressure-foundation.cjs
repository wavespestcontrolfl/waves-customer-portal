'use strict';
// SYNTHETIC UI QA. Every API response is fulfilled in-browser; no database or
// provider is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, waitForFonts, evidence } = require('./browser');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-pest-pressure-foundation');
const now = new Date().toISOString();
const config = {
  enabled: true, showOnCustomerReport: true, showHowCalculated: true,
  showComponentBreakdownToCustomer: false, missingDataBehavior: 'recalculate_available_components',
  minimumDataRequired: { requireOneOf: ['technicianRating'] }, allowManualOverride: true,
  allowTechnicianClientRatingEntry: true, enabledServiceLines: ['pest', 'mosquito'], requireRecurringFrequency: true,
  weights: { client: 25, technician: 30, reService: 20, recurring: 15, risk: 10 },
  labels: [
    { key: 'very_low', name: 'Very Low', min: 0, max: 0.9, description: 'Little to no pest activity.' },
    { key: 'low', name: 'Low', min: 1, max: 1.9, description: 'Minor activity.' },
    { key: 'moderate', name: 'Moderate', min: 2, max: 2.9, description: 'Noticeable activity.' },
    { key: 'elevated', name: 'Elevated', min: 3, max: 3.9, description: 'Recurring activity.' },
    { key: 'high', name: 'High', min: 4, max: 5, description: 'Heavy activity.' },
  ],
  trendThresholds: { improvingAtOrBelow: -0.5, stableBand: 0.4, increasingFrom: 0.5, significantIncreaseFrom: 1 },
  serviceFrequencyWindows: { monthly: 30, bimonthly: 60, quarterly: 90, semiannual: 180, fallbackDays: 90 },
  clientQuestionText: { monthly: 'Monthly prompt', bimonthly: 'Bi-monthly prompt', quarterly: 'Quarterly prompt', custom: 'Custom prompt' },
  customerExplanationText: 'Synthetic customer explanation.', calculationVersion: '1.0',
};
const scores = [
  { id: 'score-1', service_record_id: 'service-1', customer_id: 'customer-1', customer_name: 'Synthetic customer',
    service_date: '2026-09-10', service_line: 'pest', calculated_score: 2.4, displayed_score: 2.4,
    label_name: 'Moderate', trend: 'stable', is_overridden: false },
  { id: 'score-2', service_record_id: 'service-2', customer_id: 'customer-2', customer_name: 'Override customer',
    service_date: '2026-09-09', service_line: 'mosquito', calculated_score: 3.2, displayed_score: 4,
    label_name: 'High', trend: 'increasing', is_overridden: true, override_reason: 'Synthetic override' },
];
const events = [{ id: 'audit-1', action: 'pest_pressure.override', actor_type: 'admin', actor_id: 'fixture-admin',
  created_at: now, metadata: { displayedScore: 4, reason: 'Synthetic override' } }];

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), scenarios: [], requests: [], unmatched: [], blockedExternal: [],
    consoleErrors: [], pageErrors: [], screenshots: [] };
  let server;
  let browser;
  let stage = 'startup';

  function fixture(api, method, requestBody) {
    if (api === '/health') return { status: 'ok', gates: {} };
    if (api === '/admin/auth/me') return { id: 'fixture-admin', name: 'Fixture operator', email: 'operator@example.invalid', role: 'admin' };
    if (api === '/admin/pest-pressure/config') return method === 'PUT'
      ? { config: requestBody, changedFields: ['showComponentBreakdownToCustomer'] }
      : { config, defaults: config };
    if (api === '/admin/pest-pressure/scores/recent') return { scores };
    if (api === '/admin/pest-pressure/audit') return { events };
    if (api === '/admin/pest-pressure/preview') return { result: { score: 2.6, label: { name: 'Moderate' },
      dataCompleteness: 'complete', trend: 'increasing', trendDelta: 0.5, summary: 'Synthetic preview summary.',
      componentScores: {}, componentWeights: config.weights, missingComponents: [], calculationVersion: '1.0' } };
    if (/^\/admin\/pest-pressure\/scores\/[^/]+\/(recalculate|override)$/.test(api)) return { ok: true };
    if (api === '/admin/feature-flags') return { flags: {} };
    if (api === '/admin/notifications/unread-count') return { count: 0 };
    if (api === '/admin/communications/unread-count') return { conversations: 0, messages: 0 };
    if (api === '/admin/usage/track') return { ok: true };
    return null;
  }

  async function openPage(width) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    page.setDefaultTimeout(15000);
    await page.addInitScript(() => {
      localStorage.setItem('waves_admin_token', 'synthetic-local-token');
      localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-admin', name: 'Fixture operator', role: 'admin' }));
      window.confirm = () => true;
      if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: 'synthetic-local-test' });
    });
    page.on('pageerror', (error) => report.pageErrors.push({ stage, message: error.message }));
    page.on('console', (message) => {
      if (message.type() === 'error') report.consoleErrors.push({ stage, message: message.text() });
    });
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== server.baseUrl) {
        report.blockedExternal.push({ stage, origin: url.origin });
        return route.abort();
      }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const api = url.pathname.slice(4);
      const method = request.method();
      const requestBody = request.postData() ? JSON.parse(request.postData()) : null;
      report.requests.push({ stage, method, path: api, search: url.search, body: requestBody });
      const body = fixture(api, method, requestBody);
      if (body === null) {
        report.unmatched.push({ stage, method, path: api, search: url.search });
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Unmatched synthetic fixture' }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    return page;
  }

  async function assertFoundation(page) {
    const surface = page.locator('[data-ui-density="comfortable"]');
    await surface.waitFor();
    const inlineStyles = await surface.locator('[style]:not(.ui-select)').evaluateAll((elements) => elements
      .filter((element) => element.getAttribute('style')?.trim())
      .map((element) => ({ tag: element.tagName, className: element.className, style: element.getAttribute('style') }))
      .slice(0, 8));
    assert.deepEqual(inlineStyles, [], `page-local inline styles must be absent: ${JSON.stringify(inlineStyles)}`);
    const undersizedText = await surface.evaluate((rootElement) => Array.from(rootElement.querySelectorAll('*'))
      .filter((element) => element.children.length === 0 && element.textContent.trim() && getComputedStyle(element).display !== 'none')
      .map((element) => ({ text: element.textContent.trim().slice(0, 80), size: parseFloat(getComputedStyle(element).fontSize) }))
      .filter((item) => item.size < 14));
    assert.deepEqual(undersizedText, [], `readable text below 14px: ${JSON.stringify(undersizedText)}`);
    const undersizedControls = await surface.evaluate((rootElement) => Array.from(rootElement.querySelectorAll('button, a[href], input, select, textarea, summary'))
      .filter((element) => getComputedStyle(element).display !== 'none' && !element.classList.contains('u-touch-hit'))
      .map((element) => ({ name: element.getAttribute('aria-label') || element.textContent.trim(), height: element.getBoundingClientRect().height }))
      .filter((item) => item.height < 44));
    assert.deepEqual(undersizedControls, [], `controls below 44px: ${JSON.stringify(undersizedControls)}`);
  }

  async function shot(page, name) {
    await waitForFonts(page);
    const file = path.join(output, `${name}.png`);
    await page.screenshot({ path: file });
    report.screenshots.push({ name, file: path.relative(root, file), width: page.viewportSize().width,
      overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
  }

  async function scenario(name, work) {
    stage = name;
    console.log(`Checking: ${name}`);
    await work();
    report.scenarios.push({ name, passed: true });
  }

  try {
    server = await previewServer(root);
    browser = await launchBrowser();
    const desktop = await openPage(1440);
    await scenario('desktop foundation renders every settings section and live records', async () => {
      await desktop.goto(`${server.baseUrl}/admin/settings/pest-pressure`);
      await desktop.getByRole('table', { name: 'Recent Pest Pressure scores' }).waitFor();
      await desktop.getByText('Score formula', { exact: true }).waitFor();
      await desktop.getByText('Client rating prompt text', { exact: true }).waitFor();
      await desktop.getByText('pest_pressure.override', { exact: true }).waitFor();
      await assertFoundation(desktop);
      assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await shot(desktop, 'pest-pressure-desktop-top-1440');
      await desktop.getByRole('table', { name: 'Recent Pest Pressure scores' }).scrollIntoViewIfNeeded();
      await shot(desktop, 'pest-pressure-desktop-records-1440');
    });

    await scenario('configuration save and preview retain request payloads', async () => {
      await desktop.getByRole('switch', { name: 'Show component breakdown to customers' }).click();
      await desktop.getByRole('button', { name: 'Save changes' }).click();
      await desktop.getByText('Saved. 1 field updated.', { exact: true }).waitFor();
      await desktop.getByRole('spinbutton', { name: 'Client rating', exact: true }).fill('4');
      await desktop.getByRole('button', { name: 'Run preview' }).click();
      await desktop.getByText('Synthetic preview summary.', { exact: true }).waitFor();
      const save = report.requests.find((request) => request.path === '/admin/pest-pressure/config' && request.method === 'PUT');
      const preview = report.requests.find((request) => request.path === '/admin/pest-pressure/preview' && request.method === 'POST');
      assert.equal(save.body.showComponentBreakdownToCustomer, true);
      assert.equal(preview.body.inputs.clientRating, 4);
    });

    await scenario('record recalculate and override preserve audited mutations', async () => {
      await desktop.getByRole('button', { name: 'Recalc' }).first().click();
      await desktop.getByRole('button', { name: 'Override', exact: true }).click();
      const dialog = desktop.getByRole('dialog', { name: 'Override Pest Pressure score' });
      await dialog.waitFor();
      await dialog.getByLabel('New displayed score (0–5)').fill('3.7');
      await dialog.getByLabel(/Reason \(required, audited\)/).fill('Corrected from technician notes');
      await dialog.getByRole('button', { name: 'Save override' }).click();
      await dialog.waitFor({ state: 'detached' });
      const recalc = report.requests.find((request) => request.path === '/admin/pest-pressure/scores/service-1/recalculate');
      const override = report.requests.find((request) => request.path === '/admin/pest-pressure/scores/service-1/override' && request.method === 'PUT');
      assert.deepEqual(recalc.body, { clearOverride: false });
      assert.deepEqual(override.body, { displayedScore: 3.7, reason: 'Corrected from technician notes' });
    });

    const mobile = await openPage(390);
    await scenario('mobile settings and full-screen override remain usable without overflow', async () => {
      await mobile.goto(`${server.baseUrl}/admin/settings/pest-pressure`);
      await mobile.getByText('Synthetic customer', { exact: true }).waitFor();
      await mobile.getByRole('button', { name: 'Override', exact: true }).click();
      const dialog = mobile.getByRole('dialog', { name: 'Override Pest Pressure score' });
      await dialog.waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Save override' }).count(), 1);
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await shot(mobile, 'pest-pressure-mobile-override-390');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await assertFoundation(mobile);
    });

    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.blockedExternal, []);
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.pageErrors, []);
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Evidence: ${path.relative(root, path.join(output, 'report.json'))}`);
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
