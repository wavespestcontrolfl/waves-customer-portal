// sendBulkDocument sends only the audience staff reviewed. The send recomputes
// the audience from its request, so it carries the sendable count staff
// confirmed on the preview (expectedSendable) and refuses a request without
// one, or one whose recount differs, before any document is created or any
// text is sent.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/document-contract-delivery', () => ({ deliverDocumentRequestChannels: jest.fn() }));

const mockState = { audience: [], writes: [], tables: [] };
const GUIDE_ROW = {
  id: 't1',
  template_key: 'marketing.pest_products_safety',
  name: 'Pest Products Guide',
  category: 'marketing',
  document_type: 'customer_guide',
  requires_signature: false,
  status: 'active',
  active_version__id: 'v1',
  active_version__title: 'Pest Products Guide',
  active_version__body: 'Hello {{customer.name}}',
};
jest.mock('../models/db', () => {
  const builder = (table) => {
    const b = {};
    const chain = () => b;
    for (const m of [
      'whereNot', 'leftJoin', 'where', 'whereNull', 'whereIn', 'whereNotIn', 'whereRaw', 'orWhereRaw', 'whereExists',
      'whereNotExists', 'orWhereIn', 'whereILike', 'orWhereILike', 'select', 'groupBy', 'orderByRaw', 'orderBy', 'limit',
      'countDistinct', 'clone', 'forUpdate',
    ]) b[m] = jest.fn(chain);
    b.first = jest.fn(async () => (table.startsWith('document_templates') ? GUIDE_ROW : { count: mockState.audience.length }));
    b.then = (resolve, reject) => Promise.resolve(table.startsWith('customers') ? mockState.audience : []).then(resolve, reject);
    b.insert = jest.fn(async (row) => { mockState.writes.push({ table, row }); return [{ id: 'new' }]; });
    b.update = jest.fn(async (row) => { mockState.writes.push({ table, row }); return 1; });
    return b;
  };
  const fn = jest.fn((table) => { mockState.tables.push(table); return builder(table); });
  fn.raw = jest.fn((sql) => sql);
  fn.schema = { hasTable: jest.fn(async () => false) };
  fn.transaction = jest.fn(async (cb) => cb(fn));
  return fn;
});

const { deliverDocumentRequestChannels } = require('../services/document-contract-delivery');
const { sendBulkDocument } = require('../services/document-template-bulk-send');

// Opted in to seasonal tips with a phone: sendable by SMS.
const optedIn = (id) => ({ id, first_name: `Customer ${id}`, phone: '+19415550100', sms_enabled: true, seasonal_tips: true });
const REQUEST = { audience: 'all', guideType: 'pest', channel: 'sms', skipRecentDays: 0 };
const req = { technicianId: 'admin-1', ip: '127.0.0.1', get: () => 'jest' };

beforeEach(() => {
  jest.clearAllMocks();
  mockState.audience = [];
  mockState.writes = [];
  mockState.tables = [];
});

test('a send without the confirmed count is refused before anything is read or written', async () => {
  await expect(sendBulkDocument(GUIDE_ROW.template_key, REQUEST, req)).rejects.toMatchObject({ status: 400, code: 'BULK_PREVIEW_REQUIRED' });
  await expect(sendBulkDocument(GUIDE_ROW.template_key, { ...REQUEST, expectedSendable: '2' }, req)).rejects.toMatchObject({ status: 400, code: 'BULK_PREVIEW_REQUIRED' });
  expect(mockState.tables).toEqual([]);
});

test('a recount that differs from the confirmed count (another audience) is refused before any document or text', async () => {
  mockState.audience = [1, 2, 3, 4, 5].map((n) => optedIn(`c${n}`));
  await expect(sendBulkDocument(GUIDE_ROW.template_key, { ...REQUEST, expectedSendable: 2 }, req)).rejects.toMatchObject({
    status: 409,
    code: 'BULK_AUDIENCE_CHANGED',
    message: 'The audience changed after the preview: 5 customers can get this guide now, not 2. Run Preview again.',
  });
  expect(mockState.writes).toEqual([]);
  expect(deliverDocumentRequestChannels).not.toHaveBeenCalled();
});

test('a recount that matches the confirmed count goes ahead', async () => {
  // Not opted in to seasonal tips: nobody is sendable, and the confirmed count is 0.
  mockState.audience = [{ ...optedIn('c1'), seasonal_tips: false }];
  const result = await sendBulkDocument(GUIDE_ROW.template_key, { ...REQUEST, expectedSendable: 0 }, req);
  expect(result.summary).toMatchObject({ loaded: 1, attempted: 0, skippedMissingContact: 1 });
  expect(deliverDocumentRequestChannels).not.toHaveBeenCalled();
});
