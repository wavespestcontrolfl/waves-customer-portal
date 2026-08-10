/**
 * 20260810000020 mosquito_seasonal un-archive (owner directive 2026-08-10).
 *
 * 20260805000010 carried the activation directive but loud-skips
 * `is_archived === true`, and the catalog's only hand-deactivation path
 * (`service-library.deactivateService`) sets is_active=false AND
 * is_archived=true together — so the prod row it was written for was
 * archived, and it returned before BOTH the activation and the cadence fix.
 * This migration finishes the job: un-archive, activate, assert the
 * sellability flags, and land 'seasonal_feb_oct'. Ownership is RECORDED in
 * a system_settings row, so down() restores only what up() proved it
 * changed and admin edits survive both directions.
 */
const migration = require('../models/migrations/20260810000020_unarchive_mosquito_seasonal_catalog');

const STATE_KEY = 'migration.20260810000020.state';

// Prod shape: archived by the admin Service Library (is_active false AND
// is_archived true, written together), seeded cadence still in place.
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
        is_archived: true,
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
        booking_enabled: true,
        customer_visible: true,
        updated_at: 'orig',
      },
    ],
    system_settings: [],
  };
}

function fakeKnex(db, { missingTables = [], missingColumns = [] } = {}) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const rowMatch = (r) => filters.every((cond) => Object.entries(cond).every(([k, v]) => r[k] === v));
    const q = {
      where(cond) {
        if (typeof cond === 'function') throw new Error('fake where: grouped callbacks unsupported');
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
    hasColumn: async (_t, c) => !missingColumns.includes(c),
  };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const seasonalRow = (db) => db.services.find((r) => r.service_key === 'mosquito_seasonal');
const monthlyRow = (db) => db.services.find((r) => r.service_key === 'mosquito_monthly');
const stateRow = (db) => db.system_settings.find((r) => r.key === STATE_KEY);
const stateValue = (db) => JSON.parse(stateRow(db).value);

describe('20260810000020 mosquito_seasonal un-archive', () => {
  test('up() on the prod shape un-archives, activates, fixes cadence, and records raw priors', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(seasonalRow(db)).toMatchObject({
      is_archived: false,
      is_active: true,
      frequency: 'seasonal_feb_oct',
      updated_at: 'NOW',
    });
    // visits_per_year was already 9 and is never touched.
    expect(seasonalRow(db).visits_per_year).toBe(9);
    expect(stateValue(db)).toEqual({
      prior: { is_archived: true, is_active: false, frequency: 'monthly' },
    });
    // The sibling monthly row (same frequency value) is never swept.
    expect(monthlyRow(db)).toMatchObject({ frequency: 'monthly', updated_at: 'orig' });
  });

  test('up() is a recordless no-op on a row 20260805000010 already corrected', async () => {
    const db = seedDb({ is_archived: false, is_active: true, frequency: 'seasonal_feb_oct' });
    await migration.up(fakeKnex(db));

    expect(seasonalRow(db)).toMatchObject({
      is_archived: false, is_active: true, frequency: 'seasonal_feb_oct', updated_at: 'orig',
    });
    expect(stateRow(db)).toBeUndefined();
  });

  test('up() on a hand-restored row (flags fixed in the UI, cadence still seeded) claims only the cadence', async () => {
    // The Service Library "Restore service" button sends exactly
    // {is_archived: false, is_active: true} — it cannot reach frequency.
    const db = seedDb({ is_archived: false, is_active: true });
    await migration.up(fakeKnex(db));

    expect(seasonalRow(db)).toMatchObject({ is_active: true, frequency: 'seasonal_feb_oct' });
    expect(stateValue(db)).toEqual({ prior: { frequency: 'monthly' } });
  });

  test('up() activates a NULL-is_active row (reads as inactive in every catalog filter) and records the raw NULL', async () => {
    const db = seedDb({ is_active: null });
    await migration.up(fakeKnex(db));

    expect(seasonalRow(db).is_active).toBe(true);
    expect(stateValue(db).prior.is_active).toBe(null);

    await migration.down(fakeKnex(db));
    expect(seasonalRow(db).is_active).toBe(null);
  });

  test('up() asserts the sellability flags when they are off, and records them', async () => {
    const db = seedDb({ booking_enabled: false, customer_visible: false });
    await migration.up(fakeKnex(db));

    expect(seasonalRow(db)).toMatchObject({ booking_enabled: true, customer_visible: true });
    expect(stateValue(db).prior).toMatchObject({ booking_enabled: false, customer_visible: false });
  });

  test('up() does not record sellability flags that were already true', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(stateValue(db).prior).not.toHaveProperty('booking_enabled');
    expect(stateValue(db).prior).not.toHaveProperty('customer_visible');
  });

  test('up() skips a sellability flag whose column does not exist (never blocks a deploy)', async () => {
    const db = seedDb({ booking_enabled: false, customer_visible: false });
    await migration.up(fakeKnex(db, { missingColumns: ['booking_enabled'] }));

    expect(seasonalRow(db).booking_enabled).toBe(false);
    expect(seasonalRow(db).customer_visible).toBe(true);
    expect(stateValue(db).prior).not.toHaveProperty('booking_enabled');
  });

  test('up() leaves an admin-tuned frequency alone and does not claim it', async () => {
    const db = seedDb({ frequency: 'every_6_weeks' });
    await migration.up(fakeKnex(db));

    expect(seasonalRow(db)).toMatchObject({ is_active: true, frequency: 'every_6_weeks' });
    expect(stateValue(db).prior).not.toHaveProperty('frequency');
  });

  test('up() warns and records nothing when the row is absent', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = seedDb();
      db.services = db.services.filter((r) => r.service_key !== 'mosquito_seasonal');
      await migration.up(fakeKnex(db));

      expect(stateRow(db)).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('down() restores exactly the recorded fields and deletes the state row', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.down(knex);

    expect(seasonalRow(db)).toMatchObject({
      is_archived: true, is_active: false, frequency: 'monthly',
    });
    expect(stateRow(db)).toBeUndefined();
  });

  test('down() leaves post-migration admin edits alone (value-matched restore)', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    // Admin re-tunes the cadence after the migration ran; the flags are untouched.
    seasonalRow(db).frequency = 'every_6_weeks';
    await migration.down(knex);

    expect(seasonalRow(db)).toMatchObject({
      is_archived: true, is_active: false, frequency: 'every_6_weeks',
    });
    // The cycle still closes: the state row is consumed either way.
    expect(stateRow(db)).toBeUndefined();
  });

  test('down() with no ownership record is a no-op', async () => {
    const db = seedDb();
    await migration.down(fakeKnex(db));

    expect(seasonalRow(db)).toMatchObject({
      is_archived: true, is_active: false, frequency: 'monthly', updated_at: 'orig',
    });
  });

  test('up() then down() round-trips a row that only needed the cadence fix', async () => {
    const db = seedDb({ is_archived: false, is_active: true });
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.down(knex);

    // Un-archive/activate were never claimed, so down() must not deactivate.
    expect(seasonalRow(db)).toMatchObject({
      is_archived: false, is_active: true, frequency: 'monthly',
    });
  });
});
