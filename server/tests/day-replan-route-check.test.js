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
// The booking engine's question (day-agreement-shadow.js freeSlotsAt); its own suite covers how it asks the engine.
jest.mock('../services/day-agreement-shadow', () => ({
  freeSlotsAt: jest.fn(async () => []),
  visitIdentity: ({ service }) => ({ name: service?.name || null, minutes: Number(service?.default_duration_minutes) || 60 }),
}));

const { _internals: replan } = require('../services/day-replan/index');
const { freeSlotsAt } = require('../services/day-agreement-shadow');
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

  test("a legacy promised time takes part in the chain rule: one visit's 9 AM and 3 PM services are two stops", () => {
    const legacy = (id, time_window) => ({ ...sibling(id), visit_id: 'visit-1', window_start: null, window_end: null, time_window });
    expect(rc.physicalStops([legacy('v1', '9:00 AM'), legacy('v2', '3:00 PM')])).toHaveLength(2);
    expect(rc.physicalStops([legacy('v1', '9:00 AM'), legacy('v2', '10:00 AM')])).toHaveLength(1); // 9-11 and 10-12 connect
    // Their promises do not overlap, so dispatch cannot run them as one stop: the day is not simulated.
    const noon = stop('n1', '12:00:00', '13:00:00', { customer_id: 'cust-2', lat: 27.45, lng: -82.4 });
    const legacyDay = [legacy('v1', '9:00 AM'), legacy('v2', '3:00 PM'), noon].map((r) => ({ ...r, technician_id: TECH }));
    expect(rc.measureTechDay({ ...open, rows: legacyDay })).toEqual({ stops: 3, skip: 'GROUP_UNMODELED' });
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

  test("a visit's morning and afternoon services are two stops; apart in the order, dispatch cannot group them", () => {
    const am = stop('v1', '09:00:00', '10:00:00', { visit_id: 'visit-1', customer_id: 'cust-1' });
    const pm = stop('v2', '15:00:00', '16:00:00', { visit_id: 'visit-1', customer_id: 'cust-1' });
    const noon = stop('n1', '12:00:00', '13:00:00', { customer_id: 'cust-2', lat: 27.45, lng: -82.4 });
    // Counted as 3 stops; not simulated (arrival-route.js groupRouteStops: one visit's services apart in the order).
    expect(rc.measureTechDay({ ...open, rows: [am, pm, noon] })).toEqual({ stops: 3, skip: 'GROUP_UNMODELED' });
  });

  test("dispatch's order rule: the stored order when it is a real plan; when it is stale, both orders run (round 31)", () => {
    const { storedOrderStale } = require('../services/scheduling/arrival-route')._internals;
    const ids = (rows) => rc.simulateBookedDay(rows, { origin: HQ, departureMin: 480, blocks: [], date: MONDAY }).sim.arrivals.map((x) => x.id);
    const a = stop('a', '09:00:00', '12:00:00', { route_order: 2 });
    const b = stop('b', '09:00:00', '12:00:00', { route_order: 1, customer_id: 'cust-2', lat: 27.45, lng: -82.4 });
    expect(ids([a, b])).toEqual(['b', 'a']); // a real plan: the stored order alone
    // Stale numbering (a gap, an earlier promise behind a later one): both orders run, and dispatch's choice wins
    // (selectWinningOrder): here promised-window order z, x, y drives less than the stored x, z, y.
    const at = (id, start, order, lat) => stop(id, start, null, { route_order: order, customer_id: `cust-${id}`, lat, lng: -82.45 });
    const line = [at('x', '10:00:00', 1, 27.5), at('z', '09:00:00', 2, 27.45), at('y', '11:00:00', 4, 27.6)];
    expect(storedOrderStale(line)).toBe(true);
    expect(ids(line)).toEqual(['z', 'x', 'y']);
    // The stored order still runs when promised-window order brings the van home after 18:00.
    const day = [at('near', '14:00:00', 3, 27.41), at('far', '14:30:00', 1, 27.9)];
    expect(storedOrderStale(day)).toBe(true);
    expect(ids(day)).toEqual(['far', 'near']);
  });

  test("between two orders, one that keeps every promise wins over a late one, whatever its drive (round 32)", () => {
    const { storedOrderStale } = require('../services/scheduling/arrival-route')._internals;
    const at = (id, start, end, order, lat) => stop(id, start, end, { route_order: order, customer_id: `cust-${id}`, lat, lng: -82.45 });
    // The stored p1, p2, p3 drives least (86 minutes) but reaches p2 43 minutes after its arrival promise (8:00 plus
    // 2 hours), behind p1's 2-hour job; promised-window order p2, p1, p3 drives 102 and keeps every promise.
    const day = [{ ...at('p1', '08:30:00', null, 1, 27.45), estimated_duration_minutes: 120 },
      at('p2', '08:00:00', '09:00:00', 2, 27.5), at('p3', '10:30:00', null, 4, 27.6)];
    expect(storedOrderStale(day)).toBe(true);
    const { sim } = rc.simulateBookedDay(day, { origin: HQ, departureMin: 480, blocks: [], date: MONDAY });
    expect(sim.arrivals.map((x) => x.id)).toEqual(['p2', 'p1', 'p3']);
    expect(sim.arrivals.every((x) => !(x.lateMinutes > 0))).toBe(true);
  });

  test("a version-2 allocation's services are one stop, also with no street address (round 31)", () => {
    const mix = { version: 2, allocatedServiceIds: ['a1', 'a2'] };
    const member = (id) => stop(id, '09:00:00', null, {
      visit_id: null, customer_id: 'cust-1', scheduled_date: MONDAY, estimated_duration_minutes: 30, reservation_service_mix: mix,
    });
    const rows = [member('a1'), member('a2')];
    expect(rc.physicalStops(rows)).toHaveLength(1);
    expect(rc.measureTechDay({ ...open, rows })).toMatchObject({ stops: 1 });
  });

  test('a schedule block takes its time out of the openings', () => {
    const fig = rc.measureTechDay({ ...open, rows: [], blocks: [{ startMin: 720, endMin: 1020 }] });
    expect(fig.openings).toEqual([{ kind: 'tail', start: 480, min: 240, slots: 2, noticeSlots: 3 }]); // 8:00, 10:00
  });

  test('a stop with no time or no place leaves the day unmeasured', () => {
    expect(rc.measureTechDay({ ...open, rows: [stop('a', null, null)] }).skip).toBe('UNTIMED_STOP');
    expect(rc.measureTechDay({ ...open, rows: [stop('a', '09:00:00', null, { lat: null })] }).skip).toBe('STOP_WITHOUT_COORDINATES');
  });

  test('stops counts physical stops, measured or not: one visit\'s two services at one place are one stop', () => {
    const service = (id, extra) => stop(id, '09:00:00', '10:00:00', { visit_id: 'visit-1', ...extra });
    expect(rc.measureTechDay({ ...open, rows: [service('v1'), service('v2')] }).stops).toBe(1);
    expect(rc.measureTechDay({ ...open, rows: [service('v1'), service('v2', { lat: null })] })).toMatchObject({ stops: 1, skip: 'STOP_WITHOUT_COORDINATES' });
  });

  test("dispatch's grouping: a visit's services are one stop, and a block moves the whole visit, never splits it", () => {
    // Open-ended windows: each service's work is its 45-minute estimate (a window's span would count as work).
    const service = (id, extra) => stop(id, '09:00:00', null, { visit_id: 'visit-1', customer_id: 'cust-1', ...extra });
    const visit = [service('v1'), service('v2')];
    // One arrival at 9:00, then 45 + 45 minutes: done at 10:30.
    expect(rc.measureTechDay({ ...open, rows: visit })).toMatchObject({ stops: 1, endMin: 630 });
    // A block at 9:45-10:30 moves the whole 90 minutes past it: done at 12:00.
    expect(rc.measureTechDay({ ...open, rows: visit, blocks: [{ startMin: 585, endMin: 630 }] })).toMatchObject({ stops: 1, endMin: 720 });
    // One visit's services at two places: dispatch cannot run them as one stop, so the day is not simulated.
    expect(rc.measureTechDay({ ...open, rows: [service('v1'), service('v2', { lat: 27.45, lng: -82.4 })] }).skip).toBe('GROUP_UNMODELED');
  });

  test("dispatch's grouping: a version-2 allocation's services are one stop at one arrival, their work summed", () => {
    const member = (id, extra) => stop(id, '09:00:00', null, {
      visit_id: null, customer_id: 'cust-1', scheduled_date: MONDAY, estimated_duration_minutes: 30, service_address_line1: '1 Test St', ...extra,
    });
    const mix = { version: 2, allocatedServiceIds: ['a1', 'a2'] };
    const allocated = [member('a1', { reservation_service_mix: mix }), member('a2', { reservation_service_mix: mix })];
    const day = (rows, blocks = []) => rc.simulateBookedDay(rows, { origin: HQ, departureMin: 480, blocks, date: MONDAY }).sim.arrivals;
    expect(day(allocated)).toEqual([expect.objectContaining({ id: 'a1', arrivalMin: 540, departureMin: 600 })]);
    // A block inside it moves all 60 minutes; co-visit siblings with no allocation run around the block instead.
    expect(day(allocated, [{ startMin: 570, endMin: 600 }])).toEqual([expect.objectContaining({ arrivalMin: 600, departureMin: 660 })]);
    expect(day([member('a1'), member('a2')], [{ startMin: 570, endMin: 600 }]).at(-1).departureMin).toBe(630);
  });

  test("each stop is charged its planned minutes, as dispatch stamps them for a version-2 booking (round 30)", () => {
    const { PLANNING_MINUTES } = require('../services/scheduling/planning-minutes');
    // A one-time pest stop at 14:00 with a 15-minute estimate and no window end: charged the table's minutes.
    const pest = stop('p1', '14:00:00', null, { service_type: 'One-Time Pest Control', estimated_duration_minutes: 15 });
    expect(rc.measureTechDay({ ...open, rows: [pest] })).toMatchObject({ stops: 1, endMin: 840 + PLANNING_MINUTES.oneTimePest });
    // A service the table does not name keeps its own estimate.
    expect(rc.measureTechDay({ ...open, rows: [{ ...pest, service_type: 'Mosquito' }] })).toMatchObject({ endMin: 855 });
  });

  test("the last opening leaves the drive home before dispatch's day end; a block on the way home moves it earlier (round 30)", () => {
    const RouteOptimizer = require('../services/route-optimizer');
    const far = { lat: 27.9, lng: -82.45 }; // a 97-minute drive home on the conservative model
    const leg = RouteOptimizer.createSchedulingTravel({ maxRequests: 0 }).lookup({ date: MONDAY, from: far, to: HQ, departureMin: 600 }).minutes;
    // The drive home is longer than the hour between the day's close (17:00) and dispatch's day end (18:00).
    expect(rc.DISPATCH_DAY_END).toBe(18 * 60);
    expect(leg).toBeGreaterThan(rc.DISPATCH_DAY_END - open.closeMin);
    const lastTail = (blocks = []) => rc.measureTechDay({ ...open, rows: [stop('f1', '09:00:00', null, far)], blocks, date: MONDAY })
      .openings.filter((o) => o.kind === 'tail').at(-1);
    const tail = lastTail();
    expect(tail.start + tail.min).toBe(rc.DISPATCH_DAY_END - leg);
    // A block across that drive home: the van must leave before the block.
    const blockStart = rc.DISPATCH_DAY_END - leg + 10;
    const blocked = lastTail([{ startMin: blockStart, endMin: blockStart + 20 }]);
    expect(blocked.start + blocked.min).toBe(blockStart - leg);
    // A booked day that ends after the day end is not simulated: dispatch refuses every placement on it.
    expect(rc.measureTechDay({ ...open, rows: [stop('late', '17:30:00', null)] }).skip).toBe('NO_SIMULATION');
  });

  test("a block with no valid span leaves the day unmeasured, as dispatch's simulation refuses it (round 33)", () => {
    const day = [stop('s1', '10:00:00', null)];
    for (const block of [{ startMin: 600, endMin: 600 }, { startMin: 660, endMin: 600 }, { startMin: NaN, endMin: 600 }]) {
      expect(rc.measureTechDay({ ...open, rows: day, blocks: [block] }).skip).toBe('NO_SIMULATION');
    }
    expect(rc.measureTechDay({ ...open, rows: day, blocks: [{ startMin: 600, endMin: 660 }] }).skip).toBeUndefined();
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
      next: { dates: ['2026-11-20', '2026-11-21', '2026-11-23'], slots: 1, unmeasured: [] }, week: { through: '2026-11-26', slots: 4, unmeasured: [] }, techBlind: false,
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
    expect(totals.next).toEqual({ dates: ['2026-11-20', '2026-11-21', '2026-11-23'], slots: 0, unmeasured: [] });
    // The 7-day view names the date it could not measure.
    expect(totals.week).toEqual({ through: '2026-11-26', slots: 4, unmeasured: ['2026-11-25'] });
  });

  test('a staffed day in the window that could not be measured is counted as unmeasured, never as room', () => {
    const totals = rc.summarize([
      day('2026-11-20', { skip: 'UNTIMED_STOP', slots: 3 }), day('2026-11-21'), day('2026-11-23'),
    ], '2026-11-19');
    expect(totals.next).toEqual({ dates: ['2026-11-20', '2026-11-21', '2026-11-23'], slots: 0, unmeasured: ['2026-11-20'] });
    // A long closure: the scan found only 2 staffed days, and the dates say so.
    expect(rc.summarize([day('2026-11-20'), day('2026-11-21')], '2026-11-19').next.dates).toHaveLength(2);
    expect(rc.summarize([day('2026-11-20', { slots: 1 }), day('2026-11-21', { skip: 'FAILED' })], '2026-11-19').next)
      .toMatchObject({ slots: 1, unmeasured: ['2026-11-21'] });
    // Two technicians unmeasured on one date name that date once.
    const TECH2 = '00000000-0000-4000-8000-000000000002';
    const both = [day('2026-11-20', { skip: 'FAILED' }), { ...day('2026-11-20', { skip: 'UNTIMED_STOP' }), technician_id: TECH2 }, day('2026-11-21'), day('2026-11-23')];
    expect(rc.summarize(both, '2026-11-19').next.unmeasured).toEqual(['2026-11-20']);
  });
});

