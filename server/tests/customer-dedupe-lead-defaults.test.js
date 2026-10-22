/**
 * GATE_MERGE_LEAD_DEFAULTS (dark) — a retired call lead that never had a billing
 * relationship carries autopay_enabled=false only as the intake default. A merge
 * must not copy it onto the real customer's row.
 *
 * Pure unit tests with a table-routed fake knex (no database). The executor round
 * trip runs on real Postgres in customer-dedupe-lead-defaults-postgres.test.js
 * (skipped without DATABASE_URL; CI runs it).
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));

const dedupe = require('../services/customer-dedupe');
const { mergeLeadDefaultsLive } = require('../config/feature-gates');

// A fake knex: database(table) is a chain whose awaited value comes from
// routes[table]. Every builder method returns the chain.
function fakeDb(routes = {}) {
  const queried = [];
  const database = (table) => {
    queried.push(table);
    const q = {};
    for (const m of ['where', 'select']) q[m] = () => q;
    q.first = () => { q._first = true; return q; };
    q.then = (resolve, reject) => Promise.resolve().then(() => {
      const value = routes[table];
      if (value instanceof Error) throw value;
      return q._first ? value : (value === undefined ? [] : value);
    }).then(resolve, reject);
    return q;
  };
  database.queried = queried;
  return database;
}

describe('GATE_MERGE_LEAD_DEFAULTS reader', () => {
  afterEach(() => { delete process.env.GATE_MERGE_LEAD_DEFAULTS; });
  it('is dark unless exactly "true", read at call time', () => {
    expect(mergeLeadDefaultsLive()).toBe(false);
    for (const v of ['1', 'TRUE', 'yes', ' true', 'false', '']) {
      process.env.GATE_MERGE_LEAD_DEFAULTS = v;
      expect(mergeLeadDefaultsLive()).toBe(false);
    }
    process.env.GATE_MERGE_LEAD_DEFAULTS = 'true';
    expect(mergeLeadDefaultsLive()).toBe(true);
  });
});

describe('the merge rules the gate must not touch', () => {
  it('two different Stripe profiles still refuse (no relaxation)', () => {
    expect(dedupe.rowLevelMergeConflict(
      { id: 'w', active: true, stripe_customer_id: 'cus_a' }, { id: 'l', stripe_customer_id: 'cus_b' },
    )).toMatchObject({ code: 'stripe_profile_conflict' });
  });
});

describe('inheritedAutopayRestrictions with a never-billed loser', () => {
  const NOW = Date.parse('2026-10-21T12:00:00Z');
  const winner = { autopay_enabled: true, auto_apply_account_credit: true };
  it('default: the loser autopay=false is inherited (unchanged)', () => {
    expect(dedupe.inheritedAutopayRestrictions(winner, { autopay_enabled: false }, NOW)).toEqual({ autopay_enabled: false });
  });
  it('never-billed loser: autopay=false is NOT inherited', () => {
    expect(dedupe.inheritedAutopayRestrictions(winner, { autopay_enabled: false }, NOW, { loserNeverBilled: true })).toEqual({});
  });
  it('never-billed loser: a live pause and the credit opt-out are still inherited', () => {
    expect(dedupe.inheritedAutopayRestrictions(
      winner,
      { autopay_enabled: false, auto_apply_account_credit: false, autopay_paused_until: '2026-12-01T00:00:00Z', autopay_pause_reason: 'asked' },
      NOW,
      { loserNeverBilled: true },
    )).toEqual({ auto_apply_account_credit: false, autopay_paused_until: '2026-12-01T00:00:00Z', autopay_pause_reason: 'asked' });
  });
});

describe('loserNeverBilled', () => {
  afterEach(() => { delete process.env.GATE_MERGE_LEAD_DEFAULTS; });
  const lead = { id: 'l1', autopay_enabled: false };
  const noBilling = { customers: { autopay_payment_method_id: null }, payment_methods: null, autopay_log: null };

  it('gate off: false, no query', async () => {
    const database = fakeDb(noBilling);
    expect(await dedupe.loserNeverBilled(database, lead)).toBe(false);
    expect(database.queried).toEqual([]);
  });

  describe('gate on', () => {
    beforeEach(() => { process.env.GATE_MERGE_LEAD_DEFAULTS = 'true'; });
    it('no designated card, no card, no autopay log: never billed', async () => {
      expect(await dedupe.loserNeverBilled(fakeDb(noBilling), lead)).toBe(true);
    });
    it.each([
      ['a designated autopay card', { ...noBilling, customers: { autopay_payment_method_id: 'pm1' } }],
      ['a saved card', { ...noBilling, payment_methods: { id: 'pm1' } }],
      ['an autopay log row', { ...noBilling, autopay_log: { id: 'log1' } }],
      ['a missing customer row', { ...noBilling, customers: null }],
      ['an unreadable autopay log', { ...noBilling, autopay_log: new Error('boom') }],
    ])('%s: billed', async (_label, routes) => {
      expect(await dedupe.loserNeverBilled(fakeDb(routes), lead)).toBe(false);
    });
  });
});
