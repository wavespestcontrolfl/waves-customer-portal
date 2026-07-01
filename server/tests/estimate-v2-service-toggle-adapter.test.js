const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

function baseProfile() {
  return {
    address: 'TEST-RODENT-SANITATION',
    propertyType: 'single_family',
    category: 'residential',
    homeSqFt: 2400,
    lotSqFt: 9000,
    stories: 1,
    footprint: 2400,
    serviceZone: 'A',
    shrubDensity: 'MODERATE',
    treeDensity: 'MODERATE',
    landscapeComplexity: 'MODERATE',
    pool: 'NO',
    poolCage: 'NO',
    hasLargeDriveway: false,
    nearWater: 'NO',
  };
}

describe('estimate v2 service toggle adapter', () => {
  test('maps rodent sanitation selection into the v1 sanitation service', () => {
    const input = translateV2CallToV1Input(
      baseProfile(),
      ['RODENT_SANITATION'],
      {
        sanitationTier: 'heavy',
        sanitationArea: 1200,
        sanitationDebris: 12,
        sanitationAccess: 'tight',
      }
    );

    expect(input.services.sanitation).toEqual({
      tier: 'heavy',
      affectedSqFt: 1200,
      insulationRemovalCuFt: 12,
      accessType: 'tight',
    });

    const estimate = generateEstimate(input);
    const item = estimate.lineItems.find((line) => line.service === 'rodent_sanitation');

    expect(item).toMatchObject({
      service: 'rodent_sanitation',
      tier: 'heavy',
      name: 'Rodent Sanitation (Heavy)',
    });
    expect(item.price).toBeGreaterThan(0);

    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.specItems).toContainEqual(expect.objectContaining({
      service: 'rodent_sanitation',
      name: 'Rodent Sanitation',
    }));
  });

  test('labels rodent sanitation bundle discounts in the legacy response', () => {
    const input = translateV2CallToV1Input(
      baseProfile(),
      ['RODENT_TRAP', 'RODENT_SANITATION'],
      {
        sanitationTier: 'standard',
        sanitationArea: 900,
        sanitationDebris: 10,
      }
    );

    const mapped = mapV1ToLegacyShape(generateEstimate(input));
    expect(mapped.specItems).toContainEqual(expect.objectContaining({
      service: 'rodent_bundle_discount',
      name: 'Rodent Bundle Discount',
    }));
  });

  test('labels selected mosquito program and station/dunk add-ons in legacy recurring and one-time rows', () => {
    const input = translateV2CallToV1Input(
      {
        ...baseProfile(),
        lotSqFt: 14500,
        pool: 'YES',
        poolCage: 'YES',
        shrubDensity: 'HEAVY',
        treeDensity: 'HEAVY',
        landscapeComplexity: 'COMPLEX',
        nearWater: 'YES',
      },
      ['MOSQUITO', 'OT_MOSQUITO'],
      {
        mosquitoProgram: 'monthly12',
        mosquitoStationCount: 2,
        mosquitoDunkCount: 4,
      }
    );

    const mapped = mapV1ToLegacyShape(generateEstimate(input));
    expect(mapped.recurring.services).toContainEqual(expect.objectContaining({
      service: 'mosquito',
      name: 'Mosquito',
      displayName: 'Monthly Mosquito Program (12 visits)',
      program: 'monthly12',
      detail: expect.stringContaining('2 mosquito stations'),
    }));
    expect(mapped.recurring.services.find((svc) => svc.service === 'mosquito').detail)
      .toContain('4 Bti dunk tablets');
    expect(mapped.oneTime.items).toContainEqual(expect.objectContaining({
      service: 'one_time_mosquito',
      name: 'One-Time Mosquito',
      detail: expect.stringContaining('2 mosquito stations'),
    }));
  });

  test('maps exterior flea spray options into the authoritative server flea package', () => {
    const input = translateV2CallToV1Input(
      {
        ...baseProfile(),
        homeSqFt: 2000,
        lotSqFt: 7500,
        footprint: 2000,
        treeDensity: 'LIGHT',
        landscapeComplexity: 'SIMPLE',
      },
      ['FLEA'],
      {
        fleaExterior: true,
        fleaExteriorAreaSqFt: 5000,
        fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
        fleaExteriorZones: ['PET_RESTING_AREA'],
      }
    );

    expect(input.services.flea).toEqual(expect.objectContaining({
      fleaExterior: true,
      fleaExteriorAreaSqFt: 5000,
      fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
      fleaExteriorZones: ['PET_RESTING_AREA'],
    }));

    const estimate = generateEstimate(input);
    const item = estimate.lineItems.find((line) => line.service === 'flea_package');
    expect(item.total).toBe(505);

    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.hasOneTime).toBe(true);
    expect(mapped.oneTime.specItems).toContainEqual(expect.objectContaining({
      service: 'flea_package',
      name: 'Flea Elimination Package — 2 visits',
      price: 505,
      exteriorDetail: 'Exterior flea spray — 5,000 sf',
      fleaExteriorZones: ['PET_RESTING_AREA'],
    }));
  });

  test('maps palm injection selection with editable property and service palm counts', () => {
    const input = translateV2CallToV1Input(
      {
        ...baseProfile(),
        palmCount: 8,
      },
      ['PALM_INJECTION'],
      {
        palmInjection: {
          palmCount: 5,
          treatmentType: 'combo',
          palmSize: 'medium',
        },
      }
    );

    expect(input.palmCount).toBe(8);
    expect(input.services.palm).toEqual(expect.objectContaining({
      palmCount: 5,
      measurements: { palmCount: 5 },
      treatmentType: 'combo',
      palmSize: 'medium',
    }));

    const estimate = generateEstimate(input);
    const palm = estimate.lineItems.find((line) => line.service === 'palm_injection');
    expect(palm).toEqual(expect.objectContaining({
      palmCount: 5,
      treatmentType: 'combo',
      palmSize: 'medium',
      pricePerPalm: 75,
      palmCountSource: 'service_manual_override',
      servicePalmCountDiffersFromPropertyPalmCount: true,
    }));

    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.results.injection).toEqual(expect.objectContaining({
      pricePerPalm: 75,
      appsPerYear: 2,
      palmSize: 'medium',
      palmCountSource: 'service_manual_override',
      servicePalmCountDiffersFromPropertyPalmCount: true,
      detail: expect.stringContaining('$75/palm'),
    }));
  });

  test('palm injection without service or property palm count returns a clear validation error', () => {
    const input = translateV2CallToV1Input(
      baseProfile(),
      ['PALM_INJECTION'],
      {}
    );

    expect(input.services.palm.palmCount).toBeUndefined();
    expect(() => generateEstimate(input)).toThrow(/Palm count is required/);
  });

  test('maps Gold palm credits onto the legacy palm line item and totals', () => {
    const input = translateV2CallToV1Input(
      {
        ...baseProfile(),
        palmCount: 3,
      },
      ['PEST', 'LAWN', 'MOSQUITO', 'PALM_INJECTION'],
      {
        palmInjection: { palmCount: 3, treatmentType: 'combo', palmSize: 'medium' },
        manualDiscount: { type: 'FIXED', value: 100, label: 'Manual promo' },
      }
    );

    const estimate = generateEstimate(input);
    const palm = estimate.lineItems.find((line) => line.service === 'palm_injection');
    expect(estimate.waveGuard.tier).toBe('gold');
    expect(palm).toEqual(expect.objectContaining({
      annualBeforeCredits: 450,
      flatCreditAnnual: 30,
      annualAfterCredits: 420,
      monthlyAfterCredits: 35,
    }));

    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.results.injection).toEqual(expect.objectContaining({
      ann: 420,
      mo: 35,
      annualBeforeCredits: 450,
      flatCreditAnnual: 30,
      annualAfterCredits: 420,
      monthlyAfterCredits: 35,
    }));
    expect(mapped.recurring.palmInjectionAnn).toBe(420);
    expect(mapped.recurring.palmInjectionMo).toBe(35);
    expect(mapped.recurring.annualBeforeDiscount).toBeCloseTo(
      estimate.summary.recurringAnnualBeforeDiscount - palm.annualBeforeCredits
    );
    expect(mapped.recurring.annualAfterDiscount).toBeCloseTo(
      estimate.summary.recurringAnnualAfterDiscount - palm.annualAfterCredits
    );
    expect(mapped.recurring.savings).toBeCloseTo(
      estimate.summary.waveGuardSavings - palm.flatCreditAnnual
    );
    expect(mapped.manualDiscount).toEqual(expect.objectContaining({ amount: 100 }));
    expect(mapped.recurring.annualBeforeDiscount - mapped.recurring.annualAfterDiscount)
      .toBeCloseTo(mapped.recurring.savings + mapped.manualDiscount.amount);
    expect(mapped.totals.year2).toBeCloseTo(estimate.summary.recurringAnnualAfterDiscount);
  });

  test('uses recurring mosquito add-on amounts in detail copy', () => {
    const input = translateV2CallToV1Input(
      {
        ...baseProfile(),
        serviceZone: 'D',
        lotSqFt: 14500,
        pool: 'YES',
        poolCage: 'YES',
        shrubDensity: 'HEAVY',
        treeDensity: 'HEAVY',
        landscapeComplexity: 'COMPLEX',
        nearWater: 'YES',
      },
      ['MOSQUITO'],
      {
        mosquitoProgram: 'monthly12',
        mosquitoStationCount: 2,
        mosquitoDunkCount: 4,
      }
    );

    const mapped = mapV1ToLegacyShape(generateEstimate(input));
    const mosquito = mapped.recurring.services.find((svc) => svc.service === 'mosquito');
    expect(mosquito.detail).toContain('2 mosquito stations (+$78/yr)');
    expect(mosquito.detail).toContain('4 Bti dunk tablets (+$16/yr)');
  });

  test('persists both tree and shrub tiers for the public estimate slider', () => {
    const input = translateV2CallToV1Input(
      {
        ...baseProfile(),
        shrubDensity: 'LIGHT',
        treeDensity: 'LIGHT',
        landscapeComplexity: 'SIMPLE',
      },
      ['TREE_SHRUB'],
      {}
    );

    const mapped = mapV1ToLegacyShape(generateEstimate(input));

    expect(mapped.results.ts.map((row) => row.name)).toEqual(['Light', 'Standard']);
    expect(mapped.results.ts).toEqual([
      expect.objectContaining({
        name: 'Light',
        tier: 'light',
        selected: false,
        isSelected: false,
        v: 4,
      }),
      expect.objectContaining({
        name: 'Standard',
        tier: 'standard',
        selected: true,
        isSelected: true,
        v: 6,
      }),
    ]);
    // Standard (6x, mandated default) outprices the Light 4x downsell.
    expect(mapped.results.ts[1].mo).toBeGreaterThan(mapped.results.ts[0].mo);
  });

  test('does not double-bill recurring German roach initial when standalone German roach is also selected', () => {
    const input = translateV2CallToV1Input(
      baseProfile(),
      ['PEST', 'ROACH'],
      {
        roachModifier: 'GERMAN',
        roachType: 'GERMAN',
        pestFreq: 4,
      }
    );

    expect(input.services.pest).toEqual({
      frequency: 'quarterly',
      roachType: 'german',
    });
    expect(input.services.germanRoach).toEqual({});
    expect(input.services.germanRoachInitial).toBeUndefined();
    expect(input.services.pestInitialRoach).toBeUndefined();

    const estimate = generateEstimate(input);
    const serviceKeys = estimate.lineItems.map((line) => line.service);
    expect(serviceKeys.filter((key) => key === 'pest_initial_roach')).toHaveLength(1);
    expect(serviceKeys).toContain('german_roach');
    expect(serviceKeys).not.toContain('german_roach_initial');
    expect(estimate.pricingMetadata.manualReviewReasons).toContain('german_roach_initial_and_cleanout_both_selected');
  });

  test('maps German Roach Cleanout total through the legacy adapter', () => {
    const input = translateV2CallToV1Input(
      {
        ...baseProfile(),
        homeSqFt: 2800,
        footprint: 2800,
      },
      ['ROACH'],
      {
        roachType: 'GERMAN',
      }
    );

    const estimate = generateEstimate(input);
    const mapped = mapV1ToLegacyShape(estimate);
    const cleanout = mapped.oneTime.specItems.find((line) => line.service === 'german_roach');

    expect(estimate.summary.specialtyTotal).toBe(350);
    expect(cleanout).toEqual(expect.objectContaining({
      name: 'German Roach Cleanout — 2 Visit Program',
      price: 350,
      source: 'german_roach_cleanout_selected',
      pricingModel: 'german_roach_severity_tier_cleanout',
      severity: 'light',
      visits: 2,
      setupCharge: 0,
      total: 350,
      noRecurringDiscount: true,
    }));
    expect(mapped.oneTime.total).toBe(350);
    expect(mapped.totals.year1).toBe(350);
  });

  test('does not double-bill regular roach when recurring pest already includes regular knockdown', () => {
    const input = translateV2CallToV1Input(
      baseProfile(),
      ['PEST', 'ROACH'],
      {
        roachModifier: 'REGULAR',
        roachType: 'REGULAR',
        pestFreq: 4,
      }
    );

    expect(input.services.pest).toEqual({
      frequency: 'quarterly',
      roachType: 'regular',
    });
    expect(input.services.pestInitialRoach).toBeUndefined();
    expect(input.pricingMetadata).toEqual(expect.objectContaining({
      skippedDuplicateRoachLine: true,
      skippedService: 'standalone_native_cockroach_treatment',
      skippedReason: 'recurring_pest_initial_roach_already_covers_regular_roach',
    }));

    const estimate = generateEstimate(input);
    const serviceKeys = estimate.lineItems.map((line) => line.service);
    expect(serviceKeys.filter((key) => key === 'pest_initial_roach')).toHaveLength(1);
    expect(serviceKeys).not.toContain('german_roach');
    expect(serviceKeys).not.toContain('german_roach_initial');
    expect(estimate.pricingMetadata.skippedDuplicateRoachLine).toBe(true);
  });

  test('regular roach modifier does not alter recurring per-app price or discount the initial', () => {
    const noRoach = generateEstimate({
      ...baseProfile(),
      services: { pest: { frequency: 'quarterly', roachType: 'none' } },
      recurringCustomer: true,
    });
    const regularRoach = generateEstimate({
      ...baseProfile(),
      services: { pest: { frequency: 'quarterly', roachType: 'regular' } },
      recurringCustomer: true,
    });

    const noRoachPest = noRoach.lineItems.find((line) => line.service === 'pest_control');
    const regularPest = regularRoach.lineItems.find((line) => line.service === 'pest_control');
    const initialRoach = regularRoach.lineItems.find((line) => line.service === 'pest_initial_roach');

    expect(regularPest.perApp).toBe(noRoachPest.perApp);
    expect(regularPest.roachAddOn).toBe(0);
    expect(initialRoach).toEqual(expect.objectContaining({
      service: 'pest_initial_roach',
      label: 'Initial Native Roach Knockdown',
      price: 139,
      roachType: 'regular',
    }));
    expect(regularRoach.summary.oneTimeTotal).toBe(139);
  });

  test('prices standalone regular roach from the standalone knockdown scale', () => {
    const input = translateV2CallToV1Input(
      {
        ...baseProfile(),
        homeSqFt: 4200,
        footprint: 4200,
      },
      ['ROACH'],
      {
        roachType: 'REGULAR',
      }
    );

    expect(input.services.pest).toBeUndefined();
    expect(input.services.pestInitialRoach).toEqual({
      roachType: 'regular',
      source: 'standalone_native_cockroach_treatment',
    });

    const estimate = generateEstimate(input);
    const roachLine = estimate.lineItems.find((line) => line.service === 'pest_initial_roach');
    expect(roachLine).toEqual(expect.objectContaining({
      label: 'Initial Native Roach Knockdown',
      price: 289,
      roachType: 'regular',
      standalone: true,
      source: 'standalone_native_cockroach_treatment',
    }));
  });

  test('keeps standalone regular roach scale when recurring pest has no roach modifier', () => {
    const input = translateV2CallToV1Input(
      {
        ...baseProfile(),
        homeSqFt: 4200,
        footprint: 4200,
      },
      ['PEST', 'ROACH'],
      {
        roachModifier: 'NONE',
        roachType: 'REGULAR',
        pestFreq: 4,
      }
    );

    expect(input.services.pest).toEqual({
      frequency: 'quarterly',
      roachType: 'none',
    });
    expect(input.services.pestInitialRoach).toEqual({
      roachType: 'regular',
      source: 'standalone_native_cockroach_treatment',
    });

    const estimate = generateEstimate(input);
    const roachLines = estimate.lineItems.filter((line) => line.service === 'pest_initial_roach');
    expect(roachLines).toHaveLength(1);
    expect(roachLines[0].price).toBe(289);
  });

  test('preserves inferred pool cage size for pest pricing confidence', () => {
    const input = translateV2CallToV1Input(
      {
        ...baseProfile(),
        pool: 'YES',
        poolCage: 'YES',
        poolCageSize: 'MEDIUM',
        poolCageSizeInferred: true,
      },
      ['PEST'],
      { pestFreq: 4 }
    );

    expect(input.features.poolCageSize).toBeUndefined();

    const estimate = generateEstimate(input);
    const pest = estimate.lineItems.find((line) => line.service === 'pest_control');
    expect(pest.productionDiagnostics.poolCageSize).toBe('medium');
    expect(pest.productionDiagnostics.reviewReasons).toContain('pool_cage_size_inferred');
  });

  test('honors explicit pool cage size when inferred flag is cleared', () => {
    const input = translateV2CallToV1Input(
      {
        ...baseProfile(),
        pool: 'YES',
        poolCage: 'YES',
        poolCageSize: 'LARGE',
        poolCageSizeInferred: false,
      },
      ['PEST'],
      { pestFreq: 4 }
    );

    expect(input.features.poolCageSize).toBe('large');

    const estimate = generateEstimate(input);
    const pest = estimate.lineItems.find((line) => line.service === 'pest_control');
    expect(pest.productionDiagnostics.poolCageSize).toBe('large');
    expect(pest.productionDiagnostics.reviewReasons).toContain('large_pool_cage');
    expect(pest.productionDiagnostics.reviewReasons).not.toContain('pool_cage_size_inferred');
  });

  test('maps RODENT_GUARANTEE with all eligibility flags into a priced renewable warranty line', () => {
    const input = translateV2CallToV1Input(
      baseProfile(),
      ['RODENT_GUARANTEE'],
      {
        rgTrappingCompleted: true,
        rgExclusionCompleted: true,
        rgSanitationBaseline: true,
        rgNoActivityAfterFinalCheck: true,
      }
    );

    expect(input.services.rodentGuarantee).toMatchObject({
      eligibility: {
        trappingCompleted: true,
        exclusionCompleted: true,
        sanitationCompletedOrPhotoBaseline: true,
        noActivityAfterFinalTrapCheck: true,
      },
    });

    const estimate = generateEstimate(input);
    const item = estimate.lineItems.find((line) => line.service === 'rodent_guarantee');

    expect(item).toBeDefined();
    expect(item.eligible).toBe(true);
    expect(item.price).toBeGreaterThan(0);
    expect(item.detail).toContain('renewable annually');
  });

  test('tiers the guarantee off the profile home size even without a footprint field', () => {
    // A large two-story tile home must price as estate ($299), not complex —
    // the adapter forwards normalized homeSqFt/stories/roofType so tiering does
    // not depend on the engine's optional property.footprint fallback.
    const { footprint, ...profileNoFootprint } = baseProfile();
    const input = translateV2CallToV1Input(
      { ...profileNoFootprint, homeSqFt: 5000, stories: 2, roofType: 'tile' },
      ['RODENT_GUARANTEE'],
      {
        rgTrappingCompleted: true,
        rgExclusionCompleted: true,
        rgSanitationBaseline: true,
        rgNoActivityAfterFinalCheck: true,
      }
    );

    expect(input.services.rodentGuarantee).toMatchObject({
      homeSqFt: 5000,
      stories: 2,
      roofType: 'tile',
    });

    const estimate = generateEstimate(input);
    const item = estimate.lineItems.find((line) => line.service === 'rodent_guarantee');
    expect(item.tier).toBe('estate');
    expect(item.price).toBe(299);
  });

  test('promotes a small tile-roof home to complex even when roof type is uppercase', () => {
    // Property lookup / verified overrides return roof type as 'TILE'; the tier
    // rule must still recognize it (small single-story tile home -> complex $249,
    // not standard $199).
    const { footprint, ...profileNoFootprint } = baseProfile();
    const input = translateV2CallToV1Input(
      { ...profileNoFootprint, homeSqFt: 2000, stories: 1, roofType: 'TILE' },
      ['RODENT_GUARANTEE'],
      {
        rgTrappingCompleted: true,
        rgExclusionCompleted: true,
        rgSanitationBaseline: true,
        rgNoActivityAfterFinalCheck: true,
      }
    );

    const estimate = generateEstimate(input);
    const item = estimate.lineItems.find((line) => line.service === 'rodent_guarantee');
    expect(item.tier).toBe('complex');
    expect(item.price).toBe(249);
  });

  test('drops the RODENT_GUARANTEE line when any eligibility flag is missing (fail closed)', () => {
    const input = translateV2CallToV1Input(
      baseProfile(),
      ['RODENT_GUARANTEE'],
      {
        rgTrappingCompleted: true,
        rgExclusionCompleted: false, // not confirmed
        rgSanitationBaseline: true,
        rgNoActivityAfterFinalCheck: true,
      }
    );

    expect(input.services.rodentGuarantee.eligibility.exclusionCompleted).toBe(false);

    const estimate = generateEstimate(input);
    const item = estimate.lineItems.find((line) => line.service === 'rodent_guarantee');
    expect(item).toBeUndefined();
  });
});
