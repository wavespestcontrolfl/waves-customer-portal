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

// The bond option ships dark (GATE_TERMITE_BOND_OPTION, default OFF) — the
// engine emission is the single choke point, so the suite runs gate-on and
// one case pins the dark default.
beforeAll(() => { process.env.GATE_TERMITE_BOND_OPTION = 'true'; });
afterAll(() => { delete process.env.GATE_TERMITE_BOND_OPTION; });

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

describe('accept scheduling: bait + bond combine to ONE visit (converter routes)', () => {
  const { combineRecurringServicesForScheduling } = require('../services/estimate-converter');
  const baitRow = { name: 'Termite Bait', service: 'termite_bait', mo: 35, monthly: 35, perTreatment: 105, visitsPerYear: 4 };
  const bondRow = {
    name: 'Termite Bond (10-Year Term)', service: 'termite_bond_10yr', bondTerm: '10yr',
    mo: 15, perTreatment: 45, visitsPerYear: 4, countsTowardWaveGuardTier: false,
  };

  test('combined route produces one quarterly unit whose NAME carries the bond + term fragments', () => {
    const { remaining, combos } = combineRecurringServicesForScheduling([baitRow, bondRow], {});
    expect(combos).toHaveLength(1);
    expect(remaining).toHaveLength(0);
    expect(combos[0].frequency).toBe('quarterly');
    expect(combos[0].service.visitsPerYear).toBe(4);
    expect(combos[0].service.name).toBe('Quarterly Termite Bait Station + Termite Bond Service (10-Year Term)');
    // The scheduled service_type mints the termite_bonds row at the right term.
    expect(sweepPrivate.termYearsFrom(combos[0].service.name)).toBe(10);
  });

  test('each term routes to its own combined label', () => {
    for (const [key, label] of [['1yr', '1-Year'], ['5yr', '5-Year'], ['10yr', '10-Year']]) {
      const bond = { ...bondRow, service: `termite_bond_${key}`, name: `Termite Bond (${label} Term)`, bondTerm: key };
      const { combos } = combineRecurringServicesForScheduling([baitRow, bond], {});
      expect(combos).toHaveLength(1);
      expect(combos[0].service.name).toBe(`Quarterly Termite Bait Station + Termite Bond Service (${label} Term)`);
    }
  });

  test('pest + bait + bond: pest consumes the bait line first; bond stays standalone (documented v1 limitation)', () => {
    const pestRow = { name: 'Pest Control', service: 'pest_control', mo: 36.67, perTreatment: 110, visitsPerYear: 4, frequency: 'quarterly' };
    const { combos, remaining } = combineRecurringServicesForScheduling(
      [pestRow, baitRow, bondRow],
      { acceptFrequency: 'quarterly' },
    );
    expect(combos).toHaveLength(1);
    expect(combos[0].service.name).toBe('Quarterly Pest + Termite Bait Station');
    expect(remaining.map((r) => r.service)).toEqual(['termite_bond_10yr']);
  });
});

