// planStartBlocker: may the app price, or offer, a NEW residential plan for this customer with nobody watching?
//
// The REAL readers of every plan record, each in the module that owns it, on a fake database that applies no
// filter. A table answers a list of rows, or a function of the filters one read used ([name, ...args] in call
// order). So a case below gives its row ONLY to the read that asks for that shape, as the database would, and
// cannot pass on another read. The SQL itself is proved on real PostgreSQL
// (plan-start-eligibility-postgres.test.js).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// Every read must run on the handle the caller gives: a caller inside a transaction sees its own writes, and no
// read leaves on another connection. So the app's own connection refuses every use in this suite.
jest.mock('../models/db', () => {
  const refuse = () => { throw new Error('a read used the app connection, not the handle the caller gave'); };
  return new Proxy(refuse, { get: (_target, key) => (typeof key === 'symbol' || key === 'then' || key === '__esModule' ? undefined : refuse) });
});

const { planStartBlocker, PLAN_START_BLOCKERS } = require('../services/plan-start-eligibility');
const { TERMINAL_STATUSES } = require('../services/waveguard-existing-services');

const FUTURE = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
const PAST = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);

function fakeDb(tables = {}, { scheduledColumns = {}, tableProbe = null } = {}) {
  const db = (table) => {
    const source = tables[table];
    const calls = [];
    const answer = () => (typeof source === 'function' ? source(calls) : source || []);
    const filter = (name) => (...args) => { calls.push([name, ...args]); return q; };
    const q = {
      where: filter('where'),
      whereNotIn: filter('whereNotIn'),
      whereNull: filter('whereNull'),
      whereNotNull: filter('whereNotNull'),
      orWhereNull: filter('orWhereNull'),
      // The annual-prepay coverage read (coveredTermsAsOf) filters with raw SQL; this fake answers by table.
      whereRaw: filter('whereRaw'),
      leftJoin() { return q; },
      orderBy() { return q; },
      limit() { return q; },
      select() { return answer(); },
      first() { return answer()[0] || null; },
      distinct() { return answer(); },
      pluck(column) { return answer().map((row) => row[column]); },
      columnInfo() {
        // The columns the calendar read asks for. recurring_ongoing is one a test adds: the ongoing-series read
        // asks for it only where it exists.
        return table === 'scheduled_services'
          ? { is_recurring: {}, is_callback: {}, source: {}, followup_included: {}, ...scheduledColumns }
          : {};
      },
    };
    return q;
  };
  db.schema = {
    hasTable: async (name) => (tableProbe ? tableProbe(name) : Object.prototype.hasOwnProperty.call(tables, name)),
  };
  return db;
}

// A live residential account with no plan record of any kind.
const CUSTOMER = (change = {}) => ({
  id: 'cust-1', active: true, deleted_at: null, waveguard_tier: null, monthly_rate: null, property_type: 'single_family', ...change,
});
// `visits`: what the reads of scheduled_services answer (a list, or a function of the filters of one read).
function world({ customer = {}, visits = [], planRates = [], tables = {}, ...options } = {}) {
  return fakeDb({
    customers: customer === null ? [] : [CUSTOMER(customer)],
    scheduled_services: typeof visits === 'function' ? visits : () => visits,
    // The catalog join of the calendar read: no catalog identity here, so a row keeps its own service_type.
    'scheduled_services as s': [],
    customer_plan_rates: planRates,
    ...tables,
  }, options);
}
const blocker = (db) => planStartBlocker(db, 'cust-1');

// Which read of scheduled_services is this? By the filters only that read uses.
const whereHas = (calls, test) => calls.some(([name, filter]) => name === 'where' && filter && typeof filter === 'object' && test(filter));
const isCalendarRead = (calls) => whereHas(calls, (f) => f.is_recurring === true && !('recurring_ongoing' in f));
const isSeriesRead = (calls) => whereHas(calls, (f) => f.recurring_ongoing === true);
const isLegacyRead = (calls) => calls.some(([name, column]) => name === 'whereNull' && column === 'is_recurring');
const onlyFor = (isRead, rows) => (calls) => (isRead(calls) ? rows : []);

