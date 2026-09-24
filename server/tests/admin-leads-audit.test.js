jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (_q, _s, next) => next(), requireAdmin: (_q, _s, next) => next() }));
jest.mock('../routes/admin-customers', () => ({ ensureCustomerAccount: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lead-funnel-bridge', () => ({ bridgeLeadFunnelStage: jest.fn() }));
jest.mock('../services/lead-attribution', () => ({ ...jest.requireActual('../services/lead-attribution'), settleWonFunnelRow: jest.fn() }));
const db = require('../models/db');
const knex = require('knex')({ client: 'pg' });
const router = require('../routes/admin-leads');
const { logFirstResponse } = require('../services/lead-attribution');
const queries = [];
let lead, activities, failActivity, lockDeletes;
// Compile real PostgreSQL queries; replace execution with a synthetic runner.
knex.client.runner = builder => ({ run: async () => {
  const compiled = builder.toSQL(); queries.push(compiled);
  if (builder._single.table === 'lead_activities') {
    if (failActivity) throw new Error('activity unavailable');
    activities.push(builder._single.insert); return [1];
  }
  if (compiled.sql.includes('for update') && lockDeletes) return undefined;
  if (builder._method === 'update') {
    if (!lead || lead.deleted_at) return builder._single.returning ? [] : 0;
    Object.assign(lead, builder._single.update);
    return builder._single.returning ? [{ ...lead }] : 1;
  }
  if (builder._method === 'first') return compiled.sql.includes('count(') ? { count: '1' } : lead && { ...lead };
  return lead ? [{ ...lead }] : [];
} });
async function request(method, path, body = {}, query = {}) {
  const handler = router.stack.find(l => l.route?.path === path && l.route.methods[method]).route.stack.at(-1).handle;
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }, next = jest.fn();
  await handler({ body, query, params: { id: 'lead-1' }, technician: { first_name: 'Test', last_name: 'Admin' } }, res, next);
  return { res, error: next.mock.calls[0]?.[0], data: res.json.mock.calls[0]?.[0] };
}
beforeEach(() => {
  jest.clearAllMocks(); queries.length = 0; activities = []; failActivity = false; lockDeletes = false;
  lead = { id: 'lead-1', status: 'new', first_contact_at: new Date(Date.now() - 600000), response_time_minutes: 7 };
  db.mockImplementation(table => knex(table)); db.raw = knex.raw.bind(knex); db.isTransaction = true;
  db.transaction = jest.fn(async work => {
    const before = { ...lead }, beforeActivities = activities.slice();
    try { return await work(db); } catch (err) { lead = before; activities = beforeActivities; throw err; }
  });
});
afterAll(() => knex.destroy());
test.each([['2030-09-24', '2030-09-24T14:00:00.000Z'], ['2030-01-24', '2030-01-24T15:00:00.000Z']])('callback uses ET in %s', async (date, expected) => {
  expect((await request('post', '/:id/schedule-callback', { date, time: '10:00' })).error).toBeUndefined();
  expect(lead.next_follow_up_at.toISOString()).toBe(expected);
  expect(JSON.parse(activities[0].metadata).callback_at).toBe(expected);
});
test.each([{ date: '2030-02-30', time: '10:00' }, { date: '2030-09-24', time: '24:10' }, { date: '2030-09-24', time: '10:00Z' }])('invalid callback rejected %j', async body => {
  expect((await request('post', '/:id/schedule-callback', body)).res.status).toHaveBeenCalledWith(400);
  expect(db.transaction).not.toHaveBeenCalled();
});
test('callback rolls back when history fails', async () => {
  failActivity = true;
  expect((await request('post', '/:id/schedule-callback', { date: '2030-09-24', time: '10:00' })).error.message).toBe('activity unavailable');
  expect(lead.next_follow_up_at).toBeUndefined();
});
test('callback rejects the missing spring-forward hour without writing', async () => {
  const { res, error } = await request('post', '/:id/schedule-callback', { date: '2027-03-14', time: '02:30' });
  expect(error).toBeUndefined();
  expect(res.status).toHaveBeenCalledWith(400);
  expect(db.transaction).not.toHaveBeenCalled();
  expect(lead.next_follow_up_at).toBeUndefined();
  expect(activities).toHaveLength(0);
});
test.each([['01:30', '2027-03-14T06:30:00.000Z'], ['03:30', '2027-03-14T07:30:00.000Z']])('callback accepts valid DST-boundary time %s', async (time, expected) => {
  const { error } = await request('post', '/:id/schedule-callback', { date: '2027-03-14', time });
  expect(error).toBeUndefined();
  expect(lead.next_follow_up_at.toISOString()).toBe(expected);
});
test('manual win preserves first win and response, records operator and before/after', async () => {
  const { data, error } = await request('put', '/:id', { status: 'won' });
  expect(error).toBeUndefined();
  expect(data.lead).toMatchObject({ status: 'won', is_qualified: true, response_time_minutes: 7 });
  expect(data.lead.converted_at).toBeInstanceOf(Date);
  expect(activities[0]).toMatchObject({ activity_type: 'status_change', performed_by: 'Test Admin' });
  expect(JSON.parse(activities[0].metadata)).toMatchObject({ previous_status: 'new', status: 'won' });
  const firstWin = lead.converted_at;
  await request('put', '/:id', { status: 'contacted' }); await request('put', '/:id', { status: 'won' });
  expect(lead.converted_at).toEqual(firstWin);
});
test('manual status and first response roll back when history fails', async () => {
  lead.response_time_minutes = null; failActivity = true;
  expect((await request('put', '/:id', { status: 'contacted' })).error).toBeTruthy();
  expect(lead).toMatchObject({ status: 'new', response_time_minutes: null });
});
test('concurrent delete prevents manual status change', async () => {
  lockDeletes = true;
  expect((await request('put', '/:id', { status: 'won' })).res.status).toHaveBeenCalledWith(404);
  expect(activities).toHaveLength(0);
});
test('first response only claims a live null metric once', async () => {
  lead.response_time_minutes = null;
  await logFirstResponse('lead-1', { database: db });
  expect(lead.response_time_minutes).toBe(10);
  const update = queries.find(q => q.method === 'update');
  expect(update.sql).toContain('"response_time_minutes" is null');
  expect(update.sql).toContain('"deleted_at" is null');
  await logFirstResponse('lead-1', { database: db }); expect(activities).toHaveLength(1);
});
test.each(['Jamie Example', '(941) 555-0101'])('search %s shares row/count criteria', async search => {
  expect((await request('get', '/', {}, { search })).error).toBeUndefined();
  const [count, rows] = queries.filter(q => q.sql.includes('from "leads"'));
  const condition = q => q.sql.split(' where ')[1].split(' order by ')[0].split(' limit ')[0];
  expect(condition(rows)).toBe(condition(count));
  expect(rows.sql).toContain("CONCAT_WS(' '"); expect(rows.bindings).toContain(`%${search}%`);
  if (search.includes('941')) expect(rows.bindings).toContain('%9415550101%');
});
test.each(['/analytics/funnel', '/analytics/response', '/analytics/lost'])('%s uses complete ET days', async path => {
  lead = null;
  expect((await request('get', path, {}, { start_date: '2030-09-24', end_date: '2030-09-24' })).error).toBeUndefined();
  for (const q of queries) expect(q.bindings.filter(v => v instanceof Date).map(v => v.toISOString())).toEqual(['2030-09-24T04:00:00.000Z', '2030-09-25T03:59:59.999Z']);
  if (path === '/analytics/response') {
    expect(queries[0].bindings).toEqual(expect.arrayContaining(['spam', 'duplicate', 'cancelled']));
    expect(queries[0].sql).toContain('WITH RECURSIVE');
  }
});
