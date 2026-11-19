/**
 * Hourly route check, shadow (services/day-replan/route-check.js, owner 2026-11-19): the openings dispatch can fill
 * from the live schedule; today from the van's progress; which tech-days count; the ad rule's shadow decision; one
 * route_check_runs row and no other write. Fake knex, synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/technician-eligibility', () => ({
  applyAssignable: jest.fn((q) => q), absentTechDays: jest.fn(async () => new Set()),
}));
jest.mock('../services/scheduling/blackout-dates', () => ({ getBlackoutDates: jest.fn(async () => new Set()) }));
jest.mock('../services/scheduling/occupancy', () => ({ techScopedConfirmActive: jest.fn(() => false), listOccupiedWindows: jest.fn(async () => []) }));
jest.mock('../services/scheduling/departure-time', () => ({ dayDepartureMinutes: jest.fn(async () => 480) }));
jest.mock('../services/scheduling/tech-start-point', () => ({
  loadTechStartPoints: jest.fn(async () => new Map()), homeFromMap: jest.fn(() => ({ lat: 27.4, lng: -82.45 })),
}));
jest.mock('../services/day-replan/index', () => ({
  _internals: { loadDayStops: jest.fn(async () => []), loadBlocks: jest.fn(async () => []), blockedHoursFor: jest.fn(() => []) },
}));

const { _internals: replan } = require('../services/day-replan/index');
const { getBlackoutDates } = require('../services/scheduling/blackout-dates');
const { absentTechDays } = require('../services/technician-eligibility');
const { listOccupiedWindows } = require('../services/scheduling/occupancy');
const { occupiedRows } = require('../services/scheduling/visit-capacity');
const { runRouteCheck, _internals: rc } = require('../services/day-replan/route-check');

const TECH = '00000000-0000-4000-8000-000000000001';
const HQ = { lat: 27.4, lng: -82.45 };
const MONDAY = '2026-11-23';
const stop = (id, start, end, extra = {}) => ({
  id, technician_id: TECH, status: 'confirmed', window_start: start, window_end: end, estimated_duration_minutes: 45,
  lat: 27.41, lng: -82.46, created_at: '2026-11-01T12:00:00Z', ...extra,
});
const open = { blocks: [], held: [], origin: HQ, departureMin: 480, openMin: 480, closeMin: 1020 };

beforeEach(() => jest.clearAllMocks());

// A span as listOccupiedWindows returns it.
const span = (id, technician_id, startMin, endMin) => ({ id, technician_id, startMin, endMin });

describe('dispatch held time', () => {
  test("this technician's own booked spans and unassigned ones; another technician's only while tech-blind", () => {
    const rows = [span('o1', TECH, 540, 600), span('u1', null, 780, 840), span('x1', 'other-tech', 900, 960)];
    expect(rc.heldSpans(rows, TECH, false)).toEqual([{ startMin: 540, endMin: 600 }, { startMin: 780, endMin: 840 }]);
    expect(rc.heldSpans(rows, TECH, true)).toHaveLength(3);
  });

  test('a version-2 allocation holds its whole combined span (occupiedRows), not each service alone', () => {
    const mix = { version: 2, allocatedServiceIds: ['a1', 'a2'] };
    const pair = ['a1', 'a2'].map((id) => ({
      id, technician_id: null, customer_id: 'cust-2', scheduled_date: MONDAY, window_start: '09:00:00', window_end: '10:00:00',
      estimated_duration_minutes: 60, reservation_service_mix: mix,
    }));
    expect(rc.heldSpans(occupiedRows(pair), TECH, false)[0]).toEqual({ startMin: 540, endMin: 660 });
  });
});

describe('where the van is now (today)', () => {
  const day = '2026-11-19';
  const home = HQ;
  const sibling = (id) => ({
    id, visit_id: null, customer_id: 'cust-1', status: 'on_site', window_start: '09:00:00', window_end: null, estimated_duration_minutes: 45,
    lat: 27.5, lng: -82.4, service_address_line1: '1 Test St', created_at: '2026-11-01T12:00:00Z',
  });

  test('the latest completed stop sets the place and the clock', () => {
    const van = rc.vanNow({
      day, home, departureMin: 480, nowMin: 630, onSite: [],
      completed: [
        { completed_at: '2026-11-19T13:50:00Z', lat: 27.3, lng: -82.5 }, // 8:50 ET
        { completed_at: '2026-11-19T14:45:00Z', lat: 27.5, lng: -82.4 }, // 9:45 ET
      ],
    });
    expect(van).toEqual({ origin: { lat: 27.5, lng: -82.4 }, clockMin: 585, source: 'completed' });
  });

  test('a job on site that runs past its stay keeps the van there until now', () => {
    const onSite = rc.onSiteStays(rc.physicalStops([sibling('s1')]), new Map([['s1', '2026-11-19T14:00:00Z']])); // 9:00 + 45
    expect(rc.vanNow({ day, home, departureMin: 480, nowMin: 660, completed: [], onSite }).clockMin).toBe(660);
  });

  test('co-visit siblings on site together are charged their combined stay, as the simulator charges them', () => {
    const arrived = new Map([['s1', '2026-11-19T14:00:00Z'], ['s2', '2026-11-19T14:00:00Z']]);
    const onSite = rc.onSiteStays(rc.physicalStops([sibling('s1'), sibling('s2')]), arrived);
    expect(onSite).toHaveLength(1);
    expect(rc.vanNow({ day, home, departureMin: 480, nowMin: 560, completed: [], onSite })).toMatchObject({ clockMin: 630, source: 'on_site' });
  });

  test("one visit's services (one visit_id) on site are one stop, charged one after another", () => {
    const service = (id) => ({ ...sibling(id), visit_id: 'visit-1' });
    const stops = rc.physicalStops([service('v1'), service('v2')]);
    expect(stops).toHaveLength(1);
    const onSite = rc.onSiteStays(stops, new Map([['v1', '2026-11-19T14:00:00Z']])); // fan-out: one arrival recorded
    expect(rc.vanNow({ day, home, departureMin: 480, nowMin: 560, completed: [], onSite })).toMatchObject({ clockMin: 630, source: 'on_site' });
  });

  test("one visit's services with disconnected windows are two stops, as tracking keeps them", () => {
    const am = { ...sibling('v1'), visit_id: 'visit-1', window_start: '09:00:00', window_end: '10:00:00' };
    const pm = { ...sibling('v2'), visit_id: 'visit-1', window_start: '13:00:00', window_end: '14:00:00' };
    expect(rc.physicalStops([am, pm])).toHaveLength(2);
    expect(rc.physicalStops([am, { ...pm, window_start: '10:00:00', window_end: '11:00:00' }])).toHaveLength(1);
    expect(rc.physicalStops([am, { ...pm, window_start: '10:00:00', window_end: '11:00:00', customer_id: 'cust-2' }])).toHaveLength(2);
  });

  test('a service of the on-site stop already done: the rest starts when it finished, not at the arrival', () => {
    const onSite = rc.onSiteStays(rc.physicalStops([sibling('s2')]), new Map([['s2', '2026-11-19T15:00:00Z']])); // arrived 10:00
    const completed = [{ completed_at: '2026-11-19T15:45:00Z', lat: 27.5, lng: -82.4 }]; // the first service done at 10:45
    expect(rc.vanNow({ day, home, departureMin: 480, nowMin: 660, completed, onSite })).toMatchObject({ clockMin: 690, source: 'on_site' });
  });

  test("today's stops: the progress status wins by id; on site, en route and the rest are split by physical stop", () => {
    const own = [stop('a', '09:00:00', null), stop('b', '11:00:00', null, { status: 'en_route' }), stop('c', '13:00:00', null)];
    const split = rc.todaysStops(own, [{ id: 'a', status: 'completed' }]);
    expect(split.live.map((r) => r.id)).toEqual(['b', 'c']);
    expect(split.onSite).toEqual([]);
    expect(split.enRoute.flat(2).map((r) => r.id)).toEqual(['b']);
    expect(split.rest.map((r) => r.id)).toEqual(['c']);
    expect(rc.todaysStops(own, [{ id: 'c', status: 'on_site' }]).onSite.flat(2).map((r) => r.id)).toEqual(['c']);
  });

  test('two stops done in one minute: the later timestamp sets the place', () => {
    const completed = [
      { completed_at: '2026-11-19T14:45:40Z', lat: 27.5, lng: -82.4 },
      { completed_at: '2026-11-19T14:45:10Z', lat: 27.3, lng: -82.5 },
    ];
    expect(rc.vanNow({ day, home, departureMin: 480, nowMin: 630, onSite: [], completed }).origin).toEqual({ lat: 27.5, lng: -82.4 });
    expect(rc.vanNow({ day, home, departureMin: 480, nowMin: 630, onSite: [], completed: completed.slice().reverse() }).origin).toEqual({ lat: 27.5, lng: -82.4 });
  });

  test('nothing done yet: the start point at the departure minute', () => {
    expect(rc.vanNow({ day, home, departureMin: 480, nowMin: 450, onSite: [], completed: [] })).toEqual({ origin: home, clockMin: 480, source: 'start_point' });
  });

  test("the latest stop done has no place: the van's place is unknown, never an earlier customer's", () => {
    const completed = [
      { completed_at: '2026-11-19T13:50:00Z', lat: 27.3, lng: -82.5 }, // 8:50, placed
      { completed_at: '2026-11-19T14:45:00Z', lat: null, lng: null }, // 9:45, no place
    ];
    expect(rc.vanNow({ day, home, departureMin: 480, nowMin: 630, onSite: [], completed })).toMatchObject({ origin: null, source: 'unknown' });
    // An earlier stop with no place does not matter.
    expect(rc.vanNow({ day, home, departureMin: 480, nowMin: 630, onSite: [], completed: completed.slice().reverse().map((r, i) => (i ? { ...r, lat: 27.5, lng: -82.4 } : { ...r, completed_at: '2026-11-19T13:00:00Z' })) }).source).toBe('completed');
  });
});

describe('one tech-day', () => {
  test('counts each opening of a job slot or more', () => {
    const fig = rc.measureTechDay({ ...open, rows: [stop('a', '09:00:00', '10:00:00'), stop('b', '13:00:00', '14:00:00', { lat: 27.45, lng: -82.4 })] });
    expect(fig.openings.map((o) => o.kind)).toEqual(['wait', 'tail']);
    // 2 PM to 5 PM: the notice counts 2 whole slots; on the hour, 2 PM, then 4 PM would run past 5.
    expect(fig.openings.find((o) => o.kind === 'tail')).toEqual({ kind: 'tail', start: 840, min: 180, slots: 1, noticeSlots: 2 });
    expect(fig).toMatchObject({ stops: 2, noticeSlots: 4 });
    expect(fig.slots).toBe(fig.openings.reduce((n, o) => n + o.slots, 0));
  });

  test("a visit's afternoon service runs at its own time, after another customer's noon stop", () => {
    const am = stop('v1', '09:00:00', '10:00:00', { visit_id: 'visit-1', customer_id: 'cust-1' });
    const pm = stop('v2', '15:00:00', '16:00:00', { visit_id: 'visit-1', customer_id: 'cust-1' });
    const noon = stop('n1', '12:00:00', '13:00:00', { customer_id: 'cust-2', lat: 27.45, lng: -82.4 });
    const fig = rc.measureTechDay({ ...open, rows: [am, pm, noon] });
    // In window order the day ends when the 3 PM service does; pulled together, the noon stop would run last and late.
    const pulled = rc.measureTechDay({ ...open, rows: [noon], first: [am, pm] });
    expect(fig.endMin).toBeLessThanOrEqual(960);
    expect(pulled.endMin).toBeGreaterThan(fig.endMin);
  });

  test('the stop the van is driving to comes first, even with a later window', () => {
    const a = stop('a', '11:00:00', null);
    const b = stop('b', '13:00:00', null, { status: 'en_route', lat: 27.45, lng: -82.4 });
    const plain = rc.measureTechDay({ ...open, rows: [a, b] });
    const pinned = rc.measureTechDay({ ...open, rows: [a], first: [b] });
    expect(pinned.stops).toBe(2);
    expect(pinned.endMin).toBeGreaterThan(plain.endMin); // b at 1 PM, then a: the day ends later
    expect(plain.openings.map((o) => o.kind)).toContain('start');
    expect(pinned.openings.map((o) => o.kind)).not.toContain('start'); // no job goes ahead of the customer en route
  });

  test('a schedule block takes its time out of the openings', () => {
    const fig = rc.measureTechDay({ ...open, rows: [], blocks: [{ startMin: 720, endMin: 1020 }] });
    expect(fig.openings).toEqual([{ kind: 'tail', start: 480, min: 240, slots: 2, noticeSlots: 3 }]); // 8:00, 10:00
  });

  test('a stop with no time or no place leaves the day unmeasured', () => {
    expect(rc.measureTechDay({ ...open, rows: [stop('a', null, null)] }).skip).toBe('UNTIMED_STOP');
    expect(rc.measureTechDay({ ...open, rows: [stop('a', '09:00:00', null, { lat: null })] }).skip).toBe('STOP_WITHOUT_COORDINATES');
  });

  test('after the day closes there is no opening', () => {
    expect(rc.measureTechDay({ ...open, rows: [], departureMin: 1050, openMin: 1050 })).toMatchObject({ openings: [], slots: 0 });
  });
});

describe('which days count', () => {
  const elig = { blackout: new Set(['2026-11-26']), techIds: [TECH], absent: new Set([`${TECH}:2026-11-24`]) };
  test('a blackout day and an absence count no room; a Sunday counts only with a stop booked', () => {
    expect(rc.staffed(elig, '2026-11-26', TECH, true)).toBe(false);
    expect(rc.staffed(elig, '2026-11-24', TECH, true)).toBe(false);
    expect(rc.staffed(elig, '2026-11-22', TECH, false)).toBe(false);
    expect(rc.staffed(elig, '2026-11-22', TECH, true)).toBe(true);
    expect(rc.staffed(elig, '2026-11-23', 'someone-else', true)).toBe(false);
  });

  test('today, through the third staffed day, and at least the 7-day demand view', () => {
    expect(rc.datesToMeasure(elig, '2026-11-19', new Map())).toEqual(
      ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'],
    );
    // Off all next week: the scan runs on until it finds three staffed days.
    const away = { ...elig, absent: new Set(['20', '21', '23', '24', '25', '27', '28'].map((d) => `${TECH}:2026-11-${d}`)) };
    expect(rc.datesToMeasure(away, '2026-11-19', new Map()).at(-1)).toBe('2026-12-02');
  });
});

describe('the totals and the ad rule shadow', () => {
  const day = (date, fig) => ({ date, technician_id: TECH, staffed: true, slots: 0, openings: [], ...fig });
  test('full budget while dispatch room exists today or in the next 3 staffed days', () => {
    const { totals, ad } = rc.summarize([
      day('2026-11-19', { slots: 1 }), day('2026-11-20'), day('2026-11-21'), day('2026-11-23', { slots: 1 }), day('2026-11-24', { slots: 3 }),
    ], '2026-11-19');
    expect(totals.next).toEqual({ dates: ['2026-11-20', '2026-11-21', '2026-11-23'], slots: 1 });
    expect(totals.week).toEqual({ through: '2026-11-26', slots: 4 });
    expect(ad).toEqual({ decision: 'full', slotsAhead: 2, techBlind: false, unmeasured: 0 });
  });

  test('tech-blind: two technicians free at the same hours count that room once', () => {
    const TECH2 = '00000000-0000-4000-8000-000000000002';
    const free = { openings: [{ kind: 'start', start: 540, min: 200, slots: 2 }], slots: 2 }; // 9:00 and 11:00
    const days = [day('2026-11-20', free), { ...day('2026-11-20', free), technician_id: TECH2 }];
    expect(rc.summarize(days, '2026-11-19').totals.next.slots).toBe(4);
    expect(rc.summarize(days, '2026-11-19', { techBlind: true }).totals.next.slots).toBe(2);
  });

  test('a job starts on the hour: a 10:30-11:50 opening holds none', () => {
    expect(rc.hourSlots({ start: 630, min: 80 })).toBe(0);
    expect(rc.hourSlots({ start: 600, min: 80 })).toBe(1);
    expect(rc.blindSlots([{ start: 630, min: 80 }])).toBe(0);
  });

  test("tech-blind: every job fits one technician's opening (no job is handed from one to the other)", () => {
    expect(rc.blindSlots([{ start: 540, min: 120 }, { start: 660, min: 120 }])).toBe(2); // A 9-11, B 11-1: two, not three
  });

  test('the 1% floor when no dispatch room exists in that window', () => {
    const { ad } = rc.summarize([
      day('2026-11-19'), day('2026-11-20'), day('2026-11-21'), day('2026-11-23'), day('2026-11-24', { slots: 4 }),
      day('2026-11-25', { skip: 'UNTIMED_STOP' }), // past the window: not counted
    ], '2026-11-19');
    expect(ad).toEqual({ decision: 'floor', slotsAhead: 0, techBlind: false, unmeasured: 0 });
  });

  test('unknown, never a floor, when no room is found and a day in the window could not be measured', () => {
    const { ad } = rc.summarize([
      day('2026-11-19'), day('2026-11-20', { skip: 'UNTIMED_STOP', slots: 3 }), day('2026-11-21'), day('2026-11-23'),
    ], '2026-11-19');
    expect(ad).toEqual({ decision: 'unknown', slotsAhead: 0, techBlind: false, unmeasured: 1 });
    // A long closure: the scan found only 2 staffed days, so no room is not a measured floor.
    expect(rc.summarize([day('2026-11-19'), day('2026-11-20'), day('2026-11-21')], '2026-11-19').ad.decision).toBe('unknown');
    // Room found elsewhere: full, with the unmeasured day named.
    expect(rc.summarize([day('2026-11-19', { slots: 1 }), day('2026-11-20', { skip: 'FAILED' })], '2026-11-19').ad)
      .toMatchObject({ decision: 'full', unmeasured: 1 });
  });
});

describe('runRouteCheck', () => {
  const NOW = new Date('2026-11-19T15:30:00Z'); // Thu 10:30 AM ET

  function fakeConn({ progress = [], occupancy = [], campaigns = [{ id: 'c1', status: 'paused', budget_mode: 'stop' }] } = {}) {
    const writes = [];
    const conn = (table) => {
      let joined = false;
      const q = {
        leftJoin() { joined = true; return q; }, where() { return q; }, whereIn() { return q; }, whereNotIn() { return q; }, whereRaw() { return q; },
        select: async () => {
          if (table === 'technicians') return [{ id: TECH }];
          // The progress read joins customers for the place; the occupancy read does not.
          if (table === 'scheduled_services') return joined ? progress : occupancy;
          if (table === 'ad_campaigns') return campaigns;
          return [];
        },
        insert: async (row) => { writes.push([table, row]); return [1]; },
        update: async (row) => { writes.push([table, row]); return 1; },
      };
      return q;
    };
    conn.raw = (sql) => sql;
    return { conn, writes };
  }

  beforeEach(() => {
    getBlackoutDates.mockResolvedValue(new Set(['2026-11-26']));
    absentTechDays.mockResolvedValue(new Set());
    replan.loadDayStops.mockImplementation(async (_c, date) => {
      if (date === '2026-11-19') return [stop('t1', '13:00:00', '14:00:00')];
      if (date === '2026-11-20') return [stop('f1', '09:00:00', '10:00:00')];
      return [];
    });
  });

  test('records one row: today from the van, then the next staffed days, and the ad shadow; nothing else is written', async () => {
    const { conn, writes } = fakeConn({ progress: [{ technician_id: TECH, status: 'completed', completed_at: '2026-11-19T14:45:00Z', lat: 27.5, lng: -82.4 }] });
    const result = await runRouteCheck({ conn, now: NOW });
    expect(writes.map(([table]) => table)).toEqual(['route_check_runs']);
    const row = writes[0][1];
    expect(row).toMatchObject({ run_at: NOW, service_date: '2026-11-19', status: 'completed' });
    const days = JSON.parse(row.days);
    expect(days.map((d) => d.date)).toEqual(['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-23', '2026-11-24', '2026-11-25']);
    const today = days[0];
    expect(today.van).toBe('completed');
    // Nothing before now (10:30): the van leaves the 9:45 stop at 10:30, and the opening starts after that drive.
    expect(today.openings[0].kind).toBe('start');
    expect(today.openings[0].start).toBeGreaterThanOrEqual(630);
    const totals = JSON.parse(row.totals);
    expect(totals.next.dates).toEqual(['2026-11-20', '2026-11-21', '2026-11-23']);
    expect(JSON.parse(row.ad_shadow)).toMatchObject({ decision: 'full', live: [{ id: 'c1', status: 'paused', mode: 'stop' }] });
    // Only the measured dates and the Sundays are read, never the whole 14-day scan.
    expect(replan.loadDayStops.mock.calls.map(([, d]) => d)).toEqual(['2026-11-19', '2026-11-22', '2026-11-29', '2026-11-20', '2026-11-21', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26']);
    expect(JSON.parse(row.ad_shadow)).toEqual(expect.objectContaining({ slotsAhead: expect.any(Number) }));
    expect(result).toMatchObject({ status: 'completed', days: 6 });
  });

  test('a tech-day that fails to read is marked and the row is still written', async () => {
    replan.loadBlocks.mockImplementation(async (_c, date) => {
      if (date === '2026-11-20') throw new Error('timeout');
      return [];
    });
    const { conn, writes } = fakeConn();
    const result = await runRouteCheck({ conn, now: NOW });
    expect(result.status).toBe('completed_with_errors');
    const days = JSON.parse(writes[0][1].days);
    expect(days.find((d) => d.date === '2026-11-20')).toMatchObject({ skip: 'FAILED' });
    replan.loadBlocks.mockResolvedValue([]);
  });

  test('a stop on site with no place leaves today unmeasured, never free time from the start point', async () => {
    replan.loadDayStops.mockImplementation(async (_c, date) => (date === '2026-11-19' ? [stop('t1', '10:00:00', null, { status: 'on_site', lat: null, lng: null })] : []));
    const { conn, writes } = fakeConn({ progress: [{ id: 't1', technician_id: TECH, status: 'on_site', arrived_at: '2026-11-19T15:00:00Z', lat: null, lng: null }] });
    await runRouteCheck({ conn, now: NOW });
    expect(JSON.parse(writes[0][1].days)[0]).toMatchObject({ date: '2026-11-19', skip: 'ON_SITE_WITHOUT_COORDINATES' });
  });

  test("an unassigned version-2 allocation holds its combined span against dispatch openings too", async () => {
    replan.loadDayStops.mockResolvedValue([]);
    const mix = { version: 2, allocatedServiceIds: ['a1', 'a2'] };
    const pair = ['a1', 'a2'].map((id) => ({
      id, technician_id: null, customer_id: 'cust-2', scheduled_date: '2026-11-20', window_start: '09:00:00', window_end: '10:00:00',
      estimated_duration_minutes: 60, reservation_service_mix: mix,
    }));
    listOccupiedWindows.mockImplementation(async ({ dateFrom }) => (dateFrom === '2026-11-20' ? occupiedRows(pair) : []));
    const { conn, writes } = fakeConn();
    await runRouteCheck({ conn, now: NOW });
    listOccupiedWindows.mockResolvedValue([]);
    const friday = JSON.parse(writes[0][1].days).find((d) => d.date === '2026-11-20');
    expect(friday.openings.map((o) => [o.start, o.min])).toEqual([[660, 360]]); // 8-9 is under a job slot; 9-11 is held
  });

  test('a stop finished between the two reads is done, not simulated again and not lost', async () => {
    // The rows' read still sees the 9:00 stop live; the progress read, after it, sees it completed at 9:45.
    replan.loadDayStops.mockImplementation(async (_c, date) => (date === '2026-11-19' ? [stop('x1', '09:00:00', '10:00:00', { lat: 27.5, lng: -82.4 })] : []));
    const { conn, writes } = fakeConn({ progress: [{ id: 'x1', technician_id: TECH, status: 'completed', completed_at: '2026-11-19T14:45:00Z', lat: 27.5, lng: -82.4 }] });
    await runRouteCheck({ conn, now: NOW });
    const today = JSON.parse(writes[0][1].days)[0];
    expect(today).toMatchObject({ stops: 0, van: 'completed' });
    expect(today.openings[0]).toMatchObject({ kind: 'tail', start: 630 });
    expect(today.driveMin).toBeGreaterThan(0); // the drive home from the last stop, not a return to that customer
  });

  test('co-visit siblings: one on site and one not yet moved are one stop on site, never a second visit', async () => {
    const sib = (id, status) => stop(id, '09:00:00', null, {
      status, visit_id: null, customer_id: 'cust-9', lat: 27.5, lng: -82.4, service_address_line1: '1 Test St',
    });
    replan.loadDayStops.mockImplementation(async (_c, date) => (date === '2026-11-19' ? [sib('s1', 'on_site'), sib('s2', 'confirmed')] : []));
    const { conn, writes } = fakeConn({ progress: [{ id: 's1', technician_id: TECH, status: 'on_site', arrived_at: '2026-11-19T15:00:00Z', lat: 27.5, lng: -82.4 }] });
    await runRouteCheck({ conn, now: NOW }); // arrived 10:00, two 45-minute services: busy to 11:30
    const today = JSON.parse(writes[0][1].days)[0];
    expect(today).toMatchObject({ stops: 0, van: 'on_site' });
    expect(today.openings[0].start).toBeGreaterThanOrEqual(690);
  });

  test("one visit's services: one on site and one not yet moved are one stop on site, charged in full", async () => {
    const svc = (id, status) => stop(id, '09:00:00', null, { status, visit_id: 'visit-9', customer_id: 'cust-9', lat: 27.5, lng: -82.4 });
    replan.loadDayStops.mockImplementation(async (_c, date) => (date === '2026-11-19' ? [svc('v1', 'on_site'), svc('v2', 'confirmed')] : []));
    const { conn, writes } = fakeConn({ progress: [{ id: 'v1', technician_id: TECH, status: 'on_site', arrived_at: '2026-11-19T15:00:00Z', lat: 27.5, lng: -82.4 }] });
    await runRouteCheck({ conn, now: NOW }); // arrived 10:00, two 45-minute services: busy to 11:30
    const today = JSON.parse(writes[0][1].days)[0];
    expect(today).toMatchObject({ stops: 0, van: 'on_site' });
    expect(today.openings[0].start).toBeGreaterThanOrEqual(690);
  });

  test('a stop done early still holds its booked window; the read is the booking surfaces\' own', async () => {
    replan.loadDayStops.mockResolvedValue([]);
    // Booked 10 AM-noon, finished at 10:15: the hour to noon is not room.
    listOccupiedWindows.mockImplementation(async ({ dateFrom }) => (dateFrom === '2026-11-19' ? [span('d1', TECH, 600, 720)] : []));
    const { conn, writes } = fakeConn({ progress: [{ id: 'd1', technician_id: TECH, status: 'completed', completed_at: '2026-11-19T15:15:00Z', lat: 27.5, lng: -82.4 }] });
    await runRouteCheck({ conn, now: NOW });
    const today = JSON.parse(writes[0][1].days)[0];
    expect(today.openings[0].start).toBeGreaterThanOrEqual(720);
    expect(listOccupiedWindows).toHaveBeenCalledWith(expect.objectContaining({ db: conn, dateFrom: '2026-11-19', dateTo: '2026-11-19' }));
    listOccupiedWindows.mockResolvedValue([]);
  });

  test('two stops on site at once leave today unmeasured', async () => {
    replan.loadDayStops.mockImplementation(async (_c, date) => (date === '2026-11-19'
      ? [stop('o1', '09:00:00', null, { status: 'on_site' }), stop('o2', '13:00:00', null, { status: 'on_site', customer_id: 'cust-2', lat: 27.45, lng: -82.4 })]
      : []));
    const { conn, writes } = fakeConn();
    await runRouteCheck({ conn, now: NOW });
    expect(JSON.parse(writes[0][1].days)[0]).toMatchObject({ date: '2026-11-19', skip: 'SEVERAL_ON_SITE' });
  });

  test("a failed stops read (a Sunday's or a date's) marks that date and the row is still written", async () => {
    replan.loadDayStops.mockImplementation(async (_c, date) => {
      if (date === '2026-11-22' || date === '2026-11-20') throw new Error('timeout');
      return [];
    });
    const { conn, writes } = fakeConn();
    const result = await runRouteCheck({ conn, now: NOW });
    expect(result.status).toBe('completed_with_errors');
    const days = JSON.parse(writes[0][1].days);
    expect(days.find((d) => d.date === '2026-11-20')).toMatchObject({ skip: 'FAILED' });
    expect(days.find((d) => d.date === '2026-11-22')).toMatchObject({ skip: 'FAILED' }); // staffed when unknown
  });

  test('a stop put on site after the rows\' read leaves today unmeasured', async () => {
    replan.loadDayStops.mockResolvedValue([]);
    const { conn, writes } = fakeConn({ progress: [{ id: 'late', technician_id: TECH, status: 'on_site', arrived_at: '2026-11-19T15:20:00Z', lat: 27.5, lng: -82.4 }] });
    await runRouteCheck({ conn, now: NOW });
    expect(JSON.parse(writes[0][1].days)[0]).toMatchObject({ date: '2026-11-19', skip: 'ON_SITE_NOT_IN_ROUTE' });
  });

  test("a completion whose tracker update failed: the dispatch finish time sets the van's clock", async () => {
    replan.loadDayStops.mockResolvedValue([]);
    const { conn, writes } = fakeConn({ progress: [{
      id: 'd1', technician_id: TECH, status: 'completed', completed_at: null, check_out_time: null,
      actual_end_time: '2026-11-19T15:20:00Z', lat: 27.5, lng: -82.4, // 10:20 ET
    }] });
    await runRouteCheck({ conn, now: NOW });
    expect(JSON.parse(writes[0][1].days)[0]).toMatchObject({ date: '2026-11-19', van: 'completed' });
  });

  test("a failed progress read on a Sunday keeps today's technicians, marked FAILED", async () => {
    replan.loadDayStops.mockResolvedValue([]);
    const { conn, writes } = fakeConn();
    const base = conn;
    const failing = (table) => {
      const q = base(table);
      if (table === 'scheduled_services') q.leftJoin = () => { throw new Error('timeout'); };
      return q;
    };
    failing.raw = base.raw;
    await runRouteCheck({ conn: failing, now: new Date('2026-11-22T17:00:00Z') }); // Sunday noon ET
    const today = JSON.parse(writes[0][1].days).find((d) => d.date === '2026-11-22');
    expect(today).toMatchObject({ skip: 'FAILED' });
    expect(JSON.parse(writes[0][1].ad_shadow).decision).not.toBe('floor');
  });

  test("one date's occupancy read failing marks that date and the row is still written", async () => {
    listOccupiedWindows.mockImplementation(async ({ dateFrom }) => {
      if (dateFrom === '2026-11-24') throw new Error('timeout');
      return [];
    });
    const { conn, writes } = fakeConn();
    const result = await runRouteCheck({ conn, now: NOW });
    expect(result.status).toBe('completed_with_errors');
    const days = JSON.parse(writes[0][1].days);
    expect(days.find((d) => d.date === '2026-11-24')).toMatchObject({ skip: 'FAILED' });
    expect(days.find((d) => d.date === '2026-11-23').skip).toBeUndefined();
    listOccupiedWindows.mockResolvedValue([]);
  });

  test('two stops en route at once leave today unmeasured', async () => {
    replan.loadDayStops.mockImplementation(async (_c, date) => (date === '2026-11-19'
      ? [stop('e1', '11:00:00', null, { status: 'en_route' }), stop('e2', '13:00:00', null, { status: 'en_route', lat: 27.45, lng: -82.4 })]
      : []));
    const { conn, writes } = fakeConn();
    await runRouteCheck({ conn, now: NOW });
    expect(JSON.parse(writes[0][1].days)[0]).toMatchObject({ date: '2026-11-19', skip: 'SEVERAL_EN_ROUTE' });
  });

  test("a Sunday stays staffed after its last stop is done", async () => {
    replan.loadDayStops.mockResolvedValue([]);
    const { conn, writes } = fakeConn({ progress: [{ id: 'd1', technician_id: TECH, status: 'completed', completed_at: '2026-11-22T16:00:00Z', lat: 27.5, lng: -82.4 }] });
    await runRouteCheck({ conn, now: new Date('2026-11-22T17:00:00Z') }); // Sunday noon ET, the only stop done at 11
    const today = JSON.parse(writes[0][1].days).find((d) => d.date === '2026-11-22');
    expect(today).toMatchObject({ van: 'completed' });
    expect(today.slots).toBeGreaterThan(0);
  });
});
