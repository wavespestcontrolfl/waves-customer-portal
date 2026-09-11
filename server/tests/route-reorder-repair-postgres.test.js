let mockConnection;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConnection(...args);
  proxy.raw = (...args) => mockConnection.raw(...args);
  proxy.transaction = (...args) => mockConnection.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
const { randomUUID } = require('node:crypto');
const { runRouteReorder } = require('../services/route-reorder');
const { HQ } = require('../services/route-optimizer');
const { getScheduleQualityMeasurements } = require('../services/scheduling/day-quality');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

postgres('route quality and repair on isolated PostgreSQL fixtures', () => {
  let database;
  let technicianId;
  let customerId;
  let ids;
  const gates = ['GATE_ROUTE_REORDER_REPAIR', 'GATE_DRIVE_TIME_CALIBRATION', 'GATE_SCHEDULE_QUALITY_MEASUREMENTS'];
  const now = new Date('2040-09-09T08:00:00Z');
  const date = '2040-09-10';
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 3 } });
    gates.forEach(gate => { process.env[gate] = 'true'; });
  });
  afterAll(async () => { await database?.destroy(); gates.forEach(gate => { delete process.env[gate]; }); });
  beforeEach(async () => {
    mockConnection = await database.transaction({ isolationLevel: 'serializable' });
    technicianId = randomUUID(); customerId = randomUUID(); ids = [randomUUID(), randomUUID(), randomUUID()];
    await mockConnection('technicians').insert({ id: technicianId, name: 'Synthetic routing technician',
      active: true, employment_status: 'active', field_dispatchable: true });
    await mockConnection('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Route',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true });
    const common = { customer_id: customerId, technician_id: technicianId, scheduled_date: date,
      status: 'confirmed', service_type: 'Quarterly Pest Control Service', estimated_duration_minutes: 60,
      lat: HQ.lat, lng: HQ.lng, is_recurring: false };
    await mockConnection('scheduled_services').insert([
      { ...common, id: ids[0], window_start: '13:00', window_end: '14:00', route_order: 1 },
      { ...common, id: ids[1], window_start: '15:00', window_end: '17:00', route_order: 2 },
      { ...common, id: ids[2], window_start: '14:00', window_end: '15:00', route_order: null },
    ]);
  });
  afterEach(async () => {
    delete process.env.GATE_ROUTE_REORDER;
    delete process.env.GATE_SCHEDULE_QUALITY_ALERTS;
    await mockConnection.rollback();
  });

  test('unrepairable routes get one Dispatch card and a later repair clears it', async () => {
    const { refreshScheduleQualityAfterChange } = require('../services/scheduling/quality-after-change');
    process.env.GATE_ROUTE_REORDER = 'true';
    process.env.GATE_SCHEDULE_QUALITY_ALERTS = 'true';
    await mockConnection('scheduled_services').where('id', ids[0]).update({ auto_dispatch_locked: true });
    const first = await refreshScheduleQualityAfterChange({ jobId: ids[2], now }, mockConnection);
    expect(first.repair.applied).toBe(0);
    const cards = () => mockConnection('dispatch_alerts').where({ type: 'schedule_route_quality', tech_id: technicianId }).whereNull('resolved_at');
    const opened = await cards();
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toMatchObject({ date, departureMinutes: 480,
      issues: [expect.stringContaining('modeled after the promised arrival window')] });
    await refreshScheduleQualityAfterChange({ jobId: ids[2], now }, mockConnection);
    expect((await cards()).map(row => row.id)).toEqual(opened.map(row => row.id));
    await mockConnection('scheduled_services').where('id', ids[0]).update({ auto_dispatch_locked: false });
    expect((await refreshScheduleQualityAfterChange({ jobId: ids[2], now }, mockConnection)).repair.applied).toBe(1);
    expect(await cards()).toHaveLength(0);
    expect((await mockConnection('dispatch_alerts').where('id', opened[0].id).first()).resolved_at).not.toBeNull();
  }, 30000);

  test('missing locations and unallocated work surface without claiming capacity or changing appointments', async () => {
    const { refreshScheduleQualityAlerts } = require('../services/scheduling/quality-alerts');
    process.env.GATE_SCHEDULE_QUALITY_ALERTS = 'true';
    await mockConnection('scheduled_services').where('id', ids[0]).update({ lat: null, lng: null });
    await mockConnection('scheduled_services').where('id', ids[2]).update({ technician_id: null });
    const before = await mockConnection('scheduled_services').whereIn('id', ids).orderBy('id').select('*');
    expect((await refreshScheduleQualityAlerts({ dates: [date], now }, mockConnection)).status).toBe('reconciled');
    const cards = await mockConnection('dispatch_alerts').where({ type: 'schedule_route_quality' }).whereNull('resolved_at');
    expect(cards.find(row => row.tech_id === technicianId).payload.issues).toEqual([expect.stringContaining('without a usable location')]);
    expect(cards.find(row => row.tech_id == null).payload.issues).toContainEqual(expect.stringContaining('placement with an available technician'));
    expect(await mockConnection('scheduled_services').whereIn('id', ids).orderBy('id').select('*')).toEqual(before);
    await mockConnection('scheduled_services').whereIn('id', ids).update({ status: 'cancelled' });
    expect((await refreshScheduleQualityAlerts({ dates: [date], now }, mockConnection)).resolved).toBe(cards.length);
    expect(await mockConnection('dispatch_alerts').where({ type: 'schedule_route_quality' }).whereNull('resolved_at')).toHaveLength(0);
  });

  test('a busy day cannot flood the Action Queue: per-date cards are capped and the rest summarized', async () => {
    // GET /api/admin/dispatch/alerts returns 50 rows. Four technicians here
    // stand in for the nine a real day can carry across six overnight dates.
    const { refreshScheduleQualityAlerts } = require('../services/scheduling/quality-alerts');
    const { MAX_CARDS_PER_DATE } = require('../services/scheduling/quality-alerts');
    process.env.GATE_SCHEDULE_QUALITY_ALERTS = 'true';
    await mockConnection('scheduled_services').where('id', ids[0]).update({ lat: null, lng: null });
    const extras = [randomUUID(), randomUUID(), randomUUID()];
    for (const techId of extras) {
      await mockConnection('technicians').insert({ id: techId, name: `Synthetic routing technician ${techId.slice(0, 4)}`,
        active: true, employment_status: 'active', field_dispatchable: true });
      await mockConnection('scheduled_services').insert({ id: randomUUID(), customer_id: customerId, technician_id: techId,
        scheduled_date: date, status: 'confirmed', service_type: 'Quarterly Pest Control Service',
        estimated_duration_minutes: 60, lat: null, lng: null, is_recurring: false, window_start: '09:00', window_end: '10:00' });
    }
    const open = () => mockConnection('dispatch_alerts').where({ type: 'schedule_route_quality' }).whereNull('resolved_at').orderBy('created_at');
    expect((await refreshScheduleQualityAlerts({ dates: [date], now }, mockConnection)).created).toBe(MAX_CARDS_PER_DATE);
    const cards = await open();
    expect(cards).toHaveLength(MAX_CARDS_PER_DATE);
    const summary = cards.find(row => row.payload?.overflow);
    expect(summary.payload.issues).toEqual([expect.stringContaining(`2 more routes on ${date}`)]);
    expect(summary.tech_id).toBeNull();
    // The kept cards name their technician, so a socket-delivered card (which
    // carries the bare row, without the joined tech_name) is not just a date.
    for (const kept of cards.filter(row => !row.payload?.overflow)) {
      expect(kept.payload.techName).toEqual(expect.stringContaining('Synthetic routing technician'));
    }
    // Idempotent: the same day reconciles to the same rows, not a fresh set.
    expect(await refreshScheduleQualityAlerts({ dates: [date], now }, mockConnection)).toMatchObject({ created: 0, resolved: 0 });
    expect((await open()).map(row => row.id)).toEqual(cards.map(row => row.id));
  }, 30000);

  test('a kill during an alert insert rolls back the card and suppresses its broadcast', async () => {
    const { refreshScheduleQualityAlerts } = require('../services/scheduling/quality-alerts');
    const { getIo } = require('../sockets');
    process.env.GATE_SCHEDULE_QUALITY_ALERTS = 'true';
    getIo.mockClear();
    // Revoke after PostgreSQL has answered the insert, while the checker
    // still owns its transaction. All SQL and commit handling remain real.
    const conn = { transaction: (callback, options) => mockConnection.transaction(trx => callback(new Proxy(trx, {
      apply(target, receiver, args) {
        const query = Reflect.apply(target, receiver, args);
        if (args[0] === 'dispatch_alerts') query.on('query-response', rows => {
          if (Array.isArray(rows) && rows.some(row => row.tech_id === technicianId)) {
            delete process.env.GATE_SCHEDULE_QUALITY_ALERTS;
          }
        });
        return query;
      },
    })), options) };
    expect(await refreshScheduleQualityAlerts({ dates: [date], now }, conn)).toEqual({ status: 'gate_off' });
    expect(await mockConnection('dispatch_alerts').where({ type: 'schedule_route_quality', tech_id: technicianId })).toHaveLength(0);
    expect(getIo).not.toHaveBeenCalled();
  });

  test('future-planning cards expire when their service day starts', async () => {
    const { refreshScheduleQualityAlerts } = require('../services/scheduling/quality-alerts');
    process.env.GATE_SCHEDULE_QUALITY_ALERTS = 'true';
    await refreshScheduleQualityAlerts({ dates: [date], now }, mockConnection);
    expect(await mockConnection('dispatch_alerts').where({ type: 'schedule_route_quality', tech_id: technicianId }).whereNull('resolved_at')).toHaveLength(1);
    await refreshScheduleQualityAlerts({ dates: [], now: parseETDateTime(`${date}T00:01`) }, mockConnection);
    expect(await mockConnection('dispatch_alerts').where({ type: 'schedule_route_quality', tech_id: technicianId }).whereNull('resolved_at')).toHaveLength(0);
  });

  test('concurrent committed checkers create only one open route card', async () => {
    const { refreshScheduleQualityAlerts } = require('../services/scheduling/quality-alerts');
    process.env.GATE_SCHEDULE_QUALITY_ALERTS = 'true';
    const concurrentTech = randomUUID();
    const concurrentCustomer = randomUUID();
    const concurrentJob = randomUUID();
    const existingCards = await database('dispatch_alerts').pluck('id');
    try {
      // These fixtures must commit so both independent connections can see
      // them. Cleanup is limited to the explicitly created synthetic rows.
      await database.transaction(async trx => {
        await trx('technicians').insert({ id: concurrentTech, name: 'Synthetic concurrent technician',
          active: true, employment_status: 'active', field_dispatchable: true });
        await trx('customers').insert({ id: concurrentCustomer, first_name: 'Synthetic', last_name: 'Concurrent',
          email: `${concurrentCustomer}@example.invalid`, phone: `fixture-${concurrentCustomer.slice(0, 8)}`, active: true });
        await trx('scheduled_services').insert({ id: concurrentJob, customer_id: concurrentCustomer, technician_id: concurrentTech,
          scheduled_date: date, status: 'confirmed', service_type: 'Quarterly Pest Control Service',
          window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60, is_recurring: false });
      });
      const results = await Promise.all([
        refreshScheduleQualityAlerts({ dates: [date], now }, database),
        refreshScheduleQualityAlerts({ dates: [date], now }, database),
      ]);
      expect(results.every(result => result.status === 'reconciled')).toBe(true);
      expect(results.some(result => result.created === 0)).toBe(true);
      expect(await database('dispatch_alerts').where({ type: 'schedule_route_quality', tech_id: concurrentTech }).whereNull('resolved_at')).toHaveLength(1);
    } finally {
      await database.transaction(async trx => {
        await trx('dispatch_alerts').where({ type: 'schedule_route_quality' }).whereNotIn('id', existingCards).delete();
        await trx('scheduled_services').where('id', concurrentJob).delete();
        await trx('customers').where('id', concurrentCustomer).delete();
        await trx('technicians').where('id', concurrentTech).delete();
      });
    }
  }, 30000);

  test('the nightly pass surfaces an unresolved pinned route in the existing Dispatch queue', async () => {
    process.env.GATE_SCHEDULE_QUALITY_ALERTS = 'true';
    await mockConnection('scheduled_services').where('id', ids[0]).update({ auto_dispatch_locked: true });
    const result = await runRouteReorder({ now });
    expect(result).toMatchObject({ applied: 0, failed: 0 });
    const cards = await mockConnection('dispatch_alerts').where({ type: 'schedule_route_quality', tech_id: technicianId }).whereNull('resolved_at');
    expect(cards).toHaveLength(1);
    expect(cards[0].payload.issues).toContainEqual(expect.stringContaining('modeled after'));
  });

  test('the fenced repair changes only route_order and records before-route measurements', async () => {
    const before = await mockConnection('scheduled_services').whereIn('id', ids).select('*').orderBy('id');
    const result = await runRouteReorder({ now });
    expect(result).toMatchObject({ applied: 1, failed: 0 });
    const after = await mockConnection('scheduled_services').whereIn('id', ids).select('*').orderBy('id');
    const withoutOrder = rows => rows.map(({ route_order: _order, ...row }) => row);
    expect(withoutOrder(after)).toEqual(withoutOrder(before));
    expect([...after].sort((a, b) => a.route_order - b.route_order).map(row => row.id)).toEqual([ids[0], ids[2], ids[1]]);
    const ledger = await mockConnection('route_optimization_planner_runs').where('id', result.ledgerId).first('result');
    const details = typeof ledger.result === 'string' ? JSON.parse(ledger.result) : ledger.result;
    expect(details.reorders[0].source).toBe('chronological_repair');
    expect(details.route_quality[0]).toMatchObject({ serviceMinutes: 240, modeledLateVisits: [expect.objectContaining({ id: ids[2], lateMinutes: 60 })] });
    expect(details.route_quality[1]).toMatchObject({ snapshot_phase: 'applied_reorder', modeledLateVisits: [] });
    expect(details.route_quality[1].plannedStops.map(stop => stop.id)).toEqual([ids[0], ids[2], ids[1]]);
  });

  test('measurements use live hold occupancy, unassigned work and configured closures', async () => {
    const future = etDateString(addETDays(new Date(), 10));
    await mockConnection('scheduled_services').whereIn('id', ids).update({ scheduled_date: future });
    await mockConnection('scheduled_services').where('id', ids[2]).update({ technician_id: null });
    await mockConnection('scheduled_services').where('id', ids[1]).update({ reservation_expires_at: new Date(Date.now() - 60000) });
    await mockConnection('schedule_blackout_dates').insert({ date: future, reason: 'Synthetic closure' }).onConflict('date').ignore();
    const result = await getScheduleQualityMeasurements({ date: future, departure_time: '08:00', target_return_time: '17:00', break_minutes: 30 }, mockConnection);
    const day = result.days[0];
    expect(day).toMatchObject({ closed: true, unallocatedVisits: 1, unallocatedServiceMinutes: 60 });
    expect(day.byTech.find(tech => tech.technicianId === technicianId)).toMatchObject({ scheduledVisits: 1, serviceMinutes: 60,
      remainingServiceBudgetMinutes: null, uncertaintyReasons: expect.arrayContaining(['unallocated_work_requires_placement', 'scheduled_day_off']) });
  });

  test('candidate reads honor stored work, preferences and family pauses without creating a hold or changing any visit', async () => {
    const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');
    const future = etDateString(addETDays(new Date(), 10));
    // This scenario needs an open day independently of the day-of-week on
    // which CI runs. Both synthetic configuration edits roll back below.
    await mockConnection('system_settings').where('key', 'schedule_weekly_days_off').update({ value: '[]' });
    await mockConnection('schedule_blackout_dates').where('date', future).delete();
    await mockConnection('scheduled_services').whereIn('id', ids).update({ scheduled_date: future, route_order: null });
    await mockConnection('scheduled_services').where('id', ids[2]).update({ technician_id: null });
    await mockConnection('property_preferences').insert({ customer_id: customerId, preferred_time: 'afternoon' });
    const [hold] = await mockConnection('plan_holds').insert({ customer_id: customerId, family_key: 'lawn_care',
      starts_on: future, resume_on: etDateString(addETDays(parseETDateTime(`${future}T12:00`), 10)) }).returning('id');
    const before = await mockConnection('scheduled_services').whereIn('id', ids).orderBy('id').select('*');
    const input = { date: future, candidate_service_id: ids[2], departure_time: '08:00', target_return_time: '18:00', break_minutes: 30 };
    const result = await executeScheduleTool('find_schedule_gaps', input);
    const candidate = result.days[0].byTech.find(tech => tech.technicianId === technicianId).candidateAnalysis;
    expect(candidate).toMatchObject({ workdayVerified: true, automaticMoveAuthorized: false, reason: 'route_fit_requires_staff_review' });
    expect(candidate.routeFits.length).toBeGreaterThan(0);
    expect(result.days[0].byTech.find(tech => tech.technicianId === technicianId)).toMatchObject({
      insertionStatus: candidate.reason, feasibleInsertionWindows: candidate.feasibleInsertionWindows,
    });
    expect(candidate.routeFits.every(fit => Number(fit.windowStart.slice(0, 2)) >= 12 && fit.modeledReturnMinuteWithAllowance <= 1080)).toBe(true);
    const after = await mockConnection('scheduled_services').whereIn('id', ids).orderBy('id').select('*');
    expect(after).toEqual(before);
    expect((await mockConnection('plan_holds').where('customer_id', customerId))).toHaveLength(1);
    // A paused lawn plan does not block pest work. Changing the candidate
    // itself to that family makes the same hold apply.
    await mockConnection('scheduled_services').where('id', ids[2]).update({ service_type: 'Lawn Care Service' });
    const paused = await executeScheduleTool('find_schedule_gaps', input);
    expect(paused.days[0].byTech.find(tech => tech.technicianId === technicianId).candidateAnalysis.reason).toBe('plan_paused_on_date');
    expect(await mockConnection('plan_holds').where('id', hold.id).first('status')).toEqual({ status: 'active' });
  });

  test('a dispatch update remeasures the source and destination without changing appointments', async () => {
    const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');
    const { getRoutePerformance } = require('../services/scheduling/route-performance');
    const original = etDateString(addETDays(new Date(), 10));
    const destination = etDateString(addETDays(new Date(), 11));
    await mockConnection('scheduled_services').whereIn('id', ids).update({ scheduled_date: original });
    await mockConnection('scheduled_services').where('id', ids[2]).update({ scheduled_date: destination });
    const before = await mockConnection('scheduled_services').whereIn('id', ids).orderBy('id').select('*');
    await emitDispatchJobUpdate({ jobId: ids[2], previousDate: original });
    expect(await mockConnection('scheduled_services').whereIn('id', ids).orderBy('id').select('*')).toEqual(before);
    const ledger = await mockConnection('route_optimization_planner_runs').where('run_type', 'schedule_quality_change').first();
    expect(ledger).toMatchObject({ applied_count: 0, status: 'completed' });
    const details = typeof ledger.result === 'string' ? JSON.parse(ledger.result) : ledger.result;
    const snapshots = details.route_quality.filter(row => row.technician_id === technicianId);
    expect(snapshots.map(row => [row.date, row.plannedStops.length])).toEqual([[original, 2], [destination, 1]]);
    expect(JSON.stringify(details)).not.toContain('Synthetic routing technician');
    const measured = await getRoutePerformance({ from: original, to: destination, now: addETDays(new Date(), 12) }, mockConnection);
    expect(measured.plans.filter(plan => plan.technicianId === technicianId).map(plan => plan.snapshotPhase))
      .toEqual(['schedule_change', 'schedule_change']);
    expect(measured.missingBaselineDates).toEqual([]);
  });

  test('removing the last appointment replaces the prior planning snapshot with an empty route', async () => {
    const { refreshScheduleQualityAfterChange } = require('../services/scheduling/quality-after-change');
    const { getRoutePerformance } = require('../services/scheduling/route-performance');
    const future = etDateString(addETDays(new Date(), 10));
    await mockConnection('scheduled_services').whereIn('id', ids).update({ scheduled_date: future });
    await refreshScheduleQualityAfterChange({ jobId: ids[0] }, mockConnection);
    await mockConnection('scheduled_services').whereIn('id', ids).update({ status: 'cancelled' });
    const refreshed = await refreshScheduleQualityAfterChange({ jobId: ids[0] }, mockConnection);
    expect(refreshed).toMatchObject({ status: 'recorded', dates: [future] });
    const result = await getRoutePerformance({ from: future, to: future, now: addETDays(new Date(), 11) }, mockConnection);
    expect(result.plans.find(plan => plan.technicianId === technicianId)).toMatchObject({
      planningRunId: refreshed.ledgerId, snapshotPhase: 'schedule_change', plannedVisits: 0, onTimeRate: null,
    });
  });

  test('a measurement query failure rolls back its savepoint and leaves the caller transaction usable', async () => {
    const { refreshScheduleQualityAfterChange } = require('../services/scheduling/quality-after-change');
    await mockConnection.schema.renameTable('schedule_blackout_dates', 'synthetic_hidden_blackouts');
    const refreshed = await refreshScheduleQualityAfterChange({ dates: [etDateString(addETDays(new Date(), 10))] }, mockConnection);
    expect(refreshed).toEqual({ status: 'failed' });
    expect(await mockConnection('scheduled_services').whereIn('id', ids)).toHaveLength(3);
    expect(await mockConnection('route_optimization_planner_runs').where('run_type', 'schedule_quality_change')).toHaveLength(0);
  });

  test.each([
    [false, 'rescheduled', false],
    [true, 'rescheduled', true],
    [false, 'confirmed', true],
    [true, 'cancelled', false],
  ])('sibling dates preserve ordinary/due placement semantics (due=%s, sibling=%s)', async (due, status, blocked) => {
    const { loadGapCandidate, analyzeGapCandidate } = require('../services/scheduling/gap-candidates');
    await mockConnection('scheduled_services').whereIn('id', ids).update({ is_recurring: true });
    await mockConnection('scheduled_services').where('id', ids[0]).update({ scheduled_date: '2040-08-01' });
    await mockConnection('scheduled_services').where('id', ids[1]).update({ recurring_parent_id: ids[0], status });
    await mockConnection('scheduled_services').where('id', ids[2]).update({ recurring_parent_id: ids[0],
      scheduled_date: '2040-09-11', recurring_dispatch_due_date: due ? date : null });
    const before = await mockConnection('scheduled_services').whereIn('id', ids).orderBy('id').select('*');
    const candidate = await loadGapCandidate(ids[2], mockConnection);
    const result = analyzeGapCandidate(candidate, [], { date, technicianId, now: new Date('2040-09-09T12:00:00Z'),
      today: '2040-09-09', departureMinutes: 480, targetReturnMinutes: 1080, breakMinutes: 30, closed: false });
    expect(result.reason).toBe(blocked ? 'another_series_visit_on_date' : 'route_fit_requires_staff_review');
    expect(result.routeFits.length > 0).toBe(!blocked);
    expect(await mockConnection('scheduled_services').whereIn('id', ids).orderBy('id').select('*')).toEqual(before);
  });
});
