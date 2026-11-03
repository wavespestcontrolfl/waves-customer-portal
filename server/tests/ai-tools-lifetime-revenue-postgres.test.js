/**
 * Lifetime revenue in the AI tools is the net of paid payments, never the
 * stored customers.lifetime_revenue (no writer; it reads $0), against a real
 * migrated PostgreSQL database:
 *   - Intelligence Bar query_customers (value and sort) and get_customer_detail;
 *     the waves-admin MCP serves these same tools,
 *   - the AI chart builder's ai_customers view (migration 20261103180000).
 *
 * Synthetic names only. Every row this suite inserts is deleted in afterAll.
 */
const SKIP = !process.env.DATABASE_URL;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('crypto');

jest.setTimeout(120000);

(SKIP ? describe.skip : describe)('AI tools read lifetime revenue from payments', () => {
  let db;
  let executeTool;
  // Letters only, so the tag never matches a phone or address search.
  const tag = `ltv${randomUUID().slice(0, 8).replace(/\d/g, (d) => 'ghijklmnop'[d])}`;
  const ids = { stale: randomUUID(), paid: randomUUID() };
  const phone = () => `+1941${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    db = require('../models/db');
    ({ executeTool } = require('../services/intelligence-bar/tools'));
    await db('customers').insert([
      // The stored figure says 9999; the payments say 10.
      { id: ids.stale, first_name: 'Orvel', last_name: 'Quandry', phone: phone(), company_name: tag, lifetime_revenue: 9999 },
      // The stored figure says 0; the payments say 400 + (100 - 30) = 470.
      { id: ids.paid, first_name: 'Marlo', last_name: 'Quandry', phone: phone(), company_name: tag, lifetime_revenue: 0 },
    ]);
    await db('payments').insert([
      { customer_id: ids.stale, amount: 10, status: 'paid', payment_date: today },
      { customer_id: ids.paid, amount: 400, status: 'paid', payment_date: today },
      { customer_id: ids.paid, amount: 100, refund_amount: 30, status: 'paid', payment_date: today },
      // Never revenue: a refunded and a failed payment.
      { customer_id: ids.paid, amount: 50, status: 'refunded', payment_date: today },
      { customer_id: ids.paid, amount: 75, status: 'failed', payment_date: today },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db('payments').whereIn('customer_id', Object.values(ids)).del().catch(() => {});
    await db('customers').whereIn('id', Object.values(ids)).del().catch(() => {});
    await db.destroy();
  });

  test('get_customer_detail reports the net of paid payments', async () => {
    const paid = await executeTool('get_customer_detail', { customer_id: ids.paid });
    expect(paid.error).toBeUndefined();
    expect(paid.profile.lifetime_revenue).toBe(470);
    const stale = await executeTool('get_customer_detail', { customer_id: ids.stale });
    expect(stale.profile.lifetime_revenue).toBe(10);
  });

  test('query_customers returns and sorts by the net of paid payments', async () => {
    const result = await executeTool('query_customers', { search: tag, sort_by: 'lifetime_revenue', sort_dir: 'desc', limit: 10 });
    expect(result.error).toBeUndefined();
    const rows = result.customers.filter((row) => Object.values(ids).includes(row.id));
    expect(rows.map((row) => [row.id, row.lifetime_revenue])).toEqual([[ids.paid, 470], [ids.stale, 10]]);
  });

  test('the chart builder view ai_customers reads the same net', async () => {
    const rows = await db('ai_customers').whereIn('id', Object.values(ids)).select('id', 'lifetime_revenue');
    const byId = Object.fromEntries(rows.map((row) => [row.id, Number(row.lifetime_revenue)]));
    expect(byId).toEqual({ [ids.paid]: 470, [ids.stale]: 10 });
  });
});
