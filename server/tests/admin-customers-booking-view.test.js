// GET /api/admin/customers/:id?view=booking (owner 2026-11-01): Dispatch "Book it" needs only the
// New appointment form's customer box. The full profile reads ~28 sources (4.5 s on a real tap);
// this view reads the customer row and nothing else, with the same values the full profile gives
// those fields. All identities are synthetic.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockTables = [];
const CUSTOMER = {
  id: 'cust-1', first_name: 'Pat', last_name: 'Sample', phone: '+19415550100', email: 'pat@example.test',
  address_line1: '12 Test Lane', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34205',
  waveguard_tier: 'Gold', monthly_rate: '89.00', deleted_at: null,
};
jest.mock('../models/db', () => jest.fn((table) => {
  mockTables.push(table);
  const q = {};
  q.where = jest.fn(() => q);
  q.whereNull = jest.fn(() => q);
  q.first = jest.fn(async () => (table === 'customers' ? CUSTOMER : undefined));
  return q;
}));

const router = require('../routes/admin-customers');

const layer = router.stack.find((l) => l.route?.path === '/:id' && l.route.methods.get);
const handler = layer.route.stack.at(-1).handle;

const call = async (query) => {
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await handler({ params: { id: 'cust-1' }, query, techRole: 'admin' }, res, next);
  return { res, next };
};

beforeEach(() => { mockTables.length = 0; });

test('view=booking answers the form fields from the customer row alone', async () => {
  const { res, next } = await call({ view: 'booking' });
  expect(next).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith({
    customer: {
      id: 'cust-1', firstName: 'Pat', lastName: 'Sample', phone: '+19415550100',
      address: { line1: '12 Test Lane', line2: null, city: 'Bradenton', state: 'FL', zip: '34205' },
      tier: 'Gold',
    },
  });
  expect(mockTables).toEqual(['customers']);
});

test('a missing customer is still a 404', async () => {
  const db = require('../models/db');
  db.mockImplementationOnce((table) => {
    mockTables.push(table);
    const q = {};
    q.where = jest.fn(() => q);
    q.whereNull = jest.fn(() => q);
    q.first = jest.fn(async () => undefined);
    return q;
  });
  const { res } = await call({ view: 'booking' });
  expect(res.status).toHaveBeenCalledWith(404);
  expect(res.json).toHaveBeenCalledWith({ error: 'Customer not found' });
});
