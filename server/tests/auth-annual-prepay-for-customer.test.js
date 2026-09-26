/**
 * annualPrepayForCustomer (server/routes/auth.js) — the /api/auth/me
 * "paid-through" badge lookup. Codex round-1 P2: a decided-lapse term
 * (status 'cancelled' AND renewal_decision 'cancel', e.g. a termite annual
 * plan declined online through the portal, slice 6a) must keep showing the
 * badge through its own term_end — the decline only refuses the FUTURE
 * renewal, it does not end the coverage the customer already paid for. A
 * void/refund 'cancelled' row (renewal_decision NULL) must stay excluded.
 *
 * Codex pre-push P1: the decided-lapse SQL branch above is status-only —
 * a declined term whose invoice was later refunded or disputed still
 * reads 'cancelled' + 'cancel'. This file proves the WIRING: every
 * decided-lapse CANDIDATE is re-checked against isPaidDecidedLapseTerm
 * (mocked here — its own real refund/dispute exclusion logic is proven
 * against real Postgres in annual-prepay-decided-lapse-coverage-postgres.test.js)
 * before it is accepted, and a candidate that fails falls through to the
 * next-best one or drops the badge entirely.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockIsPaidDecidedLapseTerm = jest.fn();
jest.mock('../services/annual-prepay-renewals', () => ({
  isPaidDecidedLapseTerm: (...args) => mockIsPaidDecidedLapseTerm(...args),
}));

const db = require('../models/db');
const { _private: { annualPrepayForCustomer } } = require('../routes/auth');

// select(...) resolves to `rows`; the production code always chains a
// .catch() onto it (never .first()), matching how it fetches a bounded
// candidate LIST rather than a single row.
function chainSelecting(rows, { fail = false } = {}) {
  const result = () => (fail ? Promise.reject(new Error('db down')) : Promise.resolve(rows));
  const query = {};
  ['leftJoin', 'where', 'orderByRaw', 'orderBy', 'limit', 'select'].forEach((method) => {
    query[method] = jest.fn(() => query);
  });
  query.then = (ok, bad) => result().then(ok, bad);
  query.catch = (fn) => result().catch(fn);
  return query;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
});

describe('annualPrepayForCustomer', () => {
  test('a live active term is returned as usual — never even asks isPaidDecidedLapseTerm', async () => {
    const row = {
      id: 'term-1', status: 'active', renewal_decision: null, plan_label: 'WaveGuard Bronze Annual Prepay', monthly_rate: null,
      prepay_amount: '450.00', term_start: '2026-09-25', term_end: '2027-09-25', prepay_invoice_id: 'inv-1',
      prepay_invoice_status: 'paid', prepay_invoice_total: 450,
    };
    const query = chainSelecting([row]);
    db.mockReturnValueOnce(query);

    const result = await annualPrepayForCustomer('cust-1');

    expect(result).toEqual(expect.objectContaining({ id: 'term-1', status: 'active' }));
    expect(mockIsPaidDecidedLapseTerm).not.toHaveBeenCalled();
    // The applicable-status predicate is wired in (active/renewal_pending/
    // payment_pending OR the decided-lapse shape) — never a bare whereIn
    // that would drop the decided-lapse OR-branch silently.
    expect(query.where).toHaveBeenCalledWith('apt.customer_id', 'cust-1');
    expect(query.where).toHaveBeenCalledWith(expect.any(Function));
    expect(query.limit).toHaveBeenCalledWith(20);
  });

  test('a decided-lapse candidate still PAID (isPaidDecidedLapseTerm true) returns the badge', async () => {
    const row = {
      id: 'term-1', status: 'cancelled', renewal_decision: 'cancel', plan_label: 'WaveGuard Bronze Annual Prepay',
      monthly_rate: null, prepay_amount: '450.00', term_start: '2026-09-25', term_end: '2027-09-25',
      prepay_invoice_id: 'inv-1', prepay_invoice_status: 'paid', prepay_invoice_total: 450,
    };
    mockIsPaidDecidedLapseTerm.mockResolvedValue(true);
    const query = chainSelecting([row]);
    db.mockReturnValueOnce(query);

    const result = await annualPrepayForCustomer('cust-1');

    expect(result).toEqual(expect.objectContaining({ id: 'term-1', status: 'cancelled' }));
    expect(mockIsPaidDecidedLapseTerm).toHaveBeenCalledWith(expect.objectContaining({ id: 'term-1' }), db);
    // Verify the applicable-status predicate function itself resolves the
    // decided-lapse OR branch correctly against a lightweight fake builder.
    const predicate = query.where.mock.calls.map((args) => args[0]).find((arg) => typeof arg === 'function');
    const seen = [];
    const fakeBuilder = {
      whereIn: jest.fn(() => fakeBuilder),
      orWhere: jest.fn((fn) => { fn.call(fakeBuilder); return fakeBuilder; }),
      where: jest.fn((...args) => { seen.push(args); return fakeBuilder; }),
      andWhere: jest.fn((...args) => { seen.push(args); return fakeBuilder; }),
    };
    predicate.call(fakeBuilder);
    expect(fakeBuilder.whereIn).toHaveBeenCalledWith('apt.status', ['active', 'renewal_pending', 'payment_pending']);
    expect(seen).toEqual(expect.arrayContaining([
      ['apt.status', 'cancelled'],
      ['apt.renewal_decision', 'cancel'],
      ['apt.term_end', '>=', expect.any(String)],
    ]));
  });

  // codex pre-push P1: decline then a refund, or decline then a disputed
  // invoice, both leave the row reading 'cancelled' + 'cancel' — only
  // isPaidDecidedLapseTerm (billing's own live-coverage test) tells them
  // apart from a still-covered decline. Both must drop the badge here.
  test.each([
    ['refunded', { prepay_invoice_status: 'paid' }],
    ['disputed', { prepay_invoice_status: 'overdue' }],
  ])('a decided-lapse candidate that is no longer covered (%s) drops the badge when it is the only candidate', async (_label, extra) => {
    const row = {
      id: 'term-1', status: 'cancelled', renewal_decision: 'cancel', plan_label: 'WaveGuard Bronze Annual Prepay',
      monthly_rate: null, prepay_amount: '450.00', term_start: '2026-09-25', term_end: '2027-09-25',
      prepay_invoice_id: 'inv-1', prepay_invoice_total: 450, ...extra,
    };
    mockIsPaidDecidedLapseTerm.mockResolvedValue(false);
    const query = chainSelecting([row]);
    db.mockReturnValueOnce(query);

    const result = await annualPrepayForCustomer('cust-1');

    expect(result).toBeNull();
    expect(mockIsPaidDecidedLapseTerm).toHaveBeenCalledWith(expect.objectContaining({ id: 'term-1' }), db);
  });

  test('a no-longer-covered decided-lapse candidate falls through to the next-best (older but still active) candidate', async () => {
    const decidedLapse = {
      id: 'term-declined', status: 'cancelled', renewal_decision: 'cancel', term_end: '2027-09-25', prepay_invoice_id: 'inv-1',
    };
    const stillActive = {
      id: 'term-older', status: 'active', renewal_decision: null, term_end: '2026-12-01', prepay_invoice_id: 'inv-0',
    };
    mockIsPaidDecidedLapseTerm.mockResolvedValue(false);
    // ORDER BY ranks 'active' ahead of 'cancelled' regardless of term_end,
    // so the real query would put stillActive first — but this test proves
    // the fallback loop works even when the decided-lapse candidate is
    // examined and rejected, whatever position it lands in.
    const query = chainSelecting([decidedLapse, stillActive]);
    db.mockReturnValueOnce(query);

    const result = await annualPrepayForCustomer('cust-1');

    expect(result).toEqual(expect.objectContaining({ id: 'term-older', status: 'active' }));
    expect(mockIsPaidDecidedLapseTerm).toHaveBeenCalledTimes(1);
  });

  test('no matching term (e.g. only a void/refund cancelled row on file) returns null', async () => {
    const query = chainSelecting([]);
    db.mockReturnValueOnce(query);

    const result = await annualPrepayForCustomer('cust-1');

    expect(result).toBeNull();
    expect(mockIsPaidDecidedLapseTerm).not.toHaveBeenCalled();
  });

  test('no customerId short-circuits without touching the database', async () => {
    const result = await annualPrepayForCustomer(null);
    expect(result).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('a query error is swallowed (logged) rather than thrown', async () => {
    const query = chainSelecting([], { fail: true });
    db.mockReturnValueOnce(query);

    const result = await annualPrepayForCustomer('cust-1');

    expect(result).toBeNull();
  });
});
