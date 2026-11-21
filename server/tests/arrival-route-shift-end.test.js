/**
 * The route engine's shift end (evaluateArrivalPlacement `shiftEndMin`). A caller
 * passes it to hold a placement to the technician's shift hours (owner 2026-11-19,
 * ad budget rule v2 page item D4: "offers and confirmations allow only jobs that
 * end by that tech's shift end"). The engine then certifies only a stop order in
 * which the placed visit does not keep the technician on a stop after that minute:
 * the visit ends by it, and no other service is moved to end after it. It answers
 * `shift_end` when every order that keeps the arrival promises breaks that.
 *
 * A failure here means one of two things. An hour was certified that keeps the
 * technician working past the shift end. Or an hour that fits the shift was
 * refused, or an answer changed with no shift end given.
 *
 * The real engine and the real route simulation run over synthetic stops. The
 * drive model is a double: two minutes for each 0.01 degree of latitude between
 * two places, with the office at latitude 27.40.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.4, lng: -82.4 },
  haversine: (lat1, _lng1, lat2) => Math.abs(lat1 - lat2),
  fallbackLegMetrics: (distance) => ({ minutes: Math.round(distance * 200) }),
}));

const { evaluateArrivalPlacement, enumerateArrivalPlacements } = require('../services/scheduling/arrival-route');
const { etDateString, addETDays } = require('../utils/datetime-et');

const DATE = etDateString(addETDays(new Date(), 10));
const OTHER_DAY = etDateString(addETDays(new Date(), 9));
const SAVED_CAPACITY = process.env.GATE_SCHEDULING_CAPACITY;
beforeEach(() => { delete process.env.GATE_SCHEDULING_CAPACITY; });
afterAll(() => {
  if (SAVED_CAPACITY === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
  else process.env.GATE_SCHEDULING_CAPACITY = SAVED_CAPACITY;
});

const clock = (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const minuteOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
// One stop on the technician's day: `minutes` of work from its window start.
const stop = (id, windowStart, lat, { minutes = 60, ...overrides } = {}) => ({
  id, technician_id: 'tech', scheduled_date: DATE, status: 'confirmed',
  window_start: windowStart, window_end: clock(minuteOf(windowStart) + minutes),
  estimated_duration_minutes: minutes, lat, lng: -82.4, route_order: null, created_at: '2020-01-01T12:00:00Z', ...overrides,
});
// A staff move of a visit saved on another day: the engine tries it at every place in the route.
const moved = (start, lat, overrides = {}) => stop('target', start, lat, { scheduled_date: OTHER_DAY, ...overrides });
const movedTo = (rows, target) => ({
  date: DATE, now: new Date(), target, rows, grouped: false,
  placedAt: { date: OTHER_DAY, technicianId: 'tech', windowStart: target.window_start.slice(0, 5) },
});
const at = (start) => ({ windowStart: start, windowEnd: clock(minuteOf(start) + 60), durationMinutes: 60 });
const order = (fit) => fit.arrivals.map((row) => row.id);
const rowOf = (fit, id) => fit.arrivals.find((row) => row.id === id);
const REFUSED = { feasible: false, reason: 'shift_end' };

describe('a visit the route reaches late in its hour', () => {
  // The 11:00 stop ends at 12:00, 20 minutes of driving away: the 12:00 visit is reached at 12:20.
  const route = () => movedTo([stop('before', '11:00', 27.60, { route_order: 1 })], moved('12:00', 27.50));

  test('no shift end given: the hour fits, and the visit ends at 13:20', () => {
    const fit = evaluateArrivalPlacement(route(), at('12:00'));
    expect(order(fit)).toEqual(['before', 'target']);
    expect(rowOf(fit, 'target')).toMatchObject({ arrival: '12:20', departure: '13:20' });
  });

  test('a shift that ends at 13:00, the hour\'s own end, refuses it as shift_end', () => {
    const fit = evaluateArrivalPlacement(route(), { ...at('12:00'), shiftEndMin: 13 * 60 });
    expect(fit).toMatchObject(REFUSED);
    expect(fit.warning).toBe(`With this visit the modeled route ends a stop after the technician's shift end on ${DATE}.`);
  });

  test('one minute short of the visit\'s end is refused; the exact end is kept', () => {
    expect(evaluateArrivalPlacement(route(), { ...at('12:00'), shiftEndMin: 13 * 60 + 19 })).toMatchObject(REFUSED);
    expect(evaluateArrivalPlacement(route(), { ...at('12:00'), shiftEndMin: 13 * 60 + 20 })).toEqual(evaluateArrivalPlacement(route(), at('12:00')));
  });

  test('the staff finder\'s enumeration passes it on: each refused hour is counted as shift_end', () => {
    const limits = { durationMinutes: 60, earliestStartMin: 12 * 60, latestServiceEndMin: 14 * 60 };
    // 12:00 ends at 13:20. 13:00 is reached on time and ends at 14:00.
    expect(enumerateArrivalPlacements(route(), limits).placements.map((placement) => placement.windowStart)).toEqual(['12:00', '13:00']);
    const held = enumerateArrivalPlacements(route(), { ...limits, shiftEndMin: 13 * 60 + 20 });
    expect(held.placements.map((placement) => placement.windowStart)).toEqual(['12:00']);
    expect(held.rejections).toEqual({ shift_end: 1 });
    expect(enumerateArrivalPlacements(route(), { ...limits, shiftEndMin: 13 * 60 }).rejections).toEqual({ shift_end: 2 });
  });
});

describe('the shift end is applied before the stop order is chosen', () => {
  // Stop a (09:00, 30 minutes) is on the way to the visit (promised 08:00 to 10:00). Stop c is at 12:00, past both.
  const route = () => movedTo([stop('a', '09:00', 27.45, { minutes: 30, route_order: 1 }), stop('c', '12:00', 27.60, { route_order: 2 })],
    moved('08:00', 27.50));

  test('no shift end given: the least drive wins, with the visit second (it ends at 10:40)', () => {
    const fit = evaluateArrivalPlacement(route(), at('08:00'));
    expect(fit.routeOrder).toEqual(['a', 'target', 'c']);
    expect(rowOf(fit, 'target')).toMatchObject({ arrival: '09:40', departure: '10:40' });
  });

  test('a 10:30 shift end: the order with the visit first is certified, and that is the order a save would write', () => {
    const fit = evaluateArrivalPlacement(route(), { ...at('08:00'), shiftEndMin: 10 * 60 + 30 });
    expect(fit.feasible).toBe(true);
    expect(fit.routeOrder).toEqual(['target', 'a', 'c']);
    expect(rowOf(fit, 'target')).toMatchObject({ arrival: '08:20', departure: '09:20' });
    // Stop a moves from 09:30 to 10:00, still inside the shift.
    expect(rowOf(fit, 'a').departure).toBe('10:00');
    // Stop c ends at 13:00 with the visit or without it: it was booked past this shift end before the check.
    expect(rowOf(fit, 'c').departure).toBe('13:00');
  });

  test('a shift end the least-drive order already meets changes nothing', () => {
    expect(evaluateArrivalPlacement(route(), { ...at('08:00'), shiftEndMin: 10 * 60 + 40 })).toEqual(evaluateArrivalPlacement(route(), at('08:00')));
  });

  test('a 09:59 shift end: the visit first would push stop a to 10:00, so no order is left', () => {
    expect(evaluateArrivalPlacement(route(), { ...at('08:00'), shiftEndMin: 10 * 60 }).routeOrder).toEqual(['target', 'a', 'c']);
    expect(evaluateArrivalPlacement(route(), { ...at('08:00'), shiftEndMin: 9 * 60 + 59 })).toMatchObject(REFUSED);
  });
});

describe('a stop the visit pushes later', () => {
  // The visit (15:00 to 16:00) is 20 minutes of driving from the 16:00 stop: that stop moves from 17:00 to 17:20.
  const route = () => movedTo([stop('later', '16:00', 27.60, { route_order: 1 })], moved('15:00', 27.50));

  test('no shift end given: the hour fits, and the later stop ends at 17:20', () => {
    const fit = evaluateArrivalPlacement(route(), at('15:00'));
    expect(rowOf(fit, 'target').departure).toBe('16:00');
    expect(rowOf(fit, 'later')).toMatchObject({ arrival: '16:20', departure: '17:20' });
  });

  test('a 17:00 shift end: the visit ends inside it, but it would hold the technician at the later stop until 17:20', () => {
    expect(evaluateArrivalPlacement(route(), { ...at('15:00'), shiftEndMin: 17 * 60 })).toMatchObject(REFUSED);
    expect(evaluateArrivalPlacement(route(), { ...at('15:00'), shiftEndMin: 17 * 60 + 19 })).toMatchObject(REFUSED);
  });

  test('a shift that covers the later stop\'s new end keeps the hour', () => {
    expect(evaluateArrivalPlacement(route(), { ...at('15:00'), shiftEndMin: 17 * 60 + 20 })).toEqual(evaluateArrivalPlacement(route(), at('15:00')));
  });

  describe('a day that already runs past the shift end', () => {
    // A stop booked 17:00 to 18:00 for a technician whose shift now ends at 17:30.
    const longDay = (start) => movedTo([stop('booked', '17:00', 27.60, { route_order: 1 })], moved(start, 27.50));
    const SHIFT_END = { shiftEndMin: 17 * 60 + 30 };

    test.each(['09:00', '15:00'])('a %s visit does not move that stop: the hour is kept', (start) => {
      const fit = evaluateArrivalPlacement(longDay(start), { ...at(start), ...SHIFT_END });
      expect(fit).toEqual(evaluateArrivalPlacement(longDay(start), at(start)));
      expect(rowOf(fit, 'booked').departure).toBe('18:00');
    });

    test('a 16:00 visit would move that stop from 18:00 to 18:20: refused', () => {
      expect(rowOf(evaluateArrivalPlacement(longDay('16:00'), at('16:00')), 'booked').departure).toBe('18:20');
      expect(evaluateArrivalPlacement(longDay('16:00'), { ...at('16:00'), ...SHIFT_END })).toMatchObject(REFUSED);
    });
  });
});

describe('two services of one customer at one stop end together', () => {
  // The same customer, premise, pin and 09:00 promise: one stop. 50 minutes plus 20 minutes ends at 10:10.
  const sameStop = (id, minutes, overrides = {}) => ({
    ...stop(id, '09:00', 27.545, {
      customer_id: 'cust_1', service_address_line1: '100 Fixture St',
      customer_address_line1: '100 Fixture St', customer_city: 'Bradenton', customer_zip: '34205', visit_id: null, ...overrides,
    }),
    estimated_duration_minutes: minutes,
  });
  const sibling = () => sameStop('sibling', 50, { route_order: 1 });
  // The visit checked where it is saved: it follows the service already there.
  const saved = () => ({ date: DATE, now: new Date(), grouped: false, rows: [sibling()], target: sameStop('target', 20) });
  // The visit moved here from another day: the engine certifies it ahead of the service already there.
  const movedHere = () => movedTo([sibling()], sameStop('target', 20, { scheduled_date: OTHER_DAY }));

  test('the visit last at the stop: its own row carries the stop\'s end', () => {
    const fit = evaluateArrivalPlacement(saved(), at('09:00'));
    expect(order(fit)).toEqual(['sibling', 'target']);
    expect(rowOf(fit, 'target').departure).toBe('10:10');
    expect(evaluateArrivalPlacement(saved(), { ...at('09:00'), shiftEndMin: 10 * 60 + 9 })).toMatchObject(REFUSED);
    expect(evaluateArrivalPlacement(saved(), { ...at('09:00'), shiftEndMin: 10 * 60 + 10 })).toEqual(fit);
  });

  test('the visit first at the stop: its own row ends at 10:00, and the stop still ends at 10:10', () => {
    const fit = evaluateArrivalPlacement(movedHere(), at('09:00'));
    expect(order(fit)).toEqual(['target', 'sibling']);
    expect(rowOf(fit, 'target').departure).toBe('10:00');
    expect(rowOf(fit, 'sibling')).toMatchObject({ arrival: '09:00', departure: '10:10' });
    // A shift that ends at 10:00 or 10:09 would keep the technician there until 10:10.
    expect(evaluateArrivalPlacement(movedHere(), { ...at('09:00'), shiftEndMin: 10 * 60 })).toMatchObject(REFUSED);
    expect(evaluateArrivalPlacement(movedHere(), { ...at('09:00'), shiftEndMin: 10 * 60 + 9 })).toMatchObject(REFUSED);
    expect(evaluateArrivalPlacement(movedHere(), { ...at('09:00'), shiftEndMin: 10 * 60 + 10 })).toEqual(fit);
  });
});

describe('a day that cannot run without the visit is still compared', () => {
  // The search's own road times (context.travel). The direct road from the office to the far stop
  // takes 590 minutes and every other leg takes 20. Alone, the far stop is reached at 17:50.
  // Through the visit it is reached at 10:20.
  const travel = { lookup: ({ from, to }) => ({ minutes: Number(from.lat) === 27.4 && Number(to.lat) === 27.6 ? 590 : 20, source: 'google_traffic', reason: null }) };
  const route = (far) => ({ ...movedTo([far], moved('09:00', 27.50)), travel });

  test.each([
    ['is late for its 15:00 promise', stop('far', '15:00', 27.60, { route_order: 1 }), '16:00', 15 * 60 + 30],
    ['ends at 20:20, past the day\'s end', stop('far', '16:00', 27.60, { minutes: 150, route_order: 1 }), '18:30', 17 * 60],
  ])('without the visit the far stop %s: its earlier end with the visit is not an overrun', (_words, far, end, shiftEndMin) => {
    const open = evaluateArrivalPlacement(route(far), at('09:00'));
    expect(order(open)).toEqual(['target', 'far']);
    expect(rowOf(open, 'far').departure).toBe(end);
    expect(evaluateArrivalPlacement(route(far), { ...at('09:00'), shiftEndMin })).toEqual(open);
    // The visit itself is still held to the shift end: it ends at 10:00.
    expect(evaluateArrivalPlacement(route(far), { ...at('09:00'), shiftEndMin: 10 * 60 - 1 })).toMatchObject(REFUSED);
  });
});

describe('next to the engine\'s other limits', () => {
  // Stop a is next to the office and the visit is far north: the order that ends at the visit gets home later.
  const route = () => movedTo([stop('a', '09:00', 27.44, { route_order: 1 })], moved('09:00', 27.60));

  test('an order past the return time and an order past the shift end: the answer names the shift end', () => {
    const open = evaluateArrivalPlacement(route(), { ...at('09:00'), returnByMin: 12 * 60 });
    expect(order(open)).toEqual(['target', 'a']);
    expect(evaluateArrivalPlacement(route(), { ...at('09:00'), returnByMin: 12 * 60, shiftEndMin: 9 * 60 + 59 })).toMatchObject(REFUSED);
  });

  test('every order past the return time: return_time, worded as before', () => {
    const fit = evaluateArrivalPlacement(route(), { ...at('09:00'), returnByMin: 11 * 60, shiftEndMin: 10 * 60 });
    expect(fit).toMatchObject({ feasible: false, reason: 'return_time' });
    expect(fit.warning).toBe(`The modeled route returns after the requested workday limit on ${DATE}.`);
    expect(fit).toEqual(evaluateArrivalPlacement(route(), { ...at('09:00'), returnByMin: 11 * 60 }));
  });

  test('an order that crowds a later stop and an order past the shift end: the answer names the shift end', () => {
    // The visit first reaches stop l at 09:50, 10 minutes before its promise ends: under the 15-minute margin.
    // The visit last is reached at 09:55 and ends at 10:55.
    const tight = () => movedTo([stop('l', '08:00', 27.50, { route_order: 1 })], moved('08:00', 27.325));
    const open = evaluateArrivalPlacement(tight(), at('08:00'));
    expect(order(open)).toEqual(['l', 'target']);
    expect(rowOf(open, 'target').departure).toBe('10:55');
    expect(evaluateArrivalPlacement(tight(), { ...at('08:00'), shiftEndMin: 10 * 60 + 54 })).toMatchObject(REFUSED);
  });

  test('a day that is already late (the staff lists): the hour is listed only when it ends inside the shift', () => {
    // A takes four hours, so B (promised 08:30) is late with or without the new visit.
    const lateDay = () => ({
      date: DATE, now: new Date(), grouped: false, prospective: true, blocks: [],
      rows: [stop('A', '08:00', 27.5, { minutes: 240 }), stop('B', '08:30', 27.5)],
      target: stop('__candidate__', '15:00', 27.5),
    });
    const listed = evaluateArrivalPlacement(lateDay(), { ...at('15:00'), lateDays: true });
    expect(listed).toMatchObject({ feasible: true, dayAlreadyLate: true });
    expect(rowOf(listed, '__candidate__').departure).toBe('16:00');
    expect(evaluateArrivalPlacement(lateDay(), { ...at('15:00'), lateDays: true, shiftEndMin: 16 * 60 })).toEqual(listed);
    // The day's own refusal stands: its arrival promises are already broken.
    expect(evaluateArrivalPlacement(lateDay(), { ...at('15:00'), lateDays: true, shiftEndMin: 15 * 60 + 59 }))
      .toMatchObject({ feasible: false, reason: 'arrival_window' });
  });
});

describe('a day that is already late, and the only order that keeps every promise ends past the shift end', () => {
  // The search's own road times (context.travel). The direct road from stop a to stop b takes 120
  // minutes and every other leg takes 20. Without the visit stop b is reached at 12:30, 30 minutes
  // after its promise ends. With the 30-minute visit between them it is reached at 11:40, on time.
  const travel = { lookup: ({ from, to }) => ({ minutes: Number(from.lat) === 27.45 && Number(to.lat) === 27.6 ? 120 : 20, source: 'google_traffic', reason: null }) };
  const route = () => ({
    ...movedTo([stop('a', '10:00', 27.45, { minutes: 30, route_order: 1 }), stop('b', '10:00', 27.60, { route_order: 2 })],
      moved('09:00', 27.50, { minutes: 30 })),
    travel,
  });
  const HOUR = { windowStart: '09:00', windowEnd: '09:30', durationMinutes: 30 };

  test('no shift end given: the visit goes between the two stops and ends at 11:20, and the day is on time', () => {
    const fit = evaluateArrivalPlacement(route(), { ...HOUR, lateDays: true });
    expect(order(fit)).toEqual(['a', 'target', 'b']);
    expect(rowOf(fit, 'target')).toMatchObject({ arrival: '10:50', departure: '11:20' });
    expect(rowOf(fit, 'b')).toMatchObject({ arrival: '11:40', departure: '12:40' });
    expect(fit.dayAlreadyLate).toBeUndefined();
    expect(evaluateArrivalPlacement(route(), { ...HOUR, lateDays: true, shiftEndMin: 11 * 60 + 20 })).toEqual(fit);
  });

  test('an 11:19 shift end, the staff lists: the visit goes first, ends at 09:30, and stop b stays as late as it is', () => {
    const fit = evaluateArrivalPlacement(route(), { ...HOUR, lateDays: true, shiftEndMin: 11 * 60 + 19 });
    expect(fit).toMatchObject({ feasible: true, dayAlreadyLate: true });
    expect(order(fit)).toEqual(['target', 'a', 'b']);
    expect(rowOf(fit, 'target').departure).toBe('09:30');
    // Stop a still ends at 10:30, and stop b at 13:30: the same as without the visit.
    expect(rowOf(fit, 'a').departure).toBe('10:30');
    expect(rowOf(fit, 'b')).toMatchObject({ arrival: '12:30', departure: '13:30' });
  });

  test('a path that lists no late day (the customer paths): the same hour is refused as shift_end', () => {
    expect(evaluateArrivalPlacement(route(), { ...HOUR, shiftEndMin: 11 * 60 + 19 })).toMatchObject(REFUSED);
  });

  test('a 09:29 shift end: no order ends the visit inside it, so the answer names the shift end', () => {
    expect(evaluateArrivalPlacement(route(), { ...HOUR, lateDays: true, shiftEndMin: 9 * 60 + 29 })).toMatchObject(REFUSED);
  });
});

describe('capacity mode', () => {
  beforeEach(() => { process.env.GATE_SCHEDULING_CAPACITY = 'true'; });
  // The search's own drive times: every leg takes 30 minutes, the drive home included.
  const travel = { lookup: () => ({ minutes: 30, source: 'google_traffic', reason: null }) };
  const DAY = '2031-03-05';
  const capacity = (rows = []) => ({
    date: DAY, now: new Date('2031-03-01T12:00:00Z'), rows, prospective: true, travel,
    target: stop('__candidate__', '14:00', 27.44, { scheduled_date: DAY, service_type: 'Mosquito' }),
  });
  const booked = (id, windowStart) => stop(id, windowStart, 27.5, { scheduled_date: DAY, service_type: 'Mosquito', route_order: 1 });

  test('the drive home is not held to the shift end: the visit ends at 15:00 and the van is home at 15:30', () => {
    const fit = evaluateArrivalPlacement(capacity(), { ...at('14:00'), shiftEndMin: 15 * 60 });
    expect(fit.feasible).toBe(true);
    expect(rowOf(fit, '__candidate__')).toMatchObject({ arrival: '14:00', departure: '15:00' });
    expect(fit.finishMinute).toBe(15 * 60 + 30);
    expect(evaluateArrivalPlacement(capacity(), { ...at('14:00'), shiftEndMin: 15 * 60 - 1 })).toMatchObject(REFUSED);
  });

  test('a stop that runs to 14:00 half an hour away: the 14:00 hour ends at 15:30 and is refused', () => {
    const open = evaluateArrivalPlacement(capacity([booked('before', '13:00')]), at('14:00'));
    expect(rowOf(open, '__candidate__')).toMatchObject({ arrival: '14:30', departure: '15:30' });
    expect(evaluateArrivalPlacement(capacity([booked('before', '13:00')]), { ...at('14:00'), shiftEndMin: 15 * 60 })).toMatchObject(REFUSED);
    expect(evaluateArrivalPlacement(capacity([booked('before', '13:00')]), { ...at('14:00'), shiftEndMin: 15 * 60 + 30 })).toEqual(open);
  });
});
