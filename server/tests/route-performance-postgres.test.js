jest.mock('../models/db', () => ({}));
const { randomUUID } = require('node:crypto');
const { getRoutePerformance } = require('../services/scheduling/route-performance');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { buildCloseoutRequirementsSnapshot } = require('../services/service-closeout-requirements');
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

postgres('recorded route evidence on isolated PostgreSQL', () => {
  let database;
  let trx;
  let technicianId;
  let customerId;
  let jobId;
  let ledgerId;
  let past;
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
  });
  afterAll(async () => { await database?.destroy(); });
  beforeEach(async () => {
    trx = await database.transaction({ isolationLevel: 'serializable' });
    technicianId = randomUUID(); customerId = randomUUID(); jobId = randomUUID();
    past = etDateString(addETDays(new Date(), -2));
    const captured = addETDays(parseETDateTime(`${past}T04:20`), -1);
    const arrival = parseETDateTime(`${past}T13:15`);
    const completion = parseETDateTime(`${past}T14:00`);
    await trx('technicians').insert({ id: technicianId, name: 'Synthetic evidence technician', active: true });
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Evidence',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`, active: true });
    await trx('scheduled_services').insert({ id: jobId, customer_id: customerId, technician_id: technicianId,
      scheduled_date: past, status: 'completed', service_type: 'Quarterly Pest Control Service',
      window_start: '13:00', window_end: '14:00', actual_start_time: arrival, actual_end_time: completion,
      service_time_minutes: 45, actual_duration_minutes: 45, is_recurring: false });
    await trx('service_records').insert({ customer_id: customerId, technician_id: technicianId,
      scheduled_service_id: jobId, service_date: past, service_type: 'Quarterly Pest Control Service',
      structured_notes: JSON.stringify({ timeOnSite: '45:00' }) });
    await trx('job_status_history').insert([
      { job_id: jobId, from_status: 'confirmed', to_status: 'on_site', transitioned_at: arrival, transitioned_by: technicianId },
      { job_id: jobId, from_status: 'on_site', to_status: 'completed', transitioned_at: completion, transitioned_by: technicianId },
    ]);
    const [ledger] = await trx('route_optimization_planner_runs').insert({ run_type: 'schedule_quality_change', status: 'completed',
      start_date: past, end_date: past, created_at: captured, technician_ids: JSON.stringify([technicianId]),
      service_types: JSON.stringify([]), constraints: JSON.stringify({}), result: JSON.stringify({ route_quality: [{
        date: past, technician_id: technicianId, as_of: captured.toISOString(), snapshot_phase: 'schedule_change',
        plannedStops: [{ id: jobId, serviceMinutes: 60, predictedArrivalMinute: 780, arrivalWindow: { startMin: 780, endMin: 900 } }],
      }] }) }).returning('id');
    ledgerId = ledger.id;
  });
  afterEach(async () => { await trx?.rollback(); });

  test('joins a pre-service plan to matching status and completion evidence without mutating the visit', async () => {
    const before = await trx('scheduled_services').where('id', jobId).first();
    const result = await getRoutePerformance({ from: past, to: past }, trx);
    expect(result.plans.find(plan => plan.technicianId === technicianId)).toMatchObject({ planningRunId: ledgerId,
      knownArrivals: 1, onTimeRate: 1, durationEvidenceCounts: { recorded_lifecycle_interval: 1 },
      stops: [expect.objectContaining({ appointmentId: jobId, recordedServiceMinutes: 45,
        servicePredictionErrorMinutes: -15, arrivalPredictionErrorMinutes: 15 })] });
    expect(await trx('scheduled_services').where('id', jobId).first()).toEqual(before);
  });

  test('a late-created ledger cannot manufacture a pre-service baseline', async () => {
    await trx('route_optimization_planner_runs').where('id', ledgerId).update({ created_at: new Date() });
    const result = await getRoutePerformance({ from: past, to: past }, trx);
    expect(result.plans.some(plan => plan.technicianId === technicianId)).toBe(false);
    expect(result.missingBaselineRoutes).toContainEqual({ date: past, technicianId });
    expect(result.unbaselinedCompletedVisits).toBeGreaterThanOrEqual(1);
  });

  test.each([false, true])('the committed record retains its timing evidence when backfill=%s and a newer recap exists', async backfill => {
    const canonical = await trx('service_records').where('scheduled_service_id', jobId).first('id');
    await trx('service_records').where('id', canonical.id).update({ structured_notes: JSON.stringify({ timeOnSite: '45:00', backfill }) });
    await trx('service_completion_attempts').insert({ service_id: jobId, idempotency_key: randomUUID(),
      status: 'succeeded', service_record_id: canonical.id });
    await trx('service_records').insert({ customer_id: customerId, technician_id: technicianId,
      scheduled_service_id: jobId, service_date: past, service_type: 'Quarterly Pest Control Service',
      created_at: new Date(Date.now() + 1000), structured_notes: JSON.stringify({ timeOnSite: 1 }) });
    const result = await getRoutePerformance({ from: past, to: past }, trx);
    expect(result.plans.find(plan => plan.technicianId === technicianId)).toMatchObject({
      knownArrivals: backfill ? 0 : 1,
      stops: [expect.objectContaining({ recordedServiceMinutes: 45,
        durationEvidence: backfill ? 'backfill_reported' : 'recorded_lifecycle_interval' })],
    });
  });

  test('a reassigned visit is unbaselined on its new technician route', async () => {
    const otherTech = randomUUID();
    await trx('technicians').insert({ id: otherTech, name: 'Synthetic second technician', active: true });
    await trx('scheduled_services').where('id', jobId).update({ technician_id: otherTech });
    const result = await getRoutePerformance({ from: past, to: past }, trx);
    expect(result.missingBaselineRoutes).toContainEqual({ date: past, technicianId: otherTech });
    expect(result.unbaselinedCompletedVisits).toBeGreaterThanOrEqual(1);
    expect(result.plans.find(plan => plan.technicianId === technicianId).stops[0].arrivalOutcome).toBe('day_or_technician_changed');
  });

  test('duration cohorts use the committed frozen identity, need no baseline and exclude callbacks and included work', async () => {
    const frozenServiceId = randomUUID();
    const closeoutRequirements = buildCloseoutRequirementsSnapshot({ serviceId: frozenServiceId,
      requiresServiceReport: false, source: 'catalog' }, { now: parseETDateTime(`${past}T14:00`) });
    const canonical = await trx('service_records').where('scheduled_service_id', jobId).first('id');
    await trx('service_records').where('id', canonical.id).update({
      structured_notes: JSON.stringify({ timeOnSite: '45:00', closeoutRequirements }),
    });
    await trx('service_completion_attempts').insert({ service_id: jobId, idempotency_key: randomUUID(),
      status: 'succeeded', service_record_id: canonical.id });
    await trx('service_records').insert({ customer_id: customerId, technician_id: technicianId,
      scheduled_service_id: jobId, service_date: past, service_type: 'Later recap', created_at: new Date(Date.now() + 1000),
      structured_notes: JSON.stringify({ timeOnSite: 1 }) });
    await trx('route_optimization_planner_runs').where('id', ledgerId).update({ created_at: new Date() });
    const before = await trx('scheduled_services').where('id', jobId).first();
    const result = await getRoutePerformance({ from: past, to: past }, trx);
    expect(result.durationReferences).toMatchObject({ automaticApplication: false,
      byService: expect.arrayContaining([expect.objectContaining({ serviceId: frozenServiceId, samples: 1,
        status: 'insufficient_samples', medianMinutes: null, observedMinimumMinutes: 45 })]) });
    expect(await trx('scheduled_services').where('id', jobId).first()).toEqual(before);
    for (const flags of [{ is_callback: true }, { is_callback: false, followup_included: true }]) {
      await trx('scheduled_services').where('id', jobId).update(flags);
      const filtered = (await getRoutePerformance({ from: past, to: past }, trx)).durationReferences;
      expect(filtered.byService.some(group => group.serviceId === frozenServiceId)).toBe(false);
      expect(filtered.excluded.callback_or_included_followup).toBeGreaterThanOrEqual(1);
    }
  });

  test.each([-3, 0, 1])('duration exclusions omit a baseline visit moved outside past work (offset %i)', async offset => {
    const target = etDateString(addETDays(new Date(), offset));
    await trx('scheduled_services').where('id', jobId).update({ scheduled_date: target, is_callback: true });
    const range = { from: past, to: etDateString(addETDays(new Date(), 2)) };
    const before = (await getRoutePerformance(range, trx)).durationReferences;
    await trx('scheduled_services').where('id', jobId).update({ status: 'cancelled' });
    expect((await getRoutePerformance(range, trx)).durationReferences).toEqual(before);
  });
});
