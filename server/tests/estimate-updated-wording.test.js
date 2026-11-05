// GATE_ESTIMATE_UPDATED_WORDING (owner 2026-11-04 "updated"): which sends count as a corrected estimate.
const wording = require('../services/estimate-updated-wording');

const SCOPE = { lines: [{ name: 'Synthetic pest service', cadence: 'quarterly' }], address: 'Synthetic street', property: null };
const TOTALS = { monthly: '94.80', annual: '1137.60', onetime: '0.00' };
const ROW = {
  monthly_total: '94.80', annual_total: '1137.60', onetime_total: '0',
  estimate_data: { engineResult: { generatedAt: '2026-11-03T18:33:00.000Z', lineItems: [
    { service: 'pest', frequency: 'quarterly', annual: 487, perApp: 121.75, costs: { labor: 9 }, margin: 0.9 },
    { service: 'lawn', selectedFrequency: 'monthly', annual: 650.6, monthly: 54.22, diagnosticMargin: 0.8 },
  ] }, result: { totals: { year1: 1137.6, year2: 1137.6, year2mo: 94.8 } } },
};
const PRICED = wording.pricedContent(ROW);
const withLines = (lines) => ({ ...ROW, estimate_data: { ...ROW.estimate_data, engineResult: { ...ROW.estimate_data.engineResult, lineItems: lines } } });

describe('offerChangedSinceDelivery', () => {
  test('no delivery stamp, or an unreadable one, is never an update', () => {
    expect(wording.offerChangedSinceDelivery(undefined, SCOPE, PRICED)).toBe(false);
    expect(wording.offerChangedSinceDelivery({}, SCOPE, PRICED)).toBe(false);
    expect(wording.offerChangedSinceDelivery({ scope: { lines: 'x' } }, SCOPE, PRICED)).toBe(false);
    expect(wording.offerChangedSinceDelivery({ scope: SCOPE }, null, PRICED)).toBe(false);
  });
  test('the same scope and prices, in another key order (JSONB), is the same quote', () => {
    const reordered = { property: null, address: 'Synthetic street', lines: [{ cadence: 'quarterly', name: 'Synthetic pest service' }] };
    const stampedPriced = JSON.parse(JSON.stringify({ engineTotals: PRICED.engineTotals, lines: PRICED.lines, totals: PRICED.totals }));
    expect(wording.offerChangedSinceDelivery({ scope: reordered, priced: stampedPriced }, SCOPE, wording.pricedContent(structuredClone(ROW)))).toBe(false);
  });
  test('a changed line, address or total is an update', () => {
    expect(wording.offerChangedSinceDelivery({ scope: SCOPE, priced: PRICED }, { ...SCOPE, lines: [...SCOPE.lines, { name: 'Synthetic lawn service' }] }, PRICED)).toBe(true);
    expect(wording.offerChangedSinceDelivery({ scope: SCOPE, priced: PRICED }, { ...SCOPE, address: 'Another synthetic street' }, PRICED)).toBe(true);
    expect(wording.offerChangedSinceDelivery({ scope: SCOPE, priced: PRICED }, SCOPE, wording.pricedContent({ ...ROW, annual_total: '1080' }))).toBe(true);
  });
  test('two line prices that move by offsetting amounts (same totals) are an update', () => {
    const [pest, lawn] = ROW.estimate_data.engineResult.lineItems;
    const offset = wording.pricedContent(withLines([{ ...pest, annual: 537 }, { ...lawn, annual: 600.6 }]));
    expect(offset.totals).toEqual(PRICED.totals);
    expect(wording.offerChangedSinceDelivery({ scope: SCOPE, priced: PRICED }, SCOPE, offset)).toBe(true);
  });
  test('a re-price that lands on the same prices (new generatedAt, costs, margins) is the same quote', () => {
    const [pest, lawn] = ROW.estimate_data.engineResult.lineItems;
    const repriced = withLines([{ ...pest, costs: { labor: 11 }, margin: 0.85 }, { ...lawn, diagnosticMargin: 0.7 }]);
    repriced.estimate_data.engineResult.generatedAt = '2026-11-04T09:00:00.000Z';
    expect(wording.offerChangedSinceDelivery({ scope: SCOPE, priced: PRICED }, SCOPE, wording.pricedContent(repriced))).toBe(false);
  });
  test('a stamp from before prices were stamped can only differ by scope', () => {
    expect(wording.offerChangedSinceDelivery({ scope: SCOPE }, SCOPE, wording.pricedContent({ ...ROW, annual_total: '1.00' }))).toBe(false);
  });
});

describe('pricedContent', () => {
  test('keeps each line identity and its customer-facing prices as fixed cents, and the totals', () => {
    expect(PRICED).toEqual({
      totals: TOTALS,
      lines: [
        { service: 'pest', frequency: 'quarterly', annual: '487.00', perApp: '121.75' },
        { service: 'lawn', frequency: 'monthly', annual: '650.60', monthly: '54.22' },
      ],
      engineTotals: { year1: 1137.6, year2: 1137.6, year2mo: 94.8 },
    });
  });
  test('an estimate without engine lines (or with unreadable data) still carries its totals', () => {
    expect(wording.pricedContent({ monthly_total: '10', estimate_data: 'not json' })).toEqual({ totals: { monthly: '10.00', annual: null, onetime: null }, lines: [], engineTotals: null });
  });
});

describe('deliveredTotals', () => {
  test('reads numeric columns (pg strings or numbers) as fixed cents, blanks as null', () => {
    expect(wording.deliveredTotals({ monthly_total: '94.8', annual_total: 1137.6, onetime_total: '0' })).toEqual(TOTALS);
    expect(wording.deliveredTotals({ monthly_total: null, annual_total: '', onetime_total: 'n/a' })).toEqual({ monthly: null, annual: null, onetime: null });
  });
});

describe('updatedEmailTemplateUsable', () => {
  test('only an active template with an active version', () => {
    expect(wording.updatedEmailTemplateUsable({ template: { status: 'active' }, activeVersion: { id: 'v' } })).toBe(true);
    expect(wording.updatedEmailTemplateUsable({ template: {}, activeVersion: { id: 'v' } })).toBe(true);
    expect(wording.updatedEmailTemplateUsable({ template: { status: 'disabled' }, activeVersion: { id: 'v' } })).toBe(false);
    expect(wording.updatedEmailTemplateUsable({ template: { status: 'active' }, activeVersion: null })).toBe(false);
    expect(wording.updatedEmailTemplateUsable(null)).toBe(false);
  });
});

describe('updatedWordingLive', () => {
  const before = process.env.GATE_ESTIMATE_UPDATED_WORDING;
  afterEach(() => {
    if (before === undefined) delete process.env.GATE_ESTIMATE_UPDATED_WORDING;
    else process.env.GATE_ESTIMATE_UPDATED_WORDING = before;
  });
  test('reads the gate at call time, strict true only', () => {
    process.env.GATE_ESTIMATE_UPDATED_WORDING = 'true';
    expect(wording.updatedWordingLive()).toBe(true);
    process.env.GATE_ESTIMATE_UPDATED_WORDING = '1';
    expect(wording.updatedWordingLive()).toBe(false);
    delete process.env.GATE_ESTIMATE_UPDATED_WORDING;
    expect(wording.updatedWordingLive()).toBe(false);
  });
});
