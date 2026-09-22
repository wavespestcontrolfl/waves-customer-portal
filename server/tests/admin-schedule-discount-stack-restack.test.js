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
  restackLiveVisitFinancials,
  restackStoredVisitFinancials,
  applyDiscountStackRestack,
  insertRecurringChildAddons,
  insertScheduledServiceAddons,
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

  // Codex pre-push audit P0 (round 1): reconstructing a line discount's
  // typed slot without its cap let the restack ignore a cap
  // calculateDiscountDollars would otherwise have enforced — a $100 line at
  // 50% capped $10 plus a $10 fixed appointment credit restacked to $45 net
  // instead of the correct $80.
  test('gate on: a capped percentage line discount keeps its cap through the restack', async () => {
    const lineDiscountRow = { id: 'line-disc-2', name: 'Capped 50%', discount_type: 'percentage', amount: 50, max_discount_dollars: 10 };
    const appointmentDiscountRow = { id: 'appt-fixed-2', name: 'Fixed $10', discount_type: 'fixed_amount', amount: 10 };
    db.mockReturnValueOnce(discountQuery(lineDiscountRow))
      .mockReturnValueOnce(discountQuery(appointmentDiscountRow));

    const pricing = await withGateLive(() => buildAppointmentPricing({
      serviceRecord: { service_key: 'general_pest', category: 'pest_control', base_price: 100 },
      estimatedPrice: 100,
      primaryLinePrice: 100,
      primaryLineDiscount: { discountId: 'line-disc-2' },
      serviceAddons: [],
      discountId: 'appt-fixed-2',
      discountType: 'fixed_amount',
      customer: { id: 'customer-1' },
    }));

    // $10 fixed credit off $100 first = $90 remaining. Uncapped, 50% of $90
    // would be $45 — the cap holds it to $10, netting $80, never the $45 a
    // dropped cap would give.
    expect(pricing.primaryDiscount.discountDollars).toBe(10);
    expect(pricing.primaryNet).toBe(90);
    expect(pricing.appointmentDiscount.discountDollars).toBe(10);
    expect(pricing.finalPrice).toBe(80);
  });
});

describe('seeded recurring children/boosters — restackLiveVisitFinancials', () => {
  beforeEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

  // Codex pre-push audit P0 (round 1): an initially seeded child/booster
  // (created in the SAME booking request as the anchor date) used to copy
  // pricing.primaryDiscount.discountDollars — restacked against the
  // ANCHOR's own add-on mix — onto every occurrence unchanged, even one
  // whose own due add-ons differ. This mirrors restackStoredVisitFinancials'
  // extension-side fix, sourced from the LIVE pricing object instead of a
  // stored row, so a series stays internally consistent whether a visit was
  // seeded at booking time or produced later by auto-extend.
  const pricingFixture = {
    primaryBase: 100,
    primaryNet: 68, // legacy value from the anchor's OWN restack — irrelevant to this function, which re-derives everything from primaryDiscount + primaryBase
    primaryServiceKey: 'general_pest',
    primaryServiceCategory: 'pest_control',
    primaryDiscount: { discountType: 'percentage', discountAmount: 15, discountDollars: 12, maxDiscountDollars: null },
    appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30, discountDollars: 30, maxDiscountDollars: null, serviceKeyFilter: null, serviceCategoryFilter: null },
  };

  test('gate off: returns null — the caller keeps calculateVisitFinancialsForAddons unchanged', () => {
    expect(restackLiveVisitFinancials(pricingFixture, [
      { base: 50, price: 40, serviceKey: 'termite_addon', serviceCategory: 'termite' },
    ])).toBeNull();
  });

  test('gate on: the anchor’s own add-on mix restacks to the anchor’s $12 primary discount', async () => {
    await withGateLive(() => {
      const result = restackLiveVisitFinancials(pricingFixture, [
        { base: 50, price: 40, serviceKey: 'termite_addon', serviceCategory: 'termite' },
      ]);
      expect(result.primaryDiscountDollars).toBe(12);
      expect(result.appointmentDiscountDollars).toBe(30);
    });
  });

  test('gate on: a child WITHOUT that add-on restacks its OWN, different primary discount — never a copy of the anchor’s', async () => {
    await withGateLive(() => {
      const result = restackLiveVisitFinancials(pricingFixture, []);
      // Matches restackStoredVisitFinancials' identical shape (same primary
      // gross/type/amount, same fixed appointment credit, no addon pool):
      // $30 credit takes the whole primary line, leaving $70; 15% of $70 =
      // $10.50 — not the anchor's $12, and not a stale copy of either.
      expect(result.primaryDiscountDollars).toBe(10.5);
      expect(result.appointmentDiscountDollars).toBe(30);
      expect(result.price).toBe(59.5);
    });
  });

  test('gate on but no primary gross: returns null (nothing to restack)', async () => {
    await withGateLive(() => {
      expect(restackLiveVisitFinancials({ ...pricingFixture, primaryBase: null }, [])).toBeNull();
    });
  });

  // Codex pre-push audit P0 (round 2): a fully-discounted line restacks to
  // an exact $0 subtotal, which the "subtotal > 0" fallback used to treat as
  // "unpriced" — nulling primaryDiscountDollars right alongside price, so
  // the caller stamped line_discount_dollars: 0 while primary_line_price
  // stayed at its full $100 gross. invoice.js omits a zero/null discount
  // line, so the visit would have invoiced $100 for what is genuinely free.
  test('gate on: a 100%-off primary line restacks to a real $0 price WITH its full discount stamp intact', async () => {
    await withGateLive(() => {
      const fullyDiscounted = {
        primaryBase: 100,
        primaryServiceKey: 'general_pest',
        primaryServiceCategory: 'pest_control',
        primaryDiscount: { discountType: 'percentage', discountAmount: 100, discountDollars: 100, maxDiscountDollars: null },
        appointmentDiscount: null,
      };
      const result = restackLiveVisitFinancials(fullyDiscounted, []);
      expect(result.price).toBe(0);
      expect(result.primaryDiscountDollars).toBe(100);
    });
  });
});

