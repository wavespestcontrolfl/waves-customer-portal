// Verifies the Intelligence Bar `update_customer` tool keeps an address edit
// consistent with the Customers route (PUT /:id): the primary customer_properties
// row is synced ATOMICALLY (a unique-index collision rolls back with a clear
// error) and the customer is re-geocoded so the map pin / dispatch drive-time use
// the new location. A plain `customers` update used to leave both stale — the bug
// behind "I updated the address but it still shows the old one."

jest.mock('../models/db', () => {
  const qb = {};
  qb.where = jest.fn(() => qb);
  qb.whereIn = jest.fn(() => qb);
  qb.forUpdate = jest.fn(() => qb);
  qb.first = jest.fn();
  qb.update = jest.fn(() => Promise.resolve(1));
  const db = jest.fn(() => qb);
  // trx behaves like db() — the executor only uses trx('customers').where().update()
  db.transaction = jest.fn(async (cb) => cb(db));
  db.__qb = qb;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-properties', () => ({
  syncPrimaryAddress: jest.fn(() => Promise.resolve()),
  syncPrimaryCoordsFromCustomer: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/customer-address-fanout', () => ({
  propagateCustomerAddressChange: jest.fn(() => Promise.resolve({ leads: 0, estimates: 0 })),
}));
jest.mock('../services/geocoder', () => ({
  ensureCustomerGeocoded: jest.fn(() => Promise.resolve({ latitude: 27.1, longitude: -82.4 })),
}));

const db = require('../models/db');
const customerProperties = require('../services/customer-properties');
const addressFanout = require('../services/customer-address-fanout');
const geocoder = require('../services/geocoder');
const { executeTool } = require('../services/intelligence-bar/tools');

const CUSTOMER_ID = 'cust-1';
const baseRow = {
  id: CUSTOMER_ID, first_name: 'Jenny', last_name: 'Miguel',
  address_line1: '123 Old Street', city: 'Bradenton', state: 'FL', zip: '34205',
  pipeline_stage: 'new_lead', member_since: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  db.transaction.mockImplementation(async (cb) => cb(db));
});

test('an address change syncs the primary property atomically and re-geocodes', async () => {
  db.__qb.first
    .mockResolvedValueOnce(baseRow) // before (pre-transaction read)
    .mockResolvedValueOnce(baseRow) // locked in-transaction read (FOR UPDATE)
    .mockResolvedValueOnce({ ...baseRow, address_line1: '9136 93rd Run E', city: 'Parrish', zip: '34219' }); // after

  const result = await executeTool('update_customer', {
    customer_id: CUSTOMER_ID,
    updates: { address_line1: '9136 93rd Run E', city: 'Parrish', zip: '34219' },
  });

  expect(result.success).toBe(true);
  // property mirror + lead/estimate snapshot fan-out synced inside the transaction
  expect(db.transaction).toHaveBeenCalledTimes(1);
  expect(customerProperties.syncPrimaryAddress).toHaveBeenCalledTimes(1);
  expect(addressFanout.propagateCustomerAddressChange).toHaveBeenCalledTimes(1);
  expect(addressFanout.propagateCustomerAddressChange).toHaveBeenCalledWith(
    expect.objectContaining({
      before: expect.objectContaining({ address_line1: '123 Old Street' }),
      after: expect.objectContaining({ address_line1: '9136 93rd Run E' }),
    }),
    expect.anything(),
  );
  // coords cleared, then a re-geocode kicked off
  expect(db.__qb.update).toHaveBeenCalledWith(expect.objectContaining({ latitude: null, longitude: null }));
  expect(geocoder.ensureCustomerGeocoded).toHaveBeenCalledWith(CUSTOMER_ID);
});

test('a colliding address rolls back and returns a clear error, no geocode', async () => {
  db.__qb.first.mockResolvedValueOnce(baseRow); // before
  const dup = new Error('duplicate key'); dup.code = '23505';
  customerProperties.syncPrimaryAddress.mockRejectedValueOnce(dup);

  const result = await executeTool('update_customer', {
    customer_id: CUSTOMER_ID,
    updates: { address_line1: '9136 93rd Run E', city: 'Parrish', zip: '34219' },
  });

  expect(result).toEqual({ error: 'That address already exists as another property on this customer.' });
  expect(geocoder.ensureCustomerGeocoded).not.toHaveBeenCalled();
});

