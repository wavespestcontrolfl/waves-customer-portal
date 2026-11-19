/**
 * Hourly route check, shadow (services/day-replan/route-check.js, owner 2026-11-19): the openings a new job fits, for
 * dispatch and for online booking, from the live schedule; today from the van's progress; which tech-days count; the
 * ad rule's shadow decision; one route_check_runs row and no other write. Fake knex, synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/technician-eligibility', () => ({
  applyAssignable: jest.fn((q) => q), absentTechDays: jest.fn(async () => new Set()),
}));
jest.mock('../services/scheduling/blackout-dates', () => ({ getBlackoutDates: jest.fn(async () => new Set()) }));
jest.mock('../services/scheduling/occupancy', () => ({ techScopedConfirmActive: jest.fn(() => false) }));
jest.mock('../services/scheduling/departure-time', () => ({ dayDepartureMinutes: jest.fn(async () => 480) }));
jest.mock('../services/scheduling/tech-start-point', () => ({
  loadTechStartPoints: jest.fn(async () => new Map()), homeFromMap: jest.fn(() => ({ lat: 27.4, lng: -82.45 })),
}));
jest.mock('../services/interview-slots', () => ({ bookedInterviewWindowsForDate: jest.fn(async () => []) }));
jest.mock('../services/day-replan/index', () => ({
  _internals: { loadDayStops: jest.fn(async () => []), loadBlocks: jest.fn(async () => []), blockedHoursFor: jest.fn(() => []) },
}));

const { _internals: replan } = require('../services/day-replan/index');
const { getBlackoutDates } = require('../services/scheduling/blackout-dates');
const { absentTechDays } = require('../services/technician-eligibility');
const { bookedInterviewWindowsForDate } = require('../services/interview-slots');
const { runRouteCheck, _internals: rc } = require('../services/day-replan/route-check');

const TECH = '00000000-0000-4000-8000-000000000001';
const HQ = { lat: 27.4, lng: -82.45 };
const stop = (id, start, end, extra = {}) => ({
  id, technician_id: TECH, status: 'confirmed', window_start: start, window_end: end, estimated_duration_minutes: 45,
  lat: 27.41, lng: -82.46, created_at: '2026-11-01T12:00:00Z', ...extra,
});
// A Monday well ahead: only the customer window rule decides (the booking notice is far behind).
const MONDAY = '2026-11-23';
const AHEAD = new Date('2026-11-20T12:00:00Z');
// The live booking_config row's shape (Nov 19): book from tomorrow, 8 AM to 6 PM, 60-minute visits.
const CONFIG = { advance_days_min: 1, advance_days_max: 14, slot_duration_minutes: 60, day_start: '08:00:00', day_end: '18:00:00' };
const SAME_DAY = { ...CONFIG, advance_days_min: 0 };
const open = { blocks: [], held: [], origin: HQ, departureMin: 480, openMin: 480, closeMin: 1020, admit: null };

const savedEnv = { gate: process.env.GATE_CUSTOMER_LAST_START_16, notice: process.env.SELF_SERVE_NOTICE_HOURS };
const restore = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_CUSTOMER_LAST_START_16 = 'true';
  process.env.SELF_SERVE_NOTICE_HOURS = '1';
  open.admit = rc.onlineAdmit(MONDAY, AHEAD, [], CONFIG);
});
afterAll(() => {
  restore('GATE_CUSTOMER_LAST_START_16', savedEnv.gate);
  restore('SELF_SERVE_NOTICE_HOURS', savedEnv.notice);
});

describe('online count: the customer booking rules', () => {
  test('an opening holds an online job only on the hour grid, with a full job slot inside it', () => {
    const admit = rc.onlineAdmit(MONDAY, AHEAD, [], CONFIG);
    expect(rc.onlineStarts({ startMin: 560, min: 80 }, admit)).toEqual([]); // 9:20-10:40: dispatch fits one, no hourly start does
    expect(rc.onlineStarts({ startMin: 540, min: 480 }, admit)).toEqual([540, 600, 660, 720, 780, 840, 900]); // 4 PM would run past 5
    expect(rc.spaced(rc.onlineStarts({ startMin: 540, min: 480 }, admit))).toEqual([540, 660, 780, 900]); // 4 jobs
    expect(rc.onlineAdmit('2026-11-22', AHEAD, [], CONFIG)).not.toBeNull(); // /book offers weekends: a staffed Sunday counts
  });

  test("the /book page's own rules: its first day and its configured opening hour", () => {
    const now = new Date('2026-11-23T13:00:00Z'); // Monday 8 AM ET
    expect(rc.onlineAdmit(MONDAY, now, [], CONFIG)).toBeNull(); // advance_days_min 1: not today
    expect(rc.onlineAdmit(MONDAY, now, [], { ...CONFIG, advance_days_min: null })).toBeNull(); // null keeps the 1-day default
    expect(rc.onlineAdmit(MONDAY, now, [], SAME_DAY)).not.toBeNull();
    const tenOpen = rc.onlineAdmit(MONDAY, AHEAD, [], { ...CONFIG, day_start: '10:00:00' });
    expect(rc.onlineStarts({ startMin: 540, min: 240 }, tenOpen)).toEqual([600, 660]); // no 9 AM before a 10 AM opening
  });

  test('a 5 PM start counts only while GATE_CUSTOMER_LAST_START_16 is off', () => {
    expect(rc.onlineStarts({ startMin: 1020, min: 80 }, rc.onlineAdmit(MONDAY, AHEAD, [], CONFIG))).toEqual([]);
    process.env.GATE_CUSTOMER_LAST_START_16 = 'false';
    expect(rc.onlineStarts({ startMin: 1020, min: 80 }, rc.onlineAdmit(MONDAY, AHEAD, [], CONFIG))).toEqual([1020]);
  });

  test('a start inside the self-serve booking notice is not online room, but stays dispatch room', () => {
    const now = new Date('2026-11-23T15:30:00Z'); // Monday 10:30 AM ET, notice 1 h: the first online start is noon
    const fig = rc.measureTechDay({ ...open, rows: [], departureMin: 630, openMin: 630, admit: rc.onlineAdmit(MONDAY, now, [], SAME_DAY) });
    // 4 PM would need the job slot to 5:20; the opening ends at 5.
    expect(fig.openings).toEqual([{ kind: 'tail', start: 630, min: 390, slots: 4, online: 2, starts: [720, 780, 840, 900] }]);
    process.env.SELF_SERVE_NOTICE_HOURS = '24';
    expect(rc.measureTechDay({ ...open, rows: [], departureMin: 630, openMin: 630, admit: rc.onlineAdmit(MONDAY, now, [], SAME_DAY) })).toMatchObject({ slots: 4, online: 0 });
  });

  test("booked spans and the owner's interviews hold time against online starts", () => {
    const row = (id, extra) => ({ id, technician_id: TECH, customer_id: 'cust-1', scheduled_date: MONDAY, estimated_duration_minutes: 60, ...extra });
    const busy = rc.onlineBusy({
      techId: TECH, techBlind: false,
      occupancy: [
        row('v1', { window_start: '09:00:00', window_end: '11:00:00' }),
        row('v2', { technician_id: 'other-tech', window_start: '13:00:00', window_end: null }),
      ],
      interviews: [{ start: '14:45', end: '16:15' }],
    });
    expect(busy).toEqual([{ startMin: 540, endMin: 660 }, { startMin: 885, endMin: 975 }]); // another tech's visit holds nothing
    // 2 PM would run to 3, into the interview's 2:45 buffer.
    expect(rc.onlineStarts({ startMin: 540, min: 480 }, rc.onlineAdmit(MONDAY, AHEAD, busy, CONFIG))).toEqual([660, 720, 780]);
    // Tech-blind: another technician's visit holds its span too.
    const blind = rc.onlineBusy({ techId: TECH, techBlind: true, occupancy: [row('v2', { technician_id: 'other-tech', window_start: '13:00:00', window_end: null })], interviews: [] });
    expect(blind).toEqual([{ startMin: 780, endMin: 840 }]);
  });

  test("dispatch held time: other rows' booked spans, never this technician's own", () => {
    const rows = [
      { id: 'o1', technician_id: TECH, customer_id: 'c1', scheduled_date: MONDAY, window_start: '09:00:00', window_end: '10:00:00' },
      { id: 'u1', technician_id: null, customer_id: 'c2', scheduled_date: MONDAY, window_start: '13:00:00', window_end: '14:00:00' },
    ];
    expect(rc.bookedSpans(rows, TECH, false, { own: false })).toEqual([{ startMin: 780, endMin: 840 }]);
    expect(rc.bookedSpans(rows, TECH, false, { own: true })).toHaveLength(2);
  });

  test('a version-2 allocation holds its whole combined span (occupiedRows), not each service alone', () => {
    const mix = { version: 2, allocatedServiceIds: ['a1', 'a2'] };
    const pair = ['a1', 'a2'].map((id) => ({
      id, technician_id: null, customer_id: 'cust-2', scheduled_date: MONDAY, window_start: '09:00:00', window_end: '10:00:00',
      estimated_duration_minutes: 60, reservation_service_mix: mix,
    }));
    const busy = rc.onlineBusy({ techId: TECH, techBlind: false, occupancy: pair, interviews: [] });
    expect(busy[0]).toEqual({ startMin: 540, endMin: 660 });
    expect(rc.onlineStarts({ startMin: 540, min: 240 }, rc.onlineAdmit(MONDAY, AHEAD, busy, CONFIG))).toEqual([660]); // 10 AM is held
  });

  test('append-only /book (insertion off): only the time after the last stop is online room', () => {
    const rows = [stop('a', '09:00:00', '10:00:00'), stop('b', '13:00:00', '14:00:00', { lat: 27.45, lng: -82.4 })];
    const insert = rc.measureTechDay({ ...open, rows });
    const append = rc.measureTechDay({ ...open, rows, appendOnly: true });
    expect(insert.openings.map((o) => [o.kind, o.online])).toEqual([['wait', 1], ['tail', 1]]);
    expect(append.openings.map((o) => [o.kind, o.online])).toEqual([['wait', 0], ['tail', 1]]);
    expect(append.slots).toBe(insert.slots); // dispatch room is the same
  });

  test('no online room while self-booking is closed; dispatch room is unchanged', () => {
    expect(rc.onlineAdmit(MONDAY, AHEAD, [], { ...CONFIG, enabled: false })).toBeNull();
    const fig = rc.measureTechDay({ ...open, rows: [], admit: rc.onlineAdmit(MONDAY, AHEAD, [], { ...CONFIG, enabled: false }) });
    expect(fig).toMatchObject({ slots: 6, online: 0 });
  });

  test('a /book visit longer than the job slot must fit the opening and spaces the online starts', () => {
    const long = { ...CONFIG, slot_duration_minutes: 90 };
    expect(rc.onlineNeedMin(CONFIG)).toBe(80);
    expect(rc.onlineNeedMin(long)).toBe(90);
    const admit = rc.onlineAdmit(MONDAY, AHEAD, [], long);
    expect(rc.onlineStarts({ startMin: 540, min: 80 }, admit, 90)).toEqual([]); // 80 open minutes, a 90-minute visit
    expect(rc.spaced([540, 600, 660], 90)).toEqual([540, 660]);
  });

  test("booking_config's day end bounds the customer's visit", async () => {
    const late = { startMin: 900, min: 120 }; // 3:00-5:00 PM
    expect(rc.onlineStarts(late, rc.onlineAdmit(MONDAY, AHEAD, [], CONFIG))).toEqual([900]); // default close 6 PM
    // A fresh module copy, so the booking-window cache this sets never reaches the other tests.
    let fresh;
    let windows;
    jest.isolateModules(() => {
      fresh = require('../services/day-replan/route-check')._internals;
      windows = require('../services/scheduling/customer-windows');
    });
    await windows.refreshCustomerBookingWindowConfig(() => ({ first: async () => ({ lunch_start: '12:00:00', lunch_end: '12:00:00', day_end: '15:00:00' }) }));
    expect(windows.currentDayEndMinutes()).toBe(900);
    // A 3 PM close: a 3 PM visit would run to 4.
    expect(fresh.onlineStarts(late, fresh.onlineAdmit(MONDAY, AHEAD, [], CONFIG))).toEqual([]);
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
    const onSite = rc.onSiteStays([sibling('s1')], new Map([['s1', '2026-11-19T14:00:00Z']])); // 9:00 + 45
    expect(rc.vanNow({ day, home, departureMin: 480, nowMin: 660, completed: [], onSite }).clockMin).toBe(660);
  });

  test('co-visit siblings on site together are charged their combined stay, as the simulator charges them', () => {
    const arrived = new Map([['s1', '2026-11-19T14:00:00Z'], ['s2', '2026-11-19T14:00:00Z']]);
    const onSite = rc.onSiteStays([sibling('s1'), sibling('s2')], arrived);
    expect(onSite).toHaveLength(1);
    expect(rc.vanNow({ day, home, departureMin: 480, nowMin: 560, completed: [], onSite })).toMatchObject({ clockMin: 630, source: 'on_site' });
  });

  test('nothing done yet: the start point at the departure minute; a completed row with no place is ignored', () => {
    const van = rc.vanNow({ day, home, departureMin: 480, nowMin: 450, onSite: [], completed: [{ completed_at: '2026-11-19T13:00:00Z', lat: null, lng: null }] });
    expect(van).toEqual({ origin: home, clockMin: 480, source: 'start_point' });
  });
});

describe('one tech-day', () => {
  test('counts each opening of a job slot or more, for dispatch and for online booking', () => {
    const fig = rc.measureTechDay({ ...open, rows: [stop('a', '09:00:00', '10:00:00'), stop('b', '13:00:00', '14:00:00', { lat: 27.45, lng: -82.4 })] });
    expect(fig.openings.map((o) => o.kind)).toEqual(['wait', 'tail']);
    expect(fig.openings.find((o) => o.kind === 'tail')).toMatchObject({ start: 840, min: 180, slots: 2, online: 1, starts: [840, 900] });
    expect(fig).toMatchObject({ stops: 2, slots: 4, online: 2 });
  });

  test('a schedule block takes its time out of the openings', () => {
    const fig = rc.measureTechDay({ ...open, rows: [], blocks: [{ startMin: 720, endMin: 1020 }] });
    // 8 AM is not on the customer grid: online fits 9:00 only (11:00 would run past noon).
    expect(fig.openings).toEqual([{ kind: 'tail', start: 480, min: 240, slots: 3, online: 1, starts: [540, 600] }]);
  });

  test('a stop with no time or no place leaves the day unmeasured', () => {
    expect(rc.measureTechDay({ ...open, rows: [stop('a', null, null)] }).skip).toBe('UNTIMED_STOP');
    expect(rc.measureTechDay({ ...open, rows: [stop('a', '09:00:00', null, { lat: null })] }).skip).toBe('STOP_WITHOUT_COORDINATES');
  });

  test('after the day closes there is no opening', () => {
    expect(rc.measureTechDay({ ...open, rows: [], departureMin: 1050, openMin: 1050 })).toMatchObject({ openings: [], slots: 0, online: 0 });
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
  const day = (date, fig) => ({ date, technician_id: TECH, staffed: true, slots: 0, online: 0, ...fig });
  test('full budget while dispatch room exists today or in the next 3 staffed days; the online upper bound beside it', () => {
    const { totals, ad } = rc.summarize([
      day('2026-11-19', { online: 0, slots: 1 }), day('2026-11-20'), day('2026-11-21'), day('2026-11-23', { online: 1, slots: 1 }),
      day('2026-11-24', { online: 2, slots: 3 }),
    ], '2026-11-19');
    expect(totals.next).toEqual({ dates: ['2026-11-20', '2026-11-21', '2026-11-23'], slots: 1, online: 1 });
    expect(totals.week).toMatchObject({ through: '2026-11-26', slots: 4, online: 3 });
    expect(ad).toEqual({ decision: 'full', slotsAhead: 2, onlineAhead: 1, techBlind: false, unmeasured: 0 });
  });

  test('tech-blind: two technicians free at the same hours count that room once', () => {
    const TECH2 = '00000000-0000-4000-8000-000000000002';
    const free = { openings: [{ kind: 'start', start: 540, min: 160, slots: 2, online: 1, starts: [540] }], slots: 2, online: 1 };
    const days = [day('2026-11-20', free), { ...day('2026-11-20', free), technician_id: TECH2 }];
    expect(rc.summarize(days, '2026-11-19').totals.next).toMatchObject({ slots: 4, online: 2 });
    expect(rc.summarize(days, '2026-11-19', { techBlind: true }).totals.next).toMatchObject({ slots: 2, online: 1 });
  });

  test('tech-blind: every job fits one technician\'s opening, and starts are spaced once for the date', () => {
    // A free 9-11, B free 11-1: two jobs, not three (no job is handed from one technician to the other).
    expect(rc.blindSlots([{ start: 540, min: 120 }, { start: 660, min: 120 }])).toBe(2);
    // A can start only at 9, B at 10 or 11: 9 and 11 both fit.
    const TECH2 = '00000000-0000-4000-8000-000000000002';
    const days = [
      day('2026-11-20', { openings: [{ start: 540, min: 80, slots: 1, starts: [540] }] }),
      { ...day('2026-11-20', { openings: [{ start: 600, min: 140, slots: 1, starts: [600, 660] }] }), technician_id: TECH2 },
    ];
    expect(rc.summarize(days, '2026-11-19', { techBlind: true }).totals.next.online).toBe(2);
  });

  test('the 1% floor when no dispatch room exists in that window; an unmeasured day is counted, never as room', () => {
    const { ad } = rc.summarize([
      day('2026-11-19'), day('2026-11-20', { skip: 'UNTIMED_STOP', slots: 3 }), day('2026-11-21'), day('2026-11-23'),
      day('2026-11-24', { slots: 4, online: 4 }),
    ], '2026-11-19');
    expect(ad).toEqual({ decision: 'floor', slotsAhead: 0, onlineAhead: 0, techBlind: false, unmeasured: 1 });
  });
});

describe('runRouteCheck', () => {
  const NOW = new Date('2026-11-19T15:30:00Z'); // Thu 10:30 AM ET

  function fakeConn({ progress = [], occupancy = [], campaigns = [{ id: 'c1', status: 'paused', budget_mode: 'stop' }], bookingConfig = CONFIG } = {}) {
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
        first: async () => (table === 'booking_config' ? bookingConfig : undefined),
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

  test("today's completed visit keeps its booked window out of the online starts; interviews are read per date", async () => {
    replan.loadDayStops.mockResolvedValue([]);
    const done = { id: 'd1', technician_id: TECH, customer_id: 'cust-3', scheduled_date: '2026-11-19', status: 'completed', window_start: '11:00:00', window_end: '13:00:00' };
    const { conn, writes } = fakeConn({
      bookingConfig: SAME_DAY,
      occupancy: [done],
      progress: [{ ...done, completed_at: '2026-11-19T15:00:00Z', lat: 27.5, lng: -82.4 }],
    });
    await runRouteCheck({ conn, now: NOW }); // 10:30 AM, notice 1 h; the 11-1 visit finished at 10
    const today = JSON.parse(writes[0][1].days)[0];
    expect(today.openings[0].starts).toEqual([780, 840, 900]);
    expect(bookedInterviewWindowsForDate.mock.calls.map(([d]) => d)).toContain('2026-11-20');
  });

  test("the /book page's first day: with advance_days_min 1, today holds dispatch room only", async () => {
    replan.loadDayStops.mockResolvedValue([]);
    const { conn, writes } = fakeConn();
    await runRouteCheck({ conn, now: NOW });
    const days = JSON.parse(writes[0][1].days);
    expect(days[0]).toMatchObject({ date: '2026-11-19', online: 0 });
    expect(days[0].slots).toBeGreaterThan(0);
    expect(days[1].online).toBeGreaterThan(0); // tomorrow is bookable
  });

  test("an unassigned version-2 allocation holds its combined span against dispatch openings too", async () => {
    replan.loadDayStops.mockResolvedValue([]);
    const mix = { version: 2, allocatedServiceIds: ['a1', 'a2'] };
    const pair = ['a1', 'a2'].map((id) => ({
      id, technician_id: null, customer_id: 'cust-2', scheduled_date: '2026-11-20', window_start: '09:00:00', window_end: '10:00:00',
      estimated_duration_minutes: 60, reservation_service_mix: mix,
    }));
    const { conn, writes } = fakeConn({ occupancy: pair });
    await runRouteCheck({ conn, now: NOW });
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

  test('an unreadable interview list holds no time and the run still completes', async () => {
    bookedInterviewWindowsForDate.mockRejectedValue(new Error('timeout'));
    const { conn, writes } = fakeConn();
    expect((await runRouteCheck({ conn, now: NOW })).status).toBe('completed');
    expect(writes).toHaveLength(1);
    bookedInterviewWindowsForDate.mockResolvedValue([]);
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
