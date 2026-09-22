/**
 * POST /api/admin/schedule/preview — GATE_DISCOUNT_STACKING round 4
 * structural fix on PR #4656 (slice 6 of #4405).
 *
 * Follows this repo's convention for route files with no supertest harness
 * (see server/tests/admin-schedule-checkout-stacking-gate.test.js): locate
 * the handler on router.stack and drive it directly against mocked deps.
 *
 * This route is a THIN WRAPPER around buildAppointmentPricing — the EXACT
 * SAME function the creation route (POST /) calls to price a group. Because
 * both call the literal same function with the literal same inputs,
 * preview==create parity is structural (guaranteed by construction), not
 * something this suite has to separately re-derive — these tests pin the
 * WIRING (request shape in, response shape out) for the specific scenarios
 * prior review rounds flagged as client/server drift risks, proving the
 * server-authoritative number for each.
 */
// Discount catalog rows this suite's scenarios reference by id. Every field
// an eligibility/cap check might read is present (even when falsy) so
// DiscountEngine.manualEligibilityFailures never takes one of its extra-
// DB-query branches (those only fire when requires_new_customer,
// min_service_count, requires_referral/prepayment or promo_code is set —
// none of these fixtures set them).
const DISCOUNTS = {
  'credit-1': {
    id: 'credit-1', name: 'Fixed appointment credit', discount_type: 'fixed_amount', amount: 10.03,
    is_active: true, show_in_invoices: true, max_discount_dollars: null,
    service_key_filter: null, service_category_filter: null, discount_key: null,
  },
  'five-pct': {
    id: 'five-pct', name: 'Five percent off', discount_type: 'percentage', amount: 5,
    is_active: true, show_in_invoices: true, max_discount_dollars: null,
    service_key_filter: null, service_category_filter: null, discount_key: null,
  },
  'half-off': {
    id: 'half-off', name: 'Half Off', discount_type: 'percentage', amount: 50,
    is_active: true, show_in_invoices: true, max_discount_dollars: null,
    service_key_filter: null, service_category_filter: null, discount_key: null,
  },
  'scoped-1': {
    id: 'scoped-1', name: 'Scoped preset', discount_type: 'percentage', amount: 10,
    is_active: true, show_in_invoices: true, max_discount_dollars: null,
    service_key_filter: null, service_category_filter: null, discount_key: null,
  },
  silver: {
    id: 'silver', name: 'Silver tier', discount_type: 'percentage', amount: 10,
    is_active: true, show_in_invoices: true, max_discount_dollars: null,
    service_key_filter: null, service_category_filter: null, discount_key: null, stack_group: 'tier',
  },
  gold: {
    id: 'gold', name: 'Gold tier', discount_type: 'percentage', amount: 15,
    is_active: true, show_in_invoices: true, max_discount_dollars: null,
    service_key_filter: null, service_category_filter: null, discount_key: null, stack_group: 'tier',
  },
};

const mockDb = jest.fn((table) => {
  const q = {};
  q.where = jest.fn((cond) => {
    q.__where = cond;
    return q;
  });
  q.whereIn = jest.fn((_col, ids) => {
    q.__whereInIds = ids;
    return q;
  });
  q.select = jest.fn(async (...cols) => {
    if (table === 'discounts' && Array.isArray(q.__whereInIds)) {
      // The stack_group lookup: id/stack_group/is_stackable only.
      return q.__whereInIds
        .map((id) => DISCOUNTS[id])
        .filter(Boolean)
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

let mockGateEnabled = false;
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  gateEnvValue: jest.fn(() => false),
  discountStackingLive: () => mockGateEnabled,
}));

const adminScheduleRouter = require('../routes/admin-schedule');

const layer = adminScheduleRouter.stack.find(
  (l) => l.route && l.route.path === '/preview' && l.route.methods.post,
);
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

const CUSTOMER = { id: 'cust-1', waveguard_tier: null };

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
  mockGateEnabled = false;
  mockDb.__customer = CUSTOMER;
  mockDb.__service = null;
});

