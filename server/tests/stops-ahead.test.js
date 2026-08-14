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

// db mock: builder calls fetch the visit row (and the fallback floor
// re-read); db.raw serves BOTH the single-snapshot CTE count and the
// atomic floor UPDATE … RETURNING, dispatched on the SQL text. By default
// the UPDATE mock echoes back the bound clamped value (the ELSE /
// no-prior-floor branch of the real statement); tests override `rawFloor`
// to emulate a concurrent racer having stored a smaller floor, or set it
// to null to emulate the guarded no-op write.
function makeDb({ svcRow, countN = 0, rawFloor, rawError = null } = {}) {
  const queries = [];
  const dbFn = jest.fn(() => {
    const q = {
      where: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(svcRow),
    };
    queries.push(q);
    return q;
  });
  dbFn.raw = jest.fn((sql, bindings) => {
    if (/WITH target/.test(sql)) {
      return Promise.resolve({ rows: [{ n: countN }] });
    }
    if (rawError) return Promise.reject(rawError);
    if (rawFloor === null) return Promise.resolve({ rows: [] }); // guarded no-op write
    const stored = rawFloor !== undefined ? rawFloor : bindings[1];
    return Promise.resolve({ rows: [{ stops_ahead_min_shown: stored }] });
  });
  dbFn.countCall = () => dbFn.raw.mock.calls.find(([sql]) => /WITH target/.test(sql));
  dbFn.updateCalls = () => dbFn.raw.mock.calls.filter(([sql]) => /UPDATE scheduled_services/.test(sql));
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
    // Single conditional UPDATE — (today, clamped, clamped, today, id) for
    // the SET, plus (today, clamped) for the skip-unchanged-write guard.
    expect(db.updateCalls()).toHaveLength(1);
    expect(db.updateCalls()[0][1]).toEqual([TODAY, 2, 2, TODAY, 'svc-self', TODAY, 2]);
    // Single-snapshot CTE count (hook P1 r6): target tuple and preceding
    // count in ONE statement, bound to (target id, excluded statuses).
    const [countSql, countBindings] = db.countCall();
    expect(countBindings).toEqual(['svc-self', ...NOT_A_STOP_STATUSES]);
    expect(NOT_A_STOP_STATUSES).toEqual(['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled']);
    expect(countSql).toContain('s.id <> t.id');
    // Dead estimate-slot holds must not count (hook P1: live-hold predicate).
    expect(countSql).toContain('(s.reservation_expires_at IS NULL OR s.reservation_expires_at > NOW())');
    // track_state can diverge from status (markComplete can leave
    // status='confirmed' + track_state='complete') — tracker-terminal rows
    // must drop out too, NULL-safely.
    expect(countSql).toContain("(s.track_state IS NULL OR s.track_state NOT IN ('complete', 'cancelled'))");
  });

  test(`raw count above the cap (${STOPS_AHEAD_DISPLAY_CAP}) → null and nothing persists`, async () => {
    const db = makeDb({ svcRow: baseSvc(), countN: STOPS_AHEAD_DISPLAY_CAP + 1 });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
    expect(db.updateCalls()).toHaveLength(0);
  });

  test('clamp: a same-day floor caps a count that grew (2 shown, truth now 4 → 2) with no write', async () => {
    // The guarded UPDATE no-ops (floor unchanged) and the fallback re-read
    // returns the stored floor — the displayed count never increases.
    const db = makeDb({
      svcRow: baseSvc({ stops_ahead_min_shown: 2, stops_ahead_shown_date: TODAY }),
      countN: 4,
      rawFloor: null,
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
    expect(db.updateCalls()[0][1]).toEqual([TODAY, 3, 3, TODAY, 'svc-self', TODAY, 3]);
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
    ['rescheduled placeholder (still track_state=scheduled)', baseSvc({ status: 'rescheduled' })],
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
