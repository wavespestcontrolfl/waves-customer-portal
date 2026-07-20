/**
 * Post-completion recurring-series maintenance (fix: recurring-series
 * integrity).
 *
 * The auto-extend / plan-ending logic used to live inline in
 * PUT /admin/schedule/:id/status — a route no production completion path
 * calls — so ongoing plans completed through dispatch ran dry with no refill
 * and no alert. It is now runRecurringSeriesMaintenance, shared with the
 * dispatch completion routes via services/recurring-series-extend.js.
 *
 * Unit tests drive the extracted function with a scripted fake connection;
 * source-pattern guards (house style — see booking-slot-commit-validation)
 * pin the exhausted-ongoing derived scan and the unchanged fixed-plan scan.
 */
jest.mock('../services/appointment-reminders', () => ({
  registerAppointment: jest.fn().mockResolvedValue(undefined),
  alertRegistrationFailure: jest.fn().mockResolvedValue(undefined),
}));

const fs = require('fs');
const path = require('path');

const adminScheduleRouter = require('../routes/admin-schedule');
const { runRecurringSeriesMaintenance } = adminScheduleRouter._test;
const AppointmentReminders = require('../services/appointment-reminders');

const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

const COLS = {
  recurring_ongoing: {}, skip_weekends: {}, weekend_shift: {}, service_id: {},
  create_invoice_on_complete: {}, estimated_price: {}, is_callback: {}, discount_dollars: {},
};

