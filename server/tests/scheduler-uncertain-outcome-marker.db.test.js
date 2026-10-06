/**
 * Codex round 7 on #6017: a scheduled text whose provider handoff may have happened with no
 * confirmed outcome must leave a durable sign on its row, whatever status the row ends in, so a
 * same-text send elsewhere (the Intelligence Bar's send reservation, sms-outcome-guard.js) can
 * refuse until it is reconciled. The sign is metadata.provider_outcome_uncertain with its own
 * timestamp, provider_outcome_uncertain_at. A definite pre-provider hold or a definite rejection
 * stamps nothing. Synthetic data only; the provider is a stub.
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
  ...jest.requireActual('../services/messaging/send-customer-message'),
  sendCustomerMessage: (...args) => mockSendCustomerMessage(...args),
}));

// CI's DB-gated step selects suites by this exact line (.github/workflows/tests.yml).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

postgres('scheduled text transitions stamp provider_outcome_uncertain when the handoff outcome is unknown (real PostgreSQL)', () => {
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

  async function queue(attempts) {
    const customerId = randomUUID();
    await fixture.knex('customers').insert({ id: customerId, first_name: 'Fixture', phone: '+19415550100' });
    const [row] = await fixture.knex('sms_log').insert({
      customer_id: customerId,
      direction: 'outbound',
      from_phone: '+19415550199',
      to_phone: '+19415550100',
      message_body: 'We will be there Tuesday at 9.',
      message_type: 'manual',
      status: 'scheduled',
      scheduled_for: new Date(0),
      created_at: new Date(),
      metadata: JSON.stringify({ scheduled_sms_attempts: attempts, human_authored: true }),
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

  const uncertain = () => ({ sent: false, blocked: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_FAILURE', reason: 'timeout', retryable: true, providerAlerted: true });
  const row = (id) => fixture.knex('sms_log').where({ id }).first();
  const stampedRecently = (meta) => Math.abs(Date.now() - new Date(meta.provider_outcome_uncertain_at).getTime()) < 60000;

  test('the terminal blocked transition (final retry, unknown outcome) writes the marker and its timestamp', async () => {
    const queued = await queue(2); // the claim makes this the third and last attempt
    mockSendCustomerMessage.mockResolvedValue(uncertain());

    await tick();

    const after = await row(queued.id);
    expect(after.status).toBe('blocked');
    expect(after.metadata).toMatchObject({ provider_outcome_uncertain: true, provider_outcome_uncertain_at: expect.any(String) });
    expect(stampedRecently(after.metadata)).toBe(true);
  });

  test('a requeue after an unknown outcome writes the marker next to provider_retry_at', async () => {
    const queued = await queue(0);
    mockSendCustomerMessage.mockResolvedValue(uncertain());

    await tick();

    const after = await row(queued.id);
    expect(after.status).toBe('scheduled');
    expect(after.metadata).toMatchObject({ provider_retry_at: expect.any(String), provider_outcome_uncertain: true, provider_outcome_uncertain_at: expect.any(String) });
  });

  test('an exception after a possible handoff ends the row failed with the marker; a throw before the provider stamps nothing', async () => {
    const queued = await queue(2);
    mockSendCustomerMessage.mockRejectedValue(Object.assign(new Error('socket hang up'), { providerOutcome: { sent: false, deliveryOutcome: 'uncertain' } }));
    await tick();
    const failed = await row(queued.id);
    expect(failed.status).toBe('failed');
    expect(failed.metadata).toMatchObject({ provider_outcome_uncertain: true, provider_outcome_uncertain_at: expect.any(String) });

    const other = await queue(2);
    mockSendCustomerMessage.mockRejectedValue(new Error('reservation update failed before the provider'));
    await tick();
    const plain = await row(other.id);
    expect(plain.status).toBe('failed');
    expect(plain.metadata.provider_outcome_uncertain).toBeUndefined();
  });

  test('a definite pre-provider hold (QUIET_HOURS_HOLD) requeues with no marker, and a definite rejection blocks with none', async () => {
    const held = await queue(0);
    mockSendCustomerMessage.mockResolvedValue({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'QUIET_HOURS_HOLD', retryable: true, deferred: true,
      nextAllowedAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    });
    await tick();
    const requeued = await row(held.id);
    expect(requeued.status).toBe('scheduled');
    expect(requeued.metadata.provider_outcome_uncertain).toBeUndefined();

    const rejected = await queue(2);
    mockSendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'SMS_OPTED_OUT', reason: 'opted out' });
    await tick();
    const blocked = await row(rejected.id);
    expect(blocked.status).toBe('blocked');
    expect(blocked.metadata.provider_outcome_uncertain).toBeUndefined();
  });
});
