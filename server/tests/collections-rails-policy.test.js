/**
 * Collections policy wiring on the two SMS dunning rails (PR A, hardened by
 * the 2026-08-14 codex round).
 *
 * Pins:
 *   - GATE_COLLECTIONS_POLICY unset/off ⇒ BYTE-IDENTICAL send behavior on
 *     both rails: the policy module is never consulted and the send args are
 *     exactly the pre-lane shape (asserted with toEqual, not objectContaining).
 *   - Gate on ⇒ each channel is evaluated INDEPENDENTLY at its leg (sms
 *     denied must not silence the email leg and vice versa), and the target
 *     invoice must be IN the verdict's eligible set (an allowed verdict
 *     about a sibling invoice is not permission).
 *   - RECORD-THEN-SEND: the ledger row precedes every delivery attempt; a
 *     ledger insert failure means NO send is attempted; a failed delivery
 *     stamps the standing row via markSendFailed.
 */

jest.mock('../models/db', () => jest.fn());
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
jest.mock('../services/collections/contact-policy', () => ({
  evaluate: jest.fn(async () => ({ allowed: true, denialReasons: [], eligibleInvoiceIds: ['inv-1'] })),
}));
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
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
      throw new Error(`Unexpected db table ${table}`);
    }
    return queue.shift();
  });
}

const ALLOWED = { allowed: true, denialReasons: [], eligibleInvoiceIds: ['inv-1'] };
const DENIED = { allowed: false, denialReasons: ['flag_do_not_collect'], eligibleInvoiceIds: [] };

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
  db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  // clearAllMocks keeps per-test mockResolvedValue overrides — re-pin defaults.
  sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false });
  BalanceReminder.sendLatePaymentEmail.mockResolvedValue({ ok: true });
  EmailTemplates.sendTemplate.mockResolvedValue({
    sent: true,
    message: { provider_message_id: 'sg-1', sent_at: '2026-05-26T14:00:00.000Z' },
  });
  smsTemplates.getTemplate.mockResolvedValue('invoice follow-up sms');
  ContactPolicy.evaluate.mockResolvedValue(ALLOWED);
  ContactLedger.recordContact.mockResolvedValue({ id: 'led-1', metadata: {} });
  ContactLedger.markSendFailed.mockResolvedValue(true);
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

// The EXACT send shape this rail produced before the collections lane — the
// gate-off byte-identical pin asserts full equality against it.
const LP_EXPECTED_SEND = {
  to: '+19415550101',
  body: 'sms body for late_payment_14d',
  channel: 'sms',
  audience: 'customer',
  purpose: 'payment_link',
  customerId: 'cust-1',
  invoiceId: 'inv-1',
  entryPoint: 'late_payment_checker',
  metadata: { original_message_type: 'late_payment' },
};

function armLatePaymentHappyPath() {
  setDbQueues({
    invoices: [chain({ result: [LP_INVOICE] })],
    activity_log: [chain({ first: null }), chain()],
    customers: [chain({ first: LP_CUSTOMER })],
    invoice_followup_sequences: [chain({ first: undefined }), chain({ first: undefined })],
  });
}

