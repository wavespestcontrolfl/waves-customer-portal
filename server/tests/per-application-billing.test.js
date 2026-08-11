/**
 * Per-application billing must charge the plan's TRUE per-visit price.
 *
 * T&S audit 2026-07-18 P1: tier plans present a monthly price
 * (billingFrequencyKey 'monthly') but deliver a non-monthly visit count
 * (tree & shrub 6x/4x). Stamping the monthly cadence amount as the
 * per_application_fee / row estimated_price collected visits/12 of the
 * accepted annual (six completions x annual/12 = half). These tests pin the
 * corrected derivation and the T&S follow-up seeding gate.
 */

const {
  perApplicationChargeAmount,
  resolveBillingCadence,
} = require('../services/billing-cadence');
const EstimateConverter = require('../services/estimate-converter');

describe('perApplicationChargeAmount', () => {
  const tsStandardCadence = resolveBillingCadence({
    monthlyRate: 51.75,
    annualRate: 621,
    frequencyKey: 'monthly',
  });

  test('tree & shrub 6x standard: monthly-billed plan charges annual/6 per application, not annual/12', () => {
    expect(tsStandardCadence.amount).toBe(51.75); // the monthly display rate — NOT the visit price
    const amount = perApplicationChargeAmount({
      billingCadence: tsStandardCadence,
      annualRate: 621,
      monthlyRate: 51.75,
      visitsPerYear: 6,
    });
    expect(amount).toBe(103.5);
    // Six completions collect exactly the accepted annual.
    expect(Math.round(amount * 6 * 100) / 100).toBe(621);
  });

  test('tree & shrub 4x light: quarterly-visit plan billed monthly charges annual/4', () => {
    const cadence = resolveBillingCadence({ monthlyRate: 33.33, annualRate: 400, frequencyKey: 'monthly' });
    const amount = perApplicationChargeAmount({
      billingCadence: cadence,
      annualRate: 400,
      monthlyRate: 33.33,
      visitsPerYear: 4,
    });
    expect(amount).toBe(100);
  });

  test('cadence-matched plan (quarterly pest) is byte-identical to the cadence amount', () => {
    const cadence = resolveBillingCadence({ monthlyRate: 32.67, annualRate: 392, frequencyKey: 'quarterly' });
    expect(cadence.amount).toBe(98);
    const amount = perApplicationChargeAmount({
      billingCadence: cadence,
      annualRate: 392,
      monthlyRate: 32.67,
      visitsPerYear: 4,
    });
    expect(amount).toBe(98);
  });

  test('unknown visit count falls back to the cadence amount', () => {
    expect(perApplicationChargeAmount({
      billingCadence: tsStandardCadence,
      annualRate: 621,
      monthlyRate: 51.75,
      visitsPerYear: null,
    })).toBe(51.75);
    expect(perApplicationChargeAmount({
      billingCadence: tsStandardCadence,
      annualRate: 621,
      monthlyRate: 51.75,
      visitsPerYear: 0,
    })).toBe(51.75);
  });

  test('an annual that diverges from monthly x 12 is not the plan annual — derives from the monthly', () => {
    const cadence = resolveBillingCadence({ monthlyRate: 51.75, annualRate: 900, frequencyKey: 'monthly' });
    const amount = perApplicationChargeAmount({
      billingCadence: cadence,
      annualRate: 900, // e.g. includes a one-time line — not the recurring annual
      monthlyRate: 51.75,
      visitsPerYear: 6,
    });
    expect(amount).toBe(103.5); // 51.75 * 12 / 6
  });

  test('no rates at all returns 0, never NaN', () => {
    expect(perApplicationChargeAmount({ visitsPerYear: 6 })).toBe(0);
    expect(perApplicationChargeAmount({})).toBe(0);
  });
});

describe('resolveFirstApplicationAmount — per-application precedence', () => {
  test('explicit amount always wins', () => {
    expect(EstimateConverter.resolveFirstApplicationAmount({
      firstApplicationAmount: 120,
      perApplicationAmount: 103.5,
      billingCadence: { amount: 51.75 },
    })).toBe(120);
  });

  test('per-application amount outranks the cadence fallback', () => {
    expect(EstimateConverter.resolveFirstApplicationAmount({
      firstApplicationAmount: null,
      perApplicationAmount: 103.5,
      billingCadence: { amount: 51.75 },
      monthlyRate: 51.75,
    })).toBe(103.5);
  });

  test('cadence fallback still applies when no per-application amount exists', () => {
    expect(EstimateConverter.resolveFirstApplicationAmount({
      firstApplicationAmount: null,
      billingCadence: { amount: 98 },
      monthlyRate: 32.67,
    })).toBe(98);
  });

  test('allowFallback:false returns 0 regardless (public-accept contract)', () => {
    expect(EstimateConverter.resolveFirstApplicationAmount({
      firstApplicationAmount: null,
      perApplicationAmount: 103.5,
      billingCadence: { amount: 51.75 },
      allowFallback: false,
    })).toBe(0);
  });
});

