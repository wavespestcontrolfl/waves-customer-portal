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
    let limitN = null;
    let offsetN = 0;
    for (const m of ['select', 'where', 'whereNull', 'whereExists', 'havingRaw', 'orderByRaw', 'clone']) {
      builder[m] = () => builder;
    }
    builder.limit = (n) => { limitN = n; return builder; };
    builder.offset = (n) => { offsetN = n; state.pages = (state.pages || 0) + 1; return builder; };
    builder.then = (resolve, reject) => Promise.resolve(
      state.rows.slice(offsetN, offsetN + (limitN ?? state.rows.length)).map((r) => ({ ...r })),
    ).then(resolve, reject);
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

test('not-yet-due longer-cadence rows cannot crowd an overdue 6-week customer out of the limit', async () => {
  // Rows arrive oldest-first, as the SQL orders them (codex P2 r12 on #4786).
  db.__state.rows = [
    row('quarterly-a', 'Quarterly Tree & Shrub Care Service', 80),
    row('quarterly-b', 'Quarterly Tree & Shrub Care Service', 79),
    row('six-week-due', 'Every 6 Weeks Tree & Shrub Care Service', 45),
  ];
  const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub', limit: 2 });
  expect(result.overdue_customers.map((c) => c.id)).toEqual(['six-week-due']);
});

test('the active recurring plan beats completed history (plan switch)', async () => {
  db.__state.rows = [
    // Quarterly history, now on the 9x plan: due at 42 days, not 90.
    { ...row('switched-to-9x', 'Quarterly Tree & Shrub Care Service', 50), active_plan_service_type: 'Every 6 Weeks Tree & Shrub Care Service' },
    // 9x history, now on bi-monthly: not due until 60.
    { ...row('switched-to-6x', 'Every 6 Weeks Tree & Shrub Care Service', 50), active_plan_service_type: 'Bi-Monthly Tree & Shrub Care Service' },
  ];
  const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  expect(result.overdue_customers.map((c) => [c.id, c.expected_frequency_days])).toEqual([['switched-to-9x', 42]]);
});

test('the plan\'s catalog key beats a generic "Tree & Shrub" label (codex r15)', async () => {
  db.__state.rows = [
    { ...row('engine-9x', 'Tree & Shrub', 45), active_plan_service_type: 'Tree & Shrub', active_plan_service_key: 'tree_shrub_6week' },
    { ...row('engine-6x', 'Tree & Shrub', 45), active_plan_service_type: 'Tree & Shrub', active_plan_service_key: 'tree_shrub_program' },
  ];
  const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  expect(result.overdue_customers.map((c) => [c.id, c.expected_frequency_days])).toEqual([['engine-9x', 42]]);
});

test('an add-on-line plan key drives the cadence the same way (codex r16)', async () => {
  // The SQL resolves active_plan_service_key across primary AND add-on lines;
  // here the combined visit's generic label would otherwise default to 60.
  db.__state.rows = [
    { ...row('addon-quarterly', 'Pest + Tree & Shrub', 70), active_plan_service_type: 'Pest + Tree & Shrub', active_plan_service_key: 'tree_shrub_quarterly' },
  ];
  const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  expect(result.overdue_customers).toEqual([]);
});

test('other categories keep their fixed interval', async () => {
  db.__state.rows = [{ ...row('pest', 'Quarterly Pest Control Service', 100) }];
  const result = await executeTool('find_overdue_customers', { service_category: 'pest' });
  expect(result.overdue_customers.map((c) => c.expected_frequency_days)).toEqual([90]);
});

test('a one_time T&S add-on line is not the customer\'s active plan (codex r18)', async () => {
  // The harness returns rows, so pin the SQL the add-on branch of the
  // active-plan subquery is built with: the one add-on-line predicate the
  // write gate and the picker read.
  const seen = [];
  const original = db.raw;
  db.raw = (sql, ...rest) => { seen.push(String(sql)); return original(sql, ...rest); };
  try {
    db.__state.rows = [];
    await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  } finally {
    db.raw = original;
  }
  const { ADDON_LINE_IS_PLAN_SQL } = require('../services/service-library');
  const planSql = seen.find((sql) => /as active_plan_service_key/.test(sql));
  expect(planSql).toBeDefined();
  expect(planSql).toContain('FROM scheduled_service_addons');
  expect(planSql).toContain(ADDON_LINE_IS_PLAN_SQL);
});

test('every prefiltered T&S row is paged through before the limit applies (codex r19)', async () => {
  // 1,200 older not-yet-due quarterly customers sort ahead of one genuinely
  // overdue 6-week customer with a newer last visit: a SQL cap of any size
  // would drop them; paging must reach the last page.
  db.__state.rows = [
    ...Array.from({ length: 1200 }, (_, i) => row(`quarterly-${i}`, 'Quarterly Tree & Shrub Care Service', 85 - (i % 10))),
    row('six-week-due', 'Every 6 Weeks Tree & Shrub Care Service', 44),
  ];
  db.__state.pages = 0;
  const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub', limit: 5 });
  expect(result.overdue_customers.map((c) => c.id)).toEqual(['six-week-due']);
  expect(result.total_found).toBe(1);
  expect(db.__state.pages).toBe(3);
});

test('other categories still read one page at the requested limit', async () => {
  db.__state.rows = Array.from({ length: 30 }, (_, i) => row(`pest-${i}`, 'Quarterly Pest Control Service', 100 + i));
  db.__state.pages = 0;
  const result = await executeTool('find_overdue_customers', { service_category: 'pest', limit: 10 });
  expect(result.overdue_customers).toHaveLength(10);
  expect(db.__state.pages).toBe(1);
});
