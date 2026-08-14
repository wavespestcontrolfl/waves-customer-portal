jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const {
  computeStopsAhead,
  STOPS_AHEAD_DISPLAY_CAP,
  NOT_A_STOP_STATUSES,
  NOT_A_ROUTE_STOP_STATUSES,
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
    ...overrides,
  };
}

// db mock: builder calls fetch the visit row; db.raw serves the
// single-snapshot CTE aggregate (which now carries the group's same-day
// floor as group_floor), the group-minimum fallback re-read (reReadFloor),
// and the atomic group-floor UPDATE … RETURNING, dispatched on the SQL
// text. ahead defaults from countN, before_all/others_all from
// beforeAll/othersAll (completed stops earlier on the route make
// before_all exceed ahead). The UPDATE mock echoes back the bound clamped
// value by default; `rawFloor` overrides it to emulate a concurrent
// racer's smaller floor, or null for the guarded no-op write.
function makeDb({
  svcRow, siblings = [], countN = 0, beforeAll, othersAll, doneBefore = 0,
  atBefore = 0, enrouteBefore = 0, activeBeyond = 0, groupFloor = null,
  reReadFloor = null, rawFloor, rawError = null,
} = {}) {
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
    if (/SELECT s\.id, s\.technician_id/.test(sql)) {
      // Sibling-group eligibility fetch: the target row plus any sibling
      // rows of the same (customer, slot). A NULL-technician target
      // yields no rows (the self-join drops it), matching Postgres.
      const rows = svcRow && svcRow.technician_id ? [svcRow, ...siblings] : [];
      return Promise.resolve({ rows });
    }
    if (/WITH target/.test(sql)) {
      return Promise.resolve({
        rows: [{
          ahead: countN,
          before_all: beforeAll !== undefined ? beforeAll : countN,
          others_all: othersAll !== undefined ? othersAll : countN + 3,
          done_before: doneBefore,
          at_before: atBefore,
          enroute_before: enrouteBefore,
          active_beyond: activeBeyond,
          group_floor: groupFloor,
        }],
      });
    }
    if (/SELECT MIN\(s\.stops_ahead_min_shown\)/.test(sql)) {
      // Group-minimum fallback re-read after a guarded no-op UPDATE.
      return Promise.resolve({ rows: [{ min_shown: reReadFloor }] });
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

  test('returns count + route position and persists the floor atomically', async () => {
    // 2 live stops ahead, 3 stops already completed earlier on the route
    // (truck actively working none): yourStop = 5+1 = 6, totalStops =
    // 7+1 = 8, currentStop = MEASURED done_before (3) — never derived
    // from the clamped count.
    const db = makeDb({ svcRow: baseSvc(), countN: 2, beforeAll: 5, othersAll: 7, doneBefore: 3 });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY }))
      .toEqual({ stopsAhead: 2, yourStop: 6, totalStops: 8, currentStop: 3, atStop: false, headingToStop: false });
    // Single conditional group UPDATE — (id, clamped, today) feed the
    // grp/floor_val CTEs, (today, today) the SET stamp + date guard. The
    // floor lands on EVERY sibling row, not just the requested one.
    expect(db.updateCalls()).toHaveLength(1);
    expect(db.updateCalls()[0][1]).toEqual(['svc-self', 2, TODAY, TODAY, TODAY]);
    const [updateSql] = db.updateCalls()[0];
    expect(updateSql).toContain('WITH grp AS');
    expect(updateSql).toContain('u.window_start IS NOT DISTINCT FROM g.window_start');
    expect(updateSql).toContain('RETURNING f.v AS stops_ahead_min_shown');
    // Single-snapshot CTE aggregate: bound to (target id, group-floor
    // date, sibling-anchor route-excluded, day_rows route-excluded, is_live
    // live-excluded).
    const [countSql, countBindings] = db.countCall();
    expect(countBindings).toEqual([
      'svc-self',
      TODAY,                           // group_floor display date
      ...NOT_A_ROUTE_STOP_STATUSES,    // sibling-anchor lateral
      ...NOT_A_ROUTE_STOP_STATUSES,    // day_rows route filter
      ...NOT_A_STOP_STATUSES,          // ranked is_live (terminal precedence)
    ]);
    expect(countSql).toMatch(/at_before/);
    expect(countSql).toMatch(/enroute_before/);
    expect(NOT_A_STOP_STATUSES).toEqual(['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled']);
    expect(NOT_A_ROUTE_STOP_STATUSES).toEqual(['cancelled', 'skipped', 'no_show', 'rescheduled']);
    // The comparison anchors at the sibling GROUP's earliest route tuple
    // (route_order is assigned per row, so per-row anchoring would give
    // sibling links different counts); the target row itself can always
    // anchor even when its siblings are all route-excluded. Foreign groups
    // anchor symmetrically at their rn=1 tuple.
    expect(countSql).toContain('JOIN LATERAL');
    expect(countSql).toContain('s.id = tr.id');
    expect(countSql).toContain('FILTER (WHERE r.rn = 1)');
    // A stop = the repo's sibling identity (customer_id, slot), classified
    // at the GROUP level; only the target's OWN sibling group is excluded.
    expect(countSql).toContain('PARTITION BY dr.customer_id, dr.slot');
    expect(countSql).toContain('GROUP BY r.customer_id, r.slot');
    expect(countSql).toContain('NOT (s.customer_id = t.customer_id');
    expect(countSql).toContain('s.window_start IS NOT DISTINCT FROM t.window_start');
    // A mixed stop (one line done, one line live) must classify ONCE:
    // any live sibling keeps the stop out of done_before, on-property
    // wins over en-route, and an active stop at/beyond the target is
    // surfaced so the planned count can be suppressed.
    expect(countSql).toContain('AND NOT g.has_live');
    expect(countSql).toContain('g.has_enroute AND NOT g.has_at');
    expect(countSql).toMatch(/active_beyond/);
    // Dead estimate-slot holds must not count (live-hold predicate).
    expect(countSql).toContain('(s.reservation_expires_at IS NULL OR s.reservation_expires_at > NOW())');
    // Tracker-terminal rows drop out of the LIVE flag by track_state too,
    // NULL-safely (track_state can diverge from status).
    expect(countSql).toContain("(dr.track_state IS NULL OR dr.track_state NOT IN ('complete', 'cancelled'))");
  });

  test(`raw count above the cap (${STOPS_AHEAD_DISPLAY_CAP}) → null and nothing persists`, async () => {
    const db = makeDb({ svcRow: baseSvc(), countN: STOPS_AHEAD_DISPLAY_CAP + 1 });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
    expect(db.updateCalls()).toHaveLength(0);
  });

  test('clamp: a same-day GROUP floor caps a count that grew (2 shown, truth now 4 → 2) with no write', async () => {
    // The floor arrives with the count snapshot (group MIN over sibling
    // rows), the guarded UPDATE no-ops (floor unchanged), and the group
    // fallback re-read returns the stored floor — the displayed count
    // never increases, on ANY sibling's link.
    const db = makeDb({
      svcRow: baseSvc(),
      countN: 4, beforeAll: 4, othersAll: 6,
      groupFloor: 2, reReadFloor: 2,
      rawFloor: null,
    });
    const res = await computeStopsAhead(db, 'svc-self', { today: TODAY });
    expect(res).toEqual({ stopsAhead: 2, yourStop: 5, totalStops: 7, currentStop: 0, atStop: false, headingToStop: false });
  });

  test('a floor from a previous date is superseded (re-date resets the clamp)', async () => {
    // The group_floor subquery only reads rows whose shown_date is today,
    // so a stale-date floor never reaches the clamp; the group UPDATE's
    // date guard re-stamps it.
    const db = makeDb({ svcRow: baseSvc(), countN: 3, groupFloor: null });
    expect((await computeStopsAhead(db, 'svc-self', { today: TODAY }))?.stopsAhead).toBe(3);
    expect(db.updateCalls()[0][1]).toEqual(['svc-self', 3, TODAY, TODAY, TODAY]);
  });

  test('floor only lowers: stored 3, truth 1 → 1', async () => {
    const db = makeDb({
      svcRow: baseSvc(),
      countN: 1, groupFloor: 3,
      rawFloor: 1,
    });
    expect((await computeStopsAhead(db, 'svc-self', { today: TODAY }))?.stopsAhead).toBe(1);
  });

  test('race collapse: a concurrent racer stored a smaller floor → its value wins', async () => {
    // This request computed 2, but RETURNING says another request already
    // persisted 1 — display the authoritative smaller floor, never 2.
    const db = makeDb({ svcRow: baseSvc(), countN: 2, rawFloor: 1 });
    expect((await computeStopsAhead(db, 'svc-self', { today: TODAY }))?.stopsAhead).toBe(1);
  });

  test.each([
    ['no technician assigned', baseSvc({ technician_id: null })],
    ['terminal status', baseSvc({ status: 'completed' })],
    ['rescheduled placeholder (still track_state=scheduled)', baseSvc({ status: 'rescheduled' })],
    ['en route to this stop (scheduled card owns the count)', baseSvc({ track_state: 'en_route' })],
    ['on the property already', baseSvc({ track_state: 'on_property' })],
    ['scheduled for a future date', baseSvc({ scheduled_date: '2026-08-15' })],
    ['row not found', null],
    // status LEADS track_state when the best-effort tracker transition
    // failed (tech-track commits status first): a visit already underway
    // must not display or persist a planned-route count.
    ['status en_route with stale track_state=scheduled', baseSvc({ status: 'en_route' })],
    ['status on_site with stale track_state=scheduled', baseSvc({ status: 'on_site' })],
  ])('%s → null', async (_label, svcRow) => {
    const db = makeDb({ svcRow, countN: 1 });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
    expect(db.updateCalls()).toHaveLength(0);
  });

  test('midnight-UTC Date scheduled_date still matches today', async () => {
    const db = makeDb({ svcRow: baseSvc({ scheduled_date: new Date(`${TODAY}T00:00:00.000Z`) }), countN: 1 });
    expect((await computeStopsAhead(db, 'svc-self', { today: TODAY }))?.stopsAhead).toBe(1);
  });

  test('floor persist failure → null: never display a number the clamp did not record', async () => {
    const db = makeDb({ svcRow: baseSvc(), countN: 1, rawError: new Error('deadlock') });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  test('zero-row RETURNING with no same-day floor on re-read → null', async () => {
    const db = makeDb({ svcRow: baseSvc(), countN: 1, rawFloor: null });
    // fallback re-read returns baseSvc (no floor fields) → null
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
  });

  test('currentStop counts the actively-worked stop; atStop only when ON it', async () => {
    // 2 done + tech physically at stop 3 → currentStop 3, atStop true.
    const db = makeDb({
      svcRow: baseSvc(), countN: 1, beforeAll: 3, othersAll: 5,
      doneBefore: 2, atBefore: 1,
    });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY }))
      .toEqual({ stopsAhead: 1, yourStop: 4, totalStops: 6, currentStop: 3, atStop: true, headingToStop: false });
  });

  test('merely en-route reads as headingToStop, never atStop', async () => {
    const db = makeDb({
      svcRow: baseSvc(), countN: 1, beforeAll: 3, othersAll: 5,
      doneBefore: 2, enrouteBefore: 1,
    });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY }))
      .toEqual({ stopsAhead: 1, yourStop: 4, totalStops: 6, currentStop: 3, atStop: false, headingToStop: true });
  });

  test.each([
    ['sibling en_route (tech transitions rows by id)', { id: 'svc-sib', status: 'en_route', track_state: 'scheduled' }],
    ['sibling on_site', { id: 'svc-sib', status: 'on_site', track_state: 'scheduled' }],
    ['sibling track_state on_property', { id: 'svc-sib', status: 'confirmed', track_state: 'on_property' }],
    ['sibling completed (stop already visited)', { id: 'svc-sib', status: 'completed', track_state: 'complete' }],
  ])('advanced sibling suppresses the count: %s → null', async (_label, sibling) => {
    const db = makeDb({
      svcRow: baseSvc(),
      siblings: [{ technician_id: 'tech-1', scheduled_date: TODAY, ...sibling }],
      countN: 1,
    });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
    expect(db.updateCalls()).toHaveLength(0);
  });

  test('a scheduled sibling does NOT suppress the count', async () => {
    const db = makeDb({
      svcRow: baseSvc(),
      siblings: [{ id: 'svc-sib', technician_id: 'tech-1', scheduled_date: TODAY, status: 'confirmed', track_state: 'scheduled' }],
      countN: 1,
    });
    expect((await computeStopsAhead(db, 'svc-self', { today: TODAY }))?.stopsAhead).toBe(1);
  });

  test('an active stop at/beyond the target suppresses the planned count', async () => {
    // Tech is servicing a LATER stop — "You're next"/"Route starts soon"
    // would be a lie; fail to the generic state, persist nothing.
    const db = makeDb({ svcRow: baseSvc(), countN: 0, activeBeyond: 1 });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
    expect(db.updateCalls()).toHaveLength(0);
  });

  test('readOnly: a durable same-day floor displays without any write', async () => {
    const db = makeDb({
      svcRow: baseSvc(), countN: 2, beforeAll: 2, othersAll: 4, groupFloor: 2,
    });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY, readOnly: true }))
      .toEqual({ stopsAhead: 2, yourStop: 3, totalStops: 5, currentStop: 0, atStop: false, headingToStop: false });
    expect(db.updateCalls()).toHaveLength(0);
  });

  test.each([
    ['no floor stored yet', { countN: 2, groupFloor: null }],
    ['count dropped below the stored floor', { countN: 1, groupFloor: 3 }],
  ])('readOnly: %s → pending, no write', async (_label, opts) => {
    const db = makeDb({ svcRow: baseSvc(), ...opts });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY, readOnly: true }))
      .toEqual({ pending: true });
    expect(db.updateCalls()).toHaveLength(0);
  });

  test('any read error fails soft to null', async () => {
    const db = jest.fn(() => { throw new Error('boom'); });
    db.raw = jest.fn(() => { throw new Error('boom'); });
    expect(await computeStopsAhead(db, 'svc-self', { today: TODAY })).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('isServiceDateToday', () => {
  const { isServiceDateToday } = require('../services/stops-ahead');

  test('matches same-day strings and midnight-UTC Dates, rejects other days and junk', () => {
    expect(isServiceDateToday(TODAY, TODAY)).toBe(true);
    expect(isServiceDateToday(new Date(`${TODAY}T00:00:00.000Z`), TODAY)).toBe(true);
    expect(isServiceDateToday('2026-08-15', TODAY)).toBe(false);
    expect(isServiceDateToday('2026-08-13', TODAY)).toBe(false);
    expect(isServiceDateToday(null, TODAY)).toBe(false);
    expect(isServiceDateToday(undefined, TODAY)).toBe(false);
    expect(isServiceDateToday('not-a-date', TODAY)).toBe(false);
  });
});
