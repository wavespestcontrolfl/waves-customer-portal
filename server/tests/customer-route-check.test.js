/**
 * GATE_CUSTOMER_ROUTE_CHECK helper (services/scheduling/customer-route-check.js):
 * the dispatcher's arrival-window route check run over a customer list as a
 * DROP-ONLY filter. arrival-route.js is mocked here: this suite pins what the
 * helper does with each outcome, not the route simulation itself.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/arrival-route', () => ({
  arrivalWindowRoutingEnabled: jest.fn(() => true),
  loadArrivalRouteContext: jest.fn(),
  evaluateArrivalPlacement: jest.fn(),
}));

const logger = require('../services/logger');
const arrivalRoute = require('../services/scheduling/arrival-route');
const { filterOfferedSlots } = require('../services/scheduling/customer-route-check');
const { etDateString } = require('../utils/datetime-et');

const addDays = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const TODAY = etDateString(new Date());
const SOON = addDays(TODAY, 2);
const FAR = addDays(TODAY, 12);
const TARGET = { prospective: { lat: 27.4, lng: -82.4, estimated_duration_minutes: 60 } };
const slot = (date, start, tech = 'tech-1', extra = {}) => ({ date, start_time: start, technician_id: tech, ...extra });
const feasible = { feasible: true };
// An arrival_window failure that the evaluator confirms makes another stop newly late.
const LATE = { targetLate: false, newlyLateStopIds: ['late-1'], baselineLateStopIds: [], dayEndExceeded: false };
const fail = (reason, lateness = LATE) => ({ feasible: false, reason, ...(reason === 'arrival_window' ? { lateness } : {}) });

function run(slots, extra = {}) {
  return filterOfferedSlots({ surface: 'book', mode: 'on', slots, target: TARGET, durationMinutes: 60, today: new Date(), ...extra });
}

beforeEach(() => {
  jest.clearAllMocks();
  arrivalRoute.arrivalWindowRoutingEnabled.mockReturnValue(true);
  arrivalRoute.loadArrivalRouteContext.mockResolvedValue({ rows: [
    { technician_id: 'tech-1', window_start: '10:00' }, { technician_id: 'tech-1', window_start: '08:30' },
  ] });
  arrivalRoute.evaluateArrivalPlacement.mockReturnValue(feasible);
});

describe('filterOfferedSlots — which outcomes remove a slot', () => {
  test('removes a slot only when the result is arrival_window', async () => {
    const reasons = ['arrival_window', 'route_unverified', 'return_time', 'arrival_margin', 'day_overcommitted'];
    const slots = reasons.map((r, i) => slot(SOON, `${9 + i}:00`.padStart(5, '0')));
    arrivalRoute.evaluateArrivalPlacement.mockImplementation((_ctx, { windowStart }) => {
      const i = Number(windowStart.slice(0, 2)) - 9;
      return reasons[i] ? fail(reasons[i]) : feasible;
    });
    const { slots: out, report } = await run([...slots, slot(SOON, '15:00')]);
    expect(out.map((s) => s.start_time)).toEqual(['10:00', '11:00', '12:00', '13:00', '15:00']);
    expect(report.removed).toBe(1);
    expect(report.keptUnverified).toBe(1);
    expect(report.keptOther).toBe(4); // return_time, arrival_margin, day_overcommitted, feasible
    expect(report.byReason).toEqual({ arrival_window: 1, route_unverified: 1, return_time: 1, arrival_margin: 1, day_overcommitted: 1, feasible: 1 });
  });

  test('a thrown error keeps the slot and counts it', async () => {
    arrivalRoute.evaluateArrivalPlacement.mockImplementation(() => { throw new Error('boom'); });
    const slots = [slot(SOON, '09:00'), slot(SOON, '10:00')];
    const { slots: out, report } = await run(slots);
    expect(out).toEqual(slots);
    expect(report.errors).toBe(2);
    expect(report.keptOther).toBe(2);
  });

  test('a route that cannot be loaded keeps its slots', async () => {
    arrivalRoute.loadArrivalRouteContext.mockRejectedValue(new Error('db down'));
    const slots = [slot(SOON, '09:00'), slot(SOON, '10:00')];
    const { slots: out, report } = await run(slots);
    expect(out).toEqual(slots);
    expect(arrivalRoute.loadArrivalRouteContext).toHaveBeenCalledTimes(1);
    expect(report.errors).toBe(2);
    expect(arrivalRoute.evaluateArrivalPlacement).not.toHaveBeenCalled();
  });

  test('a slot with no technician is kept as unverified without a route load', async () => {
    const { slots: out, report } = await run([slot(SOON, '09:00', null)]);
    expect(out).toHaveLength(1);
    expect(report.keptUnverified).toBe(1);
    expect(arrivalRoute.loadArrivalRouteContext).not.toHaveBeenCalled();
  });
});

describe('filterOfferedSlots — only confirmed lateness for another stop removes a slot', () => {
  const run1 = async (result) => {
    arrivalRoute.evaluateArrivalPlacement.mockReturnValue(result);
    const slots = [slot(SOON, '09:00'), slot(SOON, '10:00')];
    const out = await run(slots);
    return { slots, ...out };
  };

  test('asks the evaluator for the diagnosis', async () => {
    await run([slot(SOON, '09:00')]);
    expect(arrivalRoute.evaluateArrivalPlacement.mock.calls[0][1].explain).toBe(true);
  });

  test('the new visit missing only its own window is kept and counted target_late', async () => {
    const { slots, slots: input, report } = await run1(fail('arrival_window', { ...LATE, newlyLateStopIds: [], targetLate: true }));
    expect(slots).toBe(input);
    expect(report).toMatchObject({ removed: 0, targetLate: 2, keptOther: 0 });
    expect(logger.info.mock.calls[0][0]).toContain('target_late=2 baseline_late=0 day_end=0');
  });

  test('a day already late without the visit is kept and counted baseline_late', async () => {
    const { report } = await run1(fail('arrival_window', { ...LATE, newlyLateStopIds: [], baselineLateStopIds: ['b'] }));
    expect(report).toMatchObject({ removed: 0, baselineLate: 2 });
  });

  test('a route past the day end is kept and counted day_end', async () => {
    const { report } = await run1(fail('arrival_window', { ...LATE, newlyLateStopIds: [], dayEndExceeded: true }));
    expect(report).toMatchObject({ removed: 0, dayEnd: 2 });
  });

  test('arrival_window with no diagnosis, or an empty one, is kept (fail open)', async () => {
    const none = await run1({ feasible: false, reason: 'arrival_window' });
    expect(none.report).toMatchObject({ removed: 0, keptOther: 2 });
    expect(none.report.byReason.arrival_window_unexplained).toBe(2);
    const empty = await run1(fail('arrival_window', { ...LATE, newlyLateStopIds: [] }));
    expect(empty.report).toMatchObject({ removed: 0, keptOther: 2 });
  });

  test('baseline-late AND newly late is removed, not counted baseline_late (mixed diagnosis)', async () => {
    const { report } = await run1(fail('arrival_window', { ...LATE, baselineLateStopIds: ['b'] }));
    expect(report).toMatchObject({ removed: 2, baselineLate: 0, dayEnd: 0, targetLate: 0, keptOther: 0 });
    expect(report.removedSlots[0].mixed).toBe('baseline_late');
  });

  test('day end AND newly late is removed, not counted day_end (mixed diagnosis)', async () => {
    const { report } = await run1(fail('arrival_window', { ...LATE, dayEndExceeded: true }));
    expect(report).toMatchObject({ removed: 2, dayEnd: 0, baselineLate: 0 });
    expect(report.removedSlots[0].mixed).toBe('day_end');
  });

  test('the removed-slot line notes a mixed day', async () => {
    arrivalRoute.evaluateArrivalPlacement.mockReturnValue(fail('arrival_window', { ...LATE, baselineLateStopIds: ['b'], dayEndExceeded: true }));
    await run([slot(SOON, '09:00'), slot(FAR, '09:00')], { mode: 'shadow' });
    expect(logger.info.mock.calls.map(([l]) => l)).toContain(`[customer-route-check] removed surface=book date=${SOON} start=09:00 tech=tech-1 late=late-1 mixed=baseline_late,day_end`);
  });

  test('a removed slot logs the stops it would make late', async () => {
    const { report } = await run1(fail('arrival_window', { ...LATE, newlyLateStopIds: ['s1', 's2'] }));
    expect(report.removedSlots[0].lateVisitId).toBe('s1,s2');
  });
});


describe('filterOfferedSlots — evaluation', () => {
  test('a 10:45 slot is evaluated at 10:45, with the legacy duration for its end', async () => {
    await run([slot(SOON, '10:45')], { durationMinutes: 90 });
    expect(arrivalRoute.evaluateArrivalPlacement).toHaveBeenCalledTimes(1);
    expect(arrivalRoute.evaluateArrivalPlacement.mock.calls[0][1])
      .toEqual({ windowStart: '10:45', windowEnd: '12:15', durationMinutes: 90, explain: true });
  });

  test('the duration falls back to 60 and the planning minutes never appear', async () => {
    await run([slot(SOON, '09:00')], { durationMinutes: undefined });
    expect(arrivalRoute.evaluateArrivalPlacement.mock.calls[0][1].durationMinutes).toBe(60);
    expect(arrivalRoute.loadArrivalRouteContext.mock.calls[0][0].prospective.estimated_duration_minutes).toBe(60);
  });

  test('loads each (date, technician) route once and evaluates at the slot technician and date', async () => {
    await run([slot(SOON, '09:00'), slot(SOON, '10:00'), slot(SOON, '11:00', 'tech-2'), slot(FAR, '09:00')]);
    expect(arrivalRoute.loadArrivalRouteContext).toHaveBeenCalledTimes(3);
    const keys = arrivalRoute.loadArrivalRouteContext.mock.calls.map(([a]) => `${a.date}|${a.technicianId}`);
    expect(keys.sort()).toEqual([`${FAR}|tech-1`, `${SOON}|tech-1`, `${SOON}|tech-2`].sort());
    expect(arrivalRoute.evaluateArrivalPlacement).toHaveBeenCalledTimes(4);
  });

  test('the target carries the pin, the excluded visits and the estimate hold; never a road or spender option', async () => {
    await run([slot(SOON, '09:00')], { target: { ...TARGET, excludeServiceIds: ['svc-1'], excludeEstimateId: 'est-1' } });
    const arg = arrivalRoute.loadArrivalRouteContext.mock.calls[0][0];
    expect(arg.prospective).toMatchObject({ lat: 27.4, lng: -82.4 });
    expect(arg.excludeServiceIds).toEqual(['svc-1']);
    expect(arg.excludeEstimateId).toBe('est-1');
    for (const key of ['pickerRoadCheck', 'roads', 'roadSpender', 'providerTravel', 'travel', 'fromActiveStop']) {
      expect(arg).not.toHaveProperty(key);
    }
  });

  test('a stored visit target loads by service id', async () => {
    await run([slot(SOON, '09:00')], { target: { serviceId: 'svc-9' } });
    expect(arrivalRoute.loadArrivalRouteContext.mock.calls[0][0]).toMatchObject({ serviceId: 'svc-9' });
  });

  test('estimate slots (windowStart, techId) are read too', async () => {
    arrivalRoute.evaluateArrivalPlacement.mockReturnValue(fail('arrival_window'));
    const est = { date: SOON, windowStart: '11:00', windowEnd: '12:00', techId: 'tech-1', durationMinutes: 60 };
    const { slots: out, report } = await run([est, { ...est, windowStart: '14:00' }, { ...est, date: FAR }]);
    expect(report.removed).toBe(3);
    // floor: every slot dated in the next 7 days would go, so the list stays whole
    expect(out).toHaveLength(3);
    expect(report.floorKept).toBe(true);
  });
});

describe('filterOfferedSlots — list safety', () => {
  test('keeps order and object identity; never mutates the input', async () => {
    arrivalRoute.evaluateArrivalPlacement.mockImplementation((_c, { windowStart }) => (windowStart === '11:00' ? fail('arrival_window') : feasible));
    const slots = [slot(SOON, '15:00', 'tech-1', { rank: 3 }), slot(SOON, '11:00', 'tech-1', { rank: 1 }), slot(SOON, '09:00', 'tech-1', { rank: 2 })];
    slots.forEach(Object.freeze);
    Object.freeze(slots);
    const { slots: out } = await run(slots);
    expect(out).toEqual([slots[0], slots[2]]);
    expect(out[0]).toBe(slots[0]);
    expect(out[1]).toBe(slots[2]);
    expect(slots).toHaveLength(3);
  });

  test('floor: when removals leave nothing dated today..today+6, the original list comes back', async () => {
    // The far slot is feasible; both near-term slots would be removed.
    arrivalRoute.loadArrivalRouteContext.mockImplementation(async ({ date }) => ({ rows: [], date }));
    arrivalRoute.evaluateArrivalPlacement.mockImplementation((ctx) => (ctx.date === FAR ? feasible : fail('arrival_window')));
    const slots = [slot(SOON, '09:00'), slot(SOON, '10:00'), slot(FAR, '09:00')];
    const { slots: out, report } = await run(slots);
    expect(out).toBe(slots);
    expect(report.floorKept).toBe(true);
    expect(report.removed).toBe(2);
  });

  test('floor does not hold when a near-term slot survives', async () => {
    arrivalRoute.evaluateArrivalPlacement.mockImplementation((_c, { windowStart }) => (windowStart === '09:00' ? fail('arrival_window') : feasible));
    const { slots: out, report } = await run([slot(SOON, '09:00'), slot(SOON, '10:00')]);
    expect(out.map((s) => s.start_time)).toEqual(['10:00']);
    expect(report.floorKept).toBe(false);
  });

  test('shadow mode returns the original list and logs what it would remove', async () => {
    arrivalRoute.evaluateArrivalPlacement.mockImplementation((_c, { windowStart }) => (windowStart === '09:00' ? fail('arrival_window') : feasible));
    const slots = [slot(SOON, '09:00'), slot(SOON, '10:00')];
    const { slots: out, report } = await run(slots, { mode: 'shadow', surface: 'reschedule' });
    expect(out).toBe(slots);
    expect(report.removed).toBe(1);
    const lines = logger.info.mock.calls.map(([l]) => l);
    expect(lines[0]).toMatch(/^\[customer-route-check\] surface=reschedule mode=shadow offered=2 removed=1 kept_unverified=0 kept_other=1 target_late=0 baseline_late=0 day_end=0 floor_kept=false timed_out=false first_stop_hour=08 ms=\d+$/);
    expect(lines[1]).toBe(`[customer-route-check] removed surface=reschedule date=${SOON} start=09:00 tech=tech-1 late=late-1`);
  });

  test('logs at most 5 removed-slot lines', async () => {
    arrivalRoute.evaluateArrivalPlacement.mockImplementation((_c, { windowStart }) => (windowStart === '16:00' ? feasible : fail('arrival_window')));
    const slots = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'].map((t) => slot(SOON, t));
    await run(slots, { mode: 'shadow' });
    expect(logger.info.mock.calls.filter(([l]) => l.includes('] removed surface='))).toHaveLength(5);
  });

  test('the log line shows first_stop_hour as - when the day has no timed stop', async () => {
    arrivalRoute.loadArrivalRouteContext.mockResolvedValue({ rows: [] });
    await run([slot(SOON, '09:00')]);
    expect(logger.info.mock.calls[0][0]).toContain('first_stop_hour=- ');
  });

  test('budget: slots not yet evaluated are kept and the run reports timed_out', async () => {
    arrivalRoute.loadArrivalRouteContext.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ rows: [] }), 200)));
    arrivalRoute.evaluateArrivalPlacement.mockReturnValue(fail('arrival_window'));
    const slots = [slot(SOON, '09:00'), slot(SOON, '10:00'), slot(FAR, '09:00')];
    const { slots: out, report } = await run(slots, { budgetMs: 20 });
    expect(out).toEqual(slots);
    expect(report.timedOut).toBe(true);
    expect(report.removed).toBe(0);
    expect(logger.info.mock.calls[0][0]).toContain('timed_out=true');
  });

  test('budget: a run that spends it between slots stops evaluating the rest', async () => {
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      arrivalRoute.evaluateArrivalPlacement.mockImplementation(() => { clock += 1000; return fail('arrival_window'); });
      const slots = [slot(SOON, '09:00'), slot(SOON, '10:00'), slot(SOON, '11:00'), slot(FAR, '09:00')];
      const { slots: out, report } = await run(slots, { budgetMs: 1500 });
      expect(report.timedOut).toBe(true);
      expect(arrivalRoute.evaluateArrivalPlacement).toHaveBeenCalledTimes(2);
      // the two judged slots go; the unjudged ones stay
      expect(out).toEqual([slots[2], slots[3]]);
    } finally {
      Date.now = realNow;
    }
  });

  test('never throws: an unreadable list shape returns the original with the error', async () => {
    const slots = [slot(SOON, '09:00')];
    const { slots: out, report } = await run(slots, { pick: () => { throw new Error('bad shape'); } });
    expect(out).toBe(slots);
    expect(report.error).toBe('bad shape');
    expect(logger.info.mock.calls[0][0]).toContain('error=bad shape');
  });

  test('does nothing when arrival-window routing is off', async () => {
    arrivalRoute.arrivalWindowRoutingEnabled.mockReturnValue(false);
    const slots = [slot(SOON, '09:00')];
    const { slots: out, report } = await run(slots);
    expect(out).toBe(slots);
    expect(report.skipped).toBe('arrival_windows_off');
    expect(arrivalRoute.loadArrivalRouteContext).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('does nothing without a usable pin or an empty list', async () => {
    const slots = [slot(SOON, '09:00')];
    expect((await run(slots, { target: { prospective: { lat: null, lng: null } } })).slots).toBe(slots);
    expect((await run([])).slots).toEqual([]);
    expect(arrivalRoute.loadArrivalRouteContext).not.toHaveBeenCalled();
  });
});

describe('customerRouteCheckMode (feature-gates)', () => {
  const gates = jest.requireActual('../config/feature-gates');
  const saved = process.env.GATE_CUSTOMER_ROUTE_CHECK;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_CUSTOMER_ROUTE_CHECK;
    else process.env.GATE_CUSTOMER_ROUTE_CHECK = saved;
  });

  test.each([
    [undefined, 'off'], ['', 'off'], ['1', 'off'], ['on', 'off'], ['yes', 'off'],
    ['shadow', 'shadow'], [' Shadow ', 'shadow'], ['true', 'on'], ['TRUE', 'on'],
  ])('GATE_CUSTOMER_ROUTE_CHECK=%p reads %p, at call time', (value, mode) => {
    if (value === undefined) delete process.env.GATE_CUSTOMER_ROUTE_CHECK;
    else process.env.GATE_CUSTOMER_ROUTE_CHECK = value;
    expect(gates.customerRouteCheckMode()).toBe(mode);
    expect(require('../services/scheduling/customer-route-check').customerRouteCheckMode()).toBe(mode);
  });
});
