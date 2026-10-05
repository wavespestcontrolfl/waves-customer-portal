const { rankCandidates, findOpportunity, DEFAULTS } = require('../services/price-scan/compare');
const { selectAdapterKey } = require('../services/price-scan/adapters/registry');

describe('price-scan compare', () => {
  const baseline = { price: 95, quantity: '78 oz', vendor: 'SiteOne' };

  test('cheaper same-size candidate is an opportunity', () => {
    const r = findOpportunity(baseline, [{ price: 89, quantity: '78 oz', vendor: 'DoMyOwn', source_url: 'https://www.domyown.com/p' }]);
    expect(r.isOpportunity).toBe(true);
    expect(r.best.vendor).toBe('DoMyOwn');
    expect(r.savingsPct).toBeCloseTo(0.0632, 3);
    expect(r.estSavingsOnBaseline).toBeCloseTo(6.0, 1);
  });

  test('more expensive candidate is not an opportunity', () => {
    const r = findOpportunity(baseline, [{ price: 99, quantity: '78 oz', vendor: 'X' }]);
    expect(r.isOpportunity).toBe(false);
    expect(r.best.vendor).toBe('X');
  });

  test('below 2% threshold is not an opportunity', () => {
    const r = findOpportunity(baseline, [{ price: 94.5, quantity: '78 oz', vendor: 'X' }]);
    expect(r.isOpportunity).toBe(false);
  });

  test('bigger drum cheaper per oz wins on $/oz', () => {
    const r = findOpportunity(baseline, [{ price: 300, quantity: '2.5 gal', vendor: 'Drum', source_url: 'https://www.domyown.com/drum' }]);
    expect(r.isOpportunity).toBe(true);
    expect(r.best.perOz).toBeCloseTo(0.9375, 4);
    // (1.217949 - 0.9375) * 78 ~= 21.87
    expect(r.estSavingsOnBaseline).toBeCloseTo(21.87, 1);
  });

  test('non-USD candidates are dropped from ranking (USD baseline)', () => {
    const ranked = rankCandidates([
      { price: 50, quantity: '78 oz', vendor: 'CA', currency: 'CAD' },
      { price: 89, quantity: '78 oz', vendor: 'US', currency: 'USD' },
    ]);
    expect(ranked.map((c) => c.vendor)).toEqual(['US']); // CAD dropped despite lower number
  });

  test('out-of-stock is excluded from the winner by default', () => {
    const r = findOpportunity(baseline, [
      { price: 70, quantity: '78 oz', vendor: 'Cheap', availability_status: 'out_of_stock' },
      { price: 89, quantity: '78 oz', vendor: 'InStock', availability_status: 'in_stock' },
    ]);
    expect(r.best.vendor).toBe('InStock');
  });

  test('backorder is excluded from the winner (not buyable now)', () => {
    const r = findOpportunity(baseline, [
      { price: 60, quantity: '78 oz', vendor: 'Back', availability: 'backorder' },
      { price: 89, quantity: '78 oz', vendor: 'InStock', availability: 'in_stock' },
    ]);
    expect(r.best.vendor).toBe('InStock');
  });

  test('out-of-stock via raw extractor field (availability) is also excluded', () => {
    // extract.js emits the enum under `availability`; compare must honor both
    // field names so a raw extractor offer cannot win while sold out.
    const ranked = rankCandidates([
      { price: 50, quantity: '78 oz', vendor: 'Sold', availability: 'out_of_stock' },
      { price: 89, quantity: '78 oz', vendor: 'InStock', availability: 'in_stock' },
    ]);
    expect(ranked.map((c) => c.vendor)).toEqual(['InStock']);
  });

  test('ranks candidates cheapest-first on $/oz', () => {
    const ranked = rankCandidates([
      { price: 95, quantity: '78 oz', vendor: 'A' },
      { price: 80, quantity: '78 oz', vendor: 'B' },
      { price: 0, quantity: '78 oz', vendor: 'bad' },
      { price: 60, quantity: 'each', vendor: 'unparseable' },
    ]);
    expect(ranked.map((c) => c.vendor)).toEqual(['B', 'A']);
  });

  test('no baseline / no candidates -> no opportunity', () => {
    expect(findOpportunity(null, [{ price: 1, quantity: '78 oz' }]).isOpportunity).toBe(false);
    expect(findOpportunity(baseline, []).isOpportunity).toBe(false);
  });
});

