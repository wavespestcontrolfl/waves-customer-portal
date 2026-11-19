/**
 * The migration and its rollback run entirely inside a test transaction.
 * SET LOCAL confines unqualified names to a random schema with its own estimates table.
 */
const { randomUUID } = require('node:crypto');
const knexFactory = require('knex');
const migration = require('../models/migrations/20261119130000_estimate_recurring_capture_dispositions');
const { findCaptureDisposition } = require('../services/estimate-recurring-capture-dispositions');

const connection = process.env.REPAIR_TEST_DATABASE_URL || process.env.DATABASE_URL;
if (connection) {
  const url = new URL(connection);
  const localQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
  const ci = process.env.GITHUB_ACTIONS === 'true' && url.pathname === '/waves_test';
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.search || url.hash || !(localQa || ci)) {
    throw new Error('Choose a loopback random Waves QA database or GitHub Actions waves_test.');
  }
}
const describeDb = connection ? describe : describe.skip;
const TABLE = migration.TABLE;

describeDb('estimate recurring capture dispositions migration', () => {
  let database;
  beforeAll(() => { database = knexFactory({ client: 'pg', connection, pool: { min: 0, max: 1 } }); });
  afterAll(async () => { await database?.destroy(); });

  async function withMigration(run) {
    const schema = `capture_disposition_${randomUUID().replaceAll('-', '')}`;
    const trx = await database.transaction();
    try {
      await trx.raw('CREATE SCHEMA ??', [schema]);
      await trx.raw('SET LOCAL search_path TO ??', [schema]);
      await trx.raw('CREATE TABLE estimates (id uuid PRIMARY KEY, estimate_data jsonb)');
      await migration.up(trx);
      await run(trx);
      await migration.down(trx);
      expect(await trx.schema.hasTable(TABLE)).toBe(false);
      expect(await trx.schema.hasTable('estimates')).toBe(true);
    } finally {
      await trx.rollback();
    }
  }

  test('stores independent setup intents, reads only disposition fields, and rolls back only its table', async () => {
    await withMigration(async (trx) => {
      const estimateId = randomUUID();
      const oldEstimateId = randomUUID();
      await trx('estimates').insert([
        { id: estimateId, estimate_data: { quote: { totalCents: 4100 } } },
        {
          id: oldEstimateId,
          estimate_data: trx.raw('to_jsonb(?::text)', [JSON.stringify({ legacy: true, totalCents: 9900 })]),
        },
      ]);

      const discardAt = new Date('2026-11-19T17:00:00.000Z');
      const claimAt = new Date('2026-11-19T17:01:00.000Z');
      await trx(TABLE).insert([
        {
          estimate_id: estimateId,
          setup_intent_id: 'seti_discarded',
          discard_requested_at: discardAt,
        },
        {
          estimate_id: estimateId,
          setup_intent_id: 'seti_legacy',
          legacy_recovery_claimed_at: claimAt,
        },
        {
          estimate_id: estimateId,
          setup_intent_id: 'seti_both',
          discard_requested_at: discardAt,
          legacy_recovery_claimed_at: claimAt,
          retired_at: new Date('2026-11-19T17:02:00.000Z'),
        },
        {
          estimate_id: oldEstimateId,
          setup_intent_id: 'seti_both',
          legacy_recovery_claimed_at: claimAt,
        },
      ]);

      // Editing estimate preferences replaces the JSON document, including on
      // historical estimates that stored the document as an encoded string.
      await trx('estimates').where({ id: estimateId }).update({ estimate_data: { paymentPreference: 'per_visit' } });
      await trx('estimates').where({ id: oldEstimateId }).update({
        estimate_data: trx.raw('to_jsonb(?::text)', [JSON.stringify({ legacy: true, paymentPreference: 'per_visit' })]),
      });
      const row = await findCaptureDisposition(trx, {
        estimateId,
        setupIntentId: 'seti_both',
      });
      expect(row).toEqual({
        discard_requested_at: discardAt,
        retired_at: new Date('2026-11-19T17:02:00.000Z'),
        legacy_recovery_claimed_at: claimAt,
      });

      expect(await findCaptureDisposition(trx, {
        estimateId: oldEstimateId,
        setupIntentId: 'seti_both',
      })).toEqual({ discard_requested_at: null, retired_at: null, legacy_recovery_claimed_at: claimAt });
      expect(await findCaptureDisposition(trx, {
        estimateId: oldEstimateId,
        setupIntentId: 'seti_missing',
      })).toBeNull();

      await trx('estimates').where({ id: estimateId }).del();
      expect(await trx(TABLE).where({ estimate_id: estimateId })).toHaveLength(0);
      expect(await trx('estimates').where({ id: oldEstimateId })).toHaveLength(1);
      expect(await trx.schema.hasTable('estimates')).toBe(true);
    });
  });

  test('enforces the composite key and disposition facts without deciding precedence', async () => {
    await withMigration(async (trx) => {
      const estimateId = randomUUID();
      await trx('estimates').insert({ id: estimateId });
      await trx(TABLE).insert({
        estimate_id: estimateId,
        setup_intent_id: 'seti_duplicate',
        discard_requested_at: new Date(),
      });

      await expect(trx.transaction((savepoint) => savepoint(TABLE).insert({
        estimate_id: estimateId,
        setup_intent_id: 'seti_duplicate',
        legacy_recovery_claimed_at: new Date(),
      }))).rejects.toMatchObject({ code: '23505' });

      await expect(trx.transaction((savepoint) => savepoint(TABLE).insert({
        estimate_id: estimateId,
        setup_intent_id: 'seti_retired_without_discard',
        retired_at: new Date(),
      }))).rejects.toMatchObject({ code: '23514' });

      await expect(trx.transaction((savepoint) => savepoint(TABLE).insert({
        estimate_id: estimateId,
        setup_intent_id: 'seti_without_fact',
      }))).rejects.toMatchObject({ code: '23514' });

      await trx(TABLE).insert({
        estimate_id: estimateId,
        setup_intent_id: 'seti_legacy_only',
        legacy_recovery_claimed_at: new Date(),
      });
      await trx(TABLE).insert({
        estimate_id: estimateId,
        setup_intent_id: 'seti_discard_only',
        discard_requested_at: new Date(),
      });
      expect(await trx(TABLE).where({ estimate_id: estimateId })).toHaveLength(3);
    });
  });
});
