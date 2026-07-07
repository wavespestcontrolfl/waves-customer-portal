jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { resolvePolicy } = require('../services/messaging/policy');
const { checkConsentForPurpose } = require('../services/messaging/validators/consent');

// Route internals for the payload/update mapping (mirrors the mocks in
// notifications-preferences.test.js — the route file only needs these to load).
jest.mock('express', () => ({
  Router: () => ({ use: jest.fn(), get: jest.fn(), put: jest.fn() }),
}), { virtual: true });
jest.mock('joi', () => ({}), { virtual: true });
jest.mock('../middleware/auth', () => ({ authenticate: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn() }));
const notificationsRoute = require('../routes/notifications');
const { notificationPrefsDbUpdates, preferencePayload, CHANNEL_DB_COLUMNS } = notificationsRoute._private;

const smsInput = (purpose) => ({
  to: '+19415550100',
  body: 'x',
  channel: 'sms',
  audience: 'customer',
  purpose,
  customerId: 'c1',
});

const contactState = (prefs) => ({ prefs, customer: { id: 'c1' }, lookupFailed: false });

describe('billing / payment-confirmation delivery channel (SMS leg gating)', () => {
  test("purpose 'billing': channel 'email' suppresses the SMS leg", async () => {
    const policy = resolvePolicy('customer', 'billing');
    const res = await checkConsentForPurpose(
      smsInput('billing'),
      policy,
      contactState({ sms_enabled: true, billing_reminder: true, billing_reminder_channel: 'email' }),
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('CHANNEL_EMAIL_ONLY');
  });

  test.each(['sms', 'both', undefined])("purpose 'billing': channel %s allows SMS", async (channel) => {
    const policy = resolvePolicy('customer', 'billing');
    const res = await checkConsentForPurpose(
      smsInput('billing'),
      policy,
      contactState({ sms_enabled: true, billing_reminder: true, billing_reminder_channel: channel }),
    );
    expect(res.ok).toBe(true);
  });

  test("purpose 'payment_receipt': channel 'email' suppresses the SMS leg", async () => {
    const policy = resolvePolicy('customer', 'payment_receipt');
    const res = await checkConsentForPurpose(
      smsInput('payment_receipt'),
      policy,
      contactState({ sms_enabled: true, payment_confirmation_sms: true, payment_confirmation_channel: 'email' }),
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('CHANNEL_EMAIL_ONLY');
  });

  test("channel gate only applies to the sms channel — an email send through the wrapper is not blocked", async () => {
    const policy = resolvePolicy('customer', 'payment_receipt');
    const res = await checkConsentForPurpose(
      { ...smsInput('payment_receipt'), channel: 'email' },
      policy,
      contactState({ sms_enabled: true, payment_confirmation_channel: 'email' }),
    );
    expect(res.ok).toBe(true);
  });

  test("purpose 'payment_receipt' now enforces the payment_confirmation_sms toggle", async () => {
    // The policy row used to point at a 'payment_receipt' column that never
    // existed on notification_prefs, so the portal toggle was stored but
    // never honored.
    const policy = resolvePolicy('customer', 'payment_receipt');
    expect(policy.prefsColumn).toBe('payment_confirmation_sms');

    const res = await checkConsentForPurpose(
      smsInput('payment_receipt'),
      policy,
      contactState({ sms_enabled: true, payment_confirmation_sms: false }),
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('PURPOSE_OPTED_OUT');
  });

  test('default-on customer (no channel columns yet) is unaffected', async () => {
    const policy = resolvePolicy('customer', 'payment_receipt');
    const res = await checkConsentForPurpose(
      smsInput('payment_receipt'),
      policy,
      contactState({ sms_enabled: true }),
    );
    expect(res.ok).toBe(true);
  });
});

describe('notifications route mapping for the billing channels', () => {
  test('accepts and normalizes the two channel keys', () => {
    expect(notificationPrefsDbUpdates({
      billingReminderChannel: 'email',
      paymentConfirmationChannel: 'both',
    }, {})).toEqual({
      billing_reminder_channel: 'email',
      payment_confirmation_channel: 'both',
    });

    // Unknown values normalize to sms (channelValue guard).
    expect(notificationPrefsDbUpdates({
      billingReminderChannel: 'carrier-pigeon',
    }, {})).toEqual({ billing_reminder_channel: 'sms' });
  });

  test('payload exposes the channels (defaulting to sms) and omits them from property payloads', () => {
    const full = preferencePayload({ billing_reminder_channel: 'email' });
    expect(full.billingReminderChannel).toBe('email');
    expect(full.paymentConfirmationChannel).toBe('sms');

    const property = preferencePayload({ billing_reminder_channel: 'email' }, { includeChannels: false });
    expect(property.billingReminderChannel).toBeUndefined();
    expect(property.paymentConfirmationChannel).toBeUndefined();
  });

  test('billing channels stay per-row — they are NOT account-level channel columns', () => {
    // Billing sends target the charged customer row, so these live next to
    // the billing_reminder / payment_confirmation_sms toggles rather than on
    // the primary profile like the appointment channels.
    expect(CHANNEL_DB_COLUMNS).not.toContain('billing_reminder_channel');
    expect(CHANNEL_DB_COLUMNS).not.toContain('payment_confirmation_channel');
  });
});
