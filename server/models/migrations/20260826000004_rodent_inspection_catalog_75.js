/**
 * services.rodent_inspection catalog row: $125 → $75 (owner directive
 * 2026-08-26, companion to 20260826000002).
 *
 * 20260826000002 lowered the DB-authoritative pricing_config fee, which is
 * what generateEstimate quotes. The CATALOG row seeded by 20260429000005
 * still carried base_price 125 and "$125 fee creditable" copy, and the
 * scheduling service picker prices a hand-scheduled inspection from the
 * catalog base_price — so an office-booked inspection could still be $125
 * while the estimator quoted $75 (codex #3521 r1 P1). Value-guarded
 * read-modify-write: an admin who already re-priced the row is left alone,
 * and down() restores only what up() changed.
 */
const MIGRATION_TAG = 'migration:20260826000004';
const LEGACY_PRICE = 125;
const NEW_PRICE = 75;
const LEGACY_DESCRIPTION = 'Paid diagnostic visit. Identifies entry points, activity zones, and remediation scope. $125 fee creditable toward exclusion or full remediation if approved within 14 days.';
const NEW_DESCRIPTION = 'Paid diagnostic visit. Identifies entry points, activity zones, and remediation scope. $75 fee creditable toward exclusion or full remediation if approved within 14 days.';
const STATE_KEY = 'migration.20260826000004.state';

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
  const row = await knex('services').where({ service_key: 'rodent_inspection' }).first();
  if (!row) return;
  const state = { priceChanged: false, descriptionChanged: false, priorPrice: null };
  const patch = {};
  // ANY divergent numeric catalog price moves to $75 — the estimator fee is
  // unconditionally $75, and a staff-scheduled inspection copies this
  // catalog value (uncapped audit P1 on #3521). NULL (variable pricing)
  // is left alone; the prior value rides the state for rollback.
  const currentPrice = Number(row.base_price);
  if (row.base_price != null && Number.isFinite(currentPrice) && currentPrice !== NEW_PRICE) {
    patch.base_price = NEW_PRICE;
    state.priceChanged = true;
    state.priorPrice = currentPrice;
  }
  if (String(row.description || '') === LEGACY_DESCRIPTION) {
    patch.description = NEW_DESCRIPTION;
    state.descriptionChanged = true;
  }
  if (!Object.keys(patch).length) return;
  await knex('services')
    .where({ id: row.id })
    .update({ ...patch, updated_at: knex.fn.now() });
  await saveState(knex, { ...state, id: row.id, tag: MIGRATION_TAG });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const state = await loadState(knex);
  if (!state || !state.id) return;
  const row = await knex('services').where({ id: state.id, service_key: 'rodent_inspection' }).first();
  if (row) {
    const patch = {};
    if (state.priceChanged && Number(row.base_price) === NEW_PRICE) {
      patch.base_price = Number.isFinite(Number(state.priorPrice)) ? Number(state.priorPrice) : LEGACY_PRICE;
    }
    if (state.descriptionChanged && String(row.description || '') === NEW_DESCRIPTION) patch.description = LEGACY_DESCRIPTION;
    if (Object.keys(patch).length) {
      await knex('services').where({ id: row.id }).update({ ...patch, updated_at: knex.fn.now() });
    }
  }
  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

exports.LEGACY_PRICE = LEGACY_PRICE;
exports.NEW_PRICE = NEW_PRICE;
exports.LEGACY_DESCRIPTION = LEGACY_DESCRIPTION;
exports.NEW_DESCRIPTION = NEW_DESCRIPTION;
