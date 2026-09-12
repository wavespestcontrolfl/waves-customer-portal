/**
 * Stamp-versus-total consistency — the pre-push audit's three P0s on PR
 * #4405 (round 1 escalated): whatever a visit saves as its TOTAL, its
 * stored PER-LINE stamps must replay to that same number. All three are in
 * server/routes/admin-schedule.js (one shares server/services/discount-stack.js
 * math, unmodified — these tests only exercise the ADMIN-SCHEDULE side of
 * each).
 *
 * P0 (1) — update-details: an untouched primary-line discount's RECOMPUTED
 * dollars were only ever persisted when the slot was POSTED. A $100 line
 * with an unchanged 10% discount, restacked against a newly-added $30
 * appointment credit, saved estimated_price=$63 but kept the stale
 * line_discount_dollars=$10 — the invoice replays $60. Fix: always persist
 * the recalculated dollars for an untouched slot; only its identity
 * (id/type/amount) stays frozen. See reconstructPrimaryLineSlot's own
 * describe block in admin-schedule-restacking-p1-fixes.test.js for the
 * companion P0 (2) (carrying the discount's cap through reconstruction) —
 * both bugs live in the same helper/call site, so this file's P0 (1) cases
 * also exercise the cap fix incidentally.
 *
 * P0 (3) — POST create, recurring children + boosters: childFinancials
 * correctly recomputes discounts for the CHILD's own add-on mix, but the
 * add-on line objects handed to addonOnlyTotal and inserted via
 * insertScheduledServiceAddons kept the PARENT's price/discount-dollars/
 * appointment-share — filterAddonLinesForDate only filters, it doesn't
 * restate. A child dropping one add-on totalled $108 but its stored stamps
 * replayed $107.75. Fix: restateOccurrenceAddonLines clones each line and
 * applies the occurrence's OWN financials before it is totaled or
 * inserted — for children AND boosters.
 *
 * Gate-off byte-identical is covered by discount-stacking-gate.test.js
 * (unmodified) and by admin-schedule-restacking-p1-fixes.test.js's own
 * "stacking OFF" cases for reconstructPrimaryLineSlot.
 */
process.env.GATE_DISCOUNT_STACKING = 'true';

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

const fs = require('fs');
const path = require('path');
const {
  reconstructPrimaryLineSlot,
  calculateVisitFinancialsForAddons,
  addonOnlyTotal,
  restateOccurrenceAddonLines,
} = require('../routes/admin-schedule')._test;

const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

function fakeConn(row) {
  return () => ({ where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(row) });
}

// The exact computation update-details' write block performs to decide
// what to persist for the primary line's stamp (mirrors the route: see
// "wiring" tests below for the source-pattern guard that this mirror
// hasn't drifted from the real call site).
function slotDollarsToPersist(primaryLineSlot, financials) {
  const restatedPrimary = financials.lines[0];
  return primaryLineSlot && restatedPrimary && restatedPrimary.lineDiscountDollars > 0
    ? restatedPrimary.lineDiscountDollars
    : null;
}

beforeEach(() => jest.clearAllMocks());

