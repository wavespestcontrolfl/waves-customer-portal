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
const postgres = process.env.DATABASE_URL ? describe : describe.skip;

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

});
