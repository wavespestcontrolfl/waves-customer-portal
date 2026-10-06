/**
 * Codex #5001 r1 P1: a scheduled billing replay that finds another attempt's
 * live Text claim (BILLING_TEXT_LEG_IN_FLIGHT, messaging/billing-text-leg-
 * dedupe.js) made no provider call. The scheduler must refund the attempt it
 * claimed, like QUIET_HOURS_HOLD, instead of spending the bounded retry
 * ladder: three in-flight ticks would otherwise block the replay terminally
 * while the claim is still live, and the notice would be lost if that other
 * attempt then ended not_sent.
 */
const { randomUUID } = require('crypto');
const { createLawnVisitDb } = require('./helpers/lawn-visit-db');

let mockKnex;
const mockSendCustomerMessage = jest.fn();

jest.mock('../models/db', () => {
  const db = (...args) => mockKnex(...args);
  db.transaction = (...args) => mockKnex.transaction(...args);
  db.raw = (...args) => mockKnex.raw(...args);
  Object.defineProperty(db, 'fn', { get: () => mockKnex.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gateEnvTimestamp: () => null,
  gateEnvValue: () => false,
  isEnabled: (name) => name === 'cronJobs',
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

// CI's DB-gated step selects suites by this exact line (.github/workflows/tests.yml).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

postgres('scheduled billing replay held by an in-flight Text claim (real PostgreSQL)', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await createLawnVisitDb(false);
    mockKnex = fixture.knex;
    for (const table of ['sms_log', 'notification_prefs']) {
      await fixture.knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [fixture.schema, table, table]);
    }
  }, 60000);

  afterAll(async () => { if (fixture) await fixture.dispose(); });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSendCustomerMessage.mockReset();
    for (const table of ['sms_log', 'notification_prefs', 'customers']) await fixture.knex(table).del();
  });

  async function queueFinalAttempt() {
    const customerId = randomUUID();
    await fixture.knex('customers').insert({ id: customerId, first_name: 'Fixture', phone: '+19415550100' });
    const [row] = await fixture.knex('sms_log').insert({
      customer_id: customerId,
      direction: 'outbound',
      from_phone: '+19415550199',
      to_phone: '+19415550100',
      message_body: 'Your invoice is ready.',
      message_type: 'billing_reminder',
      status: 'scheduled',
      scheduled_for: new Date(0),
      created_at: new Date(),
      metadata: JSON.stringify({ scheduled_sms_attempts: 2, notificationEventKey: 'billing:fixture:reminder:1' }),
    }).returning('*');
    return row;
  }

  async function tick() {
    const cron = require('../utils/scheduled-cron');
    cron.schedule.mockClear();
    require('../services/scheduler').initScheduledJobs();
    const job = cron.schedule.mock.calls.find(([, callback]) => String(callback).includes('claimDueScheduledSms'))[1];
    await job();
  }

  test('refunds the final attempt and reschedules at the hold time — never terminally blocked', async () => {
    const queued = await queueFinalAttempt();
    const nextAllowedAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    mockSendCustomerMessage.mockResolvedValue({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'BILLING_TEXT_LEG_IN_FLIGHT',
      retryable: true, deferred: true, nextAllowedAt,
    });

    await tick();

    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    const held = await fixture.knex('sms_log').where({ id: queued.id }).first();
    expect(held).toMatchObject({
      status: 'scheduled',
      metadata: { scheduled_sms_attempts: 2, billing_text_in_flight_hold_at: expect.any(String) },
    });
    expect(new Date(held.scheduled_for).toISOString()).toBe(nextAllowedAt);
  });

  test('a collections dispute hold (COLLECTION_HOLD_DEFER) on a delayed pay-link leg refunds the final attempt and waits - never terminally blocked', async () => {
    const queued = await queueFinalAttempt();
    const nextAllowedAt = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    mockSendCustomerMessage.mockResolvedValue({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'COLLECTION_HOLD_DEFER',
      retryable: true, deferred: true, nextAllowedAt,
    });

    await tick();

    const held = await fixture.knex('sms_log').where({ id: queued.id }).first();
    expect(held).toMatchObject({
      status: 'scheduled',
      metadata: { scheduled_sms_attempts: 2, collection_hold_deferred_at: expect.any(String) },
    });
    expect(held.metadata.quiet_hours_hold_at).toBeUndefined();
    expect(new Date(held.scheduled_for).toISOString()).toBe(nextAllowedAt);
  });

  test('a dedupe-unavailable infra hold still spends the bounded ladder', async () => {
    const queued = await queueFinalAttempt();
    mockSendCustomerMessage.mockResolvedValue({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'BILLING_TEXT_DEDUPE_UNAVAILABLE',
      retryable: true, deferred: true, nextAllowedAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });

    await tick();

    const row = await fixture.knex('sms_log').where({ id: queued.id }).first();
    expect(row.metadata.billing_text_in_flight_hold_at).toBeUndefined();
    expect(row.status).not.toBe('scheduled');
  });
});