describe('P0 (1): the stored primary stamp always matches the saved total, even when the slot is untouched', () => {
  test('exact reported figures: $100 line, unchanged 10% discount, +$30 appointment credit → total $63, stamp $7 (not the stale $10)', async () => {
    const existing = { line_discount_id: 'promo-1', line_discount_type: 'percentage', line_discount_amount: 10, line_discount_dollars: 10 };
    const primaryLineSlot = await reconstructPrimaryLineSlot({
      stacking: true,
      existing,
      conn: fakeConn({ discount_type: 'percentage', amount: 10, max_discount_dollars: null }),
    });
    const financials = calculateVisitFinancialsForAddons({
      primaryNet: 90,
      primaryGross: 100,
      primaryLineDiscount: primaryLineSlot,
      primaryServiceKey: 'pest_general_quarterly',
      primaryServiceCategory: 'pest_control',
      appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30 },
    }, []);
    expect(financials.price).toBe(63);

    const slotDollars = slotDollarsToPersist(primaryLineSlot, financials);
    // This is the P0: the fix must persist $7, not the pre-fix stale $10
    // that update-details used to leave alone on an untouched slot.
    expect(slotDollars).toBe(7);
    expect(slotDollars).not.toBe(existing.line_discount_dollars);

    // Replay: gross − stamp = the line's stored net (line-only, $93 — the
    // appointment credit is a SEPARATE scalar, never folded into `net`);
    // net − that scalar (one line here, so it carries the whole $30 share)
    // = the visit total the save actually recorded.
    const restatedPrimary = financials.lines[0];
    expect(Math.round((100 - slotDollars) * 100) / 100).toBe(restatedPrimary.net);
    expect(restatedPrimary.net).toBe(93);
    expect(Math.round((restatedPrimary.net - financials.appointmentDiscountDollars) * 100) / 100).toBe(63);
    expect(financials.price).toBe(63);
  });

  test('a SECOND save with nothing new changed persists the SAME recalculated dollars again (idempotent, no drift)', async () => {
    // Simulates the row already having been corrected by a prior save
    // (line_discount_dollars now 7) and a follow-up save that touches
    // something unrelated — the untouched slot must keep restating to 7,
    // not silently freeze at whatever is currently stored.
    const primaryLineSlot = await reconstructPrimaryLineSlot({
      stacking: true,
      existing: { line_discount_id: 'promo-1', line_discount_type: 'percentage', line_discount_amount: 10, line_discount_dollars: 7 },
      conn: fakeConn({ discount_type: 'percentage', amount: 10, max_discount_dollars: null }),
    });
    const financials = calculateVisitFinancialsForAddons({
      primaryNet: 90, primaryGross: 100, primaryLineDiscount: primaryLineSlot,
      primaryServiceKey: 'k', primaryServiceCategory: 'c',
      appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30 },
    }, []);
    expect(slotDollarsToPersist(primaryLineSlot, financials)).toBe(7);
  });

  test('removing the OTHER discount also restates the primary stamp back to its own-only figure', async () => {
    // No appointment discount this save — the untouched 10% primary must
    // restate to its plain $10, not keep whatever a PRIOR compounded save
    // left behind (e.g. a stale $7 from when the $30 credit existed).
    const primaryLineSlot = await reconstructPrimaryLineSlot({
      stacking: true,
      existing: { line_discount_id: 'promo-1', line_discount_type: 'percentage', line_discount_amount: 10, line_discount_dollars: 7 },
      conn: fakeConn({ discount_type: 'percentage', amount: 10, max_discount_dollars: null }),
    });
    const financials = calculateVisitFinancialsForAddons({
      primaryNet: 90, primaryGross: 100, primaryLineDiscount: primaryLineSlot,
      primaryServiceKey: 'k', primaryServiceCategory: 'c',
      appointmentDiscount: null,
    }, []);
    expect(slotDollarsToPersist(primaryLineSlot, financials)).toBe(10);
    expect(financials.price).toBe(90);
  });

  test('wiring: the untouched-slot branch persists line_discount_dollars unconditionally, never gated by primaryLineDiscountProvided', () => {
    // Anchor INSIDE the update-details route: `if (cols.estimated_price) {`
    // also appears in propagatePriceServiceToFollowingSiblings earlier in the
    // file, so every offset is searched FORWARD from this route's own marker.
    const editPathAt = src.indexOf('await presetEligibilityCheck([');
    expect(editPathAt).toBeGreaterThan(-1);
    const endMarker = src.indexOf('if (cols.estimated_price) {', editPathAt);
    expect(endMarker).toBeGreaterThan(editPathAt);
    const block = src.slice(editPathAt, endMarker);
    // Structural: an `else if` (or equivalent standalone) branch that
    // writes line_discount_dollars OUTSIDE the `if (primaryLineDiscountProvided)`
    // gate, using the restated slotDollars.
    expect(block).toMatch(/\}\s*else if\s*\(cols\.line_discount_dollars\)\s*\{\s*[\s\S]*?updates\.line_discount_dollars\s*=\s*slotDollars;/);
    // Identity columns must NOT appear in that untouched branch — the
    // finding is explicit that identity stays frozen, only dollars move.
    const untouchedBranch = block.slice(block.indexOf('} else if (cols.line_discount_dollars)'));
    expect(untouchedBranch).not.toMatch(/updates\.line_discount_id/);
    expect(untouchedBranch).not.toMatch(/updates\.line_discount_type/);
    expect(untouchedBranch).not.toMatch(/updates\.line_discount_amount/);
  });

  // The gate-flip preservation branch (r4 P0) is the ONE case that writes a
  // stamp other than the restated slotDollars: it keeps the STORED stamp. That
  // is only sound because the stored TOTAL is preserved in the same breath —
  // the stamp and the total must always replay to the same number, so they
  // have to be governed by the same condition. This pins that pairing.
  test('wiring: gate-flip preservation keeps the stored stamp and the stored total under ONE condition', () => {
    const editPathAt = src.indexOf('await presetEligibilityCheck([');
    const stampBranch = src.slice(
      src.indexOf('} else if (legacyEconomicsPreserved) {', editPathAt),
      src.indexOf('} else if (cols.line_discount_dollars)', editPathAt),
    );
    expect(stampBranch).toMatch(/updates\.line_discount_dollars\s*=\s*existing\?\.line_discount_dollars/);

    const priceAt = src.indexOf('if (cols.estimated_price) {', editPathAt);
    const priceBranch = src.slice(priceAt, src.indexOf('if (cols.primary_line_price', priceAt));
    expect(priceBranch).toMatch(/legacyEconomicsPreserved\s*\?\s*storedTotal/);

    // The appointment-discount stamp is preserved by the same condition too.
    const apptAt = src.indexOf('if (cols.discount_dollars) {', editPathAt);
    const apptBranch = src.slice(
      apptAt,
      src.indexOf('// An untouched primary line slot keeps its line_discount_* columns', apptAt),
    );
    expect(apptBranch).toMatch(/legacyEconomicsPreserved\s*\?/);
    expect(apptBranch).toMatch(/existing\?\.discount_dollars/);
  });
});

