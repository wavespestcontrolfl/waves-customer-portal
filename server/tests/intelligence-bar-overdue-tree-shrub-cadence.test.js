/**
 * find_overdue_customers — Tree & Shrub runs at each customer's own cadence
 * (codex P2 r11 on #4786): 6x bi-monthly = 60 days, 9x every 6 weeks = 42,
 * grandfathered quarterly = 90. A flat 90 hid every current 6x/9x plan for
 * a month or more past its real due date.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-email-fanout', () => ({ EMAIL_FANOUT_DISCLOSURE: '' }));

jest.mock('../models/db', () => {
  const state = { rows: [] };
  const dbFn = () => {
    const builder = {};
    for (const m of ['select', 'where', 'whereNull', 'whereExists', 'havingRaw', 'orderByRaw', 'limit']) {
      builder[m] = () => builder;
    }
    builder.then = (resolve, reject) => Promise.resolve(state.rows.map((r) => ({ ...r }))).then(resolve, reject);
    return builder;
  };
  dbFn.raw = (sql) => ({ toString: () => sql });
  dbFn.__state = state;
  return dbFn;
});

const db = require('../models/db');
const { executeTool } = require('../services/intelligence-bar/tools');

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().split('T')[0];
const row = (id, serviceType, days) => ({
  id, first_name: id, last_name: '', active: true,
  last_service_date: daysAgo(days), last_service_type: serviceType, next_scheduled: null,
});

test('each T&S customer is judged against their own cadence', async () => {
  db.__state.rows = [
    row('bimonthly-due', 'Bi-Monthly Tree & Shrub Care Service', 65),
    row('bimonthly-not-due', 'Bi-Monthly Tree & Shrub Care Service', 50),
    row('six-week-due', 'Every 6 Weeks Tree & Shrub Care Service', 45),
    row('quarterly-not-due', 'Quarterly Tree & Shrub Care Service', 70),
    row('quarterly-due', 'Quarterly Tree & Shrub Care Service', 95),
  ];
  const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  const byId = Object.fromEntries(result.overdue_customers.map((c) => [c.id, c]));
  expect(Object.keys(byId).sort()).toEqual(['bimonthly-due', 'quarterly-due', 'six-week-due']);
  expect(byId['bimonthly-due'].expected_frequency_days).toBe(60);
  expect(byId['six-week-due'].expected_frequency_days).toBe(42);
  expect(byId['quarterly-due'].expected_frequency_days).toBe(90);
  expect(byId['quarterly-due'].days_overdue).toBe(5);
});

test('other categories keep their fixed interval', async () => {
  db.__state.rows = [{ ...row('pest', 'Quarterly Pest Control Service', 100) }];
  const result = await executeTool('find_overdue_customers', { service_category: 'pest' });
  expect(result.overdue_customers.map((c) => c.expected_frequency_days)).toEqual([90]);
});
