// owner 2026-11-26: a ledger row never rolls a visit back. n/p/k_applied_per_1000 are NUMERIC(8,4) (9999.9999 at most), so a rate
// the column cannot hold is skipped with a warning instead of reaching the insert.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const logger = require('../services/logger');
const { recordServiceProductNutrients } = require('../services/nutrient-ledger');

const product = { id: 'p-1', name: 'Fert 20-0-0', analysis_n: 20, analysis_p: 0, analysis_k: 0 };
const run = async ({ amount, sqft }) => {
  const inserts = [];
  const trx = () => ({ insert: (row) => ({ returning: async () => { inserts.push(row); return [row]; } }) });
  const row = await recordServiceProductNutrients(trx, {
    customerId: 'c-1', turfProfile: { id: 't-1', lawn_sqft: sqft }, serviceRecord: { id: 'r-1', service_date: '2026-11-26' },
    serviceProduct: { id: 'sp-1', total_amount: amount, amount_unit: 'lb' }, product, applicationDate: '2026-11-26',
  });
  return { row, inserts };
};

test('50,000 lb of a 20% N product on 1,000 sq ft (10,000 lb N per 1,000) writes no row and warns', async () => {
  const { row, inserts } = await run({ amount: 50000, sqft: 1000 });
  expect(row).toBeNull();
  expect(inserts).toEqual([]);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('too large to store'));
});

test('a small recorded lawn area cannot overflow it either: 50 lb on 1 sq ft', async () => {
  expect((await run({ amount: 50, sqft: 1 })).inserts).toEqual([]);
});

test('the largest storable rate still records, and an ordinary rate is unchanged', async () => {
  expect((await run({ amount: 4999.99995, sqft: 1000 })).inserts).toHaveLength(1); // 999.99999 rounds to 1000.0000
  const ordinary = await run({ amount: 5, sqft: 1000 });
  expect(ordinary.inserts).toHaveLength(1);
  expect(ordinary.inserts[0].n_applied_per_1000).toBe(1);
});
