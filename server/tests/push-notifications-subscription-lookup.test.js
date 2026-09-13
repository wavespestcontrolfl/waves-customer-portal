// Regression: PushService.sendToCustomer's push_subscriptions lookup runs
// BEFORE any APNs/FCM provider request — a failure there is still
// preparation, not a provider handoff. Callers (push-channel-routing.js's
// attemptPushFirst) mark their outcome 'uncertain' the instant they call in
// here on the premise that anything thrown here crossed the provider
// boundary; this lookup must resolve as an ordinary no-delivery result
// instead of throwing, or a never-attempted send gets reported as an
// ambiguous provider outcome (codex #4338 P2).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/apns', () => ({ send: jest.fn(), status: () => ({ configured: false }) }));
jest.mock('../services/fcm', () => ({ send: jest.fn(), status: () => ({ configured: false }) }));
jest.mock('../services/account-properties', () => ({
  accountPropertyIds: jest.fn(async () => []),
  resolvePrimaryProfileId: jest.fn(async (req) => req.customerId),
  appPropertyScopeEnabled: jest.fn(() => false),
}));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => false) }));

const db = require('../models/db');
const Push = require('../services/push-notifications');

function firstQuery(row) {
  return { where: jest.fn(() => ({ first: jest.fn(async () => row) })) };
}

// A thenable that lazily rejects only once actually awaited — never an
// eagerly-created rejected Promise, so nothing warns about an unhandled
// rejection before the source code's own await/try-catch handles it.
function rejectingQuery(err) {
  const q = {};
  q.whereIn = jest.fn(() => q);
  q.where = jest.fn(() => q);
  q.then = (resolve, reject) => Promise.reject(err).then(resolve, reject);
  q.catch = (reject) => Promise.reject(err).catch(reject);
  return q;
}

beforeEach(() => jest.clearAllMocks());

test('a push_subscriptions lookup failure resolves as a normal no-delivery result, not a throw', async () => {
  const lookupErr = Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
  db.mockImplementation((table) => {
    if (table === 'customers') return firstQuery({ id: 'cust-1', account_id: null, active: true, deleted_at: null });
    if (table === 'notification_prefs') return firstQuery({ push_enabled: true });
    if (table === 'push_subscriptions') return rejectingQuery(lookupErr);
    throw new Error(`Unexpected table ${table}`);
  });

  const result = await Push.sendToCustomer('cust-1', {
    title: 'On my way', body: 'Your tech is en route', url: '/', category: 'service',
  });

  expect(result).toMatchObject({ sent: 0, reason: 'subscription_lookup_failed' });
});
