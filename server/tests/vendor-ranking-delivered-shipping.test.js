/**
 * The catalog's vendor ranking compares the DELIVERED price per unit (owner 2026-11-21: "the lower
 * price per oz, lb, g, etc, and we always should include shipping").
 *
 * scoreVendorRows is the one ranking basis: recalcBestPrice (the catalog best price) and the
 * Intelligence Bar's vendor tools both read it. A vendor_pricing row that gives no delivered price
 * is ranked on its current price plus shipping. Two row shapes get shipping added (an allow-list):
 * a row that says nothing takes the vendor's rule from the weekly price scan
 * (services/price-scan/shipping-rules.js), and a row whose one statement is a shipping estimate
 * takes that estimate. A row outside the list (entered shipping or tax, a fee, a reported landed
 * quote, a landed figure that differs from its sticker) is ranked exactly as before the rule
 * existed. The sticker per-unit figures (perOz, perUnit) that the catalog stores do not change.
 */
jest.mock('../models/db', () => { const db = () => { throw new Error('no database in this suite'); }; db.raw = db; db.transaction = db; return db; });
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (req, res, next) => next(), requireAdmin: (req, res, next) => next(), requireTechOrAdmin: (req, res, next) => next() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { scoreVendorRows, storedUnitCostPerOz } = require('../routes/admin-inventory');
const { shippingFor } = require('../services/price-scan/shipping-rules');

// The estimate is an env allowance (docs/gates-and-env.md): pinned, so a supported setting cannot change which row wins here.
const PINNED = { PRICE_SCAN_DEFAULT_SHIPPING_USD: '15', PRICE_SCAN_BULK_FREIGHT_USD: '25' };
const before = {};
beforeAll(() => { for (const [key, value] of Object.entries(PINNED)) { before[key] = process.env[key]; process.env[key] = value; } });
afterAll(() => { for (const key of Object.keys(PINNED)) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } });

const GALLON = { unit_size_oz: 128 };
const siteOne = (over) => ({ id: 'siteone', vendor_name: 'SiteOne', vendor_product_url: 'https://www.siteone.com/en/x/p/1', ...over });
const solutions = (over) => ({ id: 'solutions', vendor_name: 'Solutions Pest & Lawn', vendor_product_url: 'https://www.solutionsstores.com/x', ...over });
const byId = (out) => Object.fromEntries(out.ranked.map((s) => [s.row.id, s]));
// The scan's own figure for a seller with no published rule (an estimate, env-configurable).
const estimateFor = (quantity, price) => shippingFor({ vendor: { url: 'https://www.solutionsstores.com/x' }, vendorName: 'Solutions Pest & Lawn', price, quantity });
// What the manual route stores beside a price with no shipping entered: the sticker per ounce, twice.
const manualPair = (perOz) => ({ normalized_unit_price: perOz, landed_unit_price: perOz, unit_normalized: 'oz', source_type: 'manual', price_type: 'manual' });

