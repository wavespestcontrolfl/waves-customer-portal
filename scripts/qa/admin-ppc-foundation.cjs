'use strict';
/* global document, getComputedStyle, innerWidth, localStorage, navigator, window */
// SYNTHETIC UI QA. Every API request is fulfilled in-browser; no database or
// advertising provider is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, waitForFonts, evidence } = require('./browser');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-ppc-foundation');
async function connectPreview(url) {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try { return await previewServer(root, url); }
    catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError;
}
const campaign = {
  id: 1, campaign_name: 'Bradenton Pest Control', platform: 'google_ads', campaign_type: 'SEARCH',
  service_category: 'Pest Control', target_area: 'Bradenton', status: 'active',
  daily_budget_current: 100, recommended_daily_budget: 110,
  last7d: { spend: 500, conversionValue: 2500, conversions: 20, clicks: 100, impressions: 2500 },
  last30d: { spend: 2000, conversionValue: 9000, conversions: 75, clicks: 410, impressions: 9800 },
};
const campaigns = [
  campaign,
  // The dashboard's existing platform split recognizes these legacy/manual
  // campaign_type keys. Keep the synced Google Ads SEARCH row above as well:
  // this visual QA must not hide the production-sync normalization mismatch.
  { ...campaign, id: 2, campaign_name: 'Venice Pest Control', platform: 'manual', campaign_type: 'google_search' },
  {
    ...campaign,
    id: 3,
    campaign_name: 'Sarasota Lawn Care',
    platform: 'google_lsa',
    campaign_type: 'google_lsa',
    service_category: 'Lawn Care',
    target_area: 'Sarasota',
    last7d: { spend: 200, conversionValue: 800, conversions: 7, clicks: 30, impressions: 700 },
    last30d: { spend: 750, conversionValue: 3200, conversions: 26, clicks: 120, impressions: 2800 },
  },
];

