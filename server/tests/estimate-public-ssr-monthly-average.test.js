// GATE_ESTIMATE_MONTHLY_AVERAGE on the LEGACY server-rendered estimate page
// (renderPage: use_v2_view=false rows and the GrowthBook control). Same shared
// builder and eligibility rules as the email, the PDF and the React page.
const mockGate = { on: true };
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: jest.fn((gate) => (gate === 'estimateMonthlyAverage' ? mockGate.on : actual.isEnabled(gate))) };
});

const { renderPage } = require('../routes/estimate-public');

const tree = { service: 'tree_shrub', tier: 'standard', frequency: 6, visitsPerYear: 6, monthly: 66.75, annual: 801, perApp: 133.5, palmCountSource: 'service_line', pricingKnobs: { perPalmAnnual: 0, minutesPerPalmVisit: 0 } };
const lawn = { service: 'lawn_care', frequency: 9, visitsPerYear: 9, monthly: 35.5, annual: 426, perApp: 47.33 };
const mosquito = { service: 'mosquito', frequency: 6, visitsPerYear: 6, monthly: 30.56, annual: 366.66, perApp: 61.11 };

function estimate(monthlyTotal, overrides = {}) {
  return {
    id: 'ssr-avg', status: 'sent', customerName: 'Test Customer', address: '1 Main St, Bradenton, FL 34203',
    monthlyTotal, annualTotal: Math.round(monthlyTotal * 12 * 100) / 100, onetimeTotal: 0, quoteRequired: false, ...overrides,
  };
}
const data = (...lineItems) => ({ result: { lineItems, oneTime: { items: [], membershipFee: 0 } } });
const render = (est, estData) => renderPage('ssr-avg-token', est, estData);
const cents = (text) => Math.round(parseFloat(text.replace(/[^0-9.]/g, '')) * 100);
const averageLines = (html) => [...html.matchAll(/<div class="day-price" data-monthly-average data-avg-pref-off="\d+">(about \$[\d.,]+ a month)<\/div>/g)].map((m) => m[1]);

beforeEach(() => { mockGate.on = true; });