describe('measured products: delivered price per ounce', () => {
  test('a cheaper sticker price that loses once it is delivered does not win', () => {
    const est = estimateFor('1 gal', 91.98);
    expect(est).toMatchObject({ basis: 'estimated' });
    expect(est.amount).toBeGreaterThan(0);

    const out = scoreVendorRows([
      solutions({ price: 91.98, quantity: '1 gal', ...manualPair(0.7186) }),
      siteOne({ price: 94.13, quantity: '1 gal', ...manualPair(0.7354) }),
    ], GALLON);
    expect(out.mode).toBe('oz');
    expect(out.pool[0].row.id).toBe('siteone');
    const s = byId(out);
    // The sticker per-ounce price (what the catalog stores) is untouched on both rows.
    expect(s.solutions.perOz).toBeCloseTo(91.98 / 128, 9);
    expect(s.siteone.perOz).toBeCloseTo(94.13 / 128, 9);
    // The rank is delivered: SiteOne ships free, the other seller's rule is added.
    expect(s.siteone.rank).toBeCloseTo(94.13 / 128, 9);
    expect(s.siteone.shipping).toMatchObject({ amount: 0, basis: 'free' });
    expect(s.solutions.rank).toBeCloseTo((91.98 + est.amount) / 128, 9);
    expect(s.solutions.shipping).toMatchObject({ amount: est.amount, basis: 'estimated' });
  });

  test('a seller that ships free still wins on a cheaper price per ounce', () => {
    const out = scoreVendorRows([
      siteOne({ price: 60.72, quantity: '16 fl oz' }),
      { id: 'amazon', vendor_name: 'Amazon', vendor_product_url: 'https://www.amazon.com/dp/B000000000', price: 53.5, quantity: '16 oz' },
    ], { unit_size_oz: 16 });
    expect(out.pool[0].row.id).toBe('amazon');
    expect(out.pool[0].shipping).toMatchObject({ amount: 0, basis: 'free' });
    expect(out.pool[0].rank).toBeCloseTo(53.5 / 16, 9);
  });

  test('the price per ounce decides, not the pack price: a larger pack with shipping can still win', () => {
    // 2.5 gal at $180 + the estimate is cheaper per ounce delivered than 1 gal at $94.13 shipped free.
    const est = estimateFor('2.5 gal', 180);
    const out = scoreVendorRows([siteOne({ price: 94.13, quantity: '1 gal' }), solutions({ price: 180, quantity: '2.5 gal' })], GALLON);
    expect((180 + est.amount) / 320).toBeLessThan(94.13 / 128);
    expect(out.pool[0].row.id).toBe('solutions');
    expect(out.pool[0].rank).toBeCloseTo((180 + est.amount) / 320, 9);
  });

  test('a stored landed figure that repeats the sticker stored beside it is silence, compared as stored in the row\'s own unit', () => {
    const out = scoreVendorRows([
      // $2.40 / 128 oz = 0.01875, stored as 0.0188 twice.
      solutions({ id: 'cheap-oz', price: 2.4, quantity: '128 oz', ...manualPair(0.0188) }),
      // $20.00 / 1000 g = 0.02 a gram, although it is 0.567 an ounce.
      solutions({ id: 'gram', price: 20, quantity: '1000 g', normalized_unit_price: 0.02, landed_unit_price: 0.02, unit_normalized: 'g' }),
      // The pair was stored at an older price: the row is repriced from $100.00 to $110.00.
      solutions({ id: 'stale-pair', price: 110, quantity: '128 oz', ...manualPair(0.7813) }),
      siteOne({ id: 'stale-free', price: 110, quantity: '128 oz', ...manualPair(0.7813) }),
    ], GALLON);
    const s = byId(out);
    expect(s['cheap-oz'].shipping).toMatchObject({ basis: 'estimated' });
    expect(s['cheap-oz'].rank).toBeCloseTo((2.4 + estimateFor('128 oz', 2.4).amount) / 128, 9);
    expect(s.gram.shipping).toMatchObject({ basis: 'estimated' });
    expect(s.gram.rank).toBeGreaterThan(s.gram.perOz);
    // The rule is added to the CURRENT price, never to the older stored pair.
    expect(s['stale-pair'].rank).toBeCloseTo((110 + estimateFor('128 oz', 110).amount) / 128, 9);
    expect(s['stale-free'].shipping).toMatchObject({ amount: 0, basis: 'free' });
    expect(s['stale-free'].rank).toBeCloseTo(110 / 128, 9);
  });

  // The allow-list: each of these rows states something about its delivered price, so it gets NO vendor rule and
  // ranks exactly as it did before the rule existed (stored landed per ounce, else sticker per ounce).
  test.each([
    ['an entered shipping cost, with the landed figure the manual route stores for it', { price: 80, shipping_cost: 20, normalized_unit_price: 0.625, landed_unit_price: 0.7813, unit_normalized: 'oz' }, 0.7813],
    ['an entered shipping of 0 (free shipping)', { price: 91.98, shipping_cost: 0, ...manualPair(0.7186) }, 0.7186],
    ['a negative entered shipping', { price: 91.98, shipping_cost: -1 }, 91.98 / 128],
    ['a negative shipping estimate', { price: 91.98, shipping_estimate: '-1.00' }, 91.98 / 128],
    ['a shipping estimate beside a landed figure that already holds it', { price: 80, shipping_estimate: '20.00', normalized_unit_price: 0.625, landed_unit_price: 0.7813, unit_normalized: 'oz' }, 0.7813],
    ['a shipping estimate beside a tax rate', { price: 91.98, shipping_estimate: '5.00', tax_rate: '0.0700' }, 91.98 / 128],
    ['a recorded hazmat fee', { price: 91.98, hazmat_fee_estimate: '12.00' }, 91.98 / 128],
    ['a recorded rebate', { price: 91.98, rebate_estimate: '3.00' }, 91.98 / 128],
    ['a tax rate, with the landed figure the manual route stores for it', { price: 100, tax_rate: '0.0700', normalized_unit_price: 0.7813, landed_unit_price: 0.8359, unit_normalized: 'oz' }, 0.8359],
    ['a landed figure that differs from its sticker', { price: 100, normalized_unit_price: 0.7813, landed_unit_price: 0.9, unit_normalized: 'oz' }, 0.9],
    ['a landed figure with no stored sticker to compare', { price: 100, landed_unit_price: 0.7813, unit_normalized: 'oz' }, 0.7813],
    ['a reported price whose landed quote equals the sticker (ships free)', { price: 91.98, ...manualPair(0.7186), source_type: 'hermes_price_report', price_type: 'account' }, 0.7186],
    ['a reported price under the manual price type', { price: 91.98, ...manualPair(0.7186), source_type: 'hermes_price_report', price_type: 'manual' }, 0.7186],
    ['a source this rule does not know', { price: 91.98, ...manualPair(0.7186), source_type: 'vendor_feed' }, 0.7186],
  ])('%s: no vendor rule, ranked as before', (_name, fields, rank) => {
    const [scored] = scoreVendorRows([solutions({ quantity: '1 gal', ...fields })], GALLON).ranked;
    expect(scored.shipping).toBeNull();
    expect(scored.rank).toBeCloseTo(rank, 9);
  });

  test('a row whose one statement is a shipping estimate is ranked with that estimate, not the vendor rule', () => {
    const out = scoreVendorRows([
      solutions({ id: 'five', price: 91.98, quantity: '1 gal', shipping_estimate: '5.00' }),
      solutions({ id: 'zero', price: 91.98, quantity: '1 gal', shipping_estimate: '0.00' }),
    ], GALLON);
    const s = byId(out);
    expect(s.five.shipping).toMatchObject({ amount: 5, basis: 'estimated' });
    expect(s.five.rank).toBeCloseTo((91.98 + 5) / 128, 9);
    expect(s.five.deliveredPerOz).toBeCloseTo((91.98 + 5) / 128, 9);
    expect(s.zero.shipping).toMatchObject({ amount: 0, basis: 'estimated' });
    expect(s.zero.rank).toBeCloseTo(91.98 / 128, 9);
  });

  test('a reported price with no landed quote says nothing, like a manual one: it takes the vendor rule', () => {
    const est = estimateFor('1 gal', 91.98);
    const [scored] = scoreVendorRows([
      solutions({ price: 91.98, quantity: '1 gal', source_type: 'hermes_price_report', price_type: 'account' }),
    ], GALLON).ranked;
    expect(scored.shipping).toMatchObject({ amount: est.amount, basis: 'estimated' });
    expect(scored.rank).toBeCloseTo((91.98 + est.amount) / 128, 9);
  });

  test('a rule that depends on facts the row does not carry is counted at its published amount and labelled an estimate', () => {
    // Free over $149 unless the item is hazardous or oversize: the catalog row cannot tell.
    const out = scoreVendorRows([
      { id: 'threshold', vendor_name: 'Gemplers', vendor_product_url: 'https://gemplers.com/products/x', price: 200, quantity: '1 gal' },
      siteOne({ price: 210, quantity: '1 gal' }),
    ], GALLON);
    const s = byId(out);
    expect(s.threshold.shipping).toMatchObject({ amount: 0, basis: 'estimated' });
    expect(s.threshold.rank).toBeCloseTo(200 / 128, 9);
    // An unconditional rule stays firm.
    expect(s.siteone.shipping).toMatchObject({ amount: 0, basis: 'free' });
  });

  test('deliveredPerOz is the price with delivery in it, and null for a row that gives none', () => {
    const out = scoreVendorRows([
      solutions({ id: 'rule', price: 91.98, quantity: '1 gal' }),
      solutions({ id: 'own-landed', price: 100, quantity: '1 gal', normalized_unit_price: 0.7813, landed_unit_price: 0.9, unit_normalized: 'oz' }),
      solutions({ id: 'fee-only', price: 91.98, quantity: '1 gal', hazmat_fee_estimate: '12.00' }),
      { id: 'no-vendor', price: 91.98, quantity: '1 gal' },
    ], GALLON);
    const s = byId(out);
    expect(s.rule.deliveredPerOz).toBeCloseTo(s.rule.rank, 9);
    expect(s['own-landed'].deliveredPerOz).toBeCloseTo(0.9, 9);
    // Ranked on the sticker price, as before; not a delivered figure.
    expect(s['fee-only'].deliveredPerOz).toBeNull();
    expect(s['fee-only'].rank).toBeCloseTo(91.98 / 128, 9);
    expect(s['no-vendor'].deliveredPerOz).toBeNull();
  });

  test('a gram-denominated landed figure that differs from its sticker is kept in its own unit', () => {
    const [scored] = scoreVendorRows([
      solutions({ price: 20, quantity: '1000 g', normalized_unit_price: 0.02, landed_unit_price: 0.025, unit_normalized: 'g' }),
    ], GALLON).ranked;
    expect(scored.shipping).toBeNull();
    expect(scored.rank).toBeCloseTo(storedUnitCostPerOz(0.025, 'g'), 9);
  });

  test('a row with no vendor identity has no rule to apply and ranks on its sticker price', () => {
    const out = scoreVendorRows([{ id: 'x', price: 100, quantity: '128 oz' }, { id: 'y', price: 40, quantity: '32 oz' }], { unit_size_oz: 64 });
    expect(out.ranked.map((r) => r.row.id)).toEqual(['x', 'y']);
    expect(out.ranked[0].shipping).toBeNull();
    expect(out.ranked[0].rank).toBeCloseTo(100 / 128, 9);
    expect(out.ranked[1].rank).toBeCloseTo(40 / 32, 9);
  });
});

