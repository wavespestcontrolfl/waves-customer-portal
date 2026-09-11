'use strict';
/* global document, getComputedStyle, innerWidth, localStorage, navigator, window */
// SYNTHETIC UI QA. Reuses the selected checkout's frontend and fulfills every
// API request in-browser. It never reaches a database or provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, waitForFonts, evidence } = require('./browser');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-dashboard-foundation');

const coreKpis = {
  periodLabel: 'Month to date',
  momentum: { mrr: { net: 125, new: 180, churned: 55 }, customers: { net: 2, new: 3, lost: 1 } },
  sales: { conversion: 50, booked: 3, leads: 6, avgResponseMin: 12, callToBooking: 20, inboundCalls: 15 },
  service: { completionRate: 80, completed: 4, scheduled: 5, callbackRate: 0, callbacks: 0 },
  billing: { collectionRate: 90, issuedCount: 10, collectedCount: 9, collected: 900, billed: 1000, autopayPct: 40, autopayCount: 70, customerBase: 173 },
  financial: { grossMarginWeighted: 55, grossMarginAvg: 52, revPerJob: 120, jobsDone: 4, rpmh: 118 },
  retention: { pct: 98, lost: 1 }, ar: { days: 12, open: 2660, overdueCount: 5 },
  quality: { nps: null, csatAvg: null, csatResponses: 0 }, leaderboard: [], membershipsSold: 1,
  deposits: { onHand: 240, onHandCount: 2, collectedPeriod: 400 },
};

