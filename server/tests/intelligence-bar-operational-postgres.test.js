jest.mock('../services/dispatch-assignment', () => ({ emitDispatchJobUpdate: jest.fn(async () => ({})) }));
// Opt-in integration against a dedicated migrated dev/QA database. Every test
// rolls back its synthetic records, including the real audit writer's inserts.
jest.mock('../models/db', () => new Proxy((...args) => mockDb(...args), {
  get: (_, key) => typeof mockDb[key] === 'function' ? mockDb[key].bind(mockDb) : mockDb[key],
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => true, gates: { visitGroups: false } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');
const { executeTool } = require('../services/intelligence-bar/tools');
const { executeCommsTool } = require('../services/intelligence-bar/comms-tools');
const { previewFingerprint } = require('../services/intelligence-bar/authorization-contract');
const { etDateString, addETDays } = require('../utils/datetime-et');
const connection = process.env.IB_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockDb;
let database;
let ids;
let input;
jest.setTimeout(60000);
postgres('Intelligence Bar operational flows on PostgreSQL', () => {
  beforeAll(() => {
    if (!/^\/(waves_qa_[a-f0-9]+|waves_test)$/.test(new URL(connection).pathname)) {
      throw new Error('Use a dedicated, migrated Waves QA database');
    }
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 3 } });
  });
  beforeEach(async () => {
    mockDb = await database.transaction();
    ids = Object.fromEntries(['customer', 'primary', 'rental', 'template', 'stop', 'grouped', 'future', 'visit', 'actor'].map(key => [key, randomUUID()]));
    const today = etDateString();
    await mockDb('customers').insert({ id: ids.customer, first_name: 'Avery', last_name: 'Fixture', phone: '+1555' + Date.now().toString().slice(-7), address_line1: '100 Test Street', address_line2: 'Unit 3', city: 'Test City', state: 'FL', zip: '34201' });
    await mockDb('customer_properties').insert([
      { id: ids.primary, customer_id: ids.customer, address_line1: '100 Test Street', address_line2: 'Unit 3', is_primary: true },
      { id: ids.rental, customer_id: ids.customer, address_line1: '200 Test Street', address_line2: 'Unit 2', city: 'Test City', state: 'FL', zip: '34201', latitude: 27.4, longitude: -82.5 },
    ]);
    await mockDb('service_visits').insert({ id: ids.visit, customer_id: ids.customer, property_id: ids.primary, scheduled_date: today, stop_base_key: `${ids.primary}:${today}`, created_by: 'ib-postgres-fixture' });
    const base = { customer_id: ids.customer, property_id: ids.primary, scheduled_date: today, service_type: 'Fixture service', route_order: 2, window_start: '12:00', window_end: '13:00' };
    await mockDb('scheduled_services').insert({ ...base, id: ids.template, is_recurring: true });
    await mockDb('scheduled_services').insert([
      { ...base, id: ids.stop, status: 'en_route', recurring_parent_id: ids.template, visit_id: ids.visit },
      { ...base, id: ids.grouped, status: 'en_route', visit_id: ids.visit },
      { ...base, id: ids.future, recurring_parent_id: ids.template, scheduled_date: etDateString(addETDays(new Date(), 30)) },
    ]);
    input = { appointment_id: ids.stop, property_id: ids.rental };
  });
  afterEach(async () => { await mockDb?.rollback(); });
  afterAll(async () => { await database?.destroy(); });
  const call = (params = input, context = {}) => executeScheduleTool('switch_appointment_property', params, context);
  const confirm = preview => call({ ...input, confirmed: true, _verified_address_fingerprint: previewFingerprint(preview) }, { confirmed: true, technicianId: ids.actor });

  test('discovers a saved rental and commits an en-route grouped visit without moving the series', async () => {
    const detail = await executeTool('get_customer_detail', { customer_id: ids.customer });
    expect(detail.error).toBeUndefined();
    expect(detail.properties.map(row => row.id)).toContain(ids.rental);
    const preview = await call();
    expect(preview.error).toBeUndefined();
    expect((await mockDb('scheduled_services').where({ id: ids.stop }).first()).property_id).toBe(ids.primary);
    expect(await confirm(preview)).toMatchObject({ success: true, messages_sent: false });
    const changed = await mockDb('scheduled_services').whereIn('id', [ids.stop, ids.grouped]);
    expect(changed).toHaveLength(2);
    for (const row of changed) expect(row).toMatchObject({ property_id: ids.rental, service_address_line2: 'Unit 2', status: 'en_route', route_order: null, window_start: '12:00:00' });
    const untouched = await mockDb('scheduled_services').whereIn('id', [ids.template, ids.future]);
    expect(untouched.every(row => row.property_id === ids.primary)).toBe(true);
    expect((await mockDb('service_visits').where({ id: ids.visit }).first()).property_id).toBe(ids.rental);
    expect(await mockDb('audit_log').where({ resource_id: ids.stop, action: 'appointment_address_changed' })).toHaveLength(1);
    const schedule = await executeTool('get_schedule_view', {});
    expect(schedule.error).toBeUndefined();
    expect(schedule.appointments.find(row => row.id === ids.stop).customer_address).toContain('200 Test Street, Unit 2');
    const search = await executeTool('query_customers', { search: 'Avery Fixture', filters: { has_email: false }, limit: 1 });
    expect(search.error).toBeUndefined();
    expect(search.total_matching).toBeGreaterThanOrEqual(1);
  });

  test('rejects an edited destination after approval and leaves the visit unchanged', async () => {
    const preview = await call();
    await mockDb('customer_properties').where({ id: ids.rental }).update({ address_line2: 'Unit 8' });
    expect(await confirm(preview)).toMatchObject({ preview_changed: true });
    expect((await mockDb('scheduled_services').where({ id: ids.stop }).first()).property_id).toBe(ids.primary);
    expect(await mockDb('audit_log').where({ resource_id: ids.stop })).toHaveLength(0);
  });
  test('reads real call transcriptions and keeps tied timestamp pages stable', async () => {
    const callIds = [randomUUID(), randomUUID()].sort();
    const created = new Date();
    await mockDb('call_log').insert(callIds.map(id => ({ id, customer_id: ids.customer, direction: 'inbound',
      from_phone: '+15555550101', to_phone: '+15555550102', transcription: 'x'.repeat(12001), created_at: created,
    })));
    const params = { customer_name: 'Avery Fixture', has_transcript: true, limit: 1 };
    const first = await executeCommsTool('get_call_log', params);
    expect(first.error).toBeUndefined();
    expect(first.calls[0].id).toBe(callIds[1]);
    const second = await executeCommsTool('get_call_log', { ...params, offset: first.next_offset });
    expect(second.calls[0].id).toBe(callIds[0]);
    const detail = await executeCommsTool('get_call_log', { call_id: callIds[0] });
    expect(detail.calls[0].transcript).toHaveLength(12000);
    const continuation = await executeCommsTool('get_call_log', { call_id: callIds[0], transcript_offset: detail.calls[0].transcript_next_offset });
    expect(continuation.calls[0].transcript).toBe('x');
  });

  test('auto-dispatch rejects a destination changed after scoring', async () => {
    const { revalidatePlacement } = require('../services/auto-dispatch/apply');
    const scored = await mockDb('scheduled_services').where({ id: ids.template }).first();
    expect(await revalidatePlacement(scored)).toMatchObject({ ok: true });
    await mockDb('scheduled_services').where({ id: ids.template }).update({ property_id: ids.rental });
    expect(await revalidatePlacement(scored)).toMatchObject({ ok: false, code: 'STALE_PLACEMENT' });
  });

});
