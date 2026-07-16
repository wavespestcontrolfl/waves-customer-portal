jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/internal-test-customers', () => ({
  isInternalTestCustomerId: jest.fn(() => false),
}));
jest.mock('../services/push-notifications', () => ({
  sendToCustomer: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const logger = require('../services/logger');
const PushService = require('../services/push-notifications');
const NotificationService = require('../services/notification-service');

function preferenceQuery(row) {
  const q = {
    where: jest.fn(() => q),
    first: jest.fn(async () => row),
  };
  return q;
}

function notificationQuery({ existing = null, inserted = null } = {}) {
  const q = {
    where: jest.fn(() => q),
    whereRaw: jest.fn(() => q),
    first: jest.fn(async () => existing),
    insert: jest.fn(() => q),
    returning: jest.fn(async () => inserted ? [inserted] : []),
  };
  return q;
}

function setupDb({ prefs = null, existing = null, inserted = { id: 'notification-1' } } = {}) {
  const prefQ = preferenceQuery(prefs);
  const notifQ = notificationQuery({ existing, inserted });
  const trx = jest.fn((table) => {
    if (table === 'notifications') return notifQ;
    throw new Error(`Unexpected transaction table ${table}`);
  });
  trx.raw = jest.fn(async () => ({}));
  db.transaction = jest.fn(async (fn) => fn(trx));
  db.mockImplementation((table) => {
    if (table === 'notification_prefs') return prefQ;
    if (table === 'notifications') return notifQ;
    throw new Error(`Unexpected table ${table}`);
  });
  return { prefQ, notifQ, trx };
}

describe('customer notification native push dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    PushService.sendToCustomer.mockResolvedValue({ subscriptions: 1, sent: 1, expired: 0, failed: 0, skipped: 0 });
  });

  test('persists one bell and queues its native push with a stable event tag without awaiting the provider', async () => {
    const { notifQ, trx } = setupDb({ prefs: { tech_en_route: true } });
    let resolvePush;
    PushService.sendToCustomer.mockReturnValue(new Promise((resolve) => {
      resolvePush = resolve;
    }));

    const result = await NotificationService.notifyCustomer(
      'customer-1',
      'service',
      'Technician en route',
      'Your technician is on the way.',
      {
        link: '/?tab=visits',
        preferenceKey: 'tech_en_route',
        dedupeKey: 'scheduled-service:service-1:en-route',
        metadata: { scheduledServiceId: 'service-1' },
      },
    );

    expect(notifQ.insert).toHaveBeenCalledWith(expect.objectContaining({
      recipient_type: 'customer',
      recipient_id: 'customer-1',
      metadata: JSON.stringify({
        scheduledServiceId: 'service-1',
        dedupeKey: 'scheduled-service:service-1:en-route',
      }),
    }));
    expect(trx.raw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext(?))',
      ['customer-1:scheduled-service:service-1:en-route'],
    );
    expect(PushService.sendToCustomer).toHaveBeenCalledWith('customer-1', {
      title: 'Technician en route',
      body: 'Your technician is on the way.',
      url: '/?tab=visits',
      category: 'service',
      notificationId: 'notification-1',
      tag: 'scheduled-service:service-1:en-route',
    });
    expect(result.push).toEqual({ queued: true });
    resolvePush({ subscriptions: 1, sent: 1, expired: 0, failed: 0, skipped: 0 });
  });

  test('honors a disabled customer event preference before bell or push', async () => {
    const { notifQ } = setupDb({ prefs: { service_completed: false } });

    const result = await NotificationService.notifyCustomer(
      'customer-1',
      'service',
      'Service completed',
      'Your service is complete.',
      { preferenceKey: 'service_completed', dedupeKey: 'service-1:completed' },
    );

    expect(result).toEqual({ id: null, suppressed: true, reason: 'preference_disabled' });
    expect(notifQ.insert).not.toHaveBeenCalled();
    expect(PushService.sendToCustomer).not.toHaveBeenCalled();
  });

  test('dedupes a replayed lifecycle event before a second push', async () => {
    const existing = { id: 'existing-notification', title: 'Service completed' };
    const { notifQ } = setupDb({ prefs: { service_completed: true }, existing });

    const result = await NotificationService.notifyCustomer(
      'customer-1',
      'service',
      'Service completed',
      'Your service is complete.',
      { preferenceKey: 'service_completed', dedupeKey: 'service-1:completed' },
    );

    expect(result).toEqual({ ...existing, deduped: true, push: null });
    expect(notifQ.insert).not.toHaveBeenCalled();
    expect(PushService.sendToCustomer).not.toHaveBeenCalled();
  });

  test('keeps the durable bell successful when queued push dispatch fails', async () => {
    setupDb();
    PushService.sendToCustomer.mockRejectedValue(new Error('provider unavailable'));

    const result = await NotificationService.notifyCustomer(
      'customer-1',
      'account',
      'Estimate accepted',
      'Your service plan is confirmed.',
      { dedupeKey: 'estimate:estimate-1:accepted' },
    );

    expect(result).toMatchObject({ id: 'notification-1', push: { queued: true } });
    await Promise.resolve();
    expect(logger.warn).toHaveBeenCalledWith('[notifications] Customer push dispatch failed: provider unavailable');
  });

  test('fails closed when an unknown preference key is supplied', async () => {
    const { notifQ } = setupDb();

    const result = await NotificationService.notifyCustomer(
      'customer-1',
      'account',
      'Account update',
      'Your account changed.',
      { preferenceKey: 'not_a_real_preference' },
    );

    expect(result.suppressed).toBe(true);
    expect(notifQ.insert).not.toHaveBeenCalled();
    expect(PushService.sendToCustomer).not.toHaveBeenCalled();
  });
});
