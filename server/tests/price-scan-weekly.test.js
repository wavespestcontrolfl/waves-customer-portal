const {
  toScanSpec,
  assembleScanSpecs,
  opportunityToMatch,
  tallyBreakdown,
  isBrowserUnavailable,
  isOnHost,
  matchKey,
  runWeeklyScan,
  attachLoginCredentials,
} = require('../services/price-scan/weekly-scan');

const baselineRow = (over = {}) => ({
  id: 'p1', name: 'Taurus SC Termiticide', epa_reg_number: '53883-279', formulation: 'SC',
  container_size: '78 oz', unit_size_oz: 78, monthly_cost_estimate: 120,
  siteone_price: 95, siteone_quantity: '78 oz', siteone_unit: 'oz', ...over,
});

const VENDORS = [
  { id: 'dmo', name: 'DoMyOwn', website: 'https://www.domyown.com' },
  { id: 'sol', name: 'Solutions Pest & Lawn', website: 'https://www.solutionsstores.com' },
];

describe('toScanSpec', () => {
  test('builds the scan product + EVERY competitor vendor, quantity prefers SiteOne pack', () => {
    const urls = new Map([['dmo', 'https://www.domyown.com/p-1817.html']]);
    const { product, vendors, spend } = toScanSpec(baselineRow(), VENDORS, urls);
    expect(product).toMatchObject({
      product_id: 'p1', name: 'Taurus SC Termiticide', vendorProductName: 'Taurus SC Termiticide',
      epaReg: '53883-279', quantity: '78 oz',
      baseline: { vendor: 'SiteOne', price: 95, quantity: '78 oz' },
    });
    expect(vendors).toEqual([
      { vendor_id: 'dmo', name: 'DoMyOwn', website: 'https://www.domyown.com', url: 'https://www.domyown.com/p-1817.html' },
      { vendor_id: 'sol', name: 'Solutions Pest & Lawn', website: 'https://www.solutionsstores.com', url: null }, // no URL -> search-by-name
    ]);
    expect(spend).toBe(120);
  });
  test('quantity falls back container_size -> unit_size_oz; urls null without a map', () => {
    const a = toScanSpec(baselineRow({ siteone_quantity: null }), VENDORS, null);
    expect(a.product.quantity).toBe('78 oz'); // container_size
    expect(a.vendors.every((v) => v.url === null)).toBe(true);
    const b = toScanSpec(baselineRow({ siteone_quantity: null, container_size: null }), VENDORS, null);
    expect(b.product.quantity).toBe('78 oz'); // unit_size_oz -> "78 oz"
  });
  test('the "Each (1)" placeholder does NOT shadow the real catalog size', () => {
    // Real prod data: vendor_pricing.quantity is the placeholder "Each (1)" while the
    // actual pack lives in container_size / unit_size_oz. The placeholder can't normalize
    // to oz, so it must fall through — otherwise verifyMatch + $/oz have nothing to use.
    const s = toScanSpec(baselineRow({ siteone_quantity: 'Each (1)', container_size: '2.5 gal', unit_size_oz: 320 }), VENDORS, null);
    expect(s.product.quantity).toBe('2.5 gal');
    expect(s.product.baseline.quantity).toBe('2.5 gal'); // baseline can't keep the placeholder either
  });
  test('placeholder with no real size column anywhere -> null (honestly unscannable)', () => {
    const s = toScanSpec(baselineRow({ siteone_quantity: 'Each (1)', container_size: null, unit_size_oz: null }), VENDORS, null);
    expect(s.product.quantity).toBeNull();
    expect(s.product.baseline.quantity).toBeNull();
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
    const specs = assembleScanSpecs(rows, new Map(), { limit: 2, vendors: VENDORS });
    expect(specs.map((s) => s.product.product_id)).toEqual(['b', 'a']); // spend 200 > 50 > c(0)
    expect(specs).toHaveLength(2);
    expect(specs[0].vendors.map((v) => v.vendor_id)).toEqual(['dmo', 'sol']); // every vendor on each spec
  });
  test('ties on spend break by SiteOne price desc', () => {
    const rows = [
      baselineRow({ id: 'lo', monthly_cost_estimate: 0, siteone_price: 10 }),
      baselineRow({ id: 'hi', monthly_cost_estimate: 0, siteone_price: 90 }),
    ];
    const specs = assembleScanSpecs(rows, new Map(), { limit: 5, vendors: VENDORS });
    expect(specs.map((s) => s.product.product_id)).toEqual(['hi', 'lo']);
  });
  test('attaches each vendor URL from the per-product map', () => {
    const urlByProduct = new Map([['p9', new Map([['dmo', 'https://www.domyown.com/p9'], ['sol', 'https://www.solutionsstores.com/p9']])]]);
    const specs = assembleScanSpecs([baselineRow({ id: 'p9' })], urlByProduct, { limit: 5, vendors: VENDORS });
    expect(specs[0].vendors.find((v) => v.vendor_id === 'dmo').url).toBe('https://www.domyown.com/p9');
    expect(specs[0].vendors.find((v) => v.vendor_id === 'sol').url).toBe('https://www.solutionsstores.com/p9');
  });
});

