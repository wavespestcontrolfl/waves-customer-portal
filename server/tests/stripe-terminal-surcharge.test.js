/**
 * Card-present (Tap to Pay) surcharge planner — pure-function coverage.
 *
 * Pins the decision that the in-person two-step flow makes once the tap reveals
 * card funding, just before the device confirms (issue #1928: card-present
 * charges historically never surcharged because the PI is minted at base before
 * the card is read). No DB, no Stripe network calls — the route is thin glue
 * over `planCardPresentSurcharge`; this file pins the money math + eligibility
 * the route depends on.
 *
 * Invariants under test:
 *   - Only positively-confirmed CREDIT is surcharged. Debit, prepaid, unknown,
 *     and null funding collect base-only (fail-safe — never over-collect).
 *   - The surcharge is the SAME 2.9% computeSurchargeCents math + policy version
 *     as the online flow, so card-present and online receipts reconcile.
 *   - Re-invocation (alreadyFinalized) never re-raises the amount.
 *
 * A regression here either over-collects (debit/unknown customer charged a
 * surcharge they're owed exemption from — Dodd-Frank exposure) or under-collects
 * (credit cards slip through at base — the very leak #1928 was opened to close).
 */

const {
  planCardPresentSurcharge,
  computeSurchargeCents,
  CONFIGURED_COST_BPS,
  SURCHARGE_POLICY_VERSION,
} = require('../services/stripe-pricing');

describe('planCardPresentSurcharge — eligibility', () => {
  test('credit funding → apply_surcharge with the 2.9% breakdown', () => {
    const base = 11700; // $117.00 — the field-charge ticket size from the audit
    const plan = planCardPresentSurcharge({ baseCents: base, funding: 'credit' });
    expect(plan.action).toBe('apply_surcharge');
    expect(plan.surchargeCents).toBe(computeSurchargeCents(base));
    expect(plan.surchargeCents).toBe(339); // floor(11700 * 290 / 10000) = $3.39
    expect(plan.totalCents).toBe(base + 339);
    expect(plan.rateBps).toBe(CONFIGURED_COST_BPS);
    expect(plan.policyVersion).toBe(SURCHARGE_POLICY_VERSION);
    expect(plan.funding).toBe('credit');
  });

  test.each([
    ['debit', 'debit'],
    ['prepaid', 'prepaid'],
    ['unknown string', 'unknown'],
    ['null funding', null],
    ['undefined funding', undefined],
  ])('%s → finalize_base, zero surcharge, amount unchanged', (_label, funding) => {
    const base = 11700;
    const plan = planCardPresentSurcharge({ baseCents: base, funding });
    expect(plan.action).toBe('finalize_base');
    expect(plan.surchargeCents).toBe(0);
    expect(plan.totalCents).toBe(base);
    expect(plan.rateBps).toBe(0);
    // policyVersion is still stamped so the payment record is honest about funding
    expect(plan.policyVersion).toBe(SURCHARGE_POLICY_VERSION);
  });

  test('debit field charge (the $117 audit case) is never surcharged', () => {
    const plan = planCardPresentSurcharge({ baseCents: 11700, funding: 'debit' });
    expect(plan.surchargeCents).toBe(0);
    expect(plan.totalCents).toBe(11700);
  });
});

describe('planCardPresentSurcharge — idempotency', () => {
  test('alreadyFinalized short-circuits even for a credit card', () => {
    const base = 11700;
    const plan = planCardPresentSurcharge({ baseCents: base, funding: 'credit', alreadyFinalized: true });
    expect(plan.action).toBe('already');
    expect(plan.surchargeCents).toBe(0);
    expect(plan.totalCents).toBe(base); // amount is NOT re-raised
  });
});

describe('planCardPresentSurcharge — money math safety', () => {
  test.each([5000, 9999, 11700, 25000, 100000, 543210])(
    'credit surcharge for base=%i never exceeds 2.9%% and matches computeSurchargeCents',
    (base) => {
      const plan = planCardPresentSurcharge({ baseCents: base, funding: 'credit' });
      expect(plan.surchargeCents).toBe(computeSurchargeCents(base));
      // floor-based, so always at/under the configured cost rate — never over
      expect(plan.surchargeCents).toBeLessThanOrEqual(Math.ceil((base * CONFIGURED_COST_BPS) / 10000));
      expect(plan.surchargeCents / base).toBeLessThanOrEqual(CONFIGURED_COST_BPS / 10000);
      expect(plan.totalCents).toBe(base + plan.surchargeCents);
    },
  );
});
