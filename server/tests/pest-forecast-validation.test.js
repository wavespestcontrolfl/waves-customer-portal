const { evaluateForecasts, observationFromRecord } = require('../services/pest-forecast/validation');
const { computeForecast } = require('../services/pest-forecast/forecast');
const { BY_SLUG } = require('../services/pest-forecast/locations');

const record = (overrides = {}) => ({
  id: 'visit-1', customer_id: 'customer-1', technician_id: 'tech-1', status: 'completed', service_date: '2026-10-02',
  service_data: {
    reportIdentitySnapshot: { address: { city: 'Bradenton', state: 'FL' } },
    typedReportSnapshot: { type: 'one_time_pest_treatment', values: {
      pests_observed: 'Ghost ants', evidence_observed: 'Live pests observed', activity_level: 'Moderate',
    } },
  }, ...overrides,
});
const forecast = (date = '2026-10-01', city = 'bradenton-fl') => computeForecast(BY_SLUG.get(city),
  { hasWeather: true, source: 'nws', warm: true, wet: true }, new Date(`${date}T16:00:00Z`));

test.each([
  ['customer report', { pests_observed: 'Customer-reported activity only' }],
  ['AI-like prose', { pests_observed: 'Probably ghost ants' }],
  ['multiple pests', { pests_observed: 'Ghost ants, German cockroaches' }],
  ['dead evidence', { evidence_observed: 'Dead pests observed' }],
  ['contradictory evidence', { evidence_observed: 'Live pests observed, No evidence observed' }],
  ['none observed', { activity_level: 'None observed' }],
])('%s cannot become confirmed local evidence', (_label, values) => {
  const r = record();
  Object.assign(r.service_data.typedReportSnapshot.values, values);
  expect(observationFromRecord(r).observation).toBeUndefined();
});

test('frozen service city wins over a moved customer; missing frozen city stays unknown', () => {
  const r = record({ city: 'Sarasota', service_address_city: 'Sarasota', service_address_state: 'FL' });
  expect(observationFromRecord(r).observation.location).toBe('bradenton-fl');
  r.service_data.reportIdentitySnapshot.address.city = null;
  expect(observationFromRecord(r)).toEqual({ excluded: 'unverified_location' });
  delete r.service_data.reportIdentitySnapshot;
  expect(observationFromRecord(r).observation.location).toBe('sarasota-fl');
});

test('unperformed/internal records and missing technician provenance are excluded', () => {
  for (const overrides of [{ status: 'cancelled' }, { technician_id: null }, { structured_notes: { typedReportDelivery: 'internal_only' } }]) {
    expect(observationFromRecord(record(overrides)).observation).toBeUndefined();
  }
});

test.each([['German', 'german_roach'], ['American', 'palmetto_roach']])(
  'active cockroach form with explicit live %s roaches contributes an observation', (species, pest) => {
    const r = record();
    r.service_data.typedReportSnapshot = { type: 'cockroach', values: {
      species, evidence_observed: ['Live roaches', 'Droppings'], activity_level: 'Moderate',
    } };
    const out = evaluateForecasts({ records: [r], forecasts: [forecast()] });
    expect(out.coverage.matchedObservations).toBe(1);
    expect(out.results[0]).toMatchObject({ pest, samples: 1 });
    expect(out.publicAccuracyClaimsSupported).toBe(false);
  });

test.each([
  { species: 'Mixed' }, { species: 'Unknown' }, { species: 'Smoky brown' },
  { species: 'Probably German' }, { evidence_observed: ['Droppings', 'Dead roaches'] },
  { activity_level: 'None observed' },
])('cockroach evidence stays conservative for %j', overrides => {
  const r = record();
  r.service_data.typedReportSnapshot = { type: 'cockroach', values: {
    species: 'German', evidence_observed: ['Live roaches'], activity_level: 'Moderate', ...overrides,
  } };
  expect(observationFromRecord(r).observation).toBeUndefined();
});

test('only saved predictions before the observation day match; repeat callbacks do not inflate counts', () => {
  const records = [record(), record({ id: 'visit-2', service_date: '2026-10-03' })];
  const forecasts = [forecast(), forecast('2026-10-02'), forecast('2026-10-01', 'sarasota-fl')];
  const out = evaluateForecasts({ records, forecasts });
  expect(out.coverage).toMatchObject({ eligibleObservations: 2, duplicateCustomerWeeks: 1, matchedObservations: 1 });
  expect(out.results[0]).toMatchObject({ location: 'bradenton-fl', pest: 'ants', samples: 1 });
  expect(out.results[0].meanModelScore).toBe(7);
  expect(out.publicAccuracyClaimsSupported).toBe(false);
  expect(JSON.stringify(out)).not.toMatch(/customer-1|visit-1|tech-1/);
});

test.each([
  ['same day', () => forecast('2026-10-02')],
  ['older than seven days', () => forecast('2026-09-24')],
  ['another city', () => forecast('2026-10-01', 'sarasota-fl')],
  ['backdated payload captured after visit', () => ({ ...forecast(), generated_at: '2026-10-03T16:00:00Z' })],
  ['another model', () => ({ ...forecast(), model_version: 'another-model' })],
  ['incomplete ranking', () => ({ ...forecast(), pests: forecast().pests.slice(0, 1) })],
])('%s cannot validate a prediction', (_label, make) => {
  const out = evaluateForecasts({ records: [record()], forecasts: [make()] });
  expect(out.coverage.matchedObservations).toBe(0);
  expect(out.validationStatus).toBe('insufficient_evidence');
  expect(out.publicAccuracyClaimsSupported).toBe(false);
});

test('absence of observations or history is insufficient evidence, never perfect accuracy', () => {
  expect(evaluateForecasts({ records: [], forecasts: [] })).toMatchObject({ validationStatus: 'insufficient_evidence', publicAccuracyClaimsSupported: false });
  const out = evaluateForecasts({ records: [record()], forecasts: [] });
  expect(out.coverage.noPriorForecast).toBe(1);
  expect(out.results).toEqual([]);
});
