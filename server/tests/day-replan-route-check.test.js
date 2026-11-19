/**
 * Hourly route check, shadow (services/day-replan/route-check.js, owner 2026-11-19): the room in each route on the
 * staffed days after today, from the live schedule; which tech-days count; the totals; one route_check_runs row and no
 * other write. Fake knex, synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/technician-eligibility', () => ({
  applyAssignable: jest.fn((q) => q), absentTechDays: jest.fn(async () => new Set()),
}));
jest.mock('../services/scheduling/blackout-dates', () => ({ getBlackoutDates: jest.fn(async () => new Set()) }));
jest.mock('../services/scheduling/occupancy', () => ({ techScopedConfirmActive: jest.fn(() => false), listOccupiedWindows: jest.fn(async () => []) }));
jest.mock('../services/scheduling/departure-time', () => ({
  LEGACY_DEPARTURE_MINUTES: 480, readDepartureSetting: jest.fn(async () => ({ saved: true, minutes: 480 })), effectiveDepartureMinutes: jest.fn((s) => s.minutes),
}));
jest.mock('../services/interview-slots', () => ({ bookedInterviewWindowsForDate: jest.fn(async () => []) }));
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
const { bookedInterviewWindowsForDate } = require('../services/interview-slots');
const departure = require('../services/scheduling/departure-time');
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

describe('physical stops and reads', () => {
  const sibling = (id) => ({
    id, visit_id: null, customer_id: 'cust-1', status: 'confirmed', window_start: '09:00:00', window_end: null, estimated_duration_minutes: 45,
    lat: 27.5, lng: -82.4, service_address_line1: '1 Test St', created_at: '2026-11-01T12:00:00Z',
  });

  test('co-visit siblings, and one visit\'s services (one visit_id), are one stop', () => {
    expect(rc.physicalStops([sibling('s1'), sibling('s2')])).toHaveLength(1);
    const service = (id) => ({ ...sibling(id), visit_id: 'visit-1' });
    expect(rc.physicalStops([service('v1'), service('v2')])).toHaveLength(1);
  });

  test("one visit's services with disconnected windows are two stops, as tracking keeps them", () => {
    const am = { ...sibling('v1'), visit_id: 'visit-1', window_start: '09:00:00', window_end: '10:00:00' };
    const pm = { ...sibling('v2'), visit_id: 'visit-1', window_start: '13:00:00', window_end: '14:00:00' };
    expect(rc.physicalStops([am, pm])).toHaveLength(2);
    expect(rc.physicalStops([am, { ...pm, window_start: '10:00:00', window_end: '11:00:00' }])).toHaveLength(1);
    expect(rc.physicalStops([am, { ...pm, window_start: '10:00:00', window_end: '11:00:00', customer_id: 'cust-2' }])).toHaveLength(2);
  });

  test('a read inside the snapshot runs in its own savepoint; outside a transaction it reads directly', async () => {
    const savepoint = { name: 'sp' };
    const trx = { isTransaction: true, transaction: jest.fn(async (fn) => fn(savepoint)) };
    expect(await rc.recoverable(trx, async (c) => c)).toBe(savepoint);
    expect(trx.transaction).toHaveBeenCalledTimes(1);
    const plain = { transaction: jest.fn() };
    expect(await rc.recoverable(plain, async (c) => c)).toBe(plain);
    expect(plain.transaction).not.toHaveBeenCalled();
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
    // Two stops of one visit, in window order: the noon stop runs between them, and the day ends with the 3 PM service.
    expect(rc.routeOrder([am, pm, noon]).map((r) => r.id)).toEqual(['v1', 'n1', 'v2']);
    expect(rc.measureTechDay({ ...open, rows: [am, pm, noon] }).endMin).toBeLessThanOrEqual(960);
  });

  test("the stored route order when it is a real plan, else each stop at its own promised time", () => {
    const a = stop('a', '09:00:00', '12:00:00', { route_order: 2 });
    const b = stop('b', '09:00:00', '12:00:00', { route_order: 1, customer_id: 'cust-2', lat: 27.45, lng: -82.4 });
    expect(rc.routeOrder([a, b]).map((r) => r.id)).toEqual(['b', 'a']);
    expect(rc.routeOrder([{ ...a, route_order: null }, b]).map((r) => r.id)).toEqual(['a', 'b']); // a null: clock order
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

  test('the days after today, through the third staffed day, and at least the 7-day demand view', () => {
    expect(rc.datesToMeasure(elig, '2026-11-19', new Map())).toEqual(
      ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'],
    );
    // Off all next week: the scan runs on until it finds three staffed days.
    const away = { ...elig, absent: new Set(['20', '21', '23', '24', '25', '27', '28'].map((d) => `${TECH}:2026-11-${d}`)) };
    expect(rc.datesToMeasure(away, '2026-11-19', new Map()).at(-1)).toBe('2026-12-02');
  });
});

describe('the totals', () => {
  const day = (date, fig) => ({ date, technician_id: TECH, staffed: true, slots: 0, openings: [], ...fig });
  test('the next 3 staffed days and the 7-day view', () => {
    const totals = rc.summarize([
      day('2026-11-20'), day('2026-11-21'), day('2026-11-23', { slots: 1 }), day('2026-11-24', { slots: 3 }),
    ], '2026-11-19');
    expect(totals).toEqual({
      next: { dates: ['2026-11-20', '2026-11-21', '2026-11-23'], slots: 1, unmeasured: 0 }, week: { through: '2026-11-26', slots: 4 }, techBlind: false,
    });
    // Today is not measured: a row dated today never counts.
    expect(rc.summarize([day('2026-11-19', { slots: 5 }), day('2026-11-20'), day('2026-11-21'), day('2026-11-23')], '2026-11-19').next.slots).toBe(0);
  });

  test('tech-blind: a date counts the most any one technician can take, in any order, never the sum', () => {
    const TECH2 = '00000000-0000-4000-8000-000000000002';
    const a = day('2026-11-20', { slots: 2 });
    const b = { ...day('2026-11-20', { slots: 1 }), technician_id: TECH2 };
    expect(rc.summarize([a, b], '2026-11-19').next.slots).toBe(3);
    expect(rc.summarize([a, b], '2026-11-19', { techBlind: true }).next.slots).toBe(2);
    expect(rc.summarize([b, a], '2026-11-19', { techBlind: true }).next.slots).toBe(2);
  });

  test("the first job's drive starts with the working day: an earlier departure is not credited (a lower bound)", () => {
    const fig = rc.measureTechDay({ ...open, rows: [], departureMin: 450, openMin: 480, blocks: [{ startMin: 540, endMin: 1020 }] });
    expect(fig.openings).toEqual([]); // 8-9 AM: the drive to 8:20, no 8 AM service
  });

  test('a legacy time_window promise is a promised time, not an untimed stop', () => {
    const legacy = stop('a', null, null, { time_window: 'afternoon' });
    expect(rc.unmeasurable([legacy])).toBeNull();
    expect(rc.unmeasurable([stop('b', null, null)])).toBe('UNTIMED_STOP');
  });

  test('a job is the drive, then a service that starts on the hour', () => {
    expect(rc.hourSlots({ start: 630, min: 80 })).toBe(0); // 10:30-11:50: an 11:00 service runs to noon
    expect(rc.hourSlots({ start: 640, min: 80 })).toBe(1); // 10:40-12:00: drive to 11:00, service 11-12
    expect(rc.hourSlots({ start: 480, min: 240 })).toBe(2); // 8-12: 9:00 and 11:00
  });

  test('no room in the window counts 0; a day past the window is not counted there', () => {
    const totals = rc.summarize([
      day('2026-11-20'), day('2026-11-21'), day('2026-11-23'), day('2026-11-24', { slots: 4 }),
      day('2026-11-25', { skip: 'UNTIMED_STOP' }), // past the window: not counted
    ], '2026-11-19');
    expect(totals.next).toEqual({ dates: ['2026-11-20', '2026-11-21', '2026-11-23'], slots: 0, unmeasured: 0 });
    expect(totals.week.slots).toBe(4);
  });

  test('a staffed day in the window that could not be measured is counted as unmeasured, never as room', () => {
    const totals = rc.summarize([
      day('2026-11-20', { skip: 'UNTIMED_STOP', slots: 3 }), day('2026-11-21'), day('2026-11-23'),
    ], '2026-11-19');
    expect(totals.next).toEqual({ dates: ['2026-11-20', '2026-11-21', '2026-11-23'], slots: 0, unmeasured: 1 });
    // A long closure: the scan found only 2 staffed days, and the dates say so.
    expect(rc.summarize([day('2026-11-20'), day('2026-11-21')], '2026-11-19').next.dates).toHaveLength(2);
    expect(rc.summarize([day('2026-11-20', { slots: 1 }), day('2026-11-21', { skip: 'FAILED' })], '2026-11-19').next)
      .toMatchObject({ slots: 1, unmeasured: 1 });
  });
});

describe('runRouteCheck', () => {
  const NOW = new Date('2026-11-19T15:30:00Z'); // Thu 10:30 AM ET

  function fakeConn({ campaigns = [{ id: 'c1', status: 'paused', budget_mode: 'stop' }] } = {}) {
    const writes = [];
    const conn = (table) => {
      const q = {
        leftJoin() { return q; }, where() { return q; }, whereIn() { return q; }, whereNotIn() { return q; }, whereRaw() { return q; },
        select: async () => {
          if (table === 'technicians') return [{ id: TECH }];
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

  test('records one row: the staffed days after today, and the ad shadow; nothing else is written', async () => {
    const { conn, writes } = fakeConn();
    const result = await runRouteCheck({ conn, now: NOW });
    expect(writes.map(([table]) => table)).toEqual(['route_check_runs']);
    const row = writes[0][1];
    expect(row).toMatchObject({ run_at: NOW, service_date: '2026-11-19', status: 'completed' });
    const days = JSON.parse(row.days);
    // Today is not measured: its room depends on where the van is now (a follow-up).
    expect(days.map((d) => d.date)).toEqual(['2026-11-20', '2026-11-21', '2026-11-23', '2026-11-24', '2026-11-25']);
    expect(days[0]).toMatchObject({ stops: 1, slots: expect.any(Number) });
    expect(days[0].openings.length).toBeGreaterThan(0);
    const totals = JSON.parse(row.totals);
    expect(totals.next.dates).toEqual(['2026-11-20', '2026-11-21', '2026-11-23']);
    expect(totals.today).toBeUndefined();
    // No budget decision: the live rule's campaigns only, to compare the counts with.
    expect(JSON.parse(row.ad_shadow)).toEqual({ live: [{ id: 'c1', status: 'paused', mode: 'stop' }] });
    // Only the measured dates and the Sundays are read: never today, never the whole 14-day scan.
    expect(replan.loadDayStops.mock.calls.map(([, d]) => d)).toEqual(['2026-11-22', '2026-11-29', '2026-11-20', '2026-11-21', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26']);
    expect(listOccupiedWindows).toHaveBeenCalledWith(expect.objectContaining({ db: conn, dateFrom: '2026-11-20', dateTo: '2026-11-20' }));
    expect(totals.next).toMatchObject({ slots: expect.any(Number), unmeasured: 0 });
    expect(result).toMatchObject({ status: 'completed', days: 5 });
  });

  test('a Sunday counts when the technician has a stop booked that day', async () => {
    replan.loadDayStops.mockImplementation(async (_c, date) => (date === '2026-11-22' ? [stop('s1', '10:00:00', '11:00:00')] : []));
    const { conn, writes } = fakeConn();
    await runRouteCheck({ conn, now: NOW });
    expect(JSON.parse(writes[0][1].days).find((d) => d.date === '2026-11-22')).toMatchObject({ stops: 1, staffed: true });
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

  test('a run-wide read failing still writes the hour, as failed with its error', async () => {
    getBlackoutDates.mockRejectedValueOnce(new Error('timeout'));
    const { conn, writes } = fakeConn();
    const result = await runRouteCheck({ conn, now: NOW });
    expect(result).toMatchObject({ status: 'failed', totals: { error: 'timeout' } });
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toMatchObject({ status: 'failed', service_date: '2026-11-19' });
    expect(JSON.parse(writes[0][1].totals)).toEqual({ error: 'timeout' });
  });

  test('an unassigned booking ending off the hour holds only its own minutes', async () => {
    replan.loadDayStops.mockResolvedValue([]);
    listOccupiedWindows.mockImplementation(async ({ dateFrom }) => (dateFrom === '2026-11-20' ? [span('u1', null, 480, 930)] : [])); // 8:00-3:30
    const { conn, writes } = fakeConn();
    await runRouteCheck({ conn, now: NOW });
    const friday = JSON.parse(writes[0][1].days).find((d) => d.date === '2026-11-20');
    expect(friday.openings).toEqual([expect.objectContaining({ start: 930, min: 90, slots: 1 })]); // drive 3:30-3:50, a 4 PM job
    listOccupiedWindows.mockResolvedValue([]);
  });

  test("the owner's booked interviews hold dispatch time; an unreadable list marks the date", async () => {
    replan.loadDayStops.mockResolvedValue([]);
    bookedInterviewWindowsForDate.mockImplementation(async (date) => {
      if (date === '2026-11-20') return [{ start: '08:00', end: '15:30', applicationId: 'app-1' }];
      if (date === '2026-11-21') throw new Error('timeout');
      return [];
    });
    const { conn, writes } = fakeConn();
    await runRouteCheck({ conn, now: NOW });
    const days = JSON.parse(writes[0][1].days);
    expect(days.find((d) => d.date === '2026-11-20').openings).toEqual([expect.objectContaining({ start: 930 })]);
    expect(days.find((d) => d.date === '2026-11-21')).toMatchObject({ skip: 'FAILED' });
    bookedInterviewWindowsForDate.mockResolvedValue([]);
  });

  test('an unreadable departure time (day rules on) records the run as failed, never an 08:00 guess', async () => {
    const saved = process.env.GATE_AUTO_DISPATCH_DAY_RULES;
    process.env.GATE_AUTO_DISPATCH_DAY_RULES = 'true';
    departure.readDepartureSetting.mockRejectedValueOnce(new Error('timeout'));
    const { conn, writes } = fakeConn();
    const result = await runRouteCheck({ conn, now: NOW });
    if (saved === undefined) delete process.env.GATE_AUTO_DISPATCH_DAY_RULES; else process.env.GATE_AUTO_DISPATCH_DAY_RULES = saved;
    expect(result).toMatchObject({ status: 'failed' });
    expect(writes[0][1]).toMatchObject({ status: 'failed' });
  });

  test('every read of a run comes from one read-only snapshot, each recoverable read in a savepoint; the row is written outside it', async () => {
    const { conn, writes } = fakeConn();
    const seen = [];
    const snap = (table) => ({ ...conn(table), insert: async () => { throw new Error('written inside the snapshot'); } });
    snap.raw = conn.raw;
    snap.isTransaction = true;
    snap.transaction = jest.fn(async (fn) => fn(snap)); // a savepoint
    const pool = (table) => conn(table);
    pool.raw = conn.raw;
    pool.transaction = jest.fn(async (fn, opts) => { seen.push(opts); return fn(snap); });
    const result = await runRouteCheck({ conn: pool, now: NOW });
    expect(pool.transaction).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual({ isolationLevel: 'repeatable read', readOnly: true });
    expect(replan.loadDayStops.mock.calls.find(([, d]) => d === '2026-11-20')[0]).toBe(snap);
    expect(snap.transaction).toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(writes.map(([table]) => table)).toEqual(['route_check_runs']);
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

});
