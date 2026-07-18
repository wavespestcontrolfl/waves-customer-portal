// Regression: a plan-wide manual/referral discount must NOT collapse a
// splittable multi-service plan into the badge-free combined 'bundle' card.
//
// Why this broke: the referral credit reduces the COMBINED monthly total but is
// NOT baked into the per-service treatment rows (it's a plan-level credit
// applied after WaveGuard). frequencyServiceRowsMatchMonthly compared the
// per-service row-sum against the referral-reduced monthly, so the ~$2/mo gap
// blew past the 1-cent tolerance, the split was rejected, and the whole plan
// rendered as one 'bundle' section — which the client renders badge-free. Result:
// adding Lawn to a Pest plan (with a referral) silently hid the WaveGuard tier
// badge + discount on every service line. The fix adds the credit back before
// reconciling, so the rows describe the same pre-credit price the check expects.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { buildPricingBundle } = require('../routes/estimate-public');

// Real prod Silver pest+lawn draft shape (numbers verbatim, identity swapped) —
// the same fixture family as estimate-per-service-cadence.test.js's driftEstimate.
function silverPestLawn({ referral } = {}) {
  const est = {
    id: `estimate-${Math.random().toString(36).slice(2)}`,
    status: 'draft',
    monthly_total: 84.08,
    annual_total: 1008.90,
    onetime_total: 99,
    waveguard_tier: 'Silver',
    estimate_data: {
      inputs: {
        svcPest: true, svcLawn: true, pestFreq: '4', lawnFreq: '9',
        grassType: 'st_augustine', homeSqFt: '2309', lotSqFt: '9423',
        stories: '1', isCommercial: 'NO', customerName: 'Referral Split',
        address: '123 Rounding Way, Parrish, FL 34219',
      },
      result: {
        hasRecurring: true,
        hasOneTime: true,
        manualDiscount: null,
        totals: { year1: 1107.9, year2: 1008.9, year2mo: 84.08, manualDiscount: null },
        oneTime: { items: [], total: 99, membershipFee: 99 },
        recurring: {
          tier: 'Silver', waveGuardTier: 'Silver', discount: 0.1, serviceCount: 2,
          monthlyTotal: 84.08, grandTotal: 84.08,
          annualBeforeDiscount: 1121, annualAfterDiscount: 1008.9,
          services: [
            {
              name: 'Lawn Care', service: 'lawn_care', mo: 57.75, monthly: 57.75,
              perTreatment: 77, visitsPerYear: 9, grassType: 'St. Augustine',
              discountable: true, discountEligible: true,
              waveGuardDiscountEligible: true, countsTowardWaveGuardTier: true,
            },
            {
              name: 'Pest Control', service: 'pest_control', mo: 35.67, monthly: 35.67,
              basePrice: 107, perTreatment: 107, visitsPerYear: 4,
            },
          ],
        },
        results: {
          pestTiers: [
            { label: 'Quarterly', mo: 35.67, pa: 107, ann: 428, apps: 4, init: 99, recommended: true },
            { label: 'Bi-Monthly', mo: 45.48, pa: 90.95, ann: 545.7, apps: 6, init: 99 },
            { label: 'Monthly', mo: 74.9, pa: 74.9, ann: 898.8, apps: 12, init: 99 },
          ],
          lawn: [
            { name: '6x applications/yr', v: 6, mo: 50, pa: 100, ann: 600, dimmed: true },
            { name: '9x applications/yr', v: 9, mo: 57.75, pa: 77, ann: 693, recommended: true },
            { name: '12x applications/yr', v: 12, mo: 79, pa: 79, ann: 948, dimmed: true },
          ],
        },
      },
    },
  };
  if (referral) {
    const credit = {
      source: 'catalog_preset', presetKey: 'referral', catalogName: 'Referral Credit',
      label: 'Referral Credit', type: 'FIXED', value: 25,
      amount: 25, recurringAmount: 25, oneTimeAmount: 0,
      scope: 'recurring_annual_after_waveguard', stackingOrder: 'after_waveguard',
    };
    est.estimate_data.result.manualDiscount = credit;
    est.estimate_data.result.totals.manualDiscount = credit;
  }
  return est;
}

describe('referral credit does not hide the WaveGuard tier on a multi-service plan', () => {
  test('pest+lawn WITH a referral still splits into per-service cards (badges intact)', async () => {
    const bundle = await buildPricingBundle(silverPestLawn({ referral: true }));
    // The bug produced ['bundle']; the client renders 'bundle' sections badge-free.
    expect(bundle.services.map((s) => s.key)).toEqual(['pest_control', 'lawn_care']);
    expect(bundle.services.every((s) => s.waveGuardTierEligible === true)).toBe(true);
    expect(bundle.combinedRecurring.waveGuardTierLabel).toBe('Silver');
  });

  test('the referral is preserved for display and billing (combo total stays net)', async () => {
    const bundle = await buildPricingBundle(silverPestLawn({ referral: true }));
    // The credit rides on combinedRecurring for the plan-level summary…
    expect(bundle.combinedRecurring.manualDiscount).toMatchObject({ label: 'Referral Credit', amount: 25 });
    // …and the per-service cards stay PRE-credit (credit shows once, at plan level).
    const pest = bundle.services.find((s) => s.key === 'pest_control');
    expect(pest.frequencies.every((f) => !f.manualDiscount)).toBe(true);
    // Billing is unchanged: the combo (accept) total is still net of the $2.08/mo credit.
    const combo = bundle.serviceCadenceCombos.find(
      (c) => c.key === 'lawn_care:enhanced|pest_control:quarterly',
    );
    expect(combo.monthly).toBe(82);
    expect(bundle.combinedRecurring.monthlySubtotal).toBe(82);
  });

  test('control: the same plan WITHOUT a referral also splits', async () => {
    const bundle = await buildPricingBundle(silverPestLawn({ referral: false }));
    expect(bundle.services.map((s) => s.key)).toEqual(['pest_control', 'lawn_care']);
  });
});
