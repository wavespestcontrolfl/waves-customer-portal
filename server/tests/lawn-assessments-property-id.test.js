const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const migration = require('../models/migrations/20260907000010_lawn_assessments_property_id');
const backfill = require('../models/migrations/20260907000020_backfill_lawn_assessment_property');

describeDb('lawn property migration against dev table definitions', () => {
  let owned;
  let knex;
  beforeEach(async () => { owned = await createLawnHistoryDb(); knex = owned.knex; });
  afterEach(async () => { if (owned) await owned.dispose(); });

  test('nullable UUID columns, partial history index, and reset index exist', async () => {
    for (const table of ['lawn_assessments', 'lawn_baseline_resets']) {
      const columns = await knex(table).columnInfo();
      expect(columns.property_id).toMatchObject({ type: 'uuid', nullable: true });
    }
    const indexes = await knex('pg_indexes').where({ schemaname: owned.schema }).whereIn('indexname', [
      'idx_lawn_assessments_property_id', 'idx_lawn_baseline_resets_customer_created',
    ]);
    expect(indexes).toHaveLength(2);
    expect(indexes.find((row) => row.indexname === 'idx_lawn_assessments_property_id').indexdef).toContain('WHERE (property_id IS NOT NULL)');
    expect(indexes.find((row) => row.indexname === 'idx_lawn_baseline_resets_customer_created').indexdef).toContain('(customer_id, created_at DESC)');
  });

  test('both foreign keys null on property deletion and cascade id corrections', async () => {
    const f = await fixture(knex);
    const row = await f.assessment(null, { property_id: f.property.id });
    const [reset] = await knex('lawn_baseline_resets').insert({ customer_id: f.customerId, property_id: f.property.id, reset_by: 'fixture', reason: 'Fixture reset' }).returning('*');
    const nextId = require('crypto').randomUUID();
    await knex('customer_properties').where({ id: f.property.id }).update({ id: nextId });
    expect((await knex('lawn_assessments').where({ id: row.id }).first()).property_id).toBe(nextId);
    expect((await knex('lawn_baseline_resets').where({ id: reset.id }).first()).property_id).toBe(nextId);
    await knex('customer_properties').where({ id: nextId }).del();
    expect((await knex('lawn_assessments').where({ id: row.id }).first()).property_id).toBeNull();
    expect((await knex('lawn_baseline_resets').where({ id: reset.id }).first()).property_id).toBeNull();
  });

  test('both actual migrations support up/down/up without touching activity timestamps', async () => {
    const f = await fixture(knex);
    const visit = await f.visit();
    const row = await f.assessment(visit, { property_id: null });
    await backfill.up(knex);
    const stamped = await knex('lawn_assessments').where({ id: row.id }).first();
    expect(stamped.property_id).toBe(f.property.id);
    expect(stamped.updated_at).toEqual(row.updated_at);
    await backfill.down(knex);
    await migration.down(knex);
    expect(await knex.schema.hasColumn('lawn_assessments', 'property_id')).toBe(false);
    await migration.up(knex);
    await migration.up(knex);
    await backfill.up(knex);
    expect((await knex('lawn_assessments').where({ id: row.id }).first()).property_id).toBe(f.property.id);
  });
});