describe('runRouteCheck', () => {
  const NOW = new Date('2026-11-19T15:30:00Z'); // Thu 10:30 AM ET

  // The slot rule's inputs: the catalog's stated job and the service zones' centers (synthetic pins).
  const JOB = { name: 'Quarterly Pest Control Service', default_duration_minutes: 60, is_active: true };
  const ZONES = [
    { zone_name: 'North', center_lat: 27.5, center_lng: -82.57 },
    { zone_name: 'South', center_lat: 27.1, center_lng: -82.45 },
  ];
  // The decision when every ask answers with no slot.
  const FLOOR = {
    mode: 'floor', job: { key: 'pest_general_quarterly', name: JOB.name, minutes: 60 },
    dates: ['2026-11-20', '2026-11-21', '2026-11-23'],
    zones: ['North', 'South'].map((zone) => ({
      zone, byDate: { '2026-11-20': 0, '2026-11-21': 0, '2026-11-23': 0 }, first: null,
    })),
  };

  // `campaigns` an Error: the campaign read throws. `taken`: the unique key's rows (key -> row), shared across runs.
  // `job` / `zones`: the catalog row and the zone rows the decision reads (an Error throws).
  function fakeConn({
    campaigns = [{ id: 'c1', status: 'paused', budget_mode: 'stop' }], taken = new Map(), job = JOB, zones = ZONES,
  } = {}) {
    const writes = [];
    const conflicts = [];
    const reads = [];
    const conn = (table) => {
      let filter = {};
      const q = {
        leftJoin() { return q; }, whereIn() { return q; }, whereNotIn() { return q; }, whereRaw() { return q; },
        where(arg) { if (arg && typeof arg === 'object') filter = arg; return q; },
        first: async () => {
          if (table !== 'services') return taken.get(`${filter.service_date}|${filter.run_hour}`);
          reads.push([table, filter]);
          if (job instanceof Error) throw job;
          return job;
        },
        select: async () => {
          if (table === 'technicians') return [{ id: TECH }];
          if (table === 'ad_campaigns') {
            if (campaigns instanceof Error) throw campaigns;
            return campaigns;
          }
          if (table === 'service_zones') {
            if (zones instanceof Error) throw zones;
            return zones;
          }
          return [];
        },
        // ON CONFLICT (cols) DO NOTHING RETURNING id: no row back when the key is taken.
        insert: (row) => ({
          onConflict: (cols) => ({
            ignore: () => ({
              returning: async () => {
                conflicts.push(cols);
                const key = cols.map((c) => row[c]).join('|');
                if (taken.has(key)) return [];
                taken.set(key, row);
                writes.push([table, row]);
                return [{ id: `r${writes.length}` }];
              },
            }),
          }),
        }),
        update: async (row) => { writes.push([table, row]); return 1; },
      };
      return q;
    };
    conn.raw = (sql) => sql;
    return { conn, writes, conflicts, reads };
  }

  beforeEach(() => {
    freeSlotsAt.mockReset();
    freeSlotsAt.mockImplementation(async () => []);
    getBlackoutDates.mockResolvedValue(new Set(['2026-11-26']));
    absentTechDays.mockResolvedValue(new Set());
    replan.loadDayStops.mockImplementation(async (_c, date) => {
      if (date === '2026-11-19') return [stop('t1', '13:00:00', '14:00:00')];
      if (date === '2026-11-20') return [stop('f1', '09:00:00', '10:00:00')];
      return [];
    });
  });

  test('records one row: the staffed days after today, and the ad shadow; nothing else is written', async () => {
    const { conn, writes, conflicts } = fakeConn();
    const result = await runRouteCheck({ conn, now: NOW });
    expect(writes.map(([table]) => table)).toEqual(['route_check_runs']);
    const row = writes[0][1];
    expect(row).toMatchObject({ run_at: NOW, service_date: '2026-11-19', run_hour: 10, status: 'completed' });
    expect(conflicts).toEqual([['service_date', 'run_hour']]);
    const days = JSON.parse(row.days);
    // Today is not measured: its room depends on where the van is now (a follow-up).
    expect(days.map((d) => d.date)).toEqual(['2026-11-20', '2026-11-21', '2026-11-23', '2026-11-24', '2026-11-25']);
    expect(days[0]).toMatchObject({ stops: 1, slots: expect.any(Number) });
    expect(days[0].openings.length).toBeGreaterThan(0);
    const totals = JSON.parse(row.totals);
    expect(totals.next.dates).toEqual(['2026-11-20', '2026-11-21', '2026-11-23']);
    expect(totals.today).toBeUndefined();
    // The live rule's campaigns, to compare with, and the slot rule's decision from the booking engine (no slot here).
    expect(JSON.parse(row.ad_shadow)).toEqual({ live: [{ id: 'c1', status: 'paused', mode: 'stop' }], decision: FLOOR });
    // Only the measured dates and the Sundays are read: never today, never the whole 14-day scan.
    expect(replan.loadDayStops.mock.calls.map(([, d]) => d)).toEqual(['2026-11-22', '2026-11-29', '2026-11-20', '2026-11-21', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26']);
    expect(listOccupiedWindows).toHaveBeenCalledWith(expect.objectContaining({ db: conn, dateFrom: '2026-11-20', dateTo: '2026-11-20' }));
    expect(totals.next).toMatchObject({ slots: expect.any(Number), unmeasured: [] });
    expect(result).toMatchObject({ status: 'completed', days: 5 });
  });

  test('a Sunday counts when the technician has a stop booked that day', async () => {
    replan.loadDayStops.mockImplementation(async (_c, date) => (date === '2026-11-22' ? [stop('s1', '10:00:00', '11:00:00')] : []));
    const { conn, writes } = fakeConn();
    await runRouteCheck({ conn, now: NOW });
    expect(JSON.parse(writes[0][1].days).find((d) => d.date === '2026-11-22')).toMatchObject({ stops: 1, staffed: true });
  });

  test("a placeholder dispatch drops (no window start, no time window) is no stop and staffs no Sunday (round 39)", async () => {
    const placeholder = (date) => stop('p1', null, null, { status: 'pending', scheduled_date: date });
    replan.loadDayStops.mockImplementation(async (_c, date) => {
      if (date === '2026-11-20') return [stop('f1', '09:00:00', '10:00:00'), placeholder(date)];
      if (date === '2026-11-22') return [placeholder(date)];
      return [];
    });
    const { conn, writes } = fakeConn();
    await runRouteCheck({ conn, now: NOW });
    const days = JSON.parse(writes[0][1].days);
    expect(days.find((d) => d.date === '2026-11-20')).toMatchObject({ stops: 1, slots: expect.any(Number) });
    expect(days.find((d) => d.date === '2026-11-20').skip).toBeUndefined();
    expect(days.some((d) => d.date === '2026-11-22')).toBe(false);
    expect(JSON.parse(writes[0][1].totals).next).toMatchObject({ dates: ['2026-11-20', '2026-11-21', '2026-11-23'], unmeasured: [] });
    replan.loadDayStops.mockResolvedValue([]);
  });

  test("an unclaimed hold alone does not staff a Sunday; a staff-booked visit that keeps its hold timestamp does (round 38)", async () => {
    const expires = '2026-11-20T12:00:00Z';
    for (const [extra, staffedSunday] of [
      [{ customer_id: null, reservation_expires_at: expires }, false],
      [{ customer_id: 'cust-1', reservation_expires_at: expires }, true],
    ]) {
      replan.loadDayStops.mockImplementation(async (_c, date) => (date === '2026-11-22' ? [stop('h1', '10:00:00', '11:00:00', extra)] : []));
      const { conn, writes } = fakeConn();
      await runRouteCheck({ conn, now: NOW });
      const days = JSON.parse(writes[0][1].days);
      expect([extra.customer_id, days.some((d) => d.date === '2026-11-22')]).toEqual([extra.customer_id, staffedSunday]);
      expect(JSON.parse(writes[0][1].totals).next.dates)
        .toEqual(staffedSunday ? ['2026-11-20', '2026-11-21', '2026-11-22'] : ['2026-11-20', '2026-11-21', '2026-11-23']);
    }
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

  test("the check reads every visit staff have booked and every block, as dispatch's commit-time checks do (rounds 33, 34)", async () => {
    replan.loadDayStops.mockImplementation(async (_c, date) => (date === '2026-11-20' ? [stop('s1', '10:00:00', null)] : []));
    const { conn } = fakeConn();
    await runRouteCheck({ conn, now: NOW });
    expect(replan.loadDayStops.mock.calls.length).toBeGreaterThan(0);
    expect(replan.loadDayStops.mock.calls.every(([, , booked]) => booked === true)).toBe(true);
    expect(replan.loadBlocks.mock.calls.length).toBeGreaterThan(0);
    expect(replan.loadBlocks.mock.calls.every(([, , , options]) => options?.keepInvalid === true)).toBe(true);
    // Held time and version-2 allocations come from the same booked-visit rule as the stops (round 34).
    expect(listOccupiedWindows.mock.calls.length).toBeGreaterThan(0);
    expect(listOccupiedWindows.mock.calls.every(([options]) => options.includeClaimedReservations === true)).toBe(true);
    replan.loadDayStops.mockResolvedValue([]);
  });

  test('work the count must hold but cannot leaves its date unmeasured (rounds 35 to 37)', () => {
    const work = (id, technician_id, extra) => stop(id, null, null, { technician_id, ...extra });
    const own = stop('s1', '10:00:00', null);
    const cases = [
      // Unassigned work: dispatch holds its whole promise plus its work, or blocks every route.
      [work('u1', null, { time_window: '3 PM' }), true, 'UNASSIGNED_WORK'],
      [work('u2', null, { time_window: 'afternoon' }), true, 'UNASSIGNED_WORK'],
      [work('u3', null, { window_start: '09:00:00', window_end: '10:00:00' }), true, 'UNASSIGNED_WORK'],
      [work('u4', null, { time_window: '  ' }), true, 'UNASSIGNED_WORK'],
      [work('u5', null, { window_start: '09:00:00', status: 'completed' }), true, null],
      [work('u6', null, { time_window: null }), true, null],
      [work('u7', null, { time_window: '' }), true, null],
      // Work under way with no time field: dispatch keeps it, cannot resolve it, and blocks every route (round 37).
      [work('u8', null, { status: 'en_route' }), true, 'UNASSIGNED_WORK'],
      [work('u9', null, { status: 'on_site' }), true, 'UNASSIGNED_WORK'],
      // Another technician's visit: only a legacy window, and only while tech-blind.
      [work('x1', 'other-tech', { time_window: '3 PM' }), true, 'LEGACY_WINDOW_ELSEWHERE'],
      [work('x2', 'other-tech', { time_window: '3 PM' }), false, null],
      [work('x3', 'other-tech', { window_start: '15:00:00', time_window: '3 PM' }), true, null],
      [stop('s2', null, null, { time_window: '3 PM' }), true, null],
    ];
    for (const [row, techBlind, skip] of cases) expect([row.id, rc.unheldWork([own, row], TECH, techBlind)]).toEqual([row.id, skip]);
  });

  test("a date with work the count cannot hold is unmeasured, its tech-days' stops still counted (rounds 35, 36)", async () => {
    for (const [extra, skip] of [[{ time_window: '3 PM' }, 'UNASSIGNED_WORK'], [{ window_start: '09:00:00' }, 'UNASSIGNED_WORK'], [{}, undefined]]) {
      const row = stop('u1', null, null, { technician_id: null, scheduled_date: '2026-11-20', ...extra });
      replan.loadDayStops.mockImplementation(async (_c, date) => (date === '2026-11-20' ? [stop('s1', '10:00:00', null), row] : []));
      const { conn, writes } = fakeConn();
      await runRouteCheck({ conn, now: NOW });
      const day = JSON.parse(writes[0][1].days).find((d) => d.date === '2026-11-20');
      expect([extra, day.skip, day.stops]).toEqual([extra, skip, 1]);
      expect(JSON.parse(writes[0][1].totals).next.unmeasured.includes('2026-11-20')).toBe(skip != null);
    }
    replan.loadDayStops.mockResolvedValue([]);
  });

  test("a version-2 allocation's services are one stop: its allocation comes from the occupancy read", async () => {
    const mix = { version: 2, allocatedServiceIds: ['a1', 'a2'] };
    const member = (id) => stop(id, '09:00:00', null, {
      visit_id: null, customer_id: 'cust-1', scheduled_date: '2026-11-20', estimated_duration_minutes: 30, service_address_line1: '1 Test St',
    });
    replan.loadDayStops.mockImplementation(async (_c, date) => (date === '2026-11-20' ? [member('a1'), member('a2')] : []));
    replan.loadBlocks.mockImplementation(async (_c, date) => (date === '2026-11-20' ? [{ startMin: 570, endMin: 600 }] : []));
    listOccupiedWindows.mockImplementation(async ({ dateFrom }) => (dateFrom === '2026-11-20'
      ? ['a1', 'a2'].map((id) => ({ ...member(id), reservation_service_mix: mix, startMin: 540, endMin: 600 })) : []));
    const { conn, writes } = fakeConn();
    await runRouteCheck({ conn, now: NOW });
    // One stop: its 60 minutes move whole past the 9:30 block, done at 11:00 (not split around it, done at 10:30).
    expect(JSON.parse(writes[0][1].days).find((d) => d.date === '2026-11-20')).toMatchObject({ stops: 1, endMin: 660 });
    listOccupiedWindows.mockResolvedValue([]);
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

  test("one row per ET hour: a second run of an hour already recorded writes nothing and reports that hour's status", async () => {
    const taken = new Map();
    const first = fakeConn({ taken });
    expect((await runRouteCheck({ conn: first.conn, now: NOW })).status).toBe('completed');
    // A second instance's run of the same 10:30 tick, after the first released the lock (a slot wait, at most 10 min).
    const second = fakeConn({ taken });
    const result = await runRouteCheck({ conn: second.conn, now: new Date('2026-11-19T15:39:00Z') });
    expect(result).toMatchObject({ status: 'completed', duplicate: true });
    expect(second.writes).toHaveLength(0);
    // The next hour records its own row.
    const next = fakeConn({ taken });
    expect((await runRouteCheck({ conn: next.conn, now: new Date('2026-11-19T16:30:00Z') })).status).toBe('completed');
    expect(next.writes[0][1]).toMatchObject({ service_date: '2026-11-19', run_hour: 11 });
  });

  test('a failed hour stays failed: a second run of it reports the recorded failure, never a success', async () => {
    const taken = new Map();
    getBlackoutDates.mockRejectedValueOnce(new Error('timeout'));
    const first = fakeConn({ taken });
    expect((await runRouteCheck({ conn: first.conn, now: NOW })).status).toBe('failed');
    const second = fakeConn({ taken });
    expect(await runRouteCheck({ conn: second.conn, now: new Date('2026-11-19T15:39:00Z') }))
      .toMatchObject({ status: 'failed', duplicate: true });
    expect(second.writes).toHaveLength(0);
  });

  test('an unread campaign list is an error of the run, with its message; an empty list is a completed run', async () => {
    const unread = fakeConn({ campaigns: new Error('timeout') });
    expect((await runRouteCheck({ conn: unread.conn, now: NOW })).status).toBe('completed_with_errors');
    expect(unread.writes[0][1].status).toBe('completed_with_errors');
    expect(JSON.parse(unread.writes[0][1].ad_shadow)).toEqual({ live: null, error: 'timeout', decision: FLOOR });
    const none = fakeConn({ campaigns: [] });
    expect((await runRouteCheck({ conn: none.conn, now: NOW })).status).toBe('completed');
    expect(JSON.parse(none.writes[0][1].ad_shadow)).toEqual({ live: [], decision: FLOOR });
  });

  test('a run-wide read failing still writes the hour, as failed with its error', async () => {
    getBlackoutDates.mockRejectedValueOnce(new Error('timeout'));
    const { conn, writes } = fakeConn();
    const result = await runRouteCheck({ conn, now: NOW });
    expect(result).toMatchObject({ status: 'failed', totals: { error: 'timeout' } });
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toMatchObject({ status: 'failed', service_date: '2026-11-19' });
    expect(JSON.parse(writes[0][1].totals)).toEqual({ error: 'timeout' });
    // No staffed days were found, so the booking engine is not asked.
    expect(JSON.parse(writes[0][1].ad_shadow)).toEqual({});
    expect(freeSlotsAt).not.toHaveBeenCalled();
  });

  test('slot rule (A3): a slot the booking engine gives any zone on a next staffed day makes the decision full', async () => {
    freeSlotsAt.mockImplementation(async (_c, { where, day }) => (where.lat === 27.1 && day === '2026-11-21'
      ? [{ date: day, start_time: '14:00', end_time: '15:00' }, { date: day, start_time: '10:00', end_time: '11:00' }] : []));
    const { conn, writes, reads } = fakeConn();
    const result = await runRouteCheck({ conn, now: NOW });
    expect(JSON.parse(writes[0][1].ad_shadow).decision).toEqual({
      ...FLOOR,
      mode: 'full',
      zones: [FLOOR.zones[0], { zone: 'South', byDate: { '2026-11-20': 0, '2026-11-21': 2, '2026-11-23': 0 }, first: '2026-11-21 10:00' }],
    });
    // The stated job is read from the catalog by its key. Each zone's center is asked about on each next staffed day,
    // on the run's own connection, with the catalog's name and length.
    expect(reads).toEqual([['services', { service_key: 'pest_general_quarterly' }]]);
    expect(freeSlotsAt.mock.calls.map(([c, ask]) => [c === conn, ask.where, ask.day, ask.identity])).toEqual(
      ZONES.flatMap((z) => FLOOR.dates.map((day) => [true, { lat: z.center_lat, lng: z.center_lng }, day, { name: JOB.name, minutes: 60 }])),
    );
    expect(result.status).toBe('completed');
  });

  test('slot rule (A3): a failed ask is an error of the run; with no slot anywhere the decision is unknown, not floor', async () => {
    freeSlotsAt.mockImplementation(async (_c, { where, day }) => {
      if (where.lat === 27.5 && day === '2026-11-21') throw new Error('booking_config_unknown');
      return [];
    });
    const none = fakeConn();
    expect((await runRouteCheck({ conn: none.conn, now: NOW })).status).toBe('completed_with_errors');
    const decision = JSON.parse(none.writes[0][1].ad_shadow).decision;
    expect(decision.mode).toBe('unknown');
    expect(decision.zones).toEqual([
      { zone: 'North', byDate: { '2026-11-20': 0, '2026-11-21': null, '2026-11-23': 0 }, first: null, error: 'booking_config_unknown' },
      FLOOR.zones[1],
    ]);
    // Any slot is full, so a slot in another zone still decides it; the failed ask still marks the run.
    freeSlotsAt.mockImplementation(async (_c, { where, day }) => {
      if (where.lat === 27.5) throw new Error('timeout');
      return day === '2026-11-23' ? [{ date: day, start_time: '09:00', end_time: '10:00' }] : [];
    });
    const some = fakeConn();
    expect((await runRouteCheck({ conn: some.conn, now: NOW })).status).toBe('completed_with_errors');
    expect(JSON.parse(some.writes[0][1].ad_shadow).decision).toMatchObject({
      mode: 'full', zones: [{ zone: 'North', error: 'timeout' }, { zone: 'South', first: '2026-11-23 09:00' }],
    });
  });

  test('slot rule (A3): no active stated job, or no zone with a pin, asks nothing; the decision is unknown', async () => {
    const cases = [
      [{ job: null }, 'job_unresolved'],
      [{ job: { ...JOB, is_active: false } }, 'job_unresolved'],
      // A blank coordinate is no pin: Number(null) is 0.
      [{ zones: [{ zone_name: 'Blank', center_lat: null, center_lng: null }, { zone_name: 'Zero', center_lat: 0, center_lng: -82.5 }] }, 'no_zones'],
    ];
    for (const [inputs, reason] of cases) {
      freeSlotsAt.mockClear();
      const { conn, writes } = fakeConn(inputs);
      expect((await runRouteCheck({ conn, now: NOW })).status).toBe('completed_with_errors');
      expect(JSON.parse(writes[0][1].ad_shadow).decision).toEqual({ mode: 'unknown', reason, dates: FLOOR.dates });
      expect(freeSlotsAt).not.toHaveBeenCalled();
    }
    // A read that throws is unknown too, with its message, and the row is still written.
    const unread = fakeConn({ zones: new Error('timeout') });
    expect((await runRouteCheck({ conn: unread.conn, now: NOW })).status).toBe('completed_with_errors');
    expect(JSON.parse(unread.writes[0][1].ad_shadow).decision).toEqual({ mode: 'unknown', error: 'timeout' });
  });

  test('slot rule (A3): a slot counts only when the customer window admits its start', async () => {
    const slot = (start, end) => ({ date: '2026-11-20', start_time: start, end_time: end });
    const decide = async (slots) => {
      freeSlotsAt.mockImplementation(async (_c, { day }) => (day === '2026-11-20' ? slots : []));
      const { conn } = fakeConn();
      return rc.decideSlotRule(conn, FLOOR.dates);
    };
    const before = process.env.GATE_CUSTOMER_LAST_START_16;
    process.env.GATE_CUSTOMER_LAST_START_16 = 'true';
    try {
      // 8:00 is before the customer grid, 17:00 is past the last customer start, 9:30 is off the hour.
      expect((await decide([slot('08:00', '09:00'), slot('17:00', '18:00'), slot('09:30', '10:30')])).mode).toBe('floor');
      const full = await decide([slot('17:00', '18:00'), slot('16:00', '17:00')]);
      expect(full).toMatchObject({ mode: 'full' });
      expect(full.zones[0]).toEqual({ zone: 'North', byDate: { '2026-11-20': 1, '2026-11-21': 0, '2026-11-23': 0 }, first: '2026-11-20 16:00' });
    } finally {
      if (before === undefined) delete process.env.GATE_CUSTOMER_LAST_START_16;
      else process.env.GATE_CUSTOMER_LAST_START_16 = before;
    }
  });

  test('slot rule (A3): with no staffed day ahead nothing can be booked: the floor, with no ask', async () => {
    const { conn } = fakeConn();
    expect(await rc.decideSlotRule(conn, [])).toEqual({ mode: 'floor', reason: 'no_staffed_days', dates: [] });
    expect(freeSlotsAt).not.toHaveBeenCalled();
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
    const snap = (table) => ({ ...conn(table), insert: () => { throw new Error('written inside the snapshot'); } });
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
