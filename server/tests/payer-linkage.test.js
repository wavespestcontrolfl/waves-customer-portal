/**
 * Codex round-28 P1 (PR #5331): ONE payer-linkage predicate (services/payer-linkage.js, extracted verbatim from
 * routes/billing-v2.js) decides whose money a payments row is — for the customer portal history AND the SMS
 * payment facts (the aggregator's recent-payments window and the in-flight probe). A row is payer-linked through ANY of: metadata.invoice_id, the legacy
 * aliases (dispute_invoice_id / waves_invoice_id), the PaymentIntent id, the charge id, the "Invoice <n> —"
 * description, where the payer invoice is payer_id OR the payer_billed: withdrawal stamp.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
// the LIVE linkage (loadLivePayerLinkage — round-41/42) also asks the shared live-ownership verdict; these cases have no live-owned invoices
jest.mock('../services/invoice-payer-ownership', () => ({ liveInvoiceOwnership: jest.fn(async () => ({ ownedIds: new Set(), unverifiable: false })) }));
const { buildPayerLinkage, loadPayerLinkage, loadLivePayerLinkage } = require('../services/payer-linkage');
const { liveInvoiceOwnership } = require('../services/invoice-payer-ownership');

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
  test('query shape: customer-scoped, payer_id NOT NULL OR payer_statement_id NOT NULL OR scheduled_send_error LIKE payer_billed:%, selects the four linkage columns', async () => {
    const calls = [];
    const q = {};
    q.where = jest.fn((arg) => { calls.push(['where', typeof arg === 'function' ? 'fn' : arg]); if (typeof arg === 'function') arg.call(q); return q; });
    q.whereNotNull = jest.fn((c) => { calls.push(['whereNotNull', c]); return q; });
    q.orWhere = jest.fn((...a) => { calls.push(['orWhere', ...a]); return q; });
    q.orWhereNotNull = jest.fn((c) => { calls.push(['orWhereNotNull', c]); return q; });
    q.select = jest.fn((...c) => { calls.push(['select', ...c]); return q; });
    q.catch = jest.fn(() => Promise.resolve([PAYER_INV]));
    const dbh = jest.fn(() => q);
    const out = await loadPayerLinkage('c1', dbh);
    expect(out.failed).toBe(false);
    expect(calls).toEqual([
      ['where', { customer_id: 'c1' }], ['where', 'fn'], ['whereNotNull', 'payer_id'],
      // Codex round-51 P2: a statement-accrued child is payer-owned too
      ['orWhereNotNull', 'payer_statement_id'],
      ['orWhere', 'scheduled_send_error', 'like', 'payer_billed:%'],
      ['select', 'id', 'stripe_payment_intent_id', 'stripe_charge_id', 'invoice_number'],
    ]);
    expect(out.isPayerLinked({ metadata: { invoice_id: PAYER_INV.id } })).toBe(true);
  });
  test('a failed lookup is reported (ownership UNKNOWN)', async () => {
    const q = { where: jest.fn(() => q), whereNotNull: jest.fn(() => q), orWhereNotNull: jest.fn(() => q), orWhere: jest.fn(() => q), select: jest.fn(() => q), catch: (h) => Promise.resolve(h(new Error('down'))) };
    const out = await loadPayerLinkage('c1', jest.fn(() => q));
    expect(out.failed).toBe(true);
    expect(out.payerInvRows).toEqual([]);
  });
  test('the portal payment history (GET /api/billing) uses the shared service (no second copy of the predicate)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/portal-payment-history'), 'utf8');
    expect(src).toMatch(/require\('\.\/payer-linkage'\)/);
    expect(src).toMatch(/await loadPayerLinkage\(customerId\)/);
    expect(src).not.toMatch(/const isPayerLinked = /);
    expect(require('fs').readFileSync(require.resolve('../routes/billing-v2'), 'utf8')).not.toMatch(/const isPayerLinked = /);
  });
  test('a row the ledger stamps as the payer\'s directly (payments.payer_id / metadata.payer_id) is payer-linked', () => {
    const { buildPayerLinkage } = require('../services/payer-linkage');
    const { isPayerLinked } = buildPayerLinkage([]);
    expect(isPayerLinked({ payer_id: 'p1' })).toBe(true);
    expect(isPayerLinked({ metadata: JSON.stringify({ payer_id: 'p1' }) })).toBe(true);
    expect(isPayerLinked({ payer_id: null, metadata: {} })).toBe(false);
  });
});

// Codex round-44 (older thread, judged on 9f0f509): the LIVE ownership scan must be bounded - a mature account may not add hundreds of
// sequential resolver lookups to every inbound draft and send-time billing recheck.
describe('loadLivePayerLinkage is bounded', () => {
  const chain = (reads) => {
    const q = {};
    q.calls = [];
    for (const m of ['where', 'whereNull', 'whereNotNull', 'orWhereNotNull', 'orWhere', 'select', 'orderBy', 'whereRaw']) q[m] = jest.fn((...a) => { if (typeof a[0] === 'function') a[0].call(q); return q; });
    q.limit = jest.fn((n) => { q.limitedTo = n; return q; });
    q.catch = jest.fn(() => Promise.resolve(reads.shift() ?? []));
    return q;
  };
  const invoices = (n) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, customer_id: 'c1', scheduled_service_id: `s${i}`, invoice_number: `WPC-2026-${1000 + i}` }));
  beforeEach(() => liveInvoiceOwnership.mockClear());

  test('reads at most 1000 candidate invoices (limit 1001); more history than that is UNVERIFIABLE (failed) and makes no resolver lookup', async () => {
    const scan = chain([invoices(1001)]);
    const stamped = chain([[]]);
    const dbh = jest.fn().mockReturnValueOnce(stamped).mockReturnValueOnce(scan);
    const out = await loadLivePayerLinkage('c1', dbh);
    expect(scan.limitedTo).toBe(1001);
    expect(out.failed).toBe(true);
    expect(liveInvoiceOwnership).not.toHaveBeenCalled();
  });

  test('within the scan bound the resolver is capped at 30 lookups, and a cap hit is unverifiable (failed)', async () => {
    const scan = chain([invoices(1000)]);
    const dbh = jest.fn().mockReturnValueOnce(chain([[]])).mockReturnValueOnce(scan);
    liveInvoiceOwnership.mockResolvedValueOnce({ ownedIds: new Set(), unverifiable: true });
    const out = await loadLivePayerLinkage('c1', dbh);
    expect(liveInvoiceOwnership).toHaveBeenCalledWith('c1', expect.any(Array), dbh, { maxResolutions: 30, byCandidatePayer: true });
    expect(out.failed).toBe(true);
  });

  // Codex round-48 P2: a long SELF-PAY history never reaches the bound - the scan only reads invoices that can resolve to a payer
  test('the scan reads only invoices with a candidate payer (account default, or the visit names one)', async () => {
    const scan = chain([invoices(5)]);
    const dbh = jest.fn().mockReturnValueOnce(chain([[]])).mockReturnValueOnce(scan);
    await loadLivePayerLinkage('c1', dbh);
    const { LIVE_CANDIDATE_PAYER_SQL } = require('../services/payer-linkage');
    expect(scan.whereRaw).toHaveBeenCalledWith(LIVE_CANDIDATE_PAYER_SQL);
    expect(LIVE_CANDIDATE_PAYER_SQL).toMatch(/customers c WHERE c\.id = invoices\.customer_id AND c\.payer_id IS NOT NULL/);
    expect(LIVE_CANDIDATE_PAYER_SQL).toMatch(/ss\.id = invoices\.scheduled_service_id AND ss\.customer_id = invoices\.customer_id AND ss\.payer_id IS NOT NULL/);
  });

  test('a scan inside both bounds is judged normally', async () => {
    const dbh = jest.fn().mockReturnValueOnce(chain([[]])).mockReturnValueOnce(chain([invoices(5)]));
    const out = await loadLivePayerLinkage('c1', dbh);
    expect(out.failed).toBe(false);
  });
});
