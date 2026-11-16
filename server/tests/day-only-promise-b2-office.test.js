'use strict';

// GATE_DAY_ONLY_PROMISE part B2 (owner 2026-11-05 "D2 a", 2026-11-06 "office"): an office move (update-details, bulk,
// dispatch board, Intelligence Bar) to another DATE more than 24.25 h out promises only the new day, unless the office marked
// "customer asked for this time". sendRescheduleNoticeForVisit runs for real over stubs; nothing is sent.

const mockDb = { first: {}, updates: [] };
jest.mock('../models/db', () => {
  const make = (table) => {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orderBy', 'select']) q[m] = () => q;
    q.first = async () => mockDb.first[table];
    q.update = async (patch) => { mockDb.updates.push({ table, patch }); return 1; };
    q.catch = () => q;
    q.then = (res, rej) => Promise.resolve([]).then(res, rej);
    return q;
  };
  const db = jest.fn((table) => make(table));
  db.raw = jest.fn((sql) => sql);
  db.transaction = jest.fn(async (fn) => fn(db));
  db.fn = { now: () => new Date() };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({
  safeSendAppointment: jest.fn(async () => false),
  visitPrefsRow: jest.fn(async () => ({})),
  getReminderPrefs: jest.fn(async () => ({ serviceReminder24h: true, smsEnabled: true, reminder24hChannel: 'sms' })),
  dayGuardMeta: (ms) => (Number.isFinite(ms) ? { guard_slot_ms: ms, promised_date: require('../utils/datetime-et').etDateString(new Date(ms)) } : {}),
  reminder24hWillSend: (prefs) => Boolean(prefs && !prefs.unavailable && prefs.serviceReminder24h),
  smsServiceLabelStored: jest.fn((label) => label),
  markRescheduleNoticeSent: jest.fn(async () => {}),
  deliverMoveNoticeEmail: jest.fn(async () => true),
}));
jest.mock('../routes/admin-dispatch', () => ({
  captureReminderGuards: jest.fn(async () => []),
  rearmRescheduleReminderWindows: jest.fn(async () => {}),
}));
jest.mock('../services/outbound-review-confirm', () => ({ activateLegacyOutboundReviewRowIfNeeded: jest.fn(async () => {}) }));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async () => 'day body'),
  renderRequiredSmsTemplate: jest.fn(async () => 'window body'),
}));
jest.mock('../services/reschedule-link', () => ({
  rescheduledTextLine: jest.fn(async () => 'Need a different time? Reply here.'),
  rescheduledDayTextLine: jest.fn(async () => 'Need a different day or a set time? Reply here or call.'),
}));

const AppointmentReminders = require('../services/appointment-reminders');
const renderer = require('../services/sms-template-renderer');
const { sendRescheduleNoticeForVisit, recordOfficeMoveIntent } = require('../routes/admin-schedule');
const { etDateString } = require('../utils/datetime-et');

const FAR_DATE = '2099-11-04'; // 16:00 ET, far outside the cutoff
const OLD_DATE = '2099-11-02';
const SLOT_MS = Date.parse('2099-11-04T21:00:00.000Z');

/** Runs the sender; the stubbed safeSend renders the body for one contact, like the real one, then reports `delivered`. */
async function notice(options, { delivered = true, date = FAR_DATE, start = '16:00' } = {}) {
  let captured;
  AppointmentReminders.safeSendAppointment.mockImplementation(async (_c, _p, renderBody, _type, _purpose, meta) => {
    captured = { meta, body: await renderBody({ name: 'Pat Doe' }) };
    return delivered;
  });
  const result = await sendRescheduleNoticeForVisit('svc-1', date, start, options);
  return { result, ...captured };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.updates = [];
  mockDb.first = {
    scheduled_services: { customer_id: 'cust-1', service_type: 'Pest Control' },
    customers: { id: 'cust-1', first_name: 'Pat', phone: '+19415550101' },
    appointment_reminders: { service_type: 'Pest Control' },
  };
  renderer.renderSmsTemplate.mockResolvedValue('day body');
  process.env.GATE_DAY_ONLY_PROMISE = 'true';
});
afterAll(() => { delete process.env.GATE_DAY_ONLY_PROMISE; });

describe('an office move to another date, far out, no "customer asked for this time"', () => {
  test('the day row: new day and date, no window or time, the reschedule line is the day-only ask', async () => {
    const out = await notice({ previousDate: OLD_DATE });
    expect(out.body).toBe('day body');
    expect(renderer.renderRequiredSmsTemplate).not.toHaveBeenCalled();
    const [key, vars, , opts] = renderer.renderSmsTemplate.mock.calls[0];
    expect(key).toBe('appointment_rescheduled_day_v1');
    expect(vars).toEqual({
      first_name: 'Pat', service_type: 'Pest Control', day: expect.any(String), date: expect.any(String),
      different_time_line: 'Need a different day or a set time? Reply here or call.',
    });
    expect(opts.requiredVars).toEqual(['date', 'day']);
  });

  test('the metadata: the day marker, no recorded slot, the guard fields and the quoted slot for a later bounce', async () => {
    const { meta } = await notice({ previousDate: OLD_DATE });
    expect(meta).toMatchObject({
      scheduled_service_id: 'svc-1', promise_level: 'day', window_unknown: true, rendered_slot_ms: SLOT_MS,
      guard_slot_ms: SLOT_MS, promised_date: FAR_DATE, move_notice_slot_ms: SLOT_MS, move_notice_at: expect.any(String),
    });
  });

  test('a stop-wide notice keeps its stop identity beside the marker', async () => {
    const { meta } = await notice({ previousDate: OLD_DATE, stopWideFor: 'stop-9' });
    expect(meta).toMatchObject({ notificationEventKey: `visit:stop-9:${FAR_DATE}:16:00`, promise_level: 'day' });
  });

  test('the text reached nobody: the email leg follows the day copy', async () => {
    await notice({ previousDate: OLD_DATE }, { delivered: false });
    expect(AppointmentReminders.deliverMoveNoticeEmail.mock.calls[0][0]).toMatchObject({ kind: 'rescheduled', dayOnly: true });
  });
});

