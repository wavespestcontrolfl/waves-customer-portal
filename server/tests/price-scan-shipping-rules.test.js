const {
  shippingFor, shippingLabel, shippingProofText, weightLbFromQuantity, GEMPLERS_WEIGHT_TABLE,
} = require('../services/price-scan/shipping-rules');

const ENV_KEYS = ['PRICE_SCAN_DEFAULT_SHIPPING_USD', 'PRICE_SCAN_BULK_FREIGHT_USD'];
let saved;
beforeEach(() => { saved = {}; ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); });
afterEach(() => { ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

describe('shippingFor — free hosts', () => {
  test.each([
    'siteone.com', 'www.veseris.com', 'www.amazon.com', 'domyown.com', 'chemicalwarehouse.com', 'diypestcontrol.com',
  ])('%s ships free', (host) => {
    expect(shippingFor({ vendorHost: host, price: 50, quantity: '1 gal' })).toMatchObject({ amount: 0, basis: 'free' });
  });
  test('SeedBarn promo is a plain estimate with a recheck note, never firm', () => {
    const r = shippingFor({ vendorHost: 'seedbarn.com', price: 20, quantity: '5 lb' });
    expect(r).toMatchObject({ amount: 15, basis: 'estimated' });
    expect(r.note).toMatch(/time-limited promo, recheck/);
    expect(shippingProofText(r)).toBe('shipping estimated ~$15.00 (not a quote)');
    expect(shippingProofText(r)).not.toMatch(/firm/);
  });
  test('no input flag can turn an estimated vendor into free (copy/markup detection is gone)', () => {
    for (const host of ['seedbarn.com', 'solutionsstores.com', 'golfcourselawn.store']) {
      expect(shippingFor({ vendorHost: host, price: 20, quantity: '5 lb', freeShipping: true, free_shipping: true }).basis).toBe('estimated');
    }
  });
  test('a $0 default allowance keeps an estimate labelled an estimate (label and proof text)', () => {
    process.env.PRICE_SCAN_DEFAULT_SHIPPING_USD = '0';
    const r = shippingFor({ vendorHost: 'gciturfacademy.com', price: 40, quantity: '1 gal' });
    expect(r).toMatchObject({ amount: 0, basis: 'estimated' });
    expect(shippingLabel(r)).toBe('incl. ~$0.00 est. shipping');
    expect(shippingLabel(r)).not.toMatch(/^free/);
    expect(shippingProofText(r)).toBe('shipping estimated ~$0.00 (not a quote)');
    expect(shippingLabel({ amount: 0, basis: 'free' })).toBe('free shipping');
  });
  test('reads the host from a candidate source_url or a vendor website', () => {
    expect(shippingFor({ vendor: { source_url: 'https://www.domyown.com/x-p-1.html' } }).basis).toBe('free');
    expect(shippingFor({ vendor: { website: 'https://diypestcontrol.com' } }).basis).toBe('free');
  });
  test('a display name alone resolves only when there is no host at all', () => {
    expect(shippingFor({ vendorName: 'DoMyOwn' }).basis).toBe('free');
    expect(shippingFor({ vendorName: 'DoMyOwn', vendor: { source_url: 'https://evil.example/x' } }).basis).toBe('estimated');
  });
});

// The table as printed on gemplers.com/pages/orders-shipping-returns (2026-10-05): [upper lb, usd].
const PUBLISHED = [
  [5, 10.99], [10, 11.99], [20, 14.99], [30, 16.99], [40, 21.99], [50, 26.99], [60, 29.99], [70, 32.99], [80, 39.99],
  [90, 49.99], [100, 59.99], [150, 79.99], [200, 99.99], [250, 125.99], [300, 149.99], [350, 175.99], [400, 199.99],
];
const gem = (quantity, extra = {}) => shippingFor({ vendorHost: 'gemplers.com', price: 30, quantity, ...extra });

describe('shippingFor — Gemplers published weight table (exact, complete)', () => {
  test('the table holds all 17 published bands, in order, exactly as printed', () => {
    expect(GEMPLERS_WEIGHT_TABLE.map((b) => [b.upToLb, b.usd])).toEqual(PUBLISHED);
  });
  test.each(PUBLISHED)('a real weight at the top of the band (%s lb) is exactly $%s and firm', (upTo, price) => {
    expect(gem(`${upTo} lb`)).toMatchObject({ amount: price, basis: 'weight_table' });
  });
  test.each(PUBLISHED.slice(0, -1).map(([upTo], i) => [upTo, PUBLISHED[i + 1][1]]))('just over %s lb (%s.01) moves to the next band, $%s', (upTo, nextPrice) => {
    expect(shippingFor({ vendorHost: 'gemplers.com', price: 30, weightLb: upTo + 0.01 })).toMatchObject({ amount: nextPrice, basis: 'weight_table' });
  });
  test('no folding: the weights the old table skipped now have their own prices', () => {
    expect(gem('7 lb').amount).toBe(11.99); // 5.01-10
    expect(gem('25 lb').amount).toBe(16.99); // 20.01-30
    expect(gem('65 lb').amount).toBe(32.99); // 60.01-70
    expect(gem('85 lb').amount).toBe(49.99); // 80.01-90
    expect(gem('120 lb').amount).toBe(79.99);
    expect(gem('225 lb').amount).toBe(125.99);
  });
  test('above the top band (over 400 lb) there is no published price -> estimated, never interpolated', () => {
    const r = shippingFor({ vendorHost: 'gemplers.com', price: 30, quantity: '401 lb' });
    expect(r.basis).toBe('estimated');
    expect(r.amount).toBe(214.99); // $199.99 top band + $15 allowance
    expect(r.note).toMatch(/top band/);
    expect(shippingFor({ vendorHost: 'gemplers.com', price: 30, quantity: '400 lb' }).basis).toBe('weight_table');
  });
  test('unknown weight under the threshold is an estimate, not a table price', () => {
    expect(gem('each').basis).toBe('estimated');
  });
});

describe('shippingFor — Gemplers free-over threshold', () => {
  test('free at/over $149 (free_over, firm), not under', () => {
    expect(shippingFor({ vendorHost: 'gemplers.com', price: 149, quantity: '1 gal' })).toMatchObject({ amount: 0, basis: 'free_over' });
    expect(shippingFor({ vendorHost: 'gemplers.com', price: 200, quantity: '50 lb' })).toMatchObject({ amount: 0, basis: 'free_over' });
    expect(shippingFor({ vendorHost: 'gemplers.com', price: 148.99, quantity: '1 lb' }).basis).toBe('weight_table');
  });
});

describe('shippingFor — Gemplers weight must be a real weight to be firm', () => {
  test('explicit lb / kg / g quantities are real weights -> firm table price', () => {
    expect(gem('5 lb')).toMatchObject({ amount: 10.99, basis: 'weight_table' });
    expect(gem('2 kg')).toMatchObject({ amount: 10.99, basis: 'weight_table' });
    expect(gem('500 g').basis).toBe('weight_table');
  });
  test('liquids use ~9 lb per gallon, and that guess is only an estimate', () => {
    expect(weightLbFromQuantity('1 gal')).toBeCloseTo(9, 5);
    const r = gem('1 gal');
    expect(r).toMatchObject({ amount: 11.99, basis: 'estimated' }); // 9 lb -> 5.01-10 band
    expect(r.note).toMatch(/weight estimated/);
    expect(shippingProofText(r)).toMatch(/shipping estimated/);
  });
  test('a liquid whose guessed weight sits right at a band boundary is estimated either side of it', () => {
    // 9 lb/gal: 2.2 gal = 19.8 lb (14.99 band), 2.3 gal = 20.7 lb (16.99 band)
    expect(gem('2.2 gal')).toMatchObject({ amount: 14.99, basis: 'estimated' });
    expect(gem('2.3 gal')).toMatchObject({ amount: 16.99, basis: 'estimated' });
  });
  test('a plain or fluid "oz" is ambiguous -> estimated', () => {
    expect(gem('17 oz')).toMatchObject({ amount: 10.99, basis: 'estimated' });
    expect(gem('17 fl oz').basis).toBe('estimated');
  });
  test('an explicit listing weight (variant grams) is firm, whatever the quantity text says', () => {
    expect(gem('1 gal', { weightLb: 6 })).toMatchObject({ amount: 11.99, basis: 'weight_table' });
    expect(gem('1 gal', { weightLb: 6 }).note).not.toMatch(/weight estimated/);
  });
});

describe('shippingFor — Gemplers special freight is never firm', () => {
  test('a special-freight item under the threshold is estimated (table floor + default allowance)', () => {
    const r = gem('2 lb', { specialFreight: true });
    expect(r).toMatchObject({ amount: 25.99, basis: 'estimated' }); // $10.99 + $15
    expect(r.note).toMatch(/special freight/);
    expect(shippingProofText(r)).toBe('shipping estimated ~$25.99 (not a quote)');
    expect(shippingProofText(r)).not.toMatch(/firm/);
  });
  test('a special-freight item over the free threshold is still estimated', () => {
    const r = shippingFor({ vendorHost: 'gemplers.com', price: 274.99, quantity: '1 gal', specialFreight: true });
    expect(r).toMatchObject({ amount: 15, basis: 'estimated' });
  });
  test('the allowance follows the env default', () => {
    process.env.PRICE_SCAN_DEFAULT_SHIPPING_USD = '20';
    expect(gem('2 lb', { specialFreight: true }).amount).toBe(30.99);
  });
  test('without the tag the same item keeps its firm table / threshold result', () => {
    expect(gem('2 lb', { specialFreight: false }).basis).toBe('weight_table');
    expect(shippingFor({ vendorHost: 'gemplers.com', price: 200, quantity: '2 lb' }).basis).toBe('free_over');
  });
  test('the flag does not change vendors that ship free on everything', () => {
    expect(shippingFor({ vendorHost: 'domyown.com', price: 30, quantity: '1 gal', specialFreight: true }).basis).toBe('free');
  });
  test('compare carries the candidate tag flag and real weight into the delivered price', () => {
    const { rankCandidates } = require('../services/price-scan/compare');
    const base = { price: 33.99, quantity: '17 oz', vendor: 'Gemplers', source_url: 'https://gemplers.com/products/x', weight_lb: 1.2 };
    const [firm] = rankCandidates([base]);
    expect(firm.shipping).toMatchObject({ amount: 10.99, basis: 'weight_table' }); // real listing weight
    const [flagged] = rankCandidates([{ ...base, special_freight: true }]);
    expect(flagged.shipping.basis).toBe('estimated');
    expect(flagged.landedPrice).toBe(59.98);
  });
});

describe('shippingFor — estimated vendors', () => {
  test.each(['solutionsstores.com', 'golfcourselawn.store'])('%s is a plain estimate (no per-item free detection)', (host) => {
    expect(shippingFor({ vendorHost: host, price: 40, quantity: '1 gal' })).toMatchObject({ amount: 15, basis: 'estimated' });
  });
  test.each([
    'gciturfacademy.com', 'intermountainturf.com', 'seedworldusa.com', 'forestrydistributing.com', 'keystonepestsolutions.com',
    'some-unknown-store.example',
  ])('%s is estimated with the default amount', (host) => {
    const r = shippingFor({ vendorHost: host, price: 40, quantity: '1 gal' });
    expect(r).toMatchObject({ amount: 15, basis: 'estimated' });
    expect(r.note).toMatch(/est\. shipping/);
  });
  test('a single item of 40 lb or more adds the bulk freight surcharge', () => {
    expect(shippingFor({ vendorHost: 'seedworldusa.com', price: 60, quantity: '39 lb' }).amount).toBe(15);
    expect(shippingFor({ vendorHost: 'seedworldusa.com', price: 60, quantity: '40 lb' })).toMatchObject({ amount: 40, basis: 'estimated' });
    expect(shippingFor({ vendorHost: 'forestrydistributing.com', price: 90, quantity: '50 lb' }).amount).toBe(40);
    expect(shippingFor({ vendorHost: 'unknown.example', price: 90, quantity: '50 lb' }).amount).toBe(40);
  });
  test('the bulk surcharge never applies to a vendor with a real free/table rule', () => {
    expect(shippingFor({ vendorHost: 'domyown.com', price: 90, quantity: '50 lb' }).amount).toBe(0);
  });
  test('env overrides change the default and bulk amounts (read at call time)', () => {
    process.env.PRICE_SCAN_DEFAULT_SHIPPING_USD = '22.5';
    process.env.PRICE_SCAN_BULK_FREIGHT_USD = '60';
    expect(shippingFor({ vendorHost: 'gciturfacademy.com', quantity: '1 gal' }).amount).toBe(22.5);
    expect(shippingFor({ vendorHost: 'gciturfacademy.com', quantity: '50 lb' }).amount).toBe(82.5);
    process.env.PRICE_SCAN_DEFAULT_SHIPPING_USD = '0';
    expect(shippingFor({ vendorHost: 'gciturfacademy.com', quantity: '1 gal' }).amount).toBe(0);
  });
  test('a garbage or negative env value falls back to the default', () => {
    process.env.PRICE_SCAN_DEFAULT_SHIPPING_USD = 'abc';
    process.env.PRICE_SCAN_BULK_FREIGHT_USD = '-5';
    expect(shippingFor({ vendorHost: 'unknown.example', quantity: '1 gal' }).amount).toBe(15);
    expect(shippingFor({ vendorHost: 'unknown.example', quantity: '50 lb' }).amount).toBe(40);
  });
  test('a custom flat rule is honored via opts.rules', () => {
    const rules = [{ id: 'x', type: 'flat', hosts: ['flat.example'], amount: 7.5 }];
    expect(shippingFor({ vendorHost: 'flat.example' }, { rules })).toMatchObject({ amount: 7.5, basis: 'flat' });
  });
});

describe('shippingFor — spoofed hosts never inherit a rule', () => {
  test.each([
    'gemplers.com.evil.com', 'https://gemplers.com@127.0.0.1/x', 'notgemplers.com', 'domyown.com.evil.com',
    'https://evil.com/domyown.com',
  ])('%s -> estimated', (src) => {
    expect(shippingFor({ vendorHost: src, price: 500, quantity: '1 gal' }).basis).toBe('estimated');
  });
  test('subdomains of a real host still match', () => {
    expect(shippingFor({ vendorHost: 'shop.gemplers.com', price: 500 }).basis).toBe('free_over');
  });
});

describe('labels', () => {
  test('shippingLabel is short and marks estimates', () => {
    expect(shippingLabel({ amount: 0, basis: 'free' })).toBe('free shipping');
    expect(shippingLabel({ amount: 15, basis: 'estimated' })).toBe('incl. ~$15.00 est. shipping');
    expect(shippingLabel({ amount: 10.99, basis: 'weight_table' })).toBe('incl. $10.99 shipping');
    expect(shippingLabel(null)).toBe('');
  });
  test('shippingProofText states firm vs estimated for the vendor email', () => {
    expect(shippingProofText({ amount: 0, basis: 'free' })).toBe('free shipping (firm)');
    expect(shippingProofText({ amount: 10.99, basis: 'weight_table' })).toBe('$10.99 shipping by published rule (firm)');
    expect(shippingProofText({ amount: 15, basis: 'estimated' })).toBe('shipping estimated ~$15.00 (not a quote)');
  });
});
