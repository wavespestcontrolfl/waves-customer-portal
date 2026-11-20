// Whole-home rodent exclusion (GATE_EXCLUSION_WHOLE_HOME, owner 2026-11-19): a home-size
// minimum replaces the job floor and the 1-year re-entry guarantee is in the price.
// Gate off, or a spot seal, must stay exactly as it was.
const {
  generateEstimate,
  priceRodentExclusionV2,
  priceRodentGuarantee,
} = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { resolveOneTimeServiceCopy } = require('../services/estimate-one-time-copy');
const { normalizeOneTimeBreakdown } = require('../routes/estimate-public');
const { exclusionWholeHomeLive } = require('../config/feature-gates');
const { SPECIALTY } = require('../services/pricing-engine/constants');

const BULLET = 'Includes a 1-year re-entry guarantee: if a rodent gets back in through the work we sealed, Waves reseals and traps at no extra charge.';

function withGate(value, fn) {
  const prior = process.env.GATE_EXCLUSION_WHOLE_HOME;
  if (value === undefined) delete process.env.GATE_EXCLUSION_WHOLE_HOME;
  else process.env.GATE_EXCLUSION_WHOLE_HOME = value;
  try { return fn(); } finally {
    if (prior === undefined) delete process.env.GATE_EXCLUSION_WHOLE_HOME;
    else process.env.GATE_EXCLUSION_WHOLE_HOME = prior;
  }
}

const gateOn = (fn) => withGate('true', fn);

function baseInput(overrides = {}) {
  return {
    homeSqFt: 2000,
    stories: 1,
    lotSqFt: 10000,
    propertyType: 'single_family',
    zone: 'A',
    features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
    ...overrides,
  };
}

const GUARANTEE_ELIGIBLE = {
  trappingCompleted: true,
  exclusionCompleted: true,
  sanitationCompletedOrPhotoBaseline: true,
  noActivityAfterFinalTrapCheck: true,
};

describe('GATE_EXCLUSION_WHOLE_HOME reader', () => {
  test('reads at call time and only for exactly true', () => {
    expect(withGate(undefined, exclusionWholeHomeLive)).toBe(false);
    expect(withGate('1', exclusionWholeHomeLive)).toBe(false);
    expect(withGate('TRUE', exclusionWholeHomeLive)).toBe(false);
    expect(withGate('true', exclusionWholeHomeLive)).toBe(true);
  });
});