describe('price-scan compare — delivered (landed) prices', () => {
  const baseline = { price: 95, quantity: '78 oz', vendor: 'SiteOne' };

  test('SiteOne baseline uses its own rule: free shipping, landed = sticker', () => {
    const r = findOpportunity(baseline, []);
    expect(r.baseline.shipping).toMatchObject({ amount: 0, basis: 'free' });
    expect(r.baseline.landedPrice).toBe(95);
  });

  test('candidates carry landedPrice + shipping; perOz stays the sticker $/oz', () => {
    const [c] = rankCandidates([{ price: 50, quantity: '78 oz', vendor: 'Forestry', source_url: 'https://www.forestrydistributing.com/p' }]);
    expect(c.shipping).toMatchObject({ amount: 15, basis: 'estimated' });
    expect(c.landedPrice).toBe(65);
    expect(c.perOz).toBeCloseTo(50 / 78, 6);
    expect(c.landedPerOz).toBeCloseTo(65 / 78, 6);
  });

  test('a cheaper STICKER price that loses after shipping is NOT an opportunity', () => {
    // $90 + ~$15 est. freight = $105 delivered vs SiteOne $95 free.
    const r = findOpportunity(baseline, [{ price: 90, quantity: '78 oz', vendor: 'GCI', source_url: 'https://gciturfacademy.com/products/x' }]);
    expect(r.best.perOz).toBeLessThan(r.baseline.perOz); // sticker looks cheaper
    expect(r.isOpportunity).toBe(false);
    expect(r.savingsPct).toBe(0);
  });

  test('ranking is by landed price: a free-shipping vendor beats a lower sticker with freight', () => {
    const ranked = rankCandidates([
      { price: 85, quantity: '78 oz', vendor: 'Forestry', source_url: 'https://www.forestrydistributing.com/p' }, // 100 delivered
      { price: 92, quantity: '78 oz', vendor: 'DoMyOwn', source_url: 'https://www.domyown.com/p-1.html' }, // 92 delivered
    ]);
    expect(ranked.map((c) => c.vendor)).toEqual(['DoMyOwn', 'Forestry']);
  });

  test('savings are computed on delivered prices', () => {
    const r = findOpportunity(baseline, [{ price: 80, quantity: '78 oz', vendor: 'DoMyOwn', source_url: 'https://www.domyown.com/p-1.html' }]);
    expect(r.isOpportunity).toBe(true);
    expect(r.savingsPct).toBeCloseTo(15 / 95, 3);
    expect(r.best.landedPrice).toBe(80);
  });

  test('an estimated-shipping vendor can still win, and stays labelled estimated', () => {
    const r = findOpportunity(baseline, [{ price: 60, quantity: '78 oz', vendor: 'Forestry', source_url: 'https://www.forestrydistributing.com/p' }]);
    expect(r.isOpportunity).toBe(true);
    expect(r.best.shipping.basis).toBe('estimated');
    expect(r.best.landedPrice).toBe(75);
    expect(r.estSavingsOnBaseline).toBeCloseTo(20, 1);
  });

  test('a free_shipping flag on a candidate is ignored: Solutions stays an estimate', () => {
    const cand = { price: 90, quantity: '78 oz', vendor: 'Solutions', source_url: 'https://www.solutionsstores.com/p', free_shipping: true };
    const r = findOpportunity(baseline, [cand]);
    expect(r.best.shipping.basis).toBe('estimated');
    expect(r.isOpportunity).toBe(false);
  });

  test('a shipping object attached by the caller wins over the rule lookup', () => {
    const r = findOpportunity(baseline, [{ price: 80, quantity: '78 oz', vendor: 'X', source_url: 'https://www.domyown.com/p', shipping: { amount: 20, basis: 'flat' } }]);
    expect(r.best.landedPrice).toBe(100);
    expect(r.isOpportunity).toBe(false);
  });

  test('min-savings thresholds are unchanged (2% and $1)', () => {
    expect(DEFAULTS.minSavingsPct).toBe(0.02);
    expect(DEFAULTS.minSavingsUsd).toBe(1.0);
  });
});

describe('adapter registry', () => {
  test('selects by host', () => {
    expect(selectAdapterKey({ url: 'https://www.domyown.com/taurus-sc-p-1816.html' })).toBe('domyown');
    expect(selectAdapterKey({ url: 'https://www.solutionsstores.com/taurus-sc' })).toBe('solutions');
    expect(selectAdapterKey({ name: 'Keystone Pest Solutions' })).toBe('keystone');
    expect(selectAdapterKey({ url: 'https://veseris.com/p/123' })).toBe('veseris');
  });
  test('routes the new vendors by anchored host, and by name only when there is no host', () => {
    expect(selectAdapterKey({ website: 'https://diypestcontrol.com' })).toBe('diypest');
    expect(selectAdapterKey({ url: 'https://www.diypestcontrol.com/qp-bifenthrin-it-7-9-f' })).toBe('diypest');
    expect(selectAdapterKey({ name: 'DIY Pest Control' })).toBe('diypest');
    expect(selectAdapterKey({ website: 'https://www.forestrydistributing.com' })).toBe('forestry');
    expect(selectAdapterKey({ name: 'Forestry Distributing' })).toBe('forestry');
    expect(selectAdapterKey({ website: 'https://gemplers.com' })).toBe('shopify');
    expect(selectAdapterKey({ website: 'https://golfcourselawn.store' })).toBe('shopify');
  });
  test('spoofed hosts for the new vendors are NOT routed to their adapters', () => {
    for (const website of [
      'https://gemplers.com.evil.com', 'https://gemplers.com@127.0.0.1', 'https://notgemplers.com',
      'https://golfcourselawn.store.evil.com',
    ]) expect(selectAdapterKey({ name: 'x', website })).toBe('generic');
    expect(selectAdapterKey({ website: 'https://diypestcontrol.com.evil.com' })).toBe('generic');
    expect(selectAdapterKey({ website: 'https://forestrydistributing.com@127.0.0.1/x' })).toBe('generic');
    // a lookalike display name cannot rescue a vendor whose real host is elsewhere
    expect(selectAdapterKey({ name: 'DIY Pest Control', website: 'https://evil.example' })).toBe('generic');
  });
  test('the new adapters are registered and scrapable', () => {
    const { getAdapter } = require('../services/price-scan/adapters/registry');
    const { SCRAPABLE_ADAPTER_KEYS } = require('../services/price-scan/weekly-scan');
    expect(getAdapter('diypest').key).toBe('diypest');
    expect(getAdapter('forestry').key).toBe('forestry');
    expect(SCRAPABLE_ADAPTER_KEYS).toEqual(expect.arrayContaining(['diypest', 'forestry']));
  });
  test('falls back to generic', () => {
    expect(selectAdapterKey({ name: 'Some New Shop' })).toBe('generic');
    expect(selectAdapterKey({})).toBe('generic');
  });
});
