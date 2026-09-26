/** Real PostgreSQL coverage for durable schedule-quality claims and fencing. */
const knex = require('knex');
const queue = require('../services/scheduling/quality-refresh-queue');

const connection = process.env.SERVICE_GEOCODE_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const NOW = new Date('2040-09-09T12:00:00Z');

postgres('schedule quality refresh queue on isolated PostgreSQL', () => {
  let database;
  const created = new Set();

  beforeAll(async () => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(url.hostname)
      && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    if (!(await database.schema.hasTable('schedule_quality_refresh_jobs'))) {
      throw new Error('Run the schedule_quality_refresh_jobs migration in the isolated test database');
    }
  });

  afterEach(async () => {
    if (created.size) await database('schedule_quality_refresh_jobs').whereIn('id', [...created]).del();
    created.clear();
  });

  afterAll(async () => { await database?.destroy(); });

  async function register(payload = { jobId: '41000000-0000-4000-8000-000000000001', customerIds: [], dates: ['2040-09-16'] }) {
    const row = await queue.registerQualityRefresh(payload, NOW, database);
    created.add(row.id);
    return row;
  }

  test('a failed request is claimable from a fresh module context with its exact payload', async () => {
    const first = await register({
      jobId: '41000000-0000-4000-8000-000000000001',
      customerIds: ['42000000-0000-4000-8000-000000000001'],
      dates: ['2040-09-16'],
    });
    await queue.captureResolvedDates(first, ['2040-09-10', '2040-09-16'], database);
    await queue.retryQualityRefresh(first, 'synthetic_discovery_failure', NOW, database);

    let freshQueue;
    jest.isolateModules(() => { freshQueue = require('../services/scheduling/quality-refresh-queue'); });
    const claimed = await freshQueue.claimQualityRefresh(new Date(NOW.getTime() + 6 * 60 * 1000), database);

    expect(claimed).toMatchObject({ id: first.id, attempts: 2, payload: {
      jobId: first.payload.jobId,
      customerIds: first.payload.customerIds,
      dates: ['2040-09-16'],
      resolvedDates: ['2040-09-10', '2040-09-16'],
    } });
    expect(claimed.attempt_token).not.toBe(first.attempt_token);
  });

  test('concurrent claims select one worker and a stale completion cannot clear its successor', async () => {
    const initial = await register();
    await database('schedule_quality_refresh_jobs').where({ id: initial.id }).update({ available_at: NOW });

    const [left, right] = await Promise.all([
      queue.claimQualityRefresh(NOW, database),
      queue.claimQualityRefresh(NOW, database),
    ]);
    const firstClaim = left || right;
    expect([left, right].filter(Boolean)).toHaveLength(1);

    await database('schedule_quality_refresh_jobs').where({ id: initial.id }).update({ available_at: NOW });
    const secondClaim = await queue.claimQualityRefresh(NOW, database);
    expect(secondClaim.attempt_token).not.toBe(firstClaim.attempt_token);
    expect(await queue.completeQualityRefresh(firstClaim, database)).toBe(0);
    expect(await database('schedule_quality_refresh_jobs').where({ id: initial.id }).first()).toBeTruthy();
    expect(await queue.completeQualityRefresh(secondClaim, database)).toBe(1);
  });
});