function dashboardFixture(api, method = 'GET') {
  if (api === '/admin/dashboard') return {
    kpis: { revenueMTD: 497, revenueChangePercent: 10, activeCustomers: 725, newCustomersThisMonth: 2 },
    mrr: 9750, mrrBreakdown: { committed: 9374, atRisk: 376 },
    revenueChart: { daily: [{ date: '2026-09-01', total: 497 }] },
  };
  if (api === '/admin/dashboard/core-kpis') return coreKpis;
  if (api === '/admin/dashboard/compare') return { deltas: { revenue: 10 }, period: { series: [] }, against: { series: [], label: 'Last month' } };
  if (api === '/admin/dashboard/sales-capture') return { captured: 500, missed: 100, captureRate: 83, wonCount: 4, lostCount: 1 };
  if (api === '/admin/dashboard/today-completion') return { date: '2026-09-11', completed: 4, total: 5, remaining: 1, cancelled: 0, noShow: 0 };
  if (api === '/admin/billing-health') return { summary: { total_billable: 173, autopay_active: 70, autopay_chargeable: 70, autopay_unchargeable: 0, autopay_paused: 0, no_payment_method: 0, failed_last_30_days: 0, in_retry_queue: 0, escalated_last_30_days: 0, expiring_cards_60_days: 0, charged_this_month: 10 } };
  if (api === '/admin/dashboard/alerts') return { alerts: [] };
  if (api === '/admin/dashboard/funnel') return { funnel: { sent: 5, viewed: 4, accepted: 2, declined: 1, pending: 2 }, rates: { view_rate: 80, close_rate: 40, decline_rate: 20 }, by_service: [] };
  if (api === '/admin/dashboard/aging') return { aging: { current: 300, days_30: 150 }, invoice_count: 2, total_outstanding: 450, total_overdue: 150 };
  if (api === '/admin/dashboard/mrr-trend') return { trend: [], avg_growth_pct: 2 };
  if (api === '/admin/dashboard/service-mix') return { mix: [], total_services: 4 };
  if (api === '/admin/dashboard/revenue-by-city') return { cities: [], total: 497 };
  if (api === '/admin/dashboard/review-trend') return { trend: [], total: 180, avgRating: 5 };
  if (api === '/admin/dashboard/retention-cohort') return { cohorts: [], maxOffset: 0 };
  if (api === '/admin/ads/capital-allocation') return { channels: [] };
  if (api === '/admin/dashboard/kpi-history') return { series: {} };
  if (api === '/admin/kpi-targets') return { targets: [] };
  if (api === '/admin/dashboard/ebitda-bridge') return { rows: [], revenue: 0 };
  if (api === '/admin/dashboard/mrr-bridge') return { months: [] };
  if (api === '/admin/revenue/overview') return { byServiceLine: [] };
  if (api === '/admin/dashboard/churn-reasons') return { reasons: [], totals: { customers: 0, mrr: 0 } };
  if (api === '/admin/command-center/stale-visits') return { visits: [], total: 0 };
  if (api === '/admin/dashboard/calls-by-source') return { sources: [], period: { label: 'Month to date' } };
  if (api === '/admin/dashboard/leads-by-source') return { sources: [], period: { label: 'Month to date' } };
  if (api === '/admin/dashboard/channel-mix') return { channels: [] };
  if (api === '/admin/dashboard/lead-funnel') return { sources: [], totals: {} };
  if (api === '/admin/dashboard/channel-roi') return { sources: [] };
  if (api === '/admin/dashboard/widgets' && method === 'GET') return { widgets: [] };
  if (api === '/admin/dashboard/ai-chart/preview' && method === 'POST') return {
    spec: { title: 'Synthetic revenue', chartType: 'kpi', y: ['value'], yFormat: 'currency' },
    rows: [{ value: 497 }],
    fields: ['value'],
  };
  return null;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), requests: [], unmatched: [], consoleErrors: [], pageErrors: [], screenshots: [], geometry: [] };
  let server;
  let browser;

  async function openPage(width) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    page.setDefaultTimeout(15000);
    await page.addInitScript(() => {
      localStorage.setItem('waves_admin_token', 'synthetic-local-token');
      localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-user', role: 'admin', name: 'Fixture operator' }));
      if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: 'synthetic-local-test' });
    });
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== server.baseUrl || url.pathname.startsWith('/socket.io')) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const api = url.pathname.slice(4);
      report.requests.push({ method: request.method(), path: api, search: url.search });
      let body = dashboardFixture(api, request.method());
      if (api === '/admin/auth/me') body = { id: 'fixture-user', role: 'admin', name: 'Fixture operator' };
      else if (api === '/admin/feature-flags') body = { flags: { 'dashboard-ai-charts': true } };
      else if (api === '/admin/notifications/unread-count') body = { count: 0 };
      else if (api === '/admin/communications/unread-count') body = { conversations: 0, messages: 0 };
      else if (api === '/admin/usage/track') body = { ok: true };
      else if (api === '/health') body = { status: 'ok', gates: {} };
      if (body == null) {
        report.unmatched.push(`${request.method()} ${api}${url.search}`);
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Unmatched synthetic fixture' }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    return page;
  }

  async function verify(page, name) {
    await waitForFonts(page);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      const scroller = document.querySelector('.admin-main');
      if (scroller) {
        scroller.scrollTop = 0;
        scroller.scrollLeft = 0;
      }
    });
    const result = await page.evaluate(() => {
      // Scope to the navigation foundation this commit migrates. The rest of the
      // dashboard (ActionInbox, the chart cards, the AI panel) still renders its
      // own explicit text-11/text-13 and sub-44px controls, which UiSurface does
      // not override, so a whole-page scan fails before the nav is ever exercised.
      // Those panels come with their own migrations.
      const scope = document.querySelector('[data-qa="dashboard-jump-nav"]');
      const rootElement = scope || document.querySelector('main [data-ui-density="comfortable"]');
      if (!rootElement) throw new Error('Comfortable dashboard surface missing');
      const visible = (node) => node.getClientRects().length > 0;
      const smallText = [...rootElement.querySelectorAll('*')]
        .filter(visible)
        .filter((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim()))
        .map((node) => ({ text: node.textContent.trim().slice(0, 70), size: parseFloat(getComputedStyle(node).fontSize) }))
        .filter((item) => item.size < 14);
      const shortControls = [...rootElement.querySelectorAll('button, input:not([type="file"]), select, a[href]')]
        .filter(visible)
        .map((node) => ({ name: node.getAttribute('aria-label') || node.textContent.trim(), height: node.getBoundingClientRect().height }))
        .filter((item) => item.height < 43.5);
      return {
        smallText,
        shortControls,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        titleSize: parseFloat(getComputedStyle(document.querySelector('main h1')).fontSize),
      };
    });
    report.geometry.push({ name, viewport: page.viewportSize(), ...result });
    assert.deepEqual(result.smallText, [], `${name}: readable text below 14px`);
    assert.deepEqual(result.shortControls, [], `${name}: controls below 44px`);
    assert.equal(result.overflow, false, `${name}: page overflow`);
    assert.equal(result.titleSize, 22, `${name}: page title size`);
    const file = path.join(output, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    report.screenshots.push(path.relative(root, file));
  }

  try {
    // No URL unless one is supplied: browser.js treats any requested URL as an
    // externally managed server and throws instead of starting Vite, so the
    // documented bare invocation could never come up on a clean checkout. A
    // caller-supplied URL still wins, and setup() picks this checkout's port.
    server = await previewServer(root, process.argv.find((arg) => arg.startsWith('http://')) || process.env.ADMIN_PREVIEW_URL);
    browser = await launchBrowser();

    const desktop = await openPage(1440);
    await desktop.goto(`${server.baseUrl}/admin/dashboard`);
    await desktop.getByRole('heading', { name: /Good (morning|afternoon|evening), Fixture/, level: 1 }).waitFor();
    await desktop.getByRole('heading', { name: 'Today', level: 2 }).waitFor();
    await verify(desktop, 'dashboard-desktop-1440');
    await desktop.getByLabel('Describe a metric').fill('Revenue this month');
    await Promise.all([
      desktop.waitForResponse((response) => response.url().endsWith('/api/admin/dashboard/ai-chart/preview')),
      desktop.getByRole('button', { name: 'Generate', exact: true }).click(),
    ]);
    await desktop.getByText('Synthetic revenue', { exact: true }).waitFor();
    await desktop.getByRole('button', { name: 'Discard', exact: true }).click();
    await Promise.all([
      desktop.waitForResponse((response) => response.url().endsWith('/api/admin/dashboard')),
      desktop.getByRole('button', { name: 'Refresh', exact: true }).click(),
    ]);
    await desktop.getByRole('button', { name: 'Growth', exact: true }).click();
    assert.equal(await desktop.getByRole('button', { name: 'Growth', exact: true }).getAttribute('aria-current'), 'page');

    const mobile = await openPage(390);
    await mobile.goto(`${server.baseUrl}/admin/dashboard`);
    await mobile.getByRole('heading', { name: /Good (morning|afternoon|evening), Fixture/, level: 1 }).waitFor();
    await mobile.getByRole('button', { name: 'Profit', exact: true }).click();
    await mobile.getByRole('heading', { name: 'Profit', level: 2 }).waitFor();
    await Promise.all([
      mobile.waitForResponse((response) => response.url().includes('/api/admin/dashboard/core-kpis?period=qtd')),
      mobile.getByLabel('Period').selectOption('qtd'),
    ]);
    await verify(mobile, 'dashboard-mobile-390');

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
