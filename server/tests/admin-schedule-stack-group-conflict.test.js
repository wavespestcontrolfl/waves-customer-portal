/**
 * POST /api/admin/schedule (creation route) — non-stackable stack_group
 * enforcement. GitHub round 5 P1 (Codex, on PR #4656's 3c7214fa45):
 * enforcement used to be entirely client-side; a client bypass, or the
 * gate simply being off (which already skips the client check), let two
 * conflicting tiers (e.g. Silver + Gold, same catalog stack_group) both
 * persist on one booking. discountStackGroupRowsForPricing +
 * assertNoDiscountStackGroupConflict (both exported via router._test) now
 * enforce this server-side too, before any write, and the SAME check
 * backs the /preview route's own advisory verdict.
 *
 * Follows this repo's convention for route files with no supertest
 * harness: locate the handler on router.stack and drive it directly
 * against mocked deps. A one-time (non-recurring), no-propertyId,
 * no-linked-estimate booking reaches buildAppointmentPricing with only
 * customers/services/discounts table lookups in between — the same
 * surface admin-schedule-preview-route.test.js already mocks.
 */
const DISCOUNTS = {
  silver: {
    id: 'silver', name: 'Silver tier', discount_type: 'percentage', amount: 10,
    is_active: true, show_in_invoices: true, max_discount_dollars: null,
    service_key_filter: null, service_category_filter: null, discount_key: null,
    stack_group: 'tier', is_stackable: false,
  },
  gold: {
    id: 'gold', name: 'Gold tier', discount_type: 'percentage', amount: 15,
    is_active: true, show_in_invoices: true, max_discount_dollars: null,
    service_key_filter: null, service_category_filter: null, discount_key: null,
    stack_group: 'tier', is_stackable: false,
  },
  credit: {
    id: 'credit', name: 'Ten dollar credit', discount_type: 'fixed_amount', amount: 10,
    is_active: true, show_in_invoices: true, max_discount_dollars: null,
    service_key_filter: null, service_category_filter: null, discount_key: null,
    stack_group: null, is_stackable: true,
  },
};

const CUSTOMER = { id: 'cust-1', waveguard_tier: null };

const mockDb = jest.fn((table) => {
  const q = {};
  q.where = jest.fn((cond) => { q.__where = cond; return q; });
  q.whereIn = jest.fn((_col, ids) => { q.__whereInIds = ids; return q; });
  q.select = jest.fn(async (...cols) => {
    if (table === 'discounts' && Array.isArray(q.__whereInIds)) {
      if (mockDb.__discountsSelectThrows) throw new Error('connection reset');
      // __missingIds simulates a referenced discount id with NO catalog
      // row at all (e.g. deleted between selection and this request) --
      // filtered out of the returned set, same as a real whereIn would.
      const ids = mockDb.__missingIds
        ? q.__whereInIds.filter((id) => !mockDb.__missingIds.includes(id))
        : q.__whereInIds;
      return ids.map((id) => DISCOUNTS[id]).filter(Boolean)
        .map((row) => Object.fromEntries(cols.map((c) => [c, row[c]])));
    }
    return [];
  });
  q.first = jest.fn(async () => {
    if (table === 'customers') return mockDb.__customer;
    if (table === 'services') return mockDb.__service;
    if (table === 'discounts') return DISCOUNTS[q.__where?.id] || undefined;
    return undefined;
  });
  return q;
});
jest.mock('../models/db', () => mockDb);
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

let mockGateEnabled = true;
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  gateEnvValue: jest.fn(() => false),
  discountStackingLive: () => mockGateEnabled,
}));

const adminScheduleRouter = require('../routes/admin-schedule');
const {
  discountStackGroupRowsForPricing,
  assertNoDiscountStackGroupConflict,
} = adminScheduleRouter._test;

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

beforeEach(() => {
  jest.clearAllMocks();
  mockGateEnabled = true;
  mockDb.__customer = CUSTOMER;
  mockDb.__service = null;
  mockDb.__discountsSelectThrows = false;
  mockDb.__missingIds = null;
});

