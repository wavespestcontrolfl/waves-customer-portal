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

const adminScheduleRouter = require('../routes/admin-schedule');
const {
  topUpRecurringSeriesLocked, topUpRecurringSeries, topUpRecurringSeriesWithLocks, TOPUP_MAX_INSERTS_PER_SERIES_PER_RUN,
} = adminScheduleRouter._test;
const AppointmentReminders = require('../services/appointment-reminders');
const { findConflictingVisits } = require('../services/scheduling/occupancy');
const { ACTIVE_STATUSES, PAYMENT_PENDING_STATUS } = require('../services/annual-prepay-renewals');
beforeEach(() => {
  findConflictingVisits.mockReset().mockResolvedValue([]);
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
        for (const nm of ['where', 'orWhere', 'whereNull', 'whereNotNull', 'orWhereNull', 'orWhereNot', 'whereRaw', 'orWhereRaw', 'orWhereNotIn', 'orWhereNotNull']) {
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
    fn.raw = () => Promise.resolve();
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
// `stampedSeriesRow` / `customerLiveTerm`: control isAnnualPrepaySeries'
// two DB probes (a stamped scheduled_services row anywhere in the series;
// any live/undecided annual_prepay_terms row for the customer) — both
// default to "no prepay footprint" so every OTHER describe block's
// fixtures are unaffected by the v1 scope cut.
function topupScenario({
  parentOverrides = {}, customerOverrides = {}, seriesDates: initialDates = [daysOut(0)],
  colsOverrides = {}, stampedSeriesRow = false, customerLiveTerm = false,
  captureCustomerCalls = null,
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
          // carries annual_prepay_term_id/prepaid_method) — a combined
          // recurring_parent_id-or-id + IS NOT NULL predicate, so it never
          // matches the plain-object where() branch below.
          return stampedSeriesRow ? { id: 'stamped-row' } : undefined;
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
      stampedSeriesRow: true,
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBe('annual_prepay_series');
    expect(inserted).toHaveLength(0);
  });

  test('skips on a prepaid_method stamp too, on a schema without annual_prepay_term_id', async () => {
    const { conn, inserted } = topupScenario({
      colsOverrides: { prepaid_method: {} },
      stampedSeriesRow: true,
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBe('annual_prepay_series');
    expect(inserted).toHaveLength(0);
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
    const whereInCall = capturedCalls[0].find((c) => c[0] === 'whereIn');
    expect(whereInCall).toBeDefined();
    expect(whereInCall[2].slice().sort()).toEqual([...ACTIVE_STATUSES, PAYMENT_PENDING_STATUS].sort());
  });

  test('a series with no prepay stamp anywhere and no live customer term proceeds normally', async () => {
    const { conn, inserted } = topupScenario({ colsOverrides: { annual_prepay_term_id: {}, prepaid_method: {} } });
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
    conn.raw = jest.fn((sql, bindings) => { rawCalls.push([sql, bindings]); return Promise.resolve(); });
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