describe('P0 (3): a recurring child/booster stamps ITS OWN recomputed add-on prices, not the parent\'s', () => {
  // The parent's ORIGINAL 3-line pricing (as buildAppointmentPricing would
  // have stashed it on pricing.addonLines): primary $100 + two $50 add-ons,
  // each with its own 10% line discount, plus a $30 FIXED appointment
  // credit spread pro rata over all three ($15 / $7.50 / $7.50), then 10%
  // line discounts compounding on what's left. addon1/addon2 net $45.75
  // each — the STALE parent-level stamps a buggy child would carry over.
  const PARENT_ADDON_LINE = (serviceKey) => ({
    serviceId: `svc-${serviceKey}`,
    serviceName: serviceKey,
    serviceKey,
    serviceCategory: 'cat',
    base: 50,
    price: 45.75, // parent-level net — STALE for a 2-line child
    discount: { discountType: 'percentage', discountAmount: 10, discountDollars: 4.25 },
    appointmentDiscountDollars: 7.5, // parent-level share — STALE for a 2-line child
  });

  test('exact reported figures: a child dropping one add-on totals $108 and its stamps replay to $108, not $107.75', () => {
    // The child's actual mix: primary + addon1 only (addon2 not due this
    // date) — filterAddonLinesForDate hands back addon1's object AS
    // STORED ON THE PARENT (base 50, but the stale parent-level
    // price/discount/appointmentShare above).
    const rawChildAddonLines = [PARENT_ADDON_LINE('addon1')];

    const childFinancials = calculateVisitFinancialsForAddons({
      primaryNet: 92, // caller convention: ignored when primaryLineDiscount is set
      primaryGross: 100,
      primaryLineDiscount: { discountType: 'percentage', discountAmount: 10 },
      primaryServiceKey: 'primary', primaryServiceCategory: 'cat',
      appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30 },
    }, rawChildAddonLines);
    // The CHILD's own 2-line pool ($100 + $50 = $150): $20 credit off the
    // primary, $10 off addon1; then 10% of what's left on each.
    expect(childFinancials.price).toBe(108);
    expect(childFinancials.lines[0].net).toBe(92); // primary: 100 - 8
    expect(childFinancials.lines[1].net).toBe(46); // addon1: 50 - 4 (NOT 45.75)

    const restatedChildAddonLines = restateOccurrenceAddonLines(rawChildAddonLines, childFinancials);
    expect(restatedChildAddonLines[0].price).toBe(46);
    expect(restatedChildAddonLines[0].discount.discountDollars).toBe(4);
    expect(restatedChildAddonLines[0].appointmentDiscountDollars).toBe(10);

    // Replay, restated (the fix): primary stamp + addon stamp − the
    // appointment-level scalar (stored separately on the service row).
    const replayedFixed = childFinancials.lines[0].net
      + restatedChildAddonLines.reduce((sum, l) => sum + l.price, 0)
      - childFinancials.appointmentDiscountDollars;
    expect(Math.round(replayedFixed * 100) / 100).toBe(108);
    expect(replayedFixed).toBe(childFinancials.price);

    // Sanity — the reported bug: replaying the STALE (unrestated, raw)
    // add-on lines instead gives exactly the reported $107.75.
    const replayedBuggy = childFinancials.lines[0].net
      + rawChildAddonLines.reduce((sum, l) => sum + l.price, 0)
      - childFinancials.appointmentDiscountDollars;
    expect(Math.round(replayedBuggy * 100) / 100).toBe(107.75);
  });

  test('the member-covered add-on-only stamp (addonOnlyTotal) also reads the RESTATED lines, not the stale parent ones', () => {
    const rawChildAddonLines = [PARENT_ADDON_LINE('addon1')];
    const childFinancials = calculateVisitFinancialsForAddons({
      primaryNet: 92, primaryGross: 100,
      primaryLineDiscount: { discountType: 'percentage', discountAmount: 10 },
      primaryServiceKey: 'primary', primaryServiceCategory: 'cat',
      appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30 },
    }, rawChildAddonLines);
    const restated = restateOccurrenceAddonLines(rawChildAddonLines, childFinancials);
    // addon1 restated: price 46, appointmentDiscountDollars 10 → billable 36.
    expect(addonOnlyTotal(restated)).toBe(36);
    // The stale (buggy) total would have been 45.75 - 7.5 = 38.25.
    expect(addonOnlyTotal(rawChildAddonLines)).toBe(38.25);
  });

  test('restateOccurrenceAddonLines clones — the ORIGINAL (parent) line objects are never mutated, so a sibling child/booster with a different mix is unaffected', () => {
    const rawChildAddonLines = [PARENT_ADDON_LINE('addon1')];
    const original = rawChildAddonLines[0];
    const originalDiscount = original.discount;
    const childFinancials = calculateVisitFinancialsForAddons({
      primaryNet: 92, primaryGross: 100,
      primaryLineDiscount: { discountType: 'percentage', discountAmount: 10 },
      primaryServiceKey: 'primary', primaryServiceCategory: 'cat',
      appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30 },
    }, rawChildAddonLines);
    const restated = restateOccurrenceAddonLines(rawChildAddonLines, childFinancials);

    expect(restated[0]).not.toBe(original); // a new object
    expect(restated[0].discount).not.toBe(originalDiscount); // a new discount object too
    expect(original.price).toBe(45.75); // untouched
    expect(original.discount.discountDollars).toBe(4.25); // untouched
    expect(original.appointmentDiscountDollars).toBe(7.5); // untouched
  });

  test('a line with no discount at all restates price/appointmentDiscountDollars without inventing a discount object', () => {
    const rawLines = [{ base: 50, price: 50, discount: null, serviceKey: 'plain', serviceCategory: 'cat' }];
    const financials = calculateVisitFinancialsForAddons({
      primaryNet: 100, primaryGross: 100, primaryLineDiscount: null,
      primaryServiceKey: 'primary', primaryServiceCategory: 'cat',
      appointmentDiscount: { discountType: 'fixed_amount', discountAmount: 30 },
    }, rawLines);
    const restated = restateOccurrenceAddonLines(rawLines, financials);
    expect(restated[0].discount).toBeNull();
    expect(restated[0].price).toBe(financials.lines[1].net);
    expect(restated[0].appointmentDiscountDollars).toBe(financials.lines[1].appointmentDiscountDollars);
  });

  test('wiring: the children loop restates before totaling AND before insertScheduledServiceAddons; the booster loop does the same', () => {
    const childBlock = src.slice(
      src.indexOf('for (const nextDateStr of plannedChildDates) {'),
      src.indexOf('createdAppointments.push({ id: childRow.id')
    );
    expect(childBlock).toMatch(/const childAddonLines\s*=\s*restateOccurrenceAddonLines\(\s*rawChildAddonLines,\s*childFinancials\s*\)/);
    // Both the member-covered total and the insert must use the RESTATED
    // name, not the raw pre-restate one.
    expect(childBlock).toMatch(/addonOnlyTotal\(childAddonLines\)/);
    expect(childBlock).toMatch(/insertScheduledServiceAddons\(trx,\s*childRow\.id,\s*childAddonLines,\s*addonCols\)/);
    expect(childBlock).not.toMatch(/insertScheduledServiceAddons\(trx,\s*childRow\.id,\s*rawChildAddonLines/);

    const boosterBlock = src.slice(
      src.indexOf('const boosterData = {'),
      src.indexOf('createdAppointments.push({ id: boosterRow.id')
    );
    expect(boosterBlock).toMatch(/const boosterAddonLines\s*=\s*restateOccurrenceAddonLines\(\s*rawBoosterAddonLines,\s*boosterFinancials\s*\)/);
    expect(boosterBlock).toMatch(/insertScheduledServiceAddons\(trx,\s*boosterRow\.id,\s*boosterAddonLines,\s*addonCols\)/);
    expect(boosterBlock).not.toMatch(/insertScheduledServiceAddons\(trx,\s*boosterRow\.id,\s*rawBoosterAddonLines/);
  });
});

