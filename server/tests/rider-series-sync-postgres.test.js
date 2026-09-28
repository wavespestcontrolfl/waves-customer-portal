// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// Rider-series core (pest-rides-the-lawn-rhythm PR 1) — proves
// syncRiderSeries actually lands a quarterly-pest rider on every 2nd date
// of a lawn every_6_weeks host, using the REAL seeder to build both series
// and the REAL completion auto-extend path for the host-gains-a-row case.
//
// The key fail-without-fix evidence: seedFollowUpsForParent seeds the pest
// series on its OWN quarterly cadence (~91-day steps) — assertPestRow*
// helpers below confirm the freshly-seeded rows sit on THOSE dates, not on
// the lawn's dates, before syncRiderSeries ever runs. Only after
// syncRiderSeries do the pest dates move onto the lawn's every-2nd date.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
// gates.visitGroups / gates.editApptPriceServiceScope are each evaluated
// once at module load (config/feature-gates.js is not a getter for either)
// — must be set before that module is first required, including
// transitively. editApptPriceServiceScope gates overlayRecurringTemplateOverrides
// (recurring_template_overrides), exercised by this file's own P1 fix #1
// coverage.
process.env.GATE_VISIT_GROUPS = 'true';
process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = 'true';

jest.mock('../services/appointment-reminders', () => ({
  registerAppointment: jest.fn().mockResolvedValue(undefined),
  resolveCommittedVisitTime: jest.fn(async (id, { date, windowStart } = {}) => (
    date ? { appointmentTime: `${date}T${windowStart || '08:00'}`, windowless: !windowStart } : null
  )),
  alertRegistrationFailure: jest.fn().mockResolvedValue(undefined),
  handleReschedule: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async () => ({ synthesized: true, billingType: null })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'synthetic-notification' })) }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/dispatch-alerts', () => ({ autoResolveOverdueAlertsForJob: jest.fn(async () => {}) }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyVisitCancelled: jest.fn(async () => {}) }));
jest.mock('../services/invoice', () => ({
  voidOpenInvoicesForCancelledService: jest.fn(async () => {}),
  createFromService: jest.fn(async () => null),
  // Real query-builder shape (services/invoice.js's own contract: "Returns
  // a query builder") — the P1 fix #3 cancellation follow-through test
  // exercises the REAL runVisitCancellationFollowThrough, which calls
  // `.first('id')` on this return value directly.
  unresolvedInvoicesForCancelledService: jest.fn((conn, scheduledServiceId) => (
    conn('invoices').where({ scheduled_service_id: scheduledServiceId })
  )),
}));
jest.mock('../services/typed-followup-obligation', () => ({
  handleFollowupChildCancellation: jest.fn(async () => {}),
  handleFollowupChildRevival: jest.fn(async () => {}),
}));
jest.mock('../services/scheduling/quality-after-change', () => ({ refreshScheduleQualityAfterChange: jest.fn(async () => {}) }));

jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  Object.defineProperty(db, 'client', { get: () => db.connection.client });
  return db;
});

const { randomUUID } = require('node:crypto');
const knex = require('knex');

const RECURRING_APPOINTMENT_SEEDER = require('../services/recurring-appointment-seeder');
const { planRiderDates, _internals: { computeRiderHorizon } } = require('../services/rider-series');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

// A row landing on a host date can become a LATER anchor the instant it
// gets grouped onto that host's visit (visit_id — immovable), which can in
// turn extend the rider's own standalone horizon past what an earlier sync
// pass already covered (P1 fix #3 — computeRiderHorizon). Convergence can
// therefore take more than one pass; this repeats until a pass makes no
// further writes (bounded, same idiom the nightly reconcile relies on).
async function syncUntilStable(riderParentId, trx, maxPasses = 6) {
  const { syncRiderSeries } = require('../services/rider-series');
  let last = null;
  for (let i = 0; i < maxPasses; i++) {
    last = await syncRiderSeries(trx, riderParentId, { dryRun: false });
    if (!last.move.length && !last.insert.length && !last.cancel.length) break;
  }
  return last;
}

// Mirrors syncRiderSeries' own anchor rule (buildRiderSyncPlan) closely
// enough for these controlled fixtures (no card holds/invoices/messaging
// involved): the latest date among completed-or-visit_id-grouped rows,
// else the earliest row's own date.
function effectiveAnchor(rows) {
  let anchor = null;
  for (const r of rows) {
    const d = r.scheduled_date.toISOString().slice(0, 10);
    if ((r.status === 'completed' || r.visit_id != null) && (!anchor || d > anchor)) anchor = d;
  }
  if (anchor) return anchor;
  return rows.map((r) => r.scheduled_date.toISOString().slice(0, 10)).sort()[0];
}

function addDays(dateStr, days) {
  return etDateString(addETDays(parseETDateTime(`${dateStr}T12:00`), days));
}

jest.setTimeout(30000);

