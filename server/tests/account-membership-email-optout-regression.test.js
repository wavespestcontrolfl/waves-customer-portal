/**
 * Regression test for AUDIT r1-comms-side-effects-2 (service level).
 *
 * Before the fix, account-membership-email.sendMembershipUpdated /
 * sendMembershipCanceled / sendRequestUpdated never read notification_prefs,
 * so a customer with the portal-wide email opt-out (email_enabled=false) was
 * still emailed. sendTemplate() now reads notification_prefs for the
 * recipient and skips (fail-closed) when email_enabled === false, the way
 * receipt-delivery-queue.js and friends already do.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({
    sent: true,
    message: { provider_message_id: 'sg-123', status: 'sent', sent_at: '2026-09-22T12:00:00.000Z' },
  })),
}));
jest.mock('../services/request-app-notifications', () => ({ send: jest.fn(async () => ({})) }));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const AccountMembershipEmail = require('../services/account-membership-email');

function chain({ result = [], first } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNotNull', 'whereNotIn', 'whereNull', 'select', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => []);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

const customer = (o = {}) => ({
  id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan', email: 'taylor@example.com',
  phone: '+19415550101', address_line1: '123 Main St', city: 'Bradenton', state: 'FL', zip: '34211',
  waveguard_tier: 'Gold', monthly_rate: '98.00', billing_mode: 'monthly_membership', active: true, ...o,
});

let prefsQueue;
function setDb() {
  prefsQueue = [chain({ first: { customer_id: 'cust-1', email_enabled: false } })];
  const queues = {
    customers: [chain({ first: customer() }), chain({ first: customer() }), chain({ first: customer() })],
    customer_interactions: [chain(), chain(), chain()],
    notification_prefs: prefsQueue,
  };
  db.mockImplementation((table) => {
    const q = queues[table];
    if (!q || !q.length) throw new Error(`Unexpected db table ${table}`);
    return q.shift();
  });
}

describe('account-membership-email honors notification_prefs.email_enabled=false', () => {
  beforeEach(() => { jest.clearAllMocks(); setDb(); });

  test('membership.updated (rate typo fix 89 -> 98) is NOT emailed to an opted-out customer', async () => {
    const result = await AccountMembershipEmail.sendMembershipUpdated({
      customerId: 'cust-1',
      before: { waveguard_tier: 'Gold', monthly_rate: '89.00', billing_mode: 'monthly_membership' },
      after: { waveguard_tier: 'Gold', monthly_rate: '98.00', billing_mode: 'monthly_membership' },
    });
    // Fixed: notification_prefs is consulted and the send is skipped.
    expect(prefsQueue).toHaveLength(0);
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, skipped: true, reason: 'email_opted_out' });
  });

  test('membership.canceled ("Account deactivated") is NOT emailed to an opted-out customer', async () => {
    const result = await AccountMembershipEmail.sendMembershipCanceled({
      customerId: 'cust-1', reason: 'Account deactivated', membershipTier: 'Gold', monthlyRate: '98.00',
    });
    expect(prefsQueue).toHaveLength(0);
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, skipped: true, reason: 'email_opted_out' });
  });

  test('account.request_updated is NOT emailed to an opted-out customer', async () => {
    const result = await AccountMembershipEmail.sendRequestUpdated({
      customerId: 'cust-1',
      request: { id: 'req-1', customer_id: 'cust-1', status: 'resolved', category: 'general', subject: 'Ants', source: 'portal', updated_at: '2026-09-22T12:00:00.000Z' },
      statusLabel: 'Resolved',
    });
    expect(prefsQueue).toHaveLength(0);
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, skipped: true, reason: 'email_opted_out' });
  });
});
