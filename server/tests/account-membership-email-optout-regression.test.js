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
// The lock's transaction reads through the same table-queue db mock.
jest.mock('../utils/customer-comms-lock', () => ({
  withCustomerCommsLock: jest.fn(async (database, _customerId, fn) => fn(database)),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const { withCustomerCommsLock } = require('../utils/customer-comms-lock');
const AccountMembershipEmail = require('../services/account-membership-email');

function chain({ result = [], first } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNotNull', 'whereNotIn', 'whereNull', 'select', 'orderBy', 'forUpdate'].forEach((m) => { q[m] = jest.fn(() => q); });
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

// Codex round-2 P2 follow-up: a genuine opt-out and a TRANSIENT prefs lookup
// failure must not collapse to the same {skipped:true} shape. Several
// callers treat `skipped` as a definitive recipient state that closes the
// run without retrying (cancellation-confirmations.js's emailBlocked check,
// deferred-replay-registry.js's `skipped !== true` retry gate) — reporting a
// DB blip that way would settle those callers as "nothing more to do"
// instead of retrying, so a customer whose other channel also failed would
// get NO confirmation at all over one brief hiccup.
describe('account-membership-email distinguishes a transient prefs failure from a real opt-out', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('a notification_prefs lookup error fails closed (no send) but reports a non-skipped, transient failure', async () => {
    const tablesRead = [];
    db.mockImplementation((table) => {
      tablesRead.push(table);
      if (table === 'notification_prefs') {
        return { where: () => ({ first: () => Promise.reject(new Error('connection terminated')) }) };
      }
      return chain({ first: customer() });
    });

    const result = await AccountMembershipEmail.sendMembershipUpdated({
      customerId: 'cust-1',
      before: { waveguard_tier: 'Gold', monthly_rate: '89.00', billing_mode: 'monthly_membership' },
      after: { waveguard_tier: 'Gold', monthly_rate: '98.00', billing_mode: 'monthly_membership' },
    });

    expect(tablesRead).toContain('notification_prefs');
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    // Not sent, and NOT reported as `skipped` — the shape a genuine opt-out
    // uses and that downstream callers treat as final.
    expect(result).toMatchObject({ ok: false, sent: false, transient: true, reason: 'prefs_unavailable' });
    expect(result.skipped).not.toBe(true);
  });
});

// Owner ruling 2026-09-26: payment emails cannot be turned off. A billing.*
// notice sent through this family's sendTemplate ignores the portal-wide
// email switch that still silences membership.* / account.* mail above.
// Where billing goes stays the customer's choice: an explicit billing channel
// selection without Email means no pre-visit balance email, and the choice
// and the billing recipient are rechecked at the provider handoff.
describe('billing notices ignore the portal-wide email switch', () => {
  let dispatched;
  beforeEach(() => {
    jest.clearAllMocks();
    dispatched = false;
    // The library runs the caller's handoff the way runProviderHandoff does:
    // dispatch inside it sends; a refusal or a throw before dispatch aborts
    // the queued attempt.
    EmailTemplates.sendTemplate.mockImplementation(async ({ withProviderHandoff }) => {
      try {
        await withProviderHandoff(async () => { dispatched = true; });
      } catch { /* a throw before dispatch aborts */ }
      return dispatched
        ? { sent: true, message: { provider_message_id: 'sg-123', status: 'sent', sent_at: '2026-09-22T12:00:00.000Z' } }
        : { sent: false, aborted: true, reason: 'aborted_by_caller_before_dispatch' };
    });
  });

  // First notification_prefs read = the recipient resolver, second = the
  // locked re-read at the provider handoff. Third customers read = the
  // handoff's locked recipient row. An Error stands in for a failed read.
  const prefsRead = (prefs) => {
    if (!(prefs instanceof Error)) return chain({ first: prefs });
    const q = chain();
    q.first = jest.fn(async () => { throw prefs; });
    return q;
  };
  function previsitDb(prefs, handoffPrefs = prefs, handoffCustomer = customer()) {
    const handoff = { customers: chain({ first: handoffCustomer }), prefs: prefsRead(handoffPrefs) };
    const queues = {
      customers: [chain({ first: customer() }), chain({ first: customer() }), handoff.customers],
      customer_interactions: [chain(), chain(), chain()],
      notification_prefs: [prefsRead(prefs), handoff.prefs],
    };
    db.mockImplementation((table) => {
      const q = queues[table];
      if (!q || !q.length) throw new Error(`Unexpected db table ${table}`);
      return q.shift();
    });
    return handoff;
  }

  const sendPrevisit = () => AccountMembershipEmail.sendPrevisitBalanceReminder({
    customerId: 'cust-1',
    amount: '$129.00',
    serviceType: 'Pest Control',
    visitDate: 'Tuesday, October 6',
    billingUrl: 'https://portal.example/pay',
    idempotencyKey: 'previsit:cust-1:2026-10-06',
  });

  test.each([
    { customer_id: 'cust-1', email_enabled: false },
    { customer_id: 'cust-1', email_enabled: false, billing_channels: ['email', 'sms'] },
  ])('billing.previsit_balance is emailed with the email switch off: %j', async (prefs) => {
    const handoff = previsitDb(prefs);
    const result = await sendPrevisit();
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ templateKey: 'billing.previsit_balance' }));
    expect(withCustomerCommsLock).toHaveBeenCalledWith(db, 'cust-1', expect.any(Function));
    // Both recipient rows are locked through dispatch, customer first (the
    // billing-channel email authority's order).
    expect(handoff.customers.forUpdate).toHaveBeenCalled();
    expect(handoff.prefs.forUpdate).toHaveBeenCalled();
    expect(handoff.customers.forUpdate.mock.invocationCallOrder[0])
      .toBeLessThan(handoff.prefs.forUpdate.mock.invocationCallOrder[0]);
    expect(dispatched).toBe(true);
    expect(result).toMatchObject({ ok: true, messageId: 'sg-123' });
  });

  test.each([
    { customer_id: 'cust-1', email_enabled: false, billing_channels: ['sms'] },
    { customer_id: 'cust-1', email_enabled: true, billing_channels: ['push'] },
  ])('a billing channel choice without Email gets no pre-visit balance email: %j', async (prefs) => {
    previsitDb(prefs);
    await expect(AccountMembershipEmail.resolvePrevisitBalanceEmailRecipient('cust-1'))
      .resolves.toEqual({ recipient: null, reason: 'billing_email_not_selected' });
    previsitDb(prefs);
    const result = await sendPrevisit();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, skipped: true, reason: 'billing_email_not_selected' });
  });

  test('an unreadable billing channel choice fails closed as a retryable no-send', async () => {
    previsitDb(new Error('db down'));
    await expect(AccountMembershipEmail.resolvePrevisitBalanceEmailRecipient('cust-1'))
      .resolves.toEqual({ recipient: null, reason: 'prefs_unavailable', transient: true });
    previsitDb(new Error('db down'));
    const result = await sendPrevisit();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, sent: false, transient: true, reason: 'prefs_unavailable' });
  });

  test('a Text-only change saved after the recipient was resolved stops the email at the provider handoff', async () => {
    previsitDb(
      { customer_id: 'cust-1', billing_channels: ['email', 'sms'] },
      { customer_id: 'cust-1', billing_channels: ['sms'] },
    );
    const result = await sendPrevisit();
    expect(withCustomerCommsLock).toHaveBeenCalledWith(db, 'cust-1', expect.any(Function));
    expect(dispatched).toBe(false);
    expect(result).toEqual({ ok: false, skipped: true, reason: 'billing_email_not_selected' });
  });

  test('a billing address saved after the recipient was resolved stops the email at the handoff, retryably', async () => {
    const prefs = { customer_id: 'cust-1', billing_channels: ['email', 'sms'] };
    previsitDb(prefs, prefs, customer({ email: 'new-billing@example.com' }));
    const result = await sendPrevisit();
    expect(dispatched).toBe(false);
    expect(result).toEqual({ ok: false, sent: false, transient: true, reason: 'billing_recipient_changed' });
  });

  test('a customer deleted after the recipient was resolved gets no email', async () => {
    const prefs = { customer_id: 'cust-1', billing_channels: ['email'] };
    previsitDb(prefs, prefs, customer({ deleted_at: '2026-09-26T12:00:00.000Z' }));
    const result = await sendPrevisit();
    expect(dispatched).toBe(false);
    expect(result).toEqual({ ok: false, skipped: true, reason: 'customer_not_found' });
  });

  test('an unreadable choice at the handoff fails closed as a retryable no-send', async () => {
    previsitDb({ customer_id: 'cust-1', billing_channels: ['email'] }, new Error('db down'));
    const result = await sendPrevisit();
    expect(dispatched).toBe(false);
    expect(result).toEqual({ ok: false, sent: false, transient: true, reason: 'billing_email_recheck_failed' });
  });
});
