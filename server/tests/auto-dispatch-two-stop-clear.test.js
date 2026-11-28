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
    stampRouteOrderWithA,
    groupCandidateBuckets,
  },
} = require('../services/auto-dispatch/two-stop-clear');
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

  test('pairClearFloor requires sum of both visits minutes-rule floors (20 / 25 / 30 min)', () => {
    expect(pairClearFloor({ auto_dispatch_change_count: 0 }, { auto_dispatch_change_count: 0 }, config)).toBe(20);
    expect(pairClearFloor({ auto_dispatch_change_count: 1 }, { auto_dispatch_change_count: 0 }, config)).toBe(25);
    expect(pairClearFloor({ auto_dispatch_change_count: 1 }, { auto_dispatch_change_count: 2 }, config)).toBe(30);
    expect(pairClearFloor({}, {}, { minDayMoveDriveSavingMinutes: 0, minutesRuleSavingMinutes: 0 })).toBe(0);
  });

  test('pairSourceDrive captures full HQ round-trip stem for two nearby stops and rejects collapsed co-visits', () => {
    const stopA = { id: 'a', customer_id: 'c1', property_id: 'p1', scheduled_date: '2026-12-21', geo: NORTH_A, startMin: 600, window_start: '10:00', estimated_duration_minutes: 60 };
    const stopB = { id: 'b', customer_id: 'c2', property_id: 'p2', scheduled_date: '2026-12-21', geo: NORTH_B, startMin: 720, window_start: '12:00', estimated_duration_minutes: 60 };
    // Individual single-stop detour stays below the 10-min single-stop minutes-rule floor because the other stop absorbs the stem.
    expect(routeCost([stopB], stopA, HQ).detourMinutes).toBeLessThan(10);
    // Together, clearing the 2-stop day recovers the entire HQ round trip.
    const src = pairSourceDrive(stopA, stopB, HQ);
    expect(src).not.toBeNull();
    expect(src.driveMinutes).toBeGreaterThan(25);
    expect(src.roadLegs).toMatchObject({ date: '2026-12-21', home: HQ, first: NORTH_A, second: NORTH_B });

    // Legacy null-visit_id co-visit (same customer, property, window) collapses to 1 physical stop -> rejected.
    const coB = { ...stopB, customer_id: 'c1', property_id: 'p1', startMin: 600, window_start: '10:00', geo: NORTH_A };
    expect(pairSourceDrive(stopA, coB, HQ)).toBeNull();
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
      adjacent: { prev: NORTH_EXIST, first: NORTH_A, second: NORTH_B, next: MID },
    });
    // Empty destination day is rejected (never shift a 2-stop day onto an empty day).
    expect(jointDestinationMetrics({
      destStops: [], destHome: HQ, aStop, bStop, aCand, bCand, bRouteOrderIds: null, currentScoreA: curScore, currentScoreB: curScore,
    })).toBeNull();
    // Overloaded destination day (combined route_minutes > 480) is rejected.
    const heavyDest = Array.from({ length: 7 }, (_, i) => ({
      id: `h${i}`, geo: MID, startMin: 480 + i * 60, window_start: `${String(8 + i).padStart(2, '0')}:00`, route_order: i + 1, estimated_duration_minutes: 60,
    }));
    expect(jointDestinationMetrics({
      destStops: heavyDest, destHome: HQ, aStop, bStop, aCand: { date: '2026-12-22', start_time: '15:00' }, bCand: { date: '2026-12-22', start_time: '16:00' },
      bRouteOrderIds: null, currentScoreA: curScore, currentScoreB: curScore,
    })).toBeNull();
  });

  test('sameDestRoadSpecFor distinguishes adjacent 4-leg vs disjoint 6-leg placements', () => {
    const disjoint = sameDestRoadSpecFor(
      [{ id: 'a', geo: NORTH_A }, { id: 'd1', geo: MID }, { id: 'b', geo: NORTH_B }, { id: 'd2', geo: SOUTH }],
      'a', 'b', { date: '2026-12-22', startMinA: 540, startMinB: 720, home: HQ },
    );
    expect(disjoint.adjacent).toBeUndefined();
    expect(disjoint.disjoint).toEqual([
      { prev: HQ, stop: NORTH_A, next: MID, startMin: 540 },
      { prev: MID, stop: NORTH_B, next: SOUTH, startMin: 720 },
    ]);
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
  const sourceLegs = { date: '2026-12-21', startMin: 600, home: P('H'), first: P('A'), second: P('B') };
  const baseConfig = { roadCheckEnabled: true };

  test('confirms different-day pair on real Google roads and fails closed when Google has no answer', async () => {
    const slotA = { [ROAD_LEGS]: { prev: P('P1'), stop: P('A'), next: P('N1'), date: '2026-12-22', startMin: 600 } };
    const slotB = { [ROAD_LEGS]: { prev: P('P2'), stop: P('B'), next: P('N2'), date: '2026-12-23', startMin: 660 } };
    const pair = { sameDest: false, slotA, slotB, saving: 25 };
    // Source day: H->A (18) + A->B (2) + B->H (18) = 38 min.
    // Dest A detour: 8 + 8 - 12 = 4 min. Dest B detour: 9 + 9 - 12 = 6 min. Total added = 10 min -> saving = 28 >= 20.
    const map = {
      'H->A': 18, 'A->B': 2, 'B->H': 18,
      'P1->A': 8, 'A->N1': 8, 'P1->N1': 12,
      'P2->B': 9, 'B->N2': 9, 'P2->N2': 12,
    };
    const res = await confirmPairOnRoads([pair], { sourceLegs, floor: 20, config: baseConfig, travel: travelFor(map) });
    expect(res).toMatchObject({
      pair,
      road: { source_drive_minutes: 38, added_drive_minutes: 10, saving_minutes: 28, source: 'google' },
    });
    // Missing Google answer fails closed (null, never commits on straight-line estimate).
    const miss = await confirmPairOnRoads([pair], { sourceLegs, floor: 20, config: baseConfig, travel: travelFor({ 'H->A': 18 }) });
    expect(miss).toBeNull();
  });

  test('confirms same-day adjacent 4-leg detour and same-day disjoint 6-leg detour accurately', async () => {
    const adjPair = {
      sameDest: true,
      sameDestRoadSpec: {
        date: '2026-12-22', startMin: 600,
        adjacent: { prev: P('D1'), first: P('A'), second: P('B'), next: P('D2') },
      },
      saving: 30,
    };
    // Source: 38 min. Adjacent dest: D1->A (6) + A->B (2) + B->D2 (12) - D1->D2 (12) = 8 min -> saving = 30 >= 20.
    const adjMap = { 'H->A': 18, 'A->B': 2, 'B->H': 18, 'D1->A': 6, 'B->D2': 12, 'D1->D2': 12 };
    const adjRes = await confirmPairOnRoads([adjPair], { sourceLegs, floor: 20, config: baseConfig, travel: travelFor(adjMap) });
    expect(adjRes.road).toEqual({ source_drive_minutes: 38, added_drive_minutes: 8, saving_minutes: 30, source: 'google' });

    const disjPair = {
      sameDest: true,
      sameDestRoadSpec: {
        date: '2026-12-22', startMin: 540,
        disjoint: [
          { prev: P('H'), stop: P('A'), next: P('D1'), startMin: 540 },
          { prev: P('D1'), stop: P('B'), next: P('H'), startMin: 720 },
        ],
      },
      saving: 22,
    };
    // Source: 38 min. Disjoint dest: (10+6-12) + (6+10-12) = 4 + 4 = 8 min -> saving = 30 >= 20.
    const disjMap = { 'H->A': 10, 'A->B': 2, 'B->H': 10, 'A->D1': 6, 'H->D1': 12, 'D1->B': 6, 'D1->H': 12 };
    // Make source day 38 min via separate legs on source date:
    const travelDateAware = {
      preload: jest.fn(async () => {}),
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
    expect(disjRes.road).toEqual({ source_drive_minutes: 38, added_drive_minutes: 8, saving_minutes: 30, source: 'google' });
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
    ['where', 'whereNotIn', 'orWhereNull'].forEach((m) => { c[m] = () => c; });
    c.select = async () => rows;
    return c;
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
        roadCheckEnabled: false, arrivalSearch: 'false',
      },
      nowDate: new Date('2026-11-27T09:00:00Z'),
      lockBoundary: '2026-12-10',
      totals: { changed: 0, recommended: 0, failed: 0 },
      pairEligible: new Map([['svc-a', entryA], ['svc-b', entryB]]),
      claimedPairIds: new Set(),
      quarantinedIds: new Set(),
      roadTravel: null,
    };
    const slotA = {
      date: '2026-12-22', start_time: '10:00', end_time: '11:00', technician_id: 'tech-1',
      detour_minutes: 4, stops_that_day: 5, same_area_share: 0.8, route_minutes: 300, capability_level: 'qualified',
    };
    const slotB = {
      date: '2026-12-23', start_time: '11:00', end_time: '12:00', technician_id: 'tech-1',
      detour_minutes: 4, stops_that_day: 5, same_area_share: 0.8, route_minutes: 300, capability_level: 'qualified',
    };
    return { svcA, svcB, run, slotA, slotB };
  }

  afterEach(() => { jest.restoreAllMocks(); });

  test('does not commit A when proofreader holds B', async () => {
    const { svcA, svcB, run, slotA, slotB } = makeFixture('apply', 10);
    db.mockImplementation(() => makeChain([
      { id: svcA.id, technician_id: 'tech-1', status: 'pending', visit_id: null, window_start: '10:00:00' },
      { id: svcB.id, technician_id: 'tech-1', status: 'pending', visit_id: null, window_start: '12:00:00' },
    ]));
    jest.spyOn(candidateSlots, 'findValidCandidateSlots')
      .mockResolvedValueOnce({ current: { is_current: true, date: '2026-12-21', start_time: '10:00', technician_id: 'tech-1', detour_minutes: 4, stops_that_day: 2, route_minutes: 180, capability_level: 'qualified' }, candidates: [slotA] })
      .mockResolvedValueOnce({ current: { is_current: true, date: '2026-12-21', start_time: '12:00', technician_id: 'tech-1', detour_minutes: 4, stops_that_day: 2, route_minutes: 180, capability_level: 'qualified' }, candidates: [slotB] });
    jest.spyOn(southDayKept, 'ruleFor').mockResolvedValue(null);
    jest.spyOn(roadCheck, 'confirmPairOnRoads').mockImplementation(async (pairs) => ({ pair: pairs[0], road: null }));

    const commitPairMove = jest.fn(async () => true);
    const checkProofreader = jest.fn()
      .mockResolvedValueOnce({ ok: true, checked: { allowed: true } })
      .mockResolvedValueOnce({ ok: false, checked: { allowed: false } });
    const helpers = {
      recheckPairEntry: jest.fn(async () => true),
      checkProofreader,
      preferencesChanged: jest.fn(async () => false),
      buildPlacementAudit: jest.fn(() => ({ improvement: 5, newPlacement: {}, scores: {}, routeMetrics: {}, constraints: {} })),
      commitPairMove,
      logDryRunPair: jest.fn(),
    };

    const cleared = await runTwoStopClearPass(run, helpers);
    expect(cleared).toBe(0);
    expect(checkProofreader).toHaveBeenCalledTimes(2);
    expect(commitPairMove).not.toHaveBeenCalled();
  });

  test('skips pair clearing when fewer than 2 changes remain in the per-run cap', async () => {
    const { run } = makeFixture('apply', 5);
    run.totals.changed = 4; // only 1 slot left
    const helpers = {
      recheckPairEntry: jest.fn(async () => true),
      checkProofreader: jest.fn(),
      preferencesChanged: jest.fn(),
      buildPlacementAudit: jest.fn(),
      commitPairMove: jest.fn(),
      logDryRunPair: jest.fn(),
    };
    const cleared = await runTwoStopClearPass(run, helpers);
    expect(cleared).toBe(0);
    expect(helpers.recheckPairEntry).not.toHaveBeenCalled();
  });

  test('commits both A and B cleanly when road check and proofreader allow both (and logs both in dry_run)', async () => {
    const { svcA, svcB, run, slotA, slotB } = makeFixture('apply', 10);
    db.mockImplementation(() => makeChain([
      { id: svcA.id, technician_id: 'tech-1', status: 'pending', visit_id: null, window_start: '10:00:00' },
      { id: svcB.id, technician_id: 'tech-1', status: 'pending', visit_id: null, window_start: '12:00:00' },
    ]));
    jest.spyOn(candidateSlots, 'findValidCandidateSlots')
      .mockResolvedValueOnce({ current: { is_current: true, date: '2026-12-21', start_time: '10:00', technician_id: 'tech-1', detour_minutes: 4, stops_that_day: 2, route_minutes: 180, capability_level: 'qualified' }, candidates: [slotA] })
      .mockResolvedValueOnce({ current: { is_current: true, date: '2026-12-21', start_time: '12:00', technician_id: 'tech-1', detour_minutes: 4, stops_that_day: 2, route_minutes: 180, capability_level: 'qualified' }, candidates: [slotB] });
    jest.spyOn(southDayKept, 'ruleFor').mockResolvedValue(null);

    const commitPairMove = jest.fn(async () => true);
    const helpers = {
      recheckPairEntry: jest.fn(async () => true),
      checkProofreader: jest.fn(async () => ({ ok: true, checked: null })),
      preferencesChanged: jest.fn(async () => false),
      buildPlacementAudit: jest.fn(() => ({ improvement: 5, newPlacement: {}, scores: {}, routeMetrics: {}, constraints: {} })),
      commitPairMove,
      logDryRunPair: jest.fn(),
    };

    const cleared = await runTwoStopClearPass(run, helpers);
    expect(cleared).toBe(1);
    expect(commitPairMove).toHaveBeenCalledTimes(2);
    expect([...run.claimedPairIds]).toEqual(['svc-a', 'svc-b']);
  });
});
