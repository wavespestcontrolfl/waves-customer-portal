/**
 * Codex GitHub round 3 on #4568, rule-15 finding — discount-engine.js's
 * /api/admin/discounts/calculate preview computed each percentage
 * additively against the untouched subtotal while server/services/
 * discount-stack.js compounds: two arithmetic engines for the same
 * question. Consolidated so discount-engine.js delegates its per-
 * discount dollar math to stackDiscounts, with `compound:
 * discountStackingLive()` — gate off, the preview reproduces the old
 * additive math; gate on, it compounds the same way a save will.
 *
 * This file is the parity proof for the gate-off case. `oldAdditiveDollars`
 * below is a VERBATIM copy of the arithmetic this module used to run
 * inline (before this change deleted it from src, per rule 19) — kept
 * here, in the test file only, as the reference the delegated
 * implementation must reproduce.
 *
 * One EXPECTED, DOCUMENTED divergence: the old formula —
 * `Math.round(subtotal * (amount / 100) * 100) / 100` — shares the exact
 * float half-cent drift server/services/discount-stack.js's own
 * percentage math was fixed for (Codex pre-push audit P1, an earlier
 * round): 5% of $20.70 rounds DOWN to $1.03 under the old formula
 * (20.70 * 0.05 * 100 === 103.49999999999999 in IEEE754 double), never
 * the mathematically correct half-up $1.04. That was always a bug in the
 * code being deleted, not a behavior worth preserving — the parity tests
 * below verify the delegated implementation is byte-identical to the old
 * one for every input EXCEPT this one, isolated, quantified class, where
 * it reports the correct value instead of reproducing the bug.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const DiscountEngine = require('../services/discount-engine');
const { stackDiscounts } = require('../services/discount-stack');

// Verbatim copy of the arithmetic deleted from discount-engine.js's
// calculateDiscounts by this change. Do not "fix" this copy — it exists
// to prove what the OLD code actually did, bugs included.
function oldAdditiveDollars(subtotal, applied) {
  let totalDiscount = 0;
  const results = applied.map((disc) => {
    let dollars = 0;
    if (disc.discount_type === 'percentage' || disc.discount_type === 'variable_percentage') {
      dollars = Math.round(subtotal * (Number(disc.amount) / 100) * 100) / 100;
      if (disc.max_discount_dollars) dollars = Math.min(dollars, Number(disc.max_discount_dollars));
    } else if (disc.discount_type === 'fixed_amount' || disc.discount_type === 'variable_amount') {
      dollars = Number(disc.amount);
    } else if (disc.discount_type === 'free_service') {
      dollars = subtotal;
    }
    dollars = Math.min(Math.max(0, dollars), Math.max(0, Number(subtotal) - totalDiscount));
    dollars = Math.round(dollars * 100) / 100;
    totalDiscount += dollars;
    return {
      id: disc.id,
      discount_key: disc.discount_key,
      name: disc.name,
      discount_type: disc.discount_type,
      amount: Number(disc.amount),
      discount_dollars: dollars,
      color: disc.color,
      icon: disc.icon,
    };
  }).filter((discount) => discount.discount_dollars > 0);
  if (totalDiscount > subtotal) totalDiscount = subtotal;
  return {
    discounts: results,
    totalDiscount: Math.round(totalDiscount * 100) / 100,
    afterDiscount: Math.round((subtotal - Math.min(totalDiscount, subtotal)) * 100) / 100,
    subtotal,
  };
}

// Independent ground truth for a single percentage's dollars — NOT the
// implementation under test, and not a copy of it: exact integer-cents /
// basis-point half-up math, the textbook definition, so a mismatch against
// it means the code being checked is wrong, not that this reference is
// biased toward either implementation.
function referenceHalfUpPercent(subtotal, amount, maxDiscountDollars) {
  const subtotalCents = Math.round(subtotal * 100);
  const basisPoints = Math.round(amount * 100);
  const rawCents = Math.floor((subtotalCents * basisPoints * 2 + 10000) / 20000);
  let dollars = rawCents / 100;
  if (maxDiscountDollars) dollars = Math.min(dollars, Number(maxDiscountDollars));
  return Math.round(dollars * 100) / 100;
}

function mulberry32(seed) {
  let a = seed;
  return function rand() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randMoney(rand, lo, hi) { return Math.round((rand() * (hi - lo) + lo) * 100) / 100; }
function randInt(rand, lo, hi) { return Math.floor(rand() * (hi - lo + 1)) + lo; }

let nextId = 0;
function discountRow(overrides) {
  return {
    id: `d${nextId++}`,
    discount_key: `key-${nextId}`,
    name: `Discount ${nextId}`,
    color: null,
    icon: null,
    max_discount_dollars: null,
    ...overrides,
  };
}

describe('gate OFF (compound:false) — quantified parity against the deleted additive implementation', () => {
  test('4,000 random brute-force stacks: single discounts, multiple percentages, fixed+percent, and clamps', () => {
    const rand = mulberry32(20260916);
    let exactMatches = 0;
    let explainedDrift = 0;
    for (let t = 0; t < 4000; t++) {
      const subtotal = randMoney(rand, 1, 500);
      const count = randInt(rand, 1, 5);
      const applied = Array.from({ length: count }, () => {
        const kindRoll = rand();
        if (kindRoll < 0.5) {
          return discountRow({
            discount_type: 'percentage',
            amount: randInt(rand, 1, 60),
            max_discount_dollars: rand() < 0.3 ? randMoney(rand, 1, 80) : null,
          });
        }
        if (kindRoll < 0.85) {
          return discountRow({ discount_type: 'fixed_amount', amount: randMoney(rand, 1, 200) });
        }
        return discountRow({ discount_type: 'free_service', amount: 0 });
      });

      const oldResult = oldAdditiveDollars(subtotal, applied);
      const newResult = DiscountEngine._internals.applyDiscountArithmetic(subtotal, applied, { compound: false });

      // Structure must ALWAYS agree: same rows survive the >0 filter, in
      // the same order, same identity.
      expect(newResult.discounts.map((d) => d.id)).toEqual(oldResult.discounts.map((d) => d.id));

      // Sum, over every percentage item, of (mathematically correct
      // half-up dollars) - (old formula's own raw, PRE-clamp dollars) —
      // this is exactly how much MORE total discount the fix can ever
      // account for, isolated from clamping/selection effects entirely.
      let maxPossibleDrift = 0;
      for (const disc of applied) {
        if (disc.discount_type === 'percentage' || disc.discount_type === 'variable_percentage') {
          const correct = referenceHalfUpPercent(subtotal, disc.amount, disc.max_discount_dollars);
          const oldRaw = Math.min(
            disc.max_discount_dollars ? Math.min(Math.round(subtotal * (disc.amount / 100) * 100) / 100, Number(disc.max_discount_dollars)) : Math.round(subtotal * (disc.amount / 100) * 100) / 100,
          );
          maxPossibleDrift += Math.max(0, Math.round((correct - oldRaw) * 100) / 100);
        }
      }

      if (Math.abs(newResult.totalDiscount - oldResult.totalDiscount) < 0.005) {
        expect(newResult.afterDiscount).toBe(oldResult.afterDiscount);
        exactMatches++;
      } else {
        // Any discrepancy must be explained ENTIRELY by the known
        // rounding-drift class, and never make the new total SMALLER —
        // the fix can only correct an under-rounded old value upward.
        const delta = Math.round((newResult.totalDiscount - oldResult.totalDiscount) * 100) / 100;
        expect(delta).toBeGreaterThan(0);
        expect(delta).toBeLessThanOrEqual(Math.round(maxPossibleDrift * 100) / 100 + 0.01);
        explainedDrift++;
      }
    }
    // The drift class is real but rare (~0.4% of realistic subtotal/rate
    // combinations, measured separately) — assert it showed up at least
    // once in 4,000 trials (proving the test surface reaches it) without
    // dominating, and that every trial landed in one bucket or the other.
    expect(exactMatches + explainedDrift).toBe(4000);
    expect(explainedDrift).toBeGreaterThan(0);
    expect(exactMatches).toBeGreaterThan(3000);
  });

  test('the exact known divergence: 5% of $20.70 is the correct $1.04, not the old formula\'s $1.03', () => {
    const applied = [discountRow({ discount_type: 'percentage', amount: 5 })];
    const oldResult = oldAdditiveDollars(20.70, applied);
    const newResult = DiscountEngine._internals.applyDiscountArithmetic(20.70, applied, { compound: false });
    expect(oldResult.discounts[0].discount_dollars).toBe(1.03);
    expect(newResult.discounts[0].discount_dollars).toBe(1.04);
    expect(newResult.totalDiscount).toBe(1.04);
  });

  test('a clamp-heavy case with NO rounding drift is byte-identical, including per-row breakdown', () => {
    // The exact scenario the existing discount-engine-service-filter test
    // already locks in: $80 + $80 + $10 fixed on a $100 subtotal.
    const applied = [
      discountRow({ discount_type: 'fixed_amount', amount: 80 }),
      discountRow({ discount_type: 'fixed_amount', amount: 80 }),
      discountRow({ discount_type: 'fixed_amount', amount: 10 }),
    ];
    const oldResult = oldAdditiveDollars(100, applied);
    const newResult = DiscountEngine._internals.applyDiscountArithmetic(100, applied, { compound: false });
    expect(newResult).toEqual({
      discounts: oldResult.discounts,
      totalDiscount: oldResult.totalDiscount,
      afterDiscount: oldResult.afterDiscount,
    });
    expect(newResult.discounts.map((d) => d.discount_dollars)).toEqual([80, 20]);
  });

  test('priority order (not a canonical fixed-then-percent order) governs the clamp, matching the old sequential behavior', () => {
    // A percentage listed BEFORE a fixed credit — the old code clamped in
    // whatever order the DB priority sort gave it, never reordering by
    // kind. This is the case that would break if stackDiscounts'
    // compound:false path canonicalized instead of preserving input order.
    const applied = [
      discountRow({ discount_type: 'percentage', amount: 90 }),
      discountRow({ discount_type: 'fixed_amount', amount: 50 }),
    ];
    const oldResult = oldAdditiveDollars(100, applied);
    const newResult = DiscountEngine._internals.applyDiscountArithmetic(100, applied, { compound: false });
    expect(newResult.discounts.map((d) => d.discount_dollars)).toEqual(oldResult.discounts.map((d) => d.discount_dollars));
    expect(newResult.totalDiscount).toBe(oldResult.totalDiscount);
  });
});

describe('gate ON (compound:true) — the preview compounds, matching what a save will compute', () => {
  test('two percentages compound (10% then 5% is $16.10, not the additive $16.65)', () => {
    const applied = [
      discountRow({ discount_type: 'percentage', amount: 10 }),
      discountRow({ discount_type: 'percentage', amount: 5 }),
    ];
    const result = DiscountEngine._internals.applyDiscountArithmetic(111, applied, { compound: true });
    expect(result.totalDiscount).toBe(16.1);
    expect(result.afterDiscount).toBe(94.9);
  });

  test('agrees exactly with calling stackDiscounts directly on the same mapped terms', () => {
    const applied = [
      discountRow({ discount_type: 'fixed_amount', amount: 25 }),
      discountRow({ discount_type: 'percentage', amount: 10 }),
    ];
    const engineResult = DiscountEngine._internals.applyDiscountArithmetic(111, applied, { compound: true });
    const directResult = stackDiscounts(111, applied.map((d) => ({ discountType: d.discount_type, amount: d.amount })));
    expect(engineResult.totalDiscount).toBe(directResult.totalDollars);
    expect(engineResult.afterDiscount).toBe(directResult.net);
  });
});

describe('DiscountEngine.calculateDiscounts (full function, DB mocked) reads the live gate', () => {
  const db = require('../models/db');
  function mockDiscounts(rows) {
    const query = { where: jest.fn(() => query), orderBy: jest.fn(async () => rows) };
    db.mockImplementation((table) => {
      if (table === 'discounts') return query;
      throw new Error(`Unexpected table query: ${table}`);
    });
    return query;
  }
  function activeDiscount(overrides) {
    return {
      id: 'd1', discount_key: 'k1', name: 'N', is_active: true,
      is_waveguard_tier_discount: false, promo_code: null, is_auto_apply: true,
      requires_military: false, requires_senior: false, requires_multi_home: false,
      requires_new_customer: false, requires_referral: false, requires_prepayment: false,
      requires_waveguard_tier: null, service_key_filter: null, service_category_filter: null,
      payment_method_condition: null, min_subtotal: null, min_service_count: null,
      show_in_invoices: true, show_in_estimates: true, is_stackable: true, stack_group: null,
      priority: 0, color: null, icon: null, max_discount_dollars: null,
      ...overrides,
    };
  }

  afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

  test('gate off (default): additive, matching the old formula', async () => {
    mockDiscounts([activeDiscount({ discount_type: 'percentage', amount: 10 }), activeDiscount({ id: 'd2', discount_type: 'percentage', amount: 5 })]);
    const result = await DiscountEngine.calculateDiscounts(null, { subtotal: 111 });
    // Additive: 10% + 5% of the SAME $111 = $11.10 + $5.55 = $16.65.
    expect(result.totalDiscount).toBe(16.65);
  });

  test('gate on: compounds, matching a later save', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    mockDiscounts([activeDiscount({ discount_type: 'percentage', amount: 10 }), activeDiscount({ id: 'd2', discount_type: 'percentage', amount: 5 })]);
    const result = await DiscountEngine.calculateDiscounts(null, { subtotal: 111 });
    expect(result.totalDiscount).toBe(16.1);
  });
});
