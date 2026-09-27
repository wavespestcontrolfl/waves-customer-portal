// The pre-visit balance email is a billing email: its recipient, the
// customer's billing choice and the portal-wide switch come from the shared
// billing email authority (owner ruling 2026-09-27), read when the sweep
// resolves the email leg and again under the authority's locks at the
// provider handoff. The authority's own locks, rechecks and suppression reads
// are pinned in billing-channel-email-authority.test.js and the Postgres
// suite; here it authorizes the billing recipient, and a test overrides it to
// refuse at the first read or at the handoff.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({
    sent: true,
    message: { provider_message_id: 'sg-1', status: 'sent', sent_at: '2026-09-27T14:05:00.000Z' },
  })),
}));
jest.mock('../services/billing-channel-email-authority', () => ({
  loadBillingEmailContext: jest.fn(),
  dispatchUnderBillingEmailAuthority: jest.fn(),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const BillingEmailAuthority = require('../services/billing-channel-email-authority');
const AccountMembershipEmail = require('../services/account-membership-email');

function chain({ first } = {}) {
  const q = {};
  ['where', 'select'].forEach((method) => { q[method] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.insert = jest.fn(async () => [1]);
  return q;
}

const customer = {
  id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan', email: 'taylor@example.com',
  phone: '+19415550101', address_line1: '123 Main St', city: 'Bradenton', state: 'FL', zip: '34211',
};
const authorityInput = { customerId: 'cust-1', channel: 'email', metadata: { billingDeliveryCategory: 'billing' } };
const reminder = {
  customerId: 'cust-1',
  amount: '$96.60',
  serviceType: 'Quarterly Pest Control',
  visitDate: 'Tuesday, September 29',
  billingUrl: 'https://portal.wavespestcontrol.com/?tab=billing',
  idempotencyKey: 'billing.previsit_balance:visit-1',
};

let interactions;
beforeEach(() => {
  jest.clearAllMocks();
  interactions = [];
  // No notification_prefs read here: the portal-wide switch and the billing
  // choice are the authority's to read for a billing email.
  db.mockImplementation((table) => {
    if (table === 'customers') return chain({ first: customer });
    if (table === 'customer_interactions') {
      const q = chain();
      interactions.push(q);
      return q;
    }
    throw new Error(`Unexpected db table ${table}`);
  });
  BillingEmailAuthority.loadBillingEmailContext.mockReset().mockResolvedValue({
    category: 'billing',
    recipient: { email: 'Billing@Example.com', name: 'Jordan Morgan' },
    recipientEmail: 'billing@example.com',
  });
  BillingEmailAuthority.dispatchUnderBillingEmailAuthority.mockReset()
    .mockImplementation(async ({ dispatch, state }) => {
      state.handoffStarted = true;
      await dispatch('authority-trx');
      state.providerAccepted = true;
      return { ok: true };
    });
});

describe('pre-visit balance email through the shared billing email authority', () => {
  test('goes to the authority\'s billing recipient and dispatches under its locked recheck', async () => {
    const dispatch = jest.fn();
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      const handoff = await withProviderHandoff(dispatch);
      return { sent: handoff.ok, message: { provider_message_id: 'sg-1', status: 'sent' } };
    });

    const result = await AccountMembershipEmail.sendPrevisitBalanceReminder(reminder);

    expect(result).toMatchObject({ ok: true, messageId: 'sg-1' });
    expect(BillingEmailAuthority.loadBillingEmailContext).toHaveBeenCalledWith(authorityInput);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'billing.previsit_balance',
      to: 'billing@example.com',
      idempotencyKey: 'billing.previsit_balance:visit-1',
      payload: expect.objectContaining({ first_name: 'Jordan', amount: '$96.60', visit_date: 'Tuesday, September 29' }),
    }));
    expect(BillingEmailAuthority.dispatchUnderBillingEmailAuthority).toHaveBeenCalledWith(expect.objectContaining({
      input: authorityInput,
      recipientEmail: 'billing@example.com',
      templateKey: 'billing.previsit_balance',
    }));
    expect(dispatch).toHaveBeenCalledWith('authority-trx');
  });

  test.each([
    ['an explicit billing choice without Email', 'BILLING_PREFERENCES_CHANGED',
      { ok: false, retryable: true, deliveryOutcome: 'not_sent', reason: 'BILLING_PREFERENCES_CHANGED' }],
    ['no billing address', 'NO_EMAIL_RECIPIENT', { ok: false, skipped: true, reason: 'missing_email' }],
  ])('%s at the first read is no email leg and sends nothing', async (_label, code, expected) => {
    BillingEmailAuthority.loadBillingEmailContext.mockResolvedValue({ error: { code, reason: code } });

    const leg = await AccountMembershipEmail.resolvePrevisitBalanceEmailRecipient('cust-1');
    const result = await AccountMembershipEmail.sendPrevisitBalanceReminder(reminder);

    expect(leg.recipient).toBeNull();
    expect(result).toEqual(expected);
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('an unreadable billing context is no email leg this run, and a retryable no-send', async () => {
    BillingEmailAuthority.loadBillingEmailContext.mockRejectedValue(new Error('connection reset'));

    const leg = await AccountMembershipEmail.resolvePrevisitBalanceEmailRecipient('cust-1');
    const result = await AccountMembershipEmail.sendPrevisitBalanceReminder(reminder);

    expect(leg).toMatchObject({ recipient: null, reason: 'billing_email_context_unavailable' });
    expect(result).toEqual({
      ok: false, retryable: true, deliveryOutcome: 'not_sent', reason: 'billing_email_context_unavailable',
    });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test.each([
    ['provider acceptance survives a later throw', () => { throw Object.assign(new Error('audit write failed'), {
      providerOutcome: { deliveryOutcome: 'accepted' },
    }); }, { ok: true }, 'sent'],
    ['a throw after the handoff started stays uncertain', () => { throw new Error('provider response lost'); },
      { ok: false, error: 'provider response lost', deliveryOutcome: 'uncertain' }, 'failed'],
  ])('%s', async (_label, providerCall, expected, loggedStatus) => {
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) =>
      withProviderHandoff(async () => providerCall()));

    const result = await AccountMembershipEmail.sendPrevisitBalanceReminder(reminder);

    expect(result).toEqual(expected);
    expect(JSON.parse(interactions[0].insert.mock.calls[0][0].metadata)).toMatchObject({ status: loggedStatus });
  });

  test('a throw before the handoff began is definitely not sent', async () => {
    EmailTemplates.sendTemplate.mockRejectedValueOnce(new Error('template read unavailable'));

    const result = await AccountMembershipEmail.sendPrevisitBalanceReminder(reminder);

    expect(result).toEqual({ ok: false, error: 'template read unavailable', deliveryOutcome: 'not_sent' });
    expect(BillingEmailAuthority.dispatchUnderBillingEmailAuthority).not.toHaveBeenCalled();
  });

  test('a staff do-not-contact at the provider handoff is refused, logged and reported as a suppression', async () => {
    BillingEmailAuthority.dispatchUnderBillingEmailAuthority.mockImplementationOnce(async ({ state }) => {
      state.boundaryBlock = { code: 'SUPPRESSED_MANUAL_DNC', reason: 'manual_dnc' };
      return { ok: false };
    });
    const dispatch = jest.fn();
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      await withProviderHandoff(dispatch);
      return { sent: false, aborted: true, reason: 'aborted_by_caller_before_dispatch' };
    });

    const result = await AccountMembershipEmail.sendPrevisitBalanceReminder(reminder);

    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, blocked: true, reason: 'Suppressed: manual_dnc' });
    expect(interactions).toHaveLength(1);
    expect(JSON.parse(interactions[0].insert.mock.calls[0][0].metadata)).toMatchObject({
      status: 'blocked', failure_reason: 'Suppressed: manual_dnc',
    });
  });
});
