// Migration 20261102041500 on real Postgres (metrics audit 2026-11-01): the manual trigger's "completed" jobs
// that never ran become failed and its vendor status clears; a job with real results is left alone; one audit
// event lists what changed, and down restores it exactly. Runs inside a transaction that is always rolled back.
const SKIP = !process.env.DATABASE_URL;

(SKIP ? describe.skip : describe)('unrun scrape jobs migration (real PG)', () => {
  let db;
  beforeAll(() => { db = require('../models/db'); });
  afterAll(async () => { if (db) await db.destroy(); });

  test('fake completions become failed, a real run is kept, and down restores what the trigger wrote', async () => {
    const migration = require('../models/migrations/20261102041500_unrun_scrape_jobs_failed');
    const rollback = new Error('rollback');
    const when = new Date('2026-10-01T12:00:00Z');
    const earlier = new Date('2026-09-01T12:00:00Z');
    await expect(db.transaction(async (trx) => {
      const suffix = Math.random().toString(36).slice(2, 10);
      const [completed] = await trx('vendors')
        .insert({ name: `Synthetic Completed ${suffix}`, last_scrape_status: 'completed', last_scrape_at: when }).returning('*');
      const [running] = await trx('vendors')
        .insert({ name: `Synthetic Running ${suffix}`, last_scrape_status: 'running', last_scrape_at: earlier }).returning('*');
      const [other] = await trx('vendors').insert({ name: `Synthetic Other ${suffix}` }).returning('*');
      const [fake] = await trx('price_scrape_jobs').insert({
        vendor_id: completed.id, status: 'completed', started_at: when, completed_at: when, products_found: 0, prices_updated: 0, duration_ms: 0,
      }).returning('*');
      const [stuck] = await trx('price_scrape_jobs').insert({ vendor_id: running.id, status: 'pending', created_at: earlier }).returning('*');
      const [real] = await trx('price_scrape_jobs').insert({
        vendor_id: other.id, status: 'completed', started_at: when, completed_at: when, products_found: 4, prices_updated: 2, duration_ms: 5400,
      }).returning('*');
      const job = (row) => trx('price_scrape_jobs').where({ id: row.id }).first('status', 'error_message');
      const vendor = (row) => trx('vendors').where({ id: row.id }).first('last_scrape_status', 'last_scrape_at');

      await migration.up(trx);
      expect(await job(fake)).toEqual({ status: 'failed', error_message: migration.NEVER_RAN });
      expect(await job(stuck)).toEqual({ status: 'failed', error_message: migration.NEVER_RAN });
      expect(await job(real)).toEqual({ status: 'completed', error_message: null });
      for (const row of [completed, running, other]) expect(await vendor(row)).toEqual({ last_scrape_status: null, last_scrape_at: null });
      const event = await trx('audit_log').where({ action: migration.AUDIT_ACTION }).orderBy('created_at', 'desc').first('metadata');
      expect(event.metadata.jobs).toEqual(expect.arrayContaining([{ id: fake.id, status: 'completed' }, { id: stuck.id, status: 'pending' }]));
      expect(event.metadata.jobs.map((row) => row.id)).not.toContain(real.id);
      expect(event.metadata.vendors.map((row) => row.id)).toEqual(expect.arrayContaining([completed.id, running.id]));

      await migration.down(trx);
      expect(await job(fake)).toEqual({ status: 'completed', error_message: null });
      expect(await job(stuck)).toEqual({ status: 'pending', error_message: null });
      expect(await job(real)).toEqual({ status: 'completed', error_message: null });
      expect(await vendor(completed)).toEqual({ last_scrape_status: 'completed', last_scrape_at: when });
      expect(await vendor(running)).toEqual({ last_scrape_status: 'running', last_scrape_at: earlier });
      expect(await vendor(other)).toEqual({ last_scrape_status: null, last_scrape_at: null });
      expect(await trx('audit_log').where({ action: `${migration.AUDIT_ACTION}:down` })).toHaveLength(1);
      throw rollback;
    })).rejects.toBe(rollback);
  });
});
