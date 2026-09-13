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
  id: 1, campaign_name: 'Bradenton Pest Control', platform: 'google_ads', campaign_type: '2',
  service_category: 'Pest Control', target_area: 'Bradenton', status: 'active',
  daily_budget_current: 100, recommended_daily_budget: 110,
  last7d: { spend: 500, conversionValue: 2500, conversions: 20, clicks: 100, impressions: 2500 },
  last30d: { spend: 2000, conversionValue: 9000, conversions: 75, clicks: 410, impressions: 9800 },
};
const campaigns = [
  campaign,
  // Google client parses SEARCH to enum 2; the DB string column returns "2".
  // Mix that real synced channel value with an existing manually managed row.
  // The Search card must include both, without changing stored campaign types.
  { ...campaign, id: 2, campaign_name: 'Venice Pest Control', platform: 'google_ads', campaign_type: 'google_search', target_area: 'Venice' },
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
const lowRoasCampaigns = campaigns.map((item) => {
  const ratio = item.id === 2 ? 1.5 : item.id === 1 ? 0.5 : 0.8;
  return {
    ...item,
    last7d: { ...item.last7d, conversionValue: item.last7d.spend * ratio },
    last30d: { ...item.last30d, conversionValue: item.last30d.spend * ratio },
  };
});

function fixture(api, method, { emptyCampaigns = false, largeRevenue = false, lowRoas = false } = {}) {
  if (api === '/admin/ads/campaigns') {
    return { campaigns: emptyCampaigns ? [] : lowRoas ? lowRoasCampaigns : campaigns };
  }
  if (api === '/admin/ads/funnel?period=30d') {
    return lowRoas
      ? { funnel: { lead: 75, booked: 52, completed: 41, lost: 10 }, totalLeads: 75, totalRevenue: 3000, roas: 1.5 }
      : { funnel: { lead: 75, booked: 52, completed: 41 }, totalLeads: 75, totalRevenue: 9000, roas: 4.5 };
  }
  if (api === '/admin/ads/revenue-attribution?period=month') {
    if (largeRevenue) {
      return { totalRevenue: 1000000, sources: [{ source: 'Google Ads', revenue: 750000, roas: 4.2 }, { source: 'Local Service Ads', revenue: 250000, roas: 5.1 }] };
    }
    if (lowRoas) {
      return { totalRevenue: 3000, sources: [{ source: 'Google Ads', revenue: 2000, roas: 0.5 }, { source: 'Local Service Ads', revenue: 1000, roas: 1.5 }] };
    }
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

  async function assertMetric(locator, text, color) {
    await locator.waitFor();
    assert.equal((await locator.textContent()).trim(), text);
    assert.equal(await locator.evaluate((element) => getComputedStyle(element).color), color);
  }

  async function assertPlatformAttribution(page) {
    for (const [type, values] of [
      ['google_search', ['$4,000.00', '$18,000.00', '150', '4.5x']],
      ['google_lsa', ['$750.00', '$3,200.00', '26', '4.3x']],
    ]) {
      const card = page.locator(`[data-qa="platform-${type}"]`);
      for (const value of values) await card.getByText(value, { exact: true }).waitFor();
    }
    const file = path.join(output, `ppc-platform-attribution-${page.viewportSize().width}.png`);
    await page.locator('.ppc-platform-grid').screenshot({ path: file });
    report.screenshots.push(path.relative(root, file));
  }

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

  async function verify(page, name, { adaptiveDonut = false, semanticRoas = false } = {}) {
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
      const donutCenters = dashboard
        ? [...dashboard.querySelectorAll('[data-qa="donut-center-value"]')].filter(visible).map((node) => {
          const chart = node.closest('.relative');
          const svg = chart.querySelector('svg');
          const svgRect = svg.getBoundingClientRect();
          const strokeWidth = Number(svg.querySelector('path')?.getAttribute('stroke-width') || 0);
          const innerRadius = svgRect.width / 2 - strokeWidth;
          const center = { x: svgRect.left + svgRect.width / 2, y: svgRect.top + svgRect.height / 2 };
          const textRects = [node, node.nextElementSibling].flatMap((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return [...range.getClientRects()];
          });
          const corners = textRects.flatMap((rect) => [
            [rect.left, rect.top], [rect.right, rect.top],
            [rect.left, rect.bottom], [rect.right, rect.bottom],
          ]);
          const maxCornerDistance = Math.max(...corners.map(([x, y]) => Math.hypot(x - center.x, y - center.y)));
          return {
            text: node.textContent.trim(), fontSize: parseFloat(getComputedStyle(node).fontSize),
            textRects: textRects.map((rect) => ({ width: rect.width, height: rect.height })),
            innerRadius, maxCornerDistance, fits: maxCornerDistance <= innerRadius + 0.5,
          };
        })
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
      const opaqueBackground = (node) => {
        let current = node;
        while (current) {
          const color = getComputedStyle(current).backgroundColor;
          const channels = color.match(/[\d.]+/g)?.map(Number) || [];
          if (channels.length >= 3 && (channels.length === 3 || channels[3] > 0)) return color;
          current = current.parentElement;
        }
        return 'rgb(255, 255, 255)';
      };
      const barContrasts = dashboard
        ? [...dashboard.querySelectorAll('[data-qa="metric-bar"]')].filter(visible).map((bar) => {
          const value = bar.querySelector('[data-qa="metric-bar-value"]');
          const valueColor = getComputedStyle(value).color;
          const valueBackground = opaqueBackground(value);
          const fillColor = getComputedStyle(bar.querySelector('[data-qa="metric-bar-fill"]')).backgroundColor;
          const trackColor = getComputedStyle(bar.querySelector('[data-qa="metric-bar-track"]')).backgroundColor;
          return {
            valueColor, valueBackground, fillColor, trackColor,
            valueRatio: contrast(valueColor, valueBackground),
            fillTrackRatio: contrast(fillColor, trackColor),
          };
        })
        : [];
      return { smallText, shortControls, donutCenters, revenueMetrics, roasMetrics, barContrasts, overflow: document.documentElement.scrollWidth > innerWidth + 1, titleSize: parseFloat(getComputedStyle(rootElement.querySelector('h1')).fontSize) };
    });
    report.geometry.push({ name, viewport: page.viewportSize(), ...result });
    assert.deepEqual(result.smallText, [], `${name}: readable text below 14px`);
    assert.deepEqual(result.shortControls, [], `${name}: controls below 44px`);
    assert.ok(result.donutCenters.every((center) => center.fits), `${name}: donut center overlaps ring ${JSON.stringify(result.donutCenters)}`);
    if (adaptiveDonut) {
      assert.ok(result.donutCenters.every((center) => center.fontSize >= 14), `${name}: adaptive donut text below 14px ${JSON.stringify(result.donutCenters)}`);
    } else {
      assert.ok(result.donutCenters.every((center) => center.fontSize === 22), `${name}: normal donut center value is not 22px ${JSON.stringify(result.donutCenters)}`);
    }
    assert.ok(result.revenueMetrics.every((metric) => ['rgb(24, 24, 27)', 'rgb(39, 39, 42)'].includes(metric.color)), `${name}: non-zinc revenue metric ${JSON.stringify(result.revenueMetrics)}`);
    if (!semanticRoas) {
      assert.ok(result.roasMetrics.every((metric) => ['rgb(24, 24, 27)', 'rgb(39, 39, 42)', 'rgb(82, 82, 91)'].includes(metric.color)), `${name}: non-zinc normal ROAS metric ${JSON.stringify(result.roasMetrics)}`);
    }
    assert.ok(result.barContrasts.every((bar) => bar.fillTrackRatio >= 3), `${name}: metric fill/track contrast below 3 ${JSON.stringify(result.barContrasts)}`);
    assert.ok(result.barContrasts.every((bar) => bar.valueRatio >= 4.5), `${name}: metric value/background contrast below 4.5 ${JSON.stringify(result.barContrasts)}`);
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
    await assertPlatformAttribution(desktop);
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
    await assertPlatformAttribution(mobile);
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
      const large = await openPage(width, { largeRevenue: true });
      await large.goto(`${server.baseUrl}/admin/ppc`);
      await large.getByRole('heading', { name: 'Waves PPC command center', level: 2 }).waitFor();
      await large.locator('#admin-main').getByRole('button', { name: 'Funnel & Attribution', exact: true }).last().evaluate((element) => element.click());
      await large.getByText('$1,000,000.00', { exact: true }).waitFor();
      await verify(large, `ppc-dashboard-large-donut-${width}`, { adaptiveDonut: true });
      const largeGeometry = report.geometry.find((entry) => entry.name === `ppc-dashboard-large-donut-${width}`);
      const largeCenter = largeGeometry.donutCenters.find((center) => center.text === '$1,000,000.00');
      assert.ok(largeCenter, `${width}: exact seven-digit donut total missing`);
      assert.ok(largeCenter.fontSize >= 14 && largeCenter.fits, `${width}: seven-digit donut total does not fit ${JSON.stringify(largeCenter)}`);
    }

    const lowDesktop = await openPage(1440, { lowRoas: true });
    await lowDesktop.goto(`${server.baseUrl}/admin/ppc`);
    await lowDesktop.getByRole('heading', { name: 'Waves PPC command center', level: 2 }).waitFor();
    await assertMetric(lowDesktop.locator('[data-qa="ppc-dashboard"] [data-metric="roas"]').first(), '1.0x', 'rgb(153, 27, 27)');
    await verify(lowDesktop, 'ppc-dashboard-low-roas-overview-1440', { semanticRoas: true });
    await lowDesktop.locator('#admin-main').getByRole('button', { name: 'Campaigns', exact: true }).last().evaluate((element) => element.click());
    await assertMetric(lowDesktop.getByRole('row').filter({ hasText: 'Bradenton Pest Control' }).locator('[data-metric="roas"]'), '0.5x', 'rgb(153, 27, 27)');
    await assertMetric(lowDesktop.getByRole('row').filter({ hasText: 'Venice Pest Control' }).locator('[data-metric="roas"]'), '1.5x', 'rgb(161, 98, 7)');
    await verify(lowDesktop, 'ppc-dashboard-low-roas-campaigns-1440', { semanticRoas: true });
    await lowDesktop.locator('#admin-main').getByRole('button', { name: 'Funnel & Attribution', exact: true }).last().evaluate((element) => element.click());
    await assertMetric(lowDesktop.locator('[data-qa="ppc-dashboard"] [data-metric="roas"]').first(), '1.5x', 'rgb(161, 98, 7)');
    await assertMetric(lowDesktop.getByText('0.5x ROAS', { exact: true }), '0.5x ROAS', 'rgb(82, 82, 91)');
    await verify(lowDesktop, 'ppc-dashboard-low-roas-funnel-1440', { semanticRoas: true });

    const lowMobile = await openPage(390, { lowRoas: true });
    await lowMobile.goto(`${server.baseUrl}/admin/ppc`);
    await lowMobile.getByRole('heading', { name: 'Waves PPC command center', level: 2 }).waitFor();
    await assertMetric(lowMobile.locator('[data-qa="ppc-dashboard"] [data-metric="roas"]').first(), '1.0x', 'rgb(153, 27, 27)');
    await verify(lowMobile, 'ppc-dashboard-low-roas-overview-390', { semanticRoas: true });
    await lowMobile.locator('#admin-main').getByRole('button', { name: 'Funnel & Attribution', exact: true }).last().evaluate((element) => element.click());
    await assertMetric(lowMobile.locator('[data-qa="ppc-dashboard"] [data-metric="roas"]').first(), '1.5x', 'rgb(161, 98, 7)');
    await verify(lowMobile, 'ppc-dashboard-low-roas-funnel-390', { semanticRoas: true });

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
