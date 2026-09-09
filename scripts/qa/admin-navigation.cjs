'use strict';
// Runs the real frontend with synthetic responses. No backend or real account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, waitForFonts, evidence } = require('./browser');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-navigation/browser');

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), checks: [], requests: [], unmatched: [], pageErrors: [], screenshots: [] };
  let server;
  let browser;
  const check = (name, condition) => { assert.ok(condition, name); report.checks.push(name); };
  async function openPage({ width = 1440, role = 'admin', enabled = true, hasTouch = false } = {}) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch, serviceWorkers: 'block' });
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('waves_admin_token', 'synthetic-local-token');
      const fetchOriginal = window.fetch.bind(window);
      window.fetch = (input, options) => String(input).endsWith('/admin/usage/track')
        ? Promise.resolve(new Response('{}', { status: 200 })) : fetchOriginal(input, options);
      if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: 'synthetic-local-test' });
    });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== server.baseUrl) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const api = url.pathname.slice(4);
      report.requests.push({ path: api, method: route.request().method() });
      const fixtures = {
        '/health': { status: 'ok', gates: {} },
        '/admin/auth/me': { id: `fixture-${role}`, name: 'Fixture operator', role },
        '/admin/feature-flags': { flags: { 'admin-navigation': enabled } },
        '/admin/notifications/unread-count': { count: 0 },
        '/admin/communications/unread-count': { conversations: role === 'admin' ? 5 : 0 },
        '/admin/usage/track': { ok: true },
        '/admin/customers': { customers: [], total: 0, totalPages: 1 },
        '/admin/customers/intelligence': { totalCustomers: 0, distribution: {}, atRiskCustomers: [], pendingOutreach: [], upsells: [] },
        '/admin/leads': { leads: [], total: 0, stats: {} },
        '/admin/estimates': { estimates: [], total: 0, stats: {} },
        '/admin/estimates/win-loss-slices': { slices: [] },
        '/admin/estimates/source-performance': { sources: [] },
      };
      if (!Object.hasOwn(fixtures, api)) {
        report.unmatched.push(api);
        return route.fulfill({ status: 404, json: { error: 'Unmatched synthetic API' } });
      }
      return route.fulfill({ json: fixtures[api] });
    });
    return page;
  }
  async function shot(page, name) {
    await waitForFonts(page);
    await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
    report.screenshots.push(name);
  }
  try {
    server = await previewServer(root);
    browser = await launchBrowser();
    const desktop = await openPage();
    await desktop.goto(`${server.baseUrl}/admin/customers`);
    const nav = desktop.getByRole('navigation', { name: 'Admin workspaces' });
    await nav.waitFor();
    await desktop.getByRole('heading', { name: 'Customers', exact: true }).waitFor();
    await desktop.getByRole('button', { name: 'Collapse Customers' }).click();
    await shot(desktop, 'desktop-1440');
    check('12 workspace rows at rest', await nav.locator(':scope > div > div').count() === 11 && await desktop.getByRole('link', { name: 'Settings', exact: true }).count() === 1);
    await desktop.getByRole('button', { name: 'Operations', exact: true }).click();
    await desktop.getByRole('link', { name: 'Inventory', exact: true }).waitFor();
    check('Operations opens without navigating', new URL(desktop.url()).pathname === '/admin/customers');
    await desktop.reload();
    await desktop.getByRole('link', { name: 'Inventory', exact: true }).waitFor();
    check('Expansion survives reload', true);
    await desktop.getByRole('button', { name: 'Operations', exact: true }).click();
    await desktop.getByRole('button', { name: 'Collapse Customers' }).click();
    await desktop.setViewportSize({ width: 1366, height: 768 });
    const fits = await nav.evaluate((el) => el.scrollHeight <= el.clientHeight);
    check('At-rest menu fits 1366 by 768', fits);
    await desktop.getByRole('button', { name: 'Expand Sales' }).click();
    await desktop.getByRole('link', { name: 'Estimates', exact: true }).click();
    await desktop.waitForURL('**/admin/pipeline?tab=estimates');
    await desktop.getByRole('heading', { name: 'Pipeline', exact: true }).first().waitFor();
    check('Estimates link selects the rendered Estimates tab', await desktop.getByRole('link', { name: 'Estimates', exact: true }).getAttribute('aria-current') === 'page');

    for (const width of [700, 820, 1024, 1440]) {
      await desktop.setViewportSize({ width, height: 900 });
      if (width < 768) await desktop.getByRole('button', { name: 'Open menu' }).click();
      const row = desktop.getByRole('link', { name: 'Sales', exact: true });
      const height = (await row.boundingBox()).height;
      check(`Fine pointer target at ${width}`, height >= (width < 1024 ? 44 : 36));
    }
    const touch = await openPage({ width: 1440, hasTouch: true });
    await touch.goto(`${server.baseUrl}/admin/customers`);
    const touchRow = touch.getByRole('link', { name: 'Sales', exact: true });
    await touchRow.waitFor();
    check('Coarse pointer desktop keeps 44px targets', (await touchRow.boundingBox()).height >= 44);

    const mobile = await openPage({ width: 390, hasTouch: true });
    await mobile.goto(`${server.baseUrl}/admin/more`);
    await mobile.getByRole('heading', { name: 'Workspaces', exact: true }).waitFor();
    check('Mobile keeps all settings leaves', await mobile.getByRole('link', { name: 'Early feature access' }).count() === 1 && await mobile.getByRole('link', { name: 'Portal Usage' }).count() === 1);
    await shot(mobile, 'mobile-directory-390');
    await mobile.getByRole('button', { name: 'Open menu' }).click();
    const drawer = mobile.getByRole('dialog', { name: 'Admin menu' });
    await drawer.waitFor();
    await mobile.waitForTimeout(240);
    await shot(mobile, 'mobile-drawer-390');
    await mobile.keyboard.press('Shift+Tab');
    check('Drawer traps keyboard focus', await drawer.evaluate((el) => el.contains(document.activeElement)));
    await mobile.keyboard.press('Escape');
    check('Escape restores menu trigger', await mobile.getByRole('button', { name: 'Open menu' }).evaluate((el) => el === document.activeElement));
    check('Hidden drawer is inert', await mobile.locator('#admin-sidebar').getAttribute('inert') !== null);
    check('No horizontal mobile overflow', await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

    const tech = await openPage({ width: 390, role: 'technician', hasTouch: true });
    await tech.goto(`${server.baseUrl}/admin/more`);
    await tech.getByRole('heading', { name: 'Workspaces', exact: true }).waitFor();
    check('Technician directory excludes owner-only destinations', await tech.getByRole('button', { name: 'Sales', exact: true }).count() === 0 && await tech.getByRole('link', { name: 'Early feature access' }).count() === 0);
    const legacy = await openPage({ enabled: false });
    await legacy.goto(`${server.baseUrl}/admin/customers`);
    await legacy.getByRole('navigation', { name: 'Admin sections' }).waitFor();
    check('Flag off retains existing navigation', await legacy.getByRole('navigation', { name: 'Admin workspaces' }).count() === 0);
    check('No browser render errors', report.pageErrors.length === 0);
  } finally {
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
    await browser?.close();
    await server?.close();
  }
  process.stdout.write(`${report.checks.length} browser checks passed; evidence: ${output}\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
