const { randomUUID } = require('crypto');
const { createLawnVisitDb } = require('./helpers/lawn-visit-db');
const pipelineMigration = require('../models/migrations/20260908000030_lawn_assessment_runs_pipeline');
const ownerMigration = require('../models/migrations/20260909000050_lawn_assessment_runs_pipeline_owner');

let mockKnex;
const mockNotify = jest.fn();
const mockRenderRequiredSmsTemplate = jest.fn(async (_key, vars) => `Score ${vars.overall_score}${vars.tip_line}`);

jest.mock('../models/db', () => {
  const db = (...args) => mockKnex(...args);
  db.transaction = (...args) => mockKnex.transaction(...args);
  db.raw = (...args) => mockKnex.raw(...args);
  Object.defineProperty(db, 'fn', { get: () => mockKnex.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => false) }));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: jest.fn(() => '+19415550199') }));
jest.mock('../services/sms-template-renderer', () => ({
  renderRequiredSmsTemplate: (...args) => mockRenderRequiredSmsTemplate(...args),
}));
jest.mock('../services/notification-dispatcher', () => ({ notify: (...args) => mockNotify(...args) }));

const LawnIntel = require('../services/lawn-intelligence');
const { replayDeferredNotification } = require('../services/lawn-visit-delivery');

const DATABASE_URL = process.env.DATABASE_URL;
const postgres = DATABASE_URL ? describe : describe.skip;
const holdSms = (nextAllowedAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()) => ({
  sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'QUIET_HOURS_HOLD',
  deferred: true, retryable: true, nextAllowedAt,
});
const dispatcherResult = (smsResult) => ({
  sent: smsResult.sent, channel: 'sms', deliveryOutcome: smsResult.deliveryOutcome,
  results: { sms: smsResult.sent ? 'sent' : `blocked: ${smsResult.code}` }, smsResult,
});

