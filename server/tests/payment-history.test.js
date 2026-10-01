/**
 * payment-history — authoritative history for absence claims (Codex round-10/11
 * P1, PR #5331): payer exclusion in SQL BEFORE the limit, exact `complete`,
 * lazy loading, fail closed.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const { loadPaymentHistory, ensureAbsenceHistory, PAYMENT_HISTORY_CAP } = require('../services/payment-history');

function fakeDb(rows, { fail = false, payerInvoices = [], linkageFails = false } = {}) {
  const calls = [];
  const q = {};
  ['where', 'whereNot', 'whereNull', 'whereRaw', 'orderBy', 'limit'].forEach((m) => {
    q[m] = jest.fn((...args) => { calls.push([m, args]); return q; });
  });
  q.modify = jest.fn((fn) => { fn(q); return q; });
  q.then = (res, rej) => (fail ? Promise.reject(new Error('db down')) : Promise.resolve(rows)).then(res, rej);
  // the shared payer-linkage lookup (services/payer-linkage.js): the customer's payer-owned invoices
  const inv = {};
  ['where', 'select', 'whereNotNull', 'orWhere'].forEach((m) => { inv[m] = jest.fn(() => inv); });
  inv.catch = (handler) => (linkageFails ? Promise.resolve(handler(new Error('linkage down'))) : Promise.resolve(payerInvoices));
  const dbh = jest.fn((table) => (table === 'invoices' ? inv : q));
  dbh.calls = calls;
  // number of PAYMENTS reads (the linkage lookup is a second, invoices, query)
  dbh.paymentReads = () => dbh.mock.calls.filter(([t]) => t === 'payments').length;
  return dbh;
}

describe('loadPaymentHistory', () => {
  test('excludes payer-billed invoices IN SQL, before the limit; reads cap+1', async () => {
    const dbh = fakeDb([{ id: 1 }]);
    await loadPaymentHistory('c1', dbh);
    const names = dbh.calls.map(([m]) => m);
    expect(names.indexOf('whereRaw')).toBeGreaterThan(-1);
    expect(names.indexOf('whereRaw')).toBeLessThan(names.indexOf('limit'));
    const raw = dbh.calls.find(([m]) => m === 'whereRaw')[1];
    expect(raw[0]).toMatch(/NOT EXISTS \(SELECT 1 FROM invoices i WHERE i\.id = \(CASE WHEN payments\.metadata->>'invoice_id' ~\* '\^\[0-9a-f\]\{8\}[^']*\$' THEN \(payments\.metadata->>'invoice_id'\)::uuid END\) AND i\.customer_id = \? AND i\.payer_id IS NOT NULL\)/);
    // the indexed key is compared as a uuid (never cast to text); the cast sits behind a regex CASE so a malformed value cannot throw
    expect(raw[0]).not.toMatch(/NOT IN|COALESCE|i\.id::text/);
    expect(raw[1]).toEqual(['c1']);
    expect(dbh.calls.find(([m]) => m === 'limit')[1]).toEqual([PAYMENT_HISTORY_CAP + 1]);
    // only an EXPLICIT 'upcoming' row is excluded — NULL-status rows stay (Codex round-15 P1)
    expect(dbh.calls.some(([m, a]) => m === 'whereNot' && a[1] === 'upcoming')).toBe(false);
    // deterministic order for same-day attempts (Codex round-27 P1)
    expect(dbh.calls.filter(([m]) => m === 'orderBy').map(([, a]) => a)).toEqual([['payments.payment_date', 'desc'], ['payments.created_at', 'desc'], ['payments.id', 'desc']]);
    const grouped = dbh.calls.find(([m, a]) => m === 'where' && typeof a[0] === 'function')[1][0];
    const inner = [];
    const rec = { whereNull: (c) => { inner.push(['whereNull', c]); return rec; }, orWhereNot: (c, v) => { inner.push(['orWhereNot', c, v]); return rec; } };
    grouped.call(rec);
    expect(inner).toEqual([['whereNull', 'payments.status'], ['orWhereNot', 'payments.status', 'upcoming']]);
  });

  test('never-attempted collection_hold deferrals are excluded IN SQL, before the limit (Codex round-37 P1)', async () => {
    const dbh = fakeDb([{ id: 1 }]);
    await loadPaymentHistory('c1', dbh);
    const raws = dbh.calls.map(([m, a], i) => [m, a, i]).filter(([m]) => m === 'whereRaw');
    const hold = raws.find(([, a]) => /deferred_reason/.test(a[0]));
    expect(hold).toBeDefined();
    expect(hold[1][0]).toMatch(/^NOT \(/);
    expect(hold[1][1]).toEqual(['collection_hold', 'absorbed_annual_prepay']);
    expect(hold[2]).toBeLessThan(dbh.calls.findIndex(([m]) => m === 'limit'));
  });

  test('never-attempted lock_contention deferrals are excluded IN SQL too, before the limit (Codex round-38 P1)', async () => {
    const dbh = fakeDb([{ id: 1 }]);
    await loadPaymentHistory('c1', dbh);
    const raws = dbh.calls.map(([m, a], i) => [m, a, i]).filter(([m, a]) => m === 'whereRaw' && /deferred_reason/.test(a[0]));
    const lock = raws.find(([, a]) => a[1][0] === 'lock_contention');
    expect(lock).toBeDefined();
    expect(lock[1][0]).toMatch(/^NOT \(/);
    expect(lock[1][0]).toMatch(/stripe_payment_intent_id IS NULL/);
    expect(lock[2]).toBeLessThan(dbh.calls.findIndex(([m]) => m === 'limit'));
  });

  test('complete is exact: <= cap rows complete; cap+1 rows is truncated to cap and incomplete', async () => {
    const few = await loadPaymentHistory('c1', fakeDb(Array.from({ length: 4 }, (_, i) => ({ id: i }))));
    expect(few).toEqual({ rows: expect.any(Array), complete: true });
    expect(few.rows).toHaveLength(4);
    const exactlyCap = await loadPaymentHistory('c1', fakeDb(Array.from({ length: PAYMENT_HISTORY_CAP }, (_, i) => ({ id: i }))));
    expect(exactlyCap.complete).toBe(true);
    const over = await loadPaymentHistory('c1', fakeDb(Array.from({ length: PAYMENT_HISTORY_CAP + 1 }, (_, i) => ({ id: i }))));
    expect(over.complete).toBe(false);
    expect(over.rows).toHaveLength(PAYMENT_HISTORY_CAP);
  });

  test('a failed read returns null (unknown => fail closed); no customer returns null', async () => {
    expect(await loadPaymentHistory('c1', fakeDb([], { fail: true }))).toBeNull();
    expect(await loadPaymentHistory(null, fakeDb([]))).toBeNull();
  });
});

describe('ensureAbsenceHistory (lazy)', () => {
  const ctx = (billing) => ({ customer: { id: 'c1' }, billing });

  test('no read unless the reply makes an ABSENCE claim AND the display window may be truncated', async () => {
    const dbh = fakeDb([{ id: 1 }]);
    const notAbsence = ctx({ recentPayments: [], recentPaymentsTruncated: true });
    await ensureAbsenceHistory(notAbsence, 'See you Tuesday, thanks!', dbh);
    expect(dbh.paymentReads()).toBe(0);
    expect(notAbsence.billing.paymentHistory).toBeUndefined();
    const notTruncated = ctx({ recentPayments: [], recentPaymentsTruncated: false });
    await ensureAbsenceHistory(notTruncated, "Your payment isn't showing yet.", dbh);
    expect(dbh.paymentReads()).toBe(0);
  });

  // Codex round-27 P1: ANY status / receipt claim binds against incomplete rows when the window is truncated.
  test('a receipt / status claim (not only an absence claim) loads the authoritative history when the window is truncated', async () => {
    for (const reply of ['We received your $120 payment from Sep 12.', 'Your payment failed.', 'Your payment settled.', 'Your invoice is paid.']) {
      const dbh = fakeDb([{ id: 1, status: 'paid' }]);
      const c = ctx({ recentPayments: [], recentPaymentsTruncated: true });
      await ensureAbsenceHistory(c, reply, dbh);
      expect({ reply, loaded: c.billing.paymentHistory !== undefined }).toEqual({ reply, loaded: true });
    }
    const dbh = fakeDb([]);
    const notTruncated = ctx({ recentPayments: [], recentPaymentsTruncated: false });
    await ensureAbsenceHistory(notTruncated, 'We received your $120 payment from Sep 12.', dbh);
    expect(dbh.paymentReads()).toBe(0);
  });

  test('an amount-free NEGATED ack ("No payment received.") also loads the authoritative history (Codex round-15 P1)', async () => {
    const dbh = fakeDb([{ id: 1, status: 'paid' }]);
    const denial = ctx({ recentPayments: [], recentPaymentsTruncated: true });
    await ensureAbsenceHistory(denial, 'No payment received.', dbh);
    expect(dbh.paymentReads()).toBe(1);
    expect(denial.billing.paymentHistory.rows).toHaveLength(1);
  });

  test('absence claim + truncated window: loads once, attaches, idempotent', async () => {
    const dbh = fakeDb([{ id: 1, amount: 120 }]);
    const c = ctx({ recentPayments: [], recentPaymentsTruncated: true });
    await ensureAbsenceHistory(c, "Your payment isn't showing on our end yet.", dbh);
    expect(c.billing.paymentHistory).toEqual({ rows: [{ id: 1, amount: 120 }], complete: true });
    await ensureAbsenceHistory(c, "We haven't received it.", dbh);
    expect(dbh.paymentReads()).toBe(1);
  });

  test('a failed load attaches null (validator then rejects)', async () => {
    const c = ctx({ recentPayments: [], recentPaymentsTruncated: true });
    await ensureAbsenceHistory(c, "Your payment isn't showing.", fakeDb([], { fail: true }));
    expect(c.billing.paymentHistory).toBeNull();
  });
});

describe('Codex round-12 P0: payer-owned rows with no invoice_id', () => {
  test('payments.payer_id IS NULL is applied in SQL before the limit', async () => {
    const dbh = fakeDb([{ id: 1 }]);
    await loadPaymentHistory('c1', dbh);
    const names = dbh.calls.map(([m]) => m);
    expect(dbh.calls.some(([m, a]) => m === 'whereNull' && a[0] === 'payments.payer_id')).toBe(true);
    expect(names.indexOf('whereNull')).toBeLessThan(names.indexOf('limit'));
  });
});

describe('Codex round-12 P0: the aggregator\'s Recent payments read excludes payer-owned rows in SQL too', () => {
  test('getContextForCustomer\'s db(\'payments\') display read carries whereNull(\'payments.payer_id\') before its limit', () => {
    const src = require('fs').readFileSync(require.resolve('../services/context-aggregator'), 'utf8');
    const line = src.split('\n').find((l) => /db\('payments'\)\.where\(\{ 'payments\.customer_id': customer\.id \}\)/.test(l));
    expect(line).toBeDefined();
    expect(line).toMatch(/whereNull\('payments\.payer_id'\)/);
    expect(line.indexOf("whereNull('payments.payer_id')")).toBeLessThan(line.indexOf('.limit('));
  });
});

// Codex round-13 P1: hasProcessingPayment is an authoritative EXISTENCE query, not a window read.
describe('hasInFlightMoney', () => {
  const { hasInFlightMoney, IN_FLIGHT_PAYMENTS_SQL, IN_FLIGHT_INVOICE_SQL } = require('../services/payment-history');
  // dbh: the shared payer-linkage lookup (invoices query chain) + two raw reads (candidate payments, processing invoice)
  function flightDb({ candidates = [], invoiceRows = [], payerInvoices = [], linkageFails = false, rawThrows = false } = {}) {
    const inv = {};
    ['where', 'select', 'whereNotNull', 'orWhere'].forEach((m) => { inv[m] = jest.fn(() => inv); });
    inv.catch = (h) => (linkageFails ? Promise.resolve(h(new Error('down'))) : Promise.resolve(payerInvoices));
    const dbh = jest.fn(() => inv);
    dbh.raw = jest.fn(async (sql) => {
      if (rawThrows) throw new Error('db down');
      return { rows: sql === IN_FLIGHT_PAYMENTS_SQL ? candidates : invoiceRows };
    });
    return dbh;
  }
  const APAY = { id: 'ap', stripe_payment_intent_id: 'pi_ap', stripe_charge_id: 'ch_ap', invoice_number: 'WPC-2026-0500' };

  test('two reads: candidate in-flight payments (payer_id NULL, capped) filtered in JS, and a processing invoice (not withdrawn)', () => {
    expect(IN_FLIGHT_PAYMENTS_SQL).toMatch(/FROM payments/);
    expect(IN_FLIGHT_PAYMENTS_SQL).toMatch(/payer_id IS NULL/);
    expect(IN_FLIGHT_PAYMENTS_SQL).toMatch(/IN \('pending', 'processing', 'requires_action'\)/);
    expect(IN_FLIGHT_PAYMENTS_SQL).toMatch(/LIMIT 200/);
    expect(IN_FLIGHT_INVOICE_SQL).toMatch(/FROM invoices/);
    expect(IN_FLIGHT_INVOICE_SQL).toMatch(/payer_id IS NULL AND lower\(status\) = 'processing'/);
    expect(IN_FLIGHT_INVOICE_SQL).toMatch(/scheduled_send_error NOT LIKE 'payer_billed:%'/);
  });
  test('an own in-flight payment => true; nothing => false; a processing own invoice => true', async () => {
    expect(await hasInFlightMoney('c1', flightDb({ candidates: [{ id: 'p1', metadata: null }] }))).toBe(true);
    expect(await hasInFlightMoney('c1', flightDb({}))).toBe(false);
    expect(await hasInFlightMoney('c1', flightDb({ invoiceRows: [{ in_flight: 1 }] }))).toBe(true);
  });
  test('payer-linked in-flight rows do NOT count, through EVERY linkage (not just metadata.invoice_id)', async () => {
    const linked = [
      { id: 'a', metadata: { invoice_id: 'ap' } }, { id: 'b', metadata: { dispute_invoice_id: 'ap' } }, { id: 'c', metadata: { waves_invoice_id: 'ap' } },
      { id: 'd', stripe_payment_intent_id: 'pi_ap' }, { id: 'e', stripe_charge_id: 'ch_ap' }, { id: 'f', description: 'Invoice WPC-2026-0500 — zelle' },
    ];
    for (const row of linked) {
      expect({ id: row.id, r: await hasInFlightMoney('c1', flightDb({ candidates: [row], payerInvoices: [APAY] })) }).toEqual({ id: row.id, r: false });
    }
    // ...while an OWN row alongside them still counts
    expect(await hasInFlightMoney('c1', flightDb({ candidates: [...linked, { id: 'own', metadata: null }], payerInvoices: [APAY] }))).toBe(true);
  });
  test('a FULL candidate read that is entirely payer-linked leaves unseen rows => unknown (null), not "clear"', async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({ id: `x${i}`, stripe_payment_intent_id: 'pi_ap' }));
    expect(await hasInFlightMoney('c1', flightDb({ candidates: full, payerInvoices: [APAY] }))).toBeNull();
  });
  test('a failed read, a failed payer-linkage lookup, or no customer is null (unknown => the aggregator reads it as in flight)', async () => {
    expect(await hasInFlightMoney('c1', flightDb({ rawThrows: true }))).toBeNull();
    expect(await hasInFlightMoney('c1', flightDb({ linkageFails: true }))).toBeNull();
    expect(await hasInFlightMoney(null, flightDb({}))).toBeNull();
  });
});

// Codex round-18 P2: a payment older than the display window reaches the FACTS before the model answers.
describe('surfaceReferencedPayments', () => {
  const { surfaceReferencedPayments } = require('../services/payment-history');
  const older = { id: 'p-old', amount: 120, status: 'paid', payment_date: '2026-06-12', payment_method_type: 'card' };
  const other = { id: 'p-other', amount: 45, status: 'paid', payment_date: '2026-05-01', payment_method_type: 'card' };
  const newest = [1, 2, 3].map((n) => ({ id: `p${n}`, amount: 60 + n, status: 'paid', payment_date: `2026-09-0${n}`, payment_method_type: 'card' }));
  const ctx = (billing) => ({ customer: { id: 'c1' }, billing: { recentPayments: [...newest], recentPaymentsTruncated: true, ...billing } });

  test('a question naming an OLDER payment\'s amount/date puts that row into recentPayments (and only that row)', async () => {
    const context = ctx();
    await surfaceReferencedPayments(context, 'Did you get my $120 payment from June 12?', fakeDb([older, other]));
    expect(context.billing.recentPayments.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p-old']);
    expect(context.billing.paymentHistory.rows).toHaveLength(2); // history stays attached for the absence checks
  });
  test('a tender-only identity matches by tender; a row already shown is not duplicated', async () => {
    const zelle = { id: 'p-z', amount: 90, status: 'paid', payment_date: '2026-05-05', description: 'Invoice INV-9 — zelle' };
    const context = ctx();
    await surfaceReferencedPayments(context, 'Did my Zelle payment go through?', fakeDb([zelle, newest[0], older]));
    expect(context.billing.recentPayments.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p-z']);
  });
  test('no read when the window is not truncated, the message is not about a payment, or it names no identity', async () => {
    const dbh = fakeDb([older]);
    const notTruncated = ctx({ recentPaymentsTruncated: false });
    await surfaceReferencedPayments(notTruncated, 'Did you get my $120 payment from June 12?', dbh);
    await surfaceReferencedPayments(ctx(), 'What time are you coming Tuesday?', dbh);
    await surfaceReferencedPayments(ctx(), 'Did you get my payment?', dbh); // no amount / date / tender
    expect(dbh.paymentReads()).toBe(0);
  });
  test('a failed history read leaves the context untouched (never throws)', async () => {
    const context = ctx();
    await expect(surfaceReferencedPayments(context, 'Did you get my $120 payment from June 12?', fakeDb([], { fail: true }))).resolves.toBe(context);
    expect(context.billing.recentPayments).toHaveLength(3);
  });
});

// Codex round-27 P1: end to end — a truncated window + a receipt / status claim loads the history, and the claim is judged on ALL same-day attempts.
describe('draft/send flow with 4+ same-day attempts', () => {
  const { replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');
  const att = (id, status, created) => ({ id, amount: 120, status, payment_date: '2026-09-12', created_at: created, payment_method_type: 'card' });
  const all = [att('e', 'failed', '2026-09-12T18:00:00Z'), att('d', 'failed', '2026-09-12T17:00:00Z'), att('c', 'failed', '2026-09-12T16:00:00Z'), att('b', 'paid', '2026-09-12T15:00:00Z'), att('a', 'processing', '2026-09-12T14:00:00Z')];
  const truncatedCtx = () => ({ customer: { id: 'c1' }, billing: { outstandingBalance: 0, recentPayments: all.slice(0, 3), recentPaymentsTruncated: true } });
  test('the reply\'s claim triggers the history load and is then ungrounded (ambiguous statuses that day)', async () => {
    const context = truncatedCtx();
    const dbh = fakeDb(all);
    const reply = 'Your $120 card payment from Sep 12 failed.';
    expect(replyQuotesUngroundedAmount(reply, context, { byMeaning: true })).toBe(false); // window only: looks fine
    await ensureAbsenceHistory(context, reply, dbh);
    expect(dbh.paymentReads()).toBe(1);
    expect(replyQuotesUngroundedAmount(reply, context, { byMeaning: true })).toBe(true);
  });
  test('a failed history read (null) leaves the truncated window unusable for binding', async () => {
    const context = truncatedCtx();
    await ensureAbsenceHistory(context, 'Your $120 card payment from Sep 12 failed.', fakeDb([], { fail: true }));
    expect(context.billing.paymentHistory).toBeNull();
    expect(replyQuotesUngroundedAmount('Your $120 card payment from Sep 12 failed.', context, { byMeaning: true })).toBe(true);
  });
});

// Codex round-28 P2: surfaceReferencedPayments keeps the FULL history for validation but shows the model only a few rows.
describe('surfaceReferencedPayments prompt size', () => {
  const { surfaceReferencedPayments } = require('../services/payment-history');
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `z${i}`, amount: 40 + i, status: 'paid', payment_date: `2026-05-${String(28 - (i % 27)).padStart(2, '0')}`, payment_method_type: 'card' }));
  const newest = [1, 2, 3].map((n) => ({ id: `p${n}`, amount: 900 + n, status: 'paid', payment_date: `2026-09-0${n}`, payment_method_type: 'card' }));
  test('a broad identity (just a tender) adds at most 5 rows to the model-facing window; the full history stays attached', async () => {
    const context = { customer: { id: 'c1' }, billing: { recentPayments: [...newest], recentPaymentsTruncated: true } };
    await surfaceReferencedPayments(context, 'Did my card payment go through?', fakeDb([...newest, ...many]));
    expect(context.billing.recentPayments).toHaveLength(3 + 5);
    expect(context.billing.recentPayments.slice(3).map((p) => p.id)).toEqual(['z0', 'z1', 'z2', 'z3', 'z4']); // most recent first (history is date-desc)
    expect(context.billing.paymentHistory.rows).toHaveLength(63); // validation still sees everything
  });
  test('a precise identity still surfaces its row', async () => {
    const context = { customer: { id: 'c1' }, billing: { recentPayments: [...newest], recentPaymentsTruncated: true } };
    await surfaceReferencedPayments(context, 'Did my $77 payment go through?', fakeDb([...newest, ...many]));
    expect(context.billing.recentPayments.slice(3).map((p) => p.amount)).toEqual([77]);
  });
});

describe('isNeverAttemptedDeferral (shared placeholder predicate, Codex round-38 P1)', () => {
  const { isNeverAttemptedDeferral } = require('../services/failed-payments');
  const base = { stripe_payment_intent_id: null, retry_count: 0, next_retry_at: new Date() };
  test('armed lock_contention and collection_hold placeholders are both never-attempted', () => {
    expect(isNeverAttemptedDeferral({ ...base, metadata: { deferred_reason: 'lock_contention' } })).toBe(true);
    expect(isNeverAttemptedDeferral({ ...base, metadata: { deferred_reason: 'collection_hold' } })).toBe(true);
  });
  test('a lock placeholder the retry sweep collected (superseded by another row) is still a placeholder', () => {
    expect(isNeverAttemptedDeferral({ ...base, id: 'a', retry_count: 1, next_retry_at: null, superseded_by_payment_id: 'b', metadata: { deferred_reason: 'lock_contention' } })).toBe(true);
    expect(isNeverAttemptedDeferral({ ...base, id: 'a', retry_count: 1, next_retry_at: null, superseded_by_payment_id: 'a', metadata: { deferred_reason: 'lock_contention' } })).toBe(false);
  });
  test('a row a real attempt touched is not a placeholder', () => {
    expect(isNeverAttemptedDeferral({ ...base, stripe_payment_intent_id: 'pi_x', metadata: { deferred_reason: 'lock_contention' } })).toBe(false);
    expect(isNeverAttemptedDeferral({ ...base, metadata: { type: 'monthly_autopay' } })).toBe(false);
  });
});