describe('the general invariant: stored stamps always replay to the saved total', () => {
  test('single-line, percentage-capped primary discount, no add-ons', async () => {
    const primaryLineSlot = await reconstructPrimaryLineSlot({
      stacking: true,
      existing: { line_discount_id: 'promo-cap', line_discount_type: 'percentage', line_discount_amount: 50, line_discount_dollars: 20 },
      conn: fakeConn({ discount_type: 'percentage', amount: 50, max_discount_dollars: 20 }),
    });
    const financials = calculateVisitFinancialsForAddons({
      primaryNet: 80, primaryGross: 100, primaryLineDiscount: primaryLineSlot,
      primaryServiceKey: 'k', primaryServiceCategory: 'c', appointmentDiscount: null,
    }, []);
    const slotDollars = slotDollarsToPersist(primaryLineSlot, financials);
    expect(Math.round((100 - slotDollars) * 100) / 100).toBe(financials.price);
  });

  test('multi-line child: restated line stamps plus the appointment scalar sum to the child total, across several ugly-cents mixes', () => {
    const scenarios = [
      { addons: [{ base: 33, discount: null }], appt: { discountType: 'percentage', amount: 13 } },
      { addons: [{ base: 17, discount: { discountType: 'percentage', discountAmount: 5 } }, { base: 23, discount: null }], appt: { discountType: 'fixed_amount', amount: 11 } },
    ];
    for (const { addons, appt } of scenarios) {
      const rawLines = addons.map((a, i) => ({
        base: a.base, price: 0, discount: a.discount, serviceKey: `a${i}`, serviceCategory: 'cat',
      }));
      const financials = calculateVisitFinancialsForAddons({
        primaryNet: 90, primaryGross: 90, primaryLineDiscount: null,
        primaryServiceKey: 'primary', primaryServiceCategory: 'cat',
        appointmentDiscount: { discountType: appt.discountType, discountAmount: appt.amount },
      }, rawLines);
      const restated = restateOccurrenceAddonLines(rawLines, financials);
      const replay = Math.round((
        financials.lines[0].net
        + restated.reduce((sum, l) => sum + l.price, 0)
        - financials.appointmentDiscountDollars
      ) * 100) / 100;
      expect(replay).toBe(financials.price);
    }
  });
});
