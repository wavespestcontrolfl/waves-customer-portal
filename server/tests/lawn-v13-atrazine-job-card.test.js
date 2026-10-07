// The job card shows the atrazine bag's planned dose only once the catalog row carries a label stamp
// (migration 20261007162000). Same card builder the job card uses; the catalog row is the one the
// migrations write, the plan amount is the 4.0 lb per 1,000 sq ft on a 10,000 sq ft lawn.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = () => ({});
  fn.raw = () => ({});
  fn.schema = { hasTable: async () => true };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/epa-product-label', () => ({ ...jest.requireActual('../services/epa-product-label'), currentEpaSourceStatus: jest.fn() }));

const jobCard = require('../services/job-card');
const feb = require('../models/migrations/20261007160000_lawn_v13_atrazine_feb_option');
const stamp = require('../models/migrations/20261007162000_lawn_v13_atrazine_label_stamp');

const row = (extra) => ({ id: 'atz', name: feb.NAME, rate_unit: feb.PRODUCT.rate_unit, ...extra });
const card = async (product) => (await jobCard._test.buildProductCards({
  facts: { customerId: 'c1', scheduledDate: '2026-02-12' },
  lines: [{ raw: 'x', role: 'conditional', selected: true, product, planMix: { amount: 40, amountUnit: 'lb' } }],
  verdicts: [], packSizes: {},
}))[0];

test('without a label stamp the card withholds the 40 lb; with the migration\'s stamp it keeps it', async () => {
  expect(await card(row({ label_verified_at: null }))).toMatchObject({ planned: null, amountNote: 'Label rate not yet verified — amount withheld' });
  expect(await card(row({ label_verified_at: new Date('2026-10-07T12:00:00Z'), label_verified_by: stamp.VERIFIED_BY })))
    .toMatchObject({ planned: { amount: 40, unit: 'lb' }, amountNote: null });
});