function fixture(api, method, { emptyCampaigns = false } = {}) {
  if (api === '/admin/ads/campaigns') return { campaigns: emptyCampaigns ? [] : campaigns };
  if (api === '/admin/ads/funnel?period=30d') {
    return { funnel: { lead: 75, booked: 52, completed: 41 }, totalLeads: 75, totalRevenue: 9000, roas: 4.5 };
  }
  if (api === '/admin/ads/revenue-attribution?period=month') {
    return { totalRevenue: 9000, sources: [{ source: 'Google Ads', revenue: 6500, roas: 4.2 }, { source: 'Local Service Ads', revenue: 2500, roas: 5.1 }] };
  }
  if (api === '/admin/ads/call-bridge?period=30d') return { summary: { total: 0, ready: 0, ambiguous: 0, unmatched: 0 }, matches: [] };
  if (api === '/admin/ads/service-lines?period=30d') return { totalLeads: 0, serviceLines: [], lines: [] };
  if (api === '/admin/ads/advisor') return { report: null };
  if (api === '/admin/ads/advisor/history') return { reports: [] };
  if (api === '/admin/ads/advisor/generate' && method === 'POST') return { report: null };
  if (api === '/admin/ads/capacity-heatmap') return { heatmap: {} };
  return undefined;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), requests: [], fallbackFixtures: [], consoleErrors: [], pageErrors: [], screenshots: [], geometry: [] };
  let server;
  let browser;

  async function openPage(width, fixtureOptions = {}) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    page.setDefaultTimeout(60000);
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
      if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      if (url.origin !== server.baseUrl || url.pathname.startsWith('/socket.io')) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const api = url.pathname.slice(4);
      report.requests.push({ method: request.method(), path: api, search: url.search });
      let body = fixture(`${api}${url.search}`, request.method(), fixtureOptions);
      if (api === '/admin/auth/me') body = { id: 'fixture-user', role: 'admin', name: 'Fixture operator' };
      else if (api === '/admin/feature-flags') body = { flags: {} };
      else if (api === '/admin/notifications/unread-count') body = { count: 0 };
      else if (api === '/admin/communications/unread-count') body = { conversations: 0, messages: 0 };
      else if (api === '/admin/usage/track') body = { ok: true };
      else if (api === '/health') body = { status: 'ok', gates: {} };
      if (body === undefined) { report.fallbackFixtures.push(`${request.method()} ${api}${url.search}`); body = {}; }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    return page;
  }

  async function verify(page, name) {
    await waitForFonts(page);
    await page.locator('#admin-main').evaluate((element) => element.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    await page.waitForTimeout(150);
    const result = await page.evaluate(() => {
      const rootElement = document.querySelector('main .ads-page[data-ui-density="comfortable"]');
      if (!rootElement) throw new Error('Comfortable PPC surface missing');
      const visible = (node) => node.getClientRects().length > 0;
      const smallText = [...rootElement.querySelectorAll('*')]
        .filter(visible)
        .filter((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim()))
        .map((node) => ({ text: node.textContent.trim().slice(0, 70), size: parseFloat(getComputedStyle(node).fontSize) }))
        .filter((item) => item.size < 14);
      const shortControls = [...rootElement.querySelectorAll('button, input:not([type="file"]), select, textarea, a[href]')]
        .filter(visible)
        .map((node) => ({ name: node.getAttribute('aria-label') || node.textContent.trim().slice(0, 60), height: node.getBoundingClientRect().height }))
        .filter((item) => item.height < 43.5);
      const dashboard = rootElement.querySelector('[data-qa="ppc-dashboard"]');
      const donutCenterSizes = dashboard
        ? [...dashboard.querySelectorAll('[data-qa="donut-center-value"]')].filter(visible).map((node) => parseFloat(getComputedStyle(node).fontSize))
        : [];
      const revenueMetrics = dashboard
        ? [...dashboard.querySelectorAll('[data-metric="revenue"]')].filter(visible).map((node) => ({ text: node.textContent.trim(), color: getComputedStyle(node).color }))
        : [];
      const roasMetrics = dashboard
        ? [...dashboard.querySelectorAll('[data-metric="roas"]')].filter(visible).map((node) => ({ text: node.textContent.trim(), color: getComputedStyle(node).color }))
        : [];
      const luminance = (color) => {
        const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      const contrast = (a, b) => {
        const [lighter, darker] = [luminance(a), luminance(b)].sort((left, right) => right - left);
        return (lighter + 0.05) / (darker + 0.05);
      };
      const barContrasts = dashboard
        ? [...dashboard.querySelectorAll('[data-qa="metric-bar"]')].filter(visible).map((bar) => {
          const valueColor = getComputedStyle(bar.querySelector('[data-qa="metric-bar-value"]')).color;
          const fillColor = getComputedStyle(bar.querySelector('[data-qa="metric-bar-fill"]')).backgroundColor;
          return { valueColor, fillColor, ratio: contrast(valueColor, fillColor) };
        })
        : [];
      return { smallText, shortControls, donutCenterSizes, revenueMetrics, roasMetrics, barContrasts, overflow: document.documentElement.scrollWidth > innerWidth + 1, titleSize: parseFloat(getComputedStyle(rootElement.querySelector('h1')).fontSize) };
    });
    report.geometry.push({ name, viewport: page.viewportSize(), ...result });
    assert.deepEqual(result.smallText, [], `${name}: readable text below 14px`);
    assert.deepEqual(result.shortControls, [], `${name}: controls below 44px`);
    assert.ok(result.donutCenterSizes.every((size) => size === 22), `${name}: donut center value below 22px`);
    assert.ok(result.revenueMetrics.every((metric) => ['rgb(24, 24, 27)', 'rgb(39, 39, 42)'].includes(metric.color)), `${name}: non-zinc revenue metric ${JSON.stringify(result.revenueMetrics)}`);
    assert.ok(result.roasMetrics.every((metric) => ['rgb(24, 24, 27)', 'rgb(39, 39, 42)', 'rgb(82, 82, 91)'].includes(metric.color)), `${name}: non-zinc normal ROAS metric ${JSON.stringify(result.roasMetrics)}`);
    assert.ok(result.barContrasts.every((bar) => bar.ratio >= 4.5), `${name}: metric bar contrast below 4.5 ${JSON.stringify(result.barContrasts)}`);
    assert.equal(result.overflow, false, `${name}: page overflow`);
    assert.equal(result.titleSize, 22, `${name}: page title size`);
    const file = path.join(output, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    report.screenshots.push(path.relative(root, file));
  }

  try {
    // No URL unless one is actually supplied: browser.js treats any requested
    // URL as an externally managed server and throws rather than starting Vite,
    // so the documented bare invocation could never come up on a clean checkout.
    server = await connectPreview(process.env.ADMIN_PREVIEW_URL);
    browser = await launchBrowser();
    const desktop = await openPage(1440);
    await desktop.goto(`${server.baseUrl}/admin/ppc`);
    await desktop.getByRole('heading', { name: 'PPC', level: 1 }).waitFor();
    await desktop.getByRole('heading', { name: 'Waves PPC command center', level: 2 }).waitFor();
    for (const view of ['Overview', 'Campaigns', 'Funnel & Attribution']) {
      console.log(`Checking dashboard view: ${view}`);
      const button = desktop.locator('#admin-main').getByRole('button', { name: view, exact: true }).last();
      await button.evaluate((element) => element.click());
      await desktop.waitForTimeout(200);
      await verify(desktop, `ppc-dashboard-${view.toLowerCase().replaceAll(' ', '-').replaceAll('&', 'and')}-1440`);
    }
    assert.ok(report.geometry.filter((entry) => entry.name.startsWith('ppc-dashboard-')).every((entry) => entry.revenueMetrics.length > 0));
    assert.ok(report.geometry.find((entry) => entry.name === 'ppc-dashboard-overview-1440').revenueMetrics.every((entry) => entry.text !== '$0.00'));
    const nav = desktop.getByRole('navigation', { name: 'PPC section' });
    for (const section of ['Overview', 'Call Bridge', 'Service Lines', 'AI Advisor', 'Capacity']) {
      console.log(`Checking workspace: ${section}`);
      const tab = nav.getByRole('button', { name: section, exact: true });
      await tab.evaluate((element) => element.click());
      await desktop.waitForFunction((label) => {
        const node = [...document.querySelectorAll('nav[aria-label="PPC section"] button')].find((button) => button.textContent.trim() === label);
        return node?.getAttribute('aria-current') === 'page';
      }, section);
      await desktop.waitForTimeout(150);
      await verify(desktop, `ppc-${section.toLowerCase().replaceAll(' ', '-')}-1440`);
    }

    const mobile = await openPage(390);
    await mobile.goto(`${server.baseUrl}/admin/ppc`);
    await mobile.getByRole('heading', { name: 'PPC', level: 1 }).waitFor();
    await mobile.getByRole('heading', { name: 'Waves PPC command center', level: 2 }).waitFor();
    await verify(mobile, 'ppc-dashboard-390');
    const mobileNav = mobile.getByRole('navigation', { name: 'PPC section' });
    for (const section of ['Overview', 'Call Bridge', 'Service Lines', 'AI Advisor', 'Capacity']) {
      console.log(`Checking mobile workspace: ${section}`);
      await mobileNav.getByRole('button', { name: section, exact: true }).evaluate((element) => element.click());
      await mobile.waitForFunction((label) => {
        const node = [...document.querySelectorAll('nav[aria-label="PPC section"] button')].find((button) => button.textContent.trim() === label);
        return node?.getAttribute('aria-current') === 'page';
      }, section);
      await mobile.waitForTimeout(150);
      await verify(mobile, `ppc-${section.toLowerCase().replaceAll(' ', '-')}-390`);
    }

    for (const width of [1440, 390]) {
      const empty = await openPage(width, { emptyCampaigns: true });
      await empty.goto(`${server.baseUrl}/admin/ppc`);
      const emptyTitle = empty.getByText('No Campaigns Yet', { exact: true });
      await emptyTitle.waitFor();
      assert.equal(await emptyTitle.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)), 18);
      await verify(empty, `ppc-dashboard-empty-${width}`);
    }

    assert.deepEqual(report.fallbackFixtures, []);
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

main().catch((error) => { console.error(error); process.exitCode = 1; });
