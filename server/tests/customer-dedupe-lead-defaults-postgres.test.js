/**
 * GATE_MERGE_LEAD_DEFAULTS against live Postgres (skipped without DATABASE_URL;
 * CI runs it): the real executeMerge on synthetic call-lead pairs.
 *
 *  - gate on: a never-billed lead's autopay=false is not inherited
 *  - gate off: it is inherited, as before
 *  - gate on: a loser with a saved card or an autopay log row still passes its
 *    autopay=false on
 *
 * Synthetic names and phones only; every row written is removed.
 */
const { randomUUID } = require('node:crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
jest.setTimeout(120000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const db = require('../models/db');
const dedupe = require('../services/customer-dedupe');

const digits = (n) => String(n).replace(/\d/g, (d) => 'abcdefghij'[d]);
const uniq = () => Math.floor(10000 + Math.random() * 89999);

maybeDescribe('GATE_MERGE_LEAD_DEFAULTS (real executeMerge)', () => {
  const made = [];

  afterEach(() => { delete process.env.GATE_MERGE_LEAD_DEFAULTS; });
  afterAll(async () => {
    const best = async (fn) => { try { await fn(); } catch { /* best effort */ } };
    if (made.length) {
      await best(() => db('customer_merge_journal').where((q) => q.whereIn('winner_customer_id', made).orWhereIn('loser_customer_id', made)).del());
      await best(() => db('customer_duplicate_dismissals').where((q) => q.whereIn('customer_id_a', made).orWhereIn('customer_id_b', made)).del());
      for (const table of ['autopay_log', 'payment_methods']) {
        await best(() => db(table).whereIn('customer_id', made).del());
      }
      await best(() => db('customers').whereIn('id', made).del());
    }
    await db.destroy();
  });

  // A real customer (active, autopay on) and a call lead sharing the phone with
  // the intake default autopay_enabled=false. Neither has a Stripe profile.
  async function leadPair() {
    const first = `Zed${digits(uniq())}`;
    const last = `Leadson${digits(uniq())}`;
    const phone = `+1941${String(uniq()).padStart(3, '0').slice(-3)}${String(uniq()).padStart(4, '0').slice(-4)}`;
    const winnerId = randomUUID();
    const loserId = randomUUID();
    made.push(winnerId, loserId);
    await db('customers').insert({
      id: winnerId, first_name: first, last_name: last, phone, pipeline_stage: 'active_customer', active: true,
      created_at: '2026-01-01T00:00:00Z', autopay_enabled: true,
    });
    await db('customers').insert({
      id: loserId, first_name: first, last_name: last, phone, pipeline_stage: 'new_lead', active: true,
      created_at: '2026-10-20T00:00:00Z', autopay_enabled: false,
    });
    return { winnerId, loserId };
  }
  const merge = (winnerId, loserId) => dedupe.executeMerge({
    winnerId, loserId, mode: 'manual', performedBy: 'test:lead-defaults', evidence: { via: 'test' },
  });
  const row = (id) => db('customers').where({ id }).first();

  test('gate on: a never-billed lead\'s autopay=false is not inherited', async () => {
    process.env.GATE_MERGE_LEAD_DEFAULTS = 'true';
    const { winnerId, loserId } = await leadPair();
    await merge(winnerId, loserId);
    expect((await row(winnerId)).autopay_enabled).toBe(true);
    expect((await row(loserId)).deleted_at).not.toBeNull();
  });

  test('gate off: the same lead\'s autopay=false is still inherited', async () => {
    const { winnerId, loserId } = await leadPair();
    await merge(winnerId, loserId);
    expect((await row(winnerId)).autopay_enabled).toBe(false);
  });

  test('gate on: a loser with a saved card and autopay=false still passes its opt-out on', async () => {
    process.env.GATE_MERGE_LEAD_DEFAULTS = 'true';
    const { winnerId, loserId } = await leadPair();
    await db('payment_methods').insert({
      customer_id: loserId, card_brand: 'visa', last_four: '4242', exp_month: '12', exp_year: '2030',
      stripe_payment_method_id: `pm_syn_${randomUUID()}`,
    });
    await merge(winnerId, loserId);
    expect((await row(winnerId)).autopay_enabled).toBe(false);
  });

  test('gate on: a loser with an autopay log row (no card) still passes its opt-out on', async () => {
    process.env.GATE_MERGE_LEAD_DEFAULTS = 'true';
    const { winnerId, loserId } = await leadPair();
    await db('autopay_log').insert({ customer_id: loserId, event_type: 'autopay_disabled' });
    await merge(winnerId, loserId);
    expect((await row(winnerId)).autopay_enabled).toBe(false);
  });

  test('gate on: the undo still works after an autopay-skipping merge', async () => {
    process.env.GATE_MERGE_LEAD_DEFAULTS = 'true';
    const { winnerId, loserId } = await leadPair();
    const result = await merge(winnerId, loserId);
    await dedupe.revertMerge({ journalId: result.journalId, performedBy: 'test:undo', performedById: null });
    expect((await row(loserId)).deleted_at).toBeNull();
    expect((await row(winnerId)).autopay_enabled).toBe(true);
  });
});
