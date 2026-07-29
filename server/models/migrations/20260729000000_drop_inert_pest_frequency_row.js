/**
 * Drop the INERT `pest_frequency` pricing_config row.
 *
 * No server code reads this config key: db-bridge only VALIDATES
 * PEST.frequencyDiscounts (both curves in (0,1]) and never writes it — the
 * pest cadence curve is code-authoritative BY DESIGN since #2966 (v2 live
 * default in constants.js; v1 retained for replay only). The row's values
 * (bimonthly 0.92 / monthly 0.85) matched NEITHER curve, and the admin
 * Pricing Logic panel offered it as an editor whose "takes effect
 * immediately" save was a silent no-op (audit 2026-07-28). Removing the row
 * removes the trap; the curve itself is unchanged.
 */
const CONFIG_KEY = 'pest_frequency';
const MIGRATION_TAG = 'migration:20260729000000';
const UP_REASON = 'Removed inert pest_frequency row — no reader exists; cadence curve is code-authoritative (#2966). Admin edits to this row silently no-opped (audit 2026-07-28).';

// Seed shape from 20260414000026, used only if the audit trail is missing on
// rollback. v2_* keys reflect the staged-then-live v2 curve values the prod
// row actually carried at deletion time.
const FALLBACK_ROW = {
  name: 'Pest Frequency Discounts',
  category: 'pest',
  sort_order: 5,
  data: { quarterly: 1.0, bimonthly: 0.92, monthly: 0.85, v2_bimonthly: 0.88, v2_monthly: 0.78 },
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const row = await knex('pricing_config').where({ config_key: CONFIG_KEY }).first();
  if (!row) return;
  const oldData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  await knex('pricing_config').where({ config_key: CONFIG_KEY }).del();
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: CONFIG_KEY,
      old_value: JSON.stringify(oldData),
      new_value: null,
      changed_by: MIGRATION_TAG,
      reason: UP_REASON,
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const existing = await knex('pricing_config').where({ config_key: CONFIG_KEY }).first();
  if (existing) return;
  // Restore the exact deleted data from the audit trail when available.
  let data = FALLBACK_ROW.data;
  if (await knex.schema.hasTable('pricing_config_audit')) {
    const audit = await knex('pricing_config_audit')
      .where({ config_key: CONFIG_KEY, changed_by: MIGRATION_TAG })
      .orderBy('id', 'desc')
      .first();
    if (audit?.old_value) {
      try { data = JSON.parse(audit.old_value); } catch { /* keep fallback */ }
    }
  }
  await knex('pricing_config').insert({
    config_key: CONFIG_KEY,
    name: FALLBACK_ROW.name,
    category: FALLBACK_ROW.category,
    sort_order: FALLBACK_ROW.sort_order,
    data: JSON.stringify(data),
  });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: CONFIG_KEY,
      old_value: null,
      new_value: JSON.stringify(data),
      changed_by: MIGRATION_TAG,
      reason: 'Rollback: restored pest_frequency row deleted by 20260729000000.',
    });
  }
};
