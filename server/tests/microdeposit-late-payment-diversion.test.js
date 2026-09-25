// late-payment-checker: a micro-deposit-blocked invoice gets a verification
// re-nudge instead of the misleading "X days overdue" dunning.
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
  markDelivered: jest.fn(async () => true),
  markSendFailed: jest.fn(async () => true),
  claimAttempt: jest.fn(async () => ({ allowed: true })),
}));

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false })),
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
jest.mock('../services/stripe', () => ({
  isInvoiceAwaitingMicrodepositVerification: jest.fn(async () => false),
}));
jest.mock('../services/microdeposit-verification-email', () => ({
  sendMicrodepositVerificationEmail: jest.fn(async () => ({ ok: true })),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const BalanceReminder = require('../services/workflows/balance-reminder');
const StripeService = require('../services/stripe');
const { sendMicrodepositVerificationEmail } = require('../services/microdeposit-verification-email');
const ContactLedger = require('../services/collections/contact-ledger');
const LatePaymentChecker = require('../services/late-payment-checker');

function chain({ result = [], first } = {}) {
  const q = {};
  q.where = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q); return q; });
  q.whereIn = jest.fn(() => q);
  q.whereNull = jest.fn(() => q);
  q.whereNot = jest.fn(() => q);
  q.orWhereNot = jest.fn(() => q);
  q.orWhereNull = jest.fn(() => q);
  q.whereRaw = jest.fn(() => q);
  q.orderBy = jest.fn(() => q);
  q.andWhere = jest.fn(() => q);
  q.orWhere = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q); return q; });
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
      if (table === 'notification_prefs') return chain({ first: undefined });
      if (table === 'collections_contact_ledger') return chain({ result: [] });
      throw new Error(`Unexpected db table ${table}`);
    }
    return queue.shift();
  });
}

