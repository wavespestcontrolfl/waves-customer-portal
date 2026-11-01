/**
 * A payer text the 8 AM to 8 PM window holds is persisted and replayed (Codex #7357 P2). The automatic send queues one
 * scheduled sms_log row on the existing scheduled-SMS rail; the executor replays it through the registry entry
 * payer_invoice_sms_deferred, whose recheck and dispatch re-run the live send's checks and send under the same episode
 * key. Real sendPayerInvoiceText, real registry entry and real billing text claim (withBillingTextLegLock); the messaging
 * pipeline is a stub that applies the window, a STOP list and the claim around a fake provider; sms_log and the advisory
 * locks are an in-memory fake (the claim's real-database concurrency is billing-text-leg-dedupe-postgres.test.js).
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: () => '+19415550000' }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'portal.wavespestcontrol.com/l/x'),
  invoiceShortCodePrefix: jest.fn(() => 'wpc'),
}));
jest.mock('../services/billing-email-details', () => ({
  invoicePropertyAddress: jest.fn(async () => '123 Palm Ave, Bradenton, FL'),
  invoiceServiceDetails: jest.fn(async () => ({ label: '' })),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { withBillingTextLegLock } = require('../services/messaging/billing-text-leg-dedupe');
const { resolvePolicy } = require('../services/messaging/policy');
const registry = require('../services/messaging/deferred-replay-registry');
const { sendPayerInvoiceText, DEFERRED_ENTRY_POINT } = require('../services/payer-invoice-sms');

const KEY = 'invoice:inv-1:payer_sms:em-1';
const WINDOW_OPEN = '2026-11-04T13:00:00.000Z';
const AP_TO = '+19415550123';
const CUSTOMER_PHONE = '+19415550111';

let rows;
let queued; // scheduled replay rows
let claims; // live claim rows
let accepted; // durable accepted text rows
let heldLocks;
let providerSends;
let windowClosed;
let stopListed;

const tick = () => new Promise((resolve) => setImmediate(resolve));

function smsLogTable() {
  const q = {};
  let kind = 'accepted';
  q.where = (arg) => { if (arg && typeof arg === 'object' && arg.status === 'sending') kind = 'claim'; return q; };
  q.whereIn = (col, values) => { if (col === 'status' && values.includes('scheduled')) kind = 'queue'; return q; };
  q.whereRaw = () => q;
  q.whereNot = () => q;
  q.orderBy = () => q;
  q.first = async () => {
    if (kind === 'queue') return queued.find((r) => ['scheduled', 'sending'].includes(r.status));
    return kind === 'claim' ? claims[0] : accepted[0];
  };
  q.insert = (row) => {
    if (row.status === 'scheduled') {
      queued.push({ ...row, id: `sched-${queued.length + 1}` });
      return Promise.resolve([`sched-${queued.length}`]);
    }
    claims.push({ ...row, id: `claim-${claims.length + 1}` });
    return { returning: async () => [`claim-${claims.length}`] };
  };
  q.del = async () => { claims.length = 0; return 1; };
  q.update = async () => 1;
  return q;
}

function table(name) {
  if (name === 'sms_log') return smsLogTable();
  const q = {};
  q.where = () => q;
  q.first = async () => rows[name];
  return q;
}

function fakeTransaction(callback) {
  const trx = (name) => table(name);
  const held = [];
  trx.raw = async (sql, [key]) => {
    if (String(sql).includes('pg_try_advisory_xact_lock')) {
      if (heldLocks.has(key)) return { rows: [{ locked: false }] };
      heldLocks.add(key); held.push(key);
      return { rows: [{ locked: true }] };
    }
    return {}; // the queue's blocking xact lock: the fake runs one transaction body at a time per await chain
  };
  return Promise.resolve(callback(trx)).finally(() => held.forEach((k) => heldLocks.delete(k)));
}

// What the scheduled-SMS executor hands the registry for a claimed row (scheduler.js replayDispatchMeta).
function claimMetaOf(row) {
  return { ...JSON.parse(row.metadata), scheduled_sms_log_id: row.id, customer_id: row.customer_id, to_phone: row.to_phone };
}

// The executor's order: the registry recheck, then the registered dispatch (never the frozen-body default).
async function executorReplay(row) {
  const meta = claimMetaOf(row);
  const recheck = await registry.recheckDeferredReplay(DEFERRED_ENTRY_POINT, meta);
  if (recheck && recheck.eligible === false) return { recheck };
  const defaultDispatch = jest.fn(async () => { throw new Error('the frozen body must never be sent'); });
  const outcome = await registry.dispatchDeferredReplay(DEFERRED_ENTRY_POINT, meta, defaultDispatch);
  expect(defaultDispatch).not.toHaveBeenCalled();
  return { recheck, outcome };
}

async function holdOne() {
  windowClosed = true;
  const held = await sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-1' });
  windowClosed = false;
  return held;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_PAYER_INVOICE_SMS = 'true';
  queued = []; claims = []; accepted = []; heldLocks = new Set(); providerSends = [];
  windowClosed = false; stopListed = false;
  rows = {
    invoices: { id: 'inv-1', customer_id: 'cust-1', payer_id: 7, payer_statement_id: null, status: 'sending', total: '150.00', credit_applied: 0, amount_paid: 0, token: 'tok', service_type: 'Lawn Care', service_date: null, scheduled_send_error: null },
    payers: { id: 7, display_name: 'Pat Rowe', company_name: null, ap_phone: '(941) 555-0123', active: true },
    customers: { id: 'cust-1', first_name: 'Sam', phone: CUSTOMER_PHONE },
  };
  db.mockImplementation(table);
  db.transaction = jest.fn(fakeTransaction);
  // The pipeline stub: the send window (an office send is exempt), the phone's STOP row, then the claim around a
  // provider send that takes a few ticks and logs the accepted text.
  sendCustomerMessage.mockImplementation(async (input) => {
    if (windowClosed && input.operatorInitiated !== true) {
      return { sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', reason: 'window', deferred: true, nextAllowedAt: WINDOW_OPEN, deliveryOutcome: 'not_sent' };
    }
    if (stopListed) return { sent: false, blocked: true, code: 'SUPPRESSED_OPT_OUT', reason: 'STOP', deliveryOutcome: 'not_sent' };
    return withBillingTextLegLock(input, async () => {
      await tick(); await tick();
      providerSends.push({ to: input.to, key: input.metadata.notificationEventKey });
      accepted.push({ twilio_sid: `SM${'a'.repeat(32)}`, created_at: new Date() });
      return { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}` };
    });
  });
});

afterAll(() => { delete process.env.GATE_PAYER_INVOICE_SMS; });

describe('the hold is persisted', () => {
  test('an automatic send held by the window queues one replay row with the payer purpose and the episode key', async () => {
    await expect(holdOne()).resolves.toMatchObject({ sent: false, code: 'held_for_window', deferred: true, nextAllowedAt: WINDOW_OPEN });
    expect(queued).toHaveLength(1);
    const row = queued[0];
    expect(row).toMatchObject({
      customer_id: 'cust-1', to_phone: AP_TO, status: 'scheduled', message_type: 'payer_invoice', direction: 'outbound',
    });
    expect(row.scheduled_for).toEqual(new Date(WINDOW_OPEN));
    expect(JSON.parse(row.metadata)).toMatchObject({
      entry_point: 'payer_invoice_sms_deferred',
      requires_registered_dispatch: true,
      replay_purpose: 'payer_payment_link',
      notificationEventKey: KEY,
      invoice_id: 'inv-1',
      payer_id: 7,
      payer_ap_phone: '9415550123',
      customer_id: 'cust-1',
      email_message_id: 'em-1',
    });
    expect(providerSends).toHaveLength(0);
  });

  test('a second hold for the same episode does not queue a second row', async () => {
    await holdOne();
    await expect(holdOne()).resolves.toMatchObject({ code: 'held_for_window' });
    expect(queued).toHaveLength(1);
  });

  test('a failed queue write is reported, never thrown', async () => {
    db.transaction = jest.fn(async () => { throw new Error('db down'); });
    await expect(holdOne()).resolves.toMatchObject({ sent: false, code: 'hold_queue_failed' });
  });

  test('an office send is exempt from the window and is never queued', async () => {
    windowClosed = true;
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-1', operatorInitiated: true }))
      .resolves.toMatchObject({ sent: true });
    expect(queued).toHaveLength(0);
    expect(providerSends).toEqual([{ to: AP_TO, key: KEY }]);
  });

  test('an office send that is held anyway is reported, not queued', async () => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', deferred: true, nextAllowedAt: WINDOW_OPEN });
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-1', operatorInitiated: true }))
      .resolves.toMatchObject({ sent: false, code: 'QUIET_HOURS_HOLD', deferred: true });
    expect(queued).toHaveLength(0);
  });
});

describe('the replay', () => {
  test('inside the window it texts the payer AP phone exactly once, under the same key, as a fresh live send', async () => {
    await holdOne();
    sendCustomerMessage.mockClear();
    const { recheck, outcome } = await executorReplay(queued[0]);
    expect(recheck).toEqual({ eligible: true });
    expect(outcome).toMatchObject({ sent: true, deliveryOutcome: 'accepted' });
    expect(providerSends).toEqual([{ to: AP_TO, key: KEY }]);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    const input = sendCustomerMessage.mock.calls[0][0];
    expect(input).toMatchObject({
      to: AP_TO, purpose: 'payer_payment_link', customerId: 'cust-1', invoiceId: 'inv-1', entryPoint: 'payer_invoice_sms',
    });
    expect(input.operatorInitiated).toBeUndefined();
    expect(input.to).not.toBe(CUSTOMER_PHONE);
    expect(input.metadata).toMatchObject({ notificationEventKey: KEY, payer_id: 7, invoice_id: 'inv-1', scheduled_sms_log_id: 'sched-1' });
    expect(input.body).toContain('portal.wavespestcontrol.com/l/x');
  });

  test('the replay purpose keeps the verified STOP read, and a STOP since the hold sends nothing', async () => {
    expect(resolvePolicy('customer', 'payer_payment_link')).toMatchObject({ requireVerifiedSuppression: true });
    await holdOne();
    stopListed = true;
    const { outcome } = await executorReplay(queued[0]);
    expect(outcome).toMatchObject({ sent: false, code: 'SUPPRESSED_OPT_OUT', deliveryOutcome: 'not_sent' });
    expect(providerSends).toHaveLength(0);
  });

  const STALE = [
    ['the invoice was paid', () => { rows.invoices.status = 'paid'; rows.invoices.amount_paid = 150; }, 'payer-text-invoice-not-open'],
    ['the invoice was voided', () => { rows.invoices.status = 'void'; }, 'payer-text-invoice-not-open'],
    ['the invoice moved onto a payer statement', () => { rows.invoices.payer_statement_id = 'st-1'; }, 'payer-text-statement-accrued'],
    ['the payer was deactivated', () => { rows.payers.active = false; }, 'payer-text-payer-inactive'],
    ['the payer AP phone changed', () => { rows.payers.ap_phone = '(941) 555-0199'; }, 'payer-text-payer-phone-changed'],
    ['the AP phone was removed', () => { rows.payers.ap_phone = ''; }, 'payer-text-payer-phone-missing'],
    ['the invoice moved to another payer', () => { rows.invoices.payer_id = 8; rows.payers = { ...rows.payers, id: 8 }; }, 'payer-text-payer-changed'],
    ['the gate is off', () => { process.env.GATE_PAYER_INVOICE_SMS = 'false'; }, 'payer-text-gate-off'],
  ];

  test.each(STALE)('after %s: the recheck drops the row and the dispatch sends nothing', async (_label, change, reason) => {
    await holdOne();
    change();
    const { recheck } = await executorReplay(queued[0]);
    expect(recheck).toEqual({ eligible: false, reason });
    // The dispatch re-runs the same checks on its own fresh read (a change that lands after the recheck).
    const outcome = await registry.dispatchDeferredReplay(DEFERRED_ENTRY_POINT, claimMetaOf(queued[0]), jest.fn());
    expect(outcome).toMatchObject({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'PAYER_TEXT_STALE', retryable: false });
    expect(providerSends).toHaveLength(0);
  });

  test('a failed read holds the row for a retry, never a send', async () => {
    await holdOne();
    db.mockImplementation(() => { throw new Error('db down'); });
    const meta = claimMetaOf(queued[0]);
    await expect(registry.recheckDeferredReplay(DEFERRED_ENTRY_POINT, meta))
      .resolves.toEqual({ eligible: false, reason: 'recheck-failed', retryable: true });
    await expect(registry.dispatchDeferredReplay(DEFERRED_ENTRY_POINT, meta, jest.fn()))
      .resolves.toMatchObject({ sent: false, code: 'PAYER_TEXT_CHECK_FAILED', retryable: true, deliveryOutcome: 'not_sent' });
    expect(providerSends).toHaveLength(0);
  });

  test('two replays of the row send once', async () => {
    await holdOne();
    await executorReplay(queued[0]);
    const { outcome } = await executorReplay(queued[0]);
    expect(outcome).toMatchObject({ sent: true, deduped: true });
    expect(providerSends).toHaveLength(1);
  });

  test('two concurrent replays send once', async () => {
    await holdOne();
    const [a, b] = await Promise.all([executorReplay(queued[0]), executorReplay(queued[0])]);
    expect(providerSends).toHaveLength(1);
    const codes = [a.outcome, b.outcome].map((o) => (o.sent && !o.deduped ? 'sent' : o.code || 'deduped'));
    expect(codes.sort()).toEqual(['BILLING_TEXT_LEG_IN_FLIGHT', 'sent']);
  });

  test('a replay after a live office send of the same episode sends nothing; the reverse order too', async () => {
    await holdOne();
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-1', operatorInitiated: true }))
      .resolves.toMatchObject({ sent: true });
    const { outcome } = await executorReplay(queued[0]);
    expect(outcome).toMatchObject({ sent: true, deduped: true });
    expect(providerSends).toHaveLength(1);

    accepted.length = 0; providerSends.length = 0; queued.length = 0;
    await holdOne();
    await executorReplay(queued[0]);
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-1', operatorInitiated: true }))
      .resolves.toMatchObject({ sent: false, code: 'already_texted' });
    expect(providerSends).toHaveLength(1);
  });

  test('a row with missing replay facts is dropped', async () => {
    await expect(registry.recheckDeferredReplay(DEFERRED_ENTRY_POINT, { invoice_id: 'inv-1', customer_id: 'cust-1' }))
      .resolves.toEqual({ eligible: false, reason: 'payer-text-replay-meta-missing' });
  });
});
