// Explicit, isolated test database only. Uses a random schema; never touches
// application rows or falls back to DATABASE_URL / an application's .env.
const knexFactory = require('knex');
const { randomUUID } = require('node:crypto');
const migration = require('../models/migrations/20261002190000_pest_forecast_snapshots');
const { saveSnapshot, readPreviousForecast } = require('../services/pest-forecast/history');
const { computeForecast } = require('../services/pest-forecast/forecast');
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
  });
  afterEach(async () => { await db('pest_forecast_snapshots').del(); });
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
    try {
      // All pool connections are held, so Knex cannot reach its SQL timeout.
      // This must fail within the overall read budget, not its 60s pool wait.
      const started = Date.now();
      await expect(readPreviousForecast(make('2026-10-02'), db)).rejects.toThrow('History read timed out');
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await Promise.all(connections.map(connection => db.client.releaseConnection(connection)));
    }
  });

});
