/**
 * GATE_BOOKING_TEXT_COVERS_DAY_BEFORE (owner 2026-11-09). A customer who books a visit for tomorrow got the booking
 * confirmation text and, minutes later, the 24-hour "is tomorrow" reminder.
 *
 * Three booking paths, one shared rule (confirmationCoversDayBefore):
 *   - call pipeline (source_action ai_call_pipeline): registers the row with sendConfirmation:false, sends its own text
 *     afterwards, so it closes the 24h flag through closeDayBeforeForBookingText (gated).
 *   - office-booked (admin_manual) and self-booked (inspection_link -> createSelfBooking, booking_new): the text goes
 *     through deliverConfirmation, which already closes the flag in the confirmation's own write (ungated, #6882).
 * All names are synthetic.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../utils/customer-comms-lock', () => ({
  // The real helper opens a transaction and takes the advisory lock; here it just runs the callback and records the id.
  withCustomerCommsLock: jest.fn(async (_db, customerId, fn) => fn({ customerId })),
  lockCustomerComms: jest.fn(),
}));
jest.mock('../services/recipient-optin', () => ({ filterRecipientsByOptin: jest.fn(async (contacts) => contacts) }));
jest.mock('../services/contact-notification-prefs', () => ({ filterContactsByOwnPrefs: jest.fn(async (contacts) => contacts) }));
jest.mock('../services/property-notification-prefs', () => ({ prefsForVisit: jest.fn(async (prefs) => prefs) }));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn(() => []),
  isServiceContactRole: jest.fn(() => false),
  prefsUnavailable: jest.fn(() => false),
  firstNameFrom: jest.fn(() => null),
  PREFS_UNAVAILABLE: Object.freeze({ __prefsUnavailable: true }),
}));
jest.mock('../services/appointment-email', () => ({
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
  sendTechEnRouteEmail: jest.fn(async () => ({ ok: true })),
  _private: { loadCustomer: jest.fn(async (id) => ({ id })), resolveRecipients: jest.fn(async () => []) },
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/messaging/send-window', () => ({ isWithinSendWindowET: jest.fn(() => true) }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gateEnvValue: jest.fn(() => false),
  bookingTextCoversDayBeforeLive: jest.fn(() => false),
}));

const db = require('../models/db');
const CustomerContact = require('../services/customer-contact');
const CommsLock = require('../utils/customer-comms-lock');
const AppointmentEmail = require('../services/appointment-email');
const gates = require('../config/feature-gates');
const AppointmentReminders = require('../services/appointment-reminders');
const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');

const { deliverConfirmation } = AppointmentReminders._test;
const { closeDayBeforeForBookingText } = AppointmentReminders;

const tomorrowNoonET = () => parseETDateTime(`${etDateString(addETDays(new Date(), 1))}T12:00`);
const inDaysNoonET = (n) => parseETDateTime(`${etDateString(addETDays(new Date(), n))}T12:00`);

const SAVED_PHONE = '+19415550101'; // the customer's saved number (the 24h reminder's recipient)
const OTHER_PHONE = '+19415550199'; // a different caller number (the implied-consent redirect target)

/** A knex-style chain that records every appointment_reminders write: { where, patch }. */
function recordingDb({ updated = 1 } = {}) {
  const writes = [];
  db.mockImplementation((table) => {
    const q = { _where: [] };
    ['whereIn', 'whereRaw', 'whereNotNull', 'orderBy', 'select', 'leftJoin'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.where = jest.fn((cond) => { q._where.push(cond); if (cond === 'member_since') q.memberSince = true; return q; });
    q.update = jest.fn(async (patch) => { if (table === 'appointment_reminders') writes.push({ where: q._where, patch }); return updated; });
    const rows = {
      notification_prefs: { appointment_confirmation_channel: 'email' },
      customers: { id: 'c1', account_id: 'acct-1', is_primary_profile: true, first_name: 'Sample', email: 'sample@example.com', phone: SAVED_PHONE },
      scheduled_services: { id: 'done-1' },
    };
    q.first = jest.fn(async () => (q.memberSince ? null : rows[table] ?? null));
    return q;
  });
  return writes;
}

beforeEach(() => {
  jest.clearAllMocks();
  gates.bookingTextCoversDayBeforeLive.mockReturnValue(false);
  CustomerContact.getAppointmentContacts.mockImplementation(() => [{ phone: SAVED_PHONE, name: 'Sample Customer', role: 'primary' }]);
  AppointmentEmail.sendAppointmentConfirmationEmail.mockResolvedValue({ ok: true });
});

describe('call pipeline: closeDayBeforeForBookingText (the shared rule, gated)', () => {
  const close = (over = {}) => closeDayBeforeForBookingText({
    scheduledServiceId: 'ss1', apptTime: tomorrowNoonET(), sent: true, customerId: 'c1', recipientPhone: SAVED_PHONE, ...over,
  });

  test('gate off: nothing is read or written, the 24h reminder stays armed', async () => {
    const writes = recordingDb();
    await expect(close()).resolves.toBe(false);
    expect(writes).toHaveLength(0);
    expect(db).not.toHaveBeenCalled();
  });

  test('a gate reader missing from a bare feature-gates mock reads as off', async () => {
    const writes = recordingDb();
    const original = gates.bookingTextCoversDayBeforeLive;
    delete gates.bookingTextCoversDayBeforeLive;
    try {
      await expect(close()).resolves.toBe(false);
    } finally {
      gates.bookingTextCoversDayBeforeLive = original;
    }
    expect(writes).toHaveLength(0);
  });

  test('gate on, text delivered, visit tomorrow: one write closes the 24h flag, fenced on the quoted time', async () => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    const writes = recordingDb();
    const apptTime = tomorrowNoonET();
    await expect(close({ apptTime })).resolves.toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].where[0]).toEqual({
      scheduled_service_id: 'ss1', appointment_time: apptTime, cancelled: false, reminder_24h_sent: false,
    });
    expect(writes[0].patch).toEqual(expect.objectContaining({ reminder_24h_sent: true, reminder_24h_sent_at: expect.any(Date) }));
  });

  test('gate on, visit later today: closed too (a delivered text for today is the notice)', async () => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    const writes = recordingDb();
    await expect(close({ apptTime: inDaysNoonET(0) })).resolves.toBe(true);
    expect(writes).toHaveLength(1);
  });

  test('gate on, confirmation delivered to the reminder number in another format: closed (digits compare, not raw strings)', async () => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    const writes = recordingDb();
    await expect(close({ recipientPhone: '(941) 555-0101' })).resolves.toBe(true);
    expect(writes).toHaveLength(1);
  });

  test('gate on, ANI-only confirmation (implied consent redirected to a different number): not stamped, nothing written', async () => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    const writes = recordingDb();
    await expect(close({ recipientPhone: OTHER_PHONE })).resolves.toBe(false);
    expect(writes).toHaveLength(0);
  });

  test('gate on, redirected number that is a reminder contact but not the primary recipient: not stamped (decided by the primary)', async () => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    CustomerContact.getAppointmentContacts.mockImplementation(() => [
      { phone: OTHER_PHONE, name: 'Sample Contact', role: 'spouse' },
      { phone: SAVED_PHONE, name: 'Sample Customer', role: 'primary' },
    ]);
    const writes = recordingDb();
    await expect(close({ recipientPhone: OTHER_PHONE })).resolves.toBe(false);
    expect(writes).toHaveLength(0);
    await expect(close({ recipientPhone: SAVED_PHONE })).resolves.toBe(true);
    expect(writes).toHaveLength(1);
  });

  test.each([null, '', 'no digits'])('gate on, recipient unknown (%p): not stamped, nothing read or written', async (recipientPhone) => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    const writes = recordingDb();
    await expect(close({ recipientPhone })).resolves.toBe(false);
    expect(writes).toHaveLength(0);
    expect(db).not.toHaveBeenCalled();
  });

  test('gate on, the reminder recipient cannot be determined (no customer id, no contacts, unreadable prefs): not stamped', async () => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    let writes = recordingDb();
    await expect(close({ customerId: null })).resolves.toBe(false);
    CustomerContact.getAppointmentContacts.mockImplementation(() => []);
    await expect(close()).resolves.toBe(false);
    CustomerContact.getAppointmentContacts.mockImplementation(() => [{ phone: SAVED_PHONE, role: 'primary' }]);
    require('../services/property-notification-prefs').prefsForVisit.mockRejectedValueOnce(new Error('prefs down'));
    await expect(close()).resolves.toBe(false);
    expect(writes).toHaveLength(0);
    // an unreadable customer row
    writes = recordingDb();
    db.mockImplementationOnce(() => ({ where: () => ({ first: async () => null }) }));
    await expect(close()).resolves.toBe(false);
    expect(writes).toHaveLength(0);
  });

  test('gate on, send failed, blocked or held (sent false): not stamped', async () => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    const writes = recordingDb();
    await expect(close({ sent: false })).resolves.toBe(false);
    expect(writes).toHaveLength(0);
  });

  test('gate on, day-only confirmation: not stamped (it gave no window)', async () => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    const writes = recordingDb();
    await expect(close({ dayOnly: true })).resolves.toBe(false);
    expect(writes).toHaveLength(0);
  });

  test.each([2, 3, 10])('gate on, visit %i days out: not stamped (the 24h reminder is still owed)', async (days) => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    const writes = recordingDb();
    await expect(close({ apptTime: inDaysNoonET(days) })).resolves.toBe(false);
    expect(writes).toHaveLength(0);
  });

  test('gate on: a row that moved under the text (fence misses) reports false and stays armed', async () => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    const writes = recordingDb({ updated: 0 });
    await expect(close()).resolves.toBe(false);
    expect(writes).toHaveLength(1); // the fenced write ran and matched no row
  });

  test('a missing id or an invalid time never reaches the database', async () => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    recordingDb();
    await expect(closeDayBeforeForBookingText({ scheduledServiceId: null, apptTime: tomorrowNoonET(), sent: true, customerId: 'c1', recipientPhone: SAVED_PHONE })).resolves.toBe(false);
    await expect(closeDayBeforeForBookingText({ scheduledServiceId: 'ss1', apptTime: new Date('nope'), sent: true, customerId: 'c1', recipientPhone: SAVED_PHONE })).resolves.toBe(false);
    expect(db).not.toHaveBeenCalled();
  });
});

