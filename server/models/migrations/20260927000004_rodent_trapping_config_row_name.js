'use strict';

/**
 * pricing_config.rodent_trapping row name (PR #4932 Codex r3): 000001
 * renames the row only when it moves 'unlimited' → 1. A row that carried a
 * numeric allowance was repaired to 1 by 000003 (data only), so the Pricing
 * Logic panel would still label it "flat $350, unlimited callbacks". When
 * the name is still that seeded value and the allowance is 1, rename it.
 * Locked read (same row lock as the admin Pricing Logic PUT); down()
 * reverts only a rename this migration recorded and that is still in place.
 */
const MIGRATION_MARKER = 'migration:20260927000004';
const STATE_KEY = 'migration.20260927000004.state';

const PRIOR_ROW_NAME = 'Rodent Trapping (Standard — flat $350, unlimited callbacks)';
const ROW_NAME = 'Rodent Trapping (Standard — flat $350, setup + 1 trap check)';

function parseData(row) {
  if (!row) return null;
  try { return typeof row.data === 'string' ? JSON.parse(row.data) : row.data; } catch { return null; }
}

exports.PRIOR_ROW_NAME = PRIOR_ROW_NAME;
exports.ROW_NAME = ROW_NAME;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const row = await knex('pricing_config').where({ config_key: 'rodent_trapping' }).forUpdate().first();
  if (!row || row.name !== PRIOR_ROW_NAME) return;
  const data = parseData(row);
  if (!data || Number(data.included_followups) !== 1) return;
  await knex('pricing_config').where({ config_key: 'rodent_trapping' }).update({ name: ROW_NAME, updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('system_settings')) {
    const value = JSON.stringify({ tag: MIGRATION_MARKER, renamed: true });
    const updated = await knex('system_settings').where({ key: STATE_KEY }).update({ value });
    if (!updated) await knex('system_settings').insert({ key: STATE_KEY, value });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const state = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!state) return;
  if (await knex.schema.hasTable('pricing_config')) {
    await knex('pricing_config')
      .where({ config_key: 'rodent_trapping', name: ROW_NAME })
      .update({ name: PRIOR_ROW_NAME, updated_at: knex.fn.now() });
  }
  await knex('system_settings').where({ key: STATE_KEY }).del();
};
