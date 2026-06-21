const {
  toScanSpec,
  assembleScanSpecs,
  opportunityToMatch,
  isBrowserUnavailable,
  isDomyownUrl,
  matchSignature,
  runWeeklyScan,
} = require('../services/price-scan/weekly-scan');

const baselineRow = (over = {}) => ({
  id: 'p1', name: 'Taurus SC Termiticide', epa_reg_number: '53883-279', formulation: 'SC',
  container_size: '78 oz', unit_size_oz: 78, monthly_cost_estimate: 120,
  siteone_price: 95, siteone_quantity: '78 oz', siteone_unit: 'oz', ...over,
});

describe('toScanSpec', () => {
  test('builds the scan product + DoMyOwn vendor, quantity prefers SiteOne pack', () => {
    const { product, vendors, spend } = toScanSpec(baselineRow(), { domyownId: 'dmo-uuid', domyownName: 'DoMyOwn', domyownUrl: 'https://www.domyown.com/p-1817.html' });
    expect(product).toMatchObject({
      product_id: 'p1', name: 'Taurus SC Termiticide', vendorProductName: 'Taurus SC Termiticide',
      epaReg: '53883-279', quantity: '78 oz',
      baseline: { vendor: 'SiteOne', price: 95, quantity: '78 oz' },
    });
    expect(vendors).toEqual([{ vendor_id: 'dmo-uuid', name: 'DoMyOwn', url: 'https://www.domyown.com/p-1817.html' }]);
    expect(spend).toBe(120);
  });
  test('quantity falls back container_size -> unit_size_oz; url null when absent', () => {
    const a = toScanSpec(baselineRow({ siteone_quantity: null }), { domyownId: 'd' });
    expect(a.product.quantity).toBe('78 oz'); // container_size
    expect(a.vendors[0].url).toBeNull();
    const b = toScanSpec(baselineRow({ siteone_quantity: null, container_size: null }), { domyownId: 'd' });
    expect(b.product.quantity).toBe('78 oz'); // unit_size_oz -> "78 oz"
  });
});

describe('assembleScanSpecs', () => {
  test('dedups by product (first wins), ranks by spend then price, respects limit', () => {
    const rows = [
      baselineRow({ id: 'a', monthly_cost_estimate: 50, siteone_price: 10 }),
      baselineRow({ id: 'a', monthly_cost_estimate: 999 }), // dup id -> ignored
      baselineRow({ id: 'b', monthly_cost_estimate: 200, siteone_price: 20 }),
      baselineRow({ id: 'c', monthly_cost_estimate: 0, siteone_price: 300 }),
    ];
    const specs = assembleScanSpecs(rows, new Map(), { limit: 2, domyownId: 'd' });
    expect(specs.map((s) => s.product.product_id)).toEqual(['b', 'a']); // spend 200 > 50 > c(0)
    expect(specs).toHaveLength(2);
  });
  test('ties on spend break by SiteOne price desc', () => {
    const rows = [
      baselineRow({ id: 'lo', monthly_cost_estimate: 0, siteone_price: 10 }),
      baselineRow({ id: 'hi', monthly_cost_estimate: 0, siteone_price: 90 }),
    ];
    const specs = assembleScanSpecs(rows, new Map(), { limit: 5, domyownId: 'd' });
    expect(specs.map((s) => s.product.product_id)).toEqual(['hi', 'lo']);
  });
  test('attaches DoMyOwn URL from the map', () => {
    const specs = assembleScanSpecs([baselineRow({ id: 'p9' })], new Map([['p9', 'https://x/p9']]), { limit: 5, domyownId: 'd' });
    expect(specs[0].vendors[0].url).toBe('https://x/p9');
  });
});

describe('opportunityToMatch', () => {
  const product = { name: 'Taurus SC Termiticide', epaReg: '53883-279' };
  test('maps a real opportunity to a composer match', () => {
    const scan = {
      opportunity: {
        isOpportunity: true,
        baseline: { vendor: 'SiteOne', price: 95, quantity: '78 oz' },
        best: { vendor: 'DoMyOwn', price: 89, quantity: '78 oz', source_url: 'https://d/p', name: 'Taurus SC 78 oz' },
      },
    };
    expect(opportunityToMatch(product, scan)).toEqual({
      product: 'Taurus SC Termiticide',
      epaReg: '53883-279',
      baseline: { vendor: 'SiteOne', price: 95, quantity: '78 oz' },
      competitor: { vendor: 'DoMyOwn', price: 89, quantity: '78 oz', source_url: 'https://d/p', name: 'Taurus SC 78 oz' },
    });
  });
  test('null when not an opportunity / no best / no scan', () => {
    expect(opportunityToMatch(product, { opportunity: { isOpportunity: false, best: { price: 1 }, baseline: {} } })).toBeNull();
    expect(opportunityToMatch(product, { opportunity: { isOpportunity: true, best: null, baseline: {} } })).toBeNull();
    expect(opportunityToMatch(product, null)).toBeNull();
  });
});

describe('isBrowserUnavailable', () => {
  test('true for missing playwright / chromium / launch errors', () => {
    expect(isBrowserUnavailable(new Error("Cannot find module 'playwright'"))).toBe(true);
    expect(isBrowserUnavailable(new Error('browserType.launch: Executable doesn\'t exist'))).toBe(true);
  });
  test('false for an ordinary error', () => {
    expect(isBrowserUnavailable(new Error('some scrape parse problem'))).toBe(false);
  });
});

