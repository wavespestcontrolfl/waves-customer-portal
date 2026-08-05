/**
 * 20260805000010 mosquito_seasonal catalog activation (owner directive
 * 2026-08-05): flip is_active back on now that converter series support
 * exists (#3173), and fix the seeded frequency drift ('monthly' with
 * visits_per_year=9 → 'seasonal_feb_oct'). Ownership is RECORDED in a
 * system_settings state row — down() restores only what up() proved it
 * changed, so admin edits before or after the migration survive both
 * directions, and an archived row is never touched.
 */
const migration = require('../models/migrations/20260805000010_activate_mosquito_seasonal_catalog');

const STATE_KEY = 'migration.20260805000010.state';

// Prod shape: deactivated by hand, seeded frequency still in place.
function seedDb(overrides = {}) {
  return {
    services: [
      {
        id: 'svc-mq-seasonal',
        service_key: 'mosquito_seasonal',
        name: 'Seasonal Mosquito Control Service',
        category: 'mosquito',
        billing_type: 'recurring',
        frequency: 'monthly',
        visits_per_year: 9,
        is_active: false,
        is_archived: false,
        booking_enabled: true,
        customer_visible: true,
        updated_at: 'orig',
        ...overrides,
      },
      {
        id: 'svc-mq-monthly',
        service_key: 'mosquito_monthly',
        name: 'Monthly Mosquito Control Service',
        category: 'mosquito',
        billing_type: 'recurring',
        frequency: 'monthly',
        visits_per_year: 12,
        is_active: true,
        is_archived: false,
        updated_at: 'orig',
      },
    ],
    system_settings: [],
  };
}

function fakeKnex(db, { missingTables = [] } = {}) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const rowMatch = (r) => filters.every((cond) => Object.entries(cond).every(([k, v]) => r[k] === v));
    const q = {
      where(cond) {
        if (typeof cond === 'function') {
          // Emulates the grouped-where shape only as far as this suite
          // needs; the migration itself uses plain object predicates.
          throw new Error('fake where: grouped callbacks unsupported');
        }
        filters.push(cond);
        return q;
      },
      whereNull(col) { filters.push({ [col]: null }); return q; },
      forUpdate() { return q; },
      first: async () => {
        const hit = rowsNow().find(rowMatch);
        return hit ? { ...hit } : undefined;
      },
      update: async (patch, returning) => {
        const hits = rowsNow().filter(rowMatch);
        hits.forEach((r) => Object.assign(r, patch));
        if (Array.isArray(returning)) {
          return hits.map((r) => {
            const out = {};
            returning.forEach((c) => { out[c] = r[c]; });
            return out;
          });
        }
        return hits.length;
      },
      del: async () => {
        const hits = rowsNow().filter(rowMatch);
        db[table] = rowsNow().filter((r) => !hits.includes(r));
        return hits.length;
      },
      insert: async (row) => {
        (db[table] = rowsNow()).push({ ...row });
        return [1];
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t) && t in db,
  };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const seasonalRow = (db) => db.services.find((r) => r.service_key === 'mosquito_seasonal');
const monthlyRow = (db) => db.services.find((r) => r.service_key === 'mosquito_monthly');
const stateRow = (db) => db.system_settings.find((r) => r.key === STATE_KEY);
const stateValue = (db) => JSON.parse(stateRow(db).value);