describe('supportsConverterFollowUpSeeding — lawn series (owner GO 2026-08-10)', () => {
  const { supportsConverterFollowUpSeeding, converterFollowUpSeedingPattern } = EstimateConverter;
  // Real accepted-line shapes from the live defect (2026-08-10): a sold
  // recurring lawn plan booked its reserved first visit and seeded nothing.
  const bimonthlyLine = { name: 'Bi-Monthly Lawn Care Service', service: 'lawn_care', frequency: 'bi_monthly', visits: 6, visitsPerYear: 6 };
  const sixWeekLine = { name: 'Every 6 Weeks Lawn Care Service', service: 'lawn_care', cadence: 'every_6_weeks', frequency: 'every_6_weeks', visits: 9, visitsPerYear: 9 };
  const monthlyLine = { name: 'Monthly Lawn Care Service', service: 'lawn_care', frequency: 'monthly', visitsPerYear: 12 };

  test('all three SOLD lawn tiers seed their series (LAWN_TIERS — quarterly is retired)', () => {
    expect(supportsConverterFollowUpSeeding(bimonthlyLine, {}, 'bimonthly')).toBe(true);
    expect(supportsConverterFollowUpSeeding(sixWeekLine, {}, 'every_6_weeks')).toBe(true);
    expect(supportsConverterFollowUpSeeding(monthlyLine, {}, 'monthly')).toBe(true);
  });

  test('the RETIRED quarterly lawn cadence never seeds (owner 2026-08-04; public accepts 409 it — codex #3349 r2 P2)', () => {
    const quarterlyLine = { name: 'Quarterly Lawn Care Service', service: 'lawn_care', frequency: 'quarterly', visitsPerYear: 4 };
    expect(supportsConverterFollowUpSeeding(quarterlyLine, {}, 'quarterly')).toBe(false);
    expect(converterFollowUpSeedingPattern(quarterlyLine, { service_type: 'Lawn Care' }, null)).toBe(null);
  });

  test('cadence resolves end-to-end from the accepted line, parent row keyed by service_type', () => {
    // The reserved row carries service_type "Lawn Care" — serviceKeyFor must
    // land the lawn_care family from either the line or the row.
    expect(converterFollowUpSeedingPattern(bimonthlyLine, { service_type: 'Lawn Care' }, null)).toBe('bimonthly');
    expect(converterFollowUpSeedingPattern(sixWeekLine, { service_type: 'Lawn Care' }, null)).toBe('every_6_weeks');
  });

  test('a visit count that contradicts the cadence declines rather than guesses', () => {
    expect(supportsConverterFollowUpSeeding({ ...bimonthlyLine, visits: 9, visitsPerYear: 9 }, {}, 'bimonthly')).toBe(false);
    expect(supportsConverterFollowUpSeeding({ ...monthlyLine, visitsPerYear: 6 }, {}, 'monthly')).toBe(false);
  });

  test('lawn and palm follow-ups book flat 60-minute slots on every path (codex duration rounds)', () => {
    const { durationMinutesForRecurringService } = EstimateConverter;
    // The catalog identity links are duration-silent (the lawn rows carry
    // a 45-minute default that contradicts the 60-minute slot authority),
    // so the family default lives in the converter like tree_shrub's.
    expect(durationMinutesForRecurringService({ name: 'Bi-Monthly Lawn Care Service' }, 'bimonthly')).toBe(60);
    expect(durationMinutesForRecurringService({ name: 'Palm Injection', service: 'palm_injection' }, 'semiannual')).toBe(60);
    // An explicit line duration still wins.
    expect(durationMinutesForRecurringService({ name: 'Monthly Lawn Care Service', estimatedDurationMinutes: 90 }, 'monthly')).toBe(90);
  });

  test('COMMERCIAL lawn never collapses into the residential allowlist — office-scheduled via the bell (codex r6 P1)', () => {
    // serviceKeyFor reduces any /lawn/ text to lawn_care, and custom
    // commercial proposals can carry residential-shaped visit counts.
    const commercial = { name: 'Commercial Lawn Care Program', service: 'commercial_lawn', frequency: 'bi_monthly', visits: 6, visitsPerYear: 6 };
    expect(supportsConverterFollowUpSeeding(commercial, {}, 'bimonthly')).toBe(false);
    expect(converterFollowUpSeedingPattern(commercial, { service_type: 'Commercial Lawn Care Program' }, null)).toBe(null);
    // The commercial identity on the PARENT row alone also rejects.
    expect(supportsConverterFollowUpSeeding({ frequency: 'monthly', visitsPerYear: 12 }, { service_type: 'Commercial Lawn Service' }, 'monthly')).toBe(false);
  });

  test('a visit-count-only lawn row beats the accepted PEST plan fallback (codex r11 P1)', () => {
    // Legacy mixed pest+lawn shape: the lawn row carries only
    // visitsPerYear. Inference checks the pest fallback before the visit
    // count, so without the forced-lawn resolution the gate would see
    // 'quarterly' and decline a supported 9-visit lawn line.
    expect(converterFollowUpSeedingPattern({ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9 }, { service_type: 'Lawn Care' }, 'quarterly')).toBe('every_6_weeks');
    expect(converterFollowUpSeedingPattern({ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 6 }, { service_type: 'Lawn Care' }, 'monthly')).toBe('bimonthly');
    expect(converterFollowUpSeedingPattern({ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 12 }, { service_type: 'Lawn Care' }, 'quarterly')).toBe('monthly');
    // Retired 4-visit count maps to nothing and still declines.
    expect(converterFollowUpSeedingPattern({ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 4 }, { service_type: 'Lawn Care' }, 'quarterly')).toBe(null);
    // Prepay mirror records the same cadence the series seeds.
    expect(EstimateConverter.annualPrepayCoverageCadence({ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9 }, 'quarterly')).toBe('every_6_weeks');
  });

  test('lawn prepay coverage rejects contradictory shapes; legacy cadence-only rows keep their inferred cadence (codex r11 P1)', () => {
    const { annualPrepayCoverageCadence } = EstimateConverter;
    // monthly frequency + 6 visits seeds nothing — coverage must not
    // record monthly and let payment-time coverage create six monthly
    // visits.
    expect(annualPrepayCoverageCadence({ service: 'lawn_care', name: 'Lawn Care', frequency: 'monthly', visitsPerYear: 6 }, null)).toBe(EstimateConverter.PREPAY_COVERAGE_INVALID);
    expect(annualPrepayCoverageCadence({ service: 'commercial_lawn', name: 'Commercial Lawn Care', frequency: 'bi_monthly', visitsPerYear: 6 }, null)).toBe(EstimateConverter.PREPAY_COVERAGE_INVALID);
    // Legacy shape without explicit visits keeps its inferred cadence.
    expect(annualPrepayCoverageCadence({ service: 'lawn_care', name: 'Lawn Care', frequency: 'bi_monthly' }, null)).toBe('bimonthly');
    // Matching shape records the seeded cadence.
    expect(annualPrepayCoverageCadence({ service: 'lawn_care', name: 'Bi-Monthly Lawn Care Service', frequency: 'bi_monthly', visitsPerYear: 6 }, null)).toBe('bimonthly');
  });

  test('LEGACY lawn rows without explicit visits keep office scheduling', () => {
    // The lawn billing cadence (monthly) must never seed a 12-visit series
    // for a plan whose visit cadence is unknown — no visits, no series.
    const legacy = { name: 'Lawn Care', service: 'lawn_care' };
    expect(converterFollowUpSeedingPattern({ ...legacy, frequency: 'monthly' }, { service_type: 'Lawn Care' }, null)).toBe(null);
    expect(supportsConverterFollowUpSeeding(legacy, { service_type: 'Lawn Care' }, 'monthly')).toBe(false);
  });
});

