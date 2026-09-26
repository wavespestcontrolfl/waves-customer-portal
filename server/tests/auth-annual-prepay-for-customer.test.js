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
  // The REAL provisional-term rule (pure) — /me must agree with billing.
  coverageAwaitsInstallation: (...args) => jest.requireActual('../services/annual-prepay-renewals').coverageAwaitsInstallation(...args),
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
    const record = (...args) => {
      if (typeof args[0] === 'function') args[0].call(fakeBuilder, fakeBuilder);
      else seen.push(args);
      return fakeBuilder;
    };
    const fakeBuilder = {
      whereIn: jest.fn(() => fakeBuilder),
      orWhere: jest.fn(record),
      where: jest.fn(record),
      andWhere: jest.fn(record),
      whereNotNull: jest.fn((col) => { seen.push(['whereNotNull', col]); return fakeBuilder; }),
      whereNull: jest.fn((col) => { seen.push(['whereNull', col]); return fakeBuilder; }),
    };
    predicate.call(fakeBuilder);
    expect(fakeBuilder.whereIn).toHaveBeenCalledWith('apt.status', ['active', 'renewal_pending', 'payment_pending']);
    expect(seen).toEqual(expect.arrayContaining([
      ['apt.status', 'cancelled'],
      ['apt.renewal_decision', 'cancel'],
      ['apt.term_end', '>=', expect.any(String)],
      // Codex r3 P1: a declined term still awaiting its installation has
      // only a provisional term_end — never cut off by it.
      ['whereNull', 'apt.installation_anchored_at'],
      ['whereNull', 'apt.renewed_from_term_id'],
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

  // Codex r2 P1: billing_mode stays 'annual_prepay' after a portal decline,
  // so the Billing tab reads renewalDeclined / awaitsInstallation from here
  // to stop promising a renewal charge (and to avoid quoting a provisional
  // term_end for a plan still awaiting its station installation).
  test.each([
    ['an undecided, installation-anchored termite term', {
      status: 'active', renewal_decision: null, annual_plan_version: 'v3', installation_anchored_at: '2026-10-14T12:00:00Z',
    }, { renewalDeclined: false, awaitsInstallation: false }],
    ['a paid decline of an anchored termite term', {
      status: 'cancelled', renewal_decision: 'cancel', annual_plan_version: 'v3', installation_anchored_at: '2026-10-14T12:00:00Z',
    }, { renewalDeclined: true, awaitsInstallation: false }],
    ['a paid decline BEFORE installation (provisional term_end)', {
      status: 'cancelled', renewal_decision: 'cancel', annual_plan_version: 'v3', installation_anchored_at: null, renewed_from_term_id: null,
    }, { renewalDeclined: true, awaitsInstallation: true }],
    ['a non-termite annual prepay term (never anchored, never provisional)', {
      status: 'active', renewal_decision: null, annual_plan_version: null, installation_anchored_at: null,
    }, { renewalDeclined: false, awaitsInstallation: false }],
    ['a termite RENEWAL term (dates are real from the start)', {
      status: 'active', renewal_decision: null, annual_plan_version: 'v3', installation_anchored_at: null, renewed_from_term_id: 'term-0',
    }, { renewalDeclined: false, awaitsInstallation: false }],
  ])('%s reports its renewal decision and anchor state', async (_label, shape, expected) => {
    mockIsPaidDecidedLapseTerm.mockResolvedValue(true);
    db.mockReturnValueOnce(chainSelecting([{
      id: 'term-1', term_start: '2026-09-25', term_end: '2027-09-25', prepay_invoice_id: 'inv-1', ...shape,
    }]));

    const result = await annualPrepayForCustomer('cust-1');

    expect(result).toEqual(expect.objectContaining({ id: 'term-1', ...expected }));
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

  // Codex r3 P2: the paid re-check sits inside the same fail-soft posture —
  // /api/auth/me never 500s over it.
  test('a thrown coverage re-check drops the payload (logged), never throws', async () => {
    const logger = require('../services/logger');
    mockIsPaidDecidedLapseTerm.mockRejectedValue(new Error('coverage lookup down'));
    db.mockReturnValueOnce(chainSelecting([{
      id: 'term-1', status: 'cancelled', renewal_decision: 'cancel', term_end: '2027-09-25', prepay_invoice_id: 'inv-1',
    }]));

    await expect(annualPrepayForCustomer('cust-1')).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('coverage lookup down'));
  });

  test('a query error is swallowed (logged) rather than thrown', async () => {
    const query = chainSelecting([], { fail: true });
    db.mockReturnValueOnce(query);

    const result = await annualPrepayForCustomer('cust-1');

    expect(result).toBeNull();
  });
});
