const {
  toScanSpec,
  assembleScanSpecs,
  opportunityToMatch,
  tallyBreakdown,
  isBrowserUnavailable,
  isOnHost,
  matchKey,
  runWeeklyScan,
  fetchFailureOf,
  classifyFetchFailures,
  watchInterrupt,
  throwIfScanFailed,
  FETCH_CLASS_SKIP_REASONS,
  attachLoginCredentials,
  scrapableVendors,
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
      baseline: { vendor: 'SiteOne', price: 95, quantity: '78 oz', shipping: null },
      competitor: { vendor: 'Solutions Pest & Lawn', price: 88, quantity: '78 oz', source_url: 'https://s/p', name: 'Taurus SC 78 oz', shipping: null, landedPrice: null },
    });
  });
  test('carries the delivered basis (shipping + landed price) the opportunity was ranked on', () => {
    const shipping = { amount: 15, basis: 'estimated', note: '~$15.00 est. shipping' };
    const scan = {
      opportunity: {
        isOpportunity: true,
        baseline: { vendor: 'SiteOne', price: 95, quantity: '78 oz', shipping: { amount: 0, basis: 'free', note: 'free shipping' } },
        best: { vendor: 'Solutions Pest & Lawn', price: 70, quantity: '78 oz', source_url: 'https://www.solutionsstores.com/p', shipping, landedPrice: 85 },
      },
    };
    const m = opportunityToMatch(product, scan);
    expect(m.competitor.shipping).toEqual(shipping);
    expect(m.competitor.landedPrice).toBe(85);
    expect(m.baseline.shipping.basis).toBe('free');
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
  test('a corrected shipping basis or amount is a new ask, not a duplicate', () => {
    const est = { ...a, competitor: { ...a.competitor, shipping: { amount: 15, basis: 'estimated' } } };
    const firm = { ...a, competitor: { ...a.competitor, shipping: { amount: 15, basis: 'weight_table' } } };
    const free = { ...a, competitor: { ...a.competitor, shipping: { amount: 0, basis: 'free' } } };
    const keys = [a, est, firm, free].map(matchKey);
    expect(new Set(keys).size).toBe(4);
    expect(matchKey(est)).toBe(matchKey({ ...a, competitor: { ...a.competitor, shipping: { amount: 15, basis: 'estimated', note: 'other note' } } })); // note text is not part of the key
    const baseShip = { ...a, baseline: { ...a.baseline, shipping: { amount: 5, basis: 'flat' } } };
    expect(matchKey(baseShip)).not.toBe(matchKey(a));
  });
  test('an active draft priced on the old shipping does not suppress the corrected one', async () => {
    const old = { ...a, competitor: { ...a.competitor, shipping: { amount: 0, basis: 'free' } } };
    const corrected = { ...a, competitor: { ...a.competitor, shipping: { amount: 15, basis: 'estimated' } } };
    const seen = new Set([matchKey(old)]);
    expect([old, corrected].filter((m) => !seen.has(matchKey(m)))).toEqual([corrected]);
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

describe('fetch-failure classification', () => {
  const prod = (name) => ({ name });
  const okScan = (skipped = []) => ({ product: prod('A'), scan: { verified: [{ vendor: 'DoMyOwn' }], skipped } });

  test('the fetch-class reason is exactly the one scanProduct writes when an adapter throws', () => {
    expect(FETCH_CLASS_SKIP_REASONS).toEqual(['fetch_error']);
  });

  test('"blocked" is not fetch-class: a vendor that always blocks never degrades a run', () => {
    expect(FETCH_CLASS_SKIP_REASONS).not.toContain('blocked');
    const blocked = (n) => ({ product: prod(n), scan: { verified: [], skipped: [{ vendor: 'DoMyOwn', reason: 'blocked', detail: 'DoMyOwn blocked the scan with a bot check (Cloudflare)' }] } });
    expect(fetchFailureOf(blocked('a'))).toBeNull();
    const all = classifyFetchFailures([blocked('a'), blocked('b'), blocked('c')], 3);
    expect(all).toEqual({ failedProducts: [], degraded: false });
  });

  test('"blocked" shows in the per-vendor breakdown', () => {
    const r = (reason) => ({ product: prod('A'), scan: { verified: [], skipped: [{ vendor: 'DoMyOwn', reason }, { vendor: 'Keystone', reason: 'blocked' }] } });
    const b = tallyBreakdown([r('blocked'), r('blocked'), r('no_candidate')]);
    expect(b.vendors.DoMyOwn.skipped).toEqual({ blocked: 2, no_candidate: 1 });
    expect(b.vendors.Keystone.skipped).toEqual({ blocked: 3 });
  });

  test('a thrown product is a failure', () => {
    expect(fetchFailureOf({ product: prod('A'), error: new Error('Target closed') })).toEqual({ reason: 'error', detail: 'Target closed' });
  });

  test('every vendor fetch_error with nothing verified is a failure', () => {
    const r = { product: prod('A'), scan: { verified: [], skipped: [{ vendor: 'DoMyOwn', reason: 'fetch_error', detail: 'browser closed' }, { vendor: 'Solutions', reason: 'fetch_error' }] } };
    expect(fetchFailureOf(r)).toEqual({ reason: 'fetch_failed', detail: 'browser closed' });
  });

  test.each(['no_candidate', 'unverified', 'non_usd', 'no_proof_url'])('a real %s answer is NOT a fetch failure', (reason) => {
    expect(fetchFailureOf({ product: prod('A'), scan: { verified: [], skipped: [{ vendor: 'DoMyOwn', reason }] } })).toBeNull();
  });

  test('one vendor answering "not found" next to a fetch error is not a failure', () => {
    const r = { product: prod('A'), scan: { verified: [], skipped: [{ vendor: 'DoMyOwn', reason: 'fetch_error' }, { vendor: 'Solutions', reason: 'no_candidate' }] } };
    expect(fetchFailureOf(r)).toBeNull();
  });

  test('a verified entry beats a fetch error on another vendor; no vendors at all is not a failure', () => {
    expect(fetchFailureOf(okScan([{ vendor: 'Solutions', reason: 'fetch_error' }]))).toBeNull();
    expect(fetchFailureOf({ product: prod('A'), scan: { verified: [], skipped: [] } })).toBeNull();
    expect(fetchFailureOf(null)).toBeNull();
  });

  test('degraded at exactly half the evaluated products, not below', () => {
    const bad = (n) => ({ product: prod(n), error: new Error('x') });
    expect(classifyFetchFailures([bad('a'), okScan()], 2).degraded).toBe(true);
    expect(classifyFetchFailures([bad('a'), okScan(), okScan()], 3).degraded).toBe(false);
    expect(classifyFetchFailures([bad('a'), bad('b'), okScan()], 3).failedProducts.map((f) => f.product)).toEqual(['a', 'b']);
  });

  test('products the scan never returned still count against the evaluated total', () => {
    // 4 evaluated, 2 results back (both failed): 2 of 4 failed = degraded; 1 of 4 is not.
    expect(classifyFetchFailures([{ product: prod('a'), error: new Error('x') }, okScan()], 4).degraded).toBe(false);
    expect(classifyFetchFailures([{ product: prod('a'), error: new Error('x') }, { product: prod('b'), error: new Error('x') }], 4).degraded).toBe(true);
  });
});

describe('watchInterrupt', () => {
  const fakeProc = () => {
    const { EventEmitter } = require('events');
    const p = new EventEmitter();
    p.pid = 4242;
    p.kill = jest.fn();
    return p;
  };

  test('records the signal and removes its listeners on dispose', () => {
    const p = fakeProc();
    p.on('SIGTERM', () => {}); // the server's own shutdown handler stays in place
    const w = watchInterrupt(p);
    expect(p.listenerCount('SIGTERM')).toBe(2);
    expect(p.listenerCount('SIGINT')).toBe(1);
    expect(w.signal).toBeNull();
    p.emit('SIGTERM');
    expect(w.signal).toBe('SIGTERM');
    expect(p.kill).not.toHaveBeenCalled(); // someone else handles the signal
    w.dispose();
    expect(p.listenerCount('SIGTERM')).toBe(1);
    expect(p.listenerCount('SIGINT')).toBe(0);
  });

  test('dispose without a signal leaves no listener behind', () => {
    const p = fakeProc();
    const w = watchInterrupt(p);
    w.dispose();
    expect(p.listenerCount('SIGTERM')).toBe(0);
    expect(p.listenerCount('SIGINT')).toBe(0);
    expect(w.signal).toBeNull();
  });

  test('re-raises the signal when nothing else listens, so a script still stops', () => {
    const p = fakeProc();
    const w = watchInterrupt(p);
    p.emit('SIGINT');
    expect(w.signal).toBe('SIGINT');
    expect(p.kill).toHaveBeenCalledWith(4242, 'SIGINT');
  });
});

describe('throwIfScanFailed', () => {
  test('passes healthy and clean-skip results through', () => {
    const ok = { ok: true, evaluated: 3 };
    expect(throwIfScanFailed(ok)).toBe(ok);
    for (const reason of ['browser_unavailable', 'vendors_missing', 'no_scrapable_vendors']) {
      expect(() => throwIfScanFailed({ ok: false, reason, evaluated: 0 })).not.toThrow();
    }
    expect(() => throwIfScanFailed(undefined)).not.toThrow();
  });

  test('throws a clear message with the reason and counts', () => {
    expect(() => throwIfScanFailed({
      ok: false, reason: 'interrupted', signal: 'SIGTERM', evaluated: 25, fetchFailed: 24, scanned: 1, draftId: 7,
      failedProducts: [{ product: 'A', reason: 'error', detail: 'Target page, context or browser has been closed' }],
    })).toThrow('price scan interrupted: 25 products evaluated, 24 with fetch failures, 1 scanned, got SIGTERM, draft 7 staged, first error: Target page, context or browser has been closed');
    expect(() => throwIfScanFailed({ ok: false, reason: 'degraded', evaluated: 10, fetchFailed: 6 })).toThrow(/^price scan degraded: 10 products evaluated, 6 with fetch failures/);
    expect(() => throwIfScanFailed({ ok: false, reason: 'scan_error', evaluated: 10, error: 'boom' })).toThrow('price scan scan_error: 10 products evaluated, first error: boom');
  });
});

describe('runWeeklyScan failed-run classification (injected scanMany)', () => {
  const siteoneOnly = async (db, name) => (name === 'SiteOne' ? { id: 'so', name } : null);
  const mk = (n) => ({ product: { name: n, epaReg: `e-${n}` }, vendors: [] });
  const specs = ['A', 'B', 'C', 'D'].map(mk);
  const fetchFail = (name) => ({ product: { name }, scan: { verified: [], skipped: [{ vendor: 'DoMyOwn', reason: 'fetch_error', detail: 'Target closed' }, { vendor: 'Solutions Pest & Lawn', reason: 'fetch_error', detail: 'Target closed' }], opportunity: { isOpportunity: false } } });
  const notFound = (name) => ({ product: { name }, scan: { verified: [], skipped: [{ vendor: 'DoMyOwn', reason: 'no_candidate' }, { vendor: 'Solutions Pest & Lawn', reason: 'unverified' }], opportunity: { isOpportunity: false } } });
  const opp = (name, price, url) => ({ product: { name }, scan: { verified: [{ vendor: 'DoMyOwn' }], skipped: [], opportunity: { isOpportunity: true, baseline: { vendor: 'SiteOne', price: 95, quantity: '78 oz' }, best: { vendor: 'DoMyOwn', price, quantity: '78 oz', source_url: url } } } });
  const base = { vendorByName: siteoneOnly, vendors: VENDORS, activeMatchKeys: new Set() };

  test('the 10-26 incident: every fetch failed -> degraded, not ok:true', async () => {
    const scanMany = jest.fn(async () => specs.map((s) => fetchFail(s.product.name)));
    const createDraft = jest.fn();
    const r = await runWeeklyScan({ ...base, specs, scanMany, createDraft });
    expect(r).toMatchObject({ ok: false, reason: 'degraded', evaluated: 4, scanned: 4, opportunities: 0, fetchFailed: 4 });
    expect(r.failedProducts).toHaveLength(4);
    expect(r.failedProducts[0]).toEqual({ product: 'A', reason: 'fetch_failed', detail: 'Target closed' });
    expect(createDraft).not.toHaveBeenCalled();
  });

  test('thrown products count too: 2 of 4 is degraded', async () => {
    const scanMany = jest.fn(async () => [{ product: specs[0].product, error: new Error('Target closed') }, { product: specs[1].product, error: new Error('Target closed') }, notFound('C'), notFound('D')]);
    const r = await runWeeklyScan({ ...base, specs, scanMany });
    expect(r).toMatchObject({ ok: false, reason: 'degraded', errors: 2, fetchFailed: 2 });
  });

  test('a degraded run still stages the fresh matches it found', async () => {
    const scanMany = jest.fn(async () => [opp('A', 89, 'https://d/a'), fetchFail('B'), fetchFail('C'), fetchFail('D')]);
    const createDraft = jest.fn(async () => ({ id: 21, included_count: 1 }));
    const r = await runWeeklyScan({ ...base, specs, scanMany, createDraft });
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft.mock.calls[0][1].map((m) => m.product)).toEqual(['A']);
    expect(r).toMatchObject({ ok: false, reason: 'degraded', draftId: 21, includedCount: 1, fetchFailed: 3 });
  });

  test('a rerun does not re-stage a match an active draft already covers', async () => {
    const scanMany = jest.fn(async () => [opp('A', 89, 'https://d/a'), fetchFail('B'), fetchFail('C'), fetchFail('D')]);
    const createDraft = jest.fn();
    const activeMatchKeys = new Set([matchKey({ product: 'A', competitor: { source_url: 'https://d/a', price: 89 }, baseline: { price: 95 } })]);
    const r = await runWeeklyScan({ ...base, activeMatchKeys, specs, scanMany, createDraft });
    expect(createDraft).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, reason: 'degraded', duplicates: 1, draftId: null });
  });

  test('legitimate not-found / unverified answers on every product stay ok:true', async () => {
    const scanMany = jest.fn(async () => specs.map((s) => notFound(s.product.name)));
    const r = await runWeeklyScan({ ...base, specs, scanMany });
    expect(r).toMatchObject({ ok: true, scanned: 4, opportunities: 0, fetchFailed: 0 });
    expect(r.failedProducts).toBeUndefined();
  });

  test('under half failing stays ok:true and reports the count', async () => {
    const scanMany = jest.fn(async () => [fetchFail('A'), notFound('B'), notFound('C'), notFound('D')]);
    const r = await runWeeklyScan({ ...base, specs, scanMany });
    expect(r).toMatchObject({ ok: true, fetchFailed: 1 });
  });

  test('a signal during the scan -> interrupted, matches still staged, listeners removed', async () => {
    const before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
    process.on('SIGTERM', () => {}); // stand-in for the server's shutdown handler
    const stand = process.listenerCount('SIGTERM');
    const scanMany = jest.fn(async () => {
      process.emit('SIGTERM');
      return [opp('A', 89, 'https://d/a'), fetchFail('B'), fetchFail('C'), fetchFail('D')];
    });
    const createDraft = jest.fn(async () => ({ id: 31, included_count: 1 }));
    try {
      const r = await runWeeklyScan({ ...base, specs, scanMany, createDraft });
      expect(r).toMatchObject({ ok: false, reason: 'interrupted', signal: 'SIGTERM', draftId: 31 });
      expect(r.failedProducts).toHaveLength(3);
      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(process.listenerCount('SIGTERM')).toBe(stand); // ours is gone
      expect(process.listenerCount('SIGINT')).toBe(before[1]);
    } finally {
      process.removeAllListeners('SIGTERM');
    }
  });

  test('interrupted wins over degraded, even with no fetch failures recorded', async () => {
    process.on('SIGINT', () => {});
    const scanMany = jest.fn(async () => { process.emit('SIGINT'); return specs.map((s) => notFound(s.product.name)); });
    try {
      const r = await runWeeklyScan({ ...base, specs, scanMany });
      expect(r).toMatchObject({ ok: false, reason: 'interrupted', signal: 'SIGINT', fetchFailed: 0 });
    } finally {
      process.removeAllListeners('SIGINT');
    }
  });

  test('scanMany throwing after a signal is interrupted, not a browser skip', async () => {
    process.on('SIGTERM', () => {});
    const scanMany = jest.fn(async () => { process.emit('SIGTERM'); throw new Error('browserType.launch: Executable closed'); });
    try {
      const r = await runWeeklyScan({ ...base, specs, scanMany });
      expect(r).toMatchObject({ ok: false, reason: 'interrupted', signal: 'SIGTERM', evaluated: 4 });
    } finally {
      process.removeAllListeners('SIGTERM');
    }
  });

  test('an unexpected scanMany throw is a scan_error carrying the message; listeners are removed', async () => {
    const before = process.listenerCount('SIGTERM');
    const scanMany = jest.fn(async () => { throw new Error('db exploded'); });
    const r = await runWeeklyScan({ ...base, specs, scanMany });
    expect(r).toEqual({ ok: false, reason: 'scan_error', evaluated: 4, error: 'db exploded' });
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  test('a healthy run leaves no signal listener behind', async () => {
    const before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
    const scanMany = jest.fn(async () => specs.map((s) => notFound(s.product.name)));
    await runWeeklyScan({ ...base, specs, scanMany });
    expect([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')]).toEqual(before);
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

describe('scrapableVendors (adapter allowlist incl. shopify)', () => {
  const fakeDb = (rows) => {
    const chain = { where: () => chain, andWhere: () => chain, select: async () => rows };
    return () => chain;
  };
  test('keeps vendors that resolve to a bespoke adapter (incl. Shopify), drops generic', async () => {
    const rows = [
      { id: 'cw', name: 'Chemical Warehouse', website: 'https://chemicalwarehouse.com' }, // shopify
      { id: 'dmo', name: 'DoMyOwn', website: 'https://www.domyown.com' }, // domyown
      { id: 'ves', name: 'Veseris', website: 'https://www.veseris.com' }, // veseris
      { id: 'rng', name: 'Random Co', website: 'https://example.com' }, // generic -> dropped
    ];
    const kept = await scrapableVendors(fakeDb(rows));
    expect(kept.map((v) => v.name).sort()).toEqual(['Chemical Warehouse', 'DoMyOwn', 'Veseris']);
  });
});
