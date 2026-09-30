/**
 * Collections policy wiring on the two SMS dunning rails (PR A, hardened by
 * the 2026-08-14 codex round).
 *
 * Pins:
 *   - GATE_COLLECTIONS_POLICY unset/off ⇒ the policy module is never
 *     consulted. Exact send arguments preserve legacy content and include
 *     the billing category/event and Email-owner routing metadata.
 *   - Gate on ⇒ each channel is evaluated INDEPENDENTLY at its leg (sms
 *     denied must not silence the email leg and vice versa), and the target
 *     invoice must be IN the verdict's eligible set (an allowed verdict
 *     about a sibling invoice is not permission).
 *   - RECORD-THEN-SEND: the ledger row precedes every delivery attempt; a
 *     ledger insert failure means NO send is attempted; a failed delivery
 *     stamps the standing row via markSendFailed.
 */

// The dispute-hold read is not what this suite exercises (its db is a queue of
// canned chains): no active hold. The hold behavior has its own suites.
jest.mock('../services/collections/collection-hold', () => ({
  ...jest.requireActual('../services/collections/collection-hold'),
  dueInvoiceHeldByDisputeHold: jest.fn(async () => ({ held: false })),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
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
jest.mock('../services/workflows/balance-reminder', () => ({
  sendLatePaymentEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => 'invoice follow-up sms'),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({
    sent: true,
    message: { provider_message_id: 'sg-1', sent_at: '2026-05-26T14:00:00.000Z' },
  })),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(() => [{ email: 'billing@example.com', name: 'Taylor' }]),
}));
// The follow-up email rides the shared billing email authority (owner ruling
// 2026-09-27); its locks and rechecks are pinned in its own suites. Here it
// authorizes the same billing recipient the customer-contact mock returns.
jest.mock('../services/billing-channel-email-authority', () => ({
  loadBillingEmailContext: jest.fn(async () => ({
    category: 'invoice',
    recipient: { email: 'billing@example.com', name: 'Taylor' },
    recipientEmail: 'billing@example.com',
  })),
  dispatchUnderBillingEmailAuthority: jest.fn(async ({ dispatch, state }) => {
    state.handoffStarted = true;
    await dispatch();
    state.providerAccepted = true;
    return { ok: true };
  }),
}));
jest.mock('../services/stripe', () => ({ isInvoiceAwaitingMicrodepositVerification: jest.fn(async () => false) }));
jest.mock('../services/microdeposit-verification-email', () => ({ sendMicrodepositVerificationEmail: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/collections/contact-policy', () => ({
  evaluate: jest.fn(async () => ({ allowed: true, denialReasons: [], eligibleInvoiceIds: ['inv-1'] })),
}));
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  claimAttempt: jest.fn(async () => ({ allowed: true })),
  markSendFailed: jest.fn(async () => true),
  markDelivered: jest.fn(async () => true),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const BalanceReminder = require('../services/workflows/balance-reminder');
const EmailTemplates = require('../services/email-template-library');
const smsTemplates = require('../routes/admin-sms-templates');
const ContactPolicy = require('../services/collections/contact-policy');
const ContactLedger = require('../services/collections/contact-ledger');
const StripeService = require('../services/stripe');
const { sendMicrodepositVerificationEmail } = require('../services/microdeposit-verification-email');
const LatePaymentChecker = require('../services/late-payment-checker');
// Deliberately NOT mocked: the late-payment rail consults the REAL
// invoice-followups hasActiveSequence/isDunningStopped (served by the
// invoice_followup_sequences queues below), and the followups rail under
// test IS this module.
const InvoiceFollowUps = require('../services/invoice-followups');

function chain({ result = [], first, returning } = {}) {
  const q = {};
  ['join', 'where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw',
    'select', 'orderBy', 'forUpdate', 'limit', 'andWhere',
    // the withdrawal-stamp exclusion (a payer-billed combined-visit invoice
    // keeps payer_id NULL) builds its clause from these
    'whereNot', 'orWhereNot', 'orWhereNull',
  ].forEach((m) => { q[m] = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q); return q; }); });
  q.orWhere = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q); return q; });
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
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
      if (table === 'notification_prefs') return chain({ first: undefined });
      throw new Error(`Unexpected db table ${table}`);
    }
    return queue.shift();
  });
}

const ALLOWED = { allowed: true, denialReasons: [], eligibleInvoiceIds: ['inv-1'] };
const DENIED = { allowed: false, denialReasons: ['flag_do_not_collect'], eligibleInvoiceIds: [] }; // durable (flag_)
// A spacing window lifts on its own: the only kind of denial the held retime covers.
const TRANSIENT_DENIED = { allowed: false, denialReasons: ['spacing_window'], eligibleInvoiceIds: [] };

const savedGate = process.env.GATE_COLLECTIONS_POLICY;
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_COLLECTIONS_POLICY;
  else process.env.GATE_COLLECTIONS_POLICY = savedGate;
});

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-05-26T14:00:00.000Z')); // Tue
  jest.clearAllMocks();
  delete process.env.GATE_COLLECTIONS_POLICY;
  db.transaction = jest.fn(async (fn) => fn(db));
  // The email hand-off takes the customer-comms advisory lock (trx.raw).
  db.raw = jest.fn(async () => ({ rows: [] }));
  db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  // clearAllMocks keeps per-test mockResolvedValue overrides — re-pin defaults.
  sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, deliveryOutcome: 'accepted' });
  BalanceReminder.sendLatePaymentEmail.mockResolvedValue({ ok: true });
  EmailTemplates.sendTemplate.mockResolvedValue({
    sent: true,
    message: { provider_message_id: 'sg-1', sent_at: '2026-05-26T14:00:00.000Z' },
  });
  smsTemplates.getTemplate.mockResolvedValue('invoice follow-up sms');
  ContactPolicy.evaluate.mockResolvedValue(ALLOWED);
  ContactLedger.recordContact.mockResolvedValue({ id: 'led-1', metadata: {} });
  ContactLedger.claimAttempt.mockResolvedValue({ allowed: true });
  ContactLedger.markSendFailed.mockResolvedValue(true);
  StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(false);
});

afterEach(() => jest.useRealTimers());

// ─── late-payment-checker rail ─────────────────────────────────────────────

