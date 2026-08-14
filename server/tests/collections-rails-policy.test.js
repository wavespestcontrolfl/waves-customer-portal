/**
 * Collections policy wiring on the two SMS dunning rails (PR A).
 *
 * Pins:
 *   - GATE_COLLECTIONS_POLICY unset/off ⇒ BYTE-IDENTICAL send behavior on
 *     both rails: the policy module is never consulted and the send args are
 *     exactly the pre-lane shape (asserted with toEqual, not objectContaining).
 *   - Gate on ⇒ a denial skips the send; an allow leaves the send unchanged.
 *   - Both rails ALWAYS write a collections_contact_ledger row (via the
 *     never-throw recordContact) after a delivered touch — gate state
 *     irrelevant — and never for an undelivered one.
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
  evaluate: jest.fn(async () => ({ allowed: true, denialReasons: [] })),
}));
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => true),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const BalanceReminder = require('../services/workflows/balance-reminder');
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
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
}

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
  ContactPolicy.evaluate.mockResolvedValue({ allowed: true, denialReasons: [] });
  ContactLedger.recordContact.mockResolvedValue(true);
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

  test("gate 'true' + denial: reminder skipped, nothing sent", async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue({ allowed: false, denialReasons: ['flag_do_not_text'] });
    setDbQueues({
      invoices: [chain({ result: [LP_INVOICE] })],
      activity_log: [chain({ first: null })],
      customers: [chain({ first: LP_CUSTOMER })],
      invoice_followup_sequences: [chain({ first: undefined }), chain({ first: undefined })],
    });
    const result = await LatePaymentChecker.checkAndNotify();
    expect(ContactPolicy.evaluate).toHaveBeenCalledWith('cust-1', {
      channel: 'sms', purpose: 'late_payment', now: expect.any(Date),
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
    expect(result).toMatchObject({ notified: 0, skipped: 1 });
  });

  test("gate 'true' + allowed: the send is unchanged from the gate-off shape", async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue({ allowed: true, denialReasons: [] });
    armLatePaymentHappyPath();
    await LatePaymentChecker.checkAndNotify();
    expect(sendCustomerMessage.mock.calls[0][0]).toEqual(LP_EXPECTED_SEND);
  });

  test('a delivered SMS reminder writes a ledger row (gate state irrelevant)', async () => {
    armLatePaymentHappyPath();
    await LatePaymentChecker.checkAndNotify();
    expect(ContactLedger.recordContact).toHaveBeenCalledTimes(1);
    expect(ContactLedger.recordContact).toHaveBeenCalledWith({
      customerId: 'cust-1',
      channel: 'sms',
      purpose: 'late_payment',
      invoiceIds: ['inv-1'],
      source: 'late_payment_checker',
      metadata: { tier_days: 14, days_overdue: 16 },
    });
  });

  test('an email-only fallback delivery writes an email-channel ledger row', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'NON_MOBILE' });
    BalanceReminder.sendLatePaymentEmail.mockResolvedValue({ ok: true });
    armLatePaymentHappyPath();
    await LatePaymentChecker.checkAndNotify();
    expect(ContactLedger.recordContact).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'email', purpose: 'late_payment', invoiceIds: ['inv-1'],
    }));
  });

  test('no channel delivered → NO ledger row (only delivered touches count)', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'NON_MOBILE' });
    BalanceReminder.sendLatePaymentEmail.mockResolvedValue({ ok: false, reason: 'missing_email' });
    setDbQueues({
      invoices: [chain({ result: [LP_INVOICE] })],
      activity_log: [chain({ first: null })],
      customers: [chain({ first: LP_CUSTOMER })],
      invoice_followup_sequences: [chain({ first: undefined }), chain({ first: undefined })],
    });
    await LatePaymentChecker.checkAndNotify();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
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

function armFollowupHappyPath() {
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
      chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 0, next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }),
      chain({ result: 1 }), // touch claim
      chain(), // cadence advance
      chain({ result: 1 }), // claim clear
    ],
  });
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

  test("gate 'true' + denial: the touch is skipped before any invoice work, nothing sent", async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue({ allowed: false, denialReasons: ['contact_within_24h'] });
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [followupRow()] })],
    });
    const result = await InvoiceFollowUps.runPending();
    expect(ContactPolicy.evaluate).toHaveBeenCalledWith('cust-1', {
      channel: 'sms', purpose: 'late_payment', now: expect.any(Date),
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, skipped: 1 });
  });

  test("gate 'true' + allowed: the touch fires with the unchanged send shape", async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    ContactPolicy.evaluate.mockResolvedValue({ allowed: true, denialReasons: [] });
    armFollowupHappyPath();
    const result = await InvoiceFollowUps.runPending();
    expect(sendCustomerMessage.mock.calls[0][0]).toEqual(FU_EXPECTED_SEND);
    expect(result).toEqual({ sent: 1, skipped: 0 });
  });

  test('a delivered touch writes a ledger row (gate state irrelevant)', async () => {
    armFollowupHappyPath();
    await InvoiceFollowUps.runPending();
    expect(ContactLedger.recordContact).toHaveBeenCalledTimes(1);
    expect(ContactLedger.recordContact).toHaveBeenCalledWith({
      customerId: 'cust-1',
      channel: 'sms',
      purpose: 'invoice_followup',
      invoiceIds: ['inv-1'],
      source: 'invoice_followups',
      metadata: { step_id: 'd3_friendly', sms_sent: true, email_sent: true },
    });
  });
});
