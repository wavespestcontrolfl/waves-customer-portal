// #4741 (2026-09-24): a technician's tap became the Pest Pressure score
// directly (tap 3 = 3.0) while older scores were blended (tap 3 = 0.9) and
// were never recalculated. Every customer-facing surface that compares or
// charts two stored readings must only pair readings on the SAME scale.

jest.mock('../services/pest-pressure/store', () => ({
  loadActiveConfig: jest.fn(),
  loadHistoryForCustomer: jest.fn(),
}));
jest.mock('../services/pest-pressure/one-time-exclusion', () => ({
  isOneTimePressureExcludedRecord: jest.fn(async () => false),
}));

const store = require('../services/pest-pressure/store');
const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');
const { buildSinceLastVisitContext } = require('../services/service-report/since-last-visit');
const { buildNeighborhoodPressureContext } = require('../services/service-report/neighborhood-pressure');
const { buildPestPressureCustomerView } = require('../services/pest-pressure/customer-view');
const { _test } = require('../services/property-score');

const TAP = { technicianActivityRating: { value: 3, weight: 100, present: true } };
const BLENDED = { clientRating: { value: 3, weight: 25, present: true } };

describe('since-last-visit "Pressure: a -> b" line', () => {
  function fakeKnex({ prior, scores }) {
    return (table) => {
      const data = { service_records: prior ? [prior] : [], pest_pressure_scores: scores, service_findings: [] }[table] || [];
      const q = {
        where: () => q, whereNot: () => q, whereIn: () => q, orderBy: () => q, select: () => q, modify: () => q,
        first: () => Promise.resolve(data[0]),
        catch: () => Promise.resolve(data),
        then: (resolve, reject) => Promise.resolve(data).then(resolve, reject),
      };
      return q;
    };
  }
  const record = { id: 'rec-now', customer_id: 'c1', service_type: 'Quarterly Pest Control', service_line: 'pest', service_date: '2026-09-28', started_at: '2026-09-28T15:00:00Z', pressure_index: 3 };
  const june = { id: 'rec-june', pressure_index: 0.9, service_date: '2026-06-10', started_at: '2026-06-10T15:00:00Z' };

  test('omits the line when the prior reading is on the other scale', async () => {
    const ctx = await buildSinceLastVisitContext({
      record,
      knex: fakeKnex({ prior: june, scores: [
        { service_record_id: 'rec-now', component_scores: TAP },
        { service_record_id: 'rec-june', component_scores: BLENDED },
      ] }),
    });
    expect(ctx.priorServiceRecordId).toBe('rec-june');
    expect(ctx.pressureLine).toBeUndefined();
  });

  test('omits the line on the cutover-date fallback too (no score rows)', async () => {
    const ctx = await buildSinceLastVisitContext({ record, knex: fakeKnex({ prior: june, scores: [] }) });
    expect(ctx.pressureLine).toBeUndefined();
  });

  test('keeps the line when both readings share a scale', async () => {
    const ctx = await buildSinceLastVisitContext({
      record: { ...record, pressure_index: 2 },
      knex: fakeKnex({ prior: { ...june, id: 'rec-sep', pressure_index: 4, service_date: '2026-09-25', started_at: '2026-09-25T15:00:00Z' }, scores: [
        { service_record_id: 'rec-now', component_scores: TAP },
        { service_record_id: 'rec-sep', component_scores: TAP },
      ] }),
    });
    expect(ctx.pressureLine).toBe('Pressure: 4.0 -> 2.0');
  });
});

describe('neighborhood average chart', () => {
  function knexWith(rows) {
    const q = { where: () => q, orderBy: () => q, limit: () => q, catch: () => Promise.resolve(rows) };
    return () => q;
  }
  const rec = { id: 'r', county: 'Sarasota', service_line: 'pest' };
  const win = (start, avg) => ({ period_start: start, period_end: start, avg_pressure_index: avg, sample_size: 40 });

  test('windows from before the cutover are not charted next to windows after it', async () => {
    const ctx = await buildNeighborhoodPressureContext({
      record: rec,
      knex: knexWith([win('2026-11-01', 2.0), win('2026-10-01', 1.9), win('2026-09-01', 0.6)]),
    });
    expect(ctx.points.map((p) => p.avgPressureIndex)).toEqual([1.9, 2.0]);
    expect(ctx.customerSummary).toBe('Nearby WaveGuard homes averaged 2.0 this month.');
  });

  test('all-old-scale windows still chart together', async () => {
    const ctx = await buildNeighborhoodPressureContext({
      record: rec,
      knex: knexWith([win('2026-08-01', 0.7), win('2026-07-01', 0.6)]),
    });
    expect(ctx.points).toHaveLength(2);
  });
});

describe('pest pressure chart history', () => {
  const rows = [
    { service_date: '2026-09-28', displayed_score: 3, pressure_scale: 'technician_rating' },
    { service_date: '2026-09-25', displayed_score: 4, pressure_scale: 'technician_rating' },
    { service_date: '2026-06-10', displayed_score: 0.9, pressure_scale: 'blended' },
  ];
  const scoreRow = { displayed_score: 3, data_completeness: 'complete', trend: 'first_marker', service_date: '2026-09-28' };

  test('does not plot old blended readings beside tap readings', () => {
    const view = buildPestPressureCustomerView({
      config: DEFAULT_CONFIG, scoreRow, historyRows: rows, serviceRecord: { service_type: 'Quarterly Pest Control', service_line: 'pest' },
    });
    expect(view.history.map((h) => h.score)).toEqual([4, 3]);
  });
});

describe('property score previous value', () => {
  const record = (id) => ({ id, customer_id: 'c1', service_type: 'Quarterly Pest Control', service_line: 'pest', status: 'completed' });
  function knexFor(ids) {
    return (table) => {
      const data = table === 'pest_pressure_scores'
        ? []
        : ids.map(record);
      const q = { whereIn: () => q, catch: () => Promise.resolve(data), then: (r, j) => Promise.resolve(data).then(r, j) };
      return q;
    };
  }
  const base = (id, date, score, scale) => ({
    service_record_id: id, service_date: date, displayed_score: score, data_completeness: 'complete',
    trend: 'stable', label_name: 'x', pressure_scale: scale,
  });

  beforeEach(() => store.loadActiveConfig.mockResolvedValue(DEFAULT_CONFIG));

  test('no delta against a previous score on the other scale', async () => {
    store.loadHistoryForCustomer.mockResolvedValue([
      base('a', '2026-09-28', 3, 'technician_rating'),
      base('b', '2026-06-10', 0.9, 'blended'),
    ]);
    const out = await _test.pestComponent('c1', knexFor(['a', 'b']), new Set(['pest']));
    expect(out.status).toBe('scored');
    expect(out.previousScore).toBeNull();
    expect(out.delta).toBeNull();
  });

  test('still pairs same-scale scores, skipping an other-scale row between them', async () => {
    store.loadHistoryForCustomer.mockResolvedValue([
      base('a', '2026-10-28', 2, 'technician_rating'),
      base('b', '2026-09-28', 0.9, 'blended'),
      base('c', '2026-09-25', 4, 'technician_rating'),
    ]);
    const out = await _test.pestComponent('c1', knexFor(['a', 'b', 'c']), new Set(['pest']));
    expect(out.previousScore).toBe(20);
    expect(out.delta).toBe(60 - 20);
  });
});
