// Operations audit OP-15: fleet YTD and the mileage default year follow the ET
// business year. On Dec 31 at 10 PM ET the server's UTC clock is already in
// the new year; the totals must still be this year's. The old bug shows only
// on a UTC clock (production, CI); on an Eastern machine run with TZ=UTC.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const calls = [];
  const builder = (table) => new Proxy({}, {
    get(_t, name) {
      if (name === 'then') return (resolve) => resolve([]);
      if (name === 'first') return async () => ({ count: '0', total: '0', total_miles: '0', business_miles: '0', total_fuel: '0', total_gallons: '0', total_irs_deduction: '0' });
      return (...args) => { calls.push([table, name, args]); return builder(table); };
    },
  });
  const db = jest.fn((table) => builder(table));
  db.raw = jest.fn((sql) => sql);
  db.fn = { now: () => 'now()' };
  db.calls = calls;
  return db;
});

const db = require('../models/db');
const { getFleetOverview } = require('../services/equipment-maintenance');

afterEach(() => { jest.useRealTimers(); db.calls.length = 0; });

test.each([
  ['10 PM ET on Dec 31 (already Jan 1 in UTC)', '2027-01-01T03:00:00Z', '2026-01-01'],
  ['12:01 AM ET on Jan 1', '2027-01-01T05:01:00Z', '2027-01-01'],
])('YTD starts at the ET year: %s', async (_label, now, yearStart) => {
  jest.useFakeTimers({ now: new Date(now) });
  await getFleetOverview();
  const ytd = db.calls.filter(([table, name, args]) => name === 'where' && ['maintenance_records', 'vehicle_mileage_log'].includes(table) && args[1] === '>=');
  expect(ytd.map(([table, , args]) => [table, args[0], args[2]])).toEqual([
    ['maintenance_records', 'performed_at', yearStart],
    ['vehicle_mileage_log', 'log_date', yearStart],
  ]);
});
