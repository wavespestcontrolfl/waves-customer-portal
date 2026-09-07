jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockHealth = { average: 0, failAverage: false, predicates: [] };
jest.mock('../models/db', () => {
  const db = jest.fn(() => {
    let average = false;
    const query = {};
    for (const method of ['whereNotExists', 'whereIn', 'where', 'whereNotNull', 'whereNull', 'select', 'count', 'sum', 'groupBy', 'orderBy', 'limit', 'join', 'leftJoin']) query[method] = (...args) => { if (method === 'whereIn') mockHealth.predicates.push(args); return query; };
    query.avg = () => { average = true; return query; };
    query.first = async () => { if (average && mockHealth.failAverage) throw new Error('Read failed'); return { avg: mockHealth.average, count: 0, total: 0 }; };
    query.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return query;
  });
  db.raw = jest.fn(sql => sql);
  return db;
});
const router = require('../routes/admin-health');
async function dashboard() {
  const handler = router.stack.find(layer => layer.route?.path === '/dashboard').route.stack.at(-1).handle;
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  await handler({}, res);
  return res.json.mock.calls[0][0];
}
beforeEach(() => { mockHealth.average = 0; mockHealth.failAverage = false; mockHealth.predicates = []; });
test('preserves a measured zero and scopes the at-risk list to actual risk records', async () => {
  expect(await dashboard()).toMatchObject({ complete: true, fleetHealthAvg: 0 });
  expect(mockHealth.predicates).toContainEqual(['customer_health_scores.churn_risk', ['high', 'critical']]);
});
test('a failed source is incomplete, not a fabricated 50 or healthy fleet', async () => {
  mockHealth.failAverage = true;
  expect(await dashboard()).toMatchObject({ complete: false, fleetHealthAvg: null });
});
test('an empty score table has no numerical average', async () => {
  mockHealth.average = null;
  expect(await dashboard()).toMatchObject({ complete: true, fleetHealthAvg: null });
});
