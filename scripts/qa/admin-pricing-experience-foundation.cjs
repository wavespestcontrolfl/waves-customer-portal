'use strict';
// SYNTHETIC UI QA. Every API response is fulfilled in-browser; no database or
// provider is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, waitForFonts, evidence } = require('./browser');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-pricing-experience-foundation');
const now = new Date().toISOString();

const configs = [
  { config_key: 'global_labor_rate', name: 'Loaded labor rate', category: 'global', data: { value: 35, enabled: true } },
  { config_key: 'lawn_adjustments', name: 'Lawn adjustments', category: 'lawn', data: { slopes: [{ label: 'Flat', multiplier: 1 }] } },
  { config_key: 'waveguard_tiers', name: 'WaveGuard tiers', category: 'waveguard', data: { gold: { threshold: 3, discount: 0.15 } } },
];

function fixture(api, method, body) {
  if (api === '/health') return { status: 'ok', gates: {} };
  if (api === '/admin/auth/me') return { id: 'fixture-admin', name: 'Fixture operator', role: 'admin' };
  if (api === '/admin/feature-flags') return { flags: {} };
  if (api === '/admin/notifications/unread-count') return { count: 0 };
  if (api === '/admin/communications/unread-count') return { conversations: 0, messages: 0 };
  if (api === '/admin/usage/track') return { ok: true };
  if (api === '/admin/pricing-config') return { configs };
  if (api === '/admin/pricing-config/audit-log') return { logs: [{ config_key: 'global_labor_rate', changed_by: 'Fixture operator', changed_at: now, reason: 'Synthetic QA' }] };
  if (api === '/admin/pricing-config/margin-check') return { waveguardTier: 'gold', services: [{ service: 'pest', annual: 1200, estimatedCost: 300, materialCostSource: 'inventory_cost_per_unit', materialPerVisit: 2.5, afterDiscount: 1020, margin: 0.7 }] };
  if (api === '/admin/pricing-config/pest-calibration') return {
    summary: { count: 2, avgDelta: 2.2, avgAbsDelta: 3.1, outlierCount: 1, byPoolCageSize: [{ key: 'medium', count: 2, avgDelta: 2.2, avgAbsDelta: 3.1 }], byLotBand: [{ key: '10k–20k', count: 2, avgDelta: 2.2, avgAbsDelta: 3.1 }], reviewQueueCount: 1, reviewQueue: [{ id: 'review-1', service_date: '2026-09-10', customer_name: 'Review customer', delta_minutes: 18, pool_cage_size: 'medium', lot_sqft: 15000, calibration_review_reasons: ['large delta'] }] },
    sampleHealth: { jobsEvaluated: 4, materializedCount: 2, fallbackMatchedCount: 1, missingEstimateLinkCount: 1, missingTimerCount: 0, missingDiagnosticsCount: 0 },
    records: [{ id: 'sample-1', service_date: '2026-09-10', customer_name: 'Calibration customer', pool_cage_size: 'medium', lot_sqft: 15000, predicted_minutes: 42, actual_minutes: 45, delta_minutes: 3, pricing_confidence: 'high', review_reasons: [] }],
  };
  if (api === '/admin/pricing-config/lawn-brackets') return { tracks: { st_augustine: [
    { sqft_bracket: 5000, tier: 'standard', monthly_price: 70 }, { sqft_bracket: 5000, tier: 'enhanced', monthly_price: 95 }, { sqft_bracket: 5000, tier: 'premium', monthly_price: 120 },
  ], bermuda: [], zoysia: [], bahia: [] } };
  if (api === '/admin/pricing-config/discount-rules') return { rules: [{ service_key: 'pest', tier_qualifier: true, max_discount_pct: 15, exclude_from_pct_discount: false, flat_credit: 25, flat_credit_min_tier: 'gold', notes: 'Synthetic rule' }] };
  if (api === '/admin/inventory') return { products: [{ id: 'product-1', product_name: 'Synthetic treatment', category: 'Pest', active_ingredient: 'Synthetic ingredient', best_price: 42, unit_price: 1.25 }] };
  if (api === '/admin/pricing-proposals') return { proposals: [{ id: 17, config_key: 'global_labor_rate', current_value: 35, proposed_value: 40, pct_change: 14.3, trigger_source: 'margin-monitor', status: 'pending', created_at: now, evidence: { sample: 10 }, price_impact: { annual: 200 } }] };
  if (api === '/admin/pricing-config/changelog') return { entries: [{ id: 'change-1', changed_at: now, version_from: 1, version_to: 2, category: 'rule', summary: 'Synthetic pricing rule update', changed_by: 'Fixture operator', rationale: 'Synthetic rationale', affected_services: ['pest'], before_value: 35, after_value: 40 }] };
  if (/^\/admin\/pricing-config\/[^/]+$/.test(api) && method === 'PUT') return { success: true, received: body };
  if (/^\/admin\/pricing-config\/lawn-brackets\//.test(api) && method === 'PUT') return { success: true };
  if (/^\/admin\/pricing-config\/discount-rules\//.test(api) && method === 'PUT') return { success: true };
  if (/^\/admin\/pricing-proposals\/\d+\/(approve|reject)$/.test(api) && method === 'POST') return { success: true, changelog_id: 22 };
  if (api === '/admin/pricing/dashboard') return { totalCustomers: 8, avgLTV: 900, avgCAC: 90, ltvCacRatio: 10, mrr: 1200, funnel: { leads: 10, estimates: 8, accepted: 6, active: 5, retained: 4 }, revenueByStage: { attraction: 300, core: 600, upsell: 200, continuity: 100 }, upsellOpportunities: [] };
  if (api === '/admin/pricing/calculate-value') return { valueScore: 54, priceRecommendation: 'Market rate', positioning: 'Synthetic positioning' };
  if (api === '/admin/pricing/offers') return { offers: [{ id: 'offer-1', name: 'Synthetic package', description: 'Synthetic custom offer', conversion_rate: 25 }] };
  if (api === '/admin/pricing/upsell-rules') return { rules: [{ id: 'rule-1', name: 'Synthetic upsell rule', trigger_event: 'renewal', offer_service: 'mosquito', enabled: true, times_triggered: 2, times_converted: 1 }] };
  if (api === '/admin/pricing/upsell-opportunities') return { opportunities: [{ customerId: 'customer-1', customerName: 'Synthetic customer', currentTier: 'Silver', serviceCount: 2, monthlyRate: 100, potentialAdd: 25, suggestedService: 'Mosquito' }] };
  if (api === '/admin/pricing/trigger-upsell/customer-1') return { message: 'Synthetic upsell sent' };
  if (api === '/admin/pricing/ltv-analysis') return { avgLTV: 900, avgCAC: 90, ltvCacRatio: 10, bestChannel: 'Referral', retention12mo: 75, bySource: { Referral: { count: 5, avgLTV: 1000, avgCAC: 50, ratio: 20 } } };
  if (api === '/admin/pricing/recalculate-ltv') return { success: true };
  return null;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), scenarios: [], requests: [], unmatched: [], blockedExternal: [], consoleErrors: [], pageErrors: [], screenshots: [] };
  let server;
  let browser;
  let stage = 'startup';

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
    page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push({ stage, message: message.text() }); });
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== server.baseUrl) { report.blockedExternal.push({ stage, origin: url.origin }); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const api = url.pathname.slice(4);
      const method = request.method();
      let requestBody = null;
      try { requestBody = request.postData() ? JSON.parse(request.postData()) : null; } catch { requestBody = request.postData(); }
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
    const surface = page.locator('[data-ui-density="comfortable"]').last();
    await surface.waitFor();
    const inlineStyles = await surface.locator('[style]:not(.ui-select)').evaluateAll((elements) => elements.filter((element) => element.getAttribute('style')?.trim()).map((element) => ({ tag: element.tagName, style: element.getAttribute('style') })).slice(0, 8));
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
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('#admin-main').evaluate((element) => element.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    await page.waitForTimeout(100);
    const file = path.join(output, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    report.screenshots.push({ name, file: path.relative(root, file), width: page.viewportSize().width, overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
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

    await scenario('logic workspace, category reads and config mutation parity', async () => {
      await desktop.goto(`${server.baseUrl}/admin/pricing-logic?section=logic`);
      await desktop.getByRole('heading', { name: 'Pricing', level: 1 }).waitFor();
      await desktop.getByText('Loaded labor rate', { exact: true }).waitFor();
      await assertFoundation(desktop);
      await desktop.getByText('Loaded labor rate', { exact: true }).click();
      await desktop.getByTitle('Click to edit').first().click();
      const editor = desktop.locator('input[type="number"]').last();
      await editor.fill('42');
      await Promise.all([
        desktop.waitForRequest((request) => request.url().endsWith('/api/admin/pricing-config/global_labor_rate') && request.method() === 'PUT' && request.postDataJSON().data.value === 42),
        editor.press('Enter'),
      ]);
      await desktop.getByRole('button', { name: 'Lawn care', exact: true }).click();
      await desktop.getByRole('table', { name: 'Monthly lawn price brackets' }).waitFor();
      await desktop.getByRole('button', { name: 'WaveGuard', exact: true }).click();
      await desktop.getByRole('table', { name: 'Service discount rules' }).waitFor();
      await desktop.getByRole('button', { name: 'Products', exact: true }).click();
      await desktop.getByText('Synthetic treatment', { exact: true }).waitFor();
      await desktop.getByRole('button', { name: 'Proposals', exact: true }).click();
      await desktop.getByRole('button', { name: 'Review', exact: true }).click();
      const proposalDialog = desktop.getByRole('dialog', { name: 'Proposal #17' });
      await proposalDialog.waitFor();
      await proposalDialog.getByLabel('Review notes').fill('Synthetic approval note');
      await Promise.all([
        desktop.waitForRequest((request) => request.url().endsWith('/api/admin/pricing-proposals/17/approve') && request.method() === 'POST' && request.postDataJSON().review_notes === 'Synthetic approval note'),
        proposalDialog.getByRole('button', { name: 'Approve', exact: true }).click(),
      ]);
      await desktop.getByRole('button', { name: 'Changelog', exact: true }).click();
      await desktop.getByText('Synthetic pricing rule update', { exact: true }).waitFor();
      await desktop.getByText('Synthetic pricing rule update', { exact: true }).click();
      await desktop.getByText('Synthetic rationale', { exact: true }).waitFor();
      await shot(desktop, 'pricing-logic-desktop-1440');
    });

    await scenario('strategy calculation, offers, upsell and LTV actions', async () => {
      await desktop.goto(`${server.baseUrl}/admin/pricing-logic?area=strategy`);
      await desktop.getByText('Total customers', { exact: true }).waitFor();
      await desktop.getByRole('button', { name: 'Value equation', exact: true }).click();
      await desktop.getByText('Synthetic positioning', { exact: true }).waitFor();
      const dreamOutcome = desktop.getByLabel('Dream outcome');
      await dreamOutcome.focus();
      await desktop.keyboard.press('ArrowRight');
      await Promise.all([
        desktop.waitForRequest((request) => request.url().endsWith('/api/admin/pricing/calculate-value') && request.postDataJSON().dreamOutcome === 9),
        desktop.keyboard.press('ArrowRight'),
      ]);
      await desktop.getByRole('button', { name: 'Offer builder', exact: true }).click();
      await desktop.getByText('Synthetic package', { exact: true }).waitFor();
      await desktop.getByRole('button', { name: 'Upsell engine', exact: true }).click();
      await desktop.getByText('Synthetic customer', { exact: true }).waitFor();
      await desktop.getByRole('button', { name: 'Send offer', exact: true }).click();
      await desktop.getByText('Synthetic upsell sent', { exact: true }).waitFor();
      await desktop.getByRole('button', { name: 'LTV analysis', exact: true }).click();
      await desktop.getByText('Referral', { exact: true }).first().waitFor();
      await Promise.all([
        desktop.waitForRequest((request) => request.url().endsWith('/api/admin/pricing/recalculate-ltv') && request.method() === 'POST'),
        desktop.getByRole('button', { name: 'Recalculate all', exact: true }).click(),
      ]);
      await assertFoundation(desktop);
      await shot(desktop, 'pricing-strategy-desktop-1440');
    });

    const mobile = await openPage(390);
    await scenario('mobile pricing logic remains readable without page overflow', async () => {
      await mobile.goto(`${server.baseUrl}/admin/pricing-logic?section=margins`);
      await mobile.getByRole('table', { name: 'Service margins' }).waitFor();
      await assertFoundation(mobile);
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await shot(mobile, 'pricing-logic-mobile-390');
    });

    await scenario('mobile pricing strategy remains readable without page overflow', async () => {
      await mobile.goto(`${server.baseUrl}/admin/pricing-logic?area=strategy`);
      await mobile.getByText('Total customers', { exact: true }).waitFor();
      await mobile.getByRole('button', { name: 'Upsell engine', exact: true }).click();
      await mobile.getByText('Synthetic customer', { exact: true }).waitFor();
      await assertFoundation(mobile);
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await shot(mobile, 'pricing-strategy-mobile-390');
    });

    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.blockedExternal, []);
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Evidence: ${path.relative(root, path.join(output, 'report.json'))}`);
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
