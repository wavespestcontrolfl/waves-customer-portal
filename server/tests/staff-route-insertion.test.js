jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// GATE_STAFF_ROUTE_INSERTION (owner 2026-10-25): with capacity mode off, a
// staff check of a MOVED visit tries every place in the stored route, keeps
// every later stop 15 minutes inside its arrival window, and hands the save
// the order it certified. Synthetic stops on the calibrated drive model; no
// customer records and no network.
const {
  evaluateArrivalPlacement, placeMovedVisit, INSERTION_MARGIN_MINUTES, _internals: { laterStopTooTight },
} = require('../services/scheduling/arrival-route');
const { effectiveWindowRange } = require('../services/route-reorder-window-fit');
const { etDateString, addETDays } = require('../utils/datetime-et');

const DATE = etDateString(addETDays(new Date(), 10));
const OTHER_DAY = etDateString(addETDays(new Date(), 9));
const GATES = ['GATE_DRIVE_TIME_CALIBRATION', 'GATE_ADMIN_ARRIVAL_WINDOWS', 'GATE_STAFF_ROUTE_INSERTION', 'GATE_SCHEDULING_CAPACITY'];
const saved = Object.fromEntries(GATES.map(key => [key, process.env[key]]));
beforeEach(() => {
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
  process.env.GATE_STAFF_ROUTE_INSERTION = 'true';
  delete process.env.GATE_SCHEDULING_CAPACITY;
});
afterAll(() => {
  GATES.forEach(key => { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });
});

const hour = (h) => `${String(h).padStart(2, '0')}:00`;
const stop = (id, windowStart, lat, overrides = {}) => ({
  id, technician_id: 'tech', scheduled_date: DATE, status: 'confirmed',
  window_start: windowStart, window_end: hour(Number(windowStart.slice(0, 2)) + 1),
  estimated_duration_minutes: 60, lat, lng: -82.4, route_order: null, created_at: '2020-01-01T12:00:00Z', ...overrides,
});
// A day the nightly pass numbered: north at 8, south at 10.
const numberedDay = () => [stop('north', '08:00', 27.55, { route_order: 1 }), stop('south', '10:00', 27.45, { route_order: 2 })];
// The visit being moved here from another day, next to the northern stop.
const moved = (start = '09:00', overrides = {}) => stop('target', start, 27.545, { scheduled_date: OTHER_DAY, ...overrides });
const context = ({ rows = numberedDay(), target = moved(), placedAt } = {}) => ({
  date: DATE, now: new Date(), target, rows, grouped: false,
  placedAt: placedAt || { date: OTHER_DAY, technicianId: 'tech', windowStart: target.window_start.slice(0, 5) },
});
const at = (start, hours = 1) => ({ windowStart: start, windowEnd: hour(Number(start.slice(0, 2)) + hours) });
const order = fit => fit.arrivals.map(row => row.id);

describe('gate off', () => {
  beforeEach(() => { delete process.env.GATE_STAFF_ROUTE_INSERTION; });

  test('a moved visit still goes after the last numbered stop, so 9 AM misses its window', () => {
    const fit = evaluateArrivalPlacement(context(), at('09:00'));
    expect(fit).toMatchObject({ feasible: false, reason: 'arrival_window' });
  });

  test('a fit carries no route order to write', () => {
    const fit = evaluateArrivalPlacement(context({ target: moved('13:00') }), at('13:00'));
    expect(fit.feasible).toBe(true);
    expect(fit).not.toHaveProperty('routeOrder');
    expect(order(fit)).toEqual(['north', 'south', 'target']);
  });
});

describe('a moved visit tries every place', () => {
  test('9 AM fits between the two stops, and each hour gets its own number', () => {
    const morning = evaluateArrivalPlacement(context(), at('09:00'));
    expect(morning.feasible).toBe(true);
    expect(order(morning)).toEqual(['north', 'target', 'south']);
    expect(morning.routeOrder).toEqual(['north', 'target', 'south']);
    const afternoon = evaluateArrivalPlacement(context({ target: moved('13:00') }), at('13:00'));
    expect(order(afternoon)).toEqual(['north', 'south', 'target']);
    expect(morning.detourMinutes).toBeLessThan(afternoon.detourMinutes);
  });

  test('the save probe agrees with the box: allowInsertion:false does not pin a staff move to the end', () => {
    const probe = evaluateArrivalPlacement(context(), { ...at('09:00'), allowInsertion: false });
    expect(probe.feasible).toBe(true);
    expect(order(probe)).toEqual(['north', 'target', 'south']);
  });

  test('a technician change is a move too', () => {
    const fit = evaluateArrivalPlacement(context({ target: moved('09:00', { scheduled_date: DATE }),
      placedAt: { date: DATE, technicianId: 'another-tech', windowStart: '09:00' } }), at('09:00'));
    expect(order(fit)).toEqual(['north', 'target', 'south']);
  });

  test('the stored order still leads: stops ahead of the visit keep their places', () => {
    const rows = [stop('north', '08:00', 27.55, { route_order: 1 }), stop('middle', '09:00', 27.5, { route_order: 2 }),
      stop('south', '12:00', 27.45, { route_order: 3 })];
    const fit = evaluateArrivalPlacement(context({ rows, target: moved('10:00') }), at('10:00'));
    expect(fit.feasible).toBe(true);
    expect(fit.routeOrder.filter(id => id !== 'target')).toEqual(['north', 'middle', 'south']);
  });
});