describe('estimate view payload + bond term switcher rewrite', () => {
  const {
    buildPricingBundle,
    applySelectedTermiteBondToEstimateData,
  } = require('../routes/estimate-public');

  function bondEstimate(term) {
    const mapped = mapV1ToLegacyShape(generateEstimate(termiteInput(term ? { termiteBondTerm: term } : {})));
    return {
      id: `estimate-bond-${term || 'none'}`,
      status: 'sent',
      monthly_total: mapped.recurring.monthlyTotal,
      annual_total: mapped.recurring.annualAfterDiscount,
      onetime_total: mapped.oneTime.total,
      waveguard_tier: 'Bronze',
      estimate_data: { inputs: { svcTermiteBait: true }, result: mapped },
    };
  }

  test('bond stays a rider: ONE termite section carrying bondOptions + selection, never its own card', async () => {
    const bundle = await buildPricingBundle(bondEstimate('10yr'));
    const keys = bundle.services.map((s) => s.key);
    expect(keys.filter((k) => String(k).startsWith('termite_bond'))).toHaveLength(0);
    const termite = bundle.services.find((s) => s.key === 'termite_bait');
    expect(termite).toBeTruthy();
    expect(termite.bondOptions).toHaveLength(3);
    expect(termite.bondOptions.map((o) => o.key)).toEqual(['1yr', '5yr', '10yr']);
    expect(termite.bondOptions.find((o) => o.key === '10yr')).toMatchObject({
      perApplicationAdd: 45, monthlyAdd: 15, annualAdd: 180,
    });
    expect(termite.selectedBondTerm).toBe('10yr');
    // The bond still shows as a priced line in the breakdown rows.
    expect(JSON.stringify(bundle)).toContain('Termite Bond (10-Year Term)');
  });

  test('no-bond estimate still carries the selector options with nothing selected', async () => {
    const bundle = await buildPricingBundle(bondEstimate(null));
    const termite = bundle.services.find((s) => s.key === 'termite_bait');
    expect(termite.bondOptions).toHaveLength(3);
    expect(termite.selectedBondTerm).toBeNull();
  });

  test('switcher rewrite: 10yr -> 1yr adjusts rows and totals by the exact deltas', () => {
    const estimate = bondEstimate('10yr');
    const parsed = estimate.estimate_data;
    const outcome = applySelectedTermiteBondToEstimateData(parsed, '1yr');
    expect(outcome).toMatchObject({ ok: true, changed: true, monthlyDelta: 5, annualDelta: 60, selectedBondTerm: '1yr' });
    const rows = parsed.result.recurring.services;
    const bondRows = rows.filter((svc) => String(svc.service).startsWith('termite_bond'));
    expect(bondRows).toHaveLength(1);
    expect(bondRows[0]).toMatchObject({ service: 'termite_bond_1yr', mo: 20, perTreatment: 60, visitsPerYear: 4 });
    expect(parsed.result.recurring.monthlyTotal).toBe(55);
    expect(parsed.result.recurring.annualAfterDiscount).toBe(660);
    expect(parsed.result.results.tmBait.selectedBondTerm).toBe('1yr');
  });

  test('switcher rewrite: none removes the bond row and subtracts its slice', () => {
    const estimate = bondEstimate('10yr');
    const parsed = estimate.estimate_data;
    const outcome = applySelectedTermiteBondToEstimateData(parsed, 'none');
    expect(outcome).toMatchObject({ ok: true, changed: true, monthlyDelta: -15, annualDelta: -180, selectedBondTerm: null });
    expect(parsed.result.recurring.services.some((svc) => String(svc.service).startsWith('termite_bond'))).toBe(false);
    expect(parsed.result.recurring.monthlyTotal).toBe(35);
  });

  test('switcher rewrite: invalid term and bond-less payloads fail closed', () => {
    expect(applySelectedTermiteBondToEstimateData(bondEstimate('10yr').estimate_data, '3yr'))
      .toMatchObject({ ok: false, reason: 'invalid_bond_term' });
    const legacy = { result: { recurring: { services: [{ name: 'Termite Bait', service: 'termite_bait', mo: 35 }] }, results: { tmBait: {} } } };
    expect(applySelectedTermiteBondToEstimateData(legacy, '10yr'))
      .toMatchObject({ ok: false, reason: 'bond_not_available' });
  });
});

describe('solo termite accept totals carry the bond (money-path)', () => {
  const { buildPricingBundle } = require('../routes/estimate-public');

  function soloBondEstimate(term) {
    const mapped = mapV1ToLegacyShape(generateEstimate(termiteInput(term ? { termiteBondTerm: term } : {})));
    return {
      id: `estimate-solo-bond-${term || 'none'}`,
      status: 'sent',
      monthly_total: mapped.recurring.monthlyTotal,
      annual_total: mapped.recurring.annualAfterDiscount,
      onetime_total: mapped.oneTime.total,
      waveguard_tier: 'Bronze',
      estimate_data: { inputs: { svcTermiteBait: true }, result: mapped },
    };
  }

  test('selected bond folds into the SOLO section frequency — the plan the accept freezes', async () => {
    const bundle = await buildPricingBundle(soloBondEstimate('10yr'));
    expect(bundle.services).toHaveLength(1);
    const entry = bundle.services[0].frequencies[0];
    // 35+15 monthly, 420+180 annual, 105+45 per application — the true
    // price of the combined bait+bond visit; accept's effective totals and
    // the converter's $150 per-application fee both read these.
    expect(entry.monthly).toBe(50);
    expect(entry.annual).toBe(600);
    expect(entry.perTreatment).toBe(150);
    expect(entry.visitsPerYear).toBe(4);
  });

  test('no bond selected: solo section frequency unchanged', async () => {
    const bundle = await buildPricingBundle(soloBondEstimate(null));
    const entry = bundle.services[0].frequencies[0];
    expect(entry.monthly).toBe(35);
    expect(entry.perTreatment).toBe(105);
  });
});

