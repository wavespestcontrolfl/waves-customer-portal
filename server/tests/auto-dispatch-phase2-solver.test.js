/**
 * Phase 2 solver fixes:
 * - route-model insertByWindow / scoreOnSharedModel insertByTime (standalone vs grouped)
 * - minutesRuleOk non-regression (workload guard without synthetic gain > 0 veto)
 * - drive-saving-first candidate ranking & pass-2 budget ordering
 */
const { routeCost, chainDriveMinutes, _internals: { insertByWindow } } = require('../services/auto-dispatch/route-model');
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
});
