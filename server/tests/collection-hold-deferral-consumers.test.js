/**
 * B10: a monthly dues deferral written under a dispute hold is a payments row
 * with status 'failed' + metadata.deferred_reason 'collection_hold', but
 * Stripe was NEVER contacted. Every consumer that counts unsuperseded failed
 * payments must leave that never-attempted, still-armed row out (one shared
 * predicate), while a row that was really attempted, or disarmed, still counts.
 *
 * The SQL twin runs against real Postgres when REPAIR_TEST_DATABASE_URL is set
 * (local throwaway db); the in-memory predicate and the consumer wiring run
 * everywhere.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knexLib = require('knex');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  isNeverAttemptedHoldDeferral,
  excludeNeverAttemptedHoldDeferrals,
} = require('../services/collections/collection-hold');

const armed = () => new Date();
const holdRow = (over = {}) => ({
  status: 'failed',
  stripe_payment_intent_id: null,
  retry_count: 0,
  next_retry_at: armed(),
  metadata: JSON.stringify({ type: 'monthly_autopay', billed_month: '2026-09', deferred_reason: 'collection_hold' }),
  ...over,
});

describe('isNeverAttemptedHoldDeferral', () => {
  test('matches the armed, never-attempted hold deferral (string or object metadata)', () => {
    expect(isNeverAttemptedHoldDeferral(holdRow())).toBe(true);
    expect(isNeverAttemptedHoldDeferral(holdRow({ metadata: { deferred_reason: 'collection_hold' } }))).toBe(true);
    expect(isNeverAttemptedHoldDeferral(holdRow({ retry_count: null }))).toBe(true);
  });

  test('a real attempt, a disarmed row, or another reason still counts as a failure', () => {
    expect(isNeverAttemptedHoldDeferral(holdRow({ stripe_payment_intent_id: 'pi_synthetic' }))).toBe(false);
    expect(isNeverAttemptedHoldDeferral(holdRow({ retry_count: 1 }))).toBe(false);
    expect(isNeverAttemptedHoldDeferral(holdRow({ next_retry_at: null }))).toBe(false);
    expect(isNeverAttemptedHoldDeferral(holdRow({ metadata: { deferred_reason: 'lock_contention' } }))).toBe(false);
    expect(isNeverAttemptedHoldDeferral(holdRow({ metadata: null }))).toBe(false);
    expect(isNeverAttemptedHoldDeferral(holdRow({ metadata: '{not json' }))).toBe(false);
    expect(isNeverAttemptedHoldDeferral(null)).toBe(false);
  });
});

describe('excludeNeverAttemptedHoldDeferrals', () => {
  test('adds one NULL-safe NOT(...) clause bound to the payments alias', () => {
    const calls = [];
    const qb = { whereRaw: (...a) => { calls.push(a); return qb; } };
    expect(excludeNeverAttemptedHoldDeferrals(qb)).toBe(qb);
    excludeNeverAttemptedHoldDeferrals(qb, 'p');
    expect(calls[0][0]).toContain("COALESCE(payments.metadata->>'deferred_reason', '') = ?");
    expect(calls[0][1]).toEqual(['collection_hold']);
    expect(calls[1][0]).toContain('p.stripe_payment_intent_id IS NULL');
  });
});

describe('every failed-payment consumer applies the shared predicate', () => {
  const root = path.join(__dirname, '..');
  const consumers = [
    ['routes/admin-billing-health.js', 'excludeNeverAttemptedHoldDeferrals'],
    ['services/dashboard-alerts.js', 'excludeNeverAttemptedHoldDeferrals'],
    ['services/lead-scorer.js', 'excludeNeverAttemptedHoldDeferrals'],
    ['services/customer-intelligence/signal-detector.js', 'excludeNeverAttemptedHoldDeferrals'],
    ['services/cancellation-resolution/facts.js', 'excludeNeverAttemptedHoldDeferrals'],
    ['services/bi-agent-tools.js', 'excludeNeverAttemptedHoldDeferrals'],
    ['routes/badges.js', 'isNeverAttemptedHoldDeferral'],
    ['services/context-aggregator.js', 'isNeverAttemptedHoldDeferral'],
    ['services/context-aggregator.js', 'excludeNeverAttemptedHoldDeferrals'],
    ['services/customer-health.js', 'isNeverAttemptedHoldDeferral'],
    ['routes/billing-v2.js', 'isNeverAttemptedHoldDeferral'],
  ];
  test.each(consumers)('%s uses %s', (file, fn) => {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    expect(src).toMatch(new RegExp(`${fn}\\(`));
    expect(src).toContain('collections/collection-hold');
  });

  test('admin billing health applies it to all five failed-row reads (summary + at-risk lists)', () => {
    const src = fs.readFileSync(path.join(root, 'routes/admin-billing-health.js'), 'utf8');
    expect(src.match(/excludeNeverAttemptedHoldDeferrals\(db\('payments'\)/g)).toHaveLength(5);
  });

  test('lead scoring does not dock points for a hold deferral', async () => {
    const db = require('../models/db');
    const calls = [];
    const makeQb = (table, result) => {
      const qb = {};
      for (const m of ['where', 'whereNull', 'whereRaw', 'groupBy', 'select', 'count', 'whereIn', 'update', 'orderBy']) {
        qb[m] = (...args) => { calls.push({ table, m, args }); return qb; };
      }
      qb.first = async () => result;
      qb.then = (res, rej) => Promise.resolve(Array.isArray(result) ? result : []).then(res, rej);
      return qb;
    };
    db.mockImplementation((table) => {
      if (table === 'customers') return makeQb(table, { id: 'c1', waveguard_tier: 'Gold', monthly_rate: 0 });
      if (table === 'payments') return makeQb(table, { count: '0' });
      return makeQb(table, { count: '0' });
    });
    const scorer = require('../services/lead-scorer');
    await scorer.calculateScore('c1');
    const paymentsHold = calls.filter((c) => c.table === 'payments' && c.m === 'whereRaw' && c.args[1]?.[0] === 'collection_hold');
    expect(paymentsHold).toHaveLength(1);
  });
});

describe('payment health score leaves hold deferrals out of the whole sample (codex #5394)', () => {
  test('total, recent and failed all exclude never-attempted hold deferrals; the SQL twin keeps them out of the 24-row fetch', async () => {
    const db = require('../models/db');
    const rawCalls = [];
    let limitArg = null;
    const paid = (i) => ({ id: `p${i}`, status: 'paid', metadata: null, stripe_payment_intent_id: `pi_${i}`, retry_count: 0, next_retry_at: null });
    const deferral = (i) => ({ id: `d${i}`, status: 'failed', metadata: JSON.stringify({ deferred_reason: 'collection_hold' }), stripe_payment_intent_id: null, retry_count: 0, next_retry_at: new Date() });
    // newest first: three held months on top of six real payments
    const rows = [deferral(1), deferral(2), deferral(3), ...[1, 2, 3, 4, 5, 6].map(paid)];
    db.schema = { hasTable: jest.fn(async (t) => t === 'payments') };
    db.mockImplementation(() => {
      const qb = {};
      qb.where = () => qb;
      qb.whereNotNull = () => qb;
      qb.select = () => qb;
      qb.whereRaw = (...a) => { rawCalls.push(a); return qb; };
      qb.orderBy = () => qb;
      // the fake ignores the SQL clause on purpose: the in-memory belt must hold on its own
      qb.limit = (n) => { limitArg = n; return Promise.resolve(rows); };
      return qb;
    });
    const { computePaymentScore } = require('../services/customer-health');
    const { score, details } = await computePaymentScore('c1');
    expect(rawCalls.some((a) => a[1]?.[0] === 'collection_hold')).toBe(true);
    expect(limitArg).toBe(24);
    expect(details.source).toBe('payments');
    expect(details.onTimeRate).toBe(1); // 6 paid / 6 real, not 6 / 9
    expect(details.failedCount).toBe(0);
    expect(score).toBe(100); // 60 base + 30 on-time + 10 six-payment consistency bonus
  });

  test('a real failed payment still counts', async () => {
    const db = require('../models/db');
    const rows = [
      { id: 'f1', status: 'failed', metadata: null, stripe_payment_intent_id: 'pi_f', retry_count: 1, next_retry_at: null },
      { id: 'p1', status: 'paid', metadata: null },
    ];
    db.schema = { hasTable: jest.fn(async (t) => t === 'payments') };
    db.mockImplementation(() => {
      const qb = {};
      for (const m of ['where', 'whereNotNull', 'select', 'whereRaw', 'orderBy']) qb[m] = () => qb;
      qb.limit = () => Promise.resolve(rows);
      return qb;
    });
    const { computePaymentScore } = require('../services/customer-health');
    const { details } = await computePaymentScore('c2');
    expect(details.failedCount).toBe(1);
    expect(details.onTimeRate).toBe(0.5);
  });
});

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
(SKIP ? describe.skip : describe)('excludeNeverAttemptedHoldDeferrals — real Postgres', () => {
  jest.setTimeout(60000);
  let pg;
  let schema;

  beforeAll(async () => {
    const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
      throw new Error('This test requires a local invoice_repair_test or waves_test database');
    }
    schema = `holddefer_${randomUUID().replace(/-/g, '')}`;
    pg = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
    await pg.raw('CREATE SCHEMA ??', [schema]);
    await pg.raw(`CREATE TABLE payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, status text,
      stripe_payment_intent_id text, retry_count int, next_retry_at timestamptz,
      metadata jsonb, superseded_by_payment_id uuid)`);
    const cust = randomUUID();
    const hold = JSON.stringify({ deferred_reason: 'collection_hold' });
    await pg('payments').insert([
      { customer_id: cust, status: 'failed', retry_count: 0, next_retry_at: new Date(), metadata: hold }, // never attempted, armed -> excluded
      { customer_id: cust, status: 'failed', retry_count: 0, next_retry_at: new Date(), metadata: null }, // plain failure
      { customer_id: cust, status: 'failed', retry_count: null, next_retry_at: new Date(), metadata: JSON.stringify({ type: 'x' }) }, // plain failure
      { customer_id: cust, status: 'failed', retry_count: 1, next_retry_at: new Date(), metadata: hold }, // really attempted
      { customer_id: cust, status: 'failed', retry_count: 0, next_retry_at: null, metadata: hold }, // disarmed
      { customer_id: cust, status: 'failed', retry_count: 0, next_retry_at: new Date(), stripe_payment_intent_id: 'pi_synthetic', metadata: hold }, // has a PI
      { customer_id: cust, status: 'failed', retry_count: 0, next_retry_at: new Date(), metadata: JSON.stringify({ deferred_reason: 'lock_contention' }) }, // other reason
    ]);
  });

  afterAll(async () => {
    if (pg) {
      await pg.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
      await pg.destroy();
    }
  });

  test('drops only the armed never-attempted hold deferral', async () => {
    const all = await pg('payments').where({ status: 'failed' }).count('* as n').first();
    const kept = await excludeNeverAttemptedHoldDeferrals(pg('payments').where({ status: 'failed' })).count('* as n').first();
    expect(Number(all.n)).toBe(7);
    expect(Number(kept.n)).toBe(6);
  });

  test('works through an aliased join, as the at-risk lists use it', async () => {
    const rows = await excludeNeverAttemptedHoldDeferrals(pg('payments as p').where('p.status', 'failed'), 'p').select('p.id');
    expect(rows).toHaveLength(6);
  });
});
