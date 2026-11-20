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
jest.mock('../services/scheduling/occupancy', () => ({
  techScopedConfirmActive: jest.fn(() => false),
  listOccupiedWindows: jest.fn(async () => []),
  // The office's occupancy guard compares hours with it (rain-out conflictsForTarget).
  windowsOverlap: jest.requireActual('../services/scheduling/occupancy').windowsOverlap,
}));
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
// The finder that offers a lead its times (routes/booking.js availabilityForPin); its own suites cover how it builds.
jest.mock('../routes/booking', () => ({ _internals: { availabilityForPin: jest.fn(async () => ({ days: [] })) } }));
// The finder the office books a same-day caller with (scheduling/find-time.js findAvailableSlots), asked about today.
jest.mock('../services/scheduling/find-time', () => ({
  ...jest.requireActual('../services/scheduling/find-time'),
  findAvailableSlots: jest.fn(async () => ({ slots: [], rejections_by_date: {} })),
}));
// The rest of the office list's chain for today: its capability rule, and its occupancy guard's snapshot
// (find-time-hints guardHintStarts, which runs as is).
jest.mock('../services/technician-capabilities', () => ({
  ...jest.requireActual('../services/technician-capabilities'),
  inactiveCapabilitiesForServices: jest.fn(async () => []),
}));
jest.mock('../services/rain-out', () => ({
  ...jest.requireActual('../services/rain-out'),
  loadOccupancy: jest.fn(),
}));

