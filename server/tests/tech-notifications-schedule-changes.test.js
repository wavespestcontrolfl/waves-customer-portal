// The Today page's schedule-change cards (owner ruling 2026-10-03): every open
// visit_* card for the signed-in tech, a change touching today or tomorrow
// marked `soon` (its own card), and one "clear all" that only ever clears
// this tech's own schedule-change cards.
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

db.raw = jest.fn((sql) => sql);

function handler(path, method) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function recordingChain(result) {
  const calls = {};
  const chain = {};
  for (const m of ['leftJoin', 'where', 'whereNull', 'whereIn', 'orderBy', 'limit', 'select']) {
    chain[m] = jest.fn((...args) => { (calls[m] ||= []).push(args); return chain; });
  }
  chain.update = jest.fn(async (patch) => { calls.update = patch; return result; });
  chain.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return { chain, calls };
}

const ID = (n) => `00000000-0000-4000-8000-00000000000${n}`;

describe('GET /schedule-changes', () => {
  test('marks a change soon when its new or previous day is today or tomorrow (ET); older cards fall back to the visit\'s day', async () => {
    const now = new Date();
    const today = etDateString(now);
    const tomorrow = etDateString(addETDays(now, 1));
    const farOut = etDateString(addETDays(now, 60));
    const farther = etDateString(addETDays(now, 65));
    const rows = [
      { id: ID(1), type: 'visit_rescheduled', payload: { date: farOut, previous_date: farther }, visit_date: farOut },
      { id: ID(2), type: 'visit_rescheduled', payload: JSON.stringify({ date: farOut, previous_date: today }), visit_date: farOut },
      { id: ID(3), type: 'visit_cancelled', payload: { date: tomorrow }, visit_date: tomorrow },
      // Written before the ISO days existed: only the visit's current day.
      { id: ID(4), type: 'visit_rescheduled', payload: { when: 'Fri Dec 11, 10–11 AM' }, visit_date: tomorrow },
      { id: ID(5), type: 'visit_assigned', payload: { when: 'Tue Dec 15' }, visit_date: null },
    ];
    const { chain, calls } = recordingChain(rows);
    db.mockImplementation(() => chain);
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await handler('/schedule-changes', 'get')({ technicianId: 't-1' }, res, (e) => { throw e; });

    expect(calls.where[0]).toEqual(['n.technician_id', 't-1']);
    expect(calls.whereIn[0]).toEqual(['n.type', ['visit_assigned', 'visit_unassigned', 'visit_rescheduled', 'visit_cancelled']]);
    const { changes } = res.json.mock.calls[0][0];
    expect(changes.map((c) => [c.id, c.soon])).toEqual([[ID(1), false], [ID(2), true], [ID(3), true], [ID(4), true], [ID(5), false]]);
    expect(changes[1].payload.previous_date).toBe(today);
    expect(changes[0]).not.toHaveProperty('visit_date');
  });
});

describe('POST /dismiss-batch', () => {
  test('clears only this tech\'s open schedule-change cards among the ids sent', async () => {
    const { chain, calls } = recordingChain(2);
    db.mockImplementation(() => chain);
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await handler('/dismiss-batch', 'post')({ technicianId: 't-1', body: { ids: [ID(1), ID(2)] } }, res, (e) => { throw e; });

    expect(calls.where[0]).toEqual([{ technician_id: 't-1' }]);
    expect(calls.whereIn).toEqual([['id', [ID(1), ID(2)]], ['type', ['visit_assigned', 'visit_unassigned', 'visit_rescheduled', 'visit_cancelled']]]);
    expect(calls.whereNull[0]).toEqual(['dismissed_at']);
    expect(calls.update).toMatchObject({ read: true, dismissed_at: expect.any(Date) });
    expect(res.json).toHaveBeenCalledWith({ success: true, dismissed: 2 });
  });

  test.each([
    ['no ids', {}],
    ['an empty list', { ids: [] }],
    ['a non-uuid id (would be a 500 from Postgres)', { ids: [ID(1), 'nope'] }],
    ['more than 300 ids', { ids: Array.from({ length: 301 }, () => ID(1)) }],
  ])('%s → 400, nothing written', async (_label, body) => {
    db.mockReset();
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await handler('/dismiss-batch', 'post')({ technicianId: 't-1', body }, res, (e) => { throw e; });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(db).not.toHaveBeenCalled();
  });
});
