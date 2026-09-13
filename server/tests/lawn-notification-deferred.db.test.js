const { randomUUID } = require('crypto');
const { createLawnVisitDb } = require('./helpers/lawn-visit-db');
const pipelineMigration = require('../models/migrations/20260908000030_lawn_assessment_runs_pipeline');
const ownerMigration = require('../models/migrations/20260909000050_lawn_assessment_runs_pipeline_owner');

let mockKnex;
const mockNotify = jest.fn();
const mockSendCustomerMessage = jest.fn();
const mockGateEnvValue = jest.fn(() => false);
const mockIsEnabled = jest.fn((name) => name === 'cronJobs');
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
jest.mock('../config/feature-gates', () => ({
  gateEnvValue: (...args) => mockGateEnvValue(...args),
  isEnabled: (...args) => mockIsEnabled(...args),
  logGateStatus: jest.fn(),
}));
jest.mock('../utils/scheduled-cron', () => ({
  schedule: jest.fn(),
  scheduleTimeout: jest.fn(),
  scheduleInterval: jest.fn(),
  isScheduledTick: () => false,
  runAsScheduledTick: (fn) => fn(),
}));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: async (_name, fn) => fn(),
  recordMissedTick: jest.fn(),
  settleDeadRunningJobs: jest.fn(async () => ({})),
}));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: jest.fn(() => '+19415550199') }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...args) => mockSendCustomerMessage(...args),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderRequiredSmsTemplate: (...args) => mockRenderRequiredSmsTemplate(...args),
}));
jest.mock('../services/notification-dispatcher', () => ({
  ...jest.requireActual('../services/notification-dispatcher'),
  notify: (...args) => mockNotify(...args),
}));