const LP_INVOICE = {
  id: 'inv-1',
  customer_id: 'cust-1',
  token: 'token-1',
  invoice_number: 'WPC-2026-1042',
  status: 'sent',
  title: 'Quarterly Pest Control',
  total: '129.00',
  due_date: '2026-05-10', // 16 days overdue → tier 14
  service_date: '2026-05-01',
  created_at: '2026-05-01T12:00:00.000Z',
};
const LP_CUSTOMER = { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' };

// Exact legacy delivery content plus billing routing metadata, independent
// of whether the collections policy gate is enabled.
const LP_EXPECTED_SEND = {
  to: '+19415550101',
  body: 'sms body for late_payment_14d',
  channel: 'sms',
  audience: 'customer',
  purpose: 'payment_link',
  customerId: 'cust-1',
  invoiceId: 'inv-1',
  entryPoint: 'late_payment_checker',
  metadata: { original_message_type: 'late_payment', billingDeliveryCategory: 'billing',
    notificationEventKey: 'late-payment:inv-1:14', collections_ledger_id: 'led-1' },
  hasEmailLeg: true,
  // The last ownership check, run by the canonical sender immediately before
  // provider preparation — a Bill-To change during the render/ledger awaits
  // must not reach the homeowner.
  preDispatchCheck: expect.any(Function),
};

function armLatePaymentHappyPath(prefs = undefined, selectedCustomer = LP_CUSTOMER, episodeRows = null) {
  setDbQueues({
    invoices: [
      chain({ result: [LP_INVOICE] }),
      // the pre-guard ownership re-read, the last one before dispatch, and
      // the email leg's own check (its handoff is later still)
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
    ],
    activity_log: [chain({ first: null }), chain()],
    customers: [chain({ first: selectedCustomer })],
    ...(prefs ? { notification_prefs: [chain({ first: prefs })] } : {}),
    ...(episodeRows ? { collections_contact_ledger: [chain({ result: [] }), chain({ result: episodeRows })] } : {}),
    invoice_followup_sequences: [chain({ first: undefined }), chain({ first: undefined })],
  });
}

describe('late-payment-checker rail', () => {
  test('App-only selection consults push policy and sends despite do_not_text and no phone', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockImplementation(async (_customerId, { channel }) => channel === 'sms'
      ? { allowed: false, denialReasons: ['flag_do_not_text'], eligibleInvoiceIds: ['inv-1'] }
      : ALLOWED);
    armLatePaymentHappyPath({ billing_channels: ['push'] }, { ...LP_CUSTOMER, phone: null });

    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 1 });
    expect(ContactPolicy.evaluate.mock.calls.map(([, args]) => args.channel)).toEqual(['push']);
    expect(ContactLedger.recordContact).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'push', idempotencyKey: 'late_payment_checker:inv-1:14:push',
    }));
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0]).toMatchObject({
      to: null, channel: 'push', metadata: {
        billingDeliveryLeg: 'push', billingDeliveryCategory: 'billing', appOnly: true,
      },
    });
  });

  test('a global collections hold still suppresses an App-only reminder', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue(DENIED);
    armLatePaymentHappyPath({ billing_channels: ['push'] }, { ...LP_CUSTOMER, phone: null });

    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 0, skipped: 1 });
    expect(ContactPolicy.evaluate.mock.calls.map(([, args]) => args.channel)).toEqual(['push']);
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('App and Text selection sends only policy-permitted App when do_not_text denies Text', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockImplementation(async (_customerId, { channel }) => channel === 'sms'
      ? { allowed: false, denialReasons: ['flag_do_not_text'], eligibleInvoiceIds: ['inv-1'] }
      : ALLOWED);
    armLatePaymentHappyPath({ billing_channels: ['push', 'sms'] });

    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 1 });
    expect(ContactPolicy.evaluate.mock.calls.map(([, args]) => args.channel)).toEqual(['push', 'sms']);
    expect(ContactLedger.recordContact.mock.calls.map(([args]) => args.channel)).toEqual(['push']);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].metadata.billingDeliveryLeg).toBe('push');
  });

  test('permitted App and Text reserve separate ledgers and dispatch each selected leg once', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockImplementation(async (_customerId, { channel }) => channel === 'email'
      ? { allowed: false, denialReasons: ['flag_do_not_email'], eligibleInvoiceIds: ['inv-1'] }
      : ALLOWED);
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-14`, metadata: {} }));
    armLatePaymentHappyPath({ billing_channels: ['push', 'sms'] });

    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 1 });
    expect(ContactLedger.recordContact.mock.calls.map(([args]) => args.channel)).toEqual(['push', 'sms']);
    expect(sendCustomerMessage.mock.calls.map(([args]) => args.metadata.billingDeliveryLeg)).toEqual(['push', 'sms']);
    expect(sendCustomerMessage.mock.calls.map(([args]) => args.channel)).toEqual(['push', 'sms']);
    expect(ContactLedger.markDelivered.mock.calls.map(([ledger]) => ledger.id)).toEqual(['push-14', 'sms-14']);
  });

  test('a retryable Text sibling reuses accepted App ledger without repeating App', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockImplementation(async (_customerId, { channel }) => channel === 'email'
      ? { allowed: false, denialReasons: ['flag_do_not_email'], eligibleInvoiceIds: ['inv-1'] }
      : ALLOWED);
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-14`, metadata: {} }));
    let appClaimCount = 0;
    ContactLedger.claimAttempt.mockImplementation(async (ledger) => ledger.id === 'push-14' && appClaimCount++ > 0
      ? { allowed: false, delivered: true } : { allowed: true });
    sendCustomerMessage
      .mockResolvedValueOnce({ sent: true, deliveryOutcome: 'accepted' })
      .mockResolvedValueOnce({ sent: false, deliveryOutcome: 'not_sent', retryable: true, deferred: true, code: 'PROVIDER_FAILURE' })
      .mockResolvedValueOnce({ sent: true, deliveryOutcome: 'accepted' });

    armLatePaymentHappyPath({ billing_channels: ['push', 'sms'] });
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 0, skipped: 1 });
    expect(sendCustomerMessage.mock.calls.map(([args]) => args.metadata.billingDeliveryLeg)).toEqual(['push', 'sms']);

    armLatePaymentHappyPath({ billing_channels: ['push', 'sms'] }, LP_CUSTOMER, [
      { id: 'push-14', idempotency_key: 'late_payment_checker:inv-1:14:push' },
      { id: 'sms-14', idempotency_key: 'late_payment_checker:inv-1:14:sms' },
      { id: 'other-invoice', idempotency_key: 'late_payment_checker:inv-2:14:sms' },
    ]);
    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 1 });
    expect(sendCustomerMessage.mock.calls.map(([args]) => args.metadata.billingDeliveryLeg)).toEqual(['push', 'sms', 'sms']);
    expect(ContactLedger.claimAttempt.mock.calls.filter(([ledger]) => ledger.id === 'push-14')).toHaveLength(2);
    expect(ContactPolicy.evaluate).toHaveBeenLastCalledWith('cust-1', expect.objectContaining({
      channel: 'sms', excludeLedgerIds: ['push-14', 'sms-14'],
    }));
  });

  test('a prior Text remains a spacing hold after preferences switch to App-only', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockImplementation(async (_customerId, { excludeLedgerIds }) =>
      excludeLedgerIds.includes('sms-14') ? ALLOWED
        : { allowed: false, denialReasons: ['contact_within_24h'], eligibleInvoiceIds: ['inv-1'] });
    armLatePaymentHappyPath({ billing_channels: ['push'] }, LP_CUSTOMER, [
      { id: 'sms-14', idempotency_key: 'late_payment_checker:inv-1:14:sms' },
    ]);

    expect(await LatePaymentChecker.checkAndNotify()).toMatchObject({ notified: 0, skipped: 1 });
    expect(ContactPolicy.evaluate).toHaveBeenCalledWith('cust-1', expect.objectContaining({
      channel: 'push', excludeLedgerIds: [],
    }));
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each([
    ['a durable do-not-email flag waives the selected Email', 'flag_do_not_email', false],
    ['a spacing window keeps the selected Email owed', 'contact_within_24h', true],
  ])('%s after Text delivers', async (_label, reason, stillPending) => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockImplementation(async (_customerId, { channel }) => channel === 'email'
      ? { allowed: false, denialReasons: [reason], eligibleInvoiceIds: ['inv-1'] }
      : ALLOWED);
    const activityInsert = chain();
    setDbQueues({
      invoices: [
        chain({ result: [LP_INVOICE] }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
        chain({ first: { payer_id: null, scheduled_send_error: null } }),
      ],
      activity_log: [chain({ first: null }), chain(), activityInsert],
      customers: [chain({ first: LP_CUSTOMER })],
      notification_prefs: [chain({ first: { billing_channels: ['email', 'sms'] } })],
      invoice_followup_sequences: [chain({ first: undefined }), chain({ first: undefined })],
    });

    await LatePaymentChecker.checkAndNotify();

    expect(BalanceReminder.sendLatePaymentEmail).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    const inserted = JSON.parse(activityInsert.insert.mock.calls[0][0].metadata);
    expect(inserted.pendingEmail === true).toBe(stillPending);
  });

  test('gate UNSET: policy never consulted, legacy content and billing routing metadata are preserved', async () => {
    armLatePaymentHappyPath();
    const result = await LatePaymentChecker.checkAndNotify();
    expect(ContactPolicy.evaluate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0]).toEqual(LP_EXPECTED_SEND);
    expect(result.notified).toBe(1);
  });

  test("gate 'false': still never consulted", async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'false';
    armLatePaymentHappyPath();
    await LatePaymentChecker.checkAndNotify();
    expect(ContactPolicy.evaluate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test("gate 'true' + both channels denied: nothing sent, nothing ledgered, invoice skipped without burning the tier", async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue(DENIED);
    setDbQueues({
      invoices: [
      chain({ result: [LP_INVOICE] }),
      // the pre-guard ownership re-read, the last one before dispatch, and
      // the email leg's own check (its handoff is later still)
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
    ],
      activity_log: [chain({ first: null })],
      customers: [chain({ first: LP_CUSTOMER })],
      invoice_followup_sequences: [chain({ first: undefined }), chain({ first: undefined })],
    });
    const result = await LatePaymentChecker.checkAndNotify();
    expect(ContactPolicy.evaluate).toHaveBeenCalledWith('cust-1', expect.objectContaining({
      channel: 'sms', purpose: 'late_payment', now: expect.any(Date),
    }));
    expect(ContactPolicy.evaluate).toHaveBeenCalledWith('cust-1', expect.objectContaining({
      channel: 'email', purpose: 'late_payment', now: expect.any(Date),
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(BalanceReminder.sendLatePaymentEmail).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
    expect(result).toMatchObject({ notified: 0, skipped: 1 });
  });

  test("gate 'true' + allowed: the send is unchanged from the gate-off shape", async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    armLatePaymentHappyPath();
    await LatePaymentChecker.checkAndNotify();
    expect(sendCustomerMessage.mock.calls[0][0]).toEqual(LP_EXPECTED_SEND);
  });

  test('CHANNEL INDEPENDENCE: sms denied but email allowed ⇒ no text, email fallback still delivers', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockImplementation(async (cid, { channel }) => (
      channel === 'email' ? ALLOWED : { allowed: false, denialReasons: ['flag_do_not_text'], eligibleInvoiceIds: ['inv-1'] }
    ));
    armLatePaymentHappyPath();
    const result = await LatePaymentChecker.checkAndNotify();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(BalanceReminder.sendLatePaymentEmail).toHaveBeenCalledTimes(1);
    expect(result.emailedFallback).toBe(1);
    // Only the delivered channel is ledgered — the policy-denied sms leg
    // never reached the record-then-send step.
    expect(ContactLedger.recordContact).toHaveBeenCalledTimes(1);
    expect(ContactLedger.recordContact).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email' }));
  });

  test('INVOICE MEMBERSHIP: an allowed verdict about a DIFFERENT invoice is not permission for this one', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    // Two-invoice account: the target inv-1 was payer-dropped from the
    // eligible set; sibling inv-2 is the one the verdict allows.
    ContactPolicy.evaluate.mockResolvedValue({ allowed: true, denialReasons: [], eligibleInvoiceIds: ['inv-2'] });
    setDbQueues({
      invoices: [
      chain({ result: [LP_INVOICE] }),
      // the pre-guard ownership re-read, the last one before dispatch, and
      // the email leg's own check (its handoff is later still)
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
    ],
      activity_log: [chain({ first: null })],
      customers: [chain({ first: LP_CUSTOMER })],
      invoice_followup_sequences: [chain({ first: undefined }), chain({ first: undefined })],
    });
    const result = await LatePaymentChecker.checkAndNotify();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(BalanceReminder.sendLatePaymentEmail).not.toHaveBeenCalled();
    expect(result).toMatchObject({ notified: 0, skipped: 1 });
  });

  test('RECORD-THEN-SEND: the sms ledger row is written BEFORE the send, and the email row before the sidecar', async () => {
    armLatePaymentHappyPath();
    await LatePaymentChecker.checkAndNotify();
    expect(ContactLedger.recordContact).toHaveBeenCalledTimes(2);
    expect(ContactLedger.recordContact.mock.calls[0][0]).toEqual({
      customerId: 'cust-1',
      channel: 'sms',
      purpose: 'late_payment',
      invoiceIds: ['inv-1'],
      source: 'late_payment_checker',
      metadata: { tier_days: 14, days_overdue: 16 },
      idempotencyKey: 'late_payment_checker:inv-1:14:sms',
    });
    expect(ContactLedger.recordContact.mock.calls[1][0]).toEqual(expect.objectContaining({
      channel: 'email', purpose: 'late_payment', invoiceIds: ['inv-1'],
    }));
    // Strict ordering: sms record < sms send < email record < email send.
    const smsRecordAt = ContactLedger.recordContact.mock.invocationCallOrder[0];
    const smsSendAt = sendCustomerMessage.mock.invocationCallOrder[0];
    const emailRecordAt = ContactLedger.recordContact.mock.invocationCallOrder[1];
    const emailSendAt = BalanceReminder.sendLatePaymentEmail.mock.invocationCallOrder[0];
    expect(smsRecordAt).toBeLessThan(smsSendAt);
    expect(emailRecordAt).toBeLessThan(emailSendAt);
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalled();
  });

  test('LEDGER FAILURE ⇒ NO SEND: an unledgerable contact is never attempted (and retries next run — no dedupe row)', async () => {
    ContactLedger.recordContact.mockRejectedValue(new Error('ledger down'));
    setDbQueues({
      invoices: [
      chain({ result: [LP_INVOICE] }),
      // the pre-guard ownership re-read, the last one before dispatch, and
      // the email leg's own check (its handoff is later still)
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
    ],
      activity_log: [chain({ first: null })],
      customers: [chain({ first: LP_CUSTOMER })],
      invoice_followup_sequences: [chain({ first: undefined }), chain({ first: undefined })],
    });
    const result = await LatePaymentChecker.checkAndNotify();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(BalanceReminder.sendLatePaymentEmail).not.toHaveBeenCalled();
    expect(result).toMatchObject({ notified: 0, skipped: 1 });
  });

  test('SEND FAILURE ⇒ the standing ledger row is stamped send_failed (over-suppression is the safe direction)', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'NON_MOBILE' });
    BalanceReminder.sendLatePaymentEmail.mockResolvedValue({ ok: true });
    armLatePaymentHappyPath();
    const result = await LatePaymentChecker.checkAndNotify();
    expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(
      { id: 'led-1', metadata: {} },
      { code: 'NON_MOBILE' },
    );
    expect(result.emailedFallback).toBe(1); // email leg still delivered, with its own row
  });
});

