const migration = require('../models/migrations/20260823000005_newsletter_relink_archived_customer_subscribers');

function fakeKnex({ hasPrimary = true } = {}) {
  const knex = { raw: jest.fn(async () => ({ rowCount: 3 })) };
  knex.schema = {
    hasTable: jest.fn(async () => true),
    hasColumn: jest.fn(async (_t, col) => (col === 'is_primary_profile' ? hasPrimary : true)),
  };
  return knex;
}

describe('newsletter archived-link relink backfill migration', () => {
  test('one set-based UPDATE: archived link → live twin of the SUBSCRIBER email, canonical scope, deterministic twin', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(knex.raw).toHaveBeenCalledTimes(1);
    const [sql, bindings] = knex.raw.mock.calls[0];
    expect(sql).toMatch(/UPDATE newsletter_subscribers ns/);
    // Twin picked per EMAIL (from the subscriber's own email), not per customer.
    expect(sql).toMatch(/DISTINCT ON \(LOWER\(TRIM\(c\.email\)\)\)/);
    // Archived-only scope, matching liveTwinSubselect: no lifecycle predicate,
    // so a lead-stage profile stays a valid link target here too.
    expect(sql).toMatch(/c\.deleted_at IS NULL/);
    expect(sql).not.toMatch(/c\.active = true/);
    expect(sql).not.toMatch(/c\.pipeline_stage/);
    expect(sql).toMatch(/ORDER BY LOWER\(TRIM\(c\.email\)\), c\.is_primary_profile DESC NULLS LAST, c\.created_at ASC, c\.id ASC/);
    expect(sql).toMatch(/WHERE LOWER\(TRIM\(ns\.email\)\) = t\.email_key/);
    expect(sql).toMatch(/ns\.customer_id <> t\.twin_id/);
    // Only rows whose CURRENT link is an archived customer move.
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM customers a WHERE a\.id = ns\.customer_id AND a\.deleted_at IS NOT NULL\)/);
    expect(sql).not.toMatch(/LOWER\(TRIM\(a\.email\)\)/);
    expect(bindings).toBeUndefined();
  });

  test('skips when is_primary_profile is absent; down is a no-op', async () => {
    const knex = fakeKnex({ hasPrimary: false });
    await migration.up(knex);
    expect(knex.raw).not.toHaveBeenCalled();
    await expect(migration.down(knex)).resolves.toBeUndefined();
  });
});
