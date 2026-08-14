jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const {
  computeStopsAhead,
  STOPS_AHEAD_DISPLAY_CAP,
  NOT_A_STOP_STATUSES,
} = require('../services/stops-ahead');

const TODAY = '2026-08-14';

function baseSvc(overrides = {}) {
  return {
    id: 'svc-self',
    technician_id: 'tech-1',
    scheduled_date: TODAY,
    status: 'confirmed',
    track_state: 'scheduled',
    route_order: null,
    window_start: '10:00:00',
    created_at: '2026-08-01T12:00:00.000Z',
    stops_ahead_min_shown: null,
    stops_ahead_shown_date: null,
    ...overrides,
  };
}

// db mock: builder calls fetch the visit row / serve the day-plan count;
// db.raw serves the atomic floor UPDATE … RETURNING. By default the raw
// mock echoes back the bound clamped value (the ELSE / no-prior-floor
// branch of the real statement); tests override `rawFloor` to emulate a
// concurrent racer having stored a smaller floor.
function makeDb({ svcRow, countN = 0, rawFloor, rawError = null } = {}) {
  const queries = [];
  const dbFn = jest.fn(() => {
    const q = {
      where: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(svcRow),
      count: jest.fn().mockResolvedValue([{ n: countN }]),
    };
    queries.push(q);
    return q;
  });
  dbFn.raw = jest.fn((sql, bindings) => {
    if (rawError) return Promise.reject(rawError);
    const stored = rawFloor !== undefined ? rawFloor : bindings[1];
    return Promise.resolve({ rows: [{ stops_ahead_min_shown: stored }] });
  });
  dbFn.queries = queries;
  return dbFn;
}

describe('computeStopsAhead', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_STOPS_AWAY = 'true';
  });
  afterAll(() => { delete process.env.GATE_STOPS_AWAY; });

  test('gate off → null and no queries at all', async () => {
    process.env.GATE_STOPS_AWAY = '';
    const db = makeDb({ svcRow: baseSvc() });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
    expect(db).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
  });

  test('counts non-stop-excluded earlier visits and persists the floor atomically', async () => {
    const db = makeDb({ svcRow: baseSvc(), countN: 2 });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBe(2);
    // Single conditional UPDATE, bound to (today, clamped, clamped, today, id).
    expect(db.raw).toHaveBeenCalledTimes(1);
    expect(db.raw.mock.calls[0][1]).toEqual([TODAY, 2, 2, TODAY, 'svc-self']);
    // The count query must exclude terminal + rescheduled-phantom statuses
    // and the visit itself (hook P1: rescheduled placeholders are not stops).
    const countQ = db.queries[1];
    expect(countQ.whereNotIn).toHaveBeenCalledWith('status', NOT_A_STOP_STATUSES);
    expect(NOT_A_STOP_STATUSES).toEqual(['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled']);
    expect(countQ.whereNot).toHaveBeenCalledWith('id', 'svc-self');
    // Dead estimate-slot holds must not count (hook P1: live-hold predicate).
    expect(countQ.whereRaw).toHaveBeenCalledWith(
      '(reservation_expires_at IS NULL OR reservation_expires_at > NOW())'
    );
  });

  test(`raw count above the cap (${STOPS_AHEAD_DISPLAY_CAP}) → null and nothing persists`, async () => {
    const db = makeDb({ svcRow: baseSvc(), countN: STOPS_AHEAD_DISPLAY_CAP + 1 });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
    expect(db.raw).not.toHaveBeenCalled();
  });

  test('clamp: a same-day floor caps a count that grew (2 shown, truth now 4 → 2)', async () => {
    const db = makeDb({
      svcRow: baseSvc({ stops_ahead_min_shown: 2, stops_ahead_shown_date: TODAY }),
      countN: 4,
      rawFloor: 2,
    });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBe(2);
  });

  test('a floor from a previous date is superseded (re-date resets the clamp)', async () => {
    const db = makeDb({
      svcRow: baseSvc({ stops_ahead_min_shown: 1, stops_ahead_shown_date: '2026-08-13' }),
      countN: 3,
    });
    // Stale-date floor is ignored for clamping; the atomic UPDATE's CASE
    // resets it (mock echoes the ELSE branch).
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBe(3);
    expect(db.raw.mock.calls[0][1]).toEqual([TODAY, 3, 3, TODAY, 'svc-self']);
  });

  test('floor only lowers: stored 3, truth 1 → 1', async () => {
    const db = makeDb({
      svcRow: baseSvc({ stops_ahead_min_shown: 3, stops_ahead_shown_date: TODAY }),
      countN: 1,
      rawFloor: 1,
    });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBe(1);
  });

  test('race collapse: a concurrent racer stored a smaller floor → its value wins', async () => {
    // This request computed 2, but RETURNING says another request already
    // persisted 1 — display the authoritative smaller floor, never 2.
    const db = makeDb({ svcRow: baseSvc(), countN: 2, rawFloor: 1 });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBe(1);
  });

  test.each([
    ['no technician assigned', baseSvc({ technician_id: null })],
    ['en route to this stop (scheduled card owns the count)', baseSvc({ track_state: 'en_route' })],
    ['terminal status', baseSvc({ status: 'completed' })],
    ['on the property already', baseSvc({ track_state: 'on_property' })],
    ['scheduled for a future date', baseSvc({ scheduled_date: '2026-08-15' })],
    ['row not found', null],
  ])('%s → null', async (_label, svcRow) => {
    const db = makeDb({ svcRow, countN: 1 });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
    expect(db.raw).not.toHaveBeenCalled();
  });

  test('midnight-UTC Date scheduled_date still matches today', async () => {
    const db = makeDb({ svcRow: baseSvc({ scheduled_date: new Date(`${TODAY}T00:00:00.000Z`) }), countN: 1 });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBe(1);
  });

  test('floor persist failure → null: never display a number the clamp did not record', async () => {
    const db = makeDb({ svcRow: baseSvc(), countN: 1, rawError: new Error('deadlock') });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  test('zero-row RETURNING (visit deleted mid-poll) → null', async () => {
    const db = makeDb({ svcRow: baseSvc(), countN: 1 });
    db.raw = jest.fn().mockResolvedValue({ rows: [] });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
  });

  test('any read error fails soft to null', async () => {
    const db = jest.fn(() => { throw new Error('boom'); });
    db.raw = jest.fn();
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});