postgres('rider-series sync against migrated PostgreSQL', () => {
  let database;
  let trx;
  let customerId;
  const LAWN_START = '2098-01-08'; // a Thursday, safely in the future
  const PEST_START = '2098-01-08'; // same customer, same start (both series accepted together)

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!localCI && !ownedQA && !privateQa) throw new Error("Use disposable CI or this worktree's private QA database");
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Rider-series', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `+1941555${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer',
    });
  });

  // isCompleted() guard: one test below (the P1 fix #3 cancellation
  // follow-through test) deliberately COMMITS trx instead of rolling it
  // back — the follow-through is deferred to the OUTER transaction's real
  // commit (syncRiderSeries's own commitPromiseOf wiring), which a
  // rollback-only harness can never observe within the test body. A
  // second rollback() on an already-completed transaction throws.
  //
  // Explicit-error rollback (P1 fix #3's own commitPromiseOf wiring):
  // Knex's doNotRejectOnRollback default (transaction.js) RESOLVES
  // executionPromise on a bare rollback() with no error — same hazard
  // annual-prepay-renewals.js's fileCoverageExceptionAfterCommit comment
  // documents and works around the same way. Every OTHER test in this file
  // rolls trx back (never commits), and several incidentally produce a
  // real rider cancel in the course of proving something else — a bare
  // rollback would let syncRiderSeries's commitPromiseOf-deferred
  // cancellation follow-through believe THAT rollback was a commit and
  // fire for real against this file's own shared, reassigned `db.connection`
  // mock (whatever trx is live in a LATER test by the time the deferred
  // callback's async chain actually runs) — cross-test interference this
  // suite's per-test isolation must never allow. Passing an explicit error
  // forces the rejection instead, so commitPromiseOf's own `.catch(() =>
  // {})` in rider-series.js correctly treats every ordinary rollback here
  // as "nothing to follow through on."
  afterEach(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback(new Error('rider-series-sync-postgres.test.js: per-test rollback')).catch(() => {});
    jest.clearAllMocks();
  });
  afterAll(async () => { await database?.destroy(); });

  // Polls until `fn` returns a truthy value or the budget expires — used
  // only by the P1 fix #3 test, whose assertion depends on the
  // post-commit-deferred cancellation follow-through actually running
  // (a real async DB round trip triggered off trx's executionPromise,
  // not something a single microtask tick guarantees has finished).
  async function waitFor(fn, { timeoutMs = 5000, intervalMs = 25 } = {}) {
    const start = Date.now();
    for (;;) {
      const result = await fn();
      if (result) return result;
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
      await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
    }
  }

  // window_start/window_end in minutes — a real host row's own
  // estimated_duration_minutes always matches its stored window span (every
  // booking writer derives one from the other), and normalizeTopUpWindow
  // (admin-schedule.js) trusts THIS field to re-derive a window's end,
  // never the stored window_end directly (see its own header) — an
  // inconsistent fixture duration would make a plain re-window (no
  // flooring needed) look "stale" and silently rewrite the end.
  function minutesBetween(startStr, endStr) {
    const [sh, sm] = String(startStr || '').split(':').map(Number);
    const [eh, em] = String(endStr || '').split(':').map(Number);
    if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return null;
    return (eh * 60 + em) - (sh * 60 + sm);
  }

  async function makeParent({ pattern, scheduledDate, technicianId = null, windowStart = '08:00', windowEnd = '10:00' }) {
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: pattern === 'every_6_weeks' ? 'Lawn Care' : 'Pest Control',
      status: 'pending', scheduled_date: scheduledDate, window_start: windowStart, window_end: windowEnd,
      technician_id: technicianId, is_recurring: true, recurring_pattern: pattern, recurring_ongoing: true,
      source: 'admin', estimated_duration_minutes: minutesBetween(windowStart, windowEnd),
    }).returning('*');
    return row;
  }

  async function seedChildren(parent, pattern, plannedCount) {
    return RECURRING_APPOINTMENT_SEEDER.seedFollowUpsForParent(trx, parent, { pattern, plannedCount });
  }

  async function seriesRows(parentId) {
    return trx('scheduled_services')
      .where((q) => { q.where('id', parentId).orWhere('recurring_parent_id', parentId); })
      .orderBy('scheduled_date', 'asc');
  }

  // Grouping is a separate, correct immovability rule tested elsewhere (see
  // "a rider row lands in the SAME visit as its host row"). A test that
  // targets the diff/move/refresh machinery in isolation needs it OFF for
  // every row this customer's series ever produces — nulling a row's own
  // property_id once is not durable against the canonical writer
  // (insertSeriesOccurrenceLocked, admin-schedule.js, PR #5268 round-3
  // structural fix): every fresh insert calls anchorSoleProperty itself,
  // which LAZILY BACKFILLS a customer_properties row from customers.
  // address_line1 the first time anything resolves it and re-anchors every
  // later insert to that same resolved property (customer-properties.js's
  // own comment: "the primary is created LAZILY... on the first read that
  // backfills"). An inactive PRIMARY row heads that off permanently:
  // ensurePrimaryCore only checks is_primary existence (any active state)
  // before deciding whether to create one, so this customer never gets an
  // active primary and every anchorSoleProperty call for it returns null,
  // for the rest of this test — including inserts a LATER sync pass makes,
  // which per-row nulling cannot reach in advance.
  async function disablePropertyAnchoring() {
    // A prior seedChildren call on this customer (the lawn host's own
    // children) may already have lazily backfilled an ACTIVE primary —
    // deactivate it rather than blind-inserting a second is_primary row,
    // which the one-primary-per-customer unique index refuses.
    const existingPrimary = await trx('customer_properties').where({ customer_id: customerId, is_primary: true }).first('id');
    if (existingPrimary) {
      await trx('customer_properties').where({ id: existingPrimary.id }).update({ active: false });
      return;
    }
    await trx('customer_properties').insert({
      id: randomUUID(), customer_id: customerId, is_primary: true, active: false,
      address_line1: '100 Test Lane', city: 'Test City', state: 'FL', zip: '00000',
    });
  }

  test('pest seeds on its own quarterly cadence before any sync (fail-without-fix evidence)', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await seedChildren(pestParent, 'quarterly', 4);

    const pestDatesBefore = (await seriesRows(pestParent.id)).map((r) => r.scheduled_date.toISOString().slice(0, 10));
    // Without the fix, pest rows walk their OWN quarterly cadence — a
    // constant ~91-day gap, never the rider's every-2nd-lawn-visit (84-day)
    // gap. (An occasional coincidental date COLLISION with a lawn date is
    // possible at the 42/91-day LCM — the gap is the real signal.)
    const gaps = [];
    for (let i = 1; i < pestDatesBefore.length; i++) gaps.push(daysBetween(pestDatesBefore[i - 1], pestDatesBefore[i]));
    expect(gaps.length).toBeGreaterThan(0);
    for (const g of gaps) {
      expect(g).toBeGreaterThan(80);
      expect(g).not.toBe(84); // the rider's own fallback gap — never produced by the plain quarterly walk
    }
  });

  test('syncRiderSeries moves pest onto every 2nd lawn date, with the lawn window/tech; dry run writes nothing; second sync is a no-op', async () => {
    const { syncRiderSeries } = require('../services/rider-series');
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId, windowStart: '09:00', windowEnd: '11:00' });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await seedChildren(pestParent, 'quarterly', 4);
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });

    const lawnRows = await seriesRows(lawnParent.id);
    const lawnDates = lawnRows.map((r) => r.scheduled_date.toISOString().slice(0, 10)).sort();
    // Expected: every 2nd lawn date starting from the anchor (the pest
    // parent's own start date, which equals the lawn's own start date here).
    const expected = planRiderDates({
      hostDates: lawnDates.filter((d) => d > LAWN_START),
      lastRiderDate: PEST_START,
      horizonDate: lawnDates[lawnDates.length - 1],
    });
    expect(expected.length).toBeGreaterThan(0);
    for (const d of expected) expect(lawnDates).toContain(d);

    const dry = await syncRiderSeries(trx, pestParent.id, { dryRun: true });
    expect(dry.insert.length + dry.move.length).toBeGreaterThan(0);
    const pestRowsAfterDry = await seriesRows(pestParent.id);
    // Dry run wrote nothing: same row count and dates as before.
    const pestDatesAfterDry = pestRowsAfterDry.map((r) => r.scheduled_date.toISOString().slice(0, 10)).sort();
    const pestDatesBeforeSync = (await seriesRows(pestParent.id)).map((r) => r.scheduled_date.toISOString().slice(0, 10)).sort();
    expect(pestDatesAfterDry).toEqual(pestDatesBeforeSync);

    const applied = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(applied.insert.length + applied.move.length).toBeGreaterThan(0);

    const pestRowsAfter = await seriesRows(pestParent.id);
    const movableAfter = pestRowsAfter.filter((r) => r.scheduled_date.toISOString().slice(0, 10) > PEST_START);
    for (const row of movableAfter) {
      const d = row.scheduled_date.toISOString().slice(0, 10);
      expect(lawnDates).toContain(d);
      const hostRow = lawnRows.find((r) => r.scheduled_date.toISOString().slice(0, 10) === d);
      expect(String(row.window_start)).toBe(String(hostRow.window_start));
      expect(String(row.technician_id)).toBe(String(hostRow.technician_id));
    }

    // Idempotence: once the plan converges, a further sync with nothing
    // else changed returns no moves/inserts/cancels. A single pass may not
    // be the last word (see syncUntilStable's own comment) — assert BOTH
    // that convergence happens within the bound AND that the pass right
    // after it is a true no-op.
    const stable = await syncUntilStable(pestParent.id, trx);
    expect(stable.move).toEqual([]);
    expect(stable.insert).toEqual([]);
    expect(stable.cancel).toEqual([]);
    const second = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(second.move).toEqual([]);
    expect(second.insert).toEqual([]);
    expect(second.cancel).toEqual([]);
  });

  test('an immovable pest row (invoice linked) stays put and the plan re-anchors from it', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await seedChildren(pestParent, 'quarterly', 4);
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });

    const { syncRiderSeries } = require('../services/rider-series');
    await syncRiderSeries(trx, pestParent.id, { dryRun: false });

    // Pick the pest row that's now furthest out and invoice it — it becomes
    // an immovable anchor.
    const pestRowsAfterFirstSync = await seriesRows(pestParent.id);
    const anchorRow = pestRowsAfterFirstSync[pestRowsAfterFirstSync.length - 1];
    await trx('invoices').insert({
      id: randomUUID(), token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 24)}`,
      customer_id: customerId, status: 'sent', scheduled_service_id: anchorRow.id,
    });

    // Move the invoiced row's date backward via a raw update (simulating a
    // stale plan) so the next sync must actively decide to leave it alone.
    const anchorDateStr = anchorRow.scheduled_date.toISOString().slice(0, 10);

    const plan = await syncRiderSeries(trx, pestParent.id, { dryRun: true });
    // The invoiced row must never appear as a move source or a cancel target.
    expect(plan.move.some((m) => m.id === anchorRow.id)).toBe(false);
    expect(plan.cancel.some((c) => c.id === anchorRow.id)).toBe(false);

    await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    const anchorStillThere = await trx('scheduled_services').where({ id: anchorRow.id }).first('scheduled_date', 'status');
    expect(anchorStillThere.scheduled_date.toISOString().slice(0, 10)).toBe(anchorDateStr);
    expect(anchorStillThere.status).not.toBe('cancelled');
  });

  test('host auto-extend (real completion path) adds the matching pest row; the pest\'s own completion never walks its own interval', async () => {
    const adminScheduleRouter = require('../routes/admin-schedule');
    const { runRecurringSeriesMaintenance } = adminScheduleRouter._test;
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 2); // small plan so upcomingCount < 2 is easy to hit
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await seedChildren(pestParent, 'quarterly', 4);
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });
    await require('../services/rider-series').syncRiderSeries(trx, pestParent.id, { dryRun: false });

    // Future-only (excludes the anchor's own date), the same basis
    // futurePestDatesAfter/expectedPlanAfterExtend below use — an
    // apples-to-apples "the host's extension never shrinks the plan" check.
    const pestRowsBefore = await seriesRows(pestParent.id);
    const anchorBefore = effectiveAnchor(pestRowsBefore);
    const pestDatesBefore = new Set(
      pestRowsBefore
        .filter((r) => r.status !== 'cancelled' && r.scheduled_date.toISOString().slice(0, 10) > anchorBefore)
        .map((r) => r.scheduled_date.toISOString().slice(0, 10)),
    );

    // Complete the lawn parent's own first visit — upcomingCount for the
    // lawn series is now low, triggering its own-interval auto-extend.
    await trx('scheduled_services').where({ id: lawnParent.id }).update({ status: 'completed', completed_at: new Date() });
    await runRecurringSeriesMaintenance(trx, { ...lawnParent, status: 'completed' });

    const lawnRowsAfter = await seriesRows(lawnParent.id);
    const newestLawnDate = lawnRowsAfter[lawnRowsAfter.length - 1].scheduled_date.toISOString().slice(0, 10);
    expect(newestLawnDate > LAWN_START).toBe(true);

    // The host's own extension should have pulled a rider sync through
    // (this tiny 3-visit lawn horizon means the rider's plan can
    // legitimately still include a standalone fallback date — the host
    // has too few visits to cover the whole rider horizon). A single
    // syncRidersOfHost pass may not be the last word: a row landing on a
    // host date auto-anchors to this shared QA database's sole property
    // and groups onto the host's visit (visit_id — immovable), which can
    // itself become a LATER anchor and extend the rider's own standalone
    // horizon past what this one pass already covered (P1 fix #3) — so
    // converge first. The oracle for "did this land correctly" is
    // planRiderDates itself (via computeRiderHorizon, the SAME horizon rule
    // the engine uses), recomputed off the CURRENT lawn dates and the
    // CURRENT (possibly-advanced) anchor, not a blanket "must be a lawn
    // date" or a horizon fixed at PEST_START.
    await syncUntilStable(pestParent.id, trx);
    const pestRowsAfter = await seriesRows(pestParent.id);
    const lawnDatesAfter = lawnRowsAfter.map((r) => r.scheduled_date.toISOString().slice(0, 10)).sort();
    const anchorAfterExtend = effectiveAnchor(pestRowsAfter);
    const horizonAfterExtend = computeRiderHorizon(
      anchorAfterExtend, lawnDatesAfter.filter((d) => d > anchorAfterExtend), 'quarterly',
    );
    const expectedPlanAfterExtend = planRiderDates({
      hostDates: lawnDatesAfter.filter((d) => d > anchorAfterExtend),
      lastRiderDate: anchorAfterExtend,
      horizonDate: horizonAfterExtend,
    });
    // Cancelled rows (an earlier sync pass's own surplus cleanup, before
    // the host had any date far enough out to plan against) are history,
    // not part of the live series, and are excluded here same as the plan
    // itself only concerns live rows.
    const futurePestDatesAfter = pestRowsAfter
      .filter((r) => r.status !== 'cancelled' && r.scheduled_date.toISOString().slice(0, 10) > anchorAfterExtend)
      .map((r) => r.scheduled_date.toISOString().slice(0, 10))
      .sort();
    expect(futurePestDatesAfter).toEqual(expectedPlanAfterExtend);
    expect(futurePestDatesAfter.length).toBeGreaterThanOrEqual(pestDatesBefore.size);

    // Now complete the pest parent's own visit and run the SAME maintenance
    // path on it — it must NOT spawn an own-interval (~91-day) child; the
    // series must still match the SAME plan oracle recomputed the same way.
    await trx('scheduled_services').where({ id: pestParent.id }).update({ status: 'completed', completed_at: new Date() });
    await runRecurringSeriesMaintenance(trx, { ...pestParent, status: 'completed' });
    await syncUntilStable(pestParent.id, trx);
    const afterRows = await seriesRows(pestParent.id);
    const anchorFinal = effectiveAnchor(afterRows);
    const horizonFinal = computeRiderHorizon(anchorFinal, lawnDatesAfter.filter((d) => d > anchorFinal), 'quarterly');
    const expectedPlanFinal = planRiderDates({
      hostDates: lawnDatesAfter.filter((d) => d > anchorFinal),
      lastRiderDate: anchorFinal,
      horizonDate: horizonFinal,
    });
    const futurePestDatesFinal = afterRows
      .filter((r) => r.status !== 'cancelled' && r.scheduled_date.toISOString().slice(0, 10) > anchorFinal)
      .map((r) => r.scheduled_date.toISOString().slice(0, 10))
      .sort();
    expect(futurePestDatesFinal).toEqual(expectedPlanFinal);
  });

  test('a failed immovable-lookup query aborts the sync — nothing moved, inserted, or cancelled', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await seedChildren(pestParent, 'quarterly', 4);
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });

    const before = (await seriesRows(pestParent.id))
      .map((r) => ({ id: r.id, date: r.scheduled_date.toISOString().slice(0, 10), status: r.status }));

    const { syncRiderSeries } = require('../services/rider-series');
    // Force the invoices lookup (one of the batched immovable-row queries)
    // to fail. DDL inside a transaction is fully transactional — restored
    // before this test ends regardless of outcome.
    await trx.raw('ALTER TABLE invoices RENAME TO invoices_disabled_for_test');
    let result;
    try {
      result = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    } finally {
      await trx.raw('ALTER TABLE invoices_disabled_for_test RENAME TO invoices');
    }

    expect(result.skipped).toBe('error');
    expect(result.move).toEqual([]);
    expect(result.insert).toEqual([]);
    expect(result.cancel).toEqual([]);

    const after = (await seriesRows(pestParent.id))
      .map((r) => ({ id: r.id, date: r.scheduled_date.toISOString().slice(0, 10), status: r.status }));
    expect(after).toEqual(before);
  });

  test('a rider row with a visit_id set is immovable — never moved or cancelled', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await seedChildren(pestParent, 'quarterly', 4);
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });

    const pestRows = await seriesRows(pestParent.id);
    const grouped = pestRows.find((r) => r.scheduled_date.toISOString().slice(0, 10) > PEST_START);
    const groupedDate = grouped.scheduled_date.toISOString().slice(0, 10);
    const [visit] = await trx('service_visits').insert({
      id: randomUUID(), customer_id: customerId, scheduled_date: grouped.scheduled_date, stop_base_key: 'synthetic-stop', created_by: 'test',
    }).returning('*');
    await trx('scheduled_services').where({ id: grouped.id }).update({ visit_id: visit.id });

    const { syncRiderSeries } = require('../services/rider-series');
    const plan = await syncRiderSeries(trx, pestParent.id, { dryRun: true });
    expect(plan.move.some((m) => m.id === grouped.id)).toBe(false);
    expect(plan.cancel.some((c) => c.id === grouped.id)).toBe(false);

    await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    const stillThere = await trx('scheduled_services').where({ id: grouped.id }).first('scheduled_date', 'status', 'visit_id');
    expect(stillThere.scheduled_date.toISOString().slice(0, 10)).toBe(groupedDate);
    expect(stillThere.status).not.toBe('cancelled');
    expect(String(stillThere.visit_id)).toBe(String(visit.id));
  });

  test('a rider row scheduled within the next 7 days is immovable regardless of other signals', async () => {
    const today = etDateString();
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    // Host has no date the rider's own rule could ever reach from `today`
    // (200 days out) — isolates the near-term rule from the ordinary
    // host-date-matching path; any effect proven here is the 7-day rule
    // alone.
    const hostStart = addDays(today, 200);
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: hostStart, technicianId: lawnTechId });
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: today });
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });
    // A movable-looking pest row 3 days out, matching no planned date (the
    // plan's first candidate lands ~84+ days from `today`) — must be left
    // alone anyway because it's inside the 7-day window.
    const nearTermDate = addDays(today, 3);
    const [nearTermRow] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Pest Control', status: 'pending',
      scheduled_date: nearTermDate, is_recurring: true, recurring_pattern: 'quarterly',
      recurring_parent_id: pestParent.id, recurring_ongoing: true, source: 'admin',
    }).returning('*');

    const { syncRiderSeries } = require('../services/rider-series');
    const plan = await syncRiderSeries(trx, pestParent.id, { dryRun: true });
    expect(plan.move.some((m) => m.id === nearTermRow.id)).toBe(false);
    expect(plan.cancel.some((c) => c.id === nearTermRow.id)).toBe(false);

    await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    const stillThere = await trx('scheduled_services').where({ id: nearTermRow.id }).first('scheduled_date', 'status');
    expect(stillThere.scheduled_date.toISOString().slice(0, 10)).toBe(nearTermDate);
    expect(stillThere.status).not.toBe('cancelled');
  });

  test('a rider row lands in the SAME visit as its host row (GATE_VISIT_GROUPS)', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const [property] = await trx('customer_properties').insert({ id: randomUUID(), customer_id: customerId }).returning('*');
    const [lawnService] = await trx('services').insert({
      id: randomUUID(), service_key: `synthetic_lawn_${randomUUID().slice(0, 8)}`, name: 'Synthetic Lawn Care',
      groupable: true, group_family: 'recurring_property_service',
    }).returning('*');
    const [pestService] = await trx('services').insert({
      id: randomUUID(), service_key: `synthetic_pest_${randomUUID().slice(0, 8)}`, name: 'Synthetic Pest Control',
      groupable: true, group_family: 'recurring_property_service',
    }).returning('*');

    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await trx('scheduled_services').where({ id: lawnParent.id }).update({ service_id: lawnService.id, property_id: property.id });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    await trx('scheduled_services')
      .where((q) => { q.where('id', lawnParent.id).orWhere('recurring_parent_id', lawnParent.id); })
      .update({ property_id: property.id, service_id: lawnService.id });

    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await trx('scheduled_services').where({ id: pestParent.id })
      .update({ service_id: pestService.id, property_id: property.id, rides_parent_id: lawnParent.id });
    await seedChildren(pestParent, 'quarterly', 4);
    await trx('scheduled_services')
      .where((q) => { q.where('id', pestParent.id).orWhere('recurring_parent_id', pestParent.id); })
      .update({ property_id: property.id, service_id: pestService.id });

    const { syncRiderSeries } = require('../services/rider-series');
    await syncRiderSeries(trx, pestParent.id, { dryRun: false });

    const lawnRows = await seriesRows(lawnParent.id);
    const pestRows = await seriesRows(pestParent.id);
    const matched = pestRows.filter((r) => r.scheduled_date.toISOString().slice(0, 10) > PEST_START && r.status !== 'cancelled');
    expect(matched.length).toBeGreaterThan(0);
    for (const pestRow of matched) {
      const d = pestRow.scheduled_date.toISOString().slice(0, 10);
      const hostRow = lawnRows.find((r) => r.scheduled_date.toISOString().slice(0, 10) === d);
      expect(hostRow).toBeTruthy();
      expect(pestRow.visit_id).not.toBeNull();
      expect(String(pestRow.visit_id)).toBe(String(hostRow.visit_id));
      const visit = await trx('service_visits').where({ id: pestRow.visit_id }).first();
      expect(visit).toBeTruthy();
      expect(visit.status).toBe('open');
    }
  });

  // Wraps a real (sub)transaction so the FIRST .first() lookup of
  // `targetId` on scheduled_services answers with a STALE snapshot whose
  // rides_parent_id is `staleHostId` — simulating a concurrent admin edit
  // that repointed the link between syncRiderSeries's pre-lock peek and its
  // locked re-read. Every other read/write passes through to the real sp.
  function wrapForStalePeek(sp, targetId, staleHostId) {
    let seen = false;
    const wrapped = (table) => {
      const qb = sp(table);
      if (table !== 'scheduled_services') return qb;
      const originalFirst = qb.first.bind(qb);
      qb.first = async (...args) => {
        const row = await originalFirst(...args);
        if (!seen && row && row.id === targetId && row.rides_parent_id) {
          seen = true;
          return { ...row, rides_parent_id: staleHostId };
        }
        return row;
      };
      return qb;
    };
    wrapped.raw = (...args) => sp.raw(...args);
    wrapped.transaction = (...args) => sp.transaction(...args);
    wrapped.isTransaction = true;
    Object.defineProperty(wrapped, 'client', { get: () => sp.client });
    return wrapped;
  }

  test('rides_parent_id changing between the pre-lock peek and the locked read aborts the sync (TOCTOU)', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await seedChildren(pestParent, 'quarterly', 4);
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });

    const before = (await seriesRows(pestParent.id))
      .map((r) => ({ id: r.id, date: r.scheduled_date.toISOString().slice(0, 10), status: r.status }));

    const staleHostId = randomUUID(); // a host id that never existed — the "old" link
    const { syncRiderSeries } = require('../services/rider-series');
    const fakeConn = {
      isTransaction: false,
      transaction: (fn) => trx.transaction((sp) => fn(wrapForStalePeek(sp, pestParent.id, staleHostId))),
    };
    const result = await syncRiderSeries(fakeConn, pestParent.id, { dryRun: false });

    expect(result.skipped).toBe('host_changed');
    expect(result.move).toEqual([]);
    expect(result.insert).toEqual([]);
    expect(result.cancel).toEqual([]);
    const after = (await seriesRows(pestParent.id))
      .map((r) => ({ id: r.id, date: r.scheduled_date.toISOString().slice(0, 10), status: r.status }));
    expect(after).toEqual(before);
  });

  test('a failed add-on copy aborts the insert — the rider sync rolls back rather than going live without its add-ons', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await seedChildren(pestParent, 'quarterly', 4);
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });

    const before = (await seriesRows(pestParent.id))
      .map((r) => ({ id: r.id, date: r.scheduled_date.toISOString().slice(0, 10), status: r.status }));

    const { syncRiderSeries } = require('../services/rider-series');
    await trx.raw('ALTER TABLE scheduled_service_addons RENAME TO scheduled_service_addons_disabled_for_test');
    let result;
    try {
      result = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    } finally {
      await trx.raw('ALTER TABLE scheduled_service_addons_disabled_for_test RENAME TO scheduled_service_addons');
    }

    expect(result.skipped).toBe('error');
    expect(result.move).toEqual([]);
    expect(result.insert).toEqual([]);
    expect(result.cancel).toEqual([]);
    const after = (await seriesRows(pestParent.id))
      .map((r) => ({ id: r.id, date: r.scheduled_date.toISOString().slice(0, 10), status: r.status }));
    expect(after).toEqual(before);
  });

  test('the plan-ending alert action refuses (never resolves the alert) when the rider sync is skipped', async () => {
    const adminScheduleRouter = require('../routes/admin-schedule');
    const { runRecurringAlertAction } = adminScheduleRouter._test;
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await seedChildren(pestParent, 'quarterly', 4);
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });

    await trx.raw('ALTER TABLE invoices RENAME TO invoices_disabled_for_test');
    let outcome;
    try {
      outcome = await runRecurringAlertAction(trx, {
        idParam: `derived-${pestParent.id}`, action: 'extend', count: 1, adminUserId: null,
      });
    } finally {
      await trx.raw('ALTER TABLE invoices_disabled_for_test RENAME TO invoices');
    }

    expect(outcome.status).not.toBe(200);
    expect(outcome.body.success).not.toBe(true);
    expect(outcome.body.code).toBe('RIDER_SYNC_INCOMPLETE');
    // No plan_ending alert was ever created or left resolved by this call.
    const alerts = await trx('recurring_plan_alerts').where({ recurring_parent_id: pestParent.id });
    expect(alerts.every((a) => !a.resolved_at)).toBe(true);
  });

  test('a contended customer-comms lock skips the sync (customer_locked), non-blocking', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await seedChildren(pestParent, 'quarterly', 4);
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });

    const before = (await seriesRows(pestParent.id))
      .map((r) => ({ id: r.id, date: r.scheduled_date.toISOString().slice(0, 10), status: r.status }));

    // NOTE: a genuinely separate session BLOCK-acquiring this same key would
    // deadlock this test — seedChildren above already took this exact lock
    // reentrant on `trx`'s own session (recurring-appointment-seeder.js's
    // follow-up insert locks customer-comms for the whole rest of the
    // transaction), so a second session's blocking pg_advisory_xact_lock on
    // the same key would wait for `trx` to end, which never happens mid-
    // test. tryLockCustomerComms itself is non-blocking by construction
    // (pg_try_advisory_xact_lock, verified directly against
    // utils/customer-comms-lock.js) — what this test proves is the code
    // path: syncRiderSeries writes nothing and returns 'customer_locked'
    // the moment that call reports contention, whoever's holding it.
    const commsLock = require('../utils/customer-comms-lock');
    const spy = jest.spyOn(commsLock, 'tryLockCustomerComms').mockResolvedValueOnce(false);
    try {
      const { syncRiderSeries } = require('../services/rider-series');
      const result = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
      expect(result.skipped).toBe('customer_locked');
      expect(result.move).toEqual([]);
      expect(result.insert).toEqual([]);
      expect(result.cancel).toEqual([]);
    } finally {
      spy.mockRestore();
    }

    const after = (await seriesRows(pestParent.id))
      .map((r) => ({ id: r.id, date: r.scheduled_date.toISOString().slice(0, 10), status: r.status }));
    expect(after).toEqual(before);
  });

  test('two movable rider rows sharing one planned date: exactly one is kept, the other resolves (never both orphaned); a second sync is a no-op', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await seedChildren(pestParent, 'quarterly', 4);
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });
    // Isolate the diff/claim algorithm this test targets from visit-group
    // grouping (a SEPARATE, correct immovability rule this suite covers
    // elsewhere): both series resolve real groupable catalog rows in this
    // shared QA database, so a first sync would otherwise group every
    // matched row onto its host's visit and make it immovable, leaving
    // nothing left to duplicate against. property_id IS NULL is grouping's
    // own hard requirement to skip (visit-groups.js groupRowOn); clearing it
    // on the existing rows keeps the TEMPLATE's own stamp null, and
    // disablePropertyAnchoring keeps it null for every future insert too
    // (see its own comment — a per-row null is not durable against
    // insertSeriesOccurrenceLocked's own anchorSoleProperty call).
    await trx('scheduled_services')
      .where((q) => { q.where('id', pestParent.id).orWhere('recurring_parent_id', pestParent.id); })
      .update({ property_id: null });
    await disablePropertyAnchoring();

    const { syncRiderSeries } = require('../services/rider-series');
    await syncRiderSeries(trx, pestParent.id, { dryRun: false }); // aligns all 4 pest rows onto plan dates

    const pestRowsAfterFirstSync = await seriesRows(pestParent.id);
    const movableRow = pestRowsAfterFirstSync.find((r) => r.scheduled_date.toISOString().slice(0, 10) > PEST_START);
    const dupDate = movableRow.scheduled_date;

    // A genuine duplicate on the SAME already-planned date.
    const [duplicateRow] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Pest Control', status: 'pending',
      scheduled_date: dupDate, is_recurring: true, recurring_pattern: 'quarterly',
      recurring_parent_id: pestParent.id, recurring_ongoing: true, source: 'admin',
    }).returning('*');

    const result = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    const pairIds = [movableRow.id, duplicateRow.id];
    const keptFromPair = pairIds.filter((id) => result.keep.some((k) => k.id === id));
    const resolvedFromPair = pairIds.filter((id) => (
      result.move.some((m) => m.id === id) || result.cancel.some((c) => c.id === id)
    ));
    expect(keptFromPair.length).toBe(1);
    expect(resolvedFromPair.length).toBe(1);

    const rowsAfter = await trx('scheduled_services').whereIn('id', pairIds);
    const liveDates = rowsAfter.filter((r) => r.status !== 'cancelled').map((r) => r.scheduled_date.toISOString().slice(0, 10));
    expect(new Set(liveDates).size).toBe(liveDates.length); // never two live rows on the same date

    const second = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(second.move).toEqual([]);
    expect(second.insert).toEqual([]);
    expect(second.cancel).toEqual([]);
  });

  test('the plan-ending alert action resolves a REAL persisted alert on a successful rider sync', async () => {
    const adminScheduleRouter = require('../routes/admin-schedule');
    const { runRecurringAlertAction } = adminScheduleRouter._test;
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await seedChildren(pestParent, 'quarterly', 4);
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });

    const [alertRow] = await trx('recurring_plan_alerts').insert({
      recurring_parent_id: pestParent.id, customer_id: customerId, alert_type: 'plan_ending',
    }).returning('*');

    const outcome = await runRecurringAlertAction(trx, {
      idParam: String(alertRow.id), action: 'extend', count: 1, adminUserId: null,
    });

    expect(outcome.status).toBe(200);
    expect(outcome.body.success).toBe(true);
    const alertAfter = await trx('recurring_plan_alerts').where({ id: alertRow.id }).first();
    expect(alertAfter.resolved_at).not.toBeNull();
    expect(alertAfter.resolved_action).toBe('extend');
  });
  async function linkedPair() {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await seedChildren(pestParent, 'quarterly', 4);
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });
    return { lawnParent, pestParent };
  }

  const snapshot = async (parentId) => (await seriesRows(parentId))
    .map((r) => ({ id: r.id, date: r.scheduled_date.toISOString().slice(0, 10), status: r.status }));

  test.each([
    ['customer_churned', { pipeline_stage: 'churned' }],
    ['customer_inactive', { active: false }],
    ['customer_deleted', { deleted_at: new Date() }],
    ['customer_service_held', { service_paused_at: new Date(), service_pause_reason: 'owner_hold' }],
  ])('an ineligible customer (%s) skips the sync and writes nothing', async (reason, patch) => {
    const { pestParent } = await linkedPair();
    await trx('customers').where({ id: customerId }).update(patch);
    const before = await snapshot(pestParent.id);
    const { syncRiderSeries } = require('../services/rider-series');
    const result = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(result.skipped).toBe(reason);
    expect(await snapshot(pestParent.id)).toEqual(before);
  });

  test('a series that rides itself is refused (self_link), nothing written', async () => {
    const { pestParent } = await linkedPair();
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: pestParent.id });
    const before = await snapshot(pestParent.id);
    const { syncRiderSeries } = require('../services/rider-series');
    const result = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(result.skipped).toBe('self_link');
    expect(await snapshot(pestParent.id)).toEqual(before);
  });

  test('a host that itself rides another series is refused (host_is_rider), so links never chain or cycle', async () => {
    const { lawnParent, pestParent } = await linkedPair();
    await trx('scheduled_services').where({ id: lawnParent.id }).update({ rides_parent_id: pestParent.id });
    const before = await snapshot(pestParent.id);
    const { syncRiderSeries } = require('../services/rider-series');
    const result = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(result.skipped).toBe('host_is_rider');
    expect(await snapshot(pestParent.id)).toEqual(before);
  });

  test('a lapsed rider (last visit 300 days ago) never plans into the past or the near-term window', async () => {
    const today = etDateString();
    const floor = addDays(today, 8);
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnStart = addDays(today, 14);
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: lawnStart, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: addDays(today, -300) });
    await trx('scheduled_services').where({ id: pestParent.id }).update({ status: 'completed', rides_parent_id: lawnParent.id });

    const { syncRiderSeries } = require('../services/rider-series');
    const result = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(result.skipped).toBeUndefined();
    expect(result.insert.length).toBeGreaterThan(0);

    const pestDates = (await snapshot(pestParent.id)).filter((r) => r.id !== pestParent.id).map((r) => r.date);
    expect(pestDates.length).toBe(result.insert.length);
    expect(pestDates.every((d) => d >= floor)).toBe(true);
    expect(pestDates[0]).toBe(lawnStart); // overdue: rides the first lawn stop after the floor
  });

  test.each(['cancelled', 'skipped', 'no_show', 'rescheduled'])(
    'a %s rider row in the near-term window never anchors the plan',
    async (status) => {
      const { pestParent } = await linkedPair();
      const { syncRiderSeries } = require('../services/rider-series');
      const baseline = await syncRiderSeries(trx, pestParent.id, { dryRun: true });
      await trx('scheduled_services').insert({
        id: randomUUID(), customer_id: customerId, service_type: 'Pest Control', status,
        scheduled_date: addDays(etDateString(), 3), window_start: '08:00', window_end: '10:00',
        is_recurring: true, recurring_pattern: 'quarterly', recurring_parent_id: pestParent.id, source: 'admin',
      });
      const result = await syncRiderSeries(trx, pestParent.id, { dryRun: true });
      expect(result.skipped).toBeUndefined();
      const shape = (r) => ({ keep: r.keep.length, move: r.move.length, insert: r.insert.length, cancel: r.cancel.length });
      expect(shape(result)).toEqual(shape(baseline));
    },
  );

  // Card rows are checked by what is dead, not what is live: any other
  // status (every in-flight money state, or one added later) pins the row.
  const CARD_CASES = [
    ...['pending', 'completing', 'charging', 'charge_review', 'charged', 'completed', 'satisfied', 'some_future_status']
      .map((status) => ['appointment_card_requests', status, true]),
    ...['held', 'charging', 'charge_review', 'charged_completion', 'charged_no_show', 'pending']
      .map((status) => ['estimate_card_holds', status, true]),
    ...['released', 'cancelled', 'failed', 'expired'].map((status) => ['appointment_card_requests', status, false]),
    ...['released', 'cancelled', 'failed'].map((status) => ['estimate_card_holds', status, false]),
  ];
  test.each(CARD_CASES)('%s status=%s -> immovable=%s', async (table, status, immovable) => {
    const { pestParent } = await linkedPair();
    const [row] = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id })
      .orderBy('scheduled_date', 'asc').limit(1);
    if (table === 'appointment_card_requests') {
      await trx('appointment_card_requests').insert({ id: randomUUID(), scheduled_service_id: row.id, customer_id: customerId, status });
    } else {
      const estimateId = randomUUID();
      await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted', service_interest: 'Quarterly Pest Control' });
      await trx('estimate_card_holds').insert({
        id: randomUUID(), estimate_id: estimateId, customer_id: customerId, scheduled_service_id: row.id,
        stripe_setup_intent_id: `seti_${randomUUID().replaceAll('-', '')}`, status,
      });
    }
    const { _internals } = require('../services/rider-series');
    const set = await _internals.immovableRowIdSet(trx, [row.id]);
    expect(set.has(row.id)).toBe(immovable);
  });

  test('an annual-prepay rider series is refused (annual_prepay_series), nothing written', async () => {
    const { pestParent } = await linkedPair();
    await trx('scheduled_services').where({ recurring_parent_id: pestParent.id }).update({ prepaid_method: 'annual_prepay_invoice' });
    const before = await snapshot(pestParent.id);
    const { syncRiderSeries } = require('../services/rider-series');
    const result = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(result.skipped).toBe('annual_prepay_series');
    expect(await snapshot(pestParent.id)).toEqual(before);
  });

  test('a rider whose customer has a second active pest series is refused (duplicate_series), nothing written', async () => {
    const { pestParent } = await linkedPair();
    const other = await makeParent({ pattern: 'quarterly', scheduledDate: '2098-02-05' });
    await seedChildren(other, 'quarterly', 4);
    const before = await snapshot(pestParent.id);
    const { syncRiderSeries } = require('../services/rider-series');
    const result = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(result.skipped).toBe('duplicate_series');
    expect(await snapshot(pestParent.id)).toEqual(before);
  });

  test('an inserted rider row never inherits the template row\'s annual_prepay_term_id', async () => {
    // insertSeriesOccurrenceLocked (admin-schedule.js) is the SAME writer
    // extendSeriesOnceLocked uses for an ordinary auto-extend — its own
    // insert literal never sets annual_prepay_term_id, so a fresh rider row
    // it lands never carries one over from the template, structurally
    // (a real annual-prepay RIDER is refused before any write — see the
    // 'annual_prepay_series' test below — so this proves the writer's own
    // insert shape on a real synced row rather than a series that could
    // never reach this writer).
    const { pestParent } = await linkedPair();
    await syncUntilStable(pestParent.id, trx);
    const inserted = (await seriesRows(pestParent.id)).filter((r) => r.id !== pestParent.id);
    expect(inserted.length).toBeGreaterThan(0);
    for (const row of inserted) expect(row.annual_prepay_term_id).toBeNull();
  });

  // --- P1 fix #1: inserts template off the PARENT + overrides ------------
  test('inserted rows template off the series PARENT, never the rider\'s own latest occurrence — an occurrence-only edit on the latest row never becomes the future template (P1 fix #1, fail-without-fix evidence)', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await trx('scheduled_services').where({ id: pestParent.id }).update({ estimated_price: 42 });
    await seedChildren(pestParent, 'quarterly', 2); // exactly one child, dated after the parent
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });

    // Simulate an occurrence-only ("this only") price edit on the rider's
    // single existing child — recurring_template_overrides is untouched,
    // exactly the shape the design doc's "Kept rows" plan/diff describes.
    const [onlyChild] = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id });
    await trx('scheduled_services').where({ id: onlyChild.id }).update({ estimated_price: 999.99 });

    await syncUntilStable(pestParent.id, trx);

    const inserted = (await seriesRows(pestParent.id))
      .filter((r) => r.id !== pestParent.id && r.id !== onlyChild.id);
    expect(inserted.length).toBeGreaterThan(0);
    for (const row of inserted) {
      expect(Number(row.estimated_price)).toBe(42);
      expect(Number(row.estimated_price)).not.toBe(999.99);
    }
  });

  test('recurring_template_overrides (an "apply to following" edit) DOES ride onto new inserts', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await trx('scheduled_services').where({ id: pestParent.id }).update({
      estimated_price: 42,
      recurring_template_overrides: JSON.stringify({ estimated_price: 77 }),
      rides_parent_id: lawnParent.id,
    });

    await syncUntilStable(pestParent.id, trx);

    const inserted = (await seriesRows(pestParent.id)).filter((r) => r.id !== pestParent.id);
    expect(inserted.length).toBeGreaterThan(0);
    for (const row of inserted) expect(Number(row.estimated_price)).toBe(77);
  });

  // --- P1 fix #2: add-ons filtered per due date, never a verbatim clone ---
  test('inserted rows carry the PARENT\'s add-ons filtered by due date, never a verbatim clone of one occurrence\'s add-ons (P1 fix #2, fail-without-fix evidence)', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });
    // A one-time add-on sold only on the parent's own visit — must never
    // ride onto a later inserted occurrence.
    await trx('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: pestParent.id, service_name: 'One-Time Prep', estimated_price: 25, recurring_pattern: 'one_time',
    });
    // A recurring add-on, due every occurrence (no pattern = always due).
    await trx('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: pestParent.id, service_name: 'Recurring Add-On', estimated_price: 10,
    });

    await syncUntilStable(pestParent.id, trx);

    const insertedIds = (await seriesRows(pestParent.id)).filter((r) => r.id !== pestParent.id).map((r) => r.id);
    expect(insertedIds.length).toBeGreaterThan(0);
    const addonsByRow = await trx('scheduled_service_addons').whereIn('scheduled_service_id', insertedIds);
    expect(addonsByRow.some((a) => a.service_name === 'One-Time Prep')).toBe(false);
    expect(addonsByRow.filter((a) => a.service_name === 'Recurring Add-On').length).toBe(insertedIds.length);
  });

  // --- P1 money / P2 catalog identity: closed by the structural fix (#2) --
  test('each rider insert\'s price and add-on set equal what the shared canonical writer computes for that date (P1 money, PR #5268 round-3 structural fix)', async () => {
    const { filterAddonLinesForDate } = require('../routes/admin-schedule')._test;
    // No lawn children at all — every rider date is a STANDALONE insert on
    // its own 84-day fallback cadence (deterministic: PEST_START is a
    // Thursday, so no weekend shift ever nudges a date), isolating this
    // test from any host-date coincidence.
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START });
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    // primary_line_price (a STRUCTURED price, not the ambiguous bare
    // estimated_price) makes calculateStoredVisitFinancials
    // (admin-schedule.js) use it as the primary net DIRECTLY, so every
    // occurrence's own estimated_price is deterministically primary + THAT
    // date's own due add-ons — never the parent's whole $40 add-on catalog
    // subtracted back out (calculateStoredVisitFinancials' OTHER, ambiguous
    // fallback branch for a bare estimated_price with no structured price).
    await trx('scheduled_services').where({ id: pestParent.id })
      .update({ rides_parent_id: lawnParent.id, primary_line_price: 73.5, estimated_price: 73.5 });
    // A one-time add-on (due only on the anchor, never a later insert).
    await trx('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: pestParent.id, service_name: 'One-Time Prep', estimated_price: 25, recurring_pattern: 'one_time',
    });
    // A LATER-due add-on — semiannual (~182 days), so it is due on SOME of
    // this test's inserted dates (84/168/252 days out) but not all, unlike
    // the always-due add-on the P1 fix #2 test above already covers.
    await trx('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: pestParent.id, service_name: 'Semiannual Add-On', estimated_price: 15, recurring_pattern: 'semiannual',
    });

    await syncUntilStable(pestParent.id, trx);

    const inserted = (await seriesRows(pestParent.id)).filter((r) => r.id !== pestParent.id);
    expect(inserted.length).toBeGreaterThan(0);
    // fail-without-fix: at least one inserted date must actually fall past
    // the semiannual add-on's first due date, or this test can't
    // distinguish "correctly filtered" from "always empty".
    const anyDueSemiannual = inserted.some((r) => r.scheduled_date.toISOString().slice(0, 10) >= addDays(PEST_START, 182));
    expect(anyDueSemiannual).toBe(true);

    const parentAddons = await trx('scheduled_service_addons').where({ scheduled_service_id: pestParent.id });
    for (const row of inserted) {
      const d = row.scheduled_date.toISOString().slice(0, 10);
      // Oracle: filterAddonLinesForDate is the EXACT function
      // insertSeriesOccurrenceLocked (admin-schedule.js) calls for this
      // date — an independent call here proves writeRiderPlan (rider-
      // series.js) is passing it the right base date, target date and
      // blackout scope end to end, not just that SOME filtering happened.
      const expectedDueLines = filterAddonLinesForDate(parentAddons, pestParent.scheduled_date, d, null, false);
      const expectedDue = expectedDueLines.map((a) => a.service_name).sort();
      const actualAddons = await trx('scheduled_service_addons')
        .where({ scheduled_service_id: row.id }).pluck('service_name');
      expect(actualAddons.sort()).toEqual(expectedDue);
      expect(actualAddons).not.toContain('One-Time Prep');
      // Price parity: primary (73.5, via primary_line_price — see above)
      // plus ONLY this date's own due add-ons, computed the SAME way
      // calculateStoredVisitFinancials (admin-schedule.js) does for any
      // other extension writer — never the parent's whole add-on catalog.
      const expectedPrice = 73.5 + expectedDueLines.reduce((sum, a) => sum + Number(a.estimated_price), 0);
      expect(Number(row.estimated_price)).toBe(expectedPrice);
    }
  });

  test('a renamed catalog service: a rider insert carries the catalog\'s CURRENT service_type, not the stale label the parent was stamped with (P2 catalog identity)', async () => {
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START });
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    const [catalogRow] = await trx('services').insert({
      id: randomUUID(), service_key: `synthetic_pest_${customerId}`, name: 'Old Pest Name', category: 'pest_control',
    }).returning('*');
    await trx('scheduled_services').where({ id: pestParent.id })
      .update({ rides_parent_id: lawnParent.id, service_id: catalogRow.id, service_type: 'Old Pest Name' });
    // Rename the catalog row AFTER the parent was stamped — resolveSeriesChildIdentity
    // (service-catalog-names.js) resolves by service_id, so a fresh insert
    // must carry the CURRENT name, never the parent's stale label.
    await trx('services').where({ id: catalogRow.id }).update({ name: 'New Pest Name' });

    await syncUntilStable(pestParent.id, trx);

    const inserted = (await seriesRows(pestParent.id)).filter((r) => r.id !== pestParent.id);
    expect(inserted.length).toBeGreaterThan(0);
    for (const row of inserted) {
      expect(row.service_type).toBe('New Pest Name');
      expect(row.service_type).not.toBe('Old Pest Name');
    }
  });

  // --- P1 boosters (PR #5268 round 2): never anchored, moved or cancelled -
  test('a booster row (is_recurring=false) is never the anchor and never a move/cancel candidate (P1 boosters, fail-without-fix evidence)', async () => {
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START });
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });
    // A booster: shares recurring_parent_id like any other series child, but
    // is_recurring=false — the SAME exclusion latestLiveSeriesVisit
    // (admin-schedule.js) and the upcoming-visit counter already apply.
    // Dated LATER than every date the rider's own plan will produce (a
    // fail-without-fix booster anchor would otherwise re-derive a plan
    // starting AFTER it, producing zero inserts and masking the bug as
    // "nothing to assert").
    const boosterDate = addDays(PEST_START, 60);
    const [booster] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Pest Control', status: 'pending',
      scheduled_date: boosterDate, recurring_parent_id: pestParent.id, is_recurring: false, source: 'admin',
    }).returning('*');

    const { syncRiderSeries } = require('../services/rider-series');
    const result = await syncRiderSeries(trx, pestParent.id, { dryRun: false });

    // Never an anchor: the plan still starts from PEST_START (the parent's
    // own date), not from the booster's LATER date — proven by the FIRST
    // inserted date landing at the standalone +84 step from PEST_START,
    // not from boosterDate.
    expect(result.insert.length).toBeGreaterThan(0);
    const expectedFirst = planRiderDates({ hostDates: [], lastRiderDate: PEST_START, horizonDate: addDays(PEST_START, 300) })[0];
    expect(result.insert[0]).toBe(expectedFirst);
    expect(result.insert[0]).not.toBe(boosterDate);
    // Never a move or cancel candidate: the booster itself is untouched and
    // never appears in any diff bucket.
    const touchedIds = [...result.move.map((m) => m.id), ...result.cancel.map((c) => c.id), ...result.keep.map((k) => k.id), ...result.refresh.map((r) => r.id)];
    expect(touchedIds).not.toContain(booster.id);
    const boosterAfter = await trx('scheduled_services').where({ id: booster.id }).first();
    expect(boosterAfter.scheduled_date.toISOString().slice(0, 10)).toBe(boosterDate);
    expect(boosterAfter.status).toBe('pending');
  });

  // --- P1 fix #4: let_lapse / not_ongoing / convert_ongoing ---------------
  test('runRecurringAlertAction let_lapse on a rider clears recurring_ongoing series-wide instead of resyncing it (P1 fix #4, fail-without-fix evidence)', async () => {
    const adminScheduleRouter = require('../routes/admin-schedule');
    const { runRecurringAlertAction } = adminScheduleRouter._test;
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    // refreshRecurringPlanAlert's own revalidation refuses a "plan ending"
    // alert with no completed visit at all ("an accepted estimate awaiting
    // its first service is not a renewal"), AND refuses one with any
    // upcoming visit still on the books (that is not "ending") — no pest
    // children seeded, and the parent's own sole occurrence marked
    // completed, is the genuine precondition a real plan-ending alert
    // requires.
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await trx('scheduled_services').where({ id: pestParent.id })
      .update({ rides_parent_id: lawnParent.id, status: 'completed', completed_at: new Date() });
    const [alertRow] = await trx('recurring_plan_alerts').insert({
      recurring_parent_id: pestParent.id, customer_id: customerId, alert_type: 'plan_ending',
    }).returning('*');
    const before = await snapshot(pestParent.id);

    const outcome = await runRecurringAlertAction(trx, {
      idParam: String(alertRow.id), action: 'let_lapse', count: 1, adminUserId: null,
    });

    expect(outcome.status).toBe(200);
    expect(outcome.body.success).toBe(true);
    // No rider-sync detour ran — the row set is byte-identical; only the
    // flag flips.
    expect(await snapshot(pestParent.id)).toEqual(before);
    const rowsAfter = await trx('scheduled_services')
      .where((q) => { q.where('id', pestParent.id).orWhere('recurring_parent_id', pestParent.id); });
    expect(rowsAfter.every((r) => r.recurring_ongoing === false)).toBe(true);
    const alertAfter = await trx('recurring_plan_alerts').where({ id: alertRow.id }).first();
    expect(alertAfter.resolved_action).toBe('let_lapse');
  });

  // --- P1 revival: convert_ongoing after an earlier let_lapse -------------
  test('convert_ongoing on a rider revives it even after an earlier let_lapse decision (P1 revival, fail-without-fix evidence)', async () => {
    const adminScheduleRouter = require('../routes/admin-schedule');
    const { runRecurringAlertAction } = adminScheduleRouter._test;
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    // Same genuine plan-ending precondition as the let_lapse test above: no
    // pest children, the parent's sole occurrence completed.
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await trx('scheduled_services').where({ id: pestParent.id })
      .update({ rides_parent_id: lawnParent.id, status: 'completed', completed_at: new Date() });
    const [alertRow] = await trx('recurring_plan_alerts').insert({
      recurring_parent_id: pestParent.id, customer_id: customerId, alert_type: 'plan_ending',
    }).returning('*');

    // Step 1: let this rider lapse — the SAME real action the fail-without-
    // fix precondition test above exercises. This is what leaves a
    // resolved 'let_lapse' decision as the latest recurring_plan_alerts row
    // for this parent.
    const letLapseOutcome = await runRecurringAlertAction(trx, {
      idParam: String(alertRow.id), action: 'let_lapse', count: 1, adminUserId: null,
    });
    expect(letLapseOutcome.status).toBe(200);
    const afterLapse = await trx('scheduled_services').where({ id: pestParent.id }).first('recurring_ongoing');
    expect(afterLapse.recurring_ongoing).toBe(false);

    // Step 2: convert_ongoing — without opts.revive, syncRiderSeries' own
    // plan_stopped gate reads that SAME still-latest 'let_lapse' decision
    // (the new alert row this action would resolve does not exist/resolve
    // until AFTER a successful sync) and refuses every time, so
    // convert_ongoing could never revive a rider that had ever been let to
    // lapse — a 409 forever, never the 200 a genuine revival needs.
    const outcome = await runRecurringAlertAction(trx, {
      idParam: `derived-${pestParent.id}`, action: 'convert_ongoing', count: 1, adminUserId: null,
    });

    expect(outcome.status).toBe(200);
    expect(outcome.body.success).toBe(true);
    expect(outcome.body.riderSynced).toBe(true);
    const parentAfter = await trx('scheduled_services').where({ id: pestParent.id }).first('recurring_ongoing');
    expect(parentAfter.recurring_ongoing).toBe(true);
    // Genuinely synced, not just flagged: the completed anchor (PEST_START)
    // now has at least one future row riding the lawn host's dates.
    const rowsAfter = await seriesRows(pestParent.id);
    expect(rowsAfter.some((r) => r.scheduled_date.toISOString().slice(0, 10) > PEST_START)).toBe(true);
  });

  test('revive never overrides a cancel_series decision: the customer cancelled this series', async () => {
    const { pestParent } = await linkedPair();
    await trx('recurring_plan_alerts').insert({
      recurring_parent_id: pestParent.id, customer_id: customerId, alert_type: 'plan_ending',
      resolved_at: new Date(), resolved_action: 'cancel_series',
    });
    const before = await snapshot(pestParent.id);
    const { syncRiderSeries } = require('../services/rider-series');
    const result = await syncRiderSeries(trx, pestParent.id, { dryRun: false, revive: true });
    expect(result.skipped).toBe('plan_stopped');
    expect(await snapshot(pestParent.id)).toEqual(before);
  });

  test('syncRiderSeries refuses a rider whose recurring_ongoing is false (not_ongoing), nothing written', async () => {
    const { pestParent } = await linkedPair();
    await trx('scheduled_services')
      .where((q) => { q.where('id', pestParent.id).orWhere('recurring_parent_id', pestParent.id); })
      .update({ recurring_ongoing: false });
    const before = await snapshot(pestParent.id);
    const { syncRiderSeries } = require('../services/rider-series');
    const result = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(result.skipped).toBe('not_ongoing');
    expect(await snapshot(pestParent.id)).toEqual(before);
  });

  test('runRecurringAlertAction convert_ongoing on a lapsed rider flips recurring_ongoing true before syncing it', async () => {
    const adminScheduleRouter = require('../routes/admin-schedule');
    const { runRecurringAlertAction } = adminScheduleRouter._test;
    const { pestParent } = await linkedPair();
    await trx('scheduled_services')
      .where((q) => { q.where('id', pestParent.id).orWhere('recurring_parent_id', pestParent.id); })
      .update({ recurring_ongoing: false });

    const outcome = await runRecurringAlertAction(trx, {
      idParam: `derived-${pestParent.id}`, action: 'convert_ongoing', count: 1, adminUserId: null,
    });

    expect(outcome.status).toBe(200);
    expect(outcome.body.success).toBe(true);
    expect(outcome.body.riderSynced).toBe(true);
    const parentAfter = await trx('scheduled_services').where({ id: pestParent.id }).first('recurring_ongoing');
    expect(parentAfter.recurring_ongoing).toBe(true);
  });

  test('convert_ongoing on a lapsed rider whose sync is skipped returns 409 and leaves recurring_ongoing false', async () => {
    const { runRecurringAlertAction } = require('../routes/admin-schedule')._test;
    const { pestParent } = await linkedPair();
    await trx('scheduled_services')
      .where((q) => { q.where('id', pestParent.id).orWhere('recurring_parent_id', pestParent.id); })
      .update({ recurring_ongoing: false });
    await trx('customers').where({ id: customerId }).update({ pipeline_stage: 'churned' });
    const before = await snapshot(pestParent.id);

    const outcome = await runRecurringAlertAction(trx, {
      idParam: `derived-${pestParent.id}`, action: 'convert_ongoing', count: 1, adminUserId: null,
    });

    expect(outcome.status).toBe(409);
    expect(outcome.body.code).toBe('RIDER_SYNC_INCOMPLETE');
    const flags = await trx('scheduled_services')
      .where((q) => { q.where('id', pestParent.id).orWhere('recurring_parent_id', pestParent.id); })
      .pluck('recurring_ongoing');
    expect(flags.every((f) => f === false)).toBe(true);
    expect(await snapshot(pestParent.id)).toEqual(before);
  });

  // --- P1 fix #5: standalone-date conflict + tech-absence -----------------
  test('a standalone insert date that clashes with an existing visit is skipped this sync rather than double-booked (P1 fix #5)', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    // A single lawn visit near the anchor, no further host coverage — the
    // rider must fall back to its own standalone cadence for everything
    // after it.
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    const pestTechId = randomUUID();
    await trx('technicians').insert({ id: pestTechId, name: 'Synthetic Pest Tech', employment_status: 'active', field_dispatchable: true });
    const pestParent = await makeParent({
      pattern: 'quarterly', scheduledDate: PEST_START, technicianId: pestTechId, windowStart: '08:00', windowEnd: '10:00',
    });
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });

    const standaloneDate = planRiderDates({
      hostDates: [], lastRiderDate: PEST_START, horizonDate: addDays(PEST_START, 200),
    })[0];

    // A decoy visit for a DIFFERENT customer occupying the exact same
    // date/window — the shared occupancy clash every other series writer's
    // insert/move probes before committing.
    const otherCustomerId = randomUUID();
    await trx('customers').insert({
      id: otherCustomerId, first_name: 'Decoy', last_name: 'Customer', email: `${otherCustomerId}@example.invalid`,
      phone: `+1941555${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`, active: true, pipeline_stage: 'active_customer',
    });
    await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: otherCustomerId, service_type: 'Decoy Visit', status: 'pending',
      scheduled_date: standaloneDate, window_start: '08:00', window_end: '10:00', source: 'admin',
    });

    const { syncRiderSeries } = require('../services/rider-series');
    await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    const rowsAfter = await seriesRows(pestParent.id);
    expect(rowsAfter.some((r) => r.scheduled_date.toISOString().slice(0, 10) === standaloneDate)).toBe(false);
  });

  test('a standalone insert date whose template technician is marked out that day is seeded unassigned, never onto the absent tech (Fable review addendum to fix #5)', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    const pestTechId = randomUUID();
    await trx('technicians').insert({ id: pestTechId, name: 'Synthetic Pest Tech', employment_status: 'active', field_dispatchable: true });
    const pestParent = await makeParent({
      pattern: 'quarterly', scheduledDate: PEST_START, technicianId: pestTechId, windowStart: '08:00', windowEnd: '10:00',
    });
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });

    const standaloneDate = planRiderDates({
      hostDates: [], lastRiderDate: PEST_START, horizonDate: addDays(PEST_START, 200),
    })[0];
    await trx('technician_absences').insert({
      id: randomUUID(), technician_id: pestTechId, absence_date: standaloneDate, reason: 'other',
    });

    const { syncRiderSeries } = require('../services/rider-series');
    await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    const rowsAfter = await seriesRows(pestParent.id);
    const landed = rowsAfter.find((r) => r.scheduled_date.toISOString().slice(0, 10) === standaloneDate);
    expect(landed).toBeTruthy();
    expect(landed.technician_id).toBeNull();
  });

  // --- P1 host tech / P1 windows: an INSERT onto a host date validates ---
  // --- the host's own tech and normalizes its window (PR #5268 round 2) --
  test('a rider insert onto a host date whose tech is absent that day lands unassigned, never onto the absent host tech (P1 host tech, fail-without-fix evidence)', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });

    const lawnDates = (await seriesRows(lawnParent.id))
      .map((r) => r.scheduled_date.toISOString().slice(0, 10)).sort();
    const plannedFirst = planRiderDates({
      hostDates: lawnDates.filter((d) => d > LAWN_START), lastRiderDate: PEST_START, horizonDate: lawnDates[lawnDates.length - 1],
    })[0];
    expect(lawnDates).toContain(plannedFirst); // fail-without-fix precondition: this IS a host date
    // The lawn tech is otherwise fully eligible (active + field_dispatchable
    // above) — ONLY this specific day is blocked, so a fixed/inactive
    // account can't be mistaken for the absence this test targets.
    await trx('technician_absences').insert({
      id: randomUUID(), technician_id: lawnTechId, absence_date: plannedFirst, reason: 'other',
    });

    const { syncRiderSeries } = require('../services/rider-series');
    await syncRiderSeries(trx, pestParent.id, { dryRun: false });

    const landed = (await seriesRows(pestParent.id))
      .find((r) => r.scheduled_date.toISOString().slice(0, 10) === plannedFirst);
    expect(landed).toBeTruthy();
    expect(landed.technician_id).toBeNull();
    // The host's OWN row on that date still carries its tech — only the
    // RIDER's join is nulled, the host is untouched.
    const hostRowOnDate = await trx('scheduled_services')
      .where({ recurring_parent_id: lawnParent.id, scheduled_date: plannedFirst }).first();
    expect(hostRowOnDate.technician_id).toBe(lawnTechId);
  });

  test('a kept rider on a host date converges: a pinned tech and an off-hour host window are never re-flagged for refresh', async () => {
    const hostTechId = randomUUID();
    await trx('technicians').insert({ id: hostTechId, name: 'Synthetic Host Tech', employment_status: 'active', field_dispatchable: true });
    const riderOwnTechId = randomUUID();
    await trx('technicians').insert({ id: riderOwnTechId, name: 'Synthetic Rider Own Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: hostTechId });
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await trx('scheduled_services').where({ id: pestParent.id }).update({
      recurring_technician_id: riderOwnTechId, recurring_technician_override: true, rides_parent_id: lawnParent.id,
    });
    const hostChildDate = addDays(LAWN_START, 84);
    await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Lawn Care', status: 'pending',
      scheduled_date: hostChildDate, window_start: '09:30', window_end: '11:30',
      technician_id: hostTechId, is_recurring: true, recurring_pattern: 'every_6_weeks',
      recurring_parent_id: lawnParent.id, recurring_ongoing: true, source: 'admin',
      estimated_duration_minutes: 120,
    });
    // Keep the rider row ungrouped so it stays a kept, movable row.
    await trx('scheduled_services')
      .where((q) => { q.where('id', pestParent.id).orWhere('recurring_parent_id', pestParent.id).orWhere('id', lawnParent.id).orWhere('recurring_parent_id', lawnParent.id); })
      .update({ property_id: null });
    await disablePropertyAnchoring();

    const { syncRiderSeries } = require('../services/rider-series');
    await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    const landed = (await seriesRows(pestParent.id)).find((r) => r.scheduled_date.toISOString().slice(0, 10) === hostChildDate);
    expect(landed).toBeTruthy();
    expect(landed.visit_id).toBeNull();
    expect(landed.technician_id).toBe(riderOwnTechId);
    expect(String(landed.window_start)).toBe('09:00:00');

    const dry = await syncRiderSeries(trx, pestParent.id, { dryRun: true });
    expect(dry.keep.some((k) => k.id === landed.id)).toBe(true);
    expect(dry.refresh).toEqual([]);
    const second = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(second.refresh).toEqual([]);
  });

  test('a rider insert onto a host date with an off-hour window lands floored to the hour, with the normalized end (P1 windows, fail-without-fix evidence)', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });

    // A manually-inserted host CHILD (never through the seeder, which
    // floors/validates windows the way every admin write does) carries an
    // off-hour window (09:30-11:30) — the completion auto-extend path
    // never normalizes an off-hour template either
    // (opts.normalizeOffHourStart is top-up only), so this is a genuine
    // shape a real host row can carry. >= MIN_GAP_DAYS (77) past the
    // anchor so planRiderDates' first step actually reaches it.
    const hostChildDate = addDays(LAWN_START, 84);
    await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Lawn Care', status: 'pending',
      scheduled_date: hostChildDate, window_start: '09:30', window_end: '11:30',
      technician_id: lawnTechId, is_recurring: true, recurring_pattern: 'every_6_weeks',
      recurring_parent_id: lawnParent.id, recurring_ongoing: true, source: 'admin',
      estimated_duration_minutes: 120,
    });

    const { syncRiderSeries } = require('../services/rider-series');
    await syncRiderSeries(trx, pestParent.id, { dryRun: false });

    const inserted = (await seriesRows(pestParent.id)).filter((r) => r.id !== pestParent.id);
    expect(inserted.length).toBeGreaterThan(0);
    const landed = inserted.find((r) => r.scheduled_date.toISOString().slice(0, 10) === hostChildDate);
    expect(landed).toBeTruthy();
    // Floored to the hour (09:30 -> 09:00), end re-derived from the HOST
    // row's own 120-minute duration (09:00 + 120min = 11:00) — never the
    // host's raw 11:30, and never left at the un-flooured 09:30.
    expect(String(landed.window_start)).toBe('09:00:00');
    expect(String(landed.window_end)).toBe('11:00:00');
  });

  // --- P2 fix #6: kept rows pick up a re-windowed/reassigned host stop ---
  test('a kept, ungrouped rider row on a host date picks up the host\'s re-windowed/reassigned fields on a later sync; dry run reports it write-free; a second sync converges (P2 fix #6)', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech', employment_status: 'active', field_dispatchable: true });
    const otherTechId = randomUUID();
    await trx('technicians').insert({ id: otherTechId, name: 'Synthetic Reassigned Tech', employment_status: 'active', field_dispatchable: true });
    const lawnParent = await makeParent({
      pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId, windowStart: '09:00', windowEnd: '11:00',
    });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    // No pre-seeded children — every planned date is a fresh insert this
    // test's own first sync produces, so there is no risk of the seeder's
    // own quarterly walk coincidentally already landing exactly on the
    // every-2nd-lawn-date rule for some particular anchor.
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });
    // Grouping is a separate, correct immovability rule tested elsewhere —
    // disable it here (same technique the duplicate-date test uses) so a
    // kept row stays in the movable/refresh-eligible set throughout,
    // including across syncUntilStable's own several passes (see
    // disablePropertyAnchoring's own comment).
    await trx('scheduled_services')
      .where((q) => { q.where('id', pestParent.id).orWhere('recurring_parent_id', pestParent.id); })
      .update({ property_id: null });
    await disablePropertyAnchoring();

    const { syncRiderSeries } = require('../services/rider-series');
    // syncUntilStable returns the LAST pass's (converged, no-op) result —
    // check the actual row set it produced instead of that pass's own diff.
    await syncUntilStable(pestParent.id, trx);
    expect((await seriesRows(pestParent.id)).length).toBeGreaterThan(1);

    // A host visit re-windowed AND reassigned with NO date change.
    const pestRows = await seriesRows(pestParent.id);
    const kept = pestRows.find((r) => r.scheduled_date.toISOString().slice(0, 10) > PEST_START);
    const keptBefore = await trx('scheduled_services').where({ id: kept.id }).first('window_start', 'window_end', 'technician_id');
    const hostRow = await trx('scheduled_services')
      .where({ recurring_parent_id: lawnParent.id, scheduled_date: kept.scheduled_date }).first();
    expect(hostRow).toBeTruthy();
    await trx('scheduled_services').where({ id: hostRow.id }).update({
      window_start: '13:00', window_end: '15:00', technician_id: otherTechId,
    });
    // P1 fix #1 / P2 fix #2 (PR #5268 round 3): a leftover route position
    // and a stale windowless-dispatch-pending stamp on the KEPT row, same
    // shape recurring-dispatch-due.js and rebooker.js's own route_order
    // convention describe — a refresh that changes technician_id (this
    // one does: otherTechId above) must clear both, exactly like a real
    // move onto a different tech/day would.
    await trx('scheduled_services').where({ id: kept.id }).update({
      recurring_dispatch_due_date: PEST_START, route_order: 3,
    });

    const dryRefresh = await syncRiderSeries(trx, pestParent.id, { dryRun: true });
    expect(dryRefresh.refresh.some((r) => r.id === kept.id)).toBe(true);
    const keptStillOld = await trx('scheduled_services').where({ id: kept.id })
      .first('window_start', 'window_end', 'technician_id', 'recurring_dispatch_due_date', 'route_order');
    expect(String(keptStillOld.window_start)).toBe(String(keptBefore.window_start));
    expect(String(keptStillOld.technician_id)).toBe(String(keptBefore.technician_id));
    expect(keptStillOld.recurring_dispatch_due_date).toBeTruthy(); // dry run wrote nothing
    expect(keptStillOld.route_order).toBe(3);

    const refreshResult = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(refreshResult.refresh.some((r) => r.id === kept.id)).toBe(true);
    const hostRowAfter = await trx('scheduled_services').where({ id: hostRow.id }).first();
    const keptAfter = await trx('scheduled_services').where({ id: kept.id }).first();
    expect(String(keptAfter.window_start)).toBe(String(hostRowAfter.window_start));
    expect(String(keptAfter.window_end)).toBe(String(hostRowAfter.window_end));
    expect(String(keptAfter.technician_id)).toBe(String(otherTechId));
    // Fail-without-fix: before P1 fix #1, recurring_dispatch_due_date stays
    // stale (PEST_START) here, and auto-dispatch then constrains placement
    // to +/-3 days around that old date. Before P2 fix #2, route_order stays
    // 3, interleaving this stop into the tech's OLD route position.
    expect(keptAfter.recurring_dispatch_due_date).toBeNull();
    expect(keptAfter.route_order).toBeNull();

    const second = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(second.refresh).toEqual([]);
    expect(second.move).toEqual([]);
    expect(second.insert).toEqual([]);
    expect(second.cancel).toEqual([]);
  });

  // --- Fable review NEW A: messaging_audit_log, not reminder flags -------
  test('appointment_reminders bookkeeping flags alone (a sibling-suppressed registration, no real send) never pin a row (Fable review NEW A, fail-without-fix evidence)', async () => {
    const { pestParent } = await linkedPair();
    const [row] = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id }).orderBy('scheduled_date', 'asc').limit(1);
    const now = new Date();
    await trx('appointment_reminders').insert({
      id: randomUUID(), scheduled_service_id: row.id, customer_id: customerId, appointment_time: row.scheduled_date,
      source: 'system_seed',
      confirmation_sent: true, confirmation_sent_at: now, reminder_72h_sent: true, reminder_72h_sent_at: now,
      reminder_24h_sent: true, reminder_24h_sent_at: now, cancelled: false, suppressed_by_sibling: true,
    });
    const { _internals } = require('../services/rider-series');
    const set = await _internals.immovableRowIdSet(trx, [row.id]);
    expect(set.has(row.id)).toBe(false);
  });

  // 'appointment' is the generic purpose the reschedule text
  // (reschedule-sms.js), rain-out notices and prep guides log under.
  test.each([
    ['appointment_confirmation', true],
    ['appointment_reminder_72h', true],
    ['appointment_reminder_24h', true],
    ['appointment', true],
    ['appointment_card_request', true],
    ['appointment_cancellation', false],
  ])('a real send with purpose %s recorded in messaging_audit_log -> pinned=%s (Fable review NEW A)', async (purpose, pinned) => {
    const { pestParent } = await linkedPair();
    const [row] = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id }).orderBy('scheduled_date', 'asc').limit(1);
    await trx('messaging_audit_log').insert({
      id: randomUUID(), to_hash: randomUUID(), to_last4: '1234', appointment_id: String(row.id),
      audience: 'customer', purpose, channel: 'sms', body_hash: randomUUID(), sent_at: new Date(),
    });
    const { _internals } = require('../services/rider-series');
    const set = await _internals.immovableRowIdSet(trx, [row.id]);
    expect(set.has(row.id)).toBe(pinned);
  });

  test('a blocked/failed messaging_audit_log row (no sent_at) never pins the row', async () => {
    const { pestParent } = await linkedPair();
    const [row] = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id }).orderBy('scheduled_date', 'asc').limit(1);
    await trx('messaging_audit_log').insert({
      id: randomUUID(), to_hash: randomUUID(), to_last4: '1234', appointment_id: String(row.id),
      audience: 'customer', purpose: 'appointment_confirmation', channel: 'sms', body_hash: randomUUID(),
      sent_at: null, blocked_code: 'SUPPRESSED',
    });
    const { _internals } = require('../services/rider-series');
    const set = await _internals.immovableRowIdSet(trx, [row.id]);
    expect(set.has(row.id)).toBe(false);
  });

  // --- Fable review NEW B: rider liveness beyond not_ongoing --------------
  test('a rider whose customer scoped-cancelled the pest plan is never resynced by a host extend hook, even while the host keeps extending', async () => {
    const { pestParent, lawnParent } = await linkedPair();
    // Mirrors recordRecurringSeriesStops + the series-scope cancel's own
    // recurring_ongoing clear (admin-dispatch.js / cancellation-processor.js)
    // — the exact state a scoped pest-only cancel leaves behind while lawn
    // keeps going.
    await trx('scheduled_services')
      .where((q) => { q.where('id', pestParent.id).orWhere('recurring_parent_id', pestParent.id); })
      .update({ recurring_ongoing: false });
    await trx('recurring_plan_alerts').insert({
      recurring_parent_id: pestParent.id, customer_id: customerId, alert_type: 'plan_lapsed',
      resolved_at: new Date(), resolved_action: 'cancel_series',
    });
    const before = await snapshot(pestParent.id);

    const { syncRidersOfHost } = require('../services/rider-series');
    await syncRidersOfHost(trx, lawnParent.id, { source: 'host_extend' });

    expect(await snapshot(pestParent.id)).toEqual(before);
  });

  test('a rider whose latest resolved decision is cancel_series is refused (plan_stopped) even if recurring_ongoing still reads true', async () => {
    const { pestParent } = await linkedPair();
    await trx('recurring_plan_alerts').insert({
      recurring_parent_id: pestParent.id, customer_id: customerId, alert_type: 'plan_lapsed',
      resolved_at: new Date(), resolved_action: 'cancel_series',
    });
    const before = await snapshot(pestParent.id);
    const { syncRiderSeries } = require('../services/rider-series');
    const result = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(result.skipped).toBe('plan_stopped');
    expect(await snapshot(pestParent.id)).toEqual(before);
  });

  test('not_series_root: rides_parent_id set on a non-root row is refused, nothing written', async () => {
    const { pestParent, lawnParent } = await linkedPair();
    const [child] = await trx('scheduled_services').where({ recurring_parent_id: pestParent.id }).limit(1);
    await trx('scheduled_services').where({ id: child.id }).update({ rides_parent_id: lawnParent.id });
    const before = await trx('scheduled_services').where({ id: child.id }).first();
    const { syncRiderSeries } = require('../services/rider-series');
    const result = await syncRiderSeries(trx, child.id, { dryRun: false });
    expect(result.skipped).toBe('not_series_root');
    const after = await trx('scheduled_services').where({ id: child.id }).first();
    expect(after.scheduled_date).toEqual(before.scheduled_date);
    expect(after.status).toBe(before.status);
  });

  // --- Fable review NEW C: different property -----------------------------
  test('a rider at a different property than its host is refused (different_property), nothing written', async () => {
    const { pestParent, lawnParent } = await linkedPair();
    const [propA] = await trx('customer_properties').insert({ id: randomUUID(), customer_id: customerId }).returning('*');
    const [propB] = await trx('customer_properties').insert({ id: randomUUID(), customer_id: customerId }).returning('*');
    await trx('scheduled_services').where({ id: lawnParent.id }).update({ property_id: propA.id });
    await trx('scheduled_services').where({ id: pestParent.id }).update({ property_id: propB.id });
    const before = await snapshot(pestParent.id);
    const { syncRiderSeries } = require('../services/rider-series');
    const result = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(result.skipped).toBe('different_property');
    expect(await snapshot(pestParent.id)).toEqual(before);
  });

  // --- PR #5268 round 3 -----------------------------------------------------

  test('a rider MOVE onto a host date clears a stale recurring_dispatch_due_date and route_order (P1 fix #1 / P2 fix #2, fail-without-fix evidence)', async () => {
    const { syncRiderSeries } = require('../services/rider-series');
    const { pestParent } = await linkedPair();

    const dry = await syncRiderSeries(trx, pestParent.id, { dryRun: true });
    expect(dry.move.length).toBeGreaterThan(0);
    const { id: movingId, to } = dry.move[0];

    // A stale windowless-dispatch-pending stamp and a leftover route
    // position from wherever this row sat before — the same shape
    // recurring-dispatch-due.js and rebooker.js's own route_order
    // convention describe.
    await trx('scheduled_services').where({ id: movingId }).update({
      recurring_dispatch_due_date: PEST_START, route_order: 7,
    });

    const applied = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(applied.move.some((m) => m.id === movingId)).toBe(true);

    const after = await trx('scheduled_services').where({ id: movingId }).first();
    expect(after.scheduled_date.toISOString().slice(0, 10)).toBe(to);
    // Fail-without-fix: before P1 fix #1, recurring_dispatch_due_date stays
    // the stale PEST_START stamp here, and auto-dispatch (auto-dispatch/
    // candidate-slots.js) then constrains placement to +/-3 days around
    // that old date instead of the row's real new date. Before P2 fix #2,
    // route_order stays 7, interleaving the stop into the OLD day's order.
    expect(after.recurring_dispatch_due_date).toBeNull();
    expect(after.route_order).toBeNull();
  });

  test('a null-status future rider row is neither moved nor cancelled across two syncs (P1 fix #5, fail-without-fix evidence)', async () => {
    const { syncRiderSeries } = require('../services/rider-series');
    const { pestParent } = await linkedPair();

    // A legacy base row with status NULL — the CHECK constraint
    // (20260426000004) only restricts NON-NULL values, so a NULL status
    // passes it; AGENTS.md documents this shape as real, historical data.
    // Dated well short of MIN_GAP_DAYS (77) past the anchor, so it can
    // never coincidentally BE a planned date (a false pass either way).
    const legacyDate = addDays(PEST_START, 40);
    const legacyId = randomUUID();
    await trx('scheduled_services').insert({
      id: legacyId, customer_id: customerId, service_type: 'Pest Control', status: null,
      scheduled_date: legacyDate, window_start: '08:00', window_end: '09:00',
      is_recurring: true, recurring_pattern: 'quarterly', recurring_parent_id: pestParent.id,
      recurring_ongoing: true, source: 'admin', estimated_duration_minutes: 60,
    });
    const before = await trx('scheduled_services').where({ id: legacyId }).first();

    const first = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    // Fail-without-fix: before P1 fix #5, MOVABLE_ROW_STATUSES was not the
    // filter — a NULL status passed the old exclusion-based check
    // (JOIN_INELIGIBLE_STATUSES never lists null) and this row became a
    // real move or cancel candidate here.
    expect(first.move.some((m) => m.id === legacyId)).toBe(false);
    expect(first.cancel.some((c) => c.id === legacyId)).toBe(false);
    let after = await trx('scheduled_services').where({ id: legacyId }).first();
    expect(after.status).toBeNull();
    expect(after.scheduled_date.toISOString().slice(0, 10)).toBe(legacyDate);
    expect(String(after.window_start)).toBe(String(before.window_start));

    const second = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(second.move.some((m) => m.id === legacyId)).toBe(false);
    expect(second.cancel.some((c) => c.id === legacyId)).toBe(false);
    after = await trx('scheduled_services').where({ id: legacyId }).first();
    expect(after.status).toBeNull();
    expect(after.scheduled_date.toISOString().slice(0, 10)).toBe(legacyDate);
  });

  // --- P1 fix #4: host tech semantics ----------------------------------------
  describe('host tech semantics (P1 fix #4)', () => {
    test('an unpinned rider INSERT onto a host date joins the HOST tech, never the rider\'s own recurring_technician_id (fail-without-fix evidence)', async () => {
      const hostTechId = randomUUID();
      await trx('technicians').insert({ id: hostTechId, name: 'Synthetic Host Tech', employment_status: 'active', field_dispatchable: true });
      const riderOwnTechId = randomUUID();
      await trx('technicians').insert({ id: riderOwnTechId, name: 'Synthetic Rider Own Tech', employment_status: 'active', field_dispatchable: true });
      const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: hostTechId });
      await seedChildren(lawnParent, 'every_6_weeks', 9);
      const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
      // The rider's OWN template carries a recurring_technician_id with NO
      // override flag — the bug: recurringTemplateTechnicianId
      // (admin-schedule.js) prefers recurring_technician_id over
      // technician_id REGARDLESS of the override flag, so a naive
      // `{ ...template, technician_id: hostTech }` spread never actually
      // reaches the host's tech.
      await trx('scheduled_services').where({ id: pestParent.id }).update({
        recurring_technician_id: riderOwnTechId, recurring_technician_override: false, rides_parent_id: lawnParent.id,
      });

      const { syncRiderSeries } = require('../services/rider-series');
      const dry = await syncRiderSeries(trx, pestParent.id, { dryRun: true });
      const lawnDates = (await seriesRows(lawnParent.id)).map((r) => r.scheduled_date.toISOString().slice(0, 10));
      const hostDate = dry.insert.find((d) => lawnDates.includes(d));
      expect(hostDate).toBeTruthy(); // fail-without-fix precondition: a genuine host-date insert

      await syncRiderSeries(trx, pestParent.id, { dryRun: false });
      const landed = (await seriesRows(pestParent.id))
        .find((r) => r.scheduled_date.toISOString().slice(0, 10) === hostDate);
      expect(landed).toBeTruthy();
      expect(landed.technician_id).toBe(hostTechId);
    });

    test('a host with NO tech gives an unassigned rider, even though the rider has its own unpinned recurring_technician_id (fail-without-fix evidence)', async () => {
      const riderOwnTechId = randomUUID();
      await trx('technicians').insert({ id: riderOwnTechId, name: 'Synthetic Rider Own Tech', employment_status: 'active', field_dispatchable: true });
      const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: null });
      await seedChildren(lawnParent, 'every_6_weeks', 9);
      const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
      await trx('scheduled_services').where({ id: pestParent.id }).update({
        recurring_technician_id: riderOwnTechId, recurring_technician_override: false, rides_parent_id: lawnParent.id,
      });

      const { syncRiderSeries } = require('../services/rider-series');
      const dry = await syncRiderSeries(trx, pestParent.id, { dryRun: true });
      const lawnDates = (await seriesRows(lawnParent.id)).map((r) => r.scheduled_date.toISOString().slice(0, 10));
      const hostDate = dry.insert.find((d) => lawnDates.includes(d));
      expect(hostDate).toBeTruthy();

      await syncRiderSeries(trx, pestParent.id, { dryRun: false });
      const landed = (await seriesRows(pestParent.id))
        .find((r) => r.scheduled_date.toISOString().slice(0, 10) === hostDate);
      expect(landed).toBeTruthy();
      // Fail-without-fix: the bug returns riderOwnTechId here (the host's
      // null technician_id is silently ignored the same way).
      expect(landed.technician_id).toBeNull();
    });

    test('a PINNED rider (recurring_technician_override true) keeps its own tech, never the host\'s (regression guard — the pre-fix code already handled this case)', async () => {
      const hostTechId = randomUUID();
      await trx('technicians').insert({ id: hostTechId, name: 'Synthetic Host Tech', employment_status: 'active', field_dispatchable: true });
      const riderOwnTechId = randomUUID();
      await trx('technicians').insert({ id: riderOwnTechId, name: 'Synthetic Rider Own Tech', employment_status: 'active', field_dispatchable: true });
      const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: hostTechId });
      await seedChildren(lawnParent, 'every_6_weeks', 9);
      const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
      await trx('scheduled_services').where({ id: pestParent.id }).update({
        recurring_technician_id: riderOwnTechId, recurring_technician_override: true, rides_parent_id: lawnParent.id,
      });

      const { syncRiderSeries } = require('../services/rider-series');
      const dry = await syncRiderSeries(trx, pestParent.id, { dryRun: true });
      const lawnDates = (await seriesRows(lawnParent.id)).map((r) => r.scheduled_date.toISOString().slice(0, 10));
      const hostDate = dry.insert.find((d) => lawnDates.includes(d));
      expect(hostDate).toBeTruthy();

      await syncRiderSeries(trx, pestParent.id, { dryRun: false });
      const landed = (await seriesRows(pestParent.id))
        .find((r) => r.scheduled_date.toISOString().slice(0, 10) === hostDate);
      expect(landed).toBeTruthy();
      expect(landed.technician_id).toBe(riderOwnTechId);
    });

    test('a rider MOVE onto a host date also joins the HOST tech, never the rider\'s own unpinned recurring_technician_id (fail-without-fix evidence)', async () => {
      const { syncRiderSeries } = require('../services/rider-series');
      const { pestParent, lawnParent } = await linkedPair();
      const riderOwnTechId = randomUUID();
      await trx('technicians').insert({ id: riderOwnTechId, name: 'Synthetic Rider Own Tech', employment_status: 'active', field_dispatchable: true });
      await trx('scheduled_services').where({ id: pestParent.id }).update({
        recurring_technician_id: riderOwnTechId, recurring_technician_override: false,
      });

      const dry = await syncRiderSeries(trx, pestParent.id, { dryRun: true });
      const lawnDates = (await seriesRows(lawnParent.id)).map((r) => r.scheduled_date.toISOString().slice(0, 10));
      const hostMove = dry.move.find((m) => lawnDates.includes(m.to));
      expect(hostMove).toBeTruthy();

      await syncRiderSeries(trx, pestParent.id, { dryRun: false });
      const after = await trx('scheduled_services').where({ id: hostMove.id }).first();
      expect(after.scheduled_date.toISOString().slice(0, 10)).toBe(hostMove.to);
      expect(String(after.technician_id)).toBe(String(lawnParent.technician_id));
      expect(String(after.technician_id)).not.toBe(String(riderOwnTechId));
    });
  });

  // --- P1 fix #3: the cancellation follow-through -----------------------
  test('a surplus rider cancel through the resync also runs the cancellation follow-through: the tracker transitions off scheduled (P1 fix #3, fail-without-fix evidence)', async () => {
    const { syncRiderSeries } = require('../services/rider-series');
    const { pestParent } = await linkedPair();
    // Isolate from visit-group grouping (a separate, correct immovability
    // rule tested elsewhere) — same technique the "two movable rider rows
    // sharing one planned date" test uses, so the ORIGINAL row on the
    // shared date stays a movable/keep candidate throughout rather than
    // getting grouped onto its host's visit (visit_id) and dropping out of
    // the movable set entirely, which would leave nothing for the
    // duplicate below to conflict with.
    await trx('scheduled_services')
      .where((q) => { q.where('id', pestParent.id).orWhere('recurring_parent_id', pestParent.id); })
      .update({ property_id: null });
    await disablePropertyAnchoring();

    await syncRiderSeries(trx, pestParent.id, { dryRun: false }); // aligns all 4 pest rows onto plan dates
    const pestRowsAfterFirstSync = await seriesRows(pestParent.id);
    const movableRow = pestRowsAfterFirstSync.find((r) => r.scheduled_date.toISOString().slice(0, 10) > PEST_START);
    const dupDate = movableRow.scheduled_date;

    // A genuine duplicate on the SAME already-planned date — every OTHER
    // planned date is already claimed by the other 3 aligned pest rows, so
    // whichever of {movableRow, duplicateRow} loses the tie-break on this
    // date has NO planned date left to pair with: a guaranteed surplus
    // cancel, not a move (same fixture shape as the existing "two movable
    // rider rows sharing one planned date" test).
    const [duplicateRow] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Pest Control', status: 'pending',
      scheduled_date: dupDate, is_recurring: true, recurring_pattern: 'quarterly',
      recurring_parent_id: pestParent.id, recurring_ongoing: true, source: 'admin',
      track_state: 'scheduled',
    }).returning('*');
    // Explicit tracker precondition, so a later default-value change can't
    // silently make this test's own setup false.
    expect(duplicateRow.track_state).toBe('scheduled');

    const result = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    const pairIds = [movableRow.id, duplicateRow.id];
    const cancelledId = pairIds.find((id) => result.cancel.some((c) => c.id === id));
    expect(cancelledId).toBeTruthy();
    // The wiring: syncRiderSeries surfaces exactly the ids its own
    // transitionJobStatus call actually cancelled — what the deferred
    // follow-through below runs against. Fail-without-fix: before this
    // fix, syncRiderSeries's return value has no cancelledIds field at all.
    expect(result.cancelledIds).toContain(cancelledId);

    // The follow-through (runVisitCancellationFollowThrough) MUST run
    // AFTER the cancelling transaction commits — every step reads the
    // visit's committed state on its own connection. `trx` here is the
    // OUTERMOST transaction syncRiderSeries's own commitPromiseOf sees, so
    // committing it (instead of the usual per-test rollback) is what lets
    // the deferred follow-through actually run within this test's own
    // observable window — a rollback-only harness can never observe it.
    // Repoint the shared db mock to the plain root connection BEFORE
    // committing (trx.commit() itself doesn't consult the mock — this
    // ordering is what makes the deferred follow-through's OWN later DB
    // calls land on a connection that is still usable once `trx` closes).
    require('../models/db').connection = database;
    await trx.commit();
    // This test commits, so it must remove what it wrote: CI runs every
    // DATABASE_URL suite against one shared database.
    try {

    // The status flip landed inside the (now-committed) sync transaction
    // itself; the tracker transition is the deferred, post-commit part —
    // poll rather than assume a fixed number of microtask ticks, since it
    // is a real async DB round trip (trackTransitions.cancel's own nested
    // transaction) triggered off trx.executionPromise settling.
    const cancelledRow = await waitFor(async () => {
      const row = await database('scheduled_services').where({ id: cancelledId }).first();
      return row.track_state === 'cancelled' ? row : null;
    });
    expect(cancelledRow.status).toBe('cancelled');
    // Fail-without-fix: before P1 fix #3, the surplus cancel only ever
    // flipped scheduled_services.status — track_state stayed 'scheduled'
    // forever (this row's own precondition, asserted above), because
    // nothing called trackTransitions.cancel for a rider resync cancel.
    expect(cancelledRow.cancelled_at).toBeTruthy();
    } finally {
      const rows = await database('scheduled_services').where({ customer_id: customerId }).select('id', 'technician_id');
      const ids = rows.map((r) => r.id);
      const techIds = [...new Set(rows.map((r) => r.technician_id).filter(Boolean))];
      await database('job_status_history').whereIn('job_id', ids).del();
      await database('scheduled_service_addons').whereIn('scheduled_service_id', ids).del();
      await database('scheduled_services').whereIn('id', ids).whereNotNull('recurring_parent_id').del();
      await database('scheduled_services').whereIn('id', ids).del();
      await database('customer_properties').where({ customer_id: customerId }).del();
      await database('customers').where({ id: customerId }).del();
      if (techIds.length) await database('technicians').whereIn('id', techIds).where('name', 'like', 'Synthetic%').del();
    }
  });
});