describe('everything else keeps today\'s window copy', () => {
  const todayBody = (out) => {
    expect(out.body).toBe('window body');
    expect(renderer.renderRequiredSmsTemplate.mock.calls[0][0]).toBe('appointment_rescheduled');
    expect(renderer.renderRequiredSmsTemplate.mock.calls[0][1]).toEqual(expect.objectContaining({ window: 'between 4:00 PM and 6:00 PM', time: expect.any(String) }));
    expect(out.meta).not.toHaveProperty('promise_level');
    expect(out.meta).not.toHaveProperty('window_unknown');
    expect(out.meta).not.toHaveProperty('guard_slot_ms');
    expect(out.meta).not.toHaveProperty('move_notice_slot_ms');
    expect(renderer.renderSmsTemplate).not.toHaveBeenCalled();
  };

  test('"customer asked for this time" (the box): the window, and the email leg stays a window email', async () => {
    const out = await notice({ previousDate: OLD_DATE, customerAskedTime: true }, { delivered: false });
    todayBody(out);
    expect(AppointmentReminders.deliverMoveNoticeEmail.mock.calls[0][0]).not.toHaveProperty('dayOnly');
  });

  test('a same-day re-time', async () => {
    todayBody(await notice({ previousDate: FAR_DATE }));
  });

  test('no previous date given (an unknown caller): the window', async () => {
    todayBody(await notice({}));
    jest.clearAllMocks();
    todayBody(await notice(undefined));
  });

  test('inside the 24.25 h cutoff', async () => {
    const soon = new Date(Date.now() + 5 * 3600000);
    const hhmm = soon.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
    const out = await notice({ previousDate: '2000-01-01' }, { date: etDateString(soon), start: hhmm });
    expect(out.body).toBe('window body');
    expect(out.meta).not.toHaveProperty('promise_level');
  });

  test('the customer\'s 24-hour reminder will not go out', async () => {
    AppointmentReminders.getReminderPrefs.mockResolvedValueOnce({ serviceReminder24h: false });
    todayBody(await notice({ previousDate: OLD_DATE }));
  });

  test('an unreadable preference row', async () => {
    AppointmentReminders.getReminderPrefs.mockRejectedValueOnce(new Error('prefs unreadable'));
    todayBody(await notice({ previousDate: OLD_DATE }));
  });

  test('the day row missing: today\'s row, the marker comes off the metadata, the email leg is a window email', async () => {
    renderer.renderSmsTemplate.mockResolvedValue(undefined);
    const out = await notice({ previousDate: OLD_DATE }, { delivered: false });
    expect(out.body).toBe('window body');
    expect(out.meta).not.toHaveProperty('promise_level');
    expect(out.meta).not.toHaveProperty('window_unknown');
    expect(out.meta).not.toHaveProperty('guard_slot_ms');
    expect(out.meta).toMatchObject({ rendered_slot_ms: SLOT_MS });
    expect(AppointmentReminders.deliverMoveNoticeEmail.mock.calls[0][0]).not.toHaveProperty('dayOnly');
  });

  test('gate off: byte for byte today (body, exact metadata keys, email arguments), and nothing is read for the decision', async () => {
    delete process.env.GATE_DAY_ONLY_PROMISE;
    const out = await notice({ previousDate: OLD_DATE }, { delivered: false });
    todayBody(out);
    expect(Object.keys(out.meta).sort()).toEqual(['move_notice_at', 'rendered_slot_ms', 'scheduled_service_id']);
    expect(AppointmentReminders.getReminderPrefs).not.toHaveBeenCalled();
    expect(Object.keys(AppointmentReminders.deliverMoveNoticeEmail.mock.calls[0][0]).sort()).toEqual(
      ['arrivalWindow', 'customerId', 'kind', 'noticeAt', 'notificationEventKey', 'scheduledServiceId', 'sendOutcome', 'serviceLabel', 'apptTime'].sort(),
    );
  });
});

describe('recordOfficeMoveIntent (the write inside the moving transaction)', () => {
  const conn = () => {
    const writes = [];
    const fn = (table) => ({ whereIn: (_col, ids) => ({ update: async (patch) => { writes.push({ table, ids, patch }); return ids.length; } }) });
    fn.writes = writes;
    fn.raw = (sql) => ({ raw: sql });
    return fn;
  };

  test('gate on: true only for exactly true, else false; every moved member', async () => {
    const c = conn();
    await recordOfficeMoveIntent(c, ['a', 'b'], { customerAskedTime: true });
    await recordOfficeMoveIntent(c, ['c'], {});
    await recordOfficeMoveIntent(c, ['d'], { customerAskedTime: 'true' });
    await recordOfficeMoveIntent(c, ['e'], undefined);
    expect(c.writes.map((w) => [w.ids, w.patch.customer_asked_time])).toEqual([[['a', 'b'], true], [['c'], false], [['d'], false], [['e'], false]]);
  });

  test('gate off: no write, so the UPDATE payloads stay today\'s', async () => {
    delete process.env.GATE_DAY_ONLY_PROMISE;
    const c = conn();
    await recordOfficeMoveIntent(c, ['a'], { customerAskedTime: true });
    expect(c.writes).toEqual([]);
  });
});
