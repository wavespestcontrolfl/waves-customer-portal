'use strict';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/stripe', () => ({ getPaymentHistory: jest.fn() }));
jest.mock('../services/payer-linkage', () => ({
  ...jest.requireActual('../services/payer-linkage'),
  loadPayerLinkage: jest.fn(async () => ({ failed: false, payerInvoiceIds: new Set(), isPayerLinked: () => false })),
}));
jest.mock('../services/payer', () => ({
  resolveForInvoice: jest.fn(async () => null),
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
const PayerService = require('../services/payer');
const { loadFailedPaymentFacts } = require('../services/failed-payments');
const { listPortalPayments } = require('../services/portal-payment-history');

function makeDb(invoiceRows = [], serviceRecords = []) {
  return (table) => {
    const query = { _statuses: null, _draftIds: null, _ids: null, _numbers: null, _whereObj: null };
    const subQuery = (isStatusGroup) => {
      const sq = {
        where: (col, val) => {
          if (isStatusGroup && col === 'status' && val === 'draft') sq._requireDraft = true;
          return sq;
        },
        whereIn: (col, vals) => {
          if (col === 'status') query._statuses = vals;
          else if (isStatusGroup && col === 'id' && sq._requireDraft) query._draftIds = vals.map(String);
          return sq;
        },
        orWhere: (fn) => {
          if (typeof fn === 'function') {
            const nested = subQuery(isStatusGroup);
            fn.call(nested, nested);
          }
          return sq;
        },
        orWhereIn: (col, vals) => {
          if (col === 'id') query._ids = vals.map(String);
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
      } else if (arg && typeof arg === 'object') {
        query._whereObj = { ...(query._whereObj || {}), ...arg };
      }
      return query;
    };
    query.whereNull = () => query;
    query.whereNot = () => query;
    query.orWhereNot = () => query;
    query.whereRaw = () => query;
    query.orderBy = () => query;
    query.limit = () => query;
    query.whereIn = (col, vals) => {
      if (col === 'status') query._statuses = vals;
      return query;
    };
    query.count = () => query;
    query.first = async () => {
      if (table === 'service_records') {
        return serviceRecords.find((sr) => String(sr.id) === String(query._whereObj?.id)) || null;
      }
      return { count: 1 };
    };
    query.select = async () => {
      if (table !== 'invoices') return [];
      return invoiceRows.filter((inv) => {
        const statusMatch = query._statuses ? query._statuses.includes(inv.status) : true;
        const draftMatch = query._draftIds ? (inv.status === 'draft' && query._draftIds.includes(String(inv.id))) : false;
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
  PayerService.resolveForInvoice.mockResolvedValue(null);
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
    expect(PayerService.resolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', scheduledServiceId: 'svc-b' }));

    // Settled invoice: linked, so UI must NOT fall back to an unrelated invoice.
    expect(byId['fail-settled'].invoiceLinked).toBe(true);
    expect(byId['fail-settled'].payableInvoice).toBeNull();

    // Unlinked legacy row: invoiceLinked=false, payableInvoice=null -> UI shows "View open invoices".
    expect(byId['fail-unlinked'].invoiceLinked).toBe(false);
    expect(byId['fail-unlinked'].payableInvoice).toBeNull();
  });

  test('verifies live payer ownership via rowIsSelfPayDue before exposing any pay link', async () => {
    PayerService.resolveForInvoice.mockImplementation(async ({ scheduledServiceId }) => (
      scheduledServiceId === 'svc-ap' ? { payerId: 'payer-99' } : null
    ));
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

  test('resolves payer ownership through service_record_id when scheduled_service_id is null on the invoice', async () => {
    PayerService.resolveForInvoice.mockImplementation(async ({ scheduledServiceId }) => (
      scheduledServiceId === 'svc-from-record' ? { payerId: 'payer-via-record' } : null
    ));
    db.mockImplementation(makeDb(
      [
        {
          id: INV_B,
          token: 'tok-record-ap',
          invoice_number: 'WV-2009',
          status: 'sent',
          total: 95,
          credit_applied: 0,
          amount_paid: 0,
          scheduled_service_id: null,
          service_record_id: 'sr-1',
        },
      ],
      [{ id: 'sr-1', scheduled_service_id: 'svc-from-record' }],
    ));
    stripe.getPaymentHistory.mockResolvedValue([
      { id: 'fail-record-ap', payment_date: '2026-11-20', amount: 95, status: 'failed', description: 'Lawn Care', metadata: JSON.stringify({ invoice_id: INV_B }) },
    ]);

    const res = await listPortalPayments('cust-1');
    expect(PayerService.resolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1',
      scheduledServiceId: 'svc-from-record',
    }));
    expect(res.payments[0].payableInvoice).toBeNull();
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

  test('rejects an invoice in failedDraftIds whose status moved from draft to void or processing', async () => {
    loadFailedPaymentFacts.mockResolvedValue({
      rows: [{ id: 'fail-moved-void', metadata: JSON.stringify({ invoice_id: INV_DRAFT_ACTIVE }), retry_count: 1, next_retry_at: null }],
      failedInvoiceIds: [INV_DRAFT_ACTIVE],
      balanceCarryingInvoiceIds: new Set(),
    });
    db.mockImplementation(makeDb([
      { id: INV_DRAFT_ACTIVE, token: 'tok-void', invoice_number: 'WV-2012', status: 'void', total: 75, credit_applied: 0, amount_paid: 0 },
    ]));
    stripe.getPaymentHistory.mockResolvedValue([
      { id: 'fail-moved-void', payment_date: '2026-11-20', amount: 75, status: 'failed', description: 'Pest Control', metadata: JSON.stringify({ invoice_id: INV_DRAFT_ACTIVE }) },
    ]);

    const res = await listPortalPayments('cust-1');
    expect(res.payments[0].payableInvoice).toBeNull();
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
