/**
 * Seed ts_material_rates.palm_large_factor for the Tree & Shrub routine
 * palm-care reserve (owner ruling 2026-09-26: one flat per-palm rate plus a
 * count of LARGE palms, canopy wider than ~15 ft, entered on the admin
 * estimate only — customers are never asked).
 *
 * A large palm counts as palm_large_factor regular palms in both reserve
 * terms (material $/palm/yr, minutes/palm/visit). Seeded at the proposed
 * 2.5 (the owner asked for a proposal and took the recommendation): the
 * palm dose is canopy width x width / 85 lb, so a typical large canopy
 * (18–20 ft) takes about 2.5–4x the fertilizer of a typical regular one
 * (10–12 ft) while the extra minutes grow less. Prices move only on an
 * estimate that enters large palms, and only while the reserve is armed.
 * db-bridge accepts 1–5; 1 turns the distinction off.
 *
 * Read-modify-write under the row lock like 20260809000001: admin edits to
 * the row's other keys survive, and a key already present is left alone.
 */
const MIGRATION_TAG = 'migration:20260926004100';
const SEEDED_FACTOR = 2.5;
const UP_REASON = 'Seed palm_large_factor 2.5: large palms (canopy over ~15 ft) count as 2.5 regular palms in the T&S palm reserve (owner ruling 2026-09-26)';
const CHANGELOG_IDENTITY = {
  version_from: 'v4.7',
  version_to: 'v4.7',
  changed_by: 'claude-2026-09-26',
  category: 'cost',
  summary: 'T&S palm reserve: a large palm (canopy over ~15 ft) prices as 2.5 regular palms.',
};

async function loadRow(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  // forUpdate: the admin pricing writer locks this row for its own
  // read-modify-write, so an edit committed between this SELECT and the
  // whole-JSON UPDATE below cannot be overwritten.
  const row = await knex('pricing_config')
    .where({ config_key: 'ts_material_rates' })
    .forUpdate()
    .first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || typeof data !== 'object') return null;
  return { row, data };
}

async function saveRow(knex, oldData, newData, reason) {
  await knex('pricing_config')
    .where({ config_key: 'ts_material_rates' })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'ts_material_rates',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function up(knex) {
  const loaded = await loadRow(knex);
  if (!loaded) return;
  const { data } = loaded;
  // An existing value (an admin edit) is left alone; down() keys off the
  // audit row this branch then never writes.
  if (data.palm_large_factor !== undefined) return;
  await saveRow(knex, data, { ...data, palm_large_factor: SEEDED_FACTOR }, UP_REASON);

  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['tree_shrub']),
        before_value: JSON.stringify({ palm_large_factor: null }),
        after_value: JSON.stringify({ palm_large_factor: SEEDED_FACTOR }),
        rationale: 'Owner ruling 2026-09-26: price palms at one flat rate plus a separate large-palm count (canopy over ~15 ft) on the admin estimate. Fertilizer scales with canopy area (dose = width x width / 85 lb), so a large palm counts as 2.5 regular palms in the reserve material and labor terms. Estimates without large palms, and every quote already sent, are unchanged.',
      });
    }
  }
};

exports.down = async function down(knex) {
  // Only what this migration's up() wrote, keyed off its own audit row; no
  // audit table means no proof of ownership, so leave the data alone.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: 'ts_material_rates', changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id');
  if (!ownUp) return;
  const loaded = await loadRow(knex);
  // A factor the owner has since edited is an admin decision rollback must
  // not touch; only the untouched seeded value goes.
  if (loaded && Number(loaded.data.palm_large_factor) === SEEDED_FACTOR) {
    const newData = { ...loaded.data };
    delete newData.palm_large_factor;
    await saveRow(knex, loaded.data, newData, `${MIGRATION_TAG} down: remove seeded palm_large_factor`);
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};

module.exports.SEEDED_FACTOR = SEEDED_FACTOR;
module.exports.UP_REASON = UP_REASON;
