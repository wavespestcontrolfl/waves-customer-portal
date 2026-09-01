/**
 * Seed pricing_config.unified_setup_fee ($99) — the DB-authoritative amount
 * for the unified accept-time setup fee (owner ruling 2026-09-01: ONE setup
 * fee for every NEW customer starting recurring service, any mix; waived
 * only for existing customers). Read by db-bridge.syncConstantsFromDB over
 * constants.WAVEGUARD.unifiedSetupFee; live only under
 * GATE_UNIFIED_SETUP_FEE (dark at seed time).
 *
 * Idempotent both directions: up() inserts only when the key is absent (an
 * existing row — admin-edited or re-run — is left untouched); down() keys
 * off this migration's own audit row and deletes only a row still carrying
 * the exact value up() wrote, so an admin edit survives rollback.
 */
const CONFIG_KEY = 'unified_setup_fee';
const MIGRATION_TAG = 'migration:20260901000010';
const UP_REASON = 'Unified accept-time setup fee (owner ruling 2026-09-01): one setup fee for any new-customer recurring signup, any mix; waived only for existing customers. Dark behind GATE_UNIFIED_SETUP_FEE.';
const SEED_DATA = {
  value: 99,
  note: 'Owner ruling 2026-09-01: charged once at accept to every new customer starting recurring service (any mix); waived only for customers with an active recurring service. Live only under GATE_UNIFIED_SETUP_FEE.',
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const existing = await knex('pricing_config').where({ config_key: CONFIG_KEY }).first();
  if (existing) return; // admin-created or re-run — never overwrite
  await knex('pricing_config').insert({
    config_key: CONFIG_KEY,
    name: 'Unified Setup Fee',
    category: 'global',
    sort_order: 20,
    data: JSON.stringify(SEED_DATA),
  });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: CONFIG_KEY,
      old_value: null,
      new_value: JSON.stringify(SEED_DATA),
      changed_by: MIGRATION_TAG,
      reason: UP_REASON,
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  // Ownership proof: only remove a row this migration inserted (audit row
  // present) AND that still carries the exact seeded value — an admin edit
  // is preserved (documented seed-rollback rule: never destructive).
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const proof = await knex('pricing_config_audit')
    .where({ config_key: CONFIG_KEY, changed_by: MIGRATION_TAG })
    .first('id');
  if (!proof) return;
  // The seed audit row must also be the LATEST mutation recorded for the
  // key — any later audit entry (admin panel writes one per edit) means the
  // row is no longer ours to remove, even if the values happen to match.
  const laterMutation = await knex('pricing_config_audit')
    .where({ config_key: CONFIG_KEY })
    .where('id', '>', proof.id)
    .first('id');
  if (laterMutation) return;
  const row = await knex('pricing_config').where({ config_key: CONFIG_KEY }).first();
  if (!row) return;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  // Whole-row equality with what up() seeded — ANY admin edit (value, note,
  // extra keys, name, category, sort order) keeps the row.
  const seededRowIntact = JSON.stringify(data) === JSON.stringify(SEED_DATA)
    && row.name === 'Unified Setup Fee'
    && row.category === 'global'
    && Number(row.sort_order) === 20;
  if (!seededRowIntact) return; // admin-edited — keep
  await knex('pricing_config').where({ config_key: CONFIG_KEY }).delete();
  await knex('pricing_config_audit').insert({
    config_key: CONFIG_KEY,
    old_value: JSON.stringify(data),
    new_value: null,
    changed_by: MIGRATION_TAG,
    reason: 'Rollback of the unified_setup_fee seed (unedited row removed).',
  });
};