// Scriptable fake knex connection: records the chained calls and resolves
// terminal ops through the scenario handler.
//
// runRecurringSeriesMaintenance now serializes per parent with a
// pg_advisory_xact_lock inside a transaction (P0 concurrency fix): it opens a
// transaction (unless the caller already passed one), takes the lock on that
// trx, and re-reads the upcoming-count / existing-dates inside it. So the fake
// connection is also callable AS a transaction — `.transaction(cb)` invokes cb
// with a trx-shaped conn (same handler), `.raw` no-ops the advisory lock, and
// `.isTransaction` flags whether we're already inside one. An optional shared
// `mutex` serializes overlapping transactions the way the real per-parent
// advisory lock does, so the concurrency test can prove the loser re-reads and
// no-ops instead of double-inserting.
function makeConn(handler, opts = {}) {
  const buildTable = (table) => {
    const calls = [];
    const b = {};
    const record = (name) => (...args) => {
      if ((name === 'where' || name === 'whereNotExists') && typeof args[0] === 'function') {
        const nested = [];
        const sub = {
          where(...a) { nested.push(['where', ...a]); return sub; },
          orWhere(...a) { nested.push(['orWhere', ...a]); return sub; },
        };
        args[0].call(sub, sub);
        calls.push(['whereFn', nested]);
      } else {
        calls.push([name, ...args]);
      }
      return b;
    };
    for (const m of ['where', 'orWhere', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereNot', 'orderBy', 'count', 'select', 'del', 'update', 'limit']) {
      b[m] = record(m);
    }
    b.first = (...args) => {
      calls.push(['first', ...args]);
      return Promise.resolve(handler({ table, calls, op: 'first' }));
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
    // Advisory lock (SELECT pg_advisory_xact_lock(...)) — nothing to assert on
    // the result; the real lock's serialization is modelled by opts.mutex.
    fn.raw = () => Promise.resolve();
    fn.transaction = (cb) => {
      const exec = () => Promise.resolve().then(() => cb(build(true)));
      // Only top-level transactions serialize on the mutex (= the per-parent
      // advisory lock). A nested `.transaction` from inside the locked block
      // is a SAVEPOINT (the add-on preload's abort-tolerance) — it runs inline
      // under the already-held lock, so it must NOT try to re-acquire it.
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

function ongoingScenario({ upcomingCount, sibling, parentOverrides = {}, stillOngoing = true }) {
  const parent = {
    id: 10, customer_id: 5, is_recurring: true, recurring_pattern: 'quarterly',
    recurring_ongoing: true, scheduled_date: '2026-01-15',
    window_start: '08:00', window_end: '10:00',
    service_type: 'Quarterly Pest Control', time_window: 'morning', zone: 'A',
    estimated_duration_minutes: 60, skip_weekends: false, technician_id: 'tech-1',
    create_invoice_on_complete: false,
    ...parentOverrides,
  };
  const inserted = [];
  const alertInserts = [];
  const handler = ({ table, calls, op, data }) => {
    if (table === 'scheduled_services') {
      if (op === 'columnInfo') return COLS;
      if (op === 'first') {
        const firstCall = calls.find((c) => c[0] === 'first');
        if (calls.some((c) => c[0] === 'count')) return { c: String(upcomingCount) };
        if (firstCall[1] === 'recurring_ongoing') return { recurring_ongoing: stillOngoing };
        if (firstCall[1] === 'create_invoice_on_complete') return sibling;
        if (calls.some((c) => c[0] === 'orderBy')) return { scheduled_date: '2026-07-15' }; // latest
        return parent;
      }
      if (op === 'await') {
        if (calls.some((c) => c[0] === 'select' && c[1] === 'scheduled_date')) {
          return [
            { scheduled_date: '2026-01-15' },
            { scheduled_date: '2026-04-15' },
            { scheduled_date: '2026-07-15' },
          ];
        }
        return [];
      }
      if (op === 'insertReturning') { inserted.push(data); return [{ id: 901, ...data }]; }
      if (op === 'insert') { inserted.push(data); return [1]; }
    }
    if (table === 'scheduled_service_addons') {
      if (op === 'columnInfo') return {};
      return [];
    }
    if (table === 'recurring_plan_alerts') {
      if (op === 'first') return null;
      if (op === 'insert' || op === 'insertReturning') { alertInserts.push(data); return [1]; }
    }
    return null;
  };
  return { conn: makeConn(handler), inserted, alertInserts, parent };
}

describe('runRecurringSeriesMaintenance — ongoing auto-extend', () => {
  beforeEach(() => jest.clearAllMocks());

  test('extends an ongoing series below the 2-ahead window and propagates create_invoice_on_complete from the latest sibling', async () => {
    const { conn, inserted } = ongoingScenario({
      upcomingCount: 1,
      sibling: { create_invoice_on_complete: true },
    });
    await runRecurringSeriesMaintenance(conn, { id: 22, recurring_parent_id: 10, customer_id: 5, scheduled_date: '2026-07-15' });

    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row.recurring_parent_id).toBe(10);
    expect(row.is_recurring).toBe(true);
    expect(row.recurring_ongoing).toBe(true);
    expect(row.status).toBe('pending');
    expect(row.scheduled_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.scheduled_date > '2026-07-15').toBe(true);
    // Fix (4): the extension row carries invoice-on-complete — the latest
    // non-cancelled sibling's value wins over the (false) parent template.
    expect(row.create_invoice_on_complete).toBe(true);
    // Reminder registered so the 72h/24h cron sees the new visit.
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      901, 5, expect.stringContaining('T08:00'), 'Quarterly Pest Control',
      'recurring_auto_extend', { sendConfirmation: false },
    );
  });

  test('falls back to the parent template when no sibling carries the flag', async () => {
    const { conn, inserted } = ongoingScenario({
      upcomingCount: 0,
      sibling: undefined,
      parentOverrides: { create_invoice_on_complete: true },
    });
    await runRecurringSeriesMaintenance(conn, { id: 22, recurring_parent_id: 10, customer_id: 5, scheduled_date: '2026-07-15' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].create_invoice_on_complete).toBe(true);
  });

  test('does NOT extend when 2+ visits are already upcoming', async () => {
    const { conn, inserted } = ongoingScenario({ upcomingCount: 2, sibling: undefined });
    await runRecurringSeriesMaintenance(conn, { id: 22, recurring_parent_id: 10, customer_id: 5, scheduled_date: '2026-07-15' });
    expect(inserted).toHaveLength(0);
  });

  test('rolls back when the series was stopped while processing (race re-check)', async () => {
    const { conn, inserted } = ongoingScenario({ upcomingCount: 1, sibling: undefined, stillOngoing: false });
    await runRecurringSeriesMaintenance(conn, { id: 22, recurring_parent_id: 10, customer_id: 5, scheduled_date: '2026-07-15' });
    // Pre-insert re-check reads recurring_ongoing=false → no insert at all.
    expect(inserted).toHaveLength(0);
    expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
  });
});

// Stateful scenario for the concurrency test: the upcoming count and the
// existing-dates set both reflect rows inserted so far, so a run that reads
// AFTER a prior run committed sees the fresh visit and no-ops. Starts one
// visit ahead (upcoming = 1) so the first run extends and the second must not.
function concurrentScenario() {
  const parent = {
    id: 10, customer_id: 5, is_recurring: true, recurring_pattern: 'quarterly',
    recurring_ongoing: true, scheduled_date: '2026-01-15',
    window_start: '08:00', window_end: '10:00',
    service_type: 'Quarterly Pest Control', time_window: 'morning', zone: 'A',
    estimated_duration_minutes: 60, skip_weekends: false, technician_id: 'tech-1',
    create_invoice_on_complete: false,
  };
  const inserted = [];
  const baseDates = ['2026-01-15', '2026-04-15', '2026-07-15'];
  const allDates = () => [...baseDates, ...inserted.map((d) => d.scheduled_date)];
  const handler = ({ table, calls, op, data }) => {
    if (table === 'scheduled_services') {
      if (op === 'columnInfo') return COLS;
      if (op === 'first') {
        const firstCall = calls.find((c) => c[0] === 'first');
        // upcoming count reflects the visits inserted so far.
        if (calls.some((c) => c[0] === 'count')) return { c: String(1 + inserted.length) };
        if (firstCall[1] === 'recurring_ongoing') return { recurring_ongoing: true };
        if (firstCall[1] === 'create_invoice_on_complete') return undefined;
        if (calls.some((c) => c[0] === 'orderBy')) {
          const sorted = allDates().slice().sort();
          return { scheduled_date: sorted[sorted.length - 1] };
        }
        return parent;
      }
      if (op === 'await') {
        if (calls.some((c) => c[0] === 'select' && c[1] === 'scheduled_date')) {
          return allDates().map((scheduled_date) => ({ scheduled_date }));
        }
        return [];
      }
      if (op === 'insertReturning') { const row = { id: 900 + inserted.length, ...data }; inserted.push(data); return [row]; }
      if (op === 'insert') { inserted.push(data); return [1]; }
    }
    if (table === 'scheduled_service_addons') { if (op === 'columnInfo') return {}; return []; }
    if (table === 'recurring_plan_alerts') { if (op === 'first') return null; return [1]; }
    return null;
  };
  return { handler, inserted };
}

describe('runRecurringSeriesMaintenance — concurrency (P0: no duplicate billable visits)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('two concurrent maintenance runs on the same parent insert exactly one visit', async () => {
    const { handler, inserted } = concurrentScenario();
    // Shared mutex = the per-parent pg_advisory_xact_lock: overlapping
    // transactions run one at a time, so the loser re-reads the winner's
    // committed insert (upcoming now 2) and no-ops.
    const mutex = { tail: Promise.resolve() };
    const conn = makeConn(handler, { mutex });
    await Promise.all([
      runRecurringSeriesMaintenance(conn, { id: 22, recurring_parent_id: 10, customer_id: 5, scheduled_date: '2026-07-15' }),
      runRecurringSeriesMaintenance(conn, { id: 23, recurring_parent_id: 10, customer_id: 5, scheduled_date: '2026-07-15' }),
    ]);
    expect(inserted).toHaveLength(1);
  });

  test('serialization + re-read is load-bearing: the maintenance opens a transaction and locks per parent', () => {
    // The upcoming-count / existing-dates reads must run INSIDE the locked
    // transaction, else two runs both read upcoming=1 and both insert.
    expect(src).toMatch(/pg_advisory_xact_lock\(hashtext\(\?\), hashtext\(\?::text\)\)/);
    expect(src).toContain("'recurring-series-maintenance'");
    // Plain-db callers get a transaction opened for the maintenance block;
    // a caller already inside a transaction is reused as-is.
    expect(src).toContain('conn.isTransaction');
    expect(src).toContain('await conn.transaction(runLocked)');
  });
});

