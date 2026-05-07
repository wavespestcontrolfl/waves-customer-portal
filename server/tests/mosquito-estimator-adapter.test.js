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

  test('returns recurring Essential and Precision programs with selected add-ons', () => {
    const result = calculate(
      pressureProfile,
      ['MOSQUITO'],
      { mosquitoProgram: 'residual_monthly', mosquitoStationCount: 2, mosquitoDunkCount: 4 },
    );

    expect(result.results.mqMeta).toEqual(expect.objectContaining({
      program: 'residual_monthly',
      ri: 3,
      addOns: expect.objectContaining({
        stationCount: 2,
        dunkCount: 4,
        stationAddOn: 78,
        dunkAddOn: 16,
        annualAddOns: 94,
      }),
    }));
    expect(result.results.mq.map((tier) => tier.n)).toEqual([
      'Seasonal Essential Barrier',
      'Monthly Essential Barrier',
      'Seasonal Precision Barrier',
      'Monthly Precision Barrier',
    ]);
    expect(result.results.mq[3]).toEqual(expect.objectContaining({
      v: 12,
      recommended: true,
    }));
  });

  test('returns one-time mosquito with station and Bti dunk add-ons', () => {
    const result = calculate(
      pressureProfile,
      ['OT_MOSQUITO'],
      { mosquitoStationCount: 2, mosquitoDunkCount: 4 },
    );

    expect(result.hasOneTime).toBe(true);
    expect(result.oneTime.total).toBe(319);
    expect(result.oneTime.items).toEqual([
      expect.objectContaining({
        service: 'one_time_mosquito',
        name: 'One-Time Mosquito',
        price: 319,
        addOns: expect.objectContaining({
          stationCount: 2,
          dunkCount: 4,
          stationAddOn: 78,
          dunkAddOn: 16,
        }),
      }),
    ]);
  });
});
