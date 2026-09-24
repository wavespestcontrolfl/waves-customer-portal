/**
 * AUDIT REPRO r1-comms-side-effects-2
 *
 * Claim: the membership.* / account.request_updated lifecycle emails fired
 * as side effects of admin Customer 360 saves (PUT /api/admin/customers/:id)
 * and service-request triage (PATCH /api/admin/requests/:id) ignore the
 * portal-wide email opt-out (notification_prefs.email_enabled = false).
 *
 * These tests assert the EXPECTED behaviour (opted-out customer is NOT
 * emailed), the way review-request.js:2913, autopay-setup-link.js:272,
 * document-contract-delivery.js:404 and account-membership-email.js:505
 * (previsit balance) already behave. They FAIL on current code if the bug
 * is real. Mocking pattern copied from server/tests/account-membership-email.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({
    sent: true,
    message: { provider_message_id: 'sg-123', status: 'sent', sent_at: '2026-09-23T12:00:00.000Z' },
  })),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const AccountMembershipEmail = require('../services/account-membership-email');

function chain({ result = [], first, returning } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNotNull', 'whereNotIn', 'whereNull', 'select', 'orderBy'].forEach((m) => {
    q[m] = jest.fn(() => q);
  });
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

const tablesRead = [];
function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    tablesRead.push(table);
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
}

function customer(overrides = {}) {
  return {
    id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan', company_name: null,
    email: 'taylor@example.com', phone: '+19415550101', profile_label: 'Primary',
    address_line1: '123 Main St', city: 'Bradenton', state: 'FL', zip: '34211',
    waveguard_tier: 'Gold', monthly_rate: '89.00', member_since: '2026-05-20',
    active: true, billing_mode: 'monthly_membership', ...overrides,
  };
}

// The customer turned "Email Messages" off in the portal (Settings), which
// routes/notifications.js:355 stores as notification_prefs.email_enabled=false.
const OPTED_OUT_PREFS = { customer_id: 'cust-1', email_enabled: false, request_channel: 'email' };

describe('r1-comms-side-effects-2: lifecycle emails honour the portal email opt-out', () => {
  beforeEach(() => { jest.clearAllMocks(); tablesRead.length = 0; });

  test('membership.updated (admin rate typo fix) is NOT emailed to an opted-out customer', async () => {
    setDbQueues({
      customers: [
        chain({ first: customer() }), // sendMembershipUpdated loadCustomer
        chain({ first: customer() }), // sendTemplate loadCustomer
      ],
      // Unlimited prefs reads available — the code under test should read one.
      notification_prefs: Array.from({ length: 4 }, () => chain({ first: OPTED_OUT_PREFS })),
      customer_interactions: [chain(), chain()],
    });

    const result = await AccountMembershipEmail.sendMembershipUpdated({
      customerId: 'cust-1',
      before: { waveguard_tier: 'Gold', monthly_rate: 89 },
      after: { waveguard_tier: 'Gold', monthly_rate: 98 },
    });

    // Expected: the sender consulted notification_prefs and skipped.
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(tablesRead).toContain('notification_prefs');
    expect(result).toMatchObject({ ok: false, skipped: true });
  });

  test('membership.canceled ("Account deactivated") is NOT emailed to an opted-out customer', async () => {
    setDbQueues({
      customers: [chain({ first: customer() }), chain({ first: customer() })],
      notification_prefs: Array.from({ length: 4 }, () => chain({ first: OPTED_OUT_PREFS })),
      customer_interactions: [chain(), chain()],
    });

    await AccountMembershipEmail.sendMembershipCanceled({
      customerId: 'cust-1', reason: 'Account deactivated', membershipTier: 'Gold', monthlyRate: 89,
    });

    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(tablesRead).toContain('notification_prefs');
  });

  test('account.request_updated (staff triage status flip) is NOT emailed to an opted-out customer', async () => {
    setDbQueues({
      customers: [chain({ first: customer() }), chain({ first: customer() })],
      // request-app-notifications also reads notification_prefs (request_channel) — allow several reads.
      notification_prefs: Array.from({ length: 4 }, () => chain({ first: OPTED_OUT_PREFS })),
      customer_interactions: [chain(), chain()],
    });

    await AccountMembershipEmail.sendRequestUpdated({
      customerId: 'cust-1',
      request: {
        id: 'req-1', customer_id: 'cust-1', subject: 'Ants in kitchen', description: 'Seeing ants',
        category: 'pest_issue', source: 'portal', status: 'acknowledged', updated_at: '2026-09-23T12:00:00.000Z',
      },
      statusLabel: 'Acknowledged',
    });

    // Let the fire-and-forget push notification settle before asserting.
    await new Promise((r) => setTimeout(r, 20));
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });
});
