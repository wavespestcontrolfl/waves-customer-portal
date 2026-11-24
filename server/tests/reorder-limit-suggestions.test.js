const {
  packInInventoryUnit,
  pickPriceRow,
  usageHistory,
  applyDispatchPriceCheck,
  isBlackoutFertilizer,
  blackoutWindow,
  weeklyTotals,
  suggestLimitsForProduct,
} = require('../services/procurement/reorder-limit-suggestions');
const { parseArgs, render } = require('../scripts/suggest-reorder-limits');

const steady = (perDay, days = 56) => Array.from({ length: days }, (_, i) => ({ daysAgo: i, qty: perDay }));
const product = (over = {}) => ({ id: 'p1', name: 'LESCO CrossCheck Plus', inventoryUnit: 'gal', pack: { pack: 1 }, ...over });

describe('pack size (read the dispatcher\'s way)', () => {
  test('converts a readable pack to the stock unit', () => {
    expect(packInInventoryUnit('1 gal', 'fl_oz')).toEqual({ pack: 128 });
    expect(packInInventoryUnit('50 lb', 'lb')).toEqual({ pack: 50 });
    expect(packInInventoryUnit('78 fl oz', 'fl_oz')).toEqual({ pack: 78 });
  });

  test('a count pack the dispatcher accepts is read as a count', () => {
    expect(packInInventoryUnit('10 stations', 'each')).toEqual({ pack: 10 });
  });

  test('bare ounces, cross-dimension and missing packs are refused, not guessed', () => {
    expect(packInInventoryUnit('10 oz', 'lb').error).toBe('ambiguous_unit');
    expect(packInInventoryUnit('1 gal', 'lb').error).toBe('pack_unit_mismatch');
    expect(packInInventoryUnit('', 'gal').error).toBe('no_pack_size');
    expect(packInInventoryUnit('1 case', 'each').error).toBe('no_pack_size');
  });

  test('a 1 fl oz pack stocked in gal keeps full precision', () => {
    expect(packInInventoryUnit('1 fl oz', 'gal').pack).toBe(0.0078125);
  });
});

describe('price row choice', () => {
  const rows = [
    { vendor_id: 'other', vendor_name: 'Amazon', quantity: '1 qt', is_best_price: true },
    { vendor_id: 'siteone', vendor_name: 'SiteOne', quantity: '1 gal', is_best_price: false },
  ];
  test('the configured vendor\'s row, never another vendor\'s pack', () => {
    expect(pickPriceRow(rows, { auto_reorder_vendor_id: 'siteone', vendor_name: 'SiteOne' }).row.quantity).toBe('1 gal');
    const none = pickPriceRow(rows.slice(0, 1), { auto_reorder_vendor_id: 'siteone', vendor_name: 'SiteOne' });
    expect(none.row).toBeNull();
    expect(none.vendorName).toBe('SiteOne');
  });
  test('no vendor configured: best price, and the name says so', () => {
    const r = pickPriceRow(rows, { auto_reorder_vendor_id: null });
    expect(r.row.vendor_name).toBe('Amazon');
    expect(r.vendorName).toMatch(/best price, no vendor set/);
  });
  test('no vendor and no best-price winner: no pack is guessed', () => {
    expect(pickPriceRow(rows.slice(1), { auto_reorder_vendor_id: null }).row).toBeNull();
  });
});

describe('fertilizer blackout', () => {
  test('N or P above zero counts; potash-only and non-fertilizer do not', () => {
    expect(isBlackoutFertilizer('LESCO 24-0-11 with PolyPlus OPTI')).toBe(true);
    expect(isBlackoutFertilizer('Dimension 18-0-10')).toBe(true);
    expect(isBlackoutFertilizer('LESCO 0-0-28')).toBe(false);
    expect(isBlackoutFertilizer('Taurus SC')).toBe(false);
  });

  test('window: days to June 1 and in-blackout months', () => {
    expect(blackoutWindow('2026-05-22')).toEqual({ inBlackout: false, daysToJune1: 10 });
    expect(blackoutWindow('2026-07-04').inBlackout).toBe(true);
    expect(blackoutWindow('2026-11-24').daysToJune1).toBe(189);
  });
});