describe('priceRodentExclusionV2 whole-home seal', () => {
  const spot = { standardWireMeshPoints: 2, waiveInspection: true };

  test('without a whole-home pick the result is a spot seal, gate on or off', () => {
    const plain = withGate(undefined, () => priceRodentExclusionV2({ ...spot, homeSqFt: 3000 }));
    expect(plain.includesReentryGuarantee).toBeUndefined();
    expect(plain.price).toBe(195);
    expect(gateOn(() => priceRodentExclusionV2({ ...spot, homeSqFt: 3000 }))).toEqual(plain);
  });

  test('the pricer reads no gate: the engine decides it once (a stored whole-home quote prices on after a rollback)', () => {
    const asked = withGate(undefined, () => priceRodentExclusionV2({ ...spot, sealScope: 'whole_home', homeSqFt: 3000 }));
    expect(asked).toMatchObject({ price: 895, includesReentryGuarantee: true });
  });

  test('gate on, spot seal (default or explicit): unchanged, no guarantee flag', () => {
    const plain = withGate(undefined, () => priceRodentExclusionV2(spot));
    gateOn(() => {
      expect(priceRodentExclusionV2(spot)).toEqual(plain);
      expect(priceRodentExclusionV2({ ...spot, sealScope: 'spot', homeSqFt: 3000 })).toEqual(plain);
    });
  });

  test.each([
    [1200, 395, 199],
    [1500, 395, 199],
    [1501, 595, 199],
    [2500, 595, 199],
    [2501, 895, 249],
    [4000, 895, 249],
    [4001, 1295, 299],
  ])('home of %i sq ft: minimum %i, guarantee renewal %i', (homeSqFt, minimum, renewal) => {
    gateOn(() => {
      const result = priceRodentExclusionV2({ ...spot, sealScope: 'whole_home', homeSqFt });
      expect(result.price).toBe(minimum);
      expect(result.floor).toBe(minimum);
      expect(result).toMatchObject({
        sealScope: 'whole_home',
        includesReentryGuarantee: true,
        reentryGuaranteeMonths: 12,
        guaranteeRenewalPrice: renewal,
      });
      // The renewal price is the tier priceRodentGuarantee charges for the same home.
      expect(priceRodentGuarantee({ homeSqFt, equivalentExclusionPoints: result.equivalentExclusionPoints }).price).toBe(renewal);
      const minimumRow = result.lineItems.find((li) => li.component === 'whole_home_minimum');
      expect(minimumRow.label).toBe('Rodent Exclusion — Whole-home seal minimum');
      expect(result.lineItems.reduce((sum, li) => sum + li.price, 0)).toBe(minimum);
      expect(result.lineItems.every((li) => li.includesReentryGuarantee === true && li.guaranteeRenewalPrice === renewal)).toBe(true);
    });
  });

  test('items above the minimum keep the item total and add no minimum row', () => {
    gateOn(() => {
      const result = priceRodentExclusionV2({
        standardWireMeshPoints: 10, advancedWireMeshPoints: 2, sealScope: 'whole_home', homeSqFt: 1200, waiveInspection: true,
      });
      expect(result.price).toBe(10 * 75 + 2 * 150);
      expect(result.lineItems.map((li) => li.component)).toEqual(['wire_mesh_points']);
      expect(result.includesReentryGuarantee).toBe(true);
    });
  });

  test('an all-zero whole-home request still quotes its minimum as a row, plus the inspect fee unless waived', () => {
    gateOn(() => {
      const result = priceRodentExclusionV2({ sealScope: 'whole_home', homeSqFt: 2200 });
      expect(result.lineItems.map((li) => [li.component, li.price])).toEqual([
        ['whole_home_minimum', 595],
        ['inspect_fee', 75],
      ]);
      expect(result.price).toBe(670);
    });
  });

  test('the minimum table is the Settings-hydrated one: a changed bracket changes the quote', () => {
    const original = SPECIALTY.exclusion.minimumsByHomeSqFt;
    try {
      // The shape db-bridge hydrates from onetime_exclusion.minimums_by_home_sqft ('Infinity' becomes Infinity).
      SPECIALTY.exclusion.minimumsByHomeSqFt = [
        { maxSqFt: 1800, minimum: 450, customRecommended: false },
        { maxSqFt: Infinity, minimum: 1400, customRecommended: false },
      ];
      gateOn(() => {
        expect(priceRodentExclusionV2({ ...spot, sealScope: 'whole_home', homeSqFt: 1700 }).price).toBe(450);
        expect(priceRodentExclusionV2({ ...spot, sealScope: 'whole_home', homeSqFt: 9000 }).price).toBe(1400);
      });
    } finally {
      SPECIALTY.exclusion.minimumsByHomeSqFt = original;
    }
    gateOn(() => {
      expect(priceRodentExclusionV2({ ...spot, sealScope: 'whole_home', homeSqFt: 1700 }).price).toBe(595);
    });
  });

  test('the renewal price follows the home tier (stories, equivalent points, mesh)', () => {
    gateOn(() => {
      const twoStory = priceRodentExclusionV2({ sealScope: 'whole_home', homeSqFt: 1800, stories: 2, waiveInspection: true });
      expect(twoStory.guaranteeRenewalPrice).toBe(249);
      const manyPoints = priceRodentExclusionV2({ sealScope: 'whole_home', homeSqFt: 1800, standardWireMeshPoints: 16, waiveInspection: true });
      expect(manyPoints.guaranteeRenewalPrice).toBe(299);
    });
  });
});

