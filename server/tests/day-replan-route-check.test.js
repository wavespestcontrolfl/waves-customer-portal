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
jest.mock('../services/day-replan/index', () => ({
  _internals: { loadDayStops: jest.fn(async () => []), loadBlocks: jest.fn(async () => []), blockedHoursFor: jest.fn(() => []) },
}));

const { _internals: replan } = require('../services/day-replan/index');
const { getBlackoutDates } = require('../services/scheduling/blackout-dates');
const { absentTechDays } = require('../services/technician-eligibility');
const { runRouteCheck, _internals: rc } = require('../services/day-replan/route-check');

const TECH = '00000000-0000-4000-8000-000000000001';
const HQ = { lat: 27.4, lng: -82.45 };
const stop = (id, start, end, extra = {}) => ({
  id, technician_id: TECH, status: 'confirmed', window_start: start, window_end: end, estimated_duration_minutes: 45,
  lat: 27.41, lng: -82.46, created_at: '2026-11-01T12:00:00Z', ...extra,
});
const open = { blocks: [], held: [], origin: HQ, departureMin: 480, openMin: 480, closeMin: 1020, onlineDay: true };

const savedGate = process.env.GATE_CUSTOMER_LAST_START_16;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_CUSTOMER_LAST_START_16 = 'true';
});
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_CUSTOMER_LAST_START_16;
  else process.env.GATE_CUSTOMER_LAST_START_16 = savedGate;
});

describe('online count: the customer hour grid and the customer last start', () => {
  test('an opening holds an online job only on the hour grid, with a full job slot inside it', () => {
    expect(rc.onlineSlots({ startMin: 560, min: 80 }, true)).toBe(0); // 9:20-10:40: dispatch fits one, no hourly start does
    expect(rc.onlineSlots({ startMin: 540, min: 480 }, true)).toBe(4); // 9:00, 11:00, 1:00 and 3:00 PM
    expect(rc.onlineSlots({ startMin: 540, min: 480 }, false)).toBe(0); // a Sunday: the picker offers no day
  });

  test('a 5 PM start counts only while GATE_CUSTOMER_LAST_START_16 is off', () => {
    expect(rc.onlineSlots({ startMin: 1020, min: 80 }, true)).toBe(0);
    process.env.GATE_CUSTOMER_LAST_START_16 = 'false';
    expect(rc.onlineSlots({ startMin: 1020, min: 80 }, true)).toBe(1);
  });
});

describe('where the van is now (today)', () => {
  const day = '2026-11-19';
  const home = HQ;
  test('the latest completed stop sets the place and the clock', () => {
    const van = rc.vanNow({
      day, home, departureMin: 480, nowMin: 630,
      progress: [
        { status: 'completed', completed_at: '2026-11-19T13:50:00Z', lat: 27.3, lng: -82.5 }, // 8:50 ET
        { status: 'completed', completed_at: '2026-11-19T14:45:00Z', lat: 27.5, lng: -82.4 }, // 9:45 ET
      ],
    });
    expect(van).toEqual({ origin: { lat: 27.5, lng: -82.4 }, clockMin: 585, source: 'completed' });
  });

  test('a job on site that runs past its estimate keeps the van there until now', () => {
    const van = rc.vanNow({
      day, home, departureMin: 480, nowMin: 660,
      progress: [{ status: 'on_site', arrived_at: '2026-11-19T14:00:00Z', estimated_duration_minutes: 45, lat: 27.5, lng: -82.4 }], // 9:00 + 45
    });
    expect(van.clockMin).toBe(660);
  });

  test('nothing done yet: the start point at the departure minute; a row with no place is ignored', () => {
    const van = rc.vanNow({ day, home, departureMin: 480, nowMin: 450, progress: [{ status: 'completed', completed_at: '2026-11-19T13:00:00Z', lat: null, lng: null }] });
    expect(van).toEqual({ origin: home, clockMin: 480, source: 'start_point' });
  });
});

describe('one tech-day', () => {
  test('counts each opening of a job slot or more, for dispatch and for online booking', () => {
    const fig = rc.measureTechDay({ ...open, rows: [stop('a', '09:00:00', '10:00:00'), stop('b', '13:00:00', '14:00:00', { lat: 27.45, lng: -82.4 })] });
    expect(fig.openings.map((o) => o.kind)).toEqual(['wait', 'tail']);
    expect(fig.openings.find((o) => o.kind === 'tail')).toMatchObject({ start: 840, min: 180, slots: 2, online: 1 });
    expect(fig).toMatchObject({ stops: 2, slots: 4, online: 2 });
  });

  test('a schedule block takes its time out of the openings', () => {
    const fig = rc.measureTechDay({ ...open, rows: [], blocks: [{ startMin: 720, endMin: 1020 }] });
    // 8 AM is not on the customer grid: online fits 9:00 only (11:00 would run past noon).
    expect(fig.openings).toEqual([{ kind: 'tail', start: 480, min: 240, slots: 3, online: 1 }]);
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
  test('full budget while an online opening exists today or in the next 3 staffed days', () => {
    const { totals, ad } = rc.summarize([
      day('2026-11-19', { online: 0, slots: 1 }), day('2026-11-20'), day('2026-11-21'), day('2026-11-23', { online: 1, slots: 1 }),
      day('2026-11-24', { online: 2, slots: 3 }),
    ], '2026-11-19');
    expect(totals.next).toEqual({ dates: ['2026-11-20', '2026-11-21', '2026-11-23'], slots: 1, online: 1 });
    expect(totals.week).toMatchObject({ through: '2026-11-26', slots: 4, online: 3 });
    expect(ad).toEqual({ decision: 'full', onlineAhead: 1, slotsAhead: 2, unmeasured: 0 });
  });

  test('the 1% floor when no online opening exists; an unmeasured day is counted, never as room', () => {
    const { ad } = rc.summarize([
      day('2026-11-19', { slots: 2 }), day('2026-11-20', { skip: 'UNTIMED_STOP', online: 0 }), day('2026-11-21'), day('2026-11-23'),
      day('2026-11-24', { online: 4 }),
    ], '2026-11-19');
    expect(ad).toEqual({ decision: 'floor', onlineAhead: 0, slotsAhead: 2, unmeasured: 1 });
  });
});

describe('runRouteCheck', () => {
  const NOW = new Date('2026-11-19T15:30:00Z'); // Thu 10:30 AM ET

  function fakeConn({ progress = [], campaigns = [{ id: 'c1', status: 'paused', budget_mode: 'stop' }] } = {}) {
    const writes = [];
    const conn = (table) => {
      const q = {
        leftJoin() { return q; }, where() { return q; }, whereIn() { return q; },
        select: async () => {
          if (table === 'technicians') return [{ id: TECH }];
          if (table === 'scheduled_services') return progress;
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
    expect(replan.loadDayStops.mock.calls.map(([, d]) => d)).toEqual(['2026-11-22', '2026-11-29', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26']);
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
});
