/**
 * POST /admin/invoices with scheduledServiceId — an office invoice raised
 * BEFORE the closeout links to its OPEN visit at creation (owner ruling
 * 2026-09-07), so the completion reuses it instead of minting a second one.
 * Also: GET /service-records/:customerId feeds the picker the open visits.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn(async (work) => work(fn));
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'NOW()') };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/invoice', () => {
  const actual = jest.requireActual('../services/invoice');
  return { ...actual, create: jest.fn(async (args) => ({ id: 'inv-new', token: 'tok', customer_id: args.customerId, invoice_number: 'WPC-TEST-1', scheduled_service_id: args.scheduledServiceId || null })) };
});
jest.mock('../services/scheduled-invoice-mint', () => ({
  ...jest.requireActual('../services/scheduled-invoice-mint'),
  acquireScheduledInvoiceMintLock: jest.fn(async () => undefined),
  // The ONE scheduled-visit mint helper: lock chain, adopt-existing, deposit
  // roll-forward. Mocked here; its own contract is covered by its suites.
  mintScheduledServiceInvoiceWithDeposit: jest.fn(async ({ svc, buildCreateParams }) => {
    const params = buildCreateParams();
    return { invoice: { id: 'inv-new', token: 'tok', customer_id: params.customerId, invoice_number: 'WPC-TEST-1', scheduled_service_id: svc.id }, reused: false };
  }),
}));
jest.mock('../services/completion-invoice-candidate', () => ({
  ...jest.requireActual('../services/completion-invoice-candidate'),
  completionTerminalInvoiceLookup: jest.fn(async () => null),
}));
jest.mock('../services/setup-fee-alert-reconcile', () => ({
  reconcileSetupFeeAlert: jest.fn(async () => undefined),
  reconcileSetupFeeAlertForInvoice: jest.fn(async () => undefined),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  ...jest.requireActual('../services/annual-prepay-renewals'),
  annualPrepayCoversVisit: jest.fn(async () => false),
}));
jest.mock('../services/estimate-deposits', () => ({
  ...jest.requireActual('../services/estimate-deposits'),
  pendingDepositCredit: jest.fn(async (estimateId) => (estimateId === 'est-with-deposit' ? { amount: 50 } : null)),
}));
jest.mock('../services/payer', () => ({
  ...jest.requireActual('../services/payer'),
  resolveForInvoice: jest.fn(async ({ scheduledServiceId }) => (scheduledServiceId === '55555555-5555-4555-8555-555555555555' ? { payerId: 'payer-1' } : { payerId: null })),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (u) => u), invoiceShortCodePrefix: jest.fn(() => 'INV') }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.example.test') }));
// The completion-side-effects fence (GitHub P1 #4131 r3): defaults to "no
// attempt in flight" so schedule-send tests that don't care about it are
// unaffected; individual tests override the state to exercise the fence.
jest.mock('../services/completion-attempts', () => ({
  completionStatusForService: jest.fn(async () => ({ state: 'none' })),
}));

const express = require('express');
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { acquireScheduledInvoiceMintLock, mintScheduledServiceInvoiceWithDeposit } = require('../services/scheduled-invoice-mint');
const { reconcileSetupFeeAlert } = require('../services/setup-fee-alert-reconcile');
const { annualPrepayCoversVisit, ANNUAL_PREPAY_PREPAID_METHOD } = require('../services/annual-prepay-renewals');
const { completionTerminalInvoiceLookup } = require('../services/completion-invoice-candidate');
const { resolveForInvoice } = require('../services/payer');
const { completionStatusForService } = require('../services/completion-attempts');
const router = require('../routes/admin-invoices');

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const VISIT = '33333333-3333-4333-8333-333333333333';
const PAYER_VISIT = '55555555-5555-4555-8555-555555555555';

function qb(overrides = {}) {
  const q = {};
  for (const m of ['where', 'whereRaw', 'whereIn', 'leftJoin', 'select', 'orderBy', 'offset', 'limit', 'whereNull', 'whereNot', 'whereNotExists', 'modify']) q[m] = jest.fn(() => q);
  q.first = jest.fn(async () => null);
  q.then = undefined;
  Object.assign(q, overrides);
  return q;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

const body = (extra) => JSON.stringify({ customerId: CUSTOMER, serviceDate: '2040-03-04', lineItems: [{ description: 'Quarterly Pest Control Service', quantity: 1, unit_price: 117, amount: 117 }], ...extra });
const post = (baseUrl, extra) => fetch(`${baseUrl}/admin/invoices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(extra) });

describe('POST /admin/invoices with an open visit link', () => {
  let visitRow;
  beforeEach(() => {
    jest.clearAllMocks();
    visitRow = { id: VISIT, customer_id: CUSTOMER, status: 'confirmed' };
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return qb({ first: jest.fn(async () => visitRow) });
      if (table === 'service_records') return qb();
      throw new Error(`unexpected table ${table}`);
    });
  });

  test('an open visit of this customer is linked through the scheduled-visit mint helper (lock chain, adopt, deposit roll-forward)', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(201);
      expect(mintScheduledServiceInvoiceWithDeposit).toHaveBeenCalledTimes(1);
      const call = mintScheduledServiceInvoiceWithDeposit.mock.calls[0][0];
      expect(call.svc).toMatchObject({ id: VISIT, customer_id: CUSTOMER });
      expect(call.allowPriceMovement).toBe(true);
      expect(call.expectedDepositCredit).toBeNull(); // no preview sent (API callers) → no expectation
      expect(call.buildCreateParams()).toMatchObject({ customerId: CUSTOMER, scheduledServiceId: VISIT, serviceDate: '2040-03-04' });
      expect(InvoiceService.create).not.toHaveBeenCalled(); // the helper owns the create
      expect(await res.json()).toMatchObject({ id: 'inv-new', scheduled_service_id: VISIT, payUrl: expect.stringContaining('/pay/tok') });
    });
  });

  describe('a deposit that covers the whole invoice settles it at creation (Codex P1 r6)', () => {
    const minted = (invoice) => mintScheduledServiceInvoiceWithDeposit.mockImplementationOnce(async ({ svc }) => ({
      invoice: { id: 'inv-new', token: 'tok', customer_id: CUSTOMER, invoice_number: 'WPC-TEST-1', scheduled_service_id: svc.id, status: 'draft', credit_applied: 0, ...invoice },
      reused: false,
    }));

    test('nothing due after the deposit → the zero-balance transition runs and the response says so (the client skips its send)', async () => {
      minted({ total: 0 });
      const settle = jest.spyOn(InvoiceService, 'settleZeroBalance').mockResolvedValue({
        settled: true, reason: null, invoice: { id: 'inv-new', token: 'tok', customer_id: CUSTOMER, invoice_number: 'WPC-TEST-1', scheduled_service_id: VISIT, status: 'prepaid', total: 0, prepaid_by: 'system:zero_balance' },
      });
      try {
        await withServer(async (baseUrl) => {
          const res = await post(baseUrl, { scheduledServiceId: VISIT });
          expect(res.status).toBe(201);
          expect(settle).toHaveBeenCalledWith('inv-new');
          expect(await res.json()).toMatchObject({ id: 'inv-new', status: 'prepaid', settledByDeposit: true });
        });
      } finally { settle.mockRestore(); }
    });

    test('a refused settlement fails CLOSED: the row stays as minted and the response holds delivery (Codex P1 r7) — never a throw', async () => {
      minted({ total: 0 });
      const settle = jest.spyOn(InvoiceService, 'settleZeroBalance').mockResolvedValue({ settled: false, reason: 'followup_in_flight', retryable: true, invoice: null });
      try {
        await withServer(async (baseUrl) => {
          const res = await post(baseUrl, { scheduledServiceId: VISIT });
          expect(res.status).toBe(201);
          expect(await res.json()).toMatchObject({ id: 'inv-new', status: 'draft', settledByDeposit: false, deliveryHeld: { code: 'deposit_settlement_pending', reason: 'followup_in_flight' } });
        });
      } finally { settle.mockRestore(); }
    });

    test('a settlement that THROWS holds delivery the same way', async () => {
      minted({ total: 0 });
      const settle = jest.spyOn(InvoiceService, 'settleZeroBalance').mockRejectedValue(new Error('deadlock detected'));
      try {
        await withServer(async (baseUrl) => {
          const res = await post(baseUrl, { scheduledServiceId: VISIT });
          expect(res.status).toBe(201);
          expect(await res.json()).toMatchObject({ id: 'inv-new', status: 'draft', settledByDeposit: false, deliveryHeld: { code: 'deposit_settlement_pending', reason: 'deadlock detected' } });
        });
      } finally { settle.mockRestore(); }
    });

    test('a balance still due after the deposit never touches the settlement path', async () => {
      minted({ total: 67 });
      const settle = jest.spyOn(InvoiceService, 'settleZeroBalance').mockResolvedValue({ settled: true });
      try {
        await withServer(async (baseUrl) => {
          const res = await post(baseUrl, { scheduledServiceId: VISIT });
          expect(res.status).toBe(201);
          expect(settle).not.toHaveBeenCalled();
          expect(await res.json()).toMatchObject({ id: 'inv-new', status: 'draft', settledByDeposit: false, deliveryHeld: null });
        });
      } finally { settle.mockRestore(); }
    });
  });

  test('ownership and open status are re-verified ROW-LOCKED inside the mint chain — a visit cancelled in between is refused', async () => {
    mintScheduledServiceInvoiceWithDeposit.mockImplementationOnce(async ({ assertEligibleInTrx }) => {
      // The chain calls the hook on its transaction after the advisory lock.
      const lockedRow = { id: VISIT, customer_id: CUSTOMER, status: 'cancelled' };
      const trx = () => qb({ forUpdate: jest.fn(() => ({ first: jest.fn(async () => lockedRow) })) });
      trx.raw = jest.fn(async () => ({ rows: [] }));
      await assertEligibleInTrx(trx);
      throw new Error('hook should have refused');
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_not_open' });
      expect(InvoiceService.create).not.toHaveBeenCalled();
    });
  });

  describe('the invoice\'s serviceDate is derived from the LOCKED visit, not the client-supplied value (Codex r19 P2 #4131)', () => {
    // Mirrors the "ownership and open status" test's shape above: the mint
    // chain calls assertEligibleInTrx (openVisitEligibilityInTrx) on its own
    // transaction, which pins the locked row's scheduled_date onto the
    // out-parameter buildCreateParams reads.
    function mintCallsHookWith(lockedRow) {
      return mintScheduledServiceInvoiceWithDeposit.mockImplementationOnce(async ({ svc, assertEligibleInTrx }) => {
        const trx = () => qb({ forUpdate: jest.fn(() => ({ first: jest.fn(async () => lockedRow) })) });
        trx.raw = jest.fn(async () => ({ rows: [] }));
        await assertEligibleInTrx(trx);
        return { invoice: { id: 'inv-new', token: 'tok', customer_id: CUSTOMER, invoice_number: 'WPC-TEST-1', scheduled_service_id: svc.id }, reused: false };
      });
    }

    test('a visit rescheduled between picker load and submit: the invoice bills the NEW scheduled_date, not the stale value the form loaded with', async () => {
      // The picker loaded the visit at 2040-03-04 (the client's serviceDate,
      // still in the request body below); the visit was rescheduled to
      // 2040-03-10 before the create landed and locked it.
      mintCallsHookWith({ id: VISIT, customer_id: CUSTOMER, status: 'confirmed', scheduled_date: new Date(Date.UTC(2040, 2, 10)) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, { scheduledServiceId: VISIT, serviceDate: '2040-03-04' });
        expect(res.status).toBe(201);
        const call = mintScheduledServiceInvoiceWithDeposit.mock.calls[0][0];
        expect(call.buildCreateParams()).toMatchObject({ serviceDate: '2040-03-10' });
      });
    });

    test('an operator-edited date field that disagrees with the locked visit: the locked visit\'s date wins', async () => {
      // The visit was never rescheduled — the operator just typed a
      // different date into the form's serviceDate field by hand.
      mintCallsHookWith({ id: VISIT, customer_id: CUSTOMER, status: 'confirmed', scheduled_date: new Date(Date.UTC(2040, 5, 1)) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, { scheduledServiceId: VISIT, serviceDate: '2041-01-01' });
        expect(res.status).toBe(201);
        const call = mintScheduledServiceInvoiceWithDeposit.mock.calls[0][0];
        expect(call.buildCreateParams()).toMatchObject({ serviceDate: '2040-06-01' });
      });
    });
  });

  test('an accepted-estimate stamp still retires the parked setup-fee alert after an open-visit mint', async () => {
    const estimateId = '44444444-4444-4444-8444-444444444444';
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT, notes: `accepted estimate #${estimateId} — setup fee` });
      expect(res.status).toBe(201);
      expect(reconcileSetupFeeAlert).toHaveBeenCalledWith(expect.objectContaining({ customerId: CUSTOMER, sourceEstimateId: estimateId }));
    });
  });

  test('a visit that already carries an invoice is refused — the helper adopted it, no second invoice is cut', async () => {
    mintScheduledServiceInvoiceWithDeposit.mockResolvedValueOnce({ invoice: { id: 'inv-existing', invoice_number: 'WPC-2026-0406' }, reused: true });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_already_invoiced', invoiceId: 'inv-existing' });
      expect(InvoiceService.create).not.toHaveBeenCalled();
    });
  });

  test("another customer's visit is refused before anything is created", async () => {
    visitRow = { id: VISIT, customer_id: OTHER, status: 'confirmed' };
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/does not belong/);
      expect(InvoiceService.create).not.toHaveBeenCalled();
    });
  });

  test.each(['completed', 'cancelled', 'rescheduled'])('a %s visit is refused — link it through its service record', async (status) => {
    visitRow = { id: VISIT, customer_id: CUSTOMER, status };
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_not_open' });
      expect(InvoiceService.create).not.toHaveBeenCalled();
    });
  });

  // The default POST body bills a single $117 line item, so invoiceAmount
  // (billedLineTotal) is 117 for every case below.
  test('a prepaid visit is refused when the recorded prepayment covers the invoice amount', async () => {
    visitRow = { id: VISIT, customer_id: CUSTOMER, status: 'confirmed', prepaid_amount: 200 };
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_prepaid' });
      expect(mintScheduledServiceInvoiceWithDeposit).not.toHaveBeenCalled();
    });
  });

  // Pre-push P0 r3 — the office create has no prepayment-crediting step (the
  // completion / Charge Now apply the recorded prepayment when THEY mint),
  // so a partial prepayment must refuse too: otherwise a $117 visit with $50
  // on file becomes a collectible $117 invoice the operator can send at once.
  test('a prepayment that only partially covers the invoice amount is refused as well — nothing created', async () => {
    visitRow = { id: VISIT, customer_id: CUSTOMER, status: 'confirmed', prepaid_amount: 50, prepaid_method: 'zelle' };
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_prepaid' });
      expect(mintScheduledServiceInvoiceWithDeposit).not.toHaveBeenCalled();
    });
  });

  // Codex P2 #4131 r3 — the annual-prepay branch is gated on the stamped
  // method: a stale amount left by a voided/refunded term (no matching
  // method) covers nothing, whatever the number says.
  test('annual-prepay coverage refuses only when the visit is actually stamped for it', async () => {
    visitRow = { id: VISIT, customer_id: CUSTOMER, status: 'confirmed', prepaid_amount: null, prepaid_method: ANNUAL_PREPAY_PREPAID_METHOD };
    annualPrepayCoversVisit.mockResolvedValueOnce(true);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_prepaid' });
      expect(mintScheduledServiceInvoiceWithDeposit).not.toHaveBeenCalled();
    });
  });

  test('a stale annual-prepay stamp (term voided/refunded) covers nothing, however large the recorded amount', async () => {
    // annualPrepayCoversVisit defaults to false in this suite (voided/refunded
    // term) — the amount on the stamp must not override that.
    visitRow = { id: VISIT, customer_id: CUSTOMER, status: 'confirmed', prepaid_amount: 999999, prepaid_method: ANNUAL_PREPAY_PREPAID_METHOD };
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(201);
    });
    expect(annualPrepayCoversVisit).toHaveBeenCalled();
  });

  // Codex P2 #4131 r3 — a homeowner's prepayment never hides a PAYER's
  // invoice: the third party's AP invoice must still be cut.
  // Pre-push P0 r3 — the annual-prepay check runs STRICT here: an
  // unverifiable stamp (no term id, table missing, a failed read) refuses
  // the create, before and under the lock, rather than billing a visit that
  // may already be paid for.
  test('an annual-prepay stamp whose coverage cannot be verified is refused (409 visit_billing_unverifiable) — nothing created', async () => {
    visitRow = { id: VISIT, customer_id: CUSTOMER, status: 'confirmed', prepaid_amount: 117, prepaid_method: ANNUAL_PREPAY_PREPAID_METHOD, annual_prepay_term_id: null };
    annualPrepayCoversVisit.mockRejectedValueOnce(new Error('stamped visit carries no annual_prepay_term_id — coverage unverifiable'));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_billing_unverifiable' });
      expect(annualPrepayCoversVisit).toHaveBeenCalledWith(expect.objectContaining({ id: VISIT }), expect.anything(), { throwOnError: true });
      expect(mintScheduledServiceInvoiceWithDeposit).not.toHaveBeenCalled();
    });
  });

  test('an annual-prepay stamp that becomes unverifiable under the lock is refused inside the chain', async () => {
    visitRow = { id: VISIT, customer_id: CUSTOMER, status: 'confirmed', prepaid_amount: 117, prepaid_method: ANNUAL_PREPAY_PREPAID_METHOD, annual_prepay_term_id: 'term-1' };
    annualPrepayCoversVisit.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('annual_prepay_terms read failed'));
    mintScheduledServiceInvoiceWithDeposit.mockImplementationOnce(async ({ assertEligibleInTrx }) => {
      const trx = () => qb({ forUpdate: jest.fn(() => ({ first: jest.fn(async () => ({ ...visitRow })) })) });
      trx.raw = jest.fn(async () => ({ rows: [] }));
      await assertEligibleInTrx(trx);
      throw new Error('hook should have refused');
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_billing_unverifiable' });
    });
  });

  // Codex P1 r4 — the payer lookup runs STRICT on the office paths: a failed
  // read must refuse, never fall back to self-pay and bill the homeowner.
  test('a failed payer lookup refuses the create (409 visit_billing_unverifiable) — nothing created', async () => {
    visitRow = { id: VISIT, customer_id: CUSTOMER, status: 'confirmed' };
    resolveForInvoice.mockRejectedValueOnce(new Error('payer schema probe failed'));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_billing_unverifiable' });
      expect(resolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({ scheduledServiceId: VISIT, throwOnError: true }));
      expect(mintScheduledServiceInvoiceWithDeposit).not.toHaveBeenCalled();
    });
  });

  // Codex P1 r4 — a refunded invoice on the visit is a terminal blocker (the
  // completion's rule): refund.failed can restore it, so no replacement is
  // minted, before or under the lock.
  test('a visit whose previous invoice was refunded is refused (409 visit_invoice_refunded) — before the lock and under it', async () => {
    visitRow = { id: VISIT, customer_id: CUSTOMER, status: 'confirmed' };
    completionTerminalInvoiceLookup.mockResolvedValueOnce({ id: 'inv-r', invoice_number: 'WPC-REF-1', status: 'refunded' });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_invoice_refunded' });
      expect(mintScheduledServiceInvoiceWithDeposit).not.toHaveBeenCalled();
    });
    completionTerminalInvoiceLookup.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'inv-r', invoice_number: 'WPC-REF-1', status: 'refunded' });
    mintScheduledServiceInvoiceWithDeposit.mockImplementationOnce(async ({ assertEligibleInTrx }) => {
      const trx = () => qb({ forUpdate: jest.fn(() => ({ first: jest.fn(async () => ({ ...visitRow })) })) });
      trx.raw = jest.fn(async () => ({ rows: [] }));
      await assertEligibleInTrx(trx);
      throw new Error('hook should have refused');
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_invoice_refunded' });
    });
  });

  test("the visit's invoice rows are locked NOWAIT before the refunded check — a row a refund holds right now refuses (409 visit_billing_changing), never waits", async () => {
    visitRow = { id: VISIT, customer_id: CUSTOMER, status: 'confirmed' };
    const rawCalls = [];
    mintScheduledServiceInvoiceWithDeposit.mockImplementationOnce(async ({ assertEligibleInTrx }) => {
      const trx = () => qb({ forUpdate: jest.fn(() => ({ first: jest.fn(async () => ({ ...visitRow })) })) });
      trx.raw = jest.fn(async (sql, bindings) => {
        rawCalls.push([sql, bindings]);
        throw Object.assign(new Error('could not obtain lock on row in relation "invoices"'), { code: '55P03' });
      });
      await assertEligibleInTrx(trx);
      throw new Error('hook should have refused');
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_billing_changing' });
    });
    expect(rawCalls).toEqual([[expect.stringMatching(/FROM invoices WHERE scheduled_service_id = \? FOR UPDATE NOWAIT/), [VISIT]]]);
    // The refunded re-check runs only once the rows are held.
    expect(completionTerminalInvoiceLookup).toHaveBeenCalledTimes(1);
  });

  test('a payer-billed visit is never covered by the homeowner prepayment, however large', async () => {
    visitRow = { id: PAYER_VISIT, customer_id: CUSTOMER, status: 'confirmed', prepaid_amount: 999 };
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: PAYER_VISIT });
      expect(res.status).toBe(201);
    });
  });

  // GitHub r11 P1 #4131 — the in-lock prepaid verdict is only as good as the
  // payer it was taken against. The route pins that identity onto the create
  // (expectedPayerId) so a default-payer clear or a payer deactivation racing
  // the mint cannot let creation re-resolve to self-pay and bill the
  // homeowner for a prepayment the payer already covered.
  test('the payer resolved UNDER THE LOCK is pinned onto the create as expectedPayerId (payer-billed and self-pay alike)', async () => {
    const pins = [];
    const runHookThenBuild = async ({ svc, assertEligibleInTrx, buildCreateParams }) => {
      const lockedRow = { ...visitRow };
      const trx = () => qb({ forUpdate: jest.fn(() => ({ first: jest.fn(async () => lockedRow) })) });
      trx.raw = jest.fn(async () => ({ rows: [] }));
      await assertEligibleInTrx(trx);
      // The mint calls buildCreateParams only AFTER the eligibility hook —
      // the pin is live by then, never still undefined.
      pins.push(buildCreateParams().expectedPayerId);
      return { invoice: { id: 'inv-new', token: 'tok', customer_id: CUSTOMER, invoice_number: 'WPC-TEST-1', scheduled_service_id: svc.id }, reused: false };
    };

    visitRow = { id: PAYER_VISIT, customer_id: CUSTOMER, status: 'confirmed' };
    mintScheduledServiceInvoiceWithDeposit.mockImplementationOnce(runHookThenBuild);
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { scheduledServiceId: PAYER_VISIT })).status).toBe(201);
    });

    visitRow = { id: VISIT, customer_id: CUSTOMER, status: 'confirmed' };
    mintScheduledServiceInvoiceWithDeposit.mockImplementationOnce(runHookThenBuild);
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { scheduledServiceId: VISIT })).status).toBe(201);
    });

    // Payer-billed pins the payer id; self-pay pins an explicit null (NOT
    // undefined — that would switch the check off in create()).
    expect(pins).toEqual(['payer-1', null]);
  });

  test('a Bill-To that changes between the in-lock verdict and the definitive resolution is refused (409 PAYER_CHANGED)', async () => {
    visitRow = { id: PAYER_VISIT, customer_id: CUSTOMER, status: 'confirmed' };
    mintScheduledServiceInvoiceWithDeposit.mockImplementationOnce(async ({ assertEligibleInTrx, buildCreateParams }) => {
      const trx = () => qb({ forUpdate: jest.fn(() => ({ first: jest.fn(async () => ({ ...visitRow })) })) });
      trx.raw = jest.fn(async () => ({ rows: [] }));
      await assertEligibleInTrx(trx);
      // InvoiceService.create's own contract on a diverged pin, surfaced by
      // the mint exactly as it would be in production (status 409 makes it
      // terminal for the mint's retry loop).
      expect(buildCreateParams().expectedPayerId).toBe('payer-1');
      throw Object.assign(new Error('That visit\'s Bill-To changed while this invoice was being created — nothing was created; reload and try again'), { status: 409, code: 'PAYER_CHANGED' });
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: PAYER_VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'PAYER_CHANGED' });
    });
  });

  test('a prepayment recorded between the pre-check and the lock is refused inside the chain', async () => {
    mintScheduledServiceInvoiceWithDeposit.mockImplementationOnce(async ({ assertEligibleInTrx }) => {
      const lockedRow = { id: VISIT, customer_id: CUSTOMER, status: 'confirmed', prepaid_amount: 117 };
      const trx = () => qb({ forUpdate: jest.fn(() => ({ first: jest.fn(async () => lockedRow) })) });
      trx.raw = jest.fn(async () => ({ rows: [] }));
      await assertEligibleInTrx(trx);
      throw new Error('hook should have refused');
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_prepaid' });
    });
  });

  // Codex P1 r3 — the mint derives its deposit ledger from the visit snapshot's
  // source_estimate_id; an estimate attached or relinked between the
  // pre-check and the lock is refused under the lock, never minted stale.
  test('a source estimate attached or relinked between the pre-check and the lock is refused inside the chain (409 visit_link_moved)', async () => {
    visitRow = { id: VISIT, customer_id: CUSTOMER, status: 'confirmed', source_estimate_id: null };
    mintScheduledServiceInvoiceWithDeposit.mockImplementationOnce(async ({ assertEligibleInTrx }) => {
      const lockedRow = { ...visitRow, source_estimate_id: 'est-attached-later' };
      const trx = () => qb({ forUpdate: jest.fn(() => ({ first: jest.fn(async () => lockedRow) })) });
      trx.raw = jest.fn(async () => ({ rows: [] }));
      await assertEligibleInTrx(trx);
      throw new Error('hook should have refused');
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_link_moved' });
    });
  });

  test('the previewed deposit credit rides to the helper; a credit that moved since the preview is refused (409 DEPOSIT_CREDIT_CHANGED) — nothing created', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT, expectedDepositCredit: 50 });
      expect(res.status).toBe(201);
      expect(mintScheduledServiceInvoiceWithDeposit.mock.calls[0][0].expectedDepositCredit).toBe(50);
    });
    mintScheduledServiceInvoiceWithDeposit.mockRejectedValueOnce(Object.assign(
      new Error('The deposit credit changed while this invoice was being created (previewed $50.00, now $0.00) — nothing was created. Reload the visit and try again.'),
      { status: 409, code: 'DEPOSIT_CREDIT_CHANGED', expectedDepositCredit: 50, pendingDepositCredit: 0 },
    ));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT, expectedDepositCredit: 50 });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'DEPOSIT_CREDIT_CHANGED', error: expect.stringContaining('nothing was created') });
      expect(InvoiceService.create).not.toHaveBeenCalled();
    });
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { scheduledServiceId: VISIT, expectedDepositCredit: 'fifty' })).status).toBe(400);
      expect((await post(baseUrl, { scheduledServiceId: VISIT, expectedDepositCredit: -1 })).status).toBe(400);
      expect(mintScheduledServiceInvoiceWithDeposit).toHaveBeenCalledTimes(2);
    });
  });

  test('the previewed balance rides to the helper; a balance the server would bill differently is refused (409 BALANCE_CHANGED) with the real figures — nothing created', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT, expectedDepositCredit: 49, expectedBalanceDue: 76.19 });
      expect(res.status).toBe(201);
      expect(mintScheduledServiceInvoiceWithDeposit.mock.calls[0][0]).toMatchObject({ expectedDepositCredit: 49, expectedBalanceDue: 76.19 });
    });
    mintScheduledServiceInvoiceWithDeposit.mockRejectedValueOnce(Object.assign(
      new Error('The balance this invoice would bill ($68.00) differs from the one previewed ($76.19) — nothing was created.'),
      { status: 409, code: 'BALANCE_CHANGED', expectedBalanceDue: 76.19, balanceDue: 68, invoiceTotal: 117, appliedDepositCredit: 49 },
    ));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT, expectedDepositCredit: 49, expectedBalanceDue: 76.19 });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: expect.stringContaining('nothing was created'),
        code: 'BALANCE_CHANGED',
        expectedBalanceDue: 76.19,
        balanceDue: 68,
        invoiceTotal: 117,
        appliedDepositCredit: 49,
      });
      expect(InvoiceService.create).not.toHaveBeenCalled();
    });
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { scheduledServiceId: VISIT, expectedBalanceDue: 'lots' })).status).toBe(400);
      expect((await post(baseUrl, { scheduledServiceId: VISIT, expectedBalanceDue: -0.01 })).status).toBe(400);
      expect(mintScheduledServiceInvoiceWithDeposit).toHaveBeenCalledTimes(2);
    });
  });

  test('a legacy NULL-status visit is open — linkable, and re-verified as open under the lock', async () => {
    visitRow = { id: VISIT, customer_id: CUSTOMER, status: null };
    mintScheduledServiceInvoiceWithDeposit.mockImplementationOnce(async ({ svc, assertEligibleInTrx, buildCreateParams }) => {
      const lockedRow = { id: VISIT, customer_id: CUSTOMER, status: null, prepaid_amount: null };
      const trx = () => qb({ forUpdate: jest.fn(() => ({ first: jest.fn(async () => lockedRow) })) });
      trx.raw = jest.fn(async () => ({ rows: [] }));
      await assertEligibleInTrx(trx); // must not refuse
      const params = buildCreateParams();
      return { invoice: { id: 'inv-new', token: 'tok', customer_id: params.customerId, invoice_number: 'WPC-TEST-1', scheduled_service_id: svc.id }, reused: false };
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ scheduled_service_id: VISIT });
    });
  });

  test('a record link and a visit link together are rejected; a malformed id is rejected', async () => {
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { scheduledServiceId: VISIT, serviceRecordId: VISIT })).status).toBe(400);
      expect((await post(baseUrl, { scheduledServiceId: 'not-a-uuid' })).status).toBe(400);
      expect(InvoiceService.create).not.toHaveBeenCalled();
    });
  });

  // Codex P2 #4131 r3 — a 36-character near-miss (36 hyphens) passed the old
  // /^[0-9a-f-]{36}$/i regex and was bound against the Postgres uuid column,
  // turning an intended 400 into a 500. Enforce the full 8-4-4-4-12 shape.
  test('a 36-character non-uuid value (36 hyphens) is rejected as a 400, never reaches the query', async () => {
    await withServer(async (baseUrl) => {
      const nearMiss = '-'.repeat(36);
      expect(nearMiss).toHaveLength(36);
      const res = await post(baseUrl, { scheduledServiceId: nearMiss });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/uuid/);
      expect(InvoiceService.create).not.toHaveBeenCalled();
      expect(mintScheduledServiceInvoiceWithDeposit).not.toHaveBeenCalled();
    });
  });

  test('a well-formed uuid of any case is accepted by shape', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT.toUpperCase() });
      expect(res.status).toBe(201);
    });
  });

  test('without a visit id the create stays the unlinked, unlocked path', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, {});
      expect(res.status).toBe(201);
      expect(acquireScheduledInvoiceMintLock).not.toHaveBeenCalled();
      expect(mintScheduledServiceInvoiceWithDeposit).not.toHaveBeenCalled();
      expect(InvoiceService.create).toHaveBeenCalledWith(expect.not.objectContaining({ scheduledServiceId: expect.anything() }));
    });
  });
});

describe('POST /admin/invoices/:id/schedule-send on a linked visit (GitHub P1 #4131 r2/r3)', () => {
  const INVOICE = '44444444-4444-4444-8444-444444444444';
  const scheduleSend = (baseUrl) => fetch(`${baseUrl}/admin/invoices/${INVOICE}/schedule-send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduledFor: '2040-03-04T08:00' }),
  });
  let visitStatus;
  let update;
  beforeEach(() => {
    jest.clearAllMocks();
    completionStatusForService.mockResolvedValue({ state: 'none' });
    update = jest.fn(() => ({ returning: jest.fn(async () => [{ id: INVOICE, status: 'scheduled' }]) }));
    db.mockImplementation((table) => {
      if (table === 'invoices') return qb({ first: jest.fn(async () => ({ payer_statement_id: null, scheduled_service_id: VISIT })), update });
      if (table === 'scheduled_services') return qb({ first: jest.fn(async () => ({ id: VISIT, status: visitStatus })) });
      throw new Error(`unexpected table ${table}`);
    });
  });

  test.each([['confirmed'], [null]])('refuses a future send while the linked visit is still open (status %s) — the completion would send it first', async (status) => {
    visitStatus = status;
    await withServer(async (baseUrl) => {
      const res = await scheduleSend(baseUrl);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'LINKED_VISIT_OPEN', error: expect.stringContaining('open visit') });
      expect(update).not.toHaveBeenCalled();
      expect(completionStatusForService).not.toHaveBeenCalled();
    });
  });

  test('schedules normally once the linked visit is completed and its completion side effects have finished', async () => {
    visitStatus = 'completed';
    completionStatusForService.mockResolvedValue({ state: 'succeeded_other_key' });
    await withServer(async (baseUrl) => {
      const res = await scheduleSend(baseUrl);
      expect(res.status).toBe(200);
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'scheduled' }));
    });
  });

  // GitHub P1 #4131 r3 — a committed `completed` status alone does not prove
  // completion delivery finished: the closeout flips the attempt row to
  // side_effects_running/succeeded only as it runs. Fence on that signal.
  test.each([['running'], ['resumable']])('refuses while the completion side effects are still %s — nothing scheduled', async (state) => {
    visitStatus = 'completed';
    completionStatusForService.mockResolvedValue({ state });
    await withServer(async (baseUrl) => {
      const res = await scheduleSend(baseUrl);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'COMPLETION_IN_PROGRESS' });
      expect(update).not.toHaveBeenCalled();
    });
  });

  test('a legacy completion with no attempt row (state "none"/"completed_no_attempt") schedules normally', async () => {
    visitStatus = 'completed';
    completionStatusForService.mockResolvedValue({ state: 'completed_no_attempt', serviceRecordId: 'sr-1' });
    await withServer(async (baseUrl) => {
      const res = await scheduleSend(baseUrl);
      expect(res.status).toBe(200);
    });
  });
});

describe('GET /admin/invoices/service-records/:customerId', () => {
  // The visits query is found by call index below — start from a clean call log.
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => annualPrepayCoversVisit.mockImplementation(async () => false));
  test('returns the completed records AND the open visits for the picker', async () => {
    const records = [{ id: 'r1', service_date: '2040-02-01', service_type: 'Quarterly Pest Control Service', status: 'completed', tech_name: 'Adam' }];
    const open = [
      { id: VISIT, scheduled_date: '2040-03-04', service_type: 'Quarterly Pest Control Service', status: 'confirmed', tech_name: 'Adam', source_estimate_id: 'est-with-deposit' },
      { id: OTHER, scheduled_date: '2040-03-11', service_type: 'Mosquito Barrier Treatment', status: 'pending', tech_name: null, source_estimate_id: null },
      // Payer-billed (third-party Bill-To): the homeowner's deposit is never applied, so no preview credit.
      { id: '55555555-5555-4555-8555-555555555555', scheduled_date: '2040-03-18', service_type: 'Quarterly Pest Control Service', status: 'confirmed', tech_name: 'Adam', source_estimate_id: 'est-with-deposit' },
    ];
    db.mockImplementation((table) => {
      if (table === 'service_records') return qb({ limit: jest.fn(async () => records) });
      if (table === 'scheduled_services') return qb({ limit: jest.fn(async () => open.map((v) => ({ ...v }))) });
      throw new Error(`unexpected table ${table}`);
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/service-records/${CUSTOMER}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.records).toEqual(records);
      // The open-visit predicate admits a legacy NULL status beside the live vocabulary.
      const visitsQuery = db.mock.results[db.mock.calls.findIndex(([table]) => table === 'scheduled_services')].value;
      const predicate = { whereNull: jest.fn(function () { return this; }), orWhereIn: jest.fn(function () { return this; }), orWhere: jest.fn(function () { return this; }) };
      visitsQuery.where.mock.calls.filter(([arg]) => typeof arg === 'function').forEach(([fn]) => fn(predicate));
      expect(predicate.whereNull).toHaveBeenCalledWith('scheduled_services.status');
      expect(predicate.orWhereIn).toHaveBeenCalledWith('scheduled_services.status', ['pending', 'confirmed', 'en_route', 'on_site']);
      // The coverage inputs ride in the SELECT (pre-push P1 r3): annualPrepayCoversVisit
      // needs annual_prepay_term_id; the payer resolution needs customer_id.
      expect(visitsQuery.select.mock.calls[0]).toEqual(expect.arrayContaining(['scheduled_services.annual_prepay_term_id', 'scheduled_services.customer_id', 'scheduled_services.prepaid_method']));
      // The pending estimate deposit rides along for the form's balance preview; the estimate id itself does not.
      expect(body.openVisits).toEqual([
        { id: VISIT, scheduled_date: '2040-03-04', service_type: 'Quarterly Pest Control Service', status: 'confirmed', tech_name: 'Adam', deposit_credit: 50 },
        { id: OTHER, scheduled_date: '2040-03-11', service_type: 'Mosquito Barrier Treatment', status: 'pending', tech_name: null, deposit_credit: 0 },
        { id: '55555555-5555-4555-8555-555555555555', scheduled_date: '2040-03-18', service_type: 'Quarterly Pest Control Service', status: 'confirmed', tech_name: 'Adam', deposit_credit: 0 },
      ]);
    });
  });

  // Codex P1 r3 — a failed deposit (or payer) lookup must not surface the
  // visit with deposit_credit 0: the form would submit an expected credit of
  // 0 and a full-balance invoice could go out over a paid deposit.
  // Pre-push P1 r3 — the SQL limit is a batch size: when a whole first batch
  // is ineligible (prepaid), the next batch is read, so eligible visits
  // behind 40 prepaid ones still reach the picker.
  test('reads successive candidate batches until 20 eligible visits are collected or the candidates run out', async () => {
    const prepaid = (i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, scheduled_date: '2040-03-04', service_type: 'Quarterly Pest Control Service', status: 'confirmed', tech_name: 'Adam', source_estimate_id: null, prepaid_amount: 117, prepaid_method: 'cash', customer_id: CUSTOMER });
    const firstBatch = Array.from({ length: 40 }, (_, i) => prepaid(i));
    const secondBatch = [
      { id: OTHER, scheduled_date: '2040-03-11', service_type: 'Mosquito Barrier Treatment', status: 'pending', tech_name: null, source_estimate_id: null, prepaid_amount: null, prepaid_method: null, customer_id: CUSTOMER },
    ];
    const limit = jest.fn().mockResolvedValueOnce(firstBatch).mockResolvedValueOnce(secondBatch);
    const offsets = [];
    db.mockImplementation((table) => {
      if (table === 'service_records') return qb({ limit: jest.fn(async () => []) });
      if (table === 'scheduled_services') { const q = qb({ limit }); q.offset = jest.fn((o) => { offsets.push(o); return q; }); return q; }
      throw new Error(`unexpected table ${table}`);
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/service-records/${CUSTOMER}`);
      expect(res.status).toBe(200);
      expect((await res.json()).openVisits).toEqual([
        { id: OTHER, scheduled_date: '2040-03-11', service_type: 'Mosquito Barrier Treatment', status: 'pending', tech_name: null, deposit_credit: 0 },
      ]);
      // Two batches: offsets 0 and 40; the second was short, so no third read.
      expect(offsets).toEqual([0, 40]);
      expect(limit).toHaveBeenCalledTimes(2);
    });
  });

  test('a visit whose payer lookup fails is not offered (strict resolution, never read as self-pay)', async () => {
    resolveForInvoice.mockRejectedValueOnce(new Error('payer schema probe failed'));
    const open = [
      { id: VISIT, scheduled_date: '2040-03-04', service_type: 'Quarterly Pest Control Service', status: 'confirmed', tech_name: 'Adam', source_estimate_id: null, customer_id: CUSTOMER },
      { id: OTHER, scheduled_date: '2040-03-11', service_type: 'Mosquito Barrier Treatment', status: 'pending', tech_name: null, source_estimate_id: null, customer_id: CUSTOMER },
    ];
    db.mockImplementation((table) => {
      if (table === 'service_records') return qb({ limit: jest.fn(async () => []) });
      if (table === 'scheduled_services') return qb({ limit: jest.fn(async () => open.map((v) => ({ ...v }))) });
      throw new Error(`unexpected table ${table}`);
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/service-records/${CUSTOMER}`);
      expect((await res.json()).openVisits.map((v) => v.id)).toEqual([OTHER]);
      expect(resolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({ throwOnError: true }));
    });
  });

  test('a visit whose deposit lookup fails is not offered at all (never deposit_credit 0)', async () => {
    const { pendingDepositCredit } = require('../services/estimate-deposits');
    pendingDepositCredit.mockRejectedValueOnce(new Error('deposit ledger unavailable'));
    const open = [
      { id: VISIT, scheduled_date: '2040-03-04', service_type: 'Quarterly Pest Control Service', status: 'confirmed', tech_name: 'Adam', source_estimate_id: 'est-with-deposit', customer_id: CUSTOMER },
      { id: OTHER, scheduled_date: '2040-03-11', service_type: 'Mosquito Barrier Treatment', status: 'pending', tech_name: null, source_estimate_id: null, customer_id: CUSTOMER },
    ];
    db.mockImplementation((table) => {
      if (table === 'service_records') return qb({ limit: jest.fn(async () => []) });
      if (table === 'scheduled_services') return qb({ limit: jest.fn(async () => open.map((v) => ({ ...v }))) });
      throw new Error(`unexpected table ${table}`);
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/service-records/${CUSTOMER}`);
      expect(res.status).toBe(200);
      expect((await res.json()).openVisits).toEqual([
        { id: OTHER, scheduled_date: '2040-03-11', service_type: 'Mosquito Barrier Treatment', status: 'pending', tech_name: null, deposit_credit: 0 },
      ]);
    });
  });

  test('a partially prepaid visit, an annual-prepaid visit under a live term, and an unverifiable annual stamp are not offered; internal columns never reach the wire', async () => {
    const open = [
      { id: VISIT, scheduled_date: '2040-03-04', service_type: 'Quarterly Pest Control Service', status: 'confirmed', tech_name: 'Adam', source_estimate_id: null, prepaid_amount: 50, prepaid_method: 'zelle', customer_id: CUSTOMER },
      { id: OTHER, scheduled_date: '2040-03-11', service_type: 'Quarterly Pest Control Service', status: 'confirmed', tech_name: 'Adam', source_estimate_id: null, prepaid_amount: 117, prepaid_method: ANNUAL_PREPAY_PREPAID_METHOD, annual_prepay_term_id: 'term-1', customer_id: CUSTOMER },
      { id: '66666666-6666-4666-8666-666666666666', scheduled_date: '2040-03-18', service_type: 'Quarterly Pest Control Service', status: 'confirmed', tech_name: 'Adam', source_estimate_id: null, prepaid_amount: null, prepaid_method: null, annual_prepay_term_id: null, customer_id: CUSTOMER, estimated_price: 117 },
    ];
    open.push({ id: '77777777-7777-4777-8777-777777777777', scheduled_date: '2040-03-25', service_type: 'Quarterly Pest Control Service', status: 'confirmed', tech_name: 'Adam', source_estimate_id: null, prepaid_amount: 117, prepaid_method: ANNUAL_PREPAY_PREPAID_METHOD, annual_prepay_term_id: null, customer_id: CUSTOMER });
    // Strict verification: a live term refuses; an UNVERIFIABLE stamp (no term id) throws and is not offered either.
    annualPrepayCoversVisit.mockImplementation(async (visit, _conn, opts) => {
      expect(opts).toEqual({ throwOnError: true });
      if (!visit.annual_prepay_term_id) throw new Error('stamped visit carries no annual_prepay_term_id — coverage unverifiable');
      return visit.annual_prepay_term_id === 'term-1';
    });
    db.mockImplementation((table) => {
      if (table === 'service_records') return qb({ limit: jest.fn(async () => []) });
      if (table === 'scheduled_services') return qb({ limit: jest.fn(async () => open.map((v) => ({ ...v }))) });
      throw new Error(`unexpected table ${table}`);
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/invoices/service-records/${CUSTOMER}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(annualPrepayCoversVisit).toHaveBeenCalledWith(expect.objectContaining({ id: OTHER, annual_prepay_term_id: 'term-1' }), expect.anything(), { throwOnError: true });
      expect(body.openVisits).toEqual([
        { id: '66666666-6666-4666-8666-666666666666', scheduled_date: '2040-03-18', service_type: 'Quarterly Pest Control Service', status: 'confirmed', tech_name: 'Adam', deposit_credit: 0 },
      ]);
    });
  });
});

describe('POST /admin/invoices/:id/send on a pre-completion linked invoice (Codex P1 #4131 r4)', () => {
  const INVOICE = '44444444-4444-4444-8444-444444444444';
  const send = (baseUrl, body) => fetch(`${baseUrl}/admin/invoices/${INVOICE}/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let linkage;
  let sendSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    sendSpy = jest.spyOn(InvoiceService, 'sendViaSMSAndEmail').mockResolvedValue({ ok: true, sms: { ok: true }, email: { ok: false, skipped: true }, payUrl: 'https://pay.example.test/x' });
    db.mockImplementation((table) => {
      if (table === 'invoices') return qb({ first: jest.fn(async () => linkage) });
      throw new Error(`unexpected table ${table}`);
    });
  });
  afterEach(() => sendSpy.mockRestore());

  test('drops the review ask when the invoice is linked to an open visit with no service record yet', async () => {
    linkage = { scheduled_service_id: VISIT, service_record_id: null };
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, { requestReview: true, reviewDelayMinutes: 120 });
      expect(res.status).toBe(200);
      expect(sendSpy).toHaveBeenCalledWith(INVOICE, expect.objectContaining({ requestReview: false }));
    });
  });

  test('the create flow\'s immediate send is a FIRST delivery: the claim\'s already_delivered refusal is a no-op success, the operator\'s own send never passes the flag (GitHub r6 P1)', async () => {
    linkage = { scheduled_service_id: VISIT, service_record_id: null };
    sendSpy.mockRejectedValueOnce(Object.assign(new Error('Invoice WPC-1 was already delivered (status: sent) — not sent again'), { code: 'already_delivered' }));
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, { firstDelivery: true, requestReview: false });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, already_delivered: true, sms: { ok: false, code: 'already_delivered' } });
      expect(sendSpy).toHaveBeenCalledWith(INVOICE, expect.objectContaining({ firstDeliveryOnly: true }));
    });
    await withServer(async (baseUrl) => {
      await send(baseUrl, { requestReview: false });
      expect(sendSpy).toHaveBeenLastCalledWith(INVOICE, expect.objectContaining({ firstDeliveryOnly: false }));
    });
  });

  test('a FIRST delivery finding the completion\'s QUEUED text (queued_pay_link) is the same no-op success; the operator\'s own send still surfaces it (Codex P2 r8)', async () => {
    linkage = { scheduled_service_id: VISIT, service_record_id: null };
    const queued = () => Object.assign(new Error('Invoice send already in progress — a text carrying this pay link is queued for the send window; it delivers then'), { code: 'queued_pay_link' });
    sendSpy.mockRejectedValueOnce(queued());
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, { firstDelivery: true, requestReview: false });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, queued_delivery: true, sms: { ok: false, code: 'queued_pay_link' }, email: { ok: false, code: 'queued_pay_link' } });
    });
    sendSpy.mockRejectedValueOnce(queued());
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, { requestReview: false });
      expect(res.status).toBe(409); // not a first delivery: the refusal surfaces to the operator as before
      expect(await res.json()).not.toMatchObject({ queued_delivery: true });
    });
  });

  test('a linkage lookup that FAILS fails closed on the review ask: refused (409 linkage_unverifiable) with an ask, proceeds without one (Codex P1 r8)', async () => {
    db.mockImplementation((table) => {
      if (table === 'invoices') return qb({ first: jest.fn(async () => { throw new Error('connection reset'); }) });
      throw new Error(`unexpected table ${table}`);
    });
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, { requestReview: true, reviewDelayMinutes: 120 });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'linkage_unverifiable' });
      expect(sendSpy).not.toHaveBeenCalled();
    });
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, { requestReview: false });
      expect(res.status).toBe(200);
      expect(sendSpy).toHaveBeenCalledWith(INVOICE, expect.objectContaining({ requestReview: false }));
    });
  });

  test('keeps the operator\'s review ask for a standalone or completion-linked invoice', async () => {
    linkage = { scheduled_service_id: null, service_record_id: null };
    await withServer(async (baseUrl) => {
      await send(baseUrl, { requestReview: true, reviewDelayMinutes: 120 });
      expect(sendSpy).toHaveBeenCalledWith(INVOICE, expect.objectContaining({ requestReview: true }));
    });
    linkage = { scheduled_service_id: VISIT, service_record_id: 'sr-1' };
    await withServer(async (baseUrl) => {
      await send(baseUrl, { requestReview: true, reviewDelayMinutes: 120 });
      expect(sendSpy).toHaveBeenLastCalledWith(INVOICE, expect.objectContaining({ requestReview: true }));
    });
  });
});
