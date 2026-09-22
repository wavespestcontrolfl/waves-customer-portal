/**
 * Slice 3 of the #4405 discount-stacking split: canonical restack at
 * appointment creation (buildAppointmentPricing) and every recurring-
 * extension caller (restackStoredVisitFinancials / applyDiscountStackRestack
 * / insertRecurringChildAddons), gated behind GATE_DISCOUNT_STACKING
 * (discountStackingLive()).
 *
 * Slice 1 (server/services/discount-stack.js, #4568) and slice 2 (the
 * client mirror, #4640) own the arithmetic and its own worked examples —
 * these tests only pin that admin-schedule.js's callers (a) reconstruct
 * TYPED slots instead of trusting a frozen dollar figure, (b) restack
 * through that one engine when the gate is live, and (c) are BYTE
 * IDENTICAL to the pre-slice behavior when it is not.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/discount-engine', () => ({
  manualEligibilityFailures: jest.fn(),
  clearCache: jest.fn(),
}));

const db = require('../models/db');
const DiscountEngine = require('../services/discount-engine');
const {
  buildAppointmentPricing,
  restackStoredVisitFinancials,
  applyDiscountStackRestack,
  insertRecurringChildAddons,
} = require('../routes/admin-schedule')._test;

function discountQuery(discount) {
  return {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(discount),
  };
}

function withGateLive(fn) {
  const prior = process.env.GATE_DISCOUNT_STACKING;
  process.env.GATE_DISCOUNT_STACKING = 'true';
  return Promise.resolve().then(fn).finally(() => {
    if (prior === undefined) delete process.env.GATE_DISCOUNT_STACKING;
    else process.env.GATE_DISCOUNT_STACKING = prior;
  });
}

describe('appointment creation — canonical restack (buildAppointmentPricing)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_DISCOUNT_STACKING;
    DiscountEngine.manualEligibilityFailures.mockResolvedValue([]);
  });

  // $100 primary line at 20% (a plain percentage discount), plus an
  // unscoped $30 FIXED appointment-level credit. Gate off is today's
  // "line discount first, unconditionally, regardless of type" order:
  // $20 line off $100 = $80 net, then the $30 fixed credit off $80 = $50.
  function fixtures() {
    return {
      lineDiscountRow: { id: 'line-disc-1', name: 'Line 20%', discount_type: 'percentage', amount: 20 },
      appointmentDiscountRow: { id: 'appt-fixed-1', name: 'Fixed $30', discount_type: 'fixed_amount', amount: 30 },
    };
  }

  test('gate off: legacy line-then-appointment order, unchanged from before this slice', async () => {
    const { lineDiscountRow, appointmentDiscountRow } = fixtures();
    db.mockReturnValueOnce(discountQuery(lineDiscountRow))
      .mockReturnValueOnce(discountQuery(appointmentDiscountRow));

    const pricing = await buildAppointmentPricing({
      serviceRecord: { service_key: 'general_pest', category: 'pest_control', base_price: 100 },
      estimatedPrice: 100,
      primaryLinePrice: 100,
      primaryLineDiscount: { discountId: 'line-disc-1' },
      serviceAddons: [],
      discountId: 'appt-fixed-1',
      discountType: 'fixed_amount',
      customer: { id: 'customer-1' },
    });

    expect(pricing.primaryDiscount.discountDollars).toBe(20);
    expect(pricing.primaryNet).toBe(80);
    expect(pricing.appointmentDiscount.discountDollars).toBe(30);
    expect(pricing.finalPrice).toBe(50);
  });

  test('gate on: fixed appointment credit resolves before the line percentage (canonical SLOT order)', async () => {
    const { lineDiscountRow, appointmentDiscountRow } = fixtures();
    db.mockReturnValueOnce(discountQuery(lineDiscountRow))
      .mockReturnValueOnce(discountQuery(appointmentDiscountRow));

    const pricing = await withGateLive(() => buildAppointmentPricing({
      serviceRecord: { service_key: 'general_pest', category: 'pest_control', base_price: 100 },
      estimatedPrice: 100,
      primaryLinePrice: 100,
      primaryLineDiscount: { discountId: 'line-disc-1' },
      serviceAddons: [],
      discountId: 'appt-fixed-1',
      discountType: 'fixed_amount',
      customer: { id: 'customer-1' },
    }));

    // $30 fixed credit off $100 first = $70 remaining, THEN 20% of $70 = $14
    // — never the legacy $20 (20% of the untouched $100).
    expect(pricing.appointmentDiscount.discountDollars).toBe(30);
    expect(pricing.primaryDiscount.discountDollars).toBe(14);
    expect(pricing.primaryNet).toBe(86);
    expect(pricing.finalPrice).toBe(56);
  });

  test('gate on, no appointment discount: single line discount is unaffected by the restack branch', async () => {
    const { lineDiscountRow } = fixtures();
    db.mockReturnValueOnce(discountQuery(lineDiscountRow));

    const pricing = await withGateLive(() => buildAppointmentPricing({
      serviceRecord: { service_key: 'general_pest', category: 'pest_control', base_price: 100 },
      estimatedPrice: 100,
      primaryLinePrice: 100,
      primaryLineDiscount: { discountId: 'line-disc-1' },
      serviceAddons: [],
      customer: { id: 'customer-1' },
    }));

    expect(pricing.primaryDiscount.discountDollars).toBe(20);
    expect(pricing.primaryNet).toBe(80);
    expect(pricing.finalPrice).toBe(80);
    expect(pricing.appointmentDiscount).toBeNull();
  });
});

describe('recurring extension — restackStoredVisitFinancials', () => {
  beforeEach(() => {
    delete process.env.GATE_DISCOUNT_STACKING;
  });

  // The Codex #4405 r7 P1 shape: a $100 primary line at 15% plus an
  // unscoped $30 FIXED appointment credit, pro-rated across every eligible
  // line. A due add-on changes which lines share that pool, so the SAME
  // typed primary discount must land on a DIFFERENT dollar figure depending
  // on the occurrence's own add-on mix — never a frozen number copied from
  // a different occurrence's mix.
  const parentTemplate = {
    primary_line_price: 100,
    line_discount_type: 'percentage',
    line_discount_amount: 15,
    discount_type: 'fixed_amount',
    discount_amount: 30,
    discount_max_dollars: null,
    service_key_snapshot: 'general_pest',
  };

  test('an occurrence WITH a due add-on shares the fixed credit’s pool, shrinking the line’s own remainder', () => {
    const withAddon = restackStoredVisitFinancials(parentTemplate, [
      { base_price: 50, estimated_price: 50, discount_type: null, discount_amount: null, service_id: 'addon-svc' },
    ], null);

    // Pool = 100 + 50 = 150. $30 credit pro-rated: primary's share =
    // 30 * 100/150 = 20, leaving $80. 15% of $80 = $12.
    expect(withAddon.primaryLineDiscountDollars).toBe(12);
    expect(withAddon.appointmentDiscountDollars).toBe(30);
  });

  test('the SAME primary discount on an occurrence with NO due add-on resolves a DIFFERENT dollar figure', () => {
    const withoutAddon = restackStoredVisitFinancials(parentTemplate, [], null);

    // Pool = 100 only. The full $30 credit lands on the primary line,
    // leaving $70. 15% of $70 = $10.50 — not the $12 the other occurrence's
    // add-on mix produced, and NOT a frozen copy of either figure.
    expect(withoutAddon.primaryLineDiscountDollars).toBe(10.5);
    expect(withoutAddon.appointmentDiscountDollars).toBe(30);
  });

  test('returns null when there is no structured primary gross to restack (anchored-split marker template)', () => {
    expect(restackStoredVisitFinancials({ ...parentTemplate, primary_line_price: null }, [], null)).toBeNull();
  });

  test('restacks a due add-on’s OWN percentage discount against its own gross, not a frozen dollar figure', () => {
    const result = restackStoredVisitFinancials({
      primary_line_price: 100,
      line_discount_type: null,
      line_discount_amount: null,
      discount_type: null,
      discount_amount: null,
    }, [
      // A frozen discount_dollars of 5 from a DIFFERENT occurrence's gross
      // (say, a $40 gross elsewhere) must not survive — base_price here is
      // the addon's OWN $80 gross, so 10% of it is $8, not the stale $5.
      { base_price: 80, estimated_price: 75, discount_type: 'percentage', discount_amount: 10, discount_dollars: 5, service_id: 'addon-svc' },
    ], null);

    expect(result.addonDollars[0].discountDollars).toBe(8);
    expect(result.addonDollars[0].netPrice).toBe(72);
  });

  test('falls back to a derived gross (net + frozen dollars) when an addon row predates base_price', () => {
    const result = restackStoredVisitFinancials({
      primary_line_price: 100,
      line_discount_type: null,
      discount_type: null,
    }, [
      // No base_price column value at all — gross is reconstructed as
      // estimated_price(45) + discount_dollars(5) = 50, then 10% of 50 = 5
      // (byte-identical to the frozen figure here since nothing else moved
      // — the reconstruction is a safety net, not a behavior change on its
      // own).
      { base_price: null, estimated_price: 45, discount_type: 'percentage', discount_amount: 10, discount_dollars: 5, service_id: 'addon-svc' },
    ], null);

    expect(result.addonDollars[0].discountDollars).toBe(5);
  });
});

describe('recurring extension — applyDiscountStackRestack (no-op contract)', () => {
  afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

  const cols = { estimated_price: true, discount_dollars: true, line_discount_dollars: true };
  const parentTemplate = {
    primary_line_price: 100,
    line_discount_type: 'percentage',
    line_discount_amount: 15,
    discount_type: 'fixed_amount',
    discount_amount: 30,
  };

  test('gate off: touches nothing on the target row', () => {
    delete process.env.GATE_DISCOUNT_STACKING;
    const target = { estimated_price: 999, discount_dollars: 999, line_discount_dollars: 999 };
    const result = applyDiscountStackRestack(target, cols, parentTemplate, [], null);
    expect(result).toBeNull();
    expect(target).toEqual({ estimated_price: 999, discount_dollars: 999, line_discount_dollars: 999 });
  });

  test('gate on: overrides the frozen fields with the restacked figures', async () => {
    await withGateLive(() => {
      const target = { estimated_price: 999, discount_dollars: 999, line_discount_dollars: 999 };
      const addonDollars = applyDiscountStackRestack(target, cols, parentTemplate, [], null);
      expect(target.line_discount_dollars).toBe(10.5); // 15% of (100 - 30)
      expect(target.discount_dollars).toBe(30);
      expect(target.estimated_price).toBe(59.5); // 100 - 10.5 - 30
      expect(addonDollars).toEqual([]);
    });
  });

  test('gate on but nothing to restack (no primary gross): returns null and leaves target untouched', async () => {
    await withGateLive(() => {
      const target = { estimated_price: 999, discount_dollars: 999, line_discount_dollars: 999 };
      const result = applyDiscountStackRestack(target, cols, { ...parentTemplate, primary_line_price: null }, [], null);
      expect(result).toBeNull();
      expect(target).toEqual({ estimated_price: 999, discount_dollars: 999, line_discount_dollars: 999 });
    });
  });
});

describe('recurring extension — insertRecurringChildAddons restack threading', () => {
  function fakeConn(cols) {
    const inserted = [];
    const table = { insert: jest.fn((row) => { inserted.push(row); return Promise.resolve([row]); }) };
    const conn = jest.fn(() => table);
    conn.columnInfoResult = cols;
    table.columnInfo = jest.fn().mockResolvedValue(cols);
    return { conn, inserted };
  }

  const addonCols = {
    discount_dollars: true, estimated_price: true, discount_id: true, discount_name: true,
    discount_type: true, discount_amount: true, base_price: true,
  };

  test('with no restackedAddonDollars argument, stamps the addon’s own (frozen) discount fields — unchanged', async () => {
    const { conn, inserted } = fakeConn(addonCols);
    const dueAddon = {
      service_id: 'svc-1', service_name: 'Termite add-on', estimated_price: 45,
      discount_type: 'percentage', discount_amount: 10, discount_dollars: 5,
    };
    await insertRecurringChildAddons(conn, 'visit-1', [dueAddon]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].estimated_price).toBe(45);
    expect(inserted[0].discount_dollars).toBe(5);
  });

  test('with a restackedAddonDollars array, overrides discount_dollars/estimated_price per due add-on', async () => {
    const { conn, inserted } = fakeConn(addonCols);
    const dueAddon = {
      service_id: 'svc-1', service_name: 'Termite add-on', estimated_price: 45,
      discount_type: 'percentage', discount_amount: 10, discount_dollars: 5,
    };
    await insertRecurringChildAddons(conn, 'visit-1', [dueAddon], [{ discountDollars: 8, netPrice: 72 }]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].discount_dollars).toBe(8);
    expect(inserted[0].estimated_price).toBe(72);
  });

  test('a null entry in restackedAddonDollars for one add-on leaves that add-on’s own frozen fields alone', async () => {
    const { conn, inserted } = fakeConn(addonCols);
    const addonA = { service_id: 'a', service_name: 'A', estimated_price: 45, discount_type: 'percentage', discount_amount: 10, discount_dollars: 5 };
    const addonB = { service_id: 'b', service_name: 'B', estimated_price: 20, discount_type: null };
    await insertRecurringChildAddons(conn, 'visit-1', [addonA, addonB], [{ discountDollars: 8, netPrice: 72 }, null]);
    expect(inserted[0].discount_dollars).toBe(8);
    expect(inserted[1].estimated_price).toBe(20);
    expect(inserted[1].discount_dollars).toBeUndefined();
  });
});
