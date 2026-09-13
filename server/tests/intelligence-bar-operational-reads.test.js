const previousAdminPhone = process.env.ADAM_PHONE;
process.env.ADAM_PHONE = '+15555550999';
afterAll(() => { if (previousAdminPhone === undefined) delete process.env.ADAM_PHONE; else process.env.ADAM_PHONE = previousAdminPhone; });
// Real Knex SQL compilation with an in-memory transport: never opens a DB socket.
jest.mock('../models/db', () => {
  const db = require('knex')({ client: 'pg' });
  db.__queries = [];
  db.__rows = () => [];
  db.client.acquireConnection = async () => ({});
  db.client.releaseConnection = async () => {};
  db.client._query = async (_, query) => {
    db.__queries.push(query);
    query.response = { command: 'SELECT', rows: db.__rows(query) };
    return query;
  };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-email-fanout', () => ({ EMAIL_FANOUT_DISCLOSURE: '' }));
const db = require('../models/db');
const { executeTool } = require('../services/intelligence-bar/tools');
const { executeTechTool } = require('../services/intelligence-bar/tech-tools');
const { executeCommsTool } = require('../services/intelligence-bar/comms-tools');
const { effectiveServiceAddress } = require('../services/stamped-address');
const { etDateString } = require('../utils/datetime-et');

beforeEach(() => { db.__queries = []; db.__rows = () => []; });

test('a rental stamp never borrows the primary unit; primary visits preserve units', () => {
  const customer = { address_line1: '100 Test Street', address_line2: 'Unit 3', city: 'Test City' };
  expect(effectiveServiceAddress({}, customer).line2).toBe('Unit 3');
  expect(effectiveServiceAddress({ service_address_line1: '200 Test Street' }, customer).line2).toBeUndefined();
  expect(effectiveServiceAddress({ service_address_line1: '100 Test Street Apt 4' }, customer).line2).toBeUndefined();
});

test('customer search uses full name, latest health, zero bounds, true counts, and continuation', async () => {
  db.__rows = q => q.sql.includes('count(*)') ? [{ count: '51' }] : [{ id: 'fixture-customer' }];
  const result = await executeTool('query_customers', {
    search: 'Avery Example', filters: { has_email: false, max_health_score: 0, max_monthly_rate: 0 }, limit: 1,
  });
  expect(result.error).toBeUndefined();
  expect(result).toMatchObject({ total_matching: 51, returned_count: 1, has_more: true, next_offset: 1 });
  const sql = db.__queries[0].sql;
  expect(sql).toContain("TRIM(first_name || ' ' || COALESCE(last_name, '')) ILIKE");
  expect(sql).toContain('ORDER BY scored_at DESC NULLS LAST, created_at DESC LIMIT 1) <=');
  expect(sql).toContain("(NULLIF(\"email\", '') IS NOT NULL) =");
  expect(db.__queries[0].bindings).toContain(0);
  expect((await executeTool('query_customers', { filters: { invented: true } })).error).toMatch(/Unsupported/);
});

test('schedule defaults to today ET and reports a stamped destination with coverage', async () => {
  db.__rows = () => [{ id: 'fixture-stop', address_line1: '100 Test Street', service_address_line1: '200 Test Street', service_address_line2: 'Unit 2', city: 'Primary City', service_address_city: 'Rental City' }];
  const result = await executeTool('get_schedule_view', {});
  expect(result.error).toBeUndefined();
  expect(db.__queries[0].bindings).toContain(etDateString());
  expect(result.appointments[0].customer_address).toBe('200 Test Street, Unit 2, Rental City');
  expect(result.appointments[0].customer_city).toBe('Rental City');
  expect(result).toMatchObject({ has_more: false, returned_count: 1 });
});

test('tech next stop skips skipped jobs and reads the rental destination', async () => {
  db.__rows = () => [
    { id: 'skip', status: 'skipped' },
    { id: 'pending', status: 'pending', address_line1: '100 Test Street', service_address_line1: '200 Test Street' },
  ];
  const result = await executeTechTool('get_my_route', {}, { techId: 'fixture-tech' });
  expect(result.error).toBeUndefined();
  expect(result.remaining).toBe(1);
  expect(result.next_stop).toMatchObject({ id: 'pending', address: '200 Test Street' });
});

test('SMS history offers older pages instead of labeling a page the full thread', async () => {
  db.__rows = () => [{ id: 'newer' }, { id: 'older' }];
  const result = await executeCommsTool('get_conversation_thread', { phone: '+12025550123', limit: 1 });
  expect(result.error).toBeUndefined();
  expect(result).toMatchObject({ returned_count: 1, has_more: true, next_offset: 1 });
});

test('call drill-down returns transcript continuation rather than only the greeting', async () => {
  db.__rows = () => [{ transcription: 'x'.repeat(12001) }];
  const result = await executeCommsTool('get_call_log', { call_id: '00000000-0000-0000-0000-000000000001' });
  expect(result.error).toBeUndefined();
  expect(result.calls[0].transcript).toHaveLength(12000);
  expect(result.calls[0].transcript_next_offset).toBe(12000);
  expect(db.__queries[0].sql).not.toContain('"call_log"."created_at" >=');
});

test('customer detail exposes saved rentals, linked profiles, units, and coverage', async () => {
  db.__rows = q => {
    if (q.sql.includes('from "customer_properties"')) return [{ id: 'rental', address_line1: '200 Test Street' }];
    if (q.sql.includes('from "customers"')) {
      if (q.sql.includes('"account_id"')) return [{ id: 'linked-profile', address_line1: '300 Test Street' }];
      return [{ id: 'fixture-customer', account_id: 'fixture-account', address_line1: '100 Test Street', address_line2: 'Unit 3' }];
    }
    return [];
  };
  const result = await executeTool('get_customer_detail', { customer_id: 'fixture-customer' });
  expect(result.error).toBeUndefined();
  expect(result.profile.address).toBe('100 Test Street, Unit 3');
  expect(result.properties[0].id).toBe('rental');
  expect(result.account_properties[0].id).toBe('linked-profile');
  expect(result.coverage).toMatchObject({ properties: 'complete', linked_profiles: 'complete' });
});

test('unavailable property storage is marked unknown rather than empty', async () => {
  db.__rows = q => {
    if (q.sql.includes('from "customer_properties"')) throw new Error('fixture unavailable');
    if (q.sql.includes('from "customers"')) return [{ id: 'fixture-customer' }];
    return [];
  };
  const result = await executeTool('get_customer_detail', { customer_id: 'fixture-customer' });
  expect(result.error).toBeUndefined();
  expect(result.properties).toBeNull();
  expect(result.coverage.properties).toBe('unavailable');
});


test('call returned_count excludes internal calls omitted from the response', async () => {
  db.__rows = () => [
    { id: 'internal', from_phone: '+15555550999', to_phone: '+15555550999' },
    { id: 'customer', from_phone: '+15555550101', to_phone: '+15555550102' },
  ];
  const result = await executeCommsTool('get_call_log', {});
  expect(result.calls.map(row => row.id)).toEqual(['customer']);
  expect(result.returned_count).toBe(1);
});

test('find_duplicates keeps queue an array when the canonical queue read fails, and names the failure in queue_error', async () => {
  const dedupe = require('../services/customer-dedupe');
  const spy = jest.spyOn(dedupe, 'findDuplicateGroups').mockRejectedValue(new Error('relation "customer_dedupe_dismissals" does not exist'));
  try {
    db.__rows = () => [{ phone: '5555550100', count: '2', names: 'A Example, B Example' }];
    const result = await executeTool('find_duplicates', { match_on: 'phone' });
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.queue)).toBe(true);
    expect(result.queue).toEqual([]);
    expect(result.queue_error).toMatch(/duplicate queue unavailable: relation "customer_dedupe_dismissals"/);
    expect(result.duplicates).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
});

test('find_duplicates omits queue_error when the canonical queue reads cleanly', async () => {
  const dedupe = require('../services/customer-dedupe');
  const spy = jest.spyOn(dedupe, 'findDuplicateGroups').mockResolvedValue([
    { phone10: '5555550100', winner: { id: 'w1', first_name: 'A', last_name: 'Example' }, candidates: [{ loser: { id: 'l1', first_name: 'B', last_name: 'Example' }, tier: 'green', reasons: ['same_phone'] }] },
  ]);
  try {
    db.__rows = () => [];
    const result = await executeTool('find_duplicates', { match_on: 'phone' });
    expect(result.queue_error).toBeUndefined();
    expect(result.queue).toEqual([{ phone: '5555550100', winner: { customer_id: 'w1', name: 'A Example' }, candidates: [{ customer_id: 'l1', name: 'B Example', tier: 'green', reasons: ['same_phone'] }] }]);
  } finally {
    spy.mockRestore();
  }
});

test('customer list and duplicate readers skip soft-deleted rows', async () => {
  // A website stub was soft-deleted minutes after intake, yet query_customers
  // and find_duplicates kept listing it while get_customer_detail and
  // update_customer refused it — the model chased a record no tool would touch.
  db.__queries = [];
  db.__rows = q => q.sql.includes('count(*)') ? [{ count: '1' }] : [{ id: 'fixture-customer' }];
  const list = await executeTool('query_customers', { search: 'Unknown', limit: 1 });
  expect(list.error).toBeUndefined();
  const [rows, matched, total] = db.__queries;
  expect(rows.sql).toContain('"customers"."deleted_at" is null');
  expect(matched.sql).toContain('"customers"."deleted_at" is null');
  expect(total.sql).toContain('"deleted_at" is null');

  for (const match_on of ['phone', 'email', 'name_address']) {
    db.__queries = [];
    db.__rows = () => [];
    const result = await executeTool('find_duplicates', { match_on });
    expect(result.error).toBeUndefined();
    expect(db.__queries[0].sql).toContain('"deleted_at" is null');
  }
});


test('find_duplicates caps each group\'s candidates too, and says so on the group (Codex r14 P2)', async () => {
  const dedupe = require('../services/customer-dedupe');
  const wide = {
    phone10: '5550001111',
    winner: { id: 'w', first_name: 'Biz', last_name: 'Main' },
    candidates: Array.from({ length: 27 }, (_, i) => ({ loser: { id: `l${i}`, first_name: 'Site', last_name: `${i}` }, tier: 'yellow', reasons: ['same_phone'] })),
  };
  const narrow = { ...wide, phone10: '5550002222', winner: { id: 'w2', first_name: 'A', last_name: 'B' }, candidates: wide.candidates.slice(0, 10) };
  const spy = jest.spyOn(dedupe, 'findDuplicateGroups').mockResolvedValue([wide, narrow]);
  try {
    db.__rows = () => [];
    const result = await executeTool('find_duplicates', { match_on: 'phone' });
    expect(result.queue).toHaveLength(2);
    expect(result.queue[0].candidates).toHaveLength(10);
    expect(result.queue[0].candidates[0].customer_id).toBe('l0');
    expect(result.queue[0].candidates_truncated).toMatchObject({ returned: 10, total: 27 });
    expect(result.queue[0].candidates_truncated.note).toMatch(/Showing the first 10 of 27 candidates in this group/);
    // At the cap exactly → no notice on that group.
    expect(result.queue[1].candidates).toHaveLength(10);
    expect(result.queue[1].candidates_truncated).toBeUndefined();
    expect(result.queue_truncated).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});

test('find_duplicates caps the canonical queue and says so, instead of handing the model the whole customer base (Codex r11 P2)', async () => {
  const dedupe = require('../services/customer-dedupe');
  const groups = Array.from({ length: 63 }, (_, i) => ({
    phone10: `555000${String(i).padStart(4, '0')}`,
    winner: { id: `w${i}`, first_name: 'A', last_name: `Example${i}` },
    candidates: [{ loser: { id: `l${i}`, first_name: 'B', last_name: `Example${i}` }, tier: 'green', reasons: ['same_phone'] }],
  }));
  const spy = jest.spyOn(dedupe, 'findDuplicateGroups').mockResolvedValue(groups);
  try {
    db.__rows = () => [];
    const result = await executeTool('find_duplicates', { match_on: 'phone' });
    expect(result.queue).toHaveLength(50);
    expect(result.queue_truncated).toMatchObject({ returned: 50, total: 63 });
    expect(result.queue_truncated.note).toMatch(/Showing the first 50 of 63 duplicate groups/);
    // At the cap exactly → no truncation notice.
    spy.mockResolvedValue(groups.slice(0, 50));
    expect((await executeTool('find_duplicates', { match_on: 'phone' })).queue_truncated).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});
