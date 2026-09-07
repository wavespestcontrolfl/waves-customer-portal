const { _test: { dispatchReadiness }, buildSprayCheck } = require('../services/job-card');

const now = new Date('2026-09-04T13:00:00Z');
const product = { id: 'product', name: 'Synthetic liquid', inventory_on_hand: 1, inventory_unit: 'gal', low_stock_threshold: 0, default_rate_per_1000: 2, rate_unit: 'fl_oz', label_verified_at: now, max_wind_mph: 10 };
const line = { selected: true, product, planMix: { amount: 256, amountUnit: 'fl_oz' } };
const base = { facts: { serviceId: 'visit' }, now, isToday: true, lines: [line], blocks: [], tank: { calibrated: true }, sprayCheck: { hold: false, verdicts: [{ verdict: 'ok' }] } };

test('weather holds and a stock shortage survive missing readings and a blocked plan', () => {
  const hourly = [{ startTime: now.toISOString(), windMph: 20, temperatureF: null, rainChance: null }];
  const result = dispatchReadiness({ ...base, sprayCheck: buildSprayCheck({ products: [product], hourly, now }), blocks: [{ code: 'inventory_shortage' }] });
  expect(result.issues).toEqual(expect.arrayContaining([
    { kind: 'weather', status: 'hold', label: 'Weather hold' },
    { kind: 'stock', status: 'hold', label: 'Company stock short' },
    { kind: 'plan', status: 'hold', label: 'Plan blocked' },
  ]));
});

test('stock uses inventory units and does not count unselected conditional products', () => {
  const enough = { ...line, planMix: { amount: 64, amountUnit: 'fl_oz' } };
  const optional = { ...line, selected: false, product: { ...product, id: 'optional', inventory_on_hand: 0 } };
  expect(dispatchReadiness({ ...base, lines: [enough, optional] }).issues).toEqual([]);
});

test('a product repeated by an add-on uses the same selected line as its Job Card', () => {
  const enough = { ...line, planMix: { amount: 64, amountUnit: 'fl_oz' } };
  expect(dispatchReadiness({ ...base, lines: [enough, line] }).issues).toEqual([]);
  const conditional = { ...line, selected: false };
  expect(dispatchReadiness({ ...base, lines: [conditional, enough] }).issues).toEqual([]);
});

test('missing or unconvertible inventory evidence never becomes a stock clearance', () => {
  for (const change of [{ inventory_on_hand: null }, { inventory_unit: 'each' }]) {
    const result = dispatchReadiness({ ...base, lines: [{ ...line, product: { ...product, ...change } }] });
    expect(result.issues).toContainEqual({ kind: 'stock', status: 'unknown', label: 'Stock unverified' });
  }
});

test('future weather stays on the visit day and unavailable rig evidence stays unknown', () => {
  const result = dispatchReadiness({ ...base, isToday: false, tank: { calibrated: false, unavailable: true } });
  expect(result.issues).toContainEqual({ kind: 'weather', status: 'unknown', label: 'Weather on visit day' });
  expect(result.issues).toContainEqual({ kind: 'equipment', status: 'unknown', label: 'Rig check unavailable' });
});

test('per-gallon dilution does not require a carrier rig unless an area rate governs it', () => {
  const dilution = { ...line, planMix: null, product: { ...product, default_rate_per_1000: null, default_rate: '1', default_unit: 'fl_oz/gal' } };
  const summary = input => dispatchReadiness({ ...base, lines: [input], tank: { calibrated: false } });
  expect(summary(dilution).issues.some(issue => issue.kind === 'equipment')).toBe(false);
  expect(summary({ ...dilution, planMix: { ratePer1000: 2 } }).issues).toContainEqual({ kind: 'equipment', status: 'hold', label: 'Rig needed' });
});
