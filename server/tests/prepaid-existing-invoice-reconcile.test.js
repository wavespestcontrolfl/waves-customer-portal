/**
 * Round-17 P1 (#4131 finding 1): the office's direct scheduled_services
 * prepaid stamp (POST /:id/prepaid) has no row lock of its own — it can
 * commit right after a linked full-balance invoice's mint (the mint's own
 * lock only made this write WAIT), so nothing at mint time ever saw the
 * payment. This suite covers the always-on reconciler that catches up:
 * mintOrReuseScheduledServiceInvoice's mintIfMissing:false reuse-only mode,
 * generatePrepaidReceiptForService's notify:false silent finalize, and
 * reconcileExistingLinkedInvoiceOnPrepaidStamp's skip wiring. The
 * complementary fail-closed backstop (claimInvoiceForSend refusing a
 * visit_prepaid_covered claim) is covered in completion-invoice-delivered.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => ({ payerId: null })) }));
jest.mock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: jest.fn(async () => ({ closed: true })) }));
jest.mock('../services/payment-plans', () => ({ completeActivePlansForInvoice: jest.fn(async () => undefined) }));
jest.mock('../services/invoice-followups', () => ({ stopOnPayment: jest.fn(async () => undefined), scheduleForInvoice: jest.fn(async () => undefined) }));
jest.mock('../services/annual-prepay-renewals', () => ({
  ...jest.requireActual('../services/annual-prepay-renewals'),
  syncTermForInvoicePayment: jest.fn(async () => undefined),
}));
jest.mock('../services/invoice-email', () => ({ sendReceiptEmail: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/invoice', () => ({ sendReceipt: jest.fn(async () => ({ sent: true })) }));

jest.mock('../models/db', () => {
  const state = { invoice: null, lockedInvoice: null, updatedInvoice: null, svc: null };
  const chain = (table) => {
    const q = {};
    ['where', 'whereIn', 'whereNot', 'leftJoin', 'select', 'orderBy', 'forUpdate'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => {
      if (table === 'scheduled_services') return state.svc;
      if (table === 'invoices') return state.invoice;
      return null;
    });
    q.update = jest.fn(() => ({
      returning: jest.fn(async () => (state.updatedInvoice ? [state.updatedInvoice] : [])),
    }));
    q.insert = jest.fn(async () => [1]);
    return q;
  };
  const db = jest.fn((table) => chain(table));
  db.transaction = jest.fn(async (work) => work(db));
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.raw = jest.fn((sql) => sql);
  db.__state = state;
  return db;
});

const db = require('../models/db');
const { resolveForInvoice } = require('../services/payer');
const { closeOutVisitForIssuedInvoice: closeoutMock } = require('../services/invoice-issued-closeout');
const InvoiceServiceMock = require('../services/invoice');
const {
  mintOrReuseScheduledServiceInvoice,
  generatePrepaidReceiptForService,
  reconcileExistingLinkedInvoiceOnPrepaidStamp,
} = require('../routes/admin-schedule')._test;

const SVC_ID = 'svc-1';

function svcRow(overrides = {}) {
  return {
    id: SVC_ID, customer_id: 'cust-1', prepaid_amount: 117, prepaid_method: 'cash', prepaid_note: null,
    prepaid_at: new Date(), cust_monthly_rate: null, cust_property_type: 'residential',
    cust_waveguard_tier: null, cust_billing_mode: 'per_application', ...overrides,
  };
}

function draftInvoice(overrides = {}) {
  return {
    id: 'inv-1', status: 'draft', total: 117, credit_applied: 0, customer_id: 'cust-1',
    scheduled_service_id: SVC_ID, payer_id: null, stripe_payment_intent_id: null,
    invoice_number: 'WPC-TEST-1', ...overrides,
  };
}

describe('mintOrReuseScheduledServiceInvoice({ mintIfMissing: false })', () => {
  beforeEach(() => { jest.clearAllMocks(); db.__state.invoice = null; });

  test('reuses an existing linked invoice exactly like the default mode', async () => {
    db.__state.invoice = draftInvoice();
    const result = await mintOrReuseScheduledServiceInvoice(svcRow(), { mintIfMissing: false });
    expect(result).toMatchObject({ invoice: db.__state.invoice, reused: true });
  });

  test('never mints when nothing exists yet — the separate gated feature owns minting', async () => {
    db.__state.invoice = null;
    const result = await mintOrReuseScheduledServiceInvoice(svcRow(), { mintIfMissing: false });
    expect(result).toEqual({ invoice: null, reason: 'no_invoice' });
  });
});

describe('generatePrepaidReceiptForService({ mintIfMissing: false, notify: false }) — the always-on reconciler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.__state.svc = svcRow();
    db.__state.invoice = draftInvoice();
    db.__state.updatedInvoice = { ...draftInvoice(), status: 'paid' };
  });

  test('a fully-covering cash prepayment settles the already-existing linked invoice to paid and closes the visit out — WITHOUT contacting the customer', async () => {
    const result = await generatePrepaidReceiptForService(SVC_ID, {
      operatorInitiated: true, mintIfMissing: false, notify: false,
    });
    expect(result).toMatchObject({ sent: false, reason: 'not_requested', invoiceId: 'inv-1' });
    expect(db.__state.updatedInvoice.status).toBe('paid');
    expect(closeoutMock).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: 'inv-1', trigger: 'paid' }));
    // notify: false — no receipt SMS/email attempted.
    expect(InvoiceServiceMock.sendReceipt).not.toHaveBeenCalled();
  });

  test('a partially-covering prepayment leaves the invoice collectible — nothing finalized, no closeout', async () => {
    db.__state.svc = svcRow({ prepaid_amount: 50 });
    const result = await generatePrepaidReceiptForService(SVC_ID, {
      operatorInitiated: true, mintIfMissing: false, notify: false,
    });
    expect(result).toMatchObject({ reason: 'not_paid_in_full', invoiceId: 'inv-1' });
    expect(closeoutMock).not.toHaveBeenCalled();
  });

  test('no linked invoice exists yet — a no-op, never mints one (that stays behind the gated feature)', async () => {
    db.__state.invoice = null;
    const result = await generatePrepaidReceiptForService(SVC_ID, {
      operatorInitiated: true, mintIfMissing: false, notify: false,
    });
    expect(result).toMatchObject({ sent: false, reason: 'no_invoice' });
    expect(closeoutMock).not.toHaveBeenCalled();
  });

  test('a payer-billed visit is left alone — the payer\'s AP inbox owes it, not cash at the door', async () => {
    resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-1' });
    const result = await generatePrepaidReceiptForService(SVC_ID, {
      operatorInitiated: true, mintIfMissing: false, notify: false,
    });
    expect(result).toMatchObject({ sent: false, reason: 'payer_billed' });
    expect(closeoutMock).not.toHaveBeenCalled();
  });

  test('an already-paid invoice (a race winner settled it first) still closes the visit out idempotently, still silently', async () => {
    db.__state.invoice = draftInvoice({ status: 'paid' });
    const result = await generatePrepaidReceiptForService(SVC_ID, {
      operatorInitiated: true, mintIfMissing: false, notify: false,
    });
    expect(result).toMatchObject({ sent: false, reason: 'not_requested' });
    expect(closeoutMock).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileExistingLinkedInvoiceOnPrepaidStamp — the route\'s wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.__state.svc = svcRow();
    db.__state.invoice = draftInvoice();
    db.__state.updatedInvoice = { ...draftInvoice(), status: 'paid' };
  });

  test('skip:true (the gated receipt feature already ran, or applyToSeries) never touches the invoice', async () => {
    await reconcileExistingLinkedInvoiceOnPrepaidStamp(SVC_ID, { skip: true, actorTechnicianId: null, actorRole: null });
    expect(closeoutMock).not.toHaveBeenCalled();
  });

  test('skip:false reconciles a fully-covered linked invoice silently', async () => {
    await reconcileExistingLinkedInvoiceOnPrepaidStamp(SVC_ID, { skip: false, actorTechnicianId: 'tech-1', actorRole: 'admin' });
    expect(closeoutMock).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: 'inv-1', trigger: 'paid', actorTechnicianId: 'tech-1', actorRole: 'admin' }));
    expect(db.__state.updatedInvoice.status).toBe('paid');
  });

  test('a reconciliation failure never throws to the caller — it is best-effort background cleanup', async () => {
    closeoutMock.mockRejectedValueOnce(new Error('synthetic closeout failure'));
    await expect(reconcileExistingLinkedInvoiceOnPrepaidStamp(SVC_ID, { skip: false, actorTechnicianId: null, actorRole: null })).resolves.toBeUndefined();
  });
});