test('resubmitting the same address still syncs + re-geocodes (self-heals a stale row)', async () => {
  // customers.address_* already equals the submitted value (a prior pre-fix IB edit
  // updated the text but skipped the mirror/geocode). A diff-vs-customer-row check
  // would skip the heal; presence-based must still run sync + geocode.
  db.__qb.first
    .mockResolvedValueOnce(baseRow) // before — address already matches what we submit
    .mockResolvedValueOnce(baseRow) // locked in-transaction read
    .mockResolvedValueOnce(baseRow); // after

  const result = await executeTool('update_customer', {
    customer_id: CUSTOMER_ID,
    updates: { address_line1: '123 Old Street', city: 'Bradenton', state: 'FL', zip: '34205' },
  });

  expect(result.success).toBe(true);
  expect(customerProperties.syncPrimaryAddress).toHaveBeenCalledTimes(1);
  expect(geocoder.ensureCustomerGeocoded).toHaveBeenCalledWith(CUSTOMER_ID);
});

test('a non-address change does not touch the property mirror or geocoder', async () => {
  db.__qb.first
    .mockResolvedValueOnce(baseRow) // before
    .mockResolvedValueOnce(baseRow) // locked in-transaction read
    .mockResolvedValueOnce({ ...baseRow, crm_notes: 'gate code 1234' }); // after

  const result = await executeTool('update_customer', {
    customer_id: CUSTOMER_ID,
    updates: { notes: 'gate code 1234' },
  });

  expect(result.success).toBe(true);
  expect(customerProperties.syncPrimaryAddress).not.toHaveBeenCalled();
  expect(addressFanout.propagateCustomerAddressChange).not.toHaveBeenCalled();
  expect(geocoder.ensureCustomerGeocoded).not.toHaveBeenCalled();
});

test('a bulk ADDRESS edit takes the per-row path: mirror + fan-out + re-geocode per row', async () => {
  const rowA = { ...baseRow, id: 'cust-a' };
  const rowB = { ...baseRow, id: 'cust-b' };
  db.__qb.first
    .mockResolvedValueOnce(rowA) // before (cust-a)
    .mockResolvedValueOnce(rowA) // locked read (cust-a)
    .mockResolvedValueOnce(rowB) // before (cust-b)
    .mockResolvedValueOnce(rowB); // locked read (cust-b)

  const result = await executeTool('bulk_update_customers', {
    customer_ids: ['cust-a', 'cust-b'],
    updates: { address_line1: '9136 93rd Run E', city: 'Parrish', zip: '34219' },
  });

  expect(result.success).toBe(true);
  expect(result.updated_count).toBe(2);
  // one transaction per row, each with the mirror + snapshot fan-out
  expect(db.transaction).toHaveBeenCalledTimes(2);
  expect(customerProperties.syncPrimaryAddress).toHaveBeenCalledTimes(2);
  expect(addressFanout.propagateCustomerAddressChange).toHaveBeenCalledTimes(2);
  // stale coords cleared, re-geocode kicked off for each row
  expect(db.__qb.update).toHaveBeenCalledWith(expect.objectContaining({ latitude: null, longitude: null }));
  expect(geocoder.ensureCustomerGeocoded).toHaveBeenCalledWith('cust-a');
  expect(geocoder.ensureCustomerGeocoded).toHaveBeenCalledWith('cust-b');
});

test('a bulk NON-address edit keeps the single-statement path', async () => {
  const result = await executeTool('bulk_update_customers', {
    customer_ids: ['cust-a', 'cust-b'],
    updates: { waveguard_tier: 'gold' },
  });

  expect(result.success).toBe(true);
  expect(db.transaction).not.toHaveBeenCalled();
  expect(customerProperties.syncPrimaryAddress).not.toHaveBeenCalled();
  expect(addressFanout.propagateCustomerAddressChange).not.toHaveBeenCalled();
  expect(geocoder.ensureCustomerGeocoded).not.toHaveBeenCalled();
});
