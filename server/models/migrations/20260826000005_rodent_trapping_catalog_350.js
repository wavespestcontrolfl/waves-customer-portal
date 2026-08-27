/**
 * services.rodent_trapping catalog price fields: Standard-only $350
 * (owner directive 2026-08-26, companion to 20260826000001).
 *
 * 20260526000009 seeded the catalog row as a $350–$450 range (Standard /
 * Unlimited). 20260826000001 retired the Unlimited tier but rewrote only
 * the description, so admin scheduling and appointment creation — which
 * surface price_range_min/max — still advertised the retired $450 tier
 * (uncapped audit r2 P1). Value-guarded read-modify-write: only fields
 * still carrying the seeded values move, and down() restores only what
 * up() recorded changing.
 */
const MIGRATION_TAG = 'migration:20260826000005';
const STATE_KEY = 'migration.20260826000005.state';
const STANDARD_PRICE = 350;
// Seeded by 20260526000009.
const LEGACY = { base_price: 350, price_range_min: 350, price_range_max: 450 };
const TARGET = { base_price: STANDARD_PRICE, price_range_min: STANDARD_PRICE, price_range_max: STANDARD_PRICE };

async function loadState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

async function saveState(knex, state) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const value = JSON.stringify(state);
  const updated = await knex('system_settings').where({ key: STATE_KEY }).update({ value });
  if (!updated) await knex('system_settings').insert({ key: STATE_KEY, value });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const row = await knex('services').where({ service_key: 'rodent_trapping' }).first();
  if (!row) return;
  const patch = {};
  const changed = [];
  const prior = {};
  // Every numeric price field that diverges from the flat $350 is pinned —
  // base_price, price_range_min AND price_range_max — whatever an admin
  // set (uncapped audit P1 on #3521): the engine/client price is fixed, so
  // scheduling must not expose or bill anything else. NULLs are left
  // alone; prior values ride the state for rollback.
  for (const field of Object.keys(TARGET)) {
    const current = Number(row[field]);
    if (row[field] != null && Number.isFinite(current) && current !== TARGET[field]) {
      patch[field] = TARGET[field];
      changed.push(field);
      prior[field] = current;
    }
  }
  if (!changed.length) return;
  await knex('services').where({ id: row.id }).update({ ...patch, updated_at: knex.fn.now() });
  await saveState(knex, { id: row.id, changed, prior, tag: MIGRATION_TAG });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const state = await loadState(knex);
  if (!state || !state.id) return;
  const row = await knex('services').where({ id: state.id, service_key: 'rodent_trapping' }).first();
  if (row) {
    const patch = {};
    for (const field of (Array.isArray(state.changed) ? state.changed : [])) {
      if (field in TARGET && Number(row[field]) === TARGET[field]) {
        const recorded = Number(state.prior?.[field]);
        patch[field] = Number.isFinite(recorded) ? recorded : LEGACY[field];
      }
    }
    if (Object.keys(patch).length) {
      await knex('services').where({ id: row.id }).update({ ...patch, updated_at: knex.fn.now() });
    }
  }
  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

exports.LEGACY = LEGACY;
exports.TARGET = TARGET;