describe('call pipeline: closeDayBeforeAfterBookingText hands the booked slot to the shared rule', () => {
  let callProc;
  let spy;
  beforeAll(() => {
    callProc = require('../services/call-recording-processor')._test;
  });
  beforeEach(() => {
    spy = jest.spyOn(AppointmentReminders, 'closeDayBeforeForBookingText').mockResolvedValue(true);
  });
  afterEach(() => spy.mockRestore());

  test('the booked date and window become the fenced time; the text counts as sent and not day-only; the recipient rides along', async () => {
    const date = etDateString(addETDays(new Date(), 1));
    await expect(callProc.closeDayBeforeAfterBookingText({
      scheduledServiceId: 'ss1', scheduledDate: `${date}T00:00:00.000Z`, windowStart: '09:00:00', customerId: 'c1', recipientPhone: OTHER_PHONE,
    })).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith({
      scheduledServiceId: 'ss1', apptTime: parseETDateTime(`${date}T09:00`), sent: true, dayOnly: false, customerId: 'c1', recipientPhone: OTHER_PHONE,
    });
  });

  test('a windowless booking quotes the canonical 08:00 slot, the one the reminder row was registered at', async () => {
    const date = etDateString(addETDays(new Date(), 1));
    await callProc.closeDayBeforeAfterBookingText({ scheduledServiceId: 'ss1', scheduledDate: date, windowStart: null });
    expect(spy.mock.calls[0][0].apptTime).toEqual(parseETDateTime(`${date}T08:00`));
  });

  test('no visit id or date: nothing is called', async () => {
    await expect(callProc.closeDayBeforeAfterBookingText({ scheduledServiceId: null, scheduledDate: '2026-11-10', windowStart: '09:00' })).resolves.toBe(false);
    await expect(callProc.closeDayBeforeAfterBookingText({ scheduledServiceId: 'ss1', scheduledDate: null, windowStart: '09:00' })).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  test('a failure inside the close never throws into the call pass', async () => {
    spy.mockRejectedValue(new Error('db down'));
    await expect(callProc.closeDayBeforeAfterBookingText({ scheduledServiceId: 'ss1', scheduledDate: '2026-11-10', windowStart: '09:00' })).resolves.toBe(false);
  });

  test('the close runs only inside the fence around the send; the held branch and the sent branch never call it directly', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    // The old direct call in the "Appointment SMS sent" branch is gone.
    expect(src).not.toContain('await closeDayBeforeAfterBookingText(');
    const fence = 'sendBookingTextUnderReminderFence({';
    expect(src.split(`await ${fence}`)).toHaveLength(2);
    const at = src.indexOf(`await ${fence}`);
    // The held branch (nothing is sent) is the other arm of the same ternary, before the fence.
    const heldAt = src.lastIndexOf("code: holdImpliedSmsLeg ? 'implied_consent_non_ani_recipient'", at);
    expect(heldAt).toBeGreaterThan(-1);
    expect(at - heldAt).toBeLessThan(400);
    const arm = src.slice(at, at + 1200);
    expect(arm).toContain('close: () => closeDayBeforeAfterBookingText({ scheduledServiceId, scheduledDate: scheduledDateForLog, windowStart: windowStartForLog, customerId, recipientPhone: smsRecipient })');
    expect(arm).toContain('send: async () => sendCustomerMessage({');
    // primaryOk and the fence share one "really sent" test.
    expect(src).toContain('const primaryOk = bookingTextWasSent(sendResult);');
  });
});

describe('call pipeline: sendBookingTextUnderReminderFence (the text and the close under one customer-comms lock)', () => {
  let fence;
  let order;
  beforeAll(() => { fence = require('../services/call-recording-processor')._test.sendBookingTextUnderReminderFence; });
  beforeEach(() => {
    order = [];
    CommsLock.withCustomerCommsLock.mockImplementation(async (_db, customerId, fn) => {
      order.push(`lock:${customerId}`);
      const out = await fn({ customerId });
      order.push('unlock');
      return out;
    });
  });
  const make = (result = { sent: true }) => ({
    send: jest.fn(async () => { order.push('send'); return result; }),
    close: jest.fn(async () => { order.push('close'); return true; }),
  });

  test('gate off: send once, the lock is never taken, no close', async () => {
    const { send, close } = make();
    await expect(fence({ customerId: 'c1', send, close })).resolves.toEqual({ sent: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(CommsLock.withCustomerCommsLock).not.toHaveBeenCalled();
  });

  test('a gate reader missing from a bare feature-gates mock reads as off', async () => {
    const original = gates.bookingTextCoversDayBeforeLive;
    delete gates.bookingTextCoversDayBeforeLive;
    const { send, close } = make();
    try {
      await fence({ customerId: 'c1', send, close });
    } finally {
      gates.bookingTextCoversDayBeforeLive = original;
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(CommsLock.withCustomerCommsLock).not.toHaveBeenCalled();
  });

  test('gate on, text sent: lock taken with the customer id, send then close inside it, in that order', async () => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    const { send, close } = make();
    await expect(fence({ customerId: 'c1', send, close })).resolves.toEqual({ sent: true });
    expect(CommsLock.withCustomerCommsLock).toHaveBeenCalledTimes(1);
    expect(CommsLock.withCustomerCommsLock.mock.calls[0][1]).toBe('c1');
    expect(order).toEqual(['lock:c1', 'send', 'close', 'unlock']);
  });

  test.each([{ sent: false }, { blocked: true, sent: false, code: 'QUIET_HOURS_HOLD' }, { blocked: true }])(
    'gate on, text not sent (%j): no close, the result passes through',
    async (result) => {
      gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
      const { send, close } = make(result);
      await expect(fence({ customerId: 'c1', send, close })).resolves.toBe(result);
      expect(send).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
    },
  );

  test('gate on, no customer id: unfenced send, no close', async () => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    const { send, close } = make();
    await fence({ customerId: null, send, close });
    expect(send).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(CommsLock.withCustomerCommsLock).not.toHaveBeenCalled();
  });

  test('gate on, the lock cannot be taken before send ran: the confirmation still goes out once, unfenced, with no close', async () => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    CommsLock.withCustomerCommsLock.mockRejectedValue(Object.assign(new Error('pool exhausted'), { code: 'ECONNRESET' }));
    const { send, close } = make();
    await expect(fence({ customerId: 'c1', send, close })).resolves.toEqual({ sent: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  test('gate on, send throws inside the lock: the error surfaces and send is not retried', async () => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    const { send, close } = make();
    send.mockRejectedValue(new Error('provider down'));
    await expect(fence({ customerId: 'c1', send, close })).rejects.toThrow('provider down');
    expect(send).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  test('gate on, the close throws: swallowed, the send result still returns', async () => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    const { send, close } = make();
    close.mockRejectedValue(new Error('db down'));
    await expect(fence({ customerId: 'c1', send, close })).resolves.toEqual({ sent: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('gate on, releasing the lock fails after the text went out: the send result stands, no second send', async () => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(true);
    CommsLock.withCustomerCommsLock.mockImplementation(async (_db, _id, fn) => { await fn({}); throw new Error('commit lost'); });
    const { send, close } = make();
    await expect(fence({ customerId: 'c1', send, close })).resolves.toEqual({ sent: true });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('office-booked (admin_manual) and self-booked (inspection_link / booking_new) paths: deliverConfirmation, ungated', () => {
  // registerAppointment -> deliverConfirmation for both; the existing 2026-10-26 rule, unchanged by the new gate.
  const confirm = (apptTime) => deliverConfirmation(
    { id: 'rem1' },
    { scheduledServiceId: 'ss1', customerId: 'c1', apptTime, serviceLabel: 'Lawn Care' },
  );

  test.each([false, true])('gate %s: a delivered confirmation for tomorrow closes the 24h flag in the confirmation write', async (gateOn) => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(gateOn);
    const writes = recordingDb();
    await expect(confirm(tomorrowNoonET())).resolves.toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].patch).toEqual(expect.objectContaining({ confirmation_sent: true, reminder_24h_sent: true }));
  });

  test.each([false, true])('gate %s: a failed send leaves the 24h reminder armed', async (gateOn) => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(gateOn);
    AppointmentEmail.sendAppointmentConfirmationEmail.mockResolvedValue({ ok: false, reason: 'bounced' });
    const writes = recordingDb();
    await confirm(tomorrowNoonET());
    expect(writes.every((w) => !('reminder_24h_sent' in w.patch))).toBe(true);
  });

  test.each([false, true])('gate %s: a visit three days out keeps the 24h reminder armed', async (gateOn) => {
    gates.bookingTextCoversDayBeforeLive.mockReturnValue(gateOn);
    const writes = recordingDb();
    await expect(confirm(inDaysNoonET(3))).resolves.toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].patch).not.toHaveProperty('reminder_24h_sent');
  });
});