const FLAGGED = { id: 'svc-1', service_type: 'Quarterly Pest Control', is_recurring: true, status: 'scheduled', scheduled_date: FUTURE };
const LEGACY = { id: 'legacy-1', is_recurring: null, recurring_parent_id: 'root-1', status: 'confirmed', scheduled_date: FUTURE };
const ROOT = { id: 'root-1', is_recurring: true, recurring_ongoing: true, recurring_parent_id: null, status: 'completed', scheduled_date: PAST };
const ONGOING_COLUMN = { scheduledColumns: { recurring_ongoing: {} } };
const PREPAY_INVOICE = (status) => ({
  annual_prepay_terms: [{ id: 'term-1', prepay_invoice_id: 'inv-1' }], invoices: [{ id: 'inv-1', status }],
});

describe('planStartBlocker', () => {
  test('a live residential account with no plan record: nothing stands against a new plan', async () => {
    expect(await blocker(world())).toBeNull();
    // Also with the ongoing column in the schema and every table there: each read runs and finds nothing.
    expect(await blocker(world({ ...ONGOING_COLUMN, tables: { 'annual_prepay_terms as t': [], annual_prepay_terms: [], invoices: [] } }))).toBeNull();
  });

  test('the reasons it can give, in the order it checks them', () => {
    expect(PLAN_START_BLOCKERS).toEqual(['not_live', 'commercial', 'has_plan']);
  });

  test('a database handle and a customer id are required', async () => {
    await expect(planStartBlocker(null, 'cust-1')).rejects.toThrow('planStartBlocker needs');
    await expect(planStartBlocker(world(), null)).rejects.toThrow('planStartBlocker needs');
  });

  // The plan check cannot answer for these accounts (the calendar read returns no row for an inactive one), so
  // the account itself is the reason, whatever plan record it carries.
  describe('an account that is not live', () => {
    test.each([
      ['no such customer', { customer: null }],
      ['an inactive account', { customer: { active: false } }],
      ['a deleted account', { customer: { deleted_at: '2026-10-01T12:00:00Z' } }],
      ['an inactive member', { customer: { active: false, waveguard_tier: 'Gold' } }],
      ['a deleted account with a plan visit on the calendar', { customer: { deleted_at: '2026-10-01T12:00:00Z' }, visits: [FLAGGED] }],
      ['an inactive commercial account', { customer: { active: false, waveguard_tier: 'Commercial' } }],
    ])('%s: not_live', async (_label, given) => {
      expect(await blocker(world(given))).toBe('not_live');
    });

    test('only active = false is inactive: an account with no active value is live, as the calendar read takes it', async () => {
      expect(await blocker(world({ customer: { active: null } }))).toBeNull();
      expect(await blocker(world({ customer: { active: null }, visits: onlyFor(isCalendarRead, [FLAGGED]) }))).toBe('has_plan');
    });
  });

  // The account-level rule (the 'commercial' tier, or a commercial or business property type) and the pricing
  // engine's own rule for a property type. The membership predicate reads the Commercial tier as "no plan":
  // without this rule a commercial account between visits would read as a home with no plan.
  describe('a commercial account or property', () => {
    test.each([
      ['the Commercial tier and no property type', { waveguard_tier: 'Commercial', property_type: null }],
      ['the commercial tier in another spelling, with a residential property type', { waveguard_tier: ' commercial ', property_type: 'single_family' }],
      ['a business property type', { property_type: 'Business' }],
      ['a commercial property type', { property_type: 'commercial' }],
      // Types only the engine's rule knows.
      ['an office', { property_type: 'office' }],
      ['an apartment complex', { property_type: 'multi_family' }],
      ['a commercial account that also carries a monthly rate', { waveguard_tier: 'Commercial', monthly_rate: 120 }],
    ])('%s: commercial, and no plan record is read', async (_label, customer) => {
      const reads = [];
      const db = world({ ...ONGOING_COLUMN, customer, visits: (calls) => { reads.push(calls); return [FLAGGED]; } });
      expect(await blocker(db)).toBe('commercial');
      expect(reads).toEqual([]);
    });

    test.each([['single_family'], ['condo_ground'], ['unknown'], [null], ['']])('a property type of %j with no tier is not commercial', async (property_type) => {
      expect(await blocker(world({ customer: { property_type } }))).toBeNull();
    });
  });

  // A plan has several records, and one alone is enough: a member can have no recurring visit on the calendar
  // and no named ledger component, and a plan can be a service no offer family names.
  describe('each record of a plan is enough alone', () => {
    test.each([
      ['a tier on the account', { customer: { waveguard_tier: 'Gold' } }],
      ['a legacy monthly rate with no tier', { customer: { monthly_rate: 45 } }],
      ['a monthly rate saved as text', { customer: { monthly_rate: '45.00' } }],
      // The membership predicate reads these tier values as "no plan" and then ignores the rate.
      ['a monthly rate beside the tier value None', { customer: { waveguard_tier: 'None', monthly_rate: 45 } }],
      ['a monthly rate beside the tier value One-Time', { customer: { waveguard_tier: 'One-Time', monthly_rate: 45 } }],
      ['a pest visit that carries the recurring flag', { visits: onlyFor(isCalendarRead, [FLAGGED]) }],
      ['a recurring lawn visit', { visits: onlyFor(isCalendarRead, [{ ...FLAGGED, service_type: 'Lawn Care Program' }]) }],
      // Palm injection maps to no service family. The live recurring row is the plan.
      ['a recurring visit that maps to no service family', { visits: onlyFor(isCalendarRead, [{ ...FLAGGED, service_type: 'Palm Injection' }]) }],
      ['a legacy plan visit (no recurring flag, a recurring parent)', { visits: onlyFor(isLegacyRead, [LEGACY]) }],
      ['an ongoing series with no visit on the calendar', { ...ONGOING_COLUMN, visits: onlyFor(isSeriesRead, [ROOT]) }],
      ['a billed plan rate of a named family', { planRates: [{ family_key: 'lawn_care', monthly_rate: 55 }] }],
      ['a billed plan rate the ledger could not name', { planRates: [{ family_key: 'unattributed', monthly_rate: 45 }] }],
      ['a billed plan rate saved as text', { planRates: [{ family_key: 'pest_control', monthly_rate: '45.00' }] }],
      ['an annual prepay whose paid coverage is live', { tables: { 'annual_prepay_terms as t': [{ id: 'term-1' }] } }],
      ['an annual prepay invoice that is still payable', { tables: PREPAY_INVOICE('sent') }],
    ])('%s: has_plan', async (_label, given) => {
      expect(await blocker(world(given))).toBe('has_plan');
    });

    test.each([
      ['a tier value that names no plan', { customer: { waveguard_tier: 'One-Time' } }],
      ['a monthly rate of zero', { customer: { monthly_rate: 0 } }],
      ['a plan rate of zero', { planRates: [{ family_key: 'unattributed', monthly_rate: 0 }] }],
      ['an annual prepay invoice that was voided', { tables: PREPAY_INVOICE('void') }],
      ['a pending annual prepay term with no invoice row', { tables: { annual_prepay_terms: [{ id: 'term-1', prepay_invoice_id: 'inv-9' }], invoices: [] } }],
    ])('%s is not a plan record', async (_label, given) => {
      expect(await blocker(world(given))).toBeNull();
    });
  });

  // The calendar read answers the rows that carry the recurring flag. One row rule (isLiveObligationRow) decides
  // which of them is a live plan visit.
  describe('a visit that carries the recurring flag', () => {
    const calendar = (row) => world({ visits: onlyFor(isCalendarRead, [row]) });

    test.each([
      ['dated today or later', {}],
      ['in progress now, with a date before today', { status: 'on_site', scheduled_date: PAST }],
      ['on the way now, with a date before today', { status: 'en_route', scheduled_date: PAST }],
    ])('%s is a live plan visit', async (_label, change) => {
      expect(await blocker(calendar({ ...FLAGGED, ...change }))).toBe('has_plan');
    });

    // An included follow-up is the $0 second visit of a one-time job. It rides the job, never a plan, whatever
    // its recurring flag says.
    test.each([
      ['an included follow-up', { followup_included: true }],
      ['an included follow-up in progress now', { followup_included: true, status: 'on_site' }],
      ['a free re-service callback', { is_callback: true }],
      ['a callback on the way now', { is_callback: true, status: 'en_route', scheduled_date: PAST }],
      ['a visit booked from a one-time source', { source: 'estimate-accept' }],
      ['a visit dated before today and not started', { scheduled_date: PAST }],
      ['a cancelled visit dated after today', { status: 'cancelled' }],
    ])('%s is not a live plan visit', async (_label, change) => {
      expect(await blocker(calendar({ ...FLAGGED, ...change }))).toBeNull();
    });
  });

  // A legacy plan visit carries no recurring flag (NULL) and a recurring parent. The calendar read asks for
  // is_recurring = true, so it never returns that row: without a second read, a customer whose only live plan
  // record is that visit would read as a home with no plan.
  describe('a legacy plan visit (no recurring flag, a recurring parent)', () => {
    const legacy = (row) => world({ visits: onlyFor(isLegacyRead, [row]) });

    test('a visit in progress now counts, also when its date is before today', async () => {
      expect(await blocker(legacy({ ...LEGACY, status: 'on_site', scheduled_date: PAST }))).toBe('has_plan');
    });

    test.each([
      ['a free re-service callback', { is_callback: true }],
      ['an included follow-up', { followup_included: true }],
      ['a visit dated before today', { scheduled_date: PAST }],
      ['a visit with no date', { scheduled_date: null }],
      // The calendar read's own exclusions: a visit booked as one-time is not a plan, also while in progress.
      ['a visit booked from a one-time source', { source: 'estimate-accept' }],
      ['a one-time booking in progress now', { source: 'quote-wizard-onetime', status: 'on_site' }],
      ['a callback in progress now', { is_callback: true, status: 'en_route' }],
      ['a cancelled visit dated after today', { status: 'cancelled' }],
      // Rows the read does not ask for. The rule is applied to whatever the read returns.
      ['a row flagged not recurring (a booster)', { is_recurring: false }],
      ['a row with no recurring parent', { recurring_parent_id: null }],
    ])('%s is not a live plan visit', async (_label, change) => {
      expect(await blocker(legacy({ ...LEGACY, ...change }))).toBeNull();
    });

    test('the read asks for the legacy shape among this customer\'s visits that are not over', async () => {
      const reads = [];
      await blocker(world({ visits: (calls) => { reads.push(calls.map((call) => [...call])); return []; } }));
      expect(reads.find(isLegacyRead)).toEqual(expect.arrayContaining([
        ['where', { customer_id: 'cust-1' }],
        ['whereNull', 'is_recurring'],
        ['whereNotNull', 'recurring_parent_id'],
        ['whereNotIn', 'status', TERMINAL_STATUSES],
      ]));
    });
  });

  // An ongoing series BETWEEN visits. Its root says the plan goes on, also on a day with no visit of it on the
  // calendar: the last visit is completed and the next one is not minted yet. Both calendar reads see no live
  // visit then, so the proof also reads the nightly top-up's own selector.
  describe('an ongoing recurring series with no visit on the calendar', () => {
    const ongoingRoots = (rows) => rows.filter((row) => row.is_recurring === true && row.recurring_ongoing === true && row.recurring_parent_id == null);
    const series = (rows, options = ONGOING_COLUMN) => world({ ...options, visits: (calls) => (isSeriesRead(calls) ? ongoingRoots(rows) : []) });

    test.each([
      ['a completed root, no later visit', {}],
      ['a root whose own visit was cancelled while the series goes on', { status: 'cancelled' }],
    ])('%s: has_plan', async (_label, change) => {
      expect(await blocker(series([{ ...ROOT, ...change }]))).toBe('has_plan');
    });

    // A finite series that ran out, and a series a cancel ended, keep no ongoing root.
    test.each([
      ['a completed finite series (the root was never ongoing)', { recurring_ongoing: false }],
      ['a cancelled series (the cancel cleared the flag)', { recurring_ongoing: false, status: 'cancelled' }],
      ['a completed visit of a series that is not its root', { recurring_parent_id: 'root-0' }],
    ])('%s is not a plan record', async (_label, change) => {
      expect(await blocker(series([{ ...ROOT, ...change }]))).toBeNull();
    });

    test("the read is the nightly top-up's own selector, for this customer only", async () => {
      const reads = [];
      await blocker(world({ ...ONGOING_COLUMN, visits: (calls) => { reads.push(calls.map((call) => [...call])); return []; } }));
      expect(reads.find(isSeriesRead)).toEqual([
        ['where', { is_recurring: true, recurring_ongoing: true }],
        ['whereNull', 'recurring_parent_id'],
        ['where', 'customer_id', 'cust-1'],
      ]);
    });

    test('a schema without the column has no ongoing series to read', async () => {
      const reads = [];
      const db = world({ visits: (calls) => { reads.push(calls); return []; } });
      expect(await blocker(db)).toBeNull();
      expect(reads.some(isSeriesRead)).toBe(false);
    });
  });

  // An outage is never "no plan". Each read fails ALONE here, with every other read answering "nothing".
  describe('a failed read throws', () => {
    const failing = (message) => () => { throw new Error(message); };
    const failFor = (isRead, message) => (calls) => { if (isRead(calls)) throw new Error(message); return []; };
    // The nth read of the customers table: the proof's own (1), then the calendar read's (2).
    const customersFailingAt = (n, message) => { let seen = 0; return () => { seen += 1; if (seen === n) throw new Error(message); return [CUSTOMER()]; }; };

    test.each([
      ['the account read', { tables: { customers: customersFailingAt(1, 'account read down') } }, 'account read down'],
      ['the account read of the calendar reader', { tables: { customers: customersFailingAt(2, 'calendar account read down') } }, 'calendar account read down'],
      ['the calendar read', { visits: failFor(isCalendarRead, 'calendar read down') }, 'calendar read down'],
      ['the catalog join of the calendar read', { tables: { 'scheduled_services as s': failing('catalog join down') } }, 'ownership catalog join failed'],
      ['the legacy visit read', { visits: failFor(isLegacyRead, 'legacy read down') }, 'legacy read down'],
      ['the ongoing series read', { ...ONGOING_COLUMN, visits: failFor(isSeriesRead, 'series read down') }, 'series read down'],
      ['the plan-rate ledger read', { planRates: failing('ledger read down') }, 'ledger read down'],
      ['the annual prepay coverage read', { tables: { 'annual_prepay_terms as t': failing('coverage read down') } }, 'coverage read down'],
      ['the pending annual prepay read', { tables: { annual_prepay_terms: failing('pending prepay read down') } }, 'pending prepay read down'],
      ['the invoice read of a pending annual prepay', { tables: { annual_prepay_terms: [{ id: 'term-1', prepay_invoice_id: 'inv-1' }], invoices: failing('invoice read down') } }, 'invoice read down'],
    ])('%s', async (_label, given, message) => {
      await expect(blocker(world(given))).rejects.toThrow(message);
    });

    // With GATE_PLAN_RATE_LEDGER off the ledger answers a failed table probe as "no ledger". A billed rate is
    // evidence of a plan in either mode, so this proof asks for the failure.
    test.each([['off', undefined], ['on', 'true']])('a failed probe of the plan-rate ledger table, with the ledger gate %s', async (_label, gate) => {
      const saved = process.env.GATE_PLAN_RATE_LEDGER;
      if (gate === undefined) delete process.env.GATE_PLAN_RATE_LEDGER; else process.env.GATE_PLAN_RATE_LEDGER = gate;
      try {
        const probe = (name) => { if (name === 'customer_plan_rates') throw new Error('metadata query timeout'); return true; };
        await expect(blocker(world({ tableProbe: probe }))).rejects.toThrow('metadata query timeout');
      } finally {
        if (saved === undefined) delete process.env.GATE_PLAN_RATE_LEDGER; else process.env.GATE_PLAN_RATE_LEDGER = saved;
      }
    });

    test('with the ledger gate off, a database with no ledger table is not a failure', async () => {
      const saved = process.env.GATE_PLAN_RATE_LEDGER;
      delete process.env.GATE_PLAN_RATE_LEDGER;
      try {
        expect(await blocker(world({ tableProbe: (name) => name !== 'customer_plan_rates' }))).toBeNull();
      } finally {
        if (saved !== undefined) process.env.GATE_PLAN_RATE_LEDGER = saved;
      }
    });
  });
});