describe('late-payment-checker rail', () => {
  test('gate UNSET: policy never consulted, send args byte-identical to the pre-lane shape', async () => {
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
      invoices: [chain({ result: [LP_INVOICE] })],
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
      invoices: [chain({ result: [LP_INVOICE] })],
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
      invoices: [chain({ result: [LP_INVOICE] })],
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

// The EXACT touch-send shape this rail produced before the collections lane.
const FU_EXPECTED_SEND = {
  to: '+19415550101',
  body: 'invoice follow-up sms',
  channel: 'sms',
  audience: 'customer',
  purpose: 'payment_link',
  customerId: 'cust-1',
  invoiceId: 'inv-1',
  entryPoint: 'invoice_followup_sequence',
  metadata: { original_message_type: 'invoice_followup' },
};

const FU_LIVE_SEQ = {
  id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 0,
  next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null,
};

function armFollowupHappyPath({ sequenceUpdate = chain() } = {}) {
  setDbQueues({
    'invoice_followup_sequences as s': [chain({ result: [followupRow()] })],
    customers: [chain({ first: FU_CUSTOMER })],
    invoices: [
      chain({ first: FU_INVOICE }), // claim-txn row lock read
      chain({ first: FU_INVOICE }), // credit path's own invoice read
      chain({ first: FU_INVOICE }), // pre-dun refresh
      chain({ first: FU_INVOICE }), // email-eligibility read
    ],
    notification_prefs: [chain({ first: { email_enabled: true } })],
    customer_interactions: [chain(), chain()],
    invoice_followup_sequences: [
      chain({ first: FU_LIVE_SEQ }), // post-lock revalidation
      chain({ result: 1 }), // touch claim
      sequenceUpdate, // cadence advance
      chain({ result: 1 }), // claim clear
    ],
  });
  return sequenceUpdate;
}

describe('invoice-followups rail', () => {
  test('gate UNSET: policy never consulted, touch-send args byte-identical to the pre-lane shape', async () => {
    armFollowupHappyPath();
    const result = await InvoiceFollowUps.runPending();
    expect(ContactPolicy.evaluate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0]).toEqual(FU_EXPECTED_SEND);
    expect(result).toEqual({ sent: 1, skipped: 0 });
  });

  test("gate 'true' + both channels denied: no sends, no ledger rows, sequence left armed (not paused) for a later run", async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue(DENIED);
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow()] })],
      customers: [chain({ first: FU_CUSTOMER })],
      invoices: [chain({ first: FU_INVOICE })], // claim-txn row lock read only
      invoice_followup_sequences: [
        chain({ first: FU_LIVE_SEQ }),
        chain({ result: 1 }), // touch claim
        chain({ result: 1 }), // claim clear (finally)
      ],
    });
    await InvoiceFollowUps.runPending();
    expect(ContactPolicy.evaluate).toHaveBeenCalledWith('cust-1', expect.objectContaining({ channel: 'sms' }));
    expect(ContactPolicy.evaluate).toHaveBeenCalledWith('cust-1', expect.objectContaining({ channel: 'email' }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(smsTemplates.getTemplate).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
    // No cadence advance and no pause happened: the sequence queue's only
    // consumed entries were revalidate/claim/clear (a 4th access would throw).
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
      metadata: { step_id: 'd3_friendly' },
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

  test('LEDGER FAILURE ⇒ NO SENDS, and the sequence is NOT paused (transient hold, retried later)', async () => {
    ContactLedger.recordContact.mockRejectedValue(new Error('ledger down'));
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow()] })],
      customers: [chain({ first: FU_CUSTOMER })],
      invoices: [
        chain({ first: FU_INVOICE }), // claim-txn row lock read
        chain({ first: FU_INVOICE }), // credit path's own invoice read
        chain({ first: FU_INVOICE }), // pre-dun refresh
      ],
      invoice_followup_sequences: [
        chain({ first: FU_LIVE_SEQ }),
        chain({ result: 1 }), // touch claim
        chain({ result: 1 }), // claim clear — NO pause/advance writes in between
      ],
    });
    await InvoiceFollowUps.runPending();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
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

// prb-r18: the email sidecar's consult EXCLUDES the same-run SMS row — the
// any-channel 24h window must not fence a sidecar with its own sibling.
test('the late-payment email sidecar consult carries excludeLedgerIds with the same-run SMS row', async () => {
  process.env.GATE_COLLECTIONS_POLICY = 'true';
  try {
    armLatePaymentHappyPath();
    await LatePaymentChecker.checkAndNotify();
    const emailEval = ContactPolicy.evaluate.mock.calls.find((c) => c[1]?.channel === 'email');
    expect(emailEval).toBeTruthy();
    expect(emailEval[1].excludeLedgerIds).toEqual(['led-1']);
  } finally {
    delete process.env.GATE_COLLECTIONS_POLICY;
  }
});
