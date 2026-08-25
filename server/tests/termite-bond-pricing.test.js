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

    // 408 monitoring (23-station bracket $34/mo, owner 2026-07-28) + 180
    // bond, no discount (solo termite = Bronze 0%).
    expect(estimate.summary.recurringAnnualAfterDiscount).toBe(588);

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
    expect(bait).toMatchObject({ mo: 34, perTreatment: 102, visitsPerYear: 4 });
    // Options snapshot + selection persist for the customer selector.
    expect(mapped.results.tmBait.bondOptions).toHaveLength(3);
    expect(mapped.results.tmBait.selectedBondTerm).toBe('10yr');
    expect(mapped.recurring.monthlyTotal).toBe(49);
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
    expect(combos[0].service.name).toBe('Quarterly Pest + Termite Bait Station Service');
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
    expect(parsed.result.recurring.monthlyTotal).toBe(54);
    expect(parsed.result.recurring.annualAfterDiscount).toBe(648);
    expect(parsed.result.results.tmBait.selectedBondTerm).toBe('1yr');
  });

  test('switcher rewrite: none removes the bond row and subtracts its slice', () => {
    const estimate = bondEstimate('10yr');
    const parsed = estimate.estimate_data;
    const outcome = applySelectedTermiteBondToEstimateData(parsed, 'none');
    expect(outcome).toMatchObject({ ok: true, changed: true, monthlyDelta: -15, annualDelta: -180, selectedBondTerm: null });
    expect(parsed.result.recurring.services.some((svc) => String(svc.service).startsWith('termite_bond'))).toBe(false);
    expect(parsed.result.recurring.monthlyTotal).toBe(34);
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
    // 34+15 monthly, 408+180 annual, 102+45 per application — the true
    // price of the combined bait+bond visit; accept's effective totals and
    // the converter's $150 per-application fee both read these.
    expect(entry.monthly).toBe(49);
    expect(entry.annual).toBe(588);
    expect(entry.perTreatment).toBe(147);
    expect(entry.visitsPerYear).toBe(4);
  });

  test('no bond selected: solo section frequency unchanged', async () => {
    const bundle = await buildPricingBundle(soloBondEstimate(null));
    const entry = bundle.services[0].frequencies[0];
    expect(entry.monthly).toBe(34);
    expect(entry.perTreatment).toBe(102);
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
      expect(mapped.recurring.monthlyTotal).toBe(34);
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
      expect(termite.frequencies[0].monthly).toBe(49);
      expect(termite.frequencies[0].perTreatment).toBe(147);
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

describe('codex #2915 r2 hardening', () => {
  const EstimateConverter = require('../services/estimate-converter');
  const { buildPricingBundle } = require('../routes/estimate-public');
  const { assertLiveTermiteBondRates } = require('../services/admin-estimate-persistence');
  const { validatePricingConfigData } = require('../routes/admin-pricing-config');

  test('raw engine payloads ({engineInputs, engineResult}) admit the bond, term-keyed, tier-exempt (converter)', () => {
    const engineResult = generateEstimate(termiteInput({ termiteBondTerm: '10yr' }));
    const rows = EstimateConverter.recurringServicesFromEstimateData({
      engineInputs: {},
      engineResult,
    });
    const bond = rows.find((svc) => String(svc.service).startsWith('termite_bond'));
    expect(bond).toBeTruthy();
    expect(bond.service).toBe('termite_bond_10yr');
    expect(bond.name).toBe('Termite Bond (10-Year Term)');
  });

  test('multi-service plan WITH a selected bond still splits — termite section carries the selector, bond gets no card', async () => {
    const mapped = mapV1ToLegacyShape(generateEstimate(translateV2CallToV1Input(PROFILE, ['PEST', 'TERMITE_BAIT'], {
      pestFrequency: 'quarterly',
      termiteBaitSystem: 'advance',
      termiteBondTerm: '10yr',
    })));
    const estimate = {
      id: 'estimate-split-bond',
      status: 'sent',
      monthly_total: mapped.recurring.monthlyTotal,
      annual_total: mapped.recurring.annualAfterDiscount,
      onetime_total: mapped.oneTime.total,
      waveguard_tier: mapped.recurring.tier || 'Silver',
      estimate_data: { inputs: { svcPest: true, svcTermiteBait: true }, result: mapped },
    };
    const bundle = await buildPricingBundle(estimate);
    const keys = bundle.services.map((s) => s.key);
    // The bond's monthly is inside the frequency totals — reconciliation must
    // still split (no collapse to the single bundle card) and the bond must
    // not mint its own card.
    expect(keys).toContain('pest_control');
    expect(keys).toContain('termite_bait');
    expect(keys.some((k) => String(k).startsWith('termite_bond'))).toBe(false);
    const termite = bundle.services.find((s) => s.key === 'termite_bait');
    expect(termite.bondOptions).toHaveLength(3);
    expect(termite.selectedBondTerm).toBe('10yr');
  });

  test('reserved-branch promotion covers bond remainders (filter semantics)', () => {
    // The promotion filter admits the whole termite family with explicit
    // quarterly visits; pest+bait combine first, leaving exactly the bond.
    const pestRow = { name: 'Pest Control', service: 'pest_control', mo: 36.67, perTreatment: 110, visitsPerYear: 4, frequency: 'quarterly' };
    const baitRow = { name: 'Termite Bait', service: 'termite_bait', mo: 35, monthly: 35, perTreatment: 105, visitsPerYear: 4 };
    const bondRow = { name: 'Termite Bond (10-Year Term)', service: 'termite_bond_10yr', bondTerm: '10yr', mo: 15, perTreatment: 45, visitsPerYear: 4 };
    const { remaining } = EstimateConverter.combineRecurringServicesForScheduling(
      [pestRow, baitRow, bondRow],
      { acceptFrequency: 'quarterly' },
    );
    expect(remaining.map((r) => r.service)).toEqual(['termite_bond_10yr']);
    // The same seeding license the promotion relies on:
    expect(EstimateConverter.supportsConverterFollowUpSeeding(remaining[0], {}, 'quarterly')).toBe(true);
  });

  test('pricing-config termite_bond edits are validated strictly positive', () => {
    expect(validatePricingConfigData('termite_bond', { term_1yr: 60, term_5yr: 54, term_10yr: 45 }).ok).toBe(true);
    expect(validatePricingConfigData('termite_bond', { term_1yr: -60, term_5yr: 54, term_10yr: 45 }).ok).toBe(false);
    expect(validatePricingConfigData('termite_bond', { term_1yr: 'sixty', term_5yr: 54, term_10yr: 45 }).ok).toBe(false);
    expect(validatePricingConfigData('termite_bond', { term_5yr: 54, term_10yr: 45 }).ok).toBe(false);
  });

  test('client-priced saves fail closed when persisted bond rates drift from live constants', () => {
    const data = mapV1ToLegacyShape(generateEstimate(termiteInput({ termiteBondTerm: '10yr' })));
    const estimateData = { result: data };
    expect(() => assertLiveTermiteBondRates(estimateData)).not.toThrow();
    const bond = data.recurring.services.find((svc) => String(svc.service).startsWith('termite_bond'));
    bond.perTreatment = 40; // stale client bundle priced before an admin rate edit
    let status;
    try { assertLiveTermiteBondRates(estimateData); } catch (err) { status = err.statusCode || err.status; }
    expect(status).toBe(422);
  });
});

describe('codex #2915 r3 hardening', () => {
  const {
    buildPricingBundle,
    applySelectedTermiteBondToEstimateData,
  } = require('../routes/estimate-public');
  const { assertLiveTermiteBondRates } = require('../services/admin-estimate-persistence');

  function rawEngineEstimate(term) {
    const engineResult = generateEstimate(termiteInput(term ? { termiteBondTerm: term } : {}));
    return {
      id: `estimate-raw-${term || 'none'}`,
      status: 'sent',
      monthly_total: engineResult.summary.recurringMonthlyAfterDiscount,
      annual_total: engineResult.summary.recurringAnnualAfterDiscount,
      onetime_total: engineResult.summary.oneTimeTotal,
      waveguard_tier: 'Bronze',
      estimate_data: { engineInputs: {}, engineResult },
    };
  }

  test('raw engine estimates get the selector: options sourced from the bait line item', async () => {
    const bundle = await buildPricingBundle(rawEngineEstimate('10yr'));
    const termite = bundle.services.find((s) => s.key === 'termite_bait');
    expect(termite).toBeTruthy();
    expect(termite.bondOptions).toHaveLength(3);
    expect(termite.selectedBondTerm).toBe('10yr');
  });

  test('raw engine switcher rewrites the line item + summary by exact deltas', () => {
    const estimate = rawEngineEstimate('10yr');
    const parsed = estimate.estimate_data;
    const before = parsed.engineResult.summary.recurringAnnualAfterDiscount;
    const outcome = applySelectedTermiteBondToEstimateData(parsed, '1yr');
    expect(outcome).toMatchObject({ ok: true, changed: true, monthlyDelta: 5, annualDelta: 60, selectedBondTerm: '1yr' });
    const bond = parsed.engineResult.lineItems.find((li) => String(li.service).startsWith('termite_bond'));
    expect(bond).toMatchObject({ bondTerm: '1yr', perApp: 60, annual: 240, monthly: 20 });
    expect(parsed.engineResult.summary.recurringAnnualAfterDiscount).toBe(before + 60);

    const removal = applySelectedTermiteBondToEstimateData(parsed, 'none');
    expect(removal).toMatchObject({ ok: true, monthlyDelta: -20, annualDelta: -240, selectedBondTerm: null });
    expect(parsed.engineResult.lineItems.some((li) => String(li.service).startsWith('termite_bond'))).toBe(false);
    expect(parsed.engineResult.summary.recurringAnnualAfterDiscount).toBe(before - 180);
  });

  test('a stale UNSELECTED options snapshot is restamped to live rates, never bricked (r4)', () => {
    const data = mapV1ToLegacyShape(generateEstimate(termiteInput()));
    const estimateData = { result: data };
    const tenYear = data.results.tmBait.bondOptions.find((o) => o.key === '10yr');
    tenYear.perApp = 40; // browser bundle baked before an admin rate edit
    tenYear.annual = 160;
    // Nothing selected → server-authoritative correction instead of a 422
    // that would brick every fallback termite save until a redeploy.
    expect(() => assertLiveTermiteBondRates(estimateData)).not.toThrow();
    expect(tenYear.perApp).toBe(45);
    expect(tenYear.annual).toBe(180);
    expect(tenYear.monthly).toBe(15);
    // Unknown term keys still fail closed — the server never guesses a rate.
    data.results.tmBait.bondOptions.push({ key: '3yr', perApp: 50 });
    let status;
    try { assertLiveTermiteBondRates(estimateData); } catch (err) { status = err.statusCode || err.status; }
    expect(status).toBe(422);
  });
});

describe('codex #2915 r4 hardening', () => {
  const { applySelectedTermiteBondToEstimateData } = require('../routes/estimate-public');

  test('raw switcher syncs the replayable engineInputs term (bundle/accept replay parity)', () => {
    const engineResult = generateEstimate(termiteInput({ termiteBondTerm: '10yr' }));
    const parsed = {
      engineInputs: { services: { termite: { system: 'advance', monitoringTier: 'basic', bondTerm: '10yr' } } },
      engineResult,
    };
    applySelectedTermiteBondToEstimateData(parsed, '1yr');
    expect(parsed.engineInputs.services.termite.bondTerm).toBe('1yr');
    applySelectedTermiteBondToEstimateData(parsed, 'none');
    expect('bondTerm' in parsed.engineInputs.services.termite).toBe(false);
  });

  test('mapped switcher syncs engineRequest + form inputs so re-prices replay the chosen term', () => {
    const mapped = mapV1ToLegacyShape(generateEstimate(termiteInput({ termiteBondTerm: '10yr' })));
    const parsed = {
      inputs: { svcTermiteBait: true, termiteBondTerm: '10yr' },
      engineRequest: { services: { termite: { system: 'advance', monitoringTier: 'basic', bondTerm: '10yr' } } },
      result: mapped,
    };
    applySelectedTermiteBondToEstimateData(parsed, '1yr');
    expect(parsed.inputs.termiteBondTerm).toBe('1yr');
    expect(parsed.engineRequest.services.termite.bondTerm).toBe('1yr');
    applySelectedTermiteBondToEstimateData(parsed, 'none');
    expect(parsed.inputs.termiteBondTerm).toBe('none');
    expect('bondTerm' in parsed.engineRequest.services.termite).toBe(false);
  });

  test('V2 replay shape (engineRequest = {profile, selectedServices, options}) syncs options.termiteBondTerm (r5)', () => {
    const mapped = mapV1ToLegacyShape(generateEstimate(termiteInput({ termiteBondTerm: '10yr' })));
    const parsed = {
      engineRequest: {
        profile: { homeSqFt: 2000 },
        selectedServices: ['TERMITE_BAIT'],
        options: { termiteBaitSystem: 'advance', termiteBondTerm: '10yr' },
      },
      result: mapped,
    };
    applySelectedTermiteBondToEstimateData(parsed, '1yr');
    expect(parsed.engineRequest.options.termiteBondTerm).toBe('1yr');
    applySelectedTermiteBondToEstimateData(parsed, 'none');
    expect(parsed.engineRequest.options.termiteBondTerm).toBe('none');
  });
});

describe('codex #2915 r6 hardening', () => {
  const EstimateConverter = require('../services/estimate-converter');
  const { applySelectedTermiteBondToEstimateData } = require('../routes/estimate-public');
  const {
    assertNoDarkTermiteBondPayload,
    assertLiveTermiteBondRates,
  } = require('../services/admin-estimate-persistence');

  const baitRow = { name: 'Termite Bait', service: 'termite_bait', mo: 35, monthly: 35, perTreatment: 105, visitsPerYear: 4 };
  const bondRow = { name: 'Termite Bond (10-Year Term)', service: 'termite_bond_10yr', bondTerm: '10yr', mo: 15, perTreatment: 45, visitsPerYear: 4 };

  test('rider-aware single-unit visits: bait+bond derives 4 from the bait line (the $150-vs-$50 money path)', () => {
    const { riderAwareSingleUnitVisits } = EstimateConverter;
    expect(riderAwareSingleUnitVisits([baitRow, bondRow], 0)).toBe(4);
    expect(riderAwareSingleUnitVisits([baitRow], 0)).toBe(4);
    // True multi-unit plans stay null (rows priced individually).
    const pestRow = { name: 'Pest Control', service: 'pest_control', visitsPerYear: 4 };
    expect(riderAwareSingleUnitVisits([pestRow, baitRow, bondRow], 0)).toBeNull();
    expect(riderAwareSingleUnitVisits([baitRow, bondRow], 1)).toBeNull();
  });

  test('dark-gate + rate guards scan raw engine line items too', () => {
    const engineResult = generateEstimate(termiteInput({ termiteBondTerm: '10yr' }));
    const rawData = { engineInputs: {}, engineResult };
    const prev = process.env.GATE_TERMITE_BOND_OPTION;
    delete process.env.GATE_TERMITE_BOND_OPTION;
    try {
      let status;
      try { assertNoDarkTermiteBondPayload(rawData); } catch (err) { status = err.statusCode || err.status; }
      expect(status).toBe(422);
    } finally {
      process.env.GATE_TERMITE_BOND_OPTION = prev;
    }
    // Gate on: live rates pass; a stale raw bond line fails closed.
    expect(() => assertLiveTermiteBondRates(rawData)).not.toThrow();
    const rawBond = engineResult.lineItems.find((li) => String(li.service).startsWith('termite_bond'));
    rawBond.perApp = 40;
    let status;
    try { assertLiveTermiteBondRates(rawData); } catch (err) { status = err.statusCode || err.status; }
    expect(status).toBe(422);
  });

  test('switcher handles result-shaped raw payloads (result.lineItems is the display source)', () => {
    const engineResult = generateEstimate(termiteInput({ termiteBondTerm: '10yr' }));
    const parsed = { result: engineResult };
    const before = engineResult.summary.recurringAnnualAfterDiscount;
    const outcome = applySelectedTermiteBondToEstimateData(parsed, '1yr');
    expect(outcome).toMatchObject({ ok: true, monthlyDelta: 5, annualDelta: 60, selectedBondTerm: '1yr' });
    const bond = parsed.result.lineItems.find((li) => String(li.service).startsWith('termite_bond'));
    expect(bond).toMatchObject({ bondTerm: '1yr', perApp: 60 });
    expect(parsed.result.summary.recurringAnnualAfterDiscount).toBe(before + 60);
  });
});

// 2026-08-25 bridge audit: bond identity must not depend on lucky strings.
describe('bond term identity (2026-08-25 bridge fixes)', () => {
  const { recurringServicesFromEstimateData } = require('../services/estimate-converter');

  test('a raw termite_bond line with NO bondTerm derives the term key from its name', () => {
    // Older snapshots/agent drafts drop bondTerm; the bare 'termite_bond'
    // key matches no catalog row, so the visit scheduled name-only and the
    // warranty minted at the 1-year default regardless of the term sold.
    const rows = recurringServicesFromEstimateData({
      result: {
        lineItems: [
          { name: 'Termite Bait', service: 'termite_bait', annual: 420, visitsPerYear: 4 },
          { name: 'Termite Bond (5-Year Term)', service: 'termite_bond', annual: 216, visitsPerYear: 4 },
        ],
      },
    });
    const bond = rows.find((r) => String(r.service).startsWith('termite_bond'));
    expect(bond.service).toBe('termite_bond_5yr');
  });

  test('the same term-less bond row in stored AND raw lists still coalesces to ONE service', () => {
    // Normalization must run at the merge choke point: rewriting only the
    // raw lineItems representation split formerly-coalesced duplicates into
    // a bare-bond visit AND a term-keyed bond visit (codex #3485 r5 P1).
    const bondRow = { name: 'Termite Bond (5-Year Term)', service: 'termite_bond', annual: 216, visitsPerYear: 4 };
    const rows = recurringServicesFromEstimateData({
      recurring: { services: [{ ...bondRow }] },
      result: { lineItems: [{ ...bondRow }] },
    });
    const bonds = rows.filter((r) => String(r.service).startsWith('termite_bond'));
    expect(bonds).toHaveLength(1);
    expect(bonds[0].service).toBe('termite_bond_5yr');
  });

  test('alias-keyed stored rows (serviceKey/service_key) normalize and coalesce with raw rows', () => {
    // recurringServiceKey accepts all three key aliases; the choke-point
    // normalizer must too, or the formerly identical rows deduplicate
    // under termite_bond AND termite_bond_5yr and schedule two bond
    // visits (codex #3485 r8 P1).
    const rows = recurringServicesFromEstimateData({
      recurring: { services: [{ name: 'Termite Bond (5-Year Term)', serviceKey: 'termite_bond', annual: 216, visitsPerYear: 4 }] },
      result: { lineItems: [{ name: 'Termite Bond (5-Year Term)', service: 'termite_bond', annual: 216, visitsPerYear: 4 }] },
    });
    const bonds = rows.filter((r) => String(r.service || r.serviceKey || '').startsWith('termite_bond'));
    expect(bonds).toHaveLength(1);
    expect(bonds[0].service || bonds[0].serviceKey).toBe('termite_bond_5yr');
  });

  test('a NAME-ONLY legacy stored bond row coalesces with the keyed raw row', () => {
    // No key field at all — recurringServiceKey would derive a name-based
    // identity that deduplicates separately (codex #3485 r11 P1).
    const rows = recurringServicesFromEstimateData({
      recurring: { services: [{ name: 'Termite Bond (5-Year Term)', annual: 216, visitsPerYear: 4 }] },
      result: { lineItems: [{ name: 'Termite Bond (5-Year Term)', service: 'termite_bond', annual: 216, visitsPerYear: 4 }] },
    });
    const bonds = rows.filter((r) => String(r.service || '').startsWith('termite_bond'));
    expect(bonds).toHaveLength(1);
    expect(bonds[0].service).toBe('termite_bond_5yr');
  });

  test('the term parses from serviceName/service_name label fields too', () => {
    const rows = recurringServicesFromEstimateData({
      result: {
        lineItems: [{ serviceName: 'Termite Bond (10-Year Term)', service: 'termite_bond', annual: 180, visitsPerYear: 4 }],
      },
    });
    const bond = rows.find((r) => String(r.service).startsWith('termite_bond'));
    expect(bond.service).toBe('termite_bond_10yr');
  });

  test('a term-less, name-less bond line stays unrewritten (no guessed term)', () => {
    const rows = recurringServicesFromEstimateData({
      result: { lineItems: [{ name: 'Termite Bond', service: 'termite_bond', annual: 240, visitsPerYear: 4 }] },
    });
    const bond = rows.find((r) => String(r.service).startsWith('termite_bond'));
    expect(bond.service).toBe('termite_bond');
  });

  test('termYearsForVisit prefers durable identity over the label regex', () => {
    const { termYearsForVisit } = sweepPrivate;
    // The LINKED catalog row wins — same precedence as completion identity
    // (service_id first); pre-fix combined promotions could leave a stale
    // snapshot disagreeing with the id (codex #3485 r10 P1).
    expect(termYearsForVisit({
      catalog_service_key: 'termite_bond_5yr',
      service_key_snapshot: 'termite_bond_10yr',
      service_type: 'Termite Bond (1-Year Term)',
    })).toBe(5);
    // Snapshot second, still ahead of the label regex.
    expect(termYearsForVisit({
      service_key_snapshot: 'termite_bond_10yr',
      service_type: 'Termite Bond (1-Year Term)',
    })).toBe(10);
    // Label regex stays the legacy fallback…
    expect(termYearsForVisit({ service_type: 'Termite Bond (10-Year Term)' })).toBe(10);
    // …and the historical 1-year default only applies when NOTHING names a term.
    expect(termYearsForVisit({ service_type: 'Termite Bond' })).toBe(1);
  });

  test('a linked NON-bond catalog row disproves the bond — stale snapshot/label never mint', () => {
    const { termYearsForVisit } = sweepPrivate;
    // A repointed visit (service_id now names quarterly pest) keeps its old
    // snapshot and label; the authoritative link must veto the warranty
    // (pre-push P1), not fall through to the stale evidence.
    expect(termYearsForVisit({
      catalog_service_key: 'pest_general_quarterly',
      service_key_snapshot: 'termite_bond_10yr',
      service_type: 'Termite Bond (10-Year Term)',
    })).toBeNull();
  });

  test('combined bait+bond visits (termite_bait link BY DESIGN) derive the term from the label', () => {
    const { termYearsForVisit } = sweepPrivate;
    // COMBINED_SERVICE_ROUTES links these to the BAIT row — no combined
    // catalog row exists — and the bond term lives only in the name.
    expect(termYearsForVisit({
      catalog_service_key: 'termite_bait',
      service_type: 'Quarterly Termite Bait Station + Termite Bond Service (5-Year Term)',
    })).toBe(5);
    // A PLAIN bait visit is not a bond — even with a stale bond snapshot.
    expect(termYearsForVisit({
      catalog_service_key: 'termite_bait',
      service_key_snapshot: 'termite_bond_1yr',
      service_type: 'Termite Bait Station Service',
    })).toBeNull();
  });

  test('with no link, a NON-bond snapshot vetoes a stale bond label', () => {
    const { termYearsForVisit } = sweepPrivate;
    // Snapshot is the durable identity when the catalog FK is gone; a
    // leftover "Termite Bond" label must not out-vote it (pre-push P1).
    expect(termYearsForVisit({
      service_key_snapshot: 'pest_general_quarterly',
      service_type: 'Termite Bond (10-Year Term)',
    })).toBeNull();
    // The combined bait+bond snapshot keeps its label-derived term.
    expect(termYearsForVisit({
      service_key_snapshot: 'termite_bait',
      service_type: 'Quarterly Termite Bait Station + Termite Bond Service (10-Year Term)',
    })).toBe(10);
  });
});
