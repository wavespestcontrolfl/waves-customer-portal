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

const notificationsRoute = require('../routes/notifications');

const { notificationPrefsDbUpdates, preferenceChangeItems } = notificationsRoute._private;

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
