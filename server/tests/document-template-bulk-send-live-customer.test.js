// createDocumentRequestForCustomer — one bulk guide, inside the campaign loop.
// The audience row was loaded once, before the loop; the guide and its
// recipient come from the customer row read under the customer lock, so an
// edit committed in between (a corrected name, address or phone) is what the
// snapshot carries. An archived customer is refused with nothing written
// (contracts audit F6).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/document-contract-delivery', () => ({ deliverDocumentRequestChannels: jest.fn() }));

const mockState = { liveCustomer: null, writes: [], customerReads: [] };
jest.mock('../models/db', () => {
  const builder = (table) => {
    const b = { table, filters: [] };
    const chain = () => b;
    for (const m of ['whereIn', 'whereNotIn', 'whereNotNull', 'whereRaw', 'orWhere', 'forUpdate', 'returning']) b[m] = jest.fn(chain);
    b.where = jest.fn((arg) => { if (typeof arg !== 'function') b.filters.push(arg); return b; });
    b.whereNull = jest.fn((column) => { b.filters.push({ whereNull: column }); return b; });
    b.first = jest.fn(async (...columns) => {
      if (table === 'customers') {
        mockState.customerReads.push({ filters: b.filters.slice(), columns, locked: b.forUpdate.mock.calls.length > 0 });
        return mockState.liveCustomer;
      }
      if (table === 'document_templates') return { active_version_id: 'v1', status: 'active', template_key: 'marketing.pest_products_safety' };
      return null; // customer_contracts: no recent guide blocks this one
    });
    b.insert = jest.fn((row) => {
      mockState.writes.push({ table, row });
      return { returning: async () => [{ id: 'new-contract', ...row }] };
    });
    return b;
  };
  const fn = jest.fn((table) => builder(table));
  fn.raw = jest.fn((sql) => sql);
  fn.transaction = jest.fn(async (cb) => cb(fn));
  return fn;
});

const { _internals: { createDocumentRequestForCustomer } } = require('../services/document-template-bulk-send');

const loaded = {
  template: { id: 't1', template_key: 'marketing.pest_products_safety', name: 'Pest Products Guide', requires_signature: false },
  activeVersion: { id: 'v1', title: 'Pest Products Guide', body: 'Hello {{customer.name}} at {{customer.address}}.' },
};
// The audience row, loaded before the loop.
const AUDIENCE_ROW = { id: 'c1', first_name: 'Jordon', last_name: 'Old', phone: '+19415550100', email: 'old@example.invalid', address_line1: '1 Old St', city: 'Bradenton', zip: '34211' };
const args = {
  loaded,
  customer: AUDIENCE_ROW,
  productGuide: { appendix: 'Product notes.', productCount: 1, serviceGroups: [] },
  options: { values: {}, allowUnresolved: false, skipRecentDays: 14, guideType: 'pest', channel: 'sms' },
  req: { technicianId: 'admin-1', ip: '127.0.0.1', get: () => 'jest' },
  campaignId: 'bulk-doc-test',
};

beforeEach(() => {
  mockState.writes = [];
  mockState.customerReads = [];
});

test('the guide and its recipient come from the customer row read under the lock, not the audience row', async () => {
  mockState.liveCustomer = { ...AUDIENCE_ROW, first_name: 'Jordan', last_name: 'Corrected', phone: '+19415550199', address_line1: '2 New Ave' };
  await createDocumentRequestForCustomer(args);

  // One full-row read, locked, of a customer that is not archived.
  expect(mockState.customerReads).toEqual([{ filters: [{ id: 'c1' }, { whereNull: 'deleted_at' }], columns: [], locked: true }]);
  const [{ row }] = mockState.writes.filter((w) => w.table === 'customer_contracts');
  expect(row).toMatchObject({ recipient_name: 'Jordan Corrected', recipient_phone: '+19415550199', recipient_email: 'old@example.invalid' });
  expect(row.contract_text_snapshot).toBe('Hello Jordan Corrected at 2 New Ave, Bradenton FL 34211.\n\nProduct notes.');
  expect(JSON.parse(row.document_variables_snapshot).customer).toMatchObject({ name: 'Jordan Corrected', phone: '+19415550199' });
  expect(row.contract_text_snapshot).not.toContain('Jordon Old');
});

test('an archived customer is refused before anything is written', async () => {
  mockState.liveCustomer = null;
  await expect(createDocumentRequestForCustomer(args)).rejects.toMatchObject({ status: 404, message: 'Customer is no longer available for bulk document send.' });
  expect(mockState.writes).toEqual([]);
});

test('unresolved merge fields are checked on the live render, and still refuse with nothing written', async () => {
  mockState.liveCustomer = { ...AUDIENCE_ROW };
  const unresolved = { ...args, loaded: { ...loaded, activeVersion: { ...loaded.activeVersion, body: 'Starts {{agreement.start_date}}.' } } };
  await expect(createDocumentRequestForCustomer(unresolved)).rejects.toMatchObject({ status: 400, unresolvedVariables: ['agreement.start_date'] });
  expect(mockState.writes).toEqual([]);
});
