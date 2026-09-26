// Route-stop activity predicate (GATE_AUTO_DISPATCH_SHARED_MODEL). Codex
// pre-push P1 (2026-09-26): this module used to also carry a hand-rolled
// re-expression of the writer's TECH-SCOPED overlap probe
// (intervalsOverlap/conflictsWithStop/candidateHasOverlap) for the
// SLOT_TAKEN pre-filter. That check missed the writer's OTHER, tech-BLIND
// probe (rebooker.js probeMoveConflicts -> scheduling/occupancy.js
// findConflictingVisits has no technician_id filter at all — one-truck
// business) — a strict superset of the tech-scoped check, so candidate-
// slots.js now calls that canonical reader directly (scheduling/
// occupancy.js listOccupiedWindows, tested there) instead of re-deriving
// its WHERE here. The removed functions are gone; isActiveRouteStop is the
// one piece still genuinely reused (route-scoring's own stop-activity
// filter, a different concern from occupancy).
const { isActiveRouteStop, OVERLAP_EXCLUDED_STATUSES } = require('../services/auto-dispatch/overlap-predicate');

describe('isActiveRouteStop', () => {
  const liveRow = { id: 'r1', window_start: '09:00', window_end: '10:00', status: 'confirmed' };

  test('a live row is active', () => {
    expect(isActiveRouteStop(liveRow)).toBe(true);
  });
  test.each(['cancelled', 'skipped', 'no_show', 'rescheduled', 'completed'])(
    'a %s row is NOT active (matches the writer\'s excluded statuses)', (status) => {
      expect(isActiveRouteStop({ ...liveRow, status })).toBe(false);
    },
  );
  test('the excluded-status set is exactly the writer\'s (NOT_A_ROUTE_STOP_STATUSES + completed)', () => {
    expect([...OVERLAP_EXCLUDED_STATUSES].sort()).toEqual(['cancelled', 'completed', 'no_show', 'rescheduled', 'skipped']);
  });
  test('an expired estimate-slot hold is NOT active', () => {
    const expired = { ...liveRow, reservation_expires_at: new Date(Date.now() - 60000).toISOString() };
    expect(isActiveRouteStop(expired)).toBe(false);
  });
  test('a still-live hold IS active', () => {
    const live = { ...liveRow, reservation_expires_at: new Date(Date.now() + 60000).toISOString() };
    expect(isActiveRouteStop(live)).toBe(true);
  });
  test('a nullish row is not active', () => {
    expect(isActiveRouteStop(null)).toBe(false);
    expect(isActiveRouteStop(undefined)).toBe(false);
  });
});
