jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { serviceFamilyPreference, defaultTimeWindow, timeWindowForPreferenceKey } = require('../services/auto-dispatch/service-category');
const { withSchedulingDuration } = require('../services/service-library');
const { capacityForServices, capacityFromReservation, windowForCapacityService } = require('../services/combined-visit-capacity');
const RouteOptimizer = require('../services/route-optimizer');
const { placementFitsShift } = require('../services/scheduling/policy');
const { simulateArrivalRoute, effectiveWindowRange } = require('../services/route-reorder-window-fit');

const stop = (id, start, duration, extra = {}) => ({ id, estimated_duration_minutes: duration, service_type: 'Pest Control', ...extra });
beforeEach(() => { process.env.GATE_SCHEDULING_CAPACITY = 'true'; });
afterEach(() => { delete process.env.GATE_SCHEDULING_CAPACITY; });

test('versioned combined allowances preserve old holds and whole-hour new member anchors', () => {
  const services = [{ service: 'pest_control' }, { service: 'lawn_care' }];
  const old = { window_start: '09:00', reservation_service_mix: capacityForServices(services) };
  const current = { window_start: '09:00', reservation_service_mix: capacityForServices(services, [30, 40]) };
  expect(windowForCapacityService(old, 1)).toEqual({ window_start: '10:00', window_end: '11:00', estimated_duration_minutes: 60 });
  expect(windowForCapacityService(current, 1, 'lawn_care_recurring')).toEqual({ window_start: '10:00', window_end: '10:40', estimated_duration_minutes: 40 });
  // 30 pest minutes, then lawn on the next whole hour: 60 + 40 held.
  expect(capacityFromReservation(current).durationMinutes).toBe(100);
  // A hold stamped before the stop groups (no marker, plain sum) keeps its
  // original promise: every version-2 member at the shared arrival.
  const { stopGroups: _marker, ...legacyMix } = current.reservation_service_mix;
  const legacy = { window_start: '09:00', reservation_service_mix: { ...legacyMix, durationMinutes: 70 } };
  expect(capacityFromReservation(legacy).durationMinutes).toBe(70);
  expect(windowForCapacityService(legacy, 1, 'lawn_care_recurring')).toEqual({ window_start: '09:00', window_end: '09:40', estimated_duration_minutes: 40 });
  // A marked hold must carry the padded span.
  expect(() => capacityFromReservation({ reservation_service_mix: { ...current.reservation_service_mix, durationMinutes: 70 } })).toThrow();
  expect(() => capacityFromReservation({ reservation_service_mix: { version: 2, services: ['pest_control'], durationMinutes: 60 } })).toThrow();
});

test('catalog policy is gated and explicit custom allowances remain intact', () => {
  const row = { default_duration_minutes: 60, scheduling_duration_policy: { version: 1,
    default_duration_minutes: 30, min_duration_minutes: 30, max_duration_minutes: 40 } };
  expect(withSchedulingDuration(row).default_duration_minutes).toBe(30);
  expect(withSchedulingDuration({ default_duration_minutes: 120 }).default_duration_minutes).toBe(120);
  delete process.env.GATE_SCHEDULING_CAPACITY;
  expect(withSchedulingDuration(row).default_duration_minutes).toBe(60);
});

test('service-family preference is finite, weighted by work, and unknown work stays neutral', () => {
  const lawn = [stop('a', 600, 40, { service_type: 'Lawn Care' }), stop('b', 660, 20)];
  expect(serviceFamilyPreference(lawn, 'Lawn Care')).toBeGreaterThan(0);
  expect(serviceFamilyPreference(lawn, 'Pest Control')).toBeLessThan(0);
  expect(serviceFamilyPreference(lawn, 'Consultation')).toBe(0);
  expect(serviceFamilyPreference([], 'Lawn Care')).toBe(0);
  expect(defaultTimeWindow('Lawn Care')).toMatchObject({ startMin: 600, endMin: 720 });
  expect(defaultTimeWindow('Pest Control')).toMatchObject({ startMin: 480, endMin: 600 });
});

test('every afternoon anchor leaves room for the two-hour arrival promise', () => {
  const window = timeWindowForPreferenceKey('afternoon');
  const starts = [13, 14, 15, 16, 17].map(hour => hour * 60)
    .filter(start => start >= window.startMin && start < window.endMin);
  expect(starts).toEqual([13, 14, 15, 16].map(hour => hour * 60));
  expect(starts.every(start => placementFitsShift(start, start + 30))).toBe(true);
});