describe('GATE_TERMITE_BOND_OPTION (default OFF)', () => {
  test('gate off: no bond line, no options snapshot, selector never renders', () => {
    const prev = process.env.GATE_TERMITE_BOND_OPTION;
    delete process.env.GATE_TERMITE_BOND_OPTION;
    try {
      const mapped = mapV1ToLegacyShape(generateEstimate(termiteInput({ termiteBondTerm: '10yr' })));
      expect(mapped.recurring.services.some((svc) => String(svc.service).startsWith('termite_bond'))).toBe(false);
      expect(mapped.results.tmBait.bondOptions).toBeFalsy();
      expect(mapped.recurring.monthlyTotal).toBe(35);
    } finally {
      process.env.GATE_TERMITE_BOND_OPTION = prev;
    }
  });
});

describe('codex #2915 r1 hardening', () => {
  const EstimateConverter = require('../services/estimate-converter');
  const { buildPricingBundle, annualPrepayEligibleForEstimateData } = require('../routes/estimate-public');
  const { assertNoDarkTermiteBondPayload } = require('../services/admin-estimate-persistence');

  function estimateWith(term) {
    const mapped = mapV1ToLegacyShape(generateEstimate(termiteInput(term ? { termiteBondTerm: term } : {})));
    return {
      id: `estimate-hardening-${term || 'none'}`,
      status: 'sent',
      monthly_total: mapped.recurring.monthlyTotal,
      annual_total: mapped.recurring.annualAfterDiscount,
      onetime_total: mapped.oneTime.total,
      waveguard_tier: 'Bronze',
      estimate_data: { inputs: { svcTermiteBait: true }, result: mapped },
    };
  }

  test('standalone bond rows STILL seed their quarterly series (rebuttal evidence — serviceKeyFor collapses termite names)', () => {
    const bondRow = {
      name: 'Termite Bond (10-Year Term)', service: 'termite_bond_10yr', bondTerm: '10yr',
      mo: 15, perTreatment: 45, visitsPerYear: 4,
    };
    expect(EstimateConverter.supportsConverterFollowUpSeeding(bondRow, {}, 'quarterly')).toBe(true);
    // Even a monthly plan-level fallback cannot suppress it — the explicit
    // visits override applies to the whole termite family.
    expect(EstimateConverter.converterFollowUpSeedingPattern(
      bondRow, { service_type: 'Termite Bond (10-Year Term)' }, 'monthly',
    )).toBe('quarterly');
  });

  test('bond estimates are never annual-prepay eligible (CTA + accept validation share the predicate)', () => {
    expect(annualPrepayEligibleForEstimateData(estimateWith('10yr').estimate_data)).toBe(false);
    expect(annualPrepayEligibleForEstimateData(estimateWith(null).estimate_data)).toBe(true);
  });

  test('kill switch is total for unsold state: gate off strips the selector but sold pricing keeps folding', async () => {
    const estimate = estimateWith('10yr');
    const prev = process.env.GATE_TERMITE_BOND_OPTION;
    delete process.env.GATE_TERMITE_BOND_OPTION;
    try {
      const bundle = await buildPricingBundle(estimate);
      const termite = bundle.services.find((s) => s.key === 'termite_bait');
      expect(termite.bondOptions).toBeUndefined();
      expect(termite.selectedBondTerm).toBeUndefined();
      // Sold state: the selected bond still folds into the solo plan the
      // accept freezes — a kill-switch flip never rewrites a quoted price.
      expect(termite.frequencies[0].monthly).toBe(50);
      expect(termite.frequencies[0].perTreatment).toBe(150);
    } finally {
      process.env.GATE_TERMITE_BOND_OPTION = prev;
    }
  });

  test('client-priced saves cannot persist a bond while the gate is dark (reject, never strip)', () => {
    const bondData = estimateWith('10yr').estimate_data;
    const cleanData = estimateWith(null).estimate_data;
    const prev = process.env.GATE_TERMITE_BOND_OPTION;
    delete process.env.GATE_TERMITE_BOND_OPTION;
    try {
      expect(() => assertNoDarkTermiteBondPayload(bondData)).toThrow(/GATE_TERMITE_BOND_OPTION/);
      let status;
      try { assertNoDarkTermiteBondPayload(bondData); } catch (err) { status = err.statusCode || err.status; }
      expect(status).toBe(422);
      expect(() => assertNoDarkTermiteBondPayload(cleanData)).not.toThrow();
    } finally {
      process.env.GATE_TERMITE_BOND_OPTION = prev;
    }
    expect(() => assertNoDarkTermiteBondPayload(bondData)).not.toThrow();
  });
});
