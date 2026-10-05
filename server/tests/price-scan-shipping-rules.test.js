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
  test('SeedBarn promo is never a permanent free: estimated unless the offer is flagged free', () => {
    const r = shippingFor({ vendorHost: 'seedbarn.com', price: 20, quantity: '5 lb' });
    expect(r).toMatchObject({ amount: 15, basis: 'estimated' });
    expect(r.note).toMatch(/time-limited promo, recheck/);
    expect(shippingProofText(r)).toBe('shipping estimated ~$15.00 (not a quote)');
    expect(shippingProofText(r)).not.toMatch(/firm/);
    const flagged = shippingFor({ vendorHost: 'seedbarn.com', price: 20, quantity: '5 lb', freeShipping: true });
    expect(flagged).toMatchObject({ amount: 0, basis: 'free', promo: true });
    expect(flagged.note).toMatch(/recheck/);
    expect(shippingProofText(flagged)).toBe('free shipping (current promo, recheck)');
    expect(shippingProofText(flagged)).not.toMatch(/firm/);
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

describe('shippingFor — Gemplers', () => {
  test('free at/over $149 (free_over), not under', () => {
    expect(shippingFor({ vendorHost: 'gemplers.com', price: 149, quantity: '1 gal' })).toMatchObject({ amount: 0, basis: 'free_over' });
    expect(shippingFor({ vendorHost: 'gemplers.com', price: 200, quantity: '50 lb' })).toMatchObject({ amount: 0, basis: 'free_over' });
    expect(shippingFor({ vendorHost: 'gemplers.com', price: 148.99, quantity: '1 lb' }).basis).toBe('weight_table');
  });
  test.each([
    ['2 lb', 10.99], ['5 lb', 10.99], ['12 lb', 14.99], ['20 lb', 14.99], ['35 lb', 21.99],
    ['45 lb', 26.99], ['55 lb', 29.99], ['75 lb', 39.99], ['95 lb', 49.99],
  ])('weight band for %s is $%s', (qty, usd) => {
    expect(shippingFor({ vendorHost: 'gemplers.com', price: 30, quantity: qty })).toMatchObject({ amount: usd, basis: 'weight_table' });
  });
  test('a weight in a gap between published bands is charged the next band up', () => {
    const at = (qty) => shippingFor({ vendorHost: 'gemplers.com', price: 30, quantity: qty }).amount;
    expect(at('7 lb')).toBe(14.99); // 5-10 gap -> 10-20 band
    expect(at('25 lb')).toBe(21.99); // 20-30 gap -> 30-40 band
    expect(at('65 lb')).toBe(39.99); // 60-70 gap -> 70-80 band
    expect(at('85 lb')).toBe(49.99); // 80-90 gap -> 90-100 band
  });
  test('liquids use ~9 lb per gallon', () => {
    expect(weightLbFromQuantity('1 gal')).toBeCloseTo(9, 5);
    expect(shippingFor({ vendorHost: 'gemplers.com', price: 40, quantity: '1 gal' }).amount).toBe(14.99); // 9 lb -> 5-20 band
    expect(shippingFor({ vendorHost: 'gemplers.com', price: 40, quantity: '1 qt' }).amount).toBe(10.99); // 2.25 lb
  });
  test('beyond the published table is interpolated and labelled estimated', () => {
    const r = shippingFor({ vendorHost: 'gemplers.com', price: 120, quantity: '150 lb' });
    expect(r.basis).toBe('estimated');
    expect(r.amount).toBeGreaterThan(GEMPLERS_WEIGHT_TABLE[GEMPLERS_WEIGHT_TABLE.length - 1].usd);
    expect(r.amount).toBeLessThanOrEqual(199.99);
  });
  test('unknown weight under the threshold is an estimate, not a table price', () => {
    expect(shippingFor({ vendorHost: 'gemplers.com', price: 40, quantity: 'each' }).basis).toBe('estimated');
  });
});

describe('shippingFor — Gemplers hazardous items are never firm', () => {
  test('a hazmat item under the threshold is estimated (table floor + hazmat allowance), not weight_table', () => {
    const r = shippingFor({ vendorHost: 'gemplers.com', price: 33.99, quantity: '17 oz', hazmat: true });
    expect(r.basis).toBe('estimated');
    expect(r.amount).toBe(25.99); // $10.99 table floor + $15 default allowance
    expect(r.note).toMatch(/hazmat fee/);
    expect(shippingProofText(r)).toBe('shipping estimated ~$25.99 (not a quote)');
    expect(shippingProofText(r)).not.toMatch(/firm/);
  });
  test('a hazmat item over the free threshold is still estimated (free-over may exclude hazmat)', () => {
    const r = shippingFor({ vendorHost: 'gemplers.com', price: 274.99, quantity: '1 gal', hazmat: true });
    expect(r).toMatchObject({ amount: 15, basis: 'estimated' });
    expect(shippingProofText(r)).not.toMatch(/firm/);
  });
  test('the hazmat allowance follows the env default', () => {
    process.env.PRICE_SCAN_DEFAULT_SHIPPING_USD = '20';
    expect(shippingFor({ vendorHost: 'gemplers.com', price: 30, quantity: '2 lb', hazmat: true }).amount).toBe(30.99);
  });
  test('a non-hazmat Gemplers item keeps its firm table / free-over result', () => {
    expect(shippingFor({ vendorHost: 'gemplers.com', price: 30, quantity: '2 lb', hazmat: false }).basis).toBe('weight_table');
    expect(shippingFor({ vendorHost: 'gemplers.com', price: 200, quantity: '2 lb' }).basis).toBe('free_over');
  });
  test('the hazmat flag does not change vendors whose rule has no hazmat extra', () => {
    expect(shippingFor({ vendorHost: 'domyown.com', price: 30, quantity: '1 gal', hazmat: true }).basis).toBe('free');
  });
  test('compare carries the flag from a scanned candidate into the delivered price', () => {
    const { rankCandidates } = require('../services/price-scan/compare');
    const [c] = rankCandidates([{ price: 33.99, quantity: '17 oz', vendor: 'Gemplers', source_url: 'https://gemplers.com/products/x', hazmat_shipping: true }]);
    expect(c.shipping.basis).toBe('estimated');
    expect(c.landedPrice).toBe(59.98);
  });
});

describe('shippingFor — flagged-free and estimated vendors', () => {
  test.each(['solutionsstores.com', 'golfcourselawn.store'])('%s is estimated unless the offer is flagged free', (host) => {
    expect(shippingFor({ vendorHost: host, price: 40, quantity: '1 gal' })).toMatchObject({ amount: 15, basis: 'estimated' });
    expect(shippingFor({ vendorHost: host, price: 40, quantity: '1 gal', freeShipping: true })).toMatchObject({ amount: 0, basis: 'free' });
    expect(shippingFor({ vendorHost: host, price: 40, quantity: '1 gal', freeShipping: false }).basis).toBe('estimated');
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
