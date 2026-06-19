// apply.js stale guard: must re-read the row and refuse to move it if it was
// locked/excluded or its date/window/tech changed since it was scored.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/rebooker', () => ({ reschedule: jest.fn().mockResolvedValue({ success: true }) }));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const { applyAutoDispatchMove } = require('../services/auto-dispatch/apply');

const SERVICE = {
  id: 's1', status: 'confirmed', scheduled_date: '2026-08-04',
  window_start: '09:00', window_end: '11:00', technician_id: 't1', auto_dispatch_change_count: 0,
};
const BEST = { date: '2026-08-11', start_time: '08:00', end_time: '10:00', technician_id: 't1' };

function readRow(row) {
  return { where() { return this; }, first: async () => row };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn((s) => ({ raw: s }));
  db.fn = { now: jest.fn(() => 'now()') };
});

test('applies the move and atomically increments the change count', async () => {
  const update = jest.fn().mockResolvedValue(1);
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update },
  ];
  db.mockImplementation(() => queue.shift());

  const res = await applyAutoDispatchMove(SERVICE, BEST, 'run1', { notifyCustomers: false });

  const callArgs = SmartRebooker.reschedule.mock.calls[0];
  expect(callArgs.slice(0, 5)).toEqual(['s1', '2026-08-11', { start: '08:00', end: '10:00' }, 'auto_dispatch', 'auto_dispatch']);
  // atomic expect predicate carried into the rebooker's move transaction
  expect(callArgs[5].expect).toMatchObject({ auto_dispatch_locked: false, auto_dispatch_excluded: false, scheduled_date: '2026-08-04' });
  expect(res).toMatchObject({ ok: true, pre_status: 'confirmed', post_status: 'confirmed' });
  expect(update.mock.calls[0][0].auto_dispatch_change_count).toEqual({ raw: 'COALESCE(auto_dispatch_change_count, 0) + 1' });
});

test('aborts (STALE_PLACEMENT) when the visit was locked after scoring', async () => {
  db.mockImplementation(() => readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: true, auto_dispatch_excluded: false }));
  await expect(applyAutoDispatchMove(SERVICE, BEST, 'run1', {})).rejects.toMatchObject({ code: 'STALE_PLACEMENT' });
  expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
});

test('aborts when status flipped to rescheduled (customer request) after scoring', async () => {
  db.mockImplementation(() => readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'rescheduled', auto_dispatch_locked: false, auto_dispatch_excluded: false }));
  await expect(applyAutoDispatchMove(SERVICE, BEST, 'run1', {})).rejects.toMatchObject({ code: 'STALE_PLACEMENT' });
  expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
});

test('aborts when window_end changed since scoring', async () => {
  db.mockImplementation(() => readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '10:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }));
  await expect(applyAutoDispatchMove(SERVICE, BEST, 'run1', {})).rejects.toMatchObject({ code: 'STALE_PLACEMENT' });
  expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
});
