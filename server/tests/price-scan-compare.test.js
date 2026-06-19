const { rankCandidates, findOpportunity } = require('../services/price-scan/compare');
const { selectAdapterKey } = require('../services/price-scan/adapters/registry');

describe('price-scan compare', () => {
  const baseline = { price: 95, quantity: '78 oz', vendor: 'SiteOne' };

  test('cheaper same-size candidate is an opportunity', () => {
    const r = findOpportunity(baseline, [{ price: 89, quantity: '78 oz', vendor: 'DoMyOwn', source_url: 'u' }]);
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
    const r = findOpportunity(baseline, [{ price: 300, quantity: '2.5 gal', vendor: 'Drum' }]);
    expect(r.isOpportunity).toBe(true);
    expect(r.best.perOz).toBeCloseTo(0.9375, 4);
    // (1.217949 - 0.9375) * 78 ~= 21.87
    expect(r.estSavingsOnBaseline).toBeCloseTo(21.87, 1);
  });

  test('out-of-stock is excluded from the winner by default', () => {
    const r = findOpportunity(baseline, [
      { price: 70, quantity: '78 oz', vendor: 'Cheap', availability_status: 'out_of_stock' },
      { price: 89, quantity: '78 oz', vendor: 'InStock', availability_status: 'in_stock' },
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

describe('adapter registry', () => {
  test('selects by host', () => {
    expect(selectAdapterKey({ url: 'https://www.domyown.com/taurus-sc-p-1816.html' })).toBe('domyown');
    expect(selectAdapterKey({ url: 'https://www.solutionsstores.com/taurus-sc' })).toBe('solutions');
    expect(selectAdapterKey({ name: 'Keystone Pest Solutions' })).toBe('keystone');
    expect(selectAdapterKey({ url: 'https://veseris.com/p/123' })).toBe('veseris');
  });
  test('falls back to generic', () => {
    expect(selectAdapterKey({ name: 'Some New Shop' })).toBe('generic');
    expect(selectAdapterKey({})).toBe('generic');
  });
});
