'use strict';
/* global document, getComputedStyle, innerWidth, localStorage, navigator, window */
// SYNTHETIC UI QA. Every API request is fulfilled in-browser; no database or
// external SEO provider is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, waitForFonts, evidence } = require('./browser');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-seo-foundation');

const prospect = {
  id: 17,
  target_domain: 'publisher.example',
  target_url: 'https://publisher.example/resources',
  target_page: 'https://www.wavespestcontrol.com/pest-control',
  anchor_planned: 'pest control guide',
  link_type: 'editorial',
  priority: 'medium',
  status: 'prospect',
  indexing_status: 'not_checked',
  domain_rating: 42,
  outreach_status: 'drafted',
  outreach_to_email: 'editor@publisher.example',
  outreach_subject: 'Waves resource suggestion',
  outreach_body: 'A concise, synthetic outreach draft.',
};
const geoPins = Array.from({ length: 25 }, (_, index) => ({
  pin_row: Math.floor(index / 5),
  pin_col: index % 5,
  latitude: 27.49 + Math.floor(index / 5) * 0.002,
  longitude: -82.57 + (index % 5) * 0.002,
  map_pack_rank: (index % 20) + 1,
  address_label: `Synthetic grid point ${index + 1}`,
  top_competitors: [],
}));

function seoFixture(api, method) {
  if (api === '/admin/seo/ai-overview') return {
    total: 2, withAIO: 1, wavesCited: 1, geoScore: 50,
    results: [{ keyword: 'pest control bradenton', aioPresent: true, wavesCited: true, sources: [] }],
    citationCounts: { 'publisher.example': 1 }, quickWins: [],
  };
  if (api === '/admin/seo/rankings?days=7') return {
    summary: { inMapPack: 1, improving: 1, declining: 0, stable: 0 },
    rankings: [{ keyword: 'pest control bradenton', currentPosition: 3, delta: 1, mapPackPosition: 2, service_category: 'Pest Control', primary_city: 'Bradenton', history: [] }],
  };
  if (api === '/admin/seo/backlinks') return {
    total: 1, critical: 0, warning: 0, clean: 1, citationStats: { total: 1, active: 1 },
    velocity: { new_7d: 1, lost_7d: 0, net_7d: 1, trend: 'growing' },
    anchorDistribution: { branded: 1 }, recentToxic: [], snapshots: [], recentlyLost: [],
    citationGaps: [], llmStats: { measured: 1, total: 1, citationRate: 100, mentionRate: 100 },
  };
  if (api === '/admin/seo/advisor') return { recommendations: [], generatedAt: '2026-09-11T12:00:00Z' };
  if (api === '/admin/seo/sync-health') return { providers: [], warnings: [], lastSync: null };
  if (api.startsWith('/admin/seo/actions?')) return { items: [], actions: [] };
  if (api.startsWith('/admin/seo/actions/summary')) return { pending: 0, inProgress: 0, completed: 0 };
  if (api === '/admin/seo/qa') return { items: [], summary: {} };
  if (api === '/admin/seo/refresh-audit?limit=200') return { items: [], pages: [] };
  if (api.startsWith('/admin/seo/rankings-monitor?period=')) return { rows: [], annotations: [], summary: {} };
  if (api === '/admin/seo/geo-grid') return { offices: [{ id: 'bradenton', name: 'Bradenton' }], keywords: ['pest control'], gridSize: 5, scanning: false };
  if (api.startsWith('/admin/seo/geo-grid/heatmap?')) return { pins: geoPins, center: { lat: 27.49, lng: -82.57 }, gridSize: 5 };
  if (api === '/admin/seo/llm-mentions') return {
    summary: { queriesTracked: 0, platforms: [] }, benchmark: null, entity: null,
    byPlatform: [], trend: [], citedPages: [], competitors: [], grid: [],
  };
  if (api === '/admin/seo/funnel?days=30') return { stages: [], sources: [], totals: {} };
  if (api.startsWith('/admin/seo/site-rollup?')) return { sites: [], totals: {} };
  if (api.startsWith('/admin/analytics/')) return { data: [], totals: {}, profiles: [], warnings: [], blended: {}, conversions: {} };
  if (api.startsWith('/admin/seo/url-intelligence/indexation-gap?')) return {
    domain: 'wavespestcontrol.com', submitted: 0, indexed: 0, gap: 0, gap_pct: 0, by_coverage_state: [],
  };
  if (api.startsWith('/admin/seo/url-intelligence/dashboard?')) return { total_urls: 0, by_status: [], by_diagnosis: [], indexation_gap: {}, top_issues: [], canonical_conflicts: 0 };
  if (api.startsWith('/admin/seo/url-intelligence/')) return { items: [], rows: [], clusters: [], routes: [], issues: [], summary: {} };
  if (api === '/admin/seo/audit') return { hasData: false };
  if (api.startsWith('/admin/backlink-agent/prospects/stats')) return { total: 1, byStatus: { prospect: 1 }, indexingRate: 0 };
  if (api.startsWith('/admin/backlink-agent/prospects?') || api === '/admin/backlink-agent/prospects') return { items: [prospect] };
  if (api === '/admin/backlink-agent/prospects/verify') return { ok: true };
  if (api.includes('/outreach/draft') && method === 'POST') return { ok: true };
  if (api.startsWith('/admin/backlink-agent/')) return { items: [], rows: [], domains: [], stats: {}, policy: {}, queue: [] };
  return undefined;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), requests: [], fallbackFixtures: [], blockedExternal: [], consoleErrors: [], pageErrors: [], screenshots: [], geometry: [] };
  let server;
  let browser;

  async function openPage(width) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    page.setDefaultTimeout(20000);
    await page.addInitScript(() => {
      localStorage.setItem('waves_admin_token', 'synthetic-local-token');
      localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-user', role: 'admin', name: 'Fixture operator' }));
      if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: 'synthetic-local-test' });
    });
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(`${message.text()} @ ${message.location().url}`); });
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== server.baseUrl) {
        report.blockedExternal.push(url.origin);
        return route.abort();
      }
      if (url.pathname.startsWith('/socket.io')) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const api = url.pathname.slice(4);
      report.requests.push({ method: request.method(), path: api, search: url.search });
      let body = seoFixture(`${api}${url.search}`, request.method());
      if (api === '/admin/auth/me') body = { id: 'fixture-user', role: 'admin', name: 'Fixture operator' };
      else if (api === '/admin/feature-flags') body = { flags: {} };
      else if (api === '/admin/notifications/unread-count') body = { count: 0 };
      else if (api === '/admin/communications/unread-count') body = { conversations: 0, messages: 0 };
      else if (api === '/admin/usage/track') body = { ok: true };
      else if (api === '/health') body = { status: 'ok', gates: {} };
      if (body === undefined) {
        report.fallbackFixtures.push(`${request.method()} ${api}${url.search}`);
        body = {};
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    return page;
  }

  async function verify(page, name) {
    await waitForFonts(page);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
      for (const scroller of document.querySelectorAll('*')) {
        if (scroller.scrollTop) scroller.scrollTop = 0;
        if (scroller.scrollLeft) scroller.scrollLeft = 0;
      }
    });
    await page.locator('#admin-main').evaluate((element) => element.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#admin-main').evaluate((element) => element.scrollTop), 0, `${name}: main scroll reset`);
    const result = await page.evaluate(() => {
      const rootElement = document.querySelector('main .seo-page[data-ui-density="comfortable"]');
      if (!rootElement) throw new Error('Comfortable SEO surface missing');
      const visible = (node) => node.getClientRects().length > 0;
      const smallText = [...rootElement.querySelectorAll('*')]
        .filter(visible)
        .filter((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim()))
        .map((node) => ({ text: node.textContent.trim().slice(0, 70), size: parseFloat(getComputedStyle(node).fontSize) }))
        .filter((item) => item.size < 14);
      const shortControls = [...rootElement.querySelectorAll('button, input:not([type="file"]), select, textarea, a[href]')]
        .filter(visible)
        .filter((node) => !node.classList.contains('u-touch-hit'))
        .map((node) => ({ name: node.getAttribute('aria-label') || node.textContent.trim().slice(0, 60), height: node.getBoundingClientRect().height }))
        .filter((item) => item.height < 43.5);
      const unsharedControls = [...rootElement.querySelectorAll('button, input, select, textarea')]
        .filter(visible)
        .filter((node) => !node.closest('nav[aria-label="SEO section"], nav[aria-label$="SEO view"]'))
        .filter((node) => !node.classList.contains('ui-control') && !node.classList.contains('u-touch-hit'))
        .map((node) => ({ tag: node.tagName, type: node.getAttribute('type'), name: node.getAttribute('aria-label') || node.textContent.trim().slice(0, 60) }));
      const nonSquareGridCells = [...rootElement.querySelectorAll('[data-geo-grid-cell]')]
        .filter(visible)
        .map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }))
        .filter((box) => Math.abs(box.width - box.height) > 1);
      const h1 = rootElement.querySelector('h1');
      return { smallText, shortControls, unsharedControls, nonSquareGridCells, overflow: document.documentElement.scrollWidth > innerWidth + 1, titleSize: parseFloat(getComputedStyle(h1).fontSize) };
    });
    report.geometry.push({ name, viewport: page.viewportSize(), ...result });
    assert.deepEqual(result.smallText, [], `${name}: readable text below 14px`);
    assert.deepEqual(result.shortControls, [], `${name}: controls below 44px`);
    assert.deepEqual(result.unsharedControls, [], `${name}: controls must use shared UI primitives`);
    assert.deepEqual(result.nonSquareGridCells, [], `${name}: geo-grid cells must remain square`);
    assert.equal(result.overflow, false, `${name}: page overflow`);
    assert.equal(result.titleSize, 22, `${name}: page title size`);
    const file = path.join(output, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    report.screenshots.push(path.relative(root, file));
  }

  try {
    server = await previewServer(root, process.env.ADMIN_UI_PREVIEW_URL);
    browser = await launchBrowser();

    const desktop = await openPage(1440);
    await desktop.goto(`${server.baseUrl}/admin/seo`);
    await desktop.getByRole('heading', { name: 'SEO', level: 1 }).waitFor();
    await desktop.getByText('Provider Visibility', { exact: true }).waitFor();
    const primaryNav = desktop.getByRole('navigation', { name: 'SEO section' });
    const workspaces = [
      { label: 'Command', views: ['Dashboard', 'SEO Advisor'] },
      { label: 'Strategy', views: ['Actions', 'Content QA', 'Refresh Audit'] },
      { label: 'Rankings', views: ['Rankings', 'Monitor', 'Funnel', 'Geo-Grid'] },
      { label: 'Authority', views: ['Backlinks & Citations', 'AI Overview'] },
      { label: 'Technical', views: ['URL Intel', 'Indexation', 'Site Health'] },
      { label: 'Measurement', views: ['Analytics', 'By Site'] },
    ];
    const childViews = {
      'Command / Dashboard': ['AI Visibility', 'Organic Rankings'],
      'Strategy / Actions': ['Queue', 'AI Drafts', 'In Progress', 'Experiments'],
      'Authority / Backlinks & Citations': ['Overview', 'Citations', 'Competitor Gaps', 'LLM Mentions', 'Link Building', 'Agent'],
      'Technical / URL Intel': ['Overview', 'By Diagnosis', 'Priority Queue', 'Duplicates', 'Intent Routing'],
      'Technical / Indexation': ['Indexation Gap', 'Canonical Conflicts', 'Not Indexed', 'Sitemap Issues', 'URL Inspector'],
    };
    for (const workspace of workspaces) {
      const { label } = workspace;
      console.log(`Checking workspace: ${label}`);
      const tab = primaryNav.getByRole('button', { name: label, exact: true });
      await tab.evaluate((element) => element.click());
      await desktop.waitForFunction((label) => {
        const nav = document.querySelector('nav[aria-label="SEO section"]');
        return nav && [...nav.querySelectorAll('button')].some((button) => button.textContent.trim() === label && button.getAttribute('aria-current') === 'page');
      }, label);
      const secondaryNav = desktop.getByRole('navigation', { name: `${label} SEO view` });
      for (const view of workspace.views) {
        console.log(`Checking view: ${label} / ${view}`);
        const viewTab = secondaryNav.getByRole('button', { name: view, exact: true });
        await viewTab.evaluate((element) => element.click());
        await desktop.waitForFunction(({ label, view }) => {
          const nav = document.querySelector(`nav[aria-label="${label} SEO view"]`);
          return nav && [...nav.querySelectorAll('button')].some((button) => button.textContent.trim() === view && button.getAttribute('aria-current') === 'page');
        }, { label, view });
        await desktop.waitForTimeout(300);
        const slug = `${label}-${view}`.toLowerCase().replaceAll(' ', '-').replaceAll('&', 'and');
        await verify(desktop, `seo-${slug}-1440`);
        for (const childView of childViews[`${label} / ${view}`] || []) {
          console.log(`Checking nested view: ${label} / ${view} / ${childView}`);
          const childTab = desktop.locator('#admin-main').getByRole('button', { name: childView, exact: true }).last();
          await childTab.evaluate((element) => element.click());
          await desktop.waitForTimeout(300);
          const childSlug = childView.toLowerCase().replaceAll(' ', '-').replaceAll('&', 'and');
          await verify(desktop, `seo-${slug}-${childSlug}-1440`);
        }
      }
    }

    const mobile = await openPage(390);
    await mobile.goto(`${server.baseUrl}/admin/seo`);
    await mobile.getByRole('heading', { name: 'SEO', level: 1 }).waitFor();
    await mobile.getByRole('navigation', { name: 'SEO section' }).getByRole('button', { name: 'Authority', exact: true }).click();
    await mobile.getByRole('button', { name: 'Link Building', exact: true }).click();
    await mobile.getByText('publisher.example', { exact: true }).waitFor();
    await mobile.getByRole('button', { name: 'Edit draft', exact: true }).click();
    const dialog = mobile.getByRole('dialog', { name: /Outreach draft/ });
    await dialog.waitFor();
    assert.equal(await dialog.getByPlaceholder('editor@example.com').inputValue(), 'editor@publisher.example');
    await mobile.getByRole('button', { name: 'Cancel', exact: true }).click();
    await verify(mobile, 'seo-mobile-390');

    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.blockedExternal, []);
    assert.deepEqual(report.fallbackFixtures, []);
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Evidence: ${path.relative(root, path.join(output, 'report.json'))}`);
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