describe('opportunityToMatch', () => {
  const product = { name: 'Taurus SC Termiticide', epaReg: '53883-279' };
  test('maps a real opportunity to a composer match (any winning vendor)', () => {
    const scan = {
      opportunity: {
        isOpportunity: true,
        baseline: { vendor: 'SiteOne', price: 95, quantity: '78 oz' },
        best: { vendor: 'Solutions Pest & Lawn', price: 88, quantity: '78 oz', source_url: 'https://s/p', name: 'Taurus SC 78 oz' },
      },
    };
    expect(opportunityToMatch(product, scan)).toEqual({
      product: 'Taurus SC Termiticide',
      epaReg: '53883-279',
      baseline: { vendor: 'SiteOne', price: 95, quantity: '78 oz' },
      competitor: { vendor: 'Solutions Pest & Lawn', price: 88, quantity: '78 oz', source_url: 'https://s/p', name: 'Taurus SC 78 oz' },
    });
  });
  test('null when not an opportunity / no best / no scan', () => {
    expect(opportunityToMatch(product, { opportunity: { isOpportunity: false, best: { price: 1 }, baseline: {} } })).toBeNull();
    expect(opportunityToMatch(product, { opportunity: { isOpportunity: true, best: null, baseline: {} } })).toBeNull();
    expect(opportunityToMatch(product, null)).toBeNull();
  });
});

describe('isOnHost', () => {
  test('accepts on-host (incl. www / subdomain), rejects foreign/garbage', () => {
    expect(isOnHost('https://www.domyown.com/p-1817.html', 'https://www.domyown.com')).toBe(true);
    expect(isOnHost('https://domyown.com/p', 'domyown.com')).toBe(true);
    expect(isOnHost('https://www.solutionsstores.com/p', 'https://www.solutionsstores.com')).toBe(true);
    expect(isOnHost('https://evil.example.com/p', 'https://www.domyown.com')).toBe(false);
    expect(isOnHost('https://notdomyown.com.evil.com/p', 'domyown.com')).toBe(false); // suffix-spoof
    expect(isOnHost('not a url', 'domyown.com')).toBe(false);
    expect(isOnHost(null, 'domyown.com')).toBe(false);
    expect(isOnHost('https://www.domyown.com/p', null)).toBe(false);
  });
});

describe('tallyBreakdown', () => {
  test('aggregates per-vendor verified vs skip reasons + productsMatched', () => {
    const results = [
      { product: { name: 'A' }, scan: { verified: [{ vendor: 'DoMyOwn' }], skipped: [{ vendor: 'Solutions Pest & Lawn', reason: 'no_candidate' }, { vendor: 'Keystone', reason: 'fetch_error' }] } },
      { product: { name: 'B' }, scan: { verified: [], skipped: [{ vendor: 'DoMyOwn', reason: 'unverified' }, { vendor: 'Solutions Pest & Lawn', reason: 'no_candidate' }] } },
      { product: { name: 'C' }, error: new Error('x') }, // errors excluded
    ];
    const b = tallyBreakdown(results);
    expect(b.productsMatched).toBe(1); // only A had a verified candidate
    expect(b.verifiedTotal).toBe(1);
    expect(b.vendors.DoMyOwn).toEqual({ verified: 1, skipped: { unverified: 1 } });
    expect(b.vendors['Solutions Pest & Lawn']).toEqual({ verified: 0, skipped: { no_candidate: 2 } });
    expect(b.vendors.Keystone).toEqual({ verified: 0, skipped: { fetch_error: 1 } });
  });
});

