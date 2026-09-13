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

test('buckets: tracking (0) → fresh prompts (1) → fresh storms (2) → visit notices AND stale rows on recency (3)', async () => {
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

  expect(calls.orderByRaw).toHaveLength(2);
  const sql = calls.orderByRaw[0];
  // visit rows + tech-line texts → 2; storms → 1; fresh other prompts → 0;
  // stale others → 2 (stale legacy rows compete with visits on recency,
  // never ahead of them).
  // Missing-tracking notices lead the window at ANY age, in their OWN bucket:
  // they exist only while the visit is still overdue with no arrival evidence
  // (the sweep dismisses them as soon as that stops being true), so one that
  // aged past six hours must not fall in behind 20 routine kept cards — nor
  // behind 20 fresh geofence/timer prompts, which is what sharing bucket 0
  // with them allowed (codex P2, PR #4403 rounds 8 and 17).
  expect(sql).toMatch(/WHEN type = 'follow_through_tracking' THEN 0/);
  expect(sql.indexOf("follow_through_tracking")).toBeLessThan(sql.indexOf("interval '6 hours'"));
  expect(sql).toMatch(/WHEN type LIKE 'visit\\_%' OR type = 'tech_line_sms' THEN 3/);
  expect(sql).toMatch(/WHEN type = 'storm_watch_alert' THEN 2/);
  expect(sql).toMatch(/interval '6 hours' THEN 1 ELSE 3 END/);
  // Stage 2 before stage 1 inside the tracking bucket, before the limit
  // truncates — the client's stage-first sort cannot rescue a row the 20-row
  // window never returned (round-20 P2).
  expect(calls.orderByRaw[1]).toMatch(/follow_through_tracking' THEN COALESCE\(\(payload->>'stage'\)::int, 0\) ELSE 0 END DESC/);
  expect(calls.orderBy).toEqual([['created_at', 'desc']]);
  expect(calls.limit).toEqual([20]);
  expect(res.json).toHaveBeenCalledWith({ notifications: [] });
});

// GATE_NOSHOW_DETECTOR is the feature's kill switch, and turning it off stops
// the sweep that dismisses tracking notices when their visit completes, moves
// or is reassigned — so the feed must stop serving them too, or a disabled
// feature leaves stale cards leading every tech's window (codex P1, PR #4403
// round 9).
test('tracking notices are served only while GATE_NOSHOW_DETECTOR is on', async () => {
  const run = async () => {
    const notCalls = [];
    const chain = {};
    for (const m of ['where', 'whereNull', 'orWhereRaw']) {
      chain[m] = jest.fn(function (arg) { if (typeof arg === 'function') arg.call(chain, chain); return chain; });
    }
    chain.whereNot = jest.fn((arg) => { notCalls.push(arg); return chain; });
    chain.orderByRaw = jest.fn(() => chain);
    chain.orderBy = jest.fn(() => chain);
    chain.limit = jest.fn(() => chain);
    chain.then = (res, rej) => Promise.resolve([]).then(res, rej);
    db.mockImplementation(() => chain);
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await getHandler()({ technicianId: 't-1', query: {} }, res, jest.fn());
    return notCalls;
  };

  delete process.env.GATE_NOSHOW_DETECTOR;
  expect(await run()).toContainEqual({ type: 'follow_through_tracking' });

  process.env.GATE_NOSHOW_DETECTOR = 'true';
  expect(await run()).not.toContainEqual({ type: 'follow_through_tracking' });
  delete process.env.GATE_NOSHOW_DETECTOR;
});
