/** Real PostgreSQL proof of publication parity and edit/publish serialization.
 * Uses only PROTOCOL_PUBLISH_TEST_DATABASE_URL, with an owned fixture schema.
 */
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  db.raw = (...args) => mockPg.raw(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const router = require('../routes/admin-protocols');
const { protocolReferenceSyncIssues } = require('../services/lawn-protocol-operating-layer');
const connection = process.env.PROTOCOL_PUBLISH_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `protocol_publish_${randomUUID().replaceAll('-', '')}`;
let mockPg;
let admin;
let ids;
jest.setTimeout(60000);

function invoke(path, method, params, body = {}) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route;
  const handler = route.stack.at(-1).handle;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  return handler({ params, body }, res, (error) => { res.statusCode = error.statusCode || 500; res.body = { error: error.message }; }).then(() => res);
}

postgres('protocol publishing on PostgreSQL', () => {
  beforeAll(async () => {
    const name = new URL(connection).pathname;
    if (!/^\/(waves_qa_[a-f0-9]+|waves_test)$/.test(name)) throw new Error('Use a dedicated Waves QA database');
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection: { connectionString: connection, application_name: schema }, searchPath: [schema], pool: { min: 0, max: 5 } });
    await mockPg.schema.createTable('lawn_protocols', (t) => {
      t.uuid('id').primary(); t.text('protocol_key'); t.text('status'); t.text('version');
      t.date('effective_from'); t.date('effective_to'); t.timestamps(true, true);
    });
    await mockPg.schema.createTable('lawn_protocol_windows', (t) => {
      t.uuid('id').primary(); t.uuid('lawn_protocol_id'); t.text('window_key'); t.integer('month');
      for (const field of ['title', 'visit_type', 'goal', 'production_mode']) t.text(field);
      t.decimal('default_carrier_gal_per_1000', 6, 3);
      for (const field of ['main_tank', 'spot_work', 'conditional_triggers', 'wiki_refs', 'required_tasks', 'customer_note_templates']) t.jsonb(field);
      t.timestamps(true, true);
    });
    await mockPg.schema.createTable('lawn_protocol_products', (t) => {
      t.uuid('id').primary(); t.uuid('lawn_protocol_window_id'); t.uuid('product_id');
      for (const field of ['product_name', 'role', 'application_mode', 'rate_unit']) t.text(field);
      t.decimal('rate_per_1000', 10, 4); t.decimal('carrier_gal_per_1000', 6, 3);
      t.boolean('default_in_plan'); t.integer('sort_order');
      for (const field of ['gates', 'annual_counter', 'mixing', 'report_copy']) t.jsonb(field);
      t.timestamps(true, true);
    });
    await mockPg.schema.createTable('lawn_protocol_gates', (t) => {
      t.uuid('id').primary(); t.uuid('lawn_protocol_id');
      for (const field of ['gate_key', 'gate_type', 'severity', 'title', 'rule_text']) t.text(field);
      t.jsonb('logic'); t.jsonb('wiki_refs'); t.timestamps(true, true);
    });
    await mockPg.schema.createTable('products_catalog', (t) => {
      t.uuid('id').primary(); t.text('name'); t.decimal('inventory_on_hand'); t.text('inventory_unit'); t.decimal('low_stock_threshold');
    });
    await mockPg.schema.createTable('equipment_systems', (t) => {
      t.uuid('id').primary(); t.text('name'); t.text('system_type'); t.boolean('active');
    });
    await mockPg.schema.createTable('equipment_calibrations', (t) => {
      t.uuid('id').primary(); t.uuid('equipment_system_id'); t.boolean('active');
      t.decimal('carrier_gal_per_1000'); t.text('calibration_status');
    });
    await mockPg.schema.createTable('knowledge_base', (t) => {
      t.increments('id');
      for (const field of ['path', 'slug', 'title', 'content', 'category', 'source', 'confidence', 'status', 'verified_by']) t.text(field);
      t.jsonb('tags'); t.jsonb('metadata'); t.timestamp('last_verified_at'); t.timestamps(true, true);
    });
    await mockPg.schema.createTable('lawn_protocol_audit_log', (t) => {
      t.increments('id'); t.uuid('lawn_protocol_id'); t.uuid('actor_technician_id'); t.uuid('entity_id');
      for (const field of ['actor_name', 'actor_email', 'entity_type', 'action']) t.text(field);
      for (const field of ['changed_fields', 'before_snapshot', 'after_snapshot', 'metadata']) t.jsonb(field);
    });
  });
  beforeEach(async () => {
    for (const table of ['knowledge_base', 'lawn_protocol_audit_log', 'lawn_protocol_products', 'lawn_protocol_gates', 'lawn_protocol_windows', 'lawn_protocols', 'products_catalog']) await mockPg(table).delete();
    ids = Object.fromEntries(['active', 'draft', 'activeWindow', 'draftWindow', 'activeProduct', 'draftProduct', 'activeGate', 'draftGate', 'catalog'].map((key) => [key, randomUUID()]));
    await mockPg('products_catalog').insert({ id: ids.catalog, name: 'Synthetic product', inventory_on_hand: 100, inventory_unit: 'oz', low_stock_threshold: 1 });
    for (const status of ['active', 'draft']) {
      await mockPg('lawn_protocols').insert({ id: ids[status], protocol_key: 'fixture', status, version: status, effective_from: '2026-01-01' });
      await mockPg('lawn_protocol_windows').insert({ id: ids[`${status}Window`], lawn_protocol_id: ids[status], window_key: 'jan', month: 1, title: 'January', visit_type: 'fixture', goal: 'Synthetic goal', default_carrier_gal_per_1000: 2, production_mode: 'fixture', main_tank: '{}', spot_work: '[]', conditional_triggers: '[]', wiki_refs: '["kb:fixture"]', required_tasks: '["fixture_task"]' });
      await mockPg('lawn_protocol_products').insert({ id: ids[`${status}Product`], lawn_protocol_window_id: ids[`${status}Window`], product_id: ids.catalog, product_name: 'Synthetic product', role: 'fixture', application_mode: 'broadcast', rate_per_1000: 1, rate_unit: 'oz', carrier_gal_per_1000: 2, default_in_plan: true, gates: '{}', annual_counter: '{}', mixing: '{}', sort_order: 0 });
      await mockPg('lawn_protocol_gates').insert({ id: ids[`${status}Gate`], lawn_protocol_id: ids[status], gate_key: 'fixture_gate', gate_type: 'fixture', severity: 'block', title: 'Fixture', rule_text: 'Fixture rule', logic: '{"fixture":true}', wiki_refs: '["kb:fixture"]' });
    }
  });
  afterAll(async () => {
    if (mockPg) await mockPg.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  test('SOP/closeout changes publish without altering treatment sources', async () => {
    await mockPg('lawn_protocol_windows').where({ id: ids.draftWindow }).update({ wiki_refs: '["kb:new-fixture"]', required_tasks: '["new_task"]' });
    const result = await invoke('/lawn/drafts/:id/publish', 'post', { id: ids.draft });
    expect(result.statusCode).toBe(200);
    expect((await mockPg('lawn_protocols').where({ id: ids.active }).first()).status).toBe('archived');
    expect((await mockPg('lawn_protocols').where({ id: ids.draft }).first()).status).toBe('active');
    expect(await mockPg('lawn_protocol_audit_log').where({ action: 'publish' })).toHaveLength(1);
  });

  test.each([
    ['rate', 'lawn_protocol_products', 'draftProduct', { rate_per_1000: 2 }, 'products'],
    ['mapping', 'lawn_protocol_products', 'draftProduct', { product_id: null }, 'products'],
    ['default product', 'lawn_protocol_products', 'draftProduct', { default_in_plan: false }, 'products'],
    ['product gate', 'lawn_protocol_products', 'draftProduct', { gates: '{"newGate":true}' }, 'products'],
    ['carrier', 'lawn_protocol_products', 'draftProduct', { carrier_gal_per_1000: 3 }, 'products'],
    ['mixing', 'lawn_protocol_products', 'draftProduct', { mixing: '{"instruction":"changed"}' }, 'products'],
    ['monthly treatment', 'lawn_protocol_windows', 'draftWindow', { goal: 'Different goal' }, 'windows'],
    ['safety gate', 'lawn_protocol_gates', 'draftGate', { logic: '{"fixture":false}' }, 'gates'],
  ])('rejects unsynchronized %s and leaves active/audit unchanged', async (_name, table, key, patch, section) => {
    await mockPg(table).where({ id: ids[key] }).update(patch);
    const result = await invoke('/lawn/drafts/:id/publish', 'post', { id: ids.draft });
    expect(result.statusCode).toBe(409);
    expect(result.body.validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'reference_sync_required', metadata: expect.objectContaining({ section }) })]));
    expect((await mockPg('lawn_protocols').where({ id: ids.active }).first()).status).toBe('active');
    expect((await mockPg('lawn_protocols').where({ id: ids.draft }).first()).status).toBe('draft');
    expect(await mockPg('lawn_protocol_audit_log')).toHaveLength(0);
  });

  test('missing baseline fails closed', async () => {
    await mockPg('lawn_protocols').where({ id: ids.active }).update({ status: 'archived' });
    expect(await protocolReferenceSyncIssues(mockPg, await mockPg('lawn_protocols').where({ id: ids.draft }).first())).toEqual([expect.objectContaining({ code: 'reference_baseline_missing' })]);
  });

  test('repeat publish does not add another audit record', async () => {
    expect((await invoke('/lawn/drafts/:id/publish', 'post', { id: ids.draft })).statusCode).toBe(200);
    expect((await invoke('/lawn/drafts/:id/publish', 'post', { id: ids.draft })).statusCode).toBe(400);
    expect(await mockPg('lawn_protocol_audit_log').where({ action: 'publish' })).toHaveLength(1);
  });

  test('SOP synchronization writes its page and attachment together', async () => {
    const result = await invoke('/lawn/windows/:windowKey/wiki-sync', 'post', { windowKey: 'jan' }, { protocolId: ids.draft });
    expect(result.statusCode).toBe(200);
    expect(result.body.attached).toBe(true);
    expect(await mockPg('knowledge_base')).toHaveLength(1);
    expect((await mockPg('lawn_protocol_windows').where({ id: ids.draftWindow }).first()).wiki_refs).toContain(result.body.ref);
  });

  test('failed SOP attachment rolls back the knowledge page too', async () => {
    await mockPg.schema.renameTable('lawn_protocol_audit_log', 'hidden_audit');
    try {
      const result = await invoke('/lawn/windows/:windowKey/wiki-sync', 'post', { windowKey: 'jan' }, { protocolId: ids.draft });
      expect(result.statusCode).toBe(500);
      expect(await mockPg('knowledge_base')).toHaveLength(0);
      expect((await mockPg('lawn_protocol_windows').where({ id: ids.draftWindow }).first()).wiki_refs).toEqual(['kb:fixture']);
    } finally {
      await mockPg.schema.renameTable('hidden_audit', 'lawn_protocol_audit_log');
    }
  });

  test.each([
    ['/lawn/products/:id', 'draftProduct', { ratePer1000: 5 }, 'lawn_protocol_products'],
    ['/lawn/windows/:windowKey', 'draftWindow', { requiredTasks: ['late'] }, 'lawn_protocol_windows'],
    ['/lawn/windows/:windowKey/wiki-sync', 'draftWindow', {}, 'lawn_protocol_windows'],
  ])('%s waits for publication and refuses a late write', async (path, key, body, table) => {
    const before = await mockPg(table).where({ id: ids[key] }).first();
    const trx = await mockPg.transaction();
    let edit;
    try {
      await trx('lawn_protocols').where({ id: ids.draft }).forUpdate().first();
      const params = path.includes('windowKey') ? { windowKey: 'jan' } : { id: ids[key] };
      edit = invoke(path, path.endsWith('wiki-sync') ? 'post' : 'put', params, { ...body, protocolId: ids.draft });
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const rows = await mockPg.raw('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = ? AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked', [schema]);
        if (rows.rows[0].blocked) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await trx('lawn_protocols').where({ id: ids.active }).update({ status: 'archived' });
      await trx('lawn_protocols').where({ id: ids.draft }).update({ status: 'active' });
      await trx.commit();
      expect((await edit).statusCode).toBe(409);
      expect(await mockPg(table).where({ id: ids[key] }).first()).toEqual(before);
      expect(await mockPg('knowledge_base')).toHaveLength(0);
    } finally {
      if (!trx.isCompleted()) await trx.rollback();
      if (edit) await edit;
    }
  });
});