describe('seeded recurring children/boosters — insertScheduledServiceAddons restack threading', () => {
  function fakeConn(cols) {
    const inserted = [];
    const table = { insert: jest.fn((row) => { inserted.push(row); return Promise.resolve([row]); }) };
    const trx = jest.fn(() => table);
    table.columnInfo = jest.fn().mockResolvedValue(cols);
    return { trx, inserted };
  }

  const addonCols = { discount_dollars: true, estimated_price: true, base_price: true, service_key_snapshot: true, service_category_snapshot: true };

  test('with no restackedAddonDollars argument, behavior is unchanged (EDIT-route callers included)', async () => {
    const { trx, inserted } = fakeConn(addonCols);
    await insertScheduledServiceAddons(trx, 'visit-1', [
      { serviceName: 'Termite add-on', price: 40, base: 50, discount: { discountType: 'percentage', discountAmount: 10, discountDollars: 5 } },
    ], addonCols);
    expect(inserted[0].estimated_price).toBe(40);
    expect(inserted[0].discount_dollars).toBe(5);
  });

  test('with a restackedAddonDollars array, overrides discount_dollars/estimated_price per line', async () => {
    const { trx, inserted } = fakeConn(addonCols);
    await insertScheduledServiceAddons(trx, 'visit-1', [
      { serviceName: 'Termite add-on', price: 40, base: 50, discount: { discountType: 'percentage', discountAmount: 10, discountDollars: 5 } },
    ], addonCols, [{ discountDollars: 8, netPrice: 72 }]);
    expect(inserted[0].discount_dollars).toBe(8);
    expect(inserted[0].estimated_price).toBe(72);
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

  test('restacks a due add-on’s OWN percentage discount against its own pool share, not its frozen (full-base) dollar figure', () => {
    // Production writes an add-on's own discount_dollars against its OWN
    // full base_price (10% of $80 = $8, consistent — never from a different
    // row). What the frozen figure canNOT reflect is an unscoped $20 FIXED
    // appointment credit sharing the SAME pool as this add-on: the credit's
    // pro-rata share shrinks the add-on's remaining BEFORE its own 10%
    // computes, so the correct restacked figure is smaller than the frozen
    // $8 — proving the add-on's own dollars are recomputed, not replayed.
    const result = restackStoredVisitFinancials({
      primary_line_price: 100,
      line_discount_type: null,
      line_discount_amount: null,
      discount_type: 'fixed_amount',
      discount_amount: 20,
    }, [
      { base_price: 80, estimated_price: 72, discount_type: 'percentage', discount_amount: 10, discount_dollars: 8, service_id: 'addon-svc' },
    ], null);

    // Pool = 100 (primary, no own discount) + 80 (addon) = 180. $20 credit
    // pro-rated: addon's share = 20 * 80/180 = $8.89, leaving $71.11. 10% of
    // that (cent-exact) is $7.11 — never the frozen $8, and well under the
    // $8 surrogate cap (see the capped-primary test below for when that cap
    // actually binds).
    expect(result.addonDollars[0].discountDollars).toBe(7.11);
    expect(result.addonDollars[0].netPrice).toBe(72.89);
  });

  test('falls back to a derived gross (net + frozen dollars) when an addon row predates base_price', () => {
    const result = restackStoredVisitFinancials({
      primary_line_price: 100,
      line_discount_type: null,
      discount_type: 'fixed_amount',
      discount_amount: 20,
    }, [
      // No base_price column value at all — gross is reconstructed as
      // estimated_price(45) + discount_dollars(5) = 50 (a legacy row's own
      // consistent net + frozen dollars, not a different row's), then
      // restacked the same way the test above does.
      { base_price: null, estimated_price: 45, discount_type: 'percentage', discount_amount: 10, discount_dollars: 5, service_id: 'addon-svc' },
    ], null);

    // Pool = 100 + 50 = 150. $20 credit pro-rated: addon's share =
    // 20 * 50/150 = $6.67, leaving $43.33. 10% of that is $4.33 — recomputed
    // against the derived $50 gross, not the frozen $5.
    expect(result.addonDollars[0].discountDollars).toBe(4.33);
  });

  // Codex pre-push audit P0 (round 1), stored-row counterpart of the
  // buildAppointmentPricing cap test above: line_discount_type/amount carry
  // no persisted cap at all, so the ORIGINAL frozen line_discount_dollars —
  // itself already correctly capped when it was written — is used as a safe
  // surrogate ceiling (see the comment on restackStoredVisitFinancials).
  test('a capped primary line discount keeps its cap through a stored restack (frozen figure as surrogate ceiling)', () => {
    const result = restackStoredVisitFinancials({
      primary_line_price: 100,
      line_discount_type: 'percentage',
      line_discount_amount: 50,
      line_discount_dollars: 10, // the ORIGINAL 50%-capped-$10 result
      discount_type: 'fixed_amount',
      discount_amount: 10,
    }, [], null);

    // $10 fixed credit off $100 first = $90 remaining. Uncapped, 50% of $90
    // would be $45 — the surrogate ceiling holds it to the original $10,
    // never the $45 a dropped cap would give.
    expect(result.primaryLineDiscountDollars).toBe(10);
    expect(result.price).toBe(80);
  });

  // Codex pre-push audit P0 (round 2) — stored-row counterpart of the same
  // fix in restackLiveVisitFinancials above.
  test('a 100%-off primary line restacks to a real $0 price WITH its full discount stamp intact', () => {
    const result = restackStoredVisitFinancials({
      primary_line_price: 100,
      line_discount_type: 'percentage',
      line_discount_amount: 100,
      line_discount_dollars: 100,
      discount_type: null,
    }, [], null);

    expect(result.price).toBe(0);
    expect(result.primaryLineDiscountDollars).toBe(100);
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

  // Codex pre-push audit P0 (round 2), end-to-end through the stamp
  // helper: a fully-discounted extension must stamp its REAL discount
  // dollars, not a naive `|| 0` that would read as "no discount applied."
  test('gate on: a 100%-off extension stamps estimated_price 0 AND its full line_discount_dollars, never 0', async () => {
    await withGateLive(() => {
      const target = { primary_line_price: 100, estimated_price: 999, discount_dollars: 999, line_discount_dollars: 999 };
      applyDiscountStackRestack(target, cols, {
        primary_line_price: 100, line_discount_type: 'percentage', line_discount_amount: 100, discount_type: null,
      }, [], null);
      expect(target.estimated_price).toBe(0);
      expect(target.line_discount_dollars).toBe(100);
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
