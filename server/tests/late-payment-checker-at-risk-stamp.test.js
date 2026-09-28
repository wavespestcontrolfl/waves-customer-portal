// Sequence-less invoices' at-risk pipeline-stage stamp (dunning
// unification, retire-the-legacy-balance-reminder PR): once the legacy
// balance-reminder's account-level latePaymentCheck() retires
// (GATE_BALANCE_REMINDER_LEGACY_OFF + GATE_DUNNING_LADDER_90), it stops
// stamping pipeline_stage='at_risk' for a 60/90-day-overdue customer. For an
// invoice WITH an invoice_followup_sequences row, the Day 90 ladder's own
// fireTouch picks up that duty (invoice-followups-at-risk-stamp.test.js).
// But a 60/90-day invoice with NO sequence row (orphan adoption,
// GATE_DUNNING_ADOPT_ORPHANS, is dark by default) is never touched by the
// ladder at all — late-payment-checker.js is the only sender left for it,
// so it now shares the SAME markAtRiskForLongOverdue helper for its own
// 60/90-day tiers.
//
// Gated on GATE_BALANCE_REMINDER_LEGACY_OFF (Codex P1, round 3), NOT
// unconditional: this checker reaches customers legacy latePaymentCheck()'s
// own `active`/`waveguard_tier` filters would have excluded (an inactive-
// flagged or non-WaveGuard/flat-commercial account) — an unconditional
// stamp here would flip pipeline_stage for a customer the legacy method
// would never have reached with the gate unset, breaking "unset =
// byte-identical."
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return fn;
});
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  markSendFailed: jest.fn(async () => true),
  markDelivered: jest.fn(async () => true),
  claimAttempt: jest.fn(async () => ({ allowed: true })),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
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
  markAtRiskForLongOverdue: jest.fn(async () => {}),
}));
jest.mock('../services/workflows/balance-reminder', () => ({
  sendLatePaymentEmail: jest.fn(async () => ({ ok: true })),
}));

const db = require('../models/db');
const InvoiceFollowUps = require('../services/invoice-followups');
const LatePaymentChecker = require('../services/late-payment-checker');

function chain({ result = [], first } = {}) {
  const q = {};
  q.where = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q); return q; });
  q.whereIn = jest.fn(() => q);
  q.whereNull = jest.fn(() => q);
  q.whereRaw = jest.fn(() => q);
  q.orderBy = jest.fn(() => q);
  q.whereNot = jest.fn(() => q);
  q.orWhereNot = jest.fn(() => q);
  q.orWhereNull = jest.fn(() => q);
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
      if (table === 'payment_plans') return chain({ first: undefined });
      if (table === 'notification_prefs') return chain({ first: undefined });
      if (table === 'collections_contact_ledger') return chain({ result: [] });
      throw new Error(`Unexpected db table ${table}`);
    }
    return queue.shift();
  });
}

function invoiceRow({ dueDate }) {
  return {
    id: 'inv-1', customer_id: 'cust-1', token: 'token-1', invoice_number: 'WPC-2026-1042',
    status: 'sent', title: 'Quarterly Pest Control', total: '129.00',
    due_date: dueDate, service_date: '2026-01-01', created_at: '2026-01-01T12:00:00.000Z',
  };
}

const customer = { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' };

// activity_log is read THREE times per invoice before any write: the
// dedupe check (`alreadySent`), then — since tierDays !== 7 here — the
// legacy `|7 DAYS`-keyed fallback lookup, before the final insert/marker.

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-05-26T14:00:00.000Z'));
  jest.clearAllMocks();
  process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
  process.env.GATE_DUNNING_LADDER_90 = 'true';
});

afterEach(() => {
  jest.useRealTimers();
  delete process.env.GATE_BALANCE_REMINDER_LEGACY_OFF;
  delete process.env.GATE_DUNNING_LADDER_90;
});

