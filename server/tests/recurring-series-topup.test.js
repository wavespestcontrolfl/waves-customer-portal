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
jest.mock('../services/annual-prepay-renewals', () => ({
  // serviceMatchesCoverage is pure (no DB) — keep the REAL implementation so
  // the term-cap's customer-wide service scoping is exercised for real;
  // only coveredTermsAsOf (the DB query) is mocked per-test.
  ...jest.requireActual('../services/annual-prepay-renewals'),
  coveredTermsAsOf: jest.fn(),
}));

const adminScheduleRouter = require('../routes/admin-schedule');
const {
  topUpRecurringSeriesLocked, topUpRecurringSeries, topUpRecurringSeriesWithLocks, TOPUP_MAX_INSERTS_PER_SERIES_PER_RUN,
} = adminScheduleRouter._test;
const AppointmentReminders = require('../services/appointment-reminders');
const { coveredTermsAsOf } = require('../services/annual-prepay-renewals');
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
// recurring-series-maintenance.test.js's makeConn, extended with `pluck`
// (seriesTermIds / the customer-level term scan) and a `customers` table.
function makeConn(handler, opts = {}) {
  const buildTable = (table) => {
    const calls = [];
    const b = {};
    const record = (name) => (...args) => {
      if ((name === 'where' || name === 'whereNotExists') && typeof args[0] === 'function') {
        const nested = [];
        const sub = {};
        for (const nm of ['where', 'orWhere', 'whereNull', 'whereNotNull', 'orWhereNull', 'orWhereNot', 'whereRaw', 'orWhereRaw', 'orWhereNotIn']) {
          sub[nm] = (...a) => { nested.push([nm, ...a]); return sub; };
        }
        args[0].call(sub, sub);
        calls.push(['whereFn', nested]);
      } else {
        calls.push([name, ...args]);
      }
      return b;
    };
    for (const m of ['where', 'orWhere', 'whereIn', 'whereNotIn', 'whereBetween', 'whereNull', 'whereNotNull', 'whereNot', 'whereRaw', 'orWhereRaw', 'orderBy', 'count', 'select', 'del', 'update', 'limit', 'forShare', 'distinct', 'andWhere']) {
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
function topupScenario({
  parentOverrides = {}, customerOverrides = {}, seriesDates: initialDates = [daysOut(0)],
  colsOverrides = {}, linkedTermIds = [], customerTerms = [],
} = {}) {
  const parent = {
    id: 10, customer_id: 5, is_recurring: true, recurring_pattern: 'weekly',
    recurring_ongoing: true, scheduled_date: daysOut(0),
    window_start: '08:00', window_end: '10:00',
    service_type: 'Weekly Pest Control', time_window: 'morning', zone: 'A',
    estimated_duration_minutes: 60, skip_weekends: false,
    create_invoice_on_complete: false,
    ...parentOverrides,
  };
  const customer = {
    id: 5, active: true, deleted_at: null, service_paused_at: null, pipeline_stage: 'active_customer',
    ...customerOverrides,
  };
  const cols = { ...BASE_COLS, ...colsOverrides };
  const seriesDates = new Set(initialDates);
  const inserted = [];
  let nextId = 900;
  const handler = ({ table, calls, op, data, field }) => {
    if (table === 'scheduled_services') {
      if (op === 'columnInfo') return cols;
      if (op === 'pluck' && field === 'annual_prepay_term_id') return linkedTermIds;
      if (op === 'first') {
        const firstCall = calls.find((c) => c[0] === 'first');
        if (firstCall[1] === 'recurring_ongoing') return { recurring_ongoing: parent.recurring_ongoing };
        if (firstCall[1] === 'customer_id') return { customer_id: parent.customer_id };
        if (firstCall[1] === 'status') return { status: 'pending' };
        if (calls.some((c) => c[0] === 'orderBy')) {
          if (!seriesDates.size) return undefined;
          const latest = [...seriesDates].sort().slice(-1)[0];
          return { scheduled_date: latest };
        }
        const whereCall = calls.find((c) => c[0] === 'where' && c[1] && typeof c[1] === 'object' && 'id' in c[1]);
        if (whereCall && whereCall[1].id !== parent.id) return undefined;
        return parent;
      }
      if (op === 'await') {
        if (calls.some((c) => c[0] === 'whereRaw')) return []; // global occupancy probe — never clashes here
        if (calls.some((c) => c[0] === 'select' && c[1] === 'scheduled_date')) {
          return [...seriesDates].map((scheduled_date) => ({ scheduled_date }));
        }
        return [];
      }
      if (op === 'insertReturning') {
        const id = ++nextId;
        inserted.push({ id, ...data });
        seriesDates.add(data.scheduled_date);
        return [{ id, ...data }];
      }
      if (op === 'insert') { inserted.push(data); seriesDates.add(data.scheduled_date); return [1]; }
    }
    if (table === 'scheduled_service_addons') {
      if (op === 'columnInfo') return {};
      return [];
    }
    if (table === 'customers') {
      if (op === 'first') return customer;
    }
    if (table === 'annual_prepay_terms') {
      if (op === 'await') return customerTerms; // .select('id', 'coverage_service_type')
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

  test('skips a paused customer', async () => {
    const { conn, inserted } = topupScenario({ customerOverrides: { service_paused_at: new Date() } });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBe('customer_service_paused');
    expect(inserted).toHaveLength(0);
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

describe('topUpRecurringSeriesLocked — annual-prepay term_end cap', () => {
  test('never inserts past a linked term\'s term_end, even though the horizon allows more', async () => {
    const termEnd = daysOut(20);
    coveredTermsAsOf.mockReturnValue({
      whereIn: () => ({ select: async () => [{ term_end: termEnd }] }),
    });
    const { conn, inserted } = topupScenario({
      parentOverrides: { recurring_pattern: 'weekly' },
      seriesDates: [daysOut(0)],
      colsOverrides: { annual_prepay_term_id: {} },
      linkedTermIds: ['term-A'],
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBeNull();
    expect(result.termCap).toBe(termEnd);
    expect(result.effectiveHorizon).toBe(termEnd);
    for (const row of inserted) {
      expect(row.scheduled_date < termEnd).toBe(true);
    }
    expect(inserted.length).toBeGreaterThan(0);
  });

  test('discovers a term the customer holds directly, with no scheduled_services link yet', async () => {
    const termEnd = daysOut(10);
    coveredTermsAsOf.mockReturnValue({
      whereIn: () => ({ select: async () => [{ term_end: termEnd }] }),
    });
    const { conn, inserted } = topupScenario({
      parentOverrides: { recurring_pattern: 'weekly' },
      seriesDates: [daysOut(0)],
      colsOverrides: { annual_prepay_term_id: {} },
      linkedTermIds: [],
      customerTerms: [{ id: 'term-B', coverage_service_type: 'Weekly Pest Control' }],
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.effectiveHorizon).toBe(termEnd);
    for (const row of inserted) expect(row.scheduled_date < termEnd).toBe(true);
  });

  test('ignores an already-ended DECIDED term (switch_plan/declined-renewal) — never permanently caps a customer no longer on that term', async () => {
    // coveredTermsAsOf(conn, null) has no date-window filter, so a customer
    // who switched off annual prepay months ago still surfaces that closed
    // term. Its term_end is in the past, so it must never win the cap —
    // otherwise a customer with no live term would never top up again.
    const pastTermEnd = daysOut(-30);
    coveredTermsAsOf.mockReturnValue({
      whereIn: () => ({ select: async () => [{ term_end: pastTermEnd, status: 'switch_plan', renewal_decision: null }] }),
    });
    const { conn, inserted } = topupScenario({
      parentOverrides: { recurring_pattern: 'weekly' },
      seriesDates: [daysOut(0)],
      colsOverrides: { annual_prepay_term_id: {} },
      linkedTermIds: ['term-old'],
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(result.termCap).toBeNull();
    // Falls back to the ordinary horizon (30 days), not the stale term_end.
    expect(result.effectiveHorizon).toBe(daysOut(30));
    expect(inserted.length).toBeGreaterThan(0);
  });

  test('keeps capping an expired-but-UNDECIDED term (active/renewal_pending past its own term_end)', async () => {
    // The renewal decision hasn't been made yet — booking past this term
    // would be speculative. Unlike the decided-and-closed case above, this
    // term must keep capping even though its window already ended.
    const pastTermEnd = daysOut(-5);
    coveredTermsAsOf.mockReturnValue({
      whereIn: () => ({ select: async () => [{ term_end: pastTermEnd, status: 'active', renewal_decision: null }] }),
    });
    const { conn, inserted } = topupScenario({
      parentOverrides: { recurring_pattern: 'weekly' },
      seriesDates: [daysOut(0)],
      colsOverrides: { annual_prepay_term_id: {} },
      linkedTermIds: ['term-overdue'],
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.termCap).toBe(pastTermEnd);
    // The cap is already in the past, so nothing new can legally be booked.
    expect(inserted).toHaveLength(0);
  });

  test('a declined-renewal lapse still riding out its paid remainder keeps capping until its (future) term_end', async () => {
    const futureTermEnd = daysOut(15);
    coveredTermsAsOf.mockReturnValue({
      whereIn: () => ({ select: async () => [{ term_end: futureTermEnd, status: 'cancelled', renewal_decision: 'cancel' }] }),
    });
    const { conn, inserted } = topupScenario({
      parentOverrides: { recurring_pattern: 'weekly' },
      seriesDates: [daysOut(0)],
      colsOverrides: { annual_prepay_term_id: {} },
      linkedTermIds: ['term-lapsing'],
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.termCap).toBe(futureTermEnd);
    for (const row of inserted) expect(row.scheduled_date < futureTermEnd).toBe(true);
  });

  test('scopes the customer-wide term scan to THIS series\' service — an unrelated service\'s longer term never extends past this one\'s real window', async () => {
    const pestTermEnd = daysOut(20);
    const lawnTermEnd = daysOut(200); // longer, but a DIFFERENT service
    const termRows = [
      { id: 'term-pest', term_end: pestTermEnd, status: 'active', renewal_decision: null },
      { id: 'term-lawn', term_end: lawnTermEnd, status: 'active', renewal_decision: null },
    ];
    coveredTermsAsOf.mockReturnValue({
      whereIn: (col, ids) => ({ select: async () => termRows.filter((r) => ids.includes(r.id)) }),
    });
    const { conn, inserted } = topupScenario({
      parentOverrides: { recurring_pattern: 'weekly', service_type: 'Weekly Pest Control' },
      seriesDates: [daysOut(0)],
      colsOverrides: { annual_prepay_term_id: {} },
      customerTerms: [
        { id: 'term-pest', coverage_service_type: 'Pest Control' },
        { id: 'term-lawn', coverage_service_type: 'Lawn Care Program' },
      ],
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    // Capped at the PEST term's own end, never stretched to the unrelated
    // (longer) lawn term.
    expect(result.termCap).toBe(pestTermEnd);
    for (const row of inserted) expect(row.scheduled_date < pestTermEnd).toBe(true);
  });

  test('an unrelated service\'s overdue/undecided term never freezes this series', async () => {
    // A pest series with NO annual-prepay term of its own; the customer
    // separately holds an overdue, undecided LAWN term. That must not cap
    // (let alone freeze) this unrelated pest series.
    const overdueLawnTermEnd = daysOut(-10);
    coveredTermsAsOf.mockReturnValue({
      whereIn: (col, ids) => ({
        select: async () => (ids.includes('term-lawn-overdue')
          ? [{ id: 'term-lawn-overdue', term_end: overdueLawnTermEnd, status: 'active', renewal_decision: null }]
          : []),
      }),
    });
    const { conn, inserted } = topupScenario({
      parentOverrides: { recurring_pattern: 'weekly', service_type: 'Weekly Pest Control' },
      seriesDates: [daysOut(0)],
      colsOverrides: { annual_prepay_term_id: {} },
      customerTerms: [{ id: 'term-lawn-overdue', coverage_service_type: 'Lawn Care Program' }],
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    expect(result.termCap).toBeNull();
    expect(result.effectiveHorizon).toBe(daysOut(30));
    expect(inserted.length).toBeGreaterThan(0);
  });

  test('fails closed (skips the series) when the term-cap lookup errors — never guesses "no cap"', async () => {
    coveredTermsAsOf.mockImplementation(() => { throw new Error('boom'); });
    const { conn, inserted } = topupScenario({
      colsOverrides: { annual_prepay_term_id: {} },
      linkedTermIds: ['term-A'],
    });
    const result = await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 365 });
    expect(result.skipped).toBe('prepay_cap_unresolved');
    expect(inserted).toHaveLength(0);
  });

  test('a discovered-but-unlinked term is fed to coverage discovery, not just used to cap the horizon', async () => {
    // Codex pre-push P0: resolveTopUpTermCap's customer-wide scan capped the
    // horizon correctly, but applyExtensionPrepayCoverage (inside
    // extendSeriesOnceLocked) only ever discovered terms via seriesTermIds
    // (rows already stamped on THIS series) — so a term found ONLY through
    // the customer-wide scan never reached the coverage-application step,
    // and the newly inserted visit would look uncovered. This pins the
    // wiring fix (opts.extraTermIds) at the one place a fake connection can
    // observe it: the id list handed to coveredTermsAsOf when
    // applyExtensionPrepayCoverage's coveringTermForDate probes coverage for
    // the freshly computed candidate date (a real date, unlike
    // resolveTopUpTermCap's own null-coverageDate call). Full end-to-end
    // stamping (annual_prepay_term_id actually landing on the inserted row)
    // needs the real-Postgres coverage-application machinery and is out of
    // this fake-connection suite's reach — see
    // recurring-prepay-coverage-inheritance.test.js's pattern for that.
    const termEnd = daysOut(90);
    const whereInCalls = [];
    coveredTermsAsOf.mockImplementation((c, coverageDate) => ({
      whereIn: (col, ids) => {
        whereInCalls.push({ coverageDate, ids: [...ids] });
        const matched = ids.includes('term-unlinked')
          ? [{ id: 'term-unlinked', term_end: termEnd, status: 'active', renewal_decision: null }]
          : [];
        return {
          select: async () => matched,
          orderBy: () => ({ first: async () => matched[0] }),
        };
      },
    }));
    const { conn } = topupScenario({
      parentOverrides: { recurring_pattern: 'weekly', service_type: 'Weekly Pest Control' },
      seriesDates: [daysOut(0)],
      colsOverrides: { annual_prepay_term_id: {} },
      customerTerms: [{ id: 'term-unlinked', coverage_service_type: 'Pest Control' }],
    });
    await topUpRecurringSeriesLocked(conn, 10, { horizonDays: 30 });
    // resolveTopUpTermCap's own lookup (coverageDate === null) found it —
    // proven by the earlier cap tests. Here: a SEPARATE call with a real
    // coverageDate (coveringTermForDate, from inside
    // applyExtensionPrepayCoverage) must ALSO carry it.
    const coverageProbe = whereInCalls.find((c) => c.coverageDate);
    expect(coverageProbe).toBeDefined();
    expect(coverageProbe.ids).toContain('term-unlinked');
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