describe('estimate engine with a whole-home exclusion', () => {
  const exclusion = (extra = {}) => ({ pricingVersion: 'v2', standardWireMeshPoints: 2, waiveInspection: true, ...extra });

  test('gate off: a new whole-home request is refused (fail closed), never priced as a spot seal', () => {
    withGate(undefined, () => {
      let error;
      try { generateEstimate(baseInput({ services: { exclusion: exclusion({ sealScope: 'whole_home' }) } })); } catch (err) { error = err; }
      expect(error).toMatchObject({ statusCode: 400, code: 'EXCLUSION_WHOLE_HOME_GATED', failClosed: true });
      expect(error.message).toMatch(/Choose Spot seal/);
    });
  });

  test('gate off: a request with no whole-home pick is unchanged', () => {
    const plain = withGate(undefined, () => generateEstimate(baseInput({ services: { exclusion: exclusion() } })));
    const spot = withGate(undefined, () => generateEstimate(baseInput({ services: { exclusion: exclusion({ sealScope: 'spot' }) } })));
    expect(spot.lineItems).toEqual(plain.lineItems);
    expect(plain.lineItems.some((li) => li.includesReentryGuarantee)).toBe(false);
  });

  test('gate off: a stored estimate re-priced as sold keeps its whole-home terms', () => {
    withGate(undefined, () => {
      const replay = generateEstimate(baseInput({
        savedEstimateReplay: true,
        services: { exclusion: exclusion({ sealScope: 'whole_home', homeSqFt: 2000 }) },
      }));
      const rows = replay.lineItems.filter((li) => li.service === 'rodent_exclusion');
      expect(rows.reduce((sum, li) => sum + li.price, 0)).toBe(595);
      expect(rows.every((li) => li.includesReentryGuarantee === true)).toBe(true);
    });
  });

  test('gate on: home size comes from the request, else the property footprint', () => {
    gateOn(() => {
      const fromRequest = generateEstimate(baseInput({ services: { exclusion: exclusion({ sealScope: 'whole_home', homeSqFt: 3200 }) } }));
      expect(fromRequest.lineItems.filter((li) => li.service === 'rodent_exclusion')
        .reduce((sum, li) => sum + li.price, 0)).toBe(895);
      const fromProperty = generateEstimate(baseInput({ homeSqFt: 1400, services: { exclusion: exclusion({ sealScope: 'whole_home' }) } }));
      expect(fromProperty.lineItems.filter((li) => li.service === 'rodent_exclusion')
        .reduce((sum, li) => sum + li.price, 0)).toBe(395);
    });
  });

  test('gate on: a two-story home sized only at estimate level tiers on its TOTAL area, not its footprint', () => {
    gateOn(() => {
      const estimate = generateEstimate(baseInput({ homeSqFt: 4500, stories: 2, services: { exclusion: exclusion({ sealScope: 'whole_home' }) } }));
      const rows = estimate.lineItems.filter((li) => li.service === 'rodent_exclusion');
      expect(rows.reduce((sum, li) => sum + li.price, 0)).toBe(1295);
      expect(rows.every((li) => li.guaranteeRenewalPrice === 299)).toBe(true);
    });
  });

  test('gate on: an unknown home size is a guessed size, flagged on every row (never a firm minimum)', () => {
    gateOn(() => {
      const unsized = generateEstimate(baseInput({ homeSqFt: 0, services: { exclusion: exclusion({ sealScope: 'whole_home' }) } }));
      const rows = unsized.lineItems.filter((li) => li.service === 'rodent_exclusion');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((li) => li.footprintWasDefaulted === true)).toBe(true);
      const mapped = mapV1ToLegacyShape(unsized);
      const mappedRows = [...(mapped.oneTime.items || []), ...(mapped.oneTime.specItems || [])].filter((r) => r.service === 'rodent_exclusion');
      expect(mappedRows.every((r) => r.footprintWasDefaulted === true)).toBe(true);
      // A measured size carries no such flag.
      const sized = generateEstimate(baseInput({ homeSqFt: 1800, services: { exclusion: exclusion({ sealScope: 'whole_home' }) } }));
      expect(sized.lineItems.filter((li) => li.service === 'rodent_exclusion').some((li) => li.footprintWasDefaulted)).toBe(false);
    });
  });

  test('gate on: no second, paid guarantee line beside an included guarantee', () => {
    const services = (sealScope) => ({
      exclusion: exclusion({ sealScope, homeSqFt: 2000 }),
      rodentGuarantee: { eligibility: GUARANTEE_ELIGIBLE },
    });
    gateOn(() => {
      const whole = generateEstimate(baseInput({ services: services('whole_home') }));
      expect(whole.lineItems.some((li) => li.service === 'rodent_guarantee')).toBe(false);
      expect(whole.lineItems.filter((li) => li.service === 'rodent_exclusion').every((li) => li.includesReentryGuarantee === true)).toBe(true);
      // A spot seal still sells the guarantee as the paid extra.
      const spot = generateEstimate(baseInput({ services: services('spot') }));
      expect(spot.lineItems.find((li) => li.service === 'rodent_guarantee')).toMatchObject({ eligible: true, price: 199 });
    });
  });

  test('commercial property: a whole-home request never becomes a firm price', () => {
    gateOn(() => {
      for (const counts of [{}, { standardWireMeshPoints: 3 }]) {
        const estimate = generateEstimate(baseInput({
          propertyType: 'commercial',
          services: { exclusion: exclusion({ sealScope: 'whole_home', standardWireMeshPoints: 0, ...counts }) },
        }));
        expect(estimate.lineItems.some((li) => li.service === 'rodent_exclusion' && li.price > 0)).toBe(false);
      }
    });
  });

  test('the flag and renewal price reach the mapped estimate and the public breakdown rows', () => {
    gateOn(() => {
      const mapped = mapV1ToLegacyShape(generateEstimate(baseInput({
        services: { exclusion: exclusion({ sealScope: 'whole_home', homeSqFt: 2000 }) },
      })));
      const rows = normalizeOneTimeBreakdown({ result: mapped }).items.filter((r) => r.service === 'rodent_exclusion');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.includesReentryGuarantee === true && r.guaranteeRenewalPrice === 199)).toBe(true);
    });
    // A rollback does not take a quoted guarantee away: the public rows read the SAVED flag.
    const saved = gateOn(() => mapV1ToLegacyShape(generateEstimate(baseInput({
      services: { exclusion: exclusion({ sealScope: 'whole_home', homeSqFt: 2000 }) },
    }))));
    withGate(undefined, () => {
      const rows = normalizeOneTimeBreakdown({ result: saved }).items.filter((r) => r.service === 'rodent_exclusion');
      expect(rows.every((r) => r.includesReentryGuarantee === true && r.guaranteeRenewalPrice === 199)).toBe(true);
      const copy = resolveOneTimeServiceCopy(rows[0], { guaranteeScope: 'satisfaction' });
      expect(copy.includes).toContain(BULLET);
      expect(copy.terms).toBe('Pay on service day. Renew the guarantee yearly for $199.');
    });
    const spotMapped = withGate(undefined, () => mapV1ToLegacyShape(generateEstimate(baseInput({ services: { exclusion: exclusion() } }))));
    const spotRows = normalizeOneTimeBreakdown({ result: spotMapped }).items.filter((r) => r.service === 'rodent_exclusion');
    expect(spotRows.every((r) => !('includesReentryGuarantee' in r))).toBe(true);
  });
});

