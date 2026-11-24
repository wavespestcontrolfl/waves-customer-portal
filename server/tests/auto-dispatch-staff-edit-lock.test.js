// The edit form's "Keep auto-dispatch off this visit" box (staff-edit-lock.js). A staff date or time change no longer
// ticks it by itself (owner 2026-11-22); the route test pins that the edit route merges no slot-change lock.
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
