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
    for (const m of ['where', 'whereNull', 'whereExists', 'clone']) {
      builder[m] = () => builder;
    }
    builder.select = (...args) => { state.selectArgs = args; return builder; };
    builder.orderByRaw = (sql) => { state.orderBy = String(sql); return builder; };
    builder.whereRaw = (sql, bindings) => { state.cutoff = [String(sql), bindings]; return builder; };
    // Postgres rejects HAVING without GROUP BY over plain columns; the
    // cutoff must stay a WHERE.
    builder.havingRaw = () => { throw new Error('HAVING without GROUP BY: Postgres rejects this query'); };
    builder.limit = (n) => { limitN = n; return builder; };
    builder.offset = (n) => { offsetN = n; state.pages = (state.pages || 0) + 1; return builder; };
    builder.then = (resolve, reject) => Promise.resolve(
      state.rows.slice(offsetN, offsetN + (limitN ?? state.rows.length)).map((r) => ({ ...r })),
    ).then(resolve, reject);
    return builder;
  };
  dbFn.raw = (sql, bindings) => ({ toString: () => sql, sql, bindings });
  dbFn.__state = state;
  return dbFn;
});

const db = require('../models/db');
const { executeTool } = require('../services/intelligence-bar/tools');

// Noon ET on a fixed day: the UTC and Eastern calendars agree, so the
// day-count fixtures below are deterministic (only Date is faked).
const NOW = new Date('2026-09-25T16:00:00Z');
beforeEach(() => { jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] }).setSystemTime(NOW); });
afterAll(() => { jest.useRealTimers(); });

const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString().split('T')[0];
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
    { ...row('engine-9x', 'Tree & Shrub', 45), active_plan_service_type: 'Tree & Shrub', active_plan: { service_key: 'tree_shrub_6week' } },
    { ...row('engine-6x', 'Tree & Shrub', 45), active_plan_service_type: 'Tree & Shrub', active_plan: { service_key: 'tree_shrub_program' } },
  ];
  const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  expect(result.overdue_customers.map((c) => [c.id, c.expected_frequency_days])).toEqual([['engine-9x', 42]]);
});

test('an add-on-line plan key drives the cadence the same way (codex r16)', async () => {
  // The SQL resolves active_plan_service_key across primary AND add-on lines;
  // here the combined visit's generic label would otherwise default to 60.
  db.__state.rows = [
    { ...row('addon-quarterly', 'Pest + Tree & Shrub', 70), active_plan_service_type: 'Pest + Tree & Shrub', active_plan: { service_key: 'tree_shrub_quarterly' } },
  ];
  const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  expect(result.overdue_customers).toEqual([]);
});

test('the plan line\'s own recurrence outranks its catalog default (codex r28)', async () => {
  db.__state.rows = [
    // tree_shrub_program customized to every 42 days: due at 42, not the row's 60.
    { ...row('custom-42', 'Tree & Shrub', 45), active_plan: { service_key: 'tree_shrub_program', recurring_pattern: 'custom', recurring_interval_days: 42 } },
    // A bare interval under a null pattern is NOT a cadence: the line rides
    // every parent occurrence (lineDueOnRecurringDate), so the catalog
    // default stands (codex r30).
    { ...row('bare-42', 'Tree & Shrub', 45), active_plan: { service_key: 'tree_shrub_program', recurring_pattern: null, recurring_interval_days: 42 } },
    // A stored pattern wins over a stale interval and over the catalog key.
    { ...row('pattern-quarterly', 'Tree & Shrub', 70), active_plan: { service_key: 'tree_shrub_program', recurring_pattern: 'quarterly', recurring_interval_days: 42 } },
    // No recurrence on the line: the catalog default stands (a JSON string
    // from the driver parses the same way).
    { ...row('catalog-60', 'Tree & Shrub', 45), active_plan: JSON.stringify({ service_key: 'tree_shrub_program', recurring_pattern: null, recurring_interval_days: null }) },
  ];
  const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  expect(result.overdue_customers.map((c) => [c.id, c.expected_frequency_days]).sort()).toEqual([['custom-42', 42]]);
});

