/**
 * The catalog's vendor ranking compares the DELIVERED price per unit (owner 2026-11-21: "the lower
 * price per oz, lb, g, etc, and we always should include shipping").
 *
 * scoreVendorRows is the one ranking basis: recalcBestPrice (the catalog best price) and the
 * Intelligence Bar's vendor tools both read it. A vendor_pricing row that says nothing about
 * shipping is ranked with the vendor's rule from the weekly price scan
 * (services/price-scan/shipping-rules.js). A row that states its shipping (shipping_cost, a
 * snapshot's shipping_estimate) or carries a real delivered figure keeps it. The sticker per-unit
 * figures (perOz, perUnit) that the catalog stores do not change.
 */
jest.mock('../models/db', () => { const db = () => { throw new Error('no database in this suite'); }; db.raw = db; db.transaction = db; return db; });
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (req, res, next) => next(), requireAdmin: (req, res, next) => next(), requireTechOrAdmin: (req, res, next) => next() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { scoreVendorRows, storedUnitCostPerOz } = require('../routes/admin-inventory');
const { shippingFor } = require('../services/price-scan/shipping-rules');

const GALLON = { unit_size_oz: 128 };
const siteOne = (over) => ({ id: 'siteone', vendor_name: 'SiteOne', vendor_product_url: 'https://www.siteone.com/en/x/p/1', ...over });
const solutions = (over) => ({ id: 'solutions', vendor_name: 'Solutions Pest & Lawn', vendor_product_url: 'https://www.solutionsstores.com/x', ...over });
const byId = (out) => Object.fromEntries(out.ranked.map((s) => [s.row.id, s]));
// The scan's own figure for a seller with no published rule (an estimate, env-configurable).
const estimateFor = (quantity, price) => shippingFor({ vendor: { url: 'https://www.solutionsstores.com/x' }, vendorName: 'Solutions Pest & Lawn', price, quantity });