describe('count products: delivered price per unit', () => {
  const STATION = { unit_size_oz: null, container_size: '1 station' };

  test('one station at a lower sticker price loses to a case that ships free', () => {
    const est = shippingFor({ vendor: {}, vendorName: 'Solutions Pest & Lawn', price: 14, quantity: '1 station' });
    const out = scoreVendorRows([
      // No listing URL on this row: the rule is found by the vendor name.
      { id: 'single', vendor_name: 'Solutions Pest & Lawn', price: 14, quantity: '1 station' },
      siteOne({ price: 143, quantity: '10 stations' }),
    ], STATION);
    expect(out.mode).toBe('count');
    expect(out.pool[0].row.id).toBe('siteone');
    const s = byId(out);
    // The sticker per-unit price (what the catalog stores) is untouched.
    expect(s.single.perUnit).toBe(14);
    expect(s.siteone.perUnit).toBeCloseTo(14.3, 9);
    expect(s.single.rank).toBeCloseTo(14 + est.amount, 9);
    expect(s.siteone.rank).toBeCloseTo(14.3, 9);
  });

  test('a per-item landed figure that repeats the stored sticker is silence: the rule is added', () => {
    const est = shippingFor({ vendor: { url: 'https://www.solutionsstores.com/x' }, vendorName: 'Solutions Pest & Lawn', price: 100, quantity: '100 count' });
    const [scored] = scoreVendorRows([
      solutions({ price: 100, quantity: '100 count', normalized_unit_price: 1, landed_unit_price: 1, unit_normalized: 'each' }),
    ], { unit_size_oz: null, container_size: '100 count' }).ranked;
    expect(scored.shipping).toMatchObject({ basis: 'estimated' });
    expect(scored.rank).toBeCloseTo((100 + est.amount) / 100, 9);
  });

  test('entered shipping, entered tax and a real per-item landed figure rank as before, with no rule on top', () => {
    const out = scoreVendorRows([
      solutions({ id: 'stated', price: 10, quantity: '10 stations', shipping_cost: 20 }),
      solutions({ id: 'taxed', price: 30, quantity: '10 stations', tax_rate: '0.0700' }),
      solutions({ id: 'worker-landed', price: 10, quantity: '10 stations', landed_unit_price: 3.5, unit_normalized: 'each' }),
      siteOne({ price: 32, quantity: '10 stations' }),
    ], STATION);
    const s = byId(out);
    expect(s.stated.shipping).toBeNull();
    expect(s.stated.rank).toBeCloseTo(3, 9);
    expect(s.taxed.shipping).toBeNull();
    expect(s.taxed.rank).toBeCloseTo(3.21, 9);
    expect(s['worker-landed'].shipping).toBeNull();
    expect(s['worker-landed'].rank).toBe(3.5);
    expect(out.ranked.map((r) => r.row.id)).toEqual(['stated', 'siteone', 'taxed', 'worker-landed']);
  });
});
