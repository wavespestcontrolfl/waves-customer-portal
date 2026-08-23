const migration = require('../models/migrations/20260823000005_newsletter_relink_archived_customer_subscribers');
const { CUSTOMER_STAGES } = require('../services/customer-stages');

function fakeKnex({ hasPrimary = true } = {}) {
  const knex = { raw: jest.fn(async () => ({ rowCount: 3 })) };
  knex.schema = {
    hasTable: jest.fn(async () => true),
    hasColumn: jest.fn(async (_t, col) => (col === 'is_primary_profile' ? hasPrimary : true)),
  };
  return knex;
}

describe('newsletter archived-link relink backfill migration', () => {
  test('one set-based UPDATE: archived link → live same-email twin, canonical scope, deterministic twin', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(knex.raw).toHaveBeenCalledTimes(1);
    const [sql, bindings] = knex.raw.mock.calls[0];
    expect(sql).toMatch(/UPDATE newsletter_subscribers ns/);
    expect(sql).toMatch(/DISTINCT ON \(a\.id\)/);
    expect(sql).toMatch(/LOWER\(TRIM\(c\.email\)\) = LOWER\(TRIM\(a\.email\)\)/);
    expect(sql).toMatch(/a\.deleted_at IS NOT NULL/);
    expect(sql).toMatch(/c\.active = true/);
    expect(sql).toMatch(/c\.deleted_at IS NULL/);
    expect(sql).toMatch(/c\.pipeline_stage IN \((\?, )*\?\)/);
    expect(sql).toMatch(/ORDER BY a\.id, c\.is_primary_profile DESC NULLS LAST, c\.created_at ASC, c\.id ASC/);
    expect(sql).toMatch(/WHERE ns\.customer_id = t\.archived_id/);
    expect(bindings).toEqual(CUSTOMER_STAGES);
  });

  test('skips when is_primary_profile is absent; down is a no-op', async () => {
    const knex = fakeKnex({ hasPrimary: false });
    await migration.up(knex);
    expect(knex.raw).not.toHaveBeenCalled();
    await expect(migration.down(knex)).resolves.toBeUndefined();
  });
});
