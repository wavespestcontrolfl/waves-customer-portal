// No-phone pre-charge reminders (codex #4803 r5 P1 4102411769): a customer
// without a phone is reached only through an explicit App / Email choice,
// each leg dispatched on its own with the billing delivery keys the other
// workflows use, and each accepted leg keeps its own cooldown so an accepted
// App never retires an unfinished Email.
let mockCustomers = [];
let mockPrefs = null;
const mockCooldown = jest.fn(async () => false);

jest.mock('../models/db', () => {
  function thenableFor(resultFn, firstFn) {
    const b = {};
    for (const m of ['where', 'whereRaw', 'whereNull', 'select', 'orderBy']) b[m] = () => b;
    b.first = () => Promise.resolve(firstFn ? firstFn() : (resultFn()[0] || null));
    b.then = (resolve, reject) => Promise.resolve(resultFn()).then(resolve, reject);
    return b;
  }
  const db = jest.fn((table) => {
    if (table === 'customers') return thenableFor(() => mockCustomers, () => ({
      ...mockCustomers[0], billing_mode: 'monthly_membership', active: true, deleted_at: null,
    }));
    if (table === 'notification_prefs') return thenableFor(() => [], () => mockPrefs);
    return thenableFor(() => []);
  });
  return db;
});
jest.mock('../services/logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
jest.mock('../services/autopay-log', () => ({
  logAutopay: jest.fn(async () => {}),
  eventExistsRecently: (...args) => mockCooldown(...args),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async () => 'Hello! Your auto-pay processes soon.'),
}));
jest.mock('../services/payment-lifecycle-email', () => ({}));
jest.mock('../services/autopay-eligibility', () => ({ isPaused: jest.fn(() => false) }));

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { logAutopay } = require('../services/autopay-log');
const { sendPreChargeReminders } = require('../services/autopay-notifications');

const NO_PHONE = { id: 'cust-1', first_name: 'Pat', phone: null, monthly_rate: '89.00',
  waveguard_tier: 'Gold', billing_mode: 'monthly_membership', autopay_paused_until: null };

beforeEach(() => {
  jest.clearAllMocks();
  mockCooldown.mockImplementation(async () => false);
  mockCustomers = [NO_PHONE];
  mockPrefs = null;
});

test('each selected App and Email leg is dispatched explicitly with its own billing keys and no Text', async () => {
  mockPrefs = { billing_channels: ['push', 'email'] };
  const result = await sendPreChargeReminders();
  expect(result).toMatchObject({ sent: 1, skipped: 0 });
  expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
  const calls = sendCustomerMessage.mock.calls.map(([input]) => input);
  expect(calls.map((input) => input.channel)).toEqual(['push', 'email']);
  for (const input of calls) {
    expect(input).toMatchObject({ to: null, customerId: 'cust-1', entryPoint: 'autopay_pre_charge_reminder',
      metadata: expect.objectContaining({
        original_message_type: 'autopay_pre_charge', billing_mode_at_send: 'monthly_membership',
        billingDeliveryCategory: 'billing', billingDeliveryLeg: input.channel,
        notificationEventKey: expect.stringMatching(/^autopay-pre-charge:cust-1:\d{4}-\d{2}-\d{2}$/),
      }) });
    expect(typeof input.preDispatchCheck).toBe('function');
  }
  expect(calls[0].metadata.appOnly).toBe(true);
  expect(calls[1].metadata.appOnly).toBeUndefined();
  // Each accepted leg records its own progress row.
  expect(logAutopay.mock.calls.map(([, type, opts]) => [type, opts.details.channel]))
    .toEqual([['pre_charge_reminder_sent', 'push'], ['pre_charge_reminder_sent', 'email']]);
});

test('an accepted App leg does not retire an unfinished Email leg: only the pending leg is re-sent', async () => {
  mockPrefs = { billing_channels: ['push', 'email'] };
  mockCooldown.mockImplementation(async (_c, _t, _d, _pm, details) => details?.channel === 'push');
  await sendPreChargeReminders();
  expect(mockCooldown).toHaveBeenCalledWith('cust-1', 'pre_charge_reminder_sent', 25, null, { channel: 'push' });
  expect(mockCooldown).toHaveBeenCalledWith('cust-1', 'pre_charge_reminder_sent', 25, null, { channel: 'email' });
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  expect(sendCustomerMessage.mock.calls[0][0].channel).toBe('email');
});

test('a leg the canonical sender did not accept records no progress and is retried next run', async () => {
  mockPrefs = { billing_channels: ['email'] };
  sendCustomerMessage.mockResolvedValueOnce({ sent: false, deliveryOutcome: 'not_sent', code: 'EMAIL_NOT_WIRED' });
  const result = await sendPreChargeReminders();
  expect(result).toMatchObject({ sent: 0 });
  expect(logAutopay).not.toHaveBeenCalled();
});

test.each([null, { billing_channels: null }, { billing_channels: ['sms'] }])(
  'a no-phone customer with no explicit App/Email choice is skipped without a send: %j', async (prefs) => {
    mockPrefs = prefs;
    const result = await sendPreChargeReminders();
    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  },
);

test('a customer with a phone keeps the single Text reminder and the customer-wide cooldown', async () => {
  mockCustomers = [{ ...NO_PHONE, phone: '+19415550101' }];
  await sendPreChargeReminders();
  expect(mockCooldown).toHaveBeenCalledWith('cust-1', 'pre_charge_reminder_sent', 25);
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  expect(sendCustomerMessage.mock.calls[0][0]).toMatchObject({ to: '+19415550101', channel: 'sms' });
  expect(sendCustomerMessage.mock.calls[0][0].metadata).toEqual({
    original_message_type: 'autopay_pre_charge', billing_mode_at_send: 'monthly_membership',
  });
});
