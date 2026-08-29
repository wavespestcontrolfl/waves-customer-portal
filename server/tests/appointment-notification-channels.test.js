jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn(() => []),
  isServiceContactRole: jest.fn(() => false),
  // Same marker shape as the real sentinel — getReminderPrefs' fail-closed
  // `unavailable` flag keys on __prefsUnavailable.
  PREFS_UNAVAILABLE: Object.freeze({ __prefsUnavailable: true }),
}));
jest.mock('../services/appointment-email', () => ({
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
  sendTechEnRouteEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));

const db = require('../models/db');
const AppointmentEmail = require('../services/appointment-email');
const NotificationService = require('../services/notification-service');
const { getAppointmentContacts } = require('../services/customer-contact');
const AppointmentReminders = require('../services/appointment-reminders');

const { apptChannel, resolve72hChannel, isOneTimeVisit, deliverAppointmentNotice, deliverConfirmationByChannel, getReminderPrefs } = AppointmentReminders._test;
const { isEnabled } = require('../config/feature-gates');

// Minimal knex-style chainable mock. first() resolves null so the
// no-reachable-channel alert dedupe check finds no prior row and proceeds.
function chain() {
  const q = {};
  ['where', 'whereRaw', 'whereNotNull', 'orderBy', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => null);
  return q;
}

const args = (extra = {}) => ({
  kind: '24h',
  customerId: 'c1',
  scheduledServiceId: 'ss1',
  apptTime: new Date('2026-06-20T13:00:00.000Z'),
  serviceLabel: 'Quarterly Pest Control',
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  AppointmentEmail.sendAppointmentReminderEmail.mockResolvedValue({ ok: true });
  getAppointmentContacts.mockImplementation(() => []);
  db.mockImplementation(() => chain());
  db.raw = jest.fn((sql) => sql);
});

describe('apptChannel', () => {
  test('normalizes unknown / null values to sms', () => {
    expect(apptChannel('sms')).toBe('sms');
    expect(apptChannel('email')).toBe('email');
    expect(apptChannel('both')).toBe('both');
    expect(apptChannel(null)).toBe('sms');
    expect(apptChannel(undefined)).toBe('sms');
    expect(apptChannel('phone')).toBe('sms');
  });
});

describe('resolve72hChannel — email-first promotion, one-time visits only (GATE_REMINDER_72H_EMAIL_FIRST)', () => {
  // scheduled_services stub: first() resolves the given row.
  const ssDb = (row) => {
    db.mockImplementation((table) => {
      const q = chain();
      if (table === 'scheduled_services') q.first = jest.fn(async () => row);
      return q;
    });
  };
  const oneTimeRow = { id: 'ss1', is_recurring: false, recurring_parent_id: null, recurring_pattern: null };

  test('gate OFF: one-time visit with default/sms preference stays sms', async () => {
    isEnabled.mockImplementation(() => false);
    ssDb(oneTimeRow);
    await expect(resolve72hChannel('sms', 'ss1')).resolves.toBe('sms');
    await expect(resolve72hChannel(null, 'ss1')).resolves.toBe('sms');
  });

  test('gate ON: one-time visit with default/sms preference promotes to email', async () => {
    isEnabled.mockImplementation((k) => k === 'reminder72hEmailFirst');
    ssDb(oneTimeRow);
    await expect(resolve72hChannel('sms', 'ss1')).resolves.toBe('email');
    await expect(resolve72hChannel(undefined, 'ss1')).resolves.toBe('email');
    expect(isEnabled).toHaveBeenCalledWith('reminder72hEmailFirst');
  });

  test('gate ON: recurring lineage never promotes (is_recurring / booster parent / pattern)', async () => {
    isEnabled.mockImplementation((k) => k === 'reminder72hEmailFirst');
    ssDb({ ...oneTimeRow, is_recurring: true });
    await expect(resolve72hChannel('sms', 'ss1')).resolves.toBe('sms');
    // Series "booster" visit: is_recurring=false WITH recurring_parent_id set
    // (canonical lineage test, routes/pay-v2.js) — a bare is_recurring check
    // would wrongly promote this row.
    ssDb({ ...oneTimeRow, recurring_parent_id: 'parent1' });
    await expect(resolve72hChannel('sms', 'ss1')).resolves.toBe('sms');
    ssDb({ ...oneTimeRow, recurring_pattern: 'monthly' });
    await expect(resolve72hChannel('sms', 'ss1')).resolves.toBe('sms');
  });

  test('gate ON: explicit email/both preferences pass through untouched (no lineage lookup)', async () => {
    isEnabled.mockImplementation((k) => k === 'reminder72hEmailFirst');
    ssDb(oneTimeRow);
    await expect(resolve72hChannel('email', 'ss1')).resolves.toBe('email');
    await expect(resolve72hChannel('both', 'ss1')).resolves.toBe('both');
  });

  test('fail closed: unreadable prefs row never promotes (hook P1 — email leg bypasses the consent validator)', async () => {
    isEnabled.mockImplementation((k) => k === 'reminder72hEmailFirst');
    ssDb(oneTimeRow);
    await expect(resolve72hChannel('sms', 'ss1', { prefsUnavailable: true })).resolves.toBe('sms');
    // Explicit email/both still pass through — those ARE the stored contract
    // the existing email path already honors on unavailable prefs.
    await expect(resolve72hChannel('email', 'ss1', { prefsUnavailable: true })).resolves.toBe('email');
  });

  test('explicit Text choice never promotes (Codex #3588 P1 — portal delivery-method control)', async () => {
    isEnabled.mockImplementation((k) => k === 'reminder72hEmailFirst');
    ssDb(oneTimeRow);
    await expect(resolve72hChannel('sms', 'ss1', { explicitChoice: true })).resolves.toBe('sms');
    // Un-stamped default still promotes.
    await expect(resolve72hChannel('sms', 'ss1', { explicitChoice: false })).resolves.toBe('email');
  });

  test('fail-safe: missing row, missing id, or thrown lookup keeps sms', async () => {
    isEnabled.mockImplementation((k) => k === 'reminder72hEmailFirst');
    ssDb(null); // no scheduled_services row
    await expect(resolve72hChannel('sms', 'ss1')).resolves.toBe('sms');
    await expect(resolve72hChannel('sms', null)).resolves.toBe('sms');
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(resolve72hChannel('sms', 'ss1')).resolves.toBe('sms');
  });

  test('isOneTimeVisit truth table', async () => {
    ssDb(oneTimeRow);
    await expect(isOneTimeVisit('ss1')).resolves.toBe(true);
    ssDb({ ...oneTimeRow, is_recurring: true });
    await expect(isOneTimeVisit('ss1')).resolves.toBe(false);
    ssDb(null);
    await expect(isOneTimeVisit('ss1')).resolves.toBe(false);
    await expect(isOneTimeVisit(null)).resolves.toBe(false);
  });
});

describe('deliverAppointmentNotice channel routing', () => {
  test("'sms' default: sends SMS, no email when delivered", async () => {
    const smsAttempt = jest.fn(async () => true);
    const reached = await deliverAppointmentNotice(args({ channel: 'sms', smsAttempt }));

    expect(reached).toBe(true);
    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentReminderEmail).not.toHaveBeenCalled();
  });

  test("'sms' default: SMS fails -> email fallback", async () => {
    const smsAttempt = jest.fn(async () => false);
    await deliverAppointmentNotice(args({ channel: 'sms', smsAttempt }));

    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
  });

  test("'email': sends email, never attempts SMS", async () => {
    const smsAttempt = jest.fn(async () => true);
    const reached = await deliverAppointmentNotice(args({ channel: 'email', smsAttempt }));

    expect(reached).toBe(true);
    expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
    expect(smsAttempt).not.toHaveBeenCalled();
  });

  test("'email': no usable email -> falls back to SMS (no admin alert when SMS works)", async () => {
    AppointmentEmail.sendAppointmentReminderEmail.mockResolvedValue({ ok: false, skipped: true, reason: 'missing_email' });
    const smsAttempt = jest.fn(async () => true);
    const reached = await deliverAppointmentNotice(args({ channel: 'email', smsAttempt }));

    expect(reached).toBe(true);
    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test("'email': email and SMS both fail -> raises no-reachable-channel alert", async () => {
    AppointmentEmail.sendAppointmentReminderEmail.mockResolvedValue({ ok: false, skipped: true, reason: 'missing_email' });
    const smsAttempt = jest.fn(async () => false);
    const reached = await deliverAppointmentNotice(args({ channel: 'email', smsAttempt }));

    expect(reached).toBe(false);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test("'both': sends SMS and email", async () => {
    const smsAttempt = jest.fn(async () => true);
    const reached = await deliverAppointmentNotice(args({ channel: 'both', smsAttempt }));

    expect(reached).toBe(true);
    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
  });

  test("'both': SMS blocked but email delivered still counts as reached", async () => {
    const smsAttempt = jest.fn(async () => false);
    const reached = await deliverAppointmentNotice(args({ channel: 'both', smsAttempt }));

    expect(reached).toBe(true);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test("'both': a throwing SMS leg does not abort the email leg or bubble", async () => {
    const smsAttempt = jest.fn(async () => { throw new Error('customer SMS blocked'); });
    const reached = await deliverAppointmentNotice(args({ channel: 'both', smsAttempt }));

    expect(reached).toBe(true); // email still delivered
    expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test("'both': window-held SMS leg -> email goes out NOW, notice still defers (r14)", async () => {
    // The boundary re-check held the SMS at the provider handoff. The
    // email leg is not subject to the window: it must send immediately,
    // while the false return leaves the caller's row unmarked so the
    // sweep replays the SMS leg at 8:00 AM (the email send is idempotent
    // per occurrence, so the replay can't double-deliver it). No admin
    // alert — a hold is a deferral, not an unreachable customer.
    const smsAttempt = jest.fn(async () => false);
    const smsOutcome = { blockedCode: 'QUIET_HOURS_HOLD' };
    const reached = await deliverAppointmentNotice(args({ channel: 'both', smsAttempt, smsOutcome }));

    expect(reached).toBe(false);
    expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test("'both': both channels fail -> raises no-reachable-channel alert", async () => {
    AppointmentEmail.sendAppointmentReminderEmail.mockResolvedValue({ ok: false, skipped: true, reason: 'missing_email' });
    const smsAttempt = jest.fn(async () => false);
    const reached = await deliverAppointmentNotice(args({ channel: 'both', smsAttempt }));

    expect(reached).toBe(false);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });
});

describe('getReminderPrefs account-level channel resolution', () => {
  // chain whose first() resolves a fixed value.
  function firstChain(value) {
    const q = {};
    ['where', 'whereIn'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => value);
    return q;
  }

  // Drive db(table) by a per-table FIFO queue of chains.
  function setDbQueues(queues) {
    const tableQueues = new Map(Object.entries(queues));
    db.mockImplementation((table) => {
      const queue = tableQueues.get(table);
      if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
      return queue.shift();
    });
  }

  test('secondary property inherits the primary profile channel', async () => {
    setDbQueues({
      notification_prefs: [
        // property's own prefs (default sms)
        firstChain({ appointment_confirmation_channel: 'sms', service_reminder_72h_channel: 'sms', service_reminder_24h_channel: 'sms', service_reminder_72h: true }),
        // primary owner's prefs (email)
        firstChain({ appointment_confirmation_channel: 'email', service_reminder_72h_channel: 'email', service_reminder_24h_channel: 'email' }),
      ],
      customers: [
        firstChain({ account_id: 'acct-1', is_primary_profile: false }),
        firstChain({ id: 'primary-1' }),
      ],
    });

    const prefs = await getReminderPrefs('secondary-1');
    expect(prefs.confirmationChannel).toBe('email');
    expect(prefs.reminder72hChannel).toBe('email');
    // Toggles still come from the property's own row.
    expect(prefs.serviceReminder72h).toBe(true);
  });

  test('the 72h explicit-choice stamp rides the owner-resolved row (secondary profile honors the owner)', async () => {
    setDbQueues({
      notification_prefs: [
        firstChain({ service_reminder_72h_channel: 'sms', service_reminder_72h_channel_explicit: false }),
        // Owner deliberately chose Text — the stamp must surface even though
        // the resolved channel value is the ambiguous 'sms'.
        firstChain({ service_reminder_72h_channel: 'sms', service_reminder_72h_channel_explicit: true }),
      ],
      customers: [
        firstChain({ account_id: 'acct-1', is_primary_profile: false }),
        firstChain({ id: 'primary-1' }),
      ],
    });

    const prefs = await getReminderPrefs('secondary-1');
    expect(prefs.reminder72hChannel).toBe('sms');
    expect(prefs.reminder72hChannelExplicit).toBe(true);
  });

  test('a FAILED owner-profile resolution marks prefs unavailable — the email fallback fails closed (Codex #3361 r28 P1)', async () => {
    // A swallowed owner-resolution failure is NOT "no row": the resolved
    // channel/opt-out state is the child/default fallback, not the account
    // owner's stored choices — prefsKnown must go false so the
    // consent-blocked confirmation email fallback (which bypasses the
    // sendCustomerMessage opt-out validator) never mails past an opt-out
    // it never read.
    const failingChain = () => {
      const q = {};
      ['where', 'whereIn'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.first = jest.fn(async () => { throw new Error('conn reset'); });
      return q;
    };
    setDbQueues({
      notification_prefs: [
        // property's own prefs read fine…
        firstChain({ appointment_confirmation_channel: 'sms' }),
        // …but the owner's prefs read FAILS
        failingChain(),
      ],
      customers: [
        firstChain({ account_id: 'acct-1', is_primary_profile: false }),
        firstChain({ id: 'primary-1' }),
      ],
    });

    const prefs = await getReminderPrefs('secondary-1');
    expect(prefs.unavailable).toBe(true);
  });

  test('primary profile uses its own channel without an extra lookup', async () => {
    setDbQueues({
      notification_prefs: [
        firstChain({ appointment_confirmation_channel: 'both', service_reminder_24h_channel: 'both' }),
      ],
      customers: [
        firstChain({ account_id: 'acct-1', is_primary_profile: true }),
      ],
    });

    const prefs = await getReminderPrefs('primary-1');
    expect(prefs.confirmationChannel).toBe('both');
    expect(prefs.reminder24hChannel).toBe('both');
  });
});

describe('deliverConfirmationByChannel (self-service booking paths)', () => {
  function firstChain(value) {
    const q = {};
    ['where', 'whereIn'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => value);
    return q;
  }
  function setDbQueues(queues) {
    const tableQueues = new Map(Object.entries(queues));
    db.mockImplementation((table) => {
      const queue = tableQueues.get(table);
      if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
      return queue.shift();
    });
  }

  test("'sms' preference: runs the caller's SMS send, never emails", async () => {
    setDbQueues({
      notification_prefs: [firstChain({ appointment_confirmation_channel: 'sms' })],
      customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
    });
    const smsAttempt = jest.fn(async () => true);
    const reached = await deliverConfirmationByChannel({ customerId: 'c1', scheduledServiceId: 'ss1', serviceLabel: 'X', smsAttempt });

    expect(reached).toBe(true);
    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
  });

  test("'email' preference: emails the confirmation with the derived appt time, skips SMS", async () => {
    setDbQueues({
      notification_prefs: [firstChain({ appointment_confirmation_channel: 'email' })],
      customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
      scheduled_services: [firstChain({ scheduled_date: '2026-06-20', window_start: '08:00:00' })],
    });
    const smsAttempt = jest.fn(async () => true);
    const reached = await deliverConfirmationByChannel({ customerId: 'c1', scheduledServiceId: 'ss1', serviceLabel: 'X', smsAttempt });

    expect(reached).toBe(true);
    expect(smsAttempt).not.toHaveBeenCalled();
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).toHaveBeenCalledTimes(1);
    const callArg = AppointmentEmail.sendAppointmentConfirmationEmail.mock.calls[0][0];
    expect(callArg.appointmentTime instanceof Date).toBe(true);
  });

  test('opted-out customer (confirmation toggle off) is not emailed even on the email channel', async () => {
    setDbQueues({
      notification_prefs: [firstChain({ appointment_confirmation_channel: 'email', appointment_confirmation: false })],
      customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
    });
    const smsAttempt = jest.fn(async () => false);
    const reached = await deliverConfirmationByChannel({ customerId: 'c1', scheduledServiceId: 'ss1', smsAttempt });

    // Falls to the SMS-only path, where sendCustomerMessage's validator suppresses
    // it for the opted-out customer; the email path (which bypasses that check) is
    // never taken.
    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
    expect(reached).toBe(false);
  });

  test("'sms' preference: a consent-blocked text (smsPermanentlyBlocked) falls back to the confirmation email", async () => {
    setDbQueues({
      notification_prefs: [firstChain({ appointment_confirmation_channel: 'sms' })],
      customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
      scheduled_services: [
        // scheduledServiceApptTime resolves the slot for the email body...
        firstChain({ scheduled_date: '2026-06-20', window_start: '08:00:00' }),
        // ...then buildRescheduleLink reads the row (no token → no CTA link).
        firstChain({ id: 'ss1', customer_id: 'c1', reschedule_token: null }),
      ],
    });
    const smsAttempt = jest.fn(async () => false);
    const reached = await deliverConfirmationByChannel({
      customerId: 'c1', scheduledServiceId: 'ss1', serviceLabel: 'X', smsAttempt, smsPermanentlyBlocked: true,
    });

    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).toHaveBeenCalledTimes(1);
    const callArg = AppointmentEmail.sendAppointmentConfirmationEmail.mock.calls[0][0];
    expect(callArg.appointmentTime instanceof Date).toBe(true);
    expect(reached).toBe(true);
  });

  test("'sms' preference: a delivered text never triggers the smsPermanentlyBlocked email leg", async () => {
    setDbQueues({
      notification_prefs: [firstChain({ appointment_confirmation_channel: 'sms' })],
      customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
    });
    const smsAttempt = jest.fn(async () => true);
    const reached = await deliverConfirmationByChannel({
      customerId: 'c1', scheduledServiceId: 'ss1', smsAttempt, smsPermanentlyBlocked: true,
    });

    expect(reached).toBe(true);
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
  });

  test("'sms' preference: an ordinary failed send (no smsPermanentlyBlocked) still never emails — deferrals/sweeps own the retry", async () => {
    setDbQueues({
      notification_prefs: [firstChain({ appointment_confirmation_channel: 'sms' })],
      customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
    });
    const smsAttempt = jest.fn(async () => false);
    const reached = await deliverConfirmationByChannel({ customerId: 'c1', scheduledServiceId: 'ss1', smsAttempt });

    expect(reached).toBe(false);
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
  });

  test('unreadable prefs (transient lookup failure): smsPermanentlyBlocked fails closed — no email', async () => {
    // getReminderPrefs swallows the failed lookup into open defaults
    // (confirmationOn=true); the fallback must treat that as "opt-out
    // unknown" and stay silent, since the email path bypasses the
    // sendCustomerMessage validator that would re-check the stored toggle.
    const failChain = {};
    ['where', 'whereIn'].forEach((m) => { failChain[m] = jest.fn(() => failChain); });
    failChain.first = jest.fn(async () => { throw new Error('connection reset'); });
    setDbQueues({
      notification_prefs: [failChain],
      customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
    });
    const smsAttempt = jest.fn(async () => false);
    const reached = await deliverConfirmationByChannel({
      customerId: 'c1', scheduledServiceId: 'ss1', smsAttempt, smsPermanentlyBlocked: true,
    });

    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(reached).toBe(false);
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
  });

  test('opted-out customer: smsPermanentlyBlocked never emails (the email path bypasses the opt-out validator)', async () => {
    setDbQueues({
      notification_prefs: [firstChain({ appointment_confirmation_channel: 'sms', appointment_confirmation: false })],
      customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
    });
    const smsAttempt = jest.fn(async () => false);
    const reached = await deliverConfirmationByChannel({
      customerId: 'c1', scheduledServiceId: 'ss1', smsAttempt, smsPermanentlyBlocked: true,
    });

    expect(reached).toBe(false);
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
  });

  test('falls back to the SMS send when channel prefs are unavailable', async () => {
    setDbQueues({
      notification_prefs: [firstChain(null)],
      customers: [firstChain(null)],
    });
    const smsAttempt = jest.fn(async () => true);
    const reached = await deliverConfirmationByChannel({ customerId: 'c1', scheduledServiceId: 'ss1', smsAttempt });

    expect(reached).toBe(true);
    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
  });
});

// A table-aware db mock: distinct rows for customers / notification_prefs /
// sms_log / messaging_suppression so the false-positive guard can be
// exercised. The sms_log and messaging_suppression chains are phone-aware —
// they capture the last-10-digits whereRaw binding and answer per number, so
// tests can distinguish the primary phone from a service contact's. Unlisted
// tables resolve first() to null (the notifications dedupe check finds no
// prior alert).
function tableAwareDb({ customer = null, prefs = null, deliveredByDigits = {}, suppressedDigits = [] } = {}) {
  return (table) => {
    const q = chain();
    if (table === 'customers') {
      q.first = jest.fn(async () => customer);
    } else if (table === 'notification_prefs') {
      q.first = jest.fn(async () => prefs);
    } else if (table === 'sms_log' || table === 'messaging_suppression') {
      let digits = null;
      q.whereRaw = jest.fn((sql, bindings) => { digits = bindings?.[0]; return q; });
      q.first = jest.fn(async () => {
        if (table === 'sms_log') return deliveredByDigits[digits] || null;
        return suppressedDigits.includes(digits) ? { phone: digits } : null;
      });
    }
    return q;
  };
}

describe('alertNoReachableChannel — text-reachable false-positive guard', () => {
  const cust = { id: 'c1', phone: '+19412345678', first_name: 'Adam', last_name: 'Pitts' };
  const primaryContact = { phone: '+19412345678', email: '', name: 'Adam', role: 'primary' };
  const svcContact = { phone: '+19419998877', email: '', name: 'Tenant', role: 'service_contact' };

  test('suppresses the alert when a recent delivered SMS proves the recipient is text-reachable', async () => {
    getAppointmentContacts.mockReturnValue([primaryContact]);
    db.mockImplementation(tableAwareDb({ customer: cust, deliveredByDigits: { 9412345678: { id: 'sms1' } } }));
    await AppointmentReminders.alertNoReachableChannel({ customerId: 'c1', kind: '24h', scheduledServiceId: 'ss1' });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('still alerts when there is no delivered SMS on file (genuinely unreachable)', async () => {
    getAppointmentContacts.mockReturnValue([primaryContact]);
    db.mockImplementation(tableAwareDb({ customer: cust }));
    await AppointmentReminders.alertNoReachableChannel({ customerId: 'c1', kind: '24h', scheduledServiceId: 'ss1' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('still alerts when the delivered number has since been suppressed (STOP / wrong number)', async () => {
    getAppointmentContacts.mockReturnValue([primaryContact]);
    db.mockImplementation(tableAwareDb({
      customer: cust,
      deliveredByDigits: { 9412345678: { id: 'sms1' } },
      suppressedDigits: ['9412345678'],
    }));
    await AppointmentReminders.alertNoReachableChannel({ customerId: 'c1', kind: '24h', scheduledServiceId: 'ss1' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('still alerts when the customer has SMS disabled, despite a past delivery', async () => {
    getAppointmentContacts.mockReturnValue([primaryContact]);
    db.mockImplementation(tableAwareDb({
      customer: cust,
      prefs: { sms_enabled: false },
      deliveredByDigits: { 9412345678: { id: 'sms1' } },
    }));
    await AppointmentReminders.alertNoReachableChannel({ customerId: 'c1', kind: '24h', scheduledServiceId: 'ss1' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test("still alerts when the notice routes to a service contact with no delivered SMS, even though the owner's primary phone has one", async () => {
    getAppointmentContacts.mockReturnValue([svcContact]);
    db.mockImplementation(tableAwareDb({
      customer: cust,
      deliveredByDigits: { 9412345678: { id: 'sms1' } },
    }));
    await AppointmentReminders.alertNoReachableChannel({ customerId: 'c1', kind: '24h', scheduledServiceId: 'ss1' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('suppresses when the service-contact recipient itself has a recent delivered SMS', async () => {
    getAppointmentContacts.mockReturnValue([svcContact]);
    db.mockImplementation(tableAwareDb({
      customer: cust,
      deliveredByDigits: { 9419998877: { id: 'sms2' } },
    }));
    await AppointmentReminders.alertNoReachableChannel({ customerId: 'c1', kind: '24h', scheduledServiceId: 'ss1' });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });
});
