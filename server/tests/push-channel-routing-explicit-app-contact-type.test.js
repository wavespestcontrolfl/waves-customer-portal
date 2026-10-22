'use strict';

// Explicit-App delivery (attemptPushFirst, explicitPushOnly): the holder chose
// App for an appointment or report notice. The bell it raises through
// notifyCustomer carries no preference key, so the ROUTED message type must
// ride in pushOptions for the contact-device rule (contactPushPurpose in
// sendToCustomer) — without it a contact's device never gets the app alert
// the holder's choice promised, for every explicit-App send (codex #6364 r2
// P2). The holder's own legs read nothing from it.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/push-notifications', () => ({
  PUSH_HEARTBEAT_HOURS: 72,
  customerStatus: jest.fn(async () => ({ enabled: true, fresh: true })),
}));
jest.mock('../services/notification-service', () => ({
  notifyCustomer: jest.fn(async () => ({ id: 'notif-1', push: { queued: true, accepted: 0 } })),
}));
jest.mock('../services/account-properties', () => ({
  resolvePrimaryProfileId: jest.fn(async ({ customerId }) => customerId),
}));
jest.mock('../services/messaging/notice-scope', () => ({ noticeScope: jest.fn(async () => ({})) }));

const db = require('../models/db');
const { notifyCustomer } = require('../services/notification-service');
const { attemptPushFirst } = require('../services/messaging/push-channel-routing');

// The two reads the eligibility check makes: the customer's own phone, and
// the primary profile's channel column — set to App for whatever column the
// message type resolves to.
function chain(table) {
  const c = {};
  for (const m of ['where', 'whereNull', 'whereIn', 'orderBy', 'select']) c[m] = () => c;
  c.first = async (...cols) => {
    if (table === 'customers') return { phone: '+19415550101', account_id: 'cust-1' };
    if (table === 'notification_prefs') return Object.fromEntries(cols.map((col) => [col, 'push']));
    return null;
  };
  return c;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation((table) => chain(table));
  process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'true';
});
afterEach(() => { delete process.env.GATE_CUSTOMER_APP_NOTIFICATIONS; });

test('an explicit-App appointment notice passes the routed message type to the bell\'s push options, so a contact device is judged by its purpose', async () => {
  const result = await attemptPushFirst({
    customerId: 'cust-1', to: '+19415550101', body: 'Your technician is on the way.',
    messageType: 'tech_en_route', explicitPushOnly: true, notificationEventKey: 'visit-1:en-route',
  });
  expect(notifyCustomer).toHaveBeenCalledTimes(1);
  expect(notifyCustomer).toHaveBeenCalledWith('cust-1', 'service', 'Your technician is on the way', 'Your technician is on the way.',
    expect.objectContaining({
      awaitPush: true,
      dedupeKey: 'visit-1:en-route',
      pushOptions: expect.objectContaining({ nativeOnly: true, messageType: 'tech_en_route' }),
    }));
  // No device accepted: the SMS fallback decision is unchanged by the option.
  expect(result).toMatchObject({ delivered: false, deliveryOutcome: 'not_sent' });
});
