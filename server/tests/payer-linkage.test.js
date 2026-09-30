/**
 * Codex round-28 P1 (PR #5331): ONE payer-linkage predicate (services/payer-linkage.js, extracted verbatim from
 * routes/billing-v2.js) decides whose money a payments row is — for the customer portal history AND the SMS
 * facts / authoritative payment history. A row is payer-linked through ANY of: metadata.invoice_id, the legacy
 * aliases (dispute_invoice_id / waves_invoice_id), the PaymentIntent id, the charge id, the "Invoice <n> —"
 * description, where the payer invoice is payer_id OR the payer_billed: withdrawal stamp.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const { buildPayerLinkage, loadPayerLinkage } = require('../services/payer-linkage');
const { loadPaymentHistory } = require('../services/payment-history');

const PAYER_INV = { id: '11111111-1111-4111-8111-111111111111', stripe_payment_intent_id: 'pi_ap', stripe_charge_id: 'ch_ap', invoice_number: 'WPC-2026-0500' };
const linkage = buildPayerLinkage([PAYER_INV]);
const own = { id: 'p-own', amount: 50, status: 'paid', payment_date: '2026-09-10', metadata: { invoice_id: '99999999-9999-4999-8999-999999999999' }, description: 'Invoice WPC-2026-0001 — card' };

const LINKED = {
  'metadata.invoice_id (object)': { id: 'p1', metadata: { invoice_id: PAYER_INV.id } },
  'metadata.invoice_id (JSON string)': { id: 'p2', metadata: JSON.stringify({ invoice_id: PAYER_INV.id }) },
  'metadata.dispute_invoice_id alias': { id: 'p3', metadata: { dispute_invoice_id: PAYER_INV.id } },
  'metadata.waves_invoice_id alias': { id: 'p4', metadata: { waves_invoice_id: PAYER_INV.id } },
  'Stripe PaymentIntent id': { id: 'p5', stripe_payment_intent_id: 'pi_ap', metadata: null },
  'Stripe charge id': { id: 'p6', stripe_charge_id: 'ch_ap', metadata: null },
  'invoice-number description': { id: 'p7', description: 'Invoice WPC-2026-0500 — zelle', metadata: null },
};

describe('isPayerLinked recognizes every linkage', () => {
  test.each(Object.entries(LINKED))('%s', (name, row) => {
    expect(linkage.isPayerLinked(row)).toBe(true);
  });
  test('a homeowner\'s own row is not payer-linked (different ids / intent / number)', () => {
    expect(linkage.isPayerLinked(own)).toBe(false);
    expect(linkage.isPayerLinked({ ...own, stripe_payment_intent_id: 'pi_own', stripe_charge_id: 'ch_own' })).toBe(false);
    expect(linkage.isPayerLinked({ id: 'x', metadata: 'not json', description: null })).toBe(false);
  });
  test('no payer invoices => nothing is payer-linked', () => {
    expect(buildPayerLinkage([]).isPayerLinked({ metadata: { invoice_id: PAYER_INV.id }, stripe_payment_intent_id: 'pi_ap' })).toBe(false);
  });
});

describe('the payer-invoice lookup includes the WITHDRAWAL stamp (payer_billed:), not only payer_id', () => {
  test('query shape: customer-scoped, payer_id NOT NULL OR scheduled_send_error LIKE payer_billed:%, selects the four linkage columns', async () => {
    const calls = [];
    const q = {};
    q.where = jest.fn((arg) => { calls.push(['where', typeof arg === 'function' ? 'fn' : arg]); if (typeof arg === 'function') arg.call(q); return q; });
    q.whereNotNull = jest.fn((c) => { calls.push(['whereNotNull', c]); return q; });
    q.orWhere = jest.fn((...a) => { calls.push(['orWhere', ...a]); return q; });
    q.select = jest.fn((...c) => { calls.push(['select', ...c]); return q; });
    q.catch = jest.fn(() => Promise.resolve([PAYER_INV]));
    const dbh = jest.fn(() => q);
    const out = await loadPayerLinkage('c1', dbh);
    expect(out.failed).toBe(false);
    expect(calls).toEqual([
      ['where', { customer_id: 'c1' }], ['where', 'fn'], ['whereNotNull', 'payer_id'],
      ['orWhere', 'scheduled_send_error', 'like', 'payer_billed:%'],
      ['select', 'id', 'stripe_payment_intent_id', 'stripe_charge_id', 'invoice_number'],
    ]);
    expect(out.isPayerLinked({ metadata: { invoice_id: PAYER_INV.id } })).toBe(true);
  });
  test('a failed lookup is reported (ownership UNKNOWN)', async () => {
    const q = { where: jest.fn(() => q), whereNotNull: jest.fn(() => q), orWhere: jest.fn(() => q), select: jest.fn(() => q), catch: (h) => Promise.resolve(h(new Error('down'))) };
    const out = await loadPayerLinkage('c1', jest.fn(() => q));
    expect(out.failed).toBe(true);
    expect(out.payerInvRows).toEqual([]);
  });
  test('billing-v2 uses the shared service (no second copy of the predicate)', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/billing-v2'), 'utf8');
    expect(src).toMatch(/require\('\.\.\/services\/payer-linkage'\)/);
    expect(src).toMatch(/await loadPayerLinkage\(req\.customerId\)/);
    expect(src).not.toMatch(/const isPayerLinked = /);
  });
});

describe('the authoritative payment history drops payer-linked rows through EVERY linkage', () => {
  function history(rows, opts = {}) {
    const q = {};
    ['where', 'whereNot', 'whereNull', 'whereRaw', 'orderBy', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.then = (res, rej) => Promise.resolve(rows).then(res, rej);
    const inv = {};
    ['where', 'select', 'whereNotNull', 'orWhere'].forEach((m) => { inv[m] = jest.fn(() => inv); });
    inv.catch = (h) => (opts.linkageFails ? Promise.resolve(h(new Error('down'))) : Promise.resolve([PAYER_INV]));
    return jest.fn((table) => (table === 'invoices' ? inv : q));
  }
  test.each(Object.entries(LINKED))('%s', async (name, row) => {
    const out = await loadPaymentHistory('c1', history([{ ...row, amount: 120, status: 'paid' }, own]));
    expect(out.rows.map((r) => r.id)).toEqual(['p-own']);
  });
  test('`complete` reflects the RAW read: dropping payer rows never makes a full read look whole', async () => {
    const raw = Array.from({ length: 201 }, (_, i) => ({ id: `r${i}`, metadata: null }));
    raw[0] = { id: 'ap', stripe_payment_intent_id: 'pi_ap', metadata: null };
    const out = await loadPaymentHistory('c1', history(raw));
    expect(out.complete).toBe(false);
    expect(out.rows.some((r) => r.id === 'ap')).toBe(false);
  });
  test('ownership unknown (linkage lookup failed) => history unknown (null), never an unfiltered read', async () => {
    await expect(loadPaymentHistory('c1', history([own], { linkageFails: true }))).resolves.toBeNull();
  });
});
