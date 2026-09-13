/**
 * Termite annual protection plan — pricing_config row (plan
 * docs/estimator-pricing-plan-2026-09-03.md §A2/§A3; RULING A-1 = shape P1,
 * owner 2026-09-11).
 *
 * Seeds `pricing_config.termite_annual_plan`:
 *   { setup_per_station: 30, annual_base: 249, annual_step: 50,
 *     bracket_stations: 5, bracket_floor: 10 }
 *   setup   = stations × setup_per_station               (one-time, not tier-discounted)
 *   annual  = annual_base + annual_step × max(0, ceil((stations − bracket_floor) / bracket_stations))
 *
 * NO price moves: the plan is emitted only behind GATE_TERMITE_ANNUAL_PLAN
 * (default OFF), so this row is inert in prod until the owner flips the gate
 * after the agreement v3 sign-off (ruling A-11). Insert-if-absent with an
 * audit row; an existing (admin-authored) row is left alone. down() removes
 * the row only if this migration created it (audit old_value null) and it
 * still holds exactly what up() wrote.
 */
const MIGRATION_TAG = 'migration:20260911000020';
const KEY = 'termite_annual_plan';
const NEW_DATA = { setup_per_station: 30, annual_base: 249, annual_step: 50, bracket_stations: 5, bracket_floor: 10 };
const UP_REASON = 'Seed the termite annual protection plan (ruling A-1 = P1: $30/station setup + $249 base / $50 per 5-station bracket above 10); dark behind GATE_TERMITE_ANNUAL_PLAN';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const row = await knex('pricing_config').where({ config_key: KEY }).forUpdate().first();
  if (row) return;
  await knex('pricing_config').insert({
    config_key: KEY,
    name: 'Termite Annual Protection Plan (P1)',
    category: 'termite',
    sort_order: 3,
    data: JSON.stringify(NEW_DATA),
  });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: KEY,
      old_value: null,
      new_value: JSON.stringify(NEW_DATA),
      changed_by: MIGRATION_TAG,
      reason: UP_REASON,
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config')) || !(await knex.schema.hasTable('pricing_config_audit'))) return;
  const audit = await knex('pricing_config_audit').where({ config_key: KEY, changed_by: MIGRATION_TAG }).orderBy('id', 'desc').first();
  if (!audit || audit.old_value != null) return;
  const row = await knex('pricing_config').where({ config_key: KEY }).forUpdate().first();
  if (!row) return;
  const current = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
  const untouched = Object.keys(NEW_DATA).length === Object.keys(current).length
    && Object.entries(NEW_DATA).every(([k, v]) => String(current[k]) === String(v));
  if (!untouched) return;
  await knex('pricing_config').where({ config_key: KEY }).del();
  await knex('pricing_config_audit').insert({
    config_key: KEY,
    old_value: JSON.stringify(NEW_DATA),
    new_value: null,
    changed_by: `${MIGRATION_TAG}:rollback`,
    reason: 'Rollback of the termite annual plan seed',
  });
};
