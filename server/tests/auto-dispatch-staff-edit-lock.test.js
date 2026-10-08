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

  test('a live visit the route rewinds to confirmed on a date move locks too', () => {
    expect(staffEditLocksVisit(before({ status: 'en_route' }), { scheduled_date: '2026-10-20' })).toBe(true);
    expect(staffEditLocksVisit(before({ status: 'on_site' }), { scheduled_date: '2026-10-20' })).toBe(true);
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

  test('an explicit box flip already in the update wins over the slot-change lock', () => {
    expect(staffEditLockPatch(before(), { window_start: '13:00', window_end: '14:00', auto_dispatch_locked: false })).toEqual({});
  });
});

describe('autoDispatchBoxPatch (merged where the edit route builds its update)', () => {
  const { autoDispatchBoxPatch } = require('../services/auto-dispatch/staff-edit-lock');
  test('a box the person flipped is a change, in both directions', () => {
    expect(autoDispatchBoxPatch({ now: true, was: false })).toEqual({ auto_dispatch_locked: true });
    expect(autoDispatchBoxPatch({ now: false, was: true })).toEqual({ auto_dispatch_locked: false });
  });

  test('an untouched, missing or malformed box says nothing, so a stale form cannot undo a lock', () => {
    expect(autoDispatchBoxPatch({ now: false, was: false })).toEqual({});
    expect(autoDispatchBoxPatch({ now: true, was: true })).toEqual({});
    expect(autoDispatchBoxPatch({ now: 'false', was: true })).toEqual({});
    expect(autoDispatchBoxPatch({ now: false })).toEqual({});
    expect(autoDispatchBoxPatch({})).toEqual({});
    expect(autoDispatchBoxPatch()).toEqual({});
  });
});