const db = require('../models/db');
const { _internals: replan } = require('../services/day-replan/index');
const { _internals: { availabilityForPin } } = require('../routes/booking');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { inactiveCapabilitiesForServices } = require('../services/technician-capabilities');
const { loadOccupancy } = require('../services/rain-out');
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

  // The decision asks the live finder only on the wall clock's ET day (decideSlotRule), so the wall clock reads NOW.
  // Only Date is faked: timers and promises run as usual.
  beforeEach(() => jest.useFakeTimers({
    now: NOW,
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
      'setTimeout', 'clearTimeout'],
  }));
  afterEach(() => jest.useRealTimers());
  // New Appointment's open-times box is shown (production, 11-20), so today's list is there to count.
  const BOX_GATES = ['GATE_BEST_TIME_HINTS', 'GATE_OPEN_TIMES_BOX'];
  const savedBoxGates = BOX_GATES.map((name) => process.env[name]);
  beforeEach(() => { for (const name of BOX_GATES) process.env[name] = 'true'; });
  afterEach(() => BOX_GATES.forEach((name, i) => {
    if (savedBoxGates[i] === undefined) delete process.env[name]; else process.env[name] = savedBoxGates[i];
  }));

  // The slot rule's input: the service zones' centers (synthetic pins).
  const ZONES = [
    { zone_name: 'North', center_lat: 27.5, center_lng: -82.57 },
    { zone_name: 'South', center_lat: 27.1, center_lng: -82.45 },
  ];
  // The decision when every zone answers with no slot: today (10:30 AM, from the office's finder) and the next 3 staffed
  // days (from /book).
  const FLOOR = {
    mode: 'floor', service: 'pest_control',
    dates: ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-23'],
    sameDay: { date: '2026-11-19', travel: 'modeled' },
    zones: ['North', 'South'].map((zone) => ({
      zone, byDate: { '2026-11-19': 0, '2026-11-20': 0, '2026-11-21': 0, '2026-11-23': 0 }, first: null,
    })),
  };

  // `campaigns` an Error: the campaign read throws. `taken`: the unique key's rows (key -> row), shared across runs.
  // `zones`: the zone rows the decision reads (an Error throws). `techs`: the assignable technicians' ids.
  function fakeConn({
    campaigns = [{ id: 'c1', status: 'paused', budget_mode: 'stop' }], taken = new Map(), zones = ZONES, techs = [TECH], done = [],
  } = {}) {
    const writes = [];
    const conflicts = [];
    const doneReads = [];
    const handle = (table) => {
      let filter = {};
      const q = {
        leftJoin() { return q; }, whereIn() { return q; }, whereNotIn() { return q; }, whereRaw() { return q; },
        where(arg) { if (arg && typeof arg === 'object') filter = arg; return q; },
        first: async () => taken.get(`${filter.service_date}|${filter.run_hour}`),
        select: async () => {
          if (table === 'technicians') return techs.map((id) => ({ id }));
          if (table === 'ad_campaigns') {
            if (campaigns instanceof Error) throw campaigns;
            return campaigns;
          }
          if (table === 'service_zones') {
            if (zones instanceof Error) throw zones;
            return zones;
          }
          if (table === 'scheduled_services') {
            doneReads.push(filter);
            if (done instanceof Error) throw done;
            return done;
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
    // The fake is the shared handle itself (models/db): the run reads no other, and neither does the finder.
    db.mockImplementation(handle);
    db.raw = (sql) => sql;
    delete db.transaction;
    return { conn: db, writes, conflicts, doneReads };
  }

  beforeEach(() => {
    availabilityForPin.mockReset();
    availabilityForPin.mockImplementation(async () => ({ days: [] }));
    findAvailableSlots.mockReset();
    findAvailableSlots.mockImplementation(async () => ({ slots: [], rejections_by_date: {} }));
    inactiveCapabilitiesForServices.mockReset();
    inactiveCapabilitiesForServices.mockImplementation(async () => []);
    loadOccupancy.mockReset();
    loadOccupancy.mockImplementation(async () => ({ rows: [], canName: () => false, nameById: new Map() }));
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
    const result = await runRouteCheck({ now: NOW });
    expect(writes.map(([table]) => table)).toEqual(['route_check_runs']);
    const row = writes[0][1];
    expect(row).toMatchObject({ run_at: NOW, service_date: '2026-11-19', run_hour: 10, status: 'completed' });
    expect(conflicts).toEqual([['service_date', 'run_hour']]);
    const days = JSON.parse(row.days);
    // Today is not measured: its room depends on where the van is now (the decision asks the office's finder instead).
    expect(days.map((d) => d.date)).toEqual(['2026-11-20', '2026-11-21', '2026-11-23', '2026-11-24', '2026-11-25']);
    expect(days[0]).toMatchObject({ stops: 1, slots: expect.any(Number) });
    expect(days[0].openings.length).toBeGreaterThan(0);
    const totals = JSON.parse(row.totals);
    expect(totals.next.dates).toEqual(['2026-11-20', '2026-11-21', '2026-11-23']);
    expect(totals.today).toBeUndefined();
    // The live rule's campaigns, to compare with, and the slot rule's decision from the offer finder (no slot here).
    expect(JSON.parse(row.ad_shadow)).toEqual({ live: [{ id: 'c1', status: 'paused', mode: 'stop' }], decision: FLOOR });
    // Only the measured dates and the Sundays are read: never today, never the whole 14-day scan.
    expect(replan.loadDayStops.mock.calls.map(([, d]) => d)).toEqual(['2026-11-22', '2026-11-29', '2026-11-20', '2026-11-21', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26']);
    expect(listOccupiedWindows).toHaveBeenCalledWith(expect.objectContaining({ db: conn, dateFrom: '2026-11-20', dateTo: '2026-11-20' }));
    expect(totals.next).toMatchObject({ slots: expect.any(Number), unmeasured: [] });
    expect(result).toMatchObject({ status: 'completed', days: 5 });
  });

  test('a Sunday counts when the technician has a stop booked that day', async () => {
    replan.loadDayStops.mockImplementation(async (_c, date) => (date === '2026-11-22' ? [stop('s1', '10:00:00', '11:00:00')] : []));
    const { writes } = fakeConn();
    await runRouteCheck({ now: NOW });
    expect(JSON.parse(writes[0][1].days).find((d) => d.date === '2026-11-22')).toMatchObject({ stops: 1, staffed: true });
  });

  test("a placeholder dispatch drops (no window start, no time window) is no stop and staffs no Sunday (round 39)", async () => {
    const placeholder = (date) => stop('p1', null, null, { status: 'pending', scheduled_date: date });
    replan.loadDayStops.mockImplementation(async (_c, date) => {
      if (date === '2026-11-20') return [stop('f1', '09:00:00', '10:00:00'), placeholder(date)];
      if (date === '2026-11-22') return [placeholder(date)];
      return [];
    });
    const { writes } = fakeConn();
    await runRouteCheck({ now: NOW });
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
      const { writes } = fakeConn();
      await runRouteCheck({ now: NOW });
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
    const { writes } = fakeConn();
    const result = await runRouteCheck({ now: NOW });
    expect(result.status).toBe('completed_with_errors');
    const days = JSON.parse(writes[0][1].days);
    expect(days.find((d) => d.date === '2026-11-20')).toMatchObject({ skip: 'FAILED' });
    replan.loadBlocks.mockResolvedValue([]);
  });

  test("the check reads every visit staff have booked and every block, as dispatch's commit-time checks do (rounds 33, 34)", async () => {
    replan.loadDayStops.mockImplementation(async (_c, date) => (date === '2026-11-20' ? [stop('s1', '10:00:00', null)] : []));
    fakeConn();
    await runRouteCheck({ now: NOW });
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
      const { writes } = fakeConn();
      await runRouteCheck({ now: NOW });
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
    const { writes } = fakeConn();
    await runRouteCheck({ now: NOW });
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
    const { writes } = fakeConn();
    await runRouteCheck({ now: NOW });
    listOccupiedWindows.mockResolvedValue([]);
    const friday = JSON.parse(writes[0][1].days).find((d) => d.date === '2026-11-20');
    expect(friday.openings.map((o) => [o.start, o.min])).toEqual([[660, 360]]); // 8-9 is under a job slot; 9-11 is held
  });

  test("a failed stops read (a Sunday's or a date's) marks that date and the row is still written", async () => {
    replan.loadDayStops.mockImplementation(async (_c, date) => {
      if (date === '2026-11-22' || date === '2026-11-20') throw new Error('timeout');
      return [];
    });
    const { writes } = fakeConn();
    const result = await runRouteCheck({ now: NOW });
    expect(result.status).toBe('completed_with_errors');
    const days = JSON.parse(writes[0][1].days);
    expect(days.find((d) => d.date === '2026-11-20')).toMatchObject({ skip: 'FAILED' });
    expect(days.find((d) => d.date === '2026-11-22')).toMatchObject({ skip: 'FAILED' }); // staffed when unknown
  });

  test("one row per ET hour: a second run of an hour already recorded writes nothing and reports that hour's status", async () => {
    const taken = new Map();
    fakeConn({ taken });
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed');
    // A second instance's run of the same 10:30 tick, after the first released the lock (a slot wait, at most 10 min).
    const second = fakeConn({ taken });
    const result = await runRouteCheck({ now: new Date('2026-11-19T15:39:00Z') });
    expect(result).toMatchObject({ status: 'completed', duplicate: true });
    expect(second.writes).toHaveLength(0);
    // The next hour records its own row.
    const next = fakeConn({ taken });
    expect((await runRouteCheck({ now: new Date('2026-11-19T16:30:00Z') })).status).toBe('completed');
    expect(next.writes[0][1]).toMatchObject({ service_date: '2026-11-19', run_hour: 11 });
  });

  test('a failed hour stays failed: a second run of it reports the recorded failure, never a success', async () => {
    const taken = new Map();
    getBlackoutDates.mockRejectedValueOnce(new Error('timeout'));
    fakeConn({ taken });
    expect((await runRouteCheck({ now: NOW })).status).toBe('failed');
    const second = fakeConn({ taken });
    expect(await runRouteCheck({ now: new Date('2026-11-19T15:39:00Z') }))
      .toMatchObject({ status: 'failed', duplicate: true });
    expect(second.writes).toHaveLength(0);
  });

  test('an unread campaign list is an error of the run, with its message; an empty list is a completed run', async () => {
    const unread = fakeConn({ campaigns: new Error('timeout') });
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed_with_errors');
    expect(unread.writes[0][1].status).toBe('completed_with_errors');
    expect(JSON.parse(unread.writes[0][1].ad_shadow)).toEqual({ live: null, error: 'timeout', decision: FLOOR });
    const none = fakeConn({ campaigns: [] });
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed');
    expect(JSON.parse(none.writes[0][1].ad_shadow)).toEqual({ live: [], decision: FLOOR });
  });

  test('a run-wide read failing still writes the hour, as failed with its error', async () => {
    getBlackoutDates.mockRejectedValueOnce(new Error('timeout'));
    const { writes } = fakeConn();
    const result = await runRouteCheck({ now: NOW });
    expect(result).toMatchObject({ status: 'failed', totals: { error: 'timeout' } });
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toMatchObject({ status: 'failed', service_date: '2026-11-19' });
    expect(JSON.parse(writes[0][1].totals)).toEqual({ error: 'timeout' });
    // No staffed days were found, so neither finder is asked.
    expect(JSON.parse(writes[0][1].ad_shadow)).toEqual({});
    expect(availabilityForPin).not.toHaveBeenCalled();
    expect(findAvailableSlots).not.toHaveBeenCalled();
  });

  // An offer as availabilityForPin returns it: days[] with every offered start and its technician.
  const offerOn = (date, ...slots) => ({
    days: [{ date, slots: slots.map(([start_time, technician_id = TECH]) => ({ start_time, technician_id })) }],
  });

  test('slot rule (A3): a slot the offer finder gives any zone on a next staffed day makes the decision full', async () => {
    availabilityForPin.mockImplementation(async ({ lat }) => (lat === 27.1 ? offerOn('2026-11-21', ['14:00'], ['10:00']) : { days: [] }));
    const { writes } = fakeConn();
    const result = await runRouteCheck({ now: NOW });
    expect(JSON.parse(writes[0][1].ad_shadow).decision).toEqual({
      ...FLOOR,
      mode: 'full',
      zones: [FLOOR.zones[0], { zone: 'South', byDate: { ...FLOOR.zones[1].byDate, '2026-11-21': 2 }, first: '2026-11-21 10:00' }],
    });
    // Each zone's center is asked as a lead is offered times there (no staff-side `internal` read), buying nothing
    // (no road lookup, no forecast), searched through the last next staffed day, on the run's own clock, under the
    // probe's own label (the customer route check logs it apart from customer searches), taking no fallback list:
    // first with the run's crew; then, for North (no crew slot), /book's own pool. South's slot needs no second ask.
    const askAt = (z, extra = {}) => ({
      lat: z.center_lat, lng: z.center_lng, serviceKey: 'pest_control', paidLookups: false,
      through: '2026-11-23', now: NOW, surface: 'route_check', verifiedOnly: true, ...extra,
    });
    expect(availabilityForPin.mock.calls.map(([ask]) => ask)).toEqual([
      askAt(ZONES[0], { crew: expect.any(Map) }), askAt(ZONES[0]), askAt(ZONES[1], { crew: expect.any(Map) }),
    ]);
    // Hour mode: /book's own drive times are the same free model, so the answer carries no travel mark.
    expect(JSON.parse(writes[0][1].ad_shadow).decision.travel).toBeUndefined();
    expect(result.status).toBe('completed');
  });

  test('slot rule (A3): a zone with no answer is an error of the run; with no slot anywhere the decision is unknown', async () => {
    // A thrown read, and no offer at all (/book off, or no pin: availabilityForPin's null).
    for (const [north, error] of [[new Error('timeout'), 'timeout'], [null, 'no_offer']]) {
      availabilityForPin.mockImplementation(async ({ lat }) => {
        if (lat !== 27.5) return { days: [] };
        if (north instanceof Error) throw north;
        return north;
      });
      const none = fakeConn();
      expect((await runRouteCheck({ now: NOW })).status).toBe('completed_with_errors');
      expect(JSON.parse(none.writes[0][1].ad_shadow).decision).toEqual({
        // Today's answer (the office's finder) stands beside /book's failure.
        ...FLOOR, mode: 'unknown', zones: [{ zone: 'North', byDate: { '2026-11-19': 0 }, first: null, error }, FLOOR.zones[1]],
      });
    }
    // Any slot is full, so a slot in another zone still decides it; the zone with no answer still marks the run.
    availabilityForPin.mockImplementation(async ({ lat }) => (lat === 27.5 ? null : offerOn('2026-11-23', ['09:00'])));
    const some = fakeConn();
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed_with_errors');
    expect(JSON.parse(some.writes[0][1].ad_shadow).decision).toMatchObject({
      mode: 'full', zones: [{ zone: 'North', error: 'no_offer' }, { zone: 'South', first: '2026-11-23 09:00' }],
    });
  });

  test("slot rule (A3): with no crew slot, /book's own pool says whether the zero is an answer (its whole-week floor), and its crew starts count", async () => {
    // /book's own pool answers too: its check kept no whole week, so the crew's zero is the zone's answer.
    const zero = fakeConn();
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed');
    expect(JSON.parse(zero.writes[0][1].ad_shadow).decision).toEqual(FLOOR);
    expect(availabilityForPin.mock.calls.map(([ask]) => [ask.lat, ask.crew instanceof Map])).toEqual([
      [27.5, true], [27.5, false], [27.1, true], [27.1, false],
    ]);
    // /book's check would keep its whole week (every slot in it makes a customer late, and /book shows them): that ask
    // throws (routes/booking.js verifiedOnly), so the zone has no answer and the decision is unknown, never floor.
    availabilityForPin.mockImplementation(async ({ crew }) => {
      if (!crew) throw new Error('route check: floor_kept');
      return { days: [] };
    });
    const kept = fakeConn();
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed_with_errors');
    expect(JSON.parse(kept.writes[0][1].ad_shadow).decision).toEqual({
      ...FLOOR, mode: 'unknown', zones: FLOOR.zones.map((z) => ({ ...z, error: 'route check: floor_kept' })),
    });
    // A crew start /book's own pool offers counts (it opened between the two reads); another technician's does not.
    const OTHER = '00000000-0000-4000-8000-000000000002';
    availabilityForPin.mockImplementation(async ({ crew, lat }) => (
      crew || lat !== 27.5 ? { days: [] } : offerOn('2026-11-21', ['11:00'], ['09:00', OTHER])));
    const opened = fakeConn();
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed');
    expect(JSON.parse(opened.writes[0][1].ad_shadow).decision).toEqual({
      ...FLOOR,
      mode: 'full',
      zones: [{ ...FLOOR.zones[0], byDate: { ...FLOOR.zones[0].byDate, '2026-11-21': 1 }, first: '2026-11-21 11:00' }, FLOOR.zones[1]],
    });
  });

  test('slot rule (A3): a zone with no pin is asked as it is and answers nothing; no zone row at all is unknown', async () => {
    // availabilityForPin applies its own pin rule (a blank coordinate is no pin: null); the zone is never left out.
    availabilityForPin.mockImplementation(async ({ lat }) => (lat == null ? null : offerOn('2026-11-20', ['09:00'])));
    // The zones are asked in name order, whatever order the table returns them in.
    const blank = fakeConn({ zones: [...ZONES, { zone_name: 'Blank', center_lat: null, center_lng: null }] });
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed_with_errors');
    const decision = JSON.parse(blank.writes[0][1].ad_shadow).decision;
    expect(decision).toMatchObject({ mode: 'full', zones: [{ zone: 'Blank', error: 'no_offer' }, { zone: 'North' }, { zone: 'South' }] });
    expect(availabilityForPin.mock.calls[0][0]).toMatchObject({ lat: null, lng: null });
    availabilityForPin.mockClear();
    const empty = fakeConn({ zones: [] });
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed_with_errors');
    expect(JSON.parse(empty.writes[0][1].ad_shadow).decision).toEqual({ mode: 'unknown', reason: 'no_zones', dates: FLOOR.dates });
    expect(availabilityForPin).not.toHaveBeenCalled();
    // A read that throws is unknown too, with its message, and the row is still written.
    const unread = fakeConn({ zones: new Error('timeout') });
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed_with_errors');
    expect(JSON.parse(unread.writes[0][1].ad_shadow).decision).toEqual({ mode: 'unknown', error: 'timeout' });
  });

  test("slot rule (A3): the finder gets the run's crew per date: a Sunday only for a technician with a stop booked", async () => {
    const OTHER = '00000000-0000-4000-8000-000000000002';
    replan.loadDayStops.mockImplementation(async (_c, date) => (date === '2026-11-22' ? [stop('s1', '10:00:00', '11:00:00')] : []));
    fakeConn({ techs: [TECH, OTHER] });
    await runRouteCheck({ now: NOW });
    const { crew, through } = availabilityForPin.mock.calls[0][0];
    // TECH has the Sunday stop, so TECH alone works it; both work the Friday.
    expect([...crew.get('2026-11-22')]).toEqual([TECH]);
    expect([...crew.get('2026-11-20')].sort()).toEqual([TECH, OTHER]);
    expect(through).toBe('2026-11-22');
    // With no stop booked, a Sunday is worked by nobody.
    replan.loadDayStops.mockImplementation(async () => []);
    availabilityForPin.mockClear();
    fakeConn({ techs: [TECH, OTHER] });
    await runRouteCheck({ now: NOW });
    expect(availabilityForPin.mock.calls[0][0].crew.get('2026-11-22').size).toBe(0);
  });

  test("slot rule (A3): under capacity routing the answer is the free drive model's, and says so", async () => {
    fakeConn();
    const crew = new Map([['2026-11-20', new Set([TECH])]]);
    availabilityForPin.mockImplementation(async () => offerOn('2026-11-20', ['09:00']));
    const before = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    try {
      expect(await rc.decideSlotRule({ now: NOW, dates: ['2026-11-20'], crew })).toMatchObject({ mode: 'full', travel: 'modeled' });
    } finally {
      if (before === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = before;
    }
    expect(await rc.decideSlotRule({ now: NOW, dates: ['2026-11-20'], crew })).not.toHaveProperty('travel');
  });

  test('slot rule (A3): a Sunday whose stops read failed has no known crew: its offers do not count, and alone it is unknown', async () => {
    // The totals count the Sunday (its room unknown, never left out), so it is one of the next 3 dates.
    replan.loadDayStops.mockImplementation(async (_c, date) => {
      if (date === '2026-11-22') throw new Error('timeout');
      return [];
    });
    availabilityForPin.mockImplementation(async () => offerOn('2026-11-22', ['09:00']));
    const sunday = fakeConn();
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed_with_errors');
    const unknown = JSON.parse(sunday.writes[0][1].ad_shadow).decision;
    expect(unknown).toMatchObject({ mode: 'unknown', dates: ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'] });
    expect(availabilityForPin.mock.calls[0][0].crew.get('2026-11-22')).toBeNull();
    expect(unknown.zones.map((z) => z.byDate))
      .toEqual(ZONES.map(() => ({ '2026-11-19': 0, '2026-11-20': 0, '2026-11-21': 0, '2026-11-22': null })));
    // A slot on a day with a known crew still decides it.
    availabilityForPin.mockImplementation(async () => ({
      days: [...offerOn('2026-11-21', ['10:00']).days, ...offerOn('2026-11-22', ['09:00']).days],
    }));
    const saturday = fakeConn();
    await runRouteCheck({ now: NOW });
    expect(JSON.parse(saturday.writes[0][1].ad_shadow).decision).toMatchObject({
      mode: 'full', zones: [{ byDate: { '2026-11-21': 1, '2026-11-22': null }, first: '2026-11-21 10:00' }, { first: '2026-11-21 10:00' }],
    });
  });

  test('slot rule (A3): with no staffed day ahead nothing can be booked: the floor, with no ask', async () => {
    fakeConn();
    expect(await rc.decideSlotRule({ now: NOW, dates: [], crew: new Map() })).toEqual({ mode: 'floor', reason: 'no_staffed_days', dates: [] });
    expect(availabilityForPin).not.toHaveBeenCalled();
  });

  test("slot rule (A3): the finder answers for the wall clock's day only: a run on another ET day gets no decision and asks nothing", async () => {
    availabilityForPin.mockImplementation(async () => offerOn('2026-11-20', ['09:00']));
    // The wall clock reads Thu 10:30 AM ET. A run clock on Wednesday (a replay clock), or at 11:59 PM Wednesday (a run
    // that crossed midnight), is another day: its dates and crew are not the finder's.
    for (const now of [new Date('2026-11-18T15:30:00Z'), new Date('2026-11-19T04:59:00Z')]) {
      availabilityForPin.mockClear();
      const { writes } = fakeConn();
      expect((await runRouteCheck({ now })).status).toBe('completed_with_errors');
      const decision = JSON.parse(writes[0][1].ad_shadow).decision;
      expect(decision).toEqual({ mode: 'unknown', reason: 'other_day', dates: JSON.parse(writes[0][1].totals).next.dates });
      expect(decision.dates[0]).toBe('2026-11-19');
      expect(availabilityForPin).not.toHaveBeenCalled();
      expect(findAvailableSlots).not.toHaveBeenCalled();
    }
    // A clock on the next day is another day too, even with a slot on offer.
    expect(await rc.decideSlotRule({ now: new Date('2026-11-20T15:30:00Z'), dates: ['2026-11-21'], crew: new Map() }))
      .toEqual({ mode: 'unknown', reason: 'other_day', dates: ['2026-11-21'] });
    expect(availabilityForPin).not.toHaveBeenCalled();
  });

  // The office's finder's answer for one technician-day: its open starts on that technician's route, and its refusals by
  // reason. A start with the van's modeled arrival there ([start, arrival]) is the arrival search's (production's,
  // GATE_ADMIN_ARRIVAL_WINDOWS); one without ([start]) is the legacy gap finder's, a gap that holds that start alone.
  const found = (slots, rejections = {}, technicianId = TECH) => ({
    slots: slots.map(([start_time, estimated_arrival]) => ({
      date: '2026-11-19', start_time, technician: { id: technicianId },
      ...(estimated_arrival ? { estimated_arrival, route_mode: 'arrival_windows' } : {}),
    })),
    rejections_by_date: { '2026-11-19': rejections },
  });
  const OFF_THE_SERVICE = (technician_id) => ({ technician_id, service_category: 'general', active: false });
  const OTHER_TECH = '00000000-0000-4000-8000-000000000002';

  test("slot rule, today (A2): the office's own finder answers for today, per technician of today's crew; a job must end by 6 PM", async () => {
    // North's center, TECH: 6 PM (done at 7), 5 PM reached at 5:20 and 4 PM reached at 5:05 (done after 6: a start is an
    // arrival window, and the van comes late in it), and 3 PM on time. The office could book all four; the rule counts
    // 3 PM. OTHER_TECH, asked after: 4 PM and 3 PM on time, and 2 PM. An hour counts once, on any technician whose van
    // makes it: 2, 3 and 4 PM.
    findAvailableSlots.mockImplementation(async ({ lat, technicianId }) => {
      if (lat !== 27.5) return found([]);
      return technicianId === TECH
        ? found([['18:00', '18:00'], ['17:00', '17:20'], ['16:00', '17:05'], ['15:00', '15:00']], {}, TECH)
        : found([['16:00', '16:00'], ['15:00', '15:05'], ['14:00', '14:00']], {}, OTHER_TECH);
    });
    const { writes } = fakeConn({ techs: [TECH, OTHER_TECH] });
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed');
    expect(JSON.parse(writes[0][1].ad_shadow).decision).toEqual({
      ...FLOOR,
      mode: 'full',
      zones: [{ zone: 'North', byDate: { ...FLOOR.zones[0].byDate, '2026-11-19': 3 }, first: '2026-11-19 14:00' }, FLOOR.zones[1]],
    });
    // Asked as New Appointment's open-times box asks: a new stop at the pin, today only, each technician of today's crew
    // alone, from the start point, every weekday, the day continuing from the stop under way, and no road purchase.
    const askAt = (z, technicianId) => ({
      lat: z.center_lat, lng: z.center_lng, durationMinutes: 60, serviceKey: 'pest_control',
      dateFrom: '2026-11-19', dateTo: '2026-11-19', technicianId, techStartPoints: true, includeWeekends: true,
      includeBlackoutDates: true, topN: Number.POSITIVE_INFINITY, providerTravel: false, fromActiveStop: true,
      slotStepMinutes: 60, arrivalWindow: { prospective: { lat: z.center_lat, lng: z.center_lng, estimated_duration_minutes: 60 } },
    });
    expect(findAvailableSlots.mock.calls.map(([ask]) => ask)).toEqual([
      askAt(ZONES[0], TECH), askAt(ZONES[0], OTHER_TECH), askAt(ZONES[1], TECH), askAt(ZONES[1], OTHER_TECH),
    ]);
    // The list's technicians: the capability rule by the service's name, as the office's list reads it, at each zone.
    expect(inactiveCapabilitiesForServices.mock.calls).toEqual([
      [db, [TECH, OTHER_TECH], [{ service_type: 'pest_control' }]], [db, [TECH, OTHER_TECH], [{ service_type: 'pest_control' }]],
    ]);
    // Arrival-search starts were checked by their own simulation: the guard reads no snapshot for them.
    expect(loadOccupancy).not.toHaveBeenCalled();
    // North's slot today needs no second /book ask; South, with none, still asks /book's own pool.
    expect(availabilityForPin.mock.calls.map(([ask]) => [ask.lat, ask.crew instanceof Map])).toEqual([[27.5, true], [27.1, true], [27.1, false]]);
  });

  test("slot rule, today (A2): a route the office's finder cannot verify gives today no answer, unless another technician has a start", async () => {
    // TECH's route cannot be verified (two stops under way, say): the finder offers nothing on it, so TECH's zero is no
    // answer. OTHER_TECH's route is verified and simply has no room.
    const cannot = found([], { route_unverified: 8 });
    findAvailableSlots.mockImplementation(async ({ technicianId }) => (technicianId === TECH ? cannot : found([], { arrival_window: 8 })));
    const none = fakeConn({ techs: [TECH, OTHER_TECH] });
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed_with_errors');
    const unknown = JSON.parse(none.writes[0][1].ad_shadow).decision;
    expect(unknown.mode).toBe('unknown');
    expect(unknown.zones.map((z) => z.byDate['2026-11-19'])).toEqual([null, null]);
    // Another technician's start answers for today (here in the legacy finder's shape: a start with no modeled arrival is
    // its own arrival).
    findAvailableSlots.mockImplementation(async ({ technicianId }) => (technicianId === TECH ? cannot : found([['15:00']], {}, technicianId)));
    const other = fakeConn({ techs: [TECH, OTHER_TECH] });
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed');
    expect(JSON.parse(other.writes[0][1].ad_shadow).decision).toMatchObject({
      mode: 'full', zones: [{ byDate: { '2026-11-19': 1 }, first: '2026-11-19 15:00' }, { first: '2026-11-19 15:00' }],
    });
  });

  test('slot rule, today (A2): today counts only while a job can still end by 6 PM, and only when someone works it', async () => {
    // The office's earliest same-day start is 30 minutes out, on the hour: at 4:30 PM that is 5 PM (done at 6). The
    // finder reads the wall clock, so the window does too: a 4:29 PM run deciding at 4:31 PM no longer counts today.
    for (const [run, wall, counted] of [
      ['2026-11-19T21:30:00Z', '2026-11-19T21:30:00Z', true],
      ['2026-11-19T21:31:00Z', '2026-11-19T21:31:00Z', false],
      ['2026-11-19T21:29:00Z', '2026-11-19T21:31:00Z', false],
    ]) {
      jest.setSystemTime(new Date(wall));
      findAvailableSlots.mockClear();
      const { writes } = fakeConn();
      await runRouteCheck({ now: new Date(run) });
      const decision = JSON.parse(writes[0][1].ad_shadow).decision;
      expect([run, wall, decision.dates[0], decision.sameDay?.date, findAvailableSlots.mock.calls.length])
        .toEqual([run, wall, counted ? '2026-11-19' : '2026-11-20', counted ? '2026-11-19' : undefined, counted ? 2 : 0]);
    }
    jest.setSystemTime(NOW);
    // Nobody works today (TECH is off): nothing to ask, and today is not a date of the decision.
    absentTechDays.mockResolvedValue(new Set([`${TECH}:2026-11-19`]));
    findAvailableSlots.mockClear();
    const off = fakeConn();
    await runRouteCheck({ now: NOW });
    expect(JSON.parse(off.writes[0][1].ad_shadow).decision).toMatchObject({ mode: 'floor', dates: ['2026-11-20', '2026-11-21', '2026-11-23'] });
    expect(findAvailableSlots).not.toHaveBeenCalled();
  });

  test('slot rule, today (A2): a Sunday counts today only for a technician with a stop booked; an unread Sunday has no known crew', async () => {
    const SUNDAY = new Date('2026-11-22T15:30:00Z'); // Sun 10:30 AM ET
    jest.setSystemTime(SUNDAY);
    try {
      replan.loadDayStops.mockImplementation(async (_c, date) => (date === '2026-11-22' ? [stop('s1', '13:00:00', '14:00:00')] : []));
      const booked = fakeConn();
      await runRouteCheck({ now: SUNDAY });
      expect(JSON.parse(booked.writes[0][1].ad_shadow).decision.dates[0]).toBe('2026-11-22');
      expect(findAvailableSlots.mock.calls.map(([ask]) => [ask.dateFrom, ask.technicianId])).toEqual([['2026-11-22', TECH], ['2026-11-22', TECH]]);
      // No stop today: nobody works it.
      replan.loadDayStops.mockImplementation(async () => []);
      findAvailableSlots.mockClear();
      const free = fakeConn();
      await runRouteCheck({ now: SUNDAY });
      expect(JSON.parse(free.writes[0][1].ad_shadow).decision.dates).not.toContain('2026-11-22');
      expect(findAvailableSlots).not.toHaveBeenCalled();
      expect(free.doneReads).toEqual([{ scheduled_date: '2026-11-22', status: 'completed' }]);
      // Today's only stop is done (the day's stops read leaves completed visits out): TECH still works today.
      const finished = fakeConn({ done: [{ technician_id: TECH, customer_id: 'c1', reservation_expires_at: null, status: 'completed' }] });
      await runRouteCheck({ now: SUNDAY });
      expect(JSON.parse(finished.writes[0][1].ad_shadow).decision.dates[0]).toBe('2026-11-22');
      expect(findAvailableSlots.mock.calls.map(([ask]) => [ask.dateFrom, ask.technicianId])).toEqual([['2026-11-22', TECH], ['2026-11-22', TECH]]);
      // That read failing: who works today is unknown, so today has no answer, and nothing is asked.
      findAvailableSlots.mockClear();
      const doneUnread = fakeConn({ done: new Error('timeout') });
      expect((await runRouteCheck({ now: SUNDAY })).status).toBe('completed_with_errors');
      const unknownCrew = JSON.parse(doneUnread.writes[0][1].ad_shadow).decision;
      expect(unknownCrew).toMatchObject({ mode: 'unknown', sameDay: { date: '2026-11-22' } });
      expect(unknownCrew.zones.map((z) => [z.byDate['2026-11-22'], z.error])).toEqual([[null, undefined], [null, undefined]]);
      expect(findAvailableSlots).not.toHaveBeenCalled();
      // Today's stops unread: who works it is unknown, so today has no answer, and nothing is asked.
      replan.loadDayStops.mockImplementation(async (_c, date) => {
        if (date === '2026-11-22') throw new Error('timeout');
        return [];
      });
      const unread = fakeConn();
      expect((await runRouteCheck({ now: SUNDAY })).status).toBe('completed_with_errors');
      expect(unread.doneReads).toEqual([]);
      const decision = JSON.parse(unread.writes[0][1].ad_shadow).decision;
      expect(decision).toMatchObject({ mode: 'unknown', sameDay: { date: '2026-11-22' } });
      expect(decision.zones.map((z) => [z.byDate['2026-11-22'], z.error])).toEqual([[null, undefined], [null, undefined]]);
      expect(findAvailableSlots).not.toHaveBeenCalled();
    } finally {
      jest.setSystemTime(NOW);
      replan.loadDayStops.mockResolvedValue([]);
    }
  });

  test("slot rule, today (A2): today's finder failing is the zone's error, and /book's answer still stands", async () => {
    findAvailableSlots.mockRejectedValue(new Error('timeout'));
    availabilityForPin.mockImplementation(async ({ lat }) => (lat === 27.1 ? offerOn('2026-11-21', ['10:00']) : { days: [] }));
    const some = fakeConn();
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed_with_errors');
    expect(JSON.parse(some.writes[0][1].ad_shadow).decision).toMatchObject({
      mode: 'full',
      zones: [
        { zone: 'North', byDate: { '2026-11-19': null, '2026-11-20': 0, '2026-11-21': 0, '2026-11-23': 0 }, first: null, error: 'timeout' },
        { zone: 'South', first: '2026-11-21 10:00', error: 'timeout' },
      ],
    });
    // The finder's own refusal (no pin: { error }) is a failure too; with no slot anywhere the decision is unknown.
    findAvailableSlots.mockResolvedValue({ error: 'lat/lng required', slots: [] });
    availabilityForPin.mockImplementation(async () => ({ days: [] }));
    const none = fakeConn();
    await runRouteCheck({ now: NOW });
    expect(JSON.parse(none.writes[0][1].ad_shadow).decision).toMatchObject({
      mode: 'unknown', zones: [{ error: 'lat/lng required' }, { error: 'lat/lng required' }],
    });
  });

  test("slot rule, today (A2): a technician who cannot do the service is not asked, as the office's list never lists one", async () => {
    inactiveCapabilitiesForServices.mockImplementation(async () => [OFF_THE_SERVICE(TECH)]);
    findAvailableSlots.mockImplementation(async ({ technicianId }) => found([['15:00', '15:00']], {}, technicianId));
    const { writes } = fakeConn({ techs: [TECH, OTHER_TECH] });
    await runRouteCheck({ now: NOW });
    expect(findAvailableSlots.mock.calls.map(([ask]) => ask.technicianId)).toEqual([OTHER_TECH, OTHER_TECH]);
    expect(JSON.parse(writes[0][1].ad_shadow).decision.zones.map((z) => z.byDate['2026-11-19'])).toEqual([1, 1]);
    // Nobody left who can: no ask, and today's zero is an answer (the office's list is empty).
    inactiveCapabilitiesForServices.mockImplementation(async (_db, ids) => ids.map(OFF_THE_SERVICE));
    findAvailableSlots.mockClear();
    const none = fakeConn({ techs: [TECH, OTHER_TECH] });
    await runRouteCheck({ now: NOW });
    expect(findAvailableSlots).not.toHaveBeenCalled();
    expect(JSON.parse(none.writes[0][1].ad_shadow).decision.zones.map((z) => z.byDate['2026-11-19'])).toEqual([0, 0]);
    // The rule unread: today has no answer.
    inactiveCapabilitiesForServices.mockRejectedValue(new Error('capabilities unread'));
    const unread = fakeConn({ techs: [TECH, OTHER_TECH] });
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed_with_errors');
    expect(JSON.parse(unread.writes[0][1].ad_shadow).decision.zones[0]).toMatchObject({
      byDate: { '2026-11-19': null }, error: 'capabilities unread',
    });
  });

  test("slot rule, today (A2): one technician's failed ask leaves the other's starts standing, and is the zone's error", async () => {
    findAvailableSlots.mockImplementation(async ({ technicianId }) => {
      if (technicianId === TECH) throw new Error('route read timeout');
      return found([['15:00', '15:00']], {}, technicianId);
    });
    const { writes } = fakeConn({ techs: [TECH, OTHER_TECH] });
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed_with_errors');
    expect(JSON.parse(writes[0][1].ad_shadow).decision).toMatchObject({
      mode: 'full',
      zones: [
        { byDate: { '2026-11-19': 1 }, first: '2026-11-19 15:00', error: 'route read timeout' },
        { byDate: { '2026-11-19': 1 }, first: '2026-11-19 15:00', error: 'route read timeout' },
      ],
    });
    expect(findAvailableSlots.mock.calls.map(([ask]) => ask.technicianId)).toEqual([TECH, OTHER_TECH, TECH, OTHER_TECH]);
    // With no start from the other, the failure leaves today no answer: its zero is not one. One error, said once.
    findAvailableSlots.mockImplementation(async ({ technicianId }) => (
      technicianId === OTHER_TECH ? found([]) : { error: 'lat/lng required', slots: [] }));
    const none = fakeConn({ techs: [TECH, OTHER_TECH, '00000000-0000-4000-8000-000000000003'] });
    await runRouteCheck({ now: NOW });
    expect(JSON.parse(none.writes[0][1].ad_shadow).decision).toMatchObject({
      mode: 'unknown', zones: [{ byDate: { '2026-11-19': null }, error: 'lat/lng required' }, { byDate: { '2026-11-19': null } }],
    });
  });

  test("slot rule, today (A2): the legacy gap finder's starts go through the office's occupancy guard, strict", async () => {
    // The gap finder (GATE_ADMIN_ARRIVAL_WINDOWS off) gives one candidate per gap: its earliest start and its last. The
    // office's guard walks it hourly and vetoes the hours an unassigned 3:30-4:30 visit holds: 5 PM stays (done at 6).
    findAvailableSlots.mockImplementation(async ({ lat, technicianId }) => ({
      slots: lat === 27.5 ? [{ date: '2026-11-19', start_time: '15:00', latest_start_min: 17 * 60, technician: { id: technicianId } }] : [],
      rejections_by_date: {},
    }));
    loadOccupancy.mockImplementation(async () => ({
      rows: [{
        id: 'u1', date: '2026-11-19', startMin: 15 * 60 + 30, endMin: 16 * 60 + 30, customer_id: 'c1', technician_id: null,
        service_type: 'Pest Control', reservation_expires_at: null,
      }],
      canName: () => false,
      nameById: new Map(),
    }));
    const { writes } = fakeConn();
    await runRouteCheck({ now: NOW });
    expect(JSON.parse(writes[0][1].ad_shadow).decision.zones[0]).toMatchObject({ byDate: { '2026-11-19': 1 }, first: '2026-11-19 17:00' });
    expect(loadOccupancy.mock.calls).toEqual([[{ dateFrom: '2026-11-19', dateTo: '2026-11-19' }]]);
    // The snapshot unreadable: today has no answer, never the office box's fail-open list.
    loadOccupancy.mockRejectedValue(new Error('snapshot down'));
    const unread = fakeConn();
    expect((await runRouteCheck({ now: NOW })).status).toBe('completed_with_errors');
    expect(JSON.parse(unread.writes[0][1].ad_shadow).decision.zones[0]).toMatchObject({
      byDate: { '2026-11-19': null }, error: 'snapshot down',
    });
  });

  test("slot rule, today (A2): with New Appointment's open-times box hidden, today has no answer and nothing is asked", async () => {
    for (const hidden of ['GATE_OPEN_TIMES_BOX', 'GATE_BEST_TIME_HINTS']) {
      process.env.GATE_BEST_TIME_HINTS = 'true';
      process.env.GATE_OPEN_TIMES_BOX = 'true';
      delete process.env[hidden];
      findAvailableSlots.mockClear();
      inactiveCapabilitiesForServices.mockClear();
      availabilityForPin.mockImplementation(async () => ({ days: [] }));
      const none = fakeConn();
      expect((await runRouteCheck({ now: NOW })).status).toBe('completed_with_errors');
      const decision = JSON.parse(none.writes[0][1].ad_shadow).decision;
      expect([hidden, decision.mode, decision.dates[0], decision.sameDay]).toEqual([hidden, 'unknown', '2026-11-19', { date: '2026-11-19', box: 'off' }]);
      expect(decision.zones.map((z) => [z.byDate['2026-11-19'], z.error])).toEqual([[null, undefined], [null, undefined]]);
      expect(findAvailableSlots).not.toHaveBeenCalled();
      expect(inactiveCapabilitiesForServices).not.toHaveBeenCalled();
      // /book's slot still decides.
      availabilityForPin.mockImplementation(async ({ lat }) => (lat === 27.1 ? offerOn('2026-11-21', ['10:00']) : { days: [] }));
      const some = fakeConn();
      await runRouteCheck({ now: NOW });
      expect(JSON.parse(some.writes[0][1].ad_shadow).decision).toMatchObject({ mode: 'full', sameDay: { box: 'off' } });
    }
  });

  test("slot rule, today (A2): under capacity routing the office's finder buys no roads and starts today from the route as booked", async () => {
    fakeConn();
    const crew = new Map([['2026-11-19', new Set([TECH])]]);
    const before = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    let decision;
    try {
      decision = await rc.decideSlotRule({ now: NOW, dates: [], crew });
    } finally {
      if (before === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = before;
    }
    // Today alone is still a date to decide on: no slot there is the floor.
    expect(decision).toMatchObject({ mode: 'floor', travel: 'modeled', dates: ['2026-11-19'], sameDay: { date: '2026-11-19' } });
    expect(decision.sameDay).not.toHaveProperty('travel');
    expect(findAvailableSlots.mock.calls[0][0]).toMatchObject({ fromActiveStop: false });
    expect(availabilityForPin).not.toHaveBeenCalled();
  });

  test('an unassigned booking ending off the hour holds only its own minutes', async () => {
    replan.loadDayStops.mockResolvedValue([]);
    listOccupiedWindows.mockImplementation(async ({ dateFrom }) => (dateFrom === '2026-11-20' ? [span('u1', null, 480, 930)] : [])); // 8:00-3:30
    const { writes } = fakeConn();
    await runRouteCheck({ now: NOW });
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
    const { writes } = fakeConn();
    await runRouteCheck({ now: NOW });
    const days = JSON.parse(writes[0][1].days);
    expect(days.find((d) => d.date === '2026-11-20').openings).toEqual([expect.objectContaining({ start: 930 })]);
    expect(days.find((d) => d.date === '2026-11-21')).toMatchObject({ skip: 'FAILED' });
    bookedInterviewWindowsForDate.mockResolvedValue([]);
  });

  test('an unreadable departure time (day rules on) records the run as failed, never an 08:00 guess', async () => {
    const saved = process.env.GATE_AUTO_DISPATCH_DAY_RULES;
    process.env.GATE_AUTO_DISPATCH_DAY_RULES = 'true';
    departure.readDepartureSetting.mockRejectedValueOnce(new Error('timeout'));
    const { writes } = fakeConn();
    const result = await runRouteCheck({ now: NOW });
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
    const snapshot = jest.fn(async (fn, opts) => { seen.push(opts); return fn(snap); });
    db.transaction = snapshot; // on the shared handle: the run reads no other
    let result;
    try {
      result = await runRouteCheck({ now: NOW });
    } finally {
      delete db.transaction;
    }
    expect(snapshot).toHaveBeenCalledTimes(1);
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
    const { writes } = fakeConn();
    const result = await runRouteCheck({ now: NOW });
    expect(result.status).toBe('completed_with_errors');
    const days = JSON.parse(writes[0][1].days);
    expect(days.find((d) => d.date === '2026-11-24')).toMatchObject({ skip: 'FAILED' });
    expect(days.find((d) => d.date === '2026-11-23').skip).toBeUndefined();
    listOccupiedWindows.mockResolvedValue([]);
  });

});
