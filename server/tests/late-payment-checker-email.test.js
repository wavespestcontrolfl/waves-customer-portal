jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return fn;
});
// Collections contact ledger (record-then-send, codex 2026-08-14): the rails
// now insert a ledger row BEFORE each delivery attempt and SKIP the send if
// the insert fails. Mock it as always-succeeding so this suite keeps testing
// its own concern; the ledger discipline itself is pinned in
// collections-rails-policy.test.js.
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  markSendFailed: jest.fn(async () => true),
  markDelivered: jest.fn(async () => true),
  claimAttempt: jest.fn(async () => ({ allowed: true })),
}));

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false, deliveryOutcome: 'accepted' })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async (templateKey) => `sms body for ${templateKey}`),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'https://portal.wavespestcontrol.com/l/pay123'),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
jest.mock('../services/invoice-followups', () => ({
  hasActiveSequence: jest.fn(async () => false),
  isDunningStopped: jest.fn(async () => false),
}));
jest.mock('../services/workflows/balance-reminder', () => ({
  sendLatePaymentEmail: jest.fn(async () => ({ ok: true })),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const BalanceReminder = require('../services/workflows/balance-reminder');
const ContactLedger = require('../services/collections/contact-ledger');
const InvoiceFollowUps = require('../services/invoice-followups');
const LatePaymentChecker = require('../services/late-payment-checker');

function chain({ result = [], first } = {}) {
  const q = {};
  q.where = jest.fn((arg) => {
    if (typeof arg === 'function') arg.call(q);
    return q;
  });
  q.whereIn = jest.fn(() => q);
  q.whereNull = jest.fn(() => q);
  q.whereRaw = jest.fn(() => q);
  q.orderBy = jest.fn(() => q);
  // The withdrawal-stamp exclusion (a payer-billed combined-visit invoice
  // keeps payer_id NULL) uses these.
  q.whereNot = jest.fn(() => q);
  q.orWhereNot = jest.fn(() => q);
  q.orWhereNull = jest.fn(() => q);
  q.andWhere = jest.fn(() => q);
  q.orWhere = jest.fn((arg) => {
    if (typeof arg === 'function') arg.call(q);
    return q;
  });
  q.limit = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.insert = jest.fn(async () => undefined);
  q.update = jest.fn(async () => 1);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) {
      // The checker's active-plan gate (fail-closed) probes payment_plans
      // per invoice — default to "no active plan" unless a test scripts one.
      if (table === 'payment_plans') return chain({ first: undefined });
      if (table === 'collections_contact_ledger') return chain({ result: [] });
      throw new Error(`Unexpected db table ${table}`);
    }
    return queue.shift();
  });
}

