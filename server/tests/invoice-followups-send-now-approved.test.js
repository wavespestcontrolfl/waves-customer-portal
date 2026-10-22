/**
 * sendNextTouchNow with the Intelligence Bar's card pin (`approved`) and per-channel report (`report`).
 *
 *  1. The pin is judged under the invoice row lock and the reminder row lock BEFORE the re-arm and the claim: a pause, a cron
 *     advance, a replaced reminder or an invoice edit after the card sends nothing and re-arms nothing (a pause is never
 *     overwritten by the re-arm), and an edit between the re-arm and the claim puts the reminder time back.
 *  2. The report says what each channel did (sent / already_delivered / held / queued / skipped / not_sent / unknown); step
 *     progression is not delivery.
 *  3. Without `approved` and `report` the call, its writes and its return value are what the Invoices page always got.
 * The db is a small in-memory stand-in; the senders are mocked. Synthetic data only.
 */
jest.mock('../services/collections/collection-hold', () => ({
  ...jest.requireActual('../services/collections/collection-hold'),
  messagingHeldByCollectionHold: jest.fn(async () => ({ held: false })),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/billing-channel-email-authority', () => ({
  loadBillingEmailContext: jest.fn(),
  dispatchUnderBillingEmailAuthority: jest.fn(),
}));
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  markSendFailed: jest.fn(async () => true),
  markDelivered: jest.fn(async () => true),
  claimAttempt: jest.fn(async () => ({ allowed: true })),
  releaseHeldReservation: jest.fn(async () => true),
}));
jest.mock('../services/customer-credit', () => ({
  autoApplyAccountCreditIfEnabled: jest.fn(async () => ({ applied: 0 })),
  reverseAppliedCredit: jest.fn(async () => ({ reversed: 0 })),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(async () => 'invoice follow-up sms') }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'https://portal.example.com/l/inv123'),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false, deliveryOutcome: 'accepted', providerMessageId: 'sms-1' })),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true, message: { provider_message_id: 'sg-1', sent_at: '2099-01-05T14:00:00.000Z' } })),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(() => [{ email: 'billing@example.com', name: 'Taylor' }]),
}));
jest.mock('../services/pay-combined', () => ({
  lockCombinedCustomers: jest.fn(async () => undefined),
  isCombinedPiMetadata: jest.fn(() => true),
  paymentIntentOwnsInvoice: jest.fn(() => true),
  clearPaymentIntentStamps: jest.fn(async () => undefined),
}));
jest.mock('../services/stripe', () => ({
  isInvoiceAwaitingMicrodepositVerification: jest.fn(async () => false),
  retrievePaymentIntent: jest.fn(async () => null),
  cancelPaymentIntent: jest.fn(async () => ({})),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailTemplates = require('../services/email-template-library');
const Followups = require('../services/invoice-followups');
const Stripe = require('../services/stripe');
const PayCombined = require('../services/pay-combined');

const INV = 'inv-1';
const SEQ = 'seq-1';
const NEXT = new Date('2099-01-06T15:00:00Z');
const UPDATED = new Date('2099-01-01T12:00:00.123Z');
const APPROVED = { sequenceId: SEQ, status: 'active', stepIndex: 0, invoiceUpdatedAtMs: UPDATED.getTime() };

let tables;
let hooks;
let writes;
let locks;

function fresh() {
  tables = {
    invoices: [{
      id: INV, customer_id: 'cust-1', status: 'sent', token: 'tok-1', title: 'Quarterly Pest Control', total: '129.00', credit_applied: '0',
      service_date: '2098-12-01', due_date: '2098-12-15', invoice_number: 'WPC-2099-0001', payer_id: null, scheduled_send_error: null,
      stripe_payment_intent_id: null, updated_at: UPDATED, sent_at: '2098-12-01T12:00:00Z', created_at: '2098-12-01T12:00:00Z',
    }],
    customers: [{ id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan', email: 'taylor@example.com', phone: '+19415550101', deleted_at: null }],
    invoice_followup_sequences: [{
      id: SEQ, invoice_id: INV, customer_id: 'cust-1', status: 'active', step_index: 0, touches_sent: 0, next_touch_at: NEXT,
      anchor_at: new Date('2098-12-01T12:00:00Z'), touch_claimed_at: null, last_touch_at: null, created_at: '2098-12-01T12:00:00Z',
    }],
  };
  hooks = {};
  writes = [];
  locks = [];
}

// A small knex stand-in: where(object) filters; update applies (and is recorded); a function-where is ignored (the claim's
// "unclaimed or expired" clause); the joined reminder row is the sequence merged with its invoice.
function makeDb() {
  const make = (rawTable) => {
    const joined = /^invoice_followup_sequences as s$/.test(rawTable);
    const table = joined ? 'invoice_followup_sequences' : rawTable;
    const q = { wheres: [], nulls: [], single: false, forUpdate: false, op: 'select', patch: null };
    const strip = (k) => k.replace(/^s\./, '');
    const matching = () => (tables[table] || []).filter((row) => q.wheres.every((w) => Object.entries(w)
      .every(([k, v]) => String(row[strip(k)]) === String(v))) && q.nulls.every((k) => row[k] == null));
    const compose = (row) => {
      if (!joined) return row;
      const inv = tables.invoices.find((i) => i.id === row.invoice_id);
      return { ...row, invoice_id: inv.id, token: inv.token, title: inv.title, total: inv.total, credit_applied: inv.credit_applied,
        invoice_stripe_pi: inv.stripe_payment_intent_id, service_date: inv.service_date, due_date: inv.due_date, invoice_number: inv.invoice_number };
    };
    const run = () => {
      if (q.op === 'update') {
        const rows = matching();
        rows.forEach((row) => Object.assign(row, q.patch));
        writes.push({ table, patch: q.patch, count: rows.length });
        return rows.length;
      }
      if (q.op === 'insert') { (tables[table] = tables[table] || []).push(q.patch); return [1]; }
      if (q.single) {
        if (q.forUpdate) locks.push(table);
        if (q.forUpdate && table === 'invoice_followup_sequences' && hooks.onSeqLock) hooks.onSeqLock();
        if (q.forUpdate && table === 'invoices' && hooks.onInvoiceLock) hooks.onInvoiceLock(tables.invoices[0]);
        const row = matching()[0];
        return row ? compose(row) : undefined;
      }
      return matching().map(compose);
    };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve().then(run).then(res, rej);
        if (prop === 'catch') return (rej) => Promise.resolve().then(run).catch(rej);
        if (prop === 'where') return (arg) => { if (arg && typeof arg === 'object') q.wheres.push(arg); return b; };
        if (prop === 'whereNull') return (k) => { q.nulls.push(k); return b; };
        if (prop === 'forUpdate') return () => { q.forUpdate = true; return b; };
        if (prop === 'first') return () => { q.single = true; return b; };
        if (prop === 'update') return (patch) => { q.op = 'update'; q.patch = patch; return b; };
        if (prop === 'insert') return (patch) => { q.op = 'insert'; q.patch = patch; return b; };
        if (prop === 'returning') return () => b;
        return () => b;
      },
    });
    return b;
  };
  return make;
}

function install() {
  const make = makeDb();
  db.mockImplementation((table) => make(table));
  db.fn = { now: () => 'NOW' };
  db.raw = jest.fn(async () => ({ rows: [] }));
  db.transaction = jest.fn(async (cb) => {
    const trx = (table) => make(table);
    trx.raw = async () => ({ rows: [] });
    trx.fn = db.fn;
    trx.isTransaction = true;
    return cb(trx);
  });
}

const seqRow = () => tables.invoice_followup_sequences[0];
const sendNow = (opts = {}) => Followups.sendNextTouchNow(INV, { operatorInitiated: true, ...opts });

beforeEach(() => {
  jest.clearAllMocks();
  fresh();
  install();
  sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, deliveryOutcome: 'accepted', providerMessageId: 'sms-1' });
  EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, message: { provider_message_id: 'sg-1', sent_at: '2099-01-05T14:00:00.000Z' } });
});