describe('isDomyownUrl', () => {
  test('accepts domyown.com hosts, rejects foreign/garbage', () => {
    expect(isDomyownUrl('https://www.domyown.com/taurus-sc-p-1817.html')).toBe(true);
    expect(isDomyownUrl('https://domyown.com/p')).toBe(true);
    expect(isDomyownUrl('https://evil.example.com/p')).toBe(false);
    expect(isDomyownUrl('https://notdomyown.com.evil.com/p')).toBe(false);
    expect(isDomyownUrl('not a url')).toBe(false);
    expect(isDomyownUrl(null)).toBe(false);
  });
});

describe('matchSignature', () => {
  const a = { product: 'Taurus SC', competitor: { source_url: 'https://d/a', price: 89 }, baseline: { price: 95 } };
  const b = { product: 'Bifen', competitor: { source_url: 'https://d/b', price: 34 }, baseline: { price: 40 } };
  test('order-independent + stable for the same opportunities', () => {
    expect(matchSignature([a, b])).toBe(matchSignature([b, a]));
  });
  test('a changed competitor price yields a different signature (new draft)', () => {
    const a2 = { ...a, competitor: { ...a.competitor, price: 80 } };
    expect(matchSignature([a])).not.toBe(matchSignature([a2]));
  });
});

describe('runWeeklyScan (injected deps)', () => {
  const vendors = (db, name) => Promise.resolve({ id: name === 'SiteOne' ? 'so' : 'dmo', name });
  const specs = [
    { product: { name: 'A', epaReg: 'e1' }, vendors: [] },
    { product: { name: 'B', epaReg: 'e2' }, vendors: [] },
    { product: { name: 'C', epaReg: 'e3' }, vendors: [] },
  ];

  test('skips when a vendor row is missing', async () => {
    const r = await runWeeklyScan({ vendorByName: () => Promise.resolve(null), specs });
    expect(r).toEqual({ ok: false, reason: 'vendors_missing', evaluated: 0 });
  });

  test('selectOnly returns the product names without scanning', async () => {
    const scanMany = jest.fn();
    const r = await runWeeklyScan({ vendorByName: vendors, specs, selectOnly: true, scanMany });
    expect(scanMany).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, selectOnly: true, evaluated: 3, products: ['A', 'B', 'C'] });
  });

  test('stages ONE draft from only the opportunity rows', async () => {
    const scanMany = jest.fn(async () => [
      { product: specs[0].product, scan: { opportunity: { isOpportunity: true, baseline: { vendor: 'SiteOne', price: 95, quantity: '78 oz' }, best: { vendor: 'DoMyOwn', price: 89, quantity: '78 oz', source_url: 'https://d/a' } } } },
      { product: specs[1].product, scan: { opportunity: { isOpportunity: false, best: { price: 200 }, baseline: {} } } },
      { product: specs[2].product, error: new Error('timeout') },
    ]);
    const createDraft = jest.fn(async () => ({ id: 7, included_count: 1 }));
    const r = await runWeeklyScan({ vendorByName: vendors, specs, scanMany, createDraft, activeSignatures: new Set() });
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft.mock.calls[0][1]).toHaveLength(1); // only the 1 opportunity
    expect(createDraft.mock.calls[0][1][0].product).toBe('A');
    expect(r).toMatchObject({ ok: true, evaluated: 3, scanned: 2, opportunities: 1, errors: 1, draftId: 7, includedCount: 1 });
  });

  test('no opportunities -> no draft created', async () => {
    const scanMany = jest.fn(async () => [{ product: specs[0].product, scan: { opportunity: { isOpportunity: false } } }]);
    const createDraft = jest.fn();
    const r = await runWeeklyScan({ vendorByName: vendors, specs: [specs[0]], scanMany, createDraft });
    expect(createDraft).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, opportunities: 0, draftId: null });
  });

  test('skips creating a draft that duplicates one already pending/sending', async () => {
    const scanMany = jest.fn(async () => [
      { product: specs[0].product, scan: { opportunity: { isOpportunity: true, baseline: { vendor: 'SiteOne', price: 95, quantity: '78 oz' }, best: { vendor: 'DoMyOwn', price: 89, quantity: '78 oz', source_url: 'https://d/a' } } } },
    ]);
    const createDraft = jest.fn(async () => ({ id: 9, included_count: 1 }));
    // Pre-seed the active-draft signature set with the exact opportunity this run finds.
    const activeSignatures = new Set([matchSignature([
      { product: 'A', competitor: { source_url: 'https://d/a', price: 89 }, baseline: { price: 95 } },
    ])]);
    const r = await runWeeklyScan({ vendorByName: vendors, specs: [specs[0]], scanMany, createDraft, activeSignatures });
    expect(createDraft).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, opportunities: 1, draftId: null, duplicate: true });
  });

  test('a browser-unavailable batch failure is a clean skip, not a throw', async () => {
    const scanMany = jest.fn(async () => { throw new Error("Cannot find module 'playwright'"); });
    const r = await runWeeklyScan({ vendorByName: vendors, specs, scanMany });
    expect(r).toEqual({ ok: false, reason: 'browser_unavailable', evaluated: 3 });
  });
});
