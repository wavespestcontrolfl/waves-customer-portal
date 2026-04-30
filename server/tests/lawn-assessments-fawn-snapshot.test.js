/**
 * Smoke test for the fawn_snapshot drift fix (migration
 * 20260430000003_lawn_assessments_fawn_snapshot.js).
 *
 * Verifies the column exists and accepts the exact write shape that
 * services/lawn-intelligence.js:attachWeather() produces — a
 * JSON.stringify of the FAWN weather object — and that the value
 * round-trips back as a parsed object on read.
 *
 * Skipped when DATABASE_URL is unset so the rest of the unit-test
 * suite still passes on a developer box without Postgres.
 *
 * Doesn't call attachWeather() directly because fetchFawnWeather
 * resolves via a closure binding inside lawn-intelligence.js (not
 * via the exported object), so it can't be spied without refactoring
 * the module — out of scope for PR 0.1. Instead we exercise the
 * underlying invariant: the same UPDATE shape attachWeather issues
 * must succeed against the live schema.
 */

const path = require('path');
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('lawn_assessments.fawn_snapshot drift fix', () => {
  let knex;

  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
  });

  test('fawn_snapshot column exists on lawn_assessments', async () => {
    const cols = await knex('lawn_assessments').columnInfo();
    expect(cols).toHaveProperty('fawn_snapshot');
    // Postgres reports jsonb as 'jsonb'; knex normalises type names.
    expect(cols.fawn_snapshot.type).toMatch(/json/i);
    expect(cols.fawn_snapshot.nullable).toBe(true);
  });

  test('attachWeather UPDATE shape round-trips through fawn_snapshot', async () => {
    // Borrow any existing customer for the FK; if none, skip cleanly.
    const c = await knex('customers').select('id').first();
    if (!c) {
      // eslint-disable-next-line no-console
      console.warn('[fawn_snapshot smoke] no customers in DB — skipping write round-trip');
      return;
    }

    // lawn_assessments NOT NULL columns without defaults: customer_id,
    // service_date. Everything else is nullable or defaulted, so a
    // two-field scaffold is sufficient.
    const [row] = await knex('lawn_assessments')
      .insert({ customer_id: c.id, service_date: new Date() })
      .returning('id');
    const id = row?.id ?? row;

    try {
      const weather = {
        temp_f: 78.4,
        humidity_pct: 62.0,
        rainfall_in: 0.25,
        soil_temp_f: 74.1,
        station: 'BRD',
        observation_time: '2026-04-30T10:00:00-04:00',
      };

      // Mirror attachWeather() exactly — JSON.stringify on insert is
      // how the service encodes the blob, and we want to confirm the
      // jsonb column accepts that shape end-to-end.
      await knex('lawn_assessments').where({ id }).update({
        fawn_temp_f: weather.temp_f,
        fawn_humidity_pct: weather.humidity_pct,
        fawn_rainfall_7d: weather.rainfall_in,
        fawn_soil_temp_f: weather.soil_temp_f,
        fawn_station: weather.station,
        fawn_snapshot: JSON.stringify(weather),
      });

      const back = await knex('lawn_assessments')
        .select('fawn_temp_f', 'fawn_station', 'fawn_snapshot')
        .where({ id })
        .first();

      expect(back.fawn_station).toBe('BRD');
      expect(parseFloat(back.fawn_temp_f)).toBeCloseTo(78.4, 1);

      // Postgres jsonb columns return parsed objects via pg's default
      // type parser, so fawn_snapshot should already be an object.
      const snapshot = typeof back.fawn_snapshot === 'string'
        ? JSON.parse(back.fawn_snapshot)
        : back.fawn_snapshot;
      expect(snapshot).toMatchObject({
        temp_f: 78.4,
        station: 'BRD',
        observation_time: '2026-04-30T10:00:00-04:00',
      });
    } finally {
      await knex('lawn_assessments').where({ id }).del();
    }
  });
});
