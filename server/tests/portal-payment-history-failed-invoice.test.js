'use strict';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/stripe', () => ({ getPaymentHistory: jest.fn() }));
jest.mock('../services/payer-linkage', () => ({
  ...jest.requireActual('../services/payer-linkage'),
  loadPayerLinkage: jest.fn(async () => ({ failed: false, payerInvoiceIds: new Set(), isPayerLinked: () => false })),
}));
jest.mock('../services/open-balance', () => ({
  rowIsSelfPayDue: jest.fn(async () => true),
}));
jest.mock('../services/failed-payments', () => ({
  ...jest.requireActual('../services/failed-payments'),
  loadFailedPaymentFacts: jest.fn(async () => ({
    rows: [],
    failedInvoiceIds: [],
    balanceCarryingInvoiceIds: new Set(),
  })),
}));

const db = require('../models/db');
const stripe = require('../services/stripe');
const { loadPayerLinkage } = require('../services/payer-linkage');
const { rowIsSelfPayDue } = require('../services/open-balance');
const { loadFailedPaymentFacts } = require('../services/failed-payments');
const { listPortalPayments } = require('../services/portal-payment-history');

function makeDb(invoiceRows = []) {
  return (table) => {
    const query = { _statuses: null, _draftIds: null, _ids: null, _numbers: null };
    const subQuery = (isStatusGroup) => {
      const sq = {
        whereIn: (col, vals) => {
          if (col === 'status') query._statuses = vals;
          return sq;
        },
        orWhereIn: (col, vals) => {
          if (isStatusGroup && col === 'id') query._draftIds = vals.map(String);
          else if (col === 'id') query._ids = vals.map(String);
          else if (col === 'invoice_number') query._numbers = vals;
          return sq;
        },
        whereNull: () => sq,
        orWhereNot: () => sq,
      };
      return sq;
    };
    query.where = (arg) => {
      if (typeof arg === 'function') {
        const isStatusGroup = arg.name === 'openOrEligibleDraft';
        const sq = subQuery(isStatusGroup);
        arg.call(sq, sq);
      }
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
        const statusMatch = query._statuses ? query._statuses.includes(inv.status) : true;
        const draftMatch = query._draftIds ? query._draftIds.includes(String(inv.id)) : false;
        if (query._statuses && !statusMatch && !draftMatch) return false;
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
const INV_DRAFT_ACTIVE = '44444444-4444-4444-8444-444444444444';
const INV_DRAFT_SUPERSEDED = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  jest.clearAllMocks();
  loadPayerLinkage.mockResolvedValue({ failed: false, payerInvoiceIds: new Set(), isPayerLinked: () => false });
  rowIsSelfPayDue.mockResolvedValue(true);
  loadFailedPaymentFacts.mockResolvedValue({
    rows: [],
    failedInvoiceIds: [],
    balanceCarryingInvoiceIds: new Set(),
  });
});

describe('listPortalPayments — failed-row payableInvoice linkage', () => {
  test('attaches each failed payment to its own open invoice with exact remaining balance (after partial credit)', async () => {
    db.mockImplementation(makeDb([
      { id: INV_A, token: 'tok-a', invoice_number: 'WV-2001', status: 'sent', total: 60, credit_applied: 0, amount_paid: 0, scheduled_service_id: 'svc-a' },
      { id: INV_B, token: 'tok-b', invoice_number: 'WV-2002', status: 'overdue', total: 95, credit_applied: 15, amount_paid: 0, scheduled_service_id: 'svc-b' },
      { id: INV_PAID, token: 'tok-paid', invoice_number: 'WV-2003', status: 'paid', total: 120, credit_applied: 0, amount_paid: 120, scheduled_service_id: 'svc-c' },
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
    expect(rowIsSelfPayDue).toHaveBeenCalledWith('cust-1', expect.objectContaining({ id: INV_B, scheduled_service_id: 'svc-b' }), expect.any(Object));

    // Settled invoice: linked, so UI must NOT fall back to an unrelated invoice.
    expect(byId['fail-settled'].invoiceLinked).toBe(true);
    expect(byId['fail-settled'].payableInvoice).toBeNull();

    // Unlinked legacy row: invoiceLinked=false, payableInvoice=null -> UI shows "View open invoices".
    expect(byId['fail-unlinked'].invoiceLinked).toBe(false);
    expect(byId['fail-unlinked'].payableInvoice).toBeNull();
  });

  test('verifies live payer ownership via rowIsSelfPayDue before exposing any pay link', async () => {
    rowIsSelfPayDue.mockImplementation(async (_custId, row) => row.id !== INV_B);
    db.mockImplementation(makeDb([
      { id: INV_A, token: 'tok-a', invoice_number: 'WV-2001', status: 'sent', total: 60, credit_applied: 0, amount_paid: 0, scheduled_service_id: 'svc-self' },
      { id: INV_B, token: 'tok-b', invoice_number: 'WV-2002', status: 'sent', total: 95, credit_applied: 0, amount_paid: 0, scheduled_service_id: 'svc-ap' },
    ]));
    stripe.getPaymentHistory.mockResolvedValue([
      { id: 'fail-self', payment_date: '2026-11-20', amount: 60, status: 'failed', description: 'Pest Control', metadata: JSON.stringify({ invoice_id: INV_A }) },
      { id: 'fail-ap', payment_date: '2026-11-19', amount: 95, status: 'failed', description: 'Lawn Care', metadata: JSON.stringify({ invoice_id: INV_B }) },
    ]);

    const res = await listPortalPayments('cust-1');
    const byId = Object.fromEntries(res.payments.map((p) => [p.id, p]));
    expect(byId['fail-self'].payableInvoice?.payUrl).toBe('/pay/tok-a');
    expect(byId['fail-ap'].payableInvoice).toBeNull();
  });

  test('keeps an explicit invoice_id authoritative when description mentions a different open invoice', async () => {
    db.mockImplementation(makeDb([
      { id: INV_B, token: 'tok-b', invoice_number: 'WV-2002', status: 'sent', total: 95, credit_applied: 0, amount_paid: 0 },
      { id: INV_PAID, token: 'tok-paid', invoice_number: 'WV-2003', status: 'paid', total: 120, credit_applied: 0, amount_paid: 120 },
    ]));
    stripe.getPaymentHistory.mockResolvedValue([
      {
        id: 'fail-conflicting',
        payment_date: '2026-11-20',
        amount: 120,
        status: 'failed',
        // Stale description names WV-2002 (open), while explicit invoice_id points to INV_PAID (settled).
        description: 'Retry for Invoice WV-2002',
        metadata: JSON.stringify({ invoice_id: INV_PAID }),
      },
      {
        id: 'fail-desc-only',
        payment_date: '2026-11-19',
        amount: 95,
        status: 'failed',
        description: 'Invoice WV-2002 — Card',
        metadata: null,
      },
    ]);

    const res = await listPortalPayments('cust-1');
    const byId = Object.fromEntries(res.payments.map((p) => [p.id, p]));
    expect(byId['fail-conflicting'].invoiceLinked).toBe(true);
    expect(byId['fail-conflicting'].payableInvoice).toBeNull();
    expect(byId['fail-desc-only'].invoiceLinked).toBe(true);
    expect(byId['fail-desc-only'].payableInvoice?.payUrl).toBe('/pay/tok-b');
  });

  test('restricts draft invoice pay links to unsuperseded failed attempts', async () => {
    loadFailedPaymentFacts.mockResolvedValue({
      rows: [{ id: 'fail-draft-active', metadata: JSON.stringify({ invoice_id: INV_DRAFT_ACTIVE }), retry_count: 1, next_retry_at: null }],
      failedInvoiceIds: [INV_DRAFT_ACTIVE],
      balanceCarryingInvoiceIds: new Set(),
    });
    db.mockImplementation(makeDb([
      { id: INV_DRAFT_ACTIVE, token: 'tok-draft-ok', invoice_number: 'WV-2010', status: 'draft', total: 75, credit_applied: 0, amount_paid: 0 },
      { id: INV_DRAFT_SUPERSEDED, token: 'tok-draft-old', invoice_number: 'WV-2011', status: 'draft', total: 75, credit_applied: 0, amount_paid: 0 },
    ]));
    stripe.getPaymentHistory.mockResolvedValue([
      { id: 'fail-draft-active', payment_date: '2026-11-20', amount: 75, status: 'failed', description: 'Pest Control', metadata: JSON.stringify({ invoice_id: INV_DRAFT_ACTIVE }) },
      { id: 'fail-draft-superseded', payment_date: '2026-11-18', amount: 75, status: 'failed', description: 'Pest Control', metadata: JSON.stringify({ invoice_id: INV_DRAFT_SUPERSEDED }) },
    ]);

    const res = await listPortalPayments('cust-1');
    const byId = Object.fromEntries(res.payments.map((p) => [p.id, p]));
    expect(byId['fail-draft-active'].payableInvoice?.payUrl).toBe('/pay/tok-draft-ok');
    expect(byId['fail-draft-superseded'].payableInvoice).toBeNull();
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
