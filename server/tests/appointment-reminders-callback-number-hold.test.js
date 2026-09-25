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
 * The mechanism: call-recording-processor.js persists the hold onto
 * scheduled_services.callback_number_hold_at at booking time; this cron
 * reads it back and, while active, treats the SMS leg as unreachable
 * (returns a plain, non-"held" false from smsAttempt) so the ALREADY
 * EXISTING fallback machinery in deliverAppointmentNotice runs unchanged.
 * The hold is lifted by the SAME durable signal the card-request backstop
 * already honors — call_sms_cleared_at — so once anything stamps that
 * column for the visit (there is currently no dedicated "resolve this
 * callback_number_needed card" UI action that does so; this reuses the
 * general clearance column on purpose so any future resolution flow
 * inherits the reminder fix for free), the very next scan sends normally.
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

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AppointmentEmail = require('../services/appointment-email');
const AppointmentReminders = require('../services/appointment-reminders');

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
      // safeSendAppointment's own callback_number_needed hold check (codex
      // round-2 finding #7 — the boundary now re-reads the columns itself
      // rather than trusting a value computed earlier in the scan).
      chain({ select: jest.fn().mockResolvedValue([svcRow]) }),
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
      // safeSendAppointment's own callback_number_needed hold check.
      chain({ select: jest.fn().mockResolvedValue([svcRow]) }),
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

test('clearing the hold (call_sms_cleared_at stamped) resumes normal SMS sending', async () => {
  const reminderRow = row72();
  const flagUpdate = chain({ update: jest.fn().mockResolvedValue(1) });
  wireSendPathPlainSms(reminderRow, flagUpdate, {
    status: 'confirmed',
    // A prior call stamped the hold, but this visit's call-level SMS
    // clearance has SINCE been recorded (call_sms_cleared_at set) — the
    // durable signal any clearance flow uses (call-recording-processor.js's
    // own confirm-leg stamp, or an office-confirm hook). The hold reads as
    // resolved regardless of when callback_number_hold_at was set.
    callback_number_hold_at: new Date(Date.now() - 3600000),
    call_sms_cleared_at: new Date(),
  });

  const results = await AppointmentReminders.checkAndSendReminders();

  expect(sendCustomerMessage).toHaveBeenCalled();
  expect(AppointmentEmail.sendAppointmentReminderEmail).not.toHaveBeenCalled();
  expect(results.sent72h).toBe(1);
  expect(flagUpdate.update).toHaveBeenCalledWith(
    expect.objectContaining({ reminder_72h_sent: true }),
  );
});
