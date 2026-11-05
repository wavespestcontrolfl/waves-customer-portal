// CI's DB-gated pass runs this against PostgreSQL: the lead contact sync end to end
// (services/lead-contact-sync.js, GATE_LEAD_STATUS_FOLLOWS_CONTACT). It holds the SQL
// predicates the JavaScript fake in lead-contact-sync.test.js cannot: a text a person sent
// versus an automated one, a connected call versus a voicemail, the live-lead filter, and the
// real status writer (markLeadContactedFromEvidence) with its first-response stamp. Fixture
// tables live in a unique schema dropped after the suite; the funnel bridge is mocked.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lead-funnel-bridge', () => ({
  ...jest.requireActual('../services/lead-funnel-bridge'),
  bridgeLeadFunnelStage: jest.fn(async () => ({ updated: 0 })),
}));

const { runLeadContactSync, _test } = require('../services/lead-contact-sync');
const leadLink = require('../services/lead-estimate-link');

const NOW = new Date('2026-11-04T18:00:00Z');
const AT = (minutes) => new Date(Date.UTC(2026, 10, 4, 14, minutes, 0));
const FIRST = AT(0);
const PHONE = '+19415550100';

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('lead contact sync on PostgreSQL', () => {
  let database;
  const schema = `lead_contact_sync_${randomUUID().replaceAll('-', '')}`;
  const tables = ['leads', 'lead_activities', 'sms_log', 'call_log', 'emails', 'scheduled_services', 'customers'];

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    await database.raw(`ALTER TABLE "${schema}".lead_activities ALTER COLUMN created_at SET DEFAULT now()`);
    mockConn = database;
  });
  beforeEach(() => _test.resetResume());
  afterEach(async () => {
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.??', [schema, table]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  async function lead(fields = {}) {
    const row = {
      id: randomUUID(), status: 'new', lead_type: 'form', first_name: 'Pat', last_name: 'Sample', phone: PHONE,
      customer_id: null, first_contact_at: FIRST, created_at: FIRST, updated_at: FIRST, ...fields,
    };
    await database('leads').insert(row);
    return row;
  }
  const staffText = (fields = {}) => database('sms_log').insert({
    id: randomUUID(), direction: 'outbound', from_phone: '+19415550199', to_phone: PHONE, status: 'delivered',
    message_type: 'manual', metadata: JSON.stringify({ human_authored: true }), created_at: AT(7), updated_at: AT(7), ...fields,
  });
  const callRow = (fields = {}) => database('call_log').insert({
    id: randomUUID(), direction: 'inbound', from_phone: PHONE, to_phone: '+19415550199', status: 'completed',
    duration_seconds: 120, created_at: AT(10), updated_at: AT(10), ...fields,
  });
  const read = (id) => database('leads').where({ id }).first();
  const sync = (mode = 'true') => runLeadContactSync({ dbi: database, now: NOW, mode });

  test('a delivered staff text after first contact moves the lead and stamps response minutes from the text\'s time', async () => {
    const l = await lead();
    await staffText();
    const result = await sync();
    expect(result.byEvidence).toEqual({ staff_text: 1 });
    const row = await read(l.id);
    expect(row.status).toBe('contacted');
    expect(row.response_time_minutes).toBe(7);
    const history = await database('lead_activities').where({ lead_id: l.id }).orderBy('activity_type');
    expect(history.map((h) => h.activity_type)).toEqual(['first_response', 'status_change']);
    expect(history.every((h) => h.performed_by === 'Lead contact sync')).toBe(true);
    expect(history.find((h) => h.activity_type === 'status_change').metadata).toMatchObject({ evidenceType: 'staff_text' });
  });

  test('an automated text, an undelivered text and an inbound text do not move the lead', async () => {
    const l = await lead();
    await staffText({ message_type: 'lead_auto_reply', metadata: JSON.stringify({}) });
    await staffText({ message_type: 'manual', metadata: null });
    await staffText({ status: 'failed' });
    await staffText({ direction: 'inbound', from_phone: PHONE, to_phone: '+19415550199' });
    const result = await sync();
    expect(result.moved).toBe(0);
    expect((await read(l.id)).status).toBe('new');
  });

  test('a voicemail-only call does not move the lead; a live conversation does', async () => {
    const l = await lead();
    await callRow({ answered_by: 'voicemail', call_outcome: 'voicemail', processing_status: 'processed', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: 'true' } }) });
    await callRow({ status: 'no-answer' });
    expect((await sync()).moved).toBe(0);
    expect((await read(l.id)).status).toBe('new');

    await callRow({ answered_by: 'ai_agent', processing_status: 'processed', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: 'false' } }) });
    expect((await sync()).byEvidence).toEqual({ live_conversation: 1 });
    expect((await read(l.id)).status).toBe('contacted');
  });

  test('a call back a person placed and spoke on moves the lead', async () => {
    const l = await lead();
    await callRow({ direction: 'outbound', from_phone: '+19415550199', to_phone: PHONE, source: 'admin-click', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: 'false' } }) });
    expect((await sync()).byEvidence).toEqual({ live_conversation: 1 });
    expect((await read(l.id)).status).toBe('contacted');
  });

  const agentVerdict = JSON.stringify({ meta: { is_voicemail: 'false' } });
  const outboundCall = (fields = {}) => callRow({
    direction: 'outbound', from_phone: '+19415550199', to_phone: PHONE, source: 'admin-click',
    processing_status: 'processed', v2_extraction_status: 'valid', ai_extraction_enriched: agentVerdict, ...fields,
  });

  test('an outbound call with a non-voicemail verdict but a customer leg that did not complete moves nothing', async () => {
    const l = await lead();
    await outboundCall({ metadata: JSON.stringify({ customer_leg: { status: 'no-answer', duration_seconds: 90 } }) });
    expect((await sync()).moved).toBe(0);
    expect((await read(l.id)).status).toBe('new');
  });

  test('an outbound call with a completed customer leg under the minimum duration moves nothing', async () => {
    const l = await lead();
    await outboundCall({ metadata: JSON.stringify({ customer_leg: { status: 'completed', duration_seconds: 20 } }) });
    expect((await sync()).moved).toBe(0);
    expect((await read(l.id)).status).toBe('new');
  });

  test('an outbound call from a source outside the staff bridge list moves nothing even with the agent verdict', async () => {
    const l = await lead();
    await outboundCall({ source: 'collections_voice' });
    expect((await sync()).moved).toBe(0);
    expect((await read(l.id)).status).toBe('new');
  });

  test('an outbound call that passes the staff callback predicate moves the lead', async () => {
    const l = await lead();
    await outboundCall({ metadata: JSON.stringify({ customer_leg: { status: 'completed', duration_seconds: 75 } }) });
    expect((await sync()).byEvidence).toEqual({ live_conversation: 1 });
    expect((await read(l.id)).status).toBe('contacted');
  });

  test('an inbound call with the agent\'s non-voicemail verdict moves the lead', async () => {
    const l = await lead();
    await callRow({ answered_by: 'ai_agent', processing_status: 'processed', v2_extraction_status: 'valid', ai_extraction_enriched: agentVerdict });
    expect((await sync()).byEvidence).toEqual({ live_conversation: 1 });
    expect((await read(l.id)).status).toBe('contacted');
  });

  test('the call that created the lead is not its own evidence', async () => {
    const l = await lead();
    await callRow({ processing_status: 'processed', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: 'false' } }), metadata: JSON.stringify({ lead_id: l.id }) });
    expect((await sync()).moved).toBe(0);
  });

  test('contact before first_contact_at does not move the lead', async () => {
    const l = await lead({ first_contact_at: AT(30), created_at: AT(30) });
    await staffText({ created_at: AT(7) });
    expect((await sync()).moved).toBe(0);
    expect((await read(l.id)).status).toBe('new');
  });

  test('a staff email to the lead moves it', async () => {
    const l = await lead({ phone: null, email: 'pat@example.invalid' });
    await database('emails').insert({
      id: randomUUID(), gmail_id: 'g-1', gmail_thread_id: 'th-1', from_address: 'office@example.invalid',
      to_address: 'Pat Sample <pat@example.invalid>', cc_address: '', bcc_address: '', label_ids: JSON.stringify(['SENT']), received_at: AT(20),
    });
    expect((await sync()).byEvidence).toEqual({ staff_email: 1 });
    expect((await read(l.id)).status).toBe('contacted');
  });

  test('a visit booked for the linked customer moves the lead to contacted, never won', async () => {
    const customerId = randomUUID();
    await database('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Sample', phone: '+19415550177' });
    const l = await lead({ phone: null, customer_id: customerId });
    await database('scheduled_services').insert({ id: randomUUID(), customer_id: customerId, status: 'pending', created_at: AT(40), scheduled_date: '2026-11-10', service_type: 'Quarterly Pest Control Service' });
    expect((await sync()).byEvidence).toEqual({ visit_booked: 1 });
    const row = await read(l.id);
    expect(row.status).toBe('contacted');
    expect(row.status).not.toBe('won');
  });

  test('a cancelled visit does not move the lead', async () => {
    const customerId = randomUUID();
    await database('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Sample', phone: '+19415550177' });
    const l = await lead({ phone: null, customer_id: customerId });
    await database('scheduled_services').insert({ id: randomUUID(), customer_id: customerId, status: 'cancelled', created_at: AT(40), scheduled_date: '2026-11-10', service_type: 'Quarterly Pest Control Service' });
    expect((await sync()).moved).toBe(0);
    expect((await read(l.id)).status).toBe('new');
  });

  test('two live leads on one phone are both skipped', async () => {
    const a = await lead({ phone: '(941) 555-0100' });
    const b = await lead({ phone: '941.555.0100', first_contact_at: AT(2) });
    await staffText({ created_at: AT(30) });
    const result = await sync();
    expect(result.moved).toBe(0);
    expect(result.skipped.shared_phone).toBe(2);
    expect((await read(a.id)).status).toBe('new');
    expect((await read(b.id)).status).toBe('new');
  });

  test('contacted, won and deleted leads are untouched', async () => {
    const contacted = await lead({ status: 'contacted', phone: '+19415550101' });
    const won = await lead({ status: 'won', phone: '+19415550102' });
    const deleted = await lead({ deleted_at: AT(5), phone: '+19415550103' });
    for (const phone of ['+19415550101', '+19415550102', '+19415550103']) await staffText({ to_phone: phone });
    const result = await sync();
    expect(result.scanned).toBe(0);
    expect((await read(contacted.id)).status).toBe('contacted');
    expect((await read(won.id)).status).toBe('won');
    expect((await read(deleted.id)).status).toBe('new');
    expect(await database('lead_activities')).toHaveLength(0);
  });

  test('a lead a person returned to new by hand stays new', async () => {
    const l = await lead();
    await database('lead_activities').insert({ lead_id: l.id, activity_type: 'status_change', description: 'Status: contacted → new', performed_by: 'Admin' });
    await staffText();
    const result = await sync();
    expect(result.skipped.reopened_by_person).toBe(1);
    expect((await read(l.id)).status).toBe('new');
  });

  test('gate off and gate shadow write nothing', async () => {
    const l = await lead();
    await staffText();
    expect(await sync('off')).toEqual({ skipped: 'gate_off' });
    const shadow = await sync('shadow');
    expect(shadow.moved).toBe(1);
    expect(shadow.byEvidence).toEqual({ staff_text: 1 });
    const row = await read(l.id);
    expect(row.status).toBe('new');
    expect(row.response_time_minutes).toBe(null);
    expect(await database('lead_activities')).toHaveLength(0);
  });

  test('a second run moves nothing more', async () => {
    await lead();
    await staffText();
    expect((await sync()).moved).toBe(1);
    expect((await sync()).scanned).toBe(0);
  });

  // Staff correct the lead (or a person reopens it) AFTER the sweep judged it and BEFORE the
  // writer takes the row lock: the writer re-checks under the lock and moves nothing.
  async function raceBetweenJudgeAndWrite(change) {
    const writer = leadLink.markLeadContactedFromEvidence;
    const spy = jest.spyOn(leadLink, 'markLeadContactedFromEvidence').mockImplementation(async (options) => {
      await change();
      return writer(options);
    });
    try {
      return await sync();
    } finally {
      spy.mockRestore();
    }
  }

  test('a phone corrected between judging and writing moves nothing', async () => {
    const l = await lead();
    await staffText();
    const result = await raceBetweenJudgeAndWrite(() => database('leads').where({ id: l.id }).update({ phone: '+19415550188' }));
    expect(result.moved).toBe(0);
    expect(result.skipped).toEqual({ identity_changed: 1 });
    expect((await read(l.id)).status).toBe('new');
    expect(await database('lead_activities')).toHaveLength(0);
  });

  test('an email corrected between judging and writing moves nothing', async () => {
    const l = await lead({ phone: null, email: 'pat@example.invalid' });
    await database('emails').insert({
      id: randomUUID(), gmail_id: 'g-2', gmail_thread_id: 'th-2', from_address: 'office@example.invalid',
      to_address: 'pat@example.invalid', cc_address: '', bcc_address: '', label_ids: JSON.stringify(['SENT']), received_at: AT(20),
    });
    const result = await raceBetweenJudgeAndWrite(() => database('leads').where({ id: l.id }).update({ email: 'other@example.invalid' }));
    expect(result.skipped).toEqual({ identity_changed: 1 });
    expect((await read(l.id)).status).toBe('new');
  });

  test('a manual return to new landing between judging and writing moves nothing', async () => {
    const l = await lead();
    await staffText();
    const result = await raceBetweenJudgeAndWrite(() => database('lead_activities').insert({
      lead_id: l.id, activity_type: 'status_change', description: 'Status: contacted \u2192 new', performed_by: 'Admin',
    }));
    expect(result.skipped).toEqual({ reopened_by_person: 1 });
    expect((await read(l.id)).status).toBe('new');
  });

  test('a corrected phone that still matches the evidence moves the lead as usual', async () => {
    const l = await lead();
    await staffText();
    const result = await raceBetweenJudgeAndWrite(() => database('leads').where({ id: l.id }).update({ phone: '(941) 555-0100', last_name: 'Fixed' }));
    expect(result.moved).toBe(1);
    expect((await read(l.id)).status).toBe('contacted');
  });

  test('250 new leads: the newest 200 have no evidence and an older one does; the second run reaches it', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => {
      const at = AT(-i);
      return {
        id: randomUUID(), status: 'new', lead_type: 'form', first_name: 'Pat', last_name: 'Sample',
        phone: `+1941555${String(1000 + i)}`, customer_id: null, first_contact_at: at, created_at: at, updated_at: at,
      };
    });
    await database.batchInsert('leads', rows, 100);
    const oldest = rows[249];
    await staffText({ to_phone: oldest.phone, created_at: AT(-249 + 5) });
    const first = await sync();
    expect(first.scanned).toBe(200);
    expect(first.moved).toBe(0);
    const second = await sync();
    expect(second.moved).toBe(1);
    expect((await read(oldest.id)).status).toBe('contacted');
    // The walk reached the end: the next run starts from the newest again.
    expect((await sync()).scanned).toBe(200);
  });
});
