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

test('greetingName greets a former address with a neutral name, not the current first name', async () => {
  await Email.sendAccountUpdated({
    customerId: 'c1', actorCustomerId: 'c1', alwaysNotify: true, changedItems: [{ key: 'email', label: 'Email address' }],
    contactOverride: { email: 'old@example.test', name: '' }, greetingName: 'there', idempotencyKey: 'k-old2',
  });
  expect(mockSendTemplate.mock.calls[0][0].payload.first_name).toBe('there');
});

test('without greetingName the greeting is the contact name or the customer first name', async () => {
  await Email.sendAccountUpdated({ customerId: 'c1', actorCustomerId: 'c1', alwaysNotify: true, changedItems: items });
  expect(mockSendTemplate.mock.calls[0][0].payload.first_name).toBe('Pat');
});

// A send failure's message can carry the recipient address (a provider body, or a failed insert's bound values), and the
// sender logged and returned it. The profile edit asks for the code only; every other caller keeps the message.
describe('suppressProviderErrorLog', () => {
  const logger = require('../services/logger');
  const leak = () => Object.assign(new Error('insert into "email_messages" ("to_email") values (\'old@example.test\') - connection lost'), { code: '08006' });
  const send = (extra) => Email.sendAccountUpdated({
    customerId: 'c1', actorCustomerId: 'c1', alwaysNotify: true, changedItems: [{ key: 'profile', label: 'Account profile' }],
    contactOverride: { email: 'old@example.test', name: '' }, idempotencyKey: 'k-safe', ...extra,
  });
  beforeEach(() => logger.error.mockClear());

  test('on: the library is told to keep the provider body out of the log, and a failure is logged and returned by its code', async () => {
    mockSendTemplate.mockRejectedValueOnce(leak());
    const res = await send({ suppressProviderErrorLog: true });
    expect(mockSendTemplate.mock.calls[0][0].suppressProviderErrorLog).toBe(true);
    expect(res).toEqual({ ok: false, error: '08006' });
    const logged = logger.error.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('08006');
    expect(logged).not.toContain('old@example.test');
  });

  test('off (the default): unchanged, the message is logged and returned', async () => {
    mockSendTemplate.mockRejectedValueOnce(leak());
    const res = await send();
    expect(mockSendTemplate.mock.calls[0][0].suppressProviderErrorLog).toBe(false);
    expect(res.error).toContain('connection lost');
  });
});

test('bypassEmailOptOut skips notification_prefs.email_enabled opt-out for takeover security alerts', async () => {
  jest.resetModules();
  jest.doMock('../models/db', () => (table) => {
    const c = new Proxy(function f() {}, {
      get(_t, prop) {
        if (prop === 'first') {
          return jest.fn(async () => (table === 'notification_prefs' ? { email_enabled: false } : mockCustomer));
        }
        if (prop === 'insert') return jest.fn(async () => []);
        if (prop === 'then') return undefined;
        return jest.fn(() => c);
      },
    });
    return c;
  });
  jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
  const localSendTemplate = jest.fn(async () => ({ sent: true, message: { provider_message_id: 'm2', sent_at: 'now' } }));
  jest.doMock('../services/email-template-library', () => ({ sendTemplate: (...a) => localSendTemplate(...a) }));
  const FreshEmail = require('../services/account-membership-email');

  const blocked = await FreshEmail.sendAccountUpdated({
    customerId: 'c1',
    actorCustomerId: 'c1',
    alwaysNotify: true,
    changedItems: [{ key: 'profile', label: 'Account profile' }],
  });
  expect(blocked).toMatchObject({ ok: false, skipped: true, reason: 'email_opted_out' });
  expect(localSendTemplate).not.toHaveBeenCalled();

  const sent = await FreshEmail.sendAccountUpdated({
    customerId: 'c1',
    actorCustomerId: 'c1',
    alwaysNotify: true,
    bypassEmailOptOut: true,
    changedItems: [{ key: 'profile', label: 'Account profile' }],
  });
  expect(sent.ok).toBe(true);
  expect(localSendTemplate).toHaveBeenCalledTimes(1);
});
