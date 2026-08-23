/**
 * relinkSubscribersFromArchivedCustomer — archive-time move of the
 * subscriber↔customer link onto the live same-email twin.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/newsletter-sunset', () => ({ REENGAGEMENT_TAG: 'reengagement_due' }));

const { relinkSubscribersFromArchivedCustomer } = require('../services/newsletter-subscribers');
const { whereLiveCustomer, CUSTOMER_STAGES } = require('../services/customer-stages');

function fakeTrx({ twin }) {
  const customers = {};
  ['whereRaw', 'whereNot', 'orderByRaw', 'where', 'whereNull', 'whereIn', 'modify'].forEach((m) => { customers[m] = jest.fn(() => customers); });
  customers.modify = jest.fn((fn) => { fn(customers); return customers; });
  customers.first = jest.fn(async () => twin);
  const subs = { where: jest.fn(() => subs), update: jest.fn(async () => (twin ? 2 : 0)) };
  const trx = jest.fn((table) => (table === 'customers' ? customers : subs));
  trx.fn = { now: () => 'NOW()' };
  return { trx, customers, subs };
}

describe('relinkSubscribersFromArchivedCustomer', () => {
  test('archive with a live twin → subscribers relinked to the twin, canonical scope + deterministic order', async () => {
    const { trx, customers, subs } = fakeTrx({ twin: { id: 'twin-1' } });
    const out = await relinkSubscribersFromArchivedCustomer(trx, 'archived-1');

    expect(out).toEqual({ twinId: 'twin-1', relinked: 2 });
    expect(customers.whereRaw).toHaveBeenCalledWith(
      'LOWER(TRIM(email)) = (SELECT LOWER(TRIM(email)) FROM customers WHERE id = ?)', ['archived-1'],
    );
    expect(customers.whereNot).toHaveBeenCalledWith('id', 'archived-1');
    expect(customers.modify).toHaveBeenCalledWith(whereLiveCustomer);
    // whereLiveCustomer actually ran against the builder (not just passed).
    expect(customers.where).toHaveBeenCalledWith('active', true);
    expect(customers.whereNull).toHaveBeenCalledWith('deleted_at');
    expect(customers.whereIn).toHaveBeenCalledWith('pipeline_stage', CUSTOMER_STAGES);
    expect(customers.orderByRaw).toHaveBeenCalledWith('is_primary_profile DESC NULLS LAST, created_at ASC, id ASC');
    expect(subs.where).toHaveBeenCalledWith({ customer_id: 'archived-1' });
    expect(subs.update).toHaveBeenCalledWith({ customer_id: 'twin-1', updated_at: 'NOW()' });
  });

  test('archive without a live twin → link untouched', async () => {
    const { trx, subs } = fakeTrx({ twin: null });
    const out = await relinkSubscribersFromArchivedCustomer(trx, 'archived-2');
    expect(out).toEqual({ twinId: null, relinked: 0 });
    expect(subs.update).not.toHaveBeenCalled();
  });
});
