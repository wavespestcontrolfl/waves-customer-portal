// apply.js stale guard: must re-read the row and refuse to move it if it was
// locked/excluded or its date/window/tech changed since it was scored.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/rebooker', () => ({ reschedule: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../services/appointment-reminders', () => ({ handleReschedule: jest.fn().mockResolvedValue() }));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const AppointmentReminders = require('../services/appointment-reminders');
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
  // atomic expect predicate (full original placement + status) carried into the rebooker's move transaction
  expect(callArgs[5].expect).toMatchObject({
    auto_dispatch_locked: false, auto_dispatch_excluded: false, status: 'confirmed', scheduled_date: '2026-08-04',
    window_start: '09:00', window_end: '11:00', technician_id: 't1',
  });
  expect(res).toMatchObject({ ok: true, pre_status: 'confirmed', post_status: 'confirmed' });
  expect(update.mock.calls[0][0].auto_dispatch_change_count).toEqual({ raw: 'COALESCE(auto_dispatch_change_count, 0) + 1' });
  // reminders re-aligned to the new slot (non-notifying)
  expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith('s1', '2026-08-11T08:00', { sendNotification: false });
});

test('preserves pending: restores pending + writes a compensating history row', async () => {
  const update = jest.fn().mockResolvedValue(1);
  const insert = jest.fn().mockResolvedValue();
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'pending', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update },
    { insert }, // job_status_history compensating row
  ];
  db.mockImplementation(() => queue.shift());

  const res = await applyAutoDispatchMove({ ...SERVICE, status: 'pending' }, BEST, 'run1', {});
  expect(res.post_status).toBe('pending');
  expect(update.mock.calls[0][0].status).toBe('pending');
  expect(insert).toHaveBeenCalledWith({ job_id: 's1', from_status: 'confirmed', to_status: 'pending', transitioned_by: null });
});

test('does not undo a concurrent confirm: scored pending but fresh confirmed stays confirmed', async () => {
  const update = jest.fn().mockResolvedValue(1);
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update },
  ];
  db.mockImplementation(() => queue.shift());

  const res = await applyAutoDispatchMove({ ...SERVICE, status: 'pending' }, BEST, 'run1', {});
  expect(res.post_status).toBe('confirmed');
  expect(update.mock.calls[0][0].status).toBeUndefined(); // no pending restore
});

test('re-arms a still-pending creation confirmation after the silent reminder sync', async () => {
  AppointmentReminders.handleReschedule.mockResolvedValueOnce({ id: 'r1', confirmation_sent: false });
  const stamp = jest.fn().mockResolvedValue(1);
  const rearm = jest.fn().mockResolvedValue(1);
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update: stamp },     // bookkeeping stamp
    { where() { return this; }, update: rearm },     // appointment_reminders re-arm
  ];
  db.mockImplementation(() => queue.shift());

  await applyAutoDispatchMove(SERVICE, BEST, 'run1', {});
  expect(rearm).toHaveBeenCalledWith({ confirmation_sent: false, confirmation_sent_at: null });
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

test('a grouped stop moved as a unit: every moved sibling gets the same bookkeeping stamp and pending restoration as the tapped row', async () => {
  SmartRebooker.reschedule.mockResolvedValueOnce({
    success: true,
    visitMove: { visitId: 'v1', moved: ['s1', 's2'], failed: [], members: [
      { id: 's1', isPrimary: true, previousStatus: 'confirmed' },
      { id: 's2', isPrimary: false, previousStatus: 'pending' },
    ] },
  });
  const updateTapped = jest.fn().mockResolvedValue(1);
  const updateSib = jest.fn().mockResolvedValue(1);
  const insert = jest.fn().mockResolvedValue();
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update: updateTapped },
    { where() { return this; }, update: updateSib },
    { insert }, // sibling's compensating confirmed→pending row
  ];
  db.mockImplementation(() => queue.shift());

  const res = await applyAutoDispatchMove(SERVICE, BEST, 'run1', { notifyCustomers: false });
  expect(res).toMatchObject({ ok: true, post_status: 'confirmed' });
  expect(updateTapped.mock.calls[0][0].status).toBeUndefined();
  expect(updateSib.mock.calls[0][0]).toMatchObject({ status: 'pending', last_auto_dispatch_run_id: 'run1', auto_dispatch_change_count: { raw: 'COALESCE(auto_dispatch_change_count, 0) + 1' } });
  expect(insert).toHaveBeenCalledWith({ job_id: 's2', from_status: 'confirmed', to_status: 'pending', transitioned_by: null });
});