describe('assertNoDiscountStackGroupConflict / discountStackGroupRowsForPricing (unit)', () => {
  test('two rows sharing a non-stackable stack_group throw a 400 with the exact code and a clear message', () => {
    const rows = [
      { id: 'silver', name: 'Silver tier', stack_group: 'tier', is_stackable: false, scope: 'line:primary' },
      { id: 'gold', name: 'Gold tier', stack_group: 'tier', is_stackable: false, spansAll: true },
    ];
    expect(() => assertNoDiscountStackGroupConflict(rows)).toThrow(expect.objectContaining({
      statusCode: 400, status: 400, isOperational: true, code: 'DISCOUNT_STACK_GROUP_CONFLICT',
      message: expect.stringContaining('Only one WaveGuard tier discount can apply'),
    }));
  });

  test('rows in DIFFERENT (or no) stack_group never throw', () => {
    const rows = [
      { id: 'silver', name: 'Silver tier', stack_group: 'tier', is_stackable: false, scope: 'line:primary' },
      { id: 'credit', name: 'Ten dollar credit', stack_group: null, is_stackable: true, spansAll: true },
    ];
    expect(() => assertNoDiscountStackGroupConflict(rows)).not.toThrow();
  });

  test('discountStackGroupRowsForPricing threads real stack_group/is_stackable off the discounts table for the ids buildAppointmentPricing resolved', async () => {
    const pricing = {
      primaryDiscount: { discountId: 'silver', discountName: 'Silver tier' },
      addonLines: [{ discount: { discountId: 'gold', discountName: 'Gold tier' } }],
      appointmentDiscount: null,
    };
    const rows = await discountStackGroupRowsForPricing(pricing);
    expect(rows).toEqual([
      { id: 'silver', name: 'Silver tier', stack_group: 'tier', is_stackable: false, scope: 'line:primary' },
      { id: 'gold', name: 'Gold tier', stack_group: 'tier', is_stackable: false, scope: 'line:addon:0' },
    ]);
  });
});