describe('suggestLimitsForProduct', () => {
  test('steady use: lead + one-week buffer, reorder rounded up to whole packs', () => {
    const r = suggestLimitsForProduct({ product: product(), usage: steady(0.1), today: '2026-11-24' });
    expect(r.dailyUse).toBe(0.1);
    expect(r.suggestedThreshold).toBe(1); // 3 d + 7 d of 0.1 gal
    expect(r.suggestedReorder).toBe(3); // 21 d = 2.1 gal -> 3 jugs
    expect(r.status).toBe('ok');
  });

  test('a spiky peak week raises the safety stock above one week', () => {
    const usage = [...steady(0.1), { daysAgo: 2, qty: 2 }];
    const r = suggestLimitsForProduct({ product: product(), usage, today: '2026-11-24' });
    const daily = (2.8 + 2) / 28; // the 4-week rate is the higher one
    expect(r.basis).toBe('4-week use');
    const peak = 0.7 + 2;
    expect(r.suggestedThreshold).toBeCloseTo(3 * daily + (peak - daily * 7), 2);
  });

  test('the lawn schedule wins when it is above recorded use', () => {
    const r = suggestLimitsForProduct({ product: product({ inventoryUnit: 'lb', pack: { pack: 50 } }), usage: steady(1), forecastDemand: 280, today: '2026-11-24' });
    expect(r.basis).toBe('lawn schedule');
    expect(r.dailyUse).toBe(10);
    expect(r.suggestedReorder).toBe(250); // 210 lb -> 5 bags
  });

  test('a recent ramp uses the 4-week rate', () => {
    const usage = steady(0.2, 28);
    const r = suggestLimitsForProduct({ product: product(), usage, today: '2026-11-24' });
    expect(r.basis).toBe('4-week use');
    expect(r.dailyUse).toBe(0.2);
  });

  test('no use and nothing scheduled is flagged, not guessed', () => {
    const r = suggestLimitsForProduct({ product: product(), usage: [], today: '2026-11-24' });
    expect(r.status).toBe('no_usage');
    expect(r.suggestedThreshold).toBeNull();
  });

  test('only unconvertible rows: flagged for unit review, not hidden as no use', () => {
    const r = suggestLimitsForProduct({ product: product(), usage: [], unconverted: 4, today: '2026-11-24' });
    expect(r.status).toBe('needs_unit_review');
  });

  test('small packs: the 4-decimal amount maps back to the same pack count in dispatch', () => {
    const { vendorOrderQuantity } = require('../services/procurement/order-dispatch');
    const r = suggestLimitsForProduct({ product: product({ pack: { pack: 0.0078125 } }), usage: steady(0.00223), today: '2026-11-24' });
    expect(r.packs).toBe(6); // 0.0468 gal / 0.0078125 = 5.99 -> 6
    expect(r.suggestedReorder).toBe(0.0468); // 0.046875 floored to the catalog's 4 decimals
    const dispatched = vendorOrderQuantity({ adapter: { packagedQuantity: true }, request: { requested_quantity: r.suggestedReorder, unit: 'gal' }, pricing: { quantity: '1 fl oz' } });
    expect(dispatched.quantity).toBe(6);
  });

  test('no stock unit is flagged', () => {
    const r = suggestLimitsForProduct({ product: product({ inventoryUnit: null }), usage: steady(1), today: '2026-11-24' });
    expect(r.status).toBe('no_unit');
  });

  test('unreadable pack size leaves the amount unrounded and says so', () => {
    const r = suggestLimitsForProduct({ product: product({ pack: { error: 'ambiguous_unit', message: 'unresolved ounce' } }), usage: steady(0.1), today: '2026-11-24' });
    expect(r.status).toBe('no_pack_size');
    expect(r.suggestedReorder).toBe(2.1);
    expect(r.note).toContain('unresolved ounce');
  });

  test('N/P fertilizer holds inside the blackout', () => {
    const r = suggestLimitsForProduct({ product: product({ name: 'LESCO 24-0-11', inventoryUnit: 'lb', pack: { pack: 50 } }), usage: steady(5), today: '2026-07-01' });
    expect(r.status).toBe('blackout_hold');
    expect(r.suggestedReorder).toBeNull();
  });

  test('N/P fertilizer near June 1 is capped to use before the blackout', () => {
    const r = suggestLimitsForProduct({ product: product({ name: 'LESCO 24-0-11', inventoryUnit: 'lb', pack: { pack: 50 } }), usage: steady(5), today: '2026-05-18' });
    // 14 days to June 1 = 70 lb usable; threshold 50 lb leaves 20 lb: no
    // whole 50 lb bag fits before the blackout, so order none.
    expect(r.status).toBe('blackout_capped');
    expect(r.suggestedThreshold).toBe(50);
    expect(r.suggestedReorder).toBe(0);
  });

  test('rounding up to bags never crosses June 1', () => {
    // 31 days left at 5 lb/day = 155 lb; threshold 50 leaves 105 lb: two 50 lb
    // bags fit, the uncapped three (150 lb) would not.
    const r = suggestLimitsForProduct({ product: product({ name: 'LESCO 24-0-11', inventoryUnit: 'lb', pack: { pack: 50 } }), usage: steady(5), today: '2026-05-01' });
    expect(r.status).toBe('blackout_capped');
    expect(r.suggestedReorder).toBe(100);
  });

  test('catalog analysis counts when the name has no N-P-K', () => {
    const catalog = { name: 'Turf Food Blend', fertilizer_analysis: { n: 12, p: 0, k: 6 } };
    const r = suggestLimitsForProduct({ product: product({ name: catalog.name, catalog, inventoryUnit: 'lb', pack: { pack: 50 } }), usage: steady(5), today: '2026-07-01' });
    expect(r.status).toBe('blackout_hold');
  });

  test('a count-ordering vendor gets whole items, not price-tier packs', () => {
    const r = suggestLimitsForProduct({ product: product({ name: 'Yard sticker', inventoryUnit: 'each', pack: null, countOrder: true }), usage: steady(3.82), today: '2026-11-24' });
    expect(r.suggestedReorder).toBe(81); // 21 d x 3.82 = 80.2 -> 81 stickers
    expect(r.status).toBe('ok');
  });

  test('N/P fertilizer days before June 1 orders nothing more', () => {
    const r = suggestLimitsForProduct({ product: product({ name: 'LESCO 24-0-11', inventoryUnit: 'lb', pack: { pack: 50 } }), usage: steady(5), today: '2026-05-29' });
    expect(r.suggestedReorder).toBe(0);
  });
});

