jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lawn-assessment-history', () => ({
  visitEligibility: jest.fn().mockResolvedValue({ propertyId: 'fixture-property' }),
  eligibleVisitIds: jest.fn().mockResolvedValue(['fixture-visit']),
  latestForCustomer: jest.fn(),
}));
jest.mock('../services/turf-height-service', () => ({
  getLatestTurfHeight: jest.fn().mockResolvedValue(null),
  getTurfHeightTrend: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/lawn-intelligence', () => ({ getCustomerPercentile: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/photos', () => ({ getViewUrl: jest.fn() }));
jest.mock('../services/fawn-weather', () => ({
  getSeasonalContext: jest.fn(() => ({})), getPressureSignals: jest.fn(() => []),
}));

const db = require('../models/db');
const history = require('../services/lawn-assessment-history');
const router = require('../routes/lawn-health');
const dashboard = router.stack.find((layer) => layer.route?.path === '/:customerId').route.stack[0].handle;

test('the scoped dashboard uses visit dates consistently in scores, trends, before/after and elapsed days', async () => {
  const original = process.env.GATE_LAWN_PROPERTY_HISTORY;
  process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
  const assessments = [
    { id: 'fixture-first', visit_date: '2026-01-01', service_date: '2026-03-05' },
    { id: 'fixture-last', visit_date: '2026-02-01', service_date: '2026-03-06' },
  ].map((row) => ({ ...row, turf_density: 70, weed_suppression: 60, color_health: 70, stress_damage: 50, fawn_temp_f: 75 }));
  history.latestForCustomer.mockResolvedValue(assessments);
  db.mockImplementation((table) => {
    if (table !== 'lawn_assessment_photos') throw new Error(`Unexpected table ${table}`);
    const query = { where: () => query, orderByRaw: () => query, limit: async () => [] };
    return query;
  });
  const res = { json: jest.fn() };
  const next = jest.fn();
  try {
    await dashboard({ params: { customerId: 'fixture-customer' }, customerId: 'fixture-customer' }, res, next);
    expect(next).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.initialScores.assessmentDate).toBe('2026-01-01');
    expect(payload.scores.assessmentDate).toBe('2026-02-01');
    expect(payload.beforeAfter.before.date).toBe('2026-01-01');
    expect(payload.beforeAfter.after.date).toBe('2026-02-01');
    expect(payload.beforeAfter.improvement.daysSinceStart).toBe(31);
    expect(payload.trend.map((point) => point.date)).toEqual(['2026-01-01', '2026-02-01']);
    expect(assessments[0].service_date).toBe('2026-03-05');
  } finally {
    if (original === undefined) delete process.env.GATE_LAWN_PROPERTY_HISTORY;
    else process.env.GATE_LAWN_PROPERTY_HISTORY = original;
  }
});
