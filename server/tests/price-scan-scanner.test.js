const {
  hasProof,
  buildReportItem,
  scanProduct,
  reportItemsFromScan,
} = require('../services/price-scan/scanner');
const { getAdapter } = require('../services/price-scan/adapters/registry');
const { extractSizeToken } = require('../services/price-scan/extract');

const product = {
  name: 'Taurus SC',
  productName: 'Taurus SC',
  vendorProductName: 'Taurus SC Termiticide',
  epaReg: '53883-279',
  packSizeValue: 78,
  packSizeUnit: 'oz',
  product_id: 'prod-1',
  quantity: '78 oz',
  baseline: { price: 95, quantity: '78 oz', vendor: 'SiteOne' },
};

const goodCandidate = {
  name: 'Taurus SC Termiticide Insecticide 78 oz',
  quantity: '78 oz',
  price: 89,
  currency: 'USD',
  availability: 'in_stock',
  source_url: 'https://www.domyown.com/taurus-sc-p-1816.html',
  vendor_id: 'domyown',
  vendor: 'DoMyOwn',
};

describe('scanner buildReportItem (proof gate)', () => {
  test('verified candidate with a URL becomes a /report item', () => {
    const item = buildReportItem(product, goodCandidate);
    expect(item).toMatchObject({
      vendor_id: 'domyown',
      product_id: 'prod-1',
      source_url: 'https://www.domyown.com/taurus-sc-p-1816.html',
      price: 89,
      currency: 'USD',
      price_type: 'public',
      availability_status: 'in_stock',
      quantity: '78 oz',
      source_type: 'hermes_price_report',
    });
    expect(item.normalized_unit_price).toBeCloseTo(89 / 78, 6);
  });

  test('no proof URL -> null (never reaches the review queue / Mark)', () => {
    expect(buildReportItem(product, { ...goodCandidate, source_url: undefined })).toBeNull();
    expect(buildReportItem(product, { ...goodCandidate, source_url: '' })).toBeNull();
    expect(buildReportItem(product, { ...goodCandidate, source_url: 'not-a-url' })).toBeNull();
  });

  test('missing vendor_id or bad price -> null', () => {
    expect(buildReportItem(product, { ...goodCandidate, vendor_id: undefined })).toBeNull();
    expect(buildReportItem(product, { ...goodCandidate, price: 0 })).toBeNull();
    expect(buildReportItem(product, { ...goodCandidate, price: -5 })).toBeNull();
  });

  test('non-USD currency -> null (worker is USD-only)', () => {
    expect(buildReportItem(product, { ...goodCandidate, currency: 'CAD' })).toBeNull();
  });

  test('no parseable scraped size -> not emitted (would mis-set best_price)', () => {
    // No size -> no normalized_unit_price -> downstream best-price ordering falls
    // back to total price. Keep it out of the /report approval path entirely
    // (it never borrows the expected 78 oz).
    expect(buildReportItem(product, { ...goodCandidate, quantity: undefined })).toBeNull();
    expect(buildReportItem(product, { ...goodCandidate, quantity: 'each' })).toBeNull();
  });

  test('unbuyable (out_of_stock / backorder) candidate is not emitted', () => {
    expect(buildReportItem(product, { ...goodCandidate, availability: 'out_of_stock' })).toBeNull();
    expect(buildReportItem(product, { ...goodCandidate, availability: 'backorder' })).toBeNull();
    // limited / unknown remain emittable
    expect(buildReportItem(product, { ...goodCandidate, availability: 'limited' })).not.toBeNull();
  });

  test('hasProof requires an http(s) URL', () => {
    expect(hasProof({ source_url: 'https://x.com/p' })).toBe(true);
    expect(hasProof({ source_url: 'ftp://x' })).toBe(false);
    expect(hasProof({})).toBe(false);
  });
});

