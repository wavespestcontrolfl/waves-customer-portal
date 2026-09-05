jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/mrr-breakdown', () => ({ computeMrrBreakdown: async () => ({ total: 0 }) }));
jest.mock('../services/pnl-report', () => ({ VEHICLE_METHODS: [] }));

const db = require('../models/db');
const router = require('../routes/admin-revenue');
const overview = router.stack.find(layer => layer.route?.path === '/overview').route.stack[0].handle;

async function revenueFor(period, date, records) {
  db.mockImplementation(table => {
    let rows = records;
    const query = {
      where(column, operator, value) {
        if (column === 'service_date') {
          rows = rows.filter(row => {
            if (operator === '>=') return row.service_date >= value;
            if (operator === '<=') return row.service_date <= value;
            if (operator === '<') return row.service_date < value;
            throw new Error(`Unexpected comparison: ${operator}`);
          });
        }
        return query;
      },
      leftJoin() { return query; },
      select() { return query; },
      whereNull() { return query; },
      count() { return query; },
      first: async () => ({ count: 0 }),
      then(resolve, reject) {
        if (table !== 'service_records') throw new Error(`Unexpected table: ${table}`);
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return query;
  });
  let body;
  await overview({ query: { period, date } }, { json(value) { body = value; } }, error => { throw error; });
  return body;
}

test.each([
  ['quarter', '2026-09-05', '2026-04-01', '2026-06-30', '2026-07-01', '2026-03-31'],
  ['quarter', '2026-02-10', '2025-10-01', '2025-12-31', '2026-01-01', '2025-09-30'],
  ['month', '2024-03-15', '2024-02-01', '2024-02-29', '2024-03-01', '2024-01-31'],
  ['ytd', '2026-09-05', '2025-01-01', '2025-12-31', '2026-01-01', '2024-12-31'],
])('%s %s compares only the preceding period and excludes the shared boundary', async (period, date, first, last, current, outside) => {
  const records = [
    { service_date: first, revenue: 50 },
    { service_date: last, revenue: 50 },
    { service_date: current, revenue: 200 },
    { service_date: outside, revenue: 1000 },
  ];
  const result = await revenueFor(period, date, records);
  expect(result.topline.totalRevenue).toBe(200);
  expect(result.vsLastPeriod.revenueChange).toBe(100);
});