describe('the card pin is judged under the locks, before the re-arm and the claim', () => {
  test('a matching pin sends once and reports both channels as sent', async () => {
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(result).toEqual({ ok: true, report: { legs: { sms: { state: 'sent' }, email: { state: 'sent' } } } });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    expect(seqRow()).toMatchObject({ step_index: 1, touches_sent: 1 });
  });

  test('a pause that landed after the card is not overwritten by the re-arm, and nothing is sent', async () => {
    seqRow().status = 'paused';
    seqRow().next_touch_at = null;
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(result).toMatchObject({ ok: false, reason: 'preview_changed' });
    expect(seqRow()).toMatchObject({ status: 'paused', next_touch_at: null, step_index: 0 });
    expect(writes.filter((w) => w.table === 'invoice_followup_sequences')).toEqual([]);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test.each([
    ['cron advanced the reminder to the next step', () => { seqRow().step_index = 1; }],
    ['the reminder was replaced', () => { seqRow().id = 'seq-other'; tables.invoice_followup_sequences[0].invoice_id = INV; }],
    ['a send is in flight', () => { seqRow().touch_claimed_at = new Date(); }],
    ['the invoice was edited', () => { tables.invoices[0].updated_at = new Date('2099-01-02T00:00:00Z'); }],
  ])('%s: nothing is sent, nothing is re-armed', async (_label, mutate) => {
    mutate();
    const before = { ...seqRow() };
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(result).toMatchObject({ ok: false, reason: 'preview_changed' });
    expect(seqRow().next_touch_at).toEqual(before.next_touch_at);
    expect(writes.filter((w) => w.table === 'invoice_followup_sequences')).toEqual([]);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('an invoice edit between the re-arm and the claim sends nothing and puts the reminder time back', async () => {
    let locks = 0;
    hooks.onInvoiceLock = (invoice) => { locks += 1; if (locks === 2) invoice.updated_at = new Date('2099-01-02T00:00:00Z'); };
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(result).toMatchObject({ ok: false, reason: 'preview_changed' });
    expect(locks).toBe(2);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(seqRow()).toMatchObject({ status: 'active', step_index: 0, touch_claimed_at: null });
    expect(seqRow().next_touch_at).toEqual(NEXT);
  });

  test('a due-date edit between the re-arm and the claim (rescheduleForInvoiceEdit writes a newer time): nothing is sent and that newer time is kept', async () => {
    const editedNext = new Date('2099-01-20T15:00:00Z');
    let locks = 0;
    hooks.onInvoiceLock = (invoice) => {
      locks += 1;
      if (locks === 2) {
        invoice.updated_at = new Date('2099-01-02T00:00:00Z');
        seqRow().next_touch_at = editedNext; // what rescheduleForInvoiceEdit commits with the edit
      }
    };
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(result).toMatchObject({ ok: false, reason: 'preview_changed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(seqRow()).toMatchObject({ status: 'active', step_index: 0 });
    expect(seqRow().next_touch_at).toEqual(editedNext);
    // The put-back was tried as a conditional write that matched no row.
    const putBack = writes.filter((w) => w.table === 'invoice_followup_sequences' && Object.keys(w.patch).sort().join() === 'next_touch_at,updated_at').pop();
    expect(putBack).toMatchObject({ count: 0 });
  });

  test('a cron advance after the re-arm (the row read sees the next step) sends nothing and leaves cron’s own time alone', async () => {
    const cronNext = new Date('2099-01-13T15:00:00Z');
    const original = db.getMockImplementation();
    let sequenceReads = 0;
    db.mockImplementation((table) => {
      const builder = original(table);
      if (table !== 'invoice_followup_sequences as s') return builder;
      sequenceReads += 1;
      Object.assign(seqRow(), { step_index: 1, next_touch_at: cronNext });
      return builder;
    });
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(sequenceReads).toBe(1);
    expect(result).toMatchObject({ ok: false, reason: 'preview_changed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(seqRow()).toMatchObject({ step_index: 1, next_touch_at: cronNext });
  });
});

describe('the report: per-channel outcomes, never step progression', () => {
  test('email sent, text blocked (opted out): the step advances but the report says the text was not sent', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'CUSTOMER_OPTED_OUT', deliveryOutcome: 'not_sent' });
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(result.report.legs).toEqual({ sms: { state: 'not_sent', reason: 'CUSTOMER_OPTED_OUT' }, email: { state: 'sent' } });
    expect(seqRow().touches_sent).toBe(1);
  });

  test('a leg delivered earlier is "already_delivered" and the step still advances', async () => {
    EmailTemplates.sendTemplate.mockResolvedValue({ deduped: true, sent: true, message: { sent_at: '2099-01-04T14:00:00.000Z' } });
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(result.report.legs.email).toEqual({ state: 'already_delivered' });
    expect(result.report.legs.sms).toEqual({ state: 'sent' });
    expect(seqRow().touches_sent).toBe(1);
  });

  test('an email the provider may have taken is "unknown", never "not sent"', async () => {
    const err = Object.assign(new Error('socket hang up'), { providerOutcome: { deliveryOutcome: 'uncertain' } });
    EmailTemplates.sendTemplate.mockRejectedValue(err);
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(result.report.legs.email).toMatchObject({ state: 'unknown' });
    expect(result.report.legs.sms).toEqual({ state: 'sent' });
  });

  test('a text the sender could not confirm is "unknown"; a text queued for the window is "queued"', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'PROVIDER_TIMEOUT', deliveryOutcome: 'uncertain' });
    expect((await sendNow({ approved: APPROVED, report: true })).report.legs.sms).toEqual({ state: 'unknown', reason: 'PROVIDER_TIMEOUT' });
    fresh();
    install();
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'SEND_WINDOW', deferred: true, nextAllowedAt: '2099-01-06T13:00:00Z', deliveryOutcome: 'not_sent' });
    const queued = await sendNow({ approved: APPROVED, report: true });
    expect(queued.report.legs.sms).toEqual({ state: 'queued', reason: 'send_window' });
    expect(queued.report.legs.email).toEqual({ state: 'sent' });
  });

  test('the sender’s real "delivered earlier" answer ({ sent: true, deduped: true }) is already_delivered, not sent', async () => {
    sendCustomerMessage.mockResolvedValue({
      sent: true, blocked: false, deliveryOutcome: 'accepted', providerMessageId: 'SMold', sentAt: '2099-01-04T14:00:00.000Z',
      deduped: true, channel: 'sms', auditLogId: 'aud-1', segmentCount: 1, encoding: 'GSM-7', sentBody: 'invoice follow-up sms',
    });
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(result.report.legs).toEqual({ sms: { state: 'already_delivered' }, email: { state: 'sent' } });
    // A fresh answer from the same sender (no deduped flag) is still a new send.
    fresh();
    install();
    sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, deliveryOutcome: 'accepted', providerMessageId: 'SMnew', sentAt: '2099-01-05T14:00:00.000Z', channel: 'sms' });
    expect((await sendNow({ approved: APPROVED, report: true })).report.legs.sms).toEqual({ state: 'sent' });
  });

  test('no phone and no email: both legs are skipped, nothing is sent, and the report says so', async () => {
    tables.customers[0].phone = null;
    require('../services/customer-contact').getInvoiceEmailRecipients.mockReturnValueOnce([]);
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(result.report.legs.sms).toEqual({ state: 'skipped', reason: 'no_customer_phone' });
    expect(result.report.legs.email).toEqual({ state: 'skipped', reason: 'missing_email' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});

describe('without the pin and the report, the call is what the page always made', () => {
  test('the page’s call returns nothing, takes no extra locks and writes what it wrote before', async () => {
    expect(await sendNow()).toBeUndefined();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(seqRow()).toMatchObject({ step_index: 1, touches_sent: 1 });
  });

  test('a page click on a paused reminder still re-arms it (the page’s own rule; only the card pin refuses)', async () => {
    seqRow().status = 'paused';
    seqRow().next_touch_at = null;
    await sendNow();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });
});

// The reminder controls (pause / resume / stop) take the same card pin: the reminder id, status and step the card showed.
// Resume and stop judge it on the reminder row locked FOR UPDATE; pause is one conditional UPDATE. A stop (or any other
// change) after the card changes nothing; without the pin the calls are what the page always made.
describe('the reminder controls take the card pin', () => {
  const PIN = { sequenceId: SEQ, status: 'paused', stepIndex: 0 };
  const stoppedBySomeoneElse = () => Object.assign(seqRow(), { status: 'stopped', stopped_reason: 'customer disputed', stopped_by_admin_id: 'admin-2', next_touch_at: null });
  const sequenceWrites = () => writes.filter((w) => w.table === 'invoice_followup_sequences');

  beforeEach(() => Object.assign(seqRow(), { status: 'paused', paused_reason: 'paying Friday', next_touch_at: null }));

  test('resume after a stop that landed since the card: nothing is written, the stop stays', async () => {
    stoppedBySomeoneElse();
    const result = await Followups.resumeSequence(INV, undefined, { approved: PIN });
    expect(result).toEqual({ previewChanged: true });
    expect(sequenceWrites()).toEqual([]);
    expect(seqRow()).toMatchObject({ status: 'stopped', stopped_reason: 'customer disputed', stopped_by_admin_id: 'admin-2' });
  });

  test('resume with a matching pin runs in one transaction on the reminder row locked FOR UPDATE', async () => {
    const result = await Followups.resumeSequence(INV, undefined, { approved: PIN });
    expect(result).toBeUndefined();
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(locks).toContain('invoice_followup_sequences');
    expect(seqRow()).toMatchObject({ status: 'active', paused_reason: null, stopped_reason: null });
    expect(seqRow().next_touch_at).toBeInstanceOf(Date);
  });

  test.each([
    ['the step moved', () => { seqRow().step_index = 1; }],
    ['the reminder was replaced', () => { seqRow().id = 'seq-other'; }],
    ['the reminder is already active', () => { seqRow().status = 'active'; }],
    ['there is no reminder', () => { tables.invoice_followup_sequences = []; }],
  ])('resume: %s — nothing is written', async (_label, mutate) => {
    mutate();
    expect(await Followups.resumeSequence(INV, undefined, { approved: PIN })).toEqual({ previewChanged: true });
    expect(sequenceWrites()).toEqual([]);
  });

  test('resume without the pin is the page’s call: no transaction, no lock, and it still lifts a stop', async () => {
    stoppedBySomeoneElse();
    expect(await Followups.resumeSequence(INV)).toBeUndefined();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(locks).toEqual([]);
    expect(seqRow().status).toBe('active');
  });

  test('pause is a conditional UPDATE on the approved state', async () => {
    const active = { sequenceId: SEQ, status: 'active', stepIndex: 0 };
    seqRow().status = 'active';
    expect(await Followups.pauseSequence(INV, { reason: 'x', adminId: 'admin-1', approved: active })).toBeUndefined();
    expect(seqRow()).toMatchObject({ status: 'paused', paused_reason: 'x' });
    // A stop landed since the card: not overwritten.
    stoppedBySomeoneElse();
    expect(await Followups.pauseSequence(INV, { reason: 'y', approved: active })).toEqual({ previewChanged: true });
    expect(seqRow()).toMatchObject({ status: 'stopped', stopped_reason: 'customer disputed' });
  });

  test('pause without the pin is the page’s call and returns nothing', async () => {
    seqRow().status = 'active';
    expect(await Followups.pauseSequence(INV, { reason: 'x', adminId: 'admin-1' })).toBeUndefined();
    expect(seqRow().status).toBe('paused');
  });

  test('stop judges the pin first and again on the locked row; a mismatch stops nothing', async () => {
    seqRow().status = 'active';
    const active = { sequenceId: SEQ, status: 'active', stepIndex: 0 };
    Object.assign(seqRow(), { status: 'paused' });
    expect(await Followups.stopSequence(INV, { reason: 'waived', adminId: 'admin-1', approved: active })).toEqual({ previewChanged: true });
    expect(sequenceWrites()).toEqual([]);
    // The pin changes between the first look and the locked read (a race inside the transaction).
    seqRow().status = 'active';
    hooks.onSeqLock = () => { seqRow().status = 'paused'; };
    expect(await Followups.stopSequence(INV, { reason: 'waived', adminId: 'admin-1', approved: active })).toEqual({ previewChanged: true });
    expect(seqRow().status).toBe('paused');
    expect(sequenceWrites()).toEqual([]);
  });

  test('stop with a matching pin stops; without the pin it is the page’s call', async () => {
    seqRow().status = 'active';
    expect(await Followups.stopSequence(INV, { reason: 'waived', adminId: 'admin-1', approved: { sequenceId: SEQ, status: 'active', stepIndex: 0 } })).toBeUndefined();
    expect(seqRow()).toMatchObject({ status: 'stopped', stopped_reason: 'waived', stopped_by_admin_id: 'admin-1' });
    seqRow().status = 'paused';
    expect(await Followups.stopSequence(INV, { reason: 'again', adminId: 'admin-1' })).toBeUndefined();
    expect(seqRow().status).toBe('stopped');
  });
});

// stopSequence with the card's pin: the pin is validated on the reminder row locked FOR UPDATE BEFORE anything is read at
// Stripe, and the bar never cancels a combined session (or cleans its stamps) — it stops nothing and leaves it to the page.
describe('stop with the card pin and a combined card session', () => {
  const ACTIVE = { sequenceId: SEQ, status: 'active', stepIndex: 0 };
  const combinedSibling = (status = 'requires_payment_method') => {
    tables.invoices[0].stripe_payment_intent_id = 'pi_combined';
    Stripe.retrievePaymentIntent.mockResolvedValue({ id: 'pi_combined', status, metadata: { waves_invoice_id: 'other-inv' } });
  };

  test('an unconfirmed combined session: the bar refuses (needs the Invoices page), cancels nothing, cleans nothing, stops nothing', async () => {
    combinedSibling();
    const result = await Followups.stopSequence(INV, { reason: 'waived', adminId: 'admin-1', approved: ACTIVE });
    expect(result).toEqual({ needsInvoicesPage: true });
    expect(Stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(PayCombined.clearPaymentIntentStamps).not.toHaveBeenCalled();
    expect(writes.filter((w) => w.table === 'invoice_followup_sequences')).toEqual([]);
    expect(seqRow().status).toBe('active');
  });

  test('a canceled combined session (stamp cleanup owed) is refused the same way', async () => {
    combinedSibling('canceled');
    expect(await Followups.stopSequence(INV, { reason: 'waived', adminId: 'admin-1', approved: ACTIVE })).toEqual({ needsInvoicesPage: true });
    expect(PayCombined.clearPaymentIntentStamps).not.toHaveBeenCalled();
  });

  test('money in flight on the session is not touched, so the stop goes ahead (as the page’s does)', async () => {
    combinedSibling('processing');
    expect(await Followups.stopSequence(INV, { reason: 'waived', adminId: 'admin-1', approved: ACTIVE })).toBeUndefined();
    expect(Stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(seqRow().status).toBe('stopped');
  });

  test('the pin is locked and checked before the PaymentIntent is read: a change after the first look reads nothing at Stripe and writes nothing', async () => {
    combinedSibling();
    hooks.onSeqLock = () => { seqRow().status = 'paused'; };
    const result = await Followups.stopSequence(INV, { reason: 'waived', adminId: 'admin-1', approved: ACTIVE });
    expect(result).toEqual({ previewChanged: true });
    expect(Stripe.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(Stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(PayCombined.clearPaymentIntentStamps).not.toHaveBeenCalled();
    expect(writes.filter((w) => w.table === 'invoice_followup_sequences')).toEqual([]);
  });

  test('without the pin (the page) the combined session is released and the stop lands, as before', async () => {
    combinedSibling();
    expect(await Followups.stopSequence(INV, { reason: 'waived', adminId: 'admin-1' })).toBeUndefined();
    expect(Stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_combined');
    expect(PayCombined.clearPaymentIntentStamps).toHaveBeenCalled();
    expect(seqRow().status).toBe('stopped');
  });
});
