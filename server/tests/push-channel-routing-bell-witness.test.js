const mockNotifyCustomer = jest.fn();

function query(first) {
  const q = {
    where: jest.fn(() => q),
    first: jest.fn(async () => first),
  };
  return q;
}

const mockDb = jest.fn((table) => {
  if (table === 'customers') return query({ id: 'customer-1', phone: '+19415550101', account_id: null });
  if (table === 'notification_prefs') return query({ billing_channels: ['push'] });
  throw new Error(`Unexpected table: ${table}`);
});

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => true) }));
jest.mock('../services/billing-delivery-channels', () => ({
  explicitBillingChannels: jest.fn(() => ['push']),
}));
jest.mock('../services/push-notifications', () => ({
  PUSH_HEARTBEAT_HOURS: 24,
  customerStatus: jest.fn(async () => ({ enabled: true, fresh: true })),
}));
jest.mock('../services/notification-service', () => ({ notifyCustomer: mockNotifyCustomer }));
jest.mock('../services/messaging/notice-scope', () => ({ noticeScope: jest.fn(async () => ({})) }));

const { attemptPushFirst } = require('../services/messaging/push-channel-routing');

const input = {
  customerId: 'customer-1',
  to: null,
  body: 'Your balance is ready.',
  messageType: 'billing_reminder',
  explicitPushOnly: true,
  notificationEventKey: 'billing:event-1',
  billingDeliveryCategory: 'billing',
};

describe('attemptPushFirst persisted-bell failure evidence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([
    ['new', { id: 'bell-new', deduped: false }, true],
    ['refreshed', { id: 'bell-refreshed', deduped: true, refreshed: true }, true],
  ])('native retry preserves only a %s bell witness', async (_label, bell, expectedWitness) => {
    mockNotifyCustomer.mockResolvedValue({
      ...bell,
      push: { accepted: 0, retryable: 1, retryAfterMs: 900000 },
    });

    const result = await attemptPushFirst(input);

    expect(result).toMatchObject({
      delivered: false,
      retryable: true,
      deliveryOutcome: 'uncertain',
      reason: 'native_provider_retryable',
      retryAfterMs: 900000,
    });
    expect(result.bellPersisted).toBe(expectedWitness ? true : undefined);
  });

  test.each([
    ['new', { id: 'bell-new', deduped: false }, true],
  ])('push-in-flight preserves only a %s bell witness', async (_label, bell, expectedWitness) => {
    mockNotifyCustomer.mockResolvedValue({
      ...bell,
      push: { accepted: 0, deduped: true, reason: 'push_in_flight' },
    });

    const result = await attemptPushFirst(input);

    expect(result).toMatchObject({
      delivered: false,
      pending: true,
      deliveryOutcome: 'uncertain',
      reason: 'push_in_flight',
    });
    expect(result.bellPersisted).toBe(expectedWitness ? true : undefined);
  });

  test('a post-persistence exception keeps the current bell witness without changing certainty', async () => {
    const push = {};
    Object.defineProperty(push, 'accepted', { get() { throw new Error('post-persistence read failed'); } });
    mockNotifyCustomer.mockResolvedValue({ id: 'bell-new', deduped: false, push });

    await expect(attemptPushFirst(input)).resolves.toEqual({
      delivered: false,
      retryable: true,
      deliveryOutcome: 'uncertain',
      reason: 'push_attempt_failed',
      bellPersisted: true,
    });
  });

  test.each(['dedupe_payload_changed', 'push_in_flight'])('an existing billing bell retires its event on %s', async (reason) => {
    const visibleAt = new Date(Date.now() - 86400000);
    mockNotifyCustomer.mockResolvedValue({ id: 'original-bell', created_at: visibleAt, deduped: true, push: { accepted: 0, reason } });
    expect(await attemptPushFirst(input)).toEqual({
      delivered: false, deliveryOutcome: 'not_sent', reason: 'app_event_already_visible', eventVisibleAt: visibleAt,
    });
  });

  test('a first native acceptance on an unchanged old bell remains the original billing event', async () => {
    const visibleAt = new Date(Date.now() - 86400000);
    mockNotifyCustomer.mockResolvedValue({ id: 'original-bell', created_at: visibleAt,
      deduped: true, push: { accepted: 1, deduped: false } });

    expect(await attemptPushFirst(input)).toEqual({
      delivered: false, deliveryOutcome: 'not_sent', reason: 'app_event_already_visible', eventVisibleAt: visibleAt,
    });
    expect(mockNotifyCustomer).toHaveBeenCalledTimes(1);
    // The existing bell settled billing at visibleAt; no second billing
    // contact or retry-time sms_log proof is written for its native transport.
    expect(mockDb).not.toHaveBeenCalledWith('sms_log');
  });
});
