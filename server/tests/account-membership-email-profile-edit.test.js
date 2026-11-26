/**
 * sendAccountUpdated additions for the profile edit (GATE_CUSTOMER_PROFILE_EDIT): alwaysNotify bypasses the
 * self-initiated skip, contactOverride sends to the address the customer just left, and the default stays skipped.
 */
const mockCustomer = { id: 'c1', first_name: 'Pat', last_name: 'Sample', email: 'current@example.test', phone: '9415550100' };
const mockSendTemplate = jest.fn(async () => ({ sent: true, message: { provider_message_id: 'm1', sent_at: 'now' } }));
const mockChain = () => {
  const c = new Proxy(function f() {}, {
    get(_t, prop) {
      if (prop === 'first') return jest.fn(async () => mockCustomer);
      if (prop === 'insert') return jest.fn(async () => []);
      if (prop === 'then') return undefined;
      return jest.fn(() => c);
    },
  });
  return c;
};
jest.mock('../models/db', () => jest.fn(() => mockChain()));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: (...a) => mockSendTemplate(...a) }));

const Email = require('../services/account-membership-email');

const items = [{ key: 'email', label: 'Email address', oldValue: 'old@example.test', newValue: 'current@example.test' }];
beforeEach(() => mockSendTemplate.mockClear());

test('self-initiated edits are still skipped by default', async () => {
  const res = await Email.sendAccountUpdated({ customerId: 'c1', actorCustomerId: 'c1', changedItems: items });
  expect(res).toMatchObject({ skipped: true, reason: 'self_initiated' });
  expect(mockSendTemplate).not.toHaveBeenCalled();
});

test('alwaysNotify sends to the current address', async () => {
  const res = await Email.sendAccountUpdated({ customerId: 'c1', actorCustomerId: 'c1', alwaysNotify: true, changedItems: items });
  expect(res.ok).toBe(true);
  expect(mockSendTemplate.mock.calls[0][0]).toMatchObject({ templateKey: 'account.updated', to: 'current@example.test' });
});

test('contactOverride sends to the old address', async () => {
  await Email.sendAccountUpdated({
    customerId: 'c1', actorCustomerId: 'c1', alwaysNotify: true, changedItems: items,
    contactOverride: { email: 'old@example.test', name: 'Pat' }, idempotencyKey: 'k-old',
  });
  expect(mockSendTemplate.mock.calls[0][0]).toMatchObject({ to: 'old@example.test', idempotencyKey: 'k-old' });
  expect(mockSendTemplate.mock.calls[0][0].payload.changed_items_summary).toBe('Email address: old@example.test to current@example.test');
});
