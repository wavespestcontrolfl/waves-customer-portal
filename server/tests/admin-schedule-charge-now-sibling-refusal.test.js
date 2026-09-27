/**
 * POST /:id/invoice (Charge Now mint) — sibling-lookup refusal.
 *
 * Codex round-2 P1: resolveScheduledServiceCharge used to return the SAME
 * bare 0 for a sibling-coverage lookup that came back 'error' or
 * 'needs_review' as it does for a genuinely 'covered' visit. That 0 only
 * blocked THIS endpoint's "nothing chargeable" gate when extraLineItems
 * were also empty — the instant a checkout extra carried a positive total,
 * `!(amount > 0) && extrasTotal <= 0` was false and the route minted an
 * extras-only invoice, silently dropping the visit's real setup/application
 * fee. Completion then found that own live invoice first and never raised
 * the manual-billing alert for the missing fee.
 *
 * This suite pins that an unresolved sibling lookup now refuses the ENTIRE
 * mint — base AND extras — with a retryable 409, never a partial extras
 * invoice. Follows this repo's route-test convention (no supertest
 * harness): locate the handler on router.stack and drive it directly
 * against mocked deps (mirrors admin-schedule-checkout-stacking-gate.test.js).
 */
jest.mock('../services/estimate-first-application-invoice', () => ({
  findFirstApplicationInvoiceForEstimateService: jest.fn(),
}));

const mockDb = jest.fn((table) => {
  const q = {};
  q.where = jest.fn(() => q);
  q.whereNot = jest.fn(() => q);
  q.whereNotIn = jest.fn(() => q);
  q.orderBy = jest.fn(() => q);
  q.modify = jest.fn((fn) => { fn(q); return q; });
  q.leftJoin = jest.fn(() => q);
  q.select = jest.fn(() => q);
  q.first = jest.fn(async () => {
    if (table === 'scheduled_services') return mockDb.__svcRow;
    // Codex round-9 P1: a legacy invoice already attached to THIS visit's
    // own scheduled_service_id (e.g. an extras-only invoice minted before
    // the sibling-coverage lookup existed) — set only by the tests below
    // that prove the reuse block never bypasses a 'covered'/'needs_review'
    // verdict.
    if (table === 'invoices') return mockDb.__existingInvoiceRow;
    return undefined;
  });
  return q;
});
mockDb.schema = { hasTable: jest.fn(async () => false) };
jest.mock('../models/db', () => mockDb);

const mockMint = jest.fn();
jest.mock('../services/scheduled-invoice-mint', () => ({
  mintScheduledServiceInvoiceWithDeposit: (...args) => mockMint(...args),
}));

const mockResolveForInvoice = jest.fn(async () => ({ payerId: null }));
jest.mock('../services/payer', () => ({
  resolveForInvoice: (...args) => mockResolveForInvoice(...args),
}));

const mockBuildLineItems = jest.fn(async () => ({ lineItems: [], discountIds: [] }));
jest.mock('../services/invoice', () => ({
  buildLineItemsForScheduledService: (...args) => mockBuildLineItems(...args),
  CANCELLED_SERVICE_RESOLVED_STATUSES: ['refunded', 'canceled', 'void'],
}));

const { findFirstApplicationInvoiceForEstimateService } = require('../services/estimate-first-application-invoice');
const adminScheduleRouter = require('../routes/admin-schedule');

const layer = adminScheduleRouter.stack.find(
  (l) => l.route && l.route.path === '/:id/invoice' && l.route.methods.post,
);
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

// An unpriced per_application visit whose customer carries an established
// acceptance fee — the exact shape resolveScheduledServiceCharge's own
// sibling-coverage guard inspects (source_estimate_id + scheduled_date feed
// findFirstApplicationInvoiceForEstimateService).
const SVC_ROW = {
  id: 'svc-lawn', customer_id: 'cust-1', source_estimate_id: 'est-1', scheduled_date: '2026-09-27',
  estimated_price: null, is_callback: false, prepaid_method: null, prepaid_amount: null,
  cust_monthly_rate: 74.7, cust_billing_mode: 'per_application', service_type: 'Every 6 Weeks Lawn Care',
  cust_per_application_fee: 97.2,
};

