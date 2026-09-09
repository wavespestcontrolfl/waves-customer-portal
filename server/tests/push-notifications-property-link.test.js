// The push sink resolves the saved property a push is ABOUT from the visit id
// every appointment message carries (uncapped codex #4207 r1s P1): the app's
// deep link then names the stamped house, not the profile's primary.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/apns', () => ({ send: jest.fn(), status: () => ({ configured: false }) }));
jest.mock('../services/fcm', () => ({ send: jest.fn(), status: () => ({ configured: false }) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const pushService = require('../services/push-notifications');
const resolve = pushService.resolveNotificationPropertyId;
const { qualifyNotificationLink } = require('../services/notification-links');
const originalGate = process.env.GATE_APP_PROPERTY_SCOPE;
afterAll(() => { if (originalGate === undefined) delete process.env.GATE_APP_PROPERTY_SCOPE; else process.env.GATE_APP_PROPERTY_SCOPE = originalGate; });

function firstReturning(row) {
  const c = { where: jest.fn(() => c), first: jest.fn(async () => row) };
  return c;
}

beforeEach(() => { jest.clearAllMocks(); process.env.GATE_APP_PROPERTY_SCOPE = 'true'; });

test('gate off (or rolled back): no house hint at all — a composer hint is dropped and no lookup runs (uncapped codex r1t P1)', async () => {
  delete process.env.GATE_APP_PROPERTY_SCOPE;
  await expect(resolve('cust-1', { propertyId: 'prop-b', appointmentId: 'svc-1' })).resolves.toBeNull();
  expect(db).not.toHaveBeenCalled();
});

test('qualifyNotificationLink names the profile always and the house when known; absolute URLs pass through', () => {
  expect(qualifyNotificationLink('/?tab=visits', 'cust-1', null)).toBe('/?tab=visits&notificationProperty=cust-1');
  expect(qualifyNotificationLink('/?tab=visits', 'cust-1', 'prop-b')).toBe('/?tab=visits&notificationProperty=cust-1&notificationPropertyId=prop-b');
  expect(qualifyNotificationLink('/', 'cust-1', 'prop-b')).toBe('/?notificationProperty=cust-1&notificationPropertyId=prop-b');
  expect(qualifyNotificationLink('https://example.com/x', 'cust-1', 'prop-b')).toBe('https://example.com/x');
  expect(qualifyNotificationLink('//evil.example/x', 'cust-1', 'prop-b')).toBe('//evil.example/x');
});

test('a composer that knows the house wins, with no lookup', async () => {
  await expect(resolve('cust-1', { propertyId: 'prop-b', appointmentId: 'svc-1' })).resolves.toBe('prop-b');
  expect(db).not.toHaveBeenCalled();
});

test('a stamped visit resolves to its house — scoped to the recipient profile', async () => {
  const chain = firstReturning({ property_id: 'prop-b' });
  db.mockImplementation((table) => { expect(table).toBe('scheduled_services'); return chain; });
  await expect(resolve('cust-1', { appointmentId: 'svc-1' })).resolves.toBe('prop-b');
  expect(chain.where).toHaveBeenCalledWith({ id: 'svc-1', customer_id: 'cust-1' });
  expect(chain.first).toHaveBeenCalledWith('property_id');
});

test('an unstamped visit, an unknown visit, or no visit at all → the profile-only link (null)', async () => {
  db.mockImplementation(() => firstReturning({ property_id: null }));
  await expect(resolve('cust-1', { appointmentId: 'svc-1' })).resolves.toBeNull();
  db.mockImplementation(() => firstReturning(undefined));
  await expect(resolve('cust-1', { appointmentId: 'svc-missing' })).resolves.toBeNull();
  await expect(resolve('cust-1', { title: 'Hi' })).resolves.toBeNull();
});

test('a lookup failure never blocks the push: profile-only link', async () => {
  db.mockImplementation(() => ({ where: () => ({ first: async () => { throw new Error('connection reset'); } }) }));
  await expect(resolve('cust-1', { appointmentId: 'svc-1' })).resolves.toBeNull();
});

test('the in-app link is qualified under the app-notifications gate OR the property scope; bare under neither (uncapped codex r1w P1)', () => {
  const originalApp = process.env.GATE_CUSTOMER_APP_NOTIFICATIONS;
  try {
    delete process.env.GATE_CUSTOMER_APP_NOTIFICATIONS; delete process.env.GATE_APP_PROPERTY_SCOPE;
    expect(pushService.pushLinkQualificationEnabled()).toBe(false);
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    expect(pushService.pushLinkQualificationEnabled()).toBe(true);
    delete process.env.GATE_APP_PROPERTY_SCOPE; process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'true';
    expect(pushService.pushLinkQualificationEnabled()).toBe(true);
  } finally {
    if (originalApp === undefined) delete process.env.GATE_CUSTOMER_APP_NOTIFICATIONS; else process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = originalApp;
  }
});