describe('POST /api/admin/schedule — stack_group conflict (end to end, one-time booking)', () => {
  test('Silver (primary line) + Gold (appointment-level) -> 400, DISCOUNT_STACK_GROUP_CONFLICT, before any write', async () => {
    const { req, res, next } = makeReqRes({
      customerId: 'cust-1', scheduledDate: '2026-10-01', serviceType: 'Quarterly Pest Control',
      primaryLinePrice: 100,
      primaryLineDiscount: { discountId: 'silver', discountType: 'percentage', discountAmount: 10 },
      discountId: 'gold', discountType: 'percentage', discountAmount: 15,
    });
    await handler(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ code: 'DISCOUNT_STACK_GROUP_CONFLICT' });
    expect(res.body.error).toEqual(expect.stringContaining('Only one WaveGuard tier discount can apply'));
    // Nothing written: the mocked db never receives an insert call (this
    // mock's query builder has no .insert at all, so the transaction --
    // which never opens -- would throw if it were somehow reached).
    expect(next).not.toHaveBeenCalled();
  });

  test('Silver (primary line) + a different-group fixed credit (appointment-level) -> not rejected by the stack-group check, proceeds past it', async () => {
    const { req, res, next } = makeReqRes({
      customerId: 'cust-1', scheduledDate: '2026-10-01', serviceType: 'Quarterly Pest Control',
      primaryLinePrice: 100,
      primaryLineDiscount: { discountId: 'silver', discountType: 'percentage', discountAmount: 10 },
      discountId: 'credit', discountType: 'fixed_amount', discountAmount: 10,
    });
    await handler(req, res, next);
    // Never the stack-group 400 -- this mock has no .transaction/.insert,
    // so it proceeds until the next unmocked operation surfaces via
    // next(e), proving the check itself did not block a non-conflicting
    // pair (a full round-trip to 201 needs the entire creation
    // transaction mocked, out of this fix's own scope to build).
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  test('gate OFF, a single discount -> unchanged (the stack-group check never fires; a lone discount can never conflict with itself)', async () => {
    mockGateEnabled = false;
    const { req, res, next } = makeReqRes({
      customerId: 'cust-1', scheduledDate: '2026-10-01', serviceType: 'Quarterly Pest Control',
      primaryLinePrice: 100,
      primaryLineDiscount: { discountId: 'silver', discountType: 'percentage', discountAmount: 10 },
    });
    await handler(req, res, next);
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  test('gate OFF, the SAME Silver+Gold conflict as the gate-ON case -> byte-identical: still rejected (the check is unconditional, never gated on discountStackingLive)', async () => {
    mockGateEnabled = false;
    const { req, res, next } = makeReqRes({
      customerId: 'cust-1', scheduledDate: '2026-10-01', serviceType: 'Quarterly Pest Control',
      primaryLinePrice: 100,
      primaryLineDiscount: { discountId: 'silver', discountType: 'percentage', discountAmount: 10 },
      discountId: 'gold', discountType: 'percentage', discountAmount: 15,
    });
    await handler(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.code).toBe('DISCOUNT_STACK_GROUP_CONFLICT');
  });
});

describe('GitHub round 5 P1 follow-up (Codex, blocked push 5) — fail closed on a stack_group metadata lookup failure', () => {
  test('unit: discountStackGroupRowsForPricing throws when the discounts query itself throws', async () => {
    mockDb.__discountsSelectThrows = true;
    const pricing = {
      primaryDiscount: { discountId: 'silver', discountName: 'Silver tier' },
      addonLines: [], appointmentDiscount: null,
    };
    await expect(discountStackGroupRowsForPricing(pricing)).rejects.toThrow('connection reset');
  });

  test('unit: discountStackGroupRowsForPricing throws when a referenced discount id has no catalog row (query succeeds, id missing)', async () => {
    mockDb.__missingIds = ['silver'];
    const pricing = {
      primaryDiscount: { discountId: 'silver', discountName: 'Silver tier' },
      addonLines: [], appointmentDiscount: null,
    };
    await expect(discountStackGroupRowsForPricing(pricing)).rejects.toThrow(/silver/);
  });

  test('end to end (creation route): a lookup failure rejects with a retryable error, never silently proceeding as conflict-free', async () => {
    mockDb.__discountsSelectThrows = true;
    const { req, res, next } = makeReqRes({
      customerId: 'cust-1', scheduledDate: '2026-10-01', serviceType: 'Quarterly Pest Control',
      primaryLinePrice: 100,
      primaryLineDiscount: { discountId: 'silver', discountType: 'percentage', discountAmount: 10 },
      discountId: 'gold', discountType: 'percentage', discountAmount: 15,
    });
    await handler(req, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body).toMatchObject({ code: 'DISCOUNT_STACK_GROUP_LOOKUP_FAILED' });
    // Never the (wrong) conflict-free path this failure used to silently
    // fall into -- no 400 conflict verdict, and no proceeding further
    // (next() reserved for genuinely unhandled errors, not this one).
    expect(res.status).not.toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  test('end to end (preview route): a lookup failure surfaces as this group\'s own advisory error, isolated from other groups', async () => {
    mockDb.__discountsSelectThrows = true;
    const previewLayer = adminScheduleRouter.stack.find(
      (l) => l.route && l.route.path === '/preview' && l.route.methods.post,
    );
    const previewHandler = previewLayer.route.stack[previewLayer.route.stack.length - 1].handle;
    const { req, res, next } = makeReqRes({
      groups: [{
        key: 'g1', customerId: 'cust-1', serviceType: 'Quarterly Pest Control',
        primaryLinePrice: 100,
        primaryLineDiscount: { discountId: 'silver', discountType: 'percentage', discountAmount: 10 },
        discountId: 'gold', discountType: 'percentage', discountAmount: 15,
      }],
    });
    await previewHandler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.body.results[0].error).toEqual(expect.stringContaining('connection reset'));
    // Never a fabricated conflict-free verdict for this group.
    expect(res.body.results[0].stackGroupConflict).toBeUndefined();
  });
});
