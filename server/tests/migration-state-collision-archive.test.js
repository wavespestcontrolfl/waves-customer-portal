const migration = require('../models/migrations/20260924000098_archive_shared_000020_state');

function fakeKnex(rows) {
  const knex = (table) => {
    if (table !== 'system_settings') throw new Error(`unexpected table ${table}`);
    const filters = [];
    const matching = () => rows.filter((row) => filters.every(([key, value]) => row[key] === value));
    const query = {
      where(values) { filters.push(...Object.entries(values)); return query; },
      async first(...columns) {
        const row = matching()[0];
        if (!row) return undefined;
        if (!columns.length) return { ...row };
        return Object.fromEntries(columns.map((column) => [column, row[column]]));
      },
      async insert(value) { rows.push({ ...value }); return [value]; },
    };
    return query;
  };
  knex.schema = { hasTable: async (table) => table === 'system_settings' };
  return knex;
}

function archive(rows) {
  const row = rows.find(({ key }) => key === migration.STATE_KEY);
  return row && JSON.parse(row.value);
}

test('archives malformed surviving state verbatim, is idempotent, and down preserves the archive and legacy row', async () => {
  const rawLegacy = '{malformed legacy state';
  const rows = [{ key: migration.LEGACY_STATE_KEY, value: rawLegacy }];
  const knex = fakeKnex(rows);

  await migration.up(knex);
  await migration.up(knex);

  expect(rows).toHaveLength(2);
  expect(rows.find(({ key }) => key === migration.LEGACY_STATE_KEY)).toEqual({
    key: migration.LEGACY_STATE_KEY, value: rawLegacy,
  });
  expect(archive(rows)).toMatchObject({
    archive_kind: migration.ARCHIVE_KIND,
    legacy_key: migration.LEGACY_STATE_KEY,
    legacy_present: true,
    legacy_value: rawLegacy,
    frozen_owners: migration.FROZEN_OWNERS,
  });

  await migration.down(knex);
  expect(rows).toHaveLength(2);
  expect(archive(rows).legacy_value).toBe(rawLegacy);
});

test('records a missing legacy row distinctly without inventing ownership', async () => {
  const rows = [];
  await migration.up(fakeKnex(rows));

  expect(archive(rows)).toMatchObject({
    legacy_present: false,
    legacy_value: null,
    frozen_owners: migration.FROZEN_OWNERS,
  });
});

test('preserves a pre-existing archive value verbatim', async () => {
  const rows = [
    { key: migration.LEGACY_STATE_KEY, value: 'new legacy value' },
    { key: migration.STATE_KEY, value: 'operator-preserved archive' },
  ];

  await migration.up(fakeKnex(rows));

  expect(rows.find(({ key }) => key === migration.STATE_KEY).value).toBe('operator-preserved archive');
});
