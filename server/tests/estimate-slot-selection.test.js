const { resolveEstimateSlotProfile } = require('../services/estimate-slot-availability');

const companions = [
  { service: 'tree_shrub', name: 'Tree & Shrub', visitsPerYear: 9 },
  { service: 'mosquito', name: 'Monthly Mosquito Control', visitsPerYear: 12 },
];

function estimateWith(services) {
  return {
    service_interest: 'Lawn Care + Tree & Shrub + Mosquito',
    monthly_total: 100,
    annual_total: 1200,
    estimate_data: { result: { recurring: { services } } },
  };
}

function selectedCounts(estimate, options) {
  return resolveEstimateSlotProfile(estimate, options).services
    .map(({ service, visitsPerYear }) => [service, visitsPerYear]);
}

describe('estimate slot selection retains companion programs', () => {
  test.each([['basic', 4], ['standard', 6], ['enhanced', 9], ['premium', 12]])(
    'generated lawn tier %s updates only lawn', (selectedFrequency, visits) => {
      const estimate = estimateWith([{ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9 }, ...companions]);
      const before = JSON.parse(JSON.stringify(estimate));
      expect(selectedCounts(estimate, { selectedFrequency })).toEqual([
        ['lawn_care', visits], ['tree_shrub', 9], ['mosquito', 12],
      ]);
      expect(estimate).toEqual(before);
      // Selection repair precedes the separate full-capacity reservation PR.
      expect(resolveEstimateSlotProfile(estimate, { selectedFrequency }).durationMinutes).toBe(60);
    },
  );

  test.each([false, true])('saved pricing selection preserves omitted companions (stale=%s)', (stale) => {
    const estimate = estimateWith([{ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9 }, ...companions]);
    estimate.estimate_data.sendSnapshot = { pricingBundle: { frequencies: [{
      key: 'monthly', serviceCategory: 'lawn_care', serviceTierKey: 'standard',
      monthly: stale ? 50 : 100, annual: stale ? 600 : 1200,
      perServiceTreatments: [{ service: 'lawn_care', label: 'Lawn Care', visitsPerYear: stale ? 12 : 6 }],
    }] } };
    expect(selectedCounts(estimate, { selectedFrequency: 'standard' })).toEqual([
      ['lawn_care', 6], ['tree_shrub', 9], ['mosquito', 12],
    ]);
  });

  test('an explicit companion cadence in a matching bundle remains selected', () => {
    const estimate = estimateWith([{ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9 }, ...companions]);
    estimate.estimate_data.sendSnapshot = { pricingBundle: { frequencies: [{
      key: 'monthly', serviceCategory: 'lawn_care', serviceTierKey: 'standard', monthly: 100, annual: 1200,
      perServiceTreatments: [
        { service: 'lawn_care', label: 'Lawn Care', visitsPerYear: 6 },
        { service: 'tree_shrub', label: 'Tree & Shrub', visitsPerYear: 6 },
      ],
    }] } };
    expect(selectedCounts(estimate, { selectedFrequency: 'standard' })).toEqual([
      ['lawn_care', 6], ['tree_shrub', 6], ['mosquito', 12],
    ]);
  });

  test('the mosquito selection still applies after a lawn tier retains its row', () => {
    const estimate = estimateWith([{ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9 }, ...companions]);
    expect(selectedCounts(estimate, { selectedFrequency: 'standard', serviceCadences: { mosquito: 'seasonal9' } }))
      .toEqual([['lawn_care', 6], ['tree_shrub', 9], ['mosquito', 9]]);
  });

  test('nested and engine companions use the converter reader and deduplicate stored aliases', () => {
    const estimate = estimateWith([{ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9 }]);
    estimate.estimate_data.result.results = { recurring: { services: [companions[0]] } };
    estimate.estimate_data.engineResult = { lineItems: [
      { ...companions[0], annual: 600 },
      { ...companions[1], annual: 600 },
      { service: 'one_time_pest', price: 100 },
      { service: 'palm_injection', annual: 600, quoteRequired: true },
    ] };
    expect(selectedCounts(estimate, { selectedFrequency: 'standard' }))
      .toEqual([['lawn_care', 6], ['tree_shrub', 9], ['mosquito', 12]]);
  });

  test.each(['visitsPerYear', 'visits'])('flat legacy rows identified by %s retain seasonal restrictions', (countField) => {
    const estimate = { estimate_data: { services: [{ service: 'mosquito', name: 'Mosquito Control', [countField]: 9 }] } };
    const profile = resolveEstimateSlotProfile(estimate);
    expect(profile.services).toEqual([expect.objectContaining({ service: 'mosquito', visitsPerYear: 9 })]);
    expect(require('../services/estimate-slot-availability').seasonalSelectionProfile(profile)).toBe(true);
    expect(require('../services/estimate-converter').recurringServicesFromEstimateData(estimate.estimate_data)).toHaveLength(1);
  });

  test.each(['Recurring Termite Foam Service', 'Recurring Foam Treatment', 'Foam Recurring'])('saved foam selection coalesces the legacy name %s', (name) => {
    const estimate = estimateWith([{ name, visitsPerYear: 4 }]);
    estimate.estimate_data.sendSnapshot = { pricingBundle: { frequencies: [{
      key: 'quarterly', monthly: 100, annual: 1200,
      perServiceTreatments: [{ service: 'foam_recurring', label: 'Recurring Termite Foam Service', visitsPerYear: 4 }],
    }] } };
    const profile = resolveEstimateSlotProfile(estimate, { selectedFrequency: 'quarterly' });
    expect(profile.services).toEqual([expect.objectContaining({ service: 'foam_recurring', visitsPerYear: 4 })]);
    const converter = require('../services/estimate-converter');
    expect(converter.recurringServiceKey({ name })).toBe('foam_recurring');
    expect(converter.recurringServiceKey({ name: 'Termite Foam Service' })).toBe('termite_foam_service');
    expect(converter.recurringServiceKey({ service: 'commercial_foam_recurring' })).toBe('commercial_foam_recurring');
  });

  test.each([
    ['show_one_time_option', 'saved'], ['show_one_time_option', 'generated'],
    ['showOneTimeOption', 'saved'], ['showOneTimeOption', 'generated'],
  ])('%s preserves intentional pest-only recurring choice with a %s frequency', (flag, shape) => {
    const estimate = estimateWith([
      { service: 'pest_control', name: 'Pest Control', visitsPerYear: 4, perTreatment: 120 },
      { service: 'mosquito', name: 'Seasonal Mosquito Control', visitsPerYear: 9, perTreatment: 60 },
    ]);
    estimate[flag] = true;
    if (shape === 'saved') {
      estimate.estimate_data.sendSnapshot = { pricingBundle: { frequencies: [{
        key: 'quarterly', monthly: 100, annual: 1200,
        perServiceTreatments: [{ service: 'pest_control', label: 'Pest Control', visitsPerYear: 4 }],
      }] } };
    }
    const profile = resolveEstimateSlotProfile(estimate, { selectedFrequency: 'quarterly' });
    expect(profile.services.map((row) => [row.service, row.visitsPerYear])).toEqual([['pest_control', 4]]);
    expect(require('../services/estimate-slot-availability').seasonalSelectionProfile(profile)).toBe(false);
    expect(require('../routes/estimate-public').shouldPersistPestOnlyRecurringChoice(estimate, estimate.estimate_data)).toBe(true);
  });

  test('a one-time toggle without an eligible pest choice retains lawn companions', () => {
    const estimate = estimateWith([{ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9 }, ...companions]);
    estimate.show_one_time_option = true;
    expect(require('../routes/estimate-public').shouldPersistPestOnlyRecurringChoice(estimate, estimate.estimate_data)).toBe(false);
    expect(selectedCounts(estimate, { selectedFrequency: 'standard' }))
      .toEqual([['lawn_care', 6], ['tree_shrub', 9], ['mosquito', 12]]);
  });

  test('a selected bait line does not erase distinct rental or bond identities', () => {
    const estimate = estimateWith([
      { service: 'termite_bait', name: 'Termite Bait', visitsPerYear: 4 },
      { service: 'termite_station_rental', name: 'Station Rental', visitsPerYear: 4 },
      { service: 'termite_bond_1yr', name: 'Termite Bond', visitsPerYear: 4 },
    ]);
    estimate.estimate_data.sendSnapshot = { pricingBundle: { frequencies: [{
      key: 'quarterly', monthly: 100, annual: 1200,
      perServiceTreatments: [{ service: 'termite_bait', label: 'Termite Bait', visitsPerYear: 4 }],
    }] } };
    expect(resolveEstimateSlotProfile(estimate, { selectedFrequency: 'quarterly' }).services.map((row) => row.label))
      .toEqual(['Termite Bait', 'Station Rental', 'Termite Bond']);
  });
});