describe('customer copy for an included re-entry guarantee', () => {
  const row = { service: 'rodent_exclusion', label: 'Rodent Exclusion', price: 595, includesReentryGuarantee: true, guaranteeRenewalPrice: 249 };

  test('a flagged row states the guarantee and the renewal price', () => {
    const copy = resolveOneTimeServiceCopy(row);
    expect(copy.includes).toContain(BULLET);
    expect(copy.terms).toBe('Pay on service day. Renew the guarantee yearly for $249.');
  });

  test('the satisfaction and none scopes keep it for that row only', () => {
    for (const guaranteeScope of ['satisfaction', 'none']) {
      const copy = resolveOneTimeServiceCopy(row, { guaranteeScope });
      expect(copy.includes).toContain(BULLET);
      expect(copy.terms).toBe('Pay on service day. Renew the guarantee yearly for $249.');
      // The rest of the plan-terms claims are still stripped.
      expect(copy.includes.join(' ')).not.toMatch(/no contract/i);
    }
  });

  test('fail closed: no flag, a false flag or a text-only hint carries no guarantee wording', () => {
    for (const item of [
      { service: 'rodent_exclusion', label: 'Rodent Exclusion', guaranteeRenewalPrice: 249 },
      { ...row, includesReentryGuarantee: false },
      { ...row, includesReentryGuarantee: 'true' },
      { service: 'rodent_exclusion', label: 'Rodent Exclusion', detail: 'Includes a 1-year re-entry guarantee' },
    ]) {
      for (const guaranteeScope of ['all', 'satisfaction', 'none']) {
        const copy = resolveOneTimeServiceCopy(item, { guaranteeScope });
        expect(copy.includes).not.toContain(BULLET);
        expect(copy.terms).not.toMatch(/renew/i);
      }
    }
  });

  test('the flag does not put the guarantee on another service', () => {
    const copy = resolveOneTimeServiceCopy({ service: 'bed_bug', label: 'Bed Bug Heat Treatment', includesReentryGuarantee: true, guaranteeRenewalPrice: 249 }, { guaranteeScope: 'satisfaction' });
    expect(copy.includes).not.toContain(BULLET);
  });

  test('one predicate: only a recognized rodent exclusion key with the flag counts (keys, copy and Ask Waves agree)', () => {
    const { hasIncludedReentryGuarantee, includedReentryGuaranteeFields } = require('../../shared/estimate-purchased-warranty.cjs');
    const flagged = { includesReentryGuarantee: true, guaranteeRenewalPrice: 249 };
    for (const service of ['rodent_exclusion', 'exclusion', 'exclusion_v2']) {
      expect(hasIncludedReentryGuarantee({ service, ...flagged })).toBe(true);
    }
    for (const service of ['bed_bug', 'rodent_trapping', undefined]) {
      expect(hasIncludedReentryGuarantee({ service, label: 'Rodent Exclusion', ...flagged })).toBe(false);
      expect(includedReentryGuaranteeFields({ service, ...flagged })).toEqual({});
    }
    expect(hasIncludedReentryGuarantee({ service: 'rodent_exclusion', includesReentryGuarantee: 'true' })).toBe(false);
    const bedBug = resolveOneTimeServiceCopy({ service: 'bed_bug', label: 'Bed Bug Heat Treatment', ...flagged });
    expect(bedBug.includes).not.toContain(BULLET);
  });

  test('a flagged row with no renewal price keeps the normal terms and states no renewal', () => {
    const copy = resolveOneTimeServiceCopy({ ...row, guaranteeRenewalPrice: null }, { guaranteeScope: 'satisfaction' });
    expect(copy.includes).toContain(BULLET);
    expect(copy.terms).not.toMatch(/renew/i);
  });
});

