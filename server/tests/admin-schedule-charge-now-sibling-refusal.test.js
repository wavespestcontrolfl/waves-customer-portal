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
  q.first = jest.fn(async () => (table === 'scheduled_services' ? mockDb.__svcRow : undefined));
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
        expect.objectContaining({ id: 'svc-lawn' }), fakeTrx, { lockRows: true },
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

    test('refuses the mint when a concurrent refund flips "covered" to "none" under the lock', async () => {
      findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
        invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
        liveBeside: null,
      });
      mockMint.mockImplementation(async ({ buildCreateParams }) => {
        buildCreateParams();
        throw new Error('stop-after-capture');
      });
      // A 'covered' base resolves to 0 — an operator-added extra is needed
      // for the route's "nothing chargeable" gate to let the mint through
      // at all (the base alone would 400 before ever reaching it).
      const { req, res, next } = makeReqRes({
        extraLineItems: [{ description: 'Extra treatment', quantity: 1, unit_price: 40, amount: 40 }],
      });
      await handler(req, res, next);
      const { recheckInTrx } = mockMint.mock.calls[0][0];

      // The covering sibling invoice was refunded between the pre-lock read
      // and the locked recheck.
      findFirstApplicationInvoiceForEstimateService.mockResolvedValue({ invoice: null, liveBeside: null });
      await expect(recheckInTrx({})).rejects.toMatchObject({
        status: 409, code: 'SIBLING_COVERAGE_CHANGED',
      });
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
    expect(findFirstApplicationInvoiceForEstimateService).toHaveBeenCalledWith(SVC, {}, { lockRows: true });
  });
});
