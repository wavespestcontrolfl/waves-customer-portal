// New-customer status reads COMPLETED visits only: a first visit the tech
// could not finish (an `incomplete` service_records row) must not cost the
// customer the New Customer Special when the real first visit is invoiced.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const DiscountEngine = require('../services/discount-engine');

const NEW_CUSTOMER = {
  id: 'disc-new', discount_key: 'new_customer', name: 'New Customer Special', discount_type: 'fixed_amount', amount: 20,
  is_waveguard_tier_discount: false, promo_code: null, is_auto_apply: true, requires_new_customer: true,
  show_in_invoices: true, show_in_estimates: true, is_stackable: true, stack_group: null, priority: 1,
};

// service_records rows on file; the mock applies the where() filters it is given.
function wire(records) {
  db.mockImplementation((table) => {
    const filters = [];
    const q = {};
    for (const m of ['whereNotIn', 'select', 'whereNull', 'orWhere']) q[m] = jest.fn(() => q);
    q.where = jest.fn((arg) => { if (arg && typeof arg === 'object') filters.push(arg); return q; });
    q.whereRaw = jest.fn((sql) => { if (/COALESCE\(status, 'completed'\) = 'completed'/.test(sql)) filters.push({ status: 'completed' }); return q; });
    q.orderBy = jest.fn(async () => (table === 'discounts' ? [NEW_CUSTOMER] : []));
    q.countDistinct = jest.fn(() => q);
    q.count = jest.fn(() => q);
    q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    q.first = jest.fn(async () => {
      if (table === 'customers') return { id: 'cust-1', active: true };
      if (table === 'service_records') {
        const n = records.filter((r) => filters.every((f) => Object.entries(f).every(([k, v]) => k === 'customer_id' || (r[k] ?? 'completed') === v))).length;
        return { cnt: String(n), count: String(n) };
      }
      return { cnt: '0', count: '0' };
    });
    return q;
  });
}

beforeEach(() => { jest.clearAllMocks(); DiscountEngine.clearCache(); });

test('an earlier incomplete visit keeps the customer new', async () => {
  wire([{ status: 'incomplete' }]);
  const result = await DiscountEngine.calculateDiscounts('cust-1', { subtotal: 149 });
  expect(result.discounts.map((d) => d.discount_key || d.key || d.name)).toEqual(
    expect.arrayContaining([expect.stringMatching(/new_customer|New Customer Special/)]),
  );
});

test('a legacy NULL-status record still ends new-customer status', async () => {
  wire([{ status: null }]);
  const result = await DiscountEngine.calculateDiscounts('cust-1', { subtotal: 149 });
  expect(result.discounts).toEqual([]);
});

test('a completed visit ends new-customer status', async () => {
  wire([{ status: 'completed' }]);
  const result = await DiscountEngine.calculateDiscounts('cust-1', { subtotal: 149 });
  expect(result.discounts).toEqual([]);
});
