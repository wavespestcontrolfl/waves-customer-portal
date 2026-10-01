/**
 * Codex round-13 P1 (PR #5331): billing.hasProcessingPayment is an authoritative
 * EXISTENCE answer (payment-history.hasInFlightMoney), NOT derived from the
 * 5-row Recent payments display window. Five newer paid rows push an older
 * processing row out of the window; the flag must still be true.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/payment-history', () => ({
  ...jest.requireActual('../services/payment-history'),
  hasInFlightMoney: jest.fn(),
}));
jest.mock('../models/db', () => {
  const windowRows = [1, 2, 3, 4, 5].map((n) => ({
    id: `p${n}`, amount: 40 + n, status: 'paid', payment_date: `2026-09-2${n}`, payer_id: null, metadata: null,
  }));
  const rowsFor = (table, q) => (q && q._failed ? ((db.__rows && db.__rows.failedPayments) || []) : q && q._linkage ? ((db.__rows && db.__rows.payerInvoices) || []) : ((db.__rows && db.__rows[table]) || (table === 'payments' ? windowRows : [])));
  const mk = (table) => {
    const q = {};
    // the aggregator's failed / pending / overdue ledger query (services/failed-payments.js) is the only payments read filtered on status
    q.where = jest.fn(() => q);
    q.whereIn = jest.fn((col, vals) => { if (col === 'status' && Array.isArray(vals) && vals.includes('failed')) q._failed = true; return q; });
    for (const m of ['whereNull', 'whereNot', 'whereNotNull', 'whereRaw', 'orWhere', 'orderBy', 'limit', 'leftJoin', 'join', 'count', 'andWhere', 'whereNotIn', 'modify', 'groupBy', 'distinct']) q[m] = jest.fn(() => q);
    // the shared payer-linkage lookup (services/payer-linkage.js) is the only invoices query that selects stripe_charge_id
    q.select = jest.fn((...cols) => { if (cols.includes('stripe_charge_id')) q._linkage = true; return q; });
    q.first = jest.fn(async () => (table === 'customers' ? { id: 'c1' } : undefined));
    q.catch = jest.fn(() => Promise.resolve(rowsFor(table, q)));
    q.then = (res, rej) => { const r = rowsFor(table, q); return (r instanceof Error ? Promise.reject(r) : Promise.resolve(r)).then(res, rej); };
    return q;
  };
  const queries = [];
  const db = jest.fn((table) => { const q = mk(String(table).split(' ')[0]); queries.push([String(table).split(' ')[0], q]); return q; });
  db.__queries = queries;
  db.raw = jest.fn(async () => ({ rows: [] }));
  db.fn = { now: jest.fn() };
  return db;
});

const aggregator = require('../services/context-aggregator');
const { hasInFlightMoney } = require('../services/payment-history');

const build = async () => {
  const ctx = await aggregator.getContextForCustomer({ id: 'c1', first_name: 'Test', last_name: 'Customer', phone: '+15555550100' });
  return ctx.billing;
};

describe('hasProcessingPayment comes from the existence query, not the display window', () => {
  test('5 newer PAID rows in the window + an older processing row elsewhere => true', async () => {
    hasInFlightMoney.mockResolvedValue(true);
    const billing = await build();
    expect(hasInFlightMoney).toHaveBeenCalledWith('c1');
    expect(billing.recentPayments.every((p) => p.status === 'paid')).toBe(true); // the processing row is NOT in the window
    expect(billing.hasProcessingPayment).toBe(true);
  });

  test('nothing in flight => false', async () => {
    hasInFlightMoney.mockResolvedValue(false);
    expect((await build()).hasProcessingPayment).toBe(false);
  });

  test('an unreadable existence query (null) fails closed as in flight', async () => {
    hasInFlightMoney.mockResolvedValue(null);
    expect((await build()).hasProcessingPayment).toBe(true);
  });
});

// Codex round-15 P1: the capped Recent payments read excludes only an EXPLICIT 'upcoming' row —
// `status <> 'upcoming'` would also drop NULL-status rows (found-but-unknown evidence).
test('the Recent payments query keeps NULL-status rows: (status IS NULL OR status <> upcoming)', async () => {
  const db = require('../models/db');
  db.__queries.length = 0;
  hasInFlightMoney.mockResolvedValue(false);
  await build();
  const q = db.__queries.find(([t]) => t === 'payments')[1];
  expect(q.whereNot.mock.calls.some(([, v]) => v === 'upcoming')).toBe(false);
  const grouped = q.where.mock.calls.map(([a]) => a).find((a) => typeof a === 'function');
  const inner = [];
  const rec = { whereNull: (c) => { inner.push(['whereNull', c]); return rec; }, orWhereNot: (c, v) => { inner.push(['orWhereNot', c, v]); return rec; } };
  grouped.call(rec);
  expect(inner).toEqual([['whereNull', 'payments.status'], ['orWhereNot', 'payments.status', 'upcoming']]);
});

// Codex round-23: ONE collectible-own-invoice predicate (invoice-helpers) drives the balance, open invoice,
// Zelle-target list, invoice-status facts and the payer-billed flag.
describe('collectible own invoices (sent / viewed / overdue; partially_paid flagged separately; withdrawn packet invoices excluded)', () => {
  const db = require('../models/db');
  const inv = (id, number, status, total, over = {}) => ({ id, invoice_number: number, status, total, credit_applied: 0, payer_id: null, scheduled_send_error: null, due_date: null, created_at: `2026-09-2${id.slice(-1)}`, ...over });
  afterEach(() => { delete db.__rows; });
  const billingFor = async (rows) => {
    db.__rows = { invoices: rows, payments: [] };
    hasInFlightMoney.mockResolvedValue(false);
    return build();
  };

  // Codex round-36 P1: the portal's /api/billing/balance sums sent / viewed / overdue only — SMS agrees with that number and
  // FAILS CLOSED on settlement while a partially_paid invoice still has an amount due.
  test('a partially_paid invoice with an amount due is NOT in the balance (the portal omits it) but is flagged, and stays in invoiceStatuses', async () => {
    const billing = await billingFor([inv('i3', 'WPC-2026-0003', 'partially_paid', 100)]);
    expect(billing.outstandingBalance).toBe(0);
    expect(billing.openInvoice).toBeNull();
    expect(billing.openInvoices).toEqual([]);
    expect(billing.hasUncountedPartialDue).toBe(true);
    expect(billing.invoiceStatuses.map((x) => x.status)).toEqual(['partially_paid']);
  });
  test('settlement / zero-balance claims are ungrounded while a partially_paid invoice has an amount due; an unpaid claim about THAT invoice still binds', async () => {
    const { replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');
    const billing = await billingFor([inv('i3', 'WPC-2026-0003', 'partially_paid', 100)]);
    for (const claim of ["You're paid up.", 'Your account is current.', 'You have a $0 balance.', "You don't owe anything."]) {
      expect({ claim, ungrounded: replyQuotesUngroundedAmount(claim, { billing }, { byMeaning: true }) }).toEqual({ claim, ungrounded: true });
    }
    // "Invoice #0003 is still unpaid" binds through the invoice status (partially paid with an amount due => true of it)
    expect(replyQuotesUngroundedAmount('Invoice #0003 is still unpaid.', { billing }, { byMeaning: true, inboundMessage: 'Is invoice 0003 unpaid?' })).toBe(false);
    // ...and a paid invoice (no uncounted partial) still grounds "paid up"
    const clean = await billingFor([inv('i3', 'WPC-2026-0003', 'paid', 100)]);
    expect(clean.hasUncountedPartialDue).toBe(false);
    expect(replyQuotesUngroundedAmount("You're paid up.", { billing: clean }, { byMeaning: true })).toBe(false);
  });
  test('a sent invoice alongside a partially_paid one: the balance is the sent one only (the portal number)', async () => {
    const billing = await billingFor([inv('i2', 'WPC-2026-0002', 'sent', 95), inv('i3', 'WPC-2026-0003', 'partially_paid', 100)]);
    expect(billing.outstandingBalance).toBe(95);
    expect(billing.hasUncountedPartialDue).toBe(true);
  });
  test('a fully credited partially_paid invoice (nothing due) is not an open invoice', async () => {
    const billing = await billingFor([inv('i3', 'WPC-2026-0003', 'partially_paid', 100, { credit_applied: 100 })]);
    expect(billing.outstandingBalance).toBe(0);
    expect(billing.openInvoice).toBeNull();
    expect(billing.openInvoices).toEqual([]);
    expect(billing.hasUncountedPartialDue).toBe(false); // nothing due => nothing uncounted
  });
  test('a packet invoice WITHDRAWN to a payer (status sent, payer_id NULL, payer_billed stamp) is not the homeowner\'s: excluded everywhere', async () => {
    const withdrawn = inv('i4', 'WPC-2026-0123', 'sent', 250, { scheduled_send_error: 'payer_billed:payer-1' });
    const own = inv('i2', 'WPC-2026-0456', 'sent', 95);
    const billing = await billingFor([withdrawn, own]);
    expect(billing.outstandingBalance).toBe(95);
    expect(billing.openInvoice.id).toBe('i2');
    expect(billing.openInvoices.map((x) => x.id)).toEqual(['i2']);
    expect(billing.invoiceStatuses.map((x) => x.id)).toEqual(['i2']); // never "Invoice #0123 is still unpaid"
    expect(billing.payerBilledInvoice).toBe(true); // ...and it flags the payer-billed fact
  });
  test('the Zelle target resolver never picks a withdrawn invoice, and Invoice #0123 is still unpaid is ungrounded (not in the list)', async () => {
    const { resolveZelleTargetInvoice } = require('../services/zelle-target-invoice');
    const { replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');
    const billing = await billingFor([inv('i4', 'WPC-2026-0123', 'sent', 250, { scheduled_send_error: 'payer_billed:payer-1:hold' }), inv('i2', 'WPC-2026-0456', 'sent', 95)]);
    expect(resolveZelleTargetInvoice(billing, 'Can I Zelle invoice WPC-2026-0123?').invoiceId).toBeNull(); // named, but not one of the homeowner's open invoices
    expect(resolveZelleTargetInvoice(billing, 'Can I pay by Zelle?').invoiceId).toBe('i2');
    expect(replyQuotesUngroundedAmount('Invoice #0123 is still unpaid.', { billing }, { byMeaning: true })).toBe(true);
    expect(replyQuotesUngroundedAmount('Invoice #0456 is still unpaid.', { billing }, { byMeaning: true })).toBe(false);
  });
  test('drafts, void and payer-billed rows never count', async () => {
    const billing = await billingFor([inv('i1', 'A-1', 'draft', 50), inv('i2', 'A-2', 'void', 60), inv('i3', 'A-3', 'sent', 70, { payer_id: 'p1' })]);
    expect(billing.outstandingBalance).toBe(0);
    expect(billing.openInvoice).toBeNull();
    expect(billing.invoiceStatuses.map((x) => x.id)).toEqual(['i2']); // void is shown (its status is a fact); draft + payer-billed are not
  });
});

// Codex round-27 P1: the Recent payments read is DETERMINISTIC for same-day attempts.
test('the Recent payments query orders by payment_date, then created_at, then id (all descending)', async () => {
  const db = require('../models/db');
  db.__queries.length = 0;
  hasInFlightMoney.mockResolvedValue(false);
  await build();
  const q = db.__queries.find(([t]) => t === 'payments')[1];
  expect(q.orderBy.mock.calls.map(([col, dir]) => [col, dir])).toEqual([
    ['payments.payment_date', 'desc'], ['payments.created_at', 'desc'], ['payments.id', 'desc'],
  ]);
});

// Codex round-28 P1: the context's payments read uses the SAME payer-linkage predicate as billing-v2 / the history.
describe('recent payments exclude payer-linked rows through every linkage', () => {
  const db = require('../models/db');
  afterEach(() => { delete db.__rows; });
  const payerInv = { id: '11111111-1111-4111-8111-111111111111', stripe_payment_intent_id: 'pi_ap', stripe_charge_id: 'ch_ap', invoice_number: 'WPC-2026-0500' };
  const pay = (id, over = {}) => ({ id, amount: 50, status: 'paid', payment_date: '2026-09-1' + id.slice(-1), payer_id: null, metadata: null, description: null, ...over });
  const mixed = [
    pay('p1', { metadata: { dispute_invoice_id: payerInv.id } }), pay('p2', { stripe_payment_intent_id: 'pi_ap' }), pay('p3', { stripe_charge_id: 'ch_ap' }),
    pay('p4', { description: 'Invoice WPC-2026-0500 — zelle' }), pay('p5', { metadata: JSON.stringify({ waves_invoice_id: payerInv.id }) }), pay('p6', { metadata: { invoice_id: payerInv.id } }),
    pay('p7'), pay('p8'), pay('p9'),
  ];
  test('the display window shows only the homeowner\'s own rows (payer rows are over-fetched past and dropped)', async () => {
    db.__rows = { payments: mixed, invoices: [], payerInvoices: [payerInv] };
    hasInFlightMoney.mockResolvedValue(false);
    const billing = await build();
    expect(billing.recentPayments.map((p) => p.id)).toEqual(['p7', 'p8', 'p9']);
    expect(billing.recentPaymentsTruncated).toBe(false); // only three own rows exist
  });
  test('more than three own rows => truncated', async () => {
    db.__rows = { payments: [...mixed, pay('p10')], invoices: [], payerInvoices: [payerInv] };
    hasInFlightMoney.mockResolvedValue(false);
    const billing = await build();
    expect(billing.recentPayments).toHaveLength(3);
    expect(billing.recentPaymentsTruncated).toBe(true);
  });
  test('the payments query over-fetches (limit 40) so dropped payer rows cannot starve the window', async () => {
    db.__rows = { payments: mixed, invoices: [], payerInvoices: [payerInv] };
    db.__queries.length = 0;
    hasInFlightMoney.mockResolvedValue(false);
    await build();
    const q = db.__queries.find(([t]) => t === 'payments')[1];
    expect(q.limit).toHaveBeenCalledWith(40);
  });
});

// Codex round-28 P2: the Zelle target list is complete well past the old cap of 10, and flagged when it is cut.
describe('openInvoices is not silently capped at 10', () => {
  const db = require('../models/db');
  afterEach(() => { delete db.__rows; });
  const many = (n) => Array.from({ length: n }, (_, i) => ({
    id: `i${i + 1}`, invoice_number: `WPC-2026-${String(i + 1).padStart(4, '0')}`, status: 'sent', total: 100 + i, credit_applied: 0, payer_id: null,
    scheduled_send_error: null, due_date: null, created_at: `2026-09-${String(28 - (i % 27)).padStart(2, '0')}T00:00:00Z`,
  }));
  test('12 open invoices are all listed (the 11th and 12th included), not flagged truncated', async () => {
    db.__rows = { invoices: many(12), payments: [], payerInvoices: [] };
    hasInFlightMoney.mockResolvedValue(false);
    const billing = await build();
    expect(billing.openInvoices).toHaveLength(12);
    expect(billing.openInvoicesTruncated).toBe(false);
  });
  test('beyond the (much higher) cap the list is cut AND flagged', async () => {
    db.__rows = { invoices: many(130), payments: [], payerInvoices: [] };
    hasInFlightMoney.mockResolvedValue(false);
    const billing = await build();
    expect(billing.openInvoices).toHaveLength(100);
    expect(billing.openInvoicesTruncated).toBe(true);
  });
});


// Codex round-35 P1: the grounding balance sums EVERY unsuperseded failed payment (the canonical /api/billing/balance
// query, services/failed-payments.js) — not the 5-row display slice.
describe('standalone failed payments behind the display window still count as owed', () => {
  const db = require('../models/db');
  afterEach(() => { delete db.__rows; });
  const failed = (id, amount, over = {}) => ({ id, amount, status: 'failed', payment_date: '2026-06-01', metadata: null, stripe_payment_intent_id: 'pi_x', retry_count: 1, next_retry_at: null, ...over });
  const billingFor = async (failedPayments, extra = {}) => {
    db.__rows = { invoices: [], payments: undefined, failedPayments, ...extra };
    hasInFlightMoney.mockResolvedValue(false);
    return build();
  };
  test('an old failure behind 5 newer PAID rows is owed: balance > 0 and "your account is current" is ungrounded', async () => {
    const billing = await billingFor([failed('old', 95)]);
    expect(billing.recentPayments.every((p) => p.status === 'paid')).toBe(true); // the failure is NOT in the display window
    expect(billing.outstandingBalance).toBe(95);
    const { replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');
    expect(replyQuotesUngroundedAmount('Your account is current.', { billing }, { byMeaning: true })).toBe(true);
  });
  // main's status set is kept (shared by the admin overdue flag, voice / email context and the "$X overdue" summary)
  test('an old OVERDUE or PENDING payment behind 5 newer paid rows is still owed; the ledger query asks for failed / pending / overdue', async () => {
    db.__queries.length = 0;
    const overdue = await billingFor([failed('od', 60, { status: 'overdue', stripe_payment_intent_id: null })]);
    expect(overdue.recentPayments.every((p) => p.status === 'paid')).toBe(true);
    expect(overdue.outstandingBalance).toBe(60);
    const ledger = db.__queries.map(([, q]) => q).find((q) => q._failed);
    expect(ledger.whereIn).toHaveBeenCalledWith('status', ['failed', 'pending', 'overdue']);
    const pending = await billingFor([failed('pd', 45, { status: 'pending', stripe_payment_intent_id: null })]);
    expect(pending.outstandingBalance).toBe(45);
    const { replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');
    expect(replyQuotesUngroundedAmount("You're paid up.", { billing: overdue }, { byMeaning: true })).toBe(true);
  });
  test('no failure => zero owed and "your account is current" is grounded', async () => {
    const billing = await billingFor([]);
    expect(billing.outstandingBalance).toBe(0);
    const { replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');
    expect(replyQuotesUngroundedAmount('Your account is current.', { billing }, { byMeaning: true })).toBe(false);
  });
  test('the canonical exclusions hold: a never-attempted lock-contention deferral and a payer-linked failure are not owed', async () => {
    const deferral = failed('def', 55, { stripe_payment_intent_id: null, retry_count: 0, next_retry_at: '2026-10-05', metadata: { deferred_reason: 'lock_contention' } });
    expect((await billingFor([deferral])).outstandingBalance).toBe(0);
    const payerInvoice = { id: 'payer-inv', stripe_payment_intent_id: null, stripe_charge_id: null, invoice_number: 'WPC-2026-0900' };
    const linked = failed('lnk', 70, { metadata: { invoice_id: 'payer-inv' } });
    expect((await billingFor([linked], { payerInvoices: [payerInvoice], invoices: [] })).outstandingBalance).toBe(0);
  });
  test('an unreadable failed-payment read makes billing UNAVAILABLE (never a silent zero)', async () => {
    const billing = await billingFor(new Error('boom'));
    expect(billing.unavailable).toBe(true);
    expect(billing.invoiceStatuses).toBeNull();
  });
});