// ─── invoice-followups rail ────────────────────────────────────────────────

function followupRow(overrides = {}) {
  return {
    id: 'seq-1',
    invoice_id: 'inv-1',
    customer_id: 'cust-1',
    step_index: 0,
    next_touch_at: '2026-05-26T13:00:00.000Z',
    touches_sent: 0,
    token: 'token-1',
    title: 'Quarterly Pest Control',
    total: '129.00',
    status: 'active',
    service_date: '2026-05-12',
    due_date: '2026-05-19',
    invoice_number: 'WPC-2026-1042',
    invoice_created_at: '2026-05-20T12:00:00.000Z',
    invoice_payer_id: null,
    ...overrides,
  };
}

const FU_CUSTOMER = { id: 'cust-1', first_name: 'Taylor', email: 'taylor@example.com', phone: '+19415550101' };
const FU_INVOICE = {
  id: 'inv-1',
  customer_id: 'cust-1',
  invoice_number: 'WPC-2026-1042',
  status: 'sent',
  title: 'Quarterly Pest Control',
  total: '129.00',
  due_date: '2026-05-19',
  service_date: '2026-05-12',
  token: 'token-1',
};

// Exact follow-up content plus billing routing metadata.
const FU_EXPECTED_SEND = {
  to: '+19415550101',
  body: 'invoice follow-up sms',
  channel: 'sms',
  audience: 'customer',
  purpose: 'payment_link',
  customerId: 'cust-1',
  invoiceId: 'inv-1',
  entryPoint: 'invoice_followup_sequence',
  metadata: { original_message_type: 'invoice_followup', notificationEventKey: 'invoice-followup:seq-1:d3_friendly',
    billingDeliveryCategory: 'invoice', collections_ledger_id: 'led-1',
    followup_sequence_id: 'seq-1', rendered_amount: '129.00' },
  hasEmailLeg: true,
  // The last ownership check, run by the canonical sender immediately before
  // provider preparation — the short-link round-trip and the ledger writes
  // are awaited after this rail's own re-read.
  preDispatchCheck: expect.any(Function),
};

const FU_LIVE_SEQ = {
  id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 0,
  next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null,
};

function armFollowupHappyPath({ sequenceUpdate = chain(), prefs = { email_enabled: true },
  selectedCustomer = FU_CUSTOMER, ledgerRows = null, ledgerQuery = null,
  rowOverrides = {}, finalInteraction = chain() } = {}) {
  setDbQueues({
    'invoice_followup_sequences as s': [chain({ result: [followupRow(rowOverrides)] })],
    customers: [chain({ first: selectedCustomer })],
    invoices: [
      chain({ first: FU_INVOICE }), // claim-txn row lock read
      chain({ first: FU_INVOICE }), // fireTouch's live ownership re-read
      chain({ first: FU_INVOICE }), // credit path's own invoice read
      chain({ first: FU_INVOICE }), // pre-dun refresh (ownership judged again)
      chain({ first: FU_INVOICE }), // email-eligibility read
    ],
    notification_prefs: [chain({ first: prefs }), chain({ first: prefs })],
    ...(ledgerQuery || ledgerRows
      ? { collections_contact_ledger: [ledgerQuery || chain({ result: ledgerRows })] } : {}),
    customer_interactions: [finalInteraction, finalInteraction],
    invoice_followup_sequences: [
      chain({ first: FU_LIVE_SEQ }), // post-lock revalidation
      chain({ result: 1 }), // touch claim
      sequenceUpdate, // cadence advance
      chain({ result: 1 }), // claim clear
    ],
  });
  return sequenceUpdate;
}

// Held retime (PR 0): a touch nothing was delivered for, that is not
// terminal, is retimed to the start of the next NY day — never left due, where
// the daily tick's 20h stale grace would skip the step forward.
const HELD_FLOOR = new Date('2026-05-27T04:00:00.000Z'); // Wed 00:00 EDT, after the Tue-14:00Z clock

// The default row's next step (d7) falls on Wed 05-27 10:00 ET, the same NY day
// as the retry, so it would not be held; anchor rows that are meant to hold
// on 05-21 (d7 = Thu 05-28).
const HOLD_ROW = { invoice_created_at: '2026-05-21T12:00:00.000Z' };
const FU_DUE = '2026-05-26T13:00:00.000Z';

function expectHeldRetime(update, { at = HELD_FLOOR, stepIndex = 0, dueAt = FU_DUE } = {}) {
  // The guard: claim holder, same active step, AND the claimed due time
  // unchanged (a send-now rewrite in between makes it a 0-row no-op).
  expect(update.where).toHaveBeenCalledWith({
    id: 'seq-1', status: 'active', step_index: stepIndex, touch_claimed_at: expect.any(Date),
  });
  // Compared at millisecond precision: a writer that stamps the DB clock
  // (now(), microseconds) must still match the ms Date pg handed back.
  expect(update.whereRaw).toHaveBeenCalledWith(
    "date_trunc('milliseconds', next_touch_at) = ?", [new Date(dueAt)],
  );
  expect(update.update).toHaveBeenCalledTimes(1);
  const [patch] = update.update.mock.calls[0];
  expect(patch).toEqual({ updated_at: 'CURRENT_TIMESTAMP', next_touch_at: at });
  expect(patch).not.toHaveProperty('step_index');
  expect(patch).not.toHaveProperty('status');
}

