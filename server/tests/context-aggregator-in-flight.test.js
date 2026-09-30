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
  const rowsFor = (table) => ((db.__rows && db.__rows[table]) || (table === 'payments' ? windowRows : []));
  const mk = (table) => {
    const q = {};
    for (const m of ['where', 'whereNull', 'whereNot', 'whereNotNull', 'whereIn', 'whereRaw', 'orWhere', 'orderBy', 'limit', 'select', 'leftJoin', 'join', 'count', 'andWhere', 'whereNotIn', 'modify', 'groupBy', 'distinct']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'customers' ? { id: 'c1' } : undefined));
    q.catch = jest.fn(() => Promise.resolve(rowsFor(table)));
    q.then = (res, rej) => Promise.resolve(rowsFor(table)).then(res, rej);
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
describe('collectible own invoices (partially_paid included, withdrawn packet invoices excluded)', () => {
  const db = require('../models/db');
  const inv = (id, number, status, total, over = {}) => ({ id, invoice_number: number, status, total, credit_applied: 0, payer_id: null, scheduled_send_error: null, due_date: null, created_at: `2026-09-2${id.slice(-1)}`, ...over });
  afterEach(() => { delete db.__rows; });
  const billingFor = async (rows) => {
    db.__rows = { invoices: rows, payments: [] };
    hasInFlightMoney.mockResolvedValue(false);
    return build();
  };

  test('a partially_paid invoice with an amount due IS the obligation: balance, openInvoice, openInvoices, invoiceStatuses', async () => {
    const billing = await billingFor([inv('i3', 'WPC-2026-0003', 'partially_paid', 100)]);
    expect(billing.outstandingBalance).toBe(100);
    expect(billing.openInvoice).toMatchObject({ id: 'i3', amountDue: 100 });
    expect(billing.openInvoices.map((x) => x.id)).toEqual(['i3']);
    expect(billing.invoiceStatuses.map((x) => x.status)).toEqual(['partially_paid']);
  });
  test("\"You're paid up\" is ungrounded while a partially_paid invoice has an amount due (settlement uses the same obligation)", async () => {
    const { replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');
    const billing = await billingFor([inv('i3', 'WPC-2026-0003', 'partially_paid', 100)]);
    expect(replyQuotesUngroundedAmount("You're paid up.", { billing }, { byMeaning: true })).toBe(true);
    const clean = await billingFor([inv('i3', 'WPC-2026-0003', 'paid', 100)]);
    expect(replyQuotesUngroundedAmount("You're paid up.", { billing: clean }, { byMeaning: true })).toBe(false);
  });
  test('a fully credited partially_paid invoice (nothing due) is not an open invoice', async () => {
    const billing = await billingFor([inv('i3', 'WPC-2026-0003', 'partially_paid', 100, { credit_applied: 100 })]);
    expect(billing.outstandingBalance).toBe(0);
    expect(billing.openInvoice).toBeNull();
    expect(billing.openInvoices).toEqual([]);
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