function makeReqRes(body) {
  const req = { params: { id: 'svc-lawn' }, body, headers: {} };
  const res = {
    statusCode: 200,
    body: undefined,
    status: jest.fn(function status(c) { this.statusCode = c; return this; }),
    json: jest.fn(function json(b) { this.body = b; return this; }),
  };
  const next = jest.fn();
  return { req, res, next };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.__svcRow = SVC_ROW;
  mockDb.__existingInvoiceRow = undefined;
  mockResolveForInvoice.mockResolvedValue({ payerId: null });
  mockBuildLineItems.mockResolvedValue({ lineItems: [], discountIds: [] });
});

describe('POST /:id/invoice — sibling-lookup refusal (codex round-2 P1)', () => {
  test('a lookup FAILURE refuses the whole mint with a retryable 409 — never a bare 400 "no chargeable amount"', async () => {
    findFirstApplicationInvoiceForEstimateService.mockRejectedValue(new Error('db down'));
    const { req, res, next } = makeReqRes({});
    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body.error).toMatch(/refresh and try again/i);
    expect(mockMint).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('a terminal/refunded sibling match (needs_review) refuses the whole mint with a retryable 409', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'refunded', total: 153.6 },
      liveBeside: { id: 'inv-2', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
    });
    const { req, res, next } = makeReqRes({});
    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body.error).toMatch(/manual review/i);
    expect(mockMint).not.toHaveBeenCalled();
  });

  // This is the exact bug: pre-fix, resolveScheduledServiceCharge returned
  // 0 for this verdict, `!(0 > 0) && extrasTotal <= 0` was FALSE because
  // extrasTotal is positive, and the route minted an extras-only invoice
  // for the visit — dropping the real acceptance fee. Post-fix, the
  // refusal must be checked BEFORE extras are even considered.
  test('an operator-added checkout extra does NOT slip the refusal into an extras-only mint', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: null,
      liveBeside: null,
      canceledSetupFee: { id: 'inv-3', invoice_number: 'WPC-2026-0400', status: 'canceled' },
    });
    const { req, res, next } = makeReqRes({
      extraLineItems: [{ description: 'Extra treatment', quantity: 1, unit_price: 40, amount: 40 }],
    });
    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockMint).not.toHaveBeenCalled();
  });

  // Codex round 5 P2: a callback's base charge is always zeroed by
  // completionInvoiceAmount regardless of what the sibling lookup would
  // have said (isCallback short-circuits before perApplicationBilling is
  // even consulted) — so the lookup can only ever 409 a checkout extra
  // for a trip the callback itself can never rebill. Excluded the same
  // way always-free service types already are: the lookup must never run
  // for a callback, and a positive extra must mint normally even when the
  // (unconsulted) sibling verdict would have been needs_review/error.
  test('a callback never runs the sibling lookup — a checkout extra mints normally even though the (unconsulted) verdict would refuse', async () => {
    mockDb.__svcRow = { ...SVC_ROW, is_callback: true };
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'refunded', total: 153.6 },
      liveBeside: null,
    });
    mockMint.mockImplementation(async ({ buildCreateParams }) => {
      buildCreateParams();
      throw new Error('stop-after-capture');
    });
    const { req, res, next } = makeReqRes({
      extraLineItems: [{ description: 'Extra treatment', quantity: 1, unit_price: 40, amount: 40 }],
    });
    await handler(req, res, next);

    expect(findFirstApplicationInvoiceForEstimateService).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(mockMint).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('a definitive "none" verdict still mints the established fee normally', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({ invoice: null, liveBeside: null });
    mockMint.mockImplementation(async ({ buildCreateParams }) => {
      buildCreateParams();
      throw new Error('stop-after-capture');
    });
    const { req, res, next } = makeReqRes({});
    await handler(req, res, next);

    expect(mockMint).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // Codex round-6 P1: this gate used to be `perApplicationBilling &&
  // !isCallback && !hasOwnPrice` — the CUSTOMER'S CURRENT billing mode. A
  // combined pay-per-application accept leaves the PROMOTED row unpriced
  // and its first-application invoice on the RESERVED sibling; if the
  // customer is later moved to monthly/legacy-null dues (a lane change),
  // the old gate skipped the sibling lookup entirely and fell through to
  // `monthly_rate`, minting a SECOND collectible base charge beside the
  // sibling's still-live invoice. The fix gates on the visit's own shape
  // (isSiblingCoverageEligibleVisit, billing-lane.js) instead, so the
  // lookup still runs — and the mint still refuses the double charge —
  // no matter what lane the customer is on today.
  test('a lane-changed customer (per_application → monthly) still runs the sibling lookup off the visit\'s own shape, not the current billing mode', async () => {
    mockDb.__svcRow = { ...SVC_ROW, cust_billing_mode: 'monthly_membership', cust_monthly_rate: 74.7 };
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
      liveBeside: null,
    });
    const { req, res, next } = makeReqRes({});
    await handler(req, res, next);

    // The lookup ran despite `cust_billing_mode` no longer being
    // 'per_application' — proving the gate reads the visit's shape, not
    // the mutable lane.
    expect(findFirstApplicationInvoiceForEstimateService).toHaveBeenCalled();
    // Owner decision (round-8 P1, narrow + fail closed): a definitive
    // 'covered' verdict now refuses the mint OUTRIGHT with a 409, never
    // falls through to $0-plus-extras — the pre-fix regression instead fell
    // through to the $74.70 monthly rate and minted it, a real second
    // charge beside the sibling's invoice.
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body.error).toMatch(/combined trip invoice/i);
    expect(mockMint).not.toHaveBeenCalled();
  });

  test('a lane-changed customer with an unresolved sibling verdict (needs_review) still refuses instead of charging the monthly rate', async () => {
    mockDb.__svcRow = { ...SVC_ROW, cust_billing_mode: null, cust_monthly_rate: 74.7 };
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'refunded', total: 153.6 },
      liveBeside: { id: 'inv-2', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
    });
    const { req, res, next } = makeReqRes({});
    await handler(req, res, next);

    expect(findFirstApplicationInvoiceForEstimateService).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body.error).toMatch(/manual review/i);
    expect(mockMint).not.toHaveBeenCalled();
  });

  // Codex pre-push P1 (round 3): resolveScheduledServiceCharge's verdict is
  // read on a plain connection BEFORE mintScheduledServiceInvoiceWithDeposit
  // opens its locked transaction — a concurrent refund/restoration can
  // invalidate it before the invoice is actually created. The route must
  // pass a `recheckInTrx` that re-runs the SAME lookup (lockRows: true, so
  // it holds the matched row to commit) and refuses the mint if the status
  // changed.
  describe('recheckInTrx — the sibling verdict is re-proven inside the mint lock', () => {
    test('passes a recheckInTrx for a "none" verdict, which re-runs the lookup WITH lockRows: true', async () => {
      findFirstApplicationInvoiceForEstimateService.mockResolvedValue({ invoice: null, liveBeside: null });
      mockMint.mockImplementation(async ({ buildCreateParams }) => {
        buildCreateParams();
        throw new Error('stop-after-capture');
      });
      const { req, res, next } = makeReqRes({});
      await handler(req, res, next);

      const { recheckInTrx } = mockMint.mock.calls[0][0];
      expect(typeof recheckInTrx).toBe('function');
      findFirstApplicationInvoiceForEstimateService.mockClear();
      // Unchanged verdict ('none' again) — the recheck proceeds silently.
      findFirstApplicationInvoiceForEstimateService.mockResolvedValue({ invoice: null, liveBeside: null });
      const fakeTrx = {};
      await expect(recheckInTrx(fakeTrx)).resolves.toBeUndefined();
      expect(findFirstApplicationInvoiceForEstimateService).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'svc-lawn' }), fakeTrx, { lockRows: true, noWait: true },
      );
    });

    test('refuses the mint when a concurrent refund flips "none" to a live sibling match ("covered") under the lock', async () => {
      findFirstApplicationInvoiceForEstimateService.mockResolvedValue({ invoice: null, liveBeside: null });
      mockMint.mockImplementation(async ({ buildCreateParams }) => {
        buildCreateParams();
        throw new Error('stop-after-capture');
      });
      const { req, res, next } = makeReqRes({});
      await handler(req, res, next);
      const { recheckInTrx } = mockMint.mock.calls[0][0];

      // A sibling invoice was restored between the pre-lock read and the
      // locked recheck — the verdict is now 'covered'.
      findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
        invoice: { id: 'inv-restored', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
        liveBeside: null,
      });
      await expect(recheckInTrx({})).rejects.toMatchObject({
        status: 409, code: 'SIBLING_COVERAGE_CHANGED',
      });
    });

    // Owner decision (round-8 P1, narrow + fail closed): a definitive
    // 'covered' verdict now refuses the mint OUTRIGHT — no zero-base-plus-
    // extras path exists any more for Charge Now to mint AROUND coverage.
    // The mint (and any recheckInTrx) is never reached at all, even with an
    // operator-added checkout extra — this replaces the old "covered
    // resolves the base to 0, extras make it chargeable, recheck catches a
    // concurrent refund" scenario, which no longer occurs because 'covered'
    // never gets that far pre-lock.
    test('a definitive "covered" verdict refuses the ENTIRE mint before the lock — no extras-only path around it', async () => {
      findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
        invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
        liveBeside: null,
      });
      const { req, res, next } = makeReqRes({
        extraLineItems: [{ description: 'Extra treatment', quantity: 1, unit_price: 40, amount: 40 }],
      });
      await handler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.body.error).toMatch(/combined trip invoice/i);
      expect(mockMint).not.toHaveBeenCalled();
    });

    test('no recheckInTrx at all when the visit has its own explicit price (the sibling lookup never ran)', async () => {
      mockDb.__svcRow = { ...SVC_ROW, estimated_price: 150 };
      mockMint.mockImplementation(async ({ buildCreateParams }) => {
        buildCreateParams();
        throw new Error('stop-after-capture');
      });
      const { req, res, next } = makeReqRes({});
      await handler(req, res, next);

      expect(findFirstApplicationInvoiceForEstimateService).not.toHaveBeenCalled();
      expect(mockMint.mock.calls[0][0].recheckInTrx).toBeNull();
    });
  });

  // Codex round-9 P1: a legacy invoice can already sit on THIS visit's own
  // scheduled_service_id from before the sibling-coverage lookup existed
  // (e.g. an operator-added extras-only invoice). The pre-fix route
  // returned that invoice via the "reuse existing" branch WITHOUT ever
  // asking whether a sibling invoice actually covers the trip — completion
  // then found the sibling's own live invoice and never reconciled the
  // stale one. The sibling verdict must be checked BEFORE any existing
  // invoice is even looked up, so a 'covered'/'needs_review' verdict
  // refuses instead of handing back the stale invoice.
  describe('own-invoice reuse never bypasses the sibling verdict (codex round-9 P1)', () => {
    test('a "covered" sibling verdict refuses even though this visit already has its OWN attached invoice', async () => {
      mockDb.__existingInvoiceRow = {
        id: 'inv-legacy', status: 'sent', total: 40, token: 'tok-legacy',
        scheduled_service_id: 'svc-lawn', payer_id: null,
      };
      findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
        invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
        liveBeside: null,
      });
      const { req, res, next } = makeReqRes({});
      await handler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.body.error).toMatch(/combined trip invoice/i);
      // Never the stale reuse response for the legacy invoice.
      expect(res.body).not.toMatchObject({ reused: true, invoiceId: 'inv-legacy' });
      expect(mockMint).not.toHaveBeenCalled();
    });

    test('a "needs_review" sibling verdict also refuses instead of reusing this visit\'s own existing invoice', async () => {
      mockDb.__existingInvoiceRow = {
        id: 'inv-legacy', status: 'sent', total: 40, token: 'tok-legacy',
        scheduled_service_id: 'svc-lawn', payer_id: null,
      };
      findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
        invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'refunded', total: 153.6 },
        liveBeside: { id: 'inv-2', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
      });
      const { req, res, next } = makeReqRes({});
      await handler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.body.error).toMatch(/manual review/i);
      expect(res.body).not.toMatchObject({ reused: true, invoiceId: 'inv-legacy' });
      expect(mockMint).not.toHaveBeenCalled();
    });

    test('a "none" verdict still reuses this visit\'s own existing invoice normally', async () => {
      mockDb.__existingInvoiceRow = {
        id: 'inv-legacy', status: 'sent', total: 97.2, token: 'tok-legacy',
        scheduled_service_id: 'svc-lawn', payer_id: null,
      };
      findFirstApplicationInvoiceForEstimateService.mockResolvedValue({ invoice: null, liveBeside: null });
      const { req, res, next } = makeReqRes({});
      await handler(req, res, next);

      expect(res.status).not.toHaveBeenCalledWith(409);
      expect(res.body).toMatchObject({ success: true, reused: true, invoiceId: 'inv-legacy' });
      expect(mockMint).not.toHaveBeenCalled();
    });
  });
});

