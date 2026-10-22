/**
 * StripeService.ensureStripeCustomer links the new Stripe customer with a guarded
 * compare-and-set. The Stripe call runs outside any lock, so a duplicate merge can
 * retire the customer row, or another request can link a profile, before the
 * link-back write. An unguarded UPDATE wrote the id onto the archived row and
 * payment setup continued on the retired identity.
 */
describe('StripeService.ensureStripeCustomer link-back', () => {
  let stripeClient;
  let logger;

  // A one-row customers table. `beforeLink` runs after the Stripe call and before
  // the link-back write, to play the part of a concurrent merge or request.
  function load({ row, beforeLink = null }) {
    jest.resetModules();
    const state = { row: { id: 'cust-1', first_name: 'Test', last_name: 'Lead', phone: '+19415550100', deleted_at: null, stripe_customer_id: null, ...row } };
    const updates = [];
    const query = () => {
      const q = { _where: {}, _nulls: [] };
      q.where = jest.fn((cond) => { Object.assign(q._where, cond); return q; });
      q.whereNull = jest.fn((col) => { q._nulls.push(col); return q; });
      q.first = jest.fn(async () => (state.row.id === q._where.id ? { ...state.row } : null));
      q.update = jest.fn(async (patch) => {
        if (beforeLink) { const fn = beforeLink; beforeLink = null; fn(state); }
        updates.push({ nulls: [...q._nulls], patch });
        const matches = state.row.id === q._where.id && q._nulls.every((col) => state.row[col] === null || state.row[col] === undefined);
        if (matches) Object.assign(state.row, patch);
        return matches ? 1 : 0;
      });
      return q;
    };
    const database = jest.fn(query);
    stripeClient = { customers: { create: jest.fn(async () => ({ id: 'cus_new' })) } };
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    jest.doMock('../models/db', () => jest.fn());
    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', publishableKey: 'pk_test_mock' }));
    jest.doMock('../services/logger', () => logger);
    const StripeService = require('../services/stripe');
    return { StripeService, database, state, updates };
  }

  test('happy path: creates the Stripe customer and links it with a guarded write', async () => {
    const { StripeService, database, state, updates } = load({ row: {} });
    await expect(StripeService.ensureStripeCustomer('cust-1', { database })).resolves.toBe('cus_new');
    expect(state.row.stripe_customer_id).toBe('cus_new');
    expect(updates).toEqual([{ nulls: ['deleted_at', 'stripe_customer_id'], patch: { stripe_customer_id: 'cus_new' } }]);
  });

  test('already linked: returns it with no Stripe call and no write (fast path unchanged)', async () => {
    const { StripeService, database, updates } = load({ row: { stripe_customer_id: 'cus_existing' } });
    await expect(StripeService.ensureStripeCustomer('cust-1', { database })).resolves.toBe('cus_existing');
    expect(stripeClient.customers.create).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('a profile linked meanwhile wins: that one is returned, the new Stripe customer is left unused and logged by id', async () => {
    const { StripeService, database, state } = load({
      row: {},
      beforeLink: (s) => { s.row.stripe_customer_id = 'cus_other'; },
    });
    await expect(StripeService.ensureStripeCustomer('cust-1', { database })).resolves.toBe('cus_other');
    expect(state.row.stripe_customer_id).toBe('cus_other');
    const warning = logger.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(warning).toContain('cus_new');
    expect(warning).toContain('cus_other');
    expect(warning).not.toContain('Lead');
    expect(warning).not.toContain('+1941');
  });

  test('retired meanwhile (merged): throws CUSTOMER_RETIRED and writes nothing onto the archived row', async () => {
    const { StripeService, database, state } = load({
      row: {},
      beforeLink: (s) => { s.row.deleted_at = new Date(); },
    });
    await expect(StripeService.ensureStripeCustomer('cust-1', { database })).rejects.toMatchObject({
      code: 'CUSTOMER_RETIRED',
      message: 'this customer record was merged — reload and retry',
    });
    expect(state.row.stripe_customer_id).toBeNull();
  });

  test('already retired at the first read: also throws instead of linking', async () => {
    const { StripeService, database, state } = load({ row: { deleted_at: new Date() } });
    await expect(StripeService.ensureStripeCustomer('cust-1', { database })).rejects.toMatchObject({ code: 'CUSTOMER_RETIRED' });
    expect(state.row.stripe_customer_id).toBeNull();
  });

  test('a Stripe failure still surfaces the generic error', async () => {
    const { StripeService, database } = load({ row: {} });
    stripeClient.customers.create.mockRejectedValueOnce(new Error('stripe down'));
    await expect(StripeService.ensureStripeCustomer('cust-1', { database })).rejects.toThrow('Failed to create Stripe customer');
  });
});
