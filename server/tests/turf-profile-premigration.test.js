// The legacy turf-profile editor must keep working on a deploy that has not
// yet run migration 20260927010000_property_service_areas (dark feature).
const mockCalls = [];
let mockHasColumn = false;
const mockTrx = table => {
  mockCalls.push(table);
  const q = {
    where: () => q, whereRaw: () => q, update: async () => 1,
    first: async () => (table === 'customer_turf_profiles' ? { grass_type: 'bahia', lawn_sqft: 3000 } : null),
    insert: () => q, onConflict: () => q, merge: () => q,
    returning: async () => [{ customer_id: 'cust-1', lawn_sqft: 4500 }],
  };
  return q;
};
mockTrx.raw = sql => sql;
mockTrx.fn = { now: () => new Date() };
mockTrx.schema = { hasColumn: async () => mockHasColumn };

jest.mock('../models/db', () => {
  const db = table => ({ where: () => ({ first: async () => ({ id: 'cust-1' }) }) });
  return db;
});
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (r, s, n) => n(), requireTechOrAdmin: (r, s, n) => n() }));
jest.mock('../services/technician-visit-scope', () => ({ technicianServicesCustomer: async () => true }));
jest.mock('../services/customer-pricing-ai', () => ({ withTurfProfileFence: async (_db, _id, fn) => fn(mockTrx) }));
jest.mock('../services/irrigation-schedule-confirmation', () => ({ COUNTY_CONFIRMED_FIELD: 'county', confirmIrrigationFields: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const router = require('../routes/admin-customer-turf-profile');
const put = router.stack.find(layer => layer.route?.methods.put).route.stack.at(-1).handle;
const write = () => {
  const res = { json: jest.fn() };
  return put({ params: { customerId: 'cust-1' }, body: { lawn_sqft: 4500 }, technicianId: 't1' }, res, err => { throw err; }).then(() => res);
};

beforeEach(() => { mockCalls.length = 0; });

test('a changed lawn_sqft saves without touching customer_properties before the migration', async () => {
  mockHasColumn = false;
  const res = await write();
  expect(res.json).toHaveBeenCalledWith({ profile: expect.objectContaining({ lawn_sqft: 4500 }) });
  expect(mockCalls).not.toContain('customer_properties');
});

test('after the migration the primary lawn review is withdrawn', async () => {
  mockHasColumn = true;
  await write();
  expect(mockCalls).toContain('customer_properties');
});
