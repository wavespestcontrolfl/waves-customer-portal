/**
 * Slice 3 of the #4405 discount-stacking split: canonical restack at
 * appointment creation (buildAppointmentPricing), seeded children/boosters
 * within the same booking request (restackLiveVisitFinancials), and every
 * recurring-extension caller (restackStoredVisitFinancials /
 * applyDiscountStackRestack / insertRecurringChildAddons), gated behind
 * GATE_DISCOUNT_STACKING (discountStackingLive()).
 *
 * Slice 1 (server/services/discount-stack.js, #4568) and slice 2 (the
 * client mirror, #4640) own the arithmetic and its own worked examples —
 * these tests pin that admin-schedule.js's callers (a) reconstruct TYPED
 * slots instead of trusting a frozen dollar figure, (b) restack through
 * that one engine when the gate is live, (c) are BYTE IDENTICAL to the
 * pre-slice behavior when it is not, and (d) agree with each other:
 * whether a visit is priced at booking time (creation) or produced later
 * (auto-extend), the SAME inputs must restack to the SAME dollars.
 *
 * A percentage line/add-on discount's real cap is never persisted on the
 * scheduled_services / scheduled_service_addons row (only the appointment-
 * level discount_max_dollars is) — restackStoredVisitFinancials therefore
 * takes a pre-fetched `discountCaps` Map (loadDiscountCapsById reads the
 * REAL catalog cap by line_discount_id / each add-on's own discount_id)
 * rather than ever guessing one from a frozen dollar figure — a guess
 * proved unsound multiple ways in review: it could under-cap a genuinely
 * uncapped discount whose credit-sharing pool later changed (round 5), and
 * legacy float rounding can itself differ from this engine's cent-exact
 * math by a cent even with NO cap at all (round 7), so ANY frozen figure
 * risked masquerading as a cap it never was.
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
  loadDiscountCapsById,
  insertRecurringChildAddons,
  insertScheduledServiceAddons,
  occurrenceFloorPrice,
  calculateVisitFinancialsForAddons,
  storedOccurrenceFloorPrice,
  calculateStoredVisitFinancials,
  stampPricingRegimeMarker,
  hasPricingRegimeMarker,
  clearPricingRegimeMarker,
  resolveSeriesExtensionPriceTemplate,
  seriesExtensionUnbillable,
  resolveStoredDiscountCaps,
  capsSnapshotFromPricing,
  freezeLegacySeriesRootCaps,
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

  test('gate on, no appointment discount: still restacks (for cent-exact rounding), same total here since nothing shares the pool', async () => {
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

  // Codex pre-push audit P0 (round 7): a percentage discount with NO
  // appointment discount at all used to skip restacking entirely (the
  // condition required an appointment discount to be present), so the
  // ANCHOR row kept legacy's float-rounded $1.03 while a seeded CHILD
  // (restackLiveVisitFinancials, which never had that requirement) landed
  // on the engine's cent-exact $1.04 for the identical $20.70-at-5% line —
  // two different totals for what should be the same visit. Restacking now
  // fires whenever there is ANYTHING to restack, appointment discount or not.
  test('gate on, no appointment discount, cent-exact rounding differs from legacy float math', async () => {
    const lineDiscountRow = { id: 'line-disc-round7', name: 'Line 5%', discount_type: 'percentage', amount: 5 };
    db.mockReturnValueOnce(discountQuery(lineDiscountRow));

    const pricing = await withGateLive(() => buildAppointmentPricing({
      serviceRecord: { service_key: 'general_pest', category: 'pest_control', base_price: 20.70 },
      estimatedPrice: 20.70,
      primaryLinePrice: 20.70,
      primaryLineDiscount: { discountId: 'line-disc-round7' },
      serviceAddons: [],
      customer: { id: 'customer-1' },
    }));

    // 5% of $20.70 is the correct half-up $1.04 (integer-cent math) — never
    // the $1.03 that `baseAmount * (amount / 100)` float multiplication
    // gives (1.035 is 1.03499999999999992 in IEEE754).
    expect(pricing.primaryDiscount.discountDollars).toBe(1.04);
    expect(pricing.primaryNet).toBe(19.66);
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

  // Codex pre-push audit P1: a blank-priced add-on (no basePrice/grossPrice/
  // price and no catalog base_price to fall back on — a service still
  // awaiting a quote) must stay unpriced through the restack. The engine
  // only ever sees a numeric gross (line.base || 0), so that distinction
  // has to be restored at the one place that still knows which line came
  // in with no base at all.
  test('gate on: a blank-priced (awaiting-quote) add-on line stays unpriced, never becomes an explicit $0', async () => {
    const { lineDiscountRow, appointmentDiscountRow } = fixtures();
    db.mockReturnValueOnce(discountQuery(lineDiscountRow))
      .mockReturnValueOnce(discountQuery(appointmentDiscountRow));

    const pricing = await withGateLive(() => buildAppointmentPricing({
      serviceRecord: { service_key: 'general_pest', category: 'pest_control', base_price: 100 },
      estimatedPrice: 100,
      primaryLinePrice: 100,
      primaryLineDiscount: { discountId: 'line-disc-1' },
      serviceAddons: [{ name: 'Quote pending add-on' }],
      discountId: 'appt-fixed-1',
      discountType: 'fixed_amount',
      customer: { id: 'customer-1' },
    }));

    expect(pricing.addonLines[0].price).toBeNull();
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
  // stored row (the real catalog cap is already in memory here — see
  // pricing.primaryDiscount.maxDiscountDollars — so there is no time-of-edit
  // staleness risk the way a stored row's frozen dollars would have).
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
      // $30 credit takes the whole primary line, leaving $70; 15% of $70 =
      // $10.50 — not the anchor's $12, and not a stale copy of either.
      expect(result.primaryDiscountDollars).toBe(10.5);
      expect(result.appointmentDiscountDollars).toBe(30);
      expect(result.price).toBe(59.5);
    });
  });

  test('gate on but genuinely nothing to restack (no primary gross, no discount of any kind): returns null', async () => {
    await withGateLive(() => {
      expect(restackLiveVisitFinancials({ primaryBase: null, primaryDiscount: null, appointmentDiscount: null }, [])).toBeNull();
    });
  });

  // Codex pre-push audit P0 (round 8): a MISSING (not just explicit-$0)
  // primary used to bail out of restacking entirely, even with priced/
  // discounted add-ons and a shared appointment credit present — the exact
  // class round 3 fixed for an explicit $0, just for `null`/`undefined`
  // instead. Same worked example as round 3, primaryBase simply omitted.
  test('gate on: a MISSING primary (not explicit $0) still restacks its own priced/discounted add-ons and the shared appointment credit', async () => {
    await withGateLive(() => {
      const pricing = {
        primaryServiceKey: 'general_pest',
        primaryServiceCategory: 'pest_control',
        primaryDiscount: null,
        appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30, discountDollars: 30, maxDiscountDollars: null, serviceKeyFilter: null, serviceCategoryFilter: null },
      };
      const recurringAddon = { base: 100, price: 84, serviceKey: 'recurring_addon', serviceCategory: 'addon', discount: { discountType: 'percentage', discountAmount: 20, discountDollars: 16, maxDiscountDollars: null } };
      const oneTimeAddon = { base: 50, price: 50, serviceKey: 'one_time_addon', serviceCategory: 'addon', discount: null };

      const anchor = restackLiveVisitFinancials(pricing, [recurringAddon, oneTimeAddon]);
      expect(anchor.addonDollars[0].discountDollars).toBe(16);

      const later = restackLiveVisitFinancials(pricing, [recurringAddon]);
      expect(later.addonDollars[0].discountDollars).toBe(14);
      expect(later.price).toBe(56);
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
      const recurringAddon = { base: 100, price: 84, serviceKey: 'recurring_addon', serviceCategory: 'addon', discount: { discountType: 'percentage', discountAmount: 20, discountDollars: 16, maxDiscountDollars: null } };
      const oneTimeAddon = { base: 50, price: 50, serviceKey: 'one_time_addon', serviceCategory: 'addon', discount: null };

      const anchor = restackLiveVisitFinancials(pricing, [recurringAddon, oneTimeAddon]);
      expect(anchor.addonDollars[0].discountDollars).toBe(16);
      // Codex pre-push audit P1: the covered-member creation loop's OWN
      // addon-only total must read THIS netPrice (not the addon's original,
      // pre-restack .price) — $84, not the frozen $86 a stale read would
      // give when this occurrence's own add-on mix differs from another's.
      expect(anchor.addonDollars[0].netPrice).toBe(84);

      // A later occurrence where the one-time add-on isn't due.
      const later = restackLiveVisitFinancials(pricing, [recurringAddon]);
      expect(later.addonDollars[0].discountDollars).toBe(14);
      expect(later.addonDollars[0].netPrice).toBe(86);
      expect(later.price).toBe(56);
    });
  });

  // Codex pre-push audit P1: a blank-priced add-on (base == null — a
  // service still awaiting a quote) must stay unpriced through the
  // restack, never become an explicit $0 the engine's numeric-only gross
  // would otherwise produce.
  test('gate on: a blank-priced (awaiting-quote) add-on stays unpriced, never becomes an explicit $0', async () => {
    await withGateLive(() => {
      const pricing = {
        primaryBase: 100,
        primaryServiceKey: 'general_pest',
        primaryServiceCategory: 'pest_control',
        primaryDiscount: { discountType: 'percentage', discountAmount: 15, discountDollars: 15, maxDiscountDollars: null },
        appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30, discountDollars: 30, maxDiscountDollars: null, serviceKeyFilter: null, serviceCategoryFilter: null },
      };
      const unpricedAddon = { base: null, price: null, serviceKey: 'quote_pending_addon', serviceCategory: 'addon', discount: null };
      const result = restackLiveVisitFinancials(pricing, [unpricedAddon]);
      expect(result.addonDollars[0].netPrice).toBeNull();
      expect(result.addonDollars[0].discountDollars).toBeNull();
    });
  });

  // Codex pre-push audit P0 (round 7) — the create-time counterpart:
  // restacks even with no appointment discount at all, using the engine's
  // cent-exact rounding.
  test('gate on, no appointment discount: cent-exact rounding for a percentage-only primary', async () => {
    await withGateLive(() => {
      const result = restackLiveVisitFinancials({
        primaryBase: 20.70,
        primaryServiceKey: 'general_pest',
        primaryServiceCategory: 'pest_control',
        primaryDiscount: { discountType: 'percentage', discountAmount: 5, discountDollars: 1.03, maxDiscountDollars: null },
        appointmentDiscount: null,
      }, []);
      expect(result.primaryDiscountDollars).toBe(1.04);
      expect(result.price).toBe(19.66);
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
  // a different occurrence's mix. discountCaps is empty (no cap on this
  // discount) — an empty/missing entry always reads as uncapped.
  const parentTemplate = {
    primary_line_price: 100,
    line_discount_id: 'line-disc-1',
    line_discount_type: 'percentage',
    line_discount_amount: 15,
    discount_type: 'fixed_amount',
    discount_amount: 30,
    discount_max_dollars: null,
    service_key_snapshot: 'general_pest',
  };
  const uncappedCaps = new Map([['line-disc-1', null]]);

  test('an occurrence WITH a due add-on shares the fixed credit’s pool, shrinking the line’s own remainder', () => {
    const withAddon = restackStoredVisitFinancials(parentTemplate, [
      { base_price: 50, estimated_price: 50, discount_type: null, discount_amount: null, service_id: 'addon-svc' },
    ], null, uncappedCaps);

    // Pool = 100 + 50 = 150. $30 credit pro-rated: primary's share =
    // 30 * 100/150 = 20, leaving $80. 15% of $80 = $12.
    expect(withAddon.primaryLineDiscountDollars).toBe(12);
    expect(withAddon.appointmentDiscountDollars).toBe(30);
  });

  test('the SAME primary discount on an occurrence with NO due add-on resolves a DIFFERENT dollar figure', () => {
    const withoutAddon = restackStoredVisitFinancials(parentTemplate, [], null, uncappedCaps);

    // Pool = 100 only. The full $30 credit lands on the primary line,
    // leaving $70. 15% of $70 = $10.50 — not the $12 the other occurrence's
    // add-on mix produced, and NOT a frozen copy of either figure.
    expect(withoutAddon.primaryLineDiscountDollars).toBe(10.5);
    expect(withoutAddon.appointmentDiscountDollars).toBe(30);
  });

  // Codex pre-push audit P0, round 10 (reverting a round-8 attempt to treat
  // this the same as restackLiveVisitFinancials' identical-looking guard):
  // a STORED row's null primary_line_price does NOT mean "no primary
  // charge" the way a fresh, in-memory pricing.primaryBase does —
  // calculateStoredVisitFinancials (unmodified, sitting right alongside
  // this restack) already reconstructs a REAL implied primary contribution
  // for that case, from estimated_price minus the parent's full add-on
  // total. That covers BOTH the anchored-split marker (the visit's TOTAL,
  // primary share folded in) AND an ordinary legacy/unstructured row (a
  // flat estimated_price with no line-item breakdown ever recorded) —
  // restacking from gross:0 in either case would silently overwrite that
  // reconstructed charge with a hard $0. Every null primary_line_price
  // therefore defers entirely; only an EXPLICIT $0 (round 3 — a member-
  // covered series stamps exactly this) is a real, known-zero gross safe to
  // restack around.
  test('returns null for ANY null primary_line_price — defers to calculateStoredVisitFinancials’ own reconstruction', () => {
    expect(restackStoredVisitFinancials({ ...parentTemplate, primary_line_price: null }, [], null, uncappedCaps)).toBeNull();
    // Codex's own repro: a legacy/unstructured row with a real $100 total
    // and no add-ons must not restack to price: 0.
    expect(restackStoredVisitFinancials({ primary_line_price: null, estimated_price: 100, discount_type: null }, [], null, new Map())).toBeNull();
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
      { base_price: 80, estimated_price: 72, discount_type: 'percentage', discount_amount: 10, discount_dollars: 8, discount_id: 'addon-disc-1', service_id: 'addon-svc' },
    ], null, new Map([['addon-disc-1', null]]));

    // Pool = 100 (primary, no own discount) + 80 (addon) = 180. $20 credit
    // pro-rated: addon's share = 20 * 80/180 = $8.89, leaving $71.11. 10% of
    // that (cent-exact) is $7.11 — never the frozen $8.
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
      // estimated_price(45) + discount_dollars(5) = 50, then 10% of 50 = 5
      // (before the shared credit's pro-rata reduction below).
      { base_price: null, estimated_price: 45, discount_type: 'percentage', discount_amount: 10, discount_dollars: 5, discount_id: 'addon-disc-2', service_id: 'addon-svc' },
    ], null, new Map([['addon-disc-2', null]]));

    // Pool = 100 + 50 = 150. $20 credit pro-rated: addon's share =
    // 20 * 50/150 = $6.67, leaving $43.33. 10% of that is $4.33 — recomputed
    // against the derived $50 gross, not the frozen $5.
    expect(result.addonDollars[0].discountDollars).toBe(4.33);
  });

  // Codex pre-push audit P0 (round 1): reconstructing a line discount's
  // typed slot with no cap at all let the restack ignore a cap
  // calculateDiscountDollars would otherwise have enforced. discountCaps —
  // the REAL catalog cap, fetched fresh via loadDiscountCapsById, never a
  // frozen dollar figure standing in for one — fixes it.
  test('a capped primary line discount (real catalog cap) keeps its cap through a stored restack', () => {
    const result = restackStoredVisitFinancials({
      primary_line_price: 100,
      line_discount_id: 'line-disc-capped',
      line_discount_type: 'percentage',
      line_discount_amount: 50,
      discount_type: 'fixed_amount',
      discount_amount: 10,
    }, [], null, new Map([['line-disc-capped', 10]]));

    // $10 fixed credit off $100 first = $90 remaining. Uncapped, 50% of $90
    // would be $45 — the real $10 cap holds it there, netting $80.
    expect(result.primaryLineDiscountDollars).toBe(10);
    expect(result.price).toBe(80);
  });

  // Codex pre-push audit P0 (round 4): an explicit $0 cap must be honored,
  // not read as "no cap." discountCaps' own Map semantics already handle
  // this correctly (get() returns exactly what was set, 0 included) —
  // pinned here as a real catalog-cap counterpart to the original finding.
  test('an explicit $0 catalog cap restacks the discount to $0, never as uncapped', () => {
    const result = restackStoredVisitFinancials({
      primary_line_price: 100,
      line_discount_id: 'line-disc-zero-cap',
      line_discount_type: 'percentage',
      line_discount_amount: 50,
      discount_type: 'fixed_amount',
      discount_amount: 10,
    }, [], null, new Map([['line-disc-zero-cap', 0]]));

    expect(result.primaryLineDiscountDollars).toBeNull(); // 0 dollars reports as null, same convention as every other zero discount
    expect(result.price).toBe(90);
  });

  test('a 100%-off primary line restacks to a real $0 price WITH its full discount stamp intact', () => {
    const result = restackStoredVisitFinancials({
      primary_line_price: 100,
      line_discount_type: 'percentage',
      line_discount_amount: 100,
      discount_type: null,
    }, [], null, new Map());

    expect(result.price).toBe(0);
    expect(result.primaryLineDiscountDollars).toBe(100);
  });

  test('a $0 primary_line_price still restacks its OWN priced/discounted due add-ons and the shared appointment credit', () => {
    const parent = { primary_line_price: 0, line_discount_type: null, discount_type: 'fixed_amount', discount_amount: 30 };
    const recurringAddon = { base_price: 100, estimated_price: 84, discount_type: 'percentage', discount_amount: 20, discount_dollars: 16, discount_id: 'recurring-disc', service_id: 'recurring-addon' };
    const oneTimeAddon = { base_price: 50, estimated_price: 50, discount_type: null, service_id: 'one-time-addon' };
    const caps = new Map([['recurring-disc', null]]);

    const anchor = restackStoredVisitFinancials(parent, [recurringAddon, oneTimeAddon], null, caps);
    expect(anchor.addonDollars[0].discountDollars).toBe(16);

    const later = restackStoredVisitFinancials(parent, [recurringAddon], null, caps);
    expect(later.addonDollars[0].discountDollars).toBe(14);
    expect(later.price).toBe(56);
  });

  // Codex pre-push audit P1: a stored add-on row with neither base_price
  // NOR estimated_price at all (a service still awaiting a quote) must
  // stay unpriced through the restack, never become an explicit $0.
  test('a blank stored add-on row (no base_price, no estimated_price) stays unpriced through the restack', () => {
    const result = restackStoredVisitFinancials({
      primary_line_price: 100,
      line_discount_id: 'line-disc-blank',
      line_discount_type: 'percentage',
      line_discount_amount: 15,
      discount_type: 'fixed_amount',
      discount_amount: 30,
    }, [
      { base_price: null, estimated_price: null, discount_type: null, service_id: 'quote-pending-addon' },
    ], null, new Map([['line-disc-blank', null]]));

    expect(result.addonDollars[0].netPrice).toBeNull();
    expect(result.addonDollars[0].discountDollars).toBeNull();
  });

  // Codex pre-push audit P0 (round 5): reading the ORIGINAL frozen dollars
  // as a surrogate cap went stale the moment the credit sharing its pool
  // was later edited — a $100 primary at 20% under a $30 credit freezes
  // $14; the credit drops to $10 and the true share should rise to $18, but
  // the stale surrogate held it at $14. Reading the REAL catalog cap fresh
  // (here: no cap at all) fixes it — the SAME typed primary discount now
  // correctly tracks whatever the CURRENT appointment credit is.
  test('tracks a changed appointment credit correctly — no stale surrogate cap', () => {
    const primaryTerm = {
      primary_line_price: 100,
      line_discount_id: 'line-disc-3',
      line_discount_type: 'percentage',
      line_discount_amount: 20,
    };
    const caps = new Map([['line-disc-3', null]]);

    const underOldCredit = restackStoredVisitFinancials({ ...primaryTerm, discount_type: 'fixed_amount', discount_amount: 30 }, [], null, caps);
    expect(underOldCredit.primaryLineDiscountDollars).toBe(14);
    expect(underOldCredit.price).toBe(56);

    // The credit is edited down to $10 (a different slice's own concern —
    // this only proves THIS function reads it fresh, not a stale figure).
    const underNewCredit = restackStoredVisitFinancials({ ...primaryTerm, discount_type: 'fixed_amount', discount_amount: 10 }, [], null, caps);
    expect(underNewCredit.primaryLineDiscountDollars).toBe(18);
    expect(underNewCredit.price).toBe(72);
  });

  // Codex pre-push audit P0 (round 7): legacy float rounding
  // (baseAmount * (amount / 100)) can itself differ from this engine's
  // cent-exact integer math by a cent even with NO cap and NO appointment
  // discount at all — so a frozen dollar figure was never a safe stand-in
  // for a cap for ANY reason, not just staleness.
  test('cent-exact rounding for a percentage-only primary with no appointment discount', () => {
    const result = restackStoredVisitFinancials({
      primary_line_price: 20.70,
      line_discount_id: 'line-disc-round7',
      line_discount_type: 'percentage',
      line_discount_amount: 5,
      discount_type: null,
    }, [], null, new Map([['line-disc-round7', null]]));

    expect(result.primaryLineDiscountDollars).toBe(1.04);
    expect(result.price).toBe(19.66);
  });

  test('a missing discountCaps argument reads every percentage term as uncapped rather than failing', () => {
    const result = restackStoredVisitFinancials({
      primary_line_price: 100,
      line_discount_id: 'line-disc-unmapped',
      line_discount_type: 'percentage',
      line_discount_amount: 20,
      discount_type: null,
    }, [], null);

    expect(result.primaryLineDiscountDollars).toBe(20);
  });

  // Codex pre-push audit P1 (round 14): the appointment-level cap
  // (parent.discount_max_dollars) is the ONE cap source in this function
  // that reached typedDiscountSlot with no Number() wrap — every sibling
  // (catalogCap's line/addon caps, buildAppointmentPricing's identical
  // live-side slot) explicitly coerces. node-postgres returns a
  // numeric/decimal column as a STRING by default, so this row is
  // Postgres-shaped on purpose: '10.00', not 10.
  //
  // Revert-to-red note: with the coercion removed, this assertion still
  // PASSES — discount-stack.js's own capDollars/resolveDiscountCap each do
  // their own Number(maxDiscountDollars) before their Number.isFinite
  // check, so a raw string cap is already honored one layer downstream
  // today. The admin-schedule.js coercion this pins is real defense-in-
  // depth matching every sibling call site (and the only thing standing
  // between a raw string and Number.isFinite the moment either of those
  // two engine functions is ever refactored to check isFinite directly)
  // rather than a currently-observable output bug — recorded here rather
  // than silently dropped so the next person doesn't have to re-derive it.
  test('a Postgres-shaped (string) appointment discount cap is honored, not dropped, through a stored restack', () => {
    const result = restackStoredVisitFinancials({
      primary_line_price: 100,
      line_discount_type: null,
      discount_type: 'percentage',
      discount_amount: 50,
      discount_max_dollars: '10.00',
    }, [], null, new Map());

    // Uncapped, 50% of $100 would be $50 off; the $10 cap must hold.
    expect(result.appointmentDiscountDollars).toBe(10);
    expect(result.price).toBe(90);
  });
});

describe('recurring extension — loadDiscountCapsById', () => {
  function fakeConnWithRows(rows) {
    const table = {
      whereIn: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue(rows),
    };
    return jest.fn(() => table);
  }

  test('returns an empty Map for no ids, without querying', async () => {
    const conn = fakeConnWithRows([]);
    const caps = await loadDiscountCapsById(conn, []);
    expect(caps.size).toBe(0);
    expect(conn).not.toHaveBeenCalled();
  });

  test('maps each id to its real cap, including an explicit $0, and dedupes the id list', async () => {
    const conn = fakeConnWithRows([
      { id: 'd1', max_discount_dollars: 10 },
      { id: 'd2', max_discount_dollars: 0 },
      { id: 'd3', max_discount_dollars: null },
    ]);
    const caps = await loadDiscountCapsById(conn, ['d1', 'd2', 'd3', 'd1', null, undefined]);
    expect(caps.get('d1')).toBe(10);
    expect(caps.get('d2')).toBe(0);
    expect(caps.get('d3')).toBeNull();
    const table = conn.mock.results[0].value;
    expect(table.whereIn).toHaveBeenCalledWith('id', ['d1', 'd2', 'd3']);
  });
});

describe('recurring extension — applyDiscountStackRestack (no-op contract)', () => {
  afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

  const cols = { estimated_price: true, discount_dollars: true, line_discount_dollars: true };
  const parentTemplate = {
    primary_line_price: 100,
    line_discount_id: 'line-disc-1',
    line_discount_type: 'percentage',
    line_discount_amount: 15,
    discount_type: 'fixed_amount',
    discount_amount: 30,
  };
  const uncappedCaps = new Map([['line-disc-1', null]]);

  test('gate off: touches nothing on the target row', () => {
    delete process.env.GATE_DISCOUNT_STACKING;
    const target = { estimated_price: 999, discount_dollars: 999, line_discount_dollars: 999 };
    const result = applyDiscountStackRestack(target, cols, parentTemplate, [], null, uncappedCaps);
    expect(result).toBeNull();
    expect(target).toEqual({ estimated_price: 999, discount_dollars: 999, line_discount_dollars: 999 });
  });

  test('gate on: overrides the frozen fields with the restacked figures', async () => {
    await withGateLive(() => {
      const target = { estimated_price: 999, discount_dollars: 999, line_discount_dollars: 999 };
      const addonDollars = applyDiscountStackRestack(target, cols, parentTemplate, [], null, uncappedCaps);
      expect(target.line_discount_dollars).toBe(10.5); // 15% of (100 - 30)
      expect(target.discount_dollars).toBe(30);
      expect(target.estimated_price).toBe(59.5); // 100 - 10.5 - 30
      expect(addonDollars).toEqual([]);
    });
  });

  test('gate on but nothing to restack (null primary_line_price — anchored-split marker or legacy/unstructured row): returns null and leaves target untouched', async () => {
    await withGateLive(() => {
      const target = { estimated_price: 999, discount_dollars: 999, line_discount_dollars: 999 };
      const result = applyDiscountStackRestack(target, cols, { ...parentTemplate, primary_line_price: null }, [], null, uncappedCaps);
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
      }, [], null, new Map());
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

// The requested creation-to-extension parity regression: a seeded child
// (restackLiveVisitFinancials) and a later bare extension of the SAME
// series (restackStoredVisitFinancials) must agree for the identical
// inputs — including a FIXED credit sharing a pool with a percentage line
// discount (round 5/6's own combination), now that both restack via the
// real cap rather than one deferring while the other didn't.
describe('creation-to-extension parity', () => {
  afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

  test('a seeded child and a bare extension of the same series restack to the identical figures', async () => {
    await withGateLive(() => {
      const seededChild = restackLiveVisitFinancials({
        primaryBase: 100,
        primaryServiceKey: 'general_pest',
        primaryServiceCategory: 'pest_control',
        primaryDiscount: { discountType: 'percentage', discountAmount: 15, discountDollars: 15, maxDiscountDollars: null },
        appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30, discountDollars: 30, maxDiscountDollars: null, serviceKeyFilter: null, serviceCategoryFilter: null },
      }, []);
      const extension = restackStoredVisitFinancials({
        primary_line_price: 100,
        line_discount_id: 'line-disc-parity',
        line_discount_type: 'percentage',
        line_discount_amount: 15,
        discount_type: 'fixed_amount',
        discount_amount: 30,
      }, [], null, new Map([['line-disc-parity', null]]));

      expect(seededChild.primaryDiscountDollars).toBe(extension.primaryLineDiscountDollars);
      expect(seededChild.appointmentDiscountDollars).toBe(extension.appointmentDiscountDollars);
      expect(seededChild.price).toBe(extension.price);
      expect(seededChild.price).toBe(59.5);
    });
  });

  test('both restack to the same cent-exact figure with no appointment discount at all', async () => {
    await withGateLive(() => {
      const seededChild = restackLiveVisitFinancials({
        primaryBase: 20.70,
        primaryServiceKey: 'general_pest',
        primaryServiceCategory: 'pest_control',
        primaryDiscount: { discountType: 'percentage', discountAmount: 5, discountDollars: 1.03, maxDiscountDollars: null },
        appointmentDiscount: null,
      }, []);
      const extension = restackStoredVisitFinancials({
        primary_line_price: 20.70,
        line_discount_id: 'line-disc-round7',
        line_discount_type: 'percentage',
        line_discount_amount: 5,
        discount_type: null,
      }, [], null, new Map([['line-disc-round7', null]]));

      expect(seededChild.primaryDiscountDollars).toBe(1.04);
      expect(extension.primaryLineDiscountDollars).toBe(1.04);
    });
  });
});

// Deferred fast-follow (flagged on the original push, round 11): the
// CREATE-time billable-amount validation gate (floorForDate, ~admin-schedule.js
// POST create) used to size a date's floor via calculateVisitFinancialsForAddons
// alone — the LEGACY, non-restacked computation — so once a capped line
// discount and a large appointment credit interact, the gate could compute
// LESS than what the row will actually be charged and wrongly 409 a
// legitimately billable booking. occurrenceFloorPrice is floorForDate's own
// extracted decision (routes through restackLiveVisitFinancials, the exact
// pricing the insert loop stamps with, when the gate is live) so validation
// and persistence can never disagree.
describe('CREATE-time billable-amount gate — occurrenceFloorPrice', () => {
  afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

  const addonOnlyTotal = (lines) => (lines || []).reduce((sum, a) => sum + (Number(a?.price) > 0 ? Number(a.price) : 0), 0);

  // Codex's own worked example: a $100 primary at 50% off, a $100 one-time
  // add-on, and an $80 appointment credit. The anchor (add-on present)
  // restacks its primary to a $70 net. A LATER date with no add-on due
  // must floor at the canonical $10 (the $80 credit takes $80 of the
  // primary's $100 first, leaving $20, then 50% of $20 = $10 line discount,
  // net $90, minus the $80 credit = $10) — never the legacy $0 that
  // calculateVisitFinancialsForAddons alone gives.
  const pricingFixture = {
    primaryBase: 100,
    primaryNet: 70, // the anchor's OWN restacked net (add-on present) — what calculateVisitFinancialsForAddons's legacy subtotal reads
    primaryServiceKey: 'general_pest',
    primaryServiceCategory: 'pest_control',
    primaryDiscount: { discountType: 'percentage', discountAmount: 50, discountDollars: 30, maxDiscountDollars: null },
    appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 80, discountDollars: 80, maxDiscountDollars: null, serviceKeyFilter: null, serviceCategoryFilter: null },
  };

  test('gate off: byte-identical to the legacy calculateVisitFinancialsForAddons floor', () => {
    const lines = [];
    const legacy = calculateVisitFinancialsForAddons(pricingFixture, lines).price || 0;
    const floor = occurrenceFloorPrice(pricingFixture, lines, {
      memberSeriesCovered: false, isBoosterDate: false, addonOnlyTotal,
    });
    expect(floor).toBe(legacy);
    expect(floor).toBe(0); // the legacy bug's own $0 — unchanged when the gate is off
  });

  test('gate on: a later add-on-free date floors at the canonical $10, never the legacy $0', async () => {
    await withGateLive(() => {
      const later = occurrenceFloorPrice(pricingFixture, [], {
        memberSeriesCovered: false, isBoosterDate: false, addonOnlyTotal,
      });
      expect(later).toBe(10);

      // The date WITH the add-on due restacks to its own, different floor.
      const withAddon = occurrenceFloorPrice(pricingFixture, [
        { base: 100, price: 100, serviceKey: 'one_time_addon', serviceCategory: 'addon', discount: null },
      ], { memberSeriesCovered: false, isBoosterDate: false, addonOnlyTotal });
      expect(withAddon).toBe(90);
    });
  });

  test('gate on: a covered-member date still uses the restacked add-on-only total', async () => {
    await withGateLive(() => {
      const pricing = {
        primaryBase: 0,
        primaryServiceKey: 'general_pest',
        primaryServiceCategory: 'pest_control',
        primaryDiscount: null,
        appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30, discountDollars: 30, maxDiscountDollars: null, serviceKeyFilter: null, serviceCategoryFilter: null },
      };
      const recurringAddon = { base: 100, price: 84, serviceKey: 'recurring_addon', serviceCategory: 'addon', discount: { discountType: 'percentage', discountAmount: 20, discountDollars: 16, maxDiscountDollars: null } };
      const oneTimeAddon = { base: 50, price: 50, serviceKey: 'one_time_addon', serviceCategory: 'addon', discount: null };

      const anchorFloor = occurrenceFloorPrice(pricing, [recurringAddon, oneTimeAddon], {
        memberSeriesCovered: true, isBoosterDate: false, addonOnlyTotal,
      });
      expect(anchorFloor).toBe(134); // 84 (restacked recurring add-on net) + 50

      const laterFloor = occurrenceFloorPrice(pricing, [recurringAddon], {
        memberSeriesCovered: true, isBoosterDate: false, addonOnlyTotal,
      });
      expect(laterFloor).toBe(86); // restacked to $14 off, not the frozen $16
    });
  });

  test('gate on: a booster date is never addon-only-stripped, even for a covered member', async () => {
    await withGateLive(() => {
      const pricing = {
        primaryBase: 100,
        primaryNet: 100,
        primaryServiceKey: 'general_pest',
        primaryServiceCategory: 'pest_control',
        primaryDiscount: null,
        appointmentDiscount: null,
      };
      const floor = occurrenceFloorPrice(pricing, [], {
        memberSeriesCovered: true, isBoosterDate: true, addonOnlyTotal,
      });
      expect(floor).toBe(100);
    });
  });
});

// Second deferred fast-follow (round 12 of the original push's Codex
// history, flagged AFTER occurrenceFloorPrice's own fix landed):
// seriesExtensionUnbillable — the shared billable-amount guard for the
// visit-count top-up and both recurring-alert extend/convert actions —
// still sized its floor with calculateStoredVisitFinancials alone, the
// STORED-path's own legacy, non-restacked computation. Once a capped (or
// even uncapped, per Codex's own repro) line discount and a large
// appointment credit interact, the guard could compute LESS than what an
// extension will actually restack to and wrongly 409 a legitimately
// billable extension. storedOccurrenceFloorPrice is the stored-path
// sibling of occurrenceFloorPrice above: it restacks via
// restackStoredVisitFinancials (the same engine + real catalog caps every
// extension write site already stamps rows with) when the gate is live,
// falling back to calculateStoredVisitFinancials's own price otherwise —
// gate off, or the one combination restackStoredVisitFinancials itself
// defers on (a null primary_line_price: the anchored-split marker, or an
// ordinary legacy/unstructured row).
describe('recurring extension — storedOccurrenceFloorPrice (seriesExtensionUnbillable’s own floor)', () => {
  afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

  // Codex's own worked example: a $100 primary at 50% off, an $80
  // appointment credit, and a $100 anchor-only add-on. The anchor (add-on
  // present) restacks its primary to a $30 line discount — the FROZEN
  // figure every extension caller's copyLineDiscountFields already writes.
  const parentTemplate = {
    primary_line_price: 100,
    line_discount_id: 'line-disc-round12',
    line_discount_type: 'percentage',
    line_discount_amount: 50,
    line_discount_dollars: 30, // the anchor's own frozen figure, with the add-on present
    discount_type: 'fixed_amount',
    discount_amount: 80,
  };
  const uncappedCaps = new Map([['line-disc-round12', null]]);

  test('gate off: byte-identical to calling calculateStoredVisitFinancials directly', () => {
    const dueAddons = [];
    const legacy = calculateStoredVisitFinancials(parentTemplate, dueAddons, dueAddons, null);
    const legacyFloor = Number(legacy.price) > 0 ? Number(legacy.price) : 0;
    const floor = storedOccurrenceFloorPrice(parentTemplate, dueAddons, dueAddons, null, uncappedCaps);
    expect(floor).toBe(legacyFloor);
    // The legacy bug's own $0 (max(0, 100 − 30 − 80)) — unchanged off.
    expect(floor).toBe(0);
  });

  test('gate on: an add-on-free extension floors at the canonical $10, never the legacy $0/409', async () => {
    await withGateLive(() => {
      const floor = storedOccurrenceFloorPrice(parentTemplate, [], [], null, uncappedCaps);
      expect(floor).toBe(10);
    });
  });

  test('gate on: the anchor date (add-on present) still floors at its own $90', async () => {
    await withGateLive(() => {
      const anchorAddons = [{ base_price: 100, estimated_price: 100, discount_type: null, service_id: 'addon-svc' }];
      const floor = storedOccurrenceFloorPrice(parentTemplate, anchorAddons, anchorAddons, null, uncappedCaps);
      expect(floor).toBe(90);
    });
  });

  test('gate on but restackStoredVisitFinancials defers (null primary_line_price): falls back to calculateStoredVisitFinancials', async () => {
    await withGateLive(() => {
      const markerParent = { primary_line_price: null, estimated_price: 100, discount_type: null };
      const legacy = calculateStoredVisitFinancials(markerParent, [], [], null);
      const legacyFloor = Number(legacy.price) > 0 ? Number(legacy.price) : 0;
      const floor = storedOccurrenceFloorPrice(markerParent, [], [], null, new Map());
      expect(floor).toBe(legacyFloor);
      expect(floor).toBe(100);
    });
  });
});

// Codex pre-push audit P1 (round 14): seriesExtensionUnbillable's discount-
// cap set is fixed for the whole call (gatePriceParent.line_discount_id +
// parentAddons' own discount ids never vary per date), so it's read ONCE
// before the per-date floor loop, not once per date — a billable-amount
// guard the caller can ask about many dates at once has no business
// repeating the same catalog round trip for each one.
describe('recurring extension — seriesExtensionUnbillable (single discountCaps read across every date)', () => {
  beforeEach(() => {
    delete process.env.GATE_DISCOUNT_STACKING;
  });

  // A minimal fake conn: 'customers' resolves the gate's own read; every
  // other table (only 'discounts', from loadDiscountCapsById, is actually
  // reached — 'scheduled_services' is touched too, by
  // resolveSeriesExtensionPriceTemplate's own unrelated read, and served a
  // harmless null) is served through the SAME thenable, with every await
  // against 'discounts' recorded so the fix can be pinned by COUNT, not
  // just by result.
  function makeUnbillableConn(discountRows) {
    const discountCalls = [];
    const conn = (table) => {
      let whereInIds = null;
      const chain = {
        where: () => chain,
        whereIn: (_col, ids) => { whereInIds = ids; return chain; },
        select: () => chain,
        first: () => Promise.resolve(table === 'customers' ? { id: 'c1' } : null),
        then: (resolve, reject) => {
          if (table === 'discounts') {
            discountCalls.push(whereInIds);
            return Promise.resolve(discountRows.filter((r) => whereInIds.includes(r.id))).then(resolve, reject);
          }
          return Promise.resolve([]).then(resolve, reject);
        },
      };
      return chain;
    };
    return { conn, discountCalls };
  }

  // Priced (createInvoiceOnComplete forces willMint true regardless of
  // customer billing lane, per recurringWithoutBillableAmount above), so
  // the function returns null (billable — nothing to refuse) instead of
  // exercising the gate's rejection branches, which are already covered by
  // the runRecurringAlertAction P1 tests in recurring-series-maintenance.
  // test.js. No service_id / service_key_snapshot / service_type means
  // resolveCompletionProfileForScheduledService's own lookup returns early
  // without touching the fake conn at all.
  const parent = {
    id: 'p1', customer_id: 'c1', primary_line_price: 100,
    line_discount_id: 'ld1', line_discount_type: 'percentage', line_discount_amount: 10,
    discount_type: null, service_type: '', create_invoice_on_complete: true,
  };
  const cols = { create_invoice_on_complete: {} };
  const dates = ['2099-01-01', '2099-02-01', '2099-03-01'];

  test('gate off: no discounts read at all (no-op path, byte-identical to before this slice)', async () => {
    const { conn, discountCalls } = makeUnbillableConn([{ id: 'ld1', max_discount_dollars: null }]);
    const result = await seriesExtensionUnbillable(conn, {
      parent, dates, cols, parentAddons: [], storedDiscountScope: null, blackoutDates: [], skipParent: false,
    });
    expect(result).toBeNull();
    expect(discountCalls).toHaveLength(0);
  });

  test('gate on: the SAME discount-cap set is read ONCE for 3 dates, not once per date', async () => {
    await withGateLive(async () => {
      const { conn, discountCalls } = makeUnbillableConn([{ id: 'ld1', max_discount_dollars: null }]);
      const result = await seriesExtensionUnbillable(conn, {
        parent, dates, cols, parentAddons: [], storedDiscountScope: null, blackoutDates: [], skipParent: false,
      });
      expect(result).toBeNull(); // billable — the gate itself is unaffected by this fix
      expect(discountCalls).toHaveLength(1);
      expect(discountCalls[0]).toEqual(['ld1']);
    });
  });

  test('gate on: the read covers the UNION of every parentAddons discount id, not just the primary', () => {
    return withGateLive(async () => {
      const { conn, discountCalls } = makeUnbillableConn([
        { id: 'ld1', max_discount_dollars: null },
        { id: 'addon-disc-a', max_discount_dollars: 25 },
        { id: 'addon-disc-b', max_discount_dollars: null },
      ]);
      const parentAddons = [
        { discount_id: 'addon-disc-a', service_id: 'svc-a' },
        { discount_id: 'addon-disc-b', service_id: 'svc-b' },
      ];
      await seriesExtensionUnbillable(conn, {
        parent, dates, cols, parentAddons, storedDiscountScope: null, blackoutDates: [], skipParent: false,
      });
      expect(discountCalls).toHaveLength(1);
      expect(discountCalls[0]).toEqual(['ld1', 'addon-disc-a', 'addon-disc-b']);
    });
  });
});

// Round 13 (the P0 blocked at the prior push): restackStoredVisitFinancials
// deferred on EVERY null primary_line_price (round 10's fix), which was
// correct for a legacy/marker row but too broad — it also deferred a
// genuinely-null-primary row THIS SLICE itself priced (an add-on-only
// booking), so creation and its own later extension disagreed. The
// pricing-regime marker (stampPricingRegimeMarker/hasPricingRegimeMarker,
// visit-financial-stamps.js) resolves it: a row THIS SLICE stamped while
// the gate was live carries the marker and restacks its null primary as a
// real $0; a row without it (legacy, or the anchored-split marker
// template, which strips its own copy via clearPricingRegimeMarker) still
// defers.
//
// GitHub Codex round 1 on #4642 (PRRT_kwDOR3YQi86kllyE): the marker
// ORIGINALLY reused `scheduled_services.metadata`, which does not exist on
// this table — every migration was searched, none defines one — so the
// stamp silently no-opped in production. It now writes a real, migrated
// column (`pricing_provenance`, migration 20260921000002), and the marker
// also carries a `caps` snapshot (see the "frozen caps" describe below).
describe('pricing-regime marker (round 13; round 14: real column + frozen caps)', () => {
  afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

  describe('stampPricingRegimeMarker / hasPricingRegimeMarker / clearPricingRegimeMarker', () => {
    const cols = { pricing_provenance: true };

    test('stamps the marker (regime + engine version + an empty caps snapshot) onto an empty target', () => {
      const target = {};
      stampPricingRegimeMarker(target, cols);
      expect(target.pricing_provenance).toEqual({ pricing_regime: 'discount_stack_v1', engine_version: 1, caps: { line: null, addons: {} } });
      expect(hasPricingRegimeMarker(target)).toBe(true);
    });

    test('stamps the given caps snapshot verbatim (defensively copied, not aliased)', () => {
      const target = {};
      const caps = { line: 10, addons: { 'addon-1': 25, 'addon-2': null } };
      stampPricingRegimeMarker(target, cols, caps);
      expect(target.pricing_provenance.caps).toEqual(caps);
      caps.addons['addon-1'] = 999; // mutate the input after stamping
      expect(target.pricing_provenance.caps.addons['addon-1']).toBe(25); // unaffected — a real copy
    });

    test('OVERWRITES a prior pricing_provenance value entirely — a single-purpose column, not a merge target', () => {
      const target = { pricing_provenance: { some_other_shape: true } };
      stampPricingRegimeMarker(target, cols, { line: 5, addons: {} });
      expect(target.pricing_provenance).toEqual({ pricing_regime: 'discount_stack_v1', engine_version: 1, caps: { line: 5, addons: {} } });
    });

    test('no-op without a pricing_provenance column, or without a target', () => {
      const target = { pricing_provenance: 'unchanged' };
      stampPricingRegimeMarker(target, {});
      expect(target.pricing_provenance).toBe('unchanged');
      expect(stampPricingRegimeMarker(null, cols)).toBeUndefined();
    });

    test('hasPricingRegimeMarker reads a JSON-string pricing_provenance value too (knex can return either shape)', () => {
      expect(hasPricingRegimeMarker({ pricing_provenance: JSON.stringify({ pricing_regime: 'discount_stack_v1' }) })).toBe(true);
      expect(hasPricingRegimeMarker({ pricing_provenance: JSON.stringify({ other_key: 'x' }) })).toBe(false);
      expect(hasPricingRegimeMarker({ pricing_provenance: 'not json' })).toBe(false);
      expect(hasPricingRegimeMarker({ pricing_provenance: null })).toBe(false);
      expect(hasPricingRegimeMarker(null)).toBe(false);
    });

    test('clearPricingRegimeMarker nulls the whole column — a single-purpose column has nothing else to preserve', () => {
      const target = { pricing_provenance: { pricing_regime: 'discount_stack_v1', caps: { line: 10, addons: {} } } };
      clearPricingRegimeMarker(target);
      expect(target.pricing_provenance).toBeNull();
      expect(hasPricingRegimeMarker(target)).toBe(false);
    });

    test('clearPricingRegimeMarker is a no-op when there is nothing to clear', () => {
      const target = {};
      clearPricingRegimeMarker(target);
      expect(target.pricing_provenance).toBeUndefined();
      const untouched = { pricing_provenance: null };
      clearPricingRegimeMarker(untouched);
      expect(untouched.pricing_provenance).toBeNull();
    });
  });

  // Codex's exact worked example: a $100 recurring add-on at 20% off, a $50
  // one-time add-on, and a $30 appointment credit, on a NULL (not $0)
  // primary. Creation (restackLiveVisitFinancials, always safe — no
  // ambiguity for fresh, in-memory pricing) already restacks the seeded
  // occurrence without the one-time add-on to $56. A later EXTENSION of
  // that SAME row — marked, since it was priced under this slice while the
  // gate was live — must land on the identical $56, never the frozen $54
  // (100's worth of "replay the anchor's own $16 add-on discount" math: 84
  // net + 50 net for the anchor, but only the recurring add-on's frozen $16
  // survives on an add-on-free-of-the-one-time-add-on occurrence, giving
  // 84 - 30 = 54).
  test('Codex round 13: creation and a marked extension agree on $56 for a null-primary add-on-only booking', async () => {
    await withGateLive(() => {
      const seededChild = restackLiveVisitFinancials({
        primaryBase: null,
        primaryServiceKey: 'general_pest',
        primaryServiceCategory: 'pest_control',
        primaryDiscount: null,
        appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30, discountDollars: 30, maxDiscountDollars: null, serviceKeyFilter: null, serviceCategoryFilter: null },
      }, [
        { base: 100, price: 84, serviceKey: 'recurring_addon', serviceCategory: 'addon', discount: { discountType: 'percentage', discountAmount: 20, discountDollars: 16, maxDiscountDollars: null } },
      ]);
      expect(seededChild.price).toBe(56);

      const markedParent = {
        primary_line_price: null,
        pricing_provenance: { pricing_regime: 'discount_stack_v1' },
        line_discount_type: null,
        discount_type: 'fixed_amount',
        discount_amount: 30,
      };
      const recurringAddon = { base_price: 100, estimated_price: 84, discount_type: 'percentage', discount_amount: 20, discount_dollars: 16, discount_id: 'recurring-disc-13', service_id: 'recurring-addon' };
      const caps = new Map([['recurring-disc-13', null]]);
      const extension = restackStoredVisitFinancials(markedParent, [recurringAddon], null, caps);

      expect(extension).not.toBeNull();
      expect(extension.price).toBe(56); // never the frozen $54
      expect(extension.price).toBe(seededChild.price);
    });
  });

  test('a legacy null-primary row WITHOUT the marker still defers (no false restack)', () => {
    const legacyRow = { primary_line_price: null, estimated_price: 100, discount_type: null }; // no pricing_provenance at all — never priced by this slice
    expect(hasPricingRegimeMarker(legacyRow)).toBe(false);
    expect(restackStoredVisitFinancials(legacyRow, [], null, new Map())).toBeNull();
  });

  // resolveSeriesExtensionPriceTemplate's anchored-split clear strips the
  // marker back off its own template — a series whose PARENT priced under
  // this slice (and so carries the marker) must not let a LATER
  // anchored-split extension mistake the marker-total template's cleared
  // primary for "genuinely no primary."
  test('resolveSeriesExtensionPriceTemplate strips the marker from the anchored-split template', async () => {
    const parent = {
      id: 'p1',
      estimated_price: '150.00',
      primary_line_price: '150.00',
      line_discount_dollars: 0,
      pricing_provenance: { pricing_regime: 'discount_stack_v1' },
      recurring_template_overrides: { anchored_split_per_visit: 100 },
    };
    const template = await resolveSeriesExtensionPriceTemplate(null, 'p1', parent);
    expect(template.primary_line_price).toBeNull();
    expect(hasPricingRegimeMarker(template)).toBe(false);
    // The still-marked template restacks against gross:0 correctly — WITHOUT
    // the strip it would (wrongly) restack instead of deferring to the
    // marker's own $100 total.
    expect(restackStoredVisitFinancials(template, [], null, new Map())).toBeNull();
  });

  // Gate-off parity: no marker written anywhere, rows byte-identical to
  // main. Direct unit check (the full existing regression suite — run
  // separately — is the end-to-end version of this same guarantee).
  test('gate off: stampPricingRegimeMarker is never reached by any caller (verified via the byte-identical full suite); direct call still behaves, unconditionally, as documented', () => {
    // stampPricingRegimeMarker itself has no gate check — every call site
    // guards it with discountStackingLive() — so this pins its OWN
    // contract (always stamps when called) while the full admin-schedule/
    // recurring-series regression suite (run alongside this file) is what
    // actually proves no call site reaches it with the gate off.
    const target = {};
    stampPricingRegimeMarker(target, { pricing_provenance: true });
    expect(target.pricing_provenance).toEqual({ pricing_regime: 'discount_stack_v1', engine_version: 1, caps: { line: null, addons: {} } });
  });
});

// Round 13 P1 (found alongside the P0 above, on the SAME push): once a
// marked row's missing primary can reach gross:0, a booking with NO known
// price anywhere (no primary, no priced add-ons) restacked to price: 0 —
// changing a quote-pending appointment into an explicitly FREE one once an
// extension writer persisted it. The waves-billing null-price invariant
// (already honored per-add-on by the blank-priced-add-on fix) now also
// covers the WHOLE occurrence: no known price anywhere stays null.
describe('pricing-regime marker — unpriced (quote-pending) occurrences stay null, never $0 (round 13 P1)', () => {
  afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

  test('restackStoredVisitFinancials: a marked, wholly-unpriced row returns price: null, not 0', () => {
    const markedUnpriced = {
      primary_line_price: null,
      pricing_provenance: { pricing_regime: 'discount_stack_v1' },
      line_discount_type: null,
      discount_type: null,
    };
    const result = restackStoredVisitFinancials(markedUnpriced, [], null, new Map());
    expect(result).not.toBeNull();
    expect(result.price).toBeNull();
  });

  test('restackStoredVisitFinancials: a marked row with even ONE priced add-on restacks normally (not treated as unpriced)', () => {
    const markedParent = {
      primary_line_price: null,
      pricing_provenance: { pricing_regime: 'discount_stack_v1' },
      line_discount_type: null,
      discount_type: null,
    };
    const pricedAddon = { base_price: 50, estimated_price: 50, discount_type: null, service_id: 'addon-svc' };
    const result = restackStoredVisitFinancials(markedParent, [pricedAddon], null, new Map());
    expect(result.price).toBe(50);
  });

  test('restackStoredVisitFinancials: a marked, EXPLICITLY $0 primary is still a real, known zero (not treated as unpriced)', () => {
    const markedZeroPrimary = {
      primary_line_price: 0,
      pricing_provenance: { pricing_regime: 'discount_stack_v1' },
      line_discount_type: null,
      discount_type: null,
    };
    const result = restackStoredVisitFinancials(markedZeroPrimary, [], null, new Map());
    expect(result.price).toBe(0); // a real, known zero — never null
  });

  test('restackLiveVisitFinancials: a wholly-unpriced booking (only an appointment discount selected) returns price: null, not 0', async () => {
    await withGateLive(() => {
      const unpriced = {
        primaryBase: null,
        primaryServiceKey: 'general_pest',
        primaryServiceCategory: 'pest_control',
        primaryDiscount: null,
        appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30, discountDollars: 30, maxDiscountDollars: null, serviceKeyFilter: null, serviceCategoryFilter: null },
      };
      const result = restackLiveVisitFinancials(unpriced, []);
      expect(result).not.toBeNull();
      expect(result.price).toBeNull();
    });
  });
});

// GitHub Codex round 1 on #4642 (PRRT_kwDOR3YQi86kllyD): a percentage
// discount's cap is never persisted on the row itself — only read live,
// via loadDiscountCapsById, from the catalog's mutable max_discount_dollars
// — so a marked row now ALSO freezes the cap it priced against, in the
// SAME pricing_provenance column, and restacks every later extension from
// that frozen snapshot rather than a fresh (and possibly since-edited)
// catalog lookup. A later PUT /api/admin/discounts/:id cap change must
// never reprice an already-contracted recurring visit.
describe('frozen caps snapshot — a later catalog cap edit does not reprice a contracted recurring visit (round 14)', () => {
  afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

  test('resolveStoredDiscountCaps: a marked row restacks from its OWN frozen line cap, never the live (edited) catalog cap', () => {
    const markedParent = {
      line_discount_id: 'ld-1',
      pricing_provenance: { pricing_regime: 'discount_stack_v1', engine_version: 1, caps: { line: 10, addons: {} } },
    };
    // The catalog has since been edited to $20 — loadDiscountCapsById would
    // return this if it were consulted.
    const liveCatalogCaps = new Map([['ld-1', 20]]);
    const resolved = resolveStoredDiscountCaps(markedParent, liveCatalogCaps);
    expect(resolved.lineCap).toBe(10); // the FROZEN $10, never the live $20
    expect(resolved.snapshot.line).toBe(10);
  });

  // The coordinator's exact pinned combination: a 50%-off line discount
  // capped at $10 when the row was priced; the catalog cap is later raised
  // to $20; the extension must still restack to $10 off, not $20.
  test('restackStoredVisitFinancials: $10 cap frozen at creation, catalog raised to $20 — extension still restacks $10 off, not $20', () => {
    const markedParent = {
      primary_line_price: 100,
      line_discount_id: 'ld-1',
      line_discount_type: 'percentage',
      line_discount_amount: 50, // uncapped, 50% of $100 would be $50 off
      discount_type: null,
      pricing_provenance: { pricing_regime: 'discount_stack_v1', engine_version: 1, caps: { line: 10, addons: {} } },
    };
    const catalogCapRaisedTo20 = new Map([['ld-1', 20]]);
    const result = restackStoredVisitFinancials(markedParent, [], null, catalogCapRaisedTo20);
    expect(result.primaryLineDiscountDollars).toBe(10); // the frozen cap, never the raised $20 (or the uncapped $50)
    expect(result.price).toBe(90);
    // The persisted snapshot must also stay $10 — the NEXT extension must
    // inherit the same frozen value, not silently re-freeze the raised one.
    expect(result.capsSnapshot.line).toBe(10);
  });

  test('an UNMARKED (legacy) row has nothing to freeze from — every cap reads LIVE, exactly as before this fix', () => {
    const legacyParent = {
      primary_line_price: 100,
      line_discount_id: 'ld-1',
      line_discount_type: 'percentage',
      line_discount_amount: 50,
      discount_type: null,
      // no pricing_provenance at all
    };
    const catalogCap = new Map([['ld-1', 20]]);
    const result = restackStoredVisitFinancials(legacyParent, [], null, catalogCap);
    expect(result.primaryLineDiscountDollars).toBe(20); // the LIVE cap — nothing frozen yet
    // Once restacked, this row's OWN first stamp would freeze $20 going
    // forward — proven by the creation-to-extension regression below.
    expect(result.capsSnapshot.line).toBe(20);
  });

  // A discount id the row has NEVER frozen before (a new add-on discount
  // this occurrence is seeing for the first time) reads live and joins the
  // snapshot — it does not fail, and it does not inherit an unrelated
  // frozen value.
  test('a marked row with a frozen LINE cap but an add-on discount id it has never seen reads that add-on cap LIVE', () => {
    const markedParent = {
      primary_line_price: 100,
      line_discount_id: 'ld-1',
      line_discount_type: null,
      discount_type: null,
      pricing_provenance: { pricing_regime: 'discount_stack_v1', engine_version: 1, caps: { line: 10, addons: {} } }, // no 'new-addon-disc' entry yet
    };
    const addon = { base_price: 50, estimated_price: 50, discount_type: 'percentage', discount_amount: 40, discount_id: 'new-addon-disc', service_id: 'svc' };
    const liveCaps = new Map([['new-addon-disc', 5]]);
    const result = restackStoredVisitFinancials(markedParent, [addon], null, liveCaps);
    // 40% of $50 would be $20 uncapped; the live $5 cap (never frozen
    // before) applies and joins the returned snapshot.
    expect(result.addonDollars[0].discountDollars).toBe(5);
    expect(result.capsSnapshot.addons['new-addon-disc']).toBe(5);
    expect(result.capsSnapshot.line).toBe(10); // the already-frozen line cap is untouched
  });

  // Creation-to-extension: the FIRST time a row is marked (creation), its
  // caps snapshot is built from capsSnapshotFromPricing (the live catalog
  // caps buildAppointmentPricing already resolved) — the SAME values a
  // bare restackStoredVisitFinancials call would read live for an
  // as-yet-unmarked row, proving the two paths agree at the handoff point.
  test('capsSnapshotFromPricing (creation) agrees with the live lookup restackStoredVisitFinancials would make for the same row before it is marked', () => {
    const pricing = {
      primaryDiscount: { discountId: 'ld-1', maxDiscountDollars: 10 },
      addonLines: [{ discount: { discountId: 'addon-1', maxDiscountDollars: 25 } }],
    };
    const createdSnapshot = capsSnapshotFromPricing(pricing);
    expect(createdSnapshot).toEqual({ line: 10, addons: { 'addon-1': 25 } });

    const unmarkedLegacyRow = { line_discount_id: 'ld-1' }; // no pricing_provenance — same row, before its first stamp
    const liveCapsAtCreation = new Map([['ld-1', 10], ['addon-1', 25]]);
    const resolved = resolveStoredDiscountCaps(unmarkedLegacyRow, liveCapsAtCreation);
    // Agreement on every key capsSnapshotFromPricing itself reports (the
    // line cap, and each genuine add-on's own cap) — not exact object
    // equality: resolveStoredDiscountCaps' addons also carries the line's
    // OWN id (round 2 P1 fix, below) whenever liveDiscountCaps included
    // it, which capsSnapshotFromPricing never does (it only ever iterates
    // pricing.addonLines) — a harmless, unread extra key, not a
    // disagreement.
    expect(resolved.snapshot.line).toBe(createdSnapshot.line);
    for (const [id, cap] of Object.entries(createdSnapshot.addons)) {
      expect(resolved.snapshot.addons[id]).toBe(cap);
    }
  });

  // Codex pre-push audit P1 (GitHub round 2, PRRT_kwDOR3YQi86kl-X3): the
  // SAME catalog discount reused on both the primary line and an add-on
  // (a real, supported shape) — liveDiscountCaps has only ONE entry for
  // that shared id, since loadDiscountCapsById dedupes by id. An earlier
  // version of resolveStoredDiscountCaps skipped populating `addons` for
  // any id matching line_discount_id, so the add-on's OWN cap silently
  // read as uncapped and froze that wrong value into the first gate-on
  // extension's snapshot.
  test('a discount id shared between the primary line AND an add-on keeps its cap on BOTH slots independently', () => {
    const sharedId = 'shared-disc-1';
    const parent = {
      primary_line_price: 100,
      line_discount_id: sharedId,
      line_discount_type: 'percentage',
      line_discount_amount: 50, // uncapped, 50% of $100 would be $50 off
      discount_type: null,
      // unmarked — the first gate-on extension of a legacy row
    };
    const addon = {
      base_price: 100, estimated_price: 100, discount_type: 'percentage', discount_amount: 50,
      discount_id: sharedId, service_id: 'addon-svc',
    }; // uncapped, 50% of $100 would ALSO be $50 off
    const liveCaps = new Map([[sharedId, 10]]); // ONE entry — dedup by id, exactly as loadDiscountCapsById returns it
    const resolved = resolveStoredDiscountCaps(parent, liveCaps);
    expect(resolved.lineCap).toBe(10);
    expect(resolved.addonCap(sharedId)).toBe(10); // never null/uncapped

    const result = restackStoredVisitFinancials(parent, [addon], null, liveCaps);
    expect(result.primaryLineDiscountDollars).toBe(10);
    expect(result.addonDollars[0].discountDollars).toBe(10);
    // The persisted snapshot must freeze BOTH slots at $10 — a LATER
    // extension reading this frozen snapshot must not silently uncap the
    // add-on even though it shares the primary's own discount id.
    expect(result.capsSnapshot).toEqual({ line: 10, addons: { [sharedId]: 10 } });
  });

  // Gate-off parity: with the gate off, no caller ever builds or passes a
  // caps snapshot — stampPricingRegimeMarker is never reached at all (the
  // full byte-identical regression suite is the end-to-end proof), so
  // there is nothing additional to pin here beyond stampPricingRegimeMarker's
  // own documented default (an empty snapshot when none is given).
  test('gate off parity: stampPricingRegimeMarker with no caps argument writes an empty, not undefined, snapshot', () => {
    const target = {};
    stampPricingRegimeMarker(target, { pricing_provenance: true });
    expect(target.pricing_provenance.caps).toEqual({ line: null, addons: {} });
  });
});

// GitHub Codex round 2 on #4642 (PRRT_kwDOR3YQi86kl-X6): every extension
// call site stamped the caps snapshot onto its own INSERT payload (the new
// child row) but never updated the ROOT parent row every extension reads
// its pricing FROM — so a legacy (unmarked) series' SECOND extension still
// read the unmarked root and re-resolved live catalog caps all over
// again, defeating the freeze the FIRST extension's own child row got.
describe('freezeLegacySeriesRootCaps — the root parent itself gets marked on the first gate-on extension (round 2 P1)', () => {
  afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

  // A minimal fake conn: 'discounts' serves loadDiscountCapsById's read;
  // 'scheduled_services' records every UPDATE so the test can assert
  // exactly what got written to the root row, without a real database.
  function makeRootFreezeConn(discountRows) {
    const updates = [];
    const conn = (table) => {
      let whereInIds = null;
      let whereId = null;
      const chain = {
        where: (arg) => { if (arg && arg.id) whereId = arg.id; return chain; },
        whereIn: (_col, ids) => { whereInIds = ids; return chain; },
        select: () => chain,
        update: (data) => {
          updates.push({ table, id: whereId, data });
          return Promise.resolve(1);
        },
        then: (resolve, reject) => {
          if (table === 'discounts') {
            return Promise.resolve(discountRows.filter((r) => whereInIds.includes(r.id))).then(resolve, reject);
          }
          return Promise.resolve([]).then(resolve, reject);
        },
      };
      return chain;
    };
    return { conn, updates };
  }

  test('gate off: no-op — no discounts read, no update issued', async () => {
    const { conn, updates } = makeRootFreezeConn([{ id: 'ld-1', max_discount_dollars: 10 }]);
    const parent = { id: 'root-1', line_discount_id: 'ld-1' };
    await freezeLegacySeriesRootCaps(conn, parent, { pricing_provenance: true }, []);
    expect(updates).toHaveLength(0);
  });

  test('an ALREADY-marked root is left alone — no redundant re-freeze, no catalog re-read', async () => {
    await withGateLive(async () => {
      const { conn, updates } = makeRootFreezeConn([{ id: 'ld-1', max_discount_dollars: 999 }]);
      const parent = {
        id: 'root-2', line_discount_id: 'ld-1',
        pricing_provenance: { pricing_regime: 'discount_stack_v1', engine_version: 1, caps: { line: 10, addons: {} } },
      };
      await freezeLegacySeriesRootCaps(conn, parent, { pricing_provenance: true }, []);
      expect(updates).toHaveLength(0);
      expect(parent.pricing_provenance.caps.line).toBe(10); // unchanged
    });
  });

  // The coordinator's exact pinned combination: a legacy (unmarked) series
  // freezes its root on the first gate-on extension; the catalog cap is
  // raised afterward; a SECOND extension's fresh read of that now-marked
  // root must still use the frozen $10, never the raised value.
  test('legacy series: the first gate-on extension freezes the ROOT row; a later catalog raise does not reach a second extension', async () => {
    await withGateLive(async () => {
      const { conn, updates } = makeRootFreezeConn([{ id: 'ld-1', max_discount_dollars: 10 }]);
      const parent = { id: 'root-3', primary_line_price: 100, line_discount_id: 'ld-1', line_discount_type: 'percentage', line_discount_amount: 50 };
      await freezeLegacySeriesRootCaps(conn, parent, { pricing_provenance: true }, []);

      // The root row's own UPDATE, exactly as a real DB write would see it.
      expect(updates).toHaveLength(1);
      expect(updates[0].table).toBe('scheduled_services');
      expect(updates[0].id).toBe('root-3');
      expect(updates[0].data.pricing_provenance.caps.line).toBe(10);
      // addons also carries ld-1 (round 2 P1: no longer deduped against the
      // line's own id) — harmless here since nothing due reads it, and
      // correct when the SAME id is later reused on an add-on.

      // The in-memory `parent` object is updated too (same-call multi-date
      // loops must not redundantly re-freeze on their next iteration).
      expect(hasPricingRegimeMarker(parent)).toBe(true);

      // "Extension 2": a FRESH re-fetch of this now-marked root (as a real
      // second, separate extension call would do), against a catalog
      // raised to $20 since extension 1 ran.
      const freshRootRead = { ...parent }; // simulates SELECT * FROM scheduled_services WHERE id = root-3
      const catalogRaisedTo20 = new Map([['ld-1', 20]]);
      const result = restackStoredVisitFinancials(freshRootRead, [], null, catalogRaisedTo20);
      expect(result.primaryLineDiscountDollars).toBe(10); // frozen at extension 1, never the raised $20
      expect(result.price).toBe(90);
    });
  });

  test('a root whose primary line has NO discount at all still gets marked (an empty, correct snapshot) — future add-ons still freeze correctly from it', async () => {
    await withGateLive(async () => {
      const { conn, updates } = makeRootFreezeConn([]);
      const parent = { id: 'root-4', primary_line_price: 100, line_discount_id: null };
      await freezeLegacySeriesRootCaps(conn, parent, { pricing_provenance: true }, []);
      expect(updates).toHaveLength(1);
      expect(updates[0].data.pricing_provenance.caps).toEqual({ line: null, addons: {} });
    });
  });
});