describe('isBrowserUnavailable', () => {
  test('true for missing playwright / chromium / launch errors; false otherwise', () => {
    expect(isBrowserUnavailable(new Error("Cannot find module 'playwright'"))).toBe(true);
    expect(isBrowserUnavailable(new Error('browserType.launch: Executable doesn\'t exist'))).toBe(true);
    expect(isBrowserUnavailable(new Error('some scrape parse problem'))).toBe(false);
  });
});

describe('matchKey', () => {
  const a = { product: 'Taurus SC', competitor: { source_url: 'https://d/a', price: 89 }, baseline: { price: 95 } };
  test('stable per-match key; case/space-insensitive product', () => {
    expect(matchKey(a)).toBe(matchKey({ ...a, product: '  taurus sc  ' }));
  });
  test('a changed competitor price yields a different key (a new ask)', () => {
    expect(matchKey(a)).not.toBe(matchKey({ ...a, competitor: { ...a.competitor, price: 80 } }));
  });
});

describe('runWeeklyScan (injected deps)', () => {
  const siteoneOnly = async (db, name) => (name === 'SiteOne' ? { id: 'so', name } : null);
  const specs = [
    { product: { name: 'A', epaReg: 'e1' }, vendors: [] },
    { product: { name: 'B', epaReg: 'e2' }, vendors: [] },
    { product: { name: 'C', epaReg: 'e3' }, vendors: [] },
  ];

  test('skips when the SiteOne vendor row is missing', async () => {
    const r = await runWeeklyScan({ vendorByName: async () => null, specs, vendors: VENDORS });
    expect(r).toEqual({ ok: false, reason: 'vendors_missing', evaluated: 0 });
  });

  test('skips when no scrapable competitor vendors are enabled', async () => {
    const r = await runWeeklyScan({ vendorByName: siteoneOnly, scrapableVendors: async () => [], specs });
    expect(r).toEqual({ ok: false, reason: 'no_scrapable_vendors', evaluated: 0 });
  });

  test('selectOnly returns products + the vendors it would scan, no browser', async () => {
    const scanMany = jest.fn();
    const r = await runWeeklyScan({ vendorByName: siteoneOnly, vendors: VENDORS, specs, selectOnly: true, scanMany });
    expect(scanMany).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, selectOnly: true, evaluated: 3, vendors: ['DoMyOwn', 'Solutions Pest & Lawn'], products: ['A', 'B', 'C'] });
  });

  test('stages one draft from the opportunity rows + reports per-vendor breakdown', async () => {
    const scanMany = jest.fn(async () => [
      { product: specs[0].product, scan: { verified: [{ vendor: 'DoMyOwn' }], skipped: [{ vendor: 'Solutions Pest & Lawn', reason: 'no_candidate' }], opportunity: { isOpportunity: true, baseline: { vendor: 'SiteOne', price: 95, quantity: '78 oz' }, best: { vendor: 'DoMyOwn', price: 89, quantity: '78 oz', source_url: 'https://d/a' } } } },
      { product: specs[1].product, scan: { verified: [], skipped: [{ vendor: 'DoMyOwn', reason: 'unverified' }], opportunity: { isOpportunity: false, best: { price: 200 }, baseline: {} } } },
      { product: specs[2].product, error: new Error('timeout') },
    ]);
    const createDraft = jest.fn(async () => ({ id: 7, included_count: 1 }));
    const r = await runWeeklyScan({ vendorByName: siteoneOnly, vendors: VENDORS, specs, scanMany, createDraft, activeMatchKeys: new Set() });
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft.mock.calls[0][1]).toHaveLength(1);
    expect(createDraft.mock.calls[0][1][0].product).toBe('A');
    expect(r).toMatchObject({ ok: true, evaluated: 3, scanned: 2, opportunities: 1, errors: 1, draftId: 7, includedCount: 1, productsMatched: 1, verifiedTotal: 1 });
    expect(r.vendorBreakdown.DoMyOwn).toEqual({ verified: 1, skipped: { unverified: 1 } });
  });

  test('no opportunities -> no draft, but breakdown still explains why', async () => {
    const scanMany = jest.fn(async () => [{ product: specs[0].product, scan: { verified: [{ vendor: 'DoMyOwn' }], skipped: [], opportunity: { isOpportunity: false } } }]);
    const createDraft = jest.fn();
    const r = await runWeeklyScan({ vendorByName: siteoneOnly, vendors: VENDORS, specs: [specs[0]], scanMany, createDraft });
    expect(createDraft).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, opportunities: 0, draftId: null, productsMatched: 1 }); // matched but not cheaper
  });

  const oppResult = (product, price, url, vendor = 'DoMyOwn') => ({ product, scan: { verified: [{ vendor }], skipped: [], opportunity: { isOpportunity: true, baseline: { vendor: 'SiteOne', price: 95, quantity: '78 oz' }, best: { vendor, price, quantity: '78 oz', source_url: url } } } });

  test('skips a draft when every opportunity is already covered by an active draft', async () => {
    const scanMany = jest.fn(async () => [oppResult(specs[0].product, 89, 'https://d/a')]);
    const createDraft = jest.fn(async () => ({ id: 9, included_count: 1 }));
    const activeMatchKeys = new Set([matchKey({ product: 'A', competitor: { source_url: 'https://d/a', price: 89 }, baseline: { price: 95 } })]);
    const r = await runWeeklyScan({ vendorByName: siteoneOnly, vendors: VENDORS, specs: [specs[0]], scanMany, createDraft, activeMatchKeys });
    expect(createDraft).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, opportunities: 1, duplicates: 1, draftId: null });
  });

  test('stages ONLY the new opportunity when one is already pending (A pending, scan finds A+B)', async () => {
    const scanMany = jest.fn(async () => [oppResult(specs[0].product, 89, 'https://d/a'), oppResult(specs[1].product, 34, 'https://s/b', 'Solutions Pest & Lawn')]);
    const createDraft = jest.fn(async () => ({ id: 11, included_count: 1 }));
    const activeMatchKeys = new Set([matchKey({ product: 'A', competitor: { source_url: 'https://d/a', price: 89 }, baseline: { price: 95 } })]);
    const r = await runWeeklyScan({ vendorByName: siteoneOnly, vendors: VENDORS, specs: [specs[0], specs[1]], scanMany, createDraft, activeMatchKeys });
    expect(createDraft).toHaveBeenCalledTimes(1);
    const staged = createDraft.mock.calls[0][1];
    expect(staged).toHaveLength(1);
    expect(staged[0].product).toBe('B');
    expect(r).toMatchObject({ ok: true, opportunities: 2, duplicates: 1, draftId: 11 });
  });

  test('a browser-unavailable batch failure is a clean skip, not a throw', async () => {
    const scanMany = jest.fn(async () => { throw new Error("Cannot find module 'playwright'"); });
    const r = await runWeeklyScan({ vendorByName: siteoneOnly, vendors: VENDORS, specs, scanMany });
    expect(r).toEqual({ ok: false, reason: 'browser_unavailable', evaluated: 3 });
  });
});

