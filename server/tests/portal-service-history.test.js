// listPortalServiceHistory's completedOnly option: the assistant's recent
// visits read filters to status 'completed' before the limit and in the
// total; GET /api/services leaves it off and lists every record.
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
    for (const m of ['where', 'leftJoin', 'select', 'orderBy', 'limit', 'offset', 'count']) b[m] = jest.fn(() => b);
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

test('completedOnly filters the list and the total to completed records', async () => {
  const builders = wire();
  await listPortalServiceHistory('cust-1', { limit: 3, completedOnly: true });
  expect(statusFilters(builders)).toEqual([1, 1]);
});

test('the default lists every record, as the Completed tab does', async () => {
  const builders = wire();
  await listPortalServiceHistory('cust-1', { limit: 20 });
  expect(statusFilters(builders)).toEqual([0, 0]);
});