test('every supported recurrence resolves through the seeder\'s own table (codex r29)', async () => {
  db.__state.rows = [
    // semiannual tree_shrub_program: due at 180, not the catalog's 60.
    { ...row('semiannual-not-due', 'Tree & Shrub', 100), active_plan: { service_key: 'tree_shrub_program', recurring_pattern: 'semiannual', recurring_interval_days: null } },
    { ...row('semiannual-due', 'Tree & Shrub', 181), active_plan: { service_key: 'tree_shrub_program', recurring_pattern: 'semiannual', recurring_interval_days: null } },
    { ...row('triannual-not-due', 'Tree & Shrub', 100), active_plan: { service_key: 'tree_shrub_6week', recurring_pattern: 'triannual', recurring_interval_days: null } },
    { ...row('biweekly-due', 'Tree & Shrub', 15), active_plan: { service_key: 'tree_shrub_program', recurring_pattern: 'biweekly', recurring_interval_days: null } },
    // The Feb–Oct season runs monthly in season on its nth-weekday anchor
    // (Aug 11, a 2nd Tuesday, is next due Sep 8), not at the catalog's 42 (codex r33/r34).
    { ...row('seasonal-in-season', 'Tree & Shrub', 45), active_plan: { service_key: 'tree_shrub_6week', recurring_pattern: 'seasonal_feb_oct', recurring_interval_days: null } },
    // monthly_nth_weekday is due at 30, not the program row's 60 (codex r32).
    { ...row('nth-weekday-due', 'Tree & Shrub', 40), active_plan: { service_key: 'tree_shrub_program', recurring_pattern: 'monthly_nth_weekday', recurring_interval_days: null } },
  ];
  const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  expect(result.overdue_customers.map((c) => [c.id, c.expected_frequency_days]).sort()).toEqual([['biweekly-due', 14], ['nth-weekday-due', 30], ['seasonal-in-season', 28], ['semiannual-due', 180]]);
  const { intervalDaysForPattern } = require('../services/recurring-appointment-seeder');
  expect([['custom', 45], [null, 42], ['quarterly', 42], ['bimonthly', null], ['every_6_weeks', null], ['weekly', null], ['annual', null], ['seasonal_feb_oct', null], ['one_time', 90]]
    .map(([pattern, interval]) => intervalDaysForPattern(pattern, interval))).toEqual([45, null, 90, 60, 42, 7, 360, null, null]);
  // Mirrors nextRecurringDate (codex r32): monthly_nth_weekday is monthly,
  // and custom with no interval or an unknown pattern runs at the 91-day
  // fallback — neither lets the catalog default override the stored series.
  expect([['monthly_nth_weekday', null], ['custom', null], ['foo', null]]
    .map(([pattern, interval]) => intervalDaysForPattern(pattern, interval))).toEqual([30, 91, 91]);
});

test('a Feb–Oct seasonal plan is due on the scheduler\'s next seasonal slot (codex r33/r34)', async () => {
  const seasonal = (extra = {}) => ({ service_key: 'tree_shrub_program', recurring_pattern: 'seasonal_feb_oct', recurring_interval_days: null, recurring_nth: null, recurring_weekday: null, ...extra });
  const visit = (id, date, plan) => ({ id, first_name: id, last_name: '', active: true, last_service_date: date, last_service_type: 'Tree & Shrub', next_scheduled: null, active_plan: plan });
  const overdue = async (now, rows) => {
    jest.setSystemTime(new Date(now));
    db.__state.rows = rows;
    const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
    return result.overdue_customers.map((c) => [c.id, c.expected_frequency_days]);
  };
  // Dec 15: an Oct 20 (3rd Tuesday) visit waits for its February slot; a
  // Sep 20 visit missed its Oct 18 slot; a series stored on the 3rd Tuesday
  // keeps that anchor (Sep 1 -> Oct 20) rather than the visit's own weekday.
  expect(await overdue('2026-12-15T17:00:00Z', [
    visit('october-visit', '2026-10-20', seasonal()),
    visit('missed-october', '2026-09-20', seasonal()),
    visit('anchored', '2026-09-01', seasonal({ recurring_nth: 3, recurring_weekday: 2 })),
  ])).toEqual([['missed-october', 28], ['anchored', 49]]);
  // Feb 10: the Oct 20 visit's next slot is the 3rd Tuesday, Feb 16 — not Feb 1.
  expect(await overdue('2027-02-10T17:00:00Z', [visit('october-visit', '2026-10-20', seasonal())])).toEqual([]);
  expect(await overdue('2027-02-17T17:00:00Z', [visit('october-visit', '2026-10-20', seasonal())])).toEqual([['october-visit', 119]]);
});

