'use strict';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/fcm', () => ({
  ...jest.requireActual('../services/fcm'),
  send: jest.fn(async () => ({ ok: true })),
  status: () => ({ available: true, configured: true }),
}));
jest.mock('../services/apns', () => ({
  STAFF_APP_BUNDLE_ID: 'com.waves.staff',
  send: jest.fn(async () => ({ ok: true })),
  status: () => ({ available: true, configured: false }),
}));

const db = require('../models/db');
const fcm = require('../services/fcm');
const pushNotifications = require('../services/push-notifications');

function mockCustomerAndSubs(subs) {
  db.mockImplementation((table) => {
    if (table === 'customers') {
      const q = {};
      q.where = () => q;
      q.whereNull = () => q;
      q.select = async () => [{ id: 'cust-1', account_id: 'cust-1', active: true, notification_prefs: null }];
      q.first = async () => ({ id: 'cust-1', account_id: 'cust-1', active: true, notification_prefs: null });
      return q;
    }
    if (table === 'customer_notification_preferences') {
      const q = {};
      q.where = () => q;
      q.first = async () => ({ push_enabled: true });
      return q;
    }
    if (table === 'push_subscriptions') {
      const q = {};
      q.whereIn = () => q;
      q.where = () => q;
      q.then = (resolve, reject) => Promise.resolve(subs).then(resolve, reject);
      return q;
    }
    const q = {};
    q.where = () => q;
    q.whereIn = () => q;
    q.first = async () => null;
    q.select = async () => [];
    return q;
  });
}

describe('push-notifications — Android per-channel eligibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('skips an Android device whose target notification channel is disabled so SMS fallback still fires', async () => {
    mockCustomerAndSubs([
      {
        id: 'sub-android-1',
        customer_id: 'cust-1',
        role: 'customer',
        platform: 'android',
        device_token: 'fcm-tok-1',
        active: true,
        contact_phone_key: null,
        subscription_data: JSON.stringify({
          token: 'fcm-tok-1',
          disabledChannels: ['waves_billing'],
        }),
      },
    ]);

    const billingRes = await pushNotifications.sendToCustomer('cust-1', {
      title: 'Invoice ready',
      body: 'Your invoice is ready.',
      category: 'billing',
      url: '/?tab=billing',
    });
    expect(billingRes.sent).toBe(0);
    expect(fcm.send).not.toHaveBeenCalled();

    // Service updates channel is still enabled on the same device.
    const serviceRes = await pushNotifications.sendToCustomer('cust-1', {
      title: 'Tech on the way',
      body: 'Alex is 12 minutes away.',
      category: 'tech_en_route',
      url: '/track/abc',
    });
    expect(serviceRes.sent).toBe(1);
    expect(fcm.send).toHaveBeenCalledTimes(1);
  });
});