describe('20260805000010 mosquito_seasonal activation', () => {
  test('up() activates the inactive row, fixes the seeded frequency, and records raw priors', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(seasonalRow(db)).toMatchObject({
      is_active: true,
      frequency: 'seasonal_feb_oct',
      updated_at: 'NOW',
    });
    expect(stateValue(db)).toEqual({ prior: { is_active: false, frequency: 'monthly' } });
    // The sibling monthly row (same frequency value) is never swept.
    expect(monthlyRow(db)).toMatchObject({ frequency: 'monthly', updated_at: 'orig' });
  });

  test('up() on a fresh-DB row (born active, seeded frequency) fixes frequency only and records only that field', async () => {
    const db = seedDb({ is_active: true });
    await migration.up(fakeKnex(db));

    expect(seasonalRow(db)).toMatchObject({ is_active: true, frequency: 'seasonal_feb_oct' });
    expect(stateValue(db)).toEqual({ prior: { frequency: 'monthly' } });
  });

  test('up() activates a NULL-is_active row (reads as inactive in every catalog filter) and records the raw NULL', async () => {
    const db = seedDb({ is_active: null });
    await migration.up(fakeKnex(db));

    expect(seasonalRow(db).is_active).toBe(true);
    expect(stateValue(db)).toEqual({ prior: { is_active: null, frequency: 'monthly' } });

    await migration.down(fakeKnex(db));
    expect(seasonalRow(db).is_active).toBe(null);
  });

  test('up() is a recordless no-op on a fully-correct row', async () => {
    const db = seedDb({ is_active: true, frequency: 'seasonal_feb_oct' });
    await migration.up(fakeKnex(db));

    expect(seasonalRow(db)).toMatchObject({ is_active: true, frequency: 'seasonal_feb_oct', updated_at: 'orig' });
    expect(stateRow(db)).toBeUndefined();
  });

  test('up() loud-skips an archived row entirely (admin-owned decision wins)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = seedDb({ is_archived: true });
      await migration.up(fakeKnex(db));

      expect(seasonalRow(db)).toMatchObject({
        is_active: false,
        frequency: 'monthly',
        is_archived: true,
        updated_at: 'orig',
      });
      expect(stateRow(db)).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('up() leaves an admin-tuned frequency alone and does not claim it', async () => {
    const db = seedDb({ frequency: 'every_6_weeks' });
    await migration.up(fakeKnex(db));

    expect(seasonalRow(db)).toMatchObject({ is_active: true, frequency: 'every_6_weeks' });
    expect(stateValue(db)).toEqual({ prior: { is_active: false } });
  });

  test('down() restores exactly the recorded fields and deletes the state row', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.down(knex);

    expect(seasonalRow(db)).toMatchObject({ is_active: false, frequency: 'monthly' });
    expect(stateRow(db)).toBeUndefined();
  });

  test('down() leaves post-migration admin edits alone (value-matched restore)', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    // Admin re-tunes the cadence after the migration ran; is_active untouched.
    seasonalRow(db).frequency = 'every_6_weeks';
    await migration.down(knex);

    expect(seasonalRow(db)).toMatchObject({ is_active: false, frequency: 'every_6_weeks' });
    // The cycle still closes: the state row is consumed either way.
    expect(stateRow(db)).toBeUndefined();
  });

  test('down() with no ownership record is a no-op', async () => {
    const db = seedDb({ is_active: true, frequency: 'seasonal_feb_oct' });
    await migration.down(fakeKnex(db));

    expect(seasonalRow(db)).toMatchObject({ is_active: true, frequency: 'seasonal_feb_oct', updated_at: 'orig' });
  });

  test('up() tolerates a missing services row and missing tables', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const emptyDb = { services: [], system_settings: [] };
      await migration.up(fakeKnex(emptyDb));
      expect(stateRow(emptyDb)).toBeUndefined();

      // Missing services table: both directions bail on the first guard.
      const db = seedDb();
      await migration.up(fakeKnex(db, { missingTables: ['services'] }));
      expect(seasonalRow(db)).toMatchObject({ is_active: false, updated_at: 'orig' });
      await migration.down(fakeKnex(db, { missingTables: ['services'] }));

      // Missing system_settings: the flip still lands; no record is written.
      const db2 = seedDb();
      await migration.up(fakeKnex(db2, { missingTables: ['system_settings'] }));
      expect(seasonalRow(db2)).toMatchObject({ is_active: true, frequency: 'seasonal_feb_oct' });
      // And down() then answers for nothing.
      await migration.down(fakeKnex(db2, { missingTables: ['system_settings'] }));
      expect(seasonalRow(db2)).toMatchObject({ is_active: true, frequency: 'seasonal_feb_oct' });
    } finally {
      warn.mockRestore();
    }
  });
});
