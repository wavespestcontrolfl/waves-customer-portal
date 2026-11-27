/**
 * StripeService.syncStripeCustomerEmail (owner 11-27, "add both"): a customer's changed email is copied onto the linked
 * Stripe customer, read at sync time so a later edit wins. Synthetic data only; no network.
 */
describe('syncStripeCustomerEmail', () => {
  function load(row, { sharedWith = null } = {}) {
    jest.resetModules();
    const update = jest.fn(async () => ({}));
    const stripeClient = { customers: { update } };
    const events = [];
    const trx = jest.fn(() => ({
      where: (cond) => ({
        first: jest.fn(async () => { events.push('read'); return row; }),
        // The shared-profile check: another customer row on the same Stripe id.
        whereNot: () => ({ first: jest.fn(async () => (cond.stripe_customer_id && sharedWith ? { id: sharedWith } : null)) }),
      }),
    }));
    trx.raw = jest.fn(async (sql, args) => { events.push(`lock:${args[0]}`); });
    const db = jest.fn();
    db.transaction = jest.fn(async (fn) => fn(trx));
    jest.doMock('../models/db', () => db);
    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', publishableKey: 'pk_test_mock' }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    return { StripeService: require('../services/stripe'), update, events, trx };
  }

  test('updates the linked Stripe customer with the email on file now, read inside the per-customer lock', async () => {
    const { StripeService, update, events, trx } = load({ id: 'c1', email: ' new@example.test ', stripe_customer_id: 'cus_1' });
    await expect(StripeService.syncStripeCustomerEmail('c1')).resolves.toBe('updated');
    expect(update).toHaveBeenCalledWith('cus_1', { email: 'new@example.test' });
    expect(trx.raw.mock.calls[0][0]).toMatch(/pg_advisory_xact_lock/);
    expect(events).toEqual(['lock:stripe-customer-email:c1', 'read']);
  });

  test('never changes a Stripe customer another customer row also links to', async () => {
    const { StripeService, update } = load({ id: 'c1', email: 'new@example.test', stripe_customer_id: 'cus_1' }, { sharedWith: 'c2' });
    await expect(StripeService.syncStripeCustomerEmail('c1')).resolves.toBe('shared');
    expect(update).not.toHaveBeenCalled();
  });

  test('a caller transaction runs the lock on that same handle', async () => {
    const { StripeService, trx, update } = load({ id: 'c1', email: 'new@example.test', stripe_customer_id: 'cus_1' });
    trx.isTransaction = true;
    const dbMod = require('../models/db');
    await expect(StripeService.syncStripeCustomerEmail('c1', { database: trx })).resolves.toBe('updated');
    expect(dbMod.transaction).not.toHaveBeenCalled();
    expect(trx.raw).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('cus_1', { email: 'new@example.test' });
  });

  test('does nothing for a customer with no Stripe customer or no email', async () => {
    const a = load({ id: 'c1', email: 'x@example.test', stripe_customer_id: null });
    await expect(a.StripeService.syncStripeCustomerEmail('c1')).resolves.toBe('not_linked');
    expect(a.update).not.toHaveBeenCalled();
    const b = load({ id: 'c1', email: '', stripe_customer_id: 'cus_1' });
    await expect(b.StripeService.syncStripeCustomerEmail('c1')).resolves.toBe('no_email');
    expect(b.update).not.toHaveBeenCalled();
  });

  test('a Stripe failure throws to the caller (which logs it after commit)', async () => {
    const { StripeService, update } = load({ id: 'c1', email: 'new@example.test', stripe_customer_id: 'cus_1' });
    update.mockRejectedValue(new Error('stripe down'));
    await expect(StripeService.syncStripeCustomerEmail('c1')).rejects.toThrow('stripe down');
  });
});