test('a grouped sibling whose status moved on after the unit move (cancel/complete/start) is NOT rewound to pending and gets no false history row', async () => {
  SmartRebooker.reschedule.mockResolvedValueOnce({
    success: true,
    visitMove: { visitId: 'v1', moved: ['s1', 's2'], failed: [], members: [
      { id: 's1', isPrimary: true, previousStatus: 'confirmed' },
      { id: 's2', isPrimary: false, previousStatus: 'pending' },
    ] },
  });
  const updateTapped = jest.fn().mockResolvedValue(1);
  const sibWhere = jest.fn();
  const updateSibFenced = jest.fn().mockResolvedValue(0); // status is no longer 'confirmed'
  const updateSibPlain = jest.fn().mockResolvedValue(1);
  const insert = jest.fn().mockResolvedValue();
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update: updateTapped },
    { where(pred) { sibWhere(pred); return this; }, update: updateSibFenced },
    { where() { return this; }, update: updateSibPlain },
  ];
  db.mockImplementation(() => queue.shift());

  await applyAutoDispatchMove(SERVICE, BEST, 'run1', { notifyCustomers: false });
  expect(sibWhere).toHaveBeenCalledWith({ id: 's2', status: 'confirmed' });
  expect(updateSibPlain.mock.calls[0][0].status).toBeUndefined();
  expect(insert).not.toHaveBeenCalled();
});

test('a grouped visit that only PARTLY moved is an explicit failure carrying movedCount (rows that moved still get bookkeeping)', async () => {
  SmartRebooker.reschedule.mockResolvedValueOnce({
    success: true,
    visitMove: { visitId: 'v1', moved: ['s1'], failed: [{ id: 's2', reason: 'member s2 boom', code: 'SLOT_TAKEN' }], members: [
      { id: 's1', isPrimary: true, previousStatus: 'confirmed' },
    ] },
  });
  const updateTapped = jest.fn().mockResolvedValue(1);
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update: updateTapped },
  ];
  db.mockImplementation(() => queue.shift());
  await expect(applyAutoDispatchMove(SERVICE, BEST, 'run1', { notifyCustomers: false }))
    .rejects.toMatchObject({ code: 'VISIT_PARTIAL_MOVE', movedCount: 1, failedMembers: ['s2'] });
  expect(updateTapped).toHaveBeenCalledTimes(1);
});

test('a full grouped move reports movedCount = every moved row', async () => {
  SmartRebooker.reschedule.mockResolvedValueOnce({
    success: true,
    visitMove: { visitId: 'v1', moved: ['s1', 's2'], failed: [], members: [
      { id: 's1', isPrimary: true, previousStatus: 'confirmed' },
      { id: 's2', isPrimary: false, previousStatus: 'confirmed' },
    ] },
  });
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update: jest.fn().mockResolvedValue(1) },
    { where() { return this; }, update: jest.fn().mockResolvedValue(1) },
  ];
  db.mockImplementation(() => queue.shift());
  const res = await applyAutoDispatchMove(SERVICE, BEST, 'run1', { notifyCustomers: false });
  expect(res.movedCount).toBe(2);
});

test('a failed visit-parent retarget after a full member move is an explicit failure carrying movedCount', async () => {
  SmartRebooker.reschedule.mockResolvedValueOnce({
    success: true,
    warnings: ['visit parent retarget failed: boom'],
    visitMove: { visitId: 'v1', moved: ['s1', 's2'], failed: [], parentRetargetFailed: true, members: [
      { id: 's1', isPrimary: true, previousStatus: 'confirmed' },
      { id: 's2', isPrimary: false, previousStatus: 'confirmed' },
    ] },
  });
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update: jest.fn().mockResolvedValue(1) },
    { where() { return this; }, update: jest.fn().mockResolvedValue(1) },
  ];
  db.mockImplementation(() => queue.shift());
  await expect(applyAutoDispatchMove(SERVICE, BEST, 'run1', { notifyCustomers: false }))
    .rejects.toMatchObject({ code: 'VISIT_PARENT_RETARGET_FAILED', movedCount: 2 });
});

test('the remaining per-run budget is handed to the unit move as maxUnitSize', async () => {
  const queue = [
    readRow({ scheduled_date: '2026-08-04', window_start: '09:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', auto_dispatch_locked: false, auto_dispatch_excluded: false }),
    { where() { return this; }, update: jest.fn().mockResolvedValue(1) },
  ];
  db.mockImplementation(() => queue.shift());
  await applyAutoDispatchMove(SERVICE, BEST, 'run1', { notifyCustomers: false, remainingChanges: 4 });
  expect(SmartRebooker.reschedule.mock.calls[0][5].maxUnitSize).toBe(4);
});