const invoice = {
  id: 'inv-1',
  customer_id: 'cust-1',
  token: 'token-1',
  invoice_number: 'WPC-2026-1042',
  status: 'viewed',
  title: 'Quarterly Pest Control',
  total: '129.00',
  due_date: '2026-05-10',
  service_date: '2026-05-01',
  created_at: '2026-05-01T12:00:00.000Z',
  stripe_payment_intent_id: 'pi_microdeposit',
};
const customer = { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' };

describe('late-payment micro-deposit diversion', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-26T14:00:00.000Z'));
    jest.clearAllMocks();
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(false);
    ContactLedger.recordContact.mockReset().mockResolvedValue({ id: 'led-1', metadata: {} });
    ContactLedger.claimAttempt.mockReset().mockResolvedValue({ allowed: true });
  });
  afterEach(() => jest.useRealTimers());

  test('sends the verification re-nudge (not the overdue dunning) for a micro-deposit-blocked invoice', async () => {
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(true);
    setDbQueues({
      invoices: [
        chain({ result: [invoice] }),
        // the pre-guard ownership re-read, the last one before dispatch, and
        // the email leg's own check
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
      ],
      activity_log: [chain({ first: null }), chain()], // dedupe miss, then the reminder log insert
      customers: [chain({ first: customer })],
    });

    const result = await LatePaymentChecker.checkAndNotify();

    expect(StripeService.isInvoiceAwaitingMicrodepositVerification).toHaveBeenCalled();
    // Verification copy, NOT a late_payment_* template.
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'bank_verification_incomplete',
      expect.objectContaining({ first_name: 'Taylor' }),
      expect.objectContaining({ workflow: 'microdeposit_verification_reminder' }),
    );
    expect(renderSmsTemplate).not.toHaveBeenCalledWith(expect.stringMatching(/^late_payment_/), expect.anything(), expect.anything());
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550101',
      body: 'sms body for bank_verification_incomplete',
      entryPoint: 'late_payment_checker_microdeposit',
    }));
    // Branded verification EMAIL sidecar fires (keyed to the tier), and the
    // generic "overdue" email never does.
    expect(sendMicrodepositVerificationEmail).toHaveBeenCalledWith(expect.objectContaining({
      invoice: expect.objectContaining({ id: 'inv-1' }),
      touchKey: '14d',
    }));
    expect(BalanceReminder.sendLatePaymentEmail).not.toHaveBeenCalled();
    expect(result.notified).toBe(1);
  });

  test('falls through to normal dunning when the invoice has a PI but is NOT micro-deposit-blocked', async () => {
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(false);
    setDbQueues({
      invoices: [
        chain({ result: [invoice] }),
        // the pre-guard ownership re-read, the last one before dispatch, and
        // the email leg's own check
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
      ],
      activity_log: [chain({ first: null }), chain()],
      customers: [chain({ first: customer })],
    });

    await LatePaymentChecker.checkAndNotify();

    // Generic late-payment dunning, not the verification copy.
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      expect.stringMatching(/^late_payment_/),
      expect.anything(),
      expect.objectContaining({ workflow: 'late_payment_reminder' }),
    );
    expect(renderSmsTemplate).not.toHaveBeenCalledWith('bank_verification_incomplete', expect.anything(), expect.anything());
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ entryPoint: 'late_payment_checker' }));
  });

  test('preserves the legacy no-phone skip for a micro-deposit reminder', async () => {
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(true);
    setDbQueues({
      invoices: [chain({ result: [invoice] }), chain({ first: { payer_id: null, scheduled_send_error: null } })],
      activity_log: [chain({ first: null })],
      customers: [chain({ first: { ...customer, phone: null } })],
      notification_prefs: [chain({ first: {} })],
    });

    const result = await LatePaymentChecker.checkAndNotify();

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(sendMicrodepositVerificationEmail).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  test('retries only the pending verification Email after accepted Text', async () => {
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(true);
    sendMicrodepositVerificationEmail
      .mockResolvedValueOnce({ ok: false, skipped: true, reason: 'template_unavailable', deliveryOutcome: 'uncertain' })
      .mockResolvedValueOnce({ ok: true });
    const activityInsert = chain();
    setDbQueues({
      invoices: [chain({ result: [invoice] }), chain({ first: { payer_id: null, scheduled_send_error: null } })],
      activity_log: [chain({ first: null }), activityInsert],
      customers: [chain({ first: customer })],
      notification_prefs: [chain({ first: { payment_issue_channels: ['email', 'sms'] } })],
    });
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 1 });
    const pending = JSON.parse(activityInsert.insert.mock.calls[0][0].metadata);
    expect(pending).toMatchObject({ pendingEmail: true, channel: 'sms', tierDays: 14 });

    jest.setSystemTime(new Date('2026-06-15T14:00:00.000Z'));
    const completion = chain();
    setDbQueues({
      invoices: [chain({ result: [invoice] }), chain({ first: { payer_id: null, scheduled_send_error: null } })],
      activity_log: [chain({ first: { id: 'activity-1', metadata: pending } }), completion],
      customers: [chain({ first: customer })],
      notification_prefs: [chain({ first: { payment_issue_channels: ['email', 'sms'] } })],
    });
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(renderSmsTemplate).toHaveBeenCalledTimes(1);
    expect(sendMicrodepositVerificationEmail).toHaveBeenLastCalledWith(
      expect.objectContaining({ touchKey: '14d' }),
    );
    expect(completion.update).toHaveBeenCalled();
  });

  test('a failed verification ledger read holds the reminder instead of opening a new tier', async () => {
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(true);
    const failedRecovery = chain();
    failedRecovery.then = (_resolve, reject) => Promise.reject(new Error('ledger temporarily unavailable')).catch(reject);
    setDbQueues({
      invoices: [chain({ result: [invoice] }), chain({ first: { payer_id: null, scheduled_send_error: null } })],
      customers: [chain({ first: customer })],
      notification_prefs: [chain({ first: { payment_issue_channels: ['email', 'sms'] } })],
      collections_contact_ledger: [failedRecovery],
    });
    await LatePaymentChecker.checkAndNotify();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(sendMicrodepositVerificationEmail).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
  });

  test('recovers a failed 14-day verification Email from ledger at 30 days without repeating Text', async () => {
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(true);
    sendMicrodepositVerificationEmail
      .mockResolvedValueOnce({ ok: false, reason: 'provider_unavailable' })
      .mockResolvedValueOnce({ ok: true });
    const failedInsert = chain();
    failedInsert.insert.mockRejectedValueOnce(new Error('activity write unavailable'));
    setDbQueues({
      invoices: [chain({ result: [invoice] }), chain({ first: { payer_id: null, scheduled_send_error: null } })],
      activity_log: [chain({ first: null }), failedInsert],
      customers: [chain({ first: customer })],
      notification_prefs: [chain({ first: { payment_issue_channels: ['email', 'sms'] } })],
    });
    await LatePaymentChecker.checkAndNotify();

    jest.setSystemTime(new Date('2026-06-15T14:00:00.000Z'));
    ContactLedger.recordContact.mockResolvedValueOnce({
      id: 'email-14', reused: true, metadata: { send_failed: true },
    });
    setDbQueues({
      invoices: [chain({ result: [invoice] }), chain({ first: { payer_id: null, scheduled_send_error: null } })],
      activity_log: [chain({ first: null })],
      collections_contact_ledger: [chain({ result: [
        { id: 'sms-14', channel: 'sms', idempotency_key: 'late_payment_checker:microdeposit:inv-1:14:sms', metadata: { delivered: true } },
        { id: 'email-14', channel: 'email', idempotency_key: 'late_payment_checker:microdeposit:inv-1:14:email', metadata: { send_failed: true } },
      ] })],
      customers: [chain({ first: customer })],
      notification_prefs: [chain({ first: { payment_issue_channels: ['email', 'sms'] } })],
    });
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(renderSmsTemplate).toHaveBeenCalledTimes(1);
    expect(sendMicrodepositVerificationEmail).toHaveBeenLastCalledWith(
      expect.objectContaining({ touchKey: '14d' }),
    );
    expect(ContactLedger.recordContact).toHaveBeenLastCalledWith(expect.objectContaining({
      channel: 'email', idempotencyKey: 'late_payment_checker:microdeposit:inv-1:14:email',
    }));
  });

  test.each([
    ['missing address', { ok: false, skipped: true, reason: 'missing_email' }],
    ['unavailable template', { ok: false, skipped: true, reason: 'template_unavailable' }],
  ])('resolves a verification Email with %s and advances Text from day 14 to day 30 once', async (_label, refusal) => {
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(true);
    ContactLedger.recordContact.mockImplementation(async ({ idempotencyKey }) => ({
      id: idempotencyKey.endsWith(':email') ? `email-${idempotencyKey.split(':').at(-2)}` : `sms-${idempotencyKey.split(':').at(-2)}`,
      metadata: { send_failed: true },
    }));
    sendMicrodepositVerificationEmail
      .mockResolvedValueOnce({ ok: false, reason: 'provider_unavailable' })
      .mockResolvedValueOnce(refusal)
      .mockResolvedValueOnce(refusal);
    const invoiceReads = () => [chain({ result: [invoice] }), chain({ first: { payer_id: null, scheduled_send_error: null } })];
    const prefs = () => [chain({ first: { payment_issue_channels: ['email', 'sms'] } })];
    const firstInsert = chain();
    setDbQueues({
      invoices: invoiceReads(), activity_log: [chain({ first: null }), firstInsert],
      customers: [chain({ first: customer })], notification_prefs: prefs(),
    });
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 1 });
    const pending = JSON.parse(firstInsert.insert.mock.calls[0][0].metadata);
    expect(pending).toMatchObject({ pendingEmail: true, tierDays: 14, emailLedgerId: 'email-14' });

    jest.setSystemTime(new Date('2026-06-15T14:00:00.000Z'));
    const ledgerResolution = chain();
    const activityCompletion = chain();
    setDbQueues({
      invoices: invoiceReads(),
      activity_log: [chain({ first: { id: 'activity-14', metadata: pending } }), activityCompletion],
      collections_contact_ledger: [chain({ result: [
        { id: 'sms-14', channel: 'sms', idempotency_key: 'late_payment_checker:microdeposit:inv-1:14:sms', metadata: { delivered: true } },
        { id: 'email-14', channel: 'email', idempotency_key: 'late_payment_checker:microdeposit:inv-1:14:email', metadata: { send_failed: true } },
      ] }), ledgerResolution],
      customers: [chain({ first: customer })], notification_prefs: prefs(),
    });
    await LatePaymentChecker.checkAndNotify();
    expect(ledgerResolution.where).toHaveBeenCalledWith({ id: 'email-14' });
    expect(ledgerResolution.update).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ bindings: [JSON.stringify({ resolved: true, resolution: 'email_terminal_refusal' })] }),
    }));
    expect(activityCompletion.update).toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);

    const tier30Insert = chain();
    setDbQueues({
      invoices: invoiceReads(), activity_log: [chain({ first: null }), tier30Insert],
      collections_contact_ledger: [chain({ result: [] })],
      customers: [chain({ first: customer })], notification_prefs: prefs(),
    });
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
    expect(sendMicrodepositVerificationEmail.mock.calls.map(([args]) => args.touchKey)).toEqual(['14d', '14d', '30d']);
    const tier30 = JSON.parse(tier30Insert.insert.mock.calls[0][0].metadata);
    expect(tier30).toMatchObject({ tierDays: 30, dedupeKey: 'WPC-2026-1042|30 DAYS|microdeposit' });
    expect(tier30.pendingEmail).toBeUndefined();

    setDbQueues({
      invoices: invoiceReads(), activity_log: [chain({ first: { id: 'activity-30', metadata: tier30 } })],
      collections_contact_ledger: [chain({ result: [] })],
      customers: [chain({ first: customer })], notification_prefs: prefs(),
    });
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 0, skipped: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
  });

  test('does not hold the first verification Text when its selected Email is suppressed', async () => {
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(true);
    sendMicrodepositVerificationEmail.mockResolvedValueOnce({
      ok: false, blocked: true, reason: 'Suppressed: bounce',
    });
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-14`, metadata: {} }));
    const activityInsert = chain();
    const ledgerResolution = chain();
    setDbQueues({
      invoices: [chain({ result: [invoice] }), chain({ first: { payer_id: null, scheduled_send_error: null } })],
      activity_log: [chain({ first: null }), activityInsert],
      collections_contact_ledger: [chain({ result: [] }), ledgerResolution],
      customers: [chain({ first: customer })],
      notification_prefs: [chain({ first: { payment_issue_channels: ['email', 'sms'] } })],
    });
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 1 });
    const activity = JSON.parse(activityInsert.insert.mock.calls[0][0].metadata);
    expect(activity).toMatchObject({ tierDays: 14 });
    expect(activity.pendingEmail).toBeUndefined();
    expect(ledgerResolution.where).toHaveBeenCalledWith({ id: 'email-14' });
    expect(ContactLedger.markDelivered).toHaveBeenCalledWith(expect.objectContaining({ id: 'sms-14' }));
    expect(ContactLedger.markDelivered).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'email-14' }));
  });
});