describe('the estimator route translation of the Seal scope pick', () => {
  const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
  const profile = { homeSqFt: 2000, stories: 1, lotSqFt: 9000, propertyType: 'single_family' };
  const translate = (options) => translateV2CallToV1Input(profile, ['EXCLUSION'], { exclStandardWireMesh: 2, ...options });

  test('gate on: a Whole home pick reaches services.exclusion with the home facts', () => {
    gateOn(() => {
      expect(translate({ exclSealScope: 'whole_home' }).services.exclusion).toMatchObject({
        pricingVersion: 'v2', sealScope: 'whole_home', homeSqFt: 2000,
      });
    });
  });

  test('the route translation passes the pick through and reads no gate (the engine refuses it when the gate is off)', () => {
    withGate(undefined, () => {
      expect(translate({ exclSealScope: 'whole_home' }).services.exclusion).toMatchObject({ sealScope: 'whole_home', homeSqFt: 2000 });
      expect(() => generateEstimate(translate({ exclSealScope: 'whole_home' }))).toThrow(/Choose Spot seal/);
    });
  });

  test('gate off, no Whole home pick: byte-identical to a request that never mentions the scope', () => {
    withGate(undefined, () => {
      const plain = translate({});
      expect(translate({ exclSealScope: 'spot', exclusionChecklist: ['eave_gaps'] })).toEqual(plain);
      expect(plain.services.exclusion.sealScope).toBeUndefined();
    });
  });
});
