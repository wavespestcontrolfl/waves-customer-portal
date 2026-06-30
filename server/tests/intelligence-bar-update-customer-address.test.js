// Verifies the Intelligence Bar `update_customer` tool keeps an address edit
// consistent with the Customers route (PUT /:id): the primary customer_properties
// row is synced ATOMICALLY (a unique-index collision rolls back with a clear
// error) and the customer is re-geocoded so the map pin / dispatch drive-time use
// the new location. A plain `customers` update used to leave both stale — the bug
// behind "I updated the address but it still shows the old one."

jest.mock('../models/db', () => {
  const qb = {};
  qb.where = jest.fn(() => qb);
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
jest.mock('../services/geocoder', () => ({
  ensureCustomerGeocoded: jest.fn(() => Promise.resolve({ latitude: 27.1, longitude: -82.4 })),
}));

const db = require('../models/db');
const customerProperties = require('../services/customer-properties');
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
    .mockResolvedValueOnce(baseRow) // before
    .mockResolvedValueOnce({ ...baseRow, address_line1: '9136 93rd Run E', city: 'Parrish', zip: '34219' }); // after

  const result = await executeTool('update_customer', {
    customer_id: CUSTOMER_ID,
    updates: { address_line1: '9136 93rd Run E', city: 'Parrish', zip: '34219' },
  });

  expect(result.success).toBe(true);
  // property mirror synced inside the transaction
  expect(db.transaction).toHaveBeenCalledTimes(1);
  expect(customerProperties.syncPrimaryAddress).toHaveBeenCalledTimes(1);
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

test('a non-address change does not touch the property mirror or geocoder', async () => {
  db.__qb.first
    .mockResolvedValueOnce(baseRow) // before
    .mockResolvedValueOnce({ ...baseRow, crm_notes: 'gate code 1234' }); // after

  const result = await executeTool('update_customer', {
    customer_id: CUSTOMER_ID,
    updates: { notes: 'gate code 1234' },
  });

  expect(result.success).toBe(true);
  expect(customerProperties.syncPrimaryAddress).not.toHaveBeenCalled();
  expect(geocoder.ensureCustomerGeocoded).not.toHaveBeenCalled();
});
