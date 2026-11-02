// Plan-only mode (GATE_SCHEDULING_CAPACITY=plan, owner 2026-11-01, "A"): the router plans each
// stop's on-site minutes from the owner planning table, and nothing else of capacity mode turns
// on. The one-hour slots, today's 8 PM day end and the hour-mode rules stay. Pins the reader,
// the table under the new value, and two whole days on the shared arrival simulation: a full
// day of quarterly stops that the whole hour calls late and plan minutes fit, and a 5 PM last
// stop that capacity mode's 6 PM end (drive home included) refuses and plan-only mode keeps.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { schedulingPlanMinutesOnly } = require('../config/feature-gates');
const { capacityEnabled, applySchedulingPolicy } = require('../services/scheduling/policy');
const { plannedWorkMinutes, placedVisitMinutes, planningTableLive } = require('../services/scheduling/planning-minutes');
const { workDuration } = require('../services/route-reorder-window-fit');
const { evaluateArrivalPlacement } = require('../services/scheduling/arrival-route');

const saved = process.env.GATE_SCHEDULING_CAPACITY;
const setGate = (value) => {
  if (value === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
  else process.env.GATE_SCHEDULING_CAPACITY = value;
};
afterEach(() => setGate(saved));

describe('the plan-only reader', () => {
  test.each([
    ['plan', true], [' PLAN ', true], ['Plan', true],
    ['true', false], ['1', false], ['on', false], ['false', false], ['planned', false], ['', false], [undefined, false],
  ])('GATE_SCHEDULING_CAPACITY=%p reads plan-only %p', (value, expected) => {
    setGate(value);
    expect(schedulingPlanMinutesOnly()).toBe(expected);
  });

  test('plan-only is not capacity mode: the 08:00-18:00 booking policy stays off', () => {
    setGate('plan');
    expect(capacityEnabled()).toBe(false);
    const config = { day_start: '07:00', day_end: '20:00' };
    expect(applySchedulingPolicy(config)).toBe(config);
    expect(planningTableLive()).toBe(true);
  });

  test.each([[undefined, false], ['false', false], ['true', true]])(
    'GATE_SCHEDULING_CAPACITY=%p: the table is live %p, as before', (value, live) => {
      setGate(value);
      expect(planningTableLive()).toBe(live);
    });
});

describe('the planning table under plan-only mode', () => {
  const row = (service_type, extra = {}) => ({ service_type, window_start: '09:00', window_end: '10:00',
    estimated_duration_minutes: 60, ...extra });

  test.each([
    ['Quarterly Pest Control Service', 35],
    ['Bi-Monthly Pest Control Service', 35],
    ['Every 6 Weeks Lawn Care Service', 35],
    ['One-Time Pest Control Service', 45],
    ['Pest Control Re-Service', 15],
    ['Waves Assessment', 30],
    ['Rodent Trapping Service', 30],
  ])('%s plans %i minutes', (name, minutes) => {
    setGate('plan');
    expect(plannedWorkMinutes(row(name))).toBe(minutes);
    expect(workDuration(row(name))).toBe(minutes);
  });

  test.each(['Cockroach Treatment Service', 'Bee / Wasp Nest Removal Service', 'Monthly Mosquito Control Service'])(
    '%s is not in the table and keeps the legacy hour', (name) => {
      setGate('plan');
      expect(plannedWorkMinutes(row(name))).toBeNull();
      expect(workDuration(row(name))).toBe(60);
    });

  test('a stored estimate above the hour is real work and never plans shorter', () => {
    setGate('plan');
    expect(workDuration(row('Quarterly Pest Control Service', { estimated_duration_minutes: 120 }))).toBe(120);
  });

  test('the same row with the gate off keeps the whole hour; with capacity on it plans 35', () => {
    const pest = row('Quarterly Pest Control Service');
    setGate(undefined);
    expect(plannedWorkMinutes(pest)).toBeNull();
    expect(workDuration(pest)).toBe(60);
    setGate('false');
    expect(workDuration(pest)).toBe(60);
    setGate('true');
    expect(workDuration(pest)).toBe(35);
  });

  test('the visit being placed plans the table when its allowance is the hour or less', () => {
    const pest = { service_type: 'Quarterly Pest Control Service' };
    setGate('plan');
    expect(placedVisitMinutes(pest, 60)).toBe(35);
    expect(placedVisitMinutes({ service_type: 'One-Time Pest Control Service' }, 90)).toBeNull();
    setGate(undefined);
    expect(placedVisitMinutes(pest, 60)).toBeNull();
  });
});

describe('whole days on the shared arrival simulation (hour mode rules)', () => {
  const date = '2027-01-15';
  const now = new Date('2027-01-01T12:00:00Z');
  const clock = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const quarterly = (id, start, extra = {}) => ({ id, scheduled_date: date, technician_id: 'tech', lat: 27.44, lng: -82.4,
    status: 'confirmed', window_start: clock(start), window_end: clock(start + 60), estimated_duration_minutes: 60,
    service_type: 'Quarterly Pest Control Service', is_recurring: true, ...extra });
  const roads = (minutes) => ({ lookup: () => ({ minutes, source: 'google_traffic', reason: null }) });
  const place = (rows, start, minutes) => evaluateArrivalPlacement(
    { date, now, rows, prospective: true, target: quarterly('__candidate__', start, { route_order: null }), travel: roads(minutes) },
    { windowStart: clock(start), windowEnd: clock(start + 60), durationMinutes: 60 });

  // Five quarterly stops at 9, 10, 11, 12 and 13, 25 minutes apart, and a new one at 14:00. The whole
  // hour reaches it at 16:05, past the 2-hour promise; 35-minute plans reach it at 14:00.
  const fullDay = [9, 10, 11, 12, 13].map((h, i) => quarterly(`s${i}`, h * 60, { route_order: i + 1 }));

  test('the whole hour calls the 2 PM stop late', () => {
    setGate(undefined);
    expect(place(fullDay, 14 * 60, 25).feasible).toBe(false);
  });

  test('plan-only mode fits the same 2 PM stop on the same day', () => {
    setGate('plan');
    expect(place(fullDay, 14 * 60, 25).feasible).toBe(true);
  });

  // One stop at 15:00 and a new one at 17:00, 30 minutes from each other and from the office.
  // The day's work ends 17:35, inside today's 8 PM limit; the drive home ends 18:05.
  const lateDay = [quarterly('s0', 15 * 60, { route_order: 1 })];

  test('plan-only mode keeps a 5 PM last stop: the 8 PM limit stays', () => {
    setGate('plan');
    expect(place(lateDay, 17 * 60, 30).feasible).toBe(true);
  });

  test('capacity mode refuses the same stop: its day ends at 6 PM, drive home included', () => {
    setGate('true');
    expect(place(lateDay, 17 * 60, 30).feasible).toBe(false);
    // 25 minutes home ends the day at 18:00 exactly, so the 6 PM end is what refused it.
    expect(place(lateDay, 17 * 60, 25).feasible).toBe(true);
  });
});
