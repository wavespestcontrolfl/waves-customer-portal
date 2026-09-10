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
const { completionStatusForService } = require('../services/completion-attempts');
const router = require('../routes/admin-invoices');

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const VISIT = '33333333-3333-4333-8333-333333333333';
const PAYER_VISIT = '55555555-5555-4555-8555-555555555555';

function qb(overrides = {}) {
  const q = {};
  for (const m of ['where', 'whereIn', 'leftJoin', 'select', 'orderBy', 'limit', 'whereNull', 'whereNot', 'whereNotExists', 'modify']) q[m] = jest.fn(() => q);
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

  test('ownership and open status are re-verified ROW-LOCKED inside the mint chain — a visit cancelled in between is refused', async () => {
    mintScheduledServiceInvoiceWithDeposit.mockImplementationOnce(async ({ assertEligibleInTrx }) => {
      // The chain calls the hook on its transaction after the advisory lock.
      const lockedRow = { id: VISIT, customer_id: CUSTOMER, status: 'cancelled' };
      const trx = () => qb({ forUpdate: jest.fn(() => ({ first: jest.fn(async () => lockedRow) })) });
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
  test('an annual-prepay stamp whose coverage cannot be verified is refused (409 visit_prepaid_unverifiable) — nothing created', async () => {
    visitRow = { id: VISIT, customer_id: CUSTOMER, status: 'confirmed', prepaid_amount: 117, prepaid_method: ANNUAL_PREPAY_PREPAID_METHOD, annual_prepay_term_id: null };
    annualPrepayCoversVisit.mockRejectedValueOnce(new Error('stamped visit carries no annual_prepay_term_id — coverage unverifiable'));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_prepaid_unverifiable' });
      expect(annualPrepayCoversVisit).toHaveBeenCalledWith(expect.objectContaining({ id: VISIT }), expect.anything(), { throwOnError: true });
      expect(mintScheduledServiceInvoiceWithDeposit).not.toHaveBeenCalled();
    });
  });

  test('an annual-prepay stamp that becomes unverifiable under the lock is refused inside the chain', async () => {
    visitRow = { id: VISIT, customer_id: CUSTOMER, status: 'confirmed', prepaid_amount: 117, prepaid_method: ANNUAL_PREPAY_PREPAID_METHOD, annual_prepay_term_id: 'term-1' };
    annualPrepayCoversVisit.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('annual_prepay_terms read failed'));
    mintScheduledServiceInvoiceWithDeposit.mockImplementationOnce(async ({ assertEligibleInTrx }) => {
      const trx = () => qb({ forUpdate: jest.fn(() => ({ first: jest.fn(async () => ({ ...visitRow })) })) });
      await assertEligibleInTrx(trx);
      throw new Error('hook should have refused');
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_prepaid_unverifiable' });
    });
  });

  test('a payer-billed visit is never covered by the homeowner prepayment, however large', async () => {
    visitRow = { id: PAYER_VISIT, customer_id: CUSTOMER, status: 'confirmed', prepaid_amount: 999 };
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: PAYER_VISIT });
      expect(res.status).toBe(201);
    });
  });

  test('a prepayment recorded between the pre-check and the lock is refused inside the chain', async () => {
    mintScheduledServiceInvoiceWithDeposit.mockImplementationOnce(async ({ assertEligibleInTrx }) => {
      const lockedRow = { id: VISIT, customer_id: CUSTOMER, status: 'confirmed', prepaid_amount: 117 };
      const trx = () => qb({ forUpdate: jest.fn(() => ({ first: jest.fn(async () => lockedRow) })) });
      await assertEligibleInTrx(trx);
      throw new Error('hook should have refused');
    });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { scheduledServiceId: VISIT });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'visit_prepaid' });
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
