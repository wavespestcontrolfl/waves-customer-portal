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
const { runRecurringSeriesMaintenance, runRecurringAlertAction } = adminScheduleRouter._test;
const AppointmentReminders = require('../services/appointment-reminders');
const { etDateString } = require('../utils/datetime-et');

const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

const COLS = {
  recurring_ongoing: {}, skip_weekends: {}, weekend_shift: {}, service_id: {},
  create_invoice_on_complete: {}, estimated_price: {}, is_callback: {}, discount_dollars: {},
  // Bill-To + stamped-service-address columns the refill must propagate.
  payer_id: {}, po_number: {}, self_pay_override: {},
  property_id: {}, service_address_line1: {}, service_address_line2: {},
  service_address_city: {}, service_address_state: {}, service_address_zip: {},
  lat: {}, lng: {},
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
    fn.fn = { now: () => new Date() }; // knex.fn.now() (alert resolution stamps)
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

function ongoingScenario({ upcomingCount, sibling, parentOverrides = {}, stillOngoing = true, statusAfterRegistration = 'pending' }) {
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
  const reminderWrites = [];
  const handler = ({ table, calls, op, data }) => {
    if (table === 'scheduled_services') {
      if (op === 'columnInfo') return COLS;
      if (op === 'first') {
        const firstCall = calls.find((c) => c[0] === 'first');
        if (calls.some((c) => c[0] === 'count')) return { c: String(upcomingCount) };
        if (firstCall[1] === 'recurring_ongoing') return { recurring_ongoing: stillOngoing };
        if (firstCall[1] === 'create_invoice_on_complete') return sibling;
        // Post-registration cancellation re-check reads the fresh row's
        // status — script what a concurrent series cancel left behind.
        if (firstCall[1] === 'status') {
          return statusAfterRegistration == null ? undefined : { status: statusAfterRegistration };
        }
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
    if (table === 'appointment_reminders') {
      // Only the race re-check writes here (update chains resolve via 'await').
      if (op === 'await') { reminderWrites.push(calls); return 1; }
      return null;
    }
    if (table === 'recurring_plan_alerts') {
      if (op === 'first') return null;
      if (op === 'insert' || op === 'insertReturning') { alertInserts.push(data); return [1]; }
    }
    return null;
  };
  return { conn: makeConn(handler), inserted, alertInserts, reminderWrites, parent };
}

describe('runRecurringSeriesMaintenance — ongoing auto-extend', () => {
  beforeEach(() => jest.clearAllMocks());

  test('extends an ongoing series below the 2-ahead window and propagates create_invoice_on_complete from the latest sibling', async () => {
    const { conn, inserted, reminderWrites } = ongoingScenario({
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
    // Visit still live after registration → the re-check leaves the fresh
    // reminder armed.
    expect(reminderWrites).toHaveLength(0);
  });

  test('P1: the refill inherits the parent Bill-To stamp (payer/PO) and the stamped service address', async () => {
    const { conn, inserted } = ongoingScenario({
      upcomingCount: 1,
      sibling: undefined,
      parentOverrides: {
        payer_id: 'payer-77', po_number: 'PO-4411', self_pay_override: false,
        property_id: 'prop-9',
        service_address_line1: '77 Dock St', service_address_line2: 'Unit B',
        service_address_city: 'Venice', service_address_state: 'FL',
        service_address_zip: '34285', lat: 27.0998, lng: -82.4543,
      },
    });
    await runRecurringSeriesMaintenance(conn, { id: 22, recurring_parent_id: 10, customer_id: 5, scheduled_date: '2026-07-15' });
    expect(inserted).toHaveLength(1);
    // Billing must resolve identically to the rest of the series at
    // completion (payer invoice, not the homeowner), and dispatch must roll
    // to the stamped property, not the customer's primary address.
    expect(inserted[0]).toMatchObject({
      payer_id: 'payer-77', po_number: 'PO-4411', self_pay_override: false,
      property_id: 'prop-9',
      service_address_line1: '77 Dock St', service_address_line2: 'Unit B',
      service_address_city: 'Venice', service_address_state: 'FL',
      service_address_zip: '34285', lat: 27.0998, lng: -82.4543,
    });
  });

  test('P1: an explicit self-pay override survives the refill — a customer with a default payer stays self-pay', async () => {
    const { conn, inserted } = ongoingScenario({
      upcomingCount: 1,
      sibling: undefined,
      parentOverrides: { payer_id: null, po_number: null, self_pay_override: true },
    });
    await runRecurringSeriesMaintenance(conn, { id: 22, recurring_parent_id: 10, customer_id: 5, scheduled_date: '2026-07-15' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].self_pay_override).toBe(true);
    expect(inserted[0].payer_id).toBe(null);
  });

  test('alert-route extend/convert_ongoing inserts inherit Bill-To + stamped address too (source guard)', () => {
    // The recurring-alert action route builds its extension rows through the
    // same applyStoredVisitFinancials pipeline — both spawn loops must carry
    // the Bill-To and address stamps or a payer-billed / secondary-property
    // series degrades when the operator extends it from an alert.
    const alertLegs = src.match(/copyBillToFields\(data, parent, cols\);\n\s*copyStampedServiceAddressFields\(data, parent, cols\);/g) || [];
    expect(alertLegs.length).toBe(2);
    expect(src).toContain('copyBillToFields(nextData, parent, cols);');
    expect(src).toContain('copyStampedServiceAddressFields(nextData, parent, cols);');
  });

  test('P1: a series cancel landing between the refill commit and the reminder registration cannot leave an armed reminder', async () => {
    // The cancel took the per-parent lock right after the maintenance trx
    // committed: it cancelled the fresh visit, but its reminder sweep ran
    // before the post-commit registration inserted the reminder row (and the
    // DB sync trigger fired on the visit UPDATE, also before the row
    // existed). The post-registration re-check must cancel the fresh row.
    const { conn, inserted, reminderWrites } = ongoingScenario({
      upcomingCount: 1,
      sibling: undefined,
      statusAfterRegistration: 'cancelled',
    });
    await runRecurringSeriesMaintenance(conn, { id: 22, recurring_parent_id: 10, customer_id: 5, scheduled_date: '2026-07-15' });
    expect(inserted).toHaveLength(1);
    // The reminder WAS registered (registration won no ordering guarantees)…
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalled();
    // …and the re-check then cancelled it for the terminal visit.
    expect(reminderWrites).toHaveLength(1);
    expect(reminderWrites[0]).toEqual(expect.arrayContaining([
      ['where', { scheduled_service_id: 901, cancelled: false }],
      ['update', expect.objectContaining({ cancelled: true })],
    ]));
  });

  test('alert-route extension registrations run the same terminal re-check (source guard)', () => {
    // The alert actions now commit their spawns under the maintenance lock
    // and run addon mirror + reminder registration + the terminal re-check
    // POST-COMMIT (maintenance pattern) — one loop covers both the extend
    // and convert_ongoing spawns, and it still closes the commit→
    // registration cancellation window via the shared helper.
    expect(src).toContain("cancelSpawnedReminderIfVisitTerminal(conn, row.id, 'recurring-alerts');");
    expect(src).toContain("cancelSpawnedReminderIfVisitTerminal(conn, spawnedVisit.scheduledServiceId, 'recurring');");
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

  test('P1: a cancelled FUTURE visit never anchors the next extension date — the cancelled slot is refilled', async () => {
    const parent = {
      id: 10, customer_id: 5, is_recurring: true, recurring_pattern: 'quarterly',
      recurring_ongoing: true, scheduled_date: '2026-01-15',
      window_start: '08:00', window_end: '10:00',
      service_type: 'Quarterly Pest Control', time_window: 'morning', zone: 'A',
      estimated_duration_minutes: 60, skip_weekends: false, technician_id: 'tech-1',
      create_invoice_on_complete: false,
    };
    const rows = [
      { scheduled_date: '2026-01-15', status: 'completed' },
      { scheduled_date: '2026-04-15', status: 'completed' },
      { scheduled_date: '2026-07-15', status: 'completed' },
      // Cancelled FUTURE visit. Before the fix, the latest-row query had no
      // status filter, so this row became latestStr and the extension landed
      // a full cadence past it (2027-01-15) — a quarter-long service gap.
      { scheduled_date: '2026-10-15', status: 'cancelled' },
    ];
    const inserted = [];
    const handler = ({ table, calls, op, data }) => {
      if (table === 'scheduled_services') {
        if (op === 'columnInfo') return COLS;
        if (op === 'first') {
          const firstCall = calls.find((c) => c[0] === 'first');
          if (calls.some((c) => c[0] === 'count')) return { c: '1' };
          if (firstCall[1] === 'recurring_ongoing') return { recurring_ongoing: true };
          if (firstCall[1] === 'create_invoice_on_complete') return undefined;
          if (calls.some((c) => c[0] === 'orderBy')) {
            // Emulate the DB honestly: honor a whereNotIn('status', ...)
            // filter when the query carries one, then take the latest date —
            // so this test fails if the status filter is dropped again.
            const notIn = calls.find((c) => c[0] === 'whereNotIn' && c[1] === 'status');
            const visible = notIn ? rows.filter((r) => !notIn[2].includes(r.status)) : rows;
            const sorted = visible.map((r) => r.scheduled_date).sort();
            return { scheduled_date: sorted[sorted.length - 1] };
          }
          return parent;
        }
        if (op === 'await') {
          if (calls.some((c) => c[0] === 'select' && c[1] === 'scheduled_date')) {
            // The existing-dates preload already excludes cancelled rows.
            return rows
              .filter((r) => !['cancelled', 'rescheduled'].includes(r.status))
              .map((r) => ({ scheduled_date: r.scheduled_date }));
          }
          return [];
        }
        if (op === 'insertReturning') { inserted.push(data); return [{ id: 902, ...data }]; }
        if (op === 'insert') { inserted.push(data); return [1]; }
      }
      if (table === 'scheduled_service_addons') { if (op === 'columnInfo') return {}; return []; }
      if (table === 'recurring_plan_alerts') { if (op === 'first') return null; return [1]; }
      return null;
    };
    await runRecurringSeriesMaintenance(makeConn(handler), { id: 22, recurring_parent_id: 10, customer_id: 5, scheduled_date: '2026-07-15' });
    expect(inserted).toHaveLength(1);
    // Anchored to the last LIVE visit (2026-07-15): one quarter forward
    // refills the cancelled 2026-10-15 slot instead of skipping past it.
    expect(inserted[0].scheduled_date).toBe('2026-10-15');
  });

  test('the latest-anchor query pins the cancelled/rescheduled exclusion — one shared helper, both consumers (source guard)', () => {
    // The anchor now lives in latestLiveSeriesVisit, consumed by BOTH the
    // maintenance auto-extend and the alert-action route — so the alert
    // route can never regrow the unfiltered anchor that pushed manual
    // extensions a cadence past a cancelled future visit.
    const helper = src.indexOf('function latestLiveSeriesVisit(');
    const helperEnd = src.indexOf('async function loadActiveSeriesDates(');
    expect(helper).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helper);
    const helperBody = src.slice(helper, helperEnd);
    expect(helperBody).toContain(".whereNotIn('status', ['cancelled', 'rescheduled'])");
    expect(helperBody).toContain(".orderBy('scheduled_date', 'desc')");
    expect(helperBody).toContain(".where('is_recurring', true)");
    expect((src.match(/await latestLiveSeriesVisit\(/g) || []).length).toBe(2);
    // The occupied-dates preload is shared the same way.
    expect((src.match(/await loadActiveSeriesDates\(/g) || []).length).toBe(2);
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

// Stateful scenario for the alert-action tests: series rows, the parent's
// recurring_ongoing flag, and the alert row all live in shared mutable state,
// and the handler answers the anchor / occupied-dates / upcoming-count
// queries DB-honestly (whereNotIn + status/date filters applied) — so a
// second run sees exactly what the first committed. Dates live in 2098 so
// the honest today-or-later upcoming math never rots.
function alertActionScenario({ parentOverrides = {}, seriesRows = [], alertRow = null } = {}) {
  const state = {
    parent: {
      id: 10, customer_id: 5, is_recurring: true, recurring_pattern: 'quarterly',
      recurring_ongoing: false, status: 'completed', scheduled_date: '2098-01-15',
      window_start: '08:00', window_end: '10:00',
      service_type: 'Quarterly Pest Control', time_window: 'morning', zone: 'A',
      estimated_duration_minutes: 60, skip_weekends: false, technician_id: 'tech-1',
      create_invoice_on_complete: false,
      ...parentOverrides,
    },
    alert: alertRow ? { ...alertRow } : null,
    insertedVisits: [],
    auditInserts: [],
    activityInserts: [],
    flagWrites: [],
  };
  const liveRows = () => [
    ...seriesRows,
    ...state.insertedVisits.map((v) => ({ scheduled_date: v.scheduled_date, status: v.status })),
  ];
  const today = etDateString();
  const upcomingCount = () => liveRows()
    .filter((r) => ['pending', 'confirmed'].includes(r.status) && r.scheduled_date >= today)
    .length;
  const statusVisible = (calls, rows) => {
    const notIn = calls.find((c) => c[0] === 'whereNotIn' && c[1] === 'status');
    return notIn ? rows.filter((r) => !notIn[2].includes(r.status)) : rows;
  };
  const handler = ({ table, calls, op, data }) => {
    if (table === 'scheduled_services') {
      if (op === 'columnInfo') return COLS;
      if (op === 'first') {
        const firstCall = calls.find((c) => c[0] === 'first');
        if (calls.some((c) => c[0] === 'count')) return { c: String(upcomingCount()) };
        if (firstCall[1] === 'recurring_ongoing') return { recurring_ongoing: !!state.parent.recurring_ongoing };
        if (firstCall[1] === 'create_invoice_on_complete') return undefined;
        // Post-registration terminal re-check: visit still live.
        if (firstCall[1] === 'status') return { status: 'pending' };
        if (calls.some((c) => c[0] === 'orderBy')) {
          // DB-honest anchor: honor the status filter, then latest date — so
          // these tests fail if the shared filtered anchor is dropped again.
          const sorted = statusVisible(calls, liveRows()).map((r) => r.scheduled_date).sort();
          return sorted.length ? { scheduled_date: sorted[sorted.length - 1] } : undefined;
        }
        return { ...state.parent };
      }
      if (op === 'await') {
        const update = calls.find((c) => c[0] === 'update');
        if (update) {
          state.flagWrites.push(calls);
          if (update[1] && update[1].recurring_ongoing === false) {
            let cleared = 0;
            if (state.parent.recurring_ongoing) { state.parent.recurring_ongoing = false; cleared++; }
            for (const v of state.insertedVisits) {
              if (v.recurring_ongoing) { v.recurring_ongoing = false; cleared++; }
            }
            return cleared;
          }
          if (update[1] && update[1].recurring_ongoing === true) { state.parent.recurring_ongoing = true; return 1; }
          return 1;
        }
        if (calls.some((c) => c[0] === 'select' && c[1] === 'scheduled_date')) {
          return statusVisible(calls, liveRows()).map((r) => ({ scheduled_date: r.scheduled_date }));
        }
        return [];
      }
      if (op === 'insertReturning' || op === 'insert') {
        const row = { id: 900 + state.insertedVisits.length, ...data };
        state.insertedVisits.push(data);
        return op === 'insertReturning' ? [row] : [row.id];
      }
    }
    if (table === 'scheduled_service_addons') { if (op === 'columnInfo') return {}; return []; }
    if (table === 'recurring_plan_alerts') {
      if (op === 'first') return state.alert ? { ...state.alert } : null;
      if (op === 'await') {
        const update = calls.find((c) => c[0] === 'update');
        if (update && state.alert) { Object.assign(state.alert, update[1]); return 1; }
        return 1;
      }
      if (op === 'insert' || op === 'insertReturning') { state.auditInserts.push(data); return [1]; }
    }
    if (table === 'activity_log') { state.activityInserts.push(data); return [1]; }
    return null;
  };
  return { state, handler };
}

describe('runRecurringAlertAction — locked + idempotent alert actions (P0)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('P0: two concurrent extend clicks on the same alert insert exactly ONE set of visits — the loser no-ops on the resolved alert', async () => {
    const { state, handler } = alertActionScenario({
      seriesRows: [
        { scheduled_date: '2098-01-15', status: 'completed' },
        { scheduled_date: '2098-04-15', status: 'completed' },
        { scheduled_date: '2098-07-15', status: 'completed' },
      ],
      alertRow: { id: 55, recurring_parent_id: 10, alert_type: 'plan_ending', resolved_at: null },
    });
    // Shared mutex = the per-parent maintenance advisory lock: the loser's
    // transaction re-reads the alert AFTER the winner committed its inserts
    // and stamped resolved_at, and no-ops instead of double-inserting.
    const mutex = { tail: Promise.resolve() };
    const conn = makeConn(handler, { mutex });
    const [a, b] = await Promise.all([
      runRecurringAlertAction(conn, { idParam: '55', action: 'extend', count: 1, adminUserId: 'admin-1' }),
      runRecurringAlertAction(conn, { idParam: '55', action: 'extend', count: 1, adminUserId: 'admin-1' }),
    ]);
    expect(state.insertedVisits).toHaveLength(1);
    expect(state.insertedVisits[0]).toMatchObject({
      recurring_parent_id: 10, is_recurring: true, status: 'pending',
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const bodies = [a.body, b.body];
    expect(bodies.filter((x) => x.created === 1)).toHaveLength(1);
    expect(bodies.filter((x) => x.alreadyResolved && x.created === 0)).toHaveLength(1);
    expect(state.alert.resolved_action).toBe('extend');
    // Exactly one reminder registered (post-commit), for the one insert.
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledTimes(1);
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      900, 5, expect.stringContaining('T08:00'), 'Quarterly Pest Control',
      'recurring_alert_action', { sendConfirmation: false },
    );
  });

  test('P0: let_lapse on an exhausted ONGOING plan clears recurring_ongoing series-wide in the locked trx — and a later stale completion cannot re-extend or re-bill', async () => {
    const seriesRows = [
      { scheduled_date: '2098-01-15', status: 'completed' },
      { scheduled_date: '2098-04-15', status: 'completed' },
      { scheduled_date: '2098-07-15', status: 'completed' },
    ];
    // Control: with the flag still set, completing a stale retained visit
    // DOES auto-extend — this is the re-bill chain let_lapse must disarm.
    const armed = alertActionScenario({ parentOverrides: { recurring_ongoing: true }, seriesRows });
    await runRecurringSeriesMaintenance(makeConn(armed.handler), {
      id: 22, recurring_parent_id: 10, customer_id: 5, scheduled_date: '2098-07-15',
    });
    expect(armed.state.insertedVisits).toHaveLength(1);

    // let_lapse (derived ongoing_plan_exhausted id) stops the plan…
    const { state, handler } = alertActionScenario({ parentOverrides: { recurring_ongoing: true }, seriesRows });
    const conn = makeConn(handler);
    const out = await runRecurringAlertAction(conn, { idParam: 'derived-10', action: 'let_lapse', count: undefined, adminUserId: 'admin-1' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ success: true, action: 'let_lapse', created: 0 });
    expect(state.insertedVisits).toHaveLength(0);
    expect(state.parent.recurring_ongoing).toBe(false);
    // …series-wide (parent OR children) and only rows still flagged, in the
    // same locked transaction as the alert resolution.
    const clear = state.flagWrites.find((calls) => calls.some((c) => c[0] === 'update' && c[1] && c[1].recurring_ongoing === false));
    expect(clear).toBeDefined();
    expect(clear).toEqual(expect.arrayContaining([
      ['whereFn', [['where', 'id', 10], ['orWhere', 'recurring_parent_id', 10]]],
      ['where', 'recurring_ongoing', true],
    ]));
    // Resolution audit row + the plan-stop activity stamp.
    expect(state.auditInserts).toHaveLength(1);
    expect(state.auditInserts[0]).toMatchObject({ recurring_parent_id: 10, resolved_action: 'let_lapse' });
    expect(state.activityInserts).toHaveLength(1);
    expect(state.activityInserts[0]).toMatchObject({ action: 'recurring_plan_stopped', customer_id: 5 });

    // …so the derived exhausted scan (pinned above: requires
    // recurring_ongoing=true) can no longer resurrect the alert, and the
    // stale completion now takes the FIXED branch: an alert at most, never a
    // fresh billable visit.
    await runRecurringSeriesMaintenance(makeConn(handler), {
      id: 22, recurring_parent_id: 10, customer_id: 5, scheduled_date: '2098-07-15',
    });
    expect(state.insertedVisits).toHaveLength(0);
  });

  test('let_lapse on a FIXED plan stays a pure alert-resolve (no flag rows matched, no stop stamp)', async () => {
    const { state, handler } = alertActionScenario({
      seriesRows: [{ scheduled_date: '2098-07-15', status: 'completed' }],
      alertRow: { id: 56, recurring_parent_id: 10, alert_type: 'plan_ending', resolved_at: null },
    });
    const out = await runRecurringAlertAction(makeConn(handler), { idParam: '56', action: 'let_lapse', count: undefined, adminUserId: null });
    expect(out.status).toBe(200);
    expect(state.insertedVisits).toHaveLength(0);
    expect(state.alert.resolved_action).toBe('let_lapse');
    // The clear matched zero rows (recurring_ongoing already false), so no
    // plan-stop activity line is written — fixed plans have no auto-extend
    // exposure to disarm (the maintenance fixed branch only inserts alerts).
    expect(state.activityInserts).toHaveLength(0);
  });

  test('P1: a cancelled FUTURE visit never anchors the alert-route extension — the cancelled slot is refilled', async () => {
    const { state, handler } = alertActionScenario({
      seriesRows: [
        { scheduled_date: '2098-01-15', status: 'completed' },
        { scheduled_date: '2098-04-15', status: 'completed' },
        { scheduled_date: '2098-07-15', status: 'completed' },
        // Before the fix the alert route's anchor had no status filter, so
        // this row anchored the extension and pushed it to 2099-01-15 — a
        // quarter-long gap instead of refilling the cancelled slot.
        { scheduled_date: '2098-10-15', status: 'cancelled' },
      ],
      alertRow: { id: 57, recurring_parent_id: 10, alert_type: 'plan_ending', resolved_at: null },
    });
    const out = await runRecurringAlertAction(makeConn(handler), { idParam: '57', action: 'extend', count: 1, adminUserId: null });
    expect(out.status).toBe(200);
    expect(out.body.created).toBe(1);
    expect(state.insertedVisits).toHaveLength(1);
    expect(state.insertedVisits[0].scheduled_date).toBe('2098-10-15');
  });

  test('a series cancelled before the click is refused under the lock (409), inserting nothing', async () => {
    const { state, handler } = alertActionScenario({
      parentOverrides: { status: 'cancelled' },
      seriesRows: [{ scheduled_date: '2098-07-15', status: 'cancelled' }],
      alertRow: { id: 58, recurring_parent_id: 10, alert_type: 'plan_ending', resolved_at: null },
    });
    const out = await runRecurringAlertAction(makeConn(handler), { idParam: '58', action: 'extend', count: 2, adminUserId: null });
    expect(out.status).toBe(409);
    expect(state.insertedVisits).toHaveLength(0);
    expect(state.alert.resolved_at).toBeNull();
  });

  test('derived ids recompute the derived-scan condition under the lock — a concurrent refill makes the second click a no-op', async () => {
    // Ongoing plans derive (ongoing_plan_exhausted) only at ZERO upcoming
    // visits: a pending future visit — e.g. a concurrent click's insert or
    // the auto-extend — means the alert condition is gone.
    const { state, handler } = alertActionScenario({
      parentOverrides: { recurring_ongoing: true },
      seriesRows: [
        { scheduled_date: '2098-04-15', status: 'completed' },
        { scheduled_date: '2098-10-15', status: 'pending' },
      ],
    });
    const out = await runRecurringAlertAction(makeConn(handler), { idParam: 'derived-10', action: 'extend', count: 4, adminUserId: null });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ success: true, created: 0, alreadyResolved: true });
    expect(state.insertedVisits).toHaveLength(0);
    expect(state.auditInserts).toHaveLength(0);
  });

  test('alert actions run under the SAME per-parent maintenance lock, every dependent read after it (source guard)', () => {
    const core = src.indexOf('async function runRecurringAlertAction(');
    const routePost = src.indexOf("router.post('/recurring-alerts/:id/action'");
    expect(core).toBeGreaterThan(-1);
    expect(routePost).toBeGreaterThan(core);
    const body = src.slice(core, routePost);
    const lock = body.indexOf('await acquireRecurringSeriesMaintenanceLock(trx, parentId);');
    expect(lock).toBeGreaterThan(-1);
    // Anchor, occupied-dates preload, and the insert loops all sit after the
    // lock inside the locked transaction — nothing the writes depend on is
    // read unlocked anymore.
    for (const marker of [
      'await latestLiveSeriesVisit(trx, parentId)',
      'await loadActiveSeriesDates(trx, parentId)',
      "await trx('scheduled_services').insert(data).returning('*')",
    ]) {
      expect(body.indexOf(marker)).toBeGreaterThan(lock);
    }
    // The route handler delegates to the locked core.
    expect(src.slice(routePost)).toContain('await runRecurringAlertAction(db, {');
    // Byte-identical key derivation with the maintenance wrapper + dispatch
    // cancel lives in the shared helper.
    expect(src).toContain("['recurring-series-maintenance', String(parentId)],");
    expect((src.match(/await acquireRecurringSeriesMaintenanceLock\(trx, parentId\);/g) || []).length).toBe(2);
  });
});