test('a delivered 60-day-overdue invoice with no sequence row stamps at_risk', async () => {
  // due_date 2026-03-20 -> ~67 days overdue by 2026-05-26 => tierDays 60.
  const invoice = invoiceRow({ dueDate: '2026-03-20' });
  setDbQueues({
    invoices: [
      chain({ result: [invoice] }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
    ],
    activity_log: [chain({ first: null }), chain({ result: [] }), chain()],
    customers: [chain({ first: customer })],
  });

  await LatePaymentChecker.checkAndNotify();

  expect(InvoiceFollowUps.markAtRiskForLongOverdue).toHaveBeenCalledWith('cust-1', db);
});

test('a delivered 90-day-overdue invoice with no sequence row stamps at_risk', async () => {
  // due_date 2026-01-15 -> ~131 days overdue by 2026-05-26 => tierDays 90.
  const invoice = invoiceRow({ dueDate: '2026-01-15' });
  setDbQueues({
    invoices: [
      chain({ result: [invoice] }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
    ],
    activity_log: [chain({ first: null }), chain({ result: [] }), chain()],
    customers: [chain({ first: customer })],
  });

  await LatePaymentChecker.checkAndNotify();

  expect(InvoiceFollowUps.markAtRiskForLongOverdue).toHaveBeenCalledWith('cust-1', db);
});

test('a delivered 14-day-overdue invoice does not stamp at_risk', async () => {
  // due_date 2026-05-10 -> 16 days overdue by 2026-05-26 => tierDays 14.
  const invoice = invoiceRow({ dueDate: '2026-05-10' });
  setDbQueues({
    invoices: [
      chain({ result: [invoice] }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
    ],
    activity_log: [chain({ first: null }), chain({ result: [] }), chain()],
    customers: [chain({ first: customer })],
  });

  await LatePaymentChecker.checkAndNotify();

  expect(InvoiceFollowUps.markAtRiskForLongOverdue).not.toHaveBeenCalled();
});

test('no channel reached the customer — 60-day tier does not stamp at_risk (retried next run)', async () => {
  const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
  sendCustomerMessage.mockResolvedValueOnce({
    sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'SUPPRESSED_NON_MOBILE', retryable: false,
  });
  const BalanceReminder = require('../services/workflows/balance-reminder');
  BalanceReminder.sendLatePaymentEmail.mockResolvedValueOnce({ ok: false, skipped: true, reason: 'no_email' });
  const invoice = invoiceRow({ dueDate: '2026-03-20' });
  setDbQueues({
    invoices: [
      chain({ result: [invoice] }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
    ],
    activity_log: [chain({ first: null }), chain({ result: [] }), chain()],
    customers: [chain({ first: customer })],
  });

  const result = await LatePaymentChecker.checkAndNotify();

  expect(result.notified).toBe(0);
  expect(result.emailedFallback).toBe(0);
  expect(InvoiceFollowUps.markAtRiskForLongOverdue).not.toHaveBeenCalled();
});

test('GATE_BALANCE_REMINDER_LEGACY_OFF unset: a delivered 60-day tier does NOT stamp at_risk (byte-identical)', async () => {
  delete process.env.GATE_BALANCE_REMINDER_LEGACY_OFF;
  const invoice = invoiceRow({ dueDate: '2026-03-20' });
  setDbQueues({
    invoices: [
      chain({ result: [invoice] }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
    ],
    activity_log: [chain({ first: null }), chain({ result: [] }), chain()],
    customers: [chain({ first: customer })],
  });

  await LatePaymentChecker.checkAndNotify();

  // Unset (or any non-'true' spelling): this checker's own stamp stays
  // dark — balance-reminder.js's legacy latePaymentCheck() is still the one
  // unconditionally stamping any customer IT reaches.
  expect(InvoiceFollowUps.markAtRiskForLongOverdue).not.toHaveBeenCalled();
});

test('legacy-off without the ladder gate: latePaymentCheck has not retired, so the checker does not stamp either', async () => {
  delete process.env.GATE_DUNNING_LADDER_90;
  const invoice = invoiceRow({ dueDate: '2026-03-20' });
  setDbQueues({
    invoices: [
      chain({ result: [invoice] }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
    ],
    activity_log: [chain({ first: null }), chain({ result: [] }), chain()],
    customers: [chain({ first: customer })],
  });

  await LatePaymentChecker.checkAndNotify();

  expect(InvoiceFollowUps.markAtRiskForLongOverdue).not.toHaveBeenCalled();
});

test('a non-strict spelling on the gate never enables the stamp (strict === "true" only)', async () => {
  process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'TRUE';
  const invoice = invoiceRow({ dueDate: '2026-03-20' });
  setDbQueues({
    invoices: [
      chain({ result: [invoice] }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
      chain({ first: { payer_id: null, scheduled_send_error: null } }),
    ],
    activity_log: [chain({ first: null }), chain({ result: [] }), chain()],
    customers: [chain({ first: customer })],
  });

  await LatePaymentChecker.checkAndNotify();

  expect(InvoiceFollowUps.markAtRiskForLongOverdue).not.toHaveBeenCalled();
});
