/**
 * Termite bond rider (owner 2026-07-20): fixed quarterly warranty rate by
 * term (1yr $60 / 5yr $54 / 10yr $45), riding the quarterly bait-station
 * check as its own recurring line — in the totals, per-application priced,
 * NOT WaveGuard-tier-counted, NOT bundle-discountable. The emitted service
 * NAME is the termite_bonds lifecycle contract: syncTermiteBonds recognizes
 * completed visits by "Termite Bond" + the "(N-Year" fragment and mints the
 * bond row at that term.
 */

const { priceTermiteBond } = require('../services/pricing-engine/service-pricing');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const { _private: sweepPrivate } = require('../services/lifecycle-email-sweeps');

const PROFILE = { homeSqFt: 2000, stories: 1, lotSqFt: 8000 };

function termiteInput(options = {}) {
  return translateV2CallToV1Input(PROFILE, ['TERMITE_BAIT'], {
    termiteBaitSystem: 'advance',
    ...options,
  });
}

describe('priceTermiteBond', () => {
  test('terms price exactly: quarterly rate = per application; annual = x4; monthly = /3', () => {
    expect(priceTermiteBond('1yr')).toMatchObject({
      service: 'termite_bond', bondTerm: '1yr', bondYears: 1,
      name: 'Termite Bond (1-Year Term)',
      perApp: 60, visitsPerYear: 4, annual: 240, monthly: 20, discountable: false,
    });
    expect(priceTermiteBond('5yr')).toMatchObject({ perApp: 54, annual: 216, monthly: 18, bondYears: 5 });
    expect(priceTermiteBond('10yr')).toMatchObject({ perApp: 45, annual: 180, monthly: 15, bondYears: 10 });
    expect(priceTermiteBond('none')).toBeNull();
    expect(priceTermiteBond(undefined)).toBeNull();
  });

  test('emitted names satisfy the termite_bonds lifecycle sync term parser', () => {
    expect(sweepPrivate.termYearsFrom(priceTermiteBond('1yr').name)).toBe(1);
    expect(sweepPrivate.termYearsFrom(priceTermiteBond('5yr').name)).toBe(5);
    expect(sweepPrivate.termYearsFrom(priceTermiteBond('10yr').name)).toBe(10);
    // The combined scheduling label keeps the fragment too.
    expect(sweepPrivate.termYearsFrom('Quarterly Termite Bait Station + Termite Bond Service (10-Year Term)')).toBe(10);
  });
});

describe('engine + mapper emission', () => {
  test('bond rides a priced bait program: totals include it, tier does not count it', () => {
    const estimate = generateEstimate(termiteInput({ termiteBondTerm: '10yr' }));
    const bond = estimate.lineItems.find((l) => l.service === 'termite_bond');
    expect(bond).toMatchObject({ bondTerm: '10yr', annual: 180, perApp: 45, visitsPerYear: 4 });

    // 420 monitoring + 180 bond, no discount (solo termite = Bronze 0%).
    expect(estimate.summary.recurringAnnualAfterDiscount).toBe(600);

    const mapped = mapV1ToLegacyShape(estimate);
    const row = mapped.recurring.services.find((svc) => svc.service === 'termite_bond_10yr');
    expect(row).toMatchObject({
      name: 'Termite Bond (10-Year Term)',
      bondTerm: '10yr',
      mo: 15,
      perTreatment: 45,
      visitsPerYear: 4,
      countsTowardWaveGuardTier: false,
      waveGuardDiscountEligible: false,
      discountable: false,
    });
    // Bait row unchanged beside it.
    const bait = mapped.recurring.services.find((svc) => svc.service === 'termite_bait');
    expect(bait).toMatchObject({ mo: 35, perTreatment: 105, visitsPerYear: 4 });
    // Options snapshot + selection persist for the customer selector.
    expect(mapped.results.tmBait.bondOptions).toHaveLength(3);
    expect(mapped.results.tmBait.selectedBondTerm).toBe('10yr');
    expect(mapped.recurring.monthlyTotal).toBe(50);
  });

  test('no bondTerm -> no bond line; options snapshot still persisted for the selector', () => {
    const mapped = mapV1ToLegacyShape(generateEstimate(termiteInput()));
    expect(mapped.recurring.services.some((svc) => String(svc.service).startsWith('termite_bond'))).toBe(false);
    expect(mapped.results.tmBait.bondOptions).toHaveLength(3);
    expect(mapped.results.tmBait.selectedBondTerm).toBeNull();
  });

  test('bond is excluded from the WaveGuard bundle % discount and tier count', () => {
    const input = translateV2CallToV1Input(PROFILE, ['PEST', 'MOSQUITO', 'TERMITE_BAIT'], {
      pestFrequency: 'quarterly',
      termiteBaitSystem: 'advance',
      termiteBondTerm: '10yr',
    });
    const estimate = generateEstimate(input);
    const bond = estimate.lineItems.find((l) => l.service === 'termite_bond');
    // Discount-exempt: annualAfterDiscount absent/equal means the % pass
    // left the line untouched.
    expect(bond.annualAfterDiscount ?? bond.annual).toBe(180);

    const mapped = mapV1ToLegacyShape(estimate);
    // Three qualifying services (pest, mosquito, termite) -> Gold; the bond
    // must not be the fourth (Platinum would mean it counted).
    expect(mapped.recurring.tier).toBe('Gold');
    expect(mapped.recurring.discount).toBe(0.15);
    const row = mapped.recurring.services.find((svc) => String(svc.service).startsWith('termite_bond'));
    expect(row.mo).toBe(15);
  });

  test('quote-required bait (no footprint) suppresses the bond line too', () => {
    const input = translateV2CallToV1Input(
      { homeSqFt: null, stories: 1, lotSqFt: 8000, footprintUnknown: true },
      ['TERMITE_BAIT'],
      { termiteBaitSystem: 'advance', termiteBondTerm: '10yr' },
    );
    const estimate = generateEstimate(input);
    expect(estimate.lineItems.some((l) => l.service === 'termite_bond')).toBe(false);
  });
});
