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
  // The recipient resolution the confirmation email itself uses; the
  // new-client promotion (GATE_NEW_CLIENT_CONFIRM_EMAIL) reuses it.
  _private: { loadCustomer: jest.fn(async (id) => ({ id })), resolveRecipients: jest.fn(async () => []) },
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/messaging/send-window', () => ({ isWithinSendWindowET: jest.fn(() => true) }));
// gateEnvValue: getReminderPrefs now consults the per-property toggle resolver
// (app property scope, PR 3), which reads GATE_APP_PROPERTY_SCOPE at call time.
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gateEnvValue: jest.fn(() => false), newClientConfirmEmailLive: jest.fn(() => false) }));

const db = require('../models/db');
const AppointmentEmail = require('../services/appointment-email');
const NotificationService = require('../services/notification-service');
const { getAppointmentContacts } = require('../services/customer-contact');
const AppointmentReminders = require('../services/appointment-reminders');

const { apptChannel, resolve72hChannel, resolveConfirmationChannel, deliverConfirmation, isOneTimeVisit, deliverAppointmentNotice, deliverConfirmationByChannel, getReminderPrefs } = AppointmentReminders._test;
const { isEnabled, newClientConfirmEmailLive } = require('../config/feature-gates');

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

  test('portal-wide email opt-out never promotes (email leg is transactional_required and skips the toggle)', async () => {
    isEnabled.mockImplementation((k) => k === 'reminder72hEmailFirst');
    ssDb(oneTimeRow);
    await expect(resolve72hChannel('sms', 'ss1', { emailEnabled: false })).resolves.toBe('sms');
    await expect(resolve72hChannel('sms', 'ss1', { emailEnabled: true })).resolves.toBe('email');
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

describe('resolveConfirmationChannel — new client gets text AND email (GATE_NEW_CLIENT_CONFIRM_EMAIL)', () => {
  const sampleRecipients = [{ email: 'sample.lead@example.com', name: 'Sample Lead', holder: true }];
  const prefsOf = (extra = {}) => ({
    unavailable: false,
    confirmationChannel: 'sms',
    confirmationChannelExplicit: false,
    emailEnabled: true,
    appointmentConfirmation: true,
    ...extra,
  });
  const ids = { customerId: 'c1', scheduledServiceId: 'ss1' };
  // scheduled_services stub: first() resolves the given row (the completed-visit lookup);
  // customers stub: first() resolves `longStandingRow` (the member_since lookup).
  const visitsDb = (completedRow, { fail = false, longStandingRow = null } = {}) => {
    db.mockImplementation((table) => {
      const q = chain();
      if (table === 'scheduled_services') {
        q.first = jest.fn(async () => { if (fail) throw new Error('db down'); return completedRow; });
      }
      if (table === 'customers') q.first = jest.fn(async () => longStandingRow);
      return q;
    });
  };

  beforeEach(() => {
    newClientConfirmEmailLive.mockImplementation(() => true);
    AppointmentEmail._private.loadCustomer.mockImplementation(async (id) => ({ id }));
    AppointmentEmail._private.resolveRecipients.mockImplementation(async () => sampleRecipients);
    visitsDb(null);
  });
  afterEach(() => {
    newClientConfirmEmailLive.mockImplementation(() => false);
  });

  test('gate ON, new client, usable email: the default sms channel is promoted to both', async () => {
    await expect(resolveConfirmationChannel(prefsOf(), ids)).resolves.toBe('both');
    // Looked for a COMPLETED visit of this customer, and resolved the email
    // recipients the way the confirmation email does.
    expect(db).toHaveBeenCalledWith('scheduled_services');
    expect(AppointmentEmail._private.resolveRecipients).toHaveBeenCalledWith(
      { id: 'c1' }, { scheduledServiceId: 'ss1', eventType: 'appointment.confirmation' },
    );
  });

  test('gate OFF: stays sms and reads nothing', async () => {
    newClientConfirmEmailLive.mockImplementation(() => false);
    await expect(resolveConfirmationChannel(prefsOf(), ids)).resolves.toBe('sms');
    expect(db).not.toHaveBeenCalled();
    expect(AppointmentEmail._private.resolveRecipients).not.toHaveBeenCalled();
  });

  test('explicit portal choice of the confirmation channel (stamp) keeps sms', async () => {
    await expect(resolveConfirmationChannel(prefsOf({ confirmationChannelExplicit: true }), ids)).resolves.toBe('sms');
    expect(AppointmentEmail._private.resolveRecipients).not.toHaveBeenCalled();
  });

  test('fail closed: unreadable prefs keep sms (the email leg bypasses the consent validator)', async () => {
    await expect(resolveConfirmationChannel(prefsOf({ unavailable: true }), ids)).resolves.toBe('sms');
    await expect(resolveConfirmationChannel(null, ids)).resolves.toBe('sms');
    expect(AppointmentEmail._private.resolveRecipients).not.toHaveBeenCalled();
  });

  test('portal-wide email off, or the confirmation toggle off, keeps sms', async () => {
    await expect(resolveConfirmationChannel(prefsOf({ emailEnabled: false }), ids)).resolves.toBe('sms');
    await expect(resolveConfirmationChannel(prefsOf({ appointmentConfirmation: false }), ids)).resolves.toBe('sms');
    expect(AppointmentEmail._private.resolveRecipients).not.toHaveBeenCalled();
  });

  test('no usable email for the account keeps sms', async () => {
    AppointmentEmail._private.resolveRecipients.mockImplementation(async () => []);
    await expect(resolveConfirmationChannel(prefsOf(), ids)).resolves.toBe('sms');
    AppointmentEmail._private.loadCustomer.mockImplementation(async () => null);
    await expect(resolveConfirmationChannel(prefsOf(), ids)).resolves.toBe('sms');
  });

  test('a customer with a completed visit is an existing client: stays sms', async () => {
    visitsDb({ id: 'done-1' });
    await expect(resolveConfirmationChannel(prefsOf(), ids)).resolves.toBe('sms');
    expect(AppointmentEmail._private.resolveRecipients).not.toHaveBeenCalled();
  });

  test('a customer since more than 90 days ago with no completed visit (imported history) stays sms', async () => {
    visitsDb(null, { longStandingRow: { id: 'c1' } });
    await expect(resolveConfirmationChannel(prefsOf(), ids)).resolves.toBe('sms');
    expect(AppointmentEmail._private.resolveRecipients).not.toHaveBeenCalled();
    // The DATE column is compared in SQL to the ET calendar day 90 days back.
    const customersQuery = db.mock.results[db.mock.calls.findIndex(([table]) => table === 'customers')].value;
    const { etDateString, addETDays } = require('../utils/datetime-et');
    expect(customersQuery.where).toHaveBeenCalledWith({ id: 'c1' });
    expect(customersQuery.where).toHaveBeenCalledWith('member_since', '<', etDateString(addETDays(new Date(), -90)));
  });

  test('a stored email / both / push channel is returned untouched, with no lookups', async () => {
    await expect(resolveConfirmationChannel(prefsOf({ confirmationChannel: 'email' }), ids)).resolves.toBe('email');
    await expect(resolveConfirmationChannel(prefsOf({ confirmationChannel: 'both' }), ids)).resolves.toBe('both');
    expect(db).not.toHaveBeenCalled();
    expect(AppointmentEmail._private.resolveRecipients).not.toHaveBeenCalled();
  });

  test('any thrown lookup keeps sms and warns (completed-visit read, recipient resolution, gate read)', async () => {
    const logger = require('../services/logger');
    visitsDb(null, { fail: true });
    await expect(resolveConfirmationChannel(prefsOf(), ids)).resolves.toBe('sms');
    visitsDb(null);
    AppointmentEmail._private.resolveRecipients.mockImplementation(async () => { throw new Error('prefs held'); });
    await expect(resolveConfirmationChannel(prefsOf(), ids)).resolves.toBe('sms');
    AppointmentEmail._private.resolveRecipients.mockImplementation(async () => sampleRecipients);
    newClientConfirmEmailLive.mockImplementation(() => { throw new Error('gate unreadable'); });
    await expect(resolveConfirmationChannel(prefsOf(), ids)).resolves.toBe('sms');
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  test('no customer id keeps sms', async () => {
    await expect(resolveConfirmationChannel(prefsOf(), { scheduledServiceId: 'ss1' })).resolves.toBe('sms');
  });

  describe('deliverConfirmationByChannel uses the promoted channel', () => {
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
    const call = (smsAttempt) => deliverConfirmationByChannel({
      customerId: 'c1', scheduledServiceId: 'ss1', serviceLabel: 'X', apptTime: new Date('2026-06-20T12:00:00Z'), smsAttempt,
    });

    test('new client on the default channel: the text AND the email both go out (existing both path)', async () => {
      setDbQueues({
        notification_prefs: [firstChain({ appointment_confirmation_channel: 'sms' })],
        // Owner resolution, then the member_since read (a customer since less than 90 days, or never).
        customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true }), firstChain(undefined)],
        scheduled_services: [firstChain(undefined)], // no completed visit
        appointment_reminders: [firstChain(null), firstChain(null)], // move-hold checks: notice entry + email handoff
      });
      const smsAttempt = jest.fn(async () => true);
      const reached = await call(smsAttempt);
      expect(reached).toBe(true);
      expect(smsAttempt).toHaveBeenCalledTimes(1);
      expect(AppointmentEmail.sendAppointmentConfirmationEmail).toHaveBeenCalledTimes(1);
    });

    test('existing client (a completed visit) stays on the sms path: no email', async () => {
      setDbQueues({
        notification_prefs: [firstChain({ appointment_confirmation_channel: 'sms' })],
        customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
        scheduled_services: [firstChain({ id: 'done-1' })],
      });
      const smsAttempt = jest.fn(async () => true);
      const reached = await call(smsAttempt);
      expect(reached).toBe(true);
      expect(smsAttempt).toHaveBeenCalledTimes(1);
      expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
    });

    test('explicit Text choice (stamp) stays on the sms path even for a new client', async () => {
      setDbQueues({
        notification_prefs: [firstChain({ appointment_confirmation_channel: 'sms', appointment_confirmation_channel_explicit: true })],
        customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
      });
      const smsAttempt = jest.fn(async () => true);
      await call(smsAttempt);
      expect(smsAttempt).toHaveBeenCalledTimes(1);
      expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
    });

    test('gate OFF: a new client is text-only, exactly as before', async () => {
      newClientConfirmEmailLive.mockImplementation(() => false);
      setDbQueues({
        notification_prefs: [firstChain({ appointment_confirmation_channel: 'sms' })],
        customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
      });
      const smsAttempt = jest.fn(async () => true);
      await call(smsAttempt);
      expect(smsAttempt).toHaveBeenCalledTimes(1);
      expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
    });
  });

  describe('deliverConfirmation (admin manual / inline bookings) uses the promoted channel', () => {
    // Outside the 8AM-8PM window the 'both' channel sends its email NOW and
    // defers only the text; the default 'sms' channel just defers. That
    // difference proves the send-window hold and the held email leg read the
    // promoted channel, without driving the real SMS send.
    const { isWithinSendWindowET } = require('../services/messaging/send-window');
    function tableAwareDb({ completedRow, longStandingRow = null }) {
      db.mockImplementation((table) => {
        const q = {};
        ['whereIn', 'whereRaw', 'whereNotNull', 'orderBy', 'select', 'leftJoin'].forEach((m) => { q[m] = jest.fn(() => q); });
        // The member_since read (where('member_since', '<', day)) answers on its own.
        q.where = jest.fn((col) => { if (col === 'member_since') q.memberSince = true; return q; });
        q.update = jest.fn(async () => 1);
        const rows = {
          notification_prefs: { appointment_confirmation_channel: 'sms' },
          customers: { id: 'c1', account_id: 'acct-1', is_primary_profile: true, first_name: 'Sample' },
          scheduled_services: completedRow,
        };
        q.first = jest.fn(async () => (q.memberSince ? longStandingRow : rows[table] ?? null));
        return q;
      });
    }
    const run = () => deliverConfirmation(
      { id: 'rem1' },
      { scheduledServiceId: 'ss1', customerId: 'c1', apptTime: new Date(Date.now() + 3 * 86400000), serviceLabel: 'X' },
    );

    beforeEach(() => {
      isEnabled.mockImplementation((k) => k === 'smsSendWindow');
      isWithinSendWindowET.mockReturnValue(false);
    });
    afterEach(() => {
      isEnabled.mockImplementation(() => false);
      isWithinSendWindowET.mockReturnValue(true);
    });

    test('new client after hours: the email leg goes out now, the text waits for the window', async () => {
      tableAwareDb({ completedRow: null });
      await expect(run()).resolves.toBe(false);
      expect(AppointmentEmail.sendAppointmentConfirmationEmail).toHaveBeenCalledTimes(1);
    });

    test('existing client after hours: the whole confirmation waits, no email', async () => {
      tableAwareDb({ completedRow: { id: 'done-1' } });
      await expect(run()).resolves.toBe(false);
      expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
    });

    test('a customer since more than 90 days ago after hours: the whole confirmation waits, no email', async () => {
      tableAwareDb({ completedRow: null, longStandingRow: { id: 'c1' } });
      await expect(run()).resolves.toBe(false);
      expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
    });

    test('gate OFF: a new client after hours keeps the old behavior, no email', async () => {
      newClientConfirmEmailLive.mockImplementation(() => false);
      tableAwareDb({ completedRow: null });
      await expect(run()).resolves.toBe(false);
      expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
    });
  });

  describe('deliverConfirmation closes the 24h reminder when the confirmation is the day-before notice', () => {
    // Booked for tomorrow: the confirmation already says when the visit is,
    // so the cron's 24h "is tomorrow" text minutes later is a duplicate.
    let updates;
    function confirmDb() {
      updates = [];
      db.mockImplementation((table) => {
        const q = {};
        ['whereIn', 'whereRaw', 'whereNotNull', 'orderBy', 'select', 'leftJoin'].forEach((m) => { q[m] = jest.fn(() => q); });
        q.where = jest.fn((col) => { if (col === 'member_since') q.memberSince = true; return q; });
        q.update = jest.fn(async (patch) => { if (table === 'appointment_reminders') updates.push(patch); return 1; });
        const rows = {
          notification_prefs: { appointment_confirmation_channel: 'email' },
          customers: { id: 'c1', account_id: 'acct-1', is_primary_profile: true, first_name: 'Sample', email: 'sample@example.com' },
          scheduled_services: { id: 'done-1' },
        };
        q.first = jest.fn(async () => (q.memberSince ? null : rows[table] ?? null));
        return q;
      });
    }
    const confirm = (apptTime) => deliverConfirmation(
      { id: 'rem1' },
      { scheduledServiceId: 'ss1', customerId: 'c1', apptTime, serviceLabel: 'Lawn Care' },
    );
    const tomorrowNoonET = () => {
      const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');
      return parseETDateTime(`${etDateString(addETDays(new Date(), 1))}T12:00`);
    };
    afterEach(() => AppointmentEmail.sendAppointmentConfirmationEmail.mockResolvedValue({ ok: true }));

    test('visit tomorrow: the confirmation write also closes reminder_24h_sent', async () => {
      confirmDb();
      AppointmentEmail.sendAppointmentConfirmationEmail.mockResolvedValue({ ok: true });
      await expect(confirm(tomorrowNoonET())).resolves.toBe(true);
      expect(updates).toEqual([expect.objectContaining({ confirmation_sent: true, reminder_24h_sent: true })]);
    });

    test('visit three days out: the 24h reminder stays armed', async () => {
      confirmDb();
      AppointmentEmail.sendAppointmentConfirmationEmail.mockResolvedValue({ ok: true });
      await expect(confirm(new Date(Date.now() + 3 * 86400000))).resolves.toBe(true);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toEqual(expect.objectContaining({ confirmation_sent: true }));
      expect(updates[0]).not.toHaveProperty('reminder_24h_sent');
    });

    test('visit tomorrow but the confirmation did not go out: the 24h reminder stays armed as the notice', async () => {
      confirmDb();
      AppointmentEmail.sendAppointmentConfirmationEmail.mockResolvedValue({ ok: false, reason: 'bounced' });
      await confirm(tomorrowNoonET());
      expect(updates.every((u) => !('reminder_24h_sent' in u))).toBe(true);
    });
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

  // A caller holding a processing claim (the call-recording pass) cannot
  // abandon from inside its SMS closure — a return there only leaves the
  // closure. The helper therefore takes the ownership predicate itself and
  // gates EVERY leg on it, so a claim that moved sends nothing further and
  // raises no "unreachable customer" alert (codex #3677 P1).
  test("'both' preference: a claim already lost sends neither leg and raises no alert", async () => {
    setDbQueues({
      notification_prefs: [firstChain({ appointment_confirmation_channel: 'both' })],
      customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
    });
    const { notifyAdmin } = require('../services/notification-service');
    const smsAttempt = jest.fn(async () => true);
    const reached = await deliverConfirmationByChannel({
      customerId: 'c1', scheduledServiceId: 'ss1', serviceLabel: 'X', apptTime: new Date('2026-06-20T12:00:00Z'),
      smsAttempt, stillOwnsClaim: async () => false,
    });
    expect(reached).toBe(false);
    expect(smsAttempt).not.toHaveBeenCalled();
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test("'both' preference: a claim lost DURING the SMS leg stops the email leg", async () => {
    setDbQueues({
      notification_prefs: [firstChain({ appointment_confirmation_channel: 'both' })],
      customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
      appointment_reminders: [firstChain(null)], // deliverAppointmentNotice unit-move hold check → no hold
    });
    const { notifyAdmin } = require('../services/notification-service');
    let owned = true;
    // The closure discovers the loss (as the processor's does) and answers
    // "not reached" — the predicate the helper holds now reads false.
    const smsAttempt = jest.fn(async () => { owned = false; return false; });
    const reached = await deliverConfirmationByChannel({
      customerId: 'c1', scheduledServiceId: 'ss1', serviceLabel: 'X', apptTime: new Date('2026-06-20T12:00:00Z'),
      smsAttempt, stillOwnsClaim: async () => owned,
    });
    expect(reached).toBe(false);
    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test("'email' preference: emails the confirmation with the derived appt time, skips SMS", async () => {
    setDbQueues({
      notification_prefs: [firstChain({ appointment_confirmation_channel: 'email' })],
      customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
      scheduled_services: [firstChain({ scheduled_date: '2026-06-20', window_start: '08:00:00' })],
      appointment_reminders: [
        firstChain(null), // deliverAppointmentNotice unit-move hold check → no hold
        firstChain(null), // email-handoff hold recheck (sendAppointmentNoticeEmail) → no hold
      ],
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
      appointment_reminders: [
        firstChain(null), // email-handoff hold recheck (sendAppointmentNoticeEmail) → no hold
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

  // Owner ruling 2026-09-25 (folded into PR #4807's callback_number_needed
  // work): a caller who disclaims the inbound ANI as not their own with no
  // spoken callback must NOT simply have the confirmation held — reach them
  // by email when one is on file. call-recording-processor.js sets
  // smsPermanentlyBlocked: v2SmsBlocked && !v2EmailBlocked for this exact
  // case (v2SmsBlocked is true via callback_number_needed; v2EmailBlocked
  // stays false since checkTcpaConsent only blocks email on an explicit
  // do-not-contact request) and its smsAttempt closure never calls Twilio
  // when v2SmsBlocked — so this is the same smsPermanentlyBlocked fallback
  // exercised above, framed for the incident that prompted the ruling (a
  // $300 flea job booked from an office line, with the caller's email
  // captured on the call).
  describe('callback_number_needed (disclaimed caller ID, owner ruling 2026-09-25)', () => {
    test('disclaimed ANI + email on file: the confirmation is emailed, the disclaimed number is never texted', async () => {
      setDbQueues({
        notification_prefs: [firstChain({ appointment_confirmation_channel: 'sms' })],
        customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
        scheduled_services: [
          firstChain({ scheduled_date: '2026-06-20', window_start: '08:00:00' }),
          firstChain({ id: 'ss1', customer_id: 'c1', reschedule_token: null }),
        ],
        appointment_reminders: [firstChain(null)],
      });
      // Mirrors the real closure: v2SmsBlocked is true for this call, so
      // the closure never reaches sendCustomerMessage/Twilio at all — it
      // returns false without dialing out.
      const smsAttempt = jest.fn(async () => false);
      const reached = await deliverConfirmationByChannel({
        customerId: 'c1', scheduledServiceId: 'ss1', serviceLabel: 'Flea treatment',
        smsAttempt, smsPermanentlyBlocked: true,
      });

      expect(smsAttempt).toHaveBeenCalledTimes(1);
      expect(AppointmentEmail.sendAppointmentConfirmationEmail).toHaveBeenCalledTimes(1);
      expect(reached).toBe(true);
    });

    test('disclaimed ANI + no email on file: neither channel reaches the customer — stays held (crm_notes carries the warning)', async () => {
      AppointmentEmail.sendAppointmentConfirmationEmail.mockResolvedValueOnce({ skipped: true, reason: 'missing_email' });
      setDbQueues({
        notification_prefs: [firstChain({ appointment_confirmation_channel: 'sms' })],
        customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
        scheduled_services: [
          firstChain({ scheduled_date: '2026-06-20', window_start: '08:00:00' }),
          firstChain({ id: 'ss1', customer_id: 'c1', reschedule_token: null }),
        ],
        appointment_reminders: [firstChain(null)],
      });
      const smsAttempt = jest.fn(async () => false);
      const reached = await deliverConfirmationByChannel({
        customerId: 'c1', scheduledServiceId: 'ss1', serviceLabel: 'Flea treatment',
        smsAttempt, smsPermanentlyBlocked: true,
      });

      expect(smsAttempt).toHaveBeenCalledTimes(1);
      expect(AppointmentEmail.sendAppointmentConfirmationEmail).toHaveBeenCalledTimes(1);
      // Genuinely unreached on either channel — the crm_notes stamp
      // (extraction-compat.js's callerIdDisclaimedNoteText, written when
      // the customer record was created) is the durable warning; this
      // helper itself never texted the disclaimed ANI.
      expect(reached).toBe(false);
    });
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

describe('deliverConfirmation marks sent only for the appointment time it formatted (local codex audit)', () => {
  test('both post-send marks are fenced on appointment_time so a silent grouped-sibling move under the send never suppresses the corrected confirmation', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'appointment-reminders.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function deliverConfirmation('), src.indexOf('// A reminder-registration failure used to be logger.error-only'));
    const fenced = fn.match(/\.where\(\{ id: record\.id, appointment_time: apptTime \}\)\s*\.update\(\{ confirmation_sent: true/g) || [];
    expect(fenced.length).toBe(2); // success path + catch path
    // the pre-send skips (past appointment / preference off) legitimately mark by id — nothing was sent for a stale time there
    expect(fn.indexOf('.where({ id: record.id, appointment_time: apptTime })')).toBeGreaterThan(fn.indexOf('recheckBeforeSend'));
  });
});
