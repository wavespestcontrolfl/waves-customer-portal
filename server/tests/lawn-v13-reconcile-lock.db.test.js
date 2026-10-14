// The 15-minute lawn knowledge reconcile runs under the nightly's own lock
// ('knowledge-index-sync'), so the two never rebuild the corpora together, and it
// records job health under its own key (the nightly's row is never touched).
// Real advisory locks and job_health on a disposable local PostgreSQL.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

postgres('lawn knowledge reconcile and the knowledge-index lock', () => {
  let db; let holder; let KB; let runExclusive;
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local database');
    db = require('../models/db');
    KB = require('../services/knowledge-base');
    ({ runExclusive } = require('../utils/cron-lock'));
    holder = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 1 } });
  });
  afterAll(async () => { await holder?.destroy(); await db?.destroy(); });
  beforeEach(async () => {
    await db('job_health').whereIn('job_name', ['knowledge-index-sync', 'lawn-knowledge-reconcile']).del();
  });
  afterEach(() => jest.restoreAllMocks());

  test('the nightly holds the lock: the tick does nothing and retries next time', async () => {
    const reconcile = jest.spyOn(KB, 'reconcileLawnProtocolKnowledge').mockResolvedValue({ stale: false });
    await holder.raw('SELECT pg_advisory_lock(hashtext(?))', ['cron:knowledge-index-sync']);
    try {
      const result = await KB.runLawnKnowledgeReconcile();
      expect(result).toMatchObject({ skipped: true, reason: 'lease_held' });
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      await holder.raw('SELECT pg_advisory_unlock(hashtext(?))', ['cron:knowledge-index-sync']);
    }
  });

  test('while the reconcile runs the nightly cannot take the lock; job health goes under the reconcile key only', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    jest.spyOn(KB, 'reconcileLawnProtocolKnowledge').mockImplementation(async () => { entered(); await gate; return { stale: false }; });
    const running = KB.runLawnKnowledgeReconcile();
    await started;
    const nightly = jest.fn();
    expect(await runExclusive('knowledge-index-sync', nightly)).toMatchObject({ skipped: true, reason: 'lease_held' });
    expect(nightly).not.toHaveBeenCalled();
    release();
    await running;
    const rows = await db('job_health').whereIn('job_name', ['knowledge-index-sync', 'lawn-knowledge-reconcile']).select('job_name', 'last_status');
    expect(rows.map((r) => r.job_name)).toEqual(['lawn-knowledge-reconcile']);
    expect(rows[0].last_status).toBe('success');
    // Free again: the nightly takes its own lock as before.
    const ran = jest.fn(async () => 'ok');
    await runExclusive('knowledge-index-sync', ran);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  test('the scheduler tick calls the locked entry, not a lock of its own', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../services/scheduler.js'), 'utf8');
    expect(source).toMatch(/require\('\.\/knowledge-base'\)\.runLawnKnowledgeReconcile\(\)/);
    expect(source).not.toMatch(/runExclusive\('lawn-knowledge-reconcile'/);
  });
});
