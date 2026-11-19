/**
 * Real PostgreSQL proof for call-log list helpers. Creates and drops one
 * task-private schema; all rows are synthetic. Opt in with
 * CALL_ANALYTICS_TEST_DATABASE_URL pointing at local PostgreSQL 16.
 */
const connection = process.env.CALL_ANALYTICS_TEST_DATABASE_URL;
const describePg = connection ? describe : describe.skip;
const knexFactory = require('knex');
const { randomUUID } = require('crypto');
const {
  addSourceRegistryJoin, applyCallListOrder, decorateCalls, loadCurrentMonth, sourceSelectColumns,
  _private: { currentETMonthWindow, sourceEvidence },
} = require('../services/call-log-analytics');
const { loadRelatedVisits } = require('../services/related-visit-links');
const { whereNotSandboxCall } = require('../services/voice-agent/relay-protocol');

jest.setTimeout(30000);

describePg('call-log analytics SQL (PostgreSQL 16)', () => {
  const schema = `call_analytics_${process.pid}_${Date.now()}`;
  const now = new Date('2026-11-18T17:00:00.000Z');
  const month = currentETMonthWindow(now);
  let setup; let db; let rows;

  beforeAll(async () => {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('Test URL must point to local PostgreSQL');
    setup = knexFactory({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    const version = Number((await setup.raw("SELECT current_setting('server_version_num')::int AS version")).rows[0].version);
    if (version < 160000 || version >= 170000) throw new Error(`Expected PostgreSQL 16, got ${version}`);
    await setup.raw('CREATE SCHEMA ??', [schema]);
    db = knexFactory({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 3 } });
    await db.schema.createTable('call_log', (t) => {
      t.uuid('id').primary(); t.string('direction'); t.string('from_phone'); t.string('to_phone');
      t.string('source'); t.string('twilio_call_sid'); t.string('google_ads_call_resource_name');
      t.jsonb('metadata'); t.timestamp('created_at', { useTz: true });
    });
    await db.schema.createTable('lead_sources', (t) => {
      t.uuid('id').primary(); t.string('twilio_phone_number'); t.string('name'); t.string('source_type');
      t.string('domain'); t.string('landing_page_url'); t.boolean('is_active'); t.timestamp('updated_at', { useTz: true });
    });
    await db.schema.createTable('leads', (t) => {
      t.uuid('id').primary(); t.string('status'); t.string('twilio_call_sid'); t.uuid('customer_id'); t.timestamp('deleted_at', { useTz: true });
    });
    await db.schema.createTable('scheduled_services', (t) => {
      t.uuid('id').primary(); t.uuid('source_call_log_id'); t.string('status'); t.date('scheduled_date');
    });
    await db.schema.createTable('service_records', (t) => {
      t.uuid('id').primary(); t.uuid('scheduled_service_id');
    });
    await db.schema.createTable('invoices', (t) => {
      t.uuid('id').primary(); t.string('status'); t.uuid('scheduled_service_id'); t.uuid('service_record_id');
    });
    await db('lead_sources').insert([
      source('+19412691697', 'ZZZ custom Google placement', 'google_ads', null, true, -20),
      source('+19412691697', 'Duplicate inactive placement', 'google_ads', null, false, -1),
      source('+19412402066', 'AAA custom site placement', 'main_site', 'wavespestcontrol.com', true, -10),
      source('+19412975749', 'Waves Main Line', 'main_site', 'wavespestcontrol.com', true, -10),
    ]);
    rows = [];
    const add = (count, toPhone, offset, sourceValue = null) => {
      for (let i = 0; i < count; i += 1) {
        const sequence = offset + i;
        rows.push({ id: randomUUID(), direction: 'inbound',
          from_phone: sequence === 0 || sequence === 249 ? '+19415550101' : `+1941${String(5551000 + sequence).slice(-7)}`,
          to_phone: toPhone, source: sourceValue, twilio_call_sid: `CA${String(sequence).padStart(30, '0')}`,
          metadata: {}, created_at: new Date(month.startInstant.getTime() + sequence * 60000) });
      }
    };
    add(20, '+19412691697', 0);
    add(230, '+19412402066', 20);
    add(5, '+19412975749', 250);
    add(1, '+19995550123', 255);
    // This number is a website line today, but its server-owned call-time
    // stamp proves it was a Maps placement then. Display and SQL sort must agree.
    rows[20].metadata = { numberType: 'gbp_tracking', location: 'GBP — Sarasota' };
    // The main line is ambiguous by itself. Only the bridge's committed
    // resource-name stamp turns one call into accepted Google Ads evidence;
    // a metadata proposal without that stamp stays unknown.
    rows[250].google_ads_call_resource_name = 'customers/1/callViews/accepted';
    rows[250].metadata = { google_ads_call_bridge: { campaignName: 'Brand' } };
    rows[251].metadata = { google_ads_call_bridge: { proposedResourceName: 'customers/1/callViews/proposal' } };
    rows[252].google_ads_call_resource_name = '   ';
    rows.push({ id: randomUUID(), direction: 'inbound', from_phone: '+19415559991', to_phone: '+19412691697',
      source: 'voice_relay_sandbox', twilio_call_sid: 'CASANDBOX', metadata: {}, created_at: new Date(month.startInstant.getTime() + 300 * 60000) });
    rows.push({ id: randomUUID(), direction: 'outbound', from_phone: '+19412691697', to_phone: '+19415559992',
      source: null, twilio_call_sid: 'CAOUTBOUND', metadata: {}, created_at: new Date(month.startInstant.getTime() + 301 * 60000) });
    await db.batchInsert('call_log', rows, 100);
  });

  afterAll(async () => {
    if (db) await db.destroy();
    if (setup) { await setup.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]); await setup.destroy(); }
  });

  function source(phone, name, type, domain, active, minutes) {
    return { id: randomUUID(), twilio_phone_number: phone, name, source_type: type, domain,
      landing_page_url: domain ? `https://${domain}` : null, is_active: active,
      updated_at: new Date(now.getTime() + minutes * 60000) };
  }

  function listQuery({ sort = 'received', order = 'desc', limit = 200, id } = {}) {
    let query = db('call_log as cl').modify((qb) => whereNotSandboxCall(qb, 'cl.source'))
      .select('cl.*', ...sourceSelectColumns(db));
    query = addSourceRegistryJoin(query, db, 'cl');
    if (id) query.where('cl.id', id);
    return applyCallListOrder(query, db, { sort, order }).limit(limit);
  }

  test('source order is global before LIMIT and follows evidence labels, not registry names', async () => {
    const ascending = await listQuery({ sort: 'source', order: 'asc' });
    expect(ascending).toHaveLength(200);
    expect(ascending.slice(0, 21).every((row) => sourceEvidence(row).kind === 'google_ads')).toBe(true);
    expect(sourceEvidence(ascending[0])).toEqual(expect.objectContaining({ detail: 'Matched call report' }));
    expect(sourceEvidence(ascending[21]).kind).toBe('google_business');
    expect(ascending[22].direction).toBe('outbound');
    expect(ascending.slice(23, 28).every((row) => sourceEvidence(row).kind === 'unknown')).toBe(true);
    expect(ascending.slice(28).every((row) => sourceEvidence(row).kind === 'website')).toBe(true);
    const descending = await listQuery({ sort: 'source', order: 'desc' });
    expect(descending).toHaveLength(200);
    expect(descending.every((row) => sourceEvidence(row).kind === 'website')).toBe(true);
  });

  test('received sorting is stable before LIMIT in both directions', async () => {
    const ascending = await listQuery({ sort: 'received', order: 'asc' });
    const descending = await listQuery({ sort: 'received', order: 'desc' });
    expect(ascending[0].id).toBe(rows[0].id);
    expect(descending[0].id).toBe(rows[257].id);
    expect(ascending).toHaveLength(200);
    expect(descending).toHaveLength(200);
  });

  test('exact-id selection survives source join and duplicate registry history', async () => {
    const found = await listQuery({ id: rows[3].id, limit: 1 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: rows[3].id, _source_name: 'ZZZ custom Google placement' });
  });

  test('monthly aggregation counts every non-internal inbound once without disclosing an unmapped number', async () => {
    const result = await loadCurrentMonth(db, now);
    expect(result.total).toBe(256);
    expect(result.sources.reduce((sum, group) => sum + group.count, 0)).toBe(result.total);
    expect(result.sources.filter((group) => group.kind === 'unknown').reduce((sum, group) => sum + group.count, 0)).toBe(5);
    expect(JSON.stringify(result.sources)).not.toContain('+19995550123');
    expect(result.sources).toEqual(expect.arrayContaining([
      { kind: 'google_ads', label: 'Google Ads', detail: 'ZZZ custom Google placement', count: 20 },
      { kind: 'google_ads', label: 'Google Ads', detail: 'Matched call report', count: 1 },
      { kind: 'google_business', label: 'Google Business Profile', detail: 'Maps listing · Sarasota', count: 1 },
      { kind: 'website', label: 'Website', detail: 'Website · wavespestcontrol.com', count: 229 },
    ]));
  });

  test('caller history uses all inbound lines and date/id order, not only the selected page', async () => {
    const [decorated] = await decorateCalls(db, [rows[249]]);
    expect(decorated.caller_history).toBe('returning');
  });

  test('detail outcomes include every explicit visit and direct-or-record invoice without cross-visit inference', async () => {
    const callId = rows[3].id;
    const visitOlder = randomUUID();
    const visitNewer = randomUUID();
    const recordOlder = randomUUID();
    const directOlder = randomUUID();
    const recordInvoice = randomUUID();
    const directNewer = randomUUID();
    await db('scheduled_services').insert([
      { id: visitOlder, source_call_log_id: callId, status: 'completed', scheduled_date: '2026-11-10' },
      { id: visitNewer, source_call_log_id: callId, status: 'pending', scheduled_date: '2026-11-20' },
    ]);
    await db('service_records').insert({ id: recordOlder, scheduled_service_id: visitOlder });
    await db('invoices').insert([
      { id: directOlder, status: 'paid', scheduled_service_id: visitOlder, service_record_id: null },
      { id: recordInvoice, status: 'sent', scheduled_service_id: null, service_record_id: recordOlder },
      // Its service record says older, but the explicit invoice link says newer and must win.
      { id: directNewer, status: 'draft', scheduled_service_id: visitNewer, service_record_id: recordOlder },
    ]);

    const related = await loadRelatedVisits(db, callId);
    expect(related.map((visit) => visit.id)).toEqual([visitNewer, visitOlder]);
    expect(related[0].invoices).toEqual([{ id: directNewer, status: 'draft' }]);
    expect(related[1].invoices).toEqual(expect.arrayContaining([
      { id: directOlder, status: 'paid' },
      { id: recordInvoice, status: 'sent' },
    ]));
    expect(related[1].invoices).toHaveLength(2);
  });
});
