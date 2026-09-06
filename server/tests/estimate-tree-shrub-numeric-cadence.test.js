const Converter = require('../services/estimate-converter');
const Seeder = require('../services/recurring-appointment-seeder');

const line = { service: 'tree_shrub', frequency: 9, visitsPerYear: 9, annual: 917 };

describe('tree/shrub numeric nine uses its sold cadence for prepay and followups', () => {
  test.each([9, '9', 'every_6_weeks'])('frequency %s gives nine applications with 42-day spacing', frequency => {
    const svc = { ...line, frequency };
    const cadence = Converter.annualPrepayCoverageCadence(svc, 'quarterly');
    expect(cadence).toBe('every_6_weeks');
    expect(Converter.annualPrepayCoverageVisits(svc, cadence, 'quarterly')).toBe(9);
    expect(Converter.converterFollowUpSeedingPattern(svc, { service_type: 'Tree & Shrub' }, 'quarterly')).toBe(cadence);
  });

  test.each([{ visits: 6 }, { visitsPerYear: 6 }, { visits: 0 }, { isCommercial: true }])('contradictory or commercial shape refuses coverage: %j', overrides => {
    const svc = { ...line, ...overrides };
    expect(Converter.annualPrepayCoverageCadence(svc)).toBe(Converter.PREPAY_COVERAGE_INVALID);
    expect(Converter.converterFollowUpSeedingPattern(svc, {}, 'quarterly')).toBe(null);
  });

  test('legacy count-only tree/shrub stays office scheduled and mosquito stays seasonal', () => {
    expect(Converter.converterFollowUpSeedingPattern({ service: 'tree_shrub', visitsPerYear: 9 }, {}, null)).toBe(null);
    expect(Converter.annualPrepayCoverageCadence({ service: 'mosquito', frequency: 9, visitsPerYear: 9 })).toBe(Seeder.SEASONAL_FEB_OCT);
    expect(Seeder.normalizeRecurringPattern(9)).toBe('bimonthly');
  });
});

test('conflicting cadence fields never mint a prepay term', () => {
  expect(Converter.annualPrepayCoverageCadence({ ...line, cadence: 'quarterly' })).toBe(Converter.PREPAY_COVERAGE_INVALID);
  expect(Converter.annualPrepayCoverageCadence({ service: 'tree_shrub', visitsPerYear: 9 })).toBe(Converter.PREPAY_COVERAGE_INVALID);
});
