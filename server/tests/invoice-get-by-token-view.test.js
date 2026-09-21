jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.schema = { hasTable: jest.fn(async () => false) };
  return db;
});
jest.mock('../services/invoice-prepay', () => ({
  loadInvoiceAnnualPrepay: jest.fn(async () => null),
  buildPrepayCoverageSummary: jest.fn(),
}));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');

function mockInvoiceReads(initial, afterView, database = db) {
  let row = { ...initial };
  let update = null;
  database.mockImplementation((table) => {
    if (table === 'invoices') {
      const q = {};
      q.where = jest.fn(() => q);
      q.first = jest.fn(async () => ({ ...row }));
      q.update = jest.fn(async (patch) => {
        update = patch;
        row = { ...afterView };
        return 1;
      });
      return q;
    }
    if (table === 'customers') {
      const q = {};
      q.where = jest.fn(() => q);
      q.select = jest.fn(() => q);
      q.first = jest.fn(async () => ({ first_name: 'Pat' }));
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  });
  return { getUpdate: () => update };
}

describe('invoice public-token view', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a concurrent prepaid settlement stays prepaid when a sent invoice records a view', async () => {
    const initial = { id: 'inv-1', token: 'public-token', customer_id: 'cust-1', status: 'sent', total: 150, view_count: 0 };
    const prepaid = { ...initial, status: 'prepaid', total: 101, view_count: 1, viewed_at: new Date() };
    const { getUpdate } = mockInvoiceReads(initial, prepaid);

    const data = await InvoiceService.getByToken(initial.token);

    expect(getUpdate().status.sql).toBe("CASE WHEN status = 'sent' THEN 'viewed' ELSE status END");
    expect(getUpdate().view_count.sql).toBe('COALESCE(view_count, 0) + 1');
    expect(data).toMatchObject({ status: 'prepaid', total: 101, view_count: 1, amount_due: 101 });
  });

  test('the follow-up read does not count another view or change status', async () => {
    const prepaid = { id: 'inv-1', token: 'public-token', customer_id: 'cust-1', status: 'prepaid', total: 101, view_count: 1 };
    const { getUpdate } = mockInvoiceReads(prepaid, prepaid);

    const data = await InvoiceService.getByToken(prepaid.token, { recordView: false });

    expect(getUpdate()).toBeNull();
    expect(data).toMatchObject({ status: 'prepaid', total: 101, view_count: 1 });
  });

  test('a settlement follow-up uses its transaction for every invoice and enrichment read', async () => {
    const prepaid = { id: 'inv-1', token: 'public-token', customer_id: 'cust-1', status: 'prepaid', total: 101, view_count: 1 };
    const transaction = jest.fn();
    transaction.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    transaction.schema = { hasTable: jest.fn(async () => false) };
    transaction.isTransaction = true;
    transaction.transaction = jest.fn(async (callback) => callback(transaction));
    mockInvoiceReads(prepaid, prepaid, transaction);

    const data = await InvoiceService.getByToken(prepaid.token, { recordView: false, database: transaction });

    expect(data).toMatchObject({ status: 'prepaid', total: 101 });
    expect(db).not.toHaveBeenCalled();
    expect(require('../services/invoice-prepay').loadInvoiceAnnualPrepay)
      .toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-1' }), transaction);
  });
});
