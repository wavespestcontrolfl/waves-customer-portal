const { recurringDispatchDuePatch } = require('../services/scheduling/recurring-dispatch-due');

const row = {
  scheduled_date: '2099-01-10', window_start: null,
  recurring_dispatch_due_date: '2099-01-10',
};

test('a manual date change keeps an untimed occurrence eligible around its new due date', () => {
  expect(recurringDispatchDuePatch(row, { scheduled_date: '2099-02-10' }))
    .toEqual({ recurring_dispatch_due_date: '2099-02-10' });
});

test('an explicit appointment time releases the dispatcher bound', () => {
  expect(recurringDispatchDuePatch(row, { window_start: '09:00' }))
    .toEqual({ recurring_dispatch_due_date: null });
  expect(recurringDispatchDuePatch({ ...row, window_start: '09:00' }, { scheduled_date: '2099-02-10' }))
    .toEqual({ recurring_dispatch_due_date: null });
});

test('removing a placed window hands the existing occurrence back at its effective due date', () => {
  expect(recurringDispatchDuePatch({ ...row, window_start: '09:00' }, { window_start: null }))
    .toEqual({ recurring_dispatch_due_date: '2099-01-10' });
});

test('a notes or echoed schedule save preserves the original bound after automatic placement', () => {
  const placed = { ...row, scheduled_date: new Date('2099-01-12T00:00:00Z'), window_start: '09:00:00' };
  expect(recurringDispatchDuePatch(placed, { notes: 'Updated' })).toEqual({});
  expect(recurringDispatchDuePatch(placed, { scheduled_date: '2099-01-12', window_start: '09:00' })).toEqual({});
});

test('unmarked appointments never acquire a new dispatch handoff from a manual move', () => {
  expect(recurringDispatchDuePatch({ ...row, recurring_dispatch_due_date: null }, { scheduled_date: '2099-02-10' })).toEqual({});
});
