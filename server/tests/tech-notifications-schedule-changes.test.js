// The Today page's schedule-change cards (owner ruling 2026-10-03): every open
// visit_* card for the signed-in tech, a change touching today or tomorrow
// marked `soon` (its own card, listed first so the cap never cuts one off),
// a count of every other open change, and one "clear all" that covers the
// whole non-soon set up to the read the tech saw — only this tech's own
// schedule-change cards (Codex #5783 P2: past the 300-row cap too).
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
const { etDateString, addETDays } = require('../utils/datetime-et');

db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));

function handler(path, method) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

// Each db(...) call gets its own recording chain resolving to the next result.
function stubDb(results) {
  const chains = [];
  db.mockImplementation((table) => {
    const calls = { table };
    const chain = {};
    for (const m of ['leftJoin', 'where', 'whereNull', 'whereIn', 'whereRaw', 'orderBy', 'orderByRaw', 'limit', 'select', 'count']) {
      chain[m] = jest.fn((...args) => {
        (calls[m] ||= []).push(args);
        if (m === 'leftJoin' && typeof args[1] === 'function') {
          const on = { on: jest.fn((...o) => { calls.on = o; return on; }) };
          args[1].call(on);
        }
        return chain;
      });
    }
    chain.update = jest.fn(async (patch) => { calls.update = patch; return results.shift(); });
    chain.then = (res, rej) => Promise.resolve(results.shift()).then(res, rej);
    chains.push(calls);
    return chain;
  });
  return chains;
}

const ID = (n) => `00000000-0000-4000-8000-00000000000${n}`;

describe('GET /schedule-changes', () => {
  test('soon is decided in SQL from the new/previous day (today or tomorrow ET), soon rows first; later_total counts every non-soon card', async () => {
    const today = etDateString(new Date());
    const tomorrow = etDateString(addETDays(new Date(), 1));
    const rows = [
      { id: ID(2), type: 'visit_rescheduled', payload: JSON.stringify({ previous_date: today }), soon: true },
      { id: ID(1), type: 'visit_rescheduled', payload: { date: '2026-12-15' }, soon: false },
    ];
    const chains = stubDb([rows, [{ n: '412' }]]);
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await handler('/schedule-changes', 'get')({ technicianId: 't-1' }, res, (e) => { throw e; });

    const [list, count] = chains;
    expect(list.where[0]).toEqual(['n.technician_id', 't-1']);
    expect(list.whereIn[0]).toEqual(['n.type', ['visit_assigned', 'visit_unassigned', 'visit_rescheduled', 'visit_cancelled']]);
    // Joined on the uuid primary key, the payload id pattern-checked first.
    expect(list.on[0]).toBe('s.id');
    expect(list.on[2].sql).toMatch(/CASE WHEN n\.payload->>'visit_id' ~\* '.+' THEN \(n\.payload->>'visit_id'\)::uuid END/);
    expect(list.orderByRaw[0][0]).toMatch(/^COALESCE\(.*\) DESC$/);
    expect(list.orderByRaw[0][1]).toEqual([today, tomorrow, today, tomorrow, today, tomorrow]);
    expect(list.limit[0]).toEqual([300]);
    expect(count.whereRaw[0][0]).toMatch(/^NOT COALESCE\(/);

    const body = res.json.mock.calls[0][0];
    expect(body.changes.map((c) => [c.id, c.soon])).toEqual([[ID(2), true], [ID(1), false]]);
    expect(body.changes[0].payload.previous_date).toBe(today);
    expect(body.later_total).toBe(412);
    expect(Number.isNaN(Date.parse(body.as_of))).toBe(false);
  });
});

describe('POST /dismiss-batch', () => {
  test('clears every open non-soon card of this tech written by as_of, in one update', async () => {
    const chains = stubDb([37]);
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await handler('/dismiss-batch', 'post')({ technicianId: 't-1', body: { as_of: '2026-10-03T10:00:00.000Z' } }, res, (e) => { throw e; });

    const [scope, update] = chains;
    expect(scope.where).toEqual([['n.technician_id', 't-1'], ['n.created_at', '<=', new Date('2026-10-03T10:00:00.000Z')]]);
    expect(scope.whereRaw[0][0]).toMatch(/^NOT COALESCE\(/);
    expect(scope.select[0]).toEqual(['n.id']);
    expect(update.table).toBe('tech_notifications');
    expect(update.whereNull[0]).toEqual(['dismissed_at']);
    expect(update.update).toMatchObject({ read: true, dismissed_at: expect.any(Date) });
    expect(res.json).toHaveBeenCalledWith({ success: true, dismissed: 37 });
  });

  test.each([
    ['no as_of', {}],
    ['an unparseable as_of', { as_of: 'yesterday-ish' }],
  ])('%s → 400, nothing written', async (_label, body) => {
    db.mockReset();
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await handler('/dismiss-batch', 'post')({ technicianId: 't-1', body }, res, (e) => { throw e; });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(db).not.toHaveBeenCalled();
  });
});
