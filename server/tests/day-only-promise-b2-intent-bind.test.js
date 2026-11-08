// GATE_DAY_ONLY_PROMISE part B2: the post-commit intent writes (dispatch board move, Intelligence Bar move, customer move) are
// bound to the slot THEIR move wrote, so a delayed write from an earlier move cannot overwrite a later move's customer_asked_time.
// Synthetic ids only; recordCustomerAskedTime is spied, nothing touches a database.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => ({})) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({
  safeSendAppointment: jest.fn(),
  visitPrefsRow: jest.fn(async () => ({})),
  markRescheduleNoticeSent: jest.fn(async () => ({})),
  dayGuardMeta: () => ({}),
  reminder72hStillReachable: () => true,
  reminder24hStillReachable: () => true,
}));

const timePromise = require('../services/time-promise');
const dispatch = require('../routes/admin-dispatch');

const { recordVisitMoveIntent, movedSlotFor } = dispatch._test;

afterEach(() => jest.restoreAllMocks());

describe('dispatch board move: recordVisitMoveIntent', () => {
  test('a single visit: bound to the new date and the window start the move asked for', async () => {
    const spy = jest.spyOn(timePromise, 'recordCustomerAskedTime').mockResolvedValue(1);
    await recordVisitMoveIntent({ result: {}, plan: { customerAskedTime: true, effectiveWindow: '09:00-11:00' }, serviceId: 's1', newDate: '2026-11-15' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0].slice(1)).toEqual([['s1'], true, { date: '2026-11-15', windowStart: '09:00' }]);
  });

  test('a grouped stop: every member is bound to the slot the unit move landed for IT', async () => {
    const spy = jest.spyOn(timePromise, 'recordCustomerAskedTime').mockResolvedValue(1);
    const visitMove = {
      moved: ['s1', 's2'],
      members: [
        { id: 's1', landed: { scheduled_date: '2026-11-15', window_start: '09:00:00' } },
        { id: 's2', landed: { scheduled_date: '2026-11-15', window_start: '10:00' } },
      ],
    };
    await recordVisitMoveIntent({ result: { visitMove }, plan: { customerAskedTime: false }, serviceId: 's1', newDate: '2026-11-15' });
    expect(spy.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
      [['s1'], false, { date: '2026-11-15', windowStart: '09:00' }],
      [['s2'], false, { date: '2026-11-15', windowStart: '10:00' }],
    ]);
  });

  test('a landed member with no window is bound to "no window", never to the requested start', async () => {
    const spy = jest.spyOn(timePromise, 'recordCustomerAskedTime').mockResolvedValue(1);
    const visitMove = { moved: ['s1', 's2'], members: [
      { id: 's1', landed: { scheduled_date: '2026-11-15', window_start: '09:00:00' } },
      { id: 's2', landed: { scheduled_date: '2026-11-15', window_start: null } },
    ] };
    await recordVisitMoveIntent({ result: { visitMove }, plan: { customerAskedTime: false, effectiveWindow: '09:00-11:00' }, serviceId: 's1', newDate: '2026-11-15' });
    expect(spy.mock.calls.map((c) => [c[1], c[3]])).toEqual([
      [['s1'], { date: '2026-11-15', windowStart: '09:00' }],
      [['s2'], { date: '2026-11-15', windowStart: null }],
    ]);
  });

  test('no window named: any start on the new date; the write still carries the date', () => {
    expect(movedSlotFor('s1', { result: {}, plan: {}, newDate: '2026-11-15T00:00:00.000Z' })).toEqual({ date: '2026-11-15', windowStart: undefined });
  });

  test('a failed write is logged, never thrown (the move is committed)', async () => {
    jest.spyOn(timePromise, 'recordCustomerAskedTime').mockRejectedValue(new Error('write failed'));
    await expect(recordVisitMoveIntent({ result: {}, plan: {}, serviceId: 's1', newDate: '2026-11-15' })).resolves.toBeUndefined();
  });
});