describe('late-payment checker email sidecar', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-26T14:00:00.000Z'));
    jest.clearAllMocks();
    ContactLedger.recordContact.mockReset().mockResolvedValue({ id: 'led-1', metadata: {} });
    ContactLedger.claimAttempt.mockReset().mockResolvedValue({ allowed: true });
    BalanceReminder.sendLatePaymentEmail.mockReset().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('sends the matching late-payment email after the legacy fallback SMS path succeeds', async () => {
    const invoice = {
      id: 'inv-1',
      customer_id: 'cust-1',
      token: 'token-1',
      invoice_number: 'WPC-2026-1042',
      status: 'sent',
      title: 'Quarterly Pest Control',
      total: '129.00',
      due_date: '2026-05-10',
      service_date: '2026-05-01',
      created_at: '2026-05-01T12:00:00.000Z',
    };
    const customer = {
      id: 'cust-1',
      first_name: 'Taylor',
      phone: '+19415550101',
    };

    setDbQueues({
      // The batch query, then the ownership re-reads: before the dunning
      // guards, on the last read before the provider, and the email leg's
      // own check (a Bill-To change can land in any of those windows).
      invoices: [
        chain({ result: [invoice] }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
      ],
      activity_log: [chain({ first: null }), chain()],
      customers: [chain({ first: customer })],
    });

    await LatePaymentChecker.checkAndNotify();

    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'late_payment_14d',
      expect.objectContaining({
        first_name: 'Taylor',
        invoice_title: 'Quarterly Pest Control',
        pay_url: 'https://portal.wavespestcontrol.com/l/pay123',
      }),
      expect.objectContaining({
        workflow: 'late_payment_reminder',
        entity_type: 'invoice',
        entity_id: 'inv-1',
      }),
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550101',
      body: 'sms body for late_payment_14d',
      entryPoint: 'late_payment_checker',
      metadata: expect.objectContaining({ original_message_type: 'late_payment' }),
    }));
    expect(BalanceReminder.sendLatePaymentEmail).toHaveBeenCalledWith(expect.objectContaining({
      customer,
      invoice,
      smsTemplateKey: 'late_payment_14d',
      invoiceTitle: 'Quarterly Pest Control',
      payUrl: 'https://portal.wavespestcontrol.com/l/pay123',
    }));
  });

  test('falls back to the email reminder when the SMS is permanently undeliverable (landline suppression)', async () => {
    const invoice = {
      id: 'inv-1',
      customer_id: 'cust-1',
      token: 'token-1',
      invoice_number: 'WPC-2026-1042',
      status: 'sent',
      title: 'Quarterly Pest Control',
      total: '129.00',
      due_date: '2026-05-10',
      service_date: '2026-05-01',
      created_at: '2026-05-01T12:00:00.000Z',
    };
    const customer = { id: 'cust-1', first_name: 'Taylor', phone: '+18777175476' };

    // The number bounced as a landline on a prior run → now hard-suppressed.
    sendCustomerMessage.mockResolvedValueOnce({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'SUPPRESSED_NON_MOBILE', retryable: false,
    });

    setDbQueues({
      // The batch query, then the ownership re-reads: before the dunning
      // guards, on the last read before the provider, and the email leg's
      // own check (a Bill-To change can land in any of those windows).
      invoices: [
        chain({ result: [invoice] }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
      ],
      activity_log: [chain({ first: null }), chain()],
      customers: [chain({ first: customer })],
    });

    const result = await LatePaymentChecker.checkAndNotify();

    // Email still goes out even though the SMS was blocked.
    expect(BalanceReminder.sendLatePaymentEmail).toHaveBeenCalledWith(expect.objectContaining({
      customer,
      invoice,
      smsTemplateKey: 'late_payment_14d',
    }));
    expect(result.notified).toBe(0);
    expect(result.emailedFallback).toBe(1);
  });

  test('does not dedupe the tier when the SMS is undeliverable AND the email fallback also fails to send', async () => {
    const invoice = {
      id: 'inv-1',
      customer_id: 'cust-1',
      token: 'token-1',
      invoice_number: 'WPC-2026-1042',
      status: 'sent',
      title: 'Quarterly Pest Control',
      total: '129.00',
      due_date: '2026-05-10',
      service_date: '2026-05-01',
      created_at: '2026-05-01T12:00:00.000Z',
    };
    const customer = { id: 'cust-1', first_name: 'Taylor', phone: '+18777175476' };

    sendCustomerMessage.mockResolvedValueOnce({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'SUPPRESSED_NON_MOBILE', retryable: false,
    });
    // No billing email on file → the fallback email does not send.
    BalanceReminder.sendLatePaymentEmail.mockResolvedValueOnce({ ok: false, skipped: true, reason: 'missing_email' });

    // Second activity_log chain carries a spy on .insert — a regression that writes
    // the dedupe row would request it and trip the assertion below.
    const dedupeInsertSpy = jest.fn(async () => undefined);
    const insertChain = chain();
    insertChain.insert = dedupeInsertSpy;

    setDbQueues({
      // The batch query, then the ownership re-reads: before the dunning
      // guards, on the last read before the provider, and the email leg's
      // own check (a Bill-To change can land in any of those windows).
      invoices: [
        chain({ result: [invoice] }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
      ],
      activity_log: [chain({ first: null }), insertChain],
      customers: [chain({ first: customer })],
    });

    const result = await LatePaymentChecker.checkAndNotify();

    expect(BalanceReminder.sendLatePaymentEmail).toHaveBeenCalled();
    expect(dedupeInsertSpy).not.toHaveBeenCalled(); // tier left un-deduped → retried next run
    expect(result.notified).toBe(0);
    expect(result.emailedFallback).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test.each([
    ['definite non-send', { sent: true, deliveryOutcome: 'not_sent', code: 'OWNER_SILENCE' }, true],
    ['unconfirmed outcome', { sent: true, deliveryOutcome: 'uncertain', code: 'PROVIDER_UNCONFIRMED' }, false],
    ['pre-provider lock refusal', { sent: false, blocked: true, code: 'LOCK_BUSY' }, true],
  ])('does not count a Text result with %s as delivered', async (_label, textResult, definite) => {
    const invoice = {
      id: 'inv-1', customer_id: 'cust-1', token: 'token-1', invoice_number: 'WPC-2026-1042',
      status: 'sent', title: 'Quarterly Pest Control', total: '129.00', due_date: '2026-05-10',
      service_date: '2026-05-01', created_at: '2026-05-01T12:00:00.000Z',
    };
    sendCustomerMessage.mockResolvedValueOnce(textResult);
    if (definite) BalanceReminder.sendLatePaymentEmail.mockResolvedValueOnce({ ok: false, skipped: true, reason: 'missing_email' });
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-14`, metadata: {} }));
    const activityInsert = chain();
    setDbQueues({
      invoices: [chain({ result: [invoice] }), ...Array(definite ? 4 : 2).fill(null).map(() => chain({ first: { payer_id: null, scheduled_send_error: null } }))],
      activity_log: [chain({ first: null }), chain({ result: [] }), activityInsert],
      customers: [chain({ first: { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' } })],
    });
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 0, emailedFallback: 0, skipped: 1 });
    expect(ContactLedger.markDelivered).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'sms-14' }));
    if (definite) {
      expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(expect.objectContaining({ id: 'sms-14' }), expect.anything());
      expect(BalanceReminder.sendLatePaymentEmail).toHaveBeenCalledTimes(1);
    } else {
      expect(ContactLedger.markSendFailed).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'sms-14' }), expect.anything());
      expect(BalanceReminder.sendLatePaymentEmail).not.toHaveBeenCalled();
    }
    expect(activityInsert.insert).not.toHaveBeenCalled();
  });

  test('keeps a selected retryable Text leg alive after the selected Email succeeds', async () => {
    const invoice = {
      id: 'inv-1',
      customer_id: 'cust-1',
      token: 'token-1',
      invoice_number: 'WPC-2026-1042',
      status: 'sent',
      title: 'Quarterly Pest Control',
      total: '129.00',
      due_date: '2026-05-10',
      service_date: '2026-05-01',
      created_at: '2026-05-01T12:00:00.000Z',
    };
    const customer = { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' };

    sendCustomerMessage.mockResolvedValueOnce({
      sent: false, blocked: false, code: 'PROVIDER_FAILURE', retryable: true, deferred: true,
    });

    const dedupeInsert = chain();
    setDbQueues({
      // The batch query, then the ownership re-reads: before the dunning
      // guards, on the last read before the provider, and the email leg's
      // own check (a Bill-To change can land in any of those windows).
      invoices: [
        chain({ result: [invoice] }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
      ],
      activity_log: [chain({ first: null }), dedupeInsert],
      customers: [chain({ first: customer })],
      notification_prefs: [chain({ first: { billing_channels: ['email', 'sms'] } })],
    });

    const result = await LatePaymentChecker.checkAndNotify();

    expect(BalanceReminder.sendLatePaymentEmail).toHaveBeenCalled();
    expect(dedupeInsert.insert).not.toHaveBeenCalled();
    expect(result.notified).toBe(0);
    expect(result.emailedFallback).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('retries only a pending selected Email after accepted Text, preserving the original tier', async () => {
    const invoice = {
      id: 'inv-1', customer_id: 'cust-1', token: 'token-1', invoice_number: 'WPC-2026-1042',
      status: 'sent', title: 'Quarterly Pest Control', total: '129.00', due_date: '2026-05-10',
      service_date: '2026-05-01', created_at: '2026-05-01T12:00:00.000Z',
    };
    const customer = { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' };
    BalanceReminder.sendLatePaymentEmail
      .mockResolvedValueOnce({ ok: false, skipped: true, reason: 'template_unavailable', retryable: true })
      .mockResolvedValueOnce({ ok: true });
    const activityInsert = chain();
    setDbQueues({
      invoices: [chain({ result: [invoice] }), ...Array(3).fill(null).map(() => chain({ first: { payer_id: null, scheduled_send_error: null } }))],
      activity_log: [chain({ first: null }), chain({ result: [] }), activityInsert],
      customers: [chain({ first: customer })],
      notification_prefs: [chain({ first: { billing_channels: ['email', 'sms'] } })],
    });
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 1 });
    const pending = JSON.parse(activityInsert.insert.mock.calls[0][0].metadata);
    expect(pending).toMatchObject({ pendingEmail: true, channel: 'sms', tierDays: 14 });

    jest.setSystemTime(new Date('2026-06-15T14:00:00.000Z'));
    const completion = chain();
    setDbQueues({
      invoices: [chain({ result: [invoice] }), ...Array(3).fill(null).map(() => chain({ first: { payer_id: null, scheduled_send_error: null } }))],
      activity_log: [chain({ first: { id: 'activity-1', metadata: pending } }), completion],
      customers: [chain({ first: customer })],
      notification_prefs: [chain({ first: { billing_channels: ['email', 'sms'] } })],
    });
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(renderSmsTemplate).toHaveBeenCalledTimes(1);
    expect(BalanceReminder.sendLatePaymentEmail).toHaveBeenLastCalledWith(
      expect.objectContaining({ smsTemplateKey: 'late_payment_14d' }),
    );
    expect(completion.update).toHaveBeenCalled();
  });

  test('holds a pending Email whose prior provider outcome was not stamped as failed', async () => {
    const invoice = {
      id: 'inv-1', customer_id: 'cust-1', token: 'token-1', invoice_number: 'WPC-2026-1042',
      status: 'sent', title: 'Quarterly Pest Control', total: '129.00', due_date: '2026-05-10',
      service_date: '2026-05-01', created_at: '2026-05-01T12:00:00.000Z',
    };
    ContactLedger.recordContact.mockResolvedValueOnce({ id: 'email-14', reused: true, metadata: {} });
    ContactLedger.claimAttempt.mockResolvedValueOnce({ allowed: false, held: true });
    setDbQueues({
      invoices: [chain({ result: [invoice] }), chain({ first: { payer_id: null, scheduled_send_error: null } })],
      activity_log: [chain({ first: {
        id: 'activity-1',
        metadata: { pendingEmail: true, tierDays: 14, invoiceKey: 'WPC-2026-1042|14 DAYS', ledgerIds: ['sms-14', 'email-14'] },
      } })],
      customers: [chain({ first: { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' } })],
      notification_prefs: [chain({ first: { billing_channels: ['email', 'sms'] } })],
    });

    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 0, skipped: 1 });
    expect(BalanceReminder.sendLatePaymentEmail).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('recovers the 14-day Email from ledger after its activity write fails, without a 30-day Text', async () => {
    const invoice = {
      id: 'inv-1', customer_id: 'cust-1', token: 'token-1', invoice_number: 'WPC-2026-1042',
      status: 'sent', title: 'Quarterly Pest Control', total: '129.00', due_date: '2026-05-10',
      service_date: '2026-05-01', created_at: '2026-05-01T12:00:00.000Z',
    };
    const customer = { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' };
    BalanceReminder.sendLatePaymentEmail
      .mockResolvedValueOnce({ ok: false, reason: 'provider_unavailable' })
      .mockResolvedValueOnce({ ok: true });
    const failedInsert = chain();
    failedInsert.insert.mockRejectedValueOnce(new Error('activity write unavailable'));
    setDbQueues({
      invoices: [chain({ result: [invoice] }), ...Array(3).fill(null).map(() => chain({ first: { payer_id: null, scheduled_send_error: null } }))],
      activity_log: [chain({ first: null }), chain({ result: [] }), failedInsert],
      customers: [chain({ first: customer })],
      notification_prefs: [chain({ first: { billing_channels: ['email', 'sms'] } })],
    });
    await LatePaymentChecker.checkAndNotify();

    jest.setSystemTime(new Date('2026-06-15T14:00:00.000Z'));
    ContactLedger.recordContact.mockResolvedValueOnce({
      id: 'email-14', reused: true, metadata: { send_failed: true },
    });
    setDbQueues({
      invoices: [chain({ result: [invoice] }), ...Array(3).fill(null).map(() => chain({ first: { payer_id: null, scheduled_send_error: null } }))],
      activity_log: [chain({ first: null }), chain({ result: [] })],
      collections_contact_ledger: [chain({ result: [
        { id: 'sms-14', channel: 'sms', idempotency_key: 'late_payment_checker:inv-1:14:sms', metadata: { delivered: true } },
        { id: 'email-14', channel: 'email', idempotency_key: 'late_payment_checker:inv-1:14:email', metadata: { send_failed: true } },
      ] })],
      customers: [chain({ first: customer })],
      notification_prefs: [chain({ first: { billing_channels: ['email', 'sms'] } })],
    });
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(renderSmsTemplate).toHaveBeenCalledTimes(1);
    expect(BalanceReminder.sendLatePaymentEmail).toHaveBeenLastCalledWith(
      expect.objectContaining({ smsTemplateKey: 'late_payment_14d' }),
    );
    expect(ContactLedger.recordContact).toHaveBeenLastCalledWith(expect.objectContaining({
      channel: 'email', idempotencyKey: 'late_payment_checker:inv-1:14:email',
    }));
  });

  test.each([
    ['missing address with an activity row', { ok: false, skipped: true, reason: 'missing_email' }, true],
    ['suppressed address without an activity row', { ok: false, blocked: true, reason: 'Suppressed: bounce' }, false],
    ['unavailable template with an activity row', { ok: false, skipped: true, reason: 'template_unavailable' }, true],
  ])('resolves a pending 14-day Email refused for %s and sends 30-day Text once', async (_label, refusal, hasActivity) => {
    const invoice = {
      id: 'inv-1', customer_id: 'cust-1', token: 'token-1', invoice_number: 'WPC-2026-1042',
      status: 'sent', title: 'Quarterly Pest Control', total: '129.00', due_date: '2026-05-10',
      service_date: '2026-05-01', created_at: '2026-05-01T12:00:00.000Z',
    };
    const customer = { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' };
    const invoiceReads = () => [
      chain({ result: [invoice] }),
      ...Array(3).fill(null).map(() => chain({ first: { payer_id: null, scheduled_send_error: null } })),
    ];
    ContactLedger.recordContact.mockImplementation(async ({ idempotencyKey }) => ({
      id: idempotencyKey.endsWith(':email') ? `email-${idempotencyKey.split(':').at(-2)}` : `sms-${idempotencyKey.split(':').at(-2)}`,
      metadata: { send_failed: true },
    }));
    BalanceReminder.sendLatePaymentEmail
      .mockResolvedValueOnce({ ok: false, reason: 'provider_unavailable' })
      .mockResolvedValueOnce(refusal)
      .mockResolvedValueOnce(refusal);

    const firstInsert = chain();
    if (!hasActivity) firstInsert.insert.mockRejectedValueOnce(new Error('activity write unavailable'));
    setDbQueues({
      invoices: invoiceReads(),
      activity_log: [chain({ first: null }), chain({ result: [] }), firstInsert],
      customers: [chain({ first: customer })],
      notification_prefs: [chain({ first: { billing_channels: ['email', 'sms'] } })],
    });
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 1 });
    const pending = JSON.parse(firstInsert.insert.mock.calls[0][0].metadata);
    expect(pending).toMatchObject({ pendingEmail: true, tierDays: 14, emailLedgerId: 'email-14' });

    jest.setSystemTime(new Date('2026-06-15T14:00:00.000Z'));
    const ledgerResolution = chain();
    const activityCompletion = chain();
    setDbQueues({
      invoices: invoiceReads(),
      activity_log: hasActivity
        ? [chain({ first: { id: 'activity-14', metadata: pending } }), activityCompletion]
        : [chain({ first: null }), chain({ result: [] })],
      collections_contact_ledger: [chain({ result: [
        { id: 'sms-14', channel: 'sms', idempotency_key: 'late_payment_checker:inv-1:14:sms', metadata: { delivered: true } },
        { id: 'email-14', channel: 'email', idempotency_key: 'late_payment_checker:inv-1:14:email', metadata: { send_failed: true } },
      ] }), ledgerResolution],
      customers: [chain({ first: customer })],
      notification_prefs: [chain({ first: { billing_channels: ['email', 'sms'] } })],
    });
    await LatePaymentChecker.checkAndNotify();
    expect(ledgerResolution.where).toHaveBeenCalledWith({ id: 'email-14' });
    expect(ledgerResolution.update).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ bindings: [JSON.stringify({ resolved: true, resolution: 'email_terminal_refusal' })] }),
    }));
    if (hasActivity) expect(activityCompletion.update).toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);

    const tier30Insert = chain();
    setDbQueues({
      invoices: invoiceReads(),
      activity_log: [chain({ first: null }), chain({ result: [] }), tier30Insert],
      collections_contact_ledger: [chain({ result: [] })],
      customers: [chain({ first: customer })],
      notification_prefs: [chain({ first: { billing_channels: ['email', 'sms'] } })],
    });
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
    expect(renderSmsTemplate.mock.calls.map(([key]) => key)).toEqual(['late_payment_14d', 'late_payment_30d']);
    const tier30 = JSON.parse(tier30Insert.insert.mock.calls[0][0].metadata);
    expect(tier30).toMatchObject({ tierDays: 30, invoiceKey: 'WPC-2026-1042|30 DAYS' });
    expect(tier30.pendingEmail).toBeUndefined();

    setDbQueues({
      invoices: [chain({ result: [invoice] }), chain({ first: { payer_id: null, scheduled_send_error: null } })],
      activity_log: [chain({ first: { id: 'activity-30', metadata: tier30 } })],
      collections_contact_ledger: [chain({ result: [] })],
      customers: [chain({ first: customer })],
      notification_prefs: [chain({ first: { billing_channels: ['email', 'sms'] } })],
    });
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 0, skipped: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
  });

  test('does not create a pending Email obligation when the first selected Email has no address', async () => {
    const invoice = {
      id: 'inv-1', customer_id: 'cust-1', token: 'token-1', invoice_number: 'WPC-2026-1042',
      status: 'sent', title: 'Quarterly Pest Control', total: '129.00', due_date: '2026-05-10',
      service_date: '2026-05-01', created_at: '2026-05-01T12:00:00.000Z',
    };
    BalanceReminder.sendLatePaymentEmail.mockResolvedValueOnce({ ok: false, skipped: true, reason: 'missing_email' });
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-14`, metadata: {} }));
    const activityInsert = chain();
    const ledgerResolution = chain();
    setDbQueues({
      invoices: [chain({ result: [invoice] }), ...Array(3).fill(null).map(() => chain({ first: { payer_id: null, scheduled_send_error: null } }))],
      activity_log: [chain({ first: null }), chain({ result: [] }), activityInsert],
      collections_contact_ledger: [chain({ result: [] }), ledgerResolution],
      customers: [chain({ first: { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' } })],
      notification_prefs: [chain({ first: { billing_channels: ['email', 'sms'] } })],
    });
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 1 });
    expect(JSON.parse(activityInsert.insert.mock.calls[0][0].metadata)).toMatchObject({ channel: 'sms', tierDays: 14 });
    expect(JSON.parse(activityInsert.insert.mock.calls[0][0].metadata).pendingEmail).toBeUndefined();
    expect(ledgerResolution.where).toHaveBeenCalledWith({ id: 'email-14' });
    expect(ContactLedger.markDelivered).toHaveBeenCalledWith(expect.objectContaining({ id: 'sms-14' }));
    expect(ContactLedger.markDelivered).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'email-14' }));
  });

  test('a failed ledger recovery read cannot open a new reminder tier', async () => {
    const invoice = { id: 'inv-1', customer_id: 'cust-1', token: 'token-1', status: 'sent',
      total: '129.00', due_date: '2026-04-10', created_at: '2026-04-01T12:00:00Z' };
    const failedRecovery = chain();
    failedRecovery.then = (_resolve, reject) => Promise.reject(new Error('ledger temporarily unavailable')).catch(reject);
    setDbQueues({
      invoices: [chain({ result: [invoice] }), chain({ first: { payer_id: null } })],
      customers: [chain({ first: { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' } })],
      notification_prefs: [chain({ first: { billing_channels: ['email', 'sms'] } })],
      collections_contact_ledger: [failedRecovery],
    });
    await LatePaymentChecker.checkAndNotify();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(BalanceReminder.sendLatePaymentEmail).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
  });

  test('preserves the legacy no-phone skip when no explicit billing array exists', async () => {
    const invoice = {
      id: 'inv-1', customer_id: 'cust-1', token: 'token-1', invoice_number: 'WPC-2026-1042',
      status: 'sent', title: 'Quarterly Pest Control', total: '129.00', due_date: '2026-05-10',
      service_date: '2026-05-01', created_at: '2026-05-01T12:00:00.000Z',
    };
    setDbQueues({
      invoices: [chain({ result: [invoice] }), chain({ first: { payer_id: null, scheduled_send_error: null } })],
      activity_log: [chain({ first: null })],
      customers: [chain({ first: { id: 'cust-1', first_name: 'Taylor', phone: null } })],
      notification_prefs: [chain({ first: {} })],
    });

    const result = await LatePaymentChecker.checkAndNotify();

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(BalanceReminder.sendLatePaymentEmail).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  test('treats a CONSENT_LOOKUP_FAILED block as transient — defers without emailing or burning the tier', async () => {
    const invoice = {
      id: 'inv-1',
      customer_id: 'cust-1',
      token: 'token-1',
      invoice_number: 'WPC-2026-1042',
      status: 'sent',
      title: 'Quarterly Pest Control',
      total: '129.00',
      due_date: '2026-05-10',
      service_date: '2026-05-01',
      created_at: '2026-05-01T12:00:00.000Z',
    };
    const customer = { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' };

    // Transient consent-prefs DB blip — no retryable/deferred flag, only the code.
    sendCustomerMessage.mockResolvedValueOnce({
      sent: false, blocked: true, code: 'CONSENT_LOOKUP_FAILED',
    });

    setDbQueues({
      // The batch query, then the ownership re-reads: before the dunning
      // guards, on the last read before the provider, and the email leg's
      // own check (a Bill-To change can land in any of those windows).
      invoices: [
        chain({ result: [invoice] }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
      ],
      activity_log: [chain({ first: null })],
      customers: [chain({ first: customer })],
    });

    const result = await LatePaymentChecker.checkAndNotify();

    expect(BalanceReminder.sendLatePaymentEmail).not.toHaveBeenCalled();
    expect(result.notified).toBe(0);
    expect(result.emailedFallback).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('does not send a late-payment reminder when the per-invoice follow-up sequence was stopped by an admin', async () => {
    const invoice = {
      id: 'inv-1',
      customer_id: 'cust-1',
      token: 'token-1',
      invoice_number: 'WPC-2026-1042',
      status: 'sent',
      title: 'Quarterly Pest Control',
      total: '129.00',
      due_date: '2026-05-10',
      service_date: '2026-05-01',
      created_at: '2026-05-01T12:00:00.000Z',
    };

    // Admin clicked "stop" on the AUTOMATED FOLLOW-UPS card — dunning is off for this invoice.
    InvoiceFollowUps.hasActiveSequence.mockResolvedValueOnce(false);
    InvoiceFollowUps.isDunningStopped.mockResolvedValueOnce(true);

    setDbQueues({
      // The batch query, then the ownership re-reads: before the dunning
      // guards, on the last read before the provider, and the email leg's
      // own check (a Bill-To change can land in any of those windows).
      invoices: [
        chain({ result: [invoice] }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
      ],
    });

    await LatePaymentChecker.checkAndNotify();

    expect(renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(BalanceReminder.sendLatePaymentEmail).not.toHaveBeenCalled();
  });
});
