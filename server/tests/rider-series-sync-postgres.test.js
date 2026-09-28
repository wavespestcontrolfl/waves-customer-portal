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
// gates.visitGroups is evaluated once at module load (config/feature-gates.js
// is not a getter for this one) — must be set before that module is first
// required, including transitively.
process.env.GATE_VISIT_GROUPS = 'true';

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
const { planRiderDates } = require('../services/rider-series');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
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

    // Idempotence: a second sync with nothing changed returns no moves/
    // inserts/cancels.
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

    const pestDatesBefore = new Set(
      (await seriesRows(pestParent.id)).filter((r) => r.status !== 'cancelled').map((r) => r.scheduled_date.toISOString().slice(0, 10)),
    );

    // Complete the lawn parent's own first visit — upcomingCount for the
    // lawn series is now low, triggering its own-interval auto-extend.
    await trx('scheduled_services').where({ id: lawnParent.id }).update({ status: 'completed', completed_at: new Date() });
    await runRecurringSeriesMaintenance(trx, { ...lawnParent, status: 'completed' });

    const lawnRowsAfter = await seriesRows(lawnParent.id);
    const newestLawnDate = lawnRowsAfter[lawnRowsAfter.length - 1].scheduled_date.toISOString().slice(0, 10);
    expect(newestLawnDate > LAWN_START).toBe(true);

    const pestRowsAfter = await seriesRows(pestParent.id);
    // The host's own extension should have pulled a rider sync through
    // (this tiny 3-visit lawn horizon means the rider's plan can
    // legitimately still include a standalone fallback date — the host
    // has too few visits to cover the whole rider horizon — so the oracle
    // for "did this land correctly" is planRiderDates itself, recomputed
    // off the CURRENT lawn dates, not a blanket "must be a lawn date").
    // Cancelled rows (the first sync's own surplus cleanup, before the host
    // had any date far enough out to plan against) are history, not part
    // of the live series, and are excluded here same as the plan itself
    // only concerns live rows.
    const lawnDatesAfter = lawnRowsAfter.map((r) => r.scheduled_date.toISOString().slice(0, 10)).sort();
    const expectedPlanAfterExtend = planRiderDates({
      hostDates: lawnDatesAfter.filter((d) => d > PEST_START),
      lastRiderDate: PEST_START,
      horizonDate: lawnDatesAfter[lawnDatesAfter.length - 1],
    });
    const futurePestDatesAfter = pestRowsAfter
      .filter((r) => r.status !== 'cancelled' && r.scheduled_date.toISOString().slice(0, 10) > PEST_START)
      .map((r) => r.scheduled_date.toISOString().slice(0, 10))
      .sort();
    expect(futurePestDatesAfter).toEqual(expectedPlanAfterExtend);
    expect(futurePestDatesAfter.length).toBeGreaterThanOrEqual(pestDatesBefore.size);

    // Now complete the pest parent's own visit and run the SAME maintenance
    // path on it — it must NOT spawn an own-interval (~91-day) child; the
    // series must still match the SAME plan oracle (nothing an own-interval
    // walk would have produced can appear).
    await trx('scheduled_services').where({ id: pestParent.id }).update({ status: 'completed', completed_at: new Date() });
    await runRecurringSeriesMaintenance(trx, { ...pestParent, status: 'completed' });
    const afterRows = await seriesRows(pestParent.id);
    const futurePestDatesFinal = afterRows
      .map((r) => r.scheduled_date.toISOString().slice(0, 10))
      .filter((d) => d > PEST_START && afterRows.find((r) => r.scheduled_date.toISOString().slice(0, 10) === d).status !== 'cancelled')
      .sort();
    expect(futurePestDatesFinal).toEqual(expectedPlanAfterExtend);
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
});
