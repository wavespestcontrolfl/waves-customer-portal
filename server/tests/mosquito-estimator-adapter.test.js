const pricingEngine = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');

function calculate(profile, selectedServices, options = {}) {
  const v1Input = translateV2CallToV1Input(profile, selectedServices, options);
  return mapV1ToLegacyShape(pricingEngine.generateEstimate(v1Input));
}

describe('mosquito estimator adapter', () => {
  afterAll(async () => {
    try { await require('../models/db').destroy(); } catch { /* ignore */ }
  });

  const pressureProfile = {
    address: '123 Mosquito Test Dr',
    propertyType: 'Single Family',
    homeSqFt: 2200,
    lotSqFt: 10000,
    stories: 1,
    serviceZone: 'A',
    shrubDensity: 'MODERATE',
    treeDensity: 'MODERATE',
    landscapeComplexity: 'MODERATE',
    pool: 'YES',
    poolCage: 'YES',
    nearWater: 'YES',
    estimatedTurfSf: 5000,
    estimatedBedAreaSf: 900,
  };

  test('returns recurring seasonal9 and monthly12 programs with selected add-ons', () => {
    const result = calculate(
      pressureProfile,
      ['MOSQUITO'],
      { mosquitoProgram: 'monthly12', mosquitoStationCount: 2, mosquitoDunkCount: 4 },
    );

    expect(result.results.mqMeta).toEqual(expect.objectContaining({
      program: 'monthly12',
      selectedProgram: 'monthly12',
      recommendedProgram: 'seasonal9',
      recommendedTier: 'seasonal9',
      tierWasForced: true,
      ri: 1,
      addOns: expect.objectContaining({
        stationCount: 2,
        dunkCount: 4,
        stationAddOn: 78,
        dunkAddOn: 16,
        annualAddOns: 94,
      }),
    }));
    expect(result.results.mq.map((tier) => tier.n)).toEqual([
      'Seasonal Mosquito Program (9 visits)',
      'Monthly Mosquito Program (12 visits)',
    ]);
    expect(result.results.mq[1]).toEqual(expect.objectContaining({
      v: 12,
      selected: true,
      recommended: false,
      pressureRecommended: false,
    }));
    expect(result.results.mq[0]).toEqual(expect.objectContaining({
      selected: false,
      recommended: true,
      pressureRecommended: true,
    }));
  });

  test('keeps legacy direct mosquito program aliases compatible', () => {
    const property = pricingEngine.calculatePropertyProfile({
      homeSqFt: 2200,
      stories: 1,
      lotSqFt: 10000,
      propertyType: 'single_family',
      features: { trees: 'moderate', shrubs: 'moderate', complexity: 'moderate' },
    });

    expect(pricingEngine.priceMosquito(property, { tier: 'seasonal' })).toEqual(
      expect.objectContaining({ tier: 'seasonal9', visits: 9 }),
    );
    expect(pricingEngine.priceMosquito(property, { tier: 'monthly' })).toEqual(
      expect.objectContaining({ tier: 'monthly12', visits: 12 }),
    );
  });

  test('returns one-time mosquito with station and Bti dunk add-ons', () => {
    const result = calculate(
      pressureProfile,
      ['OT_MOSQUITO'],
      { mosquitoStationCount: 2, mosquitoDunkCount: 4 },
    );

    expect(result.hasOneTime).toBe(true);
    expect(result.oneTime.total).toBe(309);
    expect(result.oneTime.items).toEqual([
      expect.objectContaining({
        service: 'one_time_mosquito',
        name: 'One-Time Mosquito',
        price: 309,
        addOns: expect.objectContaining({
          stationCount: 2,
          dunkCount: 4,
          stationAddOn: 150,
          dunkAddOn: 60,
        }),
      }),
    ]);
  });
});
