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
