'use strict';

// GATE_DAY_ONLY_PROMISE part B2 (owner 2026-11-05 "D2 a", 2026-11-06 "office"): a customer move that chose "any time that
// day" (handleReschedule options.timePromise 'day') promises only the new day; 'set_time' and no choice keep today's
// window copy; the held/merged re-send keeps the recorded intent; a bounced day-only reschedule text is revalidated before
// its recovery email. Synthetic data only; the outbound layer is stubbed, nothing is sent.

// A lenient knex stand-in: every table answers from mockDb, so a test states
// only the rows it cares about. A function answer gets the selected columns
// and the where() arguments. Updates and inserts are recorded; with
// mockDb.reminder set, every appointment_reminders update also applies to it.
const mockDb = { first: {}, rows: {}, updates: [], inserts: [], reminder: null };
jest.mock('../models/db', () => {
  const make = (table) => {
    const q = { wheres: [] };
    for (const m of ['andWhere', 'orWhere', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw',
      'whereExists', 'whereNotExists', 'orderBy', 'leftJoin', 'join', 'limit', 'forUpdate', 'forShare', 'noWait', 'skipLocked',
      'modify', 'distinct', 'groupBy', 'count', 'select', 'returning']) q[m] = () => q;
    q.where = (...a) => { q.wheres.push(a); return q; };
    q.first = async (...cols) => {
      const v = mockDb.first[table];
      return typeof v === 'function' ? v(cols, q.wheres) : v;
    };
    q.pluck = async () => [];
    q.update = async (patch) => {
      mockDb.updates.push({ table, patch });
      if (table === 'appointment_reminders' && mockDb.reminder) Object.assign(mockDb.reminder, patch);
      return 1;
    };
    q.insert = (row) => {
      mockDb.inserts.push({ table, row });
      return { returning: async () => [{ id: `new-${table}`, ...row }], then: (res, rej) => Promise.resolve([1]).then(res, rej) };
    };
    q.del = async () => 1;
    q.then = (res, rej) => Promise.resolve(mockDb.rows[table] || []).then(res, rej);
    return q;
  };
  const db = jest.fn((table) => make(table));
  db.raw = jest.fn((sql) => sql);
  db.transaction = jest.fn(async (fn) => fn(db));
  db.fn = { now: () => new Date() };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/street-level-hold', () => ({ ...jest.requireActual('../services/street-level-hold'), isStreetLevelHoldVisit: jest.fn(async () => false) }));
jest.mock('../services/messaging/send-customer-message', () => ({
  ...jest.requireActual('../services/messaging/send-customer-message'),
  sendCustomerMessage: jest.fn(async () => ({ sent: false, code: 'PROVIDER_FAILED' })),
}));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(async () => 'Your visit moved.') }));
jest.mock('../services/appointment-email', () => ({
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
  sendTechEnRouteEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentRescheduledEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentCancelledEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
jest.mock('../services/reschedule-link', () => ({
  buildRescheduleLink: jest.fn(async () => ({ url: 'https://example.invalid/r/1' })),
  rescheduledTextLine: jest.fn(async () => 'Need a different time? Reschedule here: https://example.invalid/r/1'),
  rescheduledDayTextLine: jest.fn(async () => 'Need a different day or a set time? https://example.invalid/r/1'),
}));
jest.mock('../services/visit-groups', () => ({ ...jest.requireActual('../services/visit-groups'), appointmentSendHeld: jest.fn(async () => false) }));
jest.mock('../services/cancel-generation-fence', () => ({ ...jest.requireActual('../services/cancel-generation-fence'), countRestorations: jest.fn(async () => 0) }));
jest.mock('../services/property-notification-prefs', () => ({ ...jest.requireActual('../services/property-notification-prefs'), prefsForVisit: jest.fn(async (prefs) => prefs) }));
jest.mock('../services/recipient-optin', () => ({ ...jest.requireActual('../services/recipient-optin'), filterRecipientsByOptin: jest.fn(async (contacts) => contacts) }));
jest.mock('../services/contact-notification-prefs', () => ({
  ...jest.requireActual('../services/contact-notification-prefs'),
  filterContactsByOwnPrefs: jest.fn(async (contacts) => contacts),
}));

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AppointmentEmail = require('../services/appointment-email');
const { countRestorations } = require('../services/cancel-generation-fence');
const AppointmentReminders = require('../services/appointment-reminders');


// Synthetic customer. Far-future slot so "the slot is ahead" holds.
const CUSTOMER = { id: 'cust-1', first_name: 'Pat', last_name: 'Example', phone: '+19415550101', email: 'pat@example.com', is_primary_profile: true, account_id: null };
// 4:00 PM Eastern (standard time in November).
const NOTICE_AT = new Date('2099-10-24T12:00:00.000Z');

function base({ status = 'confirmed', prefs = {} } = {}) {
  mockDb.first = {
    customers: CUSTOMER,
    notification_prefs: { customer_id: 'cust-1', ...prefs },
    scheduled_services: { status, visit_id: null },
    notifications: null,
    sms_log: null,
    phone_line_types: null,
    // The cancellation claim ownership check (.first('id')): owned by default.
    appointment_reminders: { id: 'rem-1' },
  };
  mockDb.rows = {};
  mockDb.updates = [];
  mockDb.inserts = [];
  mockDb.reminder = null;
}



const reminder = {
  id: 'rem-1', scheduled_service_id: 'svc-1', customer_id: 'cust-1', appointment_time: new Date('2099-11-02T14:00:00.000Z'),
  service_type: 'Pest Control', confirmation_sent: true, reminder_72h_sent: false, reminder_24h_sent: false,
  windows_preclosed: false, suppressed_by_sibling: false, cancelled: false,
};
const DAY_KEY = 'appointment_rescheduled_day_v1';

function rows({ lineType = 'mobile', windowStart = '16:00:00' } = {}) {
  mockDb.first.customers = { ...CUSTOMER, line_type: lineType };
  mockDb.first.scheduled_services = { status: 'confirmed', visit_id: null, scheduled_date: '2099-11-04', window_start: windowStart };
  mockDb.first.appointment_reminders = reminder;
}
const templateKeys = () => require('../routes/admin-sms-templates').getTemplate.mock.calls.map((c) => c[0]);
const lastMeta = () => sendCustomerMessage.mock.calls[0][0].metadata;
const reschedule = (options) => AppointmentReminders.handleReschedule('svc-1', '2099-11-04T16:00', options);

beforeEach(() => {
  jest.clearAllMocks();
  countRestorations.mockResolvedValue(0);
  process.env.GATE_MOVE_NOTICE_EMAIL = 'true';
  process.env.GATE_DAY_ONLY_PROMISE = 'true';
  base();
  rows();
  sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM-ok' });
});
afterAll(() => { delete process.env.GATE_MOVE_NOTICE_EMAIL; delete process.env.GATE_DAY_ONLY_PROMISE; });

describe('handleReschedule: a customer move', () => {
  test("timePromise 'day', another date, far out: the day row, no window or time vars, the day marker, and no slot recorded as the promise", async () => {
    await reschedule({ timePromise: 'day', previousDate: '2099-11-02' });
    expect(templateKeys()).toEqual([DAY_KEY]);
    const [, vars] = require('../routes/admin-sms-templates').getTemplate.mock.calls[0];
    expect(vars).toEqual(expect.objectContaining({ first_name: 'Pat', day: expect.any(String), date: expect.any(String), different_time_line: 'Need a different day or a set time? https://example.invalid/r/1' }));
    expect(vars).not.toHaveProperty('window');
    expect(vars).not.toHaveProperty('time');
    const meta = lastMeta();
    expect(meta).toMatchObject({ promise_level: 'day', window_unknown: true, move_notice_slot_ms: Date.parse('2099-11-04T21:00:00.000Z') });
    expect(meta.guard_slot_ms).toBe(Date.parse('2099-11-04T21:00:00.000Z'));
    expect(meta.promised_date).toBe('2099-11-04');
    // The guard slot still rides on the send (the ABA guard), but it is not recorded as the promise.
    expect(sendCustomerMessage.mock.calls[0][0].promisedWindowUnknown).toBe(true);
  });

  test("timePromise 'set_time': today's copy and metadata, unchanged", async () => {
    await reschedule({ timePromise: 'set_time', previousDate: '2099-11-02' });
    expect(templateKeys()).toEqual(['appointment_rescheduled']);
    const meta = lastMeta();
    expect(meta).not.toHaveProperty('promise_level');
    expect(meta).not.toHaveProperty('window_unknown');
    expect(meta).not.toHaveProperty('guard_slot_ms');
    expect(sendCustomerMessage.mock.calls[0][0]).not.toHaveProperty('promisedWindowUnknown');
  });

  test('no option at all: exactly today', async () => {
    await reschedule(undefined);
    expect(templateKeys()).toEqual(['appointment_rescheduled']);
    expect(Object.keys(lastMeta()).sort()).toEqual(['move_notice_at', 'move_notice_slot_ms', 'original_message_type', 'rendered_slot_ms', 'scheduled_service_id', 'templateKey', 'useCustomerChannel'].sort());
  });

  test("'day' but the date did not change (a same-day re-time), or the previous date is unknown: the window", async () => {
    await reschedule({ timePromise: 'day', previousDate: '2099-11-04' });
    expect(templateKeys()).toEqual(['appointment_rescheduled']);
    jest.clearAllMocks();
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM-ok' });
    await reschedule({ timePromise: 'day' });
    expect(templateKeys()).toEqual(['appointment_rescheduled']);
  });

  test("'day' inside the 24.25 h cutoff: the window", async () => {
    const soon = new Date(Date.now() + 5 * 3600000);
    const { etDateString } = require('../utils/datetime-et');
    const hhmm = soon.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
    mockDb.first.scheduled_services = { status: 'confirmed', visit_id: null, scheduled_date: etDateString(soon), window_start: `${hhmm}:00` };
    await AppointmentReminders.handleReschedule('svc-1', `${etDateString(soon)}T${hhmm}`, { timePromise: 'day', previousDate: '2000-01-01' });
    expect(templateKeys()).toEqual(['appointment_rescheduled']);
  });

  test("'day' for a windowless move keeps today's windowless copy (no 24-hour text will follow)", async () => {
    rows({ windowStart: null });
    await reschedule({ timePromise: 'day', previousDate: '2099-11-02' });
    expect(templateKeys()).toEqual(['appointment_rescheduled']);
    expect(lastMeta()).toMatchObject({ window_unknown: true });
    expect(lastMeta()).not.toHaveProperty('promise_level');
  });

  test("'day' but the customer's 24-hour reminder is off: the window", async () => {
    mockDb.first.notification_prefs = { customer_id: 'cust-1', service_reminder_24h: false };
    await reschedule({ timePromise: 'day', previousDate: '2099-11-02' });
    expect(templateKeys()).toEqual(['appointment_rescheduled']);
  });

  test("'day' with the day row missing: today's row, and the metadata loses the marker (a customer always gets a text)", async () => {
    const { getTemplate } = require('../routes/admin-sms-templates');
    getTemplate.mockImplementation(async (key) => (key === DAY_KEY ? null : 'Your visit moved.'));
    await reschedule({ timePromise: 'day', previousDate: '2099-11-02' });
    expect(templateKeys()).toEqual([DAY_KEY, 'appointment_rescheduled']);
    const meta = lastMeta();
    expect(meta).not.toHaveProperty('promise_level');
    expect(meta).not.toHaveProperty('window_unknown');
    expect(meta).not.toHaveProperty('guard_slot_ms');
    expect(meta.move_notice_slot_ms).toBe(Date.parse('2099-11-04T21:00:00.000Z'));
    getTemplate.mockImplementation(async () => 'Your visit moved.');
  });

  test('gate off: a day choice is ignored, byte for byte today', async () => {
    delete process.env.GATE_DAY_ONLY_PROMISE;
    await reschedule({ timePromise: 'day', previousDate: '2099-11-02' });
    expect(templateKeys()).toEqual(['appointment_rescheduled']);
    expect(lastMeta()).not.toHaveProperty('promise_level');
    expect(mockDb.updates.filter((u) => u.table === 'scheduled_services')).toEqual([]);
  });

  test('the recorded intent: day -> customer_asked_time false, set_time -> true; none -> nothing written', async () => {
    const written = () => mockDb.updates.filter((u) => u.table === 'scheduled_services').map((u) => u.patch);
    await reschedule({ timePromise: 'day', previousDate: '2099-11-02' });
    expect(written()).toEqual([{ customer_asked_time: false }]);
    mockDb.updates = [];
    await reschedule({ timePromise: 'set_time', previousDate: '2099-11-02' });
    expect(written()).toEqual([{ customer_asked_time: true }]);
    mockDb.updates = [];
    await reschedule(undefined);
    expect(written()).toEqual([]);
  });

  test('a day text that reached nobody (a landline) is followed by the DAY email, and a window one by the window email', async () => {
    rows({ lineType: 'landline' });
    await reschedule({ timePromise: 'day', previousDate: '2099-11-02' });
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentRescheduledEmail.mock.calls[0][0]).toMatchObject({ dayOnly: true, windowUnknown: false });
    jest.clearAllMocks();
    await reschedule({ timePromise: 'set_time', previousDate: '2099-11-02' });
    expect(AppointmentEmail.sendAppointmentRescheduledEmail.mock.calls[0][0]).not.toHaveProperty('dayOnly');
  });
});

describe('a bounced day-only reschedule text (handleUndeliveredSms)', () => {
  const SLOT_MS = Date.parse('2099-11-04T21:00:00.000Z');
  const dayAudit = {
    channel: 'sms', purpose: 'appointment_confirmation', customer_id: 'cust-1', created_at: '2099-10-24T12:00:05.000Z',
    metadata: {
      original_message_type: 'appointment_rescheduled', scheduled_service_id: 'svc-1', move_notice_at: NOTICE_AT.toISOString(),
      promise_level: 'day', window_unknown: true, guard_slot_ms: SLOT_MS, promised_date: '2099-11-04', move_notice_slot_ms: SLOT_MS,
    },
  };
  const bounce = () => AppointmentReminders.handleUndeliveredSms({ sid: 'SM1', status: 'undelivered', errorCode: '30003', to: '+19415550199' });
  const timePromise = require('../services/time-promise');

  beforeEach(() => {
    mockDb.first.messaging_audit_log = dayAudit;
    mockDb.first.appointment_reminders = { appointment_time: '2099-11-04T21:00:00.000Z', service_type: 'Pest Control', cancelled: false };
  });

  test('through the delayed-send chokepoint: the shared decision still says day and no hour told since: the DAY email, never the unknown-window phrase', async () => {
    jest.spyOn(timePromise, 'loadPromiseLevels').mockResolvedValue(new Map([['svc-1', 'day']]));
    const decision = jest.spyOn(timePromise, 'dayOnlySendDecision').mockResolvedValue({ dayOnly: true });
    await bounce();
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).toHaveBeenCalledTimes(1);
    const sent = AppointmentEmail.sendAppointmentRescheduledEmail.mock.calls[0][0];
    expect(sent).toMatchObject({ dayOnly: true, windowUnknown: false, appointmentTime: new Date(SLOT_MS) });
    expect(sent.arrivalWindow).toBe('between 4:00 PM and 6:00 PM');
    expect(decision).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'svc-1', reminder24hEnabled: true }));
  });

  test('the shared decision no longer says day (gate rolled back, inside the cutoff, 24-hour reminder off): today\'s window email, with the real window', async () => {
    jest.spyOn(timePromise, 'loadPromiseLevels').mockResolvedValue(new Map([['svc-1', 'day']]));
    jest.spyOn(timePromise, 'dayOnlySendDecision').mockResolvedValue({ dayOnly: false });
    await bounce();
    const sent = AppointmentEmail.sendAppointmentRescheduledEmail.mock.calls[0][0];
    expect(sent).not.toHaveProperty('dayOnly');
    expect(sent).toMatchObject({ windowUnknown: false, arrivalWindow: 'between 4:00 PM and 6:00 PM' });
  });

  test('a replayed day text keeps only B1\'s promise fields: the quoted slot is recovered from guard_slot_ms', async () => {
    jest.spyOn(timePromise, 'loadPromiseLevels').mockResolvedValue(new Map([['svc-1', 'day']]));
    jest.spyOn(timePromise, 'dayOnlySendDecision').mockResolvedValue({ dayOnly: true });
    const { move_notice_slot_ms: _dropped, ...kept } = dayAudit.metadata;
    mockDb.first.messaging_audit_log = { ...dayAudit, metadata: kept };
    await bounce();
    expect(AppointmentEmail.sendAppointmentRescheduledEmail.mock.calls[0][0]).toMatchObject({ dayOnly: true, appointmentTime: new Date(SLOT_MS) });
  });

  test('an hour was told since (the 24-hour text, a newer window): the stale recovery is suppressed', async () => {
    jest.spyOn(timePromise, 'loadPromiseLevels').mockResolvedValue(new Map([['svc-1', 'hour']]));
    await bounce();
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).not.toHaveBeenCalled();
  });

  // Finding: the bounced day text is excluded by the reader, so the visit's latest delivered promise can be the OLD date's hour
  // confirmation. That promise predates the move notice (or is for another date) and must not supersede it.
  describe('the promise that stands is judged against the notice being recovered', () => {
    const told = require('../services/auto-dispatch/told-visits');
    const hourPromise = (communicatedAt, startAt) => ({ visit_id: 'svc-1', start_at: startAt, communicated_at: communicatedAt, source: 'message' });
    const OLD_CONFIRMATION = hourPromise('2099-10-20T12:00:00.000Z', '2099-10-30T14:00:00.000Z'); // before the move, for the old date

    test('an old delivered hour confirmation (old date, before the move) does not suppress: the NEW date gets the day email, level ignored', async () => {
      jest.spyOn(timePromise, 'loadPromiseLevels').mockResolvedValue(new Map([['svc-1', 'hour']]));
      jest.spyOn(told, 'resolvePromises').mockResolvedValue(new Map([['svc-1', OLD_CONFIRMATION]]));
      const decision = jest.spyOn(timePromise, 'dayOnlySendDecision').mockResolvedValue({ dayOnly: true });
      await bounce();
      expect(AppointmentEmail.sendAppointmentRescheduledEmail).toHaveBeenCalledTimes(1);
      expect(AppointmentEmail.sendAppointmentRescheduledEmail.mock.calls[0][0]).toMatchObject({ dayOnly: true, windowUnknown: false, appointmentTime: new Date(SLOT_MS) });
      expect(decision).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'svc-1', ignoreLevel: true }));
    });

    test('the same plus a LATER delivered 24-hour window for the new date: suppressed', async () => {
      jest.spyOn(timePromise, 'loadPromiseLevels').mockResolvedValue(new Map([['svc-1', 'hour']]));
      jest.spyOn(told, 'resolvePromises').mockResolvedValue(new Map([['svc-1', hourPromise('2099-11-03T21:00:00.000Z', '2099-11-04T21:00:00.000Z')]]));
      jest.spyOn(timePromise, 'dayOnlySendDecision').mockResolvedValue({ dayOnly: true });
      await bounce();
      expect(AppointmentEmail.sendAppointmentRescheduledEmail).not.toHaveBeenCalled();
    });

    test('a promise newer than the notice but for a different date is not the notice\'s: the day email still goes', async () => {
      jest.spyOn(timePromise, 'loadPromiseLevels').mockResolvedValue(new Map([['svc-1', 'hour']]));
      jest.spyOn(told, 'resolvePromises').mockResolvedValue(new Map([['svc-1', hourPromise('2099-10-25T12:00:00.000Z', '2099-11-09T21:00:00.000Z')]]));
      jest.spyOn(timePromise, 'dayOnlySendDecision').mockResolvedValue({ dayOnly: true });
      await bounce();
      expect(AppointmentEmail.sendAppointmentRescheduledEmail).toHaveBeenCalledTimes(1);
    });

    test('a newer unknown-window promise, or one that cannot be resolved, fails closed', async () => {
      jest.spyOn(timePromise, 'loadPromiseLevels').mockResolvedValue(new Map([['svc-1', 'hour']]));
      jest.spyOn(timePromise, 'dayOnlySendDecision').mockResolvedValue({ dayOnly: true });
      jest.spyOn(told, 'resolvePromises').mockResolvedValue(new Map([['svc-1', hourPromise('2099-10-25T12:00:00.000Z', null)]]));
      await bounce();
      jest.spyOn(told, 'resolvePromises').mockResolvedValue(new Map());
      await bounce();
      jest.spyOn(told, 'resolvePromises').mockRejectedValue(new Error('read failed'));
      await bounce();
      expect(AppointmentEmail.sendAppointmentRescheduledEmail).not.toHaveBeenCalled();
    });
  });

  test('the promise cannot be read: suppressed (a day email must not supersede a window it cannot see)', async () => {
    jest.spyOn(timePromise, 'loadPromiseLevels').mockRejectedValue(new Error('read failed'));
    await bounce();
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).not.toHaveBeenCalled();
  });

  test('a window text that bounced recovers exactly as before (no revalidation, no day arg)', async () => {
    mockDb.first.messaging_audit_log = {
      ...dayAudit, metadata: { original_message_type: 'appointment_rescheduled', scheduled_service_id: 'svc-1', rendered_slot_ms: SLOT_MS, move_notice_at: NOTICE_AT.toISOString() },
    };
    const spy = jest.spyOn(timePromise, 'loadPromiseLevels');
    await bounce();
    expect(spy).not.toHaveBeenCalled();
    expect(AppointmentEmail.sendAppointmentRescheduledEmail.mock.calls[0][0]).not.toHaveProperty('dayOnly');
  });

  afterEach(() => { jest.restoreAllMocks(); });
});