describe('supportsConverterFollowUpSeeding — palm injection series (owner ruling 2026-08-11)', () => {
  const { supportsConverterFollowUpSeeding, converterFollowUpSeedingPattern } = EstimateConverter;
  const semiannualLine = { name: 'Palm Injection Program', service: 'palm_injection', frequency: 'semiannual', visits: 2, visitsPerYear: 2 };

  test('semiannual 2x seeds its series', () => {
    expect(supportsConverterFollowUpSeeding(semiannualLine, {}, 'semiannual')).toBe(true);
  });

  test('cadence resolves end-to-end from the accepted line, parent row keyed by service_type', () => {
    expect(converterFollowUpSeedingPattern(semiannualLine, { service_type: 'Palm Injection' }, null)).toBe('semiannual');
  });

  test('quote-based line without an explicit visit count still seeds — semiannual is unambiguous', () => {
    const noVisits = { name: 'Palm Injection Program', service: 'palm_injection', frequency: 'semiannual' };
    expect(supportsConverterFollowUpSeeding(noVisits, {}, 'semiannual')).toBe(true);
  });

  test('a visit count that contradicts the cadence declines rather than guesses', () => {
    expect(supportsConverterFollowUpSeeding({ ...semiannualLine, visits: 4, visitsPerYear: 4 }, {}, 'semiannual')).toBe(false);
  });

  test('a stray non-semiannual cadence declines to office scheduling', () => {
    expect(supportsConverterFollowUpSeeding({ ...semiannualLine, frequency: 'monthly' }, {}, 'monthly')).toBe(false);
    expect(supportsConverterFollowUpSeeding(semiannualLine, {}, 'quarterly')).toBe(false);
  });

  test('the persisted "Palm Tree Injections" alias files as palm, not tree_shrub (codex r8 P1)', () => {
    // The seeder's serviceKeyFor checks tree tokens before palm; the
    // palm-first correction must land the alias in the palm family on
    // every seeding surface — line-keyed and parent-keyed.
    const aliasLine = { name: 'Palm Tree Injections', visitsPerYear: 2 };
    expect(converterFollowUpSeedingPattern(aliasLine, { service_type: 'Palm Tree Injections' }, 'quarterly')).toBe('semiannual');
    expect(supportsConverterFollowUpSeeding({ ...aliasLine, frequency: 'semiannual' }, {}, 'semiannual')).toBe(true);
    // A real tree & shrub line is untouched by the correction.
    expect(supportsConverterFollowUpSeeding({ name: 'Bi-Monthly Tree & Shrub Care Service', visitsPerYear: 6 }, {}, 'bimonthly')).toBe(true);
  });

  test('a VALID semiannual palm cadence spelled only as `cadence` still seeds against a monthly/quarterly plan fallback (codex r9 P1)', () => {
    // inferRecurringPattern never reads `cadence`/`planFrequency` and
    // checks the plan fallback before the visit count — without the
    // agreeing-field force, this valid line would decline.
    const agreeing = { service: 'palm_injection', name: 'Palm Injection', cadence: 'semiannual', visitsPerYear: 2 };
    expect(converterFollowUpSeedingPattern(agreeing, { service_type: 'Palm Injection' }, 'monthly')).toBe('semiannual');
    expect(converterFollowUpSeedingPattern({ ...agreeing, cadence: undefined, plan_frequency: 'semiannual' }, { service_type: 'Palm Injection' }, 'quarterly')).toBe('semiannual');
    expect(EstimateConverter.annualPrepayCoverageCadence(agreeing, 'monthly')).toBe('semiannual');
  });

  test('CONFLICTING visit-count aliases decline in seeding and prepay (mirror of the cadence-conflict rule)', () => {
    // { visitsPerYear: 2, visits: 4 } must not seed whichever alias the
    // reader happens to hit first.
    const palmConflict = { service: 'palm_injection', name: 'Palm Injection', frequency: 'semiannual', visitsPerYear: 2, visits: 4 };
    expect(supportsConverterFollowUpSeeding(palmConflict, {}, 'semiannual')).toBe(false);
    expect(converterFollowUpSeedingPattern({ ...palmConflict, frequency: undefined }, { service_type: 'Palm Injection' }, 'quarterly')).toBe(null);
    expect(EstimateConverter.annualPrepayCoverageCadence(palmConflict, null)).toBe(EstimateConverter.PREPAY_COVERAGE_INVALID);
    const lawnConflict = { service: 'lawn_care', name: 'Bi-Monthly Lawn Care Service', frequency: 'bi_monthly', visitsPerYear: 6, visits: 9 };
    expect(supportsConverterFollowUpSeeding(lawnConflict, {}, 'bimonthly')).toBe(false);
    expect(EstimateConverter.annualPrepayCoverageCadence(lawnConflict, null)).toBe(EstimateConverter.PREPAY_COVERAGE_INVALID);
    // Agreeing duplicate aliases are not a conflict.
    expect(supportsConverterFollowUpSeeding({ ...palmConflict, visits: 2 }, {}, 'semiannual')).toBe(true);
  });

  test('CONFLICTING cadence fields decline — behavior never depends on field precedence (codex r10 P1)', () => {
    // frequency 'semiannual' left beside a corrected cadence 'monthly'
    // (and the reverse) both decline: the force stands down and the
    // gate/prepay contradiction checks refuse the row.
    const conflictA = { service: 'palm_injection', name: 'Palm Injection', frequency: 'semiannual', cadence: 'monthly', visitsPerYear: 2 };
    const conflictB = { service: 'palm_injection', name: 'Palm Injection', frequency: 'monthly', cadence: 'semiannual', visitsPerYear: 2 };
    expect(converterFollowUpSeedingPattern(conflictA, { service_type: 'Palm Injection' }, null)).toBe(null);
    expect(converterFollowUpSeedingPattern(conflictB, { service_type: 'Palm Injection' }, null)).toBe(null);
    expect(EstimateConverter.annualPrepayCoverageCadence(conflictA, null)).toBe(EstimateConverter.PREPAY_COVERAGE_INVALID);
    expect(EstimateConverter.annualPrepayCoverageCadence(conflictB, null)).toBe(EstimateConverter.PREPAY_COVERAGE_INVALID);
    // Duplicate spellings of the SAME cadence are not a conflict.
    const agreeing = { service: 'palm_injection', name: 'Palm Injection', frequency: 'semiannual', cadence: 'semiannual', visitsPerYear: 2 };
    expect(converterFollowUpSeedingPattern(agreeing, { service_type: 'Palm Injection' }, 'monthly')).toBe('semiannual');
  });

  test('a POPULATED invalid visit count declines — never read as a legacy count-less line (codex r18 P1)', () => {
    // { visitsPerYear: 0 } (or non-numeric text) is malformed data, not an
    // absent count: the count-less compatibility case must not seed from it.
    const zeroCount = { service: 'palm_injection', name: 'Palm Injection', frequency: 'semiannual', visitsPerYear: 0 };
    expect(supportsConverterFollowUpSeeding(zeroCount, {}, 'semiannual')).toBe(false);
    expect(EstimateConverter.annualPrepayCoverageCadence(zeroCount, null)).toBe(EstimateConverter.PREPAY_COVERAGE_INVALID);
    const textCount = { service: 'palm_injection', name: 'Palm Injection', frequency: 'semiannual', visits: 'two' };
    expect(supportsConverterFollowUpSeeding(textCount, {}, 'semiannual')).toBe(false);
    // An invalid alias BESIDE a valid count is still malformed (codex r18
    // P1 follow-up): { visitsPerYear: 2, visits: 0 } must not seed or
    // force off its first valid alias, and the lawn exact-count gate must
    // not pass { visitsPerYear: 6, visits: 0 } either.
    const mixedPalm = { service: 'palm_injection', name: 'Palm Injection', visitsPerYear: 2, visits: 0 };
    expect(supportsConverterFollowUpSeeding(mixedPalm, {}, 'semiannual')).toBe(false);
    expect(converterFollowUpSeedingPattern(mixedPalm, { service_type: 'Palm Injection' }, 'quarterly')).toBe(null);
    expect(EstimateConverter.annualPrepayCoverageCadence(mixedPalm, null)).toBe(EstimateConverter.PREPAY_COVERAGE_INVALID);
    const mixedLawn = { service: 'lawn_care', name: 'Bi-Monthly Lawn Care Service', frequency: 'bi_monthly', visitsPerYear: 6, visits: 0 };
    expect(supportsConverterFollowUpSeeding(mixedLawn, {}, 'bimonthly')).toBe(false);
    // A genuinely ABSENT count still seeds (semiannual is unambiguous).
    const absent = { service: 'palm_injection', name: 'Palm Injection', frequency: 'semiannual' };
    expect(supportsConverterFollowUpSeeding(absent, {}, 'semiannual')).toBe(true);
  });

  test('snake_case visit-count spellings count everywhere — reader AND conflict check (codex r15 pre-push P0)', () => {
    // A persisted { visits_per_year: 2 } palm line must seed its program;
    // treated as count-less it would decline to office scheduling and the
    // name-only row misfiles to the one-time identity at completion.
    const snakePalm = { service: 'palm_injection', name: 'Palm Injection', visits_per_year: 2 };
    expect(converterFollowUpSeedingPattern(snakePalm, { service_type: 'Palm Injection' }, 'quarterly')).toBe('semiannual');
    expect(supportsConverterFollowUpSeeding(snakePalm, {}, 'semiannual')).toBe(true);
    // Cross-spelling conflicts are conflicts (reader and conflict check
    // share one alias list).
    expect(supportsConverterFollowUpSeeding({ ...snakePalm, visits: 4 }, {}, 'semiannual')).toBe(false);
    const snakeLawn = { service: 'lawn_care', name: 'Bi-Monthly Lawn Care Service', frequency: 'bi_monthly', apps_per_year: 6 };
    expect(supportsConverterFollowUpSeeding(snakeLawn, {}, 'bimonthly')).toBe(true);
  });

  test('an UNRECOGNIZED populated cadence field declines — never treated as cadence-less (pre-push r12 P1)', () => {
    // normalizeRecurringPattern can't read 'every_4_months'; filtered out
    // as absent, the forced palm/lawn branches would seed from the visit
    // count and override a cadence we couldn't even parse.
    const palmUnknown = { service: 'palm_injection', name: 'Palm Injection', frequency: 'every_4_months', visitsPerYear: 2 };
    expect(converterFollowUpSeedingPattern(palmUnknown, { service_type: 'Palm Injection' }, null)).toBe(null);
    expect(EstimateConverter.annualPrepayCoverageCadence(palmUnknown, null)).toBe(EstimateConverter.PREPAY_COVERAGE_INVALID);
    // Name deliberately cadence-less: with a null plan fallback, inference
    // resolves straight from the visit count — the lawn GATE's field check
    // is the only decline on this route.
    const lawnUnknown = { service: 'lawn_care', name: 'Lawn Care Service', frequency: 'every_4_months', visits: 6 };
    expect(converterFollowUpSeedingPattern(lawnUnknown, { service_type: 'Lawn Care' }, null)).toBe(null);
    expect(EstimateConverter.annualPrepayCoverageCadence(lawnUnknown, null)).toBe(EstimateConverter.PREPAY_COVERAGE_INVALID);
  });

  test('the duplicate guard receives a palm-canonical serviceType for alias labels (codex r10 P1)', () => {
    const { guardServiceTypeFor } = EstimateConverter;
    // An adopted alias label would family-match an unrelated ACTIVE Tree
    // & Shrub series through the seeder's tree-first matcher — the guard
    // gets the canonical palm label instead.
    expect(guardServiceTypeFor('Palm Tree Injections')).toBe('Palm Injection');
    // Real palm and non-palm labels pass through untouched.
    expect(guardServiceTypeFor('Palm Injection')).toBe('Palm Injection');
    expect(guardServiceTypeFor('Bi-Monthly Tree & Shrub Care Service')).toBe('Bi-Monthly Tree & Shrub Care Service');
    expect(guardServiceTypeFor('Quarterly Pest Control Service')).toBe('Quarterly Pest Control Service');
    expect(guardServiceTypeFor(null)).toBe(null);
  });

  test('an adopted "Palm Tree Injections" row matches the PALM line, not a Tree & Shrub sibling (codex r9 P1)', () => {
    const { recurringServiceForScheduledRow } = EstimateConverter;
    const tsLine = { name: 'Bi-Monthly Tree & Shrub Care Service', frequency: 'bi_monthly', visitsPerYear: 6 };
    const palmLine = { name: 'Palm Injection', service: 'palm_injection', visitsPerYear: 2 };
    const picked = recurringServiceForScheduledRow([tsLine, palmLine], { service_type: 'Palm Tree Injections' });
    expect(picked).toBe(palmLine);
    // A real T&S row still matches the T&S line.
    expect(recurringServiceForScheduledRow([tsLine, palmLine], { service_type: 'Tree & Shrub Care' })).toBe(tsLine);
  });

  test('"Palmetto" is NOT palm — the bare /palm/ substring hit declines on every surface (codex r8 P1)', () => {
    const palmetto = { service: 'pest_initial_palmetto_knockdown', name: 'Palmetto Roach Knockdown', visitsPerYear: 2 };
    expect(converterFollowUpSeedingPattern(palmetto, { service_type: 'Palmetto Roach Knockdown' }, 'quarterly')).toBe(null);
    expect(supportsConverterFollowUpSeeding(palmetto, {}, 'semiannual')).toBe(false);
    // …and never seeds a quarterly PEST series via a remap either.
    expect(supportsConverterFollowUpSeeding(palmetto, {}, 'quarterly')).toBe(false);
    expect(EstimateConverter.annualPrepayCoverageCadence(palmetto, 'quarterly')).not.toBe('semiannual');
  });

  test('COMMERCIAL palm lines never seed or force — office-scheduled (codex r6 P1)', () => {
    const commercial = { name: 'Commercial Palm Injection', service: 'palm_injection', visitsPerYear: 2 };
    expect(converterFollowUpSeedingPattern(commercial, { service_type: 'Commercial Palm Injection' }, 'quarterly')).toBe(null);
    expect(supportsConverterFollowUpSeeding({ ...commercial, frequency: 'semiannual' }, {}, 'semiannual')).toBe(false);
  });

  test('builder palm line (visitsPerYear 2, NO frequency) beats the plan fallback — forced semiannual (codex #3349 P1)', () => {
    // estimate-public's palm supplement carries no frequency field, so
    // without the forced rule the accepted PLAN's cadence (quarterly here)
    // would win inference and the semiannual gate would seed nothing.
    const builderLine = { service: 'palm_injection', name: 'Palm Injection', visitsPerYear: 2 };
    expect(converterFollowUpSeedingPattern(builderLine, { service_type: 'Palm Injection' }, 'quarterly')).toBe('semiannual');
    expect(converterFollowUpSeedingPattern(builderLine, { service_type: 'Palm Injection' }, 'monthly')).toBe('semiannual');
  });

  test('the forced rule keys on EXACTLY 2 visits — other counts fall through to inference and decline', () => {
    const fourVisits = { service: 'palm_injection', name: 'Palm Injection', visitsPerYear: 4 };
    expect(converterFollowUpSeedingPattern(fourVisits, { service_type: 'Palm Injection' }, 'quarterly')).toBe(null);
  });

  test('annual-prepay coverage mirrors the palm validation — contradictory or commercial palm records NO cadence (pre-push P1)', () => {
    const { annualPrepayCoverageCadence } = EstimateConverter;
    // The seeding gate refused monthly + 2 visits; the prepay term must
    // not record the refused cadence (payment-time coverage would seed
    // monthly-spaced visits over an office-scheduled program).
    expect(annualPrepayCoverageCadence({ service: 'palm_injection', name: 'Palm Injection', frequency: 'monthly', visitsPerYear: 2 }, null)).toBe(EstimateConverter.PREPAY_COVERAGE_INVALID);
    expect(annualPrepayCoverageCadence({ service: 'palm_injection', name: 'Palm Injection', frequency: 'semiannual', visitsPerYear: 4 }, null)).toBe(EstimateConverter.PREPAY_COVERAGE_INVALID);
    expect(annualPrepayCoverageCadence({ service: 'palm_injection', name: 'Commercial Palm Injection', visitsPerYear: 2 }, null)).toBe(EstimateConverter.PREPAY_COVERAGE_INVALID);
    // Valid palm shapes still record semiannual.
    expect(annualPrepayCoverageCadence({ service: 'palm_injection', name: 'Palm Injection', visitsPerYear: 2 }, 'quarterly')).toBe('semiannual');
    expect(annualPrepayCoverageCadence({ service: 'palm_injection', name: 'Palm Injection', frequency: 'semiannual', visitsPerYear: 2 }, null)).toBe('semiannual');
  });

  test('an explicit cadence FIELD beats the forced rule — contradictory data declines, explicit semiannual still seeds (codex r4 P1)', () => {
    // monthly + 2 visits is contradictory: normal validation must decline
    // it to office scheduling, never override to semiannual.
    const contradictory = { service: 'palm_injection', name: 'Palm Injection', frequency: 'monthly', visitsPerYear: 2 };
    expect(converterFollowUpSeedingPattern(contradictory, { service_type: 'Palm Injection' }, null)).toBe(null);
    expect(converterFollowUpSeedingPattern({ ...contradictory, frequency: 'quarterly' }, { service_type: 'Palm Injection' }, null)).toBe(null);
    // An explicit semiannual field takes the normal inference path and
    // still resolves — the force is only for cadence-less builder lines.
    const explicit = { service: 'palm_injection', name: 'Palm Injection', frequency: 'semiannual', visitsPerYear: 2 };
    expect(converterFollowUpSeedingPattern(explicit, { service_type: 'Palm Injection' }, null)).toBe('semiannual');
    // ALL persisted cadence-field spellings count — `cadence` included
    // (codex r7 P1): a monthly-cadence 2-visit palm row is contradictory
    // and declines, never forced.
    const cadenceSpelled = { service: 'palm_injection', name: 'Palm Injection', cadence: 'monthly', visitsPerYear: 2 };
    expect(converterFollowUpSeedingPattern(cadenceSpelled, { service_type: 'Palm Injection' }, null)).toBe(null);
    // Snake-case plan_frequency counts too (codex r8 P1 — the persisted
    // spelling recurringServiceCadenceKey already reads).
    const snakeSpelled = { service: 'palm_injection', name: 'Palm Injection', plan_frequency: 'monthly', visitsPerYear: 2 };
    expect(converterFollowUpSeedingPattern(snakeSpelled, { service_type: 'Palm Injection' }, null)).toBe(null);
    expect(EstimateConverter.annualPrepayCoverageCadence(snakeSpelled, null)).toBe(EstimateConverter.PREPAY_COVERAGE_INVALID);
  });
});