describe('scanner scanProduct', () => {
  const fetchFrom = (byVendor) => (adapter, vendor) => Promise.resolve(byVendor[vendor.vendor_id] ?? null);

  test('verified cheaper candidate -> verified + opportunity', async () => {
    const vendors = [{ vendor_id: 'domyown', name: 'DoMyOwn', url: goodCandidate.source_url }];
    const scan = await scanProduct(product, vendors, { fetchCandidate: fetchFrom({ domyown: goodCandidate }) });
    expect(scan.verified).toHaveLength(1);
    expect(scan.skipped).toHaveLength(0);
    expect(scan.opportunity.isOpportunity).toBe(true);
    expect(scan.opportunity.best.vendor_id).toBe('domyown');
  });

  test('a DB vendor row (.id, the vendors UUID) populates vendor_id for /report', async () => {
    // candidate carries no vendor_id; the vendor is a DB row with .id (not slug).
    const cand = { name: 'Taurus SC Termiticide 78 oz', quantity: '78 oz', price: 89, currency: 'USD', availability: 'in_stock', source_url: 'https://www.domyown.com/p' };
    const vendors = [{ id: 'uuid-vendor-1', name: 'DoMyOwn', url: cand.source_url }];
    const scan = await scanProduct(product, vendors, { fetchCandidate: () => Promise.resolve(cand) });
    expect(scan.verified[0].vendor_id).toBe('uuid-vendor-1');
    expect(reportItemsFromScan(product, scan)[0].vendor_id).toBe('uuid-vendor-1');
  });

  test('wrong-product candidate is skipped as unverified', async () => {
    const wrong = {
      name: 'Termidor SC Foam', quantity: '1 gal', price: 50,
      availability: 'in_stock', source_url: 'https://k.com/p', vendor_id: 'keystone',
    };
    const vendors = [{ vendor_id: 'keystone', name: 'Keystone', url: 'https://k.com/p' }];
    const scan = await scanProduct(product, vendors, { fetchCandidate: fetchFrom({ keystone: wrong }) });
    expect(scan.verified).toHaveLength(0);
    expect(scan.skipped[0].reason).toBe('unverified');
  });

  test('verified-but-proofless candidate is skipped (no_proof_url)', async () => {
    const noUrl = { ...goodCandidate, source_url: undefined };
    const vendors = [{ vendor_id: 'domyown', name: 'DoMyOwn', url: 'https://www.domyown.com/x' }];
    const scan = await scanProduct(product, vendors, { fetchCandidate: fetchFrom({ domyown: noUrl }) });
    expect(scan.verified).toHaveLength(0);
    expect(scan.skipped[0].reason).toBe('no_proof_url');
  });

  test('fetch errors and empty results are recorded, not thrown', async () => {
    const vendors = [
      { vendor_id: 'a', name: 'A', url: 'https://a.com/p' },
      { vendor_id: 'b', name: 'B', url: 'https://b.com/p' },
    ];
    const fetchCandidate = (adapter, vendor) => {
      if (vendor.vendor_id === 'a') return Promise.reject(new Error('nav timeout'));
      return Promise.resolve(null);
    };
    const scan = await scanProduct(product, vendors, { fetchCandidate });
    expect(scan.verified).toHaveLength(0);
    expect(scan.skipped.map((s) => s.reason).sort()).toEqual(['fetch_error', 'no_candidate']);
  });

  test('non-USD candidate is skipped before opportunity ranking', async () => {
    const cad = { ...goodCandidate, currency: 'CAD', price: 70, vendor_id: 'foreign' };
    const vendors = [{ vendor_id: 'foreign', name: 'CA Shop', url: 'https://ca.example/p' }];
    const scan = await scanProduct(product, vendors, { fetchCandidate: fetchFrom({ foreign: cad }) });
    expect(scan.verified).toHaveLength(0);
    expect(scan.opportunity.isOpportunity).toBe(false);
    expect(scan.skipped[0]).toMatchObject({ reason: 'non_usd', detail: 'CAD' });
  });

  test('throws if no fetchCandidate is injected', async () => {
    await expect(scanProduct(product, [], {})).rejects.toThrow(/fetchCandidate/);
  });

  test('reportItemsFromScan only emits verified, proof-bearing items', async () => {
    const vendors = [{ vendor_id: 'domyown', name: 'DoMyOwn', url: goodCandidate.source_url }];
    const scan = await scanProduct(product, vendors, { fetchCandidate: fetchFrom({ domyown: goodCandidate }) });
    const items = reportItemsFromScan(product, scan);
    expect(items).toHaveLength(1);
    expect(items[0].source_url).toBe(goodCandidate.source_url);
  });
});

