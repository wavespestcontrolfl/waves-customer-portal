/**
 * Lifetime revenue is paid payments net of refunds plus estimate deposits
 * (services/customer-lifetime-revenue.js), never the stored
 * customers.lifetime_revenue (no writer; it reads $0), against a real migrated
 * PostgreSQL database:
 *   - lifetimeRevenueFor, the admin customer page's figure,
 *   - Intelligence Bar query_customers (value and sort) and get_customer_detail;
 *     the waves-admin MCP serves these same tools,
 *   - the AI chart builder's ai_customers view (migrations 20261103180000 +
 *     20261103200000).
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
  let lifetimeRevenueFor;
  // Letters only, so the tag never matches a phone or address search.
  const tag = `ltv${randomUUID().slice(0, 8).replace(/\d/g, (d) => 'ghijklmnop'[d])}`;
  const ids = { stale: randomUUID(), paid: randomUUID() };
  const estimateIds = { stale: randomUUID(), paid: randomUUID() };
  const phone = () => `+1941${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    db = require('../models/db');
    ({ executeTool } = require('../services/intelligence-bar/tools'));
    ({ lifetimeRevenueFor } = require('../services/customer-lifetime-revenue'));
    await db('customers').insert([
      // The stored figure says 9999; payments 10 + a $99 deposit = 109.
      { id: ids.stale, first_name: 'Orvel', last_name: 'Quandry', phone: phone(), company_name: tag, lifetime_revenue: 9999 },
      // The stored figure says 0; payments 400 + (100 - 30) + deposits 50.42 + 1.42 = 521.84.
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
    await db('estimates').insert([
      { id: estimateIds.stale, customer_id: ids.stale, status: 'accepted' },
      { id: estimateIds.paid, customer_id: ids.paid, status: 'accepted' },
    ]);
    const pi = () => `pi_test_${tag}_${randomUUID().slice(0, 8)}`;
    await db('estimate_deposits').insert([
      // No customer_id on the deposit: it belongs to its estimate's customer.
      { estimate_id: estimateIds.stale, customer_id: null, amount: 99, stripe_payment_intent_id: pi(), status: 'received', received_at: new Date() },
      // Face + card surcharge: 49 + 1.42.
      { estimate_id: estimateIds.paid, customer_id: ids.paid, amount: 49, card_surcharge: 1.42, stripe_payment_intent_id: pi(), status: 'credited', received_at: new Date() },
      // Legacy full refund (refunded_surcharge NULL): the fee is prorated away too, 0.
      { estimate_id: estimateIds.paid, customer_id: ids.paid, amount: 49, card_surcharge: 1.42, refunded_amount: 49, stripe_payment_intent_id: pi(), status: 'refunded', received_at: new Date() },
      // Face-only refund (refunded_surcharge stamped 0): the captured fee stays, 1.42.
      { estimate_id: estimateIds.paid, customer_id: ids.paid, amount: 49, card_surcharge: 1.42, refunded_amount: 49, refunded_surcharge: 0, stripe_payment_intent_id: pi(), status: 'refunded', received_at: new Date() },
      // Never revenue: a deposit that was never received.
      { estimate_id: estimateIds.paid, customer_id: ids.paid, amount: 49, stripe_payment_intent_id: pi(), status: 'pending', received_at: null },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db('estimate_deposits').whereIn('estimate_id', Object.values(estimateIds)).del().catch(() => {});
    await db('estimates').whereIn('id', Object.values(estimateIds)).del().catch(() => {});
    await db('payments').whereIn('customer_id', Object.values(ids)).del().catch(() => {});
    await db('customers').whereIn('id', Object.values(ids)).del().catch(() => {});
    await db.destroy();
  });

  test('lifetimeRevenueFor adds received deposits to the payments net', async () => {
    expect(await lifetimeRevenueFor(db, ids.paid)).toBe(521.84);
    expect(await lifetimeRevenueFor(db, ids.stale)).toBe(109);
  });

  test('get_customer_detail reports payments net + deposits', async () => {
    const paid = await executeTool('get_customer_detail', { customer_id: ids.paid });
    expect(paid.error).toBeUndefined();
    expect(paid.profile.lifetime_revenue).toBe(521.84);
    const stale = await executeTool('get_customer_detail', { customer_id: ids.stale });
    expect(stale.profile.lifetime_revenue).toBe(109);
  });

  test('query_customers returns and sorts by payments net + deposits', async () => {
    const result = await executeTool('query_customers', { search: tag, sort_by: 'lifetime_revenue', sort_dir: 'desc', limit: 10 });
    expect(result.error).toBeUndefined();
    const rows = result.customers.filter((row) => Object.values(ids).includes(row.id));
    expect(rows.map((row) => [row.id, row.lifetime_revenue])).toEqual([[ids.paid, 521.84], [ids.stale, 109]]);
  });

  test('the chart builder view ai_customers reads the same net', async () => {
    const rows = await db('ai_customers').whereIn('id', Object.values(ids)).select('id', 'lifetime_revenue');
    const byId = Object.fromEntries(rows.map((row) => [row.id, Number(row.lifetime_revenue)]));
    expect(byId).toEqual({ [ids.paid]: 521.84, [ids.stale]: 109 });
  });
});
