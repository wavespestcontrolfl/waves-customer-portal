/**
 * GATE_MERGE_LEAD_DEFAULTS (dark) — a retired call lead's autopay_enabled=false is
 * the intake default, not a customer decision, so a merge must not copy it onto
 * the real customer's row. Only a row that is POSITIVELY an intake lead counts:
 * a customer restored after archival has autopay disarmed on purpose and may hold
 * no billing rows, so absent rows alone must not read as "lead".
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
    for (const m of ['where', 'whereIn', 'select']) q[m] = () => q;
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

describe('inheritedAutopayRestrictions with an intake-lead loser', () => {
  const NOW = Date.parse('2026-10-21T12:00:00Z');
  const winner = { autopay_enabled: true, auto_apply_account_credit: true };
  it('default: the loser autopay=false is inherited (unchanged)', () => {
    expect(dedupe.inheritedAutopayRestrictions(winner, { autopay_enabled: false }, NOW)).toEqual({ autopay_enabled: false });
  });
  it('intake-lead loser: autopay=false is NOT inherited', () => {
    expect(dedupe.inheritedAutopayRestrictions(winner, { autopay_enabled: false }, NOW, { loserIntakeLead: true })).toEqual({});
  });
  it('intake-lead loser: auto_apply_account_credit=false (the column default) is NOT inherited either', () => {
    expect(dedupe.inheritedAutopayRestrictions(winner, { auto_apply_account_credit: false }, NOW)).toEqual({ auto_apply_account_credit: false });
    expect(dedupe.inheritedAutopayRestrictions(winner, { auto_apply_account_credit: false }, NOW, { loserIntakeLead: true })).toEqual({});
  });
  it('intake-lead loser: a live pause is still inherited', () => {
    expect(dedupe.inheritedAutopayRestrictions(
      winner,
      { autopay_enabled: false, auto_apply_account_credit: false, autopay_paused_until: '2026-12-01T00:00:00Z', autopay_pause_reason: 'asked' },
      NOW,
      { loserIntakeLead: true },
    )).toEqual({ autopay_paused_until: '2026-12-01T00:00:00Z', autopay_pause_reason: 'asked' });
  });
});

describe('loserIsIntakeLead', () => {
  afterEach(() => { delete process.env.GATE_MERGE_LEAD_DEFAULTS; });
  const lead = { id: 'l1', autopay_enabled: false };
  const customerRow = {
    pipeline_stage: 'new_lead', churned_at: null, churn_episode_id: null, member_since: null, total_services: 0, autopay_payment_method_id: null,
  };
  const plainLead = { customers: customerRow, audit_log: undefined, payment_methods: undefined, autopay_log: undefined };
  const withRow = (over) => ({ ...plainLead, customers: { ...customerRow, ...over } });

  it('gate off: false, no query', async () => {
    const database = fakeDb(plainLead);
    expect(await dedupe.loserIsIntakeLead(database, lead)).toBe(false);
    expect(database.queried).toEqual([]);
  });

  describe('gate on', () => {
    beforeEach(() => { process.env.GATE_MERGE_LEAD_DEFAULTS = 'true'; });

    it.each(['new_lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'follow_up', 'negotiating'])(
      'a plain call lead at %s: an intake lead', async (stage) => {
        expect(await dedupe.loserIsIntakeLead(fakeDb(withRow({ pipeline_stage: stage })), lead)).toBe(true);
      },
    );
    it('an assessment-only lead (by name, in any case/spacing) is still an intake lead', async () => {
      const visits = [{ id: 'v1', service_type: 'Waves Assessment' }, { id: 'v2', service_type: '  waves assessment ' }];
      expect(await dedupe.loserIsIntakeLead(fakeDb({ ...plainLead, scheduled_services: visits }), lead)).toBe(true);
    });
    it('an assessment identified only by its catalog row (lawn_inspection) is still an intake lead', async () => {
      const database = fakeDb({
        ...plainLead,
        scheduled_services: [{ id: 'v1', service_type: 'Visit', service_id: 's1' }],
        services: { id: 's1', service_key: 'lawn_inspection', name: 'Something' },
      });
      expect(await dedupe.loserIsIntakeLead(database, lead)).toBe(true);
    });
    it('a total_services of null counts as none', async () => {
      expect(await dedupe.loserIsIntakeLead(fakeDb(withRow({ total_services: null })), lead)).toBe(true);
    });

    it.each(['active_customer', 'won', 'at_risk', 'churned', 'past_customer', 'dormant', 'lost', null, 'something_new'])(
      'stage %s: not an intake lead', async (stage) => {
        expect(await dedupe.loserIsIntakeLead(fakeDb(withRow({ pipeline_stage: stage })), lead)).toBe(false);
      },
    );

    it.each([
      ['churned_at', { churned_at: '2026-01-01' }],
      ['churn_episode_id', { churn_episode_id: 'ep1' }],
      ['member_since', { member_since: '2025-06-01' }],
      ['completed services', { total_services: 3 }],
      ['a designated autopay card', { autopay_payment_method_id: 'pm1' }],
    ])('a lead row with %s: not an intake lead', async (_label, over) => {
      expect(await dedupe.loserIsIntakeLead(fakeDb(withRow(over)), lead)).toBe(false);
    });

    it.each([
      ['an archive audit row', { audit_log: { id: 'a1' } }],
      ['a restore audit row (a restored customer with disarmed autopay and no billing rows)', { audit_log: { id: 'a2' } }],
      ['a saved card', { payment_methods: { id: 'pm1' } }],
      ['an autopay log row', { autopay_log: { id: 'log1' } }],
      ['a regular scheduled visit (any status, new_lead stage)', { scheduled_services: [{ id: 'v1', service_type: 'Pest Control', service_id: null }] }],
      ['an assessment plus a regular visit', { scheduled_services: [{ id: 'v1', service_type: 'Waves Assessment' }, { id: 'v2', service_type: 'Lawn Care' }] }],
      ['an assessment that produced an invoice', { scheduled_services: [{ id: 'v1', service_type: 'Waves Assessment' }], invoices: { id: 'inv1' } }],
      ['a visit whose catalog row is not the assessment', { scheduled_services: [{ id: 'v1', service_type: 'Visit', service_id: 's1' }], services: { id: 's1', service_key: 'pest_quarterly', name: 'Quarterly Pest' } }],
      ['a service record', { service_records: { id: 'sr1' } }],
      ['an invoice', { invoices: { id: 'inv1' } }],
      // Codex #6421 r9: every AUTO_BLOCKER_TABLES table is history, not a hand-picked few.
      ['a standalone payment with no invoice', { payments: { customer_id: 'lead-1' } }],
      ['a contract', { customer_contracts: { customer_id: 'lead-1' } }],
      ['an estimate deposit', { estimate_deposits: { customer_id: 'lead-1' } }],
      ['a credit ledger row', { customer_credit_ledger: { id: 'cl1' } }],
    ])('%s: not an intake lead', async (_label, over) => {
      expect(await dedupe.loserIsIntakeLead(fakeDb({ ...plainLead, ...over }), lead)).toBe(false);
    });

    it.each([
      ['a missing customer row', { customers: null }],
      ['an unreadable audit log', { audit_log: new Error('boom') }],
      ['an unreadable autopay log', { autopay_log: new Error('boom') }],
      ['an unreadable visit table', { scheduled_services: new Error('boom') }],
      ['an unreadable invoice table', { invoices: new Error('boom') }],
      ['an unreadable customers read', { customers: new Error('boom') }],
    ])('%s: fails closed', async (_label, over) => {
      expect(await dedupe.loserIsIntakeLead(fakeDb({ ...plainLead, ...over }), lead)).toBe(false);
    });
  });
});
