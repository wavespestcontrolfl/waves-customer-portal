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
  expect(windowForCapacityService(current, 1)).toEqual({ window_start: '09:00', window_end: '09:40', estimated_duration_minutes: 40 });
  expect(capacityFromReservation(current).durationMinutes).toBe(70);
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
