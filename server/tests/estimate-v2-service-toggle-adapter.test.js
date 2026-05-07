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
        mosquitoProgram: 'residual_monthly',
        mosquitoStationCount: 2,
        mosquitoDunkCount: 4,
      }
    );

    const mapped = mapV1ToLegacyShape(generateEstimate(input));
    expect(mapped.recurring.services).toContainEqual(expect.objectContaining({
      service: 'mosquito',
      name: 'Mosquito',
      displayName: 'Monthly Precision Barrier',
      program: 'residual_monthly',
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

  test('uses zoned recurring mosquito add-on amounts in detail copy', () => {
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
        mosquitoProgram: 'residual_monthly',
        mosquitoStationCount: 2,
        mosquitoDunkCount: 4,
      }
    );

    const mapped = mapV1ToLegacyShape(generateEstimate(input));
    const mosquito = mapped.recurring.services.find((svc) => svc.service === 'mosquito');
    expect(mosquito.detail).toContain('2 mosquito stations (+$94/yr)');
    expect(mosquito.detail).toContain('4 Bti dunk tablets (+$19/yr)');
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

    const estimate = generateEstimate(input);
    const serviceKeys = estimate.lineItems.map((line) => line.service);
    expect(serviceKeys.filter((key) => key === 'pest_initial_roach')).toHaveLength(1);
    expect(serviceKeys).not.toContain('german_roach');
    expect(serviceKeys).not.toContain('german_roach_initial');
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
    expect(input.services.pestInitialRoach).toEqual({ roachType: 'regular' });

    const estimate = generateEstimate(input);
    const roachLine = estimate.lineItems.find((line) => line.service === 'pest_initial_roach');
    expect(roachLine).toEqual(expect.objectContaining({
      label: 'Initial Native Roach Knockdown',
      price: 289,
      roachType: 'regular',
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
    expect(input.services.pestInitialRoach).toEqual({ roachType: 'regular' });

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
});
