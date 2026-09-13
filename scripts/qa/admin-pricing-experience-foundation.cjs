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

// Mirrors PricingIntelligence.calculateValueScore (pricing-intelligence.js:75-104)
// exactly — the clamp, the rounding and the four positioning bands — so a slider
// change produces the response production would produce.
function calculateValue(body) {
  const clamp = (value) => Math.max(1, Math.min(10, Number(value) || 5));
  const dO = clamp(body?.dreamOutcome);
  const pL = clamp(body?.perceivedLikelihood);
  const tD = clamp(body?.timeDelay);
  const eS = clamp(body?.effortSacrifice);
  const valueScore = Math.round(((dO * pL) / (tD * eS)) * 100) / 100;
  let positioning, priceRecommendation;
  if (valueScore >= 5) {
    positioning = 'Premium — high perceived value, charge accordingly';
    priceRecommendation = 'Price at top of market. Customers see massive value.';
  } else if (valueScore >= 2) {
    positioning = 'Competitive — good value but room to improve';
    priceRecommendation = 'Price at market rate. Improve likelihood or reduce time/effort to go premium.';
  } else if (valueScore >= 1) {
    positioning = 'Commodity — need to differentiate';
    priceRecommendation = 'Add guarantees, reduce onboarding friction, show faster results.';
  } else {
    positioning = "Red zone — customers don't see enough value";
    priceRecommendation = 'Rethink the offer. Stack bonuses, add unconditional guarantee, speed up results.';
  }
  return { valueScore, inputs: { dreamOutcome: dO, perceivedLikelihood: pL, timeDelay: tD, effortSacrifice: eS }, priceRecommendation, positioning };
}