describe('measured products: delivered price per ounce', () => {
  test('a cheaper sticker price that loses once it is delivered does not win', () => {
    const est = estimateFor('1 gal', 91.98);
    expect(est).toMatchObject({ basis: 'estimated' });
    expect(est.amount).toBeGreaterThan(0);

    const out = scoreVendorRows([solutions({ price: 91.98, quantity: '1 gal' }), siteOne({ price: 94.13, quantity: '1 gal' })], GALLON);
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

  test('a row that states its own shipping keeps it, rebuilt on the current price, and gets no rule on top', () => {
    const out = scoreVendorRows([
      solutions({ id: 'free-stated', price: 91.98, quantity: '1 gal', shipping_cost: 0 }),
      solutions({ id: 'paid-stated', price: 80, quantity: '1 gal', shipping_cost: 20 }),
      siteOne({ price: 94.13, quantity: '1 gal' }),
    ], GALLON);
    const s = byId(out);
    expect(s['free-stated'].shipping).toBeNull();
    expect(s['free-stated'].rank).toBeCloseTo(91.98 / 128, 9);
    expect(s['paid-stated'].shipping).toBeNull();
    expect(s['paid-stated'].rank).toBeCloseTo(100 / 128, 9);
    expect(out.ranked.map((r) => r.row.id)).toEqual(['free-stated', 'siteone', 'paid-stated']);
  });

  test('a stored landed figure that is a real delivered price is kept; one that repeats the sticker is silence about shipping', () => {
    const est = estimateFor('128 oz', 100);
    const out = scoreVendorRows([
      solutions({ id: 'real-landed', price: 100, quantity: '128 oz', landed_unit_price: 0.9, unit_normalized: 'oz' }),
      // 100 / 128 = 0.78125, stored to four decimals by the approval and manual paths.
      solutions({ id: 'repeats-sticker', price: 100, quantity: '128 oz', landed_unit_price: 0.7813, unit_normalized: 'oz' }),
    ], GALLON);
    const s = byId(out);
    expect(s['real-landed'].shipping).toBeNull();
    expect(s['real-landed'].rank).toBe(0.9);
    expect(s['repeats-sticker'].shipping).toMatchObject({ basis: 'estimated' });
    expect(s['repeats-sticker'].rank).toBeCloseTo((100 + est.amount) / 128, 9);
  });

  test('a price snapshot\'s own shipping estimate is used before the vendor rule, and an explicit zero is free shipping', () => {
    // An applied snapshot clears shipping_cost and keeps the listing's shipping_estimate.
    const out = scoreVendorRows([
      solutions({ id: 'estimate-zero', price: 91.98, quantity: '1 gal', shipping_estimate: '0.00' }),
      solutions({ id: 'estimate-five', price: 91.98, quantity: '1 gal', shipping_estimate: '5.00' }),
      siteOne({ price: 94.13, quantity: '1 gal' }),
    ], GALLON);
    const s = byId(out);
    expect(s['estimate-zero'].shipping).toBeNull();
    expect(s['estimate-zero'].rank).toBeCloseTo(91.98 / 128, 9);
    expect(s['estimate-five'].shipping).toBeNull();
    expect(s['estimate-five'].rank).toBeCloseTo(96.98 / 128, 9);
    expect(out.ranked.map((r) => r.row.id)).toEqual(['estimate-zero', 'siteone', 'estimate-five']);
  });

  test('tax recorded with a blank shipping field is not a statement about shipping: the vendor rule is added, then the tax', () => {
    const est = estimateFor('128 oz', 100);
    // The manual route stored landed = $107.00 / 128 oz for a 7% tax and a blank shipping field.
    const out = scoreVendorRows([
      solutions({ id: 'taxed', price: 100, quantity: '128 oz', tax_rate: '0.0700', landed_unit_price: 0.8359, unit_normalized: 'oz' }),
    ], GALLON);
    const [taxed] = out.ranked;
    expect(taxed.shipping).toMatchObject({ amount: est.amount, basis: 'estimated' });
    expect(taxed.rank).toBeCloseTo(((100 + est.amount) * 1.07) / 128, 4);
    expect(taxed.rank).toBeGreaterThan(107 / 128);
  });

  test('a stored landed figure is compared with the sticker in the row\'s stored unit, at its four decimals', () => {
    const est = estimateFor('128 oz', 2.4);
    const out = scoreVendorRows([
      // $2.40 / 128 oz = 0.01875, stored as 0.0188: a repeat of the sticker, so the row is silent about shipping.
      solutions({ id: 'cheap-oz', price: 2.4, quantity: '128 oz', landed_unit_price: 0.0188, unit_normalized: 'oz' }),
      // $20.00 / 1000 g = 0.02 a gram: also a repeat, although it is 0.567 an ounce.
      solutions({ id: 'gram-repeat', price: 20, quantity: '1000 g', landed_unit_price: 0.02, unit_normalized: 'g' }),
      // 0.025 a gram is more than the 0.02 sticker: a real delivered figure, kept.
      solutions({ id: 'gram-real', price: 20, quantity: '1000 g', landed_unit_price: 0.025, unit_normalized: 'g' }),
    ], GALLON);
    const s = byId(out);
    expect(s['cheap-oz'].shipping).toMatchObject({ basis: 'estimated' });
    expect(s['cheap-oz'].rank).toBeCloseTo((2.4 + est.amount) / 128, 9);
    expect(s['gram-repeat'].shipping).toMatchObject({ basis: 'estimated' });
    expect(s['gram-repeat'].rank).toBeGreaterThan(s['gram-repeat'].perOz);
    expect(s['gram-real'].shipping).toBeNull();
    expect(s['gram-real'].rank).toBeCloseTo(storedUnitCostPerOz(0.025, 'g'), 9);
    // A landed figure that repeats the sticker unit price stored beside it is silence too, whatever the current price says.
    const stale = scoreVendorRows([
      solutions({ id: 'stale-pair', price: 110, quantity: '128 oz', normalized_unit_price: 0.7813, landed_unit_price: 0.7813, unit_normalized: 'oz' }),
    ], GALLON).ranked[0];
    expect(stale.shipping).toMatchObject({ basis: 'estimated' });
    expect(stale.rank).toBeCloseTo((110 + estimateFor('128 oz', 110).amount) / 128, 9);
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

  test('a count row with tax and no shipping takes the vendor rule; a per-item landed figure that repeats the sticker is silence', () => {
    const est = shippingFor({ vendor: { url: 'https://www.solutionsstores.com/x' }, vendorName: 'Solutions Pest & Lawn', price: 100, quantity: '100 count' });
    const out = scoreVendorRows([
      solutions({ id: 'taxed', price: 100, quantity: '100 count', tax_rate: '0.0700' }),
      solutions({ id: 'repeats', price: 100, quantity: '100 count', landed_unit_price: 1, unit_normalized: 'each' }),
    ], { unit_size_oz: null, container_size: '100 count' });
    const s = byId(out);
    expect(s.taxed.shipping).toMatchObject({ basis: 'estimated' });
    expect(s.taxed.rank).toBeCloseTo(((100 + est.amount) * 1.07) / 100, 4);
    expect(s.repeats.shipping).toMatchObject({ basis: 'estimated' });
    expect(s.repeats.rank).toBeCloseTo((100 + est.amount) / 100, 9);
  });

  test('stated shipping and a real per-unit landed figure are kept, with no rule on top', () => {
    const out = scoreVendorRows([
      solutions({ id: 'stated', price: 10, quantity: '10 stations', shipping_cost: 20 }),
      solutions({ id: 'worker-landed', price: 10, quantity: '10 stations', landed_unit_price: 3.5, unit_normalized: 'each' }),
      siteOne({ price: 32, quantity: '10 stations' }),
    ], STATION);
    const s = byId(out);
    expect(s.stated.shipping).toBeNull();
    expect(s.stated.rank).toBeCloseTo(3, 9);
    expect(s['worker-landed'].shipping).toBeNull();
    expect(s['worker-landed'].rank).toBe(3.5);
    expect(out.ranked.map((r) => r.row.id)).toEqual(['stated', 'siteone', 'worker-landed']);
  });
});
