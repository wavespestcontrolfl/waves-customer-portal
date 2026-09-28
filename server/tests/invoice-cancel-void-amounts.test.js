/**
 * The per-invoice money a cancel's void moves, as the Intelligence Bar
 * cancel card shows and pins it (invoice.js cancelVoidInvoiceAmounts). The
 * void sweep compares the SAME shape against the pinned card before any
 * Stripe call and under the row lock, so a pg numeric string and a pinned
 * JSON number must compare equal, and the deposit credit must be summed
 * the way restoreDepositCreditForVoidedInvoice sums it. Synthetic rows only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
  _cancelVoidInvoiceAmounts: amounts,
  _cancelVoidAmountsMatch: match,
} = require('../services/invoice');

test('sums deposit_credit lines (absolute, amount or unit_price) and ignores other negative lines', () => {
  const row = {
    total: '50.00',
    credit_applied: '10.00',
    line_items: JSON.stringify([
      { category: 'service', amount: 135 },
      { category: 'deposit_credit', amount: -50, estimate_id: 'est-1' },
      { category: 'deposit_credit', unit_price: -25, estimate_id: 'est-2' },
      { category: 'discount', amount: -10 },
    ]),
  };
  expect(amounts(row)).toEqual({ total: 50, credit_applied: 10, deposit_credit: 75 });
});

test('a pg numeric string and the pinned JSON number compare equal; any moved amount does not', () => {
  const pinned = { id: 'inv-1', total: 89, credit_applied: 0, deposit_credit: 75 };
  const locked = { total: '89.00', credit_applied: null, line_items: [{ category: 'deposit_credit', amount: '-75.00' }] };
  expect(match(amounts(locked), pinned)).toBe(true);
  expect(match(amounts({ ...locked, line_items: [{ category: 'deposit_credit', amount: '-60.00' }] }), pinned)).toBe(false);
  expect(match(amounts({ ...locked, total: '90.00' }), pinned)).toBe(false);
  expect(match(amounts(locked), undefined)).toBe(false);
});

test('unparseable or missing line items read as no deposit', () => {
  expect(amounts({ total: 20, credit_applied: 0, line_items: '{not json' }).deposit_credit).toBe(0);
  expect(amounts({ total: null, credit_applied: 0 })).toEqual({ total: null, credit_applied: 0, deposit_credit: 0 });
});

// The ONE post-void scope (fee gate, credit-reversal guard, plan-cancel
// manual-review list, IB preview): an invoice linked only through a service
// record must count, not just a direct scheduled_service_id link.
test('unresolvedInvoicesForCancelledService matches the direct link OR a service-record link, excluding resolved statuses', () => {
  const InvoiceService = require('../services/invoice');
  const calls = [];
  const builder = (table) => {
    const b = {};
    for (const m of ['where', 'orWhereIn', 'whereNotIn', 'select']) {
      b[m] = (...args) => { calls.push({ table, m, args }); return b; };
    }
    return b;
  };
  InvoiceService.unresolvedInvoicesForCancelledService(builder, 'svc-1');
  const grouped = calls.find((c) => c.table === 'invoices' && c.m === 'where' && typeof c.args[0] === 'function');
  expect(grouped).toBeTruthy();
  grouped.args[0](builder('group'));
  expect(calls).toEqual(expect.arrayContaining([
    { table: 'group', m: 'where', args: [{ scheduled_service_id: 'svc-1' }] },
    expect.objectContaining({ table: 'group', m: 'orWhereIn', args: ['service_record_id', expect.anything()] }),
    { table: 'service_records', m: 'where', args: [{ scheduled_service_id: 'svc-1' }] },
    { table: 'invoices', m: 'whereNotIn', args: ['status', InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES] },
  ]));
});

// Customer-wide visit-money checks (signup-cancel eligibility and the
// pre-refund re-scan in customer-offboarding.js) count an invoice tied to a
// visit by EITHER link — most completion invoices carry only service_record_id.
test('whereVisitLinked matches a direct visit link OR a service-record link', () => {
  const InvoiceService = require('../services/invoice');
  const calls = [];
  const qb = {};
  for (const m of ['whereNotNull', 'orWhereNotNull']) qb[m] = (...args) => { calls.push([m, ...args]); return qb; };
  InvoiceService.whereVisitLinked(qb);
  expect(calls).toEqual([['whereNotNull', 'scheduled_service_id'], ['orWhereNotNull', 'service_record_id']]);
});
