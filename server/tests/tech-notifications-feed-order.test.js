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

test('visit_* rows sort behind fresh prompts AND stale/storm rows, before recency', async () => {
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
  // visit rows → bucket 2; fresh non-storm prompts → 0; everything else → 1.
  expect(sql).toMatch(/WHEN type LIKE 'visit\\_%' THEN 2/);
  expect(sql.indexOf("visit\\_%")).toBeLessThan(sql.indexOf("type != 'storm_watch_alert'"));
  expect(calls.orderBy).toEqual([['created_at', 'desc']]);
  expect(calls.limit).toEqual([20]);
  expect(res.json).toHaveBeenCalledWith({ notifications: [] });
});
