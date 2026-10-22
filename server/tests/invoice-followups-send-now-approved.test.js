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
jest.mock('../services/collections/rail-guard', () => ({
  ...jest.requireActual('../services/collections/rail-guard'),
  collectionsChannelPermitted: jest.fn(async ({ detail }) => (detail ? { allowed: true, durable: false } : true)),
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
  autoApplyWouldApply: jest.fn(async () => false),
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
  loadTemplateByKey: jest.fn(async () => ({ template: { template_key: 'invoice.followup_3_day' }, activeVersion: { id: 'v1' } })),
  templateContentHash: jest.fn(() => 'hash-1'),
  renderTemplate: jest.fn(() => ({ subject: 'A friendly reminder', text: 'Hi Taylor, your invoice has a balance.' })),
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
// A bar approval as the card builds it: sequence state, the channel set, the exact text (pay link as a token), the email hash.
const { approvalDigest } = require('../utils/approval-digest');
const SMS_BODY = 'Hi Taylor, a friendly reminder: [pay link]';
const APPROVED = {
  phoneDigest: approvalDigest('19415550101'), emailDigest: approvalDigest('billing@example.com'), smsDigest: approvalDigest(SMS_BODY),
  sequenceId: SEQ, status: 'active', stepIndex: 0, invoiceUpdatedAtMs: UPDATED.getTime(),
  channels: { sms: true, email: true }, smsBody: SMS_BODY, emailContentHash: 'hash-1', dueCents: 12900,
  // The whole rendered email as the card pinned it (template key, subject, text, content hash).
  emailRenderedDigest: approvalDigest(['invoice.followup_3_day', 'A friendly reminder', 'Hi Taylor, your invoice has a balance.', 'hash-1']),
};

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
    // The send-now claim is released, and no write ever touched the reminder time.
    expect(seqRow().touch_claimed_at).toBeNull();
    expect(writes.filter((w) => w.table === 'invoice_followup_sequences' && 'next_touch_at' in w.patch)).toEqual([]);
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

  test('no phone and no email now (the card had both): nothing is sent and the click is refused as changed', async () => {
    tables.customers[0].phone = null;
    require('../services/customer-contact').getInvoiceEmailRecipients.mockReturnValueOnce([]);
    expect(await sendNow({ approved: APPROVED, report: true })).toMatchObject({ ok: false, reason: 'preview_changed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
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

// A reminder claimed by a send in flight (touch_claimed_at): both orders of a control racing the send.
describe('a control racing a send in flight', () => {
  const ACTIVE = { sequenceId: SEQ, status: 'active', stepIndex: 0 };
  const sequenceWrites = () => writes.filter((w) => w.table === 'invoice_followup_sequences');

  describe('the send claimed first: the bar’s pin refuses while it is in flight', () => {
    beforeEach(() => { seqRow().touch_claimed_at = new Date(); });

    test('pause is refused, nothing written', async () => {
      expect(await Followups.pauseSequence(INV, { reason: 'x', approved: ACTIVE })).toEqual({ previewChanged: true });
      // One conditional UPDATE that matched no row.
      expect(sequenceWrites().every((w) => w.count === 0)).toBe(true);
      expect(seqRow().status).toBe('active');
      expect(seqRow().paused_reason).toBeUndefined();
    });

    test('stop is refused on the first look and on the locked row, before anything is read at Stripe', async () => {
      tables.invoices[0].stripe_payment_intent_id = 'pi_combined';
      expect(await Followups.stopSequence(INV, { reason: 'x', adminId: 'admin-1', approved: ACTIVE })).toEqual({ previewChanged: true });
      // The claim lands between the first look and the lock.
      seqRow().touch_claimed_at = null;
      hooks.onSeqLock = () => { seqRow().touch_claimed_at = new Date(); };
      expect(await Followups.stopSequence(INV, { reason: 'x', adminId: 'admin-1', approved: ACTIVE })).toEqual({ previewChanged: true });
      expect(Stripe.retrievePaymentIntent).not.toHaveBeenCalled();
      expect(sequenceWrites()).toEqual([]);
    });

    test('the page’s pause (no pin) still lands, as it always did', async () => {
      expect(await Followups.pauseSequence(INV, { reason: 'x', adminId: 'admin-1' })).toBeUndefined();
      expect(seqRow().status).toBe('paused');
    });
  });

  describe('the control landed during the send: the send’s progression does not bring the row back', () => {
    test('a pause during the send stays paused with no next time; the touch is still recorded', async () => {
      sendCustomerMessage.mockImplementation(async () => {
        Object.assign(seqRow(), { status: 'paused', paused_reason: 'paying Friday', next_touch_at: null });
        return { sent: true, blocked: false, deliveryOutcome: 'accepted', providerMessageId: 'sms-1' };
      });
      const result = await sendNow({ approved: APPROVED, report: true });
      expect(result.report.legs).toEqual({ sms: { state: 'sent' }, email: { state: 'sent' } });
      expect(seqRow()).toMatchObject({ status: 'paused', paused_reason: 'paying Friday', next_touch_at: null, step_index: 1, touches_sent: 1 });
      expect(seqRow().last_touch_at).toBeInstanceOf(Date);
    });

    test('a stop during the send stays stopped', async () => {
      sendCustomerMessage.mockImplementation(async () => {
        Object.assign(seqRow(), { status: 'stopped', stopped_reason: 'waived', next_touch_at: null });
        return { sent: true, blocked: false, deliveryOutcome: 'accepted', providerMessageId: 'sms-1' };
      });
      await sendNow({ approved: APPROVED, report: true });
      expect(seqRow()).toMatchObject({ status: 'stopped', stopped_reason: 'waived', next_touch_at: null, step_index: 1 });
    });

    test('with no race the row still returns to active with its next time', async () => {
      await sendNow({ approved: APPROVED, report: true });
      expect(seqRow()).toMatchObject({ status: 'active', step_index: 1, touches_sent: 1 });
      expect(seqRow().next_touch_at).toBeInstanceOf(Date);
    });
  });
});

// The card pins the whole email (templateContentHash: every HTML block, wrapper, sender, subject, text body), not only its
// rendered subject and text. The service checks it against the live template before the claim and hands it to sendTemplate.
describe('the card’s email content hash', () => {
  const HASHED = APPROVED;

  test('a matching hash sends, and sendTemplate is handed the hash to enforce at the email send', async () => {
    const result = await sendNow({ approved: HASHED, report: true });
    expect(result.report.legs.email).toEqual({ state: 'sent' });
    expect(EmailTemplates.sendTemplate.mock.calls[0][0]).toMatchObject({ templateKey: 'invoice.followup_3_day', expectedContentHash: 'hash-1' });
  });

  test('an HTML-block edit (the live template hash differs) sends neither channel and puts the reminder time back', async () => {
    EmailTemplates.templateContentHash.mockReturnValueOnce('hash-2');
    const result = await sendNow({ approved: HASHED, report: true });
    expect(result).toMatchObject({ ok: false, reason: 'preview_changed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(seqRow().next_touch_at).toEqual(NEXT);
  });

  test('a template that is gone, or an edit that lands after the early check: the email leg is refused by sendTemplate and reported as skipped', async () => {
    EmailTemplates.sendTemplate.mockRejectedValue(new Error('The reviewed email content changed. Review the message again before sending.'));
    const result = await sendNow({ approved: HASHED, report: true });
    expect(result.report.legs.email).toEqual({ state: 'skipped', reason: 'email_content_changed' });
    EmailTemplates.loadTemplateByKey.mockResolvedValueOnce(null);
    fresh();
    install();
    expect(await sendNow({ approved: HASHED, report: true })).toMatchObject({ ok: false, reason: 'preview_changed' });
  });

  test('a card with no email on it (channels.email false) sends no email, however the customer’s address or the template read now', async () => {
    const result = await sendNow({ approved: { ...APPROVED, channels: { sms: true, email: false }, emailContentHash: null }, report: true });
    expect(result.report.legs).toEqual({ sms: { state: 'sent' }, email: { state: 'skipped', reason: 'not_approved' } });
    expect(EmailTemplates.loadTemplateByKey).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('a card that names the email but carries no hash cannot send it unrestricted: nothing is sent and the time goes back', async () => {
    for (const emailContentHash of [null, '', undefined]) {
      fresh();
      install();
      jest.clearAllMocks();
      expect(await sendNow({ approved: { ...APPROVED, emailContentHash }, report: true })).toMatchObject({ ok: false, reason: 'preview_changed' });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
      expect(seqRow().next_touch_at).toEqual(NEXT);
    }
  });

  test('the page’s call passes no hash to the email send', async () => {
    await sendNow();
    expect(EmailTemplates.sendTemplate.mock.calls[0][0]).not.toHaveProperty('expectedContentHash');
  });
});

// The card carries the exact text and the channel set. The send uses that text as it is (no template re-resolve, so alternate
// wordings or an edit cannot change it) and sends only the channels on the card; recipients are still pinned as digests.
describe('the card’s channels, text and recipients', () => {
  const Templates = require('../routes/admin-sms-templates');

  test('both channels on the card send; the text is the card’s, with the live pay link in place of the token', async () => {
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(result.report.legs).toEqual({ sms: { state: 'sent' }, email: { state: 'sent' } });
    const body = sendCustomerMessage.mock.calls[0][0].body;
    expect(body).toMatch(/^Hi Taylor, a friendly reminder: \S+$/);
    expect(body).not.toContain('[pay link]');
    expect(Templates.getTemplate).not.toHaveBeenCalled();
  });

  test('an edited text template, or one that gained alternate wordings, after the card changes nothing: the approved text goes out', async () => {
    Templates.getTemplate.mockResolvedValue('a completely different wording');
    try {
      await sendNow({ approved: APPROVED, report: true });
      expect(sendCustomerMessage.mock.calls[0][0].body).toMatch(/^Hi Taylor, a friendly reminder: /);
      expect(Templates.getTemplate).not.toHaveBeenCalled();
    } finally {
      Templates.getTemplate.mockResolvedValue('invoice follow-up sms');
    }
  });

  test('a channel that is not on the card is skipped: no text', async () => {
    const result = await sendNow({ approved: { ...APPROVED, channels: { sms: false, email: true }, smsBody: null, smsDigest: null }, report: true });
    expect(result.report.legs).toEqual({ sms: { state: 'skipped', reason: 'not_approved' }, email: { state: 'sent' } });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an approval with no channel, a text with no pay link token, or a text that does not match its digest sends nothing', async () => {
    const broken = [
      { ...APPROVED, channels: {} },
      { ...APPROVED, channels: undefined },
      { ...APPROVED, smsBody: 'Hi Taylor, no link here', smsDigest: approvalDigest('Hi Taylor, no link here') },
      { ...APPROVED, smsBody: `${SMS_BODY} (edited)` },
      { ...APPROVED, smsBody: null },
    ];
    for (const approved of broken) {
      fresh();
      install();
      jest.clearAllMocks();
      expect(await sendNow({ approved, report: true })).toMatchObject({ ok: false, reason: 'preview_changed' });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
      expect(seqRow().next_touch_at).toEqual(NEXT);
    }
  });

  test('a phone changed after the card was shown sends nothing and puts the reminder time back', async () => {
    tables.customers[0].phone = '+19415550199';
    expect(await sendNow({ approved: APPROVED, report: true })).toMatchObject({ ok: false, reason: 'preview_changed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(seqRow().next_touch_at).toEqual(NEXT);
    expect(seqRow().touch_claimed_at).toBeNull();
  });

  test('an email address changed after the card was shown sends nothing', async () => {
    const contact = require('../services/customer-contact');
    contact.getInvoiceEmailRecipients.mockReturnValue([{ email: 'new.address@example.com', name: 'Taylor' }]);
    try {
      expect(await sendNow({ approved: APPROVED, report: true })).toMatchObject({ ok: false, reason: 'preview_changed' });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    } finally {
      contact.getInvoiceEmailRecipients.mockReturnValue([{ email: 'billing@example.com', name: 'Taylor' }]);
    }
  });

  test('the page’s call (no approval) resolves the template itself and is not limited to a channel set', async () => {
    tables.customers[0].phone = '+19415550199';
    await sendNow();
    expect(sendCustomerMessage.mock.calls[0][0].body).toBe('invoice follow-up sms');
  });
});

// An approved send-now takes the claim in the same locked UPDATE that judges its card and never re-arms the reminder, so the
// row is never due and unclaimed (runPending would send that unrestricted). Credit is never drawn on it.
describe('the approved send holds the claim from the start, and draws no credit', () => {
  const Credit = require('../services/customer-credit');

  test('the first write is the claim alone: no re-arm, no status or due-time change, and the claim is held when fireStep takes its locks', async () => {
    const seenAtLock = [];
    hooks.onInvoiceLock = () => seenAtLock.push({ claimed: Boolean(seqRow().touch_claimed_at), next: seqRow().next_touch_at, status: seqRow().status });
    await sendNow({ approved: APPROVED, report: true });
    const first = writes.find((w) => w.table === 'invoice_followup_sequences');
    expect(Object.keys(first.patch).sort()).toEqual(['touch_claimed_at', 'updated_at']);
    expect(seenAtLock.length).toBeGreaterThanOrEqual(2);
    for (const seen of seenAtLock.slice(1)) expect(seen).toEqual({ claimed: true, next: NEXT, status: 'active' });
  });

  test('the page’s call still re-arms the row (past due) as before', async () => {
    await sendNow();
    const first = writes.find((w) => w.table === 'invoice_followup_sequences');
    expect(first.patch).toMatchObject({ status: 'active' });
    expect(first.patch.next_touch_at).toBeInstanceOf(Date);
    expect(first.patch).not.toHaveProperty('touch_claimed_at');
  });

  test('a claim someone else took between the card’s lock and fireStep is not stolen or released: nothing is sent', async () => {
    const other = new Date(Date.now() + 5000);
    let locks = 0;
    hooks.onInvoiceLock = () => { locks += 1; if (locks === 2) seqRow().touch_claimed_at = other; };
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(result.report).toEqual({ notClaimed: true });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(seqRow().touch_claimed_at).toEqual(other);
  });

  test('a refusal before the send releases the claim and leaves the due time alone (changed template, changed phone)', async () => {
    EmailTemplates.templateContentHash.mockReturnValueOnce('hash-2');
    expect(await sendNow({ approved: APPROVED, report: true })).toMatchObject({ ok: false, reason: 'preview_changed' });
    expect(seqRow()).toMatchObject({ touch_claimed_at: null, status: 'active', step_index: 0 });
    expect(seqRow().next_touch_at).toEqual(NEXT);
  });

  test('no account credit is drawn on an approved send; the page’s call still draws it', async () => {
    await sendNow({ approved: APPROVED, report: true });
    expect(Credit.autoApplyAccountCreditIfEnabled).not.toHaveBeenCalled();
    expect(Credit.autoApplyWouldApply).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();
    fresh();
    install();
    await sendNow();
    expect(Credit.autoApplyAccountCreditIfEnabled).toHaveBeenCalledTimes(1);
  });

  test('credit that would apply now refuses the send: nothing is sent, nothing is drawn, the claim is released', async () => {
    Credit.autoApplyWouldApply.mockResolvedValueOnce(true);
    expect(await sendNow({ approved: APPROVED, report: true })).toMatchObject({ ok: false, reason: 'preview_changed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(Credit.autoApplyAccountCreditIfEnabled).not.toHaveBeenCalled();
    expect(seqRow()).toMatchObject({ touch_claimed_at: null, step_index: 0, touches_sent: 0 });
  });

  test('a balance that is not the card’s (credit already applied since) refuses the send', async () => {
    tables.invoices[0].credit_applied = '20';
    await sendNow({ approved: APPROVED, report: true });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(seqRow()).toMatchObject({ touch_claimed_at: null, step_index: 0 });
  });

  test('an approval with no amount sends nothing', async () => {
    const result = await sendNow({ approved: { ...APPROVED, dueCents: undefined }, report: true });
    expect(result).toMatchObject({ ok: false, reason: 'preview_changed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});

// The card pins the whole rendered email, not just the template: the send re-renders with the live greeting, amount and wording
// (the pay link as the card's token) and compares one digest before the email leg.
describe('the card’s rendered email', () => {
  const Library = require('../services/email-template-library');

  test('the send renders the email as the card did and sends', async () => {
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(result.report.legs.email).toEqual({ state: 'sent' });
    const payload = Library.renderTemplate.mock.calls.pop()[0].payload;
    expect(payload).toMatchObject({ first_name: 'Taylor', pay_url: '[pay link]', invoice_number: 'WPC-2099-0001' });
  });

  test('a greeting, amount or wording that renders differently now refuses the email leg; the text still goes (it is its own pin)', async () => {
    Library.renderTemplate.mockReturnValue({ subject: 'A friendly reminder', text: 'Hi Taylor, your invoice has a balance of $109.00.' });
    try {
      const result = await sendNow({ approved: APPROVED, report: true });
      expect(result.report.legs.email).toEqual({ state: 'skipped', reason: 'email_content_changed' });
      expect(Library.sendTemplate).not.toHaveBeenCalled();
    } finally {
      Library.renderTemplate.mockReturnValue({ subject: 'A friendly reminder', text: 'Hi Taylor, your invoice has a balance.' });
    }
  });

  test('a card that names the email but carries no rendered digest cannot send it', async () => {
    for (const emailRenderedDigest of [null, '', undefined]) {
      fresh();
      install();
      jest.clearAllMocks();
      expect(await sendNow({ approved: { ...APPROVED, emailRenderedDigest }, report: true })).toMatchObject({ ok: false, reason: 'preview_changed' });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(Library.sendTemplate).not.toHaveBeenCalled();
    }
  });
});

// A touch that ends before any sender ran reports explicit legs (never an unknown delivery): collections policy denying both
// channels, a customer that is gone, an invoice that became payer-billed. Unknown stays for a sender that ran and was unclear.
describe('pre-send exits report explicit legs', () => {
  const RailGuard = require('../services/collections/rail-guard');
  const denyAll = (durable) => RailGuard.collectionsChannelPermitted.mockImplementation(async ({ detail }) => (detail ? { allowed: false, durable } : false));
  afterEach(() => {
    RailGuard.collectionsChannelPermitted.mockImplementation(async ({ detail }) => (detail ? { allowed: true, durable: false } : true));
  });

  test('collections policy denies both channels (a transient denial): both legs held, nothing sent, no unknown', async () => {
    denyAll(false);
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(result.report.legs).toEqual({ sms: { state: 'held', reason: 'collections_policy_denied' }, email: { state: 'held', reason: 'collections_policy_denied' } });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(seqRow().touch_claimed_at).toBeNull();
  });

  test('a durable denial (suppression, standing) is skipped on both legs', async () => {
    denyAll(true);
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(result.report.legs).toEqual({ sms: { state: 'skipped', reason: 'collections_policy_denied' }, email: { state: 'skipped', reason: 'collections_policy_denied' } });
  });

  test('a customer deleted since the card, and an invoice that became payer-billed, end with skipped legs', async () => {
    tables.customers[0].deleted_at = new Date();
    expect((await sendNow({ approved: APPROVED, report: true })).report.legs.sms).toEqual({ state: 'skipped', reason: 'customer_unavailable' });
    fresh();
    install();
    tables.invoices[0].payer_id = 'payer-1';
    const payer = await sendNow({ approved: APPROVED, report: true });
    expect(payer.report.legs).toEqual({ sms: { state: 'skipped', reason: 'invoice_payer_billed' }, email: { state: 'skipped', reason: 'invoice_payer_billed' } });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a changed card still reports previewChanged, not legs', async () => {
    tables.customers[0].phone = '+19415550199';
    expect(await sendNow({ approved: APPROVED, report: true })).toMatchObject({ ok: false, reason: 'preview_changed' });
  });
});

// The dispute-hold exemption belongs to the Invoices page's own operator Send-now. The bar's approved send never has it, on any
// leg: a hold created after the card was shown stops the policy check, the text and the email.
describe('the approved send has no dispute-hold exemption', () => {
  const RailGuard = require('../services/collections/rail-guard');
  const Holds = require('../services/collections/collection-hold');

  test('the bar: no holdExempt on the policy check or the text, no operator email category, and the email handoff honors a dispute hold', async () => {
    const result = await sendNow({ approved: APPROVED, report: true });
    expect(result.report.legs).toEqual({ sms: { state: 'sent' }, email: { state: 'sent' } });
    for (const [arg] of RailGuard.collectionsChannelPermitted.mock.calls) expect(arg.holdExempt).toBeUndefined();
    const text = sendCustomerMessage.mock.calls[0][0];
    expect(text.operatorInitiated).toBe(true);
    expect(text).not.toHaveProperty('holdExempt');
    const email = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(email.categories).not.toContain(Holds.OPERATOR_INITIATED_EMAIL_CATEGORY);
    // A dispute hold that appears before the provider handoff stops the email: the handoff asks without ignoring it.
    Holds.messagingHeldByCollectionHold.mockResolvedValueOnce({ held: true, reasons: ['dispute'] });
    const dispatch = jest.fn();
    const outcome = await email.withProviderHandoff(dispatch);
    expect(Holds.messagingHeldByCollectionHold).toHaveBeenLastCalledWith('cust-1', expect.anything(), { ignoreDisputeHold: false });
    expect(outcome.ok).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('a dispute hold standing at the policy check holds both legs of the bar’s send (it is not exempt)', async () => {
    RailGuard.collectionsChannelPermitted.mockImplementation(async ({ detail, holdExempt }) => (detail ? { allowed: holdExempt === 'operator', durable: false, hold: true } : holdExempt === 'operator'));
    try {
      const result = await sendNow({ approved: APPROVED, report: true });
      expect(result.report.legs).toEqual({ sms: { state: 'held', reason: 'collections_policy_denied' }, email: { state: 'held', reason: 'collections_policy_denied' } });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      // The page's own Send-now keeps the exemption.
      fresh();
      install();
      jest.clearAllMocks();
      sendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, deliveryOutcome: 'accepted', providerMessageId: 'sms-1' });
      await sendNow();
      expect(sendCustomerMessage.mock.calls[0][0].holdExempt).toBe('operator');
      expect(EmailTemplates.sendTemplate.mock.calls[0][0].categories).toContain(Holds.OPERATOR_INITIATED_EMAIL_CATEGORY);
      const [pageEmail] = EmailTemplates.sendTemplate.mock.calls[0];
      Holds.messagingHeldByCollectionHold.mockResolvedValueOnce({ held: false });
      await pageEmail.withProviderHandoff(jest.fn());
      expect(Holds.messagingHeldByCollectionHold).toHaveBeenLastCalledWith('cust-1', expect.anything(), { ignoreDisputeHold: true });
    } finally {
      RailGuard.collectionsChannelPermitted.mockImplementation(async ({ detail }) => (detail ? { allowed: true, durable: false } : true));
    }
  });
});