// mintOrReuseScheduledServiceInvoice backs the Mark-prepaid / prepaid-receipt
// mint (generatePrepaidReceiptForService). It never throws to its caller —
// it must translate resolveScheduledServiceCharge's structured refusal into
// the SAME { invoice: null, reason } shape it already reports every other
// refusal in, so the reason surfaces through receipt.reason on the modal
// instead of a bare 0 quietly minting an extras-only invoice.
describe('mintOrReuseScheduledServiceInvoice — sibling-lookup refusal', () => {
  const { mintOrReuseScheduledServiceInvoice } = adminScheduleRouter._test;
  const SVC = { ...SVC_ROW };

  test('a lookup failure refuses to mint with a structured reason, not a $0 invoice', async () => {
    findFirstApplicationInvoiceForEstimateService.mockRejectedValue(new Error('db down'));
    const result = await mintOrReuseScheduledServiceInvoice(SVC);
    expect(result).toEqual({ invoice: null, reason: 'sibling_lookup_failed' });
    expect(mockMint).not.toHaveBeenCalled();
  });

  test('a needs_review verdict refuses to mint with a structured reason', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: null,
      liveBeside: null,
      canceledSetupFee: { id: 'inv-3', invoice_number: 'WPC-2026-0400', status: 'canceled' },
    });
    const result = await mintOrReuseScheduledServiceInvoice(SVC);
    expect(result).toEqual({ invoice: null, reason: 'sibling_invoice_needs_review' });
    expect(mockMint).not.toHaveBeenCalled();
  });

  // Round-8 P1 (owner decision — narrow + fail closed): a definitive
  // 'covered' verdict is ALSO a flat refusal now — MarkPrepaidModal's
  // RECEIPT_REASON_TEXT has copy for this exact reason.
  test('a definitive "covered" verdict refuses to mint with a structured reason, never a $0 "nothing chargeable"', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
      liveBeside: null,
    });
    const result = await mintOrReuseScheduledServiceInvoice(SVC);
    expect(result).toEqual({ invoice: null, reason: 'sibling_invoice_covered' });
    expect(mockMint).not.toHaveBeenCalled();
  });

  test('a "none" verdict mints and passes a recheckInTrx that re-proves coverage under the lock', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({ invoice: null, liveBeside: null });
    mockMint.mockImplementation(async ({ buildCreateParams }) => {
      buildCreateParams();
      return { invoice: { id: 'inv-new' }, reused: false };
    });
    const result = await mintOrReuseScheduledServiceInvoice(SVC);
    expect(result).toEqual({ invoice: { id: 'inv-new' }, reused: false });
    const { recheckInTrx } = mockMint.mock.calls[0][0];
    expect(typeof recheckInTrx).toBe('function');

    findFirstApplicationInvoiceForEstimateService.mockClear();
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-restored', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
      liveBeside: null,
    });
    await expect(recheckInTrx({})).rejects.toMatchObject({ code: 'SIBLING_COVERAGE_CHANGED' });
    expect(findFirstApplicationInvoiceForEstimateService).toHaveBeenCalledWith(SVC, {}, { lockRows: true, noWait: true });
  });

  // Codex round-9 P1 (the same fix as the Charge Now route above): a legacy
  // invoice already on svc's own scheduled_service_id must not be reused
  // when the sibling verdict is anything but 'none'.
  test('a "covered" sibling verdict refuses to mint even though svc already has its OWN existing invoice', async () => {
    mockDb.__existingInvoiceRow = { id: 'inv-legacy', status: 'sent', total: 40, scheduled_service_id: 'svc-lawn' };
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
      liveBeside: null,
    });
    const result = await mintOrReuseScheduledServiceInvoice(SVC);
    expect(result).toEqual({ invoice: null, reason: 'sibling_invoice_covered' });
    expect(mockMint).not.toHaveBeenCalled();
  });

  test('a "none" verdict still reuses svc\'s own existing invoice normally', async () => {
    mockDb.__existingInvoiceRow = { id: 'inv-legacy', status: 'sent', total: 97.2, scheduled_service_id: 'svc-lawn' };
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({ invoice: null, liveBeside: null });
    const result = await mintOrReuseScheduledServiceInvoice(SVC);
    expect(result).toEqual({ invoice: mockDb.__existingInvoiceRow, reused: true });
    expect(mockMint).not.toHaveBeenCalled();
  });
});