describe('attachLoginCredentials (login adapters get decrypted creds)', () => {
  const veserisSpec = () => ({ product: { name: 'X' }, vendors: [{ vendor_id: 'ves', name: 'Veseris', url: 'https://veseris.com' }] });
  test('attaches creds to a Veseris (login adapter) vendor, resolved once per vendor', async () => {
    const getVendorLoginCredentials = jest.fn(async () => ({ username: 'u@x.com', email: 'u@x.com', password: 'pw', loginUrl: 'https://veseris.com/login' }));
    const specs = [veserisSpec(), veserisSpec()];
    await attachLoginCredentials({}, specs, { getVendorLoginCredentials });
    expect(specs[0].vendors[0].credentials).toMatchObject({ email: 'u@x.com', password: 'pw' });
    expect(specs[1].vendors[0].credentials).toMatchObject({ password: 'pw' });
    expect(getVendorLoginCredentials).toHaveBeenCalledTimes(1); // cached by vendor_id
  });
  test('does NOT attach to a non-login (public) vendor', async () => {
    const getVendorLoginCredentials = jest.fn(async () => ({ username: 'u', email: 'u', password: 'pw' }));
    const specs = [{ product: { name: 'X' }, vendors: [{ vendor_id: 'sol', name: 'Solutions Pest & Lawn', url: 'https://www.solutionsstores.com' }] }];
    await attachLoginCredentials({}, specs, { getVendorLoginCredentials });
    expect(specs[0].vendors[0].credentials).toBeUndefined();
    expect(getVendorLoginCredentials).not.toHaveBeenCalled();
  });
  test('leaves a login vendor WITHOUT creds when none are stored (clean skip downstream)', async () => {
    const getVendorLoginCredentials = jest.fn(async () => ({ username: null, email: null, password: null, loginUrl: null }));
    const specs = [veserisSpec()];
    await attachLoginCredentials({}, specs, { getVendorLoginCredentials });
    expect(specs[0].vendors[0].credentials).toBeUndefined();
  });
});
