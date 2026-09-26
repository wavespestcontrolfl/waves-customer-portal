// Shared placement route-cost model (GATE_AUTO_DISPATCH_SHARED_MODEL) —
// the ONE function scoring both the current placement and every candidate
// (root cause b of the 2026-09-26 incident: current used plain haversine,
// candidates used a full simulation that also charged the mover its full
// estimate instead of its planning minutes).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// Pin the drive-time model to the legacy (uncalibrated) estimator so this
// suite's numbers don't depend on the ambient environment — matches
// auto-dispatch-candidates.test.js's convention.
const ORIGINAL_DRIVE_GATE = process.env.GATE_DRIVE_TIME_CALIBRATION;
const ORIGINAL_CAPACITY_GATE = process.env.GATE_SCHEDULING_CAPACITY;
beforeEach(() => { delete process.env.GATE_DRIVE_TIME_CALIBRATION; delete process.env.GATE_SCHEDULING_CAPACITY; });
afterAll(() => {
  if (ORIGINAL_DRIVE_GATE === undefined) delete process.env.GATE_DRIVE_TIME_CALIBRATION; else process.env.GATE_DRIVE_TIME_CALIBRATION = ORIGINAL_DRIVE_GATE;
  if (ORIGINAL_CAPACITY_GATE === undefined) delete process.env.GATE_SCHEDULING_CAPACITY; else process.env.GATE_SCHEDULING_CAPACITY = ORIGINAL_CAPACITY_GATE;
});

const {
  stopPlanningMinutes, chainDriveMinutes, routeCost, clusterShare, CLUSTER_RADIUS_MILES,
} = require('../services/auto-dispatch/route-model');
const { HQ, driveMin } = require('../services/auto-dispatch/geo');

// A point ~0.02 deg away from HQ (roughly 1-1.5 miles at this latitude) —
// "same area"; a point several degrees away is unambiguously far.
const NEAR_HQ = { lat: HQ.lat + 0.02, lng: HQ.lng + 0.01 };
const FAR = { lat: HQ.lat + 3, lng: HQ.lng + 3 };

describe('stopPlanningMinutes', () => {
  const pestStop = { service_type: 'Quarterly Pest Control Service', is_recurring: true, estimated_duration_minutes: 60 };

  test('GATE_SCHEDULING_CAPACITY off: falls back to the stop\'s own estimate (legacy rule)', () => {
    expect(stopPlanningMinutes(pestStop)).toBe(60);
    expect(stopPlanningMinutes({ estimated_duration_minutes: null })).toBe(60); // DEFAULT_DURATION_MINUTES
  });

  test('GATE_SCHEDULING_CAPACITY on: uses the owner planning table for a named service', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    expect(stopPlanningMinutes(pestStop)).toBe(25); // recurringPest
  });

  test('charges the MOVING VISIT too, even when it is marked planning_exempt — the deliberate departure from the general arrival-route contract', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    expect(stopPlanningMinutes({ ...pestStop, planning_exempt: true })).toBe(25);
  });

  test('an unnamed service falls back to its own estimate even with the gate on', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    expect(stopPlanningMinutes({ service_type: 'General Pest + Lawn Combo', estimated_duration_minutes: 90 })).toBe(90);
  });

  test('null/undefined stop degrades to the default rather than throwing', () => {
    expect(stopPlanningMinutes(null)).toBe(60);
  });
});

describe('chainDriveMinutes', () => {
  test('empty chain is zero (HQ to HQ)', () => {
    expect(chainDriveMinutes([])).toBe(0);
  });
  test('one stop: HQ -> stop -> HQ, twice the one-way drive', () => {
    const oneWay = driveMin(HQ, NEAR_HQ);
    expect(chainDriveMinutes([NEAR_HQ])).toBeCloseTo(oneWay * 2, 5);
  });
  test('falsy entries are skipped', () => {
    expect(chainDriveMinutes([null, undefined, NEAR_HQ])).toBeCloseTo(chainDriveMinutes([NEAR_HQ]), 5);
  });
});

describe('routeCost', () => {
  test('no visit: detour is 0 and driveWith === driveWithout', () => {
    const others = [{ geo: NEAR_HQ, startMin: 540 }];
    const cost = routeCost(others, null);
    expect(cost.detourMinutes).toBe(0);
    expect(cost.driveWithMinutes).toBe(cost.driveWithoutMinutes);
  });

  test('no geo on the visit: same as no visit', () => {
    const others = [{ geo: NEAR_HQ, startMin: 540 }];
    expect(routeCost(others, { geo: null, startMin: 600 }).detourMinutes).toBe(0);
  });

  test('inserting a visit near existing stops costs less detour than inserting it far away', () => {
    const others = [{ geo: NEAR_HQ, startMin: 540 }, { geo: NEAR_HQ, startMin: 600 }];
    const near = routeCost(others, { geo: NEAR_HQ, startMin: 570 });
    const far = routeCost(others, { geo: FAR, startMin: 570 });
    expect(near.detourMinutes).toBeLessThan(far.detourMinutes);
  });

  test('empty day: detour is just the round trip to the visit (no other stops to compare against)', () => {
    const cost = routeCost([], { geo: FAR, startMin: 540 });
    expect(cost.driveWithoutMinutes).toBe(0);
    expect(cost.driveWithMinutes).toBeCloseTo(chainDriveMinutes([FAR]), 5);
    expect(cost.detourMinutes).toBeCloseTo(cost.driveWithMinutes, 5);
  });

  test('SAME function scores a "current placement" and a "candidate" identically given the same inputs — the one-model guarantee', () => {
    const otherStops = [{ geo: NEAR_HQ, startMin: 540 }, { geo: FAR, startMin: 720 }];
    const asCurrentPlacement = routeCost(otherStops, { geo: NEAR_HQ, startMin: 600 });
    const asCandidatePlacement = routeCost(otherStops, { geo: NEAR_HQ, startMin: 600 });
    expect(asCandidatePlacement).toEqual(asCurrentPlacement);
  });

  test('never negative (Math.max floor)', () => {
    const others = [{ geo: NEAR_HQ, startMin: 540 }];
    const cost = routeCost(others, { geo: NEAR_HQ, startMin: 541 });
    expect(cost.detourMinutes).toBeGreaterThanOrEqual(0);
  });
});

describe('clusterShare', () => {
  test('empty day (no other stops) scores 0 — nothing to cluster with', () => {
    expect(clusterShare([], NEAR_HQ)).toBe(0);
  });
  test('no geo on the visit scores 0', () => {
    expect(clusterShare([{ geo: NEAR_HQ, startMin: 540 }], null)).toBe(0);
  });
  test('every other stop within the cluster radius scores 1', () => {
    const stops = [{ geo: NEAR_HQ, startMin: 540 }, { geo: NEAR_HQ, startMin: 600 }];
    expect(clusterShare(stops, NEAR_HQ)).toBe(1);
  });
  test('no other stop within the cluster radius scores 0', () => {
    const stops = [{ geo: FAR, startMin: 540 }];
    expect(clusterShare(stops, NEAR_HQ)).toBe(0);
  });
  test('a mixed day scores the SHARE within the radius, not a stop count', () => {
    const stops = [{ geo: NEAR_HQ, startMin: 540 }, { geo: FAR, startMin: 600 }];
    expect(clusterShare(stops, NEAR_HQ)).toBe(0.5);
  });
  test('CLUSTER_RADIUS_MILES is a small, documented local radius', () => {
    expect(CLUSTER_RADIUS_MILES).toBeGreaterThan(0);
    expect(CLUSTER_RADIUS_MILES).toBeLessThanOrEqual(10);
  });
});
