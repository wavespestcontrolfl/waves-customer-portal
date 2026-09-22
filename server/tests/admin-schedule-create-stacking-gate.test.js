/**
 * POST /api/admin/schedule (creation route) — expected_discount_stacking.
 *
 * GitHub round 4 P0 (PR #4656): mirrors calculateUpdateFinancials
 * (server/services/invoice.js, #4655) and InvoiceService.create's own gate
 * check (#4658) — a client that previewed under one GATE_DISCOUNT_STACKING
 * regime and posts money under a DIFFERENT live regime (a flip mid-session,
 * or a rolling deploy routing the probe and this write to pods reading
 * different values) must not silently save the opposite math, and for a
 * recurring booking's req.body.prepaid.totalAmount specifically, must not
 * silently STAMP a client-computed total that disagrees with what the
 * visits actually bill (that field is written verbatim, with no
 * server-side recomputation against the actual per-visit price).
 *
 * Follows this repo's convention for route files with no supertest harness:
 * locate the handler on router.stack and drive it directly. The check runs
 * BEFORE any db read/write in the handler, so a throwing db mock both
 * proves the 409 fires first (the request never reaches it) and would
 * fail loudly (not silently pass) if that ordering ever regressed.
 */
const mockDb = jest.fn(() => {
  throw new Error('db must not be queried when expected_discount_stacking diverges from the live gate');
});
jest.mock('../models/db', () => mockDb);
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

let mockGateEnabled = false;
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  gateEnvValue: jest.fn(() => false),
  discountStackingLive: () => mockGateEnabled,
}));

const adminScheduleRouter = require('../routes/admin-schedule');

const layer = adminScheduleRouter.stack.find(
  (l) => l.route && l.route.path === '/' && l.route.methods.post,
);
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

function makeReqRes(body) {
  const req = { body, headers: {} };
  const res = {
    statusCode: 200,
    body: undefined,
    status: jest.fn(function status(c) { this.statusCode = c; return this; }),
    json: jest.fn(function json(b) { this.body = b; return this; }),
  };
  const next = jest.fn();
  return { req, res, next };
}

const BASE_BODY = {
  customerId: 'cust-1', scheduledDate: '2026-10-01', serviceType: 'Quarterly Pest Control',
  isRecurring: true, recurringCount: 4,
  prepaid: { totalAmount: 180, method: 'cash' },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGateEnabled = false;
});

describe('POST /api/admin/schedule — expected_discount_stacking (P0 :6019 — gate flip between preview and write)', () => {
  test('rejects a mismatch with a retryable 409 BEFORE any db read/write, and never stamps the client-computed prepaid total', async () => {
    mockGateEnabled = false; // live gate is OFF
    const { req, res, next } = makeReqRes({ ...BASE_BODY, expected_discount_stacking: true }); // client previewed ON
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body).toMatchObject({ code: 'DISCOUNT_STACKING_GATE_DIVERGED' });
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('the same mismatch in the OTHER direction (client previewed OFF, live is now ON) is also rejected', async () => {
    mockGateEnabled = true;
    const { req, res, next } = makeReqRes({ ...BASE_BODY, expected_discount_stacking: false });
    await handler(req, res, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body.code).toBe('DISCOUNT_STACKING_GATE_DIVERGED');
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('a MATCHING regime is never rejected by this check — proceeds to the customer lookup', async () => {
    mockGateEnabled = true;
    const { req, res, next } = makeReqRes({ ...BASE_BODY, expected_discount_stacking: true });
    await handler(req, res, next);
    // Reaches the (throwing) db mock instead of a 409 from THIS check —
    // proves a matching regime is not blocked here. The throw is caught by
    // the route's own try/catch and forwarded to next(), not a 409.
    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(mockDb).toHaveBeenCalled();
  });

  test('omitting the field entirely skips the check — byte-identical to every caller before this slice', async () => {
    mockGateEnabled = true;
    const { expected_discount_stacking: _drop, ...body } = { ...BASE_BODY };
    const { req, res, next } = makeReqRes(body);
    await handler(req, res, next);
    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(mockDb).toHaveBeenCalled();
  });
});