const LawnIntel = require('../services/lawn-intelligence');
const RealNotificationDispatcher = jest.requireActual('../services/notification-dispatcher');
const runs = require('../services/lawn-visit-runs');
const { deliverConfirmedAssessment, replayDeferredNotification } = require('../services/lawn-visit-delivery');
const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');

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
    for (const table of ['sms_log', 'tech_calibration', 'notification_prefs']) {
      await fixture.knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [fixture.schema, table, table]);
    }
    await pipelineMigration.up(fixture.knex);
    await ownerMigration.up(fixture.knex);
  }, 60000);

  afterAll(async () => { if (fixture) await fixture.dispose(); });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockNotify.mockReset();
    mockSendCustomerMessage.mockReset();
    mockGateEnvValue.mockImplementation(() => false);
    mockIsEnabled.mockImplementation((name) => name === 'cronJobs');
    for (const table of ['sms_log', 'notification_prefs', 'tech_calibration', 'lawn_assessment_runs', 'lawn_assessments', 'technicians', 'customers']) {
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

  function knexAfterFirstReplaySnapshot(effect) {
    let fired = false;
    const wrapped = (...args) => {
      const query = fixture.knex(...args);
      if (!fired && (args[0] === 'lawn_assessments' || args[0] === 'lawn_assessments as assessment')) {
        const first = query.first.bind(query);
        query.first = (...columns) => first(...columns).then(async (row) => {
          if (!fired) {
            fired = true;
            await effect();
          }
          return row;
        });
      }
      return query;
    };
    wrapped.transaction = (...args) => fixture.knex.transaction(...args);
    wrapped.raw = (...args) => fixture.knex.raw(...args);
    Object.defineProperty(wrapped, 'fn', { get: () => fixture.knex.fn });
    return wrapped;
  }

  test('the real dispatcher turns customer quiet hours into one identity-only obligation that replays with recovery gated off', async () => {
    const seeded = await seed();
    await fixture.knex('notification_prefs').insert({
      customer_id: seeded.customerId,
      service_completed: true,
      service_complete_channel: 'sms',
      quiet_hours_start: '22:00:00',
      quiet_hours_end: '09:00:00',
    });
    mockNotify.mockImplementation((...args) => RealNotificationDispatcher.notify(...args));
    jest.useFakeTimers().setSystemTime(new Date('2026-09-12T12:00:00Z')); // 08:00 ET
    try {
      const results = await Promise.all([
        LawnIntel.sendAssessmentNotification(seeded.assessment.id, { beforeSend: jest.fn() }),
        LawnIntel.sendAssessmentNotification(seeded.assessment.id, { beforeSend: jest.fn() }),
      ]);
      expect(results.filter((result) => result?.notificationQueued)).toHaveLength(1);
      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockSendCustomerMessage).not.toHaveBeenCalled();
      const rows = await fixture.knex('sms_log').where({ customer_id: seeded.customerId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'scheduled', message_body: '', message_type: 'service_complete' });
      expect(rows[0].metadata).toMatchObject({
        entry_point: 'lawn_assessment_notification_deferred', requires_registered_dispatch: true,
        assessment_id: seeded.assessment.id, run_id: seeded.run.id, customer_id: seeded.customerId,
      });
      expect(new Date(rows[0].scheduled_for).toISOString()).toBe('2026-09-12T13:00:00.000Z');
      expect(await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id }).first())
        .toMatchObject({ notification_sent: false, notification_sent_at: null });

      await LawnIntel.sendAssessmentNotification(seeded.assessment.id, { beforeSend: jest.fn() });
      expect(await fixture.knex('sms_log').where({ customer_id: seeded.customerId })).toHaveLength(1);

      // The scheduled-SMS registry owns this replay independently of the lawn
      // recovery sweep's dark gate. A second hold remains retryable on the same
      // row so the scheduler can move it again without frozen copy.
      jest.setSystemTime(new Date('2026-09-12T13:00:00Z')); // 09:00 ET
      const replayHold = holdSms('2026-09-12T14:00:00.000Z');
      mockSendCustomerMessage.mockResolvedValue(replayHold);
      mockGateEnvValue.mockClear();
      const replayed = await replayDeferredNotification(replayMeta(seeded, rows[0]), replayDeps());
      expect(replayed).toMatchObject(replayHold);
      expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
      expect(mockGateEnvValue).not.toHaveBeenCalledWith('GATE_LAWN_DELIVERY_RECOVERY');
      expect(await fixture.knex('sms_log').where({ customer_id: seeded.customerId })).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('registry replay rechecks service-complete preferences and waits until customer quiet hours end', async () => {
    const seeded = await seed();
    await fixture.knex('notification_prefs').insert({
      customer_id: seeded.customerId,
      service_completed: true,
      service_complete_channel: 'sms',
      quiet_hours_start: '22:00:00',
      quiet_hours_end: '09:00:00',
    });
    jest.useFakeTimers().setSystemTime(new Date('2026-09-12T12:00:00Z')); // 08:00 ET
    try {
      const waiting = await recheckDeferredReplay('lawn_assessment_notification_deferred', {
        customer_id: seeded.customerId,
      });
      expect(waiting).toMatchObject({
        eligible: false, reason: 'customer_quiet_hours', retryable: true,
      });
      expect(waiting.retryAt.toISOString()).toBe('2026-09-12T13:00:00.000Z');

      await fixture.knex('notification_prefs').where({ customer_id: seeded.customerId }).update({
        service_completed: false,
        quiet_hours_start: null,
        quiet_hours_end: null,
      });
      await expect(recheckDeferredReplay('lawn_assessment_notification_deferred', {
        customer_id: seeded.customerId,
      })).resolves.toEqual({ eligible: false, reason: 'type_disabled' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('a replay racing a live pipeline quiet hold remains retryable until that owner releases the shared queue row', async () => {
    const seeded = await seed();
    const { queued } = await queueHeld(seeded.assessment.id);
    await fixture.knex('sms_log').where({ id: queued.id }).update({ status: 'sending' });
    mockNotify.mockClear();
    let enteredResolve;
    let continueResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const continueDispatch = new Promise((resolve) => { continueResolve = resolve; });
    const held = holdSms();
    mockNotify.mockImplementation(async (_customerId, _type, options) => {
      await options.preSendCheck();
      enteredResolve();
      await continueDispatch;
      return dispatcherResult(held);
    });
    const running = deliverConfirmedAssessment({ assessmentId: seeded.assessment.id }, replayDeps());
    await entered;
    try {
      expect(await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id }).first())
        .toMatchObject({ notification_sent: true, notification_sent_at: null });
      const replayed = await replayDeferredNotification(replayMeta(seeded, queued), replayDeps());
      expect(replayed).toMatchObject({
        sent: false,
        deliveryOutcome: 'not_sent',
        code: 'LAWN_NOTIFICATION_BUSY',
        retryable: true,
        deferred: true,
        nextAllowedAt: expect.any(String),
      });
      expect(new Date(replayed.nextAllowedAt).getTime()).toBeGreaterThan(Date.now());
      expect(mockNotify).toHaveBeenCalledTimes(1);
    } finally {
      continueResolve();
    }
    await expect(running).resolves.toMatchObject({
      notificationResult: { notificationQueued: true, deliveryOutcome: 'not_sent' },
    });
    expect(await fixture.knex('sms_log').where({ customer_id: seeded.customerId })).toHaveLength(1);
    expect(await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id }).first())
      .toMatchObject({ notification_sent: false, notification_sent_at: null });
    expect(await fixture.knex('lawn_assessment_runs').where({ id: seeded.run.id }).first())
      .toMatchObject({ pipeline_owner_token: null, pipeline_claimed_at: expect.any(Date) });
  });

  test('a joined replay snapshot survives the live owner handing its notification claim back during the read', async () => {
    const seeded = await seed();
    const { queued } = await queueHeld(seeded.assessment.id);
    await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id })
      .update({ notification_sent: true, notification_sent_at: null });
    expect(await runs.claimPipeline(seeded.assessment.id, fixture.knex)).toBeTruthy();
    mockNotify.mockClear();
    const knex = knexAfterFirstReplaySnapshot(async () => fixture.knex.transaction(async (trx) => {
      await trx('lawn_assessments').where({ id: seeded.assessment.id })
        .update({ notification_sent: false, notification_sent_at: null });
      await trx('lawn_assessment_runs').where({ id: seeded.run.id }).update({
        pipeline_owner_token: null, pipeline_claimed_at: trx.raw('clock_timestamp()'),
      });
    }));

    await expect(replayDeferredNotification(replayMeta(seeded, queued), { ...replayDeps(), knex }))
      .resolves.toMatchObject({
        sent: false, deliveryOutcome: 'not_sent', code: 'LAWN_NOTIFICATION_BUSY',
        retryable: true, deferred: true, nextAllowedAt: expect.any(String),
      });
    expect(await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id }).first())
      .toMatchObject({ notification_sent: false, notification_sent_at: null });
    expect(await fixture.knex('lawn_assessment_runs').where({ id: seeded.run.id }).first())
      .toMatchObject({ pipeline_owner_token: null, pipeline_claimed_at: expect.any(Date) });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('the scheduler refunds a final attempt while a lawn notification pipeline lease is live', async () => {
    const seeded = await seed();
    const { queued } = await queueHeld(seeded.assessment.id);
    await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id })
      .update({ notification_sent: true, notification_sent_at: null });
    const claim = await runs.claimPipeline(seeded.assessment.id, fixture.knex);
    expect(claim).toBeTruthy();
    await fixture.knex('sms_log').where({ id: queued.id }).update({
      status: 'scheduled',
      scheduled_for: new Date(0),
      metadata: JSON.stringify({ ...queued.metadata, scheduled_sms_attempts: 2 }),
    });
    const cron = require('../utils/scheduled-cron');
    cron.schedule.mockClear();
    require('../services/scheduler').initScheduledJobs();
    const tick = cron.schedule.mock.calls.find(([, callback]) => String(callback).includes('claimDueScheduledSms'))[1];
    mockNotify.mockClear();
    await tick();

    const held = await fixture.knex('sms_log').where({ id: queued.id }).first();
    expect(held).toMatchObject({
      status: 'scheduled',
      metadata: {
        scheduled_sms_attempts: 2,
        lawn_pipeline_hold_at: expect.any(String),
      },
    });
    expect(new Date(held.scheduled_for).toISOString()).toBe(
      new Date(new Date(claim.pipeline_claimed_at).getTime() + runs.PIPELINE_STALE_MS).toISOString(),
    );
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the scheduler refunds a final attempt when another pipeline wins the claim after replay validation', async () => {
    const seeded = await seed();
    const { queued } = await queueHeld(seeded.assessment.id);
    await fixture.knex('sms_log').where({ id: queued.id }).update({
      status: 'scheduled',
      scheduled_for: new Date(0),
      metadata: JSON.stringify({ ...queued.metadata, scheduled_sms_attempts: 2 }),
    });
    const originalClaim = runs.claimPipeline;
    let competingClaim;
    const claimSpy = jest.spyOn(runs, 'claimPipeline').mockImplementationOnce(async (...args) => {
      competingClaim = await originalClaim(args[0], fixture.knex, args[2]);
      return null;
    });
    const cron = require('../utils/scheduled-cron');
    cron.schedule.mockClear();
    require('../services/scheduler').initScheduledJobs();
    const tick = cron.schedule.mock.calls.find(([, callback]) => String(callback).includes('claimDueScheduledSms'))[1];
    mockNotify.mockClear();
    try {
      await tick();
    } finally {
      claimSpy.mockRestore();
    }

    expect(competingClaim).toBeTruthy();
    const held = await fixture.knex('sms_log').where({ id: queued.id }).first();
    expect(held).toMatchObject({
      status: 'scheduled',
      metadata: { scheduled_sms_attempts: 2, lawn_pipeline_hold_at: expect.any(String) },
    });
    expect(new Date(held.scheduled_for).toISOString()).toBe(
      new Date(new Date(competingClaim.pipeline_claimed_at).getTime() + runs.PIPELINE_STALE_MS).toISOString(),
    );
    expect(await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id }).first())
      .toMatchObject({ notification_sent: false, notification_sent_at: null });
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an expired pipeline owner cannot make an unsettled notification claim retryable', async () => {
    const seeded = await seed();
    const { queued } = await queueHeld(seeded.assessment.id);
    await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id })
      .update({ notification_sent: true, notification_sent_at: null });
    await fixture.knex('lawn_assessment_runs').where({ id: seeded.run.id }).update({
      pipeline_owner_token: randomUUID(),
      pipeline_claimed_at: fixture.knex.raw("clock_timestamp() - interval '16 minutes'"),
    });
    mockNotify.mockClear();
    await expect(replayDeferredNotification(replayMeta(seeded, queued), replayDeps())).resolves.toEqual({
      sent: false,
      blocked: true,
      deliveryOutcome: 'uncertain',
      code: 'LAWN_NOTIFICATION_ALREADY_CLAIMED',
    });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('an enqueue failure preserves a proven-unsent notification as owed', async () => {
    const seeded = await seed();
    await fixture.knex.raw('ALTER TABLE sms_log ADD CONSTRAINT fixture_requires_body CHECK (message_body <> \'\')');
    try {
      mockNotify.mockResolvedValue(dispatcherResult(holdSms()));
      await expect(LawnIntel.sendAssessmentNotification(seeded.assessment.id, { beforeSend: jest.fn() }))
        .resolves.toBeNull();
      expect(await fixture.knex('sms_log')).toHaveLength(0);
      expect(await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id }).first())
        .toMatchObject({ notification_sent: false, notification_sent_at: null });
    } finally {
      await fixture.knex.raw('ALTER TABLE sms_log DROP CONSTRAINT fixture_requires_body');
    }
  });

  test('a queued dispatcher success keeps its claim when the sent-at settlement fails', async () => {
    const seeded = await seed();
    const held = holdSms();
    mockNotify.mockImplementation((...args) => RealNotificationDispatcher.notify(...args));
    mockSendCustomerMessage.mockResolvedValue(held);
    await fixture.knex.raw(`ALTER TABLE lawn_assessments
      ADD CONSTRAINT fixture_notification_settlement_failure CHECK (notification_sent_at IS NULL)`);
    try {
      await expect(LawnIntel.sendAssessmentNotification(seeded.assessment.id)).resolves.toBeNull();
      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
      const rows = await fixture.knex('sms_log').where({ customer_id: seeded.customerId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'scheduled',
        message_type: 'service_complete',
        message_body: expect.stringContaining('Score 80'),
      });
      expect(rows[0].metadata).toMatchObject({ entry_point: 'notification_dispatcher_deferred' });
      expect(await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id }).first())
        .toMatchObject({ notification_sent: true, notification_sent_at: null });

      mockNotify.mockClear();
      await expect(LawnIntel.sendAssessmentNotification(seeded.assessment.id)).resolves.toBeNull();
      expect(mockNotify).not.toHaveBeenCalled();
      expect(await fixture.knex('sms_log').where({ customer_id: seeded.customerId })).toHaveLength(1);
    } finally {
      await fixture.knex.raw('ALTER TABLE lawn_assessments DROP CONSTRAINT fixture_notification_settlement_failure');
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
        sent: false, code: 'LAWN_NOTIFICATION_BUSY', deliveryOutcome: 'not_sent', retryable: true,
      });
      expect(mockNotify).not.toHaveBeenCalled();
      await fixture.knex('lawn_assessment_runs').where({ id: seeded.run.id })
        .update({ pipeline_claimed_at: fixture.knex.raw("clock_timestamp() - interval '16 minutes'") });
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

  test.each(['LAWN_DELIVERY_OWNERSHIP_LOST', 'LAWN_COPY_SEAL_LOST'])('%s at the final provider guard keeps the replay retryable', async (code) => {
    const seeded = await seed();
    const { queued } = await queueHeld(seeded.assessment.id);
    const deps = replayDeps();
    mockNotify.mockImplementation(async (_customerId, _type, options) => {
      if (code === 'LAWN_DELIVERY_OWNERSHIP_LOST') {
        await fixture.knex('lawn_assessment_runs').where({ id: seeded.run.id }).update({
          pipeline_owner_token: randomUUID(), pipeline_claimed_at: fixture.knex.fn.now(),
        });
      } else {
        deps.KnowledgeBridge.renewRecommendationSendSeal.mockResolvedValue(false);
      }
      try {
        await options.preSendCheck();
        throw new Error('the expired guard unexpectedly allowed delivery');
      } catch (err) {
        // Mirror the canonical sender's error normalization at the provider
        // boundary; the result must retain retryability through smsResult.
        expect(err.code).toBe(code);
        return dispatcherResult({ sent: false, deliveryOutcome: 'not_sent', code: err.code, retryable: err.retryable === true });
      }
    });
    await expect(replayDeferredNotification(replayMeta(seeded, queued), deps)).resolves.toMatchObject({
      sent: false, deliveryOutcome: 'not_sent', code, retryable: true,
    });
    expect(await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id }).first())
      .toMatchObject({ notification_sent: false, notification_sent_at: null });
  });

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
    expect(await replayDeferredNotification(meta, replayDeps())).toMatchObject({
      sent: false, code: 'LAWN_NOTIFICATION_BUSY', retryable: true,
    });
    await fixture.knex('lawn_assessment_runs').where({ id: seeded.run.id })
      .update({ pipeline_claimed_at: fixture.knex.raw("clock_timestamp() - interval '16 minutes'") });
    expect(await replayDeferredNotification(meta, replayDeps())).toMatchObject(replayHold);
    expect(await fixture.knex('sms_log').where({ customer_id: seeded.customerId })).toHaveLength(1);
    expect(await fixture.knex('lawn_assessment_runs').where({ id: seeded.run.id }).first())
      .toMatchObject({ pipeline_claimed_at: expect.any(Date), pipeline_owner_token: null, pipeline_completed_at: null });
  });

  test('a retryable provider rejection followed by an audit throw remains retryable through real dispatcher replay', async () => {
    const seeded = await seed();
    const { queued } = await queueHeld(seeded.assessment.id);
    const providerOutcome = {
      sent: false,
      provider: 'twilio',
      deliveryOutcome: 'not_sent',
      code: 'PROVIDER_RETRY',
      error: 'rate limited',
      retryable: true,
      terminal: false,
      retryAfterMs: 300000,
      nextAllowedAt: new Date(Date.now() + 300000).toISOString(),
      providerErrorCode: '20429',
      providerHttpStatus: 429,
    };
    mockNotify.mockImplementation((...args) => RealNotificationDispatcher.notify(...args));
    mockSendCustomerMessage.mockRejectedValue(Object.assign(new Error('audit write failed'), { providerOutcome }));

    await expect(replayDeferredNotification(replayMeta(seeded, queued), replayDeps())).resolves.toMatchObject({
      ...providerOutcome,
      retryable: true,
      deferred: true,
    });
    expect(await fixture.knex('sms_log').where({ customer_id: seeded.customerId })).toHaveLength(1);
    expect(await fixture.knex('lawn_assessments').where({ id: seeded.assessment.id }).first())
      .toMatchObject({ notification_sent: false, notification_sent_at: null });
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
