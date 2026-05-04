/**
 * Document the 2026-05-04 pricing regression baseline refresh.
 *
 * This migration does not change pricing rules. It records that the test
 * baselines were recaptured against the already-current DB-synced pricing
 * engine and the v1 adapter totals behavior from commit 8a2c38b.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('pricing_changelog');
  if (!hasTable) return;

  const existing = await knex('pricing_changelog')
    .where({
      version_from: 'v4.3',
      version_to: 'v4.3',
      changed_by: 'codex-2026-05-04',
      category: 'documentation',
      summary: 'Refresh pricing regression baselines against DB-synced engine state.',
    })
    .first('id');
  if (existing) return;

  await knex('pricing_changelog').insert({
    version_from: 'v4.3',
    version_to: 'v4.3',
    changed_by: 'codex-2026-05-04',
    category: 'documentation',
    summary: 'Refresh pricing regression baselines against DB-synced engine state.',
    affected_services: JSON.stringify([
      'pest_control',
      'termite_bait',
      'rodent_bait',
      'one_time_pest',
      'waveguard_adapter_totals',
    ]),
    before_value: JSON.stringify({
      baseline_source: 'stale regression fixtures',
      adapter_local_mode: 'in-memory constants possible',
    }),
    after_value: JSON.stringify({
      baseline_source: 'LOCAL=1 with syncConstantsFromDB() loading 57 pricing_config rows',
      adapter_local_mode: 'DB sync guard enabled',
    }),
    rationale: 'No pricing rules changed in this migration. Regression baselines were stale after current pricing_config values and commit 8a2c38b changed adapter total bucketing. The refresh documents the intentional fixture update and adds a harness guard so local adapter regressions exercise the same synced pricing path as production.',
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('pricing_changelog');
  if (!hasTable) return;

  await knex('pricing_changelog')
    .where({
      version_from: 'v4.3',
      version_to: 'v4.3',
      changed_by: 'codex-2026-05-04',
      category: 'documentation',
      summary: 'Refresh pricing regression baselines against DB-synced engine state.',
    })
    .del();
};
