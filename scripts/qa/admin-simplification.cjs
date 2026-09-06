'use strict';
// SYNTHETIC UI QA. Starts only the managed local frontend. All API requests are
// fulfilled in-browser; unmatched APIs fail, and external requests are blocked.
// No database, provider credentials, jobs, live sends or real records are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, waitForFonts, evidence } = require('./browser');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/simplification/browser');
const runtime = {
  overallStatus: 'critical', generatedAt: new Date().toISOString(),
  summary: { total: 20, failed: 2, errorRate: 0.1, circuitOpenCount: 1, avgDurationMs: 120 },
  agents: [], contexts: [], recentErrors: [],
  alerts: [{ severity: 'critical', title: 'Synthetic runtime failure', detail: 'Inspect the existing agent run.' }],
};
const catalog = { integrations: [{ id: 'fixture-provider', name: 'Synthetic provider', category: 'Messaging',
  description: 'Local test fixture', health: { status: 'expired', label: 'Expired', reason: 'Credential needs attention' } }] };

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), scenarios: [], requests: [], unmatched: [], blockedExternal: [], consoleErrors: [], pageErrors: [], screenshots: [] };
  const server = await previewServer(root);
  const browser = await launchBrowser();
  let stage = 'startup';
  let failCatalog = false;
  async function openPage(role = 'admin', width = 1440) {
    let profileRole = role;
    const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
    await page.addInitScript((userRole) => {
      // Chromium can release keepalive requests after page route handlers
      // detach. Resolve navigation telemetry before it creates a request;
      // the existing adminUsage unit suite verifies beacon contents/dedupe.
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, options) => String(input).endsWith('/admin/usage/track')
        ? Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
        : originalFetch(input, options);
      if (userRole) {
        localStorage.setItem('waves_admin_token', 'synthetic-local-token');
        localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-user', name: 'Fixture operator', role: userRole }));
      }
      // Prevent the PWA registration's expected blocked-worker console error.
      if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: 'synthetic-local-test' });
    }, role);
    page.on('pageerror', (error) => report.pageErrors.push({ stage, message: error.message }));
    page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push({ stage, message: message.text() }); });
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== server.baseUrl) {
        report.blockedExternal.push({ stage, origin: url.origin });
        return route.abort();
      }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const api = url.pathname.slice(4);
      report.requests.push({ stage, method: request.method(), path: api, search: url.search });
      let body;
      let status = 200;
      if (api === '/admin/auth/me') body = { id: 'fixture-user', name: 'Fixture operator', email: 'operator@example.invalid', role: profileRole };
      else if (api === '/admin/auth/login' && request.method() === 'POST') {
        profileRole = 'admin';
        body = { token: 'synthetic-login-token', user: { id: 'fixture-user', name: 'Fixture operator', role: profileRole } };
      }
      else if (api === '/health') body = { status: 'ok', gates: {} };
      else if (api === '/admin/feature-flags') body = { flags: {} };
      else if (api === '/admin/notifications/unread-count') body = { count: 0 };
      else if (api === '/admin/usage/track') body = { ok: true };
      else if (api === '/admin/tool-health') body = runtime;
      else if (api === '/admin/integrations/health') { body = failCatalog ? { error: 'Synthetic unavailable' } : catalog; status = failCatalog ? 503 : 200; }
      else if (api === '/admin/token-health/check' && request.method() === 'POST') body = { ok: true };
      else if (api === '/admin/gbp/locations') body = { locations: [] };
      else if (api === '/admin/settings/linkedin/status') body = { connected: false };
      else if (api === '/admin/agents/control/hub') body = { features: {}, areas: [] };
      else if (api === '/admin/data-hygiene/proposals') body = { proposals: [] };
      else if (api === '/admin/data-hygiene/metrics') body = {};
      else if (api === '/admin/ads/campaigns') body = { campaigns: [] };
      else if (api === '/admin/ads/funnel' || api === '/admin/ads/revenue-attribution') body = {};
      else if (api === '/admin/ads/call-bridge') body = { summary: {}, matches: [] };
      else if (api === '/admin/ads/service-lines') body = { totalLeads: 0 };
      else if (api === '/admin/ads/advisor') body = { report: null };
      else if (api === '/admin/ads/advisor/history') body = { reports: [] };
      else if (api === '/admin/ads/capacity-heatmap') body = { heatmap: {} };
      else if (api === '/admin/seo/dashboard') body = { current: {}, change: {}, topQueries: [], topPages: [], daily: [] };
      else if (api === '/admin/seo/sync-health') body = {};
      else if (api === '/admin/seo/ai-overview') body = { results: [] };
      else if (api === '/admin/seo/rankings') body = { rankings: [] };
      else if (api === '/admin/seo/backlinks') body = { backlinks: [] };
      else if (api === '/admin/customers') body = { customers: [], total: 0, totalPages: 1 };
      else if (api === '/admin/customers/intelligence') body = { totalCustomers: 0, distribution: {}, atRiskCustomers: [], pendingOutreach: [], upsells: [] };
      else if (api === '/admin/communications/log') body = { messages: [], page: 1, hasMore: false };
      else if (api === '/admin/communications/stats') body = {};
      else if (api === '/admin/communications/ai-auto-reply-status') body = { enabled: false };
      else if (api === '/admin/call-recordings/commitments/open') body = { commitments: [], enabled: true, has_more: false };
      else if (api === '/admin/notification-events') body = { events: [], catalog: [] };
      else { status = 404; body = { error: 'Unmatched synthetic fixture' }; report.unmatched.push({ stage, method: request.method(), path: api, search: url.search }); }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    return page;
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
    const page = await openPage();
    await scenario('legacy Team link retains Account identity and URL', async () => {
      await page.goto(`${server.baseUrl}/admin/settings?tab=team&source=bookmark#profile`);
      await page.getByText('Logged In As', { exact: true }).waitFor();
      await page.getByText('operator@example.invalid', { exact: false }).waitFor();
      assert.equal(await page.getByText('Team Members', { exact: true }).count(), 0);
      assert.ok(page.url().endsWith('?tab=team&source=bookmark#profile'));
      await shot(page, 'account-desktop-1440');
      await page.reload();
      await page.getByText('Logged In As', { exact: true }).waitFor();
    });
    await scenario('runtime alerts link to one canonical catalog; keyboard, Back and Forward', async () => {
      await page.goto(`${server.baseUrl}/admin/tool-health`);
      await page.getByText('Synthetic runtime failure', { exact: true }).waitFor();
      const link = page.getByRole('link', { name: 'Settings → Integrations' });
      await link.focus();
      assert.equal(await link.evaluate((element) => document.activeElement === element), true);
      await shot(page, 'tool-health-desktop-1440');
      assert.equal(report.requests.filter((r) => r.stage === stage && r.path === '/admin/integrations/health').length, 0);
      await page.keyboard.press('Enter');
      await page.getByText('Synthetic provider', { exact: true }).waitFor();
      assert.ok(page.url().endsWith('/admin/settings?tab=integrations'));
      await shot(page, 'integrations-desktop-1440');
      const before = report.requests.filter((r) => r.path === '/admin/token-health/check').length;
      await page.getByRole('button', { name: 'Refresh checks' }).click();
      await page.getByRole('button', { name: 'Refresh checks' }).waitFor();
      assert.equal(report.requests.filter((r) => r.path === '/admin/token-health/check').length, before + 1);
      await page.goBack();
      await page.getByText('Synthetic runtime failure', { exact: true }).waitFor();
      await page.goForward();
      await page.getByText('Synthetic provider', { exact: true }).waitFor();
    });
    await scenario('catalog failure stays visible', async () => {
      failCatalog = true;
      await page.reload();
      await page.getByText('Failed to load integrations: HTTP 503', { exact: true }).waitFor();
      failCatalog = false;
    });
    await scenario('digest alias consumes the retained status on direct load and refresh', async () => {
      await page.goto(`${server.baseUrl}/admin/data-hygiene?status=auto_applied&source=notification#evidence`);
      await page.waitForURL('**/admin/agents?**');
      await page.getByRole('button', { name: /auto applied/i, exact: true }).waitFor();
      const url = new URL(page.url());
      assert.equal(url.searchParams.get('tab'), 'hygiene');
      assert.equal(url.searchParams.get('status'), 'auto_applied');
      assert.equal(url.hash, '#evidence');
      assert.ok(report.requests.some((r) => r.stage === stage && r.path === '/admin/data-hygiene/proposals' && r.search.includes('status=auto_applied')));
      await page.reload();
      await page.getByRole('button', { name: /auto applied/i, exact: true }).waitFor();
    });
    await scenario('all six live PPC tabs and live SEO chunk mount', async () => {
      await page.goto(`${server.baseUrl}/admin/ppc`);
      await page.getByRole('button', { name: 'PPC Dashboard', exact: true }).waitFor();
      for (const label of ['Overview', 'Call Bridge', 'Service Lines', 'AI Advisor', 'Capacity', 'PPC Dashboard']) {
        await page.getByRole('button', { name: label, exact: true }).first().click();
      }
      await page.goto(`${server.baseUrl}/admin/seo`);
      await page.getByRole('button', { name: 'AI Visibility', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Organic Rankings', exact: true }).click();
    });
    await scenario('customer and communication labels retain existing tab keys', async () => {
      await page.goto(`${server.baseUrl}/admin/customers`);
      await page.getByRole('button', { name: 'Retention & Upsells', exact: true }).waitFor();
      await shot(page, 'customers-desktop-1440');
      await page.getByRole('button', { name: 'Retention & Upsells', exact: true }).click();
      await page.getByText('0 active customers scanned', { exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('view'), 'intelligence');
      await page.reload();
      await page.getByText('0 active customers scanned', { exact: true }).waitFor();
      await page.goto(`${server.baseUrl}/admin/communications`);
      await page.getByRole('button', { name: 'Message Automations', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Promises', exact: true }).waitFor();
      await shot(page, 'communications-desktop-1440');
      await page.getByRole('button', { name: 'Message Automations', exact: true }).click();
      await page.getByText('Catalog entries: 0', { exact: true }).waitFor();
      await page.goto(`${server.baseUrl}/admin/communications#tab=events`);
      await page.getByText('Catalog entries: 0', { exact: true }).waitFor();
      await page.goto(`${server.baseUrl}/admin/communications#tab=owed`);
      await page.getByRole('button', { name: 'Promises', exact: true }).waitFor();
      await page.getByText('Nothing owed.', { exact: false }).waitFor();
    });
    const mobile = await openPage('admin', 390);
    await scenario('mobile Settings has one Integrations link and retains Account and People', async () => {
      await mobile.goto(`${server.baseUrl}/admin/more`);
      const integrations = mobile.getByRole('link', { name: 'Integrations', exact: true });
      await integrations.waitFor();
      assert.equal(await integrations.count(), 1);
      assert.equal(await mobile.getByRole('link', { name: 'Tap to Pay', exact: true }).count(), 0);
      await mobile.getByRole('link', { name: 'Staff', exact: true }).last().waitFor();
      await mobile.getByRole('link', { name: 'Recruiting', exact: true }).last().waitFor();
      await shot(mobile, 'settings-index-mobile-390');
      await integrations.click();
      await mobile.getByText('Synthetic provider', { exact: true }).waitFor();
      await shot(mobile, 'integrations-mobile-390');
      await mobile.goto(`${server.baseUrl}/admin/settings?tab=team&source=bookmark#profile`);
      await mobile.getByText('Logged In As', { exact: true }).waitFor();
      await shot(mobile, 'account-mobile-390');
      await mobile.goto(`${server.baseUrl}/admin/tool-health`);
      await mobile.getByText('Synthetic runtime failure', { exact: true }).waitFor();
      await shot(mobile, 'tool-health-mobile-390');
      await mobile.goto(`${server.baseUrl}/admin/customers?view=intelligence`);
      await mobile.getByText('0 active customers scanned', { exact: true }).waitFor();
      await shot(mobile, 'customers-mobile-390');
      await mobile.goto(`${server.baseUrl}/admin/communications#tab=owed`);
      await mobile.getByRole('button', { name: 'Promises', exact: true }).waitFor();
      await mobile.getByText('Nothing owed.', { exact: false }).waitFor();
      await shot(mobile, 'communications-mobile-390');
      await mobile.getByRole('button', { name: 'Message Automations', exact: true }).click();
      await mobile.getByText('Catalog entries: 0', { exact: true }).waitFor();
      await shot(mobile, 'communications-automations-mobile-390');
    });
    const tech = await openPage('technician', 390);
    await scenario('technician Settings retain identity and hide owner workflows', async () => {
      await tech.goto(`${server.baseUrl}/admin/more`);
      await tech.getByRole('link', { name: 'Account', exact: true }).waitFor();
      assert.equal(await tech.getByRole('link', { name: 'Recruiting', exact: true }).count(), 0);
      assert.equal(await tech.getByRole('link', { name: 'Integrations', exact: true }).count(), 0);
      await tech.goto(`${server.baseUrl}/admin/settings?tab=integrations`);
      await tech.getByText('Logged In As', { exact: true }).waitFor();
      assert.equal(report.requests.filter((r) => r.stage === stage && r.path === '/admin/integrations/health').length, 0);
      await shot(tech, 'account-technician-mobile-390');
    });
    const guest = await openPage(null);
    await scenario('guest alias returns to its original status and fragment after mocked login', async () => {
      await guest.goto(`${server.baseUrl}/admin/data-hygiene?status=auto_applied#evidence`);
      await guest.waitForURL('**/admin/login?next=**');
      assert.equal(new URL(guest.url()).searchParams.get('next'), '/admin/data-hygiene?status=auto_applied#evidence');
      await guest.locator('input[type="email"]').fill('operator@example.invalid');
      await guest.locator('input[type="password"]').fill('synthetic-test-password');
      await guest.getByRole('button', { name: /sign in/i }).click();
      await guest.waitForURL('**/admin/agents?**');
      await guest.getByRole('button', { name: /auto applied/i, exact: true }).waitFor();
      const url = new URL(guest.url());
      assert.equal(url.searchParams.get('tab'), 'hygiene');
      assert.equal(url.searchParams.get('status'), 'auto_applied');
      assert.equal(url.hash, '#evidence');
      assert.equal(report.requests.filter((r) => r.stage === stage && r.path === '/admin/auth/login').length, 1);
    });
    assert.equal(report.unmatched.length, 0, JSON.stringify(report.unmatched));
    assert.equal(report.pageErrors.length, 0, JSON.stringify(report.pageErrors));
    assert.deepEqual(report.requests.filter((r) => r.method !== 'GET' && ![
      '/admin/usage/track', '/admin/token-health/check', '/admin/auth/login',
    ].includes(r.path)), [], 'No unrequested mutation may execute, even against fixtures.');
    report.passed = true;
  } catch (error) {
    report.failure = { stage, message: error.message };
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    for (const context of browser.contexts()) await context.setOffline(true);
    await browser.close();
    await server.close();
  }
  console.log(`Synthetic admin QA passed: ${report.scenarios.length} scenarios. Evidence: ${path.relative(root, output)}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