test('weeklyTotals buckets by week, newest last', () => {
  expect(weeklyTotals([{ daysAgo: 0, qty: 1 }, { daysAgo: 8, qty: 2 }, { daysAgo: 60, qty: 9 }], 21)).toEqual([0, 2, 1]);
});

describe('script output', () => {
  const result = {
    today: '2026-11-24',
    options: { leadDays: 3, bufferDays: 7, reorderDays: 21 },
    forecastError: null,
    products: [
      { name: 'CrossCheck', unit: 'gal', status: 'ok', suggestedThreshold: 1, note: null },
      { name: 'Unused, "old"', unit: 'lb', status: 'no_usage', note: 'No use' },
      { name: 'Uncounted', unit: null, status: 'no_unit', usageRecords: 0, note: null },
      { name: 'Used uncounted', unit: null, status: 'no_unit', usageRecords: 3, note: null },
    ],
  };

  test('flags parse; unknown flags throw', () => {
    expect(parseArgs(['--csv', '--lead-days=5', '--all'])).toEqual({ format: 'csv', all: true, options: { leadDays: 5 } });
    expect(() => parseArgs(['--write'])).toThrow(/Unknown argument/);
  });

  test('table hides no-usage rows unless --all; csv quotes', () => {
    const table = render(result, { format: 'table', all: false });
    expect(table).not.toContain('Unused');
    expect(table).not.toContain('Uncounted');
    expect(table).toContain('Used uncounted');
    const csv = render({ ...result, forecastError: 'lawn forecast failed: boom' }, { format: 'csv', all: true });
    expect(csv.split('\n')[0]).toContain('Warning: lawn forecast failed: boom');
    expect(csv).toContain('"Unused, ""old"""');
  });

  test('csv neutralizes formula-prefixed names', () => {
    const csv = render({ ...result, products: [{ name: '=HYPERLINK("x")', status: 'ok' }] }, { format: 'csv', all: true });
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('usageHistory', () => {
  test('the service record date wins over the scheduled date', () => {
    const rows = [{ quantity: 4, unit: 'fl_oz', created_at: '2026-11-24T15:00:00Z', visit_date: '2026-11-10', service_date: '2026-11-12' }];
    expect(usageHistory(rows, 'fl_oz', '2026-11-24', 56).usage[0].daysAgo).toBe(12);
  });

  test('a late close-out counts on the visit date, not the entry date', () => {
    const rows = [{ quantity: 4, unit: 'fl_oz', created_at: '2026-11-24T15:00:00Z', visit_date: '2026-11-10' }];
    expect(usageHistory(rows, 'fl_oz', '2026-11-24', 56).usage).toEqual([{ daysAgo: 14, qty: 4 }]);
  });

  test('an evening ET entry with no visit counts on its ET date', () => {
    const rows = [{ quantity: 1, unit: 'gal', created_at: '2026-11-24T02:30:00Z' }]; // 9:30 PM ET on 11-23
    expect(usageHistory(rows, 'gal', '2026-11-24', 56).usage[0].daysAgo).toBe(1);
  });

  test('rows outside the window are not counted, even as unit mismatches', () => {
    const rows = [{ quantity: 1, unit: 'lb', created_at: '2026-11-24T15:00:00Z', visit_date: '2026-09-01' }];
    expect(usageHistory(rows, 'gal', '2026-11-24', 56)).toEqual({ usage: [], unconverted: 0, records: 0 });
  });
});

describe('applyDispatchPriceCheck', () => {
  const ok = () => ({ status: 'ok', suggestedReorder: 2, note: null });
  test('configured vendor with no price row or no SKU: flagged no_price, amount kept', () => {
    const a = ok(); applyDispatchPriceCheck(a, { name: 'SiteOne', row: null });
    expect(a.status).toBe('no_price');
    expect(a.suggestedReorder).toBe(2);
    const b = ok(); applyDispatchPriceCheck(b, { name: 'SiteOne', row: { vendor_sku: null } });
    expect(b.note).toMatch(/no vendor SKU/);
  });
  test('a usable row or no configured vendor changes nothing', () => {
    const a = ok(); applyDispatchPriceCheck(a, { name: 'SiteOne', row: { vendor_sku: 'D1' } });
    const b = ok(); applyDispatchPriceCheck(b, null);
    expect([a.status, b.status]).toEqual(['ok', 'ok']);
  });
});
