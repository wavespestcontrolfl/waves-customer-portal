'use strict';
// SYNTHETIC UI QA. Reuses the selected checkout's local frontend and fulfills
// every API request in-browser. It never reaches a database or provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, waitForFonts, evidence } = require('./browser');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-tool-health-foundation');
const now = new Date().toISOString();
const runtime = {
  overallStatus: 'critical',
  generatedAt: now,
  summary: { total: 32, failed: 3, errorRate: 0.09375, circuitOpenCount: 1, avgDurationMs: 184 },
  pdfRenderer: { successRate: 0.98, succeeded: 49, terminalFailed: 1, p95LatencyMs: 930 },
  agents: [
    { source: 'primary', label: 'Primary agent', status: 'critical', total: 20, failed: 3, avgDurationMs: 220, lastCallAt: now },
    { source: 'fast', label: 'Fast agent', status: 'ok', total: 12, failed: 0, avgDurationMs: 85, lastCallAt: now },
    { source: 'idle', label: 'Background agent', status: 'idle', total: 0, failed: 0, avgDurationMs: null, lastCallAt: null },
  ],
  contexts: [
    {
      context: 'customer-support', toolsUsed: 2, total: 12, failed: 3, errorRate: 0.25,
      tools: [
        { toolName: 'lookup_customer', source: 'primary', total: 10, failed: 1, errorRate: 0.1, avgDurationMs: 140 },
        { toolName: 'create_followup', source: 'primary', total: 2, failed: 2, errorRate: 1, avgDurationMs: 410 },
      ],
    },
    {
      context: 'scheduling', toolsUsed: 1, total: 8, failed: 0, errorRate: 0,
      tools: [
        { toolName: 'find_slots', source: 'fast', total: 8, failed: 0, errorRate: 0, avgDurationMs: 72 },
      ],
    },
  ],
  recentErrors: [
    { id: 'error-1', at: now, toolName: 'create_followup', context: 'customer-support', circuitOpen: true,
      errorMessage: 'Synthetic long tool failure. '.repeat(10) },
    { id: 'error-2', at: now, toolName: 'lookup_customer', source: 'primary', circuitOpen: false,
      errorMessage: 'Synthetic short failure.' },
  ],
  alerts: [
    { severity: 'critical', title: 'Circuit breaker open', detail: 'Primary calls require attention.' },
    { severity: 'warning', title: 'Latency elevated', detail: 'Fast calls remain available.' },
  ],
};

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = {
    ...evidence(root),
    scenarios: [],
    requests: [],
    unmatched: [],
    blockedExternal: [],
    consoleErrors: [],
    pageErrors: [],
    screenshots: [],
  };
  let server;
  let browser;
  let stage = 'startup';
  let failHealth = false;

  async function openPage(role, width) {
    const page = await browser.newPage({
      viewport: { width, height: 1000 },
      timezoneId: 'America/New_York',
      serviceWorkers: 'block',
    });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
    await page.addInitScript((userRole) => {
      localStorage.setItem('waves_admin_token', 'synthetic-local-token');
      localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-user', name: 'Fixture operator', role: userRole }));
      if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: 'synthetic-local-test' });
    }, role);
    page.on('pageerror', (error) => report.pageErrors.push({ stage, message: error.message }));
    page.on('console', (message) => {
      const expectedFailure = stage === 'failed read presents safe retry'
        && message.text().includes('503 (Service Unavailable)');
      if (message.type() === 'error' && !expectedFailure) {
        report.consoleErrors.push({ stage, message: message.text() });
      }
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
      report.requests.push({ stage, method: request.method(), path: api, search: url.search });
      let body;
      let status = 200;
      if (api === '/admin/auth/me') body = { id: 'fixture-user', name: 'Fixture operator', role };
      else if (api === '/admin/tool-health') {
        body = failHealth ? { error: 'Synthetic tool health unavailable' } : runtime;
        status = failHealth ? 503 : 200;
      } else if (api === '/health') body = { status: 'ok', gates: {} };
      else if (api === '/admin/feature-flags') body = { flags: {} };
      else if (api === '/admin/notifications/unread-count') body = { count: 0 };
      else if (api === '/admin/communications/unread-count') body = { conversations: 0, messages: 0 };
      else if (api === '/admin/usage/track') body = { ok: true };
      else {
        status = 404;
        body = { error: 'Unmatched synthetic fixture' };
        report.unmatched.push({ stage, method: request.method(), path: api, search: url.search });
      }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    return page;
  }

  async function shot(page, name) {
    await waitForFonts(page);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      for (const element of document.querySelectorAll('*')) {
        if (element.scrollHeight > element.clientHeight) element.scrollTop = 0;
        if (element.scrollWidth > element.clientWidth) element.scrollLeft = 0;
      }
    });
    const file = path.join(output, `${name}.png`);
    await page.screenshot({ path: file });
    report.screenshots.push({
      name,
      file: path.relative(root, file),
      width: page.viewportSize().width,
      overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    });
  }

  async function assertFoundation(page) {
    const surface = page.locator('[data-ui-density="comfortable"]');
    await surface.waitFor();
    assert.equal(await surface.locator('[style]').count(), 0, 'page-local inline styles must be absent');
    const undersizedText = await surface.evaluate((rootElement) => Array.from(rootElement.querySelectorAll('*'))
      .filter((element) => element.children.length === 0 && element.textContent.trim() && getComputedStyle(element).display !== 'none')
      .map((element) => ({ text: element.textContent.trim().slice(0, 80), size: parseFloat(getComputedStyle(element).fontSize) }))
      .filter((item) => item.size < 14));
    assert.deepEqual(undersizedText, [], `readable text below 14px: ${JSON.stringify(undersizedText)}`);
    const undersizedControls = await surface.evaluate((rootElement) => Array.from(rootElement.querySelectorAll('button, a[href]'))
      .filter((element) => getComputedStyle(element).display !== 'none')
      .map((element) => ({ name: element.textContent.trim(), height: element.getBoundingClientRect().height }))
      .filter((item) => item.height < 44));
    assert.deepEqual(undersizedControls, [], `controls below 44px: ${JSON.stringify(undersizedControls)}`);
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
    const desktop = await openPage('admin', 1440);
    await scenario('desktop runtime, request parity and expandable details', async () => {
      await desktop.goto(`${server.baseUrl}/admin/tool-health`);
      await desktop.getByRole('heading', { name: 'Tool health', level: 1 }).waitFor();
      await desktop.getByText('Circuit breaker open', { exact: true }).waitFor();
      assert.ok(report.requests.some((request) => request.path === '/admin/tool-health' && request.search === '?hours=24'));
      assert.equal(await desktop.getByRole('link', { name: 'Settings → Integrations' }).count(), 1);
      await assertFoundation(desktop);
      await shot(desktop, 'tool-health-desktop-1440');
      const failingContext = desktop.locator('[aria-controls="tool-context-0"]');
      assert.equal(await failingContext.getAttribute('aria-expanded'), 'true');
      assert.equal(await desktop.getByRole('table', { name: 'customer-support tool health' }).count(), 1);
      const healthyContext = desktop.locator('[aria-controls="tool-context-1"]');
      assert.equal(await healthyContext.getAttribute('aria-expanded'), 'false');
      await healthyContext.focus();
      await desktop.keyboard.press('Enter');
      await desktop.getByRole('table', { name: 'scheduling tool health' }).waitFor();
      const errorRow = desktop.getByRole('button', { name: /Synthetic long tool failure/ });
      assert.equal(await errorRow.getAttribute('aria-expanded'), 'false');
      await errorRow.click();
      assert.equal(await errorRow.getAttribute('aria-expanded'), 'true');
      await Promise.all([
        desktop.waitForResponse((response) => response.url().endsWith('/api/admin/tool-health?hours=1')),
        desktop.getByRole('button', { name: '1h' }).click(),
      ]);
    });

    await scenario('failed read presents safe retry', async () => {
      failHealth = true;
      await desktop.reload();
      await desktop.getByText('Failed to load: HTTP 503', { exact: true }).waitFor();
      await desktop.getByRole('button', { name: 'Try again' }).waitFor();
      failHealth = false;
      await desktop.getByRole('button', { name: 'Try again' }).click();
      await desktop.getByText('Circuit breaker open', { exact: true }).waitFor();
    });

    const mobile = await openPage('admin', 390);
    await scenario('mobile layout preserves the full runtime without overflow', async () => {
      await mobile.goto(`${server.baseUrl}/admin/tool-health`);
      await mobile.getByText('Circuit breaker open', { exact: true }).waitFor();
      await assertFoundation(mobile);
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await shot(mobile, 'tool-health-mobile-390');
    });

    assert.deepEqual(report.unmatched, []);
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
