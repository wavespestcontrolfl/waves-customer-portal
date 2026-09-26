/**
 * annualPrepayForCustomer (server/routes/auth.js) — the /api/auth/me
 * "paid-through" badge lookup. Codex round-1 P2: a decided-lapse term
 * (status 'cancelled' AND renewal_decision 'cancel', e.g. a termite annual
 * plan declined online through the portal, slice 6a) must keep showing the
 * badge through its own term_end — the decline only refuses the FUTURE
 * renewal, it does not end the coverage the customer already paid for. A
 * void/refund 'cancelled' row (renewal_decision NULL) must stay excluded.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../models/db');
const { _private: { annualPrepayForCustomer } } = require('../routes/auth');

function chainReturning(row) {
  const query = {
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderByRaw: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(row),
  };
  return query;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
});

describe('annualPrepayForCustomer', () => {
  test('a live active term is returned as usual', async () => {
    const row = {
      id: 'term-1', status: 'active', plan_label: 'WaveGuard Bronze Annual Prepay', monthly_rate: null,
      prepay_amount: '450.00', term_start: '2026-09-25', term_end: '2027-09-25', prepay_invoice_id: 'inv-1',
      prepay_invoice_status: 'paid', prepay_invoice_total: 450,
    };
    const query = chainReturning(row);
    db.mockReturnValueOnce(query);

    const result = await annualPrepayForCustomer('cust-1');

    expect(result).toEqual(expect.objectContaining({ id: 'term-1', status: 'active' }));
    // The applicable-status predicate is wired in (active/renewal_pending/
    // payment_pending OR the decided-lapse shape) — never a bare whereIn
    // that would drop the decided-lapse OR-branch silently.
    expect(query.where).toHaveBeenCalledWith('apt.customer_id', 'cust-1');
    expect(query.where).toHaveBeenCalledWith(expect.any(Function));
  });

  test('a decided-lapse term (declined online, still covered through term_end) still returns the badge', async () => {
    const row = {
      id: 'term-1', status: 'cancelled', renewal_decision: 'cancel', plan_label: 'WaveGuard Bronze Annual Prepay',
      monthly_rate: null, prepay_amount: '450.00', term_start: '2026-09-25', term_end: '2027-09-25',
      prepay_invoice_id: 'inv-1', prepay_invoice_status: 'paid', prepay_invoice_total: 450,
    };
    const query = chainReturning(row);
    db.mockReturnValueOnce(query);

    const result = await annualPrepayForCustomer('cust-1');

    expect(result).toEqual(expect.objectContaining({ id: 'term-1', status: 'cancelled' }));
    // Verify the predicate function itself resolves the decided-lapse OR
    // branch true for a decided-lapse row and false for a void/refund one —
    // exercising the exact knex `this.where(...).orWhere(...)` builder the
    // production query passes, against a lightweight fake builder.
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

  test('no matching term (e.g. only a void/refund cancelled row on file) returns null', async () => {
    const query = chainReturning(null);
    db.mockReturnValueOnce(query);

    const result = await annualPrepayForCustomer('cust-1');

    expect(result).toBeNull();
  });

  test('no customerId short-circuits without touching the database', async () => {
    const result = await annualPrepayForCustomer(null);
    expect(result).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('a query error is swallowed (logged) rather than thrown', async () => {
    const query = chainReturning(null);
    query.first = jest.fn().mockRejectedValue(new Error('db down'));
    db.mockReturnValueOnce(query);

    const result = await annualPrepayForCustomer('cust-1');

    expect(result).toBeNull();
  });
});