postgres('deferred standalone lawn assessment notification (real PostgreSQL)', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await createLawnVisitDb();
    mockKnex = fixture.knex;
    for (const table of ['sms_log', 'tech_calibration']) {
      await fixture.knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [fixture.schema, table, table]);
    }
    await pipelineMigration.up(fixture.knex);
    await ownerMigration.up(fixture.knex);
  }, 60000);

  afterAll(async () => { if (fixture) await fixture.dispose(); });

  beforeEach(async () => {
    jest.clearAllMocks();
    for (const table of ['sms_log', 'tech_calibration', 'lawn_assessment_runs', 'lawn_assessments', 'technicians', 'customers']) {
      await fixture.knex(table).del();
    }
  });

  async function seed() {
    const customerId = randomUUID();
    const technicianId = randomUUID();
    await fixture.knex('customers').insert({
      id: customerId, first_name: 'Fixture', phone: '+19415550100',
    });
    await fixture.knex('technicians').insert({ id: technicianId, name: 'Fixture technician' });
    const [assessment] = await fixture.knex('lawn_assessments').insert({
      customer_id: customerId, technician_id: technicianId, service_date: '2026-09-12',
      turf_density: 80, weed_suppression: 80, color_health: 80, fungus_control: 80,
      thatch_level: 80, stress_damage: 80, overall_score: 80,
      confirmed_by_tech: true, confirmed_at: fixture.knex.fn.now(),
      recommendations: JSON.stringify({ summary: 'Stored', customerTip: 'Original copy' }),
      report_auto_generated: true, fawn_snapshot: JSON.stringify({ station: 'fixture' }),
    }).returning('*');
    const [run] = await fixture.knex('lawn_assessment_runs').insert({
      assessment_id: assessment.id, customer_id: customerId, status: 'complete',
      prompt_version: 'deferred-fixture', context_hash: 'd'.repeat(64),
      reconciliation: JSON.stringify({}), pipeline_health_completed_at: fixture.knex.fn.now(),
    }).returning('*');
    return { assessment, run, customerId };
  }

  async function queueHeld(assessmentId) {
    const sms = holdSms();
    mockNotify.mockImplementation(async (_customerId, _type, options) => {
      await options.preSendCheck?.();
      return dispatcherResult(sms);
    });
    const result = await LawnIntel.sendAssessmentNotification(assessmentId, { beforeSend: jest.fn() });
    const queued = await fixture.knex('sms_log').whereRaw("metadata->>'assessment_id' = ?", [String(assessmentId)]).first();
    return { result, queued, sms };
  }

  function replayDeps() {
    return {
      knex: fixture.knex,
      LawnIntel: {
        sendAssessmentNotification: (...args) => LawnIntel.sendAssessmentNotification(...args),
        trackAssessmentCompletion: jest.fn(async () => ({})),
      },
      KnowledgeBridge: {
        SEND_SEAL_MS: 120000,
        treatmentGuard: { isGenerationInFlight: jest.fn(async () => false) },
        sealRecommendationsForSend: jest.fn(async () => true),
        renewRecommendationSendSeal: jest.fn(async () => true),
        releaseRecommendationSendSeal: jest.fn(async () => true),
      },
    };
  }

  const replayMeta = (seeded, queued, overrides = {}) => ({
    ...queued.metadata, scheduled_sms_log_id: queued.id, customer_id: seeded.customerId,
    assessment_id: seeded.assessment.id, run_id: seeded.run.id, ...overrides,
  });

  test('a guarded quiet-hours hold creates one identity-only obligation and atomically releases its send claim', async () => {
    const seeded = await seed();
    const sms = holdSms();
    mockNotify.mockImplementation(async (_customerId, _type, options) => {
      await options.preSendCheck?.();
      return dispatcherResult(sms);
    });
    const results = await Promise.all([
      LawnIntel.sendAssessmentNotification(seeded.assessment.id, { beforeSend: jest.fn() }),
      LawnIntel.sendAssessmentNotification(seeded.assessment.id, { beforeSend: jest.fn() }),
    ]);
    expect(results.filter((result) => result?.notificationQueued)).toHaveLength(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const rows = await fixture.knex('sms_log').where({ customer_id: seeded.customerId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'scheduled', message_body: '', message_type: 'service_complete' });
    expect(rows[0].metadata).toMatchObject({
      entry_point: 'lawn_assessment_notification_deferred', requires_registered_dispatch: true,
      assessment_id: seeded.assessment.id, run_id: seeded.run.id, customer_id: seeded.customerId,
    });
    expect(new Date(rows[0].scheduled_for).toISOString()).toBe(sms.nextAllowedAt);
    expect(await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id }).first())
      .toMatchObject({ notification_sent: false, notification_sent_at: null });

    await LawnIntel.sendAssessmentNotification(seeded.assessment.id, { beforeSend: jest.fn() });
    expect(await fixture.knex('sms_log').where({ customer_id: seeded.customerId })).toHaveLength(1);
  });

  test('an enqueue failure rolls back without falsely releasing the in-flight send claim', async () => {
    const seeded = await seed();
    await fixture.knex.raw('ALTER TABLE sms_log ADD CONSTRAINT fixture_requires_body CHECK (message_body <> \'\')');
    try {
      mockNotify.mockResolvedValue(dispatcherResult(holdSms()));
      await expect(LawnIntel.sendAssessmentNotification(seeded.assessment.id, { beforeSend: jest.fn() }))
        .resolves.toBeNull();
      expect(await fixture.knex('sms_log')).toHaveLength(0);
      expect(await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id }).first())
        .toMatchObject({ notification_sent: true, notification_sent_at: null });
    } finally {
      await fixture.knex.raw('ALTER TABLE sms_log DROP CONSTRAINT fixture_requires_body');
    }
  });

  test('replay renders fresh copy under a new lease/seal, forwards queue identity, and cannot resend an acceptance', async () => {
    const seeded = await seed();
    const { queued } = await queueHeld(seeded.assessment.id);
    await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id }).update({
      overall_score: 91,
      recommendations: JSON.stringify({ summary: 'Stored', customerTip: 'Fresh replay copy' }),
    });
    mockRenderRequiredSmsTemplate.mockClear();
    const accepted = { sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}` };
    const guardStartedAt = Date.now();
    let guardProof;
    mockNotify.mockImplementation(async (_customerId, _type, options) => {
      guardProof = await options.preSendCheck();
      return dispatcherResult(accepted);
    });
    const deps = replayDeps();
    const meta = replayMeta(seeded, queued);
    expect(await replayDeferredNotification(meta, deps)).toMatchObject(accepted);
    expect(mockRenderRequiredSmsTemplate).toHaveBeenLastCalledWith(
      'lawn_health_report_ready', expect.objectContaining({ overall_score: '91', tip_line: '\nTip: Fresh replay copy' }), expect.any(Object),
    );
    expect(mockNotify).toHaveBeenCalledWith(seeded.customerId, 'service_complete',
      expect.objectContaining({ scheduledSmsLogId: queued.id, preSendCheck: expect.any(Function) }));
    expect(Number.isFinite(guardProof.validUntil)).toBe(true);
    expect(guardProof.validUntil).toBeGreaterThanOrEqual(guardStartedAt + 119000);
    expect(guardProof.validUntil).toBeLessThanOrEqual(Date.now() + 120000);
    const sealOwner = deps.KnowledgeBridge.sealRecommendationsForSend.mock.calls[0][3];
    expect(sealOwner).toMatch(/^lawn-recovery:/);
    expect(deps.KnowledgeBridge.renewRecommendationSendSeal).toHaveBeenCalledWith(seeded.assessment.id, sealOwner);
    expect(deps.KnowledgeBridge.releaseRecommendationSendSeal).toHaveBeenCalledWith(seeded.assessment.id, sealOwner);
    expect((await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id }).first()).notification_sent_at)
      .toBeInstanceOf(Date);
    mockNotify.mockClear();
    expect(await replayDeferredNotification(meta, replayDeps())).toMatchObject({
      sent: false, code: 'LAWN_NOTIFICATION_ALREADY_CLAIMED', deliveryOutcome: 'uncertain',
    });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test.each(['tracking', 'pipeline settlement'])(
    'an accepted replay survives a post-handoff %s failure and cannot resend', async (failure) => {
      const seeded = await seed();
      const { queued } = await queueHeld(seeded.assessment.id);
      const accepted = { sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'b'.repeat(32)}` };
      mockNotify.mockImplementation(async (_customerId, _type, options) => {
        await options.preSendCheck();
        return dispatcherResult(accepted);
      });
      const deps = replayDeps();
      if (failure === 'tracking') deps.LawnIntel.trackAssessmentCompletion.mockResolvedValue({ error: 'fixture failure' });
      if (failure === 'pipeline settlement') {
        await fixture.knex.raw(`ALTER TABLE lawn_assessment_runs
          ADD CONSTRAINT fixture_pipeline_settlement_failure CHECK (pipeline_completed_at IS NULL)`);
      }
      const meta = replayMeta(seeded, queued);
      try {
        expect(await replayDeferredNotification(meta, deps)).toMatchObject(accepted);
      } finally {
        if (failure === 'pipeline settlement') {
          await fixture.knex.raw('ALTER TABLE lawn_assessment_runs DROP CONSTRAINT fixture_pipeline_settlement_failure');
        }
      }
      expect((await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id }).first()).notification_sent_at)
        .toBeInstanceOf(Date);
      mockNotify.mockClear();
      expect(await replayDeferredNotification(meta, replayDeps())).toMatchObject({
        sent: false, code: 'LAWN_NOTIFICATION_ALREADY_CLAIMED', deliveryOutcome: 'uncertain',
      });
      expect(mockNotify).not.toHaveBeenCalled();
    },
  );

  test.each(['active generation', 'lost pipeline ownership'])(
    '%s before provider handoff sends nothing and returns a retryable replay result', async (failure) => {
      const seeded = await seed();
      const { queued } = await queueHeld(seeded.assessment.id);
      mockNotify.mockClear();
      const deps = replayDeps();
      if (failure === 'active generation') {
        deps.KnowledgeBridge.treatmentGuard.isGenerationInFlight.mockResolvedValue(true);
      } else {
        deps.KnowledgeBridge.sealRecommendationsForSend.mockImplementation(async () => {
          await fixture.knex('lawn_assessment_runs').where({ assessment_id: seeded.assessment.id }).update({
            pipeline_owner_token: randomUUID(), pipeline_claimed_at: fixture.knex.fn.now(),
          });
          return true;
        });
      }
      const result = await replayDeferredNotification(replayMeta(seeded, queued), deps);
      expect(result).toMatchObject({ sent: false, deliveryOutcome: 'not_sent', retryable: true });
      expect(result.code).toBe(failure === 'active generation'
        ? 'LAWN_NOTIFICATION_BUSY' : 'LAWN_DELIVERY_OWNERSHIP_LOST');
      expect(mockNotify).not.toHaveBeenCalled();
      expect(await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id }).first())
        .toMatchObject({ notification_sent: false, notification_sent_at: null });
    },
  );

  test('a replay held again stays on the same queue row and releases its pipeline for the next scheduled attempt', async () => {
    const seeded = await seed();
    const { queued } = await queueHeld(seeded.assessment.id);
    const replayHold = holdSms(new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString());
    mockNotify.mockImplementation(async (_customerId, _type, options) => {
      await options.preSendCheck();
      return dispatcherResult(replayHold);
    });
    const meta = replayMeta(seeded, queued);
    expect(await replayDeferredNotification(meta, replayDeps())).toMatchObject(replayHold);
    expect(await replayDeferredNotification(meta, replayDeps())).toMatchObject(replayHold);
    expect(await fixture.knex('sms_log').where({ customer_id: seeded.customerId })).toHaveLength(1);
    expect(await fixture.knex('lawn_assessment_runs').where({ id: seeded.run.id }).first())
      .toMatchObject({ pipeline_claimed_at: null, pipeline_owner_token: null, pipeline_completed_at: null });
  });

  test('an uncertain replay retains the durable claim and cannot dispatch a second time', async () => {
    const seeded = await seed();
    const { queued } = await queueHeld(seeded.assessment.id);
    const uncertain = { sent: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_UNCERTAIN' };
    mockNotify.mockImplementation(async (_customerId, _type, options) => {
      await options.preSendCheck();
      return dispatcherResult(uncertain);
    });
    const meta = replayMeta(seeded, queued);
    expect(await replayDeferredNotification(meta, replayDeps())).toMatchObject({
      sent: false, code: 'LAWN_NOTIFICATION_UNCERTAIN', deliveryOutcome: 'uncertain',
    });
    mockNotify.mockClear();
    expect(await replayDeferredNotification(meta, replayDeps())).toMatchObject({
      sent: false, code: 'LAWN_NOTIFICATION_ALREADY_CLAIMED', deliveryOutcome: 'uncertain',
    });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test.each([
    ['customer', (seeded) => ({ customer_id: randomUUID() })],
    ['run', () => ({ run_id: randomUUID() })],
  ])('a queued %s identity mismatch is terminally refused before rendering or dispatch', async (_label, mismatch) => {
    const seeded = await seed();
    const { queued } = await queueHeld(seeded.assessment.id);
    mockNotify.mockClear();
    mockRenderRequiredSmsTemplate.mockClear();
    expect(await replayDeferredNotification(replayMeta(seeded, queued, mismatch(seeded)), replayDeps()))
      .toEqual({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'LAWN_NOTIFICATION_UNAVAILABLE' });
    expect(mockRenderRequiredSmsTemplate).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