describe('the customer move intent write is bound to the slot that move committed (customerMoveSlot)', () => {
  const { customerMoveSlot } = AppointmentReminders._test;
  test('the pinned slot wins; with no start key any start on that date; an explicit null start is "no window"', () => {
    expect(customerMoveSlot('2099-11-04T09:00', { expectSchedule: { date: '2099-11-04', windowStart: '13:00:00' } }, {})).toEqual({ date: '2099-11-04', windowStart: '13:00:00' });
    expect(customerMoveSlot('2099-11-04T09:00', { expectSchedule: { date: '2099-11-04' } }, {})).toEqual({ date: '2099-11-04', windowStart: undefined });
    expect(customerMoveSlot('2099-11-04T09:00', { expectSchedule: { date: '2099-11-04', windowStart: null } }, {})).toEqual({ date: '2099-11-04', windowStart: null });
  });
  test('otherwise the slot the caller named; a windowless visit has no start', () => {
    expect(customerMoveSlot('2099-11-04T09:30', {}, { windowless: false })).toEqual({ date: '2099-11-04', windowStart: '09:30' });
    expect(customerMoveSlot('2099-11-04T08:00', undefined, { windowless: true })).toEqual({ date: '2099-11-04', windowStart: null });
  });
});

describe('a held or merged move notice re-sent as a confirmation keeps the recorded intent (confirmationDayOnly)', () => {
  const timePromise = require('../services/time-promise');
  const { confirmationDayOnly } = AppointmentReminders._test;
  const FAR = new Date('2099-11-04T21:00:00.000Z');
  const prefs = { serviceReminder24h: true, smsEnabled: true, reminder24hChannel: 'sms' };
  const run = (over = {}) => confirmationDayOnly(over.record || {}, { scheduledServiceId: 'svc-1', apptTime: FAR, prefs: over.prefs || prefs });
  let send;
  let replay;

  beforeEach(() => {
    send = jest.spyOn(timePromise, 'dayOnlySendDecision').mockResolvedValue({ dayOnly: false });
    replay = jest.spyOn(timePromise, 'dayOnlyReplayDecision').mockResolvedValue(false);
  });
  afterEach(() => { jest.restoreAllMocks(); });

  test("a day intent re-sends the day row even when today's rules (an older hour promise) say window", async () => {
    replay.mockResolvedValue(true);
    expect(await run()).toBe(true);
    expect(replay).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'svc-1', startAt: FAR, reminder24hEnabled: true }));
  });

  test("a set time (the replay says no) stays a window; today's day-only decision still wins when it says day", async () => {
    expect(await run()).toBe(false);
    send.mockResolvedValue({ dayOnly: true });
    replay.mockClear();
    expect(await run()).toBe(true);
    expect(replay).not.toHaveBeenCalled();
  });

  test('a customer whose 24-hour reminder will not go out never gets the day row', async () => {
    expect(await run({ prefs: { ...prefs, serviceReminder24h: false } })).toBe(false);
    expect(replay).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reminder24hEnabled: false }));
  });

  test('a windowless pre-closed placeholder is never day-only; gate off asks nothing', async () => {
    replay.mockResolvedValue(true);
    expect(await run({ record: { windows_preclosed: true } })).toBe(false);
    delete process.env.GATE_DAY_ONLY_PROMISE;
    replay.mockClear();
    expect(await run()).toBe(false);
    expect(replay).not.toHaveBeenCalled();
  });
});