describe('runRecurringSeriesMaintenance — fixed plan end-of-plan alert', () => {
  test('queues a plan_ending alert when the last fixed visit completes', async () => {
    const { conn, inserted, alertInserts } = ongoingScenario({
      upcomingCount: 0,
      sibling: undefined,
      parentOverrides: { recurring_ongoing: false },
    });
    await runRecurringSeriesMaintenance(conn, { id: 22, recurring_parent_id: 10, customer_id: 5, scheduled_date: '2026-07-15' });
    expect(inserted).toHaveLength(0);
    expect(alertInserts).toHaveLength(1);
    expect(alertInserts[0]).toMatchObject({
      recurring_parent_id: 10,
      customer_id: 5,
      alert_type: 'plan_ending',
      last_visit_date: '2026-07-15',
      remaining_visits: 0,
    });
  });

  test('no-ops on a non-recurring row', async () => {
    const handler = ({ table, op }) => {
      if (op === 'columnInfo') return COLS;
      if (op === 'first') return { id: 30, is_recurring: false };
      return null;
    };
    await expect(runRecurringSeriesMaintenance(makeConn(handler), { id: 30, customer_id: 5, scheduled_date: '2026-07-15' }))
      .resolves.toBeUndefined();
  });
});

describe('recurring-alerts derived scan — exhausted ongoing plans (source guards)', () => {
  test('scans ongoing parents with zero upcoming visits and surfaces ongoing_plan_exhausted', () => {
    expect(src).toContain("alertType: 'ongoing_plan_exhausted'");
    expect(src).toContain(".where('s.recurring_ongoing', true)");
    expect(src).toContain('.whereNotExists(function () {');
  });

  test('fixed-plan derived scan is unchanged (still excludes ongoing parents)', () => {
    expect(src).toContain("this.where('s.recurring_ongoing', false).orWhereNull('s.recurring_ongoing');");
    expect(src).toContain("alertType: 'plan_ending_soon'");
  });

  test('exhausted alerts reuse the derived-<parentId> id shape the action route parses', () => {
    // Both derived alert types must share the `derived-${plan.id}` id so
    // POST /recurring-alerts/:id/action (extend / convert_ongoing) works.
    const matches = src.match(/id: `derived-\$\{plan\.id\}`/g) || [];
    expect(matches.length).toBe(2);
  });

  test('schedule status route still runs the maintenance after completion', () => {
    expect(src).toContain('await runRecurringSeriesMaintenance(db, svc);');
  });
});
