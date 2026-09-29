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
  // period_end is exclusive: a window is [start, end). scale = stored score_scale.
  const win = (start, end, avg, scale) => ({
    period_start: start, period_end: end, avg_pressure_index: avg, sample_size: 40, score_scale: scale,
  });

  test('windows are compared by their stored scale, not their dates', async () => {
    const ctx = await buildNeighborhoodPressureContext({
      record: rec,
      knex: knexWith([
        win('2026-11-01', '2026-12-01', 2.0, 'technician_rating'),
        win('2026-10-01', '2026-10-31', 1.9, 'technician_rating'),
        win('2026-09-01', '2026-09-24', 0.6, 'blended'),
      ]),
    });
    expect(ctx.points.map((p) => p.avgPressureIndex)).toEqual([1.9, 2.0]);
    expect(ctx.customerSummary).toBe('Nearby WaveGuard homes averaged 2.0 this month.');
  });

  test('a window spanning the cutover is fine when the builder averaged only tap readings', async () => {
    const ctx = await buildNeighborhoodPressureContext({
      record: rec,
      knex: knexWith([win('2026-09-10', '2026-10-10', 1.1, 'technician_rating')]),
    });
    expect(ctx.points.map((p) => p.avgPressureIndex)).toEqual([1.1]);
  });

  test('legacy rows without a stored scale that reach past the cutover are unknown: hidden', async () => {
    const ctx = await buildNeighborhoodPressureContext({
      record: rec,
      knex: knexWith([win('2026-09-01', '2026-09-30', 1.1, null), win('2026-08-01', '2026-08-31', 0.6, null)]),
    });
    expect(ctx).toBeUndefined();
  });

  test('legacy rows that ended before the cutover are blended and still chart together', async () => {
    const ctx = await buildNeighborhoodPressureContext({
      record: rec,
      knex: knexWith([win('2026-08-01', '2026-08-31', 0.7, null), win('2026-07-01', '2026-07-31', 0.6, null)]),
    });
    expect(ctx.points).toHaveLength(2);
  });

  test('a legacy unknown row is never charted beside a stored-scale window', async () => {
    const ctx = await buildNeighborhoodPressureContext({
      record: rec,
      knex: knexWith([win('2026-11-01', '2026-12-01', 2.0, 'technician_rating'), win('2026-09-01', '2026-09-30', 1.1, null)]),
    });
    expect(ctx.points.map((p) => p.avgPressureIndex)).toEqual([2.0]);
  });
});

