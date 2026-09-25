/**
 * callback_number_needed reminder hold (P1-C, Codex round-1 finding on PR
 * #4807, folded into the owner ruling of 2026-09-25): a caller who
 * disclaims the inbound ANI as not their own, with no spoken callback, gets
 * the confirmation SMS held (call-recording-processor.js /
 * call-triage-flags.js's callerIdDisclaimedNeedsCallback) — but that hold
 * used to end there. The 72h/24h reminder cron (checkAndSendReminders, this
 * file) runs on its own schedule with no notion of a call-level hold, and
 * would still text the disclaimed ANI days later.
 *
 * Owner ruling (2026-09-25): do NOT simply hold the reminder — reach the
 * customer by EMAIL when one is on file, exactly like an ordinary
 * undeliverable-SMS case (deliverAppointmentNotice's existing SMS→email
 * fallback). Only when there is no email either does the visit go fully
 * unreached (deliverAppointmentEmailFallback's own alertNoReachableChannel
 * covers that, alongside the crm_notes stamp already written when the
 * customer record was created).
 *
 * The mechanism (round 6, number-keyed): call-recording-processor.js
 * records the disclaimed number in disclaimed_number_holds; while the
 * visit customer's phone on file is an actively held number,
 * safeSendAppointment treats the SMS leg as unreachable (returns a plain,
 * non-"held" false from smsAttempt) so the ALREADY EXISTING fallback
 * machinery in deliverAppointmentNotice runs unchanged. The hold lifts when
 * the office resolves the callback_number_needed card (the number row is
 * cleared) or the customer's phone moves to a number with no hold.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  readCachedLineType: jest.fn(async () => ({ state: 'hit', lineType: 'mobile' })),
  cacheLineType: jest.fn(),
  NON_SMS_LINE_TYPES: new Set(['landline', 'fixedVoip']),
}));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn((customer) => (customer?.phone
    ? [{ phone: customer.phone, name: customer.first_name, role: 'primary' }]
    : [])),
  isServiceContactRole: jest.fn(() => false),
  firstNameFrom: jest.fn((n) => n),
  prefsUnavailable: jest.fn(() => false),
  getPrimaryContact: jest.fn((customer) => ({ phone: customer?.phone, name: customer?.first_name, role: 'primary' })),
}));
jest.mock('../services/recipient-optin', () => ({
  filterRecipientsByOptin: jest.fn(async (contacts) => contacts),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => 'REMINDER BODY'),
}));
jest.mock('../services/estimate-card-holds', () => ({
  cardHoldReminderLine: jest.fn(async () => ''),
}));
jest.mock('../services/reschedule-link', () => ({
  buildRescheduleLink: jest.fn(async () => ({ url: null, line: '' })),
}));
jest.mock('../services/appointment-email', () => ({
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({})),
}));
// Round 6 (PR #4807, structural): "held" is a property of the customer's
// NUMBER (disclaimed_number_holds), read by safeSendAppointment's pre-check
// through disclaimedNumberHeldForVisit. Each test sets it explicitly; the
// row-level read itself is covered in callback-number-hold-boundary.test.js.
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberHeldForVisit: jest.fn(async () => false),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AppointmentEmail = require('../services/appointment-email');
const AppointmentReminders = require('../services/appointment-reminders');
const { disclaimedNumberHeldForVisit } = require('../services/disclaimed-number-holds');

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn(function where(arg) {
      if (typeof arg === 'function') arg.call(builder);
      return builder;
    }),
    orWhere: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    whereNotExists: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue([]),
    first: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(1),
    ...overrides,
  });
  return builder;
}

function wireDb(queues) {
  db.mockImplementation((table) => {
    const q = queues[table];
    if (!q || q.length === 0) {
      // Tables this test doesn't care about pinning exactly (e.g. the
      // no-reachable-channel alert's own notifications/customers/
      // notification_prefs lookups) get an inert default chain rather than
      // failing the whole scan — the assertions below check the alert
      // fired, not every query it took to decide that.
      return chain();
    }
    return q.shift();
  });
}

function row72(overrides = {}) {
  return {
    id: 'rem-1',
    customer_id: 'cust-1',
    scheduled_service_id: 'svc-1',
    service_type: 'Pest Control',
    appointment_time: new Date(Date.now() + 48 * 3600000),
    created_at: new Date(Date.now() - 200 * 3600000),
    reminder_72h_sent: false,
    reminder_24h_sent: true,
    ...overrides,
  };
}

const CUSTOMER = { id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', phone: '+19415550100', email: 'ada@example.com', line_type: 'mobile' };

// Same shape as appointment-reminders-flag-close.test.js's wireSendPath —
// the full query sequence a genuine send attempt walks through when the SMS
// leg is held and falls to the email fallback (which re-checks the
// unit-move hold a SECOND time at the email handoff). `svcRow` lets each
// test control the live-status guard's read of callback_number_hold_at /
// call_sms_cleared_at.
function wireSendPathViaEmailFallback(reminderRow, flagUpdate, svcRow) {
  wireDb({
    appointment_reminders: [
      chain(), // stranded-confirmation sweep → []
      chain({ select: jest.fn().mockResolvedValue([reminderRow]) }),
      chain({ first: jest.fn().mockResolvedValue({ id: reminderRow.id }) }), // current reminder under comms lock
      chain({ first: jest.fn().mockResolvedValue(undefined) }), // deliverAppointmentNotice unit-move hold check
      chain({ first: jest.fn().mockResolvedValue(undefined) }), // email-handoff hold recheck (sendAppointmentNoticeEmail)
      flagUpdate,
    ],
    scheduled_services: [
      chain({ first: jest.fn().mockResolvedValue(svcRow) }), // live-status guard
      chain({ first: jest.fn().mockResolvedValue({ tech_name: null }) }), // getCustomerAndTech join
    ],
    notification_prefs: [chain({ first: jest.fn().mockResolvedValue(null) })],
    customers: [
      chain(), // resolveChannelPrefsRow
      chain({ first: jest.fn().mockResolvedValue(CUSTOMER) }), // getCustomerAndTech
      chain({ first: jest.fn().mockResolvedValue(CUSTOMER) }), // isLandline
    ],
  });
}

// The plain SMS-delivered path (hold cleared) never reaches the email leg,
// so it never re-checks the move hold a second time — one fewer
// appointment_reminders query than the fallback path above.
function wireSendPathPlainSms(reminderRow, flagUpdate, svcRow) {
  wireDb({
    appointment_reminders: [
      chain(), // stranded-confirmation sweep → []
      chain({ select: jest.fn().mockResolvedValue([reminderRow]) }),
      chain({ first: jest.fn().mockResolvedValue({ id: reminderRow.id }) }), // current reminder under comms lock
      chain({ first: jest.fn().mockResolvedValue(undefined) }), // deliverAppointmentNotice unit-move hold check
      flagUpdate,
    ],
    scheduled_services: [
      chain({ first: jest.fn().mockResolvedValue(svcRow) }), // live-status guard
      chain({ first: jest.fn().mockResolvedValue({ tech_name: null }) }), // getCustomerAndTech join
    ],
    notification_prefs: [chain({ first: jest.fn().mockResolvedValue(null) })],
    customers: [
      chain(), // resolveChannelPrefsRow
      chain({ first: jest.fn().mockResolvedValue(CUSTOMER) }), // getCustomerAndTech
      chain({ first: jest.fn().mockResolvedValue(CUSTOMER) }), // isLandline
    ],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  disclaimedNumberHeldForVisit.mockResolvedValue(false);
  AppointmentEmail.sendAppointmentReminderEmail.mockResolvedValue({ ok: true });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
  db.transaction = jest.fn(async (run) => run(db));
  jest.spyOn(AppointmentReminders, 'selfHealMissingReminderRows').mockResolvedValue({ healed: 0 });
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('disclaimed ANI + email on file: the 72h reminder is delivered by email, never texted to the ANI', async () => {
  disclaimedNumberHeldForVisit.mockResolvedValue(true);
  const reminderRow = row72();
  const flagUpdate = chain({ update: jest.fn().mockResolvedValue(1) });
  wireSendPathViaEmailFallback(reminderRow, flagUpdate, {
    status: 'confirmed',
    callback_number_hold_at: new Date(Date.now() - 3600000),
    call_sms_cleared_at: null,
  });

  const results = await AppointmentReminders.checkAndSendReminders();

  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
  // Delivered — by email, not SMS — so the row closes as sent (not left
  // armed): the visit is genuinely reached, just not by text.
  expect(results.sent72h).toBe(1);
  expect(flagUpdate.update).toHaveBeenCalledWith(
    expect.objectContaining({ reminder_72h_sent: true }),
  );
});

test('disclaimed ANI + no email on file: neither channel reaches the customer — held, no SMS to the ANI', async () => {
  AppointmentEmail.sendAppointmentReminderEmail.mockResolvedValueOnce({ skipped: true, reason: 'missing_email' });
  disclaimedNumberHeldForVisit.mockResolvedValue(true);
  const reminderRow = row72();
  const flagUpdate = chain({ update: jest.fn().mockResolvedValue(1) });
  wireSendPathViaEmailFallback(reminderRow, flagUpdate, {
    status: 'confirmed',
    callback_number_hold_at: new Date(Date.now() - 3600000),
    call_sms_cleared_at: null,
  });

  const results = await AppointmentReminders.checkAndSendReminders();

  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
  // Not delivered on either channel — the existing no-reachable-channel
  // alert covers the human follow-up (alongside the crm_notes stamp
  // written at customer creation); the reminder attempt is still exhausted
  // (marked sent) rather than retried into the disclaimed number.
  const { notifyAdmin } = require('../services/notification-service');
  expect(notifyAdmin).toHaveBeenCalled();
  expect(results.sent72h).toBe(1);
});

test('once the number hold is lifted (card resolved, or the customer phone moved to an unheld number) the reminder texts normally', async () => {
  disclaimedNumberHeldForVisit.mockResolvedValue(false);
  const reminderRow = row72();
  const flagUpdate = chain({ update: jest.fn().mockResolvedValue(1) });
  wireSendPathPlainSms(reminderRow, flagUpdate, {
    status: 'confirmed',
    // The per-visit stamp is still there (it is an audit trail now) — no
    // send decision reads it, so it cannot keep the visit held once the
    // number itself is no longer held.
    callback_number_hold_at: new Date(Date.now() - 3600000),
    call_sms_cleared_at: null,
  });

  const results = await AppointmentReminders.checkAndSendReminders();

  expect(sendCustomerMessage).toHaveBeenCalled();
  expect(AppointmentEmail.sendAppointmentReminderEmail).not.toHaveBeenCalled();
  expect(results.sent72h).toBe(1);
  expect(flagUpdate.update).toHaveBeenCalledWith(
    expect.objectContaining({ reminder_72h_sent: true }),
  );
});

/**
 * Finding #2 (round 4 P1, PR #4807) used to close the entry-read/provider-
 * handoff race by rechecking the hold inside safeSend's own dispatchCheck;
 * round 5 moved that recheck into sendCustomerMessage keyed on the visit,
 * and round 6 re-keyed it on the send's own destination number (every
 * SMS, with or without visit metadata — see send-customer-message-
 * callback-number-hold.test.js). This file keeps the entry-read tests
 * above (safeSendAppointment still owns the email-fallback decision) plus
 * this check that the pre-check is asked about the right visit and the
 * chokepoint gets the real destination number.
 */
test('safeSendAppointment asks the hold about THIS visit, and hands sendCustomerMessage the contact number the chokepoint keys on', async () => {
  wireDb({
    customers: [
      chain({ first: jest.fn().mockResolvedValue(CUSTOMER) }), // isLandline's customer read
    ],
  });

  const sent = await AppointmentReminders.safeSendAppointment(
    CUSTOMER, {}, 'test body', 'appointment_confirmation', 'appointment',
    { scheduled_service_id: 'svc-1' }, {},
  );

  expect(sent).toBe(true);
  expect(disclaimedNumberHeldForVisit).toHaveBeenCalledWith({ scheduledServiceId: 'svc-1' });
  expect(sendCustomerMessage).toHaveBeenCalledWith(
    expect.objectContaining({ to: CUSTOMER.phone, appointmentId: 'svc-1' }),
  );
});
