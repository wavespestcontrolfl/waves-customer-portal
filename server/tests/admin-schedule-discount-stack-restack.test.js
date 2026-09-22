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

  // Codex pre-push audit P0 (round 3): an explicit $0 primary (a member-
  // covered series stamps exactly this — dues cover the primary line,
  // priced add-ons still bill) used to be treated as "no primary gross at
  // all," so a booking with a $0 primary, a discounted recurring add-on, a
  // priced one-time add-on, and an appointment credit skipped restacking
  // entirely. Codex's own worked example: a $100 recurring add-on at 20%
  // off, a $50 one-time add-on, a $30 appointment credit — the anchor
  // stamps a $16 add-on discount; a later occurrence without the one-time
  // add-on must restack to $14 (canonical $56 total), never the anchor's
  // frozen $16 (which would total $54).
  test('gate on: a $0 primary still restacks its OWN priced/discounted add-ons and the shared appointment credit', async () => {
    await withGateLive(() => {
      const pricing = {
        primaryBase: 0,
        primaryServiceKey: 'general_pest',
        primaryServiceCategory: 'pest_control',
        primaryDiscount: null,
        appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30, discountDollars: 30, maxDiscountDollars: null, serviceKeyFilter: null, serviceCategoryFilter: null },
      };
      const recurringAddon = { base: 100, price: 84, serviceKey: 'recurring_addon', serviceCategory: 'addon', discount: { discountType: 'percentage', discountAmount: 20, discountDollars: 16 } };
      const oneTimeAddon = { base: 50, price: 50, serviceKey: 'one_time_addon', serviceCategory: 'addon', discount: null };

      const anchor = restackLiveVisitFinancials(pricing, [recurringAddon, oneTimeAddon]);
      expect(anchor.addonDollars[0].discountDollars).toBe(16);

      // A later occurrence where the one-time add-on isn't due.
      const later = restackLiveVisitFinancials(pricing, [recurringAddon]);
      expect(later.addonDollars[0].discountDollars).toBe(14);
      expect(later.price).toBe(56);
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

  test('returns null when there is no structured primary gross to restack (anchored-split marker template)', () => {
    expect(restackStoredVisitFinancials({ primary_line_price: null, discount_type: 'fixed_amount', discount_amount: 10 }, [], null)).toBeNull();
  });

  // Codex pre-push audit P0 (round 5): a FIXED appointment-level credit
  // pro-rates across every eligible line BEFORE any line's own percentage
  // computes (Steps 1-2 precede Step 3 in the engine), so a percentage-type
  // line/add-on discount's dollar figure becomes sensitive to what that
  // credit reduced its remaining to. Neither line_discount_* nor an add-on's
  // own discount_* columns persist that percentage's real CAP, and the
  // credit's own AMOUNT can change later through an edit (a different
  // slice) — so a frozen dollar figure captured before that edit is not a
  // sound cap across TIME (the round-1 surrogate-cap fix used the frozen
  // figure as a ceiling; Codex's repro: a $100 primary at 20% under a $30
  // credit freezes $14, then the credit drops to $10 — the true canonical
  // share should rise to $18, but the stale $14 surrogate held it down).
  // With no persisted per-line cap column (a schema change outside this
  // slice's file scope), the only sound choice is to NOT restack this
  // combination at all — the caller's existing
  // calculateStoredVisitFinancials/applyStoredVisitFinancials computation
  // (unaffected by this function, unchanged from before this slice) is what
  // runs instead.
  test('bails out (returns null) when a FIXED appointment credit would share a pool with a percentage PRIMARY discount', () => {
    const result = restackStoredVisitFinancials({
      primary_line_price: 100,
      line_discount_type: 'percentage',
      line_discount_amount: 15,
      discount_type: 'fixed_amount',
      discount_amount: 30,
    }, [], null);
    expect(result).toBeNull();
  });

  test('bails out (returns null) when a FIXED appointment credit would share a pool with a percentage ADD-ON discount', () => {
    const result = restackStoredVisitFinancials({
      primary_line_price: 100,
      line_discount_type: null,
      discount_type: 'fixed_amount',
      discount_amount: 20,
    }, [
      { base_price: 80, estimated_price: 72, discount_type: 'percentage', discount_amount: 10, discount_dollars: 8, service_id: 'addon-svc' },
    ], null);
    expect(result).toBeNull();
  });

  // The bail-out is narrow: a percentage LINE term never shares its
  // remaining with a NON-fixed appointment discount (Step 3, the line's own
  // percentage, always precedes Step 4, the appointment percentage) — no
  // stale-cap risk, so this combination restacks fully and correctly.
  test('does NOT bail out when the shared appointment credit is percentage-typed — Step 3 always precedes Step 4', () => {
    const result = restackStoredVisitFinancials({
      primary_line_price: 100,
      line_discount_type: 'percentage',
      line_discount_amount: 15,
      line_discount_dollars: 15, // consistent, uncapped — unaffected either way
      discount_type: 'percentage',
      discount_amount: 10,
    }, [], null);
    expect(result.primaryLineDiscountDollars).toBe(15);
    expect(result.appointmentDiscountDollars).toBe(8.5); // 10% of the $85 remainder
    expect(result.price).toBe(76.5);
  });

  // The shared APPOINTMENT-LEVEL scalar was ALREADY correct before this
  // slice (calculateStoredVisitFinancials already recomputes it fresh per
  // occurrence's own add-on mix) — this pins that the bail-out above
  // doesn't regress that when no percentage line term is present at all.
  test('a due add-on still changes a FIXED appointment credit’s own pro-rata split when no percentage line term is present', () => {
    const parent = { primary_line_price: 100, line_discount_type: null, discount_type: 'fixed_amount', discount_amount: 20 };
    const withAddon = restackStoredVisitFinancials(parent, [
      { base_price: 50, estimated_price: 50, discount_type: null, service_id: 'addon-svc' },
    ], null);
    expect(withAddon.appointmentDiscountDollars).toBe(20);
    expect(withAddon.price).toBe(130);

    const withoutAddon = restackStoredVisitFinancials(parent, [], null);
    expect(withoutAddon.appointmentDiscountDollars).toBe(20);
    expect(withoutAddon.price).toBe(80);
  });

  // Round-1's cap-preservation concern, in the one combination it can still
  // be soundly checked: no FIXED appointment credit shares the pool, so a
  // percentage line discount's own remaining is NEVER reduced by anything
  // else — restacking it reproduces EXACTLY its original (already-capped)
  // frozen figure, never an uncapped recompute.
  test('a capped primary percentage discount is unaffected when nothing shares its pool (no fixed appointment credit)', () => {
    const result = restackStoredVisitFinancials({
      primary_line_price: 100,
      line_discount_type: 'percentage',
      line_discount_amount: 50,
      line_discount_dollars: 10, // the ORIGINAL 50%-capped-$10 result
      discount_type: null,
    }, [], null);
    expect(result.primaryLineDiscountDollars).toBe(10);
    expect(result.price).toBe(90);
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

  // Codex pre-push audit P0 (round 3), stored-row counterpart of the
  // identical fix in restackLiveVisitFinancials above. Uses a FIXED-type
  // (not percentage) recurring add-on discount deliberately: a fixed
  // discount is self-limiting to its own face value regardless of pool
  // size, so it never trips the round-5 bail-out, letting this stay focused
  // on the $0-primary-gross guard specifically.
  test('a $0 primary_line_price still restacks its OWN priced add-ons and the shared appointment credit', () => {
    const parent = { primary_line_price: 0, line_discount_type: null, discount_type: 'fixed_amount', discount_amount: 30 };
    const recurringAddon = { base_price: 100, estimated_price: 90, discount_type: 'fixed_amount', discount_amount: 10, discount_dollars: 10, service_id: 'recurring-addon' };
    const oneTimeAddon = { base_price: 50, estimated_price: 50, discount_type: null, service_id: 'one-time-addon' };

    // Pool = 100 + 50 = 150; $30 credit pro-rated across both.
    const anchor = restackStoredVisitFinancials(parent, [recurringAddon, oneTimeAddon], null);
    expect(anchor.addonDollars[0].discountDollars).toBe(10); // the fixed discount's own face value, unaffected by pool size
    expect(anchor.price).toBe(110);

    // A later extension occurrence where the one-time add-on isn't due —
    // the recurring add-on's OWN discount stays $10 (self-limiting), but
    // the shared credit's split (and so the total) changes correctly.
    const later = restackStoredVisitFinancials(parent, [recurringAddon], null);
    expect(later.addonDollars[0].discountDollars).toBe(10);
    expect(later.price).toBe(60);
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

  // A FIXED appointment credit sharing a pool with a percentage PRIMARY
  // discount is the one combination restackStoredVisitFinancials bails out
  // of (Codex pre-push audit P0, round 5 — see that function's own tests
  // for the full rationale): the wrapper's no-op contract covers this
  // exactly like the gate being off — the target is left exactly as
  // applyStoredVisitFinancials (called before this) already stamped it.
  test('gate on but the combination is unsafe to restack (fixed credit + percentage primary): no-op, target untouched', async () => {
    await withGateLive(() => {
      const target = { estimated_price: 999, discount_dollars: 999, line_discount_dollars: 999 };
      const result = applyDiscountStackRestack(target, cols, parentTemplate, [], null);
      expect(result).toBeNull();
      expect(target).toEqual({ estimated_price: 999, discount_dollars: 999, line_discount_dollars: 999 });
    });
  });

  test('gate on: overrides the frozen fields with the restacked figures (safe combination — percentage appointment credit)', async () => {
    await withGateLive(() => {
      const target = { estimated_price: 999, discount_dollars: 999, line_discount_dollars: 999 };
      const addonDollars = applyDiscountStackRestack(target, cols, { ...parentTemplate, discount_type: 'percentage', discount_amount: 10 }, [], null);
      expect(target.line_discount_dollars).toBe(15); // 15% of the untouched $100 — Step 3 precedes Step 4
      expect(target.discount_dollars).toBe(8.5); // 10% of the $85 remainder
      expect(target.estimated_price).toBe(76.5);
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
