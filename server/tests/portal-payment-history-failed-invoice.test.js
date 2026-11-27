'use strict';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/stripe', () => ({ getPaymentHistory: jest.fn() }));
jest.mock('../services/payer-linkage', () => ({
  ...jest.requireActual('../services/payer-linkage'),
  loadPayerLinkage: jest.fn(async () => ({ failed: false, payerInvoiceIds: new Set(), isPayerLinked: () => false })),
}));

const db = require('../models/db');
const stripe = require('../services/stripe');
const { loadPayerLinkage } = require('../services/payer-linkage');
const { listPortalPayments } = require('../services/portal-payment-history');

function makeDb(invoiceRows = []) {
  return (table) => {
    const query = { _statuses: null, _ids: null, _numbers: null };
    query.where = (arg) => {
      if (typeof arg === 'function') arg.call(query, query);
      return query;
    };
    query.orWhereIn = (col, vals) => {
      if (col === 'id') query._ids = vals.map(String);
      if (col === 'invoice_number') query._numbers = vals;
      return query;
    };
    query.whereNull = () => query;
    query.whereNot = () => query;
    query.orWhereNot = () => query;
    query.whereRaw = () => query;
    query.whereIn = (col, vals) => {
      if (col === 'status') query._statuses = vals;
      return query;
    };
    query.count = () => query;
    query.first = async () => ({ count: 1 });
    query.select = async () => {
      if (table !== 'invoices') return [];
      return invoiceRows.filter((inv) => {
        if (query._statuses && !query._statuses.includes(inv.status)) return false;
        if (inv.payer_id || inv.payer_statement_id) return false;
        const idMatch = query._ids ? query._ids.includes(String(inv.id)) : false;
        const numMatch = query._numbers ? query._numbers.includes(inv.invoice_number) : false;
        return idMatch || numMatch;
      });
    };
    return query;
  };
}

const INV_A = '11111111-1111-4111-8111-111111111111';
const INV_B = '22222222-2222-4222-8222-222222222222';
const INV_PAID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  jest.clearAllMocks();
  loadPayerLinkage.mockResolvedValue({ failed: false, payerInvoiceIds: new Set(), isPayerLinked: () => false });
});

describe('listPortalPayments — failed-row payableInvoice linkage', () => {
  test('attaches each failed payment to its own open invoice with exact remaining balance (after partial credit)', async () => {
    db.mockImplementation(makeDb([
      { id: INV_A, token: 'tok-a', invoice_number: 'WV-2001', status: 'sent', total: 60, credit_applied: 0, amount_paid: 0 },
      { id: INV_B, token: 'tok-b', invoice_number: 'WV-2002', status: 'overdue', total: 95, credit_applied: 15, amount_paid: 0 },
      { id: INV_PAID, token: 'tok-paid', invoice_number: 'WV-2003', status: 'paid', total: 120, credit_applied: 0, amount_paid: 120 },
    ]));
    stripe.getPaymentHistory.mockResolvedValue([
      {
        id: 'fail-b',
        payment_date: '2026-11-20',
        amount: 95,
        status: 'failed',
        description: 'Lawn Care',
        metadata: JSON.stringify({ invoice_id: INV_B }),
      },
      {
        id: 'fail-settled',
        payment_date: '2026-11-18',
        amount: 120,
        status: 'failed',
        description: 'Pest Control',
        metadata: JSON.stringify({ invoice_id: INV_PAID }),
      },
      {
        id: 'fail-unlinked',
        payment_date: '2026-11-15',
        amount: 89,
        status: 'failed',
        description: 'Silver WaveGuard Monthly',
        metadata: null,
      },
    ]);

    const res = await listPortalPayments('cust-1');
    const byId = Object.fromEntries(res.payments.map((p) => [p.id, p]));

    expect(byId['fail-b'].invoiceLinked).toBe(true);
    expect(byId['fail-b'].payableInvoice).toEqual({
      payUrl: '/pay/tok-b',
      amountDue: 80, // 95 total - 15 credit_applied
      invoiceNumber: 'WV-2002',
      dueDate: null,
    });

    // Settled invoice: linked, so UI must NOT fall back to an unrelated invoice.
    expect(byId['fail-settled'].invoiceLinked).toBe(true);
    expect(byId['fail-settled'].payableInvoice).toBeNull();

    // Unlinked legacy row: invoiceLinked=false, payableInvoice=null -> UI shows "View open invoices".
    expect(byId['fail-unlinked'].invoiceLinked).toBe(false);
    expect(byId['fail-unlinked'].payableInvoice).toBeNull();
  });

  test('fails closed and emits no payableInvoice when payer ownership lookup failed', async () => {
    loadPayerLinkage.mockResolvedValue({ failed: true, payerInvoiceIds: new Set(), isPayerLinked: () => false });
    db.mockImplementation(makeDb([
      { id: INV_B, token: 'tok-b', invoice_number: 'WV-2002', status: 'sent', total: 95, credit_applied: 0, amount_paid: 0 },
    ]));
    stripe.getPaymentHistory.mockResolvedValue([
      {
        id: 'fail-b',
        payment_date: '2026-11-20',
        amount: 95,
        status: 'failed',
        description: 'Lawn Care',
        metadata: JSON.stringify({ invoice_id: INV_B }),
      },
    ]);

    const res = await listPortalPayments('cust-1');
    expect(res.payments[0].payableInvoice).toBeNull();
  });
});
