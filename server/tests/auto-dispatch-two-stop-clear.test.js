/**
 * Two-stop light-day clearing pass (two-stop-clear.js + road-check.js confirmPairOnRoads):
 * - paired floor math (unmoved vs already-moved)
 * - full source-day round trip vs tiny individual detours (plus co-visit rejection)
 * - candidate filtering (no Sundays, bounce guard, preference/tech/workload non-regression)
 * - same-destination joint detour, workload overload guard, empty-day guard, and road-leg spec
 * - far-south day compatibility when pairing two visits onto the same destination date
 * - real Google road confirmation (different-day, same-day adjacent 4-leg, same-day disjoint 6-leg, fail-closed)
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  pairClearFloor,
  _internals: {
    pairSourceDrive,
    filterPairCandidates,
    jointDestinationMetrics,
    sameDestRoadSpecFor,
    rankPairs,
    sameDateSouthCompatible,
    pairNeedsOverlapCheck,
    usesArrivalRouting,
    livePairRowsValid,
    stampRouteOrderWithA,
    groupCandidateBuckets,
  },
} = require('../services/auto-dispatch/two-stop-clear');
const { _internals: { serviceToRouteStop } } = require('../services/auto-dispatch/candidate-slots');
const { ROAD_LEGS, confirmPairOnRoads } = require('../services/auto-dispatch/road-check');
const { HQ } = require('../services/auto-dispatch/geo');
const { routeCost } = require('../services/auto-dispatch/route-model');

const NORTH_A = { lat: 27.554, lng: -82.396 };
const NORTH_B = { lat: 27.552, lng: -82.392 };
const NORTH_EXIST = { lat: 27.560, lng: -82.400 };
const MID = { lat: 27.430, lng: -82.420 };
const SOUTH = { lat: 27.250, lng: -82.450 };

describe('two-stop-clear pure rules', () => {
  const savedGate = process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
  beforeAll(() => { process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true'; });
  afterAll(() => {
    if (savedGate === undefined) delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
    else process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = savedGate;
  });

  const config = {
    minDayMoveDriveSavingMinutes: 6,
    minutesRuleSavingMinutes: 10,
    minutesRuleSecondMoveSavingMinutes: 15,
    roadCheckEnabled: true,
    bounceCooldownDays: 30,
  };

  test('pairClearFloor requires sum of both visits minutes-rule floors (20 / 25 / 30 min) and honors disabled rules', () => {
    expect(pairClearFloor({ auto_dispatch_change_count: 0 }, { auto_dispatch_change_count: 0 }, config)).toBe(20);
    expect(pairClearFloor({ auto_dispatch_change_count: 1 }, { auto_dispatch_change_count: 0 }, config)).toBe(25);
    expect(pairClearFloor({ auto_dispatch_change_count: 1 }, { auto_dispatch_change_count: 2 }, config)).toBe(30);
    expect(pairClearFloor({}, {}, { minDayMoveDriveSavingMinutes: 0, minutesRuleSavingMinutes: 10 })).toBe(0);
    // Repeat-move threshold disabled (0): an already-moved visit cannot bypass its score bar via pair clear.
    expect(pairClearFloor(
      { auto_dispatch_change_count: 1 }, { auto_dispatch_change_count: 0 },
      { ...config, minutesRuleSecondMoveSavingMinutes: 0 },
    )).toBe(0);
  });

  test('pairSourceDrive captures full HQ round-trip stem for two nearby stops and rejects collapsed co-visits', () => {
    const stopA = { id: 'a', customer_id: 'c1', property_id: 'p1', scheduled_date: '2026-12-21', geo: NORTH_A, startMin: 600, window_start: '10:00', estimated_duration_minutes: 60 };
    const stopB = { id: 'b', customer_id: 'c2', property_id: 'p2', scheduled_date: '2026-12-21', geo: NORTH_B, startMin: 720, window_start: '12:00', estimated_duration_minutes: 60 };
    // Individual single-stop detour stays below the 10-min single-stop minutes-rule floor because the other stop absorbs the stem.
    expect(routeCost([stopB], stopA, HQ).detourMinutes).toBeLessThan(10);
    // Together, clearing the 2-stop day recovers the entire HQ round trip (works with production serviceToRouteStop shape).
    const prodA = serviceToRouteStop(stopA, NORTH_A, 600, [], null, false, null);
    const prodB = serviceToRouteStop(stopB, NORTH_B, 720, [], null, false, null);
    const src = pairSourceDrive(prodA, prodB, HQ, '2026-12-21', 480);
    expect(src).not.toBeNull();
    expect(src.driveMinutes).toBeGreaterThan(25);
    expect(src.roadLegs.firstDepMin).toBeLessThan(600);
    expect(src.roadLegs.firstDepMin).toBeGreaterThanOrEqual(480);
    expect(src.roadLegs).toMatchObject({
      date: '2026-12-21', firstStartMin: 600, firstDurationMin: 60, secondStartMin: 720, secondDurationMin: 60, home: HQ, first: NORTH_A, second: NORTH_B,
    });
    // Without an explicit or embedded sourceDate, fails closed (null).
    expect(pairSourceDrive(prodA, prodB, HQ)).toBeNull();

    // Legacy null-visit_id co-visit (same customer, property, window) collapses to 1 physical stop -> rejected.
    const coB = { ...stopB, customer_id: 'c1', property_id: 'p1', startMin: 600, window_start: '10:00', geo: NORTH_A };
    expect(pairSourceDrive(stopA, coB, HQ, '2026-12-21')).toBeNull();
  });

  test('filterPairCandidates blocks Sundays, same-day, bounce dates, regressions, and missing road legs', () => {
    const service = { id: 'a', technician_id: 't1', auto_dispatch_change_count: 0 };
    const prefs = { preferred_day_indexes: [], preferred_time_window: null, effective_time_window: null };
    const current = { is_current: true, date: '2026-12-21', start_time: '10:00', technician_id: 't1', detour_minutes: 2, stops_that_day: 2, same_area_share: 1, route_minutes: 150, capability_level: 'qualified' };
    const currentScore = { total_score: 80, customer_preference_score: 25, default_time_score: 0, dry_time_score: 0, technician_score: 15, workload_score: 5 };
    const leg = { prev: HQ, stop: NORTH_A, next: HQ, date: '2026-12-22', startMin: 600 };
    const mk = (overrides) => ({
      date: '2026-12-22', start_time: '10:00', technician_id: 't1', detour_minutes: 5,
      stops_that_day: 5, same_area_share: 0.5, route_minutes: 320, capability_level: 'qualified',
      [ROAD_LEGS]: leg, ...overrides,
    });
    const candidates = [
      mk({ date: '2026-12-20', tag: 'sunday' }),
      mk({ date: '2026-12-21', tag: 'same_day' }),
      mk({ date: '2026-12-23', tag: 'bounced' }),
      mk({ route_minutes: 540, tag: 'overloaded' }),
      mk({ capability_level: 'review_required', tag: 'worse_tech' }),
      mk({ [ROAD_LEGS]: null, tag: 'no_road_legs' }),
      mk({ date: '2026-12-22', detour_minutes: 6, tag: 'good_2' }),
      mk({ date: '2026-12-24', detour_minutes: 3, tag: 'good_1' }),
    ];
    const kept = filterPairCandidates({
      service, current, currentScore, candidates, prefs,
      ctx: { recentLeftDates: new Set(['2026-12-23']) },
      sourceDate: '2026-12-21',
      config,
    });
    expect(kept.map((r) => r.cand.tag)).toEqual(['good_1', 'good_2']);
  });

  test('jointDestinationMetrics charges shared detour once for same-destination pair and enforces combined workload & non-empty day', () => {
    const destStops = [
      { id: 'd1', geo: NORTH_EXIST, startMin: 540, window_start: '09:00', route_order: 1, estimated_duration_minutes: 45 },
      { id: 'd2', geo: MID, startMin: 780, window_start: '13:00', route_order: 2, estimated_duration_minutes: 45 },
    ];
    const aStop = { id: 'a', geo: NORTH_A, estimated_duration_minutes: 45 };
    const bStop = { id: 'b', geo: NORTH_B, estimated_duration_minutes: 45 };
    const aCand = { date: '2026-12-22', start_time: '10:00', route_order_ids: ['d1', '__candidate__', 'd2'] };
    const bCand = { date: '2026-12-22', start_time: '11:00' };
    const curScore = { workload_score: 5 };
    const joint = jointDestinationMetrics({
      destStops, destHome: HQ, aStop, bStop, aCand, bCand,
      bRouteOrderIds: ['d1', 'a', '__candidate__', 'd2'],
      currentScoreA: curScore, currentScoreB: curScore,
    });
    expect(joint).not.toBeNull();
    // Adding both nearby stops charges the shared north leg once, much less than their separate HQ round trips.
    const singleA = routeCost(destStops, { ...aStop, startMin: 600, route_order: null, insertByTime: true, routeOrderIds: aCand.route_order_ids }, HQ).detourMinutes;
    const singleB = routeCost(destStops, { ...bStop, startMin: 660, route_order: null, insertByTime: true }, HQ).detourMinutes;
    expect(joint.addedDrive).toBeLessThanOrEqual(singleA + singleB);
    expect(joint.addedDrive).toBeLessThan(20);
    expect(joint.sameDestRoadSpec).toMatchObject({
      date: '2026-12-22',
      subChain: {
        prev: NORTH_EXIST,
        next: MID,
        prevDepMin: 585,
        baseDepMin: 585,
        proposedStops: [
          { geo: NORTH_A, startMin: 600, durationMin: 45 },
          { geo: NORTH_B, startMin: 660, durationMin: 45 },
        ],
        baselineStops: [],
      },
    });
    // Without certified route_order_ids on a numbered day, dispatch appends unsequenced visits after numbered stops:
    // jointDestinationMetrics matches canonical currentOrder (d1 -> d2 -> a -> b), NOT window insertion.
    const uncertified = jointDestinationMetrics({
      destStops, destHome: HQ, aStop, bStop,
      aCand: { date: '2026-12-22', start_time: '10:00' },
      bCand: { date: '2026-12-22', start_time: '11:00' },
      bRouteOrderIds: null, currentScoreA: curScore, currentScoreB: curScore,
    });
    expect(uncertified.sameDestRoadSpec.subChain).toMatchObject({
      prev: MID,
      next: HQ,
      proposedStops: [
        { geo: NORTH_A, startMin: 600 },
        { geo: NORTH_B, startMin: 660 },
      ],
      baselineStops: [],
    });
    // Certified mid-route insertion whose route_order_ids no longer match rawDestWithA is REJECTED (never falls back to append).
    expect(jointDestinationMetrics({
      destStops, destHome: HQ, aStop, bStop, aCand, bCand,
      bRouteOrderIds: ['d1', 'stale-id', '__candidate__', 'd2'],
      currentScoreA: curScore, currentScoreB: curScore,
    })).toBeNull();
    expect(jointDestinationMetrics({
      destStops, destHome: HQ, aStop, bStop,
      aCand: { date: '2026-12-22', start_time: '10:00', route_order_ids: ['stale-id', '__candidate__'] },
      bCand, bRouteOrderIds: null, currentScoreA: curScore, currentScoreB: curScore,
    })).toBeNull();
    // Empty destination day is rejected (never shift a 2-stop day onto an empty day).
    expect(jointDestinationMetrics({
      destStops: [], destHome: HQ, aStop, bStop, aCand, bCand, bRouteOrderIds: null, currentScoreA: curScore, currentScoreB: curScore,
    })).toBeNull();
    // Overloaded destination day (combined route_minutes > 480) is rejected even when source workload scores are already low.
    const heavyGroupedDest = [
      { id: 'g1a', visit_id: 'vis1', geo: MID, startMin: 480, window_start: '08:00', window_end: '10:00', route_order: 1, estimated_duration_minutes: 120 },
      { id: 'g1b', visit_id: 'vis1', geo: MID, startMin: 480, window_start: '08:00', window_end: '10:00', route_order: 2, estimated_duration_minutes: 180 },
      { id: 'd3', geo: MID, startMin: 720, window_start: '12:00', window_end: '14:00', route_order: 3, estimated_duration_minutes: 120 },
    ];
    expect(jointDestinationMetrics({
      destStops: heavyGroupedDest, destHome: HQ,
      aStop: { ...aStop, window_end: '16:00', estimated_duration_minutes: 60 },
      bStop: { ...bStop, window_end: '17:00', estimated_duration_minutes: 60 },
      aCand: { date: '2026-12-22', start_time: '14:00', end_time: '15:00', route_order_ids: ['g1a', 'g1b', 'd3', '__candidate__'] },
      bCand: { date: '2026-12-22', start_time: '15:00', end_time: '16:00' },
      bRouteOrderIds: ['g1a', 'g1b', 'd3', 'a', '__candidate__'], currentScoreA: { workload_score: 0 }, currentScoreB: { workload_score: 0 },
    })).toBeNull();
  });

  test('sameDestRoadSpecFor builds sub-chain carrying intervening stops for disjoint placements', () => {
    const disjoint = sameDestRoadSpecFor(
      [
        { id: 'a', geo: NORTH_A, startMin: 540, estimated_duration_minutes: 90 },
        { id: 'd1', geo: MID, startMin: 660, estimated_duration_minutes: 60 },
        { id: 'b', geo: NORTH_B, startMin: 720, estimated_duration_minutes: 60 },
        { id: 'd2', geo: SOUTH, startMin: 840, estimated_duration_minutes: 60 },
      ],
      'a', 'b', { date: '2026-12-22', startMinA: 540, startMinB: 720, home: HQ, vanDepartureMin: 480 },
    );
    expect(disjoint.subChain).toMatchObject({
      prev: HQ,
      next: SOUTH,
      proposedStops: [
        { geo: NORTH_A, startMin: 540, durationMin: 90 },
        { geo: MID, startMin: 660, durationMin: 60 },
        { geo: NORTH_B, startMin: 720, durationMin: 60 },
      ],
      baselineStops: [
        { geo: MID, startMin: 660, durationMin: 60 },
      ],
    });
    expect(disjoint.subChain.prevDepMin).toBeLessThan(540);
  });

  test('sameDateSouthCompatible blocks mixing far-south and non-far-south stops onto the same destination day', () => {
    const fleetRule = { dates: new Set(), techDays: null, ownDate: '2026-12-21' };
    const truckRule = { dates: new Set(), techDays: new Map(), ownDate: '2026-12-21' };
    // Both non-south (both have rules) -> OK
    expect(sameDateSouthCompatible(fleetRule, fleetRule, { date: '2026-12-22', technician_id: 't1' }, { date: '2026-12-22', technician_id: 't1' })).toBe(true);
    // Mixed (one south=null, one non-south=rule) on same date in fleet view -> blocked
    expect(sameDateSouthCompatible(null, fleetRule, { date: '2026-12-22', technician_id: 't1' }, { date: '2026-12-22', technician_id: 't2' })).toBe(false);
    // Mixed on same date & same tech in per-truck view -> blocked; different tech -> allowed
    expect(sameDateSouthCompatible(null, truckRule, { date: '2026-12-22', technician_id: 't1' }, { date: '2026-12-22', technician_id: 't1' })).toBe(false);
    expect(sameDateSouthCompatible(null, truckRule, { date: '2026-12-22', technician_id: 't1' }, { date: '2026-12-22', technician_id: 't2' })).toBe(true);
    // Different dates -> allowed
    expect(sameDateSouthCompatible(null, fleetRule, { date: '2026-12-22', technician_id: 't1' }, { date: '2026-12-23', technician_id: 't1' })).toBe(true);
  });

  test('pairNeedsOverlapCheck enforces cross-tech same-date overlap when occupancy is fleet-wide', () => {
    const prev = process.env.GATE_MULTI_TECH_CONFIRM;
    try {
      delete process.env.GATE_MULTI_TECH_CONFIRM;
      expect(pairNeedsOverlapCheck({ date: '2026-12-22', technician_id: 't1' }, { date: '2026-12-22', technician_id: 't2' }, false)).toBe(true);
      expect(pairNeedsOverlapCheck({ date: '2026-12-22', technician_id: 't1' }, { date: '2026-12-23', technician_id: 't2' }, false)).toBe(false);
      process.env.GATE_MULTI_TECH_CONFIRM = 'true';
      expect(pairNeedsOverlapCheck({ date: '2026-12-22', technician_id: 't1' }, { date: '2026-12-22', technician_id: 't2' }, false)).toBe(false);
      expect(pairNeedsOverlapCheck({ date: '2026-12-22', technician_id: 't1' }, { date: '2026-12-22', technician_id: 't1' }, true)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GATE_MULTI_TECH_CONFIRM;
      else process.env.GATE_MULTI_TECH_CONFIRM = prev;
    }
  });

  test('rankPairs filters by floor, prioritizes highest saving, and prefers same-destination ties', () => {
    const ranked = rankPairs([
      { id: 'under', saving: 19, sameDest: true, gainA: 10, gainB: 10, index: 1 },
      { id: 'diff_25', saving: 25, sameDest: false, gainA: 5, gainB: 5, index: 2 },
      { id: 'same_25', saving: 25, sameDest: true, gainA: 2, gainB: 2, index: 3 },
      { id: 'top_32', saving: 32, sameDest: false, gainA: 0, gainB: 0, index: 4 },
    ], 20);
    expect(ranked.map((p) => p.id)).toEqual(['top_32', 'same_25', 'diff_25']);
  });

  test('stampRouteOrderWithA preserves completed prefix and groupCandidateBuckets keeps only exact 2-visit non-quarantined days', () => {
    const rows = [
      { id: 'c0', status: 'completed', route_order: 1 },
      { id: 's1', status: 'pending', route_order: 2 },
      { id: 's2', status: 'pending', route_order: 3 },
    ];
    const stamped = stampRouteOrderWithA(rows, { id: 'a', status: 'pending', route_order: null }, ['s1', '__candidate__', 's2']);
    expect(Object.fromEntries(stamped.map((r) => [r.id, r.route_order]))).toEqual({ c0: 1, s1: 2, a: 3, s2: 4 });

    const eligible = new Map([
      ['a', { service: { id: 'a', technician_id: 't1', scheduled_date: '2026-12-21' } }],
      ['b', { service: { id: 'b', technician_id: 't1', scheduled_date: '2026-12-21' } }],
      ['c', { service: { id: 'c', technician_id: 't1', scheduled_date: '2026-12-22' } }],
      ['q1', { service: { id: 'q1', technician_id: 't1', scheduled_date: '2026-12-23' } }],
      ['q2', { service: { id: 'q2', technician_id: 't1', scheduled_date: '2026-12-23' } }],
    ]);
    const buckets = groupCandidateBuckets(eligible, new Set(['q1']));
    expect(buckets.map(([k]) => k)).toEqual(['t1|2026-12-21']);
  });

  test('usesArrivalRouting activates under GATE_SCHEDULING_CAPACITY even when arrivalSearch is off', () => {
    const prevCap = process.env.GATE_SCHEDULING_CAPACITY;
    try {
      delete process.env.GATE_SCHEDULING_CAPACITY;
      expect(usesArrivalRouting({ arrivalSearch: 'false' })).toBe(false);
      expect(usesArrivalRouting({ arrivalSearch: 'true' })).toBe(true);
      process.env.GATE_SCHEDULING_CAPACITY = 'true';
      expect(usesArrivalRouting({ arrivalSearch: 'false' })).toBe(true);
    } finally {
      if (prevCap === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = prevCap;
    }
  });

  test('livePairRowsValid rechecks live distinct customer_ids and verifies source route_order under expectedOrder', () => {
    const a = { id: 'a', customer_id: 'c1' };
    const b = { id: 'b', customer_id: 'c2' };
    const good = [
      { id: 'a', technician_id: 't1', customer_id: 'c1', route_order: 2, status: 'pending', visit_id: null, window_start: '10:00:00' },
      { id: 'b', technician_id: 't1', customer_id: 'c2', route_order: 1, status: 'pending', visit_id: null, window_start: '12:00:00' },
    ];
    expect(livePairRowsValid(good, a, b, 't1', null)).toEqual({ routeOrderA: 2, routeOrderB: 1 });
    expect(livePairRowsValid(good, a, b, 't1', { routeOrderA: 2, routeOrderB: 1 })).toEqual({ routeOrderA: 2, routeOrderB: 1 });
    // Source route_order flipped between scoring and commit -> rejected.
    expect(livePairRowsValid(good, a, b, 't1', { routeOrderA: 1, routeOrderB: 2 })).toBeNull();
    // Customer merge turned both rows into the same customer -> rejected.
    const merged = [good[0], { ...good[1], customer_id: 'c1' }];
    expect(livePairRowsValid(merged, a, b, 't1', null)).toBeNull();
  });
});

describe('road-check confirmPairOnRoads', () => {
  const P = (id) => ({ id });
  const keyOf = (from, to) => `${from.id}->${to.id}`;
  const travelFor = (map) => ({
    preload: jest.fn(async () => {}),
    lookup: (leg) => {
      const m = map[keyOf(leg.from, leg.to)];
      return m == null ? { minutes: 10, source: 'conservative_model' } : { minutes: m, source: 'google_traffic' };
    },
  });
  const sourceLegs = {
    date: '2026-12-21', firstDepMin: 525, firstStartMin: 540, firstDurationMin: 60,
    secondStartMin: 600, secondDurationMin: 60, home: P('H'), first: P('A'), second: P('B'),
  };
  const baseConfig = { roadCheckEnabled: true };

  test('confirms different-day pair on real Google roads propagating travel, wait, and service times and fails closed when unavailable', async () => {
    const slotA = { [ROAD_LEGS]: { prev: P('P1'), stop: P('A'), next: P('N1'), date: '2026-12-22', startMin: 600 } };
    const slotB = { [ROAD_LEGS]: { prev: P('P2'), stop: P('B'), next: P('N2'), date: '2026-12-23', startMin: 660 } };
    const pair = {
      sameDest: false,
      slotA,
      slotB,
      splitDestRoadSpecs: [
        {
          date: '2026-12-22', startMin: 600,
          subChain: {
            prev: P('P1'), next: P('N1'), prevDepMin: 585, baseDepMin: 585,
            proposedStops: [{ geo: P('A'), startMin: 600, durationMin: 90 }],
            baselineStops: [],
          },
        },
        {
          date: '2026-12-23', startMin: 660,
          subChain: {
            prev: P('P2'), next: P('N2'), prevDepMin: 645, baseDepMin: 645,
            proposedStops: [{ geo: P('B'), startMin: 660, durationMin: 60 }],
            baselineStops: [],
          },
        },
      ],
      saving: 25,
    };
    const asked = [];
    // Source day propagation:
    //   H->A leaves at 525, takes 20 min -> arrives 545 (> 540), finishes stop 1 at 605.
    //   A->B leaves at 605, takes 15 min -> arrives 620 (> 600, ran into stop 2!), finishes stop 2 at 680.
    //   B->H leaves at 680, takes 18 min -> total source drive = 53 min.
    // Split dest propagation:
    //   Dest A: P1->A@585 (8), A finishes at max(593,600)+90 = 690, A->N1@690 (8), baseline P1->N1@585 (12) -> detour 4 min.
    //   Dest B: P2->B@645 (9), B finishes at max(654,660)+60 = 720, B->N2@720 (9), baseline P2->N2@645 (12) -> detour 6 min.
    const map = {
      'H->A': 20, 'A->B': 15, 'B->H': 18,
      'P1->A': 8, 'A->N1': 8, 'P1->N1': 12,
      'P2->B': 9, 'B->N2': 9, 'P2->N2': 12,
    };
    const travel = {
      preload: jest.fn(async (legs) => { asked.push(...legs); }),
      lookup: travelFor(map).lookup,
    };
    const res = await confirmPairOnRoads([pair], { sourceLegs, floor: 20, config: baseConfig, travel });
    expect(res).toMatchObject({
      pair,
      road: { source_drive_minutes: 53, added_drive_minutes: 10, saving_minutes: 43, source: 'google' },
    });
    // Source legs: 525, 605, 680; split dest A: 585, 690, 585; split dest B: 645, 720, 645.
    expect(asked.map((l) => l.departureMin)).toEqual([525, 605, 680, 585, 690, 585, 645, 720, 645]);
    // Missing Google answer fails closed (null, never commits on straight-line estimate).
    const miss = await confirmPairOnRoads([pair], { sourceLegs, floor: 20, config: baseConfig, travel: travelFor({ 'H->A': 18 }) });
    expect(miss).toBeNull();
    // Road check disabled or travel reader absent also fails closed (minutes-only pair requires real roads).
    expect(await confirmPairOnRoads([pair], { sourceLegs, floor: 20, config: { roadCheckEnabled: false }, travel })).toBeNull();
    expect(await confirmPairOnRoads([pair], { sourceLegs, floor: 20, config: baseConfig, travel: null })).toBeNull();
  });

  test('confirms same-day adjacent and disjoint sub-chain detours carrying delays across intervening stops', async () => {
    const adjPair = {
      sameDest: true,
      sameDestRoadSpec: {
        date: '2026-12-22', startMin: 600,
        subChain: {
          prev: P('D1'), next: P('D2'), prevDepMin: 585, baseDepMin: 585,
          proposedStops: [
            { geo: P('A'), startMin: 600, durationMin: 90 },
            { geo: P('B'), startMin: 660, durationMin: 60 },
          ],
          baselineStops: [],
        },
      },
      saving: 30,
    };
    // Source: H->A (18 at 525 -> arrive 543, start 543, dep2 603), A->B (2 -> arrive 605, start 605, dep3 665), B->H (18) = 38 min.
    // Adjacent dest propagation:
    //   D1->A@585 (6) -> arrive 591, wait to 600, finish A at 690 (90 min job ran past B's 660 window!).
    //   A->B@690 (2) -> arrive 692, start B at 692, finish B at 752.
    //   B->D2@752 (12); baseline D1->D2@585 (12) -> added = 6 + 2 + 12 - 12 = 8 min -> saving = 30.
    const adjAsked = [];
    const adjMap = { 'H->A': 18, 'A->B': 2, 'B->H': 18, 'D1->A': 6, 'B->D2': 12, 'D1->D2': 12 };
    const adjTravel = {
      preload: jest.fn(async (legs) => { adjAsked.push(...legs); }),
      lookup: travelFor(adjMap).lookup,
    };
    const adjRes = await confirmPairOnRoads([adjPair], { sourceLegs, floor: 20, config: baseConfig, travel: adjTravel });
    expect(adjRes.road).toEqual({ source_drive_minutes: 38, added_drive_minutes: 8, saving_minutes: 30, source: 'google' });
    // Adjacent dest legs (after the 3 source legs): D1->A@585, A->B@690, B->D2@752, baseline D1->D2@585.
    expect(adjAsked.slice(3).map((l) => l.departureMin)).toEqual([585, 690, 752, 585]);

    const disjPair = {
      sameDest: true,
      sameDestRoadSpec: {
        date: '2026-12-22', startMin: 540,
        subChain: {
          prev: P('H'), next: P('H'), prevDepMin: 525, baseDepMin: 640,
          proposedStops: [
            { geo: P('A'), startMin: 540, durationMin: 120 },
            { geo: P('D1'), startMin: 660, durationMin: 60 },
            { geo: P('B'), startMin: 720, durationMin: 60 },
          ],
          baselineStops: [
            { geo: P('D1'), startMin: 660, durationMin: 60 },
          ],
        },
      },
      saving: 22,
    };
    // Proposed: H->A@525 (10 -> start 540, dep 660), A->D1@660 (15 -> arrive 675 > 660! D1 delayed -> dep 735),
    //   D1->B@735 (6 -> arrive 741 > 720! B delayed -> dep 801), B->H@801 (10) = 41 min.
    // Baseline: H->D1@640 (12 -> start 660, dep 720), D1->H@720 (12) = 24 min.
    // Added = 41 - 24 = 17 min -> saving = 38 - 17 = 21 >= 20.
    const disjAsked = [];
    const disjMap = { 'H->A': 10, 'A->D1': 15, 'D1->B': 6, 'B->H': 10, 'H->D1': 12, 'D1->H': 12 };
    const travelDateAware = {
      preload: jest.fn(async (legs) => { disjAsked.push(...legs); }),
      lookup: (leg) => {
        if (leg.date === '2026-12-21') {
          const m = { 'H->A': 18, 'A->B': 2, 'B->H': 18 }[keyOf(leg.from, leg.to)];
          return { minutes: m, source: 'google_traffic' };
        }
        const m = disjMap[keyOf(leg.from, leg.to)];
        return { minutes: m, source: 'google_traffic' };
      },
    };
    const disjRes = await confirmPairOnRoads([disjPair], { sourceLegs, floor: 20, config: baseConfig, travel: travelDateAware });
    expect(disjRes.road).toEqual({ source_drive_minutes: 38, added_drive_minutes: 17, saving_minutes: 21, source: 'google' });
    // Delay from A propagated through D1 (735) and B (801), while baseline D1 departed on time at 720.
    expect(disjAsked.slice(3).map((l) => l.departureMin)).toEqual([525, 660, 735, 801, 640, 720]);
  });
});

describe('runTwoStopClearPass orchestration safety', () => {
  const savedGate = process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
  beforeAll(() => { process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true'; });
  afterAll(() => {
    if (savedGate === undefined) delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
    else process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = savedGate;
  });

  const db = require('../models/db');
  const candidateSlots = require('../services/auto-dispatch/candidate-slots');
  const southDayKept = require('../services/auto-dispatch/south-day-kept');
  const roadCheck = require('../services/auto-dispatch/road-check');
  const { runTwoStopClearPass } = require('../services/auto-dispatch/two-stop-clear');

  function makeChain(rows) {
    const c = {};
    ['where', 'whereIn', 'whereNotIn', 'whereNotNull', 'whereNull', 'orWhereNull', 'whereRaw', 'leftJoin'].forEach((m) => { c[m] = () => c; });
    c.select = async () => rows;
    return c;
  }

  function mockPairDb(svcA, svcB) {
    const sourceRows = [
      { id: svcA.id, technician_id: 'tech-1', customer_id: 'cust-a', route_order: 1, status: 'pending', visit_id: null, window_start: '10:00:00' },
      { id: svcB.id, technician_id: 'tech-1', customer_id: 'cust-b', route_order: 2, status: 'pending', visit_id: null, window_start: '12:00:00' },
    ];
    const destRows = [
      { id: 'dest-a1', technician_id: 'tech-1', scheduled_date: '2026-12-22', status: 'pending', window_start: '09:00:00', window_end: '10:00:00', estimated_duration_minutes: 60, route_order: 1, svc_lat: NORTH_EXIST.lat, svc_lng: NORTH_EXIST.lng },
      { id: 'dest-b1', technician_id: 'tech-1', scheduled_date: '2026-12-23', status: 'pending', window_start: '09:00:00', window_end: '10:00:00', estimated_duration_minutes: 60, route_order: 1, svc_lat: NORTH_EXIST.lat, svc_lng: NORTH_EXIST.lng },
    ];
    let calls = 0;
    db.mockImplementation(() => {
      calls += 1;
      return makeChain(calls === 1 ? sourceRows : destRows);
    });
  }

  function makeFixture(mode = 'apply', maxChangesPerRun = 10) {
    const svcA = {
      id: 'svc-a', customer_id: 'cust-a', property_id: 'prop-a', technician_id: 'tech-1',
      scheduled_date: '2026-12-21', window_start: '10:00:00', window_end: '11:00:00',
      estimated_duration_minutes: 60, status: 'pending', visit_id: null, auto_dispatch_change_count: 0,
      customer_latitude: NORTH_A.lat, customer_longitude: NORTH_A.lng,
    };
    const svcB = {
      id: 'svc-b', customer_id: 'cust-b', property_id: 'prop-b', technician_id: 'tech-1',
      scheduled_date: '2026-12-21', window_start: '12:00:00', window_end: '13:00:00',
      estimated_duration_minutes: 60, status: 'pending', visit_id: null, auto_dispatch_change_count: 0,
      customer_latitude: NORTH_B.lat, customer_longitude: NORTH_B.lng,
    };
    const prefs = { preferred_day_indexes: [], preferred_time_window: null, effective_time_window: null, raw_snapshot: {} };
    const ctx = { db, nowDate: new Date('2026-11-27T09:00:00Z'), lookaheadDays: 45, recentLeftDates: null, startPoints: new Map() };
    const entryA = { service: svcA, prefs, ctx, evalResult: { kind: 'no_change', audit: {} }, noChange: { reason_code: 'NO_SCORE_IMPROVEMENT' } };
    const entryB = { service: svcB, prefs, ctx, evalResult: { kind: 'no_change', audit: {} }, noChange: { reason_code: 'NO_SCORE_IMPROVEMENT' } };
    const run = {
      runId: 'run-1',
      config: {
        mode, maxChangesPerRun, minDayMoveDriveSavingMinutes: 6, minutesRuleSavingMinutes: 10,
        minutesRuleSecondMoveSavingMinutes: 15, minScoreImprovement: 15, removeStabilityFloor: 20,
        roadCheckEnabled: true, arrivalSearch: 'false',
      },
      nowDate: new Date('2026-11-27T09:00:00Z'),
      lockBoundary: '2026-12-10',
      totals: { changed: 0, recommended: 0, failed: 0 },
      pairEligible: new Map([['svc-a', entryA], ['svc-b', entryB]]),
      claimedPairIds: new Set(),
      quarantinedIds: new Set(),
      conflicts: new Map(),
      roadTravel: {},
    };
    const slotA = {
      date: '2026-12-22', start_time: '10:00', end_time: '11:00', technician_id: 'tech-1',
      detour_minutes: 4, stops_that_day: 3, same_area_share: 0.8, route_minutes: 300, capability_level: 'qualified',
      [ROAD_LEGS]: { prev: HQ, stop: NORTH_A, next: HQ, date: '2026-12-22', startMin: 600 },
    };
    const slotB = {
      date: '2026-12-23', start_time: '11:00', end_time: '12:00', technician_id: 'tech-1',
      detour_minutes: 4, stops_that_day: 3, same_area_share: 0.8, route_minutes: 300, capability_level: 'qualified',
      [ROAD_LEGS]: { prev: HQ, stop: NORTH_B, next: HQ, date: '2026-12-23', startMin: 660 },
    };
    return { svcA, svcB, run, slotA, slotB };
  }

  afterEach(() => { jest.restoreAllMocks(); });

  test('does not commit A when proofreader holds B', async () => {
    const { svcA, svcB, run, slotA, slotB } = makeFixture('apply', 10);
    mockPairDb(svcA, svcB);
    jest.spyOn(candidateSlots, 'findValidCandidateSlots')
      .mockResolvedValueOnce({ current: { is_current: true, date: '2026-12-21', start_time: '10:00', technician_id: 'tech-1', detour_minutes: 4, stops_that_day: 2, route_minutes: 180, capability_level: 'qualified' }, candidates: [slotA] })
      .mockResolvedValueOnce({ current: { is_current: true, date: '2026-12-21', start_time: '12:00', technician_id: 'tech-1', detour_minutes: 4, stops_that_day: 2, route_minutes: 180, capability_level: 'qualified' }, candidates: [slotB] });
    jest.spyOn(southDayKept, 'ruleFor').mockResolvedValue(null);
    jest.spyOn(roadCheck, 'confirmPairOnRoads').mockImplementation(async (pairs) => ({ pair: pairs[0], road: { source_drive_minutes: 38, added_drive_minutes: 8, saving_minutes: 30, source: 'google' } }));

    const commitAtomicPair = jest.fn(async () => true);
    const checkProofreader = jest.fn()
      .mockResolvedValueOnce({ ok: true, checked: { allowed: true } })
      .mockResolvedValueOnce({ ok: false, checked: { allowed: false } });
    const helpers = {
      recheckPairEntry: jest.fn(async () => true),
      checkProofreader,
      preferencesChanged: jest.fn(async () => false),
      buildPlacementAudit: jest.fn(() => ({ improvement: 5, newPlacement: {}, scores: {}, routeMetrics: {}, constraints: {} })),
      commitAtomicPair,
      logDryRunPair: jest.fn(),
    };

    const cleared = await runTwoStopClearPass(run, helpers);
    expect(cleared).toBe(0);
    expect(checkProofreader).toHaveBeenCalledTimes(2);
    expect(commitAtomicPair).not.toHaveBeenCalled();
  });

  test('skips pair clearing when fewer than 2 changes remain in the per-run cap', async () => {
    const { run } = makeFixture('apply', 5);
    run.totals.changed = 4; // only 1 slot left
    const helpers = {
      recheckPairEntry: jest.fn(async () => true),
      checkProofreader: jest.fn(),
      preferencesChanged: jest.fn(),
      buildPlacementAudit: jest.fn(),
      commitAtomicPair: jest.fn(),
      logDryRunPair: jest.fn(),
    };
    const cleared = await runTwoStopClearPass(run, helpers);
    expect(cleared).toBe(0);
    expect(helpers.recheckPairEntry).not.toHaveBeenCalled();
  });

  test('commits both A and B atomically when road check and proofreader allow both', async () => {
    const { svcA, svcB, run, slotA, slotB } = makeFixture('apply', 10);
    mockPairDb(svcA, svcB);
    jest.spyOn(candidateSlots, 'findValidCandidateSlots')
      .mockResolvedValueOnce({ current: { is_current: true, date: '2026-12-21', start_time: '10:00', technician_id: 'tech-1', detour_minutes: 4, stops_that_day: 2, route_minutes: 180, capability_level: 'qualified' }, candidates: [slotA] })
      .mockResolvedValueOnce({ current: { is_current: true, date: '2026-12-21', start_time: '12:00', technician_id: 'tech-1', detour_minutes: 4, stops_that_day: 2, route_minutes: 180, capability_level: 'qualified' }, candidates: [slotB] });
    jest.spyOn(southDayKept, 'ruleFor').mockResolvedValue(null);
    jest.spyOn(roadCheck, 'confirmPairOnRoads').mockImplementation(async (pairs) => ({ pair: pairs[0], road: { source_drive_minutes: 38, added_drive_minutes: 8, saving_minutes: 30, source: 'google' } }));

    const commitAtomicPair = jest.fn(async ({ entryA, entryB, run: r }) => {
      r.claimedPairIds.add(entryA.service.id);
      r.claimedPairIds.add(entryB.service.id);
      return true;
    });
    const helpers = {
      recheckPairEntry: jest.fn(async () => true),
      checkProofreader: jest.fn(async () => ({ ok: true, checked: null })),
      preferencesChanged: jest.fn(async () => false),
      buildPlacementAudit: jest.fn(() => ({ improvement: 5, newPlacement: {}, scores: {}, routeMetrics: {}, constraints: {} })),
      commitAtomicPair,
      logDryRunPair: jest.fn(),
    };

    const cleared = await runTwoStopClearPass(run, helpers);
    expect(cleared).toBe(1);
    expect(commitAtomicPair).toHaveBeenCalledTimes(1);
    expect(helpers.preferencesChanged).toHaveBeenCalledTimes(2);
    expect([...run.claimedPairIds]).toEqual(['svc-a', 'svc-b']);
  });

  test('rechecks BOTH customers preferences before commit even when proofreader is off', async () => {
    const { svcA, svcB, run, slotA, slotB } = makeFixture('apply', 10);
    mockPairDb(svcA, svcB);
    jest.spyOn(candidateSlots, 'findValidCandidateSlots')
      .mockResolvedValueOnce({ current: { is_current: true, date: '2026-12-21', start_time: '10:00', technician_id: 'tech-1', detour_minutes: 4, stops_that_day: 2, route_minutes: 180, capability_level: 'qualified' }, candidates: [slotA] })
      .mockResolvedValueOnce({ current: { is_current: true, date: '2026-12-21', start_time: '12:00', technician_id: 'tech-1', detour_minutes: 4, stops_that_day: 2, route_minutes: 180, capability_level: 'qualified' }, candidates: [slotB] });
    jest.spyOn(southDayKept, 'ruleFor').mockResolvedValue(null);
    jest.spyOn(roadCheck, 'confirmPairOnRoads').mockImplementation(async (pairs) => ({ pair: pairs[0], road: { source_drive_minutes: 38, added_drive_minutes: 8, saving_minutes: 30, source: 'google' } }));

    const logPairSuperseded = jest.fn(async () => {});
    const commitAtomicPair = jest.fn();
    const helpers = {
      recheckPairEntry: jest.fn(async () => true),
      checkProofreader: jest.fn(async () => ({ ok: true, checked: null })),
      preferencesChanged: jest.fn(async (entry) => entry.service.id === 'svc-b'),
      logPairSuperseded,
      buildPlacementAudit: jest.fn(() => ({ improvement: 5, newPlacement: {}, scores: {}, routeMetrics: {}, constraints: {} })),
      commitAtomicPair,
      logDryRunPair: jest.fn(),
    };

    const cleared = await runTwoStopClearPass(run, helpers);
    expect(cleared).toBe(0);
    expect(commitAtomicPair).not.toHaveBeenCalled();
    expect(logPairSuperseded).toHaveBeenCalledTimes(1);
    expect(logPairSuperseded.mock.calls[0][0].service.id).toBe('svc-b');
  });

  test('marks run degraded and records pair evaluation error when an evaluation throws', async () => {
    const { run } = makeFixture('apply', 10);
    db.mockImplementation(() => { throw new Error('db connection lost'); });
    const recordPairError = jest.fn(async (a, b, err, r) => {
      r.totals.failed += 1;
      r.claimedPairIds.add(a.service.id);
      r.claimedPairIds.add(b.service.id);
    });
    const helpers = {
      recheckPairEntry: jest.fn(),
      checkProofreader: jest.fn(),
      preferencesChanged: jest.fn(),
      recordPairError,
      buildPlacementAudit: jest.fn(),
      commitAtomicPair: jest.fn(),
      logDryRunPair: jest.fn(),
    };

    const cleared = await runTwoStopClearPass(run, helpers);
    expect(cleared).toBe(0);
    expect(run.guardReadDegraded).toBe(true);
    expect(recordPairError).toHaveBeenCalledTimes(1);
    expect(run.totals.failed).toBe(1);
    expect([...run.claimedPairIds]).toEqual(['svc-a', 'svc-b']);
  });

  test('attributes a B-triggered pair rollback to B and logs rollback for both visits', async () => {
    const audit = require('../services/auto-dispatch/audit');
    const logSpy = jest.spyOn(audit, 'logDecision').mockResolvedValue();
    const { _internals: { recordPairCommitFailure } } = require('../services/auto-dispatch/index');
    const { svcA, svcB, run } = makeFixture('apply', 10);
    const evalA = { audit: { constraints: {} } };
    const evalB = { audit: { constraints: {} } };
    const err = Object.assign(new Error('Slot taken for B'), { code: 'SLOT_TAKEN', failedServiceId: 'svc-b' });

    await recordPairCommitFailure({
      entryA: { service: svcA }, evalA, checkedA: null,
      entryB: { service: svcB }, evalB, checkedB: null,
      applyErr: err, run,
    });

    expect([...run.claimedPairIds]).toEqual(['svc-a', 'svc-b']);
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0][1]).toMatchObject({ action: 'no_change', service: svcB, reason_code: 'SLOT_TAKEN', reason_description: 'Slot taken for B' });
    expect(logSpy.mock.calls[1][1]).toMatchObject({ action: 'no_change', service: svcA, reason_code: 'SLOT_TAKEN' });
    expect(logSpy.mock.calls[1][1].reason_description).toContain('svc-b');
  });

  test('applyAutoDispatchPairMove rolls back transaction, pins customer/duration, and skips postCommit when B fails after A writes', async () => {
    const SmartRebooker = require('../services/rebooker');
    const occupancy = require('../services/scheduling/occupancy');
    const techDayLock = require('../services/scheduling/tech-day-lock');
    const { applyAutoDispatchPairMove } = require('../services/auto-dispatch/apply');
    const { svcA, svcB, slotA, slotB } = makeFixture('apply', 10);

    const freshA = { ...svcA, auto_dispatch_locked: false, auto_dispatch_excluded: false };
    const freshB = { ...svcB, auto_dispatch_locked: false, auto_dispatch_excluded: false };
    db.mockImplementation(() => ({
      where: ({ id }) => ({ first: async () => (id === svcA.id ? freshA : freshB) }),
    }));
    const state = { aDate: svcA.scheduled_date, bDate: svcB.scheduled_date, rolledBack: false };
    const fakeTrx = { isPairTrx: true };
    db.transaction = jest.fn(async (cb) => {
      const snapA = state.aDate;
      const snapB = state.bDate;
      try {
        return await cb(fakeTrx);
      } catch (err) {
        state.aDate = snapA;
        state.bDate = snapB;
        state.rolledBack = true;
        throw err;
      }
    });
    jest.spyOn(occupancy, 'acquireOccupancyLock').mockResolvedValue();
    jest.spyOn(techDayLock, 'lockTechDays').mockResolvedValue();
    const postCommitA = jest.fn();
    const seenOpts = [];
    jest.spyOn(SmartRebooker, 'reschedule').mockImplementation(async (id, newDate, _win, _r, _init, opts) => {
      seenOpts.push({ id, opts });
      if (id === svcA.id) {
        state.aDate = newDate;
        return { ok: true, landedStatus: 'pending', postCommit: postCommitA };
      }
      throw Object.assign(new Error('B slot lost'), { code: 'SLOT_TAKEN' });
    });

    await expect(applyAutoDispatchPairMove(
      { service: svcA, best: slotA, config: {} },
      { service: svcB, best: slotB, config: {} },
      'run-1',
      { sourceTechId: 'tech-1', sourceDate: '2026-12-21', verifySourceInTrx: async () => true },
    )).rejects.toMatchObject({ code: 'SLOT_TAKEN', failedServiceId: svcB.id });

    expect(state.rolledBack).toBe(true);
    expect(state.aDate).toBe('2026-12-21');
    expect(state.bDate).toBe('2026-12-21');
    expect(postCommitA).not.toHaveBeenCalled();
    expect(seenOpts[0].opts.trx).toBe(fakeTrx);
    expect(seenOpts[0].opts.expect).toMatchObject({ customer_id: 'cust-a', estimated_duration_minutes: 60 });
    expect(seenOpts[1].opts.trx).toBe(fakeTrx);
    expect(seenOpts[1].opts.expect).toMatchObject({ customer_id: 'cust-b', estimated_duration_minutes: 60 });
  });
});
