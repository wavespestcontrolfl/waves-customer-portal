'use strict';

/**
 * rodent_trap_check_additional is a FIXED-price row (PR #4932 Codex r4):
 * 20260927000001 seeded price_range_min/max = 95 alongside base_price. The
 * Service Library price edit updates base_price only, while
 * /services-dropdown prefers price_range_min (`price_range_min ??
 * base_price`), so an edited price would book at the stale $95 while the
 * estimate copy (db-bridge overlay of base_price) quotes the new one. Clear
 * the range so booking reads base_price, the single authority.
 * Value-guarded: only the seeded 95/95 range is cleared; down() restores
 * exactly what up() recorded.
 */
const STATE_KEY = 'migration.20260927000005.state';
const KEY = 'rodent_trap_check_additional';
const SEEDED = 95;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  if (!(await knex.schema.hasColumn('services', 'price_range_min'))) return;
  const row = await knex('services').where({ service_key: KEY }).forUpdate().first('id', 'price_range_min', 'price_range_max');
  if (!row) return;
  if (Number(row.price_range_min) !== SEEDED || Number(row.price_range_max) !== SEEDED) return;
  await knex('services').where({ id: row.id }).update({ price_range_min: null, price_range_max: null, updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('system_settings')) {
    const value = JSON.stringify({ serviceId: row.id });
    const updated = await knex('system_settings').where({ key: STATE_KEY }).update({ value });
    if (!updated) await knex('system_settings').insert({ key: STATE_KEY, value });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const state = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!state) return;
  let serviceId = null;
  try { serviceId = JSON.parse(state.value).serviceId; } catch { serviceId = null; }
  if (serviceId && await knex.schema.hasTable('services')) {
    await knex('services')
      .where({ id: serviceId, service_key: KEY, price_range_min: null, price_range_max: null })
      .update({ price_range_min: SEEDED, price_range_max: SEEDED, updated_at: knex.fn.now() });
  }
  await knex('system_settings').where({ key: STATE_KEY }).del();
};
