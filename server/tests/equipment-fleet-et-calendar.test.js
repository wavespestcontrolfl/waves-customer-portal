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
      // The alert test sets noOpenAlert so the dedupe lookup finds nothing.
      if (name === 'first' && db.firstRows?.[table]) return async () => db.firstRows[table];
      if (name === 'first') return async () => (db.noOpenAlert && table === 'maintenance_alerts' ? undefined : { count: '0', total: '0', total_miles: '0', business_miles: '0', total_fuel: '0', total_gallons: '0', total_irs_deduction: '0' });
      if (name === 'returning') return async () => [calls.filter(([t, n]) => t === table && n === 'insert').at(-1)?.[2][0]];
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
const { getFleetOverview, generateMaintenanceAlert, recordMaintenance } = require('../services/equipment-maintenance');

afterEach(() => { jest.useRealTimers(); db.calls.length = 0; db.noOpenAlert = false; db.firstRows = null; });

// performed_at is a timestamp, so its YTD bound is the instant of midnight ET
// on Jan 1 (05:00 UTC in winter); log_date is a DATE and takes the day.
test.each([
  ['10 PM ET on Dec 31 (already Jan 1 in UTC)', '2027-01-01T03:00:00Z', '2026-01-01', '2026-01-01T05:00:00.000Z'],
  ['12:01 AM ET on Jan 1', '2027-01-01T05:01:00Z', '2027-01-01', '2027-01-01T05:00:00.000Z'],
])('YTD starts at the ET year: %s', async (_label, now, yearStart, etMidnight) => {
  jest.useFakeTimers({ now: new Date(now) });
  await getFleetOverview();
  const ytd = db.calls.filter(([table, name, args]) => name === 'where' && ['maintenance_records', 'vehicle_mileage_log'].includes(table) && args[1] === '>=');
  expect(ytd.map(([table, , args]) => [table, args[0], args[2]])).toEqual([
    ['maintenance_records', 'performed_at', new Date(etMidnight)],
    ['vehicle_mileage_log', 'log_date', yearStart],
  ]);
});

// The next due date counts from today's ET date: at 10:30 PM ET on Oct 30 the
// UTC clock already reads Oct 31, which stored every next due one day late.
test.each([
  [{ interval_days: 30 }, '2026-11-29'],
  [{ interval_months: 1 }, '2026-11-30'],
])('a recorded service sets next due from the ET date: %o', async (interval, nextDue) => {
  jest.useFakeTimers({ now: new Date('2026-10-31T02:30:00Z') });
  db.firstRows = { maintenance_schedules: { id: 'schedule-1', ...interval } };
  await recordMaintenance({ equipmentId: 'equipment-1', scheduleId: 'schedule-1', taskName: 'Oil change' });
  const update = db.calls.find(([table, name]) => table === 'maintenance_schedules' && name === 'update');
  expect(update[2][0].next_due_at).toBe(nextDue);
});

test('a due-date alert names the stored calendar day, not the day before', async () => {
  db.noOpenAlert = true;
  const alert = await generateMaintenanceAlert({
    id: 'schedule-1', equipment_id: 'equipment-1', task_name: 'Oil change', equipment_name: 'Truck 1',
    next_due_at: new Date('2026-10-30T00:00:00Z'), priority: 'normal',
  }, false);
  expect(alert.description).toBe('Due date: 10/30/2026.');
});
