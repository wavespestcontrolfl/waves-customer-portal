/**
 * Pre-push audit P1 #A + #B (#4963 split PR 2, narrowed invoice-email-leg-
 * guard branch): a scheduler-level regression proving the invoice_send_
 * deferred dispatch() hook no longer lets an accepted Text leg's
 * representative outcome hide a still-retryable Email leg — the exact bug
 * that would otherwise mark the sole replay row 'sent' and drop the Email
 * obligation forever — and that the Text leg's delivery is stamped onto the
 * invoice from REAL durable evidence (a separate sms_log row, never this
 * replay's own queue row) even while the row stays on its bounded retry
 * ladder for Email.
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

postgres('invoice_send_deferred partial-fanout replay: leg-retry guard + durable stamping (real PostgreSQL)', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await createLawnVisitDb(false);
    mockKnex = fixture.knex;
    for (const table of ['sms_log', 'notification_prefs', 'invoices', 'email_messages', 'notifications']) {
      await fixture.knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [fixture.schema, table, table]);
    }
  }, 60000);

  afterAll(async () => { if (fixture) await fixture.dispose(); });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSendCustomerMessage.mockReset();
    for (const table of ['sms_log', 'notification_prefs', 'email_messages', 'notifications', 'invoices', 'customers']) {
      await fixture.knex(table).del();
    }
  });

  async function seedCustomerAndInvoice() {
    const customerId = randomUUID();
    await fixture.knex('customers').insert({ id: customerId, first_name: 'Fixture', phone: '+19415550100' });
    const [invoice] = await fixture.knex('invoices').insert({
      customer_id: customerId,
      token: randomUUID(),
      invoice_number: `INV-${Math.floor(Math.random() * 1e6)}`,
      status: 'sent',
      total: '150.00',
    }).returning('*');
    return { customerId, invoice };
  }

  async function queuePartialFanoutRetry({ customerId, invoiceId }) {
    const notificationEventKey = `invoice:${invoiceId}:sent`;
    const [row] = await fixture.knex('sms_log').insert({
      customer_id: customerId,
      direction: 'outbound',
      from_phone: '+19415550199',
      to_phone: '+19415550100',
      message_body: 'Your invoice is ready — pay here: https://example.test/pay/abc',
      message_type: 'invoice',
      status: 'scheduled',
      scheduled_for: new Date(0),
      created_at: new Date(),
      metadata: JSON.stringify({
        entry_point: 'invoice_send_deferred',
        invoice_id: invoiceId,
        billingDeliveryCategory: 'invoice',
        notificationEventKey,
        partial_fanout_retry: true,
        original_block_code: 'BILLING_CHANNEL_FAILED',
        replay_purpose: 'payment_link',
        refresh_customer_phone: true,
        resolve_from_by_customer: true,
      }),
    }).returning('*');
    return { row, notificationEventKey };
  }

  // Simulates the REAL Twilio-provider sms_log row twilio.js writes on an
  // accepted Text handoff — a SEPARATE row from the replay's own queue row,
  // which is exactly the durable evidence Finding B reads.
  async function insertAcceptedTextEvidence({ customerId, notificationEventKey }) {
    await fixture.knex('sms_log').insert({
      customer_id: customerId,
      direction: 'outbound',
      from_phone: '+19415550199',
      to_phone: '+19415550100',
      message_body: 'Your invoice is ready — pay here: https://example.test/pay/abc',
      message_type: 'invoice',
      status: 'sent',
      twilio_sid: 'SM_fixture_accepted',
      created_at: new Date(),
      metadata: JSON.stringify({ notificationEventKey, billingDeliveryLeg: 'sms' }),
    });
  }

  async function tick() {
    const cron = require('../utils/scheduled-cron');
    cron.schedule.mockClear();
    require('../services/scheduler').initScheduledJobs();
    const job = cron.schedule.mock.calls.find(([, callback]) => String(callback).includes('claimDueScheduledSms'))[1];
    await job();
  }

  test('Email retryable + Text accepted: the row stays on its bounded retry ladder (never marked sent) and the invoice is stamped sms_sent_at from durable evidence, not email_sent_at', async () => {
    const { customerId, invoice } = await seedCustomerAndInvoice();
    const { row, notificationEventKey } = await queuePartialFanoutRetry({ customerId, invoiceId: invoice.id });
    await insertAcceptedTextEvidence({ customerId, notificationEventKey });

    // The exact overshadow shape billingDispatchOutcome produces: Email
    // failed retryable, Text accepted — reported as sent:true/accepted at
    // the top level.
    mockSendCustomerMessage.mockResolvedValue({
      sent: true, deliveryOutcome: 'accepted', notificationEventKey,
      channelResults: {
        email: { sent: false, retryable: true, code: 'BILLING_CHANNEL_FAILED', reason: 'provider error' },
        sms: { sent: true, deliveryOutcome: 'accepted' },
      },
    });

    await tick();

    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);

    // The replay row is never finalized as 'sent' (which would drop the
    // Email obligation forever) — it stays on the bounded retry ladder.
    const held = await fixture.knex('sms_log').where({ id: row.id }).first();
    expect(held.status).toBe('scheduled');
    expect(held.metadata.provider_retry_code).toBe('PARTIAL_FANOUT_LEG_RETRY');
    expect(new Date(held.scheduled_for).getTime()).toBeGreaterThan(Date.now());

    // The accepted Text leg is durably stamped THIS attempt, from real
    // provider evidence — never the queue row's own (nonexistent) SID.
    const stampedInvoice = await fixture.knex('invoices').where({ id: invoice.id }).first();
    expect(stampedInvoice.sms_sent_at).not.toBeNull();
    expect(stampedInvoice.email_sent_at).toBeNull();
  });

  test('Text evidence is the provider row: the replay\'s own sent queue row and an App push proof (same key, NULL sid) never mask it', async () => {
    const { customerId, invoice } = await seedCustomerAndInvoice();
    const { row, notificationEventKey } = await queuePartialFanoutRetry({ customerId, invoiceId: invoice.id });
    // Queue row already marked sent (as markScheduledSmsSent leaves it), and
    // a push proof, both inserted BEFORE the real Twilio row so an unordered
    // .first() on the key alone would reach them first.
    await fixture.knex('sms_log').where({ id: row.id }).update({ status: 'sent' });
    await fixture.knex('sms_log').insert({
      customer_id: customerId, direction: 'outbound', from_phone: 'push', to_phone: '',
      message_body: 'Your invoice is ready', message_type: 'invoice', status: 'sent', twilio_sid: null,
      created_at: new Date(), metadata: JSON.stringify({ notificationEventKey }),
    });
    const { _registry } = require('../services/messaging/deferred-replay-registry');
    const meta = { ...row.metadata, invoice_id: invoice.id, partial_fanout_retry: true, notificationEventKey };

    // App proof alone: sms_sent_at is stamped (Text OR App), so clear it and
    // check Text on its own below.
    await _registry.invoice_send_deferred.finalize(meta);
    await fixture.knex('sms_log').where({ from_phone: 'push' }).del();
    await fixture.knex('invoices').where({ id: invoice.id }).update({ sms_sent_at: null });

    // Only the sent queue row left (NULL sid): not Text evidence.
    await _registry.invoice_send_deferred.finalize(meta);
    expect((await fixture.knex('invoices').where({ id: invoice.id }).first()).sms_sent_at).toBeNull();

    // The real provider row after it: stamped.
    await insertAcceptedTextEvidence({ customerId, notificationEventKey });
    await _registry.invoice_send_deferred.finalize(meta);
    expect((await fixture.knex('invoices').where({ id: invoice.id }).first()).sms_sent_at).not.toBeNull();
  });

  test('an uncertain Email next to a retryable Text failure: the row is blocked for review, never rescheduled', async () => {
    const { customerId, invoice } = await seedCustomerAndInvoice();
    const { row, notificationEventKey } = await queuePartialFanoutRetry({ customerId, invoiceId: invoice.id });

    mockSendCustomerMessage.mockResolvedValue({
      sent: false, deliveryOutcome: 'not_sent', retryable: true, code: 'BILLING_CHANNEL_FAILED', notificationEventKey,
      channelResults: {
        email: { sent: false, deliveryOutcome: 'uncertain', code: 'EMAIL_PROVIDER_TIMEOUT' },
        sms: { sent: false, deliveryOutcome: 'not_sent', retryable: true, code: 'BILLING_CHANNEL_FAILED' },
      },
    });

    await tick();

    const blocked = await fixture.knex('sms_log').where({ id: row.id }).first();
    expect(blocked.status).toBe('blocked');
    expect(blocked.metadata.provider_retry_code).toBeUndefined();
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('an uncertain leg blocks auto-retry entirely: the row is NOT rescheduled for another attempt, even though Text also accepted', async () => {
    const { customerId, invoice } = await seedCustomerAndInvoice();
    const { row, notificationEventKey } = await queuePartialFanoutRetry({ customerId, invoiceId: invoice.id });
    await insertAcceptedTextEvidence({ customerId, notificationEventKey });

    mockSendCustomerMessage.mockResolvedValue({
      sent: true, deliveryOutcome: 'accepted', notificationEventKey,
      channelResults: {
        push: { sent: false, deliveryOutcome: 'uncertain', code: 'APP_OUTCOME_UNCERTAIN' },
        sms: { sent: true, deliveryOutcome: 'accepted' },
      },
    });

    await tick();

    // Never retried for the uncertain leg (would risk a double-send) — the
    // row proceeds through the ordinary 'sent' finalize path instead, same
    // as the enqueue-time rule (invoice.js) an uncertain leg blocks queuing
    // entirely.
    const held = await fixture.knex('sms_log').where({ id: row.id }).first();
    expect(held.status).toBe('sent');
    expect(held.metadata.provider_retry_code).toBeUndefined();

    const stampedInvoice = await fixture.knex('invoices').where({ id: invoice.id }).first();
    expect(stampedInvoice.sms_sent_at).not.toBeNull();
  });
});