describe('neighborhood aggregate builder averages one scale per window, by provenance', () => {
  const { buildNeighborhoodPressureAggregates } = require('../services/service-report/neighborhood-pressure-aggregates');
  function builderKnex({ scoreScaleColumn }) {
    const calls = { raw: [], inserted: null };
    const knex = (table) => {
      const q = {
        columnInfo: () => Promise.resolve(table === 'neighborhood_pressure_aggregates' ? (scoreScaleColumn ? { score_scale: {} } : {}) : { county: {} }),
        where: () => q,
        del: () => Promise.resolve(0),
        insert: (rows) => { calls.inserted = rows; return Promise.resolve(); },
      };
      return q;
    };
    knex.raw = jest.fn(async (sql, bindings) => {
      calls.raw.push({ sql, bindings });
      return { rows: [{ county: 'Sarasota', postal_code: '34236', service_line: 'pest', avg_pressure_index: '2.0', median_pressure_index: '2.0', sample_size: 30 }] };
    });
    return { knex, calls };
  }

  test('a post-cutover window averages only technician-rated readings and stores its scale', async () => {
    const { knex, calls } = builderKnex({ scoreScaleColumn: true });
    await buildNeighborhoodPressureAggregates({ now: new Date('2026-10-05T12:00:00Z'), knex });
    const { sql } = calls.raw[0];
    expect(sql).toMatch(/LEFT JOIN pest_pressure_scores pps/);
    expect(sql).toMatch(/AND \(pps\.id IS NOT NULL AND jsonb_exists\(pps\.component_scores, 'technicianActivityRating'\)\)/);
    expect(sql).not.toMatch(/AND NOT \(pps/);
    expect(calls.inserted[0].score_scale).toBe('technician_rating');
  });

  test('a window that ended by the cutover averages only non-tap (blended) readings', async () => {
    const { knex, calls } = builderKnex({ scoreScaleColumn: true });
    await buildNeighborhoodPressureAggregates({ now: new Date('2026-09-20T12:00:00Z'), knex });
    expect(calls.raw[0].sql).toMatch(/AND NOT \(pps\.id IS NOT NULL AND jsonb_exists/);
    expect(calls.inserted[0].score_scale).toBe('blended');
  });

  test('before the score_scale column exists the row is written legacy-shaped (reader then hides it)', async () => {
    const { knex, calls } = builderKnex({ scoreScaleColumn: false });
    await buildNeighborhoodPressureAggregates({ now: new Date('2026-10-05T12:00:00Z'), knex });
    expect(calls.inserted[0]).not.toHaveProperty('score_scale');
  });
});

describe('fail closed on missing provenance (codex r1 P2)', () => {
  const { classifyScoreScale, scaleForVisit, loadScaleMap, isComparable } = require('../services/pest-pressure/score-scale');
  const { loadPreviousScore } = jest.requireActual('../services/pest-pressure/store');

  test('classification: pre-cutover blended, post-cutover unknown, never comparable to itself', () => {
    expect(classifyScoreScale({ componentScores: null, at: '2026-06-10' })).toBe('blended');
    expect(classifyScoreScale({ componentScores: null, at: '2026-10-01' })).toBe('unknown');
    expect(classifyScoreScale({ componentScores: undefined, at: undefined })).toBe('unknown');
    expect(isComparable('unknown', 'unknown')).toBe(false);
    expect(isComparable('blended', 'blended')).toBe(true);
  });

  test('a throwing lookup leaves post-cutover visits unknown and pre-cutover ones blended', async () => {
    const knex = () => {
      const q = { whereIn: () => q, select: () => q, catch: (h) => Promise.reject(new Error('down')).catch(h) };
      return q;
    };
    const map = await loadScaleMap(knex, ['a']);
    expect(scaleForVisit(map, { id: 'a', service_date: '2026-10-01' })).toBe('unknown');
    expect(scaleForVisit(map, { id: 'b', service_date: '2026-06-01' })).toBe('blended');
  });

  test('since-last-visit omits the line when provenance is unavailable after the cutover', async () => {
    const knex = (table) => {
      const data = table === 'service_records' ? [{ id: 'p', pressure_index: 1, service_date: '2026-09-26', started_at: '2026-09-26T15:00:00Z' }] : [];
      const q = {
        where: () => q, whereNot: () => q, whereIn: () => q, orderBy: () => q, select: () => q, modify: () => q,
        first: () => Promise.resolve(data[0]),
        catch: (h) => (table === 'pest_pressure_scores' ? Promise.reject(new Error('down')).catch(h) : Promise.resolve(data)),
        then: (r, j) => Promise.resolve(data).then(r, j),
      };
      return q;
    };
    const ctx = await buildSinceLastVisitContext({
      record: { id: 'c', customer_id: 'c1', service_type: 'Quarterly Pest Control', service_line: 'pest', service_date: '2026-10-05', started_at: '2026-10-05T15:00:00Z', pressure_index: 3 },
      knex,
    });
    expect(ctx.pressureLine).toBeUndefined();
  });

  test('loadPreviousScore never treats an unreadable post-cutover score row as same-scale', async () => {
    const q = {};
    ['where', 'whereNot', 'whereNotNull', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.limit = jest.fn(() => q);
    q.select = jest.fn(async () => [{ displayed_score: '4.0', service_date: '2026-09-26', service_record_id: 'x', component_scores: null }]);
    const result = await loadPreviousScore(() => q, { customerId: 'c', currentScale: 'technician_rating' });
    expect(result).toEqual({ value: null, otherScaleOnly: true });
  });

  test('property score does not diff against an unknown-provenance score', async () => {
    store.loadActiveConfig.mockResolvedValue(DEFAULT_CONFIG);
    const mk = (id, date, score, scale) => ({ service_record_id: id, service_date: date, displayed_score: score, data_completeness: 'complete', trend: 'stable', label_name: 'x', pressure_scale: scale });
    store.loadHistoryForCustomer.mockResolvedValue([mk('a', '2026-10-28', 3, 'unknown'), mk('b', '2026-10-01', 4, 'unknown')]);
    const knex = (table) => {
      const data = table === 'pest_pressure_scores' ? [] : ['a', 'b'].map((id) => ({ id, customer_id: 'c1', service_type: 'Quarterly Pest Control', service_line: 'pest', status: 'completed' }));
      const q = { whereIn: () => q, catch: () => Promise.resolve(data), then: (r, j) => Promise.resolve(data).then(r, j) };
      return q;
    };
    const out = await _test.pestComponent('c1', knex, new Set(['pest']));
    expect(out.status).toBe('scored');
    expect(out.previousScore).toBeNull();
  });
});

describe('pest pressure chart history', () => {
  const rows = [
    { service_date: '2026-09-28', displayed_score: 3, pressure_scale: 'technician_rating' },
    { service_date: '2026-09-25', displayed_score: 4, pressure_scale: 'technician_rating' },
    { service_date: '2026-06-10', displayed_score: 0.9, pressure_scale: 'blended' },
  ];
  const scoreRow = { displayed_score: 3, data_completeness: 'complete', trend: 'first_marker', service_date: '2026-09-28' };

  test('cadence is computed from every scored visit, not just the plotted same-scale ones', () => {
    const monthly = [
      { service_date: '2026-09-28', displayed_score: 3, pressure_scale: 'technician_rating' },
      { service_date: '2026-08-29', displayed_score: 0.9, pressure_scale: 'blended' },
      { service_date: '2026-07-30', displayed_score: 0.8, pressure_scale: 'blended' },
    ];
    const view = buildPestPressureCustomerView({
      config: DEFAULT_CONFIG,
      scoreRow,
      historyRows: monthly,
      serviceRecord: { service_type: 'Quarterly Pest Control', service_line: 'pest' },
    });
    expect(view.history).toHaveLength(1);
    expect(view.cadence).toBe('monthly');
  });

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
