/**
 * POST /:id/invoice (mobile checkout mint) — expected_discount_stacking.
 *
 * Mirrors the server pattern #4655 already shipped for InvoiceService.create
 * / calculateUpdateFinancials (server/services/invoice.js): a client that
 * previewed under one GATE_DISCOUNT_STACKING regime and posts money under a
 * DIFFERENT live regime (a flip mid-session, or a rolling deploy routing the
 * probe and this write to pods reading different values) must not silently
 * mint the opposite math from what the technician is looking at. This test
 * pins that the mint endpoint (1) forwards the client's previewed gate state
 * through to InvoiceService.create() via buildCreateParams, (2) omits the
 * field entirely — byte-identical to every caller before this slice — when
 * the client sends none, and (3) surfaces the DISCOUNT_STACKING_GATE_DIVERGED
 * 409 InvoiceService.create() throws on a mismatch, retryable rather than a
 * generic 500.
 *
 * Follows this repo's convention for route files with no supertest harness
 * (see track-public-stops-ahead-post.test.js): locate the handler on
 * router.stack and drive it directly against mocked deps.
 */
const mockDb = jest.fn((table) => {
  const q = {};
  q.where = jest.fn(() => q);
  q.whereNot = jest.fn(() => q);
  q.whereNotIn = jest.fn(() => q);
  q.orderBy = jest.fn(() => q);
  q.modify = jest.fn((fn) => { fn(q); return q; });
  q.leftJoin = jest.fn(() => q);
  q.select = jest.fn(() => q);
  // 'scheduled_services' resolves the fixture visit; every other table
  // (the existing-invoice reuse check, discount lookups) resolves "none
  // found" so the handler falls through to a fresh mint.
  q.first = jest.fn(async () => (table === 'scheduled_services' ? mockDb.__svcRow : undefined));
  return q;
});
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
}));

const adminScheduleRouter = require('../routes/admin-schedule');

const layer = adminScheduleRouter.stack.find(
  (l) => l.route && l.route.path === '/:id/invoice' && l.route.methods.post,
);
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

const SVC_ROW = {
  id: 'svc-1', customer_id: 'cust-1', estimated_price: 115, is_callback: false,
  cust_monthly_rate: null, cust_billing_mode: null, service_type: 'Quarterly Pest Control',
};

function makeReqRes(body) {
  const req = { params: { id: 'svc-1' }, body, headers: {} };
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

describe('POST /:id/invoice — expected_discount_stacking', () => {
  test('forwards the previewed gate state through to InvoiceService.create via buildCreateParams', async () => {
    let capturedParams = null;
    mockMint.mockImplementation(async ({ buildCreateParams }) => {
      capturedParams = buildCreateParams();
      throw new Error('stop-after-capture');
    });
    const { req, res, next } = makeReqRes({ expected_discount_stacking: true });
    await handler(req, res, next);

    expect(capturedParams).not.toBeNull();
    expect(capturedParams.expectedDiscountStacking).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].message).toBe('stop-after-capture');
  });

  test('forwards expected_discount_stacking: false the same way — false is a real value, not "absent"', async () => {
    let capturedParams = null;
    mockMint.mockImplementation(async ({ buildCreateParams }) => {
      capturedParams = buildCreateParams();
      throw new Error('stop-after-capture');
    });
    const { req, res, next } = makeReqRes({ expected_discount_stacking: false });
    await handler(req, res, next);

    expect(capturedParams.expectedDiscountStacking).toBe(false);
  });

  test('omits the field entirely when the client sends none — byte-identical to every caller before this slice', async () => {
    let capturedParams = null;
    mockMint.mockImplementation(async ({ buildCreateParams }) => {
      capturedParams = buildCreateParams();
      throw new Error('stop-after-capture');
    });
    const { req, res, next } = makeReqRes({});
    await handler(req, res, next);

    expect(capturedParams).not.toBeNull();
    expect('expectedDiscountStacking' in capturedParams).toBe(false);
  });

  test('a DISCOUNT_STACKING_GATE_DIVERGED 409 from InvoiceService.create surfaces as a retryable 409, not a 500', async () => {
    mockMint.mockImplementation(async () => {
      const err = new Error('Discount rules changed since this was previewed — reload and try again');
      err.status = 409;
      err.statusCode = 409;
      err.isOperational = true;
      err.code = 'DISCOUNT_STACKING_GATE_DIVERGED';
      throw err;
    });
    const { req, res, next } = makeReqRes({ expected_discount_stacking: true });
    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body).toEqual({ error: 'Discount rules changed since this was previewed — reload and try again' });
    expect(next).not.toHaveBeenCalled();
  });
});

