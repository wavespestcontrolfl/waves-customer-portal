// Owner 2026-10-03 ("narrow"): a technician's restock list carries the
// product, stock and request state, never the vendor, its order link or the
// customer another technician's job-card request came from.
const ROW = {
  id: 'r1', product_id: 'p1', product_name: 'Test Concentrate', product_category: 'insecticide',
  status: 'open', priority: 'normal', requested_quantity: 2, unit: 'bottle',
  vendor: 'Sample Vendor', best_vendor: 'Sample Vendor',
  metadata: { vendorSku: 'SKU-1', vendorProductUrl: 'https://vendor.example/p/1' },
  first_name: 'Test', last_name: 'Customer', address_line1: '1 Example St', city: 'Sampletown',
  source: 'job_card', created_at: '2026-10-03T00:00:00Z',
};

jest.mock('../models/db', () => {
  const chain = {};
  ['leftJoin', 'select', 'orderByRaw', 'orderBy', 'limit', 'where', 'whereIn'].forEach((m) => { chain[m] = jest.fn(() => chain); });
  chain.modify = jest.fn((fn) => { fn(chain); return chain; });
  chain.then = (resolve, reject) => Promise.resolve([global.__restockRow]).then(resolve, reject);
  const db = jest.fn(() => chain);
  db.schema = { hasTable: jest.fn(async (t) => t === 'product_restock_requests') };
  return db;
});

const { listRestockRequests } = require('../services/inventory-restock-queue');

describe('restock list office detail', () => {
  beforeEach(() => { global.__restockRow = { ...ROW }; });
  afterAll(() => { delete global.__restockRow; });

  test('a technician list has no vendor, order link or customer', async () => {
    const { requests } = await listRestockRequests({ status: 'open', officeDetail: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      productName: 'Test Concentrate', status: 'open', requestedQuantity: 2,
      vendor: null, vendorSku: null, vendorProductUrl: null, customerName: null, address: null, city: null,
    });
  });

  test('the office list keeps them (default)', async () => {
    const { requests } = await listRestockRequests({ status: 'open' });
    expect(requests[0]).toMatchObject({
      vendor: 'Sample Vendor', vendorSku: 'SKU-1', vendorProductUrl: 'https://vendor.example/p/1',
      customerName: 'Test Customer', address: '1 Example St', city: 'Sampletown',
    });
  });
});
