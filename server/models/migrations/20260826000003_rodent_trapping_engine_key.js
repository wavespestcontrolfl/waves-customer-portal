/**
 * rodent_trapping engine-key link (owner directive 2026-08-26).
 *
 * The 2026-08-25 engine-key expansion (20260825000011) deliberately left
 * `rodent_trapping` UNMAPPED: priceRodentTrapping sold TWO plans under the
 * one key — Standard (two included callbacks) and Unlimited — while the
 * catalog row's completion contract is unlimited callbacks for the active
 * job, so a Standard sale stamped with that identity would generate
 * callbacks beyond the two purchased.
 *
 * 20260826000001 made Standard the ONLY plan and gave it unlimited
 * callbacks, so the key now names exactly the contract the catalog row
 * carries and the mapping is unambiguous. Without it, accepted trapping
 * estimates resolve no service_id (catalogLinkForProfile links one-time
 * work through engine_keys only) and fall back to generic completion
 * instead of the typed rodent-trapping profile. Same guarded pattern
 * as the parent migration: rows stamp only when unstamped, another active
 * owner elsewhere skips the seed (no duplicate owners), the table lock
 * serializes the check-then-stamp span, ownership is RECORDED by
 * {service_key, id}, and down() reverses only recorded rows, value-guarded.
 */

const SEED = { service_key: 'rodent_trapping', engine_keys: ['rodent_trapping'] };
const STATE_KEY = 'migration.20260826000003.state';

async function activeOwnerElsewhere(knex, excludeId, engineKeys) {
  for (const key of engineKeys) {
    const owner = await knex('services')
      .whereNot({ id: excludeId })
      .where({ is_active: true })
      .whereRaw('engine_keys @> ?::jsonb', [JSON.stringify([key])])
      .first('id');
    if (owner) return true;
  }
  return false;
}

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
  if (!(await knex.schema.hasColumn('services', 'engine_keys'))) return;

  // Serialize the owner-check → stamp span against concurrent admin edits
  // (same reasoning as 20260825000011): the two statements have no
  // member-level uniqueness on engine_keys to protect them. The lock rides
  // the migration transaction.
  await knex.raw('LOCK TABLE services IN SHARE ROW EXCLUSIVE MODE');

  const state = { stamped: [] };
  const row = await knex('services')
    .where({ service_key: SEED.service_key })
    .whereNull('engine_keys')
    .first('id');
  if (row && !(await activeOwnerElsewhere(knex, row.id, SEED.engine_keys))) {
    const count = await knex('services')
      .where({ id: row.id })
      .whereNull('engine_keys')
      .update({ engine_keys: JSON.stringify(SEED.engine_keys), updated_at: knex.fn.now() });
    if (count) state.stamped.push({ service_key: SEED.service_key, id: row.id });
  }

  const prior = await loadState(knex);
  const merged = prior && Array.isArray(prior.stamped)
    ? { stamped: [...new Map([...prior.stamped, ...state.stamped].filter((r) => r && r.id).map((r) => [r.id, r])).values()] }
    : state;
  await saveState(knex, merged);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  if (!(await knex.schema.hasColumn('services', 'engine_keys'))) return;
  const state = await loadState(knex);
  if (!state) return;
  for (const rec of (Array.isArray(state.stamped) ? state.stamped : [])) {
    if (!rec || !rec.id) continue;
    // Ownership binds to the recorded ROW id, value-guarded so a post-up()
    // admin edit survives the rollback.
    await knex('services')
      .where({ id: rec.id, service_key: SEED.service_key })
      .whereRaw('engine_keys = ?::jsonb', [JSON.stringify(SEED.engine_keys)])
      .update({ engine_keys: null, updated_at: knex.fn.now() });
  }
  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

exports.SEED = SEED;
