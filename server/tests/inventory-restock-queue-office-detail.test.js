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
  order_status: 'placed', order_adapter: 'samplevendor', order_number: 'ORD-1', order_amount_cents: 1234,
};

jest.mock('../models/db', () => {
  const chain = {};
  ['select', 'orderByRaw', 'orderBy', 'limit', 'where', 'whereIn', 'orWhereRaw'].forEach((m) => { chain[m] = jest.fn(() => chain); });
  // Like Postgres: the email_* columns exist only when the query joined vendor_order_emails.
  let joinedEmails = false;
  chain.leftJoin = jest.fn((table) => { if (String(table).startsWith('vendor_order_emails')) joinedEmails = true; return chain; });
  chain.modify = jest.fn((fn) => { fn(chain); return chain; });
  chain.then = (resolve, reject) => {
    const row = joinedEmails ? global.__restockRow : Object.fromEntries(Object.entries(global.__restockRow).filter(([k]) => !k.startsWith('email_')));
    joinedEmails = false;
    return Promise.resolve([row]).then(resolve, reject);
  };
  const db = jest.fn(() => chain);
  db.schema = { hasTable: jest.fn(async () => true) };
  db.raw = jest.fn((sql) => sql);
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
    expect(requests[0].order).toMatchObject({ status: 'placed', adapter: null, externalOrderNumber: null, amountCents: null });
  });

  // GATE_SITEONE_EMAIL_ORDER: the owner's list says whether the tab offers the
  // button and carries a sent (or unconfirmed) email; a technician's list has neither.
  test('the owner list carries the email-order flag and the email; a technician list carries the flag but never the email', async () => {
    global.__restockRow = { ...ROW, email_status: 'sent', email_po: 'WAVES-R1', email_sent_at: '2026-10-27T15:00:00Z', email_packages: 6, email_item_number: '098604', email_ordered_quantity: 350 }; // float8 cast: a number
    delete process.env.GATE_SITEONE_EMAIL_ORDER;
    const off = await listRestockRequests({ status: 'open', showSpend: true });
    expect(off.siteOneEmailOrder).toBe(false);
    process.env.GATE_SITEONE_EMAIL_ORDER = 'true';
    try {
      const owner = await listRestockRequests({ status: 'open', showSpend: true });
      expect(owner.siteOneEmailOrder).toBe(true);
      expect(owner.requests[0].emailOrder).toEqual({ status: 'sent', po: 'WAVES-R1', sentAt: '2026-10-27T15:00:00Z', packages: 6, itemNumber: '098604', orderedQuantity: 350, retryable: false });
      const tech = await listRestockRequests({ status: 'open', officeDetail: false });
      expect(tech.siteOneEmailOrder).toBe(true); // the gate state only; the button is admin-only in the tab
      expect(tech.requests[0].emailOrder).toBeNull();
    } finally { delete process.env.GATE_SITEONE_EMAIL_ORDER; }
  });

  test('a sending email is retryable only when its claim never attempted the send and is stale (Codex #6866 r1 P2)', async () => {
    const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();
    const read = async (row) => {
      global.__restockRow = { ...ROW, email_status: 'sending', email_po: 'WAVES-R1', ...row };
      return (await listRestockRequests({ status: 'open', showSpend: true })).requests[0].emailOrder;
    };
    expect(await read({ email_send_attempted_at: null, email_claimed_at: minutesAgo(11) })).toMatchObject({ status: 'sending', retryable: true });
    expect(await read({ email_send_attempted_at: null, email_claimed_at: minutesAgo(2) })).toMatchObject({ status: 'sending', retryable: false });
    expect(await read({ email_send_attempted_at: minutesAgo(11), email_claimed_at: minutesAgo(11) })).toMatchObject({ status: 'sending', retryable: false });
  });

  test('a failed or pending email row is not shown', async () => {
    global.__restockRow = { ...ROW, email_status: 'failed', email_po: 'WAVES-R1' };
    const { requests } = await listRestockRequests({ status: 'open', showSpend: true });
    expect(requests[0].emailOrder).toBeNull();
  });

  test('the office list keeps them (default)', async () => {
    const { requests } = await listRestockRequests({ status: 'open' });
    expect(requests[0]).toMatchObject({
      vendor: 'Sample Vendor', vendorSku: 'SKU-1', vendorProductUrl: 'https://vendor.example/p/1',
      customerName: 'Test Customer', address: '1 Example St', city: 'Sampletown',
    });
    expect(requests[0].order).toMatchObject({ status: 'placed', adapter: 'samplevendor', externalOrderNumber: 'ORD-1' });
  });
});