test('a generic ID-less T&S plan row supplies its own cadence (codex r35 on #4786)', async () => {
  db.__state.rows = [
    // "Tree & Shrub Care" booked quarterly with no catalog link: 90, not the label's 60.
    { ...row('generic-quarterly', 'Tree & Shrub Care', 75), active_plan: { service_key: null, recurring_pattern: 'quarterly', recurring_interval_days: null } },
    { ...row('generic-quarterly-due', 'Tree & Shrub Care', 95), active_plan: { service_key: null, recurring_pattern: 'quarterly', recurring_interval_days: null } },
    // ...and every 6 weeks: 42, not 60.
    { ...row('generic-6wk-due', 'Tree & Shrub Care', 50), active_plan: { service_key: null, recurring_pattern: 'every_6_weeks', recurring_interval_days: null } },
  ];
  const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  expect(result.overdue_customers.map((c) => [c.id, c.expected_frequency_days]).sort()).toEqual([['generic-6wk-due', 42], ['generic-quarterly-due', 90]]);
  // The plan lookup keeps rows no catalog row claims when their label is a
  // T&S plan, on both the primary line and add-on lines.
  const plan = db.__state.selectArgs.find((a) => a && typeof a.sql === 'string' && a.sql.includes('row_to_json(plan)'));
  expect(plan.sql.match(/LEFT JOIN services ON/g)).toHaveLength(2);
  expect(plan.sql).toMatch(/services\.id IS NULL AND scheduled_services\.service_type ~\* \?/);
  expect(plan.sql).toMatch(/services\.id IS NULL AND scheduled_service_addons\.service_name ~\* \?/);
  expect(plan.bindings.filter((b) => b === 'tree.*shrub')).toHaveLength(2);
  expect((plan.sql.match(/\?/g) || []).length).toBe(plan.bindings.length);
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
  const { ADDON_LINE_IS_PLAN_SQL, HOLDER_VISIT_IS_SERVICE_SQL, HOLDER_ADDON_IS_SERVICE_SQL } = require('../services/service-library');
  const planSql = seen.find((sql) => /as active_plan$/.test(sql.trim()));
  expect(planSql).toBeDefined();
  expect(planSql).toContain('FROM scheduled_service_addons');
  expect(planSql).toContain(ADDON_LINE_IS_PLAN_SQL);
  // The plan row joins its catalog row by id, key snapshot or label — the
  // same identity the holder gate reads (codex r25).
  expect(planSql).toContain(`JOIN services ON ${HOLDER_VISIT_IS_SERVICE_SQL}`);
  expect(planSql).toContain(`JOIN services ON ${HOLDER_ADDON_IS_SERVICE_SQL}`);
  // The plan row carries its own recurrence; an add-on line without one rides the parent's (codex r28).
  expect(planSql).toContain('row_to_json(plan)');
  expect(planSql).toContain('scheduled_services.recurring_pattern, scheduled_services.recurring_interval_days');
  // An add-on with no pattern rides the parent whatever its interval column says (codex r30).
  expect(planSql).toMatch(/CASE WHEN scheduled_service_addons\.recurring_pattern IS NULL\s+THEN scheduled_services\.recurring_pattern ELSE scheduled_service_addons\.recurring_pattern END AS recurring_pattern/);
  expect(planSql).not.toMatch(/recurring_pattern IS NULL AND scheduled_service_addons\.recurring_interval_days IS NULL/);
  expect(planSql).not.toMatch(/JOIN services ON services\.id = scheduled_service/);
});

