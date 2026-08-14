jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const { computeStopsAhead, STOPS_AHEAD_DISPLAY_CAP } = require('../services/stops-ahead');

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

// db mock: first call fetches the visit row, later calls serve the
// day-plan count and the floor persist. Shapes mirror the knex chains
// computeStopsAhead builds.
function makeDb({ svcRow, countN = 0, updateError = null } = {}) {
  const updates = [];
  const queries = [];
  const dbFn = jest.fn(() => {
    const q = {
      where: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(svcRow),
      count: jest.fn().mockResolvedValue([{ n: countN }]),
      update: jest.fn((patch) => {
        updates.push(patch);
        return updateError ? Promise.reject(updateError) : Promise.resolve(1);
      }),
    };
    queries.push(q);
    return q;
  });
  dbFn.updates = updates;
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
  });

  test('counts non-terminal earlier stops and persists the floor', async () => {
    const db = makeDb({ svcRow: baseSvc(), countN: 2 });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBe(2);
    expect(db.updates).toEqual([{ stops_ahead_min_shown: 2, stops_ahead_shown_date: TODAY }]);
    // The count query must exclude terminal statuses and the visit itself.
    const countQ = db.queries[1];
    expect(countQ.whereNotIn).toHaveBeenCalledWith('status', ['completed', 'cancelled', 'skipped', 'no_show']);
    expect(countQ.whereNot).toHaveBeenCalledWith('id', 'svc-self');
  });

  test(`raw count above the cap (${STOPS_AHEAD_DISPLAY_CAP}) → null and nothing persists`, async () => {
    const db = makeDb({ svcRow: baseSvc(), countN: STOPS_AHEAD_DISPLAY_CAP + 1 });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
    expect(db.updates).toEqual([]);
  });

  test('clamp: a same-day floor caps a count that grew (2 shown, truth now 4 → 2)', async () => {
    const db = makeDb({
      svcRow: baseSvc({ stops_ahead_min_shown: 2, stops_ahead_shown_date: TODAY }),
      countN: 4,
    });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBe(2);
    expect(db.updates).toEqual([]); // 2 is not smaller than the stored floor
  });

  test('a floor from a previous date is ignored and overwritten (re-date resets the clamp)', async () => {
    const db = makeDb({
      svcRow: baseSvc({ stops_ahead_min_shown: 1, stops_ahead_shown_date: '2026-08-13' }),
      countN: 3,
    });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBe(3);
    expect(db.updates).toEqual([{ stops_ahead_min_shown: 3, stops_ahead_shown_date: TODAY }]);
  });

  test('floor only lowers: stored 3, truth 1 → 1 persisted', async () => {
    const db = makeDb({
      svcRow: baseSvc({ stops_ahead_min_shown: 3, stops_ahead_shown_date: TODAY }),
      countN: 1,
    });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBe(1);
    expect(db.updates).toEqual([{ stops_ahead_min_shown: 1, stops_ahead_shown_date: TODAY }]);
  });

  test('en_route → 0 without running the day-plan count', async () => {
    const db = makeDb({ svcRow: baseSvc({ track_state: 'en_route' }), countN: 99 });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBe(0);
    // fetch + update only — no count query issued
    expect(db.queries).toHaveLength(2);
    expect(db.updates).toEqual([{ stops_ahead_min_shown: 0, stops_ahead_shown_date: TODAY }]);
  });

  test.each([
    ['no technician assigned', baseSvc({ technician_id: null })],
    ['terminal status', baseSvc({ status: 'completed' })],
    ['on the property already', baseSvc({ track_state: 'on_property' })],
    ['scheduled for a future date', baseSvc({ scheduled_date: '2026-08-15' })],
    ['row not found', null],
  ])('%s → null', async (_label, svcRow) => {
    const db = makeDb({ svcRow, countN: 1 });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
    expect(db.updates).toEqual([]);
  });

  test('midnight-UTC Date scheduled_date still matches today', async () => {
    const db = makeDb({ svcRow: baseSvc({ scheduled_date: new Date(`${TODAY}T00:00:00.000Z`) }), countN: 1 });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBe(1);
  });

  test('floor persist failure is swallowed — the count still returns', async () => {
    const db = makeDb({ svcRow: baseSvc(), countN: 1, updateError: new Error('deadlock') });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBe(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('any read error fails soft to null', async () => {
    const db = jest.fn(() => { throw new Error('boom'); });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});