describe('legacy SSR page: monthly average', () => {
  test('the page script still parses and wires the hide-on-change hooks', () => {
    const html = render(estimate(66.75), data(tree));
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const main = scripts.find((code) => code.includes('syncMonthlyAverageVisibility'));
    expect(main).toBeDefined();
    expect(() => new (require('vm').Script)(main)).not.toThrow();
    expect(main).toContain("syncMonthlyAverageVisibility(null, pref === 'prepay_annual')");
    expect(main).toContain('syncMonthlyAverageVisibility(prefOff, null)');
  });

  test('single service: the per-application card stays the price, "about $X a month" hangs under it, context prints once', () => {
    const html = render(estimate(66.75), data(tree));
    expect(html).toContain('$133.50');
    expect(averageLines(html)).toEqual(['about $66.75 a month']);
    expect(html.match(/Averaged over the year\. You pay after each application\./g)).toHaveLength(1);
    expect(html).not.toContain('data-monthly-average-plan');
  });

  test('gate off: no marker, no script hook, and the page is the gate-on page minus the additions (byte-identical)', () => {
    const on = render(estimate(66.75), data(tree));
    mockGate.on = false;
    const off = render(estimate(66.75), data(tree));
    expect(off).not.toMatch(/data-monthly-average|syncMonthlyAverageVisibility|a month|Averaged over the year/);
    const stripped = on
      .replace(/\s*<div class="day-price" data-monthly-average[^>]*>[^<]*<\/div>/g, '')
      .replace(/ {2}\/\/ GATE_ESTIMATE_MONTHLY_AVERAGE: the average is computed[\s\S]*?\n {2}\}\n\n(?= {2}function syncPaymentSetupCards)/, '')
      .replace(/ syncMonthlyAverageVisibility\([^)]*\);/g, '');
    expect(stripped).toBe(off);
  });

  test('multi service: the lines add up to the plan line, which equals the stored monthly total', () => {
    const html = render(estimate(102.25), data(tree, lawn));
    const lines = averageLines(html);
    expect([...lines].sort()).toEqual(['about $35.50 a month', 'about $66.75 a month']);
    const plan = html.match(/data-monthly-average-plan[^>]*><span>([^<]*)<\/span><span[^>]*>(about \$[\d.,]+ a month)/);
    expect(plan[1]).toBe('Your plan averages');
    expect(cents(plan[2])).toBe(10225);
    expect(lines.reduce((sum, line) => sum + cents(line), 0)).toBe(10225);
    expect(html.match(/Averaged over the year\. You pay after each application\./g)).toHaveLength(1);
  });

  test('rounding remainder: three services that do not divide evenly still add up to the stored total to the cent', () => {
    const html = render(estimate(132.8), data(tree, lawn, mosquito));
    const lines = averageLines(html);
    expect(lines).toHaveLength(3);
    expect(lines.reduce((sum, line) => sum + cents(line), 0)).toBe(13280);
    expect(cents(html.match(/data-monthly-average-plan[\s\S]*?(about \$[\d.,]+ a month)/)[1])).toBe(13280);
  });

  test('the one-time notice follows an additive one-time row (flea), not an either/or option', () => {
    const flea = { service: 'flea', name: 'Flea Treatment', label: 'Flea Treatment', price: 150, amount: 150, visits: 1 };
    const withFlea = { result: { lineItems: [tree], oneTime: { items: [flea], membershipFee: 0 } } };
    const html = render(estimate(66.75, { onetimeTotal: 150 }), withFlea);
    expect(html).toContain('One-time charges are not in the average.');
    expect(render(estimate(66.75), data(tree))).not.toContain('One-time charges are not in the average.');
  });

  test('a wizard draft with the commercial marker never shows the average', () => {
    const marked = { ...data(tree), commercialEstimatedPricing: true };
    expect(render(estimate(66.75), marked)).not.toContain('data-monthly-average');
  });

  test('a plan credit: the pre-credit cards no longer cover the total, yet the credit line and a plan average equal to the stored total show', () => {
    const credit = { label: 'Referral Credit', type: 'FIXED', value: 12, amount: 12, recurringAmount: 12 };
    // 66.75 + 35.50 = 102.25 before the $1.00/month credit; the stored net is 101.25.
    const estData = data(tree, lawn);
    estData.result.manualDiscount = credit;
    const html = render(estimate(101.25), estData);
    expect(html).toContain('data-monthly-average-plan');
    expect(html).toContain('Referral Credit');
    expect(html).toContain('&minus;$1.00 a month');
    const rows = [...html.matchAll(/<span>([^<]+)<\/span><span style="white-space:nowrap;font-variant-numeric:tabular-nums">(about \$[\d.,]+ a month)<\/span>/g)].map((m) => cents(m[2]));
    // The last match is the plan line; the service lines before it, less the $1.00 credit, add up to it.
    expect(rows.slice(0, -1).reduce((sum, c) => sum + c, 0) - 100).toBe(10125);
    const plan = html.match(/data-monthly-average-plan[\s\S]*?(about \$[\d.,]+ a month)/);
    expect(cents(plan[1])).toBe(10125);
    expect(html.match(/Averaged over the year\. You pay after each application\./g)).toHaveLength(1);
  });

  test('withheld when the cards do not reconcile to the stored monthly total', () => {
    expect(render(estimate(80), data(tree, lawn))).not.toContain('data-monthly-average');
  });

  test('plans the gate leaves alone: quote-required, accepted, declined', () => {
    for (const overrides of [{ quoteRequired: true }, { status: 'accepted' }, { status: 'declined' }]) {
      expect(render(estimate(66.75, overrides), data(tree))).not.toContain('data-monthly-average');
    }
  });
});