test('blocked travel preserves stored work, late diagnostics and the return deadline', () => {
  const visit = { id: 'visit', lat: 27.5, lng: -82.4, window_start: '08:00', window_end: '10:00',
    estimated_duration_minutes: 30 };
  const options = { startMin: 480, dayEndMin: 770, includeReturnInFinish: true,
    legMinutes: () => 10, blockedIntervals: [{ startMin: 480, endMin: 610 }, { startMin: 740, endMin: 760 }] };
  expect(simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, [visit], options)).toBeNull();
  expect(simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, [visit], { ...options, reportLate: true }))
    .toMatchObject({ arrivals: [{ id: 'visit', arrivalMin: 620, departureMin: 740, lateMinutes: 20 }],
      serviceFinishMin: 740, finishMin: 770, returnFinishMin: 770, returnAtMin: 770, waitingMin: 150 });
  expect(simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, [visit], {
    ...options, reportLate: true, dayEndMin: 769,
  })).toBeNull();
});


test('conversion allowances follow service identity when the pest anchor comes before a lawn-first estimate: the pest group keeps the picked hour', () => {
  const anchor = { window_start: '09:00', reservation_service_mix: capacityForServices(
    [{ service: 'lawn_care' }, { service: 'pest_control' }], [40, 30]),
  };
  expect(windowForCapacityService(anchor, 0, 'pest_general_quarterly')).toEqual({
    window_start: '09:00', window_end: '09:30', estimated_duration_minutes: 30,
  });
  expect(windowForCapacityService(anchor, 1, 'lawn_care_recurring')).toEqual({
    window_start: '10:00', window_end: '10:40', estimated_duration_minutes: 40,
  });
  expect(() => windowForCapacityService(anchor, 1, 'mosquito_monthly')).toThrow();
});

test('the reserved anchor group keeps the picked hour, whatever the member order (version 1 and 2)', () => {
  const services = [{ service: 'lawn_care' }, { service: 'pest_control' }, { service: 'tree_shrub' }];
  for (const mix of [capacityForServices(services), capacityForServices(services, [60, 60, 60])]) {
    const anchor = { window_start: '09:00', service_key_snapshot: 'pest_general_quarterly', reservation_service_mix: mix };
    // Version 1 indexes are the converter's member order: pest first here.
    expect(windowForCapacityService(anchor, 0, 'pest_general_quarterly').window_start).toBe('09:00');
    expect(windowForCapacityService(anchor, 1, 'lawn_care_recurring').window_start).toBe('10:00');
    // Version 1 is one hour per service (lawn 10:00, tree & shrub 11:00);
    // version 2 gives the lawn group one shared hour.
    expect(windowForCapacityService(anchor, 2, 'tree_shrub_6week').window_start).toBe(mix.version === 1 ? '11:00' : '10:00');
  }
});

test('the hold covers the anchor group, then the other group from its whole-hour start', () => {
  // Lawn-anchored (no pest): lawn 60, mosquito at +60 for 15 = 75, not the worst order.
  expect(capacityForServices([{ service: 'lawn_care' }, { service: 'mosquito' }], [60, 15]).durationMinutes).toBe(75);
  // Pest-anchored whatever the order: 30 pest -> lawn at +60 for 40 = 100.
  expect(capacityForServices([{ service: 'lawn_care' }, { service: 'pest_control' }], [40, 30]).durationMinutes).toBe(100);
});

test('allocated members are ordered anchor group first, each group contiguous', () => {
  const { orderMembersByStopGroup } = require('../services/combined-visit-capacity');
  const row = (id, key) => ({ id, service_key_snapshot: key });
  const anchor = row('a', 'lawn_care_recurring');
  const members = [anchor, row('m', 'mosquito_monthly'), row('t', 'tree_shrub_6week')];
  expect(orderMembersByStopGroup(anchor, members, { stopGroups: true }).map((r) => r.id)).toEqual(['a', 't', 'm']);
  // A hold stamped before the stop groups keeps its member order.
  expect(orderMembersByStopGroup(anchor, members, {}).map((r) => r.id)).toEqual(['a', 'm', 't']);
});
