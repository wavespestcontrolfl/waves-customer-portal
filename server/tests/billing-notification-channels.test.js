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

const contactState = (prefs, customer = { id: 'c1' }) => ({ prefs, customer, lookupFailed: false });

describe('billing / payment-confirmation delivery channel (SMS leg gating)', () => {
  test('the channel gate reads the SAME migration-104 columns the channel-aware receipt senders use', () => {
    // estimate-deposits / estimate-card-holds branch their email legs off
    // payment_receipt_channel — the consent gate must not read a parallel
    // column or a portal email-only choice suppresses their SMS while their
    // email branch never fires (Codex P1 on d9029cb).
    expect(resolvePolicy('customer', 'billing').channelColumn).toBe('billing_channel');
    expect(resolvePolicy('customer', 'payment_receipt').channelColumn).toBe('payment_receipt_channel');
  });

  test("purpose 'billing': channel 'email' suppresses the SMS leg for callers with an email sidecar", async () => {
    const policy = resolvePolicy('customer', 'billing');
    const res = await checkConsentForPurpose(
      { ...smsInput('billing'), hasEmailLeg: true },
      policy,
      contactState({ sms_enabled: true, billing_reminder: true, billing_channel: 'email', billing_email: 'ap@example.com' }),
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('CHANNEL_EMAIL_ONLY');
  });

  test.each(['sms', 'both', undefined])("purpose 'billing': channel %s allows SMS", async (channel) => {
    const policy = resolvePolicy('customer', 'billing');
    const res = await checkConsentForPurpose(
      smsInput('billing'),
      policy,
      contactState({ sms_enabled: true, billing_reminder: true, billing_channel: channel }),
    );
    expect(res.ok).toBe(true);
  });

  test("purpose 'payment_receipt': channel 'email' suppresses the SMS leg (account email on file)", async () => {
    const policy = resolvePolicy('customer', 'payment_receipt');
    const res = await checkConsentForPurpose(
      { ...smsInput('payment_receipt'), hasEmailLeg: true },
      policy,
      contactState(
        { sms_enabled: true, payment_confirmation_sms: true, payment_receipt_channel: 'email' },
        { id: 'c1', email: 'adam@example.com' },
      ),
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('CHANNEL_EMAIL_ONLY');
  });

  test("channel 'email' with NO deliverable email falls back to SMS instead of leaving no channel", async () => {
    // The portal UI can't save an email-only choice without an email on file,
    // but a direct API write (or an email removed later) can — the customer
    // must still be reachable.
    const policy = resolvePolicy('customer', 'payment_receipt');
    const res = await checkConsentForPurpose(
      { ...smsInput('payment_receipt'), hasEmailLeg: true },
      policy,
      contactState(
        { sms_enabled: true, payment_confirmation_sms: true, payment_receipt_channel: 'email' },
        { id: 'c1', email: null },
      ),
    );
    expect(res.ok).toBe(true);
  });

  test("payment_receipt gate is OPT-IN — SMS-only confirmations without an email leg are never suppressed", async () => {
    // billing-cron autopay successes, invoice thank-yous, balance
    // payment-received and manual-charge receipts send purpose
    // 'payment_receipt' with NO email sidecar; an email-only preference must
    // not silence them entirely (Codex P2 on d07235e9). Only callers that
    // declare hasEmailLeg (the invoice receipt path) get the gate.
    const policy = resolvePolicy('customer', 'payment_receipt');
    expect(policy.channelGate).toBe('opt_in');
    const res = await checkConsentForPurpose(
      smsInput('payment_receipt'),
      policy,
      contactState(
        { sms_enabled: true, payment_confirmation_sms: true, payment_receipt_channel: 'email' },
        { id: 'c1', email: 'adam@example.com' },
      ),
    );
    expect(res.ok).toBe(true);
  });

  test("the 'billing' gate is OPT-IN too — callers without an email fallback are never suppressed", async () => {
    // An unconditional gate would turn an email-preferring customer's
    // billing reminder into silence for any SMS-only sender (Codex P2 on
    // 15fc2cf0). The operator Comms billing reminder DOES opt in
    // (comms-tools passes hasEmailLeg) because its block is surfaced to the
    // operator, who is the email fallback (Codex P2 on 4263af95); the
    // dispatcher's billing lane pre-filters on billing_channel itself.
    const policy = resolvePolicy('customer', 'billing');
    expect(policy.channelGate).toBe('opt_in');
    const res = await checkConsentForPurpose(
      smsInput('billing'),
      policy,
      contactState({ sms_enabled: true, billing_reminder: true, billing_channel: 'email', billing_email: 'ap@example.com' }),
    );
    expect(res.ok).toBe(true);
  });

  test("portal-wide email opt-out (email_enabled=false) makes an email-only channel undeliverable — SMS stays the fallback", async () => {
    // Every receipt/billing email leg skips email_enabled=false customers,
    // so suppressing the SMS on their stored channel='email' row would drop
    // the notice entirely. Pre-existing rows / direct writes can carry this
    // state even though the portal UI now locks the dropdowns (codex round 7).
    const policy = resolvePolicy('customer', 'billing');
    const res = await checkConsentForPurpose(
      smsInput('billing'),
      policy,
      contactState({ sms_enabled: true, billing_reminder: true, billing_channel: 'email', billing_email: 'ap@example.com', email_enabled: false }),
    );
    expect(res.ok).toBe(true);
  });

  test("channel 'email' outranks a STOP opt-out — the skip must read as the channel preference", async () => {
    // An email-only customer who has also texted STOP gets CHANNEL_EMAIL_ONLY,
    // not SMS_OPTED_OUT: the receipt-delivery queue treats the channel
    // preference as an expected skip but an SMS opt-out as an actionable
    // failure, and would retry forever a receipt whose email leg delivered
    // (Codex P2 on 8bcfd5c). The SMS is suppressed either way.
    const policy = resolvePolicy('customer', 'payment_receipt');
    const res = await checkConsentForPurpose(
      { ...smsInput('payment_receipt'), hasEmailLeg: true },
      policy,
      contactState(
        { sms_enabled: false, payment_confirmation_sms: true, payment_receipt_channel: 'email' },
        { id: 'c1', email: 'adam@example.com' },
      ),
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('CHANNEL_EMAIL_ONLY');
  });

  test("channel 'email' with NO deliverable email never texts a STOP customer", async () => {
    // The no-email fallback re-enters the normal SMS gates — a STOP must
    // still block the leg with SMS_OPTED_OUT.
    const policy = resolvePolicy('customer', 'payment_receipt');
    const res = await checkConsentForPurpose(
      { ...smsInput('payment_receipt'), hasEmailLeg: true },
      policy,
      contactState(
        { sms_enabled: false, payment_confirmation_sms: true, payment_receipt_channel: 'email' },
        { id: 'c1', email: null },
      ),
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('SMS_OPTED_OUT');
  });

  test("channel 'email' outranks the purpose toggles too — the delivered email IS the receipt", async () => {
    // Same ordering rationale: 'channel_email_only' lets the queue stamp
    // receipt_sent_at off the delivered email leg.
    const policy = resolvePolicy('customer', 'payment_receipt');
    const res = await checkConsentForPurpose(
      { ...smsInput('payment_receipt'), hasEmailLeg: true },
      policy,
      contactState(
        { sms_enabled: true, payment_confirmation_sms: false, payment_receipt_channel: 'email' },
        { id: 'c1', email: 'adam@example.com' },
      ),
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('CHANNEL_EMAIL_ONLY');
  });

  test("channel gate only applies to the sms channel — an email send through the wrapper is not blocked", async () => {
    const policy = resolvePolicy('customer', 'payment_receipt');
    const res = await checkConsentForPurpose(
      { ...smsInput('payment_receipt'), channel: 'email' },
      policy,
      contactState({ sms_enabled: true, payment_receipt_channel: 'email', billing_email: 'ap@example.com' }),
    );
    expect(res.ok).toBe(true);
  });

  test("purpose 'payment_receipt' honors BOTH the legacy receipt opt-out and the portal texts toggle", async () => {
    const policy = resolvePolicy('customer', 'payment_receipt');
    expect(policy.prefsColumn).toEqual(['payment_receipt', 'payment_confirmation_sms']);

    // Legacy kill switch (migration 104, also honored by the deposit /
    // no-show-fee receipt flows) still blocks — Codex P1 on d9029cb caught
    // this being dropped.
    const legacy = await checkConsentForPurpose(
      smsInput('payment_receipt'),
      policy,
      contactState({ sms_enabled: true, payment_receipt: false, payment_confirmation_sms: true }),
    );
    expect(legacy.ok).toBe(false);
    expect(legacy.code).toBe('PURPOSE_OPTED_OUT');

    // Portal "Payment confirmation texts" toggle — stored-but-unenforced
    // before this PR — now blocks too.
    const portal = await checkConsentForPurpose(
      smsInput('payment_receipt'),
      policy,
      contactState({ sms_enabled: true, payment_receipt: true, payment_confirmation_sms: false }),
    );
    expect(portal.ok).toBe(false);
    expect(portal.code).toBe('PURPOSE_OPTED_OUT');
  });

  test('default-on customer (no channel/toggle columns set) is unaffected', async () => {
    const policy = resolvePolicy('customer', 'payment_receipt');
    const res = await checkConsentForPurpose(
      smsInput('payment_receipt'),
      policy,
      contactState({ sms_enabled: true }),
    );
    expect(res.ok).toBe(true);
  });
});

describe('Comms send_sms schema exposes billing_reminder', () => {
  test('the model can actually select the type that activates the billing channel gate', () => {
    // The opt-in gate only fires for message_type='billing_reminder' — if the
    // advertised enum omits it, the IB model can never send one and the
    // Billing Reminder Delivery preference is unenforceable from the Comms
    // path (codex round 5).
    const { COMMS_TOOLS } = require('../services/intelligence-bar/comms-tools');
    const sendSms = COMMS_TOOLS.find((t) => t.name === 'send_sms');
    expect(sendSms.input_schema.properties.message_type.enum).toContain('billing_reminder');
  });
});

describe('notifications route mapping for the billing channels', () => {
  test('accepts the two portal keys and writes the migration-104 columns', () => {
    expect(notificationPrefsDbUpdates({
      billingReminderChannel: 'email',
      paymentConfirmationChannel: 'both',
    }, {})).toEqual({
      billing_channel: 'email',
      payment_receipt_channel: 'both',
    });

    // Unknown values normalize to sms (channelValue guard).
    expect(notificationPrefsDbUpdates({
      billingReminderChannel: 'carrier-pigeon',
    }, {})).toEqual({ billing_channel: 'sms' });
  });

  test('payload exposes the channels (defaulting to sms) and omits them from property payloads', () => {
    const full = preferencePayload({ billing_channel: 'email' });
    expect(full.billingReminderChannel).toBe('email');
    expect(full.paymentConfirmationChannel).toBe('sms');

    const property = preferencePayload({ billing_channel: 'email' }, { includeChannels: false });
    expect(property.billingReminderChannel).toBeUndefined();
    expect(property.paymentConfirmationChannel).toBeUndefined();
  });

  test('billing channels stay per-row — they are NOT account-level channel columns', () => {
    // Billing sends target the charged customer row, so these live next to
    // the billing_reminder / payment_confirmation_sms toggles rather than on
    // the primary profile like the appointment channels.
    expect(CHANNEL_DB_COLUMNS).not.toContain('billing_channel');
    expect(CHANNEL_DB_COLUMNS).not.toContain('payment_receipt_channel');
  });
});
