/**
 * Schema + FK-behavior tests for the lawn_assessments.service_id
 * migration (20260430000004_lawn_assessments_service_id.js).
 *
 * Covers the migration invariants that PR 0.2 promises:
 *   - column exists, uuid, nullable
 *   - index exists for plan-engine lookups
 *   - FK references scheduled_services(id) with ON DELETE SET NULL
 *     so deleting a service preserves the historical assessment row
 *
 * Route-level validation (/assess accepting + rejecting serviceId
 * based on customer ownership) is not exercised here — adding a
 * supertest harness is out of scope for this PR. The route logic
 * is short enough to read; the live DB migration run verifies the
 * insert path persists service_id correctly.
 *
 * Skipped without DATABASE_URL so the rest of the unit-test suite
 * still runs on a developer box without Postgres.
 */

const path = require('path');
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('lawn_assessments.service_id FK to scheduled_services', () => {
  let knex;

  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
  });

  test('service_id column exists, uuid, nullable', async () => {
    const cols = await knex('lawn_assessments').columnInfo();
    expect(cols).toHaveProperty('service_id');
    expect(cols.service_id.type).toBe('uuid');
    expect(cols.service_id.nullable).toBe(true);
  });

  test('idx_lawn_assessments_service_id index exists', async () => {
    const { rows } = await knex.raw(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'lawn_assessments'
         AND indexname = 'idx_lawn_assessments_service_id'`
    );
    expect(rows.length).toBe(1);
  });

  test('FK to scheduled_services(id) with ON DELETE SET NULL', async () => {
    // Pull the FK rule from pg's catalog so we verify the actual
    // delete behavior, not just that some FK exists.
    const { rows } = await knex.raw(`
      SELECT
        kcu.column_name,
        ccu.table_name  AS referenced_table,
        ccu.column_name AS referenced_column,
        rc.delete_rule,
        rc.update_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'lawn_assessments'
        AND tc.constraint_type = 'FOREIGN KEY'
        AND kcu.column_name = 'service_id'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].referenced_table).toBe('scheduled_services');
    expect(rows[0].referenced_column).toBe('id');
    expect(rows[0].delete_rule).toBe('SET NULL');
    expect(rows[0].update_rule).toBe('CASCADE');
  });

  test('SET NULL behavior: deleting a scheduled_service nulls assessment.service_id', async () => {
    const c = await knex('customers').select('id').first();
    if (!c) {
      // eslint-disable-next-line no-console
      console.warn('[service_id smoke] no customers — skipping SET NULL round-trip');
      return;
    }

    // Create a scheduled_service for that customer.
    const [ssRow] = await knex('scheduled_services')
      .insert({
        customer_id: c.id,
        scheduled_date: new Date(),
        service_type: 'lawn_test_pr0_2',
        status: 'pending',
      })
      .returning('id');
    const serviceId = ssRow?.id ?? ssRow;

    // Insert an assessment pointing at it.
    const [laRow] = await knex('lawn_assessments')
      .insert({
        customer_id: c.id,
        service_id: serviceId,
        service_date: new Date(),
      })
      .returning('id');
    const assessmentId = laRow?.id ?? laRow;

    try {
      // Verify FK link took effect.
      const linked = await knex('lawn_assessments')
        .select('service_id')
        .where({ id: assessmentId })
        .first();
      expect(linked.service_id).toBe(serviceId);

      // Delete the parent service. The FK should set service_id to
      // NULL on the assessment row, NOT cascade-delete the assessment.
      await knex('scheduled_services').where({ id: serviceId }).del();

      const after = await knex('lawn_assessments')
        .select('id', 'service_id')
        .where({ id: assessmentId })
        .first();
      expect(after).toBeTruthy(); // assessment survived
      expect(after.service_id).toBeNull(); // link cleared
    } finally {
      await knex('lawn_assessments').where({ id: assessmentId }).del();
      // scheduled_service already deleted above; idempotent cleanup.
      await knex('scheduled_services').where({ id: serviceId }).del();
    }
  });

  test('insert without service_id still works (backward compat)', async () => {
    const c = await knex('customers').select('id').first();
    if (!c) return;

    const [laRow] = await knex('lawn_assessments')
      .insert({ customer_id: c.id, service_date: new Date() })
      .returning('id');
    const assessmentId = laRow?.id ?? laRow;

    try {
      const row = await knex('lawn_assessments')
        .select('service_id')
        .where({ id: assessmentId })
        .first();
      expect(row.service_id).toBeNull();
    } finally {
      await knex('lawn_assessments').where({ id: assessmentId }).del();
    }
  });
});
