// GATE_ESTIMATE_UPDATED_WORDING (owner 2026-11-04 "updated"): which sends count as a corrected estimate.
const wording = require('../services/estimate-updated-wording');

const SCOPE = { lines: [{ name: 'Synthetic pest service', cadence: 'quarterly' }], address: 'Synthetic street', property: null };
const TOTALS = { monthly: '94.80', annual: '1137.60', onetime: '0.00' };

describe('offerChangedSinceDelivery', () => {
  test('no delivery stamp, or an unreadable one, is never an update', () => {
    expect(wording.offerChangedSinceDelivery(undefined, SCOPE, TOTALS)).toBe(false);
    expect(wording.offerChangedSinceDelivery({}, SCOPE, TOTALS)).toBe(false);
    expect(wording.offerChangedSinceDelivery({ scope: { lines: 'x' } }, SCOPE, TOTALS)).toBe(false);
    expect(wording.offerChangedSinceDelivery({ scope: SCOPE }, null, TOTALS)).toBe(false);
  });
  test('the same scope in another key order and the same totals is the same quote', () => {
    const reordered = { property: null, address: 'Synthetic street', lines: [{ cadence: 'quarterly', name: 'Synthetic pest service' }] };
    expect(wording.offerChangedSinceDelivery({ scope: reordered, totals: TOTALS }, SCOPE, { ...TOTALS })).toBe(false);
  });
  test('a changed line, address or total is an update', () => {
    expect(wording.offerChangedSinceDelivery({ scope: SCOPE, totals: TOTALS }, { ...SCOPE, lines: [...SCOPE.lines, { name: 'Synthetic lawn service' }] }, TOTALS)).toBe(true);
    expect(wording.offerChangedSinceDelivery({ scope: SCOPE, totals: TOTALS }, { ...SCOPE, address: 'Another synthetic street' }, TOTALS)).toBe(true);
    expect(wording.offerChangedSinceDelivery({ scope: SCOPE, totals: TOTALS }, SCOPE, { ...TOTALS, annual: '1080.00' })).toBe(true);
  });
  test('a stamp from before totals were stamped can only differ by scope', () => {
    expect(wording.offerChangedSinceDelivery({ scope: SCOPE }, SCOPE, { ...TOTALS, annual: '1.00' })).toBe(false);
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
