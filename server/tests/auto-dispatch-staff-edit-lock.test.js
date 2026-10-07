const { staffEditLocksVisit } = require('../services/auto-dispatch/staff-edit-lock');

const before = (o = {}) => ({
  is_recurring: true, recurring_parent_id: 'p1', status: 'confirmed',
  scheduled_date: '2026-10-18', window_start: '09:00:00', window_end: '10:00:00', ...o,
});

describe('staffEditLocksVisit', () => {
  test('a window-only change on a live recurring occurrence locks it', () => {
    expect(staffEditLocksVisit(before(), { window_start: '13:00', window_end: '14:00' })).toBe(true);
  });

  test('a date change locks it', () => {
    expect(staffEditLocksVisit(before(), { scheduled_date: '2026-10-20' })).toBe(true);
    expect(staffEditLocksVisit(before({ scheduled_date: new Date('2026-10-18T00:00:00Z') }), { scheduled_date: '2026-10-21' })).toBe(true);
  });

  test('saving the same slot (any time format) or other fields never locks', () => {
    expect(staffEditLocksVisit(before(), { window_start: '09:00', window_end: '10:00' })).toBe(false);
    expect(staffEditLocksVisit(before(), { scheduled_date: '2026-10-18' })).toBe(false);
    expect(staffEditLocksVisit(before(), { notes: 'gate code changed' })).toBe(false);
  });

  test('unplacing (window cleared) or a still-windowless row does not lock: there is no chosen time', () => {
    expect(staffEditLocksVisit(before(), { window_start: null, window_end: null })).toBe(false);
    expect(staffEditLocksVisit(before({ window_start: null, window_end: null }), { scheduled_date: '2026-10-20' })).toBe(false);
  });

  test('non-recurring, template and terminal rows never lock', () => {
    expect(staffEditLocksVisit(before({ is_recurring: false }), { window_start: '13:00' })).toBe(false);
    expect(staffEditLocksVisit(before({ recurring_parent_id: null }), { window_start: '13:00' })).toBe(false);
    expect(staffEditLocksVisit(before({ status: 'completed' }), { window_start: '13:00' })).toBe(false);
    expect(staffEditLocksVisit(before(), { window_start: '13:00', status: 'cancelled' })).toBe(false);
  });

  test('missing inputs never lock', () => {
    expect(staffEditLocksVisit(null, { window_start: '13:00' })).toBe(false);
    expect(staffEditLocksVisit(before(), null)).toBe(false);
  });
});

describe('staffEditLockPatch (merged by the edit route next to recurringDispatchDuePatch)', () => {
  const { staffEditLockPatch } = require('../services/auto-dispatch/staff-edit-lock');
  test('a slot change returns the lock column; anything else returns nothing', () => {
    expect(staffEditLockPatch(before(), { window_start: '13:00', window_end: '14:00' })).toEqual({ auto_dispatch_locked: true });
    expect(staffEditLockPatch(before(), { window_start: '09:00', window_end: '10:00' })).toEqual({});
    expect(staffEditLockPatch(null, { window_start: '13:00' })).toEqual({});
  });
});
