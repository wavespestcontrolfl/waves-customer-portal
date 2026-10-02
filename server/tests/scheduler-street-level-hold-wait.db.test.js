/**
 * Codex #5506 r1 P1: a scheduled composer text whose linked visit is a street-level address hold
 * (STREET_LEVEL_HOLD from the shared send step) made no provider call and can stay held as long as the
 * office takes to confirm. The scheduler must refund the attempt it claimed and keep the row scheduled,
 * like QUIET_HOURS_HOLD, instead of spending the bounded 3-attempt ladder and ending terminally blocked.
 * Once the hold clears, the same row sends. Synthetic data only.
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

postgres('scheduled composer text held by a street-level address hold (real PostgreSQL)', () => {
  let fixture;
  const VISIT = '3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c';

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

  async function queue(attempts) {
    const customerId = randomUUID();
    await fixture.knex('customers').insert({ id: customerId, first_name: 'Fixture', phone: '+19415550100' });
    const [row] = await fixture.knex('sms_log').insert({
      customer_id: customerId,
      direction: 'outbound',
      from_phone: '+19415550199',
      to_phone: '+19415550100',
      message_body: 'Here is your reschedule link.',
      message_type: 'manual',
      status: 'scheduled',
      scheduled_for: new Date(0),
      created_at: new Date(),
      metadata: JSON.stringify({ scheduled_sms_attempts: attempts, human_authored: true, linked_scheduled_service_ids: [VISIT] }),
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

  const held = () => ({
    sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'STREET_LEVEL_HOLD', retryable: true,
    reason: 'Visit is an address hold awaiting the office confirm',
  });

  test('a long-open hold never blocks the row: even on the final attempt it is refunded and rescheduled', async () => {
    const queued = await queue(2);
    mockSendCustomerMessage.mockResolvedValue(held());

    await tick();

    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    // The linked visits ride the replay, so the shared send step could check them.
    expect(mockSendCustomerMessage.mock.calls[0][0].metadata.linked_scheduled_service_ids).toEqual([VISIT]);
    const row = await fixture.knex('sms_log').where({ id: queued.id }).first();
    expect(row.status).toBe('scheduled');
    expect(row.metadata).toMatchObject({ scheduled_sms_attempts: 2, street_level_hold_at: expect.any(String) });
    expect(new Date(row.scheduled_for).getTime()).toBeGreaterThan(Date.now() + 10 * 60 * 1000);
  });

  test('it stays held across many ticks, then sends once the office has confirmed', async () => {
    const queued = await queue(0);
    mockSendCustomerMessage.mockResolvedValue(held());
    for (let i = 0; i < 5; i += 1) {
      await tick();
      const row = await fixture.knex('sms_log').where({ id: queued.id }).first();
      expect(row.status).toBe('scheduled');
      expect(Number(row.metadata.scheduled_sms_attempts)).toBeLessThanOrEqual(1);
      // The row waits until its next poll; make it due again for the next tick.
      await fixture.knex('sms_log').where({ id: queued.id }).update({ scheduled_for: new Date(0) });
    }

    // The office confirms: the hold clears and the same row sends.
    mockSendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SMfixture', blocked: false });
    await tick();
    const sent = await fixture.knex('sms_log').where({ id: queued.id }).first();
    expect(sent.status).not.toBe('scheduled');
    expect(sent.status).not.toBe('blocked');
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(6);
  });

  test('a linked visit that ended while the text waited (LINKED_VISIT_ENDED) ends the row blocked, with its reason, and is never retried', async () => {
    const queued = await queue(0);
    mockSendCustomerMessage.mockResolvedValue({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'LINKED_VISIT_ENDED',
      reason: 'The visit this reschedule link points at is no longer reschedulable (cancelled, skipped or completed)',
    });
    await tick();
    const row = await fixture.knex('sms_log').where({ id: queued.id }).first();
    expect(row.status).toBe('blocked');
    expect(row.metadata).toMatchObject({ blocked_code: 'LINKED_VISIT_ENDED', blocked_reason: expect.stringMatching(/no longer reschedulable/) });
    await fixture.knex('sms_log').where({ id: queued.id }).update({ scheduled_for: new Date(0) });
    await tick();
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('another retryable refusal still spends the bounded ladder (the hold branch is not a general wait)', async () => {
    const queued = await queue(2);
    mockSendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'SOME_OTHER_BLOCK', retryable: false });
    await tick();
    const row = await fixture.knex('sms_log').where({ id: queued.id }).first();
    expect(row.status).not.toBe('scheduled');
    expect(row.metadata.street_level_hold_at).toBeUndefined();
  });
});
