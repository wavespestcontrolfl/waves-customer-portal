jest.mock('../models/db', () => require('knex')({ client: 'pg' }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));

const db = require('../models/db');
const router = require('../routes/admin-triage');
const list = router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.get).route.stack[0].handle;
const customerId = '11111111-1111-4111-8111-111111111111';

async function listQuery(query) {
  const statements = [];
  const runner = jest.spyOn(db.client, 'runner').mockImplementation((builder) => ({
    run: async () => {
      statements.push(builder.toSQL());
      return [];
    },
  }));
  const response = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  try {
    await list({ query, techRole: 'admin' }, response);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({ items: [], counts: { open: 0, in_progress: 0, resolved: 0, dismissed: 0 } });
    return statements[0];
  } finally {
    runner.mockRestore();
  }
}

test('address-only lookup filters in SQL before the default inbox limit', async () => {
  const { sql, bindings } = await listQuery({ status: 'active', customer_id: customerId, address_confirmation: 'true' });
  expect(sql).toContain('"triage_items"."reason_code" in (');
  expect(sql.indexOf('"triage_items"."reason_code" in (')).toBeLessThan(sql.indexOf(' limit '));
  expect(bindings).toEqual([
    'open', 'in_progress', customerId,
    'missing_unit_number', 'address_unverified', 'missing_service_address',
    'low_confidence_address', 'address_validation_unavailable', 'address_unverifiable',
    'address_not_validated', 'on_file_proof_customer_mismatch', 'address_recovered', 'address_readback', 100,
  ]);
});

test.each([undefined, 'false'])('ordinary triage listing keeps all reasons when filter is %s', async (flag) => {
  const { sql, bindings } = await listQuery({ status: 'active', customer_id: customerId, address_confirmation: flag });
  expect(sql).not.toContain('"triage_items"."reason_code" in (');
  expect(bindings).toEqual(['open', 'in_progress', customerId, 100]);
});
