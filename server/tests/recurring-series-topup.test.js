/**
 * Nightly recurring-series top-up (routes/admin-schedule.js's
 * topUpRecurringSeriesLocked / topUpRecurringSeries, and the sweep wrapper
 * in services/recurring-series-topup.js).
 *
 * The completion-time auto-extend (runRecurringSeriesMaintenance) only fires
 * on COMPLETED visits and only ever adds one — an ongoing plan whose visits
 * stay on_site/unclosed never re-triggers it. This suite drives the
 * extracted horizon-fill loop directly with a scripted fake connection
 * (house style — see recurring-series-maintenance.test.js), so it exercises
 * the SAME extendSeriesOnceLocked insert step the completion path uses.
 *
 * v1 scope cut (Codex GitHub rounds 2-3): top-up never touches an
 * annual-prepay series at all (see topupSeriesSkipReason's own comment in
 * admin-schedule.js) — the customer-wide term_end cap this lane originally
 * shipped with kept landing findings on a fresh site every round. No
 * annual-prepay-renewals mocking is needed here as a result: every fixture
 * in this suite is a plain per-visit/CIOC/dues series, so
 * applyExtensionPrepayCoverage's own term discovery always finds nothing
 * (seriesTermIds resolves empty and coveringTermForDate short-circuits
 * before ever calling into that module) — a real, unmocked deep-cover of
 * exactly the "not a prepay series" path v1 relies on.
 */
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async () => ({ synthesized: true, billingType: null })),
}));
jest.mock('../services/appointment-reminders', () => ({
  registerAppointment: jest.fn().mockResolvedValue(undefined),
  resolveCommittedVisitTime: jest.fn(async () => null),
  alertRegistrationFailure: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/scheduling/occupancy', () => ({
  // acquireOccupancyLock/acquireOccupancyLocks are real (pure lock-key
  // helpers other writers use, untouched by topUp) — only the DB-backed
  // conflict probe is mocked, so a test can inspect exactly which window it
  // was asked to check without needing the fake connection to model
  // findConflictingVisits' own SQL shape.
  ...jest.requireActual('../services/scheduling/occupancy'),
  findConflictingVisits: jest.fn(),
}));
// isFamilyOnPlanHold (Codex GitHub r6 P1) reuses cancellation-processor.js's
// own familyOfServiceRow — mocked here so this suite's tests control which
// family a fixture resolves to directly, rather than depending on (and
// re-testing) that module's own service_type/service_key text heuristics,
// which have their own dedicated coverage elsewhere.
jest.mock('../services/cancellation-processor', () => ({
  ...jest.requireActual('../services/cancellation-processor'),
  familyOfServiceRow: jest.fn(() => null),
}));

const adminScheduleRouter = require('../routes/admin-schedule');
const {
  topUpRecurringSeriesLocked, topUpRecurringSeries, topUpRecurringSeriesWithLocks, TOPUP_MAX_INSERTS_PER_SERIES_PER_RUN,
} = adminScheduleRouter._test;
const AppointmentReminders = require('../services/appointment-reminders');
const { findConflictingVisits } = require('../services/scheduling/occupancy');
const { familyOfServiceRow } = require('../services/cancellation-processor');
const { ACTIVE_STATUSES, PAYMENT_PENDING_STATUS } = require('../services/annual-prepay-renewals');
const { ANNUAL_PREPAY_METHOD } = require('../services/prepaid-series');
beforeEach(() => {
  findConflictingVisits.mockReset().mockResolvedValue([]);
  // Default: no family at all (matches every fixture that never sets
  // stampedAnnualTermId/stampedPrepaidMethod's own family concerns) — a
  // series with no resolvable WaveGuard family can never be plan-held.
  familyOfServiceRow.mockReset().mockReturnValue(null);
});
const { AUTO_CLEARABLE_REASON } = require('../services/billing-pause');
const { etDateString } = require('../utils/datetime-et');