function fixture(api, method, body) {
  if (api === '/health') return { status: 'ok', gates: {} };
  if (api === '/admin/auth/me') return { id: 'fixture-admin', name: 'Fixture operator', role: 'admin' };
  if (api === '/admin/feature-flags') return { flags: {} };
  if (api === '/admin/notifications/unread-count') return { count: 0 };
  if (api === '/admin/communications/unread-count') return { conversations: 0, messages: 0 };
  if (api === '/admin/usage/track') return { ok: true };
  if (api === '/admin/pricing-config') return { configs };
  if (api === '/admin/pricing-config/audit-log') return { logs: [
    { config_key: 'global_labor_rate', changed_by: 'Fixture operator', changed_at: '2026-09-12T12:14:59Z', reason: 'Synthetic later change' },
    { config_key: 'global_labor_rate', changed_by: 'Fixture operator', changed_at: '2026-09-12T12:14:07Z', reason: 'Synthetic earlier change' },
  ] };
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
  if (api === '/admin/pricing/dashboard') return { overview: { totalCustomers: 8, avgLTV: 900, avgCAC: 90, ltvToCacRatio: 10, monthlyRecurringRevenue: 1200, annualizedRecurring: 14400 }, stages: { attraction: { totalLeads: 10, totalEstimates: 8, acceptedEstimates: 6, conversionRate: 75 }, core: { recurringCustomers: 5, monthlyRecurring: 1200, tierBreakdown: {} }, upsell: { avgServicesPerCustomer: 2, totalCompletedServices: 14 }, continuity: { retentionBuckets: { '0-3mo': 1, '3-6mo': 0, '6-12mo': 1, '12-24mo': 2, '24mo+': 1 }, totalRetained: 5 } }, funnel: { leads: 10, estimates: 8, accepted: 6, active: 5 } };
  if (api === '/admin/pricing/calculate-value') return calculateValue(body);
  if (api === '/admin/pricing/offers') return { offers: [{ id: 'offer-1', name: 'Synthetic package', description: 'Synthetic custom offer', conversion_rate: 25 }] };
  if (api === '/admin/pricing/upsell-rules') return { rules: [{ id: 'rule-1', name: 'Synthetic upsell rule', trigger_event: 'renewal', offer_service: 'mosquito', enabled: true, times_triggered: 2, times_converted: 1 }] };
  // Shapes below mirror server/routes/admin-pricing-strategy.js exactly: the
  // upsell list is { customer, upsell } pairs and the LTV read returns summary /
  // channelPerformance / retentionCurve. Flattened fixtures made this proof pass
  // against a contract the server never sends.
  if (api === '/admin/pricing/upsell-opportunities') return { total: 1, opportunities: [{ customer: { id: 'customer-1', name: 'Synthetic customer', tier: 'Silver', monthlyRate: 100, phone: '9415550100' }, upsell: { type: 'add_service', service: 'Mosquito', pitch: 'Synthetic pitch', estimatedMonthlyAdd: 25 } }] };
  // { success, upsell, messageSent } — the route has no `message` field, so the
  // page falls back to its generic success copy.
  if (api === '/admin/pricing/trigger-upsell/customer-1') return { success: true, upsell: { type: 'add_service', service: 'Mosquito', estimatedMonthlyAdd: 25 }, messageSent: 'Synthetic outbound SMS body' };
  if (api === '/admin/pricing/ltv-analysis') return {
    totalTracked: 5,
    distribution: { '<500': 1, '500-1000': 2, '1000-2000': 1, '2000-5000': 1, '5000+': 0 },
    channelPerformance: [{ source: 'Referral', avgCAC: 50, avgLTV: 1000, avgRevenue: 800, customerCount: 5, roi: 16 }],
    churnBreakdown: { low: 3, medium: 1, high: 1 },
    retentionCurve: { '3mo': { retained: 5, pct: 100 }, '6mo': { retained: 4, pct: 80 }, '12mo': { retained: 3, pct: 75 }, '24mo': { retained: 2, pct: 40 } },
    summary: { avgLTV: 900, avgCAC: 90, avgMonthlyRecurring: 120 },
  };
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
    const page = await browser.newPage({ viewport: { width, height: 1000 }, locale: 'en-US', timezoneId: 'America/New_York', serviceWorkers: 'block' });
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
    // .first(), not .last(): PricingLogicPage renders an outer surface that
    // contains MarginCalculator's own nested one, and .last() picked the
    // calculator card — so the checks skipped PricingLogicPanel entirely and
    // could report a full-workspace pass while inspecting a fraction of it.
    const surface = page.locator('[data-ui-density="comfortable"]').first();
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

  async function shot(page, name, focus) {
    await waitForFonts(page);
    if (focus) await focus.scrollIntoViewIfNeeded();
    else {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator('#admin-main').evaluate((element) => element.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    }
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

  async function assertAuditSeconds(page) {
    await page.getByText('Recent changes', { exact: true }).waitFor();
    // Same operator, setting and minute: seconds are the displayed distinction.
    await page.getByText(/8:14:59 AM/, { exact: false }).last().waitFor();
    await page.getByText(/8:14:07 AM/, { exact: false }).last().waitFor();
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
      await assertAuditSeconds(desktop);
      await shot(desktop, 'pricing-audit-desktop-1440', desktop.getByRole('heading', { name: 'Recent changes', exact: true }).locator('../..'));
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
      await desktop.getByText('Premium — high perceived value, charge accordingly', { exact: true }).waitFor();
      const dreamOutcome = desktop.getByLabel('Dream outcome');
      await dreamOutcome.focus();
      await desktop.keyboard.press('ArrowRight');
      await Promise.all([
        desktop.waitForRequest((request) => request.url().endsWith('/api/admin/pricing/calculate-value') && request.postDataJSON().dreamOutcome === 9),
        desktop.keyboard.press('ArrowRight'),
      ]);
      // The request alone proves nothing — a frozen result panel would still
      // satisfy it. Wait for the recalculated score the fixture returns for
      // dreamOutcome 9 before leaving the tab.
      await desktop.getByText('7', { exact: true }).waitFor();
      await desktop.getByRole('button', { name: 'Offer builder', exact: true }).click();
      await desktop.getByText('Synthetic package', { exact: true }).waitFor();
      await desktop.getByRole('button', { name: 'Upsell engine', exact: true }).click();
      await desktop.getByText('Synthetic customer', { exact: true }).waitFor();
      await desktop.getByRole('button', { name: 'Send offer', exact: true }).click();
      await desktop.getByText('Upsell SMS sent!', { exact: true }).waitFor();
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
    await scenario('mobile pricing audit distinguishes writes within one minute', async () => {
      await mobile.goto(`${server.baseUrl}/admin/pricing-logic?section=logic`);
      await mobile.getByText('Loaded labor rate', { exact: true }).waitFor();
      await assertAuditSeconds(mobile);
      await assertFoundation(mobile);
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await shot(mobile, 'pricing-audit-mobile-390', mobile.getByRole('heading', { name: 'Recent changes', exact: true }).locator('../..'));
    });
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
