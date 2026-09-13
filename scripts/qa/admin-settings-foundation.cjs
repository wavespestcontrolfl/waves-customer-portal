'use strict';
// SYNTHETIC UI QA. Reuses this checkout's local frontend and fulfills every
// API request in-browser. It never reaches a database or provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, waitForFonts, evidence } = require('./browser');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-settings-foundation');
const now = new Date().toISOString();
const visitTimeline = {
  enabled: true, showOnCustomerReports: true, showTechnicianEnRoute: true,
  showTechnicianOnSite: true, showCustomerContact: true, showReportGenerated: false,
  showDuration: true, minimumDurationMinutes: 5,
  showTimingNoteWhenDurationUnavailable: true, showDataSourceNote: true,
  dataSourceNote: 'Synthetic timeline source note.',
};
const serviceCoverage = {
  enabled: true, showOnCustomerReports: true, showSummaryCounts: true,
  showMap: true, showList: true, showAddress: true, showServiceDate: true,
  defaultTitle: 'Service Coverage', titleByServiceLine: { pest: 'Pest service coverage' },
  introByServiceLine: { default: 'Synthetic coverage intro.', pest: 'Synthetic pest coverage intro.' },
  disclaimerText: 'Synthetic coverage disclaimer.', defaultLayout: 'split',
  mapPrecisionMode: 'exact', showInaccessibleReasonsToCustomer: true,
  showTechnicianNotesToCustomer: false,
  statusLabels: { completed: 'Completed', treated: 'Treated', inspected: 'Inspected', checked: 'Checked',
    inaccessible: 'Inaccessible', needs_attention: 'Needs attention', needs_follow_up: 'Needs follow-up',
    skipped: 'Skipped', not_serviced: 'Not serviced' },
};
const integrationCatalog = { integrations: [{
  id: 'synthetic-provider', name: 'Synthetic provider', category: 'Messaging & Reviews',
  description: 'Synthetic integration fixture.', deprecating: false,
  health: { status: 'connected', label: 'Connected', reason: 'Synthetic credentials are ready.', lastCheckedAt: now,
    children: [{ id: 'child-1', label: 'Bradenton account', status: 'connected', statusLabel: 'Connected' }] },
  gates: [{ key: 'syntheticGate', label: 'Synthetic gate', enabled: true }],
  env: [{ key: 'SYNTHETIC_TOKEN', present: true, required: true }],
}] };

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), scenarios: [], requests: [], unmatched: [], blockedExternal: [],
    consoleErrors: [], pageErrors: [], screenshots: [] };
  let server;
  let browser;
  let stage = 'startup';

  function fixture(api, method) {
    if (api === '/health') return { status: 'ok', environment: 'synthetic', timestamp: now,
      gates: { cronJobs: true, seoIntelligence: false, syntheticGate: true } };
    if (api === '/admin/auth/me') return { id: 'fixture-user', name: 'Fixture operator', email: 'operator@example.invalid', role: 'admin' };
    if (api === '/admin/settings/visit-timeline') return { config: visitTimeline, defaults: visitTimeline };
    if (api === '/admin/settings/visit-timeline/reset') return { config: visitTimeline };
    if (api === '/admin/settings/service-coverage') return { config: serviceCoverage, defaults: serviceCoverage };
    if (api === '/admin/settings/service-coverage/reset') return { config: serviceCoverage };
    if (api === '/admin/revenue/settings') return { settings: { ovh_office_payroll: '1200', ovh_rent: '900', overhead_entered_at: '2026-09-01' } };
    if (api === '/admin/kpi-targets') return { targets: [] };
    if (api === '/admin/communications/link-library') return method === 'POST' ? { ok: true } : {
      links: [{ id: 'manual-1', key: 'manual-1', name: 'Synthetic link', url: 'https://example.invalid/help', source: 'manual', category: 'website' }],
      lastSyncedAt: null,
    };
    if (api === '/admin/communications/link-library/sync') return { fetched: 1, added: 0, updated: 1, removed: 0 };
    if (api.startsWith('/admin/communications/link-library/')) return { ok: true };
    if (api === '/admin/schedule/blackout-dates') return { blackouts: [{ id: 'day-1', date: '2026-12-25', reason: 'Holiday' }], weeklyDaysOff: [0] };
    if (api === '/admin/schedule/blackout-dates/weekly') return { weeklyDaysOff: [0, 6] };
    if (api.startsWith('/admin/schedule/blackout-dates/')) return { ok: true };
    if (api === '/admin/gbp/locations') return { locations: [{ id: 'bradenton', name: 'Bradenton', hasCredentials: true }] };
    if (api === '/admin/settings/linkedin/status') return { configured: true, connected: true, orgVerified: true, hasRefreshToken: true, tokenExpiresAt: now };
    if (api === '/admin/integrations/health') return integrationCatalog;
    if (api === '/admin/token-health/check') return { ok: true };
    if (api === '/admin/usage/summary') return { windowDays: 30, totals: { views: 12, activeDays: 4 },
      users: [{ name: 'Fixture operator', views: 12 }], pages: [{ pageKey: 'dispatch', views: 12, activeDays: 4,
        lastUsed: now, sources: { sidebar: 12 }, tabs: [] }] };
    if (api === '/admin/feature-flags') return { flags: {} };
    if (api === '/admin/notifications/unread-count') return { count: 0 };
    if (api === '/admin/communications/unread-count') return { conversations: 0, messages: 0 };
    if (api === '/admin/usage/track') return { ok: true };
    return null;
  }

  async function openPage(width) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
    await page.addInitScript(() => {
      localStorage.setItem('waves_admin_token', 'synthetic-local-token');
      localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-user', name: 'Fixture operator', role: 'admin' }));
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
      report.requests.push({ stage, method, path: api, search: url.search,
        body: request.postData() ? JSON.parse(request.postData()) : null });
      const body = fixture(api, method);
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
    assert.equal(await surface.locator('[style]:not(.ui-select)').count(), 0, 'page-local inline styles must be absent');
    const undersizedText = await surface.evaluate((rootElement) => Array.from(rootElement.querySelectorAll('*'))
      .filter((element) => element.children.length === 0 && element.textContent.trim() && getComputedStyle(element).display !== 'none')
      .map((element) => ({ text: element.textContent.trim().slice(0, 80), size: parseFloat(getComputedStyle(element).fontSize) }))
      .filter((item) => item.size < 14));
    assert.deepEqual(undersizedText, [], `readable text below 14px: ${JSON.stringify(undersizedText)}`);
    const undersizedControls = await surface.evaluate((rootElement) => Array.from(rootElement.querySelectorAll('button, a[href], input, select, textarea'))
      .filter((element) => getComputedStyle(element).display !== 'none' && !element.classList.contains('u-touch-hit'))
      .map((element) => ({ name: element.getAttribute('aria-label') || element.textContent.trim() || element.name,
        height: element.getBoundingClientRect().height }))
      .filter((item) => item.height < 44));
    assert.deepEqual(undersizedControls, [], `controls below 44px: ${JSON.stringify(undersizedControls)}`);
  }

  async function shot(page, name, fullPage = false) {
    await waitForFonts(page);
    const file = path.join(output, `${name}.png`);
    await page.screenshot({ path: file, fullPage });
    report.screenshots.push({ name, file: path.relative(root, file), width: page.viewportSize().width,
      overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
  }

  async function scenario(name, work) {
    stage = name;
    console.log(`Checking: ${name}`);
    await work();
    report.scenarios.push({ name, passed: true });
  }

  const leaves = [
    ['general', 'Company info'], ['integrations', 'Synthetic provider'], ['gates', 'Feature gates'],
    ['link-library', 'Link library'], ['service-reports', 'Service coverage'], ['blackout-days', 'Blackout days'],
    ['kpi-targets', 'KPI targets'], ['operating-costs', 'Operating costs'], ['system', 'System info'], ['usage', 'Portal usage'],
  ];
  // Integrations and Portal Usage render companion-owned descendants
  // (IntegrationHealthSection, PortalUsageTab) migrated by sibling PRs. They
  // still route and lay out here, so keep them in the navigation sweep and drop
  // the exclusion once those migrations land.
  const companionOwned = new Set(['integrations', 'usage']);

  try {
    server = await previewServer(root);
    browser = await launchBrowser();
    const desktop = await openPage(1440);
    await scenario('all ten deep-linked Settings leaves render, eight on the new foundation', async () => {
      for (const [tab, expected] of leaves) {
        await desktop.goto(`${server.baseUrl}/admin/settings?tab=${tab}`);
        await desktop.getByText(expected, { exact: true }).first().waitFor();
        if (!companionOwned.has(tab)) await assertFoundation(desktop);
        assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${tab} overflows desktop`);
        if (tab === 'usage') await shot(desktop, 'settings-usage-desktop-1440');
      }
      await desktop.goto(`${server.baseUrl}/admin/settings?tab=general`);
      await desktop.getByText('Company info', { exact: true }).waitFor();
      await shot(desktop, 'settings-general-desktop-1440');
    });

    await scenario('integration health refresh preserves the check and reload sequence', async () => {
      await desktop.goto(`${server.baseUrl}/admin/settings?tab=integrations`);
      await desktop.getByText('Synthetic provider', { exact: true }).waitFor();
      await desktop.getByRole('button', { name: 'Refresh checks' }).click();
      await desktop.getByRole('button', { name: 'Refresh checks' }).waitFor();
      assert.ok(report.requests.some((request) => request.path === '/admin/token-health/check' && request.method === 'POST'));
      await desktop.getByText('Synthetic provider', { exact: true }).scrollIntoViewIfNeeded();
      await shot(desktop, 'settings-health-desktop-1440');
      await desktop.setViewportSize({ width: 390, height: 900 });
      await desktop.reload();
      await desktop.getByText('Synthetic provider', { exact: true }).scrollIntoViewIfNeeded();
      await shot(desktop, 'settings-health-mobile-390');
      await desktop.setViewportSize({ width: 1440, height: 1000 });
    });

    await scenario('settings mutations retain endpoint methods and payloads', async () => {
      await desktop.goto(`${server.baseUrl}/admin/settings?tab=operating-costs`);
      await desktop.getByLabel('Office payroll').fill('1750.5');
      await desktop.getByRole('button', { name: 'Save costs' }).click();
      await desktop.getByText(/Saved\. The dashboard's EBITDA bridge/).waitFor();

      await desktop.goto(`${server.baseUrl}/admin/settings?tab=blackout-days`);
      await desktop.getByText('Holiday', { exact: true }).waitFor();
      await desktop.getByRole('button', { name: 'Sat open weekly' }).click();
      await desktop.getByLabel('Blackout date').fill('2026-12-31');
      await desktop.getByLabel('Reason').fill('Office closed');
      await desktop.getByRole('button', { name: 'Block day' }).click();

      await desktop.goto(`${server.baseUrl}/admin/settings?tab=link-library`);
      await desktop.getByText('Synthetic link', { exact: true }).waitFor();
      await desktop.getByLabel('Link name').fill('Synthetic added link');
      await desktop.getByLabel('Link URL').fill('https://example.invalid/added');
      await desktop.getByRole('button', { name: 'Add link' }).click();
      await desktop.getByText(/Synthetic added link added/).waitFor();

      await desktop.goto(`${server.baseUrl}/admin/settings?tab=kpi-targets`);
      await desktop.getByRole('table', { name: 'KPI targets' }).waitFor();
      await desktop.locator('input[aria-label$=" target"]').first().fill('95');
      await desktop.getByRole('button', { name: 'Save targets' }).click();
      await desktop.getByText(/Saved 1 target/).waitFor();

      const writes = report.requests.filter((request) => request.method !== 'GET');
      assert.ok(writes.some((request) => request.path === '/admin/revenue/settings' && request.method === 'PUT'
        && request.body.ovhOfficePayroll === 1750.5));
      assert.ok(writes.some((request) => request.path === '/admin/schedule/blackout-dates/weekly' && request.method === 'PUT'));
      assert.ok(writes.some((request) => request.path === '/admin/schedule/blackout-dates' && request.method === 'POST'
        && request.body.date === '2026-12-31'));
      assert.ok(writes.some((request) => request.path === '/admin/communications/link-library' && request.method === 'POST'
        && request.body.name === 'Synthetic added link'));
      assert.ok(writes.some((request) => request.path === '/admin/kpi-targets' && request.method === 'PUT'
        && request.body.targets.length === 1));
    });

    await scenario('service-report settings preserve both independent save contracts', async () => {
      await desktop.goto(`${server.baseUrl}/admin/settings?tab=service-reports`);
      await desktop.getByText('Service coverage', { exact: true }).waitFor();
      await desktop.getByRole('switch', { name: 'Show map' }).click();
      await desktop.getByRole('button', { name: 'Save settings' }).nth(1).click();
      await desktop.getByText('Service Coverage settings saved.', { exact: true }).waitFor();
      await desktop.getByRole('switch', { name: 'Show duration when reliable' }).click();
      await desktop.getByRole('button', { name: 'Save settings' }).nth(0).click();
      await desktop.getByText('Visit Timeline settings saved.', { exact: true }).waitFor();
      assert.ok(report.requests.some((request) => request.path === '/admin/settings/service-coverage' && request.method === 'PUT'
        && request.body.config.showMap === false));
      assert.ok(report.requests.some((request) => request.path === '/admin/settings/visit-timeline' && request.method === 'PUT'
        && request.body.config.showDuration === false));
      await shot(desktop, 'settings-service-reports-desktop-1440');
    });

    const mobile = await openPage(390);
    await scenario('mobile deep link keeps full settings state without horizontal overflow', async () => {
      await mobile.goto(`${server.baseUrl}/admin/settings?tab=usage`);
      await mobile.getByText('Portal usage', { exact: true }).waitFor();
      await mobile.getByRole('button', { name: '7 days' }).click();
      await Promise.all([
        mobile.waitForResponse((response) => response.url().includes('/api/admin/usage/summary?days=7&scope=all')),
        mobile.getByRole('button', { name: 'Everyone' }).click(),
      ]);
      // Portal Usage is companion-owned; this scenario asserts the deep link,
      // the retained state, and the overflow guard, not the shared foundation.
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await shot(mobile, 'settings-usage-mobile-390');
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
