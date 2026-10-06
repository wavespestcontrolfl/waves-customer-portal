// Two stop groups (owner ruling 2026-10-05): a series extension that meets the
// customer's own stop of the other group books the first whole hour after that
// stop. Which rows make "the stop", and where it ends (owner ruling 2026-10-06,
// #6064: only the clashing stop counts, and all its work is added up).
const { _test } = require('../routes/admin-schedule');

const row = (id, start, end, minutes) => ({ id, window_start: start, window_end: end, estimated_duration_minutes: minutes });

describe('after-stop extension window', () => {
  test('a separate appointment later that day is not part of the clashing stop', () => {
    const rows = [row('lawn', '09:00', '10:00', 60), row('evening', '19:00', '20:00', 60)];
    const stop = _test.connectedStop(rows, [{ id: 'lawn' }]);
    expect(stop.map((r) => r.id)).toEqual(['lawn']);
    expect(_test.followOnWindow(stop, { estimated_duration_minutes: 60 }).window_start).toBe('10:00');
  });

  test('a touching member joins the stop, and members sharing an arrival work one after another', () => {
    const rows = [row('lawn', '09:00', '10:00', 60), row('tree', '09:00', '10:00', 60), row('palm', '11:00', '12:00', 60)];
    const stop = _test.connectedStop(rows, [{ id: 'lawn' }]);
    expect(stop.map((r) => r.id).sort()).toEqual(['lawn', 'palm', 'tree']);
    expect(_test.followOnWindow(stop, { estimated_duration_minutes: 60 }).window_start).toBe('12:00');
  });

  test('staggered overlapping members add up their work (09:00-11:00 + 10:00-12:00 = four hours)', () => {
    const rows = [row('a', '09:00', '11:00', 120), row('b', '10:00', '12:00', 120)];
    const stop = _test.connectedStop(rows, [{ id: 'a' }]);
    expect(_test.followOnWindow(stop, { estimated_duration_minutes: 60 }).window_start).toBe('13:00');
  });

  test('a clash row outside the other-group rows is not this case', () => {
    expect(_test.connectedStop([row('lawn', '09:00', '10:00', 60)], [{ id: 'lawn' }, { id: 'pest' }])).toBeNull();
  });
});