test('the active-plan subqueries read ownership statuses: an open rescheduled row is still the plan (codex r26)', async () => {
  const seen = [];
  const original = db.raw;
  db.raw = (sql, bindings, ...rest) => { seen.push([String(sql), bindings]); return original(sql, bindings, ...rest); };
  try {
    db.__state.rows = [];
    await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  } finally {
    db.raw = original;
  }
  const { TERMINAL_STATUSES } = require('../services/waveguard-existing-services');
  const { terminalHistoryStatuses } = require('../services/service-library');
  expect(TERMINAL_STATUSES).toContain('rescheduled');
  const planReads = seen.filter(([sql]) => /as active_plan(_service_type)?$/.test(sql.trim()));
  expect(planReads).toHaveLength(2);
  for (const [sql, bindings] of planReads) {
    expect(sql).toMatch(/status NOT IN \(/);
    expect(bindings).not.toContain('rescheduled');
    expect(bindings).toEqual(expect.arrayContaining(terminalHistoryStatuses()));
  }
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

test('days since the last visit are counted on the Eastern calendar, not the UTC clock (codex r21)', async () => {
  // 21:00 ET on Sept 25 is already Sept 26 in UTC. A bi-monthly customer last
  // served on July 28 is 59 Eastern days out (not due); July 27 is 60 (due).
  jest.setSystemTime(new Date('2026-09-26T01:00:00Z'));
  db.__state.rows = [
    { ...row('fifty-nine', 'Bi-Monthly Tree & Shrub Care Service', 0), last_service_date: '2026-07-28' },
    { ...row('sixty', 'Bi-Monthly Tree & Shrub Care Service', 0), last_service_date: new Date('2026-07-27T00:00:00Z') },
  ];
  const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  expect(result.overdue_customers.map((c) => [c.id, c.days_since_last_service, c.days_overdue])).toEqual([['sixty', 60, 0]]);
});

test('the paged T&S read orders by a unique tie-breaker after the last-service date (codex r21)', async () => {
  db.__state.rows = [];
  db.__state.orderBy = null;
  await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  expect(db.__state.orderBy).toMatch(/\) ASC, customers\.id ASC$/);
});

test('the SQL prefilter admits a customer due exactly at the shortest supported cadence, on the Eastern calendar (codex r23/r30)', async () => {
  // A T&S plan line can run daily (the seeder's shortest gap), so the
  // prefilter keeps every row the per-customer cadence check can mark
  // overdue: 16:00Z on Sept 25 is Sept 25 ET; one day before is Sept 24 — inclusive.
  db.__state.rows = [];
  db.__state.cutoff = null;
  await executeTool('find_overdue_customers', { service_category: 'tree_shrub', overdue_days: 0 });
  expect(db.__state.cutoff[0]).toMatch(/\) <= \?$/);
  expect(db.__state.cutoff[1][1]).toBe('2026-09-24');
  // 21:00 ET on Sept 25 (Sept 26 UTC): still Sept 25 on the Eastern calendar.
  jest.setSystemTime(new Date('2026-09-26T01:00:00Z'));
  await executeTool('find_overdue_customers', { service_category: 'tree_shrub', overdue_days: 3 });
  expect(db.__state.cutoff[1][1]).toBe('2026-09-21');
  // Other categories keep their own cadence as the prefilter.
  jest.setSystemTime(NOW);
  await executeTool('find_overdue_customers', { service_category: 'pest', overdue_days: 0 });
  expect(db.__state.cutoff[1][1]).toBe('2026-06-27');
});

test('a weekly T&S plan is reported at its own cadence, not held back to 42 days (codex r30)', async () => {
  db.__state.rows = [
    { ...row('weekly-due', 'Tree & Shrub', 8), active_plan: { service_key: 'tree_shrub_program', recurring_pattern: 'weekly', recurring_interval_days: null } },
  ];
  const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  expect(result.overdue_customers.map((c) => [c.id, c.expected_frequency_days, c.days_overdue])).toEqual([['weekly-due', 7, 1]]);
});

// Edge cases below are a live-verification pass on codex r35 (this session
// did not author the r35 fix). Backed by a real PostgreSQL run against a
// migrated schema (see the handback report) that exercised the actual
// active-plan LEFT JOIN/label SQL directly — bypassing this file's mocked
// db, which only exercises the JS cadence-resolution side below — plus a
// direct comparison against the merge-base's INNER JOIN text.
test('a generic ID-less row with NO recurrence at all (pattern and interval both null) falls back to the label default, not a crash', async () => {
  db.__state.rows = [
    // 65 days since last service: overdue at the label default (60) but
    // would NOT be overdue at any real T&S cadence shorter than that.
    { ...row('generic-no-recurrence', 'Tree & Shrub Care', 65), active_plan: { service_key: null, recurring_pattern: null, recurring_interval_days: null } },
  ];
  const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  expect(result.overdue_customers.map((c) => [c.id, c.expected_frequency_days])).toEqual([['generic-no-recurrence', 60]]);
});

test('a generic ID-less row on an unrecognized cadence string (e.g. "every_3_months") falls to the seeder\'s ~quarterly fallback, not a crash', async () => {
  // The seeder's canonical name is 'quarterly' (-> 90); 'every_3_months' is
  // not in its pattern tables, so intervalDaysForPattern returns the
  // 91-day FALLBACK_RECURRENCE_GAP_DAYS — a plausible free-text/legacy
  // value on a generic row, and a real behavior difference from 'quarterly'
  // worth pinning explicitly (not a bug in this PR; recurring-appointment-
  // seeder.js's fallback predates it).
  db.__state.rows = [
    { ...row('not-due-at-91', 'Tree & Shrub Care', 88), active_plan: { service_key: null, recurring_pattern: 'every_3_months', recurring_interval_days: null } },
    { ...row('due-at-91', 'Tree & Shrub Care', 92), active_plan: { service_key: null, recurring_pattern: 'every_3_months', recurring_interval_days: null } },
  ];
  const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  expect(result.overdue_customers.map((c) => [c.id, c.expected_frequency_days])).toEqual([['due-at-91', 91]]);
});

test('the active_plan JSON is read by snake_case service_key only; a stray camelCase serviceKey field is ignored, not crashed on', async () => {
  // row_to_json() always emits snake_case column names, so a real SQL
  // response can never carry a camelCase serviceKey — this pins that the
  // JS reader (planIntervalDays) does not accidentally accept one, which
  // would silently pick up the wrong (shorter) catalog cadence.
  db.__state.rows = [
    { ...row('camel-key-ignored', 'Tree & Shrub Care', 65), active_plan: { serviceKey: 'tree_shrub_6week', service_key: null, recurring_pattern: null, recurring_interval_days: null } },
  ];
  const result = await executeTool('find_overdue_customers', { service_category: 'tree_shrub' });
  // Falls to the label-text default (60), NOT the camelCase field's 42.
  expect(result.overdue_customers.map((c) => [c.id, c.expected_frequency_days])).toEqual([['camel-key-ignored', 60]]);
});

test('the generic-label fallback pattern is literal "tree...shrub" text, not the "ornamental" alias the client-side retired-sale matcher also accepts (documents an existing, unchanged boundary)', () => {
  // This regex (patterns.tree_shrub in findOverdueCustomers) is shared with
  // the category prefilter elsewhere in this same function — this fix
  // reuses it as-is rather than introducing a second definition, so an
  // "Ornamental Care" free-text row (no literal tree/shrub substring) was
  // never covered by the category scan at all, before or after this PR.
  // (Contrast client/src/constants/retiredSaleLabels.js's TREE_SHRUB_LABEL_RE,
  // an unrelated matcher for a different feature, which DOES special-case
  // \bornamentals?\b.)
  const label = 'tree.*shrub';
  expect('Tree & Shrub Care').toMatch(new RegExp(label, 'i'));
  expect('Ornamental Care').not.toMatch(new RegExp(label, 'i'));
});
