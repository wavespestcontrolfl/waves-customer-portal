/**
 * tree_shrub_assessment_partial_photos alert dedupe (PR #4091).
 *
 * Unit: the migration installs a partial unique index on (job_id) scoped to
 * this type and unresolved rows — the shape createAlertOnce's ON CONFLICT DO
 * NOTHING relies on — and resolves pre-existing duplicates first.
 *
 * PostgreSQL (DATABASE_URL): against a throwaway copy of dispatch_alerts the
 * index admits one unresolved alert per job, rejects a second, and admits a
 * new one once the first is resolved; createAlertOnce returns the existing
 * row instead of inserting.
 */
const { randomUUID } = require('node:crypto');
const migration = require('../models/migrations/20260909000114_tree_shrub_partial_photos_alert_dedupe');

describe('20260909000114 unit', () => {
  test('resolves duplicates, then creates the partial unique index for this type', async () => {
    const raw = jest.fn().mockResolvedValue(undefined);
    await migration.up({ raw });
    expect(raw).toHaveBeenCalledTimes(2);
    const [dedupe, index] = raw.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
    expect(dedupe).toMatch(/UPDATE dispatch_alerts AS a SET resolved_at = now\(\)/);
    expect(dedupe).toMatch(/type = 'tree_shrub_assessment_partial_photos' AND resolved_at IS NULL AND job_id IS NOT NULL/);
    expect(dedupe).toMatch(/ranked\.rn > 1/);
    expect(index).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_alerts_ts_partial_photos_one_unresolved ON dispatch_alerts \(job_id\)/);
    expect(index).toMatch(/WHERE type = 'tree_shrub_assessment_partial_photos' AND resolved_at IS NULL AND job_id IS NOT NULL/);
  });

  test('down drops only that index', async () => {
    const raw = jest.fn().mockResolvedValue(undefined);
    await migration.down({ raw });
    expect(raw).toHaveBeenCalledWith('DROP INDEX IF EXISTS idx_dispatch_alerts_ts_partial_photos_one_unresolved');
  });
});

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

postgres('20260909000114 on PostgreSQL', () => {
  const knex = require('knex');
  let db;
  jest.setTimeout(60000);
  beforeAll(() => { db = knex({ client: 'pg', connection: process.env.DATABASE_URL }); });
  afterAll(async () => { await db.destroy(); });

  async function inRollback(work) {
    const rollback = new Error('intentional test rollback');
    try {
      await db.transaction(async (trx) => {
        const schema = `tsalert_${randomUUID().replaceAll('-', '')}`;
        await trx.raw('CREATE SCHEMA ??', [schema]);
        // Pre-migration fixture: INCLUDING ALL would copy the target index once
        // the migration has run on this database, and the duplicate seed below
        // would fail before migration.up executes. Copy columns, defaults and
        // check constraints only; the migration installs the index under test.
        await trx.raw('CREATE TABLE ??.dispatch_alerts (LIKE public.dispatch_alerts INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING IDENTITY)', [schema]);
        await trx.raw('SET LOCAL search_path TO ??, public', [schema]);
        await work(trx);
        throw rollback;
      });
    } catch (err) {
      if (err !== rollback) throw err;
    }
  }

  const TYPE = 'tree_shrub_assessment_partial_photos';

  test('one unresolved alert per job; duplicates resolved by the migration; resolved rows free the slot', async () => {
    await inRollback(async (trx) => {
      const job = randomUUID();
      await trx('dispatch_alerts').insert([
        { type: TYPE, severity: 'warn', job_id: job, payload: JSON.stringify({ source: 'photo_recovery', n: 1 }), created_at: new Date('2026-09-01') },
        { type: TYPE, severity: 'warn', job_id: job, payload: JSON.stringify({ source: 'photo_recovery', n: 2 }), created_at: new Date('2026-09-02') },
      ]);
      await migration.up(trx);
      const open = await trx('dispatch_alerts').where({ type: TYPE, job_id: job }).whereNull('resolved_at');
      expect(open).toHaveLength(1);
      expect(open[0].payload.n).toBe(1);
      const dup = await trx('dispatch_alerts').where({ type: TYPE, job_id: job }).whereNotNull('resolved_at').first();
      expect(dup.payload.dedupedByMigration).toBe('20260909000114_tree_shrub_partial_photos_alert_dedupe');

      // Second unresolved alert for the same job: ON CONFLICT DO NOTHING is a no-op.
      const inserted = await trx('dispatch_alerts')
        .insert({ type: TYPE, severity: 'warn', job_id: job, payload: JSON.stringify({ source: 'photo_recovery', n: 3 }) })
        .onConflict().ignore().returning('id');
      expect(inserted).toHaveLength(0);
      // A different type on the same job is unaffected.
      const other = await trx('dispatch_alerts')
        .insert({ type: 'follow_up_needed', severity: 'info', job_id: job, payload: JSON.stringify({ source: 'other' }) })
        .onConflict().ignore().returning('id');
      expect(other).toHaveLength(1);
      // Resolving the open alert frees the slot.
      await trx('dispatch_alerts').where({ id: open[0].id }).update({ resolved_at: new Date() });
      const again = await trx('dispatch_alerts')
        .insert({ type: TYPE, severity: 'warn', job_id: job, payload: JSON.stringify({ source: 'photo_recovery', n: 4 }) })
        .onConflict().ignore().returning('id');
      expect(again).toHaveLength(1);
    });
  });

  test('createAlertOnce returns the existing open alert on a repeated reconciliation', async () => {
    await inRollback(async (trx) => {
      await migration.up(trx);
      const { createAlertOnce } = require('../services/dispatch-alerts');
      const job = randomUUID();
      const args = { type: TYPE, severity: 'warn', jobId: job, payload: { source: 'photo_recovery' }, trx };
      const first = await createAlertOnce(args);
      const second = await createAlertOnce(args);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.row.id).toBe(first.row.id);
      expect(await trx('dispatch_alerts').where({ type: TYPE, job_id: job }).count('* as n').first()).toMatchObject({ n: '1' });
    });
  });
});
