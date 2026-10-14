// Customer portal lawn health card under GATE_LAWN_LIGHTING (owner 2026-10-04): the
// card's "Color / Nutrients: +N from X%" compares the latest visit with the FIRST
// one, so the server flags it hidden (initialScores.colorHidden, improvement.colorHealth
// null) unless both visits were photographed in known, compatible light. Every other
// number is a raw reading and is untouched. Gate off: the payload is what it was.
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

const ENV = ['GATE_LAWN_PROPERTY_HISTORY', 'GATE_LAWN_LIGHTING', 'GATE_LAWN_VISIT_ASSESSMENT'];
const saved = {};
beforeEach(() => { ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); process.env.GATE_LAWN_PROPERTY_HISTORY = 'true'; });
afterEach(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

const run = (assessmentId, light) => ({
  assessment_id: assessmentId, prompt_version: 'lawn-visit-v1-shot-list-lighting', photo_ids: [`${assessmentId}-1`],
  photo_quality: [{ photo: 1, quality: 'adequate', issue: '', ...light }],
});
const SUN = { lighting: 'full_sun', hard_shadows: 'no' };
const CLOUD = { lighting: 'overcast', hard_shadows: 'no' };

async function payload({ runs = [], runsFail = false } = {}) {
  const rows = [
    { id: 'first', visit_date: '2026-01-01', service_date: '2026-01-01', color_health: 60 },
    { id: 'last', visit_date: '2026-02-01', service_date: '2026-02-01', color_health: 80 },
  ].map((row) => ({ turf_density: 70, weed_suppression: 60, stress_damage: 50, fawn_temp_f: 75, ...row }));
  history.latestForCustomer.mockResolvedValue(rows);
  const tables = [];
  db.mockImplementation((table) => {
    tables.push(table);
    const photoRows = ['first', 'last'].map((id) => ({ id: `${id}-1`, assessment_id: id, zone: 'front' }));
    const query = {
      where: () => query, whereIn: () => query, orderByRaw: () => query, limit: async () => [],
      select: async () => {
        if (table === 'lawn_assessment_runs') { if (runsFail) throw new Error('runs down'); return runs; }
        return photoRows;
      },
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    };
    return query;
  });
  const res = { json: jest.fn() };
  const next = jest.fn();
  await dashboard({ params: { customerId: 'cust-1' }, customerId: 'cust-1' }, res, next);
  expect(next).not.toHaveBeenCalled();
  return { body: res.json.mock.calls[0][0], tables };
}
const live = () => { process.env.GATE_LAWN_LIGHTING = 'true'; process.env.GATE_LAWN_VISIT_ASSESSMENT = 'true'; };

test('gate off: no run read, the color comparison is what it was', async () => {
  const { body, tables } = await payload({ runs: [run('first', SUN), run('last', CLOUD)] });
  expect(tables).not.toContain('lawn_assessment_runs');
  expect(body.initialScores).not.toHaveProperty('colorHidden');
  expect(body.beforeAfter.improvement.colorHealth).toBe(20);
});

test('gate on, compatible light on the first and latest visit: unchanged', async () => {
  live();
  const { body } = await payload({ runs: [run('first', SUN), run('last', SUN)] });
  expect(body.initialScores).not.toHaveProperty('colorHidden');
  expect(body.beforeAfter.improvement.colorHealth).toBe(20);
});

test('gate on, different / unknown / unreadable light: the color comparison is hidden, every other reading is untouched', async () => {
  const off = (await payload({ runs: [] })).body;
  live();
  for (const input of [
    { runs: [run('first', SUN), run('last', CLOUD)] },
    { runs: [run('first', {}), run('last', SUN)] },
    { runs: [] },
    { runsFail: true },
  ]) {
    const { body } = await payload(input);
    expect(body.initialScores.colorHidden).toBe(true);
    expect(body.initialScores.colorHealth).toBe(off.initialScores.colorHealth); // the raw reading stays; the client hides the comparison
    expect(body.beforeAfter.improvement.colorHealth).toBeNull();
    expect(body.beforeAfter.improvement.overall).toBe(off.beforeAfter.improvement.overall);
    expect(body.scores).toEqual(off.scores);
    expect(body.trend).toEqual(off.trend);
  }
});

test('the gate needs the visit assessment gate too (no light is ever stored without it)', async () => {
  process.env.GATE_LAWN_LIGHTING = 'true';
  const { body, tables } = await payload({ runs: [run('first', SUN), run('last', CLOUD)] });
  expect(tables).not.toContain('lawn_assessment_runs');
  expect(body.initialScores).not.toHaveProperty('colorHidden');
});
