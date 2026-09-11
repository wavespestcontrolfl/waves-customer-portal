const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const { createLawnVisitDb } = require('./helpers/lawn-visit-db');
const pipelineMigration = require('../models/migrations/20260908000030_lawn_assessment_runs_pipeline');
const ownerMigration = require('../models/migrations/20260909000050_lawn_assessment_runs_pipeline_owner');
const runs = require('../services/lawn-visit-runs');
const LawnIntel = require('../services/lawn-intelligence');
const { deliverConfirmedAssessment, sweepAbandonedDeliveries, scheduleRecovery } = require('../services/lawn-visit-delivery');
const { etDateString } = require('../utils/datetime-et');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => false) }));

const AI = { turf_density: 80, weed_suppression: 82, color_health: 76, fungus_control: 85, thatch_level: 90, stress_damage: 85 };
const FINAL = { ...AI, turf_density: 60, stress_damage: 70 };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

(SKIP ? describe.skip : describe)('durable lawn delivery (real PostgreSQL)', () => {
  let db;
  beforeAll(async () => {
    db = await createLawnVisitDb();
    for (const table of ['customer_signals', 'tech_calibration']) {
      await db.knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [db.schema, table, table]);
    }
    await pipelineMigration.up(db.knex);
    await ownerMigration.up(db.knex);
  }, 60000);
  afterAll(async () => { if (db) await db.dispose(); });
  const stored = (id) => runs.loadRun(id, db.knex);
  const expire = (id) => db.knex('lawn_assessment_runs').where({ assessment_id: id })
    .update({ pipeline_claimed_at: db.knex.raw("clock_timestamp() - interval '16 minutes'") });

  async function seed({ confirmed = true, calibration = true, service = false } = {}) {
    const customerId = randomUUID(), technicianId = randomUUID();
    await db.knex('customers').insert({ id: customerId, first_name: 'Recovery fixture', phone: `+1555${String(parseInt(customerId.slice(0, 6), 16) % 10000000).padStart(7, '0')}` });
    await db.knex('technicians').insert({ id: technicianId, name: 'Fixture technician' });
    const [assessment] = await db.knex('lawn_assessments').insert({
      customer_id: customerId, technician_id: technicianId, service_date: etDateString(),
      ...FINAL, overall_score: 75, confirmed_by_tech: confirmed,
      confirmed_at: confirmed ? db.knex.raw("clock_timestamp() - interval '3 minutes'") : null,
      service_id: service ? randomUUID() : null,
    }).returning('*');
    await db.knex('lawn_assessment_runs').insert({
      assessment_id: assessment.id, customer_id: customerId, status: 'complete',
      prompt_version: 'delivery-fixture', context_hash: 'd'.repeat(64),
      reconciliation: JSON.stringify({ confirmation: {
        calibration_eligible: calibration, ai_scores: AI, final_scores: FINAL, technician_id: technicianId,
      } }),
    });
    return assessment;
  }

  function dependencies() {
    const update = (id, fields) => db.knex('lawn_assessments').where({ id }).update(fields);
    return {
      knex: db.knex,
      LawnIntel: {
        attachWeather: jest.fn(async () => null),
        recordTechCalibration: jest.fn(LawnIntel.recordTechCalibration),
        emitHealthSignal: jest.fn(LawnIntel.emitHealthSignal),
        sendAssessmentNotification: jest.fn((id) => update(id, { notification_sent: true })),
        generateServiceReport: jest.fn((id) => update(id, { report_auto_generated: true })),
        trackAssessmentCompletion: jest.fn(async () => ({})),
      },
      KnowledgeBridge: { generateAssessmentRecommendations: jest.fn((id) => update(id, { recommendations: JSON.stringify({ summary: 'Fixture summary' }) })) },
    };
  }
  const deliver = (id, deps) => deliverConfirmedAssessment({ assessmentId: id }, deps);

  test('completes only after actual calibration and health success, then retries do no work', async () => {
    const assessment = await seed();
    // Recovery must compare the frozen confirmation, even if the assessment changes.
    await db.knex('lawn_assessments').where({ id: assessment.id }).update({ turf_density: 99 });
    const deps = dependencies();
    expect(await deliver(assessment.id, deps)).toMatchObject({ done: ['calibration', 'recommendations', 'health', 'notification', 'report'], gaps: [] });
    const comparison = await db.knex('tech_calibration').where({ assessment_id: assessment.id }).first();
    expect(comparison).toMatchObject({ technician_id: assessment.technician_id, ai_turf_density: 80, tech_turf_density: 60, ai_stress_damage: 85, tech_stress_damage: 70, bias_direction: 'lower' });
    expect(Number(comparison.avg_delta)).toBe(5.8);
    expect((await stored(assessment.id)).pipeline_health_completed_at).toBeInstanceOf(Date);
    expect((await stored(assessment.id)).pipeline_completed_at).toBeInstanceOf(Date);
    expect(await deliver(assessment.id, deps)).toMatchObject({ skipped: 'not_claimed' });
    expect(deps.LawnIntel.attachWeather).toHaveBeenCalledTimes(1);
  });

  test('a failed calibration insert stays owed and recovery creates exactly one frozen comparison', async () => {
    const assessment = await seed();
    const deps = dependencies();
    await db.knex.raw('ALTER TABLE tech_calibration ADD CONSTRAINT fixture_calibration_failure CHECK (false) NOT VALID');
    try { await expect(deliver(assessment.id, deps)).rejects.toMatchObject({ code: '23514' }); }
    finally { await db.knex.raw('ALTER TABLE tech_calibration DROP CONSTRAINT fixture_calibration_failure'); }
    expect((await stored(assessment.id)).pipeline_completed_at).toBeNull();
    expect(deps.KnowledgeBridge.generateAssessmentRecommendations).not.toHaveBeenCalled();
    await expire(assessment.id);
    await deliver(assessment.id, deps);
    expect(await db.knex('tech_calibration').where({ assessment_id: assessment.id })).toHaveLength(1);
  });

  test('health database failures cannot be mistaken for an insufficient-history skip', async () => {
    const assessment = await seed();
    await db.knex('lawn_assessments').insert({ customer_id: assessment.customer_id, service_date: etDateString(), confirmed_by_tech: true, ...AI });
    const deps = dependencies();
    await db.knex.schema.renameTable('customer_signals', 'fixture_hidden_signals');
    try {
      expect(await LawnIntel.emitHealthSignal(assessment.customer_id, { knex: db.knex })).toMatchObject({ trend: expect.any(Array) });
      await expect(deliver(assessment.id, deps)).rejects.toMatchObject({ code: '42P01' });
    }
    finally { await db.knex.schema.renameTable('fixture_hidden_signals', 'customer_signals'); }
    expect((await stored(assessment.id)).pipeline_health_completed_at).toBeNull();
    expect(deps.LawnIntel.sendAssessmentNotification).not.toHaveBeenCalled();
    await expire(assessment.id);
    await deliver(assessment.id, deps);
    expect(deps.LawnIntel.recordTechCalibration).toHaveBeenCalledTimes(1);
    expect(deps.KnowledgeBridge.generateAssessmentRecommendations).toHaveBeenCalledTimes(1);
    expect(deps.LawnIntel.emitHealthSignal).toHaveBeenCalledTimes(2);
  });

  test.each(['recordTechCalibration', 'emitHealthSignal', 'sendAssessmentNotification', 'generateServiceReport'])(
    'a swallowed %s failure leaves completion unset and resumes only remaining steps', async (method) => {
      const assessment = await seed();
      const deps = dependencies();
      deps.LawnIntel[method].mockResolvedValueOnce(null);
      await expect(deliver(assessment.id, deps)).rejects.toMatchObject({ code: 'LAWN_DELIVERY_STEP_INCOMPLETE' });
      expect((await stored(assessment.id)).pipeline_completed_at).toBeNull();
      await expire(assessment.id);
      await deliver(assessment.id, deps);
      expect(deps.LawnIntel[method]).toHaveBeenCalledTimes(2);
      expect((await stored(assessment.id)).pipeline_completed_at).toBeInstanceOf(Date);
      expect(await db.knex('tech_calibration').where({ assessment_id: assessment.id })).toHaveLength(1);
    },
  );

  test('empty recommendations cannot complete delivery, while a service-linked run skips standalone notification', async () => {
    const assessment = await seed({ service: true, calibration: false });
    const deps = dependencies();
    deps.KnowledgeBridge.generateAssessmentRecommendations.mockImplementationOnce((id) => db.knex('lawn_assessments').where({ id }).update({ recommendations: JSON.stringify({ recommendations: [] }) }));
    await expect(deliver(assessment.id, deps)).rejects.toMatchObject({ code: 'LAWN_DELIVERY_STEP_INCOMPLETE' });
    expect(deps.LawnIntel.emitHealthSignal).not.toHaveBeenCalled();
    await expire(assessment.id);
    await deliver(assessment.id, deps);
    expect(deps.LawnIntel.recordTechCalibration).not.toHaveBeenCalled();
    expect(deps.LawnIntel.sendAssessmentNotification).not.toHaveBeenCalled();
    expect(deps.LawnIntel.generateServiceReport).toHaveBeenCalledTimes(1);
  });

  test('tracking failure retries without repeating completed customer steps', async () => {
    const assessment = await seed();
    const deps = dependencies();
    deps.LawnIntel.trackAssessmentCompletion.mockResolvedValueOnce({ error: 'fixture failure' });
    await expect(deliver(assessment.id, deps)).rejects.toMatchObject({ code: 'LAWN_DELIVERY_STEP_INCOMPLETE' });
    expect((await stored(assessment.id)).pipeline_completed_at).toBeNull();
    await expire(assessment.id);
    expect(await deliver(assessment.id, deps)).toMatchObject({ done: [], gaps: [] });
    expect(deps.LawnIntel.sendAssessmentNotification).toHaveBeenCalledTimes(1);
    expect(deps.LawnIntel.generateServiceReport).toHaveBeenCalledTimes(1);
  });

  test('a recommendation request lasting longer than the lease remains exclusive through heartbeats', async () => {
    const assessment = await seed();
    const deps = { ...dependencies(), staleAfterMs: 1000, heartbeatMs: 25 };
    const entered = deferred(), finish = deferred();
    const generate = deps.KnowledgeBridge.generateAssessmentRecommendations.getMockImplementation();
    deps.KnowledgeBridge.generateAssessmentRecommendations.mockImplementation(async (id) => { entered.resolve(); await finish.promise; return generate(id); });
    const running = deliver(assessment.id, deps);
    await entered.promise;
    const original = await stored(assessment.id);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1400));
      expect((await stored(assessment.id)).pipeline_claimed_at.getTime()).toBeGreaterThan(original.pipeline_claimed_at.getTime());
      expect(await runs.claimPipeline(assessment.id, db.knex, { staleAfterMs: 1000 })).toBeNull();
      expect(await deliver(assessment.id, dependencies())).toMatchObject({ skipped: 'not_claimed' });
    } finally { finish.resolve(); await running; }
    expect(deps.KnowledgeBridge.generateAssessmentRecommendations).toHaveBeenCalledTimes(1);
  }, 10000);

  test('a worker losing ownership during external work cannot send or complete for the replacement', async () => {
    const assessment = await seed();
    const deps = dependencies();
    const entered = deferred(), finish = deferred();
    const generate = deps.KnowledgeBridge.generateAssessmentRecommendations.getMockImplementation();
    deps.KnowledgeBridge.generateAssessmentRecommendations.mockImplementation(async (id) => { entered.resolve(); await finish.promise; return generate(id); });
    const running = deliver(assessment.id, deps);
    const rejected = expect(running).rejects.toMatchObject({ code: 'LAWN_DELIVERY_OWNERSHIP_LOST' });
    await entered.promise;
    const original = await stored(assessment.id);
    await expire(assessment.id);
    const replacement = await runs.claimPipeline(assessment.id, db.knex);
    finish.resolve();
    await rejected;
    expect(deps.LawnIntel.emitHealthSignal).not.toHaveBeenCalled();
    expect(deps.LawnIntel.sendAssessmentNotification).not.toHaveBeenCalled();
    expect(await runs.markPipelineHealthComplete(assessment.id, original.pipeline_owner_token, db.knex)).toBe(false);
    expect(await runs.completePipeline(assessment.id, original.pipeline_owner_token, db.knex)).toMatchObject({ owned: false });
    expect((await stored(assessment.id)).pipeline_owner_token).toBe(replacement.pipeline_owner_token);
    expect((await stored(assessment.id)).pipeline_completed_at).toBeNull();
  });

  test('a worker losing ownership while its customer send is in flight cannot dispatch', async () => {
    const assessment = await seed();
    const deps = dependencies();
    const entered = deferred(), finish = deferred();
    // Mirror the real sender: the lease check runs immediately before dispatch.
    deps.LawnIntel.sendAssessmentNotification.mockImplementation(async (id, { beforeSend }) => {
      entered.resolve();
      await finish.promise;
      await beforeSend();
      return db.knex('lawn_assessments').where({ id }).update({ notification_sent: true });
    });
    const running = deliver(assessment.id, deps);
    const rejected = expect(running).rejects.toMatchObject({ code: 'LAWN_DELIVERY_OWNERSHIP_LOST' });
    await entered.promise;
    await expire(assessment.id);
    const replacement = await runs.claimPipeline(assessment.id, db.knex);
    finish.resolve();
    await rejected;
    expect(deps.LawnIntel.sendAssessmentNotification).toHaveBeenCalledWith(assessment.id, { beforeSend: expect.any(Function) });
    expect((await db.knex('lawn_assessments').where({ id: assessment.id }).first()).notification_sent).toBe(false);
    expect(deps.LawnIntel.generateServiceReport).not.toHaveBeenCalled();
    expect((await stored(assessment.id)).pipeline_owner_token).toBe(replacement.pipeline_owner_token);
    expect((await stored(assessment.id)).pipeline_completed_at).toBeNull();
  });

  test('a recovery attaches weather once and never overwrites the visit snapshot', async () => {
    const fresh = await seed();
    const recovered = await seed();
    const snapshot = JSON.stringify({ temp_f: 71, station: 'FIXTURE' });
    await db.knex('lawn_assessments').where({ id: recovered.id }).update({ fawn_snapshot: snapshot, fawn_temp_f: 71 });
    const deps = dependencies();
    await deliver(fresh.id, deps);
    expect(deps.LawnIntel.attachWeather).toHaveBeenCalledWith(fresh.id);
    deps.LawnIntel.attachWeather.mockClear();
    await deliver(recovered.id, deps);
    // The snapshot is the visit's evidence; a later recovery must not refresh it.
    expect(deps.LawnIntel.attachWeather).not.toHaveBeenCalled();
    expect((await db.knex('lawn_assessments').where({ id: recovered.id }).first()).fawn_snapshot).toEqual(JSON.parse(snapshot));
    expect((await stored(recovered.id)).pipeline_completed_at).toBeInstanceOf(Date);
  });

  test('recovery stops sweeping a run that has been failing past the retry horizon', async () => {
    await db.knex('lawn_assessment_runs').update({ pipeline_completed_at: db.knex.fn.now() });
    const recent = await seed(), ancient = await seed();
    await db.knex('lawn_assessments').where({ id: ancient.id })
      .update({ confirmed_at: db.knex.raw("clock_timestamp() - interval '8 days'") });
    const swept = jest.fn(async () => ({ skipped: 'fixture' }));
    expect(await sweepAbandonedDeliveries({ knex: db.knex, deliver: swept })).toMatchObject({ candidates: 1 });
    expect(swept.mock.calls.map(([arg]) => arg.assessmentId)).toEqual([recent.id]);
    await expect(sweepAbandonedDeliveries({ knex: db.knex, retryHorizonMs: 60 })).rejects.toThrow(/horizon must outlast its lease/);
  });

  test('completion refuses missing durable steps even with a valid lease', async () => {
    const assessment = await seed();
    const claim = await runs.claimPipeline(assessment.id, db.knex);
    expect(await runs.completePipeline(assessment.id, claim.pipeline_owner_token, db.knex)).toMatchObject({ owned: true, gaps: ['calibration', 'recommendations', 'health', 'notification', 'report'] });
    expect((await stored(assessment.id)).pipeline_completed_at).toBeNull();
  });

  test('recovery resumes unclaimed and expired runs with both feature gates off, without a client retry', async () => {
    // Keep the sweep's population local to this test while preserving prior assertions.
    await db.knex('lawn_assessment_runs').update({ pipeline_completed_at: db.knex.fn.now() });
    const unclaimed = await seed(), abandoned = await seed(), pending = await seed({ confirmed: false });
    await runs.claimPipeline(abandoned.id, db.knex);
    await expire(abandoned.id);
    const active = await seed();
    await runs.claimPipeline(active.id, db.knex);
    const deps = dependencies();
    const resume = jest.fn(({ assessmentId }) => deliver(assessmentId, deps));
    const cron = { schedule: jest.fn((expression, tick, options) => ({ expression, tick, options })) };
    const job = scheduleRecovery(cron, { sweep: () => sweepAbandonedDeliveries({ knex: db.knex, deliver: resume }) });
    expect(job).toMatchObject({ expression: '*/10 * * * *', options: { timezone: 'America/New_York' } });
    await job.tick();
    expect(resume.mock.calls.map(([arg]) => arg.assessmentId).sort()).toEqual([unclaimed.id, abandoned.id].sort());
    for (const id of [unclaimed.id, abandoned.id]) expect((await stored(id)).pipeline_completed_at).toBeInstanceOf(Date);
    for (const id of [pending.id, active.id]) expect((await stored(id)).pipeline_completed_at).toBeNull();
    expect(await deliver(pending.id, deps)).toMatchObject({ skipped: 'not_claimed' });
  });

  test('a failed recovered run does not prevent the rest of the batch from completing', async () => {
    await db.knex('lawn_assessment_runs').update({ pipeline_completed_at: db.knex.fn.now() });
    const failed = await seed(), next = await seed();
    const deps = dependencies();
    const resume = async ({ assessmentId }) => {
      if (assessmentId === failed.id) throw Object.assign(new Error('fixture'), { code: 'FIXTURE_FAILED' });
      return deliver(assessmentId, deps);
    };
    expect(await sweepAbandonedDeliveries({ knex: db.knex, deliver: resume })).toEqual({ candidates: 2, resumed: 1, failed: 1 });
    expect((await stored(failed.id)).pipeline_completed_at).toBeNull();
    expect((await stored(next.id)).pipeline_completed_at).toBeInstanceOf(Date);
  });

  test('migration lag cannot authorize delivery and a missing table is a logged recovery skip', async () => {
    const assessment = await seed();
    const deps = dependencies();
    const logger = require('../services/logger');
    const cron = { schedule: jest.fn((expression, tick) => ({ tick })) };
    const job = scheduleRecovery(cron, { sweep: () => sweepAbandonedDeliveries({ knex: db.knex }) });
    await db.knex.schema.renameTable('lawn_assessment_runs', 'fixture_hidden_runs');
    try {
      await expect(deliver(assessment.id, deps)).rejects.toMatchObject({ code: '42P01' });
      expect(await sweepAbandonedDeliveries({ knex: db.knex })).toMatchObject({ skipped: 'schema_unavailable' });
      // Every silent tick would hide disabled recovery; the skip must leave a signal.
      logger.warn.mockClear();
      await job.tick();
      expect(logger.warn).toHaveBeenCalledWith('[lawn-visit-delivery] recovery sweep skipped', expect.objectContaining({ skipped: 'schema_unavailable' }));
    } finally { await db.knex.schema.renameTable('fixture_hidden_runs', 'lawn_assessment_runs'); }
    expect(deps.LawnIntel.attachWeather).not.toHaveBeenCalled();
    expect((await stored(assessment.id)).pipeline_claimed_at).toBeNull();
  });
});