describe('supportsConverterFollowUpSeeding — mosquito series (owner 2026-07-27)', () => {
  const { supportsConverterFollowUpSeeding, converterFollowUpSeedingPattern } = EstimateConverter;
  const SEASONAL = 'seasonal_feb_oct';
  const seasonalRow = { name: 'Seasonal Mosquito Program (9 visits)', service: 'mosquito', visitsPerYear: 9 };
  const monthlyRow = { name: 'Monthly Mosquito Program (12 visits)', service: 'mosquito', visitsPerYear: 12 };

  test('monthly 12x seeds its series', () => {
    // Already live and bookable before this shipped: a sold plan booked visit 1
    // and never created the other 11.
    expect(supportsConverterFollowUpSeeding(monthlyRow, {}, 'monthly')).toBe(true);
  });

  test('seasonal 9x seeds only on the explicit seasonal cadence', () => {
    expect(supportsConverterFollowUpSeeding(seasonalRow, {}, SEASONAL)).toBe(true);
    // Numeric inference resolves 9 visits to bimonthly; seeding that would be
    // the wrong cadence AND the wrong dates, so it must decline.
    expect(supportsConverterFollowUpSeeding(seasonalRow, {}, 'bimonthly')).toBe(false);
    expect(supportsConverterFollowUpSeeding(seasonalRow, {}, 'every_6_weeks')).toBe(false);
  });

  test('a visit count that contradicts the cadence declines rather than guesses', () => {
    expect(supportsConverterFollowUpSeeding({ ...seasonalRow }, {}, 'monthly')).toBe(false);
    expect(supportsConverterFollowUpSeeding({ ...monthlyRow, visitsPerYear: 9 }, {}, SEASONAL)).toBe(true);
    expect(supportsConverterFollowUpSeeding({ ...monthlyRow, visitsPerYear: 6 }, {}, 'monthly')).toBe(false);
  });

  test('cadence resolution picks the seasonal walk for a 9-visit mosquito line', () => {
    // End-to-end through inference: the seasonal label matches no cadence text,
    // so generic inference would resolve this line to 'bimonthly'.
    expect(converterFollowUpSeedingPattern(seasonalRow, {}, null)).toBe(SEASONAL);
    expect(converterFollowUpSeedingPattern(monthlyRow, {}, null)).toBe('monthly');
  });

  test('a stray cadence field on a 9-visit mosquito line cannot suppress the series', () => {
    // Inference reads cadence FIELDS before anything else, so any legacy or
    // copied frequency would win and then be rejected by the gate — leaving the
    // plan with NO series, the exact bug this lane fixes (pre-push P1 r3).
    // Nine visits at any other cadence is wrong by construction.
    for (const frequency of ['every_6_weeks', 'bimonthly', 'monthly', 'quarterly', '9x']) {
      expect(converterFollowUpSeedingPattern({ ...seasonalRow, frequency }, {}, null)).toBe(SEASONAL);
    }
    expect(converterFollowUpSeedingPattern({ ...seasonalRow, recurring_pattern: 'bimonthly' }, {}, null))
      .toBe(SEASONAL);
  });

  test('annual-prepay coverage records the SAME cadence the series seeds (pre-push P0 r4)', () => {
    // estimate-public's seasonal9 tier stamps frequencyKey 'every_6_weeks';
    // raw inference returns that — a cadence the prepay layer SUPPORTS — while
    // the series seeds seasonal_feb_oct. A term recording 42-day coverage over
    // a seasonal series would refresh mismatched winter visits; the converter
    // instead resolves seasonal here and fails the prepay closed (422).
    const { annualPrepayCoverageCadence } = EstimateConverter;
    expect(annualPrepayCoverageCadence({ ...seasonalRow, frequency: 'every_6_weeks' }, 'every_6_weeks')).toBe(SEASONAL);
    expect(annualPrepayCoverageCadence(seasonalRow, null)).toBe(SEASONAL);
    // Monthly mosquito and T&S 9x keep their real, supported cadences.
    expect(annualPrepayCoverageCadence(monthlyRow, null)).toBe('monthly');
    expect(annualPrepayCoverageCadence({ service: 'tree_shrub', frequency: 'every_6_weeks', visitsPerYear: 9 }, null)).toBe('every_6_weeks');
  });

  test('the forced seasonal resolution is scoped to mosquito', () => {
    // T&S also has a 9-visit program; it must keep its own 42-day cadence.
    expect(converterFollowUpSeedingPattern(
      { service: 'tree_shrub', frequency: 'every_6_weeks', visitsPerYear: 9 }, {}, null,
    )).toBe('every_6_weeks');
  });

  test('non-mosquito services are unaffected by the seasonal fallback', () => {
    expect(converterFollowUpSeedingPattern(
      { name: 'Enhanced Tree & Shrub Care Service', service: 'tree_shrub', visitsPerYear: 9 }, {}, null,
    )).not.toBe(SEASONAL);
  });
});

