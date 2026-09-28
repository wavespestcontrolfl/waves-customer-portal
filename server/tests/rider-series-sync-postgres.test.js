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

  afterEach(async () => { if (trx) await trx.rollback(); jest.clearAllMocks(); });
  afterAll(async () => { await database?.destroy(); });

  async function makeParent({ pattern, scheduledDate, technicianId = null, windowStart = '08:00', windowEnd = '10:00' }) {
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: pattern === 'every_6_weeks' ? 'Lawn Care' : 'Pest Control',
      status: 'pending', scheduled_date: scheduledDate, window_start: windowStart, window_end: windowEnd,
      technician_id: technicianId, is_recurring: true, recurring_pattern: pattern, recurring_ongoing: true,
      source: 'admin',
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

  test('pest seeds on its own quarterly cadence before any sync (fail-without-fix evidence)', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    await seedChildren(lawnParent, 'every_6_weeks', 9);
    const pestParent = await makeParent({ pattern: 'quarterly', scheduledDate: PEST_START });
    await seedChildren(pestParent, 'quarterly', 4);
    await trx('scheduled_services').where({ id: pestParent.id }).update({ rides_parent_id: lawnParent.id });
    // Isolate the diff/claim algorithm this test targets from visit-group
    // grouping (a SEPARATE, correct immovability rule this suite covers
    // elsewhere): both series resolve real groupable catalog rows and an
    // auto-anchored property in this shared QA database, so a first sync
    // would otherwise group every matched row onto its host's visit and
    // make it immovable, leaving nothing left to duplicate against.
    // property_id IS NULL is grouping's own hard requirement to skip
    // (visit-groups.js groupRowOn), and TEMPLATE_COPY_FIELDS carries it
    // forward onto every future insert/move, so clearing it once here
    // keeps grouping off for the rest of this test.
    await trx('scheduled_services')
      .where((q) => { q.where('id', pestParent.id).orWhere('recurring_parent_id', pestParent.id); })
      .update({ property_id: null });

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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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

  test('an inserted rider row never inherits the template row\'s annual_prepay_term_id', () => {
    const { _internals } = require('../services/rider-series');
    const row = _internals.buildRiderRowFromTemplate(
      { customer_id: customerId, service_type: 'Pest Control', annual_prepay_term_id: randomUUID() }, '2098-04-02', null, randomUUID(),
    );
    expect(row.annual_prepay_term_id).toBeUndefined();
  });

  // --- P1 fix #1: inserts template off the PARENT + overrides ------------
  test('inserted rows template off the series PARENT, never the rider\'s own latest occurrence — an occurrence-only edit on the latest row never becomes the future template (P1 fix #1, fail-without-fix evidence)', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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

  // --- P1 fix #4: let_lapse / not_ongoing / convert_ongoing ---------------
  test('runRecurringAlertAction let_lapse on a rider clears recurring_ongoing series-wide instead of resyncing it (P1 fix #4, fail-without-fix evidence)', async () => {
    const adminScheduleRouter = require('../routes/admin-schedule');
    const { runRecurringAlertAction } = adminScheduleRouter._test;
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
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

  // --- P1 fix #5: standalone-date conflict + tech-absence -----------------
  test('a standalone insert date that clashes with an existing visit is skipped this sync rather than double-booked (P1 fix #5)', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
    // A single lawn visit near the anchor, no further host coverage — the
    // rider must fall back to its own standalone cadence for everything
    // after it.
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    const pestTechId = randomUUID();
    await trx('technicians').insert({ id: pestTechId, name: 'Synthetic Pest Tech' });
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
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
    const lawnParent = await makeParent({ pattern: 'every_6_weeks', scheduledDate: LAWN_START, technicianId: lawnTechId });
    const pestTechId = randomUUID();
    await trx('technicians').insert({ id: pestTechId, name: 'Synthetic Pest Tech' });
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

  // --- P2 fix #6: kept rows pick up a re-windowed/reassigned host stop ---
  test('a kept, ungrouped rider row on a host date picks up the host\'s re-windowed/reassigned fields on a later sync; dry run reports it write-free; a second sync converges (P2 fix #6)', async () => {
    const lawnTechId = randomUUID();
    await trx('technicians').insert({ id: lawnTechId, name: 'Synthetic Lawn Tech' });
    const otherTechId = randomUUID();
    await trx('technicians').insert({ id: otherTechId, name: 'Synthetic Reassigned Tech' });
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
    // kept row stays in the movable/refresh-eligible set throughout.
    await trx('scheduled_services')
      .where((q) => { q.where('id', pestParent.id).orWhere('recurring_parent_id', pestParent.id); })
      .update({ property_id: null });

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

    const dryRefresh = await syncRiderSeries(trx, pestParent.id, { dryRun: true });
    expect(dryRefresh.refresh.some((r) => r.id === kept.id)).toBe(true);
    const keptStillOld = await trx('scheduled_services').where({ id: kept.id }).first('window_start', 'window_end', 'technician_id');
    expect(String(keptStillOld.window_start)).toBe(String(keptBefore.window_start));
    expect(String(keptStillOld.technician_id)).toBe(String(keptBefore.technician_id));

    const refreshResult = await syncRiderSeries(trx, pestParent.id, { dryRun: false });
    expect(refreshResult.refresh.some((r) => r.id === kept.id)).toBe(true);
    const hostRowAfter = await trx('scheduled_services').where({ id: hostRow.id }).first();
    const keptAfter = await trx('scheduled_services').where({ id: kept.id }).first();
    expect(String(keptAfter.window_start)).toBe(String(hostRowAfter.window_start));
    expect(String(keptAfter.window_end)).toBe(String(hostRowAfter.window_end));
    expect(String(keptAfter.technician_id)).toBe(String(otherTechId));

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
});
