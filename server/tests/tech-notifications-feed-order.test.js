// GET /api/tech/notifications ranks visit notices (visit_*) LAST inside the
// 20-row window: they never expire and a bulk assign can mint dozens, so
// they must not crowd an actionable geofence/Undo prompt or a fresh storm
// warning out of the poll (pre-push audit P1 on the tech-visit-notices PR).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/time-tracking', () => ({}));
jest.mock('../services/geofence-matcher', () => ({ logEvent: jest.fn() }));
jest.mock('../services/geofence-handler', () => ({ markOnPropertyFromGeofence: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const db = require('../models/db');
const router = require('../routes/tech-notifications');

function getHandler() {
  const layer = router.stack.find((l) => l.route?.path === '/' && l.route.methods.get);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

test('buckets: fresh prompts (0) → fresh storms (1) → visit notices AND stale rows on recency (2)', async () => {
  const calls = { orderByRaw: [], orderBy: [], limit: [] };
  const chain = {};
  for (const m of ['where', 'whereNull', 'whereNot', 'orWhereRaw']) {
    chain[m] = jest.fn(function (arg) { if (typeof arg === 'function') arg.call(chain, chain); return chain; });
  }
  chain.orderByRaw = jest.fn((sql) => { calls.orderByRaw.push(sql); return chain; });
  chain.orderBy = jest.fn((col, dir) => { calls.orderBy.push([col, dir]); return chain; });
  chain.limit = jest.fn((n) => { calls.limit.push(n); return chain; });
  chain.then = (res, rej) => Promise.resolve([]).then(res, rej);
  db.mockImplementation(() => chain);

  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  await getHandler()({ technicianId: 't-1', query: {} }, res, jest.fn());

  expect(calls.orderByRaw).toHaveLength(1);
  const sql = calls.orderByRaw[0];
  // visit rows → 2; storms → 1; fresh other prompts → 0; stale others → 2
  // (stale legacy rows compete with visits on recency, never ahead of them).
  expect(sql).toMatch(/WHEN type LIKE 'visit\\_%' THEN 2/);
  expect(sql).toMatch(/WHEN type = 'storm_watch_alert' THEN 1/);
  expect(sql).toMatch(/interval '6 hours' THEN 0 ELSE 2 END/);
  expect(calls.orderBy).toEqual([['created_at', 'desc']]);
  expect(calls.limit).toEqual([20]);
  expect(res.json).toHaveBeenCalledWith({ notifications: [] });
});
