// Explicit, isolated test database only. Uses a random schema; never touches
// application rows or falls back to DATABASE_URL / an application's .env.
const knexFactory = require('knex');
const { randomUUID } = require('node:crypto');
const migration = require('../models/migrations/20261002190000_pest_forecast_snapshots');
const { saveSnapshot, readPreviousForecast } = require('../services/pest-forecast/history');
const { computeForecast } = require('../services/pest-forecast/forecast');
const { loadEvaluationData, evaluateForecasts } = require('../services/pest-forecast/validation');
const { BY_SLUG } = require('../services/pest-forecast/locations');

const url = process.env.PEST_FORECAST_TEST_DATABASE_URL;
jest.setTimeout(30000);
(url ? describe : describe.skip)('pest forecast snapshots on PostgreSQL', () => {
  let db;
  const schema = `pest_forecast_${randomUUID().replaceAll('-', '')}`;
  const make = (date, location = 'bradenton-fl') => computeForecast(BY_SLUG.get(location),
    { hasWeather: true, source: 'nws', warm: true, wet: true }, new Date(`${date}T16:00:00Z`));
  beforeAll(async () => {
    db = knexFactory({ client: 'pg', connection: url, searchPath: [schema], pool: { min: 0, max: 3 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    await migration.up(db);
    await db.schema.createTable('scheduled_services', t => { t.uuid('id').primary(); t.text('service_address_city'); t.text('service_address_state'); });
    await db.schema.createTable('service_records', t => {
      t.uuid('id').primary(); t.uuid('scheduled_service_id'); t.uuid('customer_id'); t.uuid('technician_id');
      t.text('status'); t.date('service_date'); t.jsonb('service_data'); t.jsonb('structured_notes');
    });
  });
  afterEach(async () => { await db('pest_forecast_snapshots').del(); await db('service_records').del(); });
  afterAll(async () => {
    if (db) { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); }
  });

  test('concurrent collection keeps the first daily prediction immutable', async () => {
    const original = make('2026-10-01');
    await saveSnapshot(original, db);
    const revised = { ...original, summary: 'must not replace original' };
    await Promise.all([saveSnapshot(revised, db), saveSnapshot(revised, db)]);
    const rows = await db('pest_forecast_snapshots');
    expect(rows).toHaveLength(1);
    expect(rows[0].forecast.summary).toBe(original.summary);
  });

  test('history reads exactly one city, model and calendar date', async () => {
    await saveSnapshot(make('2026-09-25'), db);
    await saveSnapshot(make('2026-09-26'), db);
    await saveSnapshot(make('2026-09-25', 'sarasota-fl'), db);
    const previous = await readPreviousForecast(make('2026-10-02'), db);
    expect(previous.as_of_date).toBe('2026-09-25');
    expect(previous.location.slug).toBe('bradenton-fl');
    expect(await readPreviousForecast(make('2026-10-04'), db)).toBeNull();
  });

  test('an exhausted pool cannot stall the optional public history read', async () => {
    const connections = await Promise.all(Array.from({ length: 3 }, () => db.client.acquireConnection()));
    const queries = [];
    const record = query => queries.push(query.sql);
    db.on('query', record);
    try {
      // All pool connections are held, so Knex cannot reach its SQL timeout.
      // This must fail within the overall read budget, not its 60s pool wait.
      const started = Date.now();
      const reads = Array.from({ length: 12 }, () => readPreviousForecast(make('2026-10-02'), db));
      const results = await Promise.allSettled(reads);
      expect(results.every(r => r.status === 'rejected' && r.reason.message === 'History read timed out')).toBe(true);
      expect(db.client.pool.numPendingAcquires()).toBe(0);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await Promise.all(connections.map(connection => db.client.releaseConnection(connection)));
      await new Promise(resolve => setTimeout(resolve, 50));
      db.removeListener('query', record);
    }
    expect(queries).toEqual([]);
  });

  test('a blocked SQL read is cancelled and the pool remains usable', async () => {
    await saveSnapshot(make('2026-09-25'), db);
    const blocker = await db.transaction();
    try {
      await blocker.raw('LOCK TABLE pest_forecast_snapshots IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      await expect(readPreviousForecast(make('2026-10-02'), db))
        .rejects.toThrow(/History read timed out|Defined query timeout/);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally { await blocker.rollback(); }
    expect((await readPreviousForecast(make('2026-10-02'), db)).as_of_date).toBe('2026-09-25');
  });

  test('read-only evaluator preserves source rows and bounds blocked reads', async () => {
    const saved = make('2026-10-01');
    await saveSnapshot(saved, db);
    const oldModel = { ...saved, model_version: 'retired-model' };
    await db('pest_forecast_snapshots').insert({
      location_slug: oldModel.location.slug, forecast_date: oldModel.as_of_date,
      model_version: oldModel.model_version, generated_at: oldModel.generated_at,
      forecast: JSON.stringify(oldModel),
    });
    await db('service_records').insert({ id: randomUUID(), customer_id: randomUUID(), technician_id: randomUUID(),
      status: 'completed', service_date: '2026-10-02', service_data: JSON.stringify({
        reportIdentitySnapshot: { address: { city: 'Bradenton', state: 'FL' } },
        typedReportSnapshot: { type: 'cockroach', values: { species: 'German', evidence_observed: 'Live roaches', activity_level: 'Moderate' } },
      }) });
    const input = await loadEvaluationData(db, { from: '2026-10-01', to: '2026-10-03' });
    expect(evaluateForecasts(input).coverage).toMatchObject({ matchedObservations: 1, invalidOrOtherModelSnapshots: 1 });
    expect((await db('service_records').count('* as n').first()).n).toBe('1');
    expect((await db('pest_forecast_snapshots').count('* as n').first()).n).toBe('2');

    for (const table of ['service_records', 'pest_forecast_snapshots']) {
      const blocker = await db.transaction();
      try {
        await blocker.raw('LOCK TABLE ?? IN ACCESS EXCLUSIVE MODE', [table]);
        const started = Date.now();
        await expect(loadEvaluationData(db, { from: '2026-10-01', to: '2026-10-03' }))
          .rejects.toThrow(/canceling statement due to statement timeout/);
        expect(Date.now() - started).toBeLessThan(8000);
      } finally { await blocker.rollback(); }
    }
    expect(evaluateForecasts(await loadEvaluationData(db, { from: '2026-10-01', to: '2026-10-03' })).coverage.matchedObservations).toBe(1);
  });
});
