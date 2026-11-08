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

const { recordVisitMoveIntent, movedSlotFor, recordCustomerSeriesIntent } = dispatch._test;

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

describe('a customer-driven series move records the set-time intent before the notice decision', () => {
  const rows = [
    { id: 'c1', date: '2026-11-15', windowStart: '09:00:00' },
    { id: 'c2', date: '2026-11-22T00:00:00.000Z', windowStart: null },
  ];
  const gate = process.env.GATE_DAY_ONLY_PROMISE;
  afterEach(() => { if (gate === undefined) delete process.env.GATE_DAY_ONLY_PROMISE; else process.env.GATE_DAY_ONLY_PROMISE = gate; });

  test('customer surfaces: true on every moved row, each bound to the slot it landed (a windowless row to "no window")', async () => {
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    for (const surface of ['customer_web', 'sms_reply', 'call_reschedule', 'call_makeup']) {
      const spy = jest.spyOn(timePromise, 'recordCustomerAskedTime').mockResolvedValue(1);
      await recordCustomerSeriesIntent({ surface, rows });
      expect(spy.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
        [['c1'], true, { date: '2026-11-15', windowStart: '09:00' }],
        [['c2'], true, { date: '2026-11-22', windowStart: null }],
      ]);
      spy.mockRestore();
    }
  });

  test('office surfaces write nothing (their behavior is unchanged)', async () => {
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    const spy = jest.spyOn(timePromise, 'recordCustomerAskedTime').mockResolvedValue(1);
    for (const surface of ['dispatch_board', 'edit_modal', 'quick_move', 'intelligence_bar', undefined]) await recordCustomerSeriesIntent({ surface, rows });
    expect(spy).not.toHaveBeenCalled();
  });

  test('gate off: no UPDATE at all, even for a customer surface', async () => {
    delete process.env.GATE_DAY_ONLY_PROMISE;
    const conn = jest.fn();
    const db = require('../models/db');
    db.mockImplementation(conn);
    await recordCustomerSeriesIntent({ surface: 'customer_web', rows });
    expect(conn).not.toHaveBeenCalled();
    db.mockReset();
  });

  test('a failed write throws, so the pass fails closed and the reconciler retries (no day-only text over the customer\'s hour)', async () => {
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    jest.spyOn(timePromise, 'recordCustomerAskedTime').mockRejectedValue(new Error('write failed'));
    await expect(recordCustomerSeriesIntent({ surface: 'customer_web', rows })).rejects.toThrow('write failed');
  });

  test('the effects pass writes it before it reads the notice decision, from the row\'s recorded surface', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
    const pass = src.slice(src.indexOf('async function applySeriesMoveEffects({'));
    const write = pass.indexOf('await recordCustomerSeriesIntent({ surface: markers.source_surface, rows: reminderOccurrences });');
    expect(write).toBeGreaterThan(0);
    expect(write).toBeLessThan(pass.indexOf('await seriesNoticeDayOnly('));
  });
});
