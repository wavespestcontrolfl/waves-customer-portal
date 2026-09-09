// The push sink resolves the saved property a push is ABOUT from the visit id
// every appointment message carries (uncapped codex #4207 r1s P1): the app's
// deep link then names the stamped house, not the profile's primary.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/apns', () => ({ send: jest.fn(), status: () => ({ configured: false }) }));
jest.mock('../services/fcm', () => ({ send: jest.fn(), status: () => ({ configured: false }) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const pushService = require('../services/push-notifications');
const resolve = pushService._resolveNotificationPropertyId;

function firstReturning(row) {
  const c = { where: jest.fn(() => c), first: jest.fn(async () => row) };
  return c;
}

beforeEach(() => jest.clearAllMocks());

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