describe('adapter registry getAdapter', () => {
  test('returns a configured adapter with fetchCandidate', () => {
    const a = getAdapter('domyown');
    expect(a.key).toBe('domyown');
    expect(typeof a.fetchCandidate).toBe('function');
  });
  test('veseris resolves to its login adapter; unknown key falls back to generic', () => {
    expect(getAdapter('veseris').key).toBe('veseris'); // now built (B2B login adapter)
    expect(getAdapter('nope').key).toBe('generic');
  });
});

describe('extractSizeToken', () => {
  test('pulls a clean size token out of a noisy title', () => {
    expect(extractSizeToken('Taurus SC Termiticide Insecticide 78 oz')).toBe('78 oz');
    expect(extractSizeToken('Bifen I/T 96 fl oz Bottle')).toBe('96 fl oz');
    expect(extractSizeToken('Dominion 2L 27.5 oz')).toBe('27.5 oz');
    expect(extractSizeToken('Talstar Pro 3/4 gallon jug')).toBe('3/4 gallon');
    expect(extractSizeToken('Tekko Pro IGR 18 lb pail')).toBe('18 lb');
  });
  test('null when there is no size', () => {
    expect(extractSizeToken('Advion Cockroach Bait Stations')).toBeNull();
    expect(extractSizeToken('')).toBeNull();
  });
  test('multipack expressions keep the pack count', () => {
    expect(extractSizeToken('Taurus SC 78 oz. CASE (4 x 78 oz. bottles)')).toBe('4 x 78 oz');
    expect(extractSizeToken('Tekko Pro 4 x 30 gram tubes')).toBe('4 x 30 gram');
    expect(extractSizeToken('Gel Bait 4 x 30 g')).toBe('4 x 30 g'); // bare g ok in N x M shape
  });
  test('mixed numbers and dotted fl. oz normalize for parsePackSize', () => {
    expect(extractSizeToken('Drum 2 1/2 gal')).toBe('2 1/2 gal');
    expect(extractSizeToken('Bifen 30 fl. oz Bottle')).toBe('30 fl oz'); // dot dropped
  });
});

describe('veseris login-URL host guard (security)', () => {
  const { isTrustedVeserisLoginUrl } = require('../services/price-scan/adapters/veseris');
  test('accepts https veseris.com hosts', () => {
    expect(isTrustedVeserisLoginUrl('https://veseris.com/default/customer/account/login/')).toBe(true);
    expect(isTrustedVeserisLoginUrl('https://www.veseris.com/customer/account/login')).toBe(true);
  });
  test('rejects non-https, foreign hosts, and look-alikes (fail closed)', () => {
    expect(isTrustedVeserisLoginUrl('http://veseris.com/login')).toBe(false); // not https
    expect(isTrustedVeserisLoginUrl('https://evil.com/login')).toBe(false);
    expect(isTrustedVeserisLoginUrl('https://veseris.com.evil.com/login')).toBe(false); // look-alike
    expect(isTrustedVeserisLoginUrl('https://notveseris.com/login')).toBe(false);
    expect(isTrustedVeserisLoginUrl('garbage')).toBe(false);
    expect(isTrustedVeserisLoginUrl(null)).toBe(false);
  });
});
