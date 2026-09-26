// Shared window-overlap predicate (GATE_AUTO_DISPATCH_SHARED_MODEL) — verifies
// it agrees with SmartRebooker.reschedule's hard occupancy probe
// (rebooker.js, the `!useArrivalWindows` branch): existing.window_start <
// new.window_end AND existing.effective_end > new.window_start, a touching
// boundary is NOT a conflict, and it excludes self / visit-group members /
// non-route-stop statuses / completed / expired holds exactly like the writer.
const {
  intervalsOverlap, isActiveRouteStop, conflictsWithStop, candidateHasOverlap, OVERLAP_EXCLUDED_STATUSES,
} = require('../services/auto-dispatch/overlap-predicate');

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

describe('intervalsOverlap', () => {
  test('overlapping windows conflict', () => {
    expect(intervalsOverlap(540, 600, 570, 630)).toBe(true); // 09:00-10:00 vs 09:30-10:30
  });
  test('a touching boundary is NOT a conflict (matches the writer\'s strict SQL comparison)', () => {
    expect(intervalsOverlap(540, 600, 600, 660)).toBe(false); // 09:00-10:00 then 10:00-11:00
    expect(intervalsOverlap(600, 660, 540, 600)).toBe(false); // reversed order
  });
  test('non-overlapping windows do not conflict', () => {
    expect(intervalsOverlap(540, 600, 660, 720)).toBe(false); // 09:00-10:00 vs 11:00-12:00
  });
  test('one window fully containing another conflicts', () => {
    expect(intervalsOverlap(480, 720, 540, 600)).toBe(true);
  });
  test('non-finite inputs never conflict', () => {
    expect(intervalsOverlap(null, 600, 540, 600)).toBe(false);
    expect(intervalsOverlap(540, undefined, 540, 600)).toBe(false);
  });
});

describe('conflictsWithStop', () => {
  const baseRow = { id: 'r1', window_start: '09:00', window_end: '10:00', status: 'confirmed' };

  test('overlapping row conflicts', () => {
    expect(conflictsWithStop(baseRow, { startMin: 570, endMin: 630, excludeIds: new Set() })).toBe(true);
  });
  test('touching row (row ends exactly when candidate starts) does not conflict', () => {
    expect(conflictsWithStop(baseRow, { startMin: 600, endMin: 660, excludeIds: new Set() })).toBe(false);
  });
  test('excludes the moving visit\'s own id', () => {
    expect(conflictsWithStop(baseRow, { startMin: 570, endMin: 630, excludeIds: new Set(['r1']) })).toBe(false);
  });
  test('excludes a visit-group member id moving together', () => {
    expect(conflictsWithStop(baseRow, { startMin: 570, endMin: 630, excludeIds: new Set(['r1', 'sibling-id']) })).toBe(false);
    // baseRow.id is 'r1' — a DIFFERENT sibling row is also excluded when named:
    const siblingRow = { ...baseRow, id: 'sibling-id' };
    expect(conflictsWithStop(siblingRow, { startMin: 570, endMin: 630, excludeIds: new Set(['r1', 'sibling-id']) })).toBe(false);
  });
  test.each(['cancelled', 'skipped', 'no_show', 'rescheduled', 'completed'])(
    'a %s stop never conflicts (matches the writer\'s excluded statuses)', (status) => {
      expect(conflictsWithStop({ ...baseRow, status }, { startMin: 570, endMin: 630, excludeIds: new Set() })).toBe(false);
    },
  );
  test('the excluded-status set is exactly the writer\'s (NOT_A_ROUTE_STOP_STATUSES + completed)', () => {
    expect([...OVERLAP_EXCLUDED_STATUSES].sort()).toEqual(['cancelled', 'completed', 'no_show', 'rescheduled', 'skipped']);
  });
  test('an expired estimate-slot hold never conflicts', () => {
    const expired = { ...baseRow, reservation_expires_at: new Date(Date.now() - 60000).toISOString() };
    expect(conflictsWithStop(expired, { startMin: 570, endMin: 630, excludeIds: new Set() })).toBe(false);
  });
  test('a still-live hold conflicts like any other stop', () => {
    const live = { ...baseRow, reservation_expires_at: new Date(Date.now() + 60000).toISOString() };
    expect(conflictsWithStop(live, { startMin: 570, endMin: 630, excludeIds: new Set() })).toBe(true);
  });
  test('a row with no window_start never conflicts (nothing to overlap)', () => {
    expect(conflictsWithStop({ ...baseRow, window_start: null }, { startMin: 570, endMin: 630, excludeIds: new Set() })).toBe(false);
  });
  test('a row with no window_end falls back to estimated_duration_minutes (default 60)', () => {
    const noEnd = { id: 'r2', window_start: '09:00', window_end: null, status: 'confirmed' };
    // 09:00 + 60min default = 10:00 → touches a 10:00 start, no conflict
    expect(conflictsWithStop(noEnd, { startMin: 600, endMin: 660, excludeIds: new Set() })).toBe(false);
    // but conflicts with a 09:30 start
    expect(conflictsWithStop(noEnd, { startMin: 570, endMin: 630, excludeIds: new Set() })).toBe(true);
  });
});

describe('candidateHasOverlap', () => {
  test('true when ANY stop conflicts', () => {
    const stops = [
      { id: 'a', window_start: '07:00', window_end: '08:00', status: 'confirmed' },
      { id: 'b', window_start: '09:00', window_end: '10:00', status: 'confirmed' },
    ];
    expect(candidateHasOverlap(stops, { startMin: 570, endMin: 630, excludeIds: new Set() })).toBe(true);
  });
  test('false when nothing conflicts (empty day, or all excluded)', () => {
    expect(candidateHasOverlap([], { startMin: 540, endMin: 600, excludeIds: new Set() })).toBe(false);
    const stops = [{ id: 'self', window_start: '09:00', window_end: '10:00', status: 'confirmed' }];
    expect(candidateHasOverlap(stops, { startMin: 570, endMin: 630, excludeIds: new Set(['self']) })).toBe(false);
  });
});