describe('supportsConverterFollowUpSeeding — tree & shrub series (six-visit mandate)', () => {
  const { supportsConverterFollowUpSeeding } = EstimateConverter;
  const standardRow = {
    name: 'Bi-Monthly Tree & Shrub Care Service',
    frequency: 'bi_monthly',
    visitsPerYear: 6,
  };
  const lightRow = {
    name: 'Quarterly Tree & Shrub Care Service',
    frequency: 'quarterly',
    visitsPerYear: 4,
  };

  test('6x standard (bimonthly) seeds its series', () => {
    expect(supportsConverterFollowUpSeeding(standardRow, {}, 'bimonthly')).toBe(true);
  });

  test('4x light (quarterly) seeds its series', () => {
    expect(supportsConverterFollowUpSeeding(lightRow, {}, 'quarterly')).toBe(true);
  });

  test('visit count missing still seeds for the restamped catalog cadences', () => {
    expect(supportsConverterFollowUpSeeding(
      { name: 'Bi-Monthly Tree & Shrub Care Service', frequency: 'bi_monthly' }, {}, 'bimonthly',
    )).toBe(true);
  });

  test('legacy 9-visit rows WITHOUT the every_6_weeks frequency still do NOT seed via bimonthly inference', () => {
    // Visit-count inference maps 9 visits to 'bimonthly'; seeding that would
    // schedule 2-month gaps for a 6-week program. Scheduling stays manual.
    expect(supportsConverterFollowUpSeeding(
      { name: 'Every 6 Weeks Tree & Shrub Care Service', visitsPerYear: 9 }, {}, 'bimonthly',
    )).toBe(false);
  });

  test('un-retired 9x Enhanced (every_6_weeks + 9 visits) seeds its series', () => {
    expect(supportsConverterFollowUpSeeding(
      { name: 'Enhanced Tree & Shrub Care Service', frequency: 'every_6_weeks', visitsPerYear: 9 }, {}, 'every_6_weeks',
    )).toBe(true);
  });

  test('every_6_weeks without the explicit 9-visit stamp does NOT seed', () => {
    expect(supportsConverterFollowUpSeeding(
      { name: 'Enhanced Tree & Shrub Care Service', frequency: 'every_6_weeks' }, {}, 'every_6_weeks',
    )).toBe(false);
  });

  test('non-T&S behavior unchanged: pest quarterly seeds, pest bimonthly does not', () => {
    expect(supportsConverterFollowUpSeeding({ name: 'Quarterly Pest Control' }, {}, 'quarterly')).toBe(true);
    expect(supportsConverterFollowUpSeeding({ name: 'Quarterly Pest Control' }, {}, 'bimonthly')).toBe(false);
  });
});