describe('invoice-followups rail', () => {
  test('App-only invoice touch evaluates push policy and sends without phone despite do_not_text', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockImplementation(async (_id, { channel }) => channel === 'sms'
      ? { allowed: false, denialReasons: ['flag_do_not_text'], eligibleInvoiceIds: ['inv-1'] }
      : ALLOWED);
    const finalInteraction = chain();
    const ledgerQuery = chain();
    const sequenceUpdate = armFollowupHappyPath({
      prefs: { invoice_channels: ['push'] }, selectedCustomer: { ...FU_CUSTOMER, phone: null },
      finalInteraction, ledgerQuery,
    });

    expect(await InvoiceFollowUps.runPending()).toEqual({ sent: 1, skipped: 0 });
    expect(ContactPolicy.evaluate.mock.calls.map(([, args]) => args.channel)).toEqual(['push']);
    expect(ledgerQuery.whereIn).toHaveBeenCalledWith('idempotency_key', ['invoice_followups:seq-1:d3_friendly:push']);
    expect(ContactLedger.recordContact.mock.calls.map(([args]) => args.channel)).toEqual(['push']);
    expect(sendCustomerMessage.mock.calls[0][0]).toMatchObject({
      to: null, channel: 'push', metadata: { billingDeliveryLeg: 'push', appOnly: true },
    });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
    expect(finalInteraction.insert).toHaveBeenCalledWith(expect.objectContaining({ interaction_type: 'app_outbound' }));
  });

  test('mixed App and Text choice sends only App when do_not_text denies Text', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockImplementation(async (_id, { channel }) => channel === 'sms'
      ? { allowed: false, denialReasons: ['flag_do_not_text'], eligibleInvoiceIds: ['inv-1'] }
      : ALLOWED);
    const finalInteraction = chain();
    const sequenceUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['push', 'sms'] }, finalInteraction });

    expect(await InvoiceFollowUps.runPending()).toEqual({ sent: 1, skipped: 0 });
    expect(ContactPolicy.evaluate.mock.calls.map(([, args]) => args.channel)).toEqual(['push', 'sms']);
    expect(ContactLedger.recordContact.mock.calls.map(([args]) => args.channel)).toEqual(['push']);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].metadata.billingDeliveryLeg).toBe('push');
    expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
    expect(finalInteraction.insert).toHaveBeenCalledWith(expect.objectContaining({ interaction_type: 'app_outbound' }));
  });

  test.each([
    ['a durable do-not-email flag waives the selected Email and the step advances', 'flag_do_not_email', true],
    ['a spacing window holds the step for the selected Email', 'contact_within_24h', false],
  ])('%s after App delivers', async (_label, reason, advances) => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockImplementation(async (_id, { channel }) => channel === 'email'
      ? { allowed: false, denialReasons: [reason], eligibleInvoiceIds: ['inv-1'] }
      : ALLOWED);
    const sequenceUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['email', 'push'] } });

    await InvoiceFollowUps.runPending();

    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].metadata.billingDeliveryLeg).toBe('push');
    if (advances) expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
    else expect(sequenceUpdate.update.mock.calls[0][0]).not.toHaveProperty('step_index');
  });

  test('microdeposit follow-up uses payment-issue App policy instead of invoice Text policy', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(true);
    ContactPolicy.evaluate.mockImplementation(async (_id, { channel }) => channel === 'sms'
      ? { allowed: false, denialReasons: ['flag_do_not_text'], eligibleInvoiceIds: ['inv-1'] }
      : ALLOWED);
    armFollowupHappyPath({
      prefs: { invoice_channels: ['sms'], payment_issue_channels: ['push'] },
      selectedCustomer: { ...FU_CUSTOMER, phone: null },
      rowOverrides: { invoice_stripe_pi: 'pi-test' },
    });

    await InvoiceFollowUps.runPending();
    expect(ContactPolicy.evaluate.mock.calls.map(([, args]) => args.channel)).toEqual(['push']);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({
      billingDeliveryCategory: 'payment_issue', billingDeliveryLeg: 'push',
      original_message_type: 'bank_verification_incomplete',
    });
    expect(sendMicrodepositVerificationEmail).not.toHaveBeenCalled();
  });

  test('retryable branded Email holds accepted App on the same step until Email succeeds', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-d3`, metadata: {} }));
    let pushClaims = 0;
    ContactLedger.claimAttempt.mockImplementation(async (ledger) => ledger.id === 'push-d3' && pushClaims++ > 0
      ? { allowed: false, delivered: true } : { allowed: true });
    EmailTemplates.sendTemplate
      .mockResolvedValueOnce({ sent: false, blocked: false, reason: 'provider_unavailable' })
      .mockResolvedValueOnce({ sent: true, message: { provider_message_id: 'sg-1' } });
    const firstUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['email', 'push'] } });
    await InvoiceFollowUps.runPending();
    expect(firstUpdate.update.mock.calls[0][0]).not.toHaveProperty('step_index');
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);

    const finalUpdate = armFollowupHappyPath({
      prefs: { invoice_channels: ['email', 'push'] }, ledgerRows: [
        { id: 'email-d3', idempotency_key: 'invoice_followups:seq-1:d3_friendly:email' },
        { id: 'push-d3', idempotency_key: 'invoice_followups:seq-1:d3_friendly:push' },
      ],
    });
    await InvoiceFollowUps.runPending();
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(2);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(finalUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
  });

  test('unknown branded Email outcome keeps its ledger fenced and never repeats accepted App', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const selfPayAtDispatch = jest.spyOn(require('../services/invoice-helpers'), 'selfPayAtDispatch')
      .mockReturnValue(async () => ({ ok: true }));
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-d3`, metadata: {} }));
    let secondRun = false;
    ContactLedger.claimAttempt.mockImplementation(async (ledger) => secondRun
      ? (ledger.id === 'push-d3' ? { allowed: false, delivered: true } : { allowed: false, held: true })
      : { allowed: true });
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) =>
      withProviderHandoff(async () => { throw new Error('provider response lost'); }));
    const firstUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['email', 'push'] } });
    await InvoiceFollowUps.runPending();
    selfPayAtDispatch.mockRestore();
    expect(firstUpdate.update.mock.calls[0][0]).not.toHaveProperty('step_index');
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'email-d3' }), expect.anything(),
    );

    secondRun = true;
    const heldUpdate = armFollowupHappyPath({
      prefs: { invoice_channels: ['email', 'push'] }, ledgerRows: [
        { id: 'email-d3', idempotency_key: 'invoice_followups:seq-1:d3_friendly:email' },
        { id: 'push-d3', idempotency_key: 'invoice_followups:seq-1:d3_friendly:push' },
      ],
    });
    await InvoiceFollowUps.runPending();
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(heldUpdate.update.mock.calls[0][0]).not.toHaveProperty('step_index');
  });

  test('definite not-sent Email can retry without claiming Email delivery', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-d3`, metadata: {} }));
    EmailTemplates.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('not sent'), {
      providerOutcome: { deliveryOutcome: 'not_sent' },
    }));
    const sequenceUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['email', 'push'] } });
    await InvoiceFollowUps.runPending();

    expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(expect.objectContaining({ id: 'email-d3' }),
      expect.objectContaining({ reason: 'not sent' }));
    expect(sequenceUpdate.update.mock.calls[0][0]).not.toHaveProperty('step_index');
    expect(ContactLedger.markDelivered).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'email-d3' }));
  });

  test('template read failure before Email handoff retries the same step without repeating accepted App', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-d3`, metadata: {} }));
    let pushClaims = 0;
    ContactLedger.claimAttempt.mockImplementation(async (ledger) => ledger.id === 'push-d3' && pushClaims++ > 0
      ? { allowed: false, delivered: true } : { allowed: true });
    EmailTemplates.sendTemplate
      .mockRejectedValueOnce(new Error('template version lookup unavailable'))
      .mockResolvedValueOnce({ sent: true, message: { provider_message_id: 'sg-retry' } });
    const firstUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['email', 'push'] } });
    await InvoiceFollowUps.runPending();

    expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'email-d3' }), expect.objectContaining({ reason: 'template version lookup unavailable' }),
    );
    expect(firstUpdate.update.mock.calls[0][0]).not.toHaveProperty('step_index');

    const finalUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['email', 'push'] }, ledgerRows: [
      { id: 'email-d3', idempotency_key: 'invoice_followups:seq-1:d3_friendly:email' },
      { id: 'push-d3', idempotency_key: 'invoice_followups:seq-1:d3_friendly:push' },
    ] });
    await InvoiceFollowUps.runPending();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(2);
    expect(finalUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
  });

  test('post-handoff SendGrid 429 retries Email without repeating accepted App', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const selfPayAtDispatch = jest.spyOn(require('../services/invoice-helpers'), 'selfPayAtDispatch')
      .mockReturnValue(async () => ({ ok: true }));
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-d3`, metadata: {} }));
    let pushClaims = 0;
    ContactLedger.claimAttempt.mockImplementation(async (ledger) => ledger.id === 'push-d3' && pushClaims++ > 0
      ? { allowed: false, delivered: true } : { allowed: true });
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) =>
      withProviderHandoff(async () => { throw Object.assign(new Error('SendGrid rate limit'), { status: 429 }); }));
    const firstUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['email', 'push'] } });
    await InvoiceFollowUps.runPending();
    selfPayAtDispatch.mockRestore();

    expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'email-d3' }), expect.objectContaining({ reason: 'SendGrid rate limit' }),
    );
    expect(firstUpdate.update.mock.calls[0][0]).not.toHaveProperty('step_index');

    const finalUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['email', 'push'] }, ledgerRows: [
      { id: 'email-d3', idempotency_key: 'invoice_followups:seq-1:d3_friendly:email' },
      { id: 'push-d3', idempotency_key: 'invoice_followups:seq-1:d3_friendly:push' },
    ] });
    await InvoiceFollowUps.runPending();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(2);
    expect(finalUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
  });

  test.each([
    ['HTTP 408', 408], ['HTTP 503', 503], ['network failure', null],
  ])('post-handoff %s leaves Email and accepted App on the same held step', async (_label, status) => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const selfPayAtDispatch = jest.spyOn(require('../services/invoice-helpers'), 'selfPayAtDispatch')
      .mockReturnValue(async () => ({ ok: true }));
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-d3`, metadata: {} }));
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) =>
      withProviderHandoff(async () => { throw Object.assign(new Error('ambiguous provider result'), status ? { status } : {}); }));
    const sequenceUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['email', 'push'] } });
    await InvoiceFollowUps.runPending();
    selfPayAtDispatch.mockRestore();

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'email-d3' }), expect.anything(),
    );
    expect(sequenceUpdate.update.mock.calls[0][0]).not.toHaveProperty('step_index');
  });

  test('Email in-progress collision stays fenced before this caller starts its handoff', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-d3`, metadata: {} }));
    EmailTemplates.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('in progress'), {
      code: 'EMAIL_SEND_IN_PROGRESS', retryable: true,
    }));
    const sequenceUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['email', 'push'] } });
    await InvoiceFollowUps.runPending();

    expect(ContactLedger.markSendFailed).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'email-d3' }), expect.anything(),
    );
    expect(sequenceUpdate.update.mock.calls[0][0]).not.toHaveProperty('step_index');
  });

  test('structured uncertain Email outcome stays fenced even before this caller starts its handoff', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-d3`, metadata: {} }));
    EmailTemplates.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('handoff state unknown'), {
      status: 429,
      providerOutcome: { deliveryOutcome: 'uncertain' },
    }));
    const sequenceUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['email', 'push'] } });
    await InvoiceFollowUps.runPending();

    expect(ContactLedger.markSendFailed).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'email-d3' }), expect.anything(),
    );
    expect(sequenceUpdate.update.mock.calls[0][0]).not.toHaveProperty('step_index');
  });

  test('provider-accepted Email evidence survives a later thrown audit error', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-d3`, metadata: {} }));
    EmailTemplates.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('audit failed'), {
      providerOutcome: { deliveryOutcome: 'accepted' },
    }));
    const sequenceUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['email'] } });
    await InvoiceFollowUps.runPending();

    expect(ContactLedger.markDelivered).toHaveBeenCalledWith(expect.objectContaining({ id: 'email-d3' }));
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'email-d3' }), expect.anything(),
    );
    expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
  });

  test('unknown microdeposit Email outcome holds accepted App without reopening the Email ledger', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(true);
    sendMicrodepositVerificationEmail.mockResolvedValueOnce({ ok: false, error: 'provider response lost' });
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-d3`, metadata: {} }));
    const sequenceUpdate = armFollowupHappyPath({
      prefs: { payment_issue_channels: ['email', 'push'] }, rowOverrides: { invoice_stripe_pi: 'pi-test' },
    });
    await InvoiceFollowUps.runPending();

    expect(sequenceUpdate.update.mock.calls[0][0]).not.toHaveProperty('step_index');
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'email-d3' }), expect.anything(),
    );
  });

  test.each([
    ['suppressed', { sent: false, blocked: true, reason: 'Suppressed: bounce' }],
    ['disabled template', Object.assign(new Error('template disabled'), { code: 'EMAIL_TEMPLATE_DISABLED' })],
  ])('terminal %s Email refusal resolves while accepted App advances the step', async (_label, refusal) => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-d3`, metadata: {} }));
    if (refusal instanceof Error) EmailTemplates.sendTemplate.mockRejectedValueOnce(refusal);
    else EmailTemplates.sendTemplate.mockResolvedValueOnce(refusal);
    const sequenceUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['email', 'push'] } });

    await InvoiceFollowUps.runPending();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
    expect(ContactLedger.markDelivered).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'email-d3' }));
    expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      resolved: true, resolution: 'email_terminal_refusal',
    }));
  });

  test('resolved terminal Email plus a retried accepted Text advances on the second attempt without resending Email', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-d3`, metadata: {} }));
    let secondRun = false;
    ContactLedger.claimAttempt.mockImplementation(async (ledger) => (
      secondRun && ledger.id === 'email-d3'
        ? { allowed: false, resolved: true }
        : { allowed: true }
    ));
    EmailTemplates.sendTemplate.mockResolvedValueOnce({
      sent: false,
      blocked: true,
      reason: 'Suppressed: bounce',
    });
    sendCustomerMessage
      .mockResolvedValueOnce({
        sent: false,
        blocked: false,
        deliveryOutcome: 'not_sent',
        code: 'PROVIDER_FAILURE',
        retryable: true,
        deferred: true,
      })
      .mockResolvedValueOnce({ sent: true, blocked: false, deliveryOutcome: 'accepted' });

    const firstUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['email', 'sms'] } });
    await InvoiceFollowUps.runPending();
    expect(firstUpdate.update.mock.calls[0][0]).not.toHaveProperty('step_index');
    expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'email-d3' }),
      expect.objectContaining({ resolved: true, resolution: 'email_terminal_refusal' }),
    );

    secondRun = true;
    const finalInteraction = chain();
    const secondUpdate = armFollowupHappyPath({
      prefs: { invoice_channels: ['email', 'sms'] },
      ledgerRows: [
        { id: 'email-d3', idempotency_key: 'invoice_followups:seq-1:d3_friendly:email' },
        { id: 'sms-d3', idempotency_key: 'invoice_followups:seq-1:d3_friendly:sms' },
      ],
      finalInteraction,
    });
    await InvoiceFollowUps.runPending();

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
    expect(secondUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
    const audit = JSON.parse(finalInteraction.insert.mock.calls[0][0].metadata);
    expect(audit).toMatchObject({
      email_sent: false,
      email_reason: 'prior_email_terminally_settled',
      sms_sent: true,
    });
  });

  test('a global hold still defers an App-only touch before credit or ledger work', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue(DENIED);
    const sequenceUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['push'] } });

    await InvoiceFollowUps.runPending();
    expect(ContactPolicy.evaluate.mock.calls.map(([, args]) => args.channel)).toEqual(['push']);
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(sequenceUpdate.update.mock.calls.every(([patch]) => !Object.hasOwn(patch, 'step_index'))).toBe(true);
  });

  test('missing customer stops before preferences, credit, or provider work', async () => {
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow()] })],
      customers: [chain({ first: null })],
      invoices: [chain({ first: FU_INVOICE }), chain({ first: FU_INVOICE })],
      invoice_followup_sequences: [
        chain({ first: FU_LIVE_SEQ }), chain({ result: 1 }), chain({ result: 1 }),
      ],
    });
    await InvoiceFollowUps.runPending();
    expect(db.mock.calls.some(([table]) => table === 'notification_prefs')).toBe(false);
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('a deferred Text sibling holds the step and retries without repeating accepted App', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-d3`, metadata: {} }));
    let pushClaims = 0;
    ContactLedger.claimAttempt.mockImplementation(async (ledger) => ledger.id === 'push-d3' && pushClaims++ > 0
      ? { allowed: false, delivered: true } : { allowed: true });
    sendCustomerMessage
      .mockResolvedValueOnce({ sent: true, deliveryOutcome: 'accepted' })
      .mockResolvedValueOnce({ sent: false, deliveryOutcome: 'not_sent', deferred: true,
        retryable: true, nextAllowedAt: '2026-05-27T12:00:00.000Z', code: 'QUIET_HOURS_HOLD' })
      .mockResolvedValueOnce({ sent: true, deliveryOutcome: 'accepted' });
    const firstUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['push', 'sms'] } });
    await InvoiceFollowUps.runPending();
    expect(firstUpdate.update.mock.calls[0][0]).toMatchObject({ next_touch_at: new Date('2026-05-27T12:00:00.000Z') });
    expect(firstUpdate.update.mock.calls[0][0]).not.toHaveProperty('step_index');

    const finalUpdate = armFollowupHappyPath({
      prefs: { invoice_channels: ['push', 'sms'] }, ledgerRows: [
        { id: 'push-d3', idempotency_key: 'invoice_followups:seq-1:d3_friendly:push' },
        { id: 'sms-d3', idempotency_key: 'invoice_followups:seq-1:d3_friendly:sms' },
      ],
    });
    expect(await InvoiceFollowUps.runPending()).toEqual({ sent: 1, skipped: 0 });
    expect(sendCustomerMessage.mock.calls.map(([args]) => args.metadata.billingDeliveryLeg)).toEqual(['push', 'sms', 'sms']);
    expect(finalUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
    expect(ContactPolicy.evaluate).toHaveBeenLastCalledWith('cust-1', expect.objectContaining({
      channel: 'sms', excludeLedgerIds: ['push-d3', 'sms-d3'],
    }));
  });

  test('gate UNSET: policy never consulted, follow-up content and billing routing metadata are preserved', async () => {
    armFollowupHappyPath();
    const result = await InvoiceFollowUps.runPending();
    expect(ContactPolicy.evaluate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0]).toEqual(FU_EXPECTED_SEND);
    expect(result).toEqual({ sent: 1, skipped: 0 });
  });

  test("gate 'true' + both channels denied: no sends, no ledger rows, sequence held (not paused, not left due) for a later run", async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue(TRANSIENT_DENIED);
    const heldRetime = chain({ result: 1 });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow(HOLD_ROW)] })],
      customers: [chain({ first: FU_CUSTOMER })],
      invoices: [
        chain({ first: FU_INVOICE }), // claim-txn row lock read
        chain({ first: FU_INVOICE }), // fireTouch's live ownership re-read
      ],
      invoice_followup_sequences: [
        chain({ first: FU_LIVE_SEQ }),
        chain({ result: 1 }), // touch claim
        heldRetime, // held retime (PR 0): held, not skipped
        chain({ result: 1 }), // claim clear (finally)
      ],
    });
    await InvoiceFollowUps.runPending();
    expectHeldRetime(heldRetime);
    expect(ContactPolicy.evaluate).toHaveBeenCalledWith('cust-1', expect.objectContaining({ channel: 'sms' }));
    expect(ContactPolicy.evaluate).toHaveBeenCalledWith('cust-1', expect.objectContaining({ channel: 'email' }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(smsTemplates.getTemplate).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
    // No cadence advance and no pause happened: the only sequence writes were
    // the claim, the held retime and the claim clear (a 5th access would throw).
  });

  test("gate 'true' + allowed: the touch fires with the unchanged send shape", async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    armFollowupHappyPath();
    const result = await InvoiceFollowUps.runPending();
    expect(sendCustomerMessage.mock.calls[0][0]).toEqual(FU_EXPECTED_SEND);
    expect(result).toEqual({ sent: 1, skipped: 0 });
  });

  test('CHANNEL INDEPENDENCE: sms denied but email allowed ⇒ email leg delivers and the step advances', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockImplementation(async (cid, { channel }) => (
      channel === 'email' ? ALLOWED : { allowed: false, denialReasons: ['flag_do_not_text'], eligibleInvoiceIds: ['inv-1'] }
    ));
    const sequenceUpdate = armFollowupHappyPath();
    await InvoiceFollowUps.runPending();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
    expect(ContactLedger.recordContact).toHaveBeenCalledTimes(1);
    expect(ContactLedger.recordContact).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email' }));
  });

  test('RECORD-THEN-SEND: email and sms rows precede their delivery attempts on a delivered touch', async () => {
    armFollowupHappyPath();
    await InvoiceFollowUps.runPending();
    expect(ContactLedger.recordContact).toHaveBeenCalledTimes(2);
    expect(ContactLedger.recordContact.mock.calls[0][0]).toEqual({
      customerId: 'cust-1',
      channel: 'email',
      purpose: 'invoice_followup',
      invoiceIds: ['inv-1'],
      source: 'invoice_followups',
      metadata: { step_id: 'd3_friendly', notificationEventKey: 'invoice-followup:seq-1:d3_friendly' },
    });
    expect(ContactLedger.recordContact.mock.calls[1][0]).toEqual(expect.objectContaining({
      channel: 'sms', purpose: 'invoice_followup',
    }));
    const emailRecordAt = ContactLedger.recordContact.mock.invocationCallOrder[0];
    const emailSendAt = EmailTemplates.sendTemplate.mock.invocationCallOrder[0];
    const smsRecordAt = ContactLedger.recordContact.mock.invocationCallOrder[1];
    const smsSendAt = sendCustomerMessage.mock.invocationCallOrder[0];
    expect(emailRecordAt).toBeLessThan(emailSendAt);
    expect(smsRecordAt).toBeLessThan(smsSendAt);
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalled();
  });

  test('EXPLICIT MULTI-CHANNEL: every leg of one touch shares the same notificationEventKey (codex r2 P2 — keyless same-event ledger siblings)', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactLedger.recordContact.mockImplementation(async ({ channel }) => ({ id: `${channel}-d3`, metadata: {} }));
    const sequenceUpdate = armFollowupHappyPath({ prefs: { invoice_channels: ['email', 'push', 'sms'] } });

    await InvoiceFollowUps.runPending();

    const calls = ContactLedger.recordContact.mock.calls.map(([args]) => args);
    expect(calls.map((c) => c.channel).sort()).toEqual(['email', 'push', 'sms']);
    const keys = calls.map((c) => c.metadata.notificationEventKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('invoice-followup:seq-1:d3_friendly');
    expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
  });

  test('LEDGER FAILURE ⇒ NO SENDS, and the sequence is NOT paused (transient hold, retried later)', async () => {
    ContactLedger.recordContact.mockRejectedValue(new Error('ledger down'));
    const heldRetime = chain({ result: 1 });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow(HOLD_ROW)] })],
      customers: [chain({ first: FU_CUSTOMER })],
      invoices: [
        chain({ first: FU_INVOICE }), // claim-txn row lock read
        chain({ first: FU_INVOICE }), // fireTouch's live ownership re-read
        chain({ first: FU_INVOICE }), // credit path's own invoice read
        chain({ first: FU_INVOICE }), // pre-dun refresh (ownership judged again)
      ],
      invoice_followup_sequences: [
        chain({ first: FU_LIVE_SEQ }),
        chain({ result: 1 }), // touch claim
        heldRetime, // held retime (PR 0) — NO pause/advance writes
        chain({ result: 1 }), // claim clear
      ],
    });
    await InvoiceFollowUps.runPending();
    expectHeldRetime(heldRetime);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('held retime lands on the claim-holder only: a changed sequence (0 rows) is left alone and never throws', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue(TRANSIENT_DENIED);
    const heldRetime = chain({ result: 0 });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow(HOLD_ROW)] })],
      customers: [chain({ first: FU_CUSTOMER })],
      invoices: [chain({ first: FU_INVOICE }), chain({ first: FU_INVOICE })],
      invoice_followup_sequences: [
        chain({ first: FU_LIVE_SEQ }), chain({ result: 1 }), heldRetime, chain({ result: 1 }),
      ],
    });
    expect(await InvoiceFollowUps.runPending()).toEqual({ sent: 1, skipped: 0 });
    expect(heldRetime.update).toHaveBeenCalledTimes(1);
  });

  test('held retime: a failed write is swallowed (row stays due, the touch does not throw)', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue(TRANSIENT_DENIED);
    const heldRetime = chain();
    heldRetime.update = jest.fn(() => { throw new Error('db blip'); });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow(HOLD_ROW)] })],
      customers: [chain({ first: FU_CUSTOMER })],
      invoices: [chain({ first: FU_INVOICE }), chain({ first: FU_INVOICE })],
      invoice_followup_sequences: [
        chain({ first: FU_LIVE_SEQ }), chain({ result: 1 }), heldRetime, chain({ result: 1 }),
      ],
    });
    expect(await InvoiceFollowUps.runPending()).toEqual({ sent: 1, skipped: 0 });
  });

  test('explicit channels: the step-ledger read failing holds the touch to the next day', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const heldRetime = chain({ result: 1 });
    const ledgerQuery = chain();
    ledgerQuery.whereIn = jest.fn(() => { throw new Error('ledger read down'); });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow(HOLD_ROW)] })],
      customers: [chain({ first: FU_CUSTOMER })],
      invoices: [chain({ first: FU_INVOICE }), chain({ first: FU_INVOICE })],
      notification_prefs: [chain({ first: { invoice_channels: ['push', 'sms'] } })],
      collections_contact_ledger: [ledgerQuery],
      invoice_followup_sequences: [
        chain({ first: FU_LIVE_SEQ }), chain({ result: 1 }), heldRetime, chain({ result: 1 }),
      ],
    });
    await InvoiceFollowUps.runPending();
    expectHeldRetime(heldRetime);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(ContactPolicy.evaluate).not.toHaveBeenCalled();
  });

  test('a next-day tick SENDS a policy-held step; the pre-fix due-row shape is stale-skipped instead', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    // Tick 1 (Tue 14:00Z): everything denied -> held, and the retime is captured.
    ContactPolicy.evaluate.mockResolvedValue(TRANSIENT_DENIED);
    const heldRetime = chain({ result: 1 });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow(HOLD_ROW)] })],
      customers: [chain({ first: FU_CUSTOMER })],
      invoices: [chain({ first: FU_INVOICE }), chain({ first: FU_INVOICE })],
      invoice_followup_sequences: [
        chain({ first: FU_LIVE_SEQ }), chain({ result: 1 }), heldRetime, chain({ result: 1 }),
      ],
    });
    await InvoiceFollowUps.runPending();
    expectHeldRetime(heldRetime);
    const heldAt = heldRetime.update.mock.calls[0][0].next_touch_at;
    expect(sendCustomerMessage).not.toHaveBeenCalled();

    // Tick 2 (Wed 10:16 ET, the next daily cron): the retimed row is inside its
    // grace and the step goes out.
    jest.setSystemTime(new Date('2026-05-27T14:16:00.000Z'));
    ContactPolicy.evaluate.mockResolvedValue(ALLOWED);
    armFollowupHappyPath({ rowOverrides: { next_touch_at: heldAt } });
    expect(await InvoiceFollowUps.runPending()).toEqual({ sent: 1, skipped: 0 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);

    // Control: the row as it stood before the fix (still due Tue 09:00 ET) is
    // more than 20h old at the same tick and is passed over, never sent.
    sendCustomerMessage.mockClear();
    const staleSkip = chain({ result: 1 });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow()] })],
      invoice_followup_sequences: [staleSkip],
    });
    await InvoiceFollowUps.runPending();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(staleSkip.update.mock.calls[0][0]).toMatchObject({ step_index: expect.any(Number) });
  });

  test('a Friday hold rolls to Saturday 00:00, and Tuesday still sends it (weekend roll)', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    jest.setSystemTime(new Date('2026-05-29T14:16:00.000Z')); // Fri
    ContactPolicy.evaluate.mockResolvedValue(TRANSIENT_DENIED);
    const heldRetime = chain({ result: 1 });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow({
        // anchored 05-27 so the next step (Jun 3) is still ahead of the Saturday hold
        next_touch_at: '2026-05-29T13:00:00.000Z', invoice_created_at: '2026-05-27T12:00:00.000Z',
      })] })],
      customers: [chain({ first: FU_CUSTOMER })],
      invoices: [chain({ first: FU_INVOICE }), chain({ first: FU_INVOICE })],
      invoice_followup_sequences: [
        chain({ first: { ...FU_LIVE_SEQ, next_touch_at: '2026-05-29T13:00:00.000Z' } }),
        chain({ result: 1 }), heldRetime, chain({ result: 1 }),
      ],
    });
    await InvoiceFollowUps.runPending();
    const heldAt = heldRetime.update.mock.calls[0][0].next_touch_at;
    expect(heldAt).toEqual(new Date('2026-05-30T04:00:00.000Z')); // Sat 00:00 EDT

    jest.setSystemTime(new Date('2026-06-02T14:16:00.000Z')); // Tue 10:16 ET
    ContactPolicy.evaluate.mockResolvedValue(ALLOWED);
    armFollowupHappyPath({ rowOverrides: { next_touch_at: heldAt, invoice_created_at: '2026-05-27T12:00:00.000Z' } });
    expect(await InvoiceFollowUps.runPending()).toEqual({ sent: 1, skipped: 0 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  // ─── held-retime bound (owner ruling on the audit P1) ───────────────────
  // Clock: Tue 2026-05-26 14:00Z, so the hold target is Wed 05-27 00:00 ET.
  // The cadence is the legacy d3/d7/d14/d30 (ladder gate unset), anchored at
  // invoice_created_at 10:00 ET: step N is due on anchor + [3,7,14,30] days.
  function armDeniedTouch({ rowOverrides = {}, stepIndex = 0, third, liveDueAt = null }) {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue(TRANSIENT_DENIED);
    const claimClear = chain({ result: 1 });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow({ step_index: stepIndex, ...rowOverrides })] })],
      customers: [chain({ first: FU_CUSTOMER })],
      invoices: [chain({ first: FU_INVOICE }), chain({ first: FU_INVOICE })],
      invoice_followup_sequences: [
        chain({ first: {
          ...FU_LIVE_SEQ, step_index: stepIndex,
          next_touch_at: liveDueAt || rowOverrides.next_touch_at || FU_LIVE_SEQ.next_touch_at,
        } }),
        chain({ result: 1 }), // touch claim
        ...(third ? [third] : []),
        claimClear,
      ],
    });
    return claimClear;
  }

  test('bound: a hold inside the current stage lands (next step still ahead of the retry day)', async () => {
    // anchor 05-21 -> d7 (next step) due 05-28 10:00 ET, after the 05-27 retry.
    const heldRetime = chain({ result: 1 });
    armDeniedTouch({ rowOverrides: { invoice_created_at: '2026-05-21T12:00:00.000Z' }, third: heldRetime });
    await InvoiceFollowUps.runPending();
    expectHeldRetime(heldRetime);
  });

  test("bound: once the next step's day arrives first there is NO hold, and the stale skip then advances the step", async () => {
    // anchor 05-19 -> d7 (next step) due 05-26 10:00 ET: already here, so the
    // 05-27 retry would send Day 3 copy after Day 7's day. Nothing is written;
    // the queue has no slot for a retime (it would consume the claim clear).
    const claimClear = armDeniedTouch({
      rowOverrides: { invoice_created_at: '2026-05-19T12:00:00.000Z' },
    });
    await InvoiceFollowUps.runPending();
    expect(claimClear.update).toHaveBeenCalledTimes(1);
    expect(claimClear.update.mock.calls[0][0]).toEqual({ touch_claimed_at: null, updated_at: 'CURRENT_TIMESTAMP' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();

    // Next daily tick (Wed 10:16 ET): the row is still the untouched due row,
    // now 25h old, so the stale skip moves it past the superseded step.
    jest.setSystemTime(new Date('2026-05-27T14:16:00.000Z'));
    const staleSkip = chain({ result: 1 });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow({ invoice_created_at: '2026-05-19T12:00:00.000Z' })] })],
      invoice_followup_sequences: [staleSkip],
    });
    await InvoiceFollowUps.runPending();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(staleSkip.update.mock.calls[0][0]).toMatchObject({ step_index: 2, status: 'active' });
  });

  test('bound: the FINAL step holds while within 7 days of its own scheduled day', async () => {
    // step 3 (d30) anchor 04-26 -> due 05-26; the 05-27 retry is 1 day past.
    const heldRetime = chain({ result: 1 });
    armDeniedTouch({
      stepIndex: 3, rowOverrides: { invoice_created_at: '2026-04-26T12:00:00.000Z' }, third: heldRetime,
    });
    await InvoiceFollowUps.runPending();
    expectHeldRetime(heldRetime, { stepIndex: 3 });
  });

  test('bound: the FINAL step holds up to the 7-day edge and stops after it', async () => {
    // anchor 04-20 -> due 05-20 10:00 ET; +7d = 05-27 10:00 ET, after the
    // 05-27 00:00 ET retry: still held.
    const edgeRetime = chain({ result: 1 });
    armDeniedTouch({
      stepIndex: 3, rowOverrides: { invoice_created_at: '2026-04-20T12:00:00.000Z' }, third: edgeRetime,
    });
    await InvoiceFollowUps.runPending();
    expectHeldRetime(edgeRetime, { stepIndex: 3 });

    // anchor 04-10 -> due 05-10; +7d = 05-17, long before the retry: no hold.
    const claimClear = armDeniedTouch({
      stepIndex: 3, rowOverrides: { invoice_created_at: '2026-04-10T12:00:00.000Z' },
    });
    await InvoiceFollowUps.runPending();
    expect(claimClear.update).toHaveBeenCalledTimes(1);
    expect(claimClear.update.mock.calls[0][0]).toEqual({ touch_claimed_at: null, updated_at: 'CURRENT_TIMESTAMP' });
  });

  test('bound (weekend): a Friday hold whose next step is Tuesday is NOT held; the stale skip then advances it', async () => {
    // Friday 05-29: the hold would retry Tuesday 06-02. anchor 05-26 puts d7 on
    // Tue 06-02, so Tuesday is the NEXT step's day: no hold (a raw-instant
    // compare would wrongly hold: Sat 00:00 is before Tue 10:00).
    jest.setSystemTime(new Date('2026-05-29T14:16:00.000Z'));
    const dueAt = '2026-05-29T13:00:00.000Z';
    const claimClear = armDeniedTouch({
      rowOverrides: { invoice_created_at: '2026-05-26T12:00:00.000Z', next_touch_at: dueAt },
    });
    await InvoiceFollowUps.runPending();
    expect(claimClear.update).toHaveBeenCalledTimes(1);
    expect(claimClear.update.mock.calls[0][0]).toEqual({ touch_claimed_at: null, updated_at: 'CURRENT_TIMESTAMP' });

    // Tue 06-02 10:16 ET: the untouched due row is 4 days old -> stale skip to d7.
    jest.setSystemTime(new Date('2026-06-02T14:16:00.000Z'));
    ContactPolicy.evaluate.mockResolvedValue(ALLOWED);
    const staleSkip = chain({ result: 1 });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow({
        invoice_created_at: '2026-05-26T12:00:00.000Z', next_touch_at: dueAt,
      })] })],
      invoice_followup_sequences: [staleSkip],
    });
    await InvoiceFollowUps.runPending();
    expect(staleSkip.update.mock.calls[0][0]).toMatchObject({ step_index: 1, status: 'active' });
  });

  test('bound (weekend): a Friday hold whose next step is Wednesday or later IS held, and Tuesday sends the held step', async () => {
    // anchor 05-27 -> d7 = Wed 06-03; Tuesday 06-02 is still the current stage.
    jest.setSystemTime(new Date('2026-05-29T14:16:00.000Z'));
    const dueAt = '2026-05-29T13:00:00.000Z';
    const heldRetime = chain({ result: 1 });
    armDeniedTouch({
      rowOverrides: { invoice_created_at: '2026-05-27T12:00:00.000Z', next_touch_at: dueAt }, third: heldRetime,
    });
    await InvoiceFollowUps.runPending();
    expectHeldRetime(heldRetime, { at: new Date('2026-05-30T04:00:00.000Z'), dueAt });
  });

  test('bound (weekend): the FINAL step near the 7-day edge is judged on the Tuesday retry day, not the Saturday floor', async () => {
    jest.setSystemTime(new Date('2026-05-29T14:16:00.000Z')); // Fri; retry = Tue 06-02
    const dueAt = '2026-05-29T13:00:00.000Z';
    // own day 05-26 (+7d = Tue 06-02): retry day is inside the window -> held.
    const held = chain({ result: 1 });
    armDeniedTouch({
      stepIndex: 3, rowOverrides: { invoice_created_at: '2026-04-26T12:00:00.000Z', next_touch_at: dueAt }, third: held,
    });
    await InvoiceFollowUps.runPending();
    expectHeldRetime(held, { at: new Date('2026-05-30T04:00:00.000Z'), stepIndex: 3, dueAt });

    // own day 05-25 (+7d = Mon 06-01): the Saturday floor is inside it, but the
    // cron cannot retry before Tuesday 06-02 -> outside the window, no hold.
    const claimClear = armDeniedTouch({
      stepIndex: 3, rowOverrides: { invoice_created_at: '2026-04-25T12:00:00.000Z', next_touch_at: dueAt },
    });
    await InvoiceFollowUps.runPending();
    expect(claimClear.update).toHaveBeenCalledTimes(1);
    expect(claimClear.update.mock.calls[0][0]).toEqual({ touch_claimed_at: null, updated_at: 'CURRENT_TIMESTAMP' });
  });

  test('send-now race: the hold guard carries the claimed due time and is a 0-row no-op once it changed', async () => {
    // The batch snapshot says 13:00Z but the locked row (what fireStep claimed)
    // says 13:30Z; the guard must use the locked value, and a send-now rewrite
    // after the claim then matches no row (the mock returns 0, as Postgres would).
    const heldRetime = chain({ result: 0 });
    armDeniedTouch({
      rowOverrides: { ...HOLD_ROW }, third: heldRetime, liveDueAt: '2026-05-26T13:30:00.000Z',
    });
    expect(await InvoiceFollowUps.runPending()).toEqual({ sent: 1, skipped: 0 });
    expectHeldRetime(heldRetime, { dueAt: '2026-05-26T13:30:00.000Z' });
  });

  test('Fable P1 (a): Mon anchor — Thu denied is held to Fri; Fri denied is NOT held (Tue is the next step\'s day); Tue stale-skips step 0 and sends step 1', async () => {
    // anchor Mon 05-18: step 0 = Thu 05-21, step 1 = Mon 05-25 (eligible Tue 05-26).
    const anchor = { invoice_created_at: '2026-05-18T12:00:00.000Z' };
    jest.setSystemTime(new Date('2026-05-21T14:16:00.000Z')); // Thu
    const thuDue = '2026-05-21T14:00:00.000Z';
    const held = chain({ result: 1 });
    armDeniedTouch({ rowOverrides: { ...anchor, next_touch_at: thuDue }, third: held });
    await InvoiceFollowUps.runPending();
    expectHeldRetime(held, { at: new Date('2026-05-22T04:00:00.000Z'), dueAt: thuDue }); // Fri 00:00 ET

    jest.setSystemTime(new Date('2026-05-22T14:16:00.000Z')); // Fri, the held retry
    const friDue = '2026-05-22T04:00:00.000Z';
    const claimClear = armDeniedTouch({ rowOverrides: { ...anchor, next_touch_at: friDue } });
    await InvoiceFollowUps.runPending();
    expect(claimClear.update).toHaveBeenCalledTimes(1); // claim clear only: not held
    expect(claimClear.update.mock.calls[0][0]).toEqual({ touch_claimed_at: null, updated_at: 'CURRENT_TIMESTAMP' });

    // Tue 05-26 10:16 ET: the untouched Fri row is stale -> skipped to step 1,
    // which is due today and goes out in the same run.
    jest.setSystemTime(new Date('2026-05-26T14:16:00.000Z'));
    ContactPolicy.evaluate.mockResolvedValue(ALLOWED);
    const staleSkip = chain({ result: 1 });
    const sequenceUpdate = chain();
    const step1Live = { ...FU_LIVE_SEQ, step_index: 1, next_touch_at: '2026-05-25T14:00:00.000Z' };
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow({ ...anchor, next_touch_at: friDue })] })],
      customers: [chain({ first: FU_CUSTOMER })],
      invoices: Array.from({ length: 5 }, () => chain({ first: FU_INVOICE })),
      notification_prefs: [chain({ first: { email_enabled: true } }), chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain()],
      invoice_followup_sequences: [staleSkip, chain({ first: step1Live }), chain({ result: 1 }), sequenceUpdate, chain({ result: 1 })],
    });
    await InvoiceFollowUps.runPending();
    expect(staleSkip.update.mock.calls[0][0]).toMatchObject({ step_index: 1, status: 'active' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].metadata.notificationEventKey).toBe('invoice-followup:seq-1:d7_reminder');
  });

  test('Fable P1 (b): Fri anchor — step 0 fires Tue; Wed denied is held to Thu; Thu denied is NOT held (Fri is the next step\'s day)', async () => {
    // anchor Fri 05-22: step 0 = Mon 05-25 (fires Tue), step 1 = Fri 05-29.
    const anchor = { invoice_created_at: '2026-05-22T12:00:00.000Z' };
    jest.setSystemTime(new Date('2026-05-27T14:16:00.000Z')); // Wed
    const wedDue = '2026-05-27T04:00:00.000Z';
    const held = chain({ result: 1 });
    armDeniedTouch({ rowOverrides: { ...anchor, next_touch_at: wedDue }, third: held });
    await InvoiceFollowUps.runPending();
    expectHeldRetime(held, { at: new Date('2026-05-28T04:00:00.000Z'), dueAt: wedDue }); // Thu 00:00 ET

    jest.setSystemTime(new Date('2026-05-28T14:16:00.000Z')); // Thu
    const claimClear = armDeniedTouch({
      rowOverrides: { ...anchor, next_touch_at: '2026-05-28T04:00:00.000Z' },
    });
    await InvoiceFollowUps.runPending();
    expect(claimClear.update).toHaveBeenCalledTimes(1); // floor = Fri = next step's day: not held
    expect(claimClear.update.mock.calls[0][0]).toEqual({ touch_claimed_at: null, updated_at: 'CURRENT_TIMESTAMP' });
  });

  test('Fable P2: every selected channel DURABLY denied (flag) is not held — one attempt, row left due as before', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue(DENIED); // flag_do_not_collect: durable
    const claimClear = chain({ result: 1 });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow(HOLD_ROW)] })],
      customers: [chain({ first: FU_CUSTOMER })],
      invoices: [chain({ first: FU_INVOICE }), chain({ first: FU_INVOICE })],
      invoice_followup_sequences: [chain({ first: FU_LIVE_SEQ }), chain({ result: 1 }), claimClear],
    });
    await InvoiceFollowUps.runPending();
    expect(claimClear.update).toHaveBeenCalledTimes(1);
    expect(claimClear.update.mock.calls[0][0]).toEqual({ touch_claimed_at: null, updated_at: 'CURRENT_TIMESTAMP' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('Fable P2: a durable denial on one channel and a transient one on the other still holds (the transient one can release)', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockImplementation(async (_id, { channel }) => (channel === 'sms' ? DENIED : TRANSIENT_DENIED));
    const heldRetime = chain({ result: 1 });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow(HOLD_ROW)] })],
      customers: [chain({ first: FU_CUSTOMER })],
      invoices: [chain({ first: FU_INVOICE }), chain({ first: FU_INVOICE })],
      invoice_followup_sequences: [chain({ first: FU_LIVE_SEQ }), chain({ result: 1 }), heldRetime, chain({ result: 1 })],
    });
    await InvoiceFollowUps.runPending();
    expectHeldRetime(heldRetime);
  });

  test('Codex r2 P1: a terminal SMS refusal never discards the Email leg\'s transient denial — held so Email retries after its window', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    // Email denied by a spacing window; SMS is permitted but the sender
    // refuses it for good (non-mobile). The email leg is still owed a retry,
    // so the touch is held rather than left due for the stale skip.
    ContactPolicy.evaluate.mockImplementation(async (_id, { channel }) => (channel === 'email' ? TRANSIENT_DENIED : ALLOWED));
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'NON_MOBILE' });
    const heldRetime = chain({ result: 1 });
    const claimClear = chain({ result: 1 });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow(HOLD_ROW)] })],
      customers: [chain({ first: FU_CUSTOMER })],
      invoices: Array.from({ length: 4 }, () => chain({ first: FU_INVOICE })),
      notification_prefs: [chain({ first: { email_enabled: true } })],
      invoice_followup_sequences: [chain({ first: FU_LIVE_SEQ }), chain({ result: 1 }), heldRetime, claimClear],
    });
    await InvoiceFollowUps.runPending();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expectHeldRetime(heldRetime);
    expect(claimClear.update.mock.calls[0][0]).toEqual({ touch_claimed_at: null, updated_at: 'CURRENT_TIMESTAMP' });
  });

  test('Fable P2: an operator send-now is never held (its row has no invoice anchor aliases)', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue(TRANSIENT_DENIED);
    const claimClear = chain({ result: 1 });
    // sendNextTouchNow's row select carries s.* only: created_at, no invoice_* aliases.
    const sendNowRow = followupRow({ invoice_created_at: undefined, created_at: '2026-05-21T12:00:00.000Z' });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ first: sendNowRow })],
      customers: [chain({ first: FU_CUSTOMER })],
      invoices: [chain({ first: FU_INVOICE }), chain({ first: FU_INVOICE }), chain({ first: FU_INVOICE })],
      invoice_followup_sequences: [
        chain({ first: FU_LIVE_SEQ }), // sendNextTouchNow's own read
        chain({ result: 1 }), // its re-arm write
        chain({ first: FU_LIVE_SEQ }), // fireStep post-lock revalidation
        chain({ result: 1 }), // touch claim
        claimClear,
      ],
    });
    await InvoiceFollowUps.sendNextTouchNow('inv-1', { operatorInitiated: true });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(claimClear.update).toHaveBeenCalledTimes(1);
    expect(claimClear.update.mock.calls[0][0]).toEqual({ touch_claimed_at: null, updated_at: 'CURRENT_TIMESTAMP' });
  });

  test('SEND FAILURE ⇒ the sms ledger row is stamped send_failed', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'NON_MOBILE' });
    armFollowupHappyPath();
    await InvoiceFollowUps.runPending();
    expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(
      { id: 'led-1', metadata: {} },
      { code: 'NON_MOBILE' },
    );
  });
});

// The any-channel 24h window must not fence a sidecar with its own sibling.
// Both decisions now precede the same-run ledger rows, so neither needs an
// exclusion for a row that has not been reserved yet.
test('late-payment channel decisions precede ledger reservations so both legs can deliver', async () => {
  process.env.GATE_COLLECTIONS_POLICY = 'true';
  try {
    armLatePaymentHappyPath();
    await LatePaymentChecker.checkAndNotify();
    const emailEval = ContactPolicy.evaluate.mock.calls.find((c) => c[1]?.channel === 'email');
    expect(emailEval).toBeTruthy();
    expect(emailEval[1].excludeLedgerIds).toEqual([]);
    expect(Math.max(...ContactPolicy.evaluate.mock.invocationCallOrder))
      .toBeLessThan(Math.min(...ContactLedger.recordContact.mock.invocationCallOrder));
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(BalanceReminder.sendLatePaymentEmail).toHaveBeenCalledTimes(1);
  } finally {
    delete process.env.GATE_COLLECTIONS_POLICY;
  }
});