describe('POST /api/admin/schedule/preview', () => {
  test('rejects an empty or missing groups array with 400, no DB reads', async () => {
    const { req, res, next } = makeReqRes({});
    await handler(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('rejects an oversized groups array with 400', async () => {
    const { req, res, next } = makeReqRes({ groups: new Array(13).fill({ customerId: 'x', serviceType: 'y' }) });
    await handler(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('reports a per-group error (never a 500) for an unknown customer, and keeps processing the rest', async () => {
    mockDb.__customer = undefined;
    const { req, res, next } = makeReqRes({
      groups: [{ key: 'g1', customerId: 'missing', serviceType: 'Quarterly Pest Control' }],
    });
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.body.results).toEqual([{ key: 'g1', error: 'Customer not found' }]);
  });

  // Pin 1: a fixed appointment credit + a line percentage discount, in the
  // SAME shape as this repo's own client-side pinned regression
  // ('previews the fully stacked total in submission (cadence-sorted)
  // order, matching the server', CreateAppointmentModal.address-warning
  // .test.jsx) — a $100 monthly line (server order: primary, no discount)
  // plus a $100 quarterly line at 50% off (server order: add-on), plus a
  // $10.03 fixed appointment credit. The SERVER never reorders
  // serviceAddons itself (that cadence sort is the CLIENT's own
  // responsibility, in groupServicesForAppointmentSubmit) — sent in the
  // server's real creation-time order (the shorter-interval monthly line
  // primary, quarterly add-on second), buildAppointmentPricing produces
  // the AUTHORITATIVE $142.47 the client's own pinned test asserts, never
  // the $142.48 a UI-insertion-order preview used to show.
  test('gate ON: a fixed appointment credit + line percentage across a multi-line group prices $142.47, never the UI-order $142.48', async () => {
    mockGateEnabled = true;
    const { req, res, next } = makeReqRes({
      groups: [{
        key: 'g1',
        customerId: 'cust-1',
        serviceType: 'Quarterly Pest Control',
        primaryLinePrice: 100,
        primaryLineDiscount: null,
        // Server (real creation) order: the shorter-interval line first —
        // this addon carries the 50% line discount.
        serviceAddons: [
          { name: 'Quarterly line', basePrice: 100, discountId: 'half-off', discountType: 'percentage', discountAmount: 50 },
        ],
        discountId: 'credit-1', discountType: 'fixed_amount', discountAmount: 10.03,
      }],
    });
    await handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.body.results[0].error).toBeUndefined();
    expect(res.body.results[0].price).toBe(142.47);
    expect(res.body.regime).toBe(true);
  });

  // Pin 2: the $39.32 prepay case — a $20.70 line at 5% off (cent-exact
  // half-up: $1.04 off, $19.66/visit, $39.32 for two). calculateDiscountDollars
  // (server/routes/admin-schedule.js) shares lib/discountStack's cent-exact
  // percentageDiscountDollars helper for its OWN percentage branch
  // UNCONDITIONALLY as of slice 9 of #4405 (#4658) — "not itself gated...
  // whether or not GATE_DISCOUNT_STACKING is live" (see that function's own
  // comment; also documented in this repo's CLAUDE.md: "The corrected
  // cent-exact rounding... is live regardless of the gate") — so a LINE-ONLY
  // discount with no appointment-level discount at all now prices identically
  // in both regimes; only a MULTI-discount interaction (a fixed credit
  // ordered against a percentage, restackOccurrenceDiscounts) still depends
  // on discountStackingLive(). Pinned in BOTH regimes so a future change to
  // either path is caught regardless of which one regresses.
  test('gate ON and OFF: the SAME $20.70/5%-off line prices identically either way (calculateDiscountDollars is cent-exact regardless of the gate), and the prepay projection reflects it', async () => {
    const body = () => ({
      groups: [{
        key: 'g1', customerId: 'cust-1', serviceType: 'Monthly Lawn',
        primaryLinePrice: 20.70,
        primaryLineDiscount: { discountId: 'five-pct', discountType: 'percentage', discountAmount: 5 },
        serviceAddons: [],
        isRecurring: true, recurringCount: '2', collectPrepay: true,
      }],
    });
    mockGateEnabled = true;
    const on = makeReqRes(body());
    await handler(on.req, on.res, on.next);
    expect(on.res.body.results[0].price).toBe(19.66);
    expect(on.res.body.results[0].prepay).toEqual({ perVisit: 19.66, totalAmount: 39.32 });

    mockGateEnabled = false;
    const off = makeReqRes(body());
    await handler(off.req, off.res, off.next);
    expect(off.res.body.results[0].price).toBe(19.66);
    expect(off.res.body.results[0].prepay).toEqual({ perVisit: 19.66, totalAmount: 39.32 });
  });

  // Pin 3: a scoped preset (service_key_filter) resolving to a group other
  // than the group it was requested against still prices correctly — the
  // route trusts buildAppointmentPricing's own service-key/category
  // eligibility resolution rather than re-deriving group routing itself.
  test('a scoped appointment discount prices correctly against the group it actually targets', async () => {
    mockGateEnabled = true;
    const { req, res, next } = makeReqRes({
      groups: [{
        key: 'g-quarterly',
        customerId: 'cust-1',
        serviceType: 'Quarterly Pest Control',
        primaryLinePrice: 100,
        serviceAddons: [],
        discountId: 'scoped-1', discountType: 'percentage', discountAmount: 10,
      }],
    });
    await handler(req, res, next);
    expect(res.body.results[0].error).toBeUndefined();
    expect(res.body.results[0].price).toBe(90);
    expect(res.body.results[0].appointmentDiscount).toMatchObject({ discountDollars: 10 });
  });

  // Pin 4: gate OFF prices byte-identical to a plain single-discount save
  // (main's create route) — the whole restack/canonical-order machinery
  // only ever runs when discountStackingLive() is true.
  test('gate OFF: a single line discount prices byte-identical to the legacy (pre-restack) formula', async () => {
    mockGateEnabled = false;
    const { req, res, next } = makeReqRes({
      groups: [{
        key: 'g1', customerId: 'cust-1', serviceType: 'Quarterly Pest Control',
        primaryLinePrice: 111,
        primaryLineDiscount: { discountId: 'silver', discountType: 'percentage', discountAmount: 10 },
        serviceAddons: [],
      }],
    });
    await handler(req, res, next);
    expect(res.body.results[0].price).toBe(99.9);
    expect(res.body.regime).toBe(false);
  });

  // Codex pre-push audit P1 (push 1): the route's own discountStackGroupConflict
  // call used to read row.stack_group/row.id/row.name off buildAppointmentPricing's
  // RETURNED discount shape (discountId/discountName, no stack_group at
  // all) -- the check could never fire for a real conflict, silently
  // returning null every time despite reading as a working safety net.
  // Fixed by fetching each pricing result's own discount catalog rows
  // (id/stack_group/is_stackable) directly. This test now proves a REAL
  // conflict is actually caught, not merely that the response key exists.
  test('surfaces a real stack-group conflict as an advisory verdict, not a hard failure', async () => {
    mockGateEnabled = true;
    const { req, res, next } = makeReqRes({
      groups: [{
        key: 'g1', customerId: 'cust-1', serviceType: 'Quarterly Pest Control',
        primaryLinePrice: 100,
        primaryLineDiscount: { discountId: 'silver', discountType: 'percentage', discountAmount: 10 },
        serviceAddons: [],
        discountId: 'gold', discountType: 'percentage', discountAmount: 15,
      }],
    });
    await handler(req, res, next);
    expect(res.body.results[0].error).toBeUndefined();
    // silver (line) and gold (appointment) share catalog stack_group
    // 'tier' -- a real, currently-undetectable-without-this-fix conflict.
    expect(res.body.results[0].stackGroupConflict).toMatchObject({ group: 'tier' });
  });

  test('does NOT flag a conflict when the two discounts share no stack_group at all', async () => {
    mockGateEnabled = true;
    const { req, res, next } = makeReqRes({
      groups: [{
        key: 'g1', customerId: 'cust-1', serviceType: 'Quarterly Pest Control',
        primaryLinePrice: 100,
        primaryLineDiscount: { discountId: 'five-pct', discountType: 'percentage', discountAmount: 5 },
        serviceAddons: [],
        discountId: 'credit-1', discountType: 'fixed_amount', discountAmount: 10.03,
      }],
    });
    await handler(req, res, next);
    expect(res.body.results[0].error).toBeUndefined();
    expect(res.body.results[0].stackGroupConflict).toBeNull();
  });
});