describe('a check of the visit where it is saved keeps today\'s answer', () => {
  test('same day, technician and start: no new places are tried', () => {
    const target = stop('target', '09:00', 27.545, { route_order: 3 });
    const fit = evaluateArrivalPlacement(context({ target, placedAt: { date: DATE, technicianId: 'tech', windowStart: '09:00' } }), at('09:00'));
    expect(fit).toMatchObject({ feasible: false, reason: 'arrival_window' });
  });

  test('a whole shared stop keeps today\'s rule (its save does not renumber the day)', () => {
    const target = moved('09:00', { memberIds: ['target', 'sibling'] });
    expect(evaluateArrivalPlacement(context({ target }), at('09:00'))).toMatchObject({ feasible: false, reason: 'arrival_window' });
  });

  test('a hand-built context with no saved place (the gap tool) keeps the saved order', () => {
    const input = context();
    delete input.placedAt;
    expect(evaluateArrivalPlacement(input, at('09:00'))).toMatchObject({ feasible: false, reason: 'arrival_window' });
  });

  test('the save writer\'s own placement (place:true) does try every place', () => {
    const target = stop('target', '09:00', 27.545);
    const fit = evaluateArrivalPlacement(context({ target, placedAt: { date: DATE, technicianId: 'tech', windowStart: '09:00' } }),
      { ...at('09:00'), place: true });
    expect(fit.routeOrder).toEqual(['north', 'target', 'south']);
  });
});

describe('every later stop keeps 15 minutes', () => {
  test(`a fit that leaves a later stop under ${INSERTION_MARGIN_MINUTES} minutes is refused with its own reason`, () => {
    // Two hours of work at 8 AM: the only order that keeps both windows
    // brings the 8 AM north stop or the 10 AM south stop in near the end.
    const target = moved('08:00', { estimated_duration_minutes: 120, window_end: '10:00' });
    const fit = evaluateArrivalPlacement(context({ target }), at('08:00', 2));
    expect(fit).toMatchObject({ feasible: false, reason: 'arrival_margin' });
    expect(fit.warning).toMatch(/less than 15 minutes before its arrival window closes/);
  });

  test('a shorter visit at the same hour fits ahead of the route', () => {
    const fit = evaluateArrivalPlacement(context({ target: moved('08:00') }), at('08:00'));
    expect(fit.feasible).toBe(true);
    expect(order(fit)[0]).toBe('target');
  });

  test('the rule counts only stops after the visit, from 15 minutes up', () => {
    const route = [{ id: 'a', window_start: '08:00' }, { id: 'target', window_start: '09:00' }, { id: 'b', window_start: '10:00' }];
    const simulation = (bArrivalMin) => ({ arrivals: [{ arrivalMin: 9 * 60 + 59 }, { arrivalMin: 10 * 60 }, { arrivalMin: bArrivalMin }] });
    // b's window closes at 12:00. Stop a (1 minute to spare) is ahead of the visit.
    expect(laterStopTooTight(simulation(11 * 60 + 45), route, 'target', effectiveWindowRange, 15)).toBe(false);
    expect(laterStopTooTight(simulation(11 * 60 + 46), route, 'target', effectiveWindowRange, 15)).toBe(true);
    expect(laterStopTooTight(simulation(11 * 60 + 59), [...route.slice(0, 2), { id: 'b' }], 'target', effectiveWindowRange, 15)).toBe(false);
  });
});

test('a stored order that runs against the clock also tries the time order', () => {
  const inverted = [stop('north', '08:00', 27.55, { route_order: 2 }), stop('south', '10:00', 27.45, { route_order: 1 })];
  const fit = evaluateArrivalPlacement(context({ rows: inverted }), at('09:00'));
  expect(fit.routeOrder).toEqual(['north', 'target', 'south']);
  delete process.env.GATE_STAFF_ROUTE_INSERTION;
  expect(evaluateArrivalPlacement(context({ rows: inverted }), at('09:00')).feasible).toBe(false);
});

test('capacity mode keeps its own rules with the staff gate on', () => {
  process.env.GATE_SCHEDULING_CAPACITY = 'true';
  const probe = () => evaluateArrivalPlacement(context(), { ...at('09:00'), allowInsertion: false });
  const withGate = probe();
  delete process.env.GATE_STAFF_ROUTE_INSERTION;
  expect(JSON.stringify(withGate)).toBe(JSON.stringify(probe()));
});

describe('placeMovedVisit writes nothing unless it may', () => {
  const conn = () => Object.assign(jest.fn(() => { throw new Error('no query expected'); }), {
    isTransaction: true, transaction: jest.fn(() => { throw new Error('no savepoint expected'); }),
  });

  test('gate off', async () => {
    delete process.env.GATE_STAFF_ROUTE_INSERTION;
    const trx = conn();
    await expect(placeMovedVisit(trx, { serviceId: 'target' })).resolves.toBeNull();
    expect(trx.transaction).not.toHaveBeenCalled();
  });

  test('capacity mode (its commits write their own order)', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const trx = conn();
    await expect(placeMovedVisit(trx, { serviceId: 'target' })).resolves.toBeNull();
    expect(trx.transaction).not.toHaveBeenCalled();
  });

  test('outside a save transaction', async () => {
    const trx = Object.assign(conn(), { isTransaction: false });
    await expect(placeMovedVisit(trx, { serviceId: 'target' })).resolves.toBeNull();
    expect(trx.transaction).not.toHaveBeenCalled();
  });

  test('a failure keeps the save: the error is logged, never thrown', async () => {
    const trx = Object.assign(conn(), { transaction: jest.fn(async () => { throw new Error('savepoint rolled back'); }) });
    await expect(placeMovedVisit(trx, { serviceId: 'target' })).resolves.toBeNull();
    expect(require('../services/logger').warn).toHaveBeenCalledWith(expect.stringContaining('route order not placed for target'));
  });
});
