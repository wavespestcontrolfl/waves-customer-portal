jest.mock('express', () => ({
  Router: () => ({
    use: jest.fn(),
    get: jest.fn(),
    put: jest.fn(),
  }),
}), { virtual: true });
jest.mock('joi', () => ({}), { virtual: true });
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/auth', () => ({ authenticate: jest.fn() }));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/account-membership-email', () => ({
  sendAccountUpdated: jest.fn(),
}));

const db = require('../models/db');
const notificationsRoute = require('../routes/notifications');

const { notificationPrefsDbUpdates, preferenceChangeItems, resolvePrimaryProfileId, CHANNEL_DB_COLUMNS } = notificationsRoute._private;

describe('notification preference updates', () => {
  test('clears stale billing contact name when billing email changes without a replacement name', () => {
    const updates = notificationPrefsDbUpdates(
      { billingEmail: 'new-ap@example.com' },
      {
        billing_email: 'old-ap@example.com',
        billing_contact_name: 'Old Accounts Payable',
      },
    );

    expect(updates).toEqual({
      billing_email: 'new-ap@example.com',
      billing_contact_name: null,
    });
  });

  test('preserves billing contact name when the billing email is unchanged', () => {
    const updates = notificationPrefsDbUpdates(
      { billingEmail: 'AP@Example.com' },
      {
        billing_email: 'ap@example.com',
        billing_contact_name: 'Accounts Payable',
      },
    );

    expect(updates).toEqual({
      billing_email: 'AP@Example.com',
    });
  });

  test('stores replacement billing contact name with a changed billing email', () => {
    const updates = notificationPrefsDbUpdates(
      {
        billingEmail: 'new-ap@example.com',
        billingContactName: 'New Accounts Payable',
      },
      {
        billing_email: 'old-ap@example.com',
        billing_contact_name: 'Old Accounts Payable',
      },
    );

    expect(updates).toEqual({
      billing_email: 'new-ap@example.com',
      billing_contact_name: 'New Accounts Payable',
    });
  });

  test('ignores billing contact name when no effective billing email exists', () => {
    const updates = notificationPrefsDbUpdates(
      { billingContactName: 'Accounts Payable' },
      {},
    );

    expect(updates).toEqual({});
  });

  test('updates billing contact name when existing billing email is present', () => {
    const updates = notificationPrefsDbUpdates(
      { billingContactName: 'Accounts Payable' },
      { billing_email: 'ap@example.com' },
    );

    expect(updates).toEqual({
      billing_contact_name: 'Accounts Payable',
    });
  });

  test('maps per-notification delivery channels to their db columns', () => {
    const updates = notificationPrefsDbUpdates(
      {
        appointmentConfirmationChannel: 'email',
        serviceReminder72hChannel: 'both',
        serviceReminder24hChannel: 'sms',
      },
      {},
    );

    expect(updates).toEqual({
      appointment_confirmation_channel: 'email',
      service_reminder_72h_channel: 'both',
      service_reminder_24h_channel: 'sms',
    });
  });

  test('coerces an unrecognized channel value to sms', () => {
    const updates = notificationPrefsDbUpdates(
      { serviceReminder24hChannel: 'pigeon' },
      {},
    );

    expect(updates).toEqual({ service_reminder_24h_channel: 'sms' });
  });

  test('labels a delivery-channel change with its from/to channel names', () => {
    const items = preferenceChangeItems(
      { serviceReminder24hChannel: 'email' },
      { service_reminder_24h_channel: 'sms' },
      { serviceReminder24hChannel: 'email' },
      { scope: 'Account' },
    );

    expect(items).toEqual([{
      key: 'serviceReminder24hChannel',
      label: '24-Hour Service Reminder — Delivery',
      oldValue: 'Text',
      newValue: 'Email',
      scope: 'Account',
    }]);
  });

  test('labels a 72-hour reminder toggle for account.updated emails', () => {
    const items = preferenceChangeItems(
      { serviceReminder72h: false },
      { service_reminder_72h: true },
      { serviceReminder72h: false },
      { scope: 'Account' },
    );

    expect(items).toEqual([{
      key: 'serviceReminder72h',
      label: '72-Hour Appointment Reminder',
      oldValue: 'On',
      newValue: 'Off',
      scope: 'Account',
    }]);
  });
});

describe('account-level channel routing', () => {
  function customersChain(value) {
    const q = { where: jest.fn(() => q), first: jest.fn(async () => value) };
    return q;
  }

  test('resolvePrimaryProfileId resolves the account primary for a secondary-property session', async () => {
    db.mockImplementation(() => customersChain({ id: 'primary-1' }));
    const id = await resolvePrimaryProfileId({ customerId: 'secondary-1', customer: { account_id: 'acct-1' } });
    expect(id).toBe('primary-1');
  });

  test('resolvePrimaryProfileId falls back to the current customer when no primary profile is found', async () => {
    db.mockImplementation(() => customersChain(null));
    const id = await resolvePrimaryProfileId({ customerId: 'solo-1' });
    expect(id).toBe('solo-1');
  });

  test('CHANNEL_DB_COLUMNS lists the three appointment channel columns', () => {
    expect(CHANNEL_DB_COLUMNS).toEqual([
      'appointment_confirmation_channel',
      'service_reminder_72h_channel',
      'service_reminder_24h_channel',
    ]);
  });
});
