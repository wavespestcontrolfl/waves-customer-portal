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
});
