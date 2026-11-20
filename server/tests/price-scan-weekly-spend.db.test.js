// The weekly price scan's ranking input through PostgreSQL (owner 2026-11-20, *scan*): each product's material cost that
// job costing booked over the last 12 months, read from the product lines on job_costs.products_used. Synthetic rows only.
// Skips without DATABASE_URL; CI runs it.
//
// Pinned: a product's booked lines are summed across visits; a visit on the first day of the window counts and the day before
// it does not; a product nobody asked about, a line with no number, a line with no product and a products_used that is not an
// array add nothing and break nothing; a product booked only at $0 has zero spend (the scan then leaves it out).
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const { bookedSpendByProduct, SPEND_WINDOW_DAYS } = require('../services/price-scan/weekly-scan');
const { etDateString, addETDays } = require('../utils/datetime-et');

describeDb('weekly price scan: booked spend through PostgreSQL', () => {
  const schema = `price_scan_spend_${randomUUID().replace(/-/g, '')}`;
  const now = new Date();
  const day = (offset) => etDateString(addETDays(now, offset));
  const ids = { used: randomUUID(), second: randomUUID(), zero: randomUUID(), old: randomUUID(), notAsked: randomUUID() };
  let knex;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 2 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, 'job_costs', 'job_costs']);
    const customerId = randomUUID();
    // The line shape job-costing.js calcProductsCost writes (an inventory movement line also carries source and stock_after).
    const line = (productId, cost, extra = {}) => ({ product_id: productId, qty: 1, unit: 'oz', unit_cost: cost, line: cost, ...extra });
    const visit = (offset, productsUsed) => ({
      customer_id: customerId, scheduled_service_id: randomUUID(), service_date: day(offset), service_type: 'Fixture visit',
      products_used: JSON.stringify(productsUsed),
    });
    await knex('job_costs').insert([
      visit(-3, [line(ids.used, 5), line(ids.notAsked, 9), line(ids.zero, 0, { source: 'inventory_movement', stock_after: 0 })]),
      visit(-40, [line(ids.used, 2.5), line(ids.second, 0.38), line(ids.second, 2.01)]),
      visit(-SPEND_WINDOW_DAYS, [line(ids.used, 1)]), // the first day of the window counts
      visit(-SPEND_WINDOW_DAYS - 1, [line(ids.used, 50), line(ids.old, 70)]), // the day before it does not
      visit(-5, [line(ids.used, '12.00'), { qty: 1, line: 7 }, 'not a line']), // no number, no product, not an object
      visit(-6, { note: 'hand-entered job cost' }), // products_used that is not an array
    ]);
  }, 60000);

  afterAll(async () => {
    if (!knex) return;
    await knex.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await knex.destroy();
  });

  test('sums each asked product\'s booked lines inside the window and nothing else', async () => {
    const spend = await bookedSpendByProduct(knex, [ids.used, ids.second, ids.zero, ids.old], { now });
    expect(Object.fromEntries(spend)).toEqual({
      [ids.used]: 8.5, // 5 + 2.5 + 1; the older $50 line and the text "12.00" line do not count
      [ids.second]: 2.39,
      [ids.zero]: 0, // booked at $0 only: assembleScanSpecs leaves it out
    });
    expect(spend.has(ids.old)).toBe(false);
    expect(spend.has(ids.notAsked)).toBe(false);
  });

  test('no products asked, no query', async () => {
    expect((await bookedSpendByProduct(knex, [], { now })).size).toBe(0);
  });
});
