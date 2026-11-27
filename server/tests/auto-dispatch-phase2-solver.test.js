/**
 * Phase 2 solver fixes:
 * - route-model insertByWindow / scoreOnSharedModel insertByTime (standalone vs grouped)
 * - minutesRuleOk non-regression (workload guard without synthetic gain > 0 veto)
 * - drive-saving-first candidate ranking & pass-2 budget ordering
 */
const { routeCost, chainDriveMinutes, _internals: { insertByWindow, insertByRouteOrder } } = require('../services/auto-dispatch/route-model');
const { rankCandidates } = require('../services/auto-dispatch/move-rules');
const { scoreAppointmentPlacement } = require('../services/auto-dispatch/scoring');

const NORTH = { lat: 27.56, lng: -82.45 };
const SOUTH = { lat: 27.20, lng: -82.45 };
const NEAR_NORTH = { lat: 27.555, lng: -82.452 };

describe('Phase 2: chronological window insertion avoids 999 append penalty on numbered days', () => {
  test('insertByWindow places a morning candidate ahead of later numbered stops', () => {
    const seq = [
      { id: 's1', geo: NORTH, startMin: 540, window_start: '09:00', route_order: 1 },
      { id: 's2', geo: SOUTH, startMin: 780, window_start: '13:00', route_order: 2 },
    ];
    const placed = insertByWindow(seq, { id: 'v', geo: NEAR_NORTH, startMin: 600, route_order: null });
    expect(placed.map((s) => s.id)).toEqual(['s1', 'v', 's2']);
  });

  test('routeCost with insertByTime measures real inserted detour instead of end-of-day backtracking', () => {
    const dayStops = [
      { id: 's1', geo: NORTH, startMin: 540, window_start: '09:00', route_order: 1 },
      { id: 's2', geo: SOUTH, startMin: 780, window_start: '13:00', route_order: 2 },
    ];
    const appended = routeCost(dayStops, { id: 'v', geo: NEAR_NORTH, startMin: 600, route_order: null });
    const inserted = routeCost(dayStops, { id: 'v', geo: NEAR_NORTH, startMin: 600, route_order: null, insertByTime: true });
    expect(appended.driveWithMinutes).toBeCloseTo(chainDriveMinutes([NORTH, SOUTH, NEAR_NORTH]), 5);
    expect(inserted.driveWithMinutes).toBeCloseTo(chainDriveMinutes([NORTH, NEAR_NORTH, SOUTH]), 5);
    expect(inserted.detourMinutes).toBeLessThan(appended.detourMinutes - 15);
    expect(inserted.neighbours).toEqual({ prev: NORTH, stop: NEAR_NORTH, next: SOUTH });
  });

  test('insertByRouteOrder prices the exact solver order when arrival windows overlap (fallback to insertByWindow otherwise)', () => {
    const dayStops = [
      { id: 's1', geo: NORTH, startMin: 600, window_start: '10:00', route_order: 1 },
      { id: 's2', geo: SOUTH, startMin: 630, window_start: '10:30', route_order: 2 },
    ];
    // Candidate at 11:00 sits near s1; arrival-route inserted it BEFORE s2 (inside s2's 10:30-12:30 window).
    const placed = insertByRouteOrder(dayStops, { id: 'v', geo: NEAR_NORTH, startMin: 660 }, ['s1', '__candidate__', 's2']);
    expect(placed.map((s) => s.id)).toEqual(['s1', 'v', 's2']);
    const cost = routeCost(dayStops, {
      id: 'v', geo: NEAR_NORTH, startMin: 660, route_order: null, insertByTime: true, routeOrderIds: ['s1', '__candidate__', 's2'],
    });
    expect(cost.neighbours).toEqual({ prev: NORTH, stop: NEAR_NORTH, next: SOUTH });
    // Mismatched routeOrderIds falls back cleanly to chronological insertByWindow.
    const fallback = insertByRouteOrder(dayStops, { id: 'v', geo: NEAR_NORTH, startMin: 615 }, ['s1', '__candidate__', 'unknown']);
    expect(fallback.map((s) => s.id)).toEqual(['s1', 'v', 's2']);
  });

  test('routeCost measures detour against the repaired routeOrderIds baseline, never letting stale-order repair hide candidate detour', () => {
    const FAR_EAST = { lat: 27.40, lng: -82.10 };
    // Stored order is stale (NORTH -> SOUTH -> NEAR_NORTH backtracks), while solver
    // repaired order is NORTH -> NEAR_NORTH -> SOUTH and appends FAR_EAST.
    const staleStops = [
      { id: 's1', geo: NORTH, startMin: 480, window_start: '08:00', route_order: 1 },
      { id: 's2', geo: SOUTH, startMin: 660, window_start: '11:00', route_order: 2 },
      { id: 's3', geo: NEAR_NORTH, startMin: 540, window_start: '09:00', route_order: 3 },
    ];
    const cost = routeCost(staleStops, {
      id: 'v', geo: FAR_EAST, startMin: 780, route_order: null, insertByTime: true, routeOrderIds: ['s1', 's3', 's2', '__candidate__'],
    });
    const repairedBaseline = chainDriveMinutes([NORTH, NEAR_NORTH, SOUTH]);
    const withCandidate = chainDriveMinutes([NORTH, NEAR_NORTH, SOUTH, FAR_EAST]);
    expect(cost.detourMinutes).toBeCloseTo(withCandidate - repairedBaseline, 5);
    expect(cost.detourMinutes).toBeGreaterThan(20);
  });

  test('verifyPlacedNeighbours accepts matching neighbors (including grouped visit_id siblings) and throws ROUTE_ORDER_CHANGED on drift', () => {
    const { _internals: { verifyPlacedNeighbours } } = require('../services/scheduling/arrival-route');
    const context = {
      rows: [
        { id: 'g1a', visit_id: 'vis1' },
        { id: 'g1b', visit_id: 'vis1' },
        { id: 's2', visit_id: null },
      ],
    };
    // Grouped sibling g1a + g1b collapses to v:vis1, matching scored prevId g1a.
    expect(() => verifyPlacedNeighbours(['g1a', 'g1b', 'svc', 's2'], {
      context, serviceId: 'svc', expectedNeighbours: { prevId: 'g1a', nextId: 's2' },
    })).not.toThrow();
    // Neighbor shifted -> throws 409 ROUTE_ORDER_CHANGED so rebooker rolls back & retries.
    expect(() => verifyPlacedNeighbours(['s2', 'svc', 'g1a', 'g1b'], {
      context, serviceId: 'svc', expectedNeighbours: { prevId: 'g1a', nextId: 's2' },
    })).toThrow(expect.objectContaining({ code: 'ROUTE_ORDER_CHANGED', statusCode: 409 }));
    // Single-stop day matches { prevId: null, nextId: null }.
    expect(() => verifyPlacedNeighbours(['svc'], {
      context: { rows: [] }, serviceId: 'svc', expectedNeighbours: { prevId: null, nextId: null },
    })).not.toThrow();
  });

  test('scoreOnSharedModel keeps stored route_order for same (date, tech, start) slot so a stale day never triggers a no-op move', () => {
    const prevAdmin = process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
    const prevCap = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
    delete process.env.GATE_SCHEDULING_CAPACITY;
    try {
      const { _internals: { scoreOnSharedModel, isSamePlacement } } = require('../services/auto-dispatch/candidate-slots');
      const svc = { id: 'v', scheduled_date: '2026-12-10', technician_id: 't1', window_start: '09:00:00', route_order: 3 };
      const stops = [
        { id: 's1', technician_id: 't1', geo: NORTH, startMin: 480, window_start: '08:00', route_order: 1 },
        { id: 's2', technician_id: 't1', geo: SOUTH, startMin: 780, window_start: '13:00', route_order: 2 },
      ];
      const sameCand = { date: '2026-12-10', technician_id: 't1', start_time: '09:00', route_order_ids: ['s1', '__candidate__', 's2'] };
      const shiftedCand = { date: '2026-12-10', technician_id: 't1', start_time: '10:00', route_order_ids: ['s1', '__candidate__', 's2'] };
      expect(isSamePlacement(svc, sameCand)).toBe(true);
      expect(isSamePlacement(svc, shiftedCand)).toBe(false);
      const sameScored = scoreOnSharedModel(svc, NEAR_NORTH, sameCand, stops, [], { targets: [] });
      const shiftedScored = scoreOnSharedModel(svc, NEAR_NORTH, shiftedCand, stops, [], { targets: [] });
      // Same slot keeps route_order=3 (behind s2 -> big backtrack detour); shifted slot inserts between s1 and s2.
      expect(sameScored.detour_minutes).toBeGreaterThan(shiftedScored.detour_minutes + 15);
      expect(sameScored.route_order_ids).toBeUndefined();
      expect(shiftedScored.route_order_ids).toEqual(['s1', '__candidate__', 's2']);
      // Destination day with an unassigned stop drops route_order_ids so scoring and commit agree.
      const withUnassigned = [...stops, { id: 'u1', technician_id: null, geo: SOUTH, startMin: 600, window_start: '10:00', route_order: null }];
      const unassignedScored = scoreOnSharedModel(svc, NEAR_NORTH, shiftedCand, withUnassigned, [], { targets: [] });
      expect(unassignedScored.route_order_ids).toBeUndefined();
      // Removed stop lingering in route_order_ids (bijection mismatch) also rejects certification.
      const staleOrderCand = { ...shiftedCand, route_order_ids: ['s1', 'removed-stop', '__candidate__', 's2'] };
      const staleScored = scoreOnSharedModel(svc, NEAR_NORTH, staleOrderCand, stops, [], { targets: [] });
      expect(staleScored.route_order_ids).toBeUndefined();
    } finally {
      if (prevAdmin === undefined) delete process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
      else process.env.GATE_ADMIN_ARRIVAL_WINDOWS = prevAdmin;
      if (prevCap === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = prevCap;
    }
  });
});

describe('Phase 2: calibrated minutes-first qualification and ranking', () => {
  const savedGate = process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
  beforeAll(() => { process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true'; });
  afterAll(() => {
    if (savedGate === undefined) delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
    else process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = savedGate;
  });

  const prefs = { preferred_day_indexes: [], preferred_time_window: null, effective_time_window: null };
  const config = {
    minDayMoveDriveSavingMinutes: 6,
    minutesRuleSavingMinutes: 10,
    minutesRuleSecondMoveSavingMinutes: 15,
    roadCheckEnabled: true,
    bounceCooldownDays: 7,
  };

  test('cross-tech move (Tech 2) saving 12 min qualifies even when continuity (-5) and cluster dilution make synthetic gain <= 0', () => {
    const service = { id: 's1', scheduled_date: '2026-12-10', window_start: '09:00', technician_id: 't1', auto_dispatch_change_count: 0 };
    const current = { is_current: true, date: '2026-12-10', start_time: '09:00', technician_id: 't1', detour_minutes: 25, stops_that_day: 2, same_area_share: 1, route_minutes: 180, capability_level: 'qualified' };
    const cand = { is_current: false, date: '2026-12-12', start_time: '10:00', technician_id: 't2', detour_minutes: 13, stops_that_day: 6, same_area_share: 0.2, route_minutes: 400, capability_level: 'qualified' };
    const scoreCtx = { currentTechnicianId: 't1', changeCount: 0 };
    const currentScore = scoreAppointmentPlacement(current, prefs, scoreCtx);
    const candScore = scoreAppointmentPlacement(cand, prefs, scoreCtx);
    // Synthetic score actually drops because continuity (-5) + cluster dilution (-8) > route (+10.67).
    expect(candScore.total_score - currentScore.total_score).toBeLessThan(0);
    const ranked = rankCandidates({ service, current, currentScore, scored: [{ cand, sc: candScore }], threshold: 15, config });
    expect(ranked.qualifies).toBe(true);
    expect(ranked.byMinutes).toBe(true);
  });

  test('far lone stop saturating DETOUR_CAP_MIN (65m -> 45m, 20m saved) qualifies under minutes rule', () => {
    const service = { id: 's1', scheduled_date: '2026-12-10', window_start: '09:00', technician_id: 't1', auto_dispatch_change_count: 0 };
    const current = { is_current: true, date: '2026-12-10', start_time: '09:00', technician_id: 't1', detour_minutes: 65, stops_that_day: 1, same_area_share: 0, route_minutes: 120, capability_level: 'qualified' };
    const cand = { is_current: false, date: '2026-12-12', start_time: '10:00', technician_id: 't1', detour_minutes: 45, stops_that_day: 4, same_area_share: 0, route_minutes: 360, capability_level: 'qualified' };
    const scoreCtx = { currentTechnicianId: 't1', changeCount: 0 };
    const currentScore = scoreAppointmentPlacement(current, prefs, scoreCtx);
    const candScore = scoreAppointmentPlacement(cand, prefs, scoreCtx);
    // Both detours hit DETOUR_CAP_MIN=45 so synthetic routeScore gain is 0.
    expect(candScore.route_efficiency_score).toBe(0);
    expect(currentScore.route_efficiency_score).toBe(0);
    const ranked = rankCandidates({ service, current, currentScore, scored: [{ cand, sc: candScore }], threshold: 15, config });
    expect(ranked.qualifies).toBe(true);
    expect(ranked.byMinutes).toBe(true);
  });

  test('overloaded destination day (route_minutes > 480 lowering workload_score) still blocks minutes rule', () => {
    const service = { id: 's1', scheduled_date: '2026-12-10', window_start: '09:00', technician_id: 't1', auto_dispatch_change_count: 0 };
    const current = { is_current: true, date: '2026-12-10', start_time: '09:00', technician_id: 't1', detour_minutes: 30, stops_that_day: 2, same_area_share: 0, route_minutes: 200, capability_level: 'qualified' };
    const overloaded = { is_current: false, date: '2026-12-12', start_time: '10:00', technician_id: 't1', detour_minutes: 15, stops_that_day: 9, same_area_share: 0, route_minutes: 540, capability_level: 'qualified' };
    const scoreCtx = { currentTechnicianId: 't1', changeCount: 0 };
    const currentScore = scoreAppointmentPlacement(current, prefs, scoreCtx);
    const candScore = scoreAppointmentPlacement(overloaded, prefs, scoreCtx);
    expect(candScore.workload_score).toBeLessThan(currentScore.workload_score);
    const ranked = rankCandidates({ service, current, currentScore, scored: [{ cand: overloaded, sc: candScore }], threshold: 15, config });
    expect(ranked.qualifies).toBe(false);
  });

  test('qualifying candidate ordering is transitive across all 6 permutations of bar and minutes-rule slots', () => {
    const service = { id: 's1', scheduled_date: '2026-12-10', window_start: '09:00', technician_id: 't1', auto_dispatch_change_count: 0 };
    const current = { is_current: true, date: '2026-12-10', start_time: '09:00', technician_id: 't1', detour_minutes: 30, stops_that_day: 2, same_area_share: 0, route_minutes: 200, capability_level: 'qualified' };
    const currentScore = { total_score: 50, default_time_score: 0, customer_preference_score: 12.5, technician_score: 15, workload_score: 5 };
    const barHighGainLowSave = { cand: { date: '2026-12-11', start_time: '09:00', detour_minutes: 22 }, sc: { ...currentScore, total_score: 80 } }; // gain +30, saving 8
    const barLowGainHighSave = { cand: { date: '2026-12-12', start_time: '09:00', detour_minutes: 10 }, sc: { ...currentScore, total_score: 70 } }; // gain +20, saving 20
    const minMidSave = { cand: { date: '2026-12-14', start_time: '09:00', detour_minutes: 15 }, sc: { ...currentScore, total_score: 55 } }; // gain +5, saving 15
    const items = [barHighGainLowSave, barLowGainHighSave, minMidSave];
    const perms = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ];
    for (const p of perms) {
      const ranked = rankCandidates({ service, current, currentScore, scored: p.map((i) => items[i]), threshold: 15, config });
      expect(ranked.ranked.map((c) => c.date)).toEqual(['2026-12-12', '2026-12-14', '2026-12-11']);
    }
  });
});