describe('durationMinutesForRecurringService — tree & shrub', () => {
  test('T&S follow-ups book the flat 60-minute slot (matches estimate-slot-availability)', () => {
    expect(EstimateConverter.durationMinutesForRecurringService(
      { name: 'Bi-Monthly Tree & Shrub Care Service' }, 'bimonthly', {},
    )).toBe(60);
  });

  test('explicit duration still wins', () => {
    expect(EstimateConverter.durationMinutesForRecurringService(
      { name: 'Bi-Monthly Tree & Shrub Care Service', estimatedDurationMinutes: 90 }, 'bimonthly', {},
    )).toBe(90);
  });
});

describe('termite bait per-application billing (owner 2026-07-20)', () => {
  const { supportsConverterFollowUpSeeding } = EstimateConverter;
  const { inferFrequencyKeyFromEstimateData } = require('../services/billing-cadence');

  // The persisted recurring row as the v1 mapper now emits it — the pricer's
  // visitsPerYear/perApp forwarded onto the line as visitsPerYear/perTreatment.
  const newTermiteRow = {
    name: 'Termite Bait', service: 'termite_bait', mo: 35, monthly: 35,
    perTreatment: 105, visitsPerYear: 4,
  };
  // Pre-change payloads carry the flat monthly only.
  const legacyTermiteRow = { name: 'Termite Bait', service: 'termite_bait', mo: 35, monthly: 35 };
  const estimateDataWith = (row) => ({ result: { recurring: { services: [row] } } });

  test('new payload infers a quarterly billing cadence from the persisted visitsPerYear', () => {
    expect(inferFrequencyKeyFromEstimateData(estimateDataWith(newTermiteRow))).toBe('quarterly');
  });

  test('legacy payload infers nothing — the flat-monthly fallback is preserved byte-identically', () => {
    expect(inferFrequencyKeyFromEstimateData(estimateDataWith(legacyTermiteRow))).toBeNull();
  });

  test('quarterly cadence charges the exact per-application price: $420/yr -> $105/application', () => {
    const cadence = resolveBillingCadence({
      monthlyRate: 35,
      annualRate: 420,
      frequencyKey: null,
      estimateData: estimateDataWith(newTermiteRow),
    });
    expect(cadence.frequencyKey).toBe('quarterly');
    expect(cadence.amount).toBe(105);
    const amount = perApplicationChargeAmount({
      billingCadence: cadence, annualRate: 420, monthlyRate: 35, visitsPerYear: 4,
    });
    expect(amount).toBe(105);
    // Four completions collect exactly the accepted annual — the flat-monthly
    // fee stamped before this change collected 4 x $35 = $140 of the $420.
    expect(Math.round(amount * 4 * 100) / 100).toBe(420);
  });

  test('standalone termite quarterly seeds its follow-up series; legacy pattern-less rows do not', () => {
    expect(supportsConverterFollowUpSeeding(newTermiteRow, {}, 'quarterly')).toBe(true);
    expect(supportsConverterFollowUpSeeding(legacyTermiteRow, {}, 'monthly')).toBe(false);
    expect(supportsConverterFollowUpSeeding(newTermiteRow, {}, 'monthly')).toBe(false);
    // Codex P2 (#2911): a legacy row can reach the gate with pattern
    // 'quarterly' inherited from the accept flow's selected/inferred
    // frequency rather than from the row itself — the persisted explicit
    // visits are the seeding license, not the pattern.
    expect(supportsConverterFollowUpSeeding(legacyTermiteRow, {}, 'quarterly')).toBe(false);
  });

  test('a monthly/bimonthly PLAN fallback cannot suppress the termite series — explicit visits win (codex r3 P1)', () => {
    const { converterFollowUpSeedingPattern } = EstimateConverter;
    // Monthly pest + termite: the plan-level fallback used to win the
    // seeder's text-candidate loop before visits were read, returning
    // 'monthly' and seeding nothing for the quarterly termite program.
    expect(converterFollowUpSeedingPattern(newTermiteRow, { service_type: 'Termite Bait' }, 'monthly')).toBe('quarterly');
    expect(converterFollowUpSeedingPattern(newTermiteRow, { service_type: 'Termite Bait' }, 'bimonthly')).toBe('quarterly');
    // Legacy rows (no explicit visits) keep fallback semantics and stay
    // unseeded either way.
    expect(converterFollowUpSeedingPattern(legacyTermiteRow, { service_type: 'Termite Bait' }, 'monthly')).toBeNull();
    // Non-termite services keep the fallback semantics unchanged.
    expect(converterFollowUpSeedingPattern({ name: 'Quarterly Pest Control' }, { service_type: 'Quarterly Pest Control' }, 'quarterly')).toBe('quarterly');
  });
});
