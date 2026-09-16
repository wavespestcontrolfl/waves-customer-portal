const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const {
  termiteStationsRentedUpdate,
  supportsConverterFollowUpSeeding,
  converterFollowUpSeedingPattern,
  combineRecurringServicesForScheduling,
  promotedTermiteUnitForRemaining,
  annualPrepayCoverageCadence,
  annualPrepayCoverageVisits,
} = require('../services/estimate-converter');

const originalGates = {
  annual: process.env.GATE_TERMITE_ANNUAL_PLAN,
  cancellation: process.env.GATE_CANCEL_FLOW_V2,
};
const INPUT = {
  homeSqFt: 2000, lotSqFt: 8000, propertyType: 'single_family',
  services: { termite: { system: 'trelona', plan: 'annual_protection' } },
};

function restoreGate(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

let annualRaw;
let annualMapped;
let annualPestMapped;
let quarterlyMapped;

beforeAll(() => {
  process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  annualRaw = generateEstimate(INPUT);
  annualMapped = mapV1ToLegacyShape(annualRaw);
  annualPestMapped = mapV1ToLegacyShape(generateEstimate({
    ...INPUT, services: { pest: { frequency: 'quarterly' }, ...INPUT.services },
  }));
  delete process.env.GATE_TERMITE_ANNUAL_PLAN;
  quarterlyMapped = mapV1ToLegacyShape(generateEstimate(INPUT));
  delete process.env.GATE_CANCEL_FLOW_V2;
});

afterAll(() => {
  restoreGate('GATE_TERMITE_ANNUAL_PLAN', originalGates.annual);
  restoreGate('GATE_CANCEL_FLOW_V2', originalGates.cancellation);
});

const baitLine = (mapped) => mapped.recurring.services.find((line) => line.service === 'termite_bait');

describe('annual protection conversion identity', () => {
  test('the real mapped recurring bait line retains its annual program and Waves ownership', () => {
    const raw = annualRaw.lineItems.find((line) => line.service === 'termite_bait');
    expect(raw).toMatchObject({ plan: 'annual_protection', stationsOwnedBy: 'waves', visitsPerYear: 1 });
    expect(baitLine(annualMapped)).toMatchObject({
      service: 'termite_bait', plan: 'annual_protection', stationsOwnedBy: 'waves', visitsPerYear: 1,
    });
    expect(annualMapped.recurring.services.some((line) => line.service === 'termite_station_rental')).toBe(false);
    expect(annualMapped.oneTime.items).toContainEqual(expect.objectContaining({
      service: 'termite_bait_installation', kind: 'setup',
    }));
  });

  test('annual setup retains Waves title without a rental rider; quarterly purchase and unrelated accepts keep their prior state', () => {
    expect(termiteStationsRentedUpdate(annualMapped.recurring.services)).toEqual({ termite_stations_rented: true });
    expect(termiteStationsRentedUpdate(annualMapped.recurring.services, { suppressRecurringConversion: true })).toEqual({});
    expect(baitLine(quarterlyMapped)).not.toHaveProperty('plan', 'annual_protection');
    expect(termiteStationsRentedUpdate(quarterlyMapped.recurring.services)).toEqual({ termite_stations_rented: false });
    expect(termiteStationsRentedUpdate([{ service: 'pest_control', name: 'Pest Control' }])).toEqual({});
    expect(termiteStationsRentedUpdate([
      baitLine(quarterlyMapped), { service: 'termite_station_rental', name: 'Termite Station Rental' },
    ])).toEqual({ termite_stations_rented: true });
  });

  test('the actual converter pattern path schedules one annual visit even beside a monthly plan fallback', () => {
    const annual = baitLine(annualMapped);
    const parent = { service_type: annual.name };
    expect(supportsConverterFollowUpSeeding(annual, parent, 'annual')).toBe(true);
    expect(converterFollowUpSeedingPattern(annual, parent, 'monthly')).toBe('annual');
    expect(annualPrepayCoverageCadence(annual, 'monthly')).toBe('annual');
    expect(annualPrepayCoverageVisits(annual, 'annual')).toBe(1);
    expect(supportsConverterFollowUpSeeding(annual, parent, 'quarterly')).toBe(false);
  });

  test('annual seeding requires the explicit program, Waves title, and one valid visit', () => {
    const annual = baitLine(annualMapped);
    const parent = { service_type: annual.name };
    for (const change of [
      { plan: 'quarterly' },
      { stationsOwnedBy: 'customer' },
      { visitsPerYear: 4 },
      { visitsPerYear: 0 },
      { visits: 4 },
      { frequency: 'quarterly' },
      { isCommercial: true },
    ]) {
      const line = { ...annual, ...change };
      expect(supportsConverterFollowUpSeeding(line, parent, 'annual')).toBe(false);
      expect(converterFollowUpSeedingPattern(line, parent, 'monthly')).not.toBe('annual');
    }
  });

  test('legacy quarterly, count-less, and commercial bait seeding behavior is unchanged', () => {
    const quarterly = baitLine(quarterlyMapped);
    const parent = { service_type: quarterly.name };
    expect(quarterly.visitsPerYear).toBe(4);
    expect(supportsConverterFollowUpSeeding(quarterly, parent, 'quarterly')).toBe(true);
    expect(converterFollowUpSeedingPattern(quarterly, parent, 'monthly')).toBe('quarterly');
    expect(annualPrepayCoverageCadence(quarterly, 'monthly')).toBe('monthly');
    const legacy = { service: 'termite_bait', name: 'Termite Bait', frequency: 'quarterly' };
    expect(supportsConverterFollowUpSeeding(legacy, parent, 'quarterly')).toBe(false);
    expect(converterFollowUpSeedingPattern(legacy, parent)).toBeNull();
    const commercial = { ...quarterly, isCommercial: true };
    expect(supportsConverterFollowUpSeeding(commercial, parent, 'annual')).toBe(false);
  });

  test('a reserved pest visit leaves annual bait for promotion with its annual identity intact', () => {
    const { combos, remaining } = combineRecurringServicesForScheduling(
      annualPestMapped.recurring.services, { acceptFrequency: 'quarterly' },
    );
    expect(combos).toEqual([]);
    const annual = remaining.find((line) => line.service === 'termite_bait');
    expect(annual).toMatchObject({ plan: 'annual_protection', stationsOwnedBy: 'waves', visitsPerYear: 1 });
    const promoted = promotedTermiteUnitForRemaining(annual, 'quarterly', 'quarterly');
    expect(promoted).toMatchObject({
      catalogServiceKey: 'termite_bait', pricingLine: annual,
      service: { name: annual.name, frequency: 'annual', visitsPerYear: 1,
        plan: 'annual_protection', stationsOwnedBy: 'waves' },
    });
    expect(converterFollowUpSeedingPattern(
      promoted.service, { service_type: promoted.service.name }, promoted.service.frequency, 'quarterly',
    )).toBe('annual');
    const quarterly = promotedTermiteUnitForRemaining(baitLine(quarterlyMapped), 'monthly', 'monthly');
    expect(quarterly.service).toMatchObject({ frequency: 'quarterly', visitsPerYear: 4 });
    expect(promotedTermiteUnitForRemaining({ ...annual, stationsOwnedBy: 'customer' }, 'quarterly', 'quarterly')).toBeNull();
    expect(promotedTermiteUnitForRemaining({ service: 'termite_bait', name: 'Legacy Bait' }, 'quarterly', 'quarterly')).toBeNull();
  });
});