function daysOut(n) {
  const d = new Date(`${etDateString()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const BASE_COLS = {
  recurring_ongoing: {}, skip_weekends: {}, weekend_shift: {}, service_id: {},
  create_invoice_on_complete: {}, is_callback: {}, discount_dollars: {},
  payer_id: {}, po_number: {}, self_pay_override: {},
  property_id: {}, service_address_line1: {}, service_address_line2: {},
  service_address_city: {}, service_address_state: {}, service_address_zip: {},
  lat: {}, lng: {}, service_key_snapshot: {}, appointment_type: {},
};

// Scriptable fake knex connection — same shape/conventions as
// recurring-series-maintenance.test.js's makeConn.
function makeConn(handler, opts = {}) {
  const buildTable = (table) => {
    const calls = [];
    const b = {};
    const record = (name) => (...args) => {
      if ((name === 'where' || name === 'whereNotExists') && typeof args[0] === 'function') {
        const nested = [];
        const sub = {};
        for (const nm of ['where', 'orWhere', 'whereIn', 'whereNull', 'whereNotNull', 'orWhereNull', 'orWhereNot', 'whereRaw', 'orWhereRaw', 'orWhereNotIn', 'orWhereNotNull']) {
          sub[nm] = (...a) => { nested.push([nm, ...a]); return sub; };
        }
        args[0].call(sub, sub);
        calls.push(['whereFn', nested]);
      } else {
        calls.push([name, ...args]);
      }
      return b;
    };
    for (const m of ['where', 'orWhere', 'whereIn', 'whereNotIn', 'whereBetween', 'whereNull', 'whereNotNull', 'whereNot', 'whereRaw', 'orWhereRaw', 'orderBy', 'count', 'select', 'del', 'update', 'limit', 'forShare', 'forUpdate', 'distinct', 'andWhere']) {
      b[m] = record(m);
    }
    b.modify = (fn) => { fn(b); return b; };
    b.first = (...args) => {
      calls.push(['first', ...args]);
      return Promise.resolve(handler({ table, calls, op: 'first' }));
    };
    b.pluck = (field) => {
      calls.push(['pluck', field]);
      return Promise.resolve(handler({ table, calls, op: 'pluck', field }));
    };
    b.columnInfo = () => Promise.resolve(handler({ table, calls, op: 'columnInfo' }));
    b.insert = (data) => {
      calls.push(['insert', data]);
      return {
        returning: () => Promise.resolve(handler({ table, calls, op: 'insertReturning', data })),
        then: (res, rej) => Promise.resolve(handler({ table, calls, op: 'insert', data })).then(res, rej),
      };
    };
    b.then = (res, rej) => Promise.resolve(handler({ table, calls, op: 'await' })).then(res, rej);
    return b;
  };
  const build = (isTransaction) => {
    const fn = (table) => buildTable(table);
    fn.isTransaction = isTransaction;
    // Answers the maintenance/comms advisory-lock SELECTs (ignored, no
    // return value needed) AND the annual-prepay try-lock probe
    // (pg_try_advisory_xact_lock) — a real Postgres always "gets" an
    // uncontended lock, so every scenario in this suite defaults to a
    // successful try-lock unless a test overrides `conn.raw` itself (see
    // the dedicated 'annual_prepay_busy' tests below).
    fn.raw = () => Promise.resolve({ rows: [{ locked: true }] });
    fn.fn = { now: () => new Date() };
    fn.transaction = (cb) => {
      const exec = () => Promise.resolve().then(() => cb(build(true)));
      if (!opts.mutex || isTransaction) return exec();
      const prev = opts.mutex.tail || Promise.resolve();
      let release;
      opts.mutex.tail = new Promise((r) => { release = r; });
      return prev.then(exec).finally(() => release());
    };
    return fn;
  };
  return build(false);
}

// A stateful ongoing-series fixture: `seriesDates` grows with every insert,
// so a repeated topUpRecurringSeriesLocked loop sees its own prior inserts
// as the new "latest" on the next iteration — the real anchor-chaining
// behavior extendSeriesOnceLocked relies on.
//
// `stampedAnnualTermId` / `stampedPrepaidMethod` / `customerLiveTerm`:
// control isAnnualPrepaySeries' two DB probes (a stamped scheduled_services
// row anywhere in the series — annual_prepay_term_id set, and/or
// prepaid_method set to a specific value, evaluated the SAME way the
// production query's own conditional OR does; any live/undecided
// annual_prepay_terms row for the customer) — all default to "no prepay
// footprint" so every OTHER describe block's fixtures are unaffected by
// the v1 scope cut. `activeHold`: whether a plan_holds row matching
// isFamilyOnPlanHold's own query (customer/family/status='active'/
// resume_on > today) exists — the family itself is controlled per-test via
// the mocked familyOfServiceRow (cancellation-processor.js), not this flag.
function topupScenario({
  parentOverrides = {}, customerOverrides = {}, seriesDates: initialDates = [daysOut(0)],
  colsOverrides = {}, stampedAnnualTermId = false, stampedPrepaidMethod = null, customerLiveTerm = false,
  captureCustomerCalls = null, activeHold = false,
} = {}) {
  const parent = {
    id: 10, customer_id: 5, is_recurring: true, recurring_pattern: 'weekly',
    recurring_ongoing: true, scheduled_date: daysOut(0),
    window_start: '08:00', window_end: '10:00',
    service_type: 'Weekly Pest Control', time_window: 'morning', zone: 'A',
    estimated_duration_minutes: 60, skip_weekends: false,
    // Billable by default (create_invoice_on_complete + a real price) so
    // the horizon/cap/eligibility tests below aren't incidentally tripped
    // by topUpRecurringSeriesLocked's own billable-amount gate
    // (seriesExtensionUnbillable) — that gate has its own dedicated tests
    // further down; an override can still set either back to unbillable.
    create_invoice_on_complete: true, estimated_price: '150.00',
    ...parentOverrides,
  };
  const customer = {
    id: 5, active: true, deleted_at: null, service_paused_at: null, pipeline_stage: 'active_customer',
    ...customerOverrides,
  };
  const cols = { ...BASE_COLS, ...colsOverrides };
  // Mirrors isAnnualPrepaySeries' own conditional-OR exactly: a column the
  // schema doesn't have can never contribute a match, and prepaid_method
  // only counts when it's the annual writer's OWN method — an ordinary
  // cash/Zelle stamp must not (Codex GitHub r6 P1).
  const seriesHasAnnualStamp = (!!cols.annual_prepay_term_id && stampedAnnualTermId)
    || (!!cols.prepaid_method && stampedPrepaidMethod === ANNUAL_PREPAY_METHOD);
  const seriesDates = new Set(initialDates);
  const inserted = [];
  const insertedById = new Map();
  let nextId = 900;
  const handler = ({ table, calls, op, data }) => {
    if (table === 'scheduled_services') {
      if (op === 'columnInfo') return cols;
      if (op === 'pluck') return []; // seriesTermIds' own-series scan — no prepay fixture in this suite links one
      if (op === 'first') {
        const firstCall = calls.find((c) => c[0] === 'first');
        if (firstCall[1] === 'recurring_ongoing') return { recurring_ongoing: parent.recurring_ongoing };
        if (firstCall[1] === 'customer_id') return { customer_id: parent.customer_id };
        if (firstCall[1] === 'status') return { status: 'pending' };
        if (firstCall[1] === 'id' && calls.some((c) => c[0] === 'whereFn')) {
          // isAnnualPrepaySeries' own stamped-row probe (root or any child
          // carries annual_prepay_term_id, or prepaid_method equal to the
          // annual writer's own method) — a combined recurring_parent_id-or-
          // id + stamped predicate, so it never matches the plain-object
          // where() branch below.
          return seriesHasAnnualStamp ? { id: 'stamped-row' } : undefined;
        }
        if (calls.some((c) => c[0] === 'orderBy')) {
          if (!seriesDates.size) return undefined;
          const latest = [...seriesDates].sort().slice(-1)[0];
          return { scheduled_date: latest };
        }
        const whereCall = calls.find((c) => c[0] === 'where' && c[1] && typeof c[1] === 'object' && 'id' in c[1]);
        if (whereCall) {
          if (whereCall[1].id === parent.id) return parent;
          // A freshly-inserted row's own id (e.g. a spawned-reminder
          // terminal recheck) — tracked separately from `parent` so a plain
          // bare `.first()` by id returns the actual row, not a stale copy
          // of the parent.
          return insertedById.get(whereCall[1].id);
        }
        return parent;
      }
      if (op === 'await') {
        if (calls.some((c) => c[0] === 'del')) {
          // A row-scoped compensating delete (post-insert cancellation
          // re-check) — remove it from both the id map and the audit array
          // so an assertion checking `inserted` correctly reflects the
          // rollback instead of still showing a row this same call deleted.
          const whereCall = calls.find((c) => c[0] === 'where' && c[1] && typeof c[1] === 'object' && 'id' in c[1]);
          const targetId = whereCall?.[1]?.id;
          if (targetId != null && insertedById.has(targetId)) {
            insertedById.delete(targetId);
            const idx = inserted.findIndex((r) => r.id === targetId);
            if (idx >= 0) inserted.splice(idx, 1);
            return 1;
          }
          return 0;
        }
        if (calls.some((c) => c[0] === 'whereRaw')) return []; // global occupancy probe — never clashes here
        if (calls.some((c) => c[0] === 'select' && c[1] === 'scheduled_date')) {
          return [...seriesDates].map((scheduled_date) => ({ scheduled_date }));
        }
        return [];
      }
      if (op === 'insertReturning') {
        const id = ++nextId;
        const row = { id, ...data };
        inserted.push(row);
        insertedById.set(id, row);
        seriesDates.add(data.scheduled_date);
        return [row];
      }
      if (op === 'insert') { inserted.push(data); seriesDates.add(data.scheduled_date); return [1]; }
    }
    if (table === 'scheduled_service_addons') {
      if (op === 'columnInfo') return {};
      return [];
    }
    if (table === 'customers') {
      if (op === 'first') {
        if (captureCustomerCalls) captureCustomerCalls.push(calls);
        return customer;
      }
    }
    if (table === 'annual_prepay_terms') {
      // isAnnualPrepaySeries' customer-wide live/undecided-term probe.
      if (op === 'first') return customerLiveTerm ? { id: 'live-term' } : undefined;
    }
    if (table === 'services') {
      // isFamilyOnPlanHold's service_key/name lookup — irrelevant to the
      // result since familyOfServiceRow itself is mocked per-test; any
      // shape is fine here.
      if (op === 'first') return {};
    }
    if (table === 'plan_holds') {
      // isFamilyOnPlanHold's own active-hold probe. The family actually
      // queried is whatever the mocked familyOfServiceRow returned for this
      // test — `activeHold` says whether a row matching customer/family/
      // status='active'/resume_on>today exists at all.
      if (op === 'first') return activeHold ? { id: 'hold-1' } : undefined;
    }
    if (table === 'system_settings') return null;
    if (table === 'schedule_blackout_dates') return [];
    return null;
  };
  return { conn: makeConn(handler), inserted, parent, customer, seriesDates };
}

describe('topUpRecurringSeriesLocked — eligibility', () => {
  test('skips a non-ongoing parent', async () => {
    const { conn, inserted } = topupScenario({ parentOverrides: { recurring_ongoing: false } });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBe('not_ongoing');
    expect(inserted).toHaveLength(0);
  });

  test('skips a child id — only a series root may be topped up', async () => {
    // A mistaken --parent <child uuid> would otherwise spawn grandchildren
    // pointing at the child, outside the root's cancel/maintenance scope.
    const { conn, inserted } = topupScenario({ parentOverrides: { recurring_parent_id: 5 } });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBe('not_series_root');
    expect(inserted).toHaveLength(0);
  });

  test('skips a non-recurring / no-pattern parent', async () => {
    const { conn } = topupScenario({ parentOverrides: { recurring_pattern: null } });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBe('not_recurring');
  });

  test('skips a churned customer', async () => {
    const { conn, inserted } = topupScenario({ customerOverrides: { pipeline_stage: 'churned' } });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBe('customer_churned');
    expect(inserted).toHaveLength(0);
  });

  test('skips a past_customer / dormant stage too (FORMER_CUSTOMER_STAGES)', async () => {
    for (const stage of ['past_customer', 'dormant']) {
      const { conn } = topupScenario({ customerOverrides: { pipeline_stage: stage } });
      const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
      expect(result.skipped).toBe('customer_churned');
    }
  });

  test('skips a customer under a genuine service hold (a hand-set pause, any reason other than the billing-only one)', async () => {
    const { conn, inserted } = topupScenario({
      customerOverrides: { service_paused_at: new Date(), service_pause_reason: 'owner_pause' },
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBe('customer_service_held');
    expect(inserted).toHaveLength(0);
  });

  test('skips a paused customer with no legible reason too (fail closed on an unknown pause)', async () => {
    const { conn, inserted } = topupScenario({
      customerOverrides: { service_paused_at: new Date(), service_pause_reason: null },
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBe('customer_service_held');
    expect(inserted).toHaveLength(0);
  });

  test('does NOT skip a billing-only autopay pause — dues stop, visits (and top-up) continue', async () => {
    // Migration 20260801200000 (billing-copy-no-false-interruption):
    // service_paused_at with reason AUTO_CLEARABLE_REASON stops only the
    // dues cron; it has no scheduling consumer anywhere in the app.
    const { conn, inserted } = topupScenario({
      customerOverrides: { service_paused_at: new Date(), service_pause_reason: AUTO_CLEARABLE_REASON },
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(result.skipped).toBeNull();
    expect(inserted.length).toBeGreaterThan(0);
  });

  test('skips a deleted customer', async () => {
    const { conn } = topupScenario({ customerOverrides: { deleted_at: new Date() } });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBe('customer_deleted');
  });

  test('skips an explicitly inactive customer', async () => {
    const { conn } = topupScenario({ customerOverrides: { active: false } });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBe('customer_inactive');
  });

  test('skips a not-found parent', async () => {
    const { conn } = topupScenario();
    const result = await topUpRecurringSeriesLocked(conn, 999, { horizonDays: 365 });
    expect(result.skipped).toBe('not_found');
  });

  test('reads the customer row FOR UPDATE — the same lock PUT /:id/stage takes (Codex GitHub r3 P1)', async () => {
    const customerCalls = [];
    const { conn } = topupScenario({ seriesDates: [daysOut(0)], captureCustomerCalls: customerCalls });
    await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(customerCalls.length).toBeGreaterThan(0);
    expect(customerCalls[0].some((c) => c[0] === 'forUpdate')).toBe(true);
  });
});

describe('topUpRecurringSeriesLocked — annual-prepay scope cut v1 (Codex GitHub rounds 2-3)', () => {
  // The customer-wide, service-matched term_end cap this lane originally
  // shipped with kept landing findings on a fresh site every round —
  // structural. v1 excludes the series outright instead: a prepay
  // customer's covered rows are already seeded at term activation
  // (ensureCoverageRowsForTerm), so top-up simply never touches one.
  test('skips a series whose root or any child row already carries a prepay stamp (annual_prepay_term_id)', async () => {
    const { conn, inserted } = topupScenario({
      colsOverrides: { annual_prepay_term_id: {} },
      stampedAnnualTermId: true,
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBe('annual_prepay_series');
    expect(inserted).toHaveLength(0);
  });

  test('skips on an ANNUAL prepaid_method stamp too, on a schema without annual_prepay_term_id', async () => {
    const { conn, inserted } = topupScenario({
      colsOverrides: { prepaid_method: {} },
      stampedPrepaidMethod: ANNUAL_PREPAY_METHOD,
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBe('annual_prepay_series');
    expect(inserted).toHaveLength(0);
  });

  test('does NOT exclude on an ordinary cash/Zelle prepaid_method stamp — only the annual writer\'s own method counts (Codex GitHub r6 P1)', async () => {
    // The pre-fix version matched ANY non-null prepaid_method, so a single
    // manual cash/Zelle stamp on one visit (POST /api/admin/schedule/:id/
    // prepaid) would have marked the WHOLE family annual forever.
    const { conn, inserted } = topupScenario({
      colsOverrides: { prepaid_method: {} },
      stampedPrepaidMethod: 'cash',
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(result.skipped).toBeNull();
    expect(inserted.length).toBeGreaterThan(0);
  });

  test('skips a series whose customer holds ANY live/undecided annual_prepay_terms row, even with no scheduled_services link at all', async () => {
    // No annual_prepay_term_id/prepaid_method column even in scope — the
    // customer-level check runs independently of the series-level one.
    const { conn, inserted } = topupScenario({ customerLiveTerm: true });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBe('annual_prepay_series');
    expect(inserted).toHaveLength(0);
  });

  test('queries the exact live/undecided status vocabulary — reused from annual-prepay-renewals.js, never a second hand-picked list', async () => {
    const capturedCalls = [];
    const { customer, parent } = topupScenario();
    const conn = makeConn(({ table, calls, op }) => {
      if (table === 'scheduled_services' && op === 'columnInfo') return BASE_COLS;
      if (table === 'scheduled_services' && op === 'first') {
        const firstCall = calls.find((c) => c[0] === 'first');
        if (!firstCall[1]) return parent;
        return null;
      }
      if (table === 'customers' && op === 'first') return customer;
      if (table === 'annual_prepay_terms') {
        if (op === 'first') { capturedCalls.push(calls); return undefined; }
      }
      return null;
    });
    await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(capturedCalls).toHaveLength(1);
    const coveringFn = capturedCalls[0].find((c) => c[0] === 'whereFn');
    expect(coveringFn).toBeDefined();
    const nested = coveringFn[1];
    const whereInCall = nested.find((c) => c[0] === 'whereIn');
    expect(whereInCall).toBeDefined();
    expect(whereInCall[2].slice().sort()).toEqual([...ACTIVE_STATUSES, PAYMENT_PENDING_STATUS].sort());
  });

  test('also counts a DECIDED term still inside its window (renewed / switch_plan / cancelled-with-decision), whatever its status (Codex GitHub r5 P1)', async () => {
    // coveredTermsAsOf keeps decided terms covering until term_end, so the
    // status list alone would let an unstamped series of a still-covered
    // customer through. The exclusion also matches any term whose term_end
    // is unset or today-or-later.
    const capturedCalls = [];
    const { customer, parent } = topupScenario();
    const conn = makeConn(({ table, calls, op }) => {
      if (table === 'scheduled_services' && op === 'columnInfo') return BASE_COLS;
      if (table === 'scheduled_services' && op === 'first') {
        const firstCall = calls.find((c) => c[0] === 'first');
        return firstCall[1] ? null : parent;
      }
      if (table === 'customers' && op === 'first') return customer;
      if (table === 'annual_prepay_terms' && op === 'first') { capturedCalls.push(calls); return { id: 'renewed-term' }; }
      return null;
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(result.skipped).toBe('annual_prepay_series');
    const nested = capturedCalls[0].find((c) => c[0] === 'whereFn')[1];
    expect(nested).toContainEqual(['orWhereNull', 'term_end']);
    expect(nested).toContainEqual(['orWhere', 'term_end', '>=', etDateString()]);
  });

  test('a series with no prepay stamp anywhere and no live customer term proceeds normally', async () => {
    const { conn, inserted } = topupScenario({ colsOverrides: { annual_prepay_term_id: {}, prepaid_method: {} } });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(result.skipped).toBeNull();
    expect(inserted.length).toBeGreaterThan(0);
  });
});

describe('topUpRecurringSeriesLocked — annual-prepay term-creation race (Codex GitHub r4 P1)', () => {
  // Term CREATION serializes on ANNUAL_PREPAY_LOCK_NS (admin-customers.js /
  // admin-invoices.js) — a payment_pending term can otherwise commit for
  // this exact customer mid-loop, after the prepay-exclusion check already
  // ran and found nothing. A TRY-lock (never blocking — see the lock's own
  // call-site comment for the full lock-order analysis) on that SAME
  // namespace closes the race: a hit guarantees no new term commits for
  // the rest of this transaction; a miss defers the whole series rather
  // than risk it.
  const { ANNUAL_PREPAY_LOCK_NS } = require('../routes/admin-customers')._private;

  test('takes a TRY-lock (never blocking) on the exact ANNUAL_PREPAY_LOCK_NS namespace, keyed by customer id', async () => {
    const rawCalls = [];
    const { conn } = topupScenario();
    conn.raw = jest.fn((sql, bindings) => {
      rawCalls.push([sql, bindings]);
      return Promise.resolve({ rows: [{ locked: true }] });
    });
    await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    const prepayLockCall = rawCalls.find(([sql]) => sql.includes('pg_try_advisory_xact_lock'));
    expect(prepayLockCall).toBeDefined();
    expect(prepayLockCall[1]).toEqual([ANNUAL_PREPAY_LOCK_NS, String(5)]); // topupScenario's customer_id
  });

  test('skips with annual_prepay_busy on a miss — never races a term creation genuinely in flight', async () => {
    const { conn, inserted } = topupScenario();
    conn.raw = jest.fn(() => Promise.resolve({ rows: [{ locked: false }] }));
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(result.skipped).toBe('annual_prepay_busy');
    expect(inserted).toHaveLength(0);
  });

  test('the prepay-exclusion check runs AFTER the lock, not before — a miss never even queries it', async () => {
    const prepayTermQueries = [];
    const { customer, parent } = topupScenario();
    const conn = makeConn(({ table, calls, op }) => {
      if (table === 'scheduled_services' && op === 'columnInfo') return BASE_COLS;
      if (table === 'scheduled_services' && op === 'first') {
        const firstCall = calls.find((c) => c[0] === 'first');
        return firstCall[1] ? null : parent;
      }
      if (table === 'customers' && op === 'first') return customer;
      if (table === 'annual_prepay_terms' && op === 'first') { prepayTermQueries.push(calls); return undefined; }
      return null;
    });
    conn.raw = jest.fn(() => Promise.resolve({ rows: [{ locked: false }] }));
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(result.skipped).toBe('annual_prepay_busy');
    expect(prepayTermQueries).toHaveLength(0);
  });

  test('a lock hit proceeds to the (passing) prepay-exclusion check and on to a normal top-up', async () => {
    const { conn, inserted } = topupScenario();
    conn.raw = jest.fn(() => Promise.resolve({ rows: [{ locked: true }] }));
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(result.skipped).toBeNull();
    expect(inserted.length).toBeGreaterThan(0);
  });
});

describe('topUpRecurringSeriesLocked — plan-hold exclusion (Codex GitHub r6 P1)', () => {
  // A held family (lawn_care / mosquito / tree_shrub — cancellation-
  // resolution/holds.js's startHold) promises "no visits before resume_on."
  // familyOfServiceRow is mocked (see the top-of-file jest.mock) so each
  // test controls the family directly rather than depending on that
  // module's own service_type/service_key text heuristics.
  test('skips a series whose family has an active plan hold', async () => {
    familyOfServiceRow.mockReturnValue('lawn_care');
    const { conn, inserted } = topupScenario({ activeHold: true });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(result.skipped).toBe('plan_hold');
    expect(inserted).toHaveLength(0);
  });

  test('a held lawn family does not block the SAME customer\'s pest series — plan_holds is never even queried for a non-holdable family', async () => {
    // pest_control is not in HOLDABLE_FAMILIES, so isFamilyOnPlanHold must
    // short-circuit to false without querying plan_holds at all — activeHold
    // stays true here specifically to prove that: if the code incorrectly
    // queried plan_holds for this family and the fake conn answered it
    // unconditionally, this would wrongly skip.
    familyOfServiceRow.mockReturnValue('pest_control');
    const { conn, inserted } = topupScenario({ activeHold: true });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(result.skipped).toBeNull();
    expect(inserted.length).toBeGreaterThan(0);
  });

  test('an expired (resume_on in the past, or no longer active) hold does not skip', async () => {
    familyOfServiceRow.mockReturnValue('lawn_care');
    const { conn, inserted } = topupScenario({ activeHold: false });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(result.skipped).toBeNull();
    expect(inserted.length).toBeGreaterThan(0);
  });

  test('a series with no resolvable WaveGuard family is never held', async () => {
    familyOfServiceRow.mockReturnValue(null);
    const { conn, inserted } = topupScenario({ activeHold: true });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(result.skipped).toBeNull();
    expect(inserted.length).toBeGreaterThan(0);
  });
});

describe('topUpRecurringSeriesLocked — billable-amount gate', () => {
  // Same shared verdict every OFFICE series writer consults
  // (seriesExtensionUnbillable) — the completion-time single-visit
  // auto-extend deliberately skips it (owner ruling: warn at completion),
  // but this unattended nightly loop can mint many rows in one run and so
  // belongs with the OFFICE-writer class (schedule-update-details-
  // recurring-count.test.js pins that classification on the source).
  // Checked per ACTUAL candidate date inside extendSeriesOnceLocked (price
  // varies by date), so an unbillable series silently inserts nothing and
  // stops — `skipped` stays null, same as running out of horizon or hitting
  // the insert cap; it isn't a distinct ineligibility reason like
  // 'not_ongoing' because the series WAS otherwise eligible and simply
  // couldn't produce a billable date.
  test('an unpriced series with no create-invoice stamp and no membership/lane inserts nothing — never mints a stack of $0 visits', async () => {
    const { conn, inserted } = topupScenario({
      parentOverrides: { create_invoice_on_complete: false, estimated_price: null },
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(result.skipped).toBeNull();
    expect(inserted).toHaveLength(0);
    expect(result.spawnedVisits).toHaveLength(0);
  });

  test('a monthly member with a real dues rate is billable even with no price stamp — dues cover it', async () => {
    const { conn, inserted } = topupScenario({
      parentOverrides: { create_invoice_on_complete: false, estimated_price: null },
      customerOverrides: { billing_mode: 'monthly_membership', monthly_rate: 120, waveguard_tier: 'silver' },
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(result.skipped).toBeNull();
    expect(inserted.length).toBeGreaterThan(0);
  });
});

describe('topUpRecurringSeriesLocked — off-hour window_start normalization (Codex GitHub r2 P1)', () => {
  // A legacy 09:15/09:30 template would otherwise get copied onto every one
  // of up to 24 unattended inserts, minting rows assertAdminAppointmentWindow
  // (server/services/scheduling/window-rules.js) would reject outright on
  // any admin-facing write (AGENTS.md: windows start on the hour).
  test('floors an off-hour parent window_start to the hour and recomputes the end from duration', async () => {
    const { conn, inserted } = topupScenario({
      parentOverrides: {
        recurring_pattern: 'weekly', window_start: '09:15', window_end: '10:15',
        estimated_duration_minutes: 60,
      },
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 14 });
    expect(result.skipped).toBeNull();
    expect(inserted.length).toBeGreaterThan(0);
    for (const row of inserted) {
      expect(row.window_start).toBe('09:00');
      expect(row.window_end).toBe('10:00');
    }
  });

  test('the occupancy clash probe checks the SAME normalized window the insert uses, not the original off-hour one (Codex GitHub r2 P1)', async () => {
    // A 09:30-10:30 template probed with its own (unnormalized) window
    // could pass beside an existing 08:00-09:30 visit, then insert at the
    // floored 09:00-10:00 — which DOES overlap that same visit. The probe
    // must be asked about the window that actually gets written.
    const { conn, inserted } = topupScenario({
      parentOverrides: {
        recurring_pattern: 'weekly', window_start: '09:30', window_end: '10:30',
        estimated_duration_minutes: 60,
      },
    });
    await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 14 });
    expect(inserted.length).toBeGreaterThan(0);
    expect(findConflictingVisits).toHaveBeenCalled();
    for (const call of findConflictingVisits.mock.calls) {
      expect(call[0].windowStart).toBe('09:00');
      expect(call[0].windowEnd).toBe('10:00');
    }
  });

  test('an on-the-hour parent window_start is left exactly as-is', async () => {
    const { conn, inserted } = topupScenario({
      parentOverrides: { recurring_pattern: 'weekly', window_start: '09:00', window_end: '10:00' },
    });
    await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 14 });
    expect(inserted.length).toBeGreaterThan(0);
    for (const row of inserted) {
      expect(row.window_start).toBe('09:00');
      expect(row.window_end).toBe('10:00');
    }
  });

  test('a windowless template never gets an hour invented for it', async () => {
    const { conn, inserted } = topupScenario({
      parentOverrides: { recurring_pattern: 'weekly', window_start: null, window_end: null },
    });
    await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 14 });
    expect(inserted.length).toBeGreaterThan(0);
    for (const row of inserted) {
      expect(row.window_start).toBeFalsy();
      expect(row.window_end).toBeFalsy();
    }
  });

  test('skips a series whose floored window would push its duration-derived end past 24:00 (Codex GitHub r3 P2)', async () => {
    // 23:45 floors to 23:00; +60min duration lands the end at 24:00 —
    // never build that out-of-range time. Checked upfront, so the whole
    // series is skipped rather than discovered mid-loop.
    const { conn, inserted } = topupScenario({
      parentOverrides: {
        recurring_pattern: 'weekly', window_start: '23:45', window_end: '00:45',
        estimated_duration_minutes: 60,
      },
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 14 });
    expect(result.skipped).toBe('window_unplaceable');
    expect(inserted).toHaveLength(0);
  });

  test('skips an ALREADY on-the-hour window that ends past the 20:00 admin day bound (Codex GitHub r6 P2)', async () => {
    // The pre-fix midnight-only check never even looked at an on-the-hour
    // start (it short-circuited to "nothing to normalize"), so a legacy
    // 21:00 template with a 60-minute duration — ending 22:00, well past
    // the admin day's 20:00 close — would have inserted unchecked.
    // assertAdminAppointmentWindow (window-rules.js) is the SAME validator
    // every other admin write path runs through, so this ceiling was never
    // a top-up-specific invention.
    const { conn, inserted } = topupScenario({
      parentOverrides: {
        recurring_pattern: 'weekly', window_start: '21:00', window_end: '22:00',
        estimated_duration_minutes: 60,
      },
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 14 });
    expect(result.skipped).toBe('window_unplaceable');
    expect(inserted).toHaveLength(0);
  });

  test('skips an off-hour window whose FLOORED start + duration ends past the 20:00 admin day bound (Codex GitHub r6 P2)', async () => {
    // 19:30 floors to 19:00; +120min duration lands the end at 21:00 — never
    // past 24:00 (the old check's only concern), but past the 20:00 admin
    // day bound assertAdminAppointmentWindow enforces.
    const { conn, inserted } = topupScenario({
      parentOverrides: {
        recurring_pattern: 'weekly', window_start: '19:30', window_end: '21:30',
        estimated_duration_minutes: 120,
      },
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 14 });
    expect(result.skipped).toBe('window_unplaceable');
    expect(inserted).toHaveLength(0);
  });

  test('a normal on-the-hour 09:00 window, well within the admin day, is never treated as unplaceable', async () => {
    const { conn, inserted } = topupScenario({
      parentOverrides: {
        recurring_pattern: 'weekly', window_start: '09:00', window_end: '10:00',
        estimated_duration_minutes: 60,
      },
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 14 });
    expect(result.skipped).toBeNull();
    expect(inserted.length).toBeGreaterThan(0);
  });
});

describe('topUpRecurringSeriesLocked — horizon fill', () => {
  test('fills a weekly series to the horizon and stops (no past-dated or duplicate inserts)', async () => {
    const { conn, inserted, seriesDates } = topupScenario({
      parentOverrides: { recurring_pattern: 'weekly' },
      seriesDates: [daysOut(0)],
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    // Weekly cadence, 30-day horizon starting from today → 4 candidates
    // (day7/14/21/28) land inside the horizon; day35 does not.
    expect(result.skipped).toBeNull();
    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted.length).toBeLessThan(TOPUP_MAX_INSERTS_PER_SERIES_PER_RUN);
    const today = daysOut(0);
    const horizon = daysOut(30);
    const seen = new Set();
    for (const row of inserted) {
      // Never past-dated.
      expect(row.scheduled_date > today).toBe(true);
      // Never past the horizon this run was asked to fill to.
      expect(row.scheduled_date < horizon).toBe(true);
      // Never a duplicate date within this series.
      expect(seen.has(row.scheduled_date)).toBe(false);
      seen.add(row.scheduled_date);
    }
    // Every inserted date actually landed in the series' occupied-dates set.
    for (const d of seen) expect(seriesDates.has(d)).toBe(true);
  });

  test('stops at the hard 24-insert cap even with horizon room left', async () => {
    const { conn, inserted } = topupScenario({
      parentOverrides: { recurring_pattern: 'weekly' },
      seriesDates: [daysOut(0)],
    });
    // 1000 days at a 7-day cadence is >100 possible slots — the cap must
    // bind, not the horizon.
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 1000 });
    expect(result.skipped).toBeNull();
    expect(inserted).toHaveLength(TOPUP_MAX_INSERTS_PER_SERIES_PER_RUN);
  });

  test('a series already booked past the horizon inserts nothing', async () => {
    const { conn, inserted } = topupScenario({
      parentOverrides: { recurring_pattern: 'weekly' },
      seriesDates: [daysOut(60)],
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(result.skipped).toBeNull();
    expect(inserted).toHaveLength(0);
    expect(result.priorBookedThrough).toBe(daysOut(60));
  });
});

describe('topUpRecurringSeriesWithLocks — shared by apply and dry run', () => {
  beforeEach(() => jest.clearAllMocks());

  test('takes the per-parent maintenance lock and the customer-comms fence, and registers no reminders itself', async () => {
    // The sweep's dry run calls this inside a rollback-only transaction, so
    // a shadow/preview pass serializes against concurrent completions,
    // cancellations and merge-undos exactly like a real run.
    const { conn, inserted } = topupScenario({
      parentOverrides: { recurring_pattern: 'weekly' },
      seriesDates: [daysOut(0)],
    });
    const rawCalls = [];
    // Records every raw() call (the two advisory locks this test asserts on)
    // while still answering the annual-prepay try-lock probe as "acquired",
    // same default as every other scenario in this suite.
    conn.raw = jest.fn((sql, bindings) => { rawCalls.push([sql, bindings]); return Promise.resolve({ rows: [{ locked: true }] }); });
    const result = await topUpRecurringSeriesWithLocks(conn, 10, { horizonDays: 14 });
    const flat = rawCalls.map(([sql, b]) => `${sql} ${JSON.stringify(b || [])}`);
    expect(flat.some((x) => x.includes('pg_advisory_xact_lock') && x.includes('recurring-series-maintenance'))).toBe(true);
    expect(flat.some((x) => x.includes('customer-comms:'))).toBe(true);
    expect(inserted.length).toBeGreaterThan(0);
    expect(result.spawnedVisits).toHaveLength(inserted.length);
    expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
  });
});

describe('topUpRecurringSeries — the writing wrapper', () => {
  beforeEach(() => jest.clearAllMocks());

  test('registers a reminder for each spawned visit after commit, with no confirmation SMS', async () => {
    const { conn, inserted } = topupScenario({
      parentOverrides: { recurring_pattern: 'weekly' },
      seriesDates: [daysOut(0)],
    });
    const result = await topUpRecurringSeries(conn, 10, { horizonDays: 14 });
    expect(inserted.length).toBeGreaterThan(0);
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledTimes(inserted.length);
    for (const call of AppointmentReminders.registerAppointment.mock.calls) {
      expect(call[5]).toMatchObject({ sendConfirmation: false });
      expect(call[4]).toBe('recurring_auto_extend');
    }
    expect(result.spawnedVisits).toHaveLength(inserted.length);
  });

  test('an ineligible series registers no reminder and inserts nothing', async () => {
    const { conn, inserted } = topupScenario({ customerOverrides: { pipeline_stage: 'churned' } });
    const result = await topUpRecurringSeries(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBe('customer_churned');
    expect(inserted).toHaveLength(0);
    expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
  });

  test('refuses a conn that is already an open transaction, rather than nesting a savepoint that would self-deadlock (Codex GitHub r4 P1)', async () => {
    // A caller-supplied open transaction used to be run on directly
    // (conn.isTransaction), and a first fix attempt tried unconditionally
    // calling conn.transaction(...) instead — Codex's local pre-push audit
    // caught that this does NOT actually solve it: knex's .transaction() on
    // a conn that is ALREADY a transaction opens a SAVEPOINT, not an
    // independently-committing one, and releasing a savepoint doesn't make
    // its writes visible outside the OUTER transaction (which this
    // function doesn't own and can't commit) — registerSpawnedVisitReminder
    // below would still block on that outer transaction's own commit,
    // which the caller is synchronously waiting on THIS call to return
    // before doing. There is no safe way to run this function inside a
    // caller's own open transaction, so it refuses outright instead of
    // pretending to fix it.
    const { conn, inserted } = topupScenario({
      parentOverrides: { recurring_pattern: 'weekly' },
      seriesDates: [daysOut(0)],
    });
    conn.isTransaction = true; // what a caller's own open transaction would report
    await expect(topUpRecurringSeries(conn, 10, { horizonDays: 14 })).rejects.toThrow(/already-open transaction/);
    expect(inserted).toHaveLength(0); // refused before touching anything
  });

  test('defers to the next tick when a merge-undo repoints the parent to a new customer TWICE under the comms fence', async () => {
    // Rung-6 re-lock (mirrors runRecurringSeriesMaintenanceLocked): the
    // comms lock must fence the CURRENT owner, not whoever owned the row
    // when this call started waiting on it. A row that keeps moving even
    // under the second lock defers the whole run rather than inserting
    // under a still-stale owner's fence.
    const customerIdReads = [{ customer_id: 'cust-A' }, { customer_id: 'cust-B' }, { customer_id: 'cust-C' }];
    let readIndex = 0;
    const handler = ({ table, op, calls }) => {
      if (table === 'scheduled_services' && op === 'first') {
        const firstCall = calls.find((c) => c[0] === 'first');
        if (firstCall[1] === 'customer_id') {
          const row = customerIdReads[Math.min(readIndex, customerIdReads.length - 1)];
          readIndex += 1;
          return row;
        }
      }
      return null;
    };
    const conn = makeConn(handler);
    const result = await topUpRecurringSeries(conn, 10, { horizonDays: 30 });
    expect(result.skipped).toBe('owner_changed_under_fence');
    expect(result.spawnedVisits).toEqual([]);
    expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
  });
});
