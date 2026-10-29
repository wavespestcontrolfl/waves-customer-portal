// listPortalServiceHistory's completedOnly option: GET /api/services and the
// assistant's recent-visits read filter to status 'completed' and one record
// per appointment, before the limit and in the total.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/context-aggregator', () => ({ customerSafeVisitNotes: jest.fn(() => null) }));
jest.mock('../services/account-properties', () => ({ applyPropertyPredicate: jest.fn((q) => q) }));

const db = require('../models/db');
const { listPortalServiceHistory } = require('../services/portal-service-history');

function wire() {
  const builders = [];
  db.mockImplementation((table) => {
    const b = { table };
    for (const m of ['where', 'leftJoin', 'select', 'orderBy', 'limit', 'offset', 'count', 'whereRaw']) b[m] = jest.fn(() => b);
    b.first = jest.fn(async () => ({ count: '0' }));
    b.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    builders.push(b);
    return b;
  });
  db.raw = jest.fn((sql) => sql);
  return builders;
}

const statusFilters = (builders) => builders
  .filter((b) => b.table === 'service_records')
  .map((b) => b.where.mock.calls.filter(([col, val]) => col === 'service_records.status' && val === 'completed').length);

beforeEach(() => jest.clearAllMocks());

const siblingFilters = (builders) => builders
  .filter((b) => b.table === 'service_records')
  .map((b) => b.whereRaw.mock.calls.filter(([sql]) => /sib\.scheduled_service_id = service_records\.scheduled_service_id/.test(sql)).length);

test('completedOnly filters the list and the total to completed records, one per appointment', async () => {
  const builders = wire();
  await listPortalServiceHistory('cust-1', { limit: 3, completedOnly: true });
  expect(statusFilters(builders)).toEqual([1, 1]);
  expect(siblingFilters(builders)).toEqual([1, 1]);
});

test('without completedOnly every record is listed', async () => {
  const builders = wire();
  await listPortalServiceHistory('cust-1', { limit: 20 });
  expect(statusFilters(builders)).toEqual([0, 0]);
  expect(siblingFilters(builders)).toEqual([0, 0]);
});

test('GET /api/services asks for completed visits only', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '../routes/services.js'), 'utf8');
  expect(source).toMatch(/listPortalServiceHistory\(req\.customerId, \{\s*limit, offset, type, scope, completedOnly: true,/);
});
